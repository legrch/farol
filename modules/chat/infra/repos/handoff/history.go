package handoff

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

func historyID(id string) bool {
	return len(id) > 0 && len(id) <= 120 && utf8.ValidString(id) &&
		strings.IndexFunc(id, func(r rune) bool { return r <= 32 || r == 127 }) < 0
}

// Validate the request before storage IO. The exact anchor is still compared
// with the fully qualified current head; well-formed values supply no authority.
func validHistoryAnchor(a port.HistoryAnchor) bool {
	c := a.Consumption
	b := c.NextBinding
	for _, id := range []string{c.AttemptID, c.Next.ProfileID, c.Next.BackendGeneration,
		b.ProfileID, b.BackendGeneration, b.BuildID, b.HostLifetimeID, b.ChildLaunchID} {
		if !historyID(id) {
			return false
		}
	}
	return a.HeadDigest != ([32]byte{}) && c.PreviousHostDrainConfirmed &&
		c.Next == (port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}) &&
		b.ParentRoot.Device != 0 && b.ParentRoot.Inode != 0 && b.ChatRoot.Inode != 0 &&
		b.ChatRoot.Device == b.ParentRoot.Device && b.ChatRoot.OwnerUID == b.ParentRoot.OwnerUID &&
		b.ChatRoot != b.ParentRoot
}

func (r *Repository) historyInput(ctx context.Context, a port.HistoryAnchor, ownerID string) error {
	if r == nil || r.owner == nil || ctx == nil || !validHistoryAnchor(a) || !historyID(ownerID) {
		return fail(Invalid, false)
	}
	b, roots := a.Consumption.NextBinding, r.owner.roots
	if b.ProfileID != roots.ProfileID || b.ParentRoot != roots.Parent.Identity || b.ChatRoot != roots.Chat.Identity {
		return fail(Refused, false)
	}
	return nil
}

// historyScan runs under the repository IO mutex and retains only bounded key
// projections in addition to the scanner's replay projections and one receipt.
// ValidateRecord already closes completed versus never-dispatched evidence.
// Selection adds no weaker completion policy and reads no result payload file.
func (s *owner) historyScan(ctx context.Context, a port.HistoryAnchor, ownerID string, selectTurn func(port.HistoryMatch, uint32)) (uint32, error) {
	if err := s.check(ctx); err != nil {
		return 0, err
	}
	keys := make(map[port.HistoryKey]struct{})
	var total uint32
	head, _, _, err := s.scanEach(ctx, func(r port.HandoffRecord) error {
		if r.Stage != port.HandoffConsumed {
			return nil
		}
		for _, v := range r.Receipt.Write.Turns {
			if v.Snapshot.Result.Outcome != turn.Completed {
				continue
			}
			key := port.HistoryKey{BackendGeneration: v.Binding.BackendGeneration, OperationID: v.Binding.OperationID}
			if _, duplicate := keys[key]; duplicate || len(keys) >= port.MaxRetainedResults {
				return s.uncertain()
			}
			keys[key] = struct{}{}
			if v.Binding.OwnerID == ownerID {
				selectTurn(port.HistoryMatch{Anchor: a, Origin: r.Publication,
					PreviousRevision: r.Receipt.Write.PreviousRevision, Turn: v}, total)
				total++
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	if ctx.Err() != nil {
		return 0, s.uncertain()
	}
	if head.Record == nil || head.Digest != a.HeadDigest || head.Record.Stage != port.HandoffConsumed ||
		head.Record.Consumption == nil || *head.Record.Consumption != a.Consumption {
		return 0, fail(Refused, false)
	}
	return total, nil
}

// HistoryPage returns independent value projections in immutable consumed-chain
// order, then the operation order already required by ValidateRecord.
func (r *Repository) HistoryPage(ctx context.Context, a port.HistoryAnchor, ownerID string, offset uint32) (*port.HistoryPage, error) {
	if err := r.historyInput(ctx, a, ownerID); err != nil {
		return nil, err
	}
	if offset > port.MaxRetainedResults {
		return nil, fail(Refused, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	page := &port.HistoryPage{Anchor: a, Offset: offset, Entries: make([]port.HistoryMatch, 0, port.HistoryPageSize)}
	total, err := s.historyScan(ctx, a, ownerID, func(m port.HistoryMatch, index uint32) {
		if index >= offset && len(page.Entries) < port.HistoryPageSize {
			page.Entries = append(page.Entries, m)
		}
	})
	if err != nil {
		return nil, err
	}
	if offset > total {
		return nil, fail(Refused, false)
	}
	page.Total = total
	return page, nil
}

// HistoryFind must validate even records after a match, and the exact current
// anchor, before returning it. A missing owner/key pair returns nil,nil.
func (r *Repository) HistoryFind(ctx context.Context, a port.HistoryAnchor, ownerID string, key port.HistoryKey) (*port.HistoryMatch, error) {
	if err := r.historyInput(ctx, a, ownerID); err != nil {
		return nil, err
	}
	if !historyID(key.BackendGeneration) || !historyID(key.OperationID) {
		return nil, fail(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	var match *port.HistoryMatch
	_, err := s.historyScan(ctx, a, ownerID, func(m port.HistoryMatch, _ uint32) {
		if m.Turn.Binding.BackendGeneration == key.BackendGeneration && m.Turn.Binding.OperationID == key.OperationID {
			match = &m
		}
	})
	if err != nil {
		return nil, err
	}
	return match, nil
}
