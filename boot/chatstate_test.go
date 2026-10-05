package boot

import (
	"context"
	"encoding/json"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
	"testing"
)

func readChatStateFixture(t *testing.T, s *ChatIngress, h wire.ChatHandle) wire.ChatState {
	t.Helper()
	raw, _ := json.Marshal(wire.ChatHandleRequest{HandleId: h.HandleId})
	out, err := s.Methods()["chat.conversation.state"].Handle(context.Background(), desktop.Request{RequestID: "state-read", Body: raw})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("ChatState", out.Data) != nil {
		t.Fatal(out, err)
	}
	var result wire.ChatState
	if err = json.Unmarshal(out.Data, &result); err != nil {
		t.Fatal(err)
	}
	if result.Handle != h {
		t.Fatal("state selected another handle", result)
	}
	return result
}
func TestChatStateProjectsReleasedOriginalAndLatestSuccessor(t *testing.T) {
	f, s, a := readIntentFixture(t)
	ctx := context.Background()
	promote := readIntentPromotion(a)
	h, err := s.promoteRead(ctx, "promote", promote)
	if err != nil {
		t.Fatal(err)
	}
	initial := readChatStateFixture(t, f.ingress, *h)
	if initial.HasResult || initial.FollowReady || initial.Released || initial.DeliveryAcknowledged || initial.LifecycleSettled {
		t.Fatal(initial)
	}
	if _, err = f.ingress.facade.PrepareNext(ctx, 10000); err != nil {
		t.Fatal(err)
	}
	owned, err := f.ingress.get(h.HandleId)
	if err != nil {
		t.Fatal(err)
	}
	if err = owned.send(ctx, 10000); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err = owned.handle.Observe(ctx, 10000); err != nil {
			t.Fatal(err)
		}
	}
	if readChatStateFixture(t, f.ingress, *h).HasResult {
		t.Fatal("delta mistaken for terminal result")
	}
	result := f.finish(t, owned)
	writes, sends := len(f.journal.entries), f.physical.sends
	for n := 0; n < 3; n++ {
		observed := readChatStateFixture(t, f.ingress, *h)
		if !observed.HasResult || !observed.DeliveryAcknowledged || !observed.LifecycleSettled || !observed.Released || !observed.FollowReady || observed.ConversationId != result.ConversationID {
			t.Fatal(observed)
		}
	}
	if len(f.journal.entries) != writes || f.physical.sends != sends {
		t.Fatal("state read had effects")
	}
	next := chatComputerInput(false)
	next.Selection, next.Resolution = promote.Selection, promote.Resolution
	next.PreviousHandle = &h.HandleId
	successor, err := f.ingress.create(ctx, "follow", next)
	if err != nil {
		t.Fatal(err)
	}
	old := readChatStateFixture(t, f.ingress, *h)
	latest := readChatStateFixture(t, f.ingress, *successor)
	if old.FollowReady || !old.Released || latest.HasResult || latest.FollowReady || successor.Binding.TaskId != h.Binding.TaskId {
		t.Fatal(old, latest)
	}
}
func TestChatStateRefusesAnEffectEnvelopeOrUnknownHandle(t *testing.T) {
	f, s, a := readIntentFixture(t)
	h, err := s.promoteRead(context.Background(), "promote", readIntentPromotion(a))
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"effect", "handle"} {
		request := desktop.Request{RequestID: "read"}
		in := wire.ChatHandleRequest{HandleId: h.HandleId}
		if variant == "effect" {
			request.OperationID = "unwanted-effect"
		} else {
			in.HandleId = "unowned"
		}
		request.Body, _ = json.Marshal(in)
		before := len(f.journal.entries)
		out, err := f.ingress.Methods()["chat.conversation.state"].Handle(context.Background(), request)
		if err == nil && (out == nil || out.Status == "ok") {
			t.Fatal("invalid state request accepted", out, err)
		}
		if len(f.journal.entries) != before || f.physical.sends != 0 {
			t.Fatal("invalid state request mutated")
		}
	}
}
