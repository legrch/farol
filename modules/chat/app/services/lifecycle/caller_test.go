package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/stream"
)

// Actual Chat owner/journal/stream; all effect/browser/storage ports controlled.
// This is CPU source evidence, not native execution or live Responses acceptance.
func callerRequest(t *testing.T, s *Service, scope port.ComputerContext) port.BeginCallerToolRequest {
	t.Helper()
	external := port.CallerScope{SessionID: "host-session", ThreadID: "host-thread", TurnID: "host-turn", RootTurnID: "host-root", Model: "chatgpt"}
	raw, _ := json.Marshal(map[string]string{"sessionId": external.SessionID, "threadId": external.ThreadID, "turnId": external.TurnID, "rootTurnId": external.RootTurnID})
	hash, err := s.deps.IntentDigests.Digest(raw)
	if err != nil {
		t.Fatal(err)
	}
	return port.BeginCallerToolRequest{Context: scope, Scope: external, ProducerOperationID: "fixture-call", Call: port.CallerFunctionCall{ItemID: "fc-fixture", CallID: "farol_next_call_" + hash[:16] + "0123456789abcdef", Name: "exec_command", Arguments: `{"cmd":"fixture private command"}`}}
}
func callerInput(r port.BeginCallerToolRequest, raw string) port.AcceptCallerOutputRequest {
	return port.AcceptCallerOutputRequest{Context: r.Context, Scope: r.Scope, Calls: []port.CallerFunctionCall{cloneCallerFunction(r.Call)}, Outputs: []port.CallerFunctionOutput{{CallID: r.Call.CallID, Raw: []byte(raw)}}}
}
func callerAck(r port.BeginCallerToolRequest, o *port.CallerOutput) *port.CallerReturn {
	return &port.CallerReturn{Context: r.Context, ProducerOperationID: r.ProducerOperationID, CallID: r.Call.CallID, OutputSHA256: o.SHA256, OutputBytes: o.Bytes, Returned: true}
}
func callerBegin(t *testing.T, c *Conversation, r port.BeginCallerToolRequest) *CallerToolCall {
	t.Helper()
	call, err := c.BeginCallerTool(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	return call
}
func callerAccept(t *testing.T, call *CallerToolCall, r port.BeginCallerToolRequest) *port.CallerOutput {
	t.Helper()
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	o, err := call.AcceptOutput(context.Background(), callerInput(r, `"fixture private output"`))
	if err != nil {
		t.Fatal(err)
	}
	return o
}
func callerFrame(t *testing.T, f stream.Frame) map[string]any {
	t.Helper()
	var out map[string]any
	if json.Unmarshal(f.Data, &out) != nil {
		t.Fatal("invalid frame")
	}
	return out
}
func TestCallerOrderedRoundResultReceiptAndSameHandleContinuation(t *testing.T) {
	s, c, b, j, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	before := j.count()
	call := callerBegin(t, c, r)
	frames, err := c.Events(context.Background(), 0)
	if err != nil || len(frames) != 12 {
		t.Fatalf("frames=%d %v", len(frames), err)
	}
	want := []string{"response.created", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"}
	for n, f := range frames {
		v := callerFrame(t, f)
		if v["type"] != want[n] || f.Sequence != uint64(n+1) {
			t.Fatal("unordered round")
		}
	}
	terminal := callerFrame(t, frames[11])["response"].(map[string]any)
	items := terminal["output"].([]any)
	if len(items) != 2 || items[1].(map[string]any)["arguments"] != r.Call.Arguments || items[1].(map[string]any)["call_id"] != r.Call.CallID || frames[11].Kind == stream.Terminal || c.handle.frames.Snapshot().Terminal {
		t.Fatal("HTTP round closed Chat or lost correlation")
	}
	if j.count() != before+1 || j.writes[before].Entry.Kind != "request-computer" || relayView(t, s, c).OutstandingCallID != r.ProducerOperationID {
		t.Fatal("intent not durable")
	}
	if _, err := call.AcceptOutput(context.Background(), callerInput(r, `"too early"`)); err == nil {
		t.Fatal("output accepted before dispatch claim")
	}
	for _, f := range frames {
		if _, err := c.AcknowledgeFrame(context.Background(), f.Sequence); err != nil {
			t.Fatal(err)
		}
	}
	if relayView(t, s, c).OutstandingCallID == "" {
		t.Fatal("frame ACK resolved call")
	}
	out := callerAccept(t, call, r)
	if out.Output != "fixture private output" || out.Bytes != 22 || out.SHA256 == "" || relayView(t, s, c).OutstandingCallID == "" {
		t.Fatal("output or premature Resolve")
	}
	if _, err := call.AcceptOutput(context.Background(), callerInput(r, `"fixture private output"`)); err == nil {
		t.Fatal("output redelivered")
	}
	if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err != nil {
		t.Fatal(err)
	}
	if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err == nil {
		t.Fatal("duplicate return")
	}
	if call.output.Output != "" || relayView(t, s, c).OutstandingCallID != "" {
		t.Fatal("settlement or private output retention")
	}
	b.events = append(b.events[:2], port.BrowserObservation{Kind: port.AnswerDelta, UserTurnID: scope.UserTurnID, ReplyID: scope.ReplyID, SegmentID: "after-tool", Text: "continued"}, port.BrowserObservation{Kind: port.Completed, UserTurnID: scope.UserTurnID, ReplyID: scope.ReplyID}, port.BrowserObservation{Kind: port.Quiescent, UserTurnID: scope.UserTurnID, ReplyID: scope.ReplyID})
	observeOK(t, c)
	observeOK(t, c)
	result, err := c.Result(context.Background())
	if err != nil || !result.Complete || result.Text != "useful before tool; continued" || result.ProviderConversationID != scope.Browser.ConversationID || len(b.sent) != 1 {
		t.Fatalf("same conversation result %+v %v", result, err)
	}
	later, err := c.Events(context.Background(), 12)
	if err != nil || len(later) != 8 {
		t.Fatalf("later=%d %v", len(later), err)
	}
	next := callerFrame(t, later[0])["response"].(map[string]any)
	last := callerFrame(t, later[7])["response"].(map[string]any)
	if next["id"] == terminal["id"] || last["id"] != next["id"] || later[7].Kind != stream.Terminal {
		t.Fatal("round IDs/terminal")
	}
	message := last["output"].([]any)[0].(map[string]any)
	content := message["content"].([]any)[0].(map[string]any)
	if content["text"] != "continued" || message["id"] == scope.ReplyID {
		t.Fatal("duplicated prefix/item ID")
	}
	bytes, _ := json.Marshal(j.writes)
	for _, private := range []string{"fixture private command", "fixture private output", "useful before tool"} {
		if strings.Contains(string(bytes), private) {
			t.Fatal("private journal body")
		}
	}
	if err := c.Acknowledge(context.Background(), result.ResultID); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	if c.handle.releasedRevision == 0 || len(b.sent) != 1 {
		t.Fatal("reuse/duplicate Send")
	}
	if _, err := c.BeginCallerTool(context.Background(), r); err == nil {
		t.Fatal("second external round admitted")
	}
}
func TestCallerCrossedContinuationNeverChangesOriginal(t *testing.T) {
	changes := map[string]func(*port.AcceptCallerOutputRequest){
		"session": func(i *port.AcceptCallerOutputRequest) { i.Scope.SessionID = "other" }, "thread": func(i *port.AcceptCallerOutputRequest) { i.Scope.ThreadID = "other" }, "turn": func(i *port.AcceptCallerOutputRequest) { i.Scope.TurnID = "other" }, "root": func(i *port.AcceptCallerOutputRequest) { i.Scope.RootTurnID = "other" }, "model": func(i *port.AcceptCallerOutputRequest) { i.Scope.Model = "other" },
		"backend": func(i *port.AcceptCallerOutputRequest) { i.Context.Binding.BackendGeneration = "other" }, "generation": func(i *port.AcceptCallerOutputRequest) { i.Context.Binding.TurnGeneration++ }, "document": func(i *port.AcceptCallerOutputRequest) { i.Context.Browser.DocumentGeneration++ }, "watermark": func(i *port.AcceptCallerOutputRequest) { i.Context.SourceSequence++ },
		"arguments": func(i *port.AcceptCallerOutputRequest) { i.Calls[0].Arguments = `{ "cmd":"fixture private command"}` }, "name": func(i *port.AcceptCallerOutputRequest) { i.Calls[0].Name = "other" }, "namespace": func(i *port.AcceptCallerOutputRequest) { n := "functions"; i.Calls[0].Namespace = &n }, "item": func(i *port.AcceptCallerOutputRequest) { i.Calls[0].ItemID = "other" }, "call": func(i *port.AcceptCallerOutputRequest) { i.Calls[0].CallID = "other" }, "output-call": func(i *port.AcceptCallerOutputRequest) { i.Outputs[0].CallID = "other" }, "missing-call": func(i *port.AcceptCallerOutputRequest) { i.Calls = nil }, "missing-output": func(i *port.AcceptCallerOutputRequest) { i.Outputs = nil }, "duplicate-call": func(i *port.AcceptCallerOutputRequest) { i.Calls = append(i.Calls, i.Calls[0]) }, "duplicate-output": func(i *port.AcceptCallerOutputRequest) { i.Outputs = append(i.Outputs, i.Outputs[0]) },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			s, c, _, j, _, scope := relayRunning(t)
			r := callerRequest(t, s, scope)
			call := callerBegin(t, c, r)
			if err := call.ClaimDispatch(context.Background()); err != nil {
				t.Fatal(err)
			}
			before := j.count()
			bad := callerInput(r, `"exact"`)
			change(&bad)
			if out, err := call.AcceptOutput(context.Background(), bad); err == nil || out != nil {
				t.Fatal("crossed output accepted")
			}
			if j.count() != before || call.phase != callerPending {
				t.Fatal("crossed output settled")
			}
			if _, err := call.AcceptOutput(context.Background(), callerInput(r, `"exact"`)); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestCallerStringAndTypedTextBytes(t *testing.T) {
	cases := []struct {
		raw, want string
		ok        bool
	}{{`"héllo 😀"`, "héllo 😀", true}, {`[{"type":"input_text","text":"one"},{"type":"output_text","text":"два"},{"type":"text","text":"three"}]`, "one\nдва\nthree", true}, {`""`, "", true}, {`[]`, "", true}, {`"\ud83d\ude00"`, "😀", true}, {`"\\ud800"`, `\ud800`, true}, {`"\ud800"`, "", false}, {`"\udfff"`, "", false}, {`null`, "", false}, {`{}`, "", false}, {`[{"type":"image","text":"x"}]`, "", false}, {`[{"type":"text","text":3}]`, "", false}, {`"broken`, "", false}, {string([]byte{'"', 0xff, '"'}), "", false}, {`"` + strings.Repeat("x", CallerOutputBytesLimit+1) + `"`, "", false}}
	for n, tc := range cases {
		t.Run(string(rune('A'+n)), func(t *testing.T) {
			s, c, _, _, _, scope := relayRunning(t)
			r := callerRequest(t, s, scope)
			call := callerBegin(t, c, r)
			if err := call.ClaimDispatch(context.Background()); err != nil {
				t.Fatal(err)
			}
			out, err := call.AcceptOutput(context.Background(), callerInput(r, tc.raw))
			if !tc.ok {
				if err == nil || out != nil {
					t.Fatal("bad output accepted")
				}
				return
			}
			hash, _ := s.deps.IntentDigests.Digest([]byte(tc.want))
			if err != nil || out.Output != tc.want || out.Bytes != uint64(len(tc.want)) || out.SHA256 != hash {
				t.Fatalf("bytes %+v %v", out, err)
			}
		})
	}
}
func TestCallerLostReceiptAndResolveCannotDispatchAgain(t *testing.T) {
	for _, fault := range []string{"missing", "error", "nil", "revision", "scope", "entry"} {
		t.Run(fault, func(t *testing.T) {
			s, c, b, j, _, scope := relayRunning(t)
			r := callerRequest(t, s, scope)
			call := callerBegin(t, c, r)
			out := callerAccept(t, call, r)
			before := j.count()
			if fault == "missing" {
				if err := call.AcknowledgeReturn(context.Background(), nil); err == nil {
					t.Fatal("missing receipt resolved")
				}
			} else {
				j.fault = fault
				if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err == nil {
					t.Fatal("unknown Resolve accepted")
				}
				before = j.count()
				if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err == nil {
					t.Fatal("Resolve retried")
				}
			}
			if err := call.ClaimDispatch(context.Background()); err == nil {
				t.Fatal("dispatch repeated")
			}
			if _, err := c.BeginCallerTool(context.Background(), r); err == nil {
				t.Fatal("replacement call")
			}
			if err := c.Send(context.Background(), 100); err == nil {
				t.Fatal("Send repeated")
			}
			if j.count() != before || relayView(t, s, c).OutstandingCallID == "" || len(b.sent) != 1 || c.handle.releasedRevision != 0 {
				t.Fatal("lost ACK released work")
			}
		})
	}
}
func TestCallerBeginValidationAndInternalSeparation(t *testing.T) {
	for _, kind := range []string{"internal", "scope", "model", "item-collision", "tag", "args", "size", "namespace", "generation", "cancelled", "frozen"} {
		t.Run(kind, func(t *testing.T) {
			s, c, _, j, _, scope := relayRunning(t)
			r := callerRequest(t, s, scope)
			before := j.count()
			old, _ := c.Events(context.Background(), 0)
			switch kind {
			case "internal":
				if _, err := c.BeginComputer(context.Background(), scope, "internal-read"); err != nil {
					t.Fatal(err)
				}
				after, _ := c.Events(context.Background(), 0)
				if len(after) != len(old) || c.handle.caller != nil {
					t.Fatal("internal read emitted function call")
				}
				return
			case "scope":
				r.Scope.Model = ""
			case "item-collision":
				r.Call.ItemID = scope.ReplyID
			case "model":
				r.Scope.Model = "other-valid-model"
			case "tag":
				r.Call.CallID = "farol_next_call_" + strings.Repeat("a", 32)
			case "args":
				r.Call.Arguments = `[]`
			case "size":
				r.Call.Arguments = `{"x":"` + strings.Repeat("x", CallerArgumentBytesLimit) + `"}`
			case "namespace":
				n := ""
				r.Call.Namespace = &n
			case "generation":
				r.Context.Browser.ViewGeneration++
			case "cancelled":
				if err := c.Cancel(context.Background()); err != nil {
					t.Fatal(err)
				}
				before = j.count()
			case "frozen":
				if err := s.FreezeAdmissions(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			if call, err := c.BeginCallerTool(context.Background(), r); err == nil || call != nil || j.count() != before || c.handle.caller != nil {
				t.Fatal("bad begin wrote/published")
			}
		})
	}
}
func TestCallerCancellationDuringCommitPublishesNoExecutableGroup(t *testing.T) {
	s, c, _, j, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	entered, release := make(chan struct{}), make(chan struct{})
	j.hook = func(w port.JournalWrite) {
		if w.Entry.Kind == "request-computer" {
			close(entered)
			<-release
		}
	}
	done := make(chan error, 1)
	go func() {
		call, err := c.BeginCallerTool(context.Background(), r)
		if call != nil {
			done <- errors.New("late token")
			return
		}
		done <- err
	}()
	<-entered
	if err := c.Cancel(context.Background()); err == nil {
		t.Fatal("pending cancel falsely settled")
	}
	close(release)
	if err := <-done; err == nil {
		t.Fatal("late commit accepted")
	}
	if c.handle.caller != nil || c.handle.frames.Snapshot().LastSequence != 4 || !s.unknown {
		t.Fatal("executable group published")
	}
}
func TestCallerRetainedObservationAndClaimCloseBoundary(t *testing.T) {
	s, c, _, _, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	call := callerBegin(t, c, r)
	for n := 0; n < 2; n++ {
		frames, err := c.Events(context.Background(), 0)
		if err != nil || len(frames) != 12 {
			t.Fatal("retained observation")
		}
	}
	if call.dispatchClaimed {
		t.Fatal("reading frames granted execution")
	}
	if err := c.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := call.ClaimDispatch(context.Background()); err == nil {
		t.Fatal("closed dispatch claimed")
	}
	if _, err := call.AcceptOutput(context.Background(), callerInput(r, `"late"`)); err == nil {
		t.Fatal("closed output accepted")
	}
}
func TestCallerOverflowFailsBeforeIntentOrPartialPublication(t *testing.T) {
	s, c, _, j, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	s.deps.Gate.Lock()
	old, _ := c.handle.frames.Replay(streamScope(c.handle.fixed))
	limited, _ := stream.New(streamScope(c.handle.fixed), stream.Limits{Frames: 4, FrameBytes: 64 * 1024, Bytes: 256 * 1024})
	for _, f := range old {
		if _, err := limited.Append(f.Kind, f.Data); err != nil {
			t.Fatal(err)
		}
	}
	c.handle.frames = limited
	s.deps.Gate.Unlock()
	before := j.count()
	if call, err := c.BeginCallerTool(context.Background(), r); err == nil || call != nil {
		t.Fatal("overflow succeeded")
	}
	if j.count() != before || c.handle.frames.Snapshot().LastSequence != 4 || !s.unknown {
		t.Fatal("partial publication/durable work")
	}
}
func TestCallerConcurrentClaimAndOutputAreSingleUse(t *testing.T) {
	s, c, _, _, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	call := callerBegin(t, c, r)
	var g sync.WaitGroup
	ok := make(chan bool, 16)
	for n := 0; n < 16; n++ {
		g.Add(1)
		go func() { defer g.Done(); ok <- call.ClaimDispatch(context.Background()) == nil }()
	}
	g.Wait()
	close(ok)
	count := 0
	for v := range ok {
		if v {
			count++
		}
	}
	if count != 1 {
		t.Fatal("duplicate claim")
	}
	ok = make(chan bool, 16)
	for n := 0; n < 16; n++ {
		g.Add(1)
		go func() {
			defer g.Done()
			_, err := call.AcceptOutput(context.Background(), callerInput(r, `"one"`))
			ok <- err == nil
		}()
	}
	g.Wait()
	close(ok)
	count = 0
	for v := range ok {
		if v {
			count++
		}
	}
	if count != 1 {
		t.Fatal("duplicate output")
	}
}

func TestCallerReceiptAllFieldsAndPrematureAck(t *testing.T) {
	changes := map[string]func(*port.CallerReturn){"context": func(a *port.CallerReturn) { a.Context.Binding.TurnGeneration++ }, "producer": func(a *port.CallerReturn) { a.ProducerOperationID = "other" }, "call": func(a *port.CallerReturn) { a.CallID = "other" }, "digest": func(a *port.CallerReturn) { a.OutputSHA256 = strings.Repeat("0", 64) }, "bytes": func(a *port.CallerReturn) { a.OutputBytes++ }, "returned": func(a *port.CallerReturn) { a.Returned = false }}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			s, c, _, j, _, scope := relayRunning(t)
			r := callerRequest(t, s, scope)
			call := callerBegin(t, c, r)
			before := j.count()
			if err := call.AcknowledgeReturn(context.Background(), &port.CallerReturn{Returned: true}); err == nil || j.count() != before {
				t.Fatal("premature Resolve")
			}
			out := callerAccept(t, call, r)
			bad := callerAck(r, out)
			change(bad)
			if err := call.AcknowledgeReturn(context.Background(), bad); err == nil || j.count() != before || relayView(t, s, c).OutstandingCallID == "" {
				t.Fatal("bad receipt resolved")
			}
			if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestCallerUnknownBeginNoFramesTokenOrRetry(t *testing.T) {
	for _, fault := range []string{"error", "nil", "revision", "scope", "entry"} {
		t.Run(fault, func(t *testing.T) {
			s, c, _, j, _, scope := relayRunning(t)
			r := callerRequest(t, s, scope)
			j.fault = fault
			if call, err := c.BeginCallerTool(context.Background(), r); err == nil || call != nil {
				t.Fatal("unknown intent token")
			}
			before := j.count()
			if _, err := c.BeginCallerTool(context.Background(), r); err == nil || j.count() != before || c.handle.caller != nil || c.handle.frames.Snapshot().LastSequence != 4 || !s.unknown {
				t.Fatal("intent retry/publication")
			}
		})
	}
}
func TestCallerCancelledDeadlineAndClosedReturn(t *testing.T) {
	for _, boundary := range []string{"begin", "claim", "output", "return"} {
		t.Run(boundary, func(t *testing.T) {
			s, c, _, j, _, scope := relayRunning(t)
			r := callerRequest(t, s, scope)
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			before := j.count()
			if boundary == "begin" {
				if call, err := c.BeginCallerTool(ctx, r); err == nil || call != nil || j.count() != before {
					t.Fatal("expired begin")
				}
				return
			}
			call := callerBegin(t, c, r)
			if boundary == "claim" {
				if err := call.ClaimDispatch(ctx); err == nil || call.dispatchClaimed {
					t.Fatal("expired dispatch")
				}
				return
			}
			if err := call.ClaimDispatch(context.Background()); err != nil {
				t.Fatal(err)
			}
			if boundary == "output" {
				if _, err := call.AcceptOutput(ctx, callerInput(r, `"late"`)); err == nil || call.phase != callerPending {
					t.Fatal("expired output")
				}
				return
			}
			out, err := call.AcceptOutput(context.Background(), callerInput(r, `"exact"`))
			if err != nil {
				t.Fatal(err)
			}
			if err := c.Cancel(context.Background()); err != nil {
				t.Fatal(err)
			}
			before = j.count()
			if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err == nil || j.count() != before || !c.handle.closed || c.handle.unresolvedCallID != r.ProducerOperationID || c.handle.releasedRevision != 0 {
				t.Fatal("closed Return")
			}
		})
	}
}
func TestCallerEncodedFrameBoundAndOwnedNamespaceCopy(t *testing.T) {
	t.Run("escaped-frame-bound", func(t *testing.T) {
		s, c, _, j, _, scope := relayRunning(t)
		r := callerRequest(t, s, scope)
		r.Call.Arguments = `{"x":"` + strings.Repeat(`\"`, 22000) + `"}`
		before := j.count()
		if call, err := c.BeginCallerTool(context.Background(), r); err == nil || call != nil || j.count() != before || c.handle.frames.Snapshot().LastSequence != 4 {
			t.Fatal("encoded frame escaped bound")
		}
	})
	t.Run("namespace-copy", func(t *testing.T) {
		s, c, _, _, _, scope := relayRunning(t)
		r := callerRequest(t, s, scope)
		namespace := "functions"
		r.Call.Namespace = &namespace
		call := callerBegin(t, c, r)
		namespace = "changed"
		if err := call.ClaimDispatch(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := call.AcceptOutput(context.Background(), callerInput(r, `"one"`)); err == nil {
			t.Fatal("mutated namespace owned")
		}
		original := "functions"
		r.Call.Namespace = &original
		if _, err := call.AcceptOutput(context.Background(), callerInput(r, `"one"`)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("nil-vs-empty", func(t *testing.T) {
		s, c, _, _, _, scope := relayRunning(t)
		r := callerRequest(t, s, scope)
		call := callerBegin(t, c, r)
		if err := call.ClaimDispatch(context.Background()); err != nil {
			t.Fatal(err)
		}
		in := callerInput(r, `"one"`)
		empty := ""
		in.Calls[0].Namespace = &empty
		if _, err := call.AcceptOutput(context.Background(), in); err == nil {
			t.Fatal("namespace presence dropped")
		}
	})
}
func TestCallerJSONIdentityMatchesExistingJavaScriptProducer(t *testing.T) {
	s, c, _, _, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	r.Scope = port.CallerScope{SessionID: "<>&\u2028\u2029\\u2028😀", ThreadID: "thread", TurnID: "turn", RootTurnID: "root", Model: "chatgpt"}
	// Golden SHA computed independently with Node crypto + JSON.stringify of the
	// sorted identity keys, matching existing canonicalJson. No native tool call.
	r.Call.CallID = "farol_next_call_f3f17ae0cd27b0c50123456789abcdef"
	if _, err := c.BeginCallerTool(context.Background(), r); err != nil {
		t.Fatal(err)
	}
}
func TestCallerConcurrentReturnCommitsOnlyOriginalOnce(t *testing.T) {
	s, c, _, j, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	call := callerBegin(t, c, r)
	out := callerAccept(t, call, r)
	before := j.count()
	var g sync.WaitGroup
	success := make(chan bool, 16)
	for n := 0; n < 16; n++ {
		g.Add(1)
		go func() {
			defer g.Done()
			success <- call.AcknowledgeReturn(context.Background(), callerAck(r, out)) == nil
		}()
	}
	g.Wait()
	close(success)
	count := 0
	for ok := range success {
		if ok {
			count++
		}
	}
	if count != 1 || j.count() != before+1 || relayView(t, s, c).OutstandingCallID != "" {
		t.Fatal("duplicate Resolve")
	}
}

// This seam runs after the actual receipt guard unlocks, before original Resolve
// stages its journal candidate. No host timing or external executor is involved.
type callerUnlockGate struct {
	port.Gate
	once func()
}

func (g *callerUnlockGate) Unlock() {
	hook := g.once
	g.once = nil
	g.Gate.Unlock()
	if hook != nil {
		hook()
	}
}
func TestCallerReturnWithdrawalAfterReceiptGuardFencesOwner(t *testing.T) {
	s, c, b, j, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	call := callerBegin(t, c, r)
	out := callerAccept(t, call, r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	before := j.count()
	g := &callerUnlockGate{Gate: s.deps.Gate, once: cancel}
	s.deps.Gate = g
	if err := call.AcknowledgeReturn(ctx, callerAck(r, out)); err == nil {
		t.Fatal("withdrawn Resolve known")
	}
	if !s.unknown || j.count() != before || relayView(t, s, c).OutstandingCallID != r.ProducerOperationID || len(b.sent) != 1 {
		t.Fatal("attempted return did not fence owner")
	}
	if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err == nil || j.count() != before {
		t.Fatal("withdrawn Resolve retried")
	}
}

func TestCallerFreezeRefusesFirstDispatchButSettlesClaimedReturn(t *testing.T) {
	for _, claimed := range []bool{false, true} {
		name := "unclaimed"
		if claimed {
			name = "claimed"
		}
		t.Run(name, func(t *testing.T) {
			s, c, b, j, _, scope := relayRunning(t)
			r := callerRequest(t, s, scope)
			call := callerBegin(t, c, r)
			if claimed {
				if err := call.ClaimDispatch(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.FreezeAdmissions(context.Background()); err != nil {
				t.Fatal(err)
			}
			before := j.count()
			if !claimed {
				if err := call.ClaimDispatch(context.Background()); err == nil || call.dispatchClaimed {
					t.Fatal("first dispatch granted after freeze")
				}
				if _, err := call.AcceptOutput(context.Background(), callerInput(r, `"not dispatched"`)); err == nil {
					t.Fatal("unclaimed frozen output accepted")
				}
				if j.count() != before || relayView(t, s, c).OutstandingCallID != r.ProducerOperationID || len(b.sent) != 1 {
					t.Fatal("freeze lost outstanding original")
				}
				return
			}
			out, err := call.AcceptOutput(context.Background(), callerInput(r, `"known original"`))
			if err != nil {
				t.Fatal("freeze rejected original output", err)
			}
			if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err != nil {
				t.Fatal("freeze rejected original Resolve", err)
			}
			if j.count() != before+1 || relayView(t, s, c).OutstandingCallID != "" || len(b.sent) != 1 {
				t.Fatal("frozen settlement not exact")
			}
		})
	}
}

func TestCallerCheckDispatchIsRepeatableReadNotClaimOrFence(t *testing.T) {
	s, c, b, j, _, scope := relayRunning(t)
	r := callerRequest(t, s, scope)
	call := callerBegin(t, c, r)
	before := ownerReadProbe(t, c)
	if err := call.CheckDispatch(context.Background()); err == nil {
		t.Fatal("unclaimed call became executable")
	}
	assertOwnerReadUnchanged(t, c, before)
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	before, writes := ownerReadProbe(t, c), j.count()
	// Any accidental port invocation panics. Neither repeated reads nor frame
	// replay may claim/execute/ACK this original round a second time.
	journal, browser, results, digests := s.deps.Journal, s.deps.Browser, s.deps.Results, s.deps.IntentDigests
	s.deps.Journal = struct{ port.Journal }{}
	s.deps.Browser = struct{ port.VerifiedBrowser }{}
	s.deps.Results = struct{ port.ResultRetention }{}
	s.deps.IntentDigests = struct{ port.IntentDigester }{}
	for n := 0; n < 3; n++ {
		if err := call.CheckDispatch(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	assertOwnerReadUnchanged(t, c, before)
	s.deps.Journal, s.deps.Browser, s.deps.Results, s.deps.IntentDigests = journal, browser, results, digests
	if j.count() != writes || len(b.sent) != 1 {
		t.Fatal("snapshot performed an effect")
	}
	if err := call.ClaimDispatch(context.Background()); err == nil {
		t.Fatal("read renewed claim")
	}
	frames, err := c.Events(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range frames {
		if _, err := c.AcknowledgeFrame(context.Background(), frame.Sequence); err != nil {
			t.Fatal(err)
		}
	}
	if err := call.CheckDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if relayView(t, s, c).OutstandingCallID != r.ProducerOperationID {
		t.Fatal("read/frame ACK resolved original")
	}
	// Positive observation does not lock the transport. Freeze can follow it;
	// the next observation must refuse, while original settlement still works.
	if err := s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	before = ownerReadProbe(t, c)
	if !errors.Is(call.CheckDispatch(context.Background()), Frozen) {
		t.Fatal("snapshot survived freeze")
	}
	assertOwnerReadUnchanged(t, c, before)
	out, err := call.AcceptOutput(context.Background(), callerInput(r, `"original output"`))
	if err != nil {
		t.Fatal(err)
	}
	if err := call.AcknowledgeReturn(context.Background(), callerAck(r, out)); err != nil {
		t.Fatal(err)
	}
	if len(b.sent) != 1 {
		t.Fatal("snapshot/settlement sent again")
	}
}

func TestCallerCheckDispatchRejectsChangedOwnerWithoutMutation(t *testing.T) {
	cases := map[string]func(*Service, *Conversation, *CallerToolCall){
		"unknown":            func(s *Service, _ *Conversation, _ *CallerToolCall) { s.unknown = true },
		"revision-exhausted": func(s *Service, _ *Conversation, _ *CallerToolCall) { s.revision = math.MaxUint64 },
		"fence-exhausted":    func(s *Service, _ *Conversation, _ *CallerToolCall) { s.fence = math.MaxUint64 },
		"pending":            func(s *Service, _ *Conversation, _ *CallerToolCall) { s.pending = &mutation{} },
		"retiring":           func(s *Service, _ *Conversation, _ *CallerToolCall) { s.retiring = true },
		"retired":            func(s *Service, _ *Conversation, _ *CallerToolCall) { s.retired = &retirementProof{} },
		"closed":             func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.closed = true },
		"observing":          func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.observing = true },
		"released":           func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.releasedRevision = 1 },
		"logical-generation": func(_ *Service, _ *Conversation, call *CallerToolCall) { call.request.Context.Binding.TurnGeneration++ },
		"backend-generation": func(_ *Service, _ *Conversation, call *CallerToolCall) {
			call.request.Context.Binding.BackendGeneration = "other"
		},
		"task-epoch": func(_ *Service, _ *Conversation, call *CallerToolCall) { call.request.Context.Binding.TaskEpoch++ },
		"participant": func(_ *Service, _ *Conversation, call *CallerToolCall) {
			call.request.Context.Binding.ParticipantID = "other"
		},
		"slot-generation": func(_ *Service, _ *Conversation, call *CallerToolCall) {
			call.request.Context.Browser.Lease.SlotGeneration++
		},
		"view-generation": func(_ *Service, _ *Conversation, call *CallerToolCall) { call.request.Context.Browser.ViewGeneration++ },
		"document-generation": func(_ *Service, _ *Conversation, call *CallerToolCall) {
			call.request.Context.Browser.DocumentGeneration++
		},
		"provider-conversation": func(_ *Service, c *Conversation, _ *CallerToolCall) { c.providerID = "other" },
		"reply":                 func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.output.ReplyID = "other" },
		"user":                  func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.output.UserID = "other" },
		"watermark-regressed":   func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.sourceSequence = 0 },
		"outstanding-operation": func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.unresolvedCallID = "other" },
		"selection":             func(_ *Service, c *Conversation, _ *CallerToolCall) { c.handle.verification.Pinned.ModelID = "other" },
		"owner-registry":        func(s *Service, c *Conversation, _ *CallerToolCall) { delete(s.handles, c.handle.fixed.OperationID) },
		"replacement-token":     func(_ *Service, c *Conversation, call *CallerToolCall) { clone := *call; c.handle.caller = &clone },
		"accepted":              func(_ *Service, _ *Conversation, call *CallerToolCall) { call.phase = callerAccepted },
		"returning":             func(_ *Service, _ *Conversation, call *CallerToolCall) { call.phase = callerReturning },
		"returned":              func(_ *Service, _ *Conversation, call *CallerToolCall) { call.phase = callerReturned },
		"call-unknown":          func(_ *Service, _ *Conversation, call *CallerToolCall) { call.phase = callerUnknown },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s, c, b, j, _, scope := relayRunning(t)
			call := callerBegin(t, c, callerRequest(t, s, scope))
			if err := call.ClaimDispatch(context.Background()); err != nil {
				t.Fatal(err)
			}
			change(s, c, call)
			before, writes := ownerReadProbe(t, c), j.count()
			if err := call.CheckDispatch(context.Background()); err == nil {
				t.Fatal("changed original remained executable")
			}
			assertOwnerReadUnchanged(t, c, before)
			if j.count() != writes || len(b.sent) != 1 {
				t.Fatal("read performed effect")
			}
		})
	}
}

func TestCallerCheckDispatchAfterCancelAndContextWithdrawal(t *testing.T) {
	for _, kind := range []string{"owner-cancel", "context-cancel", "nil-context"} {
		t.Run(kind, func(t *testing.T) {
			s, c, b, j, _, scope := relayRunning(t)
			call := callerBegin(t, c, callerRequest(t, s, scope))
			if err := call.ClaimDispatch(context.Background()); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			switch kind {
			case "owner-cancel":
				if err := c.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
			case "context-cancel":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "nil-context":
				ctx = nil
			}
			before, writes := ownerReadProbe(t, c), j.count()
			if err := call.CheckDispatch(ctx); err == nil {
				t.Fatal("withdrawal accepted")
			}
			assertOwnerReadUnchanged(t, c, before)
			if j.count() != writes || len(b.sent) != 1 {
				t.Fatal("cancelled read performed effect")
			}
		})
	}
}

func TestCallerCheckDispatchDoesNotReserveOwnerAcrossCalls(t *testing.T) {
	s, c, _, _, _, scope := relayRunning(t)
	call := callerBegin(t, c, callerRequest(t, s, scope))
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := call.CheckDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Deterministic owner-gate withdrawal between two reads; no IO is held by
	// the first observation. This witnesses source semantics, not Node drain.
	s.deps.Gate.Lock()
	started, done := make(chan struct{}), make(chan error, 1)
	go func() { close(started); done <- call.CheckDispatch(context.Background()) }()
	<-started
	s.frozen = true
	s.deps.Gate.Unlock()
	if !errors.Is(<-done, Frozen) {
		t.Fatal("queued observation missed owner withdrawal")
	}
}

func TestCallerCheckDispatchRefusesAwaitingOwner(t *testing.T) {
	s, c, b, j, _, scope := relayRunning(t)
	call := callerBegin(t, c, callerRequest(t, s, scope))
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	binding := relayView(t, s, c).Binding
	if _, err := s.Apply(context.Background(), c.handle, Change{Action: AwaitOwner, Binding: binding}); err != nil {
		t.Fatal(err)
	}
	before, writes := ownerReadProbe(t, c), j.count()
	if err := call.CheckDispatch(context.Background()); err == nil {
		t.Fatal("awaiting-owner call executable")
	}
	assertOwnerReadUnchanged(t, c, before)
	if j.count() != writes || len(b.sent) != 1 {
		t.Fatal("read changed awaiting-owner")
	}
}

func TestCallerDeliveryConcurrentIssueHasOneWinnerAndNoRenewal(t *testing.T) {
	s, c, _, j, _, scope := relayRunning(t)
	call := callerBegin(t, c, callerRequest(t, s, scope))
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	type result struct {
		group *CallerDelivery
		err   error
	}
	done := make(chan result, 16)
	for n := 0; n < 16; n++ {
		go func() { <-start; group, err := call.IssueDelivery(context.Background()); done <- result{group, err} }()
	}
	before, writes := ownerReadProbe(t, c), j.count()
	close(start)
	winners := 0
	for n := 0; n < 16; n++ {
		r := <-done
		if r.err == nil {
			if r.group == nil {
				t.Fatal("empty successful issue")
			}
			winners++
		} else if r.group != nil {
			t.Fatal("refusal leaked group")
		}
	}
	if winners != 1 || !call.deliveryIssued {
		t.Fatal("issuance was not single-use")
	}
	assertOwnerReadUnchanged(t, c, before)
	if j.count() != writes {
		t.Fatal("issue journaled")
	}
	if err := call.CheckDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if group, err := call.IssueDelivery(context.Background()); err == nil || group != nil {
		t.Fatal("positive snapshot renewed issuance")
	}
}

func TestCallerDeliveryIssueBeforeCancelCannotClaimNotWritten(t *testing.T) {
	s, c, b, _, _, scope := relayRunning(t)
	call := callerBegin(t, c, callerRequest(t, s, scope))
	if err := call.ClaimDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	group, err := call.IssueDelivery(context.Background())
	if err != nil || group == nil {
		t.Fatal("original issue failed")
	}
	if err := c.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if again, err := call.IssueDelivery(context.Background()); err == nil || again != nil {
		t.Fatal("cancelled issue replayed")
	}
	// Already detached frames may be in-flight. Cancel cannot recall them or
	// prove non-delivery; the owning post-Send lifecycle remains unknown/occupied.
	if len(group.Frames) != 8 || relayView(t, s, c).Phase != "unknown" || c.handle.releasedRevision != 0 || len(b.sent) != 1 {
		t.Fatal("cancel fabricated non-delivery or reuse")
	}
}
