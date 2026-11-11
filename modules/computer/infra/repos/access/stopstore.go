package access

import (
	"context"
	"errors"
	"os"

	"github.com/legrch/farol/modules/computer/domain/authority"
	stop "github.com/legrch/farol/modules/computer/domain/journal"
)

// StopState exposes protected historical custody only, never a Stop dispatch
// permit, native closure confirmation, Settings ACK or current approval.
type StopState struct {
	Ledger     stop.StopLedger
	Present    bool
	Restricted bool
	Delivery   string
}

// restoreStopLedger runs under the existing acquired access lifetime lock.
// A permanent first-presence witness with absent bytes, or bytes without their
// witness, is ALWAYS an error; no predecessor marker supplies a replacement.
func (s *Store) restoreStopLedger() error {
	marked, err := s.disk.stopWitness()
	if err != nil {
		return err
	}
	raw, err := s.disk.readStopLedger()
	if !marked && errors.Is(err, os.ErrNotExist) {
		s.stops = stop.StopLedger{Entries: []stop.StopEntry{}}
		return nil
	}
	if !marked || errors.Is(err, os.ErrNotExist) {
		return unavailable()
	}
	if err != nil {
		return err
	}
	parsed, err := decodeStopLedger(s.binding, raw)
	if err != nil {
		return err
	}
	if err = s.disk.qualifyStopLedger(raw); err != nil {
		return err
	}
	marked, err = s.disk.stopWitness()
	if err != nil || !marked {
		return unavailable()
	}
	s.stops = parsed
	s.stopLedgerDigest = digest(raw)
	s.stopPresent = true
	return nil
}

// checkStopStorage is called from the SAME protected read/admission boundary
// as the access snapshot and C4 WAL. No earlier visible bytes can justify a
// fresh admission after a changed, corrupt, missing or foreign first witness.
func (s *Store) checkStopStorage() error {
	marked, err := s.disk.stopWitness()
	if err != nil {
		s.poisoned = true
		return err
	}
	raw, err := s.disk.readStopLedger()
	if !s.stopPresent {
		if marked || !errors.Is(err, os.ErrNotExist) {
			s.poisoned = true
			return unavailable()
		}
		return nil
	}
	if !marked || err != nil || digest(raw) != s.stopLedgerDigest {
		s.poisoned = true
		return refuse(err)
	}
	return nil
}

func (s *Store) StopStatus(ctx context.Context) (StopState, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return StopState{}, err
	}
	return StopState{
		Ledger: s.stops.Clone(), Present: s.stopPresent,
		Restricted: s.stops.Pending(), Delivery: "not_recorded",
	}, nil
}

// ObserveOriginalStop returns only the original protected phase. It cannot
// issue a fresh effect permit or fabricate historical delivery after restart.
func (s *Store) ObserveOriginalStop(ctx context.Context, id string) (stop.StopEntry, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return stop.StopEntry{}, err
	}
	entry, ok := s.stops.Find(id)
	if !ok {
		return stop.StopEntry{}, stop.ErrStopRefused
	}
	return entry, nil
}

func (s *Store) ObserveStopLedger(ctx context.Context) (stop.StopLedger, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return stop.StopLedger{}, err
	}
	return s.stops.Clone(), nil
}

// BeginStop admits only the original parent. The FIRST durable witness and
// admission record both finish readback before returning first=true. Existing
// identity is strictly observational; competing requests cannot dispatch.
func (s *Store) BeginStop(ctx context.Context, request stop.StopRequest) (stop.StopEntry, bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return stop.StopEntry{}, false, err
	}
	if request.ProfileID != s.binding.ProfileID || request.OwnerID != s.binding.OwnerID ||
		request.ComputerID != s.binding.ComputerID || !stop.ValidStopRequest(request) {
		return stop.StopEntry{}, false, stop.ErrStopRefused
	}
	if previous, ok := s.stops.Find(request.OperationID); ok {
		if previous.Request != request {
			return stop.StopEntry{}, false, stop.ErrStopRefused
		}
		return previous, false, nil
	}
	// Even though the prerequisite is independently owned, a current or
	// unresolved C4 transition may not acquire another Stop parent.
	if s.transitionRestricted() {
		return stop.StopEntry{}, false, stop.ErrStopPending
	}
	next, first, err := s.stops.Begin(request)
	if err != nil || !first {
		return stop.StopEntry{}, false, err
	}
	raw, err := encodeStopLedger(s.binding, next)
	if err != nil {
		return stop.StopEntry{}, false, err
	}
	if !s.stopPresent {
		if err = s.disk.markStopWitness(); err == nil {
			err = s.disk.beginStopLedger(raw)
		}
	} else {
		err = s.disk.updateStopLedger(raw, s.stopLedgerDigest)
	}
	if err != nil {
		s.poisoned = true
		return stop.StopEntry{}, false, err
	}
	s.stops, s.stopLedgerDigest, s.stopPresent = next, digest(raw), true
	if ctx.Err() != nil {
		// A late confirmed publication after cancellation is not permission
		// to start Stop; retain the original fenced record on disk.
		s.poisoned = true
		return stop.StopEntry{}, false, stop.ErrStopUnknown
	}
	// Only this confirmed first admission in this Store lifetime holds the
	// ephemeral right to advance the original. Neither restore nor duplicate
	// BeginStop, a matching visible digest, or a terminal certificate grants it.
	s.activeStopID = request.OperationID
	s.stopWithdrawn = false
	entry, _ := next.Find(request.OperationID)
	return entry, true, nil
}

// AdvanceStop is the protected Go-side original-phase publication. A future
// trusted composition layer must validate each native/Settings original ACK
// against its effect owner; this low-level repository is not an RPC handler.
func (s *Store) AdvanceStop(ctx context.Context, id string, next stop.StopEntry) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		if ctx != nil && ctx.Err() != nil && s.activeStopID == id {
			s.activeStopID = ""
			s.poisoned = true
		}
		return err
	}
	// A retained phase is observation-only after restart or a repeated Begin.
	// The right to advance belongs exclusively to the successful first BeginStop
	// of this Store lifetime. Visible identical protected bytes cannot mint it.
	if !s.stopPresent || s.activeStopID != id {
		return stop.ErrStopRefused
	}
	updated, err := s.stops.Update(id, next)
	if err != nil {
		return err
	}
	raw, err := encodeStopLedger(s.binding, updated)
	if err != nil {
		return err
	}
	if err = s.disk.updateStopLedger(raw, s.stopLedgerDigest); err != nil {
		s.activeStopID = ""
		s.poisoned = true
		return err
	}
	s.stops, s.stopLedgerDigest = updated, digest(raw)
	if ctx.Err() != nil {
		s.activeStopID = ""
		s.poisoned = true
		return stop.ErrStopUnknown
	}
	if next.Terminal() || next.Phase == stop.StopUnresolved {
		s.activeStopID = ""
	}
	return nil
}

// RefuseStopBeforeDispatch applies only while Go's original admission still
// has NO admitted Stop effect intent. It cannot reclassify a dispatched/UNKNOWN
// Stop, and does not create a migration certificate.
func (s *Store) RefuseStopBeforeDispatch(ctx context.Context, id string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		if ctx != nil && ctx.Err() != nil && s.activeStopID == id {
			s.activeStopID = ""
			s.poisoned = true
		}
		return err
	}
	original, ok := s.stops.Find(id)
	// A newly opened Store can see the original admission intent, but it has
	// no dispatch-proof capability and cannot turn it into a known refusal.
	if !ok || original.Phase != stop.StopAdmissionIntent || s.activeStopID != id {
		return stop.ErrStopRefused
	}
	next := original.Clone()
	next.Phase = stop.StopRefusedBeforeDispatch
	next.Refusal = "cancelled_before_dispatch"
	updated, err := s.stops.Update(id, next)
	if err != nil {
		return err
	}
	raw, err := encodeStopLedger(s.binding, updated)
	if err != nil {
		return err
	}
	if err = s.disk.updateStopLedger(raw, s.stopLedgerDigest); err != nil {
		s.activeStopID = ""
		s.poisoned = true
		return err
	}
	s.stops, s.stopLedgerDigest = updated, digest(raw)
	// A confirmed no-dispatch refusal releases only the original runtime claim.
	s.activeStopID = ""
	if ctx.Err() != nil {
		s.poisoned = true
		return stop.ErrStopUnknown
	}
	return nil
}

// STOP custody is entirely separate from current native Computer authority.
// Any current authority read still uses Store.check and its existing policy.
// A legacy marker or a successful historical certificate does not grant access.
var _ = authority.Fail
