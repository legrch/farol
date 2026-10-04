package boot

// CPU aggregate through the real framed Server and Go Chat/Computer owners.
// Native storage, filesystem and physical browser remain explicit doubles.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	wire "github.com/legrch/farol/gen/desktop/v1"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/transport/desktop"
	"io"
	"strings"
	"testing"
	"time"
)

func chatComputerWireConnect(t *testing.T, f *chatComputerFixture, computer *ComputerIngress) *taskWireTestPeer {
	t.Helper()
	relay, err := NewChatComputerIngress(f.ingress, computer)
	if err != nil {
		t.Fatal(err)
	}
	return chatComputerWireConnectRelay(t, f, computer, relay)
}

func chatComputerWireConnectRelay(t *testing.T, f *chatComputerFixture, computer *ComputerIngress, relay *ChatComputerIngress) *taskWireTestPeer {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	browser, err := NewBrowserExchange(ctx, f.ingress.peer)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	runtime := &NativeRuntime{conversations: f.ingress, ingress: computer, browser: browser, chatComputer: relay}
	methods, err := runtime.Methods()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	server, err := desktop.New(desktop.Config{BuildID: "chat-computer", ProfileID: "profile", Generation: "backend", Methods: methods})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	input, send := io.Pipe()
	receive, output := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, input, output) }()
	t.Cleanup(func() {
		cancel()
		send.Close()
		receive.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("CPU chat/computer server did not close")
		}
	})
	p := &taskWireTestPeer{t: t, in: send, out: receive, scope: f.ingress.peer}
	r := p.call("core.handshake", "", `{"protocolMajor":1,"protocolMinor":0,"buildId":"chat-computer","profileId":"profile"}`)
	if r.Result == nil || r.Result.Status != "ok" {
		t.Fatal(r)
	}
	return p
}
func chatComputerWireInput(h chatHandle) wire.ChatComputerRead {
	return wire.ChatComputerRead{HandleId: h.id, CallId: "relay-call", RelayBinding: strings.Repeat("a", 64), RequestSHA256: strings.Repeat("b", 64), WorkspaceId: "work", RelativePath: "note.md"}
}
func chatComputerWireJSON(t *testing.T, v any) string {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}
func chatComputerWireNotOK(t *testing.T, r wire.Response) {
	t.Helper()
	if r.Error == nil && (r.Result == nil || r.Result.Status == "ok") {
		t.Fatal("unexpected positive response", r)
	}
}

func TestChatComputerWireReadReceiptAndRetainedContinuation(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "wire-chat", chatComputerInput(true))
	computer, store, native, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	in := chatComputerWireInput(h)
	result := taskWireTestData[wire.ChatComputerOutput](t, p.call("chat.computer.read", "read-1", chatComputerWireJSON(t, in)), "ChatComputerOutput")
	digest := sha256.Sum256([]byte(result.Output))
	if result.Receipt.HandleId != h.id || result.Receipt.CallId != in.CallId || result.Receipt.RelayBinding != in.RelayBinding || result.Receipt.RequestSHA256 != in.RequestSHA256 || result.Receipt.OutputSHA256 != hex.EncodeToString(digest[:]) || result.Receipt.OutputBytes != fmt.Sprint(len(result.Output)) || result.Receipt.ReceiptId == "" {
		t.Fatal("wrong result identity", result)
	}
	var output wire.ComputerReadResponse
	if json.Unmarshal([]byte(result.Output), &output) != nil || wire.Validate("ComputerReadResponse", []byte(result.Output)) != nil || output.Text != "test" || output.TaskId != h.binding.TaskID || output.ParticipantId != h.binding.ParticipantID || output.CallId != in.CallId {
		t.Fatal("wrong Computer result", output)
	}
	if store.admits != 1 || native.calls != 1 || f.physical.sends != 1 || f.count("resolve-computer") != 0 {
		t.Fatal("write was mistaken for receipt")
	}
	taskWireTestData[wire.Empty](t, p.call("chat.computer.return", "returned-1", chatComputerWireJSON(t, result.Receipt)), "Empty")
	if f.count("resolve-computer") != 1 {
		t.Fatal("exact parsed receipt did not settle")
	}
	for _, operation := range []string{"read-1", "read-again"} {
		chatComputerWireNotOK(t, p.call("chat.computer.read", operation, chatComputerWireJSON(t, in)))
	}
	chatComputerWireNotOK(t, p.call("chat.computer.return", "returned-again", chatComputerWireJSON(t, result.Receipt)))
	retained := f.finish(t, h)
	if retained.Text != "Useful before tool. Continued after read." || native.calls != 1 || store.admits != 1 || f.physical.sends != 1 || f.count("resolve-computer") != 1 {
		t.Fatal("extra effect or lost continuation")
	}
	frames, e := json.Marshal(p.frames)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("CHAT_COMPUTER_CONTROLLED_FRAMES %s", frames)
}
func TestChatComputerWireCrossedReceiptNeverSettles(t *testing.T) {
	changes := map[string]func(*wire.ChatComputerReceipt){
		"handle": func(r *wire.ChatComputerReceipt) { r.HandleId = "other" }, "call": func(r *wire.ChatComputerReceipt) { r.CallId = "other" }, "receipt": func(r *wire.ChatComputerReceipt) { r.ReceiptId = "other" }, "binding": func(r *wire.ChatComputerReceipt) { r.RelayBinding = strings.Repeat("c", 64) }, "request": func(r *wire.ChatComputerReceipt) { r.RequestSHA256 = strings.Repeat("c", 64) }, "output": func(r *wire.ChatComputerReceipt) { r.OutputSHA256 = strings.Repeat("c", 64) }, "bytes": func(r *wire.ChatComputerReceipt) { r.OutputBytes = "999" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "crossed-chat", chatComputerInput(true))
			computer, store, native, _ := f.computer(t)
			p := chatComputerWireConnect(t, f, computer)
			in := chatComputerWireInput(h)
			result := taskWireTestData[wire.ChatComputerOutput](t, p.call("chat.computer.read", "read", chatComputerWireJSON(t, in)), "ChatComputerOutput")
			change(&result.Receipt)
			chatComputerWireNotOK(t, p.call("chat.computer.return", "return", chatComputerWireJSON(t, result.Receipt)))
			if f.count("resolve-computer") != 0 || store.admits != 1 || native.calls != 1 || f.physical.sends != 1 {
				t.Fatal("crossed receipt acted")
			}
			if _, e := h.handle.ComputerContext(context.Background()); e == nil {
				t.Fatal("call no longer outstanding")
			}
		})
	}
}
func TestChatComputerWireLostResolveACKDoesNotRepeat(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "unknown-resolve", chatComputerInput(true))
	computer, store, native, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	in := chatComputerWireInput(h)
	result := taskWireTestData[wire.ChatComputerOutput](t, p.call("chat.computer.read", "read", chatComputerWireJSON(t, in)), "ChatComputerOutput")
	f.journal.fail = "resolve-computer"
	first := p.call("chat.computer.return", "resolve", chatComputerWireJSON(t, result.Receipt))
	if first.Result == nil || first.Result.Status != "unknown" {
		t.Fatal(first)
	}
	chatComputerWireNotOK(t, p.call("chat.computer.return", "resolve-again", chatComputerWireJSON(t, result.Receipt)))
	in.CallId = "replacement"
	chatComputerWireNotOK(t, p.call("chat.computer.read", "read-again", chatComputerWireJSON(t, in)))
	if f.count("resolve-computer") != 1 || f.count("request-computer") != 1 || native.calls != 1 || store.admits != 1 || f.physical.sends != 1 {
		t.Fatal("unknown ACK replayed work")
	}
}
func TestChatComputerWireMembershipUnknownPreventsReturnedReceipt(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "unknown-admission", chatComputerInput(true))
	computer, store, native, _ := f.computer(t)
	store.fault = "unknown"
	p := chatComputerWireConnect(t, f, computer)
	in := chatComputerWireInput(h)
	for _, operation := range []string{"read", "new-read"} {
		chatComputerWireNotOK(t, p.call("chat.computer.read", operation, chatComputerWireJSON(t, in)))
	}
	fake := wire.ChatComputerReceipt{ReceiptId: "invented", HandleId: h.id, CallId: in.CallId, RelayBinding: in.RelayBinding, RequestSHA256: in.RequestSHA256, OutputSHA256: strings.Repeat("c", 64), OutputBytes: "0"}
	chatComputerWireNotOK(t, p.call("chat.computer.return", "fake-return", chatComputerWireJSON(t, fake)))
	if store.admits != 1 || native.calls != 0 || f.count("request-computer") != 1 || f.count("resolve-computer") != 0 || f.physical.sends != 1 {
		t.Fatal("unknown membership replayed")
	}
}
func TestChatComputerWireClosedInputAndContextRejectBeforeEffect(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "closed-input", chatComputerInput(true))
	computer, store, native, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	in := chatComputerWireInput(h)
	raw := chatComputerWireJSON(t, in)
	for _, extra := range []string{`"ownerId":"other"`, `"root":"/"`, `"grant":{}`, `"returned":true`, `"handleId":"duplicate"`} {
		chatComputerWireNotOK(t, p.call("chat.computer.read", "bad", strings.TrimSuffix(raw, "}")+","+extra+"}"))
	}
	in.RequestSHA256 = "bad"
	chatComputerWireNotOK(t, p.call("chat.computer.read", "bad-hash", chatComputerWireJSON(t, in)))
	p.scope.BackendGeneration = "other"
	chatComputerWireNotOK(t, p.call("chat.computer.read", "bad-context", raw))
	if store.admits != 0 || native.calls != 0 || f.count("request-computer") != 0 {
		t.Fatal("invalid request reached owner")
	}
}
func TestChatComputerWireCancelledOwnerCannotAcknowledge(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "cancelled-chat", chatComputerInput(true))
	computer, _, native, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	result := taskWireTestData[wire.ChatComputerOutput](t, p.call("chat.computer.read", "read", chatComputerWireJSON(t, chatComputerWireInput(h))), "ChatComputerOutput")
	if err := h.handle.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	chatComputerWireNotOK(t, p.call("chat.computer.return", "late-return", chatComputerWireJSON(t, result.Receipt)))
	if f.count("resolve-computer") != 0 || native.calls != 1 || f.physical.sends != 1 {
		t.Fatal("cancelled receipt settled or dispatched")
	}
}

func TestChatComputerWireDistinctReadsReuseMembershipWithFreshOperationLeases(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "two-read-chat", chatComputerInput(true))
	computer, store, native, clock := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	in := chatComputerWireInput(h)
	first := taskWireTestData[wire.ChatComputerOutput](t, p.call("chat.computer.read", "read-1", chatComputerWireJSON(t, in)), "ChatComputerOutput")
	taskWireTestData[wire.Empty](t, p.call("chat.computer.return", "return-1", chatComputerWireJSON(t, first.Receipt)), "Empty")
	// A second operation must select its own lease. Reusing the first read's lease
	// after its ordinary deadline would refuse, while original permission remains.
	clock.now = clock.now.Add(authority.OrdinaryExecutionLifetime + time.Second)
	in.CallId = "second-call"
	in.RelativePath = "second.md"
	in.RequestSHA256 = strings.Repeat("c", 64)
	second := taskWireTestData[wire.ChatComputerOutput](t, p.call("chat.computer.read", "read-2", chatComputerWireJSON(t, in)), "ChatComputerOutput")
	if second.Receipt.ReceiptId == first.Receipt.ReceiptId || second.Receipt.CallId != in.CallId || second.Receipt.OutputSHA256 == first.Receipt.OutputSHA256 {
		t.Fatal("second call reused first result identity")
	}
	taskWireTestData[wire.Empty](t, p.call("chat.computer.return", "return-2", chatComputerWireJSON(t, second.Receipt)), "Empty")
	if store.admits != 1 || native.calls != 2 || f.count("request-computer") != 2 || f.count("resolve-computer") != 2 || f.count("admit") != 1 {
		t.Fatal("membership repeated or read/ACK missing", store.admits, native.calls)
	}
	in.CallId = "relay-call"
	chatComputerWireNotOK(t, p.call("chat.computer.read", "read-old-call", chatComputerWireJSON(t, in)))
	retained := f.finish(t, h)
	if retained.Text != "Useful before tool. Continued after read." || f.physical.sends != 1 || native.calls != 2 {
		t.Fatal("repeated Send or missing continuation")
	}
}
func TestChatComputerWireReusedRouteRechecksOwnersWithoutReadmission(t *testing.T) {
	for _, reason := range []string{"fence", "revoke", "approval-expired", "workspace", "cancel", "late-deadline"} {
		t.Run(reason, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "reuse-denied", chatComputerInput(true))
			computer, store, native, clock := f.computer(t)
			p := chatComputerWireConnect(t, f, computer)
			in := chatComputerWireInput(h)
			first := taskWireTestData[wire.ChatComputerOutput](t, p.call("chat.computer.read", "read-1", chatComputerWireJSON(t, in)), "ChatComputerOutput")
			taskWireTestData[wire.Empty](t, p.call("chat.computer.return", "return-1", chatComputerWireJSON(t, first.Receipt)), "Empty")
			in.CallId = "read-2"
			expectedReads := 1
			switch reason {
			case "fence":
				_, _ = computer.guard.deactivate()
			case "revoke":
				store.RevokeParticipant(h.binding.ParticipantID)
			case "approval-expired":
				approval := store.approval.Clone()
				approval.ExpiresAt = clock.now.Add(-time.Second)
				store.PutApproval(approval)
			case "workspace":
				in.WorkspaceId = "outside"
			case "cancel":
				if e := h.handle.Cancel(context.Background()); e != nil {
					t.Fatal(e)
				}
			case "late-deadline":
				expectedReads = 2
				native.after = func() { clock.now = clock.now.Add(authority.OrdinaryExecutionLifetime) }
			}
			chatComputerWireNotOK(t, p.call("chat.computer.read", "read-2", chatComputerWireJSON(t, in)))
			if store.admits != 1 || native.calls != expectedReads || f.count("resolve-computer") != 1 || f.physical.sends != 1 {
				t.Fatal("reused route restored authority, repeated membership or disclosed late data", store.admits, native.calls)
			}
			in.CallId = "replacement"
			chatComputerWireNotOK(t, p.call("chat.computer.read", "replacement", chatComputerWireJSON(t, in)))
			if store.admits != 1 || native.calls != expectedReads {
				t.Fatal("refused/unknown read retried")
			}
		})
	}
}

func TestChatComputerWireOwnerObservationDoesNotReplaceOriginalRootReceipt(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "receipt-owner", chatComputerInput(true))
	computer, store, native, _ := f.computer(t)
	relay, err := NewChatComputerIngress(f.ingress, computer)
	if err != nil {
		t.Fatal(err)
	}
	in := chatComputerWireInput(h)
	ctx := context.Background()
	if _, err = relay.read(ctx, "read-1", in); err != nil {
		t.Fatal(err)
	}
	original := relay.calls[chatComputerKey{in.HandleId, in.CallId}]
	// Simulate observing a settled owner through a different trusted path. That
	// fact cannot manufacture the missing original parsed-result receipt in Root.
	if err = original.call.AcknowledgeReturn(ctx, &conversation.ComputerReturn{Context: original.correlation, CallID: in.CallId, Returned: true}); err != nil {
		t.Fatal(err)
	}
	in.CallId = "read-2"
	if _, err = relay.read(ctx, "read-2", in); err == nil || native.calls != 1 || store.admits != 1 || f.count("request-computer") != 1 {
		t.Fatal("owner observation substituted for exact Root receipt", err, native.calls)
	}
}
