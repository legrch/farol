package conversation_test

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/contracts/conversation"
)

func requireSubmission(t *testing.T, h *conversation.Handle, want conversation.SubmissionState) {
	t.Helper()
	got, err := h.SubmissionState(context.Background())
	if err != nil || got != want {
		t.Fatalf("submission=%s err=%v want=%s", got, err, want)
	}
}

func TestSubmissionContractMapsQueuedPreparedAndCommittedIntent(t *testing.T) {
	f, b, input := fixture(t)
	ctx := context.Background()
	h, err := f.Create(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	requireSubmission(t, h, conversation.SubmissionNotDispatched)
	if _, err := f.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	requireSubmission(t, h, conversation.SubmissionNotDispatched)
	if b.sends != 0 || b.verifies != 0 {
		t.Fatal("snapshot dispatched")
	}
	// Same handle is still live; not-dispatched is NOT a release/withdrawal grant.
	if err := h.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	requireSubmission(t, h, conversation.SubmissionIntentCommitted)
	for n := 0; n < 3; n++ {
		if err := h.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
	}
	requireSubmission(t, h, conversation.SubmissionIntentCommitted)
	r, err := h.Result(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Acknowledge(ctx, r.ResultID); err != nil {
		t.Fatal(err)
	}
	requireSubmission(t, h, conversation.SubmissionIntentCommitted)
	if b.sends != 1 || b.verifies != 1 {
		t.Fatal("snapshot repeated effects")
	}
}

func TestSubmissionContractCancellationDoesNotInventNoSend(t *testing.T) {
	for _, afterSend := range []bool{false, true} {
		name := "before-send"
		if afterSend {
			name = "after-send"
		}
		t.Run(name, func(t *testing.T) {
			f, b, input := fixture(t)
			ctx := context.Background()
			h, err := f.Create(ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			want := conversation.SubmissionNotDispatched
			if afterSend {
				if _, err := f.PrepareNext(ctx, 100); err != nil {
					t.Fatal(err)
				}
				if err := h.Send(ctx, 100); err != nil {
					t.Fatal(err)
				}
				want = conversation.SubmissionUnknown
			}
			if err := h.Cancel(ctx); err != nil {
				t.Fatal(err)
			}
			requireSubmission(t, h, want)
			sends := b.sends
			if err := h.Send(ctx, 100); err == nil {
				t.Fatal("cancelled owner sent")
			}
			if b.sends != sends {
				t.Fatal("read enabled Send")
			}
		})
	}
}

func TestSubmissionContractUnknownAndFailureAreNeverReleaseAuthority(t *testing.T) {
	for _, kind := range []string{"nil", "forged", "nil-context", "cancelled-context"} {
		t.Run(kind, func(t *testing.T) {
			f, _, input := fixture(t)
			h, err := f.Create(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			switch kind {
			case "nil":
				h = nil
			case "forged":
				h = &conversation.Handle{}
			case "nil-context":
				ctx = nil
			case "cancelled-context":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			}
			state, err := h.SubmissionState(ctx)
			var failed *conversation.Failure
			if state != conversation.SubmissionUnknown || !errors.As(err, &failed) || failed.Source != "chat-conversation" || failed.Retry != "never" {
				t.Fatal("invalid facade mapped to release/retry authority")
			}
		})
	}
}
