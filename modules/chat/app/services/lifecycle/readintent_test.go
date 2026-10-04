package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// These tests reuse CPU-only journal/browser fixtures. They qualify neither
// live Computer disclosure, provider IO, durable storage nor nonempty restart.
func TestReadIntentPromotionRetainsActualOwnerThroughUsefulResultAndFollow(t *testing.T) {
	s, b, j, retained := conversationOwner(t)
	ctx, i := context.Background(), input("1")
	h := admit(t, s, "1")
	admission := j.writes[0]
	j.hook = func(w port.JournalWrite) {
		if w.Entry.Kind != "promote-conversation" || w.Entry.Binding != h.fixed || w.Entry.Before.Phase != turn.Admitted || w.Entry.After.Phase != turn.Pending {
			t.Fatal("promotion is not one correlated transition", w)
		}
		if h.conversation != nil || h.prompt != "" || h.frames != nil || h.target != (port.ConversationTarget{}) || h.digest != intentDigest {
			t.Fatal("conversation published before receipt")
		}
		expectUnavailable(t, h)
	}
	c, err := s.PromoteConversation(ctx, h, i)
	if err != nil || c.handle != h || s.handles[i.Binding.OperationID] != h || j.count() != 2 || j.writes[0] != admission || len(b.prepares)+len(b.sent)+len(b.verifies) != 0 {
		t.Fatal("promotion replaced identity/admission or performed IO", c, err)
	}
	j.hook = nil
	expectCurrent(t, h, true)
	canonical, err := s.intentDigest(i.Binding, c.target, i.Prompt)
	if err != nil || h.digest != canonical || j.writes[1].Entry.IntentDigest != canonical || canonical == intentDigest || c.input.Prompt != "" || h.prompt != i.Prompt || c.root.latest != c {
		t.Fatal("canonical intent not published", err)
	}
	// Queue's digest is still ONLY the original admission deduplication key.
	if _, err := s.queue.Clone().Admit(identity(i.Binding), intentDigest); err != nil {
		t.Fatal("original queue admission was rewritten", err)
	}
	if _, err := s.queue.Clone().Admit(identity(i.Binding), canonical); !errors.Is(err, turn.Conflict) {
		t.Fatal("conversation digest reinterpreted initial admission", err)
	}
	writes := j.count()
	for n := 0; n < 2; n++ {
		replay, err := s.PromoteConversation(ctx, h, i)
		if err != nil || replay != c || j.count() != writes {
			t.Fatal("duplicate promotion mutated", err)
		}
	}
	prepared, err := s.PrepareNext(ctx, 100)
	if err != nil || prepared.Lease.Identity != browserLease(turn.Reservation{Identity: identity(i.Binding)}).Identity {
		t.Fatal(prepared, err)
	}
	b.events = observations("user-1", "reply-1", "useful fixture answer")
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	early, err := c.Events(ctx, 0)
	if err != nil || len(early) != 4 || !strings.Contains(string(early[3].Data), "useful fixture answer") {
		t.Fatal("no useful incremental output", early, err)
	}
	observeOK(t, c)
	r, err := c.Result(ctx)
	if err != nil || !r.Complete || r.Binding != i.Binding || r.Text != "useful fixture answer" || retained.calls != 1 || h.fixed != i.Binding {
		t.Fatal("result lost read owner", r, err)
	}
	if b.sent[0].IntentDigest != canonical || b.sent[0].Prompt != i.Prompt || b.sent[0].Binding.Lease.Identity != browserLease(turn.Reservation{Identity: identity(i.Binding)}).Identity {
		t.Fatal("Send lost promoted intent")
	}
	if err := c.Acknowledge(ctx, r.ResultID); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	writes = j.count()
	if replay, err := s.PromoteConversation(ctx, h, i); err != nil || replay != c || j.count() != writes {
		t.Fatal("completed promotion did not observe same result", err)
	}
	next, err := s.FollowConversation(ctx, c, followInput())
	if err != nil || next.previous != c || next.target.ConversationID != r.ProviderConversationID || next.target.PreviousReplyID != r.ProviderReplyID || next.root != c {
		t.Fatal("follow lost conversation ownership", next, err)
	}
	raw, err := json.Marshal(j.writes)
	if err != nil || strings.Contains(string(raw), i.Prompt) || strings.Contains(string(raw), r.Text) {
		t.Fatal("private content entered journal", err)
	}
}

func TestReadIntentPromotionRejectsChangedFullIntent(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*port.ConversationInput)
	}{
		{"prompt", func(i *port.ConversationInput) { i.Prompt += " changed" }},
		{"selection", func(i *port.ConversationInput) { i.Selection.ModelID = "other" }},
		{"required", func(i *port.ConversationInput) { i.Required.Effort = false }},
		{"resolution", func(i *port.ConversationInput) {
			i.Resolution = port.ModelResolution{RequestedAlias: "chatgpt", RequestedExecutor: "farol", Resolved: i.Selection, ConfigSHA256: strings.Repeat("b", 64), TranslationID: "configured"}
		}},
		{"binding", func(i *port.ConversationInput) { i.Binding.ParticipantID = "other" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			h := admit(t, s, "1")
			i := input("1")
			c, err := s.PromoteConversation(context.Background(), h, i)
			if err != nil {
				t.Fatal(err)
			}
			writes := j.count()
			change.apply(&i)
			if got, err := s.PromoteConversation(context.Background(), h, i); got != nil || err == nil || j.count() != writes || h.conversation != c || len(b.sent) != 0 {
				t.Fatal("changed intent accepted", got, err)
			}
		})
	}
}

func TestReadIntentPromotionRefusesInvalidInputAndMissingCapabilities(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*Service, *port.ConversationInput)
	}{
		{"empty prompt", func(_ *Service, i *port.ConversationInput) { i.Prompt = "" }},
		{"large prompt", func(_ *Service, i *port.ConversationInput) { i.Prompt = strings.Repeat("x", PromptBytesLimit+1) }},
		{"invalid UTF8", func(_ *Service, i *port.ConversationInput) { i.Prompt = string([]byte{0xff}) }},
		{"selection", func(_ *Service, i *port.ConversationInput) { i.Selection.Provider = "other" }},
		{"required", func(_ *Service, i *port.ConversationInput) { i.Required.Mode = true }},
		{"resolution", func(_ *Service, i *port.ConversationInput) { i.Resolution.TranslationID = "incomplete" }},
		{"digester", func(s *Service, _ *port.ConversationInput) { s.deps.IntentDigests = nil }},
		{"verified browser", func(s *Service, _ *port.ConversationInput) { s.deps.Browser = &browserFixture{} }},
		{"retention budget", func(s *Service, _ *port.ConversationInput) { s.deps.ResultBytesLimit = OutputBytesLimit - 1 }},
	} {
		t.Run(change.name, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			h, i := admit(t, s, "1"), input("1")
			change.apply(s, &i)
			if c, err := s.PromoteConversation(context.Background(), h, i); c != nil || err == nil || j.count() != 1 || h.conversation != nil || len(b.prepares)+len(b.sent) != 0 {
				t.Fatal("invalid promotion mutated", c, err)
			}
		})
	}
}

func TestReadIntentPromotionRefusesForeignStaleAndNonBareHandles(t *testing.T) {
	for _, state := range []string{"foreign", "stale", "cancelled", "queued", "reserved", "sent", "result", "outstanding", "frozen"} {
		t.Run(state, func(t *testing.T) {
			s, _, j, _ := conversationOwner(t)
			h := admit(t, s, "1")
			switch state {
			case "foreign":
				other, _, _, _ := conversationOwner(t)
				h = admit(t, other, "1")
			case "stale":
				copy := *h
				h = &copy
			case "cancelled":
				if _, err := s.Cancel(context.Background(), h, "cancel"); err != nil {
					t.Fatal(err)
				}
			case "queued":
				applyOK(t, s, h, Change{Action: Enqueue})
			case "reserved":
				prepared(t, s, h)
			case "sent":
				running(t, s, h)
			case "result":
				binding := running(t, s, h)
				if _, err := s.Finish(context.Background(), h, binding, turn.Result{ID: "completed-read", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("read result")); err != nil {
					t.Fatal(err)
				}
			case "outstanding":
				h.unresolvedCallID = "call"
			case "frozen":
				if err := s.FreezeAdmissions(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			writes := j.count()
			if c, err := s.PromoteConversation(context.Background(), h, input("1")); c != nil || err == nil || j.count() != writes {
				t.Fatal("non-bare handle promoted", c, err)
			}
		})
	}
}

func TestReadIntentPromotionUnknownReceiptNeverPublishesOrRetries(t *testing.T) {
	for _, fault := range []string{"error", "nil", "revision", "scope", "entry", "cancelled context"} {
		t.Run(fault, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			h := admit(t, s, "1")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if fault == "cancelled context" {
				j.hook = func(port.JournalWrite) { cancel() }
			} else {
				j.fault = fault
			}
			if c, err := s.PromoteConversation(ctx, h, input("1")); c != nil || err == nil {
				t.Fatal(c, err)
			}
			if h.conversation != nil || h.prompt != "" || h.frames != nil || h.digest != intentDigest {
				t.Fatal("unknown published conversation")
			}
			expectUnavailable(t, h)
			writes := j.count()
			j.hook, j.fault = nil, ""
			if c, err := s.PromoteConversation(context.Background(), h, input("1")); c != nil || !errors.Is(err, Unsettled) || j.count() != writes {
				t.Fatal("unknown promotion retried", c, err)
			}
			if err := s.WithdrawReadIntent(context.Background(), h); !errors.Is(err, Unsettled) || j.count() != writes || len(b.prepares)+len(b.sent) != 0 {
				t.Fatal("unknown withdrawn", err)
			}
		})
	}
}

func TestReadIntentCancellationFencesLatePromotion(t *testing.T) {
	s, _, j, _ := conversationOwner(t)
	h := admit(t, s, "1")
	entered, release := make(chan struct{}), make(chan struct{})
	j.hook = func(port.JournalWrite) { close(entered); <-release }
	done := make(chan error, 1)
	go func() { _, err := s.PromoteConversation(context.Background(), h, input("1")); done <- err }()
	<-entered
	if c, err := s.PromoteConversation(context.Background(), h, input("1")); c != nil || !errors.Is(err, Busy) {
		t.Fatal("pending promotion replay", err)
	}
	if err := s.WithdrawReadIntent(context.Background(), h); !errors.Is(err, Busy) {
		t.Fatal("pending withdrawal", err)
	}
	if _, err := s.Cancel(context.Background(), h, "cancel"); !errors.Is(err, Unsettled) {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; !errors.Is(err, Unsettled) || h.conversation != nil || !h.closed || j.count() != 2 {
		t.Fatal("late promotion reopened owner", err)
	}
	expectUnavailable(t, h)
}

func TestReadIntentWithdrawalKnownCancelAckAndDuplicate(t *testing.T) {
	s, b, j, retained := conversationOwner(t)
	h := admit(t, s, "1")
	if err := s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.WithdrawReadIntent(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil || !view.HasResult || view.Phase != turn.Cancelled || view.Result.Code != "NOT_DISPATCHED" || view.Result.Outcome != turn.CancelledOutcome || !view.DeliveryAcknowledged || !view.LifecycleSettled || view.Reserved || h.ackRevision != 3 || j.count() != 3 {
		t.Fatal("withdrawal lacks known Cancel and business ACK", view, err)
	}
	if j.writes[1].Entry.Kind != "cancel" || j.writes[2].Entry.Kind != "acknowledge" || retained.calls != 0 || len(b.prepares)+len(b.sent) != 0 {
		t.Fatal("unexpected withdrawal effect")
	}
	expectCurrent(t, h, false)
	if err := s.WithdrawReadIntent(context.Background(), h); err != nil || j.count() != 3 {
		t.Fatal("known duplicate withdrawal mutated", err)
	}
}

func TestReadIntentWithdrawalRefusesOtherOwnersAndNonBareTurns(t *testing.T) {
	for _, state := range []string{"foreign", "stale", "promoted", "queued", "sent", "completed", "cancelled"} {
		t.Run(state, func(t *testing.T) {
			s, _, j, _ := conversationOwner(t)
			h := admit(t, s, "1")
			switch state {
			case "foreign":
				other, _, _, _ := conversationOwner(t)
				h = admit(t, other, "1")
			case "stale":
				copy := *h
				h = &copy
			case "promoted":
				if _, err := s.PromoteConversation(context.Background(), h, input("1")); err != nil {
					t.Fatal(err)
				}
			case "queued":
				applyOK(t, s, h, Change{Action: Enqueue})
			case "sent":
				running(t, s, h)
			case "completed":
				binding := running(t, s, h)
				if _, err := s.Finish(context.Background(), h, binding, turn.Result{ID: "read", Outcome: turn.Completed, Code: "COMPLETED"}, nil); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				if _, err := s.Cancel(context.Background(), h, h.fixed.OperationID); err != nil {
					t.Fatal(err)
				}
			}
			writes := j.count()
			if err := s.WithdrawReadIntent(context.Background(), h); err == nil || j.count() != writes {
				t.Fatal("withdrawal changed non-bare turn", err)
			}
		})
	}
}

func TestReadIntentWithdrawalUnknownCancelOrAckCannotRetry(t *testing.T) {
	for _, kind := range []string{"cancel", "acknowledge"} {
		for _, fault := range []string{"error", "nil", "entry", "cancelled context"} {
			t.Run(kind+"/"+fault, func(t *testing.T) {
				s, _, j, _ := conversationOwner(t)
				h := admit(t, s, "1")
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				j.hook = func(w port.JournalWrite) {
					if w.Entry.Kind == kind {
						if fault == "cancelled context" {
							cancel()
						} else {
							j.fault = fault
						}
					}
				}
				if err := s.WithdrawReadIntent(ctx, h); err == nil {
					t.Fatal("unknown withdrawal succeeded")
				}
				expectUnavailable(t, h)
				writes := j.count()
				j.hook, j.fault = nil, ""
				if err := s.WithdrawReadIntent(context.Background(), h); !errors.Is(err, Unsettled) || j.count() != writes {
					t.Fatal("unknown withdrawal retried", err)
				}
				if c, err := s.PromoteConversation(context.Background(), h, input("1")); c != nil || !errors.Is(err, Unsettled) || j.count() != writes {
					t.Fatal("unknown withdrawal promoted", err)
				}
			})
		}
	}
}

func TestReadIntentWithdrawalPendingRejectsMutationReplay(t *testing.T) {
	for _, kind := range []string{"cancel", "acknowledge"} {
		t.Run(kind, func(t *testing.T) {
			s, _, j, _ := conversationOwner(t)
			h := admit(t, s, "1")
			entered, release := make(chan struct{}), make(chan struct{})
			j.hook = func(w port.JournalWrite) {
				if w.Entry.Kind == kind {
					close(entered)
					<-release
				}
			}
			done := make(chan error, 1)
			go func() { done <- s.WithdrawReadIntent(context.Background(), h) }()
			<-entered
			expectUnavailable(t, h)
			writes := j.count()
			if err := s.WithdrawReadIntent(context.Background(), h); !errors.Is(err, Busy) || j.count() != writes {
				t.Fatal("pending withdrawal replayed", err)
			}
			if c, err := s.PromoteConversation(context.Background(), h, input("1")); c != nil || !errors.Is(err, Busy) || j.count() != writes {
				t.Fatal("pending withdrawal promoted", err)
			}
			close(release)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if err := s.WithdrawReadIntent(context.Background(), h); err != nil || j.count() != 3 {
				t.Fatal("known terminal replay mutated", err)
			}
		})
	}
}

type readIntentDigestFixture struct {
	value string
	err   error
}

func (f readIntentDigestFixture) Digest([]byte) (string, error) { return f.value, f.err }

func TestReadIntentPromotionRefusesBrokenInjectedDigest(t *testing.T) {
	for _, digester := range []readIntentDigestFixture{{err: errors.New("fixture digest failure")}, {value: ""}, {value: strings.Repeat("A", 64)}, {value: strings.Repeat("a", 63)}} {
		s, _, j, _ := conversationOwner(t)
		h := admit(t, s, "1")
		s.deps.IntentDigests = digester
		if c, err := s.PromoteConversation(context.Background(), h, input("1")); c != nil || !errors.Is(err, Invalid) || j.count() != 1 || h.conversation != nil {
			t.Fatal("broken digest admitted", c, err)
		}
	}
}

func TestReadIntentPromotionAcceptsExactUTF8PromptByteLimit(t *testing.T) {
	s, _, j, _ := conversationOwner(t)
	h, i := admit(t, s, "1"), input("1")
	i.Prompt = strings.Repeat("é", PromptBytesLimit/2)
	if c, err := s.PromoteConversation(context.Background(), h, i); err != nil || c == nil || j.count() != 2 || h.prompt != i.Prompt {
		t.Fatal("exact valid byte limit refused", err)
	}
}

func TestReadIntentPromotionCannotReinterpretOrdinaryCreateAsDuplicate(t *testing.T) {
	s, _, j, _ := conversationOwner(t)
	i := input("1")
	c, err := s.CreateConversation(context.Background(), i)
	if err != nil {
		t.Fatal(err)
	}
	writes := j.count()
	if got, err := s.PromoteConversation(context.Background(), c.handle, i); got != nil || !errors.Is(err, turn.Transition) || j.count() != writes || c.handle.readPromoted {
		t.Fatal("ordinary Create became promotion replay", got, err)
	}
}
