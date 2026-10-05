package conversation_test

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// Source-only facade witnesses reuse the pure contract doubles. No native,
// filesystem, browser, provider, wire/UI or package behavior is claimed.
type followStateJournal struct {
	journal
	loseRelease bool
}

func (j *followStateJournal) Commit(ctx context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	receipt, err := j.journal.Commit(ctx, w)
	if j.loseRelease && w.Entry.Kind == "release" {
		return nil, nil
	}
	return receipt, err
}

func followStateFacade(t *testing.T) (*conversation.Facade, *browser, *followStateJournal, *results, conversation.Input) {
	t.Helper()
	b, j, retained := &browser{}, &followStateJournal{}, &results{}
	s, err := lifecycle.New(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}, lifecycle.Dependencies{Gate: gate.New(), Journal: j, Browser: b, Results: retained, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	i := conversation.Input{Required: conversation.RequiredControls{Model: true, Effort: true}, Binding: conversation.Binding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 31, ParticipantID: "participant", TurnID: "turn", OperationID: "operation", TurnGeneration: 2}, Selection: conversation.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "cheap", Effort: "low"}, Prompt: "fixture input"}
	return conversation.New(s), b, j, retained, i
}

func TestFacadeFollowStateMapsReadinessWithoutWritesOrSend(t *testing.T) {
	for _, ackFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "ack-first", false: "settlement-first"}[ackFirst], func(t *testing.T) {
			f, b, j, retained, i := followStateFacade(t)
			ctx := context.Background()
			h, err := f.Create(ctx, i)
			if err != nil {
				t.Fatal(err)
			}
			read := func(handle *conversation.Handle, want [5]bool) conversation.State {
				t.Helper()
				revision, sends, verifies, text := j.revision, b.sends, b.verifies, retained.text
				var state conversation.State
				if err := handle.WithState(ctx, func(s conversation.State) error { state = s; return nil }); err != nil {
					t.Fatal(err)
				}
				got := [5]bool{state.HasResult, state.DeliveryAcknowledged, state.LifecycleSettled, state.Released, state.FollowReady}
				if got != want || state.Requested != i.Selection {
					t.Fatalf("state=%+v flags=%v want=%v", state, got, want)
				}
				if j.revision != revision || b.sends != sends || b.verifies != verifies || retained.text != text {
					t.Fatal("WithState wrote, sent or changed retained result")
				}
				return state
			}
			if read(h, [5]bool{}).Prepared {
				t.Fatal("queued handle prepared")
			}
			if _, err := f.PrepareNext(ctx, 100); err != nil {
				t.Fatal(err)
			}
			if !read(h, [5]bool{}).Prepared {
				t.Fatal("prepared handle lost existing state")
			}
			if err := h.Send(ctx, 100); err != nil {
				t.Fatal(err)
			}
			read(h, [5]bool{})
			for n := 0; n < 3; n++ {
				if err := h.Observe(ctx, 100); err != nil {
					t.Fatal(err)
				}
				read(h, [5]bool{n == 2, false, false, false, false})
			}
			result, err := h.Result(ctx)
			if err != nil || !result.Complete || result.Text != "<answer>\nline two" {
				t.Fatal(result, err)
			}
			ack := func() {
				if err := h.Acknowledge(ctx, result.ResultID); err != nil {
					t.Fatal(err)
				}
			}
			settle := func() {
				if err := h.Observe(ctx, 100); err != nil {
					t.Fatal(err)
				}
			}
			if ackFirst {
				ack()
				read(h, [5]bool{true, true, false, false, false})
				settle()
			} else {
				settle()
				read(h, [5]bool{true, false, true, false, false})
				ack()
			}
			state := read(h, [5]bool{true, true, true, true, true})
			if state.Prepared || state.Binding != i.Binding || state.ConversationID != result.ConversationID {
				t.Fatal("existing public state mapping changed", state)
			}
			nextInput := i
			nextInput.Binding.OperationID, nextInput.Binding.TurnID = "next-operation", "next-turn"
			nextInput.Binding.TurnGeneration++
			nextInput.Prompt = "fixture follow-up"
			next, err := f.Follow(ctx, h, nextInput)
			if err != nil {
				t.Fatal(err)
			}
			read(h, [5]bool{true, true, true, true, false})
			read(next, [5]bool{})
			revision := j.revision
			if _, err := f.Follow(ctx, h, nextInput); err != nil || j.revision != revision || b.sends != 1 {
				t.Fatal("exact successor replay changed", err)
			}
			after, err := h.Result(ctx)
			result.Acknowledged, result.Phase = true, "delivered"
			if err != nil || *after != *result || retained.text != result.Text {
				t.Fatal("retained result changed", after, err)
			}
			sentinel := errors.New("consumer inspection failure")
			if err := h.WithState(ctx, func(conversation.State) error { return sentinel }); err != sentinel {
				t.Fatal("consumer error was reclassified", err)
			}
		})
	}
}

func TestFacadeFollowStateUnknownReleaseDoesNotPublish(t *testing.T) {
	f, b, j, retained, i := followStateFacade(t)
	ctx := context.Background()
	h, err := f.Create(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 4; n++ {
		if err := h.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
	}
	j.loseRelease = true
	var failure *conversation.Failure
	if err := h.Acknowledge(ctx, i.Binding.OperationID); !errors.As(err, &failure) || failure.Code != string(lifecycle.Unsettled) {
		t.Fatal("unknown release was accepted", err)
	}
	revision, sends, text := j.revision, b.sends, retained.text
	called := false
	err = h.WithState(ctx, func(conversation.State) error { called = true; return nil })
	if !errors.As(err, &failure) || failure.Code != string(lifecycle.Unsettled) || failure.Retry != "never" || called {
		t.Fatal("unknown owner published readiness", err)
	}
	if j.revision != revision || b.sends != sends || retained.text != text {
		t.Fatal("unknown state read retried or changed retention")
	}
}
