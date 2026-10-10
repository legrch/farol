package lifecycle

import (
	"context"
	"math"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

const SourceIncomplete Code = "CHAT_LIFECYCLE_SOURCE_INCOMPLETE"

// ContextTurn is an original text-only admitted exchange. It is correlation
// data, not a provider request, delivery ACK or account disclosure grant.
// Source text is retained only for this live owner; no historical restoration
// or permanent transcript database is introduced.
type ContextTurn struct {
	Binding                                                     port.TurnBinding
	Prompt, Text, ProviderUserTurnID, ProviderReplyID, ResultID string
	Complete                                                    bool
}
type ContextSnapshot struct {
	Revision  uint64
	Selection port.Selection
	Turns     []ContextTurn
}

// ContextLease pins one exact original owner, chain and known source revision.
// A fresh capture cannot make this old lease current. No request IDs/URLs or
// stored projections can construct it. Trusted composition must additionally
// supply its original selected-account disclosure lease before using content.
type ContextLease struct {
	owner           *Service
	latest          *Conversation
	revision, fence uint64
	snapshot        ContextSnapshot
}

// CaptureContext reads the actual live owner under its existing gate. It refuses
// tool rounds because the current owner does not retain their full originals.
// It never replays a provider effect or upgrades UNKNOWN to a complete source.
func (c *Conversation) CaptureContext(ctx context.Context) (*ContextLease, error) {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return nil, Invalid
	}
	s := c.owner
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	snapshot, err := c.contextSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	return &ContextLease{owner: s, latest: c, revision: s.revision, fence: s.fence, snapshot: snapshot}, nil
}

// WithCurrent makes exactly one synchronous callback under the original gate.
// Callbacks must not perform IO, mutate/reenter the owner or retain this as Send
// authority. Returned slices are detached; callback edits cannot mutate originals.
func (l *ContextLease) WithCurrent(ctx context.Context, inspect func(ContextSnapshot) error) error {
	if l == nil || l.owner == nil || l.latest == nil || ctx == nil || inspect == nil {
		return Invalid
	}
	s := l.owner
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if s.revision != l.revision || s.fence != l.fence {
		return Mismatch
	}
	now, err := l.latest.contextSnapshot(ctx)
	if err != nil {
		return err
	}
	if !sameContextSnapshot(now, l.snapshot) {
		return Mismatch
	}
	copy := l.snapshot
	copy.Turns = append([]ContextTurn{}, l.snapshot.Turns...)
	if err := inspect(copy); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}

func sameContextSnapshot(a, b ContextSnapshot) bool {
	if a.Revision != b.Revision || a.Selection != b.Selection || len(a.Turns) != len(b.Turns) {
		return false
	}
	for i := range a.Turns {
		if a.Turns[i] != b.Turns[i] {
			return false
		}
	}
	return true
}

// Caller holds the lifecycle gate. Read checks do not mutate UNKNOWN, including
// at revision/fence exhaustion, and do not qualify frozen owners as new sources.
func (c *Conversation) contextSnapshot(ctx context.Context) (ContextSnapshot, error) {
	s := c.owner
	if ctx.Err() != nil {
		return ContextSnapshot{}, Cancelled
	}
	if s.unknown || s.revision == math.MaxUint64 || s.fence == math.MaxUint64 {
		return ContextSnapshot{}, Unsettled
	}
	if s.pending != nil || s.retiring {
		return ContextSnapshot{}, Busy
	}
	if s.frozen || s.retired != nil {
		return ContextSnapshot{}, Frozen
	}
	if c.root == nil || c.root.latest != c || s.revision == 0 {
		return ContextSnapshot{}, Mismatch
	}
	snapshot := ContextSnapshot{Revision: s.revision, Selection: c.target.Selection, Turns: []ContextTurn{}}
	seen := map[*Conversation]bool{}
	for current := c; current != nil; current = current.previous {
		h := current.handle
		if seen[current] || len(snapshot.Turns) >= turn.MaxRequests || current.owner != s || current.root != c.root || h == nil || h.owner != s || s.handles[h.fixed.OperationID] != h || h.conversation != current || current.target.Selection != snapshot.Selection {
			return ContextSnapshot{}, Mismatch
		}
		seen[current] = true
		if h.observing {
			return ContextSnapshot{}, Busy
		}
		view, err := s.queue.Snapshot(identity(h.fixed))
		if err != nil || view.Phase == turn.Unknown {
			return ContextSnapshot{}, Unsettled
		}
		// The legacy owner discards caller output and keeps only one call.
		// An acknowledged tool round is not a complete reconstructible source.
		if h.contextToolRound || h.caller != nil || h.unresolvedCallID != "" || view.OutstandingCallID != "" {
			return ContextSnapshot{}, SourceIncomplete
		}
		prompt := h.contextPrompt
		if prompt == "" || len(prompt) > PromptBytesLimit || !utf8.ValidString(prompt) {
			return ContextSnapshot{}, SourceIncomplete
		}
		item := ContextTurn{Binding: h.fixed, Prompt: prompt}
		if view.HasResult {
			if view.Result.Outcome != turn.Completed || !h.output.Complete || !validID(h.output.UserID) || !validID(h.output.ReplyID) || h.retained == nil || h.retained.Result != view.Result || h.retained.Binding != h.fixed || !h.retained.Conversation.Complete {
				return ContextSnapshot{}, SourceIncomplete
			}
			item.Text, item.ProviderUserTurnID, item.ProviderReplyID, item.ResultID, item.Complete = h.output.Text(), h.output.UserID, h.output.ReplyID, view.Result.ID, true
		} else if current != c || view.SendIntent || h.output.Text() != "" || h.sourceSequence != 0 || h.closed {
			return ContextSnapshot{}, SourceIncomplete
		}
		if current != c && !followSettled(h, view) {
			return ContextSnapshot{}, SourceIncomplete
		}
		snapshot.Turns = append(snapshot.Turns, item)
	}
	for i, j := 0, len(snapshot.Turns)-1; i < j; i, j = i+1, j-1 {
		snapshot.Turns[i], snapshot.Turns[j] = snapshot.Turns[j], snapshot.Turns[i]
	}
	return snapshot, nil
}
