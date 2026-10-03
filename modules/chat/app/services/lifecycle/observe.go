package lifecycle

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Observe takes ONE bounded page with ONE semantic event. There is no background
// poller, clock, loop or replacement executor. Existing events/result are read
// separately; a lost observation never dispatches another Send. Publication of
// domain metadata, semantic state and each complete frame group is fenced.
func (c *Conversation) Observe(ctx context.Context, deadline uint64) error {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil || deadline == 0 {
		return Invalid
	}
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	if err := s.settlementAvailable(ctx); err != nil {
		s.deps.Gate.Unlock()
		return err
	}
	before, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil || !before.Bound || !before.SendIntent || before.Phase == turn.Unknown || h.releasedRevision != 0 {
		s.deps.Gate.Unlock()
		return Unsettled
	}
	if h.observing {
		s.deps.Gate.Unlock()
		return Busy
	}
	request := port.ObserveRequest{Binding: browserBinding(before.Binding), AfterSequence: h.sourceSequence, Limit: 1, DeadlineMillis: deadline}
	h.observing = true
	s.deps.Gate.Unlock()
	defer func() { s.deps.Gate.Lock(); h.observing = false; s.deps.Gate.Unlock() }()
	reply, err := s.deps.Browser.Observe(request)
	if err != nil {
		return s.observationFailure(h)
	}
	if err := port.ValidateObserveResponse(request, reply); err != nil {
		return s.observationFailure(h)
	}
	s.deps.Gate.Lock()
	current, snapshotErr := s.queue.Snapshot(identity(h.fixed))
	if s.unknown || s.retiring || s.retired != nil || s.pending != nil || ctx.Err() != nil || snapshotErr != nil || current != before || h.sourceSequence != request.AfterSequence {
		s.unknown = true
		s.deps.Gate.Unlock()
		return Unsettled
	}
	state, frames := h.output, h.frames.Clone()
	s.deps.Gate.Unlock()
	if len(reply.Events) == 0 {
		return nil
	}
	event := reply.Events[0]
	internal := context.WithValue(ctx, observationKey{}, h)
	duplicate := false
	// Stage the complete semantic/event candidate before journal IO. Overflow or
	// changed content is sticky and never turns into retryable provider work.
	switch event.Kind {
	case port.Accepted:
		state, duplicate, err = state.Accept(event.UserTurnID)
		if err == nil && !duplicate {
			err = createdFrames(h, frames)
		}
	case port.AnswerDelta:
		state, duplicate, err = state.Block(event.UserTurnID, event.ReplyID, event.SegmentID, event.Text)
		if err == nil && !duplicate {
			err = deltaFrames(h, state, event.Text, frames)
		}
	case port.Completed:
		duplicate = state.Complete && state.UserID == event.UserTurnID && state.ReplyID == event.ReplyID
		if !duplicate {
			state, err = state.Finish(event.UserTurnID, event.ReplyID)
		}
		if err == nil && !duplicate {
			err = completeFrames(h, state, frames)
		}
	case port.Quiescent:
		if !before.HasResult || event.UserTurnID != state.UserID || event.ReplyID != state.ReplyID {
			err = Mismatch
		}
	case port.Refused, port.OutcomeUnknown:
		if state.Accepted && (event.UserTurnID != state.UserID || (state.ReplyID != "" && event.ReplyID != state.ReplyID)) {
			err = Mismatch
			break
		}
		code := "PROVIDER_REFUSED"
		if event.Kind == port.OutcomeUnknown {
			code = "PROVIDER_OUTCOME_UNKNOWN"
		}
		err = failureFrames(h, code, frames)
	case port.AwaitingOwner:
	case port.Status, port.Commentary:
		// No fabricated reasoning/token/tool events or private Activity text.
	default:
		err = Invalid
	}
	if err != nil {
		return s.observationFailure(h)
	}
	view := &before
	switch event.Kind {
	case port.Accepted:
		if !duplicate {
			view, err = s.Apply(internal, h, Change{Action: Accept, Binding: before.Binding})
		}
	case port.AnswerDelta:
		if !duplicate {
			view, err = s.Apply(internal, h, Change{Action: Delta, Binding: before.Binding, Sequence: event.Sequence})
		}
	case port.Completed:
		if !duplicate {
			view, err = s.Finish(internal, h, before.Binding, turn.Result{ID: h.fixed.OperationID, Outcome: turn.Completed, Code: "PROVIDER_COMPLETED"}, []byte(state.Text()))
		}
	case port.Refused, port.OutcomeUnknown:
		outcome, code := turn.Refused, "PROVIDER_REFUSED"
		if event.Kind == port.OutcomeUnknown {
			outcome, code = turn.UnknownOutcome, "PROVIDER_OUTCOME_UNKNOWN"
		}
		view, err = s.Finish(internal, h, before.Binding, turn.Result{ID: h.fixed.OperationID, Outcome: outcome, Code: code}, []byte(state.Text()))
	case port.AwaitingOwner:
		view, err = s.Apply(internal, h, Change{Action: AwaitOwner, Binding: before.Binding})
	case port.Quiescent:
		view, err = s.Apply(internal, h, Change{Action: Settle, Quiescence: turn.QuiescenceEvidence{Binding: before.Binding, ResultID: before.Result.ID, Sequence: event.Sequence, Confirmed: true}})
	}
	if err != nil {
		return s.observationFailure(h)
	}
	if event.Kind == port.Quiescent {
		if err := s.releaseIfReady(internal, h, *view); err != nil {
			return s.observationFailure(h)
		}
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if s.unknown || ctx.Err() != nil || s.pending != nil || s.retiring || s.retired != nil {
		s.unknown = true
		return Unsettled
	}
	h.output, h.frames, h.sourceSequence = state, frames, event.Sequence
	return nil
}
func (s *Service) observationFailure(h *Handle) error {
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if s.handles[h.fixed.OperationID] == h {
		s.unknown = true
	}
	return Unsettled
}
