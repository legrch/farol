package access

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strconv"

	"github.com/legrch/farol/modules/computer/domain/authority"
	transition "github.com/legrch/farol/modules/computer/domain/journal"
)

// TransitionState is read-only custody, not a current grant or a caller ACK.
// A qualified logical certificate never claims delivery to the original UI.
type TransitionState struct {
	Journal    transition.Journal
	Present    bool
	Restricted bool
	Delivery   string
}

func (s *Store) transitionRestricted() bool {
	// The separately owned ORIGINAL Stop must fence current authority even
	// before the first C4 transition WAL has ever been published.
	if s.stopPresent && s.stops.Pending() {
		return true
	}
	if !s.journalPresent {
		return false
	}
	if s.journal.Unresolved() {
		return true
	}
	// Earlier committed certificates are historical; only the most recent
	// effective committed transition needs CURRENT native qualification. A
	// later settled transition cannot revive an old admission/descriptor.
	var latest *transition.Entry
	for i := range s.journal.Entries {
		e := &s.journal.Entries[i]
		if e.Phase == transition.Committed && e.DischargedBy == "" {
			latest = e
		}
	}
	if latest == nil {
		return false
	}
	a := s.currentContinuity
	return a == nil || a.operationID != latest.Request.OperationID ||
		a.journalDigest != s.journalDigest || s.current.Approval == nil ||
		a.minGeneration > s.current.Generation ||
		a.bindingDigest != currentRootBindingDigest(s.current.Approval)
}

// checkStorage is the same exact protected-state check for the journal owner.
// In contrast to authority check it permits observing unfinished work.
func (s *Store) checkStorage(ctx context.Context) error {
	if ctx == nil {
		return unavailable()
	}
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	if s.closed || s.poisoned {
		return unavailable()
	}
	raw, err := s.disk.read()
	if err != nil || digest(raw) != s.digest {
		s.poisoned = true
		return refuse(err)
	}
	marked, err := s.disk.journalMarked()
	if err != nil {
		s.poisoned = true
		return err
	}
	if s.journalPresent {
		if !marked {
			s.poisoned = true
			return unavailable()
		}
		data, e := s.disk.readJournal()
		if e != nil || digest(data) != s.journalDigest {
			s.poisoned = true
			return refuse(e)
		}
	} else if marked {
		// The transition owner does not adopt a journal installed by another task.
		s.poisoned = true
		return unavailable()
	}
	if err := s.checkStopStorage(); err != nil {
		return err
	}
	// Even if there is no C4 WAL and protected approval bytes did not change,
	// a missing/corrupt explicit check ledger or witness refuses admission.
	if err := s.checkConnectionStorage(); err != nil {
		return err
	}
	return nil
}

func (s *Store) TransitionStatus(ctx context.Context) (TransitionState, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return TransitionState{}, err
	}
	return TransitionState{Journal: s.journal.Clone(), Present: s.journalPresent, Restricted: s.transitionRestricted(), Delivery: "not_recorded"}, nil
}

// BeginTransition is a sole-owner native WAL intent, not a workspace action.
// The caller MUST finish its independently owned MCP drain and settled-state
// publication before calling; this method itself acquires zero workspace fds.
func (s *Store) BeginTransition(ctx context.Context, request transition.Request) (transition.Entry, bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if e := s.checkStorage(ctx); e != nil {
		return transition.Entry{}, false, e
	}
	if request.ProfileID != s.binding.ProfileID || request.OwnerID != s.binding.OwnerID || request.ComputerID != s.binding.ComputerID {
		return transition.Entry{}, false, unavailable()
	}
	if current, ok := s.journal.Find(request.OperationID); ok {
		if current.Request != request {
			return transition.Entry{}, false, transition.ErrRefused
		}
		// No effect admission on replay, including a terminal prior result.
		return current, false, nil
	}
	// A new C4 child after the first C7 prerequisite needs the accepted
	// schema-2 single-publication parent/certificate link. Until that reader
	// and exact verifier are implemented, NEVER consume the prerequisite by
	// creating an unlinked legacy C4 admission. Existing C4 observation is safe.
	if s.stopPresent {
		return transition.Entry{}, false, transition.ErrRefused
	}
	next, e := s.journal.Begin(request)
	if e != nil {
		return transition.Entry{}, false, e
	}
	raw, e := encodeJournal(s.binding, next)
	if e != nil {
		return transition.Entry{}, false, e
	}
	if !s.journalPresent {
		e = s.disk.beginJournal(raw)
	} else {
		e = s.disk.updateJournal(raw, s.journalDigest)
	}
	if e != nil {
		s.poisoned = true
		return transition.Entry{}, false, e
	}
	s.journal = next
	s.journalDigest = digest(raw)
	s.journalPresent = true
	current, _ := next.Find(request.OperationID)
	return current, true, nil
}

// stableChildIntentDigest is the canonical, immutable BEFORE-Stop projection.
// Do not include Settings revision/generation, current native observation,
// backend lifetime, or a post-Stop journal request digest. The retained parent
// fixes exactly one child, one explicit mode, one root and one consent scope.
// Any future desktop preparation must use this exact closed projection, not a
// caller-defined hash of arbitrary bytes or the full future C4 request.
func stableChildIntentDigest(request transition.Request, mode string) (string, error) {
	var kind string
	switch mode {
	case "legacy-confirm":
		kind = "computer.confirm-workspace"
	case "enrolled-rebind":
		kind = "computer.rebind-workspace"
	default:
		return "", transition.ErrRefused
	}
	if !transition.ValidRequest(request) || request.RecoveryParent != "" {
		return "", transition.ErrRefused
	}
	projection := struct {
		Schema           int    `json:"schema"`
		CommandKind      string `json:"commandKind"`
		Mode             string `json:"mode"`
		ChildOperationID string `json:"childOperationId"`
		ProfileID        string `json:"profileId"`
		OwnerID          string `json:"ownerId"`
		ComputerID       string `json:"computerId"`
		WorkspaceID      string `json:"workspaceId"`
		Root             string `json:"root"`
		ConsentDigest    string `json:"consentDigest"`
	}{
		Schema: 1, CommandKind: kind, Mode: mode,
		ChildOperationID: request.OperationID,
		ProfileID:        request.ProfileID, OwnerID: request.OwnerID,
		ComputerID: request.ComputerID, WorkspaceID: request.WorkspaceID,
		Root: request.Root, ConsentDigest: request.ConsentDigest,
	}
	raw, err := json.Marshal(projection)
	if err != nil {
		return "", transition.ErrRefused
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// BeginLinkedTransition is the only C7 certificate-to-child consumption path.
// It checks the immutable parent and original positive effect ACKs under the
// existing Store lifetime lock/mutex, then publishes ONE linked C4 WAL entry.
// There is no prerequisite consumed flag or second atomic publication.
// Different-boot recovery-parent admission is deliberately NOT implemented.
func (s *Store) BeginLinkedTransition(
	ctx context.Context, request transition.Request, parentID, mode string,
) (transition.Entry, bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return transition.Entry{}, false, err
	}
	if !s.stopPresent || s.stops.Pending() || !s.journal.Valid() ||
		request.ProfileID != s.binding.ProfileID ||
		request.OwnerID != s.binding.OwnerID ||
		request.ComputerID != s.binding.ComputerID ||
		request.RecoveryParent != "" {
		return transition.Entry{}, false, transition.ErrRefused
	}
	parent, found := s.stops.Find(parentID)
	if !found || parent.Phase != transition.StopComplete ||
		parent.Request.Purpose != "workspace-change" ||
		parent.Request.ChildOperationID != request.OperationID ||
		parent.Request.ChildMode != mode ||
		parent.Request.WorkspaceID != request.WorkspaceID ||
		parent.Request.Root != request.Root ||
		parent.Request.ConsentDigest != request.ConsentDigest ||
		parent.Request.BootUUID != request.BootUUID ||
		parent.Request.HostLifetimeID != request.HostLifetimeID ||
		parent.SettingsAck == nil ||
		parent.SettingsAck.Revision != request.ExpectedRevision ||
		parent.SettingsAck.ComputerGeneration != request.ExpectedGeneration ||
		parent.SettingsAck.ConsentDigest != request.ConsentDigest {
		return transition.Entry{}, false, transition.ErrRefused
	}
	stable, err := stableChildIntentDigest(request, mode)
	if err != nil || parent.Request.ChildIntentDigest != stable {
		return transition.Entry{}, false, transition.ErrRefused
	}
	// Post-Settings expectations must also agree with the CURRENT protected
	// Go approval. A historical Settings/certificate digest cannot revive
	// removed, expired or differently bound workspace authority.
	approval := s.current.Approval
	if approval == nil || approval.OwnerID != request.OwnerID ||
		approval.ComputerID != request.ComputerID ||
		approval.Generation != s.current.Generation ||
		strconv.FormatUint(approval.Generation, 10) != request.ExpectedGeneration ||
		!s.clock.Now().Before(approval.ExpiresAt) {
		return transition.Entry{}, false, transition.ErrRefused
	}
	matchedRoot := false
	for _, workspace := range approval.Workspaces {
		if workspace.WorkspaceID == request.WorkspaceID {
			if matchedRoot || workspace.Root != request.Root {
				return transition.Entry{}, false, transition.ErrRefused
			}
			matchedRoot = true
		}
	}
	if !matchedRoot {
		return transition.Entry{}, false, transition.ErrRefused
	}
	cert, err := parent.Certificate()
	if err != nil {
		return transition.Entry{}, false, transition.ErrRefused
	}
	rawCert, err := json.Marshal(cert)
	if err != nil {
		return transition.Entry{}, false, transition.ErrRefused
	}
	certHash := sha256.Sum256(rawCert)
	link := transition.AdmissionLink{
		ParentOperationID:  parentID,
		CertificateDigest:  hex.EncodeToString(certHash[:]),
		Mode:               mode,
		ChildIntentDigest:  parent.Request.ChildIntentDigest,
		FullRequestDigest:  request.RequestDigest,
		SettingsRevision:   parent.SettingsAck.Revision,
		SettingsGeneration: parent.SettingsAck.ComputerGeneration,
		SettingsDigest:     parent.SettingsAck.DocumentDigest,
	}
	if !transition.ValidAdmissionLink(request, link) {
		return transition.Entry{}, false, transition.ErrRefused
	}
	if current, ok := s.journal.Find(request.OperationID); ok {
		if current.Request != request || current.Parent == nil || *current.Parent != link {
			return transition.Entry{}, false, transition.ErrRefused
		}
		return current, false, nil
	}
	next, err := s.journal.BeginLinked(request, link)
	if err != nil {
		return transition.Entry{}, false, err
	}
	raw, err := encodeJournal(s.binding, next)
	if err != nil {
		return transition.Entry{}, false, err
	}
	if !s.journalPresent {
		err = s.disk.beginJournal(raw)
	} else {
		err = s.disk.updateJournal(raw, s.journalDigest)
	}
	if err != nil {
		s.poisoned = true
		return transition.Entry{}, false, err
	}
	s.journal, s.journalDigest, s.journalPresent = next, digest(raw), true
	if ctx.Err() != nil {
		s.poisoned = true
		return transition.Entry{}, false, transition.ErrUnknown
	}
	current, _ := next.Find(request.OperationID)
	return current, true, nil
}

// AdvanceTransition records an intent BEFORE the trusted caller may dispatch
// the corresponding effect. It does not itself perform a withdrawal or publish.
func (s *Store) AdvanceTransition(ctx context.Context, id string, phase transition.Phase, receipt transition.Receipt) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if e := s.checkStorage(ctx); e != nil {
		return e
	}
	if !s.journalPresent {
		return unavailable()
	}
	next, e := s.journal.Advance(id, phase, receipt)
	if e != nil {
		return e
	}
	raw, e := encodeJournal(s.binding, next)
	if e != nil {
		return e
	}
	if e = s.disk.updateJournal(raw, s.journalDigest); e != nil {
		s.poisoned = true
		return e
	}
	s.journal = next
	s.journalDigest = digest(raw)
	return nil
}

// CertifyTransition publishes only a logical certificate already supported
// by exact effect ACKs. A lost reply is still not_recorded for this Go owner.
func (s *Store) CertifyTransition(ctx context.Context, id string, kind transition.Phase, cleanup transition.Receipt) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if e := s.checkStorage(ctx); e != nil {
		return e
	}
	if !s.journalPresent {
		return unavailable()
	}
	next, e := s.journal.Certify(id, kind, cleanup)
	if e != nil {
		return e
	}
	raw, e := encodeJournal(s.binding, next)
	if e != nil {
		return e
	}
	if e = s.disk.updateJournal(raw, s.journalDigest); e != nil {
		s.poisoned = true
		return e
	}
	s.journal = next
	s.journalDigest = digest(raw)
	return nil
}

func (s *Store) restoreJournal() error {
	marked, err := s.disk.journalMarked()
	if err != nil {
		return err
	}
	raw, err := s.disk.readJournal()
	if errors.Is(err, os.ErrNotExist) {
		if marked {
			return unavailable()
		}
		s.journal = transition.Journal{Entries: []transition.Entry{}}
		return nil // legacy: no continuity may be inferred from absence
	}
	if err != nil {
		return err
	}
	parsed, err := decodeJournal(s.binding, raw)
	if err != nil {
		return err
	}
	if err = s.disk.qualifyJournal(raw); err != nil {
		return err
	}
	if !marked { // crash after first intent but before marker durability
		if err = s.disk.markJournal(); err != nil {
			return err
		}
	}
	s.journal = parsed
	s.journalDigest = digest(raw)
	s.journalPresent = true
	return nil
}
