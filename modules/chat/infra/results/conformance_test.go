package results

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// These journeys use the actual lifecycle owner, actual browser adapter and
// production byte retention. Exchange/journal are CPU doubles, not native/live
// provider, durable-filesystem or process-restart evidence.
type clockFixture struct{}

func (clockFixture) NowMillis() uint64 { return 1 }

type exchangeFixture struct{ calls []browser.Command }

func (e *exchangeFixture) Exchange(_ context.Context, c browser.Command) (browser.Reply, error) {
	e.calls = append(e.calls, c)
	switch r := c.(type) {
	case browser.PrepareCommand:
		cid := "saved-conversation"
		if r.Target.Mode == "owned-saved" {
			cid = r.Target.ConversationID
		}
		return browser.PreparedReply{Saved: true, Readiness: "ready", Binding: browser.Binding{Lease: r.Lease, ViewID: "view", ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration, ConversationID: cid}}, nil
	case browser.VerifySendCommand:
		return browser.VerifiedReply{Verification: browser.Verification{Binding: r.Binding, Observed: r.Requested, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, IntentDigest: r.IntentDigest, EvidenceID: "proof-" + r.Binding.Lease.Identity.OperationID}}, nil
	case browser.SendCommand:
		return browser.SentReply{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: "submitted"}, nil
	case browser.ObserveCommand:
		suffix := r.Binding.Lease.Identity.TurnID
		event := browser.Observation{Binding: r.Binding, Sequence: r.AfterSequence + 1, ObservedAtMillis: 2, UserTurnID: "user-" + suffix, ReplyID: "reply-" + suffix}
		switch r.AfterSequence {
		case 0:
			event.Kind = "accepted"
		case 1:
			event.Kind = "answer-delta"
			event.SegmentID = "segment-" + suffix
			event.Text = "stored lifecycle answer:" + suffix
		case 2:
			event.Kind = "completed"
		case 3:
			event.Kind = "quiescent"
		default:
			return browser.ObservedReply{}, nil
		}
		return browser.ObservedReply{Events: []browser.Observation{event}}, nil
	}
	return nil, errors.New("unexpected CPU command")
}

type journalFixture struct {
	revision uint64
	writes   []port.JournalWrite
}

func (*journalFixture) OpenFresh(_ context.Context, s port.JournalScope) (*port.JournalHead, error) {
	return &port.JournalHead{Scope: s}, nil
}
func (j *journalFixture) Commit(_ context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	if w.PreviousRevision != j.revision {
		return nil, errors.New("fixture revision")
	}
	j.revision = w.Revision
	j.writes = append(j.writes, w)
	return &port.JournalReceipt{Write: w}, nil
}

const deadline = 1000000

func serviceFixture(t *testing.T, limits Limits) (*lifecycle.Service, *Memory, *exchangeFixture, *journalFixture, port.ConversationInput) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	memory, err := NewMemory(ctx, scopeFixture(), limits)
	if err != nil {
		t.Fatal(err)
	}
	exchange, journal := &exchangeFixture{}, &journalFixture{}
	adapter, err := browser.New(ctx, browser.Scope{ProfileID: "profile", BackendGeneration: "backend"}, exchange, clockFixture{})
	if err != nil {
		t.Fatal(err)
	}
	service, err := lifecycle.New(ctx, scopeFixture(), lifecycle.Dependencies{Gate: gate.New(), Journal: journal, Browser: adapter, Results: memory, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	input := port.ConversationInput{Binding: bindingFixture(), Selection: port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "cheap", Effort: "low", Mode: "standard"}, Prompt: "private fixture prompt"}
	return service, memory, exchange, journal, input
}
func finishFixture(t *testing.T, c *lifecycle.Conversation) {
	t.Helper()
	if err := c.Send(context.Background(), deadline); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 3; n++ {
		if err := c.Observe(context.Background(), deadline); err != nil {
			t.Fatal(err)
		}
	}
}
func TestRealLifecycleDeliveryACKAndFollowupKeepStoredBytesOutsideActivity(t *testing.T) {
	if TextLimits().ResultBytes != lifecycle.OutputBytesLimit {
		t.Fatal("retention text bound differs from owner")
	}
	service, memory, exchange, journal, input := serviceFixture(t, TextLimits())
	ctx := context.Background()
	first, err := service.CreateConversation(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	firstBinding, err := service.PrepareNext(ctx, deadline)
	if err != nil {
		t.Fatal(err)
	}
	finishFixture(t, first)
	result, err := first.Result(ctx)
	if err != nil || !result.Complete || result.Acknowledged || result.Text != "stored lifecycle answer:turn" {
		t.Fatal("first retained result unavailable", err)
	}
	stored := memory.entries[input.Binding.OperationID]
	if string(stored.payload) != result.Text || stored.receipt.Binding != input.Binding || stored.receipt.Result.ID != result.ResultID || stored.receipt.Bytes != len(result.Text) {
		t.Fatal("real bytes missing behind delivery receipt")
	}
	if err := first.Acknowledge(ctx, "wrong-result"); err == nil {
		t.Fatal("wrong client ACK accepted")
	}
	afterWrongACK, err := first.Result(ctx)
	if err != nil || afterWrongACK.Acknowledged {
		t.Fatal("wrong ACK changed state", err)
	}
	nextInput := input
	nextInput.Binding.OperationID = "next-operation"
	nextInput.Binding.TurnID = "next-turn"
	nextInput.Binding.TurnGeneration++
	if _, err := service.FollowConversation(ctx, first, nextInput); err == nil {
		t.Fatal("slot reused before ACK/settlement")
	}
	if err := first.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
	if len(memory.entries) != 1 || string(memory.entries[input.Binding.OperationID].payload) != result.Text {
		t.Fatal("ACK evicted delivery bytes")
	}
	if _, err := service.FollowConversation(ctx, first, nextInput); err == nil {
		t.Fatal("ACK fabricated quiescence")
	}
	if err := first.Observe(ctx, deadline); err != nil {
		t.Fatal(err)
	}
	next, err := service.FollowConversation(ctx, first, nextInput)
	if err != nil {
		t.Fatal(err)
	}
	nextBinding, err := service.PrepareNext(ctx, deadline)
	if err != nil || nextBinding.ConversationID != firstBinding.ConversationID || nextBinding.Lease.SlotGeneration != firstBinding.Lease.SlotGeneration+1 {
		t.Fatal("follow-up binding/reuse differs", err)
	}
	finishFixture(t, next)
	nextResult, err := next.Result(ctx)
	if err != nil || !nextResult.Complete || nextResult.Text != "stored lifecycle answer:next-turn" || len(memory.entries) != 2 {
		t.Fatal("follow-up delivery missing", err)
	}
	if string(memory.entries[input.Binding.OperationID].payload) != result.Text || string(memory.entries[nextInput.Binding.OperationID].payload) != nextResult.Text {
		t.Fatal("slot reuse changed historical bytes")
	}
	before := len(exchange.calls)
	replay, err := service.CreateConversation(ctx, input)
	if err != nil || replay != first {
		t.Fatal("known same-ID replay not original owner", err)
	}
	read, err := replay.Result(ctx)
	if err != nil || !read.Acknowledged || read.Text != result.Text || len(exchange.calls) != before {
		t.Fatal("reconnect/read repeated browser operation", err)
	}
	activity, err := json.Marshal(journal.writes)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(activity), input.Prompt) || strings.Contains(string(activity), "stored lifecycle answer") {
		t.Fatal("private bytes persisted in journal/Activity")
	}
	sends := 0
	for _, command := range exchange.calls {
		if send, ok := command.(browser.SendCommand); ok {
			sends++
			if sends == 2 && (send.Verification.PreviousUserTurnID != "user-turn" || send.Verification.PreviousReplyID != "reply-turn") {
				t.Fatal("logical lineage lost")
			}
		}
	}
	if sends != 2 {
		t.Fatal("extra physical Send intent", sends)
	}
}
func TestRetentionCapacityDoesNotPublishFalseCompletedResultOrResend(t *testing.T) {
	service, memory, exchange, _, input := serviceFixture(t, Limits{Results: 1, ResultBytes: MaxResultBytes, TotalBytes: MaxResultBytes})
	old := requestFixture()
	old.Binding.OperationID = "occupied-operation"
	old.Binding.TurnID = "occupied-turn"
	if _, err := memory.Retain(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	c, err := service.CreateConversation(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.PrepareNext(ctx, deadline); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, deadline); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err := c.Observe(ctx, deadline); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Observe(ctx, deadline); !errors.Is(err, lifecycle.Unsettled) {
		t.Fatal("storage failure became known result", err)
	}
	if result, err := c.Result(ctx); result != nil || !errors.Is(err, lifecycle.Unsettled) {
		t.Fatal("false completed delivery", err)
	}
	before := len(exchange.calls)
	if err := c.Send(ctx, deadline); err == nil {
		t.Fatal("Send repeated after retention failure")
	}
	if len(exchange.calls) != before || len(memory.entries) != 1 || string(memory.entries[old.Binding.OperationID].payload) != string(old.Payload) {
		t.Fatal("failed result retried or evicted old bytes")
	}
}
