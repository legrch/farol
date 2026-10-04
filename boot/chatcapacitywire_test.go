package boot

// Framed Root + actual Chat queue. All physical and persistence ports are
// controlled; neither a native process nor an installed browser is involved.
import (
	"fmt"
	"strconv"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

func TestChatPrepareCapacityKeepsSixthQueuedBeforeAnyEffect(t *testing.T) {
	f := newChatComputerFixture(t)
	f.physical.distinctViews = true
	computer, _, _, _ := f.computer(t)
	peer := chatComputerWireConnect(t, f, computer)
	deadline := strconv.FormatInt(time.Now().Add(10*time.Second).UnixMilli(), 10)
	var sixth wire.ChatHandle
	for n := 0; n < 6; n++ {
		h := taskWireTestData[wire.ChatHandle](t, peer.call("chat.conversation.create", fmt.Sprintf("create-%d", n), chatComputerWireJSON(t, chatComputerInput(false))), "ChatHandle")
		if n == 5 {
			sixth = h
			break
		}
		prepared := taskWireTestData[wire.ChatPrepared](t, peer.call("chat.conversation.prepare", fmt.Sprintf("prepare-%d", n), chatComputerWireJSON(t, wire.ChatDeadline{DeadlineMillis: deadline})), "ChatPrepared")
		if prepared.Handle != h || prepared.SlotOrdinal != uint32(n+1) {
			t.Fatal("global FIFO owner crossed", prepared, h)
		}
		taskWireTestData[wire.Empty](t, peer.call("chat.conversation.send", fmt.Sprintf("send-%d", n), chatComputerWireJSON(t, wire.ChatAction{HandleId: h.HandleId, DeadlineMillis: deadline})), "Empty")
	}
	before := len(f.journal.entries)
	response := peer.call("chat.conversation.prepare", "prepare-sixth", chatComputerWireJSON(t, wire.ChatDeadline{DeadlineMillis: deadline}))
	if response.Result == nil || response.Result.Status != "refused" || response.Result.Code == nil || *response.Result.Code != "CHAT_CAPACITY" {
		t.Fatal("capacity lost its no-effect classification", response)
	}
	if len(f.journal.entries) != before || f.physical.prepares != 5 || f.physical.sends != 5 || f.count("reserve") != 5 || f.count("dispatch") != 5 {
		t.Fatal("sixth capacity check caused an effect")
	}
	state := taskWireTestData[wire.ChatSubmissionState](t, peer.call("chat.conversation.submission", "", chatComputerWireJSON(t, wire.ChatHandleRequest{HandleId: sixth.HandleId})), "ChatSubmissionState")
	if state.Handle != sixth || state.State != "not-dispatched" {
		t.Fatal("sixth queued identity lost", state)
	}
}

func TestChatPrepareLostJournalReceiptStaysUnknown(t *testing.T) {
	f := newChatComputerFixture(t)
	computer, _, _, _ := f.computer(t)
	peer := chatComputerWireConnect(t, f, computer)
	taskWireTestData[wire.ChatHandle](t, peer.call("chat.conversation.create", "create", chatComputerWireJSON(t, chatComputerInput(false))), "ChatHandle")
	f.journal.fail = "reserve"
	response := peer.call("chat.conversation.prepare", "prepare-unknown", chatComputerWireJSON(t, wire.ChatDeadline{DeadlineMillis: strconv.FormatInt(time.Now().Add(10*time.Second).UnixMilli(), 10)}))
	if response.Result == nil || response.Result.Status != "unknown" || response.Result.Code == nil || *response.Result.Code == "CHAT_CAPACITY" {
		t.Fatal("uncertain publication became harmless capacity", response)
	}
	if f.count("reserve") != 1 || f.physical.prepares != 0 || f.physical.sends != 0 {
		t.Fatal("lost receipt caused browser effect or replay")
	}
}
