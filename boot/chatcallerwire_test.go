package boot

// Real framed transport, Chat lifecycle and Browser adapter. Persistence and
// physical browser are controlled; no native child, socket or provider starts.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"strings"
	"testing"
)

func chatCallerInput(h chatHandle) wire.ChatCallerBegin {
	identity := `{"rootTurnId":"root","sessionId":"session","threadId":"thread","turnId":"turn"}`
	hash := sha256.Sum256([]byte(identity))
	tag := hex.EncodeToString(hash[:])[:16]
	return wire.ChatCallerBegin{HandleId: h.id, ProducerOperationId: "producer-operation", RelayBinding: strings.Repeat("a", 64), RequestSHA256: strings.Repeat("b", 64), Scope: wire.ChatCallerScope{SessionId: "session", ThreadId: "thread", TurnId: "turn", RootTurnId: "root", Model: "chatgpt"}, Call: wire.ChatCallerFunction{ItemId: "fc_original", CallId: "farol_call_" + tag + strings.Repeat("c", 16), Name: "read_file", Arguments: `{"path":"note.md"}`}}
}
func chatCallerAccept(token wire.ChatCallerHandle, in wire.ChatCallerBegin) wire.ChatCallerAccept {
	return wire.ChatCallerAccept{Handle: token, Scope: in.Scope, Calls: []wire.ChatCallerFunction{in.Call}, Outputs: []wire.ChatCallerFunctionOutput{{CallId: in.Call.CallId, Raw: json.RawMessage(`[{"type":"input_text","text":"external 🍐 output"}]`)}}}
}
func TestChatCallerWireRoundOutputReceiptAndSameConversation(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "external-chat", chatComputerInput(true))
	computer, store, native, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	in := chatCallerInput(h)
	token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, in)), "ChatCallerHandle")
	if token.TicketId == "" || token.HandleId != h.id || token.CallId != in.Call.CallId || token.ProducerOperationId != in.ProducerOperationId {
		t.Fatal(token)
	}
	frames := taskWireTestData[wire.ChatFrames](t, p.call("chat.conversation.events", "", chatComputerWireJSON(t, wire.ChatEventsRequest{HandleId: h.id, AfterSequence: "0"})), "ChatFrames")
	complete, calls := 0, 0
	firstResponse := ""
	for _, frame := range frames.Frames {
		var v map[string]any
		json.Unmarshal(frame.Data, &v)
		if frame.Kind == "response.completed" {
			complete++
			firstResponse = v["response"].(map[string]any)["id"].(string)
		}
		if frame.Kind == "response.function_call_arguments.done" {
			calls++
		}
	}
	if complete != 1 || calls != 1 || f.count("resolve-computer") != 0 {
		t.Fatal("wrong first HTTP round")
	}
	r, err := h.handle.Result(context.Background())
	if r != nil || err == nil || err.Error() != "CHAT_LIFECYCLE_UNSETTLED" {
		t.Fatal("HTTP completion exposed a final Chat result", r, err)
	}
	taskWireTestData[wire.Empty](t, p.call("chat.caller.claim", "claim", chatComputerWireJSON(t, token)), "Empty")
	chatComputerWireNotOK(t, p.call("chat.caller.claim", "claim-again", chatComputerWireJSON(t, token)))
	out := taskWireTestData[wire.ChatCallerOutput](t, p.call("chat.caller.output", "output", chatComputerWireJSON(t, chatCallerAccept(token, in))), "ChatCallerOutput")
	if out.Output != "external 🍐 output" || out.Receipt.Handle != token || out.Receipt.ReceiptId == "" || out.Receipt.OutputBytes != fmt.Sprint(len(out.Output)) || f.count("resolve-computer") != 0 {
		t.Fatal("output acceptance became receipt", out)
	}
	// Read and frame ACK are transport observations only, even after output arrived.
	after := frames.Frames[len(frames.Frames)-1].Sequence
	next := taskWireTestData[wire.ChatFrames](t, p.call("chat.conversation.events", "", chatComputerWireJSON(t, wire.ChatEventsRequest{HandleId: h.id, AfterSequence: after})), "ChatFrames")
	if len(next.Frames) != 1 || next.Frames[0].Kind != "response.created" {
		t.Fatal("missing next HTTP round")
	}
	taskWireTestData[wire.ChatFrameAckResult](t, p.call("chat.conversation.frame.ack", "frame-ack", chatComputerWireJSON(t, wire.ChatFrameAck{HandleId: h.id, Sequence: after})), "ChatFrameAckResult")
	if f.count("resolve-computer") != 0 {
		t.Fatal("frame ACK resolved tool")
	}
	taskWireTestData[wire.Empty](t, p.call("chat.caller.return", "return", chatComputerWireJSON(t, out.Receipt)), "Empty")
	chatComputerWireNotOK(t, p.call("chat.caller.return", "return-again", chatComputerWireJSON(t, out.Receipt)))
	result := f.finish(t, h)
	if result.Text != "Useful before tool. Continued after read." || f.physical.sends != 1 || f.count("request-computer") != 1 || f.count("resolve-computer") != 1 || native.calls != 0 || store.admits != 0 {
		t.Fatal("external call executed internally or replaced conversation", result)
	}
	final := taskWireTestData[wire.ChatFrames](t, p.call("chat.conversation.events", "", chatComputerWireJSON(t, wire.ChatEventsRequest{HandleId: h.id, AfterSequence: after})), "ChatFrames")
	found := false
	for _, frame := range final.Frames {
		if frame.Kind == "response.completed" {
			var v map[string]any
			json.Unmarshal(frame.Data, &v)
			r := v["response"].(map[string]any)
			if r["id"] == firstResponse || !strings.Contains(string(frame.Data), "Continued after read.") || strings.Contains(string(frame.Data), "Useful before tool.") {
				t.Fatal("replayed first round into final", string(frame.Data))
			}
			found = true
		}
	}
	if !found {
		t.Fatal("missing true final")
	}
	raw, err := json.Marshal(p.frames)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CHAT_CALLER_CONTROLLED_FRAMES %s", raw)
}
func TestChatCallerWireUnknownIntentAndReturnNeverReplay(t *testing.T) {
	for _, fault := range []string{"request-computer", "resolve-computer"} {
		t.Run(fault, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "unknown-caller", chatComputerInput(true))
			computer, store, native, _ := f.computer(t)
			p := chatComputerWireConnect(t, f, computer)
			in := chatCallerInput(h)
			if fault == "request-computer" {
				f.journal.fail = fault
				chatComputerWireNotOK(t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, in)))
			} else {
				token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, in)), "ChatCallerHandle")
				taskWireTestData[wire.Empty](t, p.call("chat.caller.claim", "claim", chatComputerWireJSON(t, token)), "Empty")
				out := taskWireTestData[wire.ChatCallerOutput](t, p.call("chat.caller.output", "output", chatComputerWireJSON(t, chatCallerAccept(token, in))), "ChatCallerOutput")
				f.journal.fail = fault
				for _, operation := range []string{"return", "retry"} {
					chatComputerWireNotOK(t, p.call("chat.caller.return", operation, chatComputerWireJSON(t, out.Receipt)))
				}
				chatComputerWireNotOK(t, p.call("chat.caller.claim", "claim-again", chatComputerWireJSON(t, token)))
			}
			in.ProducerOperationId = "replacement"
			chatComputerWireNotOK(t, p.call("chat.caller.begin", "replacement", chatComputerWireJSON(t, in)))
			if f.count(fault) != 1 || f.count("request-computer") != 1 || f.physical.sends != 1 || native.calls != 0 || store.admits != 0 {
				t.Fatal("unknown replayed effect")
			}
		})
	}
}
func TestChatCallerWireCrossedContinuationAndReceiptRefused(t *testing.T) {
	for _, fault := range []string{"scope", "arguments", "call-id", "ticket", "receipt-id", "output-hash", "output-bytes", "cancel"} {
		t.Run(fault, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "crossed-caller", chatComputerInput(true))
			computer, _, native, _ := f.computer(t)
			p := chatComputerWireConnect(t, f, computer)
			in := chatCallerInput(h)
			token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, in)), "ChatCallerHandle")
			taskWireTestData[wire.Empty](t, p.call("chat.caller.claim", "claim", chatComputerWireJSON(t, token)), "Empty")
			input := chatCallerAccept(token, in)
			switch fault {
			case "scope":
				input.Scope.ThreadId = "other"
			case "arguments":
				input.Calls[0].Arguments = `{"path":"other"}`
			case "call-id":
				input.Outputs[0].CallId = "other"
			case "ticket":
				input.Handle.TicketId = "other"
			}
			if fault == "scope" || fault == "arguments" || fault == "call-id" || fault == "ticket" {
				chatComputerWireNotOK(t, p.call("chat.caller.output", "output", chatComputerWireJSON(t, input)))
			} else {
				out := taskWireTestData[wire.ChatCallerOutput](t, p.call("chat.caller.output", "output", chatComputerWireJSON(t, input)), "ChatCallerOutput")
				switch fault {
				case "receipt-id":
					out.Receipt.ReceiptId = "other"
				case "output-hash":
					out.Receipt.OutputSHA256 = strings.Repeat("d", 64)
				case "output-bytes":
					out.Receipt.OutputBytes = "1"
				case "cancel":
					_ = h.handle.Cancel(context.Background())
				}
				chatComputerWireNotOK(t, p.call("chat.caller.return", "return", chatComputerWireJSON(t, out.Receipt)))
			}
			if f.count("resolve-computer") != 0 || f.physical.sends != 1 || native.calls != 0 {
				t.Fatal("crossed input settled or executed")
			}
		})
	}
}
func TestChatCallerWireInternalReadNeverEmitsExternalCall(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "internal-only", chatComputerInput(true))
	computer, store, native, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	read := taskWireTestData[wire.ChatComputerOutput](t, p.call("chat.computer.read", "internal-read", chatComputerWireJSON(t, chatComputerWireInput(h))), "ChatComputerOutput")
	chatComputerWireNotOK(t, p.call("chat.caller.begin", "external", chatComputerWireJSON(t, chatCallerInput(h))))
	frames, err := h.handle.Events(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range frames {
		if strings.Contains(string(f.JSON), "function_call") {
			t.Fatal("already executed read became external call")
		}
	}
	taskWireTestData[wire.Empty](t, p.call("chat.computer.return", "read-return", chatComputerWireJSON(t, read.Receipt)), "Empty")
	f.finish(t, h)
	if native.calls != 1 || store.admits != 1 || f.count("request-computer") != 1 || f.count("resolve-computer") != 1 {
		t.Fatal("mixed executor")
	}
}
func TestChatCallerWireClosedBoundaryAndUnclaimedOutput(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "closed-caller", chatComputerInput(true))
	computer, _, native, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	in := chatCallerInput(h)
	raw := chatComputerWireJSON(t, in)
	for _, extra := range []string{`"ownerId":"other"`, `"returned":true`, `"grant":{}`, `"handleId":"duplicate"`} {
		chatComputerWireNotOK(t, p.call("chat.caller.begin", "invalid", strings.TrimSuffix(raw, "}")+","+extra+"}"))
	}
	token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", raw), "ChatCallerHandle")
	chatComputerWireNotOK(t, p.call("chat.caller.output", "unclaimed", chatComputerWireJSON(t, chatCallerAccept(token, in))))
	_ = h.handle.Cancel(context.Background())
	chatComputerWireNotOK(t, p.call("chat.caller.claim", "closed", chatComputerWireJSON(t, token)))
	if f.count("resolve-computer") != 0 || f.count("request-computer") != 1 || f.physical.sends != 1 || native.calls != 0 {
		t.Fatal("closed boundary executed")
	}
}

func TestChatCallerWireFreezeBlocksDispatchButAllowsOriginalReturn(t *testing.T) {
	for _, claimed := range []bool{false, true} {
		t.Run(fmt.Sprint(claimed), func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "freeze-caller", chatComputerInput(true))
			computer, _, native, _ := f.computer(t)
			p := chatComputerWireConnect(t, f, computer)
			in := chatCallerInput(h)
			token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, in)), "ChatCallerHandle")
			if claimed {
				taskWireTestData[wire.Empty](t, p.call("chat.caller.claim", "claim", chatComputerWireJSON(t, token)), "Empty")
			}
			if err := f.service.FreezeAdmissions(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !claimed {
				chatComputerWireNotOK(t, p.call("chat.caller.claim", "frozen-claim", chatComputerWireJSON(t, token)))
				chatComputerWireNotOK(t, p.call("chat.caller.output", "output", chatComputerWireJSON(t, chatCallerAccept(token, in))))
				if f.count("resolve-computer") != 0 {
					t.Fatal("unclaimed frozen output settled")
				}
			} else {
				out := taskWireTestData[wire.ChatCallerOutput](t, p.call("chat.caller.output", "output", chatComputerWireJSON(t, chatCallerAccept(token, in))), "ChatCallerOutput")
				taskWireTestData[wire.Empty](t, p.call("chat.caller.return", "return", chatComputerWireJSON(t, out.Receipt)), "Empty")
				if f.count("resolve-computer") != 1 {
					t.Fatal("known original receipt lost under freeze")
				}
			}
			if f.count("request-computer") != 1 || f.physical.sends != 1 || native.calls != 0 {
				t.Fatal("freeze created new effect")
			}
		})
	}
}
