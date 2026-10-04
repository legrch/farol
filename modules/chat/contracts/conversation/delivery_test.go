package conversation_test

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/infra/responses"
)

// CPU-only published facade. Encoding these bytes is not an executable transport
// write, parsed-peer receipt or provider/native/browser acceptance.
func TestDeliveryContractExactOriginalGroupAndDeepCopies(t *testing.T) {
	h, b, j, _, scope := runningRelayHandle(t)
	ctx := context.Background()
	r := callerContractRequest(scope)
	namespace := "functions"
	r.Call.Namespace = &namespace
	r.Call.Arguments = `{ "cmd": "héllo <&> 😀" }`
	call, err := h.BeginCallerTool(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	if err := call.ClaimDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	frames, err := h.Events(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := frames[4:12]
	revision := j.revision
	group, err := call.IssueDelivery(ctx)
	if err != nil || group == nil {
		t.Fatal(err)
	}
	if group.Context != scope || group.Scope != r.Scope || group.ProducerOperationID != r.ProducerOperationID || group.Call.CallID != r.Call.CallID || group.FirstSequence != 5 || group.LastSequence != 12 || !reflect.DeepEqual(group.Frames, want) {
		t.Fatal("facade lost original correlation/range/bytes")
	}
	var encoded bytes.Buffer
	for _, frame := range group.Frames {
		wire, err := responses.Encode(frame)
		if err != nil {
			t.Fatal(err)
		}
		encoded.Write(wire)
	}
	if !bytes.Contains(encoded.Bytes(), []byte(`"namespace":"functions"`)) || !bytes.Contains(encoded.Bytes(), []byte("response.function_call_arguments.done")) || len(group.Frames) != 8 {
		t.Fatal("original namespace/group lost")
	}
	group.Context.Physical.ViewGeneration++
	group.Scope.Model = "other"
	*group.Call.Namespace = "other"
	group.Call.Arguments = "other"
	group.Frames[0].JSON[0] = '!'
	group.Frames[1].Sequence = 999
	retained, err := h.Events(ctx, 0)
	if err != nil || !reflect.DeepEqual(retained, frames) {
		t.Fatal("consumer mutated retained source")
	}
	if j.revision != revision || b.sends != 1 {
		t.Fatal("issue effected/ACKed")
	}
	if again, err := call.IssueDelivery(ctx); err == nil || again != nil {
		t.Fatal("DTO mutation renewed issuance")
	}
}

func TestDeliveryContractConcurrentAndLostReplyCannotReissue(t *testing.T) {
	h, b, j, _, scope := runningRelayHandle(t)
	ctx := context.Background()
	call, err := h.BeginCallerTool(ctx, callerContractRequest(scope))
	if err != nil {
		t.Fatal(err)
	}
	if err := call.ClaimDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	done := make(chan bool, 12)
	var workers sync.WaitGroup
	for n := 0; n < 12; n++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			group, err := call.IssueDelivery(ctx)
			done <- (err == nil && group != nil)
		}()
	}
	before := j.revision
	close(start)
	workers.Wait()
	close(done)
	wins := 0
	for known := range done {
		if known {
			wins++
		}
	}
	if wins != 1 {
		t.Fatal("concurrent facade issued twice")
	}
	if err := call.CheckDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	// Discarded DTO models a lost outer reply, never a second issuance grant.
	if group, err := call.IssueDelivery(ctx); err == nil || group != nil {
		t.Fatal("lost reply/snapshot replayed")
	}
	if j.revision != before || b.sends != 1 {
		t.Fatal("issue/snapshot performed effect")
	}
}

func TestDeliveryContractRejectsCancelledForgedAndUnclaimed(t *testing.T) {
	for _, kind := range []string{"nil", "forged", "unclaimed", "nil-context", "context-cancel", "owner-cancel"} {
		t.Run(kind, func(t *testing.T) {
			h, b, j, _, scope := runningRelayHandle(t)
			call, err := h.BeginCallerTool(context.Background(), callerContractRequest(scope))
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			if kind != "unclaimed" {
				if err := call.ClaimDispatch(ctx); err != nil {
					t.Fatal(err)
				}
			}
			switch kind {
			case "nil":
				call = nil
			case "forged":
				call = &conversation.CallerToolCall{}
			case "nil-context":
				ctx = nil
			case "context-cancel":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "owner-cancel":
				if err := h.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
			}
			before := j.revision
			group, err := call.IssueDelivery(ctx)
			var failure *conversation.Failure
			if group != nil || !errors.As(err, &failure) || failure.Source != "chat-conversation" || failure.Retry != "never" {
				t.Fatal("invalid original issued/retryable")
			}
			if j.revision != before || b.sends != 1 {
				t.Fatal("refusal performed effect")
			}
		})
	}
}
