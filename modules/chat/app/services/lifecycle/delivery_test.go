package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/stream"
)

// Actual Go owner and bounded stream with injected ports. Issuing bytes is not
// a socket write, native effect, consumer receipt or provider acceptance witness.
func deliveryCall(t *testing.T) (*Service, *Conversation, *conversationBrowser, *journalFixture, port.BeginCallerToolRequest, *CallerToolCall) {
	t.Helper()
	s, c, b, j, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	call := callerBegin(t, c, r)
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s, c, b, j, r, call
}
func originalDeliveryFrames(t *testing.T, c *Conversation, call *CallerToolCall) []stream.Frame {
	t.Helper()
	frames, err := c.handle.frames.Replay(streamScope(c.handle.fixed))
	if err != nil {
		t.Fatal(err)
	}
	var out []stream.Frame
	for _, f := range frames {
		if f.Sequence >= call.deliveryFirst && f.Sequence <= call.deliveryLast {
			out = append(out, f)
		}
	}
	return out
}

func TestDeliveryIssueExactCapturedGroupAndDetachedCopies(t *testing.T) {
	s, c, b, j, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	namespace := "functions"
	r.Call.Namespace = &namespace
	r.Call.Arguments = `{ "cmd": "héllo <&> 😀", "n": 1 }`
	call := callerBegin(t, c, r)
	// Both the caller's namespace pointer and returned DTO must be detached.
	namespace = "changed-after-begin"
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if call.deliveryFirst != 5 || call.deliveryLast != 12 {
		t.Fatal("original publication bounds wrong")
	}
	want := originalDeliveryFrames(t, c, call)
	// A later unrelated owner frame cannot join this selected original group.
	if _, err := c.handle.frames.Append(stream.Phase, []byte(`{"type":"fixture.status","sequence_number":13}`)); err != nil {
		t.Fatal(err)
	}
	before, writes := ownerReadProbe(t, c), j.count()
	journal, browser, results, digests := s.deps.Journal, s.deps.Browser, s.deps.Results, s.deps.IntentDigests
	s.deps.Journal = struct{ port.Journal }{}
	s.deps.Browser = struct{ port.VerifiedBrowser }{}
	s.deps.Results = struct{ port.ResultRetention }{}
	s.deps.IntentDigests = struct{ port.IntentDigester }{}
	group, err := call.IssueDelivery(context.Background())
	if err != nil || group == nil {
		t.Fatal(err)
	}
	s.deps.Journal, s.deps.Browser, s.deps.Results, s.deps.IntentDigests = journal, browser, results, digests
	assertOwnerReadUnchanged(t, c, before)
	if !call.deliveryIssued || j.count() != writes || len(b.sent) != 1 {
		t.Fatal("issue performed effect/ACK or failed to consume")
	}
	if group.Context != scope || group.Scope != r.Scope || group.ProducerOperationID != r.ProducerOperationID || group.Call.CallID != r.Call.CallID || group.FirstSequence != 5 || group.LastSequence != 12 || !reflect.DeepEqual(group.Frames, want) || *group.Call.Namespace != "functions" {
		t.Fatal("wrong original correlation or group")
	}
	names := []string{"response.output_text.done", "response.content_part.done", "response.output_item.done", "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"}
	for n, f := range group.Frames {
		body := callerFrame(t, f)
		if f.Sequence != uint64(n+5) || body["type"] != names[n] || body["sequence_number"] != float64(f.Sequence) || f.Kind != stream.Phase {
			t.Fatal("sequence/order/kind changed")
		}
	}
	added := callerFrame(t, group.Frames[3])["item"].(map[string]any)
	args := callerFrame(t, group.Frames[4])["delta"]
	done := callerFrame(t, group.Frames[5])["arguments"]
	last := callerFrame(t, group.Frames[7])["response"].(map[string]any)["output"].([]any)[1].(map[string]any)
	if added["namespace"] != "functions" || args != r.Call.Arguments || done != r.Call.Arguments || last["arguments"] != r.Call.Arguments || last["call_id"] != r.Call.CallID {
		t.Fatal("namespace/argument bytes changed")
	}
	group.Context.Browser.DocumentGeneration++
	group.Call.Arguments = "changed"
	*group.Call.Namespace = "changed"
	group.Frames[0].Data[0] = '!'
	group.Frames[1].Sequence = 999
	group.Frames = group.Frames[:1]
	if !reflect.DeepEqual(originalDeliveryFrames(t, c, call), want) || *call.request.Call.Namespace != "functions" || call.request.Context != scope {
		t.Fatal("DTO mutated retained original")
	}
	if again, err := call.IssueDelivery(context.Background()); err == nil || again != nil {
		t.Fatal("mutated DTO renewed issue")
	}
	if relayView(t, s, c).OutstandingCallID != r.ProducerOperationID {
		t.Fatal("issue acknowledged original")
	}
}

func TestDeliveryCheckThenWithdrawalIssuesNothing(t *testing.T) {
	for _, kind := range []string{"freeze", "cancel", "unknown", "awaiting-owner"} {
		t.Run(kind, func(t *testing.T) {
			s, c, b, j, _, call := deliveryCall(t)
			if err := call.CheckDispatch(context.Background()); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "freeze":
				if err := s.FreezeAdmissions(context.Background()); err != nil {
					t.Fatal(err)
				}
			case "cancel":
				if err := c.Cancel(context.Background()); err != nil {
					t.Fatal(err)
				}
			case "unknown":
				s.unknown = true
			case "awaiting-owner":
				if _, err := s.Apply(context.Background(), c.handle, Change{Action: AwaitOwner, Binding: relayView(t, s, c).Binding}); err != nil {
					t.Fatal(err)
				}
			}
			before, writes := ownerReadProbe(t, c), j.count()
			if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
				t.Fatal("withdrawn owner issued group")
			}
			assertOwnerReadUnchanged(t, c, before)
			if call.deliveryIssued || j.count() != writes || len(b.sent) != 1 {
				t.Fatal("refusal issued/effected")
			}
		})
	}
}

func TestDeliveryLostIssueReplyAndFreezeKeepOriginalSettlement(t *testing.T) {
	s, c, b, j, r, call := deliveryCall(t)
	if _, err := call.IssueDelivery(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Simulate discarded/lost issuance reply; source has no ACK or retry edge.
	if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
		t.Fatal("lost reply reissued")
	}
	if err := s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	before, writes := ownerReadProbe(t, c), j.count()
	if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
		t.Fatal("freeze reissued")
	}
	assertOwnerReadUnchanged(t, c, before)
	if j.count() != writes || relayView(t, s, c).OutstandingCallID != r.ProducerOperationID {
		t.Fatal("issuance/freeze settled original")
	}
	out, err := call.AcceptOutput(context.Background(), callerInput(r, `"actual original output"`))
	if err != nil {
		t.Fatal(err)
	}
	if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err != nil {
		t.Fatal(err)
	}
	if call.phase != callerReturned || relayView(t, s, c).OutstandingCallID != "" || len(b.sent) != 1 {
		t.Fatal("original settlement lost or reexecuted")
	}
}

func TestDeliveryAcceptedAndReturnedCallCannotIssue(t *testing.T) {
	for _, returned := range []bool{false, true} {
		name := "accepted"
		if returned {
			name = "returned"
		}
		t.Run(name, func(t *testing.T) {
			_, c, _, j, r, call := deliveryCall(t)
			out, err := call.AcceptOutput(context.Background(), callerInput(r, `"original output"`))
			if err != nil {
				t.Fatal(err)
			}
			if returned {
				if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err != nil {
					t.Fatal(err)
				}
			}
			before, writes := ownerReadProbe(t, c), j.count()
			if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
				t.Fatal("settled phase newly issued")
			}
			assertOwnerReadUnchanged(t, c, before)
			if call.deliveryIssued || j.count() != writes {
				t.Fatal("refusal issued/journaled")
			}
		})
	}
}

func TestDeliveryRejectsCrossedGenerationAndOwnerState(t *testing.T) {
	cases := map[string]func(*Service, *Conversation, *CallerToolCall){
		"turn": func(_ *Service, _ *Conversation, call *CallerToolCall) { call.request.Context.Binding.TurnGeneration++ },
		"backend": func(_ *Service, _ *Conversation, call *CallerToolCall) {
			call.request.Context.Binding.BackendGeneration = "other"
		},
		"document": func(_ *Service, _ *Conversation, call *CallerToolCall) {
			call.request.Context.Browser.DocumentGeneration++
		},
		"view": func(_ *Service, _ *Conversation, call *CallerToolCall) { call.request.Context.Browser.ViewGeneration++ },
		"slot": func(_ *Service, _ *Conversation, call *CallerToolCall) {
			call.request.Context.Browser.Lease.SlotGeneration++
		},
		"operation":     func(_ *Service, _ *Conversation, call *CallerToolCall) { call.request.ProducerOperationID = "other" },
		"user":          func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.output.UserID = "other" },
		"reply":         func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.output.ReplyID = "other" },
		"pending-owner": func(s *Service, _ *Conversation, _ *CallerToolCall) { s.pending = &mutation{} },
		"observing":     func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.observing = true },
		"revision":      func(s *Service, _ *Conversation, _ *CallerToolCall) { s.revision = math.MaxUint64 },
		"fence":         func(s *Service, _ *Conversation, _ *CallerToolCall) { s.fence = math.MaxUint64 },
		"registry":      func(s *Service, c *Conversation, _ *CallerToolCall) { delete(s.handles, c.handle.fixed.OperationID) },
		"replaced-call": func(_ *Service, c *Conversation, call *CallerToolCall) { clone := *call; c.handle.caller = &clone },
		"retired":       func(s *Service, _ *Conversation, _ *CallerToolCall) { s.retired = &retirementProof{} },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s, c, b, j, _, call := deliveryCall(t)
			change(s, c, call)
			before, writes := ownerReadProbe(t, c), j.count()
			if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
				t.Fatal("crossed owner issued")
			}
			assertOwnerReadUnchanged(t, c, before)
			if call.deliveryIssued || j.count() != writes || len(b.sent) != 1 {
				t.Fatal("crossed owner effected")
			}
		})
	}
}

func TestDeliveryRejectsUnclaimedForgedAndCancelledContext(t *testing.T) {
	for _, kind := range []string{"unclaimed", "nil", "forged", "copied-token", "nil-context", "cancelled-context"} {
		t.Run(kind, func(t *testing.T) {
			s, c, _, j, _, scope := relayRunning(t)
			call := callerBegin(t, c, callerRequest(t, s, scope))
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
				call = &CallerToolCall{}
			case "copied-token":
				clone := *call
				call = &clone
			case "nil-context":
				ctx = nil
			case "cancelled-context":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			}
			before, writes := ownerReadProbe(t, c), j.count()
			if group, err := call.IssueDelivery(ctx); err == nil || group != nil {
				t.Fatal("invalid original issued")
			}
			assertOwnerReadUnchanged(t, c, before)
			if c.handle.caller.deliveryIssued || j.count() != writes {
				t.Fatal("refusal issued")
			}
		})
	}
}

func TestDeliveryWaitsForOwnerGateThenSeesCancelledContext(t *testing.T) {
	s, c, _, _, _, call := deliveryCall(t)
	ctx, cancel := context.WithCancel(context.Background())
	s.deps.Gate.Lock()
	started, done := make(chan struct{}), make(chan error, 1)
	go func() { close(started); _, err := call.IssueDelivery(ctx); done <- err }()
	<-started
	cancel()
	s.deps.Gate.Unlock()
	if !errors.Is(<-done, Cancelled) || call.deliveryIssued {
		t.Fatal("context withdrawal while gate unavailable issued")
	}
	if len(originalDeliveryFrames(t, c, call)) != 8 {
		t.Fatal("cancelled context changed retained original")
	}
}

func TestDeliveryUnavailableGapAndOverflowConsumeWithoutReconstruction(t *testing.T) {
	for _, kind := range []string{"unavailable", "empty", "first-evicted", "middle-evicted", "last-evicted", "overflow"} {
		t.Run(kind, func(t *testing.T) {
			_, c, _, j, _, call := deliveryCall(t)
			switch kind {
			case "unavailable":
				c.handle.frames = nil
			case "empty":
				buffer, err := stream.New(streamScope(c.handle.fixed), stream.DefaultLimits())
				if err != nil {
					t.Fatal(err)
				}
				c.handle.frames = buffer
			case "first-evicted", "middle-evicted", "last-evicted":
				all, err := c.handle.frames.Replay(streamScope(c.handle.fixed))
				if err != nil {
					t.Fatal(err)
				}
				limits := stream.DefaultLimits()
				limits.Frames = 12
				buffer, err := stream.New(streamScope(c.handle.fixed), limits)
				if err != nil {
					t.Fatal(err)
				}
				for _, frame := range all {
					if _, err := buffer.Append(frame.Kind, frame.Data); err != nil {
						t.Fatal(err)
					}
				}
				sequence := uint64(5)
				if kind == "middle-evicted" {
					sequence = 6
				}
				if kind == "last-evicted" {
					sequence = 12
				}
				if _, err := buffer.Acknowledge(streamScope(c.handle.fixed), sequence); err != nil {
					t.Fatal(err)
				}
				if _, err := buffer.Append(stream.Phase, []byte(`{"type":"fixture.status","sequence_number":13}`)); err != nil {
					t.Fatal(err)
				}
				c.handle.frames = buffer
			case "overflow":
				for n := 0; n < stream.DefaultLimits().Frames; n++ {
					_, err := c.handle.frames.Append(stream.Phase, []byte(`{}`))
					if err == stream.Overflow {
						break
					}
					if err != nil {
						t.Fatal(err)
					}
				}
				if !c.handle.frames.Snapshot().Failed {
					t.Fatal("overflow fixture did not fail")
				}
			}
			writes := j.count()
			if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
				t.Fatal("incomplete/overflow group issued")
			}
			if !call.deliveryIssued || j.count() != writes {
				t.Fatal("failed capture was not consumed or journaled")
			}
			if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
				t.Fatal("failed capture retried/reconstructed")
			}
		})
	}
}

func TestDeliveryOriginalFrameACKDoesNotIssueOrResolve(t *testing.T) {
	s, c, _, _, r, call := deliveryCall(t)
	for _, frame := range originalDeliveryFrames(t, c, call) {
		if _, err := c.AcknowledgeFrame(context.Background(), frame.Sequence); err != nil {
			t.Fatal(err)
		}
	}
	if call.deliveryIssued || relayView(t, s, c).OutstandingCallID != r.ProducerOperationID {
		t.Fatal("frame ACK minted issuance/Resolve")
	}
	group, err := call.IssueDelivery(context.Background())
	if err != nil || len(group.Frames) != 8 {
		t.Fatal("original retained group unavailable")
	}
	if relayView(t, s, c).OutstandingCallID != r.ProducerOperationID {
		t.Fatal("issue acknowledged result")
	}
}

// Keep the JSON import tied to actual exact bytes rather than encoded summaries.
func TestDeliveryGroupCarriesOriginalJSONSequence(t *testing.T) {
	_, _, _, _, _, call := deliveryCall(t)
	group, err := call.IssueDelivery(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range group.Frames {
		var value struct {
			Sequence uint64 `json:"sequence_number"`
		}
		if json.Unmarshal(frame.Data, &value) != nil || value.Sequence != frame.Sequence {
			t.Fatal("JSON sequence crossed")
		}
	}
}
