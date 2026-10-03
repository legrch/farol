package lifecycle

import (
	"context"
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Only Observe's correlated Accepted branch can adopt a provider identity.
// The exact old physical binding is retained in Before; After binds CID once.
func (s *Service) acceptProvider(ctx context.Context, h *Handle, b turn.Binding, cid string) (*turn.Snapshot, error) {
	if h.target.Mode != port.NewSaved || !validID(cid) {
		return nil, Mismatch
	}
	m, err := s.stage(ctx, h, false, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		if _, exists := s.providerOwners[cid]; exists {
			return port.JournalEntry{}, Mismatch
		}
		after, err := q.AcceptConversation(b, cid)
		return port.JournalEntry{Binding: h.fixed, Kind: "accept", Before: before, After: after}, err
	})
	if err != nil {
		return nil, err
	}
	if err = s.commit(ctx, m, true); err != nil {
		return nil, err
	}
	view := m.entry.After
	return &view, nil
}
