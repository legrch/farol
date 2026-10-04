package conversation_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/responses"
)

func callerContractRequest(scope conversation.ComputerContext) conversation.BeginCallerToolRequest {
	s := conversation.CallerScope{SessionID: "session", ThreadID: "thread", TurnID: "turn", RootTurnID: "root", Model: "chatgpt"}
	raw, _ := json.Marshal(map[string]string{"sessionId": s.SessionID, "threadId": s.ThreadID, "turnId": s.TurnID, "rootTurnId": s.RootTurnID})
	hash, _ := (intent.SHA256{}).Digest(raw)
	return conversation.BeginCallerToolRequest{Context: scope, Scope: s, ProducerOperationID: "relay-original", Call: conversation.CallerFunctionCall{ItemID: "fc-caller", CallID: "farol_next_call_" + hash[:16] + "0123456789abcdef", Name: "exec_command", Arguments: `{"cmd":"fixture"}`}}
}
func TestCallerContractExactOutputReceiptAndSameConversation(t *testing.T) {
	h, b, _, _, scope := runningRelayHandle(t)
	ctx := context.Background()
	r := callerContractRequest(scope)
	call, err := h.BeginCallerTool(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	frames, err := h.Events(ctx, 0)
	if err != nil || len(frames) != 12 {
		t.Fatal("prefix/call frames")
	}
	for _, f := range frames {
		if _, err := responses.Encode(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := call.ClaimDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	input := conversation.AcceptCallerOutputRequest{Context: scope, Scope: r.Scope, Calls: []conversation.CallerFunctionCall{r.Call}, Outputs: []conversation.CallerFunctionOutput{{CallID: r.Call.CallID, Raw: []byte(`[{"type":"text","text":"host exact"}]`)}}}
	out, err := call.AcceptOutput(ctx, input)
	if err != nil || out.Output != "host exact" || out.Bytes != 10 {
		t.Fatalf("output %+v %v", out, err)
	}
	ack := &conversation.CallerReturn{Context: scope, ProducerOperationID: r.ProducerOperationID, CallID: r.Call.CallID, OutputSHA256: out.SHA256, OutputBytes: out.Bytes, Returned: true}
	if err := call.AcknowledgeReturn(ctx, ack); err != nil {
		t.Fatal(err)
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	result, err := h.Result(ctx)
	if err != nil || !result.Complete || result.ConversationID != scope.Physical.ConversationID || result.Binding != scope.Binding || b.sends != 1 {
		t.Fatalf("result %+v %v", result, err)
	}
	frames, err = h.Events(ctx, 12)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range frames {
		wire, err := responses.Encode(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(wire), "Inspecting fixture") {
			t.Fatal("prefix redelivered in next round")
		}
	}
}
func TestCallerContractRejectsForgedAndConflictingMapping(t *testing.T) {
	h, _, j, _, scope := runningRelayHandle(t)
	ctx := context.Background()
	r := callerContractRequest(scope)
	before := j.revision
	r.Context.Physical.Binding.TaskEpoch++
	if call, err := h.BeginCallerTool(ctx, r); err == nil || call != nil || j.revision != before {
		t.Fatal("physical mismatch dropped")
	}
	r.Context = scope
	if _, err := (&conversation.Handle{}).BeginCallerTool(ctx, r); err == nil {
		t.Fatal("forged owner")
	}
	call, err := h.BeginCallerTool(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&conversation.CallerToolCall{}).ClaimDispatch(ctx); err == nil {
		t.Fatal("forged claim")
	}
	if _, err := (&conversation.CallerToolCall{}).AcceptOutput(ctx, conversation.AcceptCallerOutputRequest{}); err == nil {
		t.Fatal("forged output")
	}
	if err := (&conversation.CallerToolCall{}).AcknowledgeReturn(ctx, nil); err == nil {
		t.Fatal("forged return")
	}
	if err := call.ClaimDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	bad := conversation.AcceptCallerOutputRequest{Context: scope, Scope: r.Scope, Calls: []conversation.CallerFunctionCall{r.Call}, Outputs: []conversation.CallerFunctionOutput{{CallID: r.Call.CallID, Raw: []byte(`"one"`)}}}
	bad.Context.Physical.Binding.TaskEpoch++
	if _, err := call.AcceptOutput(ctx, bad); err == nil {
		t.Fatal("crossed output mapping")
	}
	bad.Context = scope
	out, err := call.AcceptOutput(ctx, bad)
	if err != nil {
		t.Fatal(err)
	}
	ack := &conversation.CallerReturn{Context: scope, ProducerOperationID: r.ProducerOperationID, CallID: r.Call.CallID, OutputSHA256: out.SHA256, OutputBytes: out.Bytes, Returned: true}
	ack.Context.Physical.Binding.TaskEpoch++
	if err := call.AcknowledgeReturn(ctx, ack); err == nil {
		t.Fatal("crossed ACK mapping")
	}
}

func TestCallerContractDispatchSnapshotStaysOnOriginal(t *testing.T) {
	h, b, j, _, scope := runningRelayHandle(t)
	ctx := context.Background()
	r := callerContractRequest(scope)
	call, err := h.BeginCallerTool(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	before := j.revision
	if err := call.CheckDispatch(ctx); err == nil {
		t.Fatal("unclaimed facade positive")
	}
	if err := call.ClaimDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 3; n++ {
		if err := call.CheckDispatch(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if j.revision != before || b.sends != 1 {
		t.Fatal("read changed original")
	}
	if err := call.ClaimDispatch(ctx); err == nil {
		t.Fatal("read renewed claim")
	}
	input := conversation.AcceptCallerOutputRequest{Context: scope, Scope: r.Scope, Calls: []conversation.CallerFunctionCall{r.Call}, Outputs: []conversation.CallerFunctionOutput{{CallID: r.Call.CallID, Raw: []byte(`"original"`)}}}
	out, err := call.AcceptOutput(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if err := call.CheckDispatch(ctx); err == nil {
		t.Fatal("accepted call executable")
	}
	if err := call.AcknowledgeReturn(ctx, &conversation.CallerReturn{Context: scope, ProducerOperationID: r.ProducerOperationID, CallID: r.Call.CallID, OutputSHA256: out.SHA256, OutputBytes: out.Bytes, Returned: true}); err != nil {
		t.Fatal(err)
	}
	if err := call.CheckDispatch(ctx); err == nil {
		t.Fatal("returned call executable")
	}
	if b.sends != 1 {
		t.Fatal("snapshot repeated Send")
	}
}

func TestCallerContractDispatchSnapshotRefusesForgedAndCancelled(t *testing.T) {
	for _, kind := range []string{"nil", "forged", "nil-context", "context-cancel", "owner-cancel"} {
		t.Run(kind, func(t *testing.T) {
			h, b, j, _, scope := runningRelayHandle(t)
			call, err := h.BeginCallerTool(context.Background(), callerContractRequest(scope))
			if err != nil {
				t.Fatal(err)
			}
			if err := call.ClaimDispatch(context.Background()); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			switch kind {
			case "nil":
				call = nil
			case "forged":
				call = &conversation.CallerToolCall{}
			case "nil-context":
				ctx = nil
			case "context-cancel":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "owner-cancel":
				if err := h.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
			}
			before := j.revision
			if err := call.CheckDispatch(ctx); err == nil {
				t.Fatal("forged/withdrawn facade positive")
			}
			if j.revision != before || b.sends != 1 {
				t.Fatal("read changed original")
			}
		})
	}
}

func TestCallerDeliveryContractLegacyClaimSettlementRemainsExplicit(t *testing.T) {
	h, _, _, _, scope := runningRelayHandle(t)
	r := callerContractRequest(scope)
	call, err := h.BeginCallerTool(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Existing compatibility callers may settle their original claim without
	// IssueDelivery. The separately selected HTTP path must require issuance.
	out, err := call.AcceptOutput(context.Background(), conversation.AcceptCallerOutputRequest{Context: scope, Scope: r.Scope, Calls: []conversation.CallerFunctionCall{r.Call}, Outputs: []conversation.CallerFunctionOutput{{CallID: r.Call.CallID, Raw: []byte(`"original"`)}}})
	if err != nil {
		t.Fatal(err)
	}
	if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
		t.Fatal("accepted compatibility call newly issued")
	}
	if err := call.AcknowledgeReturn(context.Background(), &conversation.CallerReturn{Context: scope, ProducerOperationID: r.ProducerOperationID, CallID: r.Call.CallID, OutputSHA256: out.SHA256, OutputBytes: out.Bytes, Returned: true}); err != nil {
		t.Fatal(err)
	}
}
