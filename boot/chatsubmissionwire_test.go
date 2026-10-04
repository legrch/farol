package boot

// Actual Go owner and common framed server. No native/profile/provider startup.
import (
	"context"
	"encoding/json"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"testing"
)

func TestChatSubmissionWireObservationDoesNotWithdrawOrAuthorizeRetry(t *testing.T) {
	f := newChatComputerFixture(t)
	computer, _, _, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	handle, err := f.ingress.create(context.Background(), "submission-create", chatComputerInput(false))
	if err != nil {
		t.Fatal(err)
	}
	h, err := f.ingress.get(handle.HandleId)
	if err != nil {
		t.Fatal(err)
	}
	body := chatComputerWireJSON(t, wire.ChatHandleRequest{HandleId: h.id})
	observe := func(want string) {
		t.Helper()
		out := taskWireTestData[wire.ChatSubmissionState](t, p.call("chat.conversation.submission", "", body), "ChatSubmissionState")
		if out.Handle != *handle || out.State != want {
			t.Fatal("crossed state", out)
		}
	}
	before := len(f.journal.entries)
	observe("not-dispatched")
	observe("not-dispatched")
	if len(f.journal.entries) != before || f.physical.sends != 0 {
		t.Fatal("observation mutated owner")
	}
	if _, err = f.ingress.facade.PrepareNext(context.Background(), 10000); err != nil {
		t.Fatal(err)
	}
	observe("not-dispatched")
	// The same handle can still Send: not-dispatched was never withdrawal proof.
	if err = h.handle.Send(context.Background(), 10000); err != nil {
		t.Fatal(err)
	}
	before = len(f.journal.entries)
	observe("intent-committed")
	observe("intent-committed")
	if f.physical.sends != 1 || len(f.journal.entries) != before {
		t.Fatal("observation repeated or modified Send")
	}
	chatComputerWireNotOK(t, p.call("chat.conversation.submission", "effect-mislabel", body))
	raw, err := json.Marshal(p.frames)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CHAT_SUBMISSION_CONTROLLED_FRAMES %s", raw)
}
func TestChatSubmissionWireLostIntentRemainsUnknownWithoutAnotherSend(t *testing.T) {
	f := newChatComputerFixture(t)
	computer, _, _, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	h, err := f.ingress.create(context.Background(), "unknown-submission", chatComputerInput(false))
	if err != nil {
		t.Fatal(err)
	}
	actual, err := f.ingress.get(h.HandleId)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.ingress.facade.PrepareNext(context.Background(), 10000); err != nil {
		t.Fatal(err)
	}
	f.journal.fail = "dispatch"
	if err = actual.handle.Send(context.Background(), 10000); err == nil {
		t.Fatal("lost intent became known")
	}
	before := len(f.journal.entries)
	for n := 0; n < 2; n++ {
		v := taskWireTestData[wire.ChatSubmissionState](t, p.call("chat.conversation.submission", "", chatComputerWireJSON(t, wire.ChatHandleRequest{HandleId: h.HandleId})), "ChatSubmissionState")
		if v.State != "unknown" {
			t.Fatal(v)
		}
	}
	if f.count("dispatch") != 1 || f.physical.sends != 0 || len(f.journal.entries) != before {
		t.Fatal("intent observation dispatched/reconciled original")
	}
}
func TestChatCallerCheckWireOnlyObservesOriginalClaim(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "check-caller", chatComputerInput(true))
	computer, _, _, _ := f.computer(t)
	p := chatComputerWireConnect(t, f, computer)
	in := chatCallerInput(h)
	token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, in)), "ChatCallerHandle")
	body := chatComputerWireJSON(t, token)
	chatComputerWireNotOK(t, p.call("chat.caller.check", "", body))
	taskWireTestData[wire.Empty](t, p.call("chat.caller.claim", "claim", body), "Empty")
	before := len(f.journal.entries)
	for n := 0; n < 2; n++ {
		taskWireTestData[wire.Empty](t, p.call("chat.caller.check", "", body), "Empty")
	}
	if len(f.journal.entries) != before || f.physical.sends != 1 {
		t.Fatal("check is an effect")
	}
	chatComputerWireNotOK(t, p.call("chat.caller.claim", "new-claim", body))
	chatComputerWireNotOK(t, p.call("chat.caller.check", "effect-mislabel", body))
	out := taskWireTestData[wire.ChatCallerOutput](t, p.call("chat.caller.output", "output", chatComputerWireJSON(t, chatCallerAccept(token, in))), "ChatCallerOutput")
	chatComputerWireNotOK(t, p.call("chat.caller.check", "", body))
	taskWireTestData[wire.Empty](t, p.call("chat.caller.return", "return", chatComputerWireJSON(t, out.Receipt)), "Empty")
	chatComputerWireNotOK(t, p.call("chat.caller.check", "", body))
	if f.count("request-computer") != 1 || f.count("resolve-computer") != 1 || f.physical.sends != 1 {
		t.Fatal("check replaced original call")
	}
}
func TestChatCallerCheckWireWithdrawnOrCrossedSnapshotRefused(t *testing.T) {
	for _, fault := range []string{"freeze", "cancel", "handle", "ticket", "binding", "context"} {
		t.Run(fault, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "check-withdrawn", chatComputerInput(true))
			computer, _, _, _ := f.computer(t)
			p := chatComputerWireConnect(t, f, computer)
			token := taskWireTestData[wire.ChatCallerHandle](t, p.call("chat.caller.begin", "begin", chatComputerWireJSON(t, chatCallerInput(h))), "ChatCallerHandle")
			taskWireTestData[wire.Empty](t, p.call("chat.caller.claim", "claim", chatComputerWireJSON(t, token)), "Empty")
			switch fault {
			case "freeze":
				if err := f.service.FreezeAdmissions(context.Background()); err != nil {
					t.Fatal(err)
				}
			case "cancel":
				_ = h.handle.Cancel(context.Background())
			case "handle":
				token.HandleId = "other"
			case "ticket":
				token.TicketId = "other"
			case "binding":
				token.RelayBinding = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
			case "context":
				p.scope.BackendGeneration = "other"
			}
			before := len(f.journal.entries)
			chatComputerWireNotOK(t, p.call("chat.caller.check", "", chatComputerWireJSON(t, token)))
			if len(f.journal.entries) != before || f.count("resolve-computer") != 0 || f.physical.sends != 1 {
				t.Fatal("snapshot restored authority")
			}
		})
	}
}
