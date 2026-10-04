package boot

// CPU protocol aggregate through the actual framed server, Chat ownership,
// Computer authority and mutation app. Native IO and persistence are controlled
// ports; there is no NewNativeRuntime, profile, Electron or installed provider.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

func chatMutationWireFixture(t *testing.T) (*chatComputerFixture, chatHandle, *chatComputerStore, *chatMutationJournal, *chatMutationNative, *taskWireTestPeer) {
	t.Helper()
	f := newChatComputerFixture(t)
	h := f.start(t, "wire-mutable", chatComputerInput(true))
	computer, store, _, _ := f.writableComputer(t)
	deps, journal, native := chatMutationDependencies()
	joined, err := chatComputerMutationIngress(f.ingress, computer, deps)
	if err != nil {
		t.Fatal(err)
	}
	return f, h, store, journal, native, chatComputerWireConnectRelay(t, f, computer, joined)
}
func chatMutationWireWrite(h chatHandle, call string) wire.ChatComputerWrite {
	return wire.ChatComputerWrite{HandleId: h.id, CallId: call, RelayBinding: strings.Repeat("a", 64), RequestSHA256: strings.Repeat("b", 64), WorkspaceId: "work", RelativePath: "note.md", Content: "Retained file 🍐"}
}
func chatMutationWireOutput(t *testing.T, response wire.Response, operation, call string) wire.ChatComputerOutput {
	t.Helper()
	output := taskWireTestData[wire.ChatComputerOutput](t, response, "ChatComputerOutput")
	digest := sha256.Sum256([]byte(output.Output))
	if output.Receipt.OutputSHA256 != hex.EncodeToString(digest[:]) || output.Receipt.OutputBytes != decimal(uint64(len(output.Output))) || output.Receipt.CallId != call {
		t.Fatal("crossed receipt", output)
	}
	var mutation wire.ComputerMutationResponse
	if wire.Validate("ComputerMutationResponse", []byte(output.Output)) != nil || json.Unmarshal([]byte(output.Output), &mutation) != nil || mutation.OperationId != operation || mutation.CallId != call || mutation.Phase != "completed" || mutation.Publication != "durable" || mutation.Receipt == nil {
		t.Fatal("crossed mutation result", output)
	}
	return output
}
func TestChatComputerMutationWireWriteEditAndExactReturn(t *testing.T) {
	f, h, store, journal, native, p := chatMutationWireFixture(t)
	input := chatMutationWireWrite(h, "write-call")
	first := chatMutationWireOutput(t, p.call("chat.computer.write", "write-op", chatComputerWireJSON(t, input)), "write-op", input.CallId)
	observation := taskWireTestData[wire.ChatComputerMutationObservation](t, p.call("chat.computer.mutation.read", "", chatComputerWireJSON(t, wire.ChatComputerMutationRead{HandleId: h.id, CallId: input.CallId})), "ChatComputerMutationObservation")
	if observation.Result.OperationId != "write-op" || observation.Result.Receipt == nil || native.calls != 1 || journal.saves != 1 || f.count("resolve-computer") != 0 {
		t.Fatal("read dispatched or acknowledged", observation)
	}
	chatComputerWireNotOK(t, p.call("chat.computer.write", "different-op", chatComputerWireJSON(t, input)))
	taskWireTestData[wire.Empty](t, p.call("chat.computer.return", "write-return", chatComputerWireJSON(t, first.Receipt)), "Empty")
	edit := wire.ChatComputerEdit{HandleId: h.id, CallId: "edit-call", RelayBinding: input.RelayBinding, RequestSHA256: strings.Repeat("c", 64), WorkspaceId: input.WorkspaceId, RelativePath: input.RelativePath, ExpectedSHA256: observation.Result.Receipt.AfterSHA256, Edits: []wire.ComputerTextEdit{{OldText: "Retained", NewText: "Updated"}}}
	second := chatMutationWireOutput(t, p.call("chat.computer.edit", "edit-op", chatComputerWireJSON(t, edit)), "edit-op", edit.CallId)
	taskWireTestData[wire.Empty](t, p.call("chat.computer.return", "edit-return", chatComputerWireJSON(t, second.Receipt)), "Empty")
	_ = f.finish(t, h)
	if native.calls != 2 || journal.admits != 2 || journal.saves != 2 || store.admits != 1 || f.count("resolve-computer") != 2 || f.physical.sends != 1 {
		t.Fatal("wire round repeated owners/effects")
	}
}
func TestChatComputerMutationWireMemoryOnlyObservedWithoutReturn(t *testing.T) {
	for _, fault := range []string{"before", "after"} {
		t.Run(fault, func(t *testing.T) {
			f, h, store, journal, native, p := chatMutationWireFixture(t)
			journal.saveFault = fault
			input := chatMutationWireWrite(h, "uncertain-call")
			response := p.call("chat.computer.write", "uncertain-op", chatComputerWireJSON(t, input))
			if response.Result == nil || response.Result.Status != "unknown" {
				t.Fatal("uncertain publication returned a usable relay receipt", response)
			}
			observed := taskWireTestData[wire.ChatComputerMutationObservation](t, p.call("chat.computer.mutation.read", "", chatComputerWireJSON(t, wire.ChatComputerMutationRead{HandleId: h.id, CallId: input.CallId})), "ChatComputerMutationObservation")
			if observed.Result.Phase != "completed" || observed.Result.Publication != "memory_only" || observed.Result.OperationId != "uncertain-op" {
				t.Fatal("lost known memory result", observed)
			}
			fake := wire.ChatComputerReceipt{ReceiptId: "invented", HandleId: h.id, CallId: input.CallId, RelayBinding: input.RelayBinding, RequestSHA256: input.RequestSHA256, OutputSHA256: strings.Repeat("d", 64), OutputBytes: "0"}
			chatComputerWireNotOK(t, p.call("chat.computer.return", "fake-return", chatComputerWireJSON(t, fake)))
			input.CallId = "fresh-key"
			chatComputerWireNotOK(t, p.call("chat.computer.write", "fresh-op", chatComputerWireJSON(t, input)))
			if native.calls != 1 || journal.admits != 1 || journal.saves != 1 || journal.loads != 0 || store.admits != 1 || f.count("request-computer") != 1 || f.count("resolve-computer") != 0 || f.physical.sends != 1 {
				t.Fatal("uncertain publication replayed/settled")
			}
		})
	}
}
func TestChatComputerMutationWireObserverCannotSelectExecuteOrAnotherCall(t *testing.T) {
	f, h, store, journal, native, p := chatMutationWireFixture(t)
	input := chatMutationWireWrite(h, "observed-call")
	_ = chatMutationWireOutput(t, p.call("chat.computer.write", "observed-op", chatComputerWireJSON(t, input)), "observed-op", input.CallId)
	for _, changed := range []wire.ChatComputerMutationRead{{HandleId: "other", CallId: input.CallId}, {HandleId: h.id, CallId: "other"}} {
		chatComputerWireNotOK(t, p.call("chat.computer.mutation.read", "", chatComputerWireJSON(t, changed)))
	}
	chatComputerWireNotOK(t, p.call("chat.computer.mutation.read", "new-effect", chatComputerWireJSON(t, wire.ChatComputerMutationRead{HandleId: h.id, CallId: input.CallId})))
	if native.calls != 1 || journal.admits != 1 || journal.saves != 1 || store.admits != 1 || f.count("resolve-computer") != 0 {
		t.Fatal("observer selected another operation")
	}
}
func TestChatComputerMutationWireClosedAndBoundedBeforeEffects(t *testing.T) {
	for _, reason := range []string{"extra", "hash", "too-large", "empty-edits", "too-many-edits", "wrong-method"} {
		t.Run(reason, func(t *testing.T) {
			f, h, store, journal, native, p := chatMutationWireFixture(t)
			input := chatMutationWireWrite(h, "invalid-call")
			raw := chatComputerWireJSON(t, input)
			method := "chat.computer.write"
			switch reason {
			case "extra":
				raw = strings.TrimSuffix(raw, "}") + `,"retry":true}`
			case "hash":
				raw = strings.TrimSuffix(raw, "}") + `,"expectedSHA256":"bad"}`
			case "too-large":
				input.Content = strings.Repeat("x", 262145)
				raw = chatComputerWireJSON(t, input)
			case "empty-edits", "too-many-edits":
				edits := []wire.ComputerTextEdit{}
				if reason == "too-many-edits" {
					for range 129 {
						edits = append(edits, wire.ComputerTextEdit{OldText: "a", NewText: "b"})
					}
				}
				method = "chat.computer.edit"
				raw = chatComputerWireJSON(t, wire.ChatComputerEdit{HandleId: h.id, CallId: input.CallId, RelayBinding: input.RelayBinding, RequestSHA256: input.RequestSHA256, WorkspaceId: "work", RelativePath: "note.md", ExpectedSHA256: strings.Repeat("c", 64), Edits: edits})
			case "wrong-method":
				method = "chat.computer.edit"
			}
			chatComputerWireNotOK(t, p.call(method, "invalid-op", raw))
			if native.calls != 0 || journal.admits != 0 || store.admits != 0 || f.count("request-computer") != 0 {
				t.Fatal("invalid input caused effects")
			}
		})
	}
}
func TestChatComputerMutationWireReadOnlyCompositionDoesNotActivate(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "read-only-composition", chatComputerInput(true))
	computer, store, native, _ := f.writableComputer(t)
	p := chatComputerWireConnect(t, f, computer)
	chatComputerWireNotOK(t, p.call("chat.computer.write", "unselected", chatComputerWireJSON(t, chatMutationWireWrite(h, "call"))))
	if store.admits != 0 || native.calls != 0 || f.count("request-computer") != 0 {
		t.Fatal("read-only composition adopted mutation owner")
	}
	if _, err := NewChatComputerMutationIngress(f.ingress, computer, nil, nil); err == nil {
		t.Fatal("missing concrete native owners accepted")
	}
	if _, err := h.handle.ComputerContext(context.Background()); err != nil {
		t.Fatal("unselected route altered Chat", err)
	}
}
