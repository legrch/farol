package lifecycle

import (
	"context"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// PrepareNext reserves only the queue's next eligible route. Ordinal is never
// used as a route lookup. The journal records the exact lease before one Prepare;
// positive admission stays withdrawn until exact document settlement is committed.
func (s *Service) PrepareNext(ctx context.Context, deadlineMillis uint64) (*port.BrowserBinding, error) {
	if s == nil || ctx == nil || deadlineMillis == 0 {
		return nil, Invalid
	}
	if s.deps.Browser == nil {
		return nil, Unavailable
	}
	s.deps.Gate.Lock()
	if err := s.available(ctx); err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	candidate := s.queue.Clone()
	reservation, err := candidate.Reserve()
	if err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	h := s.handles[reservation.Identity.OperationID]
	if h == nil || h.closed || identity(h.fixed) != reservation.Identity {
		s.deps.Gate.Unlock()
		return nil, Mismatch
	}
	before, err := s.queue.Snapshot(reservation.Identity)
	if err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	after, err := candidate.Snapshot(reservation.Identity)
	if err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	m := s.begin(candidate, h, port.JournalEntry{Binding: h.fixed, Kind: "reserve", Before: before, After: after, Effect: "prepare"})
	s.deps.Gate.Unlock()
	if err := s.commit(ctx, m, false); err != nil {
		return nil, err
	}
	if err := s.effectCurrent(ctx, m); err != nil {
		return nil, err
	}
	lease := browserLease(reservation)
	reply, err := s.deps.Browser.Prepare(port.PrepareRequest{Lease: lease, DeadlineMillis: deadlineMillis})
	if err != nil || reply == nil || reply.Binding.Lease != lease {
		return nil, s.fail(m)
	}
	if reply.Readiness != port.Ready && reply.Readiness != port.OwnerRequired {
		return nil, s.fail(m)
	}
	binding := reply.Binding
	err = s.settle(ctx, m, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		after, err := q.Bind(reservation, turn.Document{ViewID: binding.ViewID, ViewGeneration: binding.ViewGeneration, DocumentGeneration: binding.DocumentGeneration, ConversationID: binding.ConversationID})
		if err == nil && reply.Readiness == port.OwnerRequired {
			after, err = q.AwaitOwner(after.Binding)
		}
		return port.JournalEntry{Binding: h.fixed, Kind: "prepared", Before: before, After: after}, err
	})
	if err != nil {
		return nil, err
	}
	return &binding, nil
}

// Send durably records one exact intent, then calls Desktop once with transient
// prompt bytes. It never replays. Submitted is not provider acceptance; Accept
// remains a separately correlated observation. Errors, lost/mismatched replies
// and unknown outcomes commit sticky Unknown when possible, never another Send.
func (s *Service) Send(ctx context.Context, h *Handle, prompt string, deadlineMillis uint64, failureResultID string) (*turn.Snapshot, error) {
	if s == nil || prompt == "" || !utf8.ValidString(prompt) || deadlineMillis == 0 || !validID(failureResultID) {
		return nil, Invalid
	}
	if s.deps.Browser == nil {
		return nil, Unavailable
	}
	m, err := s.stage(ctx, h, false, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		binding, err := q.ActiveBinding(identity(h.fixed))
		if err != nil {
			return port.JournalEntry{}, err
		}
		after, err := q.Dispatch(binding)
		return port.JournalEntry{Binding: h.fixed, Kind: "dispatch", Before: before, After: after, Effect: "send"}, err
	})
	if err != nil {
		return nil, err
	}
	if err := s.commit(ctx, m, false); err != nil {
		return nil, err
	}
	if err := s.effectCurrent(ctx, m); err != nil {
		return nil, err
	}
	binding := browserBinding(m.entry.After.Binding)
	reply, browserErr := s.deps.Browser.Send(port.SendRequest{Binding: binding, IntentDigest: h.digest, Prompt: prompt, DeadlineMillis: deadlineMillis})
	outcome := turn.UnknownOutcome
	code := "SEND_OUTCOME_UNKNOWN"
	if browserErr == nil && reply != nil && reply.Binding == binding {
		switch reply.Status {
		case port.Submitted:
			outcome = ""
		case port.NotSent:
			outcome, code = turn.Failed, "SEND_NOT_SENT"
		case port.SendUnknown:
		}
	}
	if err := s.effectCurrent(ctx, m); err != nil {
		return nil, err
	}
	result := turn.Result{ID: failureResultID, Outcome: outcome, Code: code}
	if outcome == turn.Failed {
		// A known failure result is retained before result-ready publication.
		if s.deps.Results == nil {
			return nil, s.fail(m)
		}
		receipt, err := s.deps.Results.Retain(ctx, port.RetainRequest{Binding: h.fixed, Result: result})
		if err != nil || receipt == nil || receipt.Binding != h.fixed || receipt.Result != result || receipt.Bytes != 0 {
			return nil, s.fail(m)
		}
	}
	err = s.settle(ctx, m, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		after := before
		var err error
		if outcome != "" {
			after, err = q.Finish(before.Binding, result)
		}
		return port.JournalEntry{Binding: h.fixed, Kind: "send-settled", Before: before, After: after, Closed: outcome != ""}, err
	})
	if err != nil {
		return nil, err
	}
	view := m.entry.After
	return &view, nil
}

func (s *Service) effectCurrent(ctx context.Context, m *mutation) error {
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	return s.current(ctx, m)
}

// This is not a public arbitrary-effect callback. Only the two narrow browser
// methods above can settle their own already committed intent.
func (s *Service) settle(ctx context.Context, m *mutation, derive func(*turn.Queue, turn.Snapshot) (port.JournalEntry, error)) error {
	s.deps.Gate.Lock()
	if err := s.current(ctx, m); err != nil {
		s.deps.Gate.Unlock()
		return err
	}
	candidate := s.queue.Clone()
	entry, err := derive(candidate, m.entry.After)
	if err != nil {
		s.unknown = true
		s.deps.Gate.Unlock()
		return Unsettled
	}
	m.candidate, m.entry = candidate, entry
	if entry.Closed {
		m.handle.closed = true
	}
	s.deps.Gate.Unlock()
	return s.commit(ctx, m, true)
}

func browserLease(r turn.Reservation) port.BrowserLease {
	i := r.Identity
	return port.BrowserLease{Identity: port.RequestIdentity{ProfileID: i.ProfileID, OwnerID: i.OwnerID, SessionID: i.SessionID, TaskID: i.TaskID, TurnID: i.TurnID, OperationID: i.OperationID, TurnGeneration: i.Generation}, BackendGeneration: r.BackendGeneration, SlotOrdinal: r.Ordinal, SlotGeneration: r.Generation}
}
func browserBinding(b turn.Binding) port.BrowserBinding {
	d := b.Document
	return port.BrowserBinding{Lease: browserLease(b.Reservation), ViewID: d.ViewID, ViewGeneration: d.ViewGeneration, DocumentGeneration: d.DocumentGeneration, ConversationID: d.ConversationID}
}
