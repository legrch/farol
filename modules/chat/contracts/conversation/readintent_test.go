package conversation_test

import (
	"context"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
)

func TestReadIntentFacadeCapturesCurrentThroughPromotionAndFollow(t *testing.T) {
	f, b, i := fixture(t)
	ctx := context.Background()
	r, err := f.AdmitReadIntent(ctx, i.Binding, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	current, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	again, err := r.Current()
	if err != nil || again != current {
		t.Fatal("Current was reconstructed", err)
	}
	inspect := func(got *admission.TaskBinding) error {
		want := admission.TaskBinding{OwnerID: i.Binding.OwnerID, SessionID: i.Binding.SessionID, TaskID: i.Binding.TaskID, TaskEpoch: i.Binding.TaskEpoch, ParticipantID: i.Binding.ParticipantID, TurnID: i.Binding.TurnID}
		if got == nil || *got != want {
			t.Fatal("captured binding changed", got)
		}
		return nil
	}
	if err := current.WithCurrent(ctx, inspect); err != nil {
		t.Fatal(err)
	}
	h, err := f.PromoteReadIntent(ctx, r, i)
	if err != nil {
		t.Fatal(err)
	}
	if err := current.WithCurrent(ctx, inspect); err != nil {
		t.Fatal(err)
	}
	if _, err := f.PromoteReadIntent(ctx, r, i); err != nil || b.sends != 0 {
		t.Fatal("duplicate promotion", err)
	}
	prepared, err := f.PrepareNext(ctx, 100)
	if err != nil || prepared.Binding != i.Binding {
		t.Fatal(prepared, err)
	}
	if err := h.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 3; n++ {
		if err := h.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
	}
	result, err := h.Result(ctx)
	if err != nil || !result.Complete || result.Binding != i.Binding || result.Text != "<answer>\nline two" {
		t.Fatal(result, err)
	}
	if err := current.WithCurrent(ctx, func(got *admission.TaskBinding) error {
		if got != nil {
			t.Fatal("terminal result still grants admission")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
	if err := h.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	next := i
	next.Binding.OperationID, next.Binding.TurnID = "next-operation", "next-turn"
	next.Binding.TurnGeneration++
	next.Prompt = "fixture follow-up"
	if follow, err := f.Follow(ctx, h, next); err != nil || follow == nil {
		t.Fatal("promoted handle lost facade for Follow", err)
	}
	if b.sends != 1 {
		t.Fatal("read/replay/follow redispatched")
	}
}

func TestReadIntentFacadeWithdrawalClosesCapturedCurrent(t *testing.T) {
	f, b, i := fixture(t)
	r, err := f.AdmitReadIntent(context.Background(), i.Binding, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	current, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err := f.WithdrawReadIntent(context.Background(), r); err != nil {
			t.Fatal(err)
		}
	}
	if err := current.WithCurrent(context.Background(), func(got *admission.TaskBinding) error {
		if got != nil {
			t.Fatal("withdrawn read still current")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if h, err := f.PromoteReadIntent(context.Background(), r, i); h != nil || err == nil || b.sends != 0 {
		t.Fatal("withdrawn admission promoted", err)
	}
}

func TestReadIntentFacadeRejectsOpaqueZeroForeignAndCrossedInput(t *testing.T) {
	f, b, i := fixture(t)
	r, err := f.AdmitReadIntent(context.Background(), i.Binding, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	other, _, _ := fixture(t)
	for _, opaque := range []*conversation.ReadIntent{nil, {}, r} {
		owner := f
		if opaque == r {
			owner = other
		}
		if h, err := owner.PromoteReadIntent(context.Background(), opaque, i); h != nil || err == nil {
			t.Fatal("foreign/zero intent promoted", err)
		}
		if err := owner.WithdrawReadIntent(context.Background(), opaque); err == nil {
			t.Fatal("foreign/zero intent withdrawn")
		}
	}
	var zero conversation.ReadIntent
	if c, err := zero.Current(); c != nil || err == nil {
		t.Fatal("zero Current", err)
	}
	crossed := i
	crossed.Binding.TaskEpoch++
	if h, err := f.PromoteReadIntent(context.Background(), r, crossed); h != nil || err == nil {
		t.Fatal("crossed binding promoted", err)
	}
	if _, err := f.PromoteReadIntent(context.Background(), r, i); err != nil {
		t.Fatal(err)
	}
	crossed = i
	crossed.Prompt += " changed"
	if h, err := f.PromoteReadIntent(context.Background(), r, crossed); h != nil || err == nil {
		t.Fatal("new prompt accepted", err)
	}
	if err := f.WithdrawReadIntent(context.Background(), r); err == nil || b.sends != 0 {
		t.Fatal("promoted handle withdrawn", err)
	}
}
