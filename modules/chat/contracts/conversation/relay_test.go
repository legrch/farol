package conversation_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/responses"
	retained "github.com/legrch/farol/modules/chat/infra/results"
)

// Source-only contract journey uses the actual facade, state owner, SSE encoder
// and bounded backend-lifetime retainer. All browser/relay/Computer effects are
// controlled ports. No external Responses endpoint or real relay ACK is claimed.
type relayBrowser struct{ browser }

func (*relayBrowser) Observe(r port.ObserveRequest) (*port.ObserveResponse, error) {
	event := port.BrowserObservation{Binding: r.Binding, Sequence: r.AfterSequence + 1, UserTurnID: "user", ReplyID: "reply"}
	switch r.AfterSequence {
	case 0:
		event.Kind = port.Accepted
		event.ProviderConversationID = "conversation"
	case 1:
		event.Kind = port.AnswerDelta
		event.SegmentID = "before"
		event.Text = "Inspecting fixture; "
	case 2:
		event.Kind = port.AnswerDelta
		event.SegmentID = "after"
		event.Text = "read result explained."
	case 3:
		event.Kind = port.Completed
	case 4:
		event.Kind = port.Quiescent
	default:
		return &port.ObserveResponse{}, nil
	}
	return &port.ObserveResponse{Events: []port.BrowserObservation{event}}, nil
}
func relayFacade(t *testing.T) (*conversation.Facade, *relayBrowser, *journal, *retained.Memory, conversation.Input) {
	t.Helper()
	_, _, input := fixture(t)
	input.Selection.ToolsEnabled = true
	input.Selection.ConnectorID = "fixture-connector"
	input.Selection.ConnectorGrantID = "fixture-grant"
	input.Required.Connector = true
	b, j := &relayBrowser{}, &journal{}
	memory, err := retained.NewMemory(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}, retained.TextLimits())
	if err != nil {
		t.Fatal(err)
	}
	s, err := lifecycle.New(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}, lifecycle.Dependencies{Gate: gate.New(), Journal: j, Browser: b, Results: memory, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	return conversation.New(s), b, j, memory, input
}
func runningRelayHandle(t *testing.T) (*conversation.Handle, *relayBrowser, *journal, *retained.Memory, conversation.ComputerContext) {
	t.Helper()
	f, b, j, m, i := relayFacade(t)
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
	for n := 0; n < 2; n++ {
		if err := h.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
	}
	scope, err := h.ComputerContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return h, b, j, m, *scope
}
func TestRelayContractUsefulDeltaToolReturnContinuesSameTurn(t *testing.T) {
	h, b, j, m, scope := runningRelayHandle(t)
	ctx := context.Background()
	frames, err := h.Events(ctx, 0)
	if err != nil || len(frames) != 4 {
		t.Fatal("missing incremental prefix")
	}
	encoded, err := responses.Encode(frames[3])
	if err != nil || !strings.Contains(string(encoded), "Inspecting fixture") {
		t.Fatal("missing useful SSE delta")
	}
	call, err := h.BeginComputer(ctx, scope, "producer-call")
	if err != nil {
		t.Fatal(err)
	}
	current, err := h.Admission()
	if err != nil {
		t.Fatal(err)
	}
	effects := 0
	if err := current.WithCurrent(ctx, func(binding *admission.TaskBinding) error {
		if binding == nil || binding.TurnID != scope.Binding.TurnID || binding.TaskEpoch != scope.Binding.TaskEpoch || binding.ParticipantID != scope.Binding.ParticipantID {
			t.Fatal("wrong owner")
		}
		effects++
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Real relay binding/operation registry and permission qualification belong to
	// Root. This simulated correlated host ACK is not provider consumption proof.
	ack := &conversation.ComputerReturn{Context: scope, CallID: "producer-call", Returned: true}
	if err := call.AcknowledgeReturn(ctx, ack); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err := h.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
	}
	result, err := h.Result(ctx)
	if err != nil || !result.Complete || result.Text != "Inspecting fixture; read result explained." || result.Binding != scope.Binding || result.ConversationID != scope.Physical.ConversationID || result.UserTurnID != scope.UserTurnID || result.ReplyID != scope.ReplyID {
		t.Fatalf("result=%+v %v", result, err)
	}
	request := port.RetainRequest{Binding: toRetainBinding(scope.Binding), Result: turn.Result{ID: result.ResultID, Outcome: turn.Completed, Code: result.Code}, Payload: []byte("changed bytes")}
	selection := port.Selection(result.Requested)
	observed := fixtureFacts(selection).Projection()
	request.Conversation = port.RetainedConversation{ProviderConversationID: result.ConversationID, ProviderUserTurnID: result.UserTurnID, ProviderReplyID: result.ReplyID, Requested: selection, Observed: observed, Complete: true,
		Evidence: port.SelectionEvidence{Requested: selection, Admitted: selection, Observed: observed, ResolutionSource: "unknown", AdmissionSource: "chat-policy", PinnedSource: "configured-pinned-scope", ObservationSource: "field-facts", EvidenceID: "witness"}}
	if _, err := m.Retain(ctx, request); !errors.Is(err, retained.Conflict) {
		t.Fatalf("actual bytes were not retained: %v", err)
	}
	request.Payload = []byte(result.Text)
	receipt, err := m.Retain(ctx, request)
	if err != nil || receipt == nil || receipt.Bytes != len(result.Text) {
		t.Fatalf("retained receipt=%+v %v", receipt, err)
	}
	frames, err = h.Events(ctx, 0)
	if err != nil || len(frames) != 9 {
		t.Fatalf("frames=%d %v", len(frames), err)
	}
	for _, frame := range frames {
		if _, err := responses.Encode(frame); err != nil {
			t.Fatal(err)
		}
		if _, err := h.AcknowledgeFrame(ctx, frame.Sequence); err != nil {
			t.Fatal(err)
		}
	}
	// Admission is absent at terminal; an old opaque handle is never a new grant.
	if err := current.WithCurrent(ctx, func(binding *admission.TaskBinding) error {
		if binding != nil {
			t.Fatal("terminal admission reused")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
	if effects != 1 || b.sends != 1 || j.revision == 0 {
		t.Fatal("duplicate effects")
	}
}
func TestRelayContractRefusesMappingConflictsForeignHandlesAndDuplicateACK(t *testing.T) {
	h, b, j, _, scope := runningRelayHandle(t)
	ctx := context.Background()
	before := j.revision
	foreign, _, _, _, otherScope := runningRelayHandle(t)
	otherScope.Binding.OperationID = "foreign-operation"
	otherScope.Physical.Binding = otherScope.Binding
	if _, err := h.BeginComputer(ctx, otherScope, "call"); err == nil {
		t.Fatal("foreign logical identity accepted")
	}
	changed := scope
	changed.Physical.Binding.TaskEpoch++
	if _, err := h.BeginComputer(ctx, changed, "call"); err == nil {
		t.Fatal("duplicated physical binding dropped")
	}
	changed = scope
	changed.Physical.DocumentGeneration++
	if _, err := h.BeginComputer(ctx, changed, "call"); err == nil {
		t.Fatal("foreign physical document accepted")
	}
	if j.revision != before {
		t.Fatal("mapping conflict wrote")
	}
	call, err := h.BeginComputer(ctx, scope, "call")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.BeginComputer(ctx, scope, "call"); err == nil {
		t.Fatal("duplicate effect token")
	}
	// An independent same-value fixture handle does not authorize a token; it
	// cannot resolve this call because no method accepts an ID-only call handle.
	if err := (&conversation.ComputerCall{}).AcknowledgeReturn(ctx, &conversation.ComputerReturn{Context: scope, CallID: "call", Returned: true}); err == nil {
		t.Fatal("forged token")
	}
	if _, err := foreign.BeginComputer(ctx, otherScope, "call"); err == nil {
		t.Fatal("foreign body minted call")
	}
	before = j.revision
	if err := call.AcknowledgeReturn(ctx, nil); err == nil {
		t.Fatal("lost ACK resolved")
	}
	ack := &conversation.ComputerReturn{Context: changed, CallID: "call", Returned: true}
	if err := call.AcknowledgeReturn(ctx, ack); err == nil {
		t.Fatal("foreign return accepted")
	}
	if j.revision != before || b.sends != 1 {
		t.Fatal("lost ACK changed owner")
	}
	ack.Context = scope
	if err := call.AcknowledgeReturn(ctx, ack); err != nil {
		t.Fatal(err)
	}
	before = j.revision
	if err := call.AcknowledgeReturn(ctx, ack); err == nil || j.revision != before {
		t.Fatal("duplicate return wrote")
	}
	if _, err := (&conversation.Handle{}).Admission(); err == nil {
		t.Fatal("forged admission")
	}
	if _, err := (&conversation.Handle{}).ComputerContext(ctx); err == nil {
		t.Fatal("forged context")
	}
	if _, err := (&conversation.Handle{}).BeginComputer(ctx, scope, "call"); err == nil {
		t.Fatal("forged begin")
	}
	var failure *conversation.Failure
	if err := call.AcknowledgeReturn(ctx, ack); !errors.As(err, &failure) || failure.Retry != "never" {
		t.Fatal("unclassified refusal")
	}
	// DTO mapping keeps actual identity and no private tool payload fields.
	data, _ := json.Marshal(scope)
	if strings.Contains(string(data), "Inspecting fixture") {
		t.Fatal("private answer in context")
	}
}
func toRetainBinding(b conversation.Binding) port.TurnBinding {
	return port.TurnBinding{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, OperationID: b.OperationID, TurnGeneration: b.TurnGeneration}
}
