package browser

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// Strict CPU Exchange around the actual adapter/owner. It does not implement a
// pipe, browser, provider or durable repository, and never validates live routing.
type clockFixture struct{ now uint64 }

func (c *clockFixture) NowMillis() uint64 { return c.now }

type exchangeFixture struct {
	calls    []Command
	hook     func(context.Context, Command) (Reply, error)
	lostSend bool
}

func (e *exchangeFixture) Exchange(ctx context.Context, c Command) (Reply, error) {
	e.calls = append(e.calls, c)
	if _, ok := ctx.Deadline(); !ok || ctx.Err() != nil {
		panic("deadline context missing")
	}
	if e.hook != nil {
		return e.hook(ctx, c)
	}
	switch r := c.(type) {
	case PrepareCommand:
		cid := "conversation"
		if r.Target.Mode == "owned-saved" {
			cid = r.Target.ConversationID
		}
		return PreparedReply{Saved: true, Readiness: "ready", Binding: Binding{Lease: r.Lease, ViewID: "view", ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration, ConversationID: cid}}, nil
	case VerifySendCommand:
		return VerifiedReply{Verification: Verification{Binding: r.Binding, Observed: r.Requested, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, IntentDigest: r.IntentDigest, EvidenceID: "proof-" + r.Binding.Lease.Identity.OperationID}}, nil
	case SendCommand:
		if e.lostSend {
			return nil, errors.New("private exchange send diagnostic")
		}
		return SentReply{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: "submitted"}, nil
	case ObserveCommand:
		suffix := r.Binding.Lease.Identity.TurnID
		event := Observation{Binding: r.Binding, Sequence: r.AfterSequence + 1, ObservedAtMillis: 11, UserTurnID: "user-" + suffix, ReplyID: "reply-" + suffix}
		switch r.AfterSequence {
		case 0:
			event.Kind = "accepted"
		case 1:
			event.Kind = "answer-delta"
			event.SegmentID = "segment-" + suffix
			event.Text = "fixture output"
		case 2:
			event.Kind = "completed"
		case 3:
			event.Kind = "quiescent"
		default:
			return ObservedReply{}, nil
		}
		return ObservedReply{Events: []Observation{event}}, nil
	case CancelCommand:
		return CancelledReply{Binding: r.Binding, Status: "requested"}, nil
	case DisposeCommand:
		return DisposedReply{Lease: r.Lease, Confirmed: true}, nil
	}
	panic("unexpected command variant")
}
func leaseFixture() port.BrowserLease {
	return port.BrowserLease{Identity: port.RequestIdentity{ProfileID: "profile", OwnerID: "owner", SessionID: "session", TaskID: "task", TurnID: "turn", OperationID: "operation", TurnGeneration: 9007199254740993}, BackendGeneration: "backend", SlotOrdinal: 3, SlotGeneration: 9007199254740995}
}
func bindingFixture() port.BrowserBinding {
	return port.BrowserBinding{Lease: leaseFixture(), ViewID: "view", ViewGeneration: 9007199254740997, DocumentGeneration: 9007199254740999, ConversationID: "conversation"}
}
func selectionFixture() port.Selection {
	return port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "cheap", Effort: "low", Mode: "standard", ToolsEnabled: true, ConnectorID: "connector", ConnectorGrantID: "grant"}
}
func adapterFixture(t *testing.T) (*Adapter, *exchangeFixture, *clockFixture) {
	t.Helper()
	e, c := &exchangeFixture{}, &clockFixture{now: 10}
	a, err := New(context.Background(), Scope{"profile", "backend"}, e, c)
	if err != nil {
		t.Fatal(err)
	}
	return a, e, c
}

const deadline = 1000000
const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func verifyFixture() port.VerifySendRequest {
	return port.VerifySendRequest{Binding: bindingFixture(), Requested: selectionFixture(), PreviousUserTurnID: "previous-user", PreviousReplyID: "previous-reply", IntentDigest: digest, DeadlineMillis: deadline}
}
func sendFixture() port.SendRequest {
	r := verifyFixture()
	return port.SendRequest{Binding: r.Binding, IntentDigest: digest, Prompt: "fixture\ninput", DeadlineMillis: deadline, Verification: port.SendVerification{Binding: r.Binding, Observed: r.Requested, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, IntentDigest: digest, EvidenceID: "proof-operation"}}
}
func TestSixIndependentValueMappingsPreserveExactGenerationAndIntent(t *testing.T) {
	a, e, _ := adapterFixture(t)
	selection := selectionFixture()
	prepare := port.PrepareRequest{Lease: leaseFixture(), Target: port.ConversationTarget{Mode: port.OwnedSaved, ConversationID: "conversation", PreviousUserTurnID: "previous-user", PreviousReplyID: "previous-reply", Selection: selection, Resolution: port.ModelResolution{RequestedAlias: "configured", RequestedExecutor: "farol", RequestedEffort: "", RequestedMode: "standard", Resolved: selection, ConfigSHA256: digest, TranslationID: "default-to-low"}}, DeadlineMillis: deadline}
	reply, err := a.Prepare(prepare)
	if err != nil || reply.Binding.Lease != prepare.Lease || !reply.Saved {
		t.Fatalf("prepare=%+v %v", reply, err)
	}
	command := e.calls[0].(PrepareCommand)
	if command.DeadlineMillis != deadline || command.Lease.Identity.TurnGeneration != 9007199254740993 || command.Lease.SlotGeneration != 9007199254740995 || command.Target.Resolution.RequestedEffort != "" || command.Target.Resolution.ConfigSHA256 != digest || command.Target.Resolution.Resolved.ModelID != "cheap" || command.Target.Selection.ConnectorGrantID != "grant" || command.Target.PreviousReplyID != "previous-reply" {
		t.Fatal("prepare values lost or coerced")
	}
	proof, err := a.VerifySend(verifyFixture())
	if err != nil || proof.Binding != bindingFixture() || proof.Observed != selection {
		t.Fatalf("proof=%+v %v", proof, err)
	}
	sent, err := a.Send(sendFixture())
	if err != nil || sent.Status != port.Submitted || sent.VerificationID != proof.EvidenceID {
		t.Fatalf("send=%+v %v", sent, err)
	}
	s := e.calls[2].(SendCommand)
	if s.Prompt != "fixture\ninput" || s.Verification.PreviousUserTurnID != "previous-user" || s.Binding.DocumentGeneration != 9007199254740999 || s.IntentDigest != digest {
		t.Fatal("send mapping changed exact values")
	}
	observed, err := a.Observe(port.ObserveRequest{Binding: bindingFixture(), DeadlineMillis: deadline})
	if err != nil || len(observed.Events) != 1 || observed.Events[0].Binding != bindingFixture() || observed.Events[0].Sequence != 1 {
		t.Fatalf("observe=%+v %v", observed, err)
	}
	o := e.calls[3].(ObserveCommand)
	if o.Limit != port.MaxObserveEvents || o.AfterSequence != 0 || o.DeadlineMillis != deadline {
		t.Fatal("observe bound/default mapping lost")
	}
	cancelled, err := a.Cancel(port.CancelRequest{Binding: bindingFixture(), DeadlineMillis: deadline})
	if err != nil || cancelled.Status != port.CancelRequested {
		t.Fatal(err)
	}
	disposed, err := a.Dispose(port.DisposeRequest{Lease: leaseFixture(), DeadlineMillis: deadline})
	if err != nil || !disposed.Confirmed || disposed.Lease != leaseFixture() {
		t.Fatal(err)
	}
	if len(e.calls) != 6 {
		t.Fatal("unexpected exchange calls")
	}
}
func TestInvalidInputRefusesBeforeExchange(t *testing.T) {
	cases := map[string]func(*Adapter) error{
		"profile": func(a *Adapter) error {
			r := sendFixture()
			r.Binding.Lease.Identity.ProfileID = "other"
			_, err := a.Send(r)
			return err
		},
		"backend": func(a *Adapter) error {
			r := port.DisposeRequest{Lease: leaseFixture(), DeadlineMillis: deadline}
			r.Lease.BackendGeneration = "other"
			_, err := a.Dispose(r)
			return err
		},
		"ordinal": func(a *Adapter) error {
			r := port.DisposeRequest{Lease: leaseFixture(), DeadlineMillis: deadline}
			r.Lease.SlotOrdinal = 6
			_, err := a.Dispose(r)
			return err
		},
		"generation": func(a *Adapter) error {
			r := port.CancelRequest{Binding: bindingFixture(), DeadlineMillis: deadline}
			r.Binding.DocumentGeneration = 0
			_, err := a.Cancel(r)
			return err
		},
		"target": func(a *Adapter) error {
			_, err := a.Prepare(port.PrepareRequest{Lease: leaseFixture(), DeadlineMillis: deadline})
			return err
		},
		"digest": func(a *Adapter) error {
			r := verifyFixture()
			r.IntentDigest = "raw"
			_, err := a.VerifySend(r)
			return err
		},
		"proof": func(a *Adapter) error {
			r := sendFixture()
			r.Verification.Binding.ViewGeneration++
			_, err := a.Send(r)
			return err
		},
		"prompt-size": func(a *Adapter) error {
			r := sendFixture()
			r.Prompt = strings.Repeat("x", MaxPromptBytes+1)
			_, err := a.Send(r)
			return err
		},
		"prompt-utf8": func(a *Adapter) error {
			r := sendFixture()
			r.Prompt = string([]byte{255})
			_, err := a.Send(r)
			return err
		},
		"ids": func(a *Adapter) error {
			r := verifyFixture()
			r.PreviousReplyID = ""
			_, err := a.VerifySend(r)
			return err
		},
		"limit": func(a *Adapter) error {
			_, err := a.Observe(port.ObserveRequest{Binding: bindingFixture(), Limit: 129, DeadlineMillis: deadline})
			return err
		},
		"sequence": func(a *Adapter) error {
			_, err := a.Observe(port.ObserveRequest{Binding: bindingFixture(), AfterSequence: math.MaxUint64, DeadlineMillis: deadline})
			return err
		},
		"expired":       func(a *Adapter) error { r := sendFixture(); r.DeadlineMillis = 10; _, err := a.Send(r); return err },
		"zero-deadline": func(a *Adapter) error { r := sendFixture(); r.DeadlineMillis = 0; _, err := a.Send(r); return err },
		"overflow-deadline": func(a *Adapter) error {
			r := sendFixture()
			r.DeadlineMillis = math.MaxUint64
			_, err := a.Send(r)
			return err
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			a, e, _ := adapterFixture(t)
			if err := run(a); err == nil || len(e.calls) != 0 {
				t.Fatalf("invalid request exchanged: %v calls=%d", err, len(e.calls))
			}
		})
	}
}
func TestLateLostAndMalformedSendRepliesAreUnknownWithoutRetry(t *testing.T) {
	for _, fault := range []string{"error", "nil", "type", "pointer", "binding", "proof", "status", "code", "late", "cancel"} {
		t.Run(fault, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			e, c := &exchangeFixture{}, &clockFixture{now: 10}
			a, err := New(ctx, Scope{"profile", "backend"}, e, c)
			if err != nil {
				t.Fatal(err)
			}
			e.hook = func(_ context.Context, cmd Command) (Reply, error) {
				r := cmd.(SendCommand)
				reply := SentReply{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: "submitted"}
				switch fault {
				case "error":
					return nil, errors.New("private raw transport diagnostic")
				case "nil":
					return nil, nil
				case "type":
					return DisposedReply{}, nil
				case "pointer":
					return &reply, nil
				case "binding":
					reply.Binding.ViewGeneration++
				case "proof":
					reply.VerificationID = "other"
				case "status":
					reply.Status = "guessed"
				case "code":
					reply.Code = "private raw diagnostic"
				case "late":
					c.now = deadline
				case "cancel":
					cancel()
				}
				return reply, nil
			}
			result, err := a.Send(sendFixture())
			if result != nil || err != Unsettled || len(e.calls) != 1 || strings.Contains(err.Error(), "private") {
				t.Fatalf("result=%+v err=%v calls=%d", result, err, len(e.calls))
			}
		})
	}
}
func TestVerificationAndPreparationRejectCrossedEvidence(t *testing.T) {
	for _, fault := range []string{"account", "effort", "mode", "connector", "grant", "digest", "user", "reply", "document", "evidence"} {
		t.Run(fault, func(t *testing.T) {
			a, e, _ := adapterFixture(t)
			e.hook = func(_ context.Context, cmd Command) (Reply, error) {
				r := cmd.(VerifySendCommand)
				v := Verification{Binding: r.Binding, Observed: r.Requested, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, IntentDigest: r.IntentDigest, EvidenceID: "proof"}
				switch fault {
				case "account":
					v.Observed.AccountID = "other"
				case "effort":
					v.Observed.Effort = "high"
				case "mode":
					v.Observed.Mode = "pro"
				case "connector":
					v.Observed.ConnectorID = "other"
				case "grant":
					v.Observed.ConnectorGrantID = "other"
				case "digest":
					v.IntentDigest = strings.Repeat("b", 64)
				case "user":
					v.PreviousUserTurnID = "other"
				case "reply":
					v.PreviousReplyID = "other"
				case "document":
					v.Binding.DocumentGeneration++
				case "evidence":
					v.EvidenceID = ""
				}
				return VerifiedReply{Verification: v}, nil
			}
			if result, err := a.VerifySend(verifyFixture()); result != nil || err != Unsettled || len(e.calls) != 1 {
				t.Fatal("crossed verification accepted")
			}
		})
	}
	for _, fault := range []string{"saved", "cid", "lease", "readiness", "code"} {
		t.Run(fault, func(t *testing.T) {
			a, e, _ := adapterFixture(t)
			e.hook = func(_ context.Context, cmd Command) (Reply, error) {
				r := cmd.(PrepareCommand)
				b := bindingFromPort(bindingFixture())
				b.Lease = r.Lease
				reply := PreparedReply{Saved: true, Readiness: "ready", Binding: b}
				switch fault {
				case "saved":
					reply.Saved = false
				case "cid":
					reply.Binding.ConversationID = "other"
				case "lease":
					reply.Binding.Lease.SlotGeneration++
				case "readiness":
					reply.Readiness = "guessed"
				case "code":
					reply.Code = "unclassified error"
				}
				return reply, nil
			}
			r := port.PrepareRequest{Lease: leaseFixture(), Target: port.ConversationTarget{Mode: port.OwnedSaved, ConversationID: "conversation", PreviousUserTurnID: "u", PreviousReplyID: "r", Selection: selectionFixture()}, DeadlineMillis: deadline}
			if result, err := a.Prepare(r); result != nil || err != Unsettled {
				t.Fatal("crossed preparation accepted")
			}
		})
	}
}
func TestObserveRejectsBoundsAndCopiesReturnedEvents(t *testing.T) {
	for _, fault := range []string{"binding", "sequence", "kind", "utf8", "text-size", "page-size", "count", "ids", "gap"} {
		t.Run(fault, func(t *testing.T) {
			a, e, _ := adapterFixture(t)
			e.hook = func(_ context.Context, cmd Command) (Reply, error) {
				r := cmd.(ObserveCommand)
				event := Observation{Binding: r.Binding, Sequence: 1, Kind: "answer-delta", Text: "x", UserTurnID: "u", ReplyID: "r", SegmentID: "s"}
				reply := ObservedReply{Events: []Observation{event}}
				switch fault {
				case "binding":
					reply.Events[0].Binding.Lease.SlotGeneration++
				case "sequence":
					reply.Events[0].Sequence = 2
				case "kind":
					reply.Events[0].Kind = "eval"
				case "utf8":
					reply.Events[0].Text = string([]byte{255})
				case "text-size":
					reply.Events[0].Text = strings.Repeat("x", port.MaxObserveTextBytes+1)
				case "page-size":
					event.Text = strings.Repeat("x", port.MaxObserveTextBytes)
					reply.Events = make([]Observation, 5)
					for n := range reply.Events {
						reply.Events[n] = event
						reply.Events[n].Sequence = uint64(n + 1)
					}
				case "count":
					reply.Events = make([]Observation, 129)
				case "ids":
					reply.Events[0].ReplyID = strings.Repeat("x", 121)
				case "gap":
					reply.Gap = true
				}
				return reply, nil
			}
			if result, err := a.Observe(port.ObserveRequest{Binding: bindingFixture(), DeadlineMillis: deadline}); result != nil || err != Unsettled || len(e.calls) != 1 {
				t.Fatal("malformed observe accepted")
			}
		})
	}
	a, e, _ := adapterFixture(t)
	events := []Observation{{Binding: bindingFromPort(bindingFixture()), Sequence: 1, Kind: "answer-delta", Text: "original", UserTurnID: "u", ReplyID: "r", SegmentID: "s"}}
	e.hook = func(context.Context, Command) (Reply, error) { return ObservedReply{Events: events}, nil }
	reply, err := a.Observe(port.ObserveRequest{Binding: bindingFixture(), DeadlineMillis: deadline})
	if err != nil {
		t.Fatal(err)
	}
	events[0].Text = "changed"
	events[0].Binding.ViewGeneration++
	if reply.Events[0].Text != "original" || reply.Events[0].Binding != bindingFixture() {
		t.Fatal("reply retained mutable exchange slice")
	}
}

type journalFixture struct{ revision uint64 }

func (*journalFixture) OpenFresh(_ context.Context, s port.JournalScope) (*port.JournalHead, error) {
	return &port.JournalHead{Scope: s}, nil
}
func (j *journalFixture) Commit(_ context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	if w.PreviousRevision != j.revision {
		return nil, errors.New("fixture revision")
	}
	j.revision = w.Revision
	return &port.JournalReceipt{Write: w}, nil
}

type resultFixture struct {
	mu    sync.Mutex
	calls int
}

func (r *resultFixture) Retain(_ context.Context, w port.RetainRequest) (*port.RetainReceipt, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	return &port.RetainReceipt{Binding: w.Binding, Result: w.Result, Bytes: len(w.Payload)}, nil
}
func serviceFixture(t *testing.T) (*lifecycle.Service, *exchangeFixture, *resultFixture, port.ConversationInput) {
	t.Helper()
	a, e, _ := adapterFixture(t)
	retained := &resultFixture{}
	s, err := lifecycle.New(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}, lifecycle.Dependencies{Gate: gate.New(), Journal: &journalFixture{}, Browser: a, Results: retained, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	i := port.ConversationInput{Binding: port.TurnBinding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 17, ParticipantID: "participant", TurnID: "turn-1", OperationID: "operation-1", TurnGeneration: 1}, Selection: selectionFixture(), Prompt: "fixture input"}
	return s, e, retained, i
}
func TestActualLifecycleUsesAdapterForSameConversationAndNoLostSendRetry(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(map[bool]string{false: "followup", true: "lost-send"}[lost], func(t *testing.T) {
			s, e, r, i := serviceFixture(t)
			ctx := context.Background()
			c, err := s.CreateConversation(ctx, i)
			if err != nil {
				t.Fatal(err)
			}
			binding, err := s.PrepareNext(ctx, deadline)
			if err != nil {
				t.Fatal(err)
			}
			e.lostSend = lost
			if err := c.Send(ctx, deadline); err != nil {
				t.Fatal(err)
			}
			if lost {
				result, err := c.Result(ctx)
				if err != nil || result.Outcome != "unknown" {
					t.Fatal("lost reply became known")
				}
				if err := c.Send(ctx, deadline); err == nil {
					t.Fatal("lost Send retried")
				}
				if len(e.calls) != 3 {
					t.Fatal("unexpected exchange after lost Send")
				}
				return
			}
			for n := 0; n < 3; n++ {
				if err := c.Observe(ctx, deadline); err != nil {
					t.Fatal(err)
				}
			}
			result, err := c.Result(ctx)
			if err != nil || !result.Complete {
				t.Fatal(err)
			}
			if err := c.Acknowledge(ctx, result.ResultID); err != nil {
				t.Fatal(err)
			}
			if err := c.Observe(ctx, deadline); err != nil {
				t.Fatal(err)
			}
			nextInput := i
			nextInput.Binding.TurnID = "turn-2"
			nextInput.Binding.OperationID = "operation-2"
			nextInput.Binding.TurnGeneration++
			next, err := s.FollowConversation(ctx, c, nextInput)
			if err != nil {
				t.Fatal(err)
			}
			nextBinding, err := s.PrepareNext(ctx, deadline)
			if err != nil || nextBinding.ConversationID != binding.ConversationID || nextBinding.Lease.SlotGeneration != binding.Lease.SlotGeneration+1 {
				t.Fatalf("next=%+v %v", nextBinding, err)
			}
			if err := next.Send(ctx, deadline); err != nil {
				t.Fatal(err)
			}
			for n := 0; n < 3; n++ {
				if err := next.Observe(ctx, deadline); err != nil {
					t.Fatal(err)
				}
			}
			sends := 0
			for _, command := range e.calls {
				if send, ok := command.(SendCommand); ok {
					sends++
					if sends == 2 && (send.Verification.PreviousUserTurnID != "user-turn-1" || send.Verification.PreviousReplyID != "reply-turn-1") {
						t.Fatal("previous logical IDs lost")
					}
				}
			}
			if sends != 2 || r.calls != 2 {
				t.Fatal("actual owner journey not exercised")
			}
		})
	}
}

func TestConstructorRefusesMissingOrEndedComposition(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var typedExchange *exchangeFixture
	var typedClock *clockFixture
	cases := []struct {
		ctx      context.Context
		scope    Scope
		exchange Exchange
		clock    Clock
	}{
		{nil, Scope{"profile", "backend"}, &exchangeFixture{}, &clockFixture{}},
		{ctx, Scope{"profile", "backend"}, &exchangeFixture{}, &clockFixture{}},
		{context.Background(), Scope{"", "backend"}, &exchangeFixture{}, &clockFixture{}},
		{context.Background(), Scope{"profile", "backend"}, typedExchange, &clockFixture{}},
		{context.Background(), Scope{"profile", "backend"}, &exchangeFixture{}, typedClock},
	}
	for _, c := range cases {
		if a, err := New(c.ctx, c.scope, c.exchange, c.clock); a != nil || err != Invalid {
			t.Fatal("invalid composition accepted")
		}
	}
}
func TestCancelDisposePreserveUnknownAndNeverFabricateCleanup(t *testing.T) {
	for _, kind := range []string{"cancel", "dispose"} {
		for _, fault := range []string{"binding", "code", "unknown"} {
			t.Run(kind+"/"+fault, func(t *testing.T) {
				a, e, _ := adapterFixture(t)
				e.hook = func(_ context.Context, cmd Command) (Reply, error) {
					if r, ok := cmd.(CancelCommand); ok {
						reply := CancelledReply{Binding: r.Binding, Status: "unknown"}
						if fault == "binding" {
							reply.Binding.DocumentGeneration++
						}
						if fault == "code" {
							reply.Code = "raw error"
						}
						return reply, nil
					}
					r := cmd.(DisposeCommand)
					reply := DisposedReply{Lease: r.Lease, Confirmed: false}
					if fault == "binding" {
						reply.Lease.SlotGeneration++
					}
					if fault == "code" {
						reply.Code = "raw error"
					}
					return reply, nil
				}
				if kind == "cancel" {
					reply, err := a.Cancel(port.CancelRequest{Binding: bindingFixture(), DeadlineMillis: deadline})
					if fault == "unknown" {
						if err != nil || reply.Status != port.CancelUnknown {
							t.Fatal("cancel unknown fabricated terminal")
						}
					} else if reply != nil || err != Unsettled {
						t.Fatal("crossed cancel accepted")
					}
				} else {
					reply, err := a.Dispose(port.DisposeRequest{Lease: leaseFixture(), DeadlineMillis: deadline})
					if fault == "unknown" {
						if err != nil || reply.Confirmed {
							t.Fatal("unconfirmed dispose became cleanup")
						}
					} else if reply != nil || err != Unsettled {
						t.Fatal("crossed dispose accepted")
					}
				}
				if len(e.calls) != 1 {
					t.Fatal("cancel/dispose retried")
				}
			})
		}
	}
}
