package access

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
)

// CurrentQualification is created only by trusted boot composition after
// compatible-reader/recovery/update and current owner-Settings qualification.
// The returned native witness retains the ORIGINAL no-follow current-startup
// Data anchor and directory chain until it is closed exactly once.
// It is never a renderer-controlled token, Settings boolean, or RPC field.
type CurrentQualification interface {
	PrepareCurrent(context.Context, journal.Entry, authority.Approval) (CurrentWitness, error)
}

// RequalifyCurrent and Close are Go-native operations only. Neither may call
// back into TS: the final Store lock prevents publication races. The expensive
// preflight/Settings eligibility belongs in PrepareCurrent, outside that lock.
type CurrentWitness interface {
	RequalifyCurrent(context.Context) error
	Close() error
}

// A ticket proves the physical ROOT BINDINGS that were current when native
// qualification completed. Store revisions and participant journal changes are
// deliberately excluded: legal Admit/Revoke must not clear this evidence.
// Ordinary owner policy mutations remain protected by Store's own CAS and the
// effective approval; changing a root binding still invalidates the ticket.
type activeContinuity struct {
	operationID   string
	bindingDigest [32]byte
	journalDigest [32]byte
	minGeneration uint64
}

func currentRootBindingDigest(a *authority.Approval) [32]byte {
	if a == nil {
		return [32]byte{}
	}
	type binding struct{ WorkspaceID, Root, Device, Inode string }
	parts := make([]binding, 0, len(a.Workspaces))
	for _, w := range a.Workspaces {
		parts = append(parts, binding{w.WorkspaceID, w.Root, w.RootIdentity.Device, w.RootIdentity.Inode})
	}
	b, err := json.Marshal(struct {
		OwnerID, ComputerID string
		Bindings            []binding
	}{a.OwnerID, a.ComputerID, parts})
	if err != nil {
		return [32]byte{}
	}
	return sha256.Sum256(b)
}

// ErrCurrentCustodyUnknown is classified native acquisition or cleanup of the
// ORIGINAL current witness, not a retryable missing Settings/recovery proof.
// A Store that receives it must poison this runtime's admission rather than
// trying another set of numeric descriptors.
var ErrCurrentCustodyUnknown = errors.New("WORKSPACE_CURRENT_NATIVE_CUSTODY_UNKNOWN")

// ErrStartupContinuityUnknown carries no workspace, operation or native detail.
var ErrStartupContinuityUnknown = errors.New("WORKSPACE_STARTUP_CONTINUITY_UNKNOWN")

type StartupQualification func(context.Context) error

type launchQualification struct {
	once        sync.Once
	result      error
	pending     bool   // Protected by the Store mutex.
	operationID string // Protected by the Store mutex.
}

// Status supplies the Store revision for the authority withdrawal receipt only
// after the launch attempt. An ingress without this route still reads Status.
func (start StartupQualification) Status(ctx context.Context, read func(context.Context) (Status, error)) (Status, error) {
	if start != nil {
		if err := start(ctx); err != nil {
			return Status{}, err
		}
	}
	return read(ctx)
}

// StartupContinuity binds the one launch attempt before any publication fence
// can be delivered. The resulting callback runs once, after the reciprocal
// Settings reader can answer. Explicit qualification remains for new commits.
func (s *Store) StartupContinuity(qualifier CurrentQualification) StartupQualification {
	s.mutex.Lock()
	if s.startup == nil {
		s.startup = &launchQualification{pending: true}
	}
	startup := s.startup
	s.mutex.Unlock()
	return func(ctx context.Context) error {
		startup.once.Do(func() { startup.result = s.qualifyStartupContinuity(ctx, qualifier) })
		return startup.result
	}
}

func (s *Store) qualifyStartupContinuity(ctx context.Context, qualifier CurrentQualification) error {
	needed, err := s.selectStartupContinuity(ctx)
	if err == nil && needed {
		_, err = s.ActivateCurrentTransition(ctx, qualifier)
	}
	switch {
	case err == nil:
		return nil
	case errors.Is(err, journal.ErrUnknown), OutcomeUnknown(err):
		return ErrStartupContinuityUnknown
	default:
		return authority.Fail("WORKSPACE_STARTUP_CONTINUITY_REFUSED", "authority-store")
	}
}

func (s *Store) selectStartupContinuity(ctx context.Context) (bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return false, err
	}
	if s.journal.Unresolved() || s.stops.Pending() {
		return false, journal.ErrUnknown
	}
	s.startup.pending = false
	if !s.transitionRestricted() {
		return false, nil
	}
	s.startup.operationID = s.latestCommittedTransition().Request.OperationID
	return true, nil
}

type CurrentTransitionReceipt struct {
	OperationID               string
	StoreRevision, Generation uint64
	LogicalOutcome            string
	CallerDelivery            string
}

// ActivateCurrentTransition qualifies CURRENT authorization, separately from
// the historical committed certificate. Native handles cannot survive restart.
// A missing host-qualified source keeps this gate CLOSED; this is NOT exposed
// as an unrestricted IPC method and does not activate the separate route fence.
func (s *Store) ActivateCurrentTransition(ctx context.Context, qualifier CurrentQualification) (CurrentTransitionReceipt, error) {
	return s.activateCurrentTransition(ctx, "", qualifier)
}

// QualifyContinuityOperation excludes every other operation before invoking
// the current witness owner. Only the exact latest committed child qualifies.
func (s *Store) QualifyContinuityOperation(ctx context.Context, id string, qualifier CurrentQualification) (bool, error) {
	if id == "" {
		return false, journal.ErrRefused
	}
	_, err := s.activateCurrentTransition(ctx, id, qualifier)
	if _, unavailable := err.(*authority.Failure); unavailable {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) activateCurrentTransition(ctx context.Context, id string, qualifier CurrentQualification) (CurrentTransitionReceipt, error) {
	if qualifier == nil || ctx == nil || ctx.Err() != nil {
		return CurrentTransitionReceipt{}, unavailable()
	}
	// Leave room for native cleanup and the reply before the host's 30 s
	// deadline. Settings readback and all held checks share this budget.
	ctx, cancel := context.WithTimeout(ctx, 27*time.Second)
	defer cancel()
	s.mutex.Lock()
	if s.closed || s.poisoned || s.currentContinuity != nil || s.currentActivating ||
		(id != "" && s.startup != nil && (s.startup.pending || id == s.startup.operationID)) {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, unavailable()
	}
	if err := s.checkStorage(ctx); err != nil {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, err
	}
	if !s.journalPresent || s.journal.Unresolved() || s.stops.Pending() || s.current.Approval == nil {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, unavailable()
	}
	latest := s.latestCommittedTransition()
	if latest == nil || (id != "" && (latest.Request.OperationID != id || latest.Parent == nil)) || latest.Certificate == nil || latest.Certificate.Kind != journal.Committed ||
		latest.Request.ProfileID != s.binding.ProfileID || latest.Request.OwnerID != s.binding.OwnerID ||
		latest.Request.ComputerID != s.binding.ComputerID {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, unavailable()
	}
	proposed := approval(*s.current.Approval)
	expected, parseErr := strconv.ParseUint(latest.Request.ExpectedGeneration, 10, 64)
	// Only startup can requalify a later approval generation. An explicit
	// Verify after the commit can advance it without changing owner consent.
	freshCommit := id != "" || s.startup == nil || latest.Request.OperationID != s.startup.operationID
	if parseErr != nil || expected == ^uint64(0) || proposed.Generation <= expected ||
		(freshCommit && proposed.Generation != expected+1) ||
		proposed.Generation != s.current.Generation || !validApproval(proposed, s.binding) {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, unavailable()
	}
	found := false
	for i, root := range proposed.Workspaces {
		if root.WorkspaceID == latest.Request.WorkspaceID && root.Root == latest.Request.Root &&
			(!root.ShellVerified || (!freshCommit && proposed.Generation > expected+1)) {
			if found {
				s.mutex.Unlock()
				return CurrentTransitionReceipt{}, unavailable()
			}
			found = true
			// The witness qualifies a root binding. Its narrowed input never
			// attests Shell readiness, even after an ordinary later Verify.
			proposed.Workspaces[i].ShellVerified = false
		}
	}
	if !found {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, unavailable()
	}
	entry := *latest
	if latest.Certificate != nil {
		c := *latest.Certificate
		entry.Certificate = &c
	}
	originalDigest, originalJournal := s.digest, s.journalDigest
	rev, generation := s.current.Revision, s.current.Generation
	s.currentActivating = true
	s.mutex.Unlock()

	witness, err := qualifier.PrepareCurrent(ctx, entry, proposed)
	s.mutex.Lock()
	defer s.mutex.Unlock()
	defer func() { s.currentActivating = false }()
	if err != nil || witness == nil {
		if errors.Is(err, ErrCurrentCustodyUnknown) || (err == nil && witness == nil) {
			s.poisoned = true
			return CurrentTransitionReceipt{}, errors.Join(journal.ErrUnknown, err)
		}
		if errors.Is(err, journal.ErrUnknown) {
			return CurrentTransitionReceipt{}, err
		}
		return CurrentTransitionReceipt{}, unavailable()
	}
	// Every returned native witness is consumed exactly once, including when
	// an intervening mutation has invalidated the original Store snapshot.
	storageErr := s.checkStorage(ctx)
	same := ctx.Err() == nil && !s.closed && !s.poisoned && storageErr == nil &&
		s.digest == originalDigest && s.journalDigest == originalJournal &&
		s.current.Revision == rev && s.current.Generation == generation &&
		!s.journal.Unresolved() && !s.stops.Pending() && s.currentContinuity == nil
	if !same {
		if err := witness.Close(); err != nil {
			s.poisoned = true
			return CurrentTransitionReceipt{}, errors.Join(journal.ErrUnknown, err, storageErr)
		}
		if storageErr != nil {
			return CurrentTransitionReceipt{}, storageErr
		}
		return CurrentTransitionReceipt{}, unavailable()
	}
	nativeErr := witness.RequalifyCurrent(ctx)
	closed := witness.Close() // exactly one Close, including a failed native check
	if closed != nil {
		s.poisoned = true
		return CurrentTransitionReceipt{}, errors.Join(journal.ErrUnknown, closed, nativeErr)
	}
	if nativeErr != nil && !errors.Is(nativeErr, errUnqualifiedCurrent) {
		s.poisoned = true
		return CurrentTransitionReceipt{}, errors.Join(journal.ErrUnknown, nativeErr)
	}
	if nativeErr != nil || ctx.Err() != nil {
		return CurrentTransitionReceipt{}, unavailable()
	}
	s.currentContinuity = &activeContinuity{
		operationID: entry.Request.OperationID, bindingDigest: currentRootBindingDigest(s.current.Approval),
		journalDigest: s.journalDigest, minGeneration: generation,
	}
	return CurrentTransitionReceipt{
		OperationID: entry.Request.OperationID, StoreRevision: rev, Generation: generation,
		LogicalOutcome: "committed", CallerDelivery: "not_recorded",
	}, nil
}

// This is an observation, never a credential or provider verification.
func (s *Store) CurrentContinuityStatus(ctx context.Context) (CurrentTransitionReceipt, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return CurrentTransitionReceipt{}, err
	}
	if s.transitionRestricted() || s.currentContinuity == nil {
		return CurrentTransitionReceipt{}, unavailable()
	}
	return CurrentTransitionReceipt{OperationID: s.currentContinuity.operationID,
		StoreRevision: s.current.Revision, Generation: s.current.Generation,
		LogicalOutcome: "committed", CallerDelivery: "not_recorded"}, nil
}
