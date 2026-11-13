package access

import (
	"context"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
)

// TransitionEffectSnapshot reads CURRENT protected Store counters only for the
// exact already-written original WAL effect intent. It does not inspect grants,
// publish authority or bypass the unresolved-transition admission fence.
// Ordinary Status/WithSnapshot remain unavailable during pending transitions.
func (s *Store) TransitionEffectSnapshot(ctx context.Context, originalOperation string, expected journal.Phase, expectedReceipt journal.Receipt) (Status, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return Status{}, err
	}
	if !s.journalPresent || s.current.Approval == nil {
		return Status{}, unavailable()
	}
	entry, ok := s.journal.Find(originalOperation)
	if !ok || entry.Phase != expected || entry.Request.ProfileID != s.binding.ProfileID ||
		entry.Request.OwnerID != s.binding.OwnerID || entry.Request.ComputerID != s.binding.ComputerID ||
		!s.journal.Unresolved() {
		return Status{}, unavailable()
	}
	var recorded journal.Receipt
	switch expected {
	case journal.WithdrawIntent:
		recorded = entry.Withdraw
	case journal.SettingsIntent:
		recorded = entry.Settings
	case journal.PublishIntent:
		recorded = entry.Publication
	case journal.CloseIntent:
		recorded = entry.Cleanup
	default:
		return Status{}, unavailable()
	}
	if recorded != expectedReceipt || recorded.EffectID == "" || recorded.Digest == "" {
		return Status{}, unavailable()
	}
	return Status{Revision: s.current.Revision, Generation: s.current.Generation, ApprovalPresent: true}, nil
}
