package access

import (
	"context"
	"errors"
	"os"

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
