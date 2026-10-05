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
	reply, err := s.deps.Browser.Prepare(port.PrepareRequest{Target: h.target, Lease: lease, DeadlineMillis: deadlineMillis})
	if err != nil || reply == nil || reply.Binding.Lease != lease {
		return nil, s.fail(m)
	}
	if reply.Readiness != port.Ready && reply.Readiness != port.OwnerRequired {
		return nil, s.fail(m)
	}
	binding := reply.Binding
	if (h.target.Mode == port.NewSaved && (reply.Saved || binding.ProviderState != port.ProviderHome || binding.ConversationID != "")) || (h.target.Mode == port.OwnedSaved && (!reply.Saved || binding.ProviderState != port.ProviderBound || binding.ConversationID != h.target.ConversationID)) {
		return nil, s.fail(m)
	}
	err = s.settle(ctx, m, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		if h.target.Mode == port.OwnedSaved {
			owned, exists := s.providerOwners[binding.ConversationID]
			if !exists || !sameConversationOwner(owned, h.fixed) {
				return port.JournalEntry{}, Mismatch
			}
		}
		after, err := q.Bind(reservation, turn.Document{ProviderState: turn.ProviderState(binding.ProviderState), ViewID: binding.ViewID, ViewGeneration: binding.ViewGeneration, DocumentGeneration: binding.DocumentGeneration, ConversationID: binding.ConversationID})
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
	if h == nil || h.owner != s {
		return nil, Invalid
	}
	var target port.ConversationTarget
	var intentDigest string
	m, err := s.stage(ctx, h, false, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		// Promotion publishes these together under Gate. Validate and retain one
		// coherent snapshot before dispatch; a pre-stage read can miss promotion.
		target, intentDigest = h.target, h.digest
		if target.Mode != "" {
			digest, err := s.intentDigest(h.fixed, target, prompt)
			if err != nil || digest != intentDigest {
				return port.JournalEntry{}, Mismatch
			}
		}
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
	s.deps.Gate.Lock()
	h.prompt = ""
	s.deps.Gate.Unlock()
	var verification port.SendVerification
	if target.Mode != "" {
		verified, ok := s.deps.Browser.(port.VerifiedBrowser)
		if !ok {
			return nil, s.fail(m)
		}
		request := port.VerifySendRequest{Binding: binding, Required: target.Required, Requested: target.Selection, IntentDigest: intentDigest, PreviousUserTurnID: target.PreviousUserTurnID, PreviousReplyID: target.PreviousReplyID, DeadlineMillis: deadlineMillis}
		proof, err := verified.VerifySend(request)
		if err != nil || !port.ValidVerification(request, proof) {
			return nil, s.fail(m)
		}
		s.deps.Gate.Lock()
		err = s.current(ctx, m)
		if err == nil && s.usedVerifications[proof.EvidenceID] {
			err = Unsettled
			s.unknown = true
		}
		if err == nil {
			verification = *proof
			s.usedVerifications[proof.EvidenceID] = true
			h.verification = verification
			h.prompt = ""
		}
		s.deps.Gate.Unlock()
		if err != nil {
			return nil, err
		}
	}
	request, authorizationErr := s.authorizeSend(ctx, m, port.SendRequest{Verification: verification, Binding: binding, IntentDigest: intentDigest, Prompt: prompt, DeadlineMillis: deadlineMillis})
	var reply *port.SendResponse
	var browserErr error
	if authorizationErr != nil {
		// No physical call occurred. Settle through the same known not-sent
		// result path; failure to retain/commit still fences the owning mutation.
		reply = &port.SendResponse{VerificationID: verification.EvidenceID, Binding: binding, Status: port.NotSent}
	} else {
		reply, browserErr = s.deps.Browser.Send(*request)
	}
	outcome := turn.UnknownOutcome
	code := "SEND_OUTCOME_UNKNOWN"
	if browserErr == nil && reply != nil && reply.Binding == binding && (target.Mode == "" || reply.VerificationID == verification.EvidenceID) {
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
		s.deps.Gate.Lock()
		currentErr := s.current(ctx, m)
		metadata := retainedConversation(h, h.output)
		s.deps.Gate.Unlock()
		if currentErr != nil {
			return nil, currentErr
		}
		if !metadata.Valid(result, nil) {
			return nil, s.fail(m)
		}
		receipt, err := s.deps.Results.Retain(ctx, port.RetainRequest{Binding: h.fixed, Result: result, Conversation: metadata})
		if err != nil || receipt == nil || receipt.Binding != h.fixed || receipt.Result != result || receipt.Bytes != 0 || receipt.Conversation != metadata {
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
	return port.BrowserBinding{ProviderState: port.ProviderState(d.ProviderState), Lease: browserLease(b.Reservation), ViewID: d.ViewID, ViewGeneration: d.ViewGeneration, DocumentGeneration: d.DocumentGeneration, ConversationID: d.ConversationID}
}

func sameConversationOwner(a, b port.TurnBinding) bool {
	return a.ProfileID == b.ProfileID && a.BackendGeneration == b.BackendGeneration && a.OwnerID == b.OwnerID && a.SessionID == b.SessionID && a.TaskID == b.TaskID && a.TaskEpoch == b.TaskEpoch && a.ParticipantID == b.ParticipantID
}

// PreparedOwner returns only the exact current reservation's fixed caller
// binding. The browser's DOM identity can never mint TaskEpoch/ParticipantID.
func (s *Service) PreparedOwner(ctx context.Context, binding port.BrowserBinding) (port.TurnBinding, error) {
	if s == nil || ctx == nil {
		return port.TurnBinding{}, Invalid
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if err := s.settlementAvailable(ctx); err != nil {
		return port.TurnBinding{}, err
	}
	h := s.handles[binding.Lease.Identity.OperationID]
	if h == nil {
		return port.TurnBinding{}, Mismatch
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil || h.closed || !view.Bound || browserBinding(view.Binding) != binding {
		return port.TurnBinding{}, Mismatch
	}
	return h.fixed, nil
}
