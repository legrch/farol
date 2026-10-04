package lifecycle

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/output"
	"github.com/legrch/farol/modules/chat/domain/stream"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// PromoteConversation binds conversation intent to the actual bare admission.
// The original queue admission digest remains admission-only deduplication;
// the promoted handle's digest is the full canonical intent used by Send.
// No browser operation occurs here, and no replacement turn/handle is minted.
func (s *Service) PromoteConversation(ctx context.Context, h *Handle, input port.ConversationInput) (*Conversation, error) {
	if s == nil || ctx == nil || h == nil || h.owner != s {
		return nil, Invalid
	}
	if input.Binding != h.fixed {
		return nil, Mismatch
	}
	target := port.ConversationTarget{Mode: port.NewSaved, Required: input.Required, Selection: input.Selection, Resolution: input.Resolution}
	if !target.Valid() || len(input.Prompt) == 0 || len(input.Prompt) > PromptBytesLimit || !utf8.ValidString(input.Prompt) {
		return nil, Invalid
	}
	if s.deps.IntentDigests == nil || s.deps.ResultBytesLimit < OutputBytesLimit {
		return nil, Unavailable
	}
	if _, ok := s.deps.Browser.(port.VerifiedBrowser); !ok {
		return nil, Unavailable
	}
	digest, err := s.intentDigest(input.Binding, target, input.Prompt)
	if err != nil {
		return nil, err
	}
	if !validIntentDigest(digest) {
		return nil, Invalid
	}
	s.deps.Gate.Lock()
	if s.handles[h.fixed.OperationID] != h {
		s.deps.Gate.Unlock()
		return nil, Mismatch
	}
	if err := s.available(ctx); err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	if c := h.conversation; c != nil {
		if !h.readPromoted {
			s.deps.Gate.Unlock()
			return nil, turn.Transition
		}
		if h.digest != digest || h.target != target {
			s.deps.Gate.Unlock()
			return nil, turn.Conflict
		}
		s.deps.Gate.Unlock()
		return c, nil
	}
	before, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil || h.closed || h.observing || h.unresolvedCallID != "" || h.caller != nil || !bareReadAdmission(before) {
		s.deps.Gate.Unlock()
		return nil, turn.Transition
	}
	candidate := s.queue.Clone()
	after, err := candidate.Enqueue(identity(h.fixed))
	if err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	frames, err := stream.New(streamScope(h.fixed), stream.DefaultLimits())
	if err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	c := &Conversation{owner: s, input: input, target: target, handle: h}
	c.root = c
	m := s.begin(candidate, h, port.JournalEntry{Binding: h.fixed, Kind: "promote-conversation", Before: before, After: after, IntentDigest: digest})
	m.conversation, m.frames = c, frames
	s.deps.Gate.Unlock()
	if err := s.commit(ctx, m, true); err != nil {
		return nil, err
	}
	return c, nil
}

// WithdrawReadIntent closes only the actual bare, never-dispatched admission.
// Known cancellation and the explicit business ACK use the same owning journal.
// A successful exact duplicate only observes terminal state. Pending/unknown
// writes cannot authorize a cancellation or acknowledgement retry.
func (s *Service) WithdrawReadIntent(ctx context.Context, h *Handle) error {
	if s == nil || ctx == nil || h == nil || h.owner != s {
		return Invalid
	}
	s.deps.Gate.Lock()
	if s.handles[h.fixed.OperationID] != h {
		s.deps.Gate.Unlock()
		return Mismatch
	}
	if err := s.settlementAvailable(ctx); err != nil {
		s.deps.Gate.Unlock()
		return err
	}
	before, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil || h.conversation != nil || h.observing || h.unresolvedCallID != "" || h.caller != nil {
		s.deps.Gate.Unlock()
		return turn.Transition
	}
	if h.readWithdrawal {
		known := h.closed && before.Phase == turn.Cancelled && before.HasResult && before.Result == (turn.Result{ID: h.fixed.OperationID, Outcome: turn.CancelledOutcome, Code: "NOT_DISPATCHED"}) && before.DeliveryAcknowledged && before.LifecycleSettled && !before.Reserved && h.ackRevision != 0
		s.deps.Gate.Unlock()
		if known {
			return nil
		}
		return Unsettled
	}
	if h.closed || !bareReadAdmission(before) {
		s.deps.Gate.Unlock()
		return turn.Transition
	}
	candidate := s.queue.Clone()
	after, err := candidate.Cancel(identity(h.fixed), h.fixed.OperationID)
	if err != nil {
		s.deps.Gate.Unlock()
		return err
	}
	h.closed, h.readWithdrawal = true, true
	m := s.begin(candidate, h, port.JournalEntry{Binding: h.fixed, Kind: "cancel", Before: before, After: after, Closed: true})
	m.readWithdrawal = true
	s.deps.Gate.Unlock()
	if err := s.commit(ctx, m, true); err != nil {
		return err
	}
	// The known cancel commit stages this same writer's ACK before releasing
	// Gate. Keep journal IO outside Gate without allowing another writer between.
	return s.commit(ctx, m, true)
}

// stageReadWithdrawalACK runs under the known cancel publication's Gate. Reuse
// the exact pending mutation/fence, as with browser effect settlement; unknown
// cancellation never reaches this continuation and unknown ACK never retries.
func (s *Service) stageReadWithdrawalACK(m *mutation) error {
	candidate := s.queue.Clone()
	after, err := candidate.Acknowledge(identity(m.handle.fixed), m.entry.After.Result.ID)
	if err != nil {
		s.unknown = true
		return Unsettled
	}
	m.candidate = candidate
	m.entry = port.JournalEntry{Binding: m.handle.fixed, Kind: "acknowledge", Before: m.entry.After, After: after, Closed: true}
	return nil
}

func bareReadAdmission(view turn.Snapshot) bool {
	return view.Phase == turn.Admitted && !view.Reserved && !view.Bound && !view.SendIntent && !view.HasResult && view.OutstandingCallID == ""
}

func validIntentDigest(digest string) bool {
	return len(digest) == 64 && strings.IndexFunc(digest, func(c rune) bool { return !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) }) == -1
}

// publishPromotion runs only under the commit gate after its exact known receipt.
func (m *mutation) publishPromotion() {
	c, h := m.conversation, m.handle
	h.conversation, h.target, h.digest = c, c.target, m.entry.IntentDigest
	h.prompt, c.input.Prompt = c.input.Prompt, ""
	h.frames, h.output = m.frames, output.New(OutputBytesLimit, c.target.PreviousUserTurnID, c.target.PreviousReplyID)
	h.readPromoted = true
	c.root.latest = c
}
