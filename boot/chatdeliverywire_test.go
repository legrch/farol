package boot

// Actual Go owner and common server; injected browser/storage, no native IO.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/chat/infra/responses"
	"strings"
	"testing"
)

func TestChatDeliveryWireIssuesExactOriginalGroupOnceWithoutReceipt(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "delivery-original", chatComputerInput(true))
	before, err := h.handle.Events(context.Background(), 0)
	if err != nil || len(before) == 0 {
		t.Fatal("missing useful prefix", err)
	}
	cursor := before[len(before)-1].Sequence
	computer, store, native, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	in := chatCallerInput(h)
	token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, in)), "ChatCallerHandle")
	body := chatComputerWireJSON(t, token)
	chatComputerWireNotOK(t, p.call("chat.caller.issue", "before-claim", body))
	taskWireTestData[wire.Empty](t, p.call("chat.caller.claim", "claim", body), "Empty")
	taskWireTestData[wire.Empty](t, p.call("chat.caller.check", "", body), "Empty")
	count := len(f.journal.entries)
	issued := taskWireTestData[wire.ChatCallerDelivery](t, p.call("chat.caller.issue", "issue", body), "ChatCallerDelivery")
	frames, err := h.handle.Events(context.Background(), cursor)
	if err != nil {
		t.Fatal(err)
	}
	var expected strings.Builder
	for _, frame := range frames {
		encoded, err := responses.Encode(frame)
		if err != nil {
			t.Fatal(err)
		}
		expected.Write(encoded)
	}
	sum := sha256.Sum256([]byte(issued.Data))
	if issued.IssuanceId == "" || issued.Handle != token || issued.FirstSequence != decimal(cursor+1) || issued.LastSequence != decimal(frames[len(frames)-1].Sequence) || issued.Data != expected.String() || issued.DataSHA256 != hex.EncodeToString(sum[:]) || issued.DataBytes != fmt.Sprint(len(issued.Data)) {
		t.Fatal("issuance differs from original owner frames", issued)
	}
	if !strings.Contains(issued.Data, "event: response.function_call_arguments.done") || !strings.Contains(issued.Data, "event: response.completed") || !strings.Contains(issued.Data, in.Call.CallId) {
		t.Fatal("missing original executable group")
	}
	chatComputerWireNotOK(t, p.call("chat.caller.issue", "retry-issue", body))
	if len(f.journal.entries) != count || f.count("resolve-computer") != 0 || store.admits != 0 || native.calls != 0 || f.physical.sends != 1 {
		t.Fatal("issue became ACK/effect/replay")
	}
	// A later freeze cannot recall an issued group. Original receipt settlement
	// remains available, but no issue or observation settles the tool itself.
	if err = f.service.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	chatComputerWireNotOK(t, p.call("chat.caller.issue", "after-freeze", body))
	out := taskWireTestData[wire.ChatCallerOutput](t, p.call("chat.caller.output", "output", chatComputerWireJSON(t, chatCallerAccept(token, in))), "ChatCallerOutput")
	if f.count("resolve-computer") != 0 {
		t.Fatal("output automatically returned")
	}
	taskWireTestData[wire.Empty](t, p.call("chat.caller.return", "return", chatComputerWireJSON(t, out.Receipt)), "Empty")
	if f.count("resolve-computer") != 1 || f.physical.sends != 1 {
		t.Fatal("original settlement missing or duplicated")
	}
	raw, err := json.Marshal(p.frames)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CHAT_DELIVERY_CONTROLLED_FRAMES %s", raw)
}
func TestChatDeliveryWireCheckThenWithdrawalDoesNotIssue(t *testing.T) {
	for _, fault := range []string{"freeze", "cancel", "crossed-ticket", "crossed-call", "wrong-context", "no-operation"} {
		t.Run(fault, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "delivery-withdrawn", chatComputerInput(true))
			computer, _, _, _ := f.computer(t)
			p := chatComputerWireConnect(t, f, computer)
			in := chatCallerInput(h)
			token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, in)), "ChatCallerHandle")
			taskWireTestData[wire.Empty](t, p.call("chat.caller.claim", "claim", chatComputerWireJSON(t, token)), "Empty")
			taskWireTestData[wire.Empty](t, p.call("chat.caller.check", "", chatComputerWireJSON(t, token)), "Empty")
			operation := "issue"
			switch fault {
			case "freeze":
				if err := f.service.FreezeAdmissions(context.Background()); err != nil {
					t.Fatal(err)
				}
			case "cancel":
				_ = h.handle.Cancel(context.Background())
			case "crossed-ticket":
				token.TicketId = "other"
			case "crossed-call":
				token.CallId = "other"
			case "wrong-context":
				p.scope.BackendGeneration = "other"
			case "no-operation":
				operation = ""
			}
			count := len(f.journal.entries)
			chatComputerWireNotOK(t, p.call("chat.caller.issue", operation, chatComputerWireJSON(t, token)))
			if len(f.journal.entries) != count || f.count("resolve-computer") != 0 || f.physical.sends != 1 {
				t.Fatal("rejected issue caused effects")
			}
		})
	}
}
