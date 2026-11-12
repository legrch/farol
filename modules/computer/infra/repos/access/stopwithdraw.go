package access

import (
	"context"

	stop "github.com/legrch/farol/modules/computer/domain/journal"
)

// ValidateOriginalStopConnector is a read-only pre-effect check. It requires
// the still-owned first C7 Stop intent and the ORIGINAL connector binding;
// an inherited marker, arbitrary parent UUID or same-looking root is not enough.
func (s *Store) ValidateOriginalStopConnector(ctx context.Context, parentID, buildID, backendGeneration, runtimeID, connectorGeneration string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return err
	}
	entry, found := s.stops.Find(parentID)
	if !found || s.activeStopID != parentID || s.stopWithdrawn ||
		entry.Phase != stop.StopEffectIntent ||
		entry.Request.BuildID != buildID ||
		entry.Request.BackendGeneration != backendGeneration ||
		entry.Request.RuntimeID != runtimeID ||
		entry.Request.ConnectorGeneration != connectorGeneration {
		return stop.ErrStopRefused
	}
	return nil
}

// WithdrawOriginalStopParticipant is narrowly scoped to the original admitted
// C7 Stop intent. Ordinary Status/Revoke remain closed during pending custody.
// This is the original connector's existing Store participant withdrawal, NOT
// approval revocation or permission to change an unrelated participant.
func (s *Store) WithdrawOriginalStopParticipant(ctx context.Context, parentID, participantID string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return err
	}
	original, ok := s.stops.Find(parentID)
	if !ok || s.activeStopID != parentID || s.stopWithdrawn ||
		original.Phase != stop.StopEffectIntent || participantID == "" {
		return stop.ErrStopRefused
	}
	participant, ok := s.current.Participants[participantID]
	if !ok || participant.Revoked || s.current.Revision == ^uint64(0) {
		return stop.ErrStopRefused
	}
	// Consume the in-memory original withdrawal BEFORE the first state effect.
	// Failure of a native/Store receipt cannot be retried by a replacement UUID,
	// even if the original protected bytes remain unchanged.
	s.stopWithdrawn = true
	next, err := s.nextState(s.current.Revision)
	if err != nil {
		s.poisoned = true
		return err
	}
	revoked := map[string]bool{participantID: true}
	for changed := true; changed; {
		changed = false
		for id, p := range next.Participants {
			if !revoked[id] && revoked[p.Value.ParentParticipantID] {
				revoked[id] = true
				changed = true
			}
		}
	}
	for id := range revoked {
		p := next.Participants[id]
		p.Revoked = true
		next.Participants[id] = p
	}
	if err = s.commit(ctx, next); err != nil {
		s.poisoned = true
		return err
	}
	if ctx.Err() != nil {
		s.poisoned = true
		return stop.ErrStopUnknown
	}
	for id := range revoked {
		if !s.current.Participants[id].Revoked {
			s.poisoned = true
			return stop.ErrStopUnknown
		}
	}
	return nil
}
