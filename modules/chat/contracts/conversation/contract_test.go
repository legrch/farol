package conversation_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/responses"
)

// Source-only facade/adapter fixture. There is no endpoint/browser/provider/native
// storage, and emitting valid text frames is not full Codex client qualification.
type journal struct{ revision uint64 }

func (*journal) OpenFresh(_ context.Context, s port.JournalScope) (*port.JournalHead, error) {
	return &port.JournalHead{Scope: s}, nil
}
func (j *journal) Commit(_ context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	if w.PreviousRevision != j.revision {
		return nil, errors.New("fixture revision")
	}
	j.revision = w.Revision
	return &port.JournalReceipt{Write: w}, nil
}

type results struct{ text string }

func (r *results) Retain(_ context.Context, w port.RetainRequest) (*port.RetainReceipt, error) {
	r.text = string(w.Payload)
	return &port.RetainReceipt{Binding: w.Binding, Result: w.Result, Bytes: len(w.Payload), Conversation: w.Conversation}, nil
}

type browser struct {
	sends, verifies  int
	ownerRequired    bool
	entered, release chan struct{}
}

func (b *browser) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	readiness := port.Ready
	if b.ownerRequired {
		readiness = port.OwnerRequired
	}
	return &port.PrepareResponse{Saved: false, Readiness: readiness, Binding: port.BrowserBinding{ProviderState: port.ProviderHome, Lease: r.Lease, ViewID: "view", ViewGeneration: 1, DocumentGeneration: 1, ConversationID: ""}}, nil
}
func (b *browser) VerifySend(r port.VerifySendRequest) (*port.SendVerification, error) {
	b.verifies++
	return &port.SendVerification{Binding: r.Binding, Pinned: r.Requested, Required: r.Required, Observed: fixtureFacts(r.Requested), IntentDigest: r.IntentDigest, EvidenceID: "witness"}, nil
}
func (b *browser) Send(r port.SendRequest) (*port.SendResponse, error) {
	b.sends++
	return &port.SendResponse{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: port.Submitted}, nil
}
func (b *browser) Observe(r port.ObserveRequest) (*port.ObserveResponse, error) {
	if r.AfterSequence == 2 && b.entered != nil {
		close(b.entered)
		<-b.release
	}
	event := port.BrowserObservation{Binding: r.Binding, Sequence: r.AfterSequence + 1, UserTurnID: "user", ReplyID: "reply"}
	switch r.AfterSequence {
	case 0:
		event.Kind = port.Accepted
		event.ProviderConversationID = "conversation"
	case 1:
		event.Kind = port.AnswerDelta
		event.SegmentID = "block"
		event.Text = "<answer>\nline two"
	case 2:
		event.Kind = port.Completed
	case 3:
		event.Kind = port.Quiescent
	default:
		return &port.ObserveResponse{}, nil
	}
	return &port.ObserveResponse{Events: []port.BrowserObservation{event}}, nil
}
func (*browser) Cancel(port.CancelRequest) (*port.CancelResponse, error)    { panic("unused") }
func (*browser) Dispose(port.DisposeRequest) (*port.DisposeResponse, error) { panic("unused") }
func fixture(t *testing.T) (*conversation.Facade, *browser, conversation.Input) {
	t.Helper()
	b := &browser{}
	s, err := lifecycle.New(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}, lifecycle.Dependencies{Gate: gate.New(), Journal: &journal{}, Browser: b, Results: &results{}, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	i := conversation.Input{Required: conversation.RequiredControls{Model: true, Effort: true}, Binding: conversation.Binding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 31, ParticipantID: "participant", TurnID: "turn", OperationID: "operation", TurnGeneration: 2}, Selection: conversation.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "cheap", Effort: "low"}, Prompt: "fixture input"}
	return conversation.New(s), b, i
}
func TestFacadeServesIncrementalFramesAndExactOwnerBinding(t *testing.T) {
	f, b, i := fixture(t)
	ctx := context.Background()
	h, err := f.Create(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := f.PrepareNext(ctx, 100)
	if err != nil || prepared.Binding != i.Binding {
		t.Fatalf("caller authority lost %+v %v", prepared, err)
	}
	if err := h.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	early, err := h.Events(ctx, 0)
	if err != nil || len(early) != 4 || early[3].Type != "response.output_text.delta" {
		t.Fatalf("early=%+v %v", early, err)
	}
	encoded, err := responses.Encode(early[3])
	if err != nil || !strings.HasPrefix(string(encoded), "event: response.output_text.delta\ndata: ") || strings.Count(string(encoded), "\n") != 3 {
		t.Fatalf("SSE=%q %v", encoded, err)
	}
	var delta struct {
		Delta string `json:"delta"`
	}
	if json.Unmarshal(early[3].JSON, &delta) != nil || delta.Delta != "<answer>\nline two" {
		t.Fatal("escaped text corrupted")
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	r, err := h.Result(ctx)
	if err != nil || !r.Complete || r.Phase != "result-ready" || r.Requested != i.Selection || r.Observed.Model.Value != i.Selection.ModelID || r.Observed.Model.Source != "public-control" || r.Binding != i.Binding || r.Acknowledged {
		t.Fatalf("result=%+v %v", r, err)
	}
	frames, err := h.Events(ctx, 0)
	if err != nil || len(frames) != 8 || frames[7].Type != "response.completed" {
		t.Fatalf("frames=%+v %v", frames, err)
	}
	for _, frame := range frames {
		if _, err := responses.Encode(frame); err != nil {
			t.Fatal(err)
		}
		if _, err := h.AcknowledgeFrame(ctx, frame.Sequence); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.Result(ctx); err != nil || b.sends != 1 || b.verifies != 1 {
		t.Fatal("reads resent")
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Acknowledge(ctx, r.ResultID); err != nil {
		t.Fatal(err)
	}
	if err := h.WithState(ctx, func(s conversation.State) error {
		if s.Phase != "delivered" || s.Binding != i.Binding {
			t.Fatalf("state=%+v", s)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
func TestFacadeRefusesForgedAndCrossOwnerHandles(t *testing.T) {
	f, _, i := fixture(t)
	h, err := f.Create(context.Background(), i)
	if err != nil {
		t.Fatal(err)
	}
	other, _, _ := fixture(t)
	if _, err := other.Follow(context.Background(), h, i); err == nil {
		t.Fatal("cross owner handle accepted")
	}
	err = (&conversation.Handle{}).Send(context.Background(), 100)
	var failure *conversation.Failure
	if !errors.As(err, &failure) || failure.Retry != "never" || failure.Source != "chat-conversation" {
		t.Fatalf("failure=%+v", failure)
	}
	for _, f := range []conversation.Frame{{Sequence: 1, Type: "response.output_text.delta\nevent: forged", JSON: []byte("{}")}, {Sequence: 1, Type: "response.completed", JSON: []byte(`{"type":"response.completed","sequence_number":2}`)}} {
		if _, err := responses.Encode(f); err == nil {
			t.Fatal("crossed SSE metadata accepted")
		}
	}
}
func TestOwnerResumeDoesNotImplicitlySend(t *testing.T) {
	f, b, i := fixture(t)
	b.ownerRequired = true
	ctx := context.Background()
	h, err := f.Create(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Send(ctx, 100); err == nil || b.sends != 0 || b.verifies != 0 {
		t.Fatal("await-owner sent")
	}
	if err := h.Resume(ctx); err != nil || b.sends != 0 {
		t.Fatalf("resume=%v sends=%d", err, b.sends)
	}
	if err := h.Send(ctx, 100); err != nil || b.sends != 1 || b.verifies != 1 {
		t.Fatalf("explicit Send=%v", err)
	}
}

func TestUsefulModelConsumerDeltaBeforeBarrierReleasesTerminal(t *testing.T) {
	f, b, i := fixture(t)
	ctx := context.Background()
	h, err := f.Create(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	b.entered, b.release = make(chan struct{}), make(chan struct{})
	var release sync.Once
	defer release.Do(func() { close(b.release) })
	done := make(chan error, 1)
	go func() { done <- h.Observe(ctx, 100) }()
	<-b.entered
	// The production facade/encoder sees previously committed useful output
	// while the external provider has NOT generated its terminal event. No future
	// result is injected after the service and no timer dribbles a final string.
	frames, err := h.Events(ctx, 0)
	if err != nil || len(frames) != 4 {
		t.Fatalf("consumer frames=%+v %v", frames, err)
	}
	wire, err := responses.Encode(frames[3])
	if err != nil || frames[3].Type != "response.output_text.delta" || !strings.Contains(string(wire), "line two") {
		t.Fatalf("useful delta=%q %v", wire, err)
	}
	for _, frame := range frames {
		if frame.Type == "response.completed" {
			t.Fatal("terminal escaped barrier")
		}
	}
	if _, err := h.Result(ctx); err == nil {
		t.Fatal("future durable result invented")
	}
	release.Do(func() { close(b.release) })
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	result, err := h.Result(ctx)
	if err != nil || !result.Complete || result.Acknowledged || b.sends != 1 {
		t.Fatalf("released result=%+v %v", result, err)
	}
}

func fixtureFacts(s port.Selection) port.SelectionFacts {
	known := func(v string) port.ControlFact {
		if v == "" {
			return port.ControlFact{}
		}
		return port.ControlFact{Value: v, Literal: "visible-" + v, Source: port.FactPublicControl}
	}
	return port.SelectionFacts{Model: known(s.ModelID), Effort: known(s.Effort), Mode: known(s.Mode), Connector: known(s.ConnectorID), ObservedAtMillis: 9}
}

// These authorization tests use the real facade/owner with in-memory ports.
type contractSendAuthorizationFunc func(context.Context, *conversation.SendCurrent) error

func (f contractSendAuthorizationFunc) Authorize(ctx context.Context, current *conversation.SendCurrent) error {
	return f(ctx, current)
}

func assertConversationFailure(t *testing.T, err error, code string) {
	t.Helper()
	var failure *conversation.Failure
	if !errors.As(err, &failure) || failure.Code != code || failure.Source != "chat-conversation" || failure.Retry != "never" {
		t.Fatalf("failure=%+v err=%v", failure, err)
	}
}

func TestFacadeCreateAuthorizedNilAndReplayConflicts(t *testing.T) {
	for _, guarded := range []bool{false, true} {
		t.Run(map[bool]string{false: "unguarded-first", true: "guarded-first"}[guarded], func(t *testing.T) {
			f, b, j, _, i := followStateFacade(t)
			ctx := context.Background()
			revision := j.revision
			if h, err := f.CreateAuthorized(ctx, i, nil); h != nil || err == nil || j.revision != revision {
				t.Fatal("nil authorization admitted", h, err)
			} else {
				assertConversationFailure(t, err, "CHAT_LIFECYCLE_INVALID")
			}
			original, replacement := 0, 0
			a := contractSendAuthorizationFunc(func(ctx context.Context, current *conversation.SendCurrent) error {
				original++
				return current.WithCurrent(ctx, func(binding *conversation.Binding) error {
					if binding == nil || *binding != i.Binding {
						t.Fatal("binding mapping changed", binding)
					}
					return nil
				})
			})
			create := func(guard bool, authorization conversation.SendAuthorization) (*conversation.Handle, error) {
				if guard {
					return f.CreateAuthorized(ctx, i, authorization)
				}
				return f.Create(ctx, i)
			}
			h, err := create(guarded, a)
			if err != nil {
				t.Fatal(err)
			}
			revision = j.revision
			if conflict, err := create(!guarded, a); conflict != nil || err == nil || j.revision != revision {
				t.Fatal("guard conflict admitted", err)
			} else {
				assertConversationFailure(t, err, "CHAT_CONFLICT")
			}
			replayed, err := create(guarded, contractSendAuthorizationFunc(func(context.Context, *conversation.SendCurrent) error {
				replacement++
				return errors.New("replacement guard")
			}))
			if err != nil || replayed == nil || j.revision != revision || b.sends != 0 || original != 0 || replacement != 0 {
				t.Fatal("exact replay changed admission", err)
			}
			if _, err := f.PrepareNext(ctx, 100); err != nil {
				t.Fatal(err)
			}
			if err := replayed.Send(ctx, 100); err != nil || b.sends != 1 || replacement != 0 || original != map[bool]int{false: 0, true: 1}[guarded] {
				t.Fatal("replay replaced captured guard", err)
			}
			if err := h.WithState(ctx, func(state conversation.State) error {
				if state.Binding != i.Binding || state.Requested != i.Selection {
					t.Fatal("replay changed original handle")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestFacadeCreateAuthorizedFinalHandleSendCannotBypass(t *testing.T) {
	for _, kind := range []string{"allow", "skip", "snapshot-only", "refuse", "late-refusal"} {
		t.Run(kind, func(t *testing.T) {
			f, b, i := fixture(t)
			ctx := context.Background()
			calls := 0
			var retained *conversation.SendCurrent
			sentinel := errors.New("consumer refusal")
			h, err := f.CreateAuthorized(ctx, i, contractSendAuthorizationFunc(func(ctx context.Context, current *conversation.SendCurrent) error {
				calls++
				retained = current
				if b.verifies != 1 || b.sends != 0 {
					t.Fatal("guard outside final Send boundary")
				}
				if kind == "skip" {
					return nil
				}
				if kind == "snapshot-only" {
					_, err := current.AccountSnapshot(ctx)
					return err
				}
				inspect := func(binding *conversation.Binding) error {
					if binding == nil || *binding != i.Binding {
						t.Fatal("binding mapping changed", binding)
					}
					if kind == "refuse" {
						return sentinel
					}
					return nil
				}
				if err := current.WithCurrent(ctx, inspect); err != nil {
					if err != sentinel {
						t.Fatal("consumer failure mapping changed", err)
					}
					return err
				}
				if kind == "late-refusal" {
					_ = current.WithCurrent(ctx, func(*conversation.Binding) error { return sentinel })
				}
				return nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.PrepareNext(ctx, 100); err != nil {
				t.Fatal(err)
			}
			if err := h.Send(ctx, 100); err != nil || calls != 1 {
				t.Fatal("guarded Send failed", err)
			}
			called := false
			err = retained.WithCurrent(ctx, func(*conversation.Binding) error { called = true; return nil })
			assertConversationFailure(t, err, "CHAT_LIFECYCLE_UNAVAILABLE")
			if called {
				t.Fatal("expired final Send capability invoked callback")
			}
			if kind == "allow" {
				if b.sends != 1 {
					t.Fatal("authorized Send missing")
				}
				return
			}
			result, err := h.Result(ctx)
			if err != nil || result.Code != "SEND_NOT_SENT" || result.Outcome != "failed" || result.Binding != i.Binding || b.sends != 0 {
				t.Fatal("refusal lost classification", result, err)
			}
			if err := h.Send(ctx, 100); err == nil || calls != 1 || b.sends != 0 {
				t.Fatal("refused Send retried", err)
			}
		})
	}
}
