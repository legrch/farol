package access

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strconv"

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

type CurrentTransitionReceipt struct {
	OperationID               string
	StoreRevision, Generation uint64
	LogicalOutcome            string
	CallerDelivery            string
}

// ActivateCurrentTransition qualifies CURRENT authorization, separately from
// the historical committed certificate. Native handles cannot survive restart.
// A missing host-qualified source keeps this gate CLOSED; this is NOT exposed
// as an IPC method and does not activate ComputerIngress's separate route fence.
func (s *Store) ActivateCurrentTransition(ctx context.Context, qualifier CurrentQualification) (CurrentTransitionReceipt, error) {
	if qualifier == nil || ctx == nil || ctx.Err() != nil {
		return CurrentTransitionReceipt{}, unavailable()
	}
	s.mutex.Lock()
	if s.closed || s.poisoned || s.currentContinuity != nil || s.currentActivating || s.checkStorage(ctx) != nil ||
		!s.journalPresent || s.journal.Unresolved() || s.current.Approval == nil {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, unavailable()
	}
	var latest *journal.Entry
	for i := range s.journal.Entries {
		e := &s.journal.Entries[i]
		if e.Phase == journal.Committed && e.DischargedBy == "" {
			latest = e
		}
	}
	if latest == nil || latest.Certificate == nil || latest.Certificate.Kind != journal.Committed ||
		latest.Request.ProfileID != s.binding.ProfileID || latest.Request.OwnerID != s.binding.OwnerID ||
		latest.Request.ComputerID != s.binding.ComputerID {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, unavailable()
	}
	proposed := approval(*s.current.Approval)
	expected, parseErr := strconv.ParseUint(latest.Request.ExpectedGeneration, 10, 64)
	if parseErr != nil || expected == ^uint64(0) || proposed.Generation != expected+1 ||
		proposed.Generation != s.current.Generation || !validApproval(proposed, s.binding) {
		s.mutex.Unlock()
		return CurrentTransitionReceipt{}, unavailable()
	}
	found := false
	for _, root := range proposed.Workspaces {
		if root.WorkspaceID == latest.Request.WorkspaceID && root.Root == latest.Request.Root && !root.ShellVerified {
			if found {
				s.mutex.Unlock()
				return CurrentTransitionReceipt{}, unavailable()
			}
			found = true
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
		}
		return CurrentTransitionReceipt{}, unavailable()
	}
	// Every returned native witness is consumed exactly once, including when
	// an intervening mutation has invalidated the original Store snapshot.
	same := ctx.Err() == nil && !s.closed && !s.poisoned && s.checkStorage(ctx) == nil &&
		s.digest == originalDigest && s.journalDigest == originalJournal &&
		s.current.Revision == rev && s.current.Generation == generation &&
		!s.journal.Unresolved() && s.currentContinuity == nil
	if !same {
		if witness.Close() != nil {
			s.poisoned = true
		}
		return CurrentTransitionReceipt{}, unavailable()
	}
	valid := witness.RequalifyCurrent(ctx) == nil && ctx.Err() == nil
	closed := witness.Close() // exactly one Close, including a failed native check
	if closed != nil {
		s.poisoned = true
	}
	if !valid || closed != nil {
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
