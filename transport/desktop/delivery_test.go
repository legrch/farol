package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

// These tests establish local frame delivery only, using owned memory pipes.
// They do not establish peer acknowledgement or native/provider execution.
type deliveryFixture struct {
	input  *io.PipeWriter
	output *io.PipeReader
	writer *deliveryWriter
	cancel context.CancelFunc
	done   chan struct{}
	err    error // Read only after done, which includes Serve's worker join.
	stop   sync.Once
	io     sync.WaitGroup
	joined chan struct{}
}

var deliveryWriteFailure = errors.New("test response write failed")

// Once armed by the owner, the writer can hold the final payload byte or fail
// a selected write. All successful bytes still pass through a real memory pipe.
type deliveryWriter struct {
	*io.PipeWriter
	armed   atomic.Bool
	mode    string
	phase   int // Serve serializes all writes.
	partial chan struct{}
	release chan struct{}
	closed  chan struct{}
	once    sync.Once
	mu      sync.Mutex
	bytes   bytes.Buffer
}

func (w *deliveryWriter) accepted(p []byte) (int, error) {
	n, err := w.PipeWriter.Write(p)
	w.mu.Lock()
	w.bytes.Write(p[:n])
	w.mu.Unlock()
	return n, err
}

func (w *deliveryWriter) Write(p []byte) (int, error) {
	if !w.armed.Load() {
		return w.accepted(p)
	}
	w.phase++
	switch w.mode {
	case "hold_tail":
		if w.phase == 2 {
			n, err := w.accepted(p[:len(p)-1])
			close(w.partial)
			return n, err
		}
		if w.phase == 3 {
			select {
			case <-w.release:
			case <-w.closed:
				return 0, io.ErrClosedPipe
			}
		}
	case "header_error":
		return 0, deliveryWriteFailure
	case "partial_body_error":
		if w.phase == 2 {
			n, _ := w.accepted(p[:len(p)/2])
			return n, deliveryWriteFailure
		}
	case "complete_body_error":
		if w.phase == 2 {
			n, _ := w.accepted(p)
			return n, deliveryWriteFailure
		}
	case "zero_body_write":
		if w.phase == 2 {
			return 0, nil
		}
	}
	return w.accepted(p)
}

func (w *deliveryWriter) Close() error {
	w.once.Do(func() { close(w.closed) })
	return w.PipeWriter.Close()
}

func (w *deliveryWriter) snapshot() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]byte(nil), w.bytes.Bytes()...)
}

type deliveryEvent struct {
	request   Request
	delivered bool
	written   []byte
}

type deliveryRecorder struct {
	mu     sync.Mutex
	events []deliveryEvent
	notify chan deliveryEvent
}

func newDeliveryRecorder() *deliveryRecorder {
	return &deliveryRecorder{notify: make(chan deliveryEvent, 64)}
}

func (r *deliveryRecorder) callback(w *deliveryWriter) func(Request, bool) {
	return func(request Request, delivered bool) {
		event := deliveryEvent{request: request, delivered: delivered, written: w.snapshot()}
		r.mu.Lock()
		r.events = append(r.events, event)
		r.mu.Unlock()
		select {
		case r.notify <- event:
		default:
		}
	}
}

func (r *deliveryRecorder) snapshot() []deliveryEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]deliveryEvent(nil), r.events...)
}

func newDeliveryFixture(t *testing.T, concurrent bool, mode string, recorder *deliveryRecorder, handle func(context.Context, Request) (*Outcome, error), terminal ...bool) *deliveryFixture {
	t.Helper()
	in, input := io.Pipe()
	output, out := io.Pipe()
	w := &deliveryWriter{PipeWriter: out, mode: mode, partial: make(chan struct{}), release: make(chan struct{}), closed: make(chan struct{})}
	s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", TerminalRejection: len(terminal) == 1 && terminal[0], Methods: map[string]Method{
		"task.create": {Concurrent: concurrent, Handle: func(ctx context.Context, request Request) (*Outcome, error) {
			if mode != "" {
				w.armed.Store(true)
			}
			return handle(ctx, request)
		}, AfterReply: recorder.callback(w)},
	}})
	if err != nil {
		input.Close()
		in.Close()
		output.Close()
		out.Close()
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	f := &deliveryFixture{input: input, output: output, writer: w, cancel: cancel, done: make(chan struct{}), joined: make(chan struct{})}
	go func() {
		f.err = s.Serve(ctx, in, w)
		close(f.done)
	}()
	t.Cleanup(func() { f.shutdown(t) })
	f.send(t, request("hello", "core.handshake", `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, nil))
	if response := f.read(t); response.Result == nil || response.Result.Status != "ok" {
		t.Fatalf("handshake: %+v", response)
	}
	return f
}

func TestResponseDeliveryTerminalRejectionClosesSerialAndConcurrent(t *testing.T) {
	for _, concurrent := range []bool{false, true} {
		t.Run(fmt.Sprintf("concurrent=%t", concurrent), func(t *testing.T) {
			recorder := newDeliveryRecorder()
			f := newDeliveryFixture(t, concurrent, "", recorder, func(context.Context, Request) (*Outcome, error) {
				return &Outcome{Status: "refused", Code: "selected_role_refused"}, nil
			}, true)
			f.send(t, deliveryRequest(t, "effect", optional("exact-op"), deliveryContext()))
			if response := f.read(t); response.Result == nil || response.Result.Status != "refused" {
				t.Fatal("terminal policy lost the original refusal response")
			}
			assertDeliveryRequest(t, deliveryWait(t, f, recorder.notify), "effect", false)
			deliveryWait(t, f, f.done)
			if f.err == nil || len(recorder.snapshot()) != 1 {
				t.Fatal("terminal role continued after refusal")
			}
		})
	}
}

func (f *deliveryFixture) shutdown(t *testing.T) {
	t.Helper()
	f.stop.Do(func() {
		f.cancel()
		f.input.Close()
		f.output.Close()
		f.writer.Close()
		go func() {
			f.io.Wait()
			close(f.joined)
		}()
	})
	select {
	case <-f.done:
	case <-time.After(2 * time.Second):
		t.Error("Serve did not join the owned handlers after cancellation")
	}
	select {
	case <-f.joined:
	case <-time.After(2 * time.Second):
		t.Error("test I/O did not join after closing the owned pipes")
	}
}

func deliveryWait[T any](t *testing.T, f *deliveryFixture, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(2 * time.Second):
		f.shutdown(t)
		// Closing the owned endpoints also joins a blocked test reader/writer.
		select {
		case <-ch:
		case <-time.After(2 * time.Second):
			t.Error("test operation did not terminate after pipe closure")
		}
		t.Fatal("timed out waiting for local delivery")
		var zero T
		return zero
	}
}

func (f *deliveryFixture) send(t *testing.T, raw []byte) {
	t.Helper()
	done := make(chan error, 1)
	f.io.Add(1)
	go func() {
		defer f.io.Done()
		done <- ipc.WriteFrame(f.input, raw)
	}()
	if err := deliveryWait(t, f, done); err != nil {
		t.Fatal(err)
	}
}

func (f *deliveryFixture) read(t *testing.T) wire.Response {
	t.Helper()
	type result struct {
		response wire.Response
		err      error
	}
	done := make(chan result, 1)
	f.io.Add(1)
	go func() {
		defer f.io.Done()
		raw, err := ipc.ReadFrame(f.output)
		var response wire.Response
		if err == nil {
			err = json.Unmarshal(raw, &response)
		}
		done <- result{response, err}
	}()
	got := deliveryWait(t, f, done)
	if got.err != nil {
		t.Fatal(got.err)
	}
	return got.response
}

func deliveryRequest(t *testing.T, id string, operation *string, bound wire.Context) []byte {
	t.Helper()
	raw, err := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: id, Method: "task.create", Params: wire.Call{Context: &bound, OperationId: operation, Body: json.RawMessage(`{"probe":"delivery"}`)}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func deliveryContext() wire.Context {
	return wire.Context{ProfileId: "test", BackendGeneration: "generation"}
}

func assertDeliveryRequest(t *testing.T, event deliveryEvent, id string, delivered bool) {
	t.Helper()
	if event.request.RequestID != id || event.request.OperationID != "exact-op" || string(event.request.Body) != `{"probe":"delivery"}` || event.delivered != delivered {
		t.Fatalf("callback identity/delivery: %+v", event)
	}
}

func TestResponseDeliveryAfterCompleteOKFrame(t *testing.T) {
	for _, concurrent := range []bool{false, true} {
		t.Run(fmt.Sprintf("concurrent=%t", concurrent), func(t *testing.T) {
			recorder := newDeliveryRecorder()
			var calls atomic.Int32
			f := newDeliveryFixture(t, concurrent, "hold_tail", recorder, func(context.Context, Request) (*Outcome, error) {
				calls.Add(1)
				return &Outcome{Status: "ok", Data: json.RawMessage(`{"accepted":true}`)}, nil
			})
			f.send(t, deliveryRequest(t, "effect", optional("exact-op"), deliveryContext()))
			type frameResult struct {
				raw []byte
				err error
			}
			readDone := make(chan frameResult, 1)
			f.io.Add(1)
			go func() {
				defer f.io.Done()
				raw, err := ipc.ReadFrame(f.output)
				readDone <- frameResult{raw, err}
			}()
			deliveryWait(t, f, f.writer.partial)
			if len(recorder.snapshot()) != 0 {
				t.Fatal("callback ran before the complete frame was written")
			}
			close(f.writer.release)
			if got := deliveryWait(t, f, readDone); got.err != nil {
				t.Fatal(got.err)
			}
			event := deliveryWait(t, f, recorder.notify)
			assertDeliveryRequest(t, event, "effect", true)
			frames := bytes.NewReader(event.written)
			for _, id := range []string{"hello", "effect"} {
				raw, err := ipc.ReadFrame(frames)
				if err != nil {
					t.Fatalf("callback preceded complete %s frame: %v", id, err)
				}
				var response wire.Response
				if err := json.Unmarshal(raw, &response); err != nil || response.Result == nil || response.Result.RequestId != id || response.Result.Status != "ok" {
					t.Fatalf("written %s response: %+v, %v", id, response, err)
				}
			}
			if frames.Len() != 0 {
				t.Fatal("unexpected bytes after the complete OK frame")
			}
			f.shutdown(t)
			if calls.Load() != 1 || len(recorder.snapshot()) != 1 {
				t.Fatal("owner or callback was invoked more than once")
			}
		})
	}
}

func TestResponseDeliveryWriteFailure(t *testing.T) {
	for _, concurrent := range []bool{false, true} {
		for _, mode := range []string{"header_error", "partial_body_error", "complete_body_error", "zero_body_write"} {
			t.Run(fmt.Sprintf("concurrent=%t/%s", concurrent, mode), func(t *testing.T) {
				recorder := newDeliveryRecorder()
				var calls atomic.Int32
				f := newDeliveryFixture(t, concurrent, mode, recorder, func(context.Context, Request) (*Outcome, error) {
					calls.Add(1)
					return &Outcome{Status: "ok"}, nil
				})
				drained := make(chan error, 1)
				f.io.Add(1)
				go func() {
					defer f.io.Done()
					_, err := io.Copy(io.Discard, f.output)
					drained <- err
				}()
				f.send(t, deliveryRequest(t, "effect", optional("exact-op"), deliveryContext()))
				assertDeliveryRequest(t, deliveryWait(t, f, recorder.notify), "effect", false)
				deliveryWait(t, f, f.done)
				deliveryWait(t, f, drained)
				want := deliveryWriteFailure
				if mode == "zero_body_write" {
					want = io.ErrShortWrite
				}
				if !errors.Is(f.err, want) || !strings.Contains(f.err.Error(), "response delivery unknown") {
					t.Fatalf("missing delivery failure: %v", f.err)
				}
				if calls.Load() != 1 || len(recorder.snapshot()) != 1 {
					t.Fatal("write failure replayed owner or callback")
				}
			})
		}
	}
}

func TestResponseDeliveryOwnerOutcome(t *testing.T) {
	for _, concurrent := range []bool{false, true} {
		for _, test := range []struct {
			name    string
			outcome *Outcome
			err     error
			status  string
			code    string
		}{
			{"owner_error", &Outcome{Status: "ok"}, errors.New("owner failed"), "unknown", "owner_outcome_unknown"},
			{"nil_outcome", nil, nil, "unknown", "owner_outcome_unknown"},
			{"refused", &Outcome{Status: "refused", Code: "owner_refused"}, nil, "refused", "owner_refused"},
			{"invalid_status", &Outcome{Status: "invalid"}, nil, "unknown", "owner_output_invalid"},
			{"invalid_json", &Outcome{Status: "ok", Data: json.RawMessage(`{`)}, nil, "unknown", "owner_output_invalid"},
			{"duplicate_json_key", &Outcome{Status: "ok", Data: json.RawMessage(`{"x":1,"x":2}`)}, nil, "unknown", "owner_output_invalid"},
			{"invalid_code", &Outcome{Status: "ok", Code: "bad\ncode"}, nil, "unknown", "owner_output_invalid"},
			{"oversized_data", &Outcome{Status: "ok", Data: json.RawMessage(`"` + strings.Repeat("a", ipc.MaxFrameBytes) + `"`)}, nil, "unknown", "owner_output_bound"},
			{"escaped_data_expansion", &Outcome{Status: "ok", Data: json.RawMessage(`"` + strings.Repeat("<", ipc.MaxFrameBytes/4) + `"`)}, nil, "unknown", "owner_output_bound"},
			{"oversized_code", &Outcome{Status: "ok", Code: strings.Repeat("a", 257)}, nil, "unknown", "owner_output_bound"},
		} {
			t.Run(fmt.Sprintf("concurrent=%t/%s", concurrent, test.name), func(t *testing.T) {
				recorder := newDeliveryRecorder()
				var calls atomic.Int32
				f := newDeliveryFixture(t, concurrent, "", recorder, func(context.Context, Request) (*Outcome, error) {
					calls.Add(1)
					return test.outcome, test.err
				})
				f.send(t, deliveryRequest(t, "effect", optional("exact-op"), deliveryContext()))
				response := f.read(t)
				if response.Id == nil || *response.Id != "effect" || response.Result == nil || response.Result.Status != test.status || response.Result.Code == nil || *response.Result.Code != test.code || response.Result.RequestId != "effect" || response.Result.OperationId == nil || *response.Result.OperationId != "exact-op" || response.Result.Context != deliveryContext() || len(response.Result.Data) != 0 {
					t.Fatalf("normalized owner output: %+v", response)
				}
				assertDeliveryRequest(t, deliveryWait(t, f, recorder.notify), "effect", false)
				f.send(t, request("after", "core.status", `{}`, &wire.Context{ProfileId: "test", BackendGeneration: "generation"}))
				if after := f.read(t); after.Result == nil || after.Result.Status != "ok" || after.Result.RequestId != "after" {
					t.Fatalf("owner output closed unrelated traffic: %+v", after)
				}
				f.shutdown(t)
				if calls.Load() != 1 || len(recorder.snapshot()) != 1 {
					t.Fatal("owner or callback was replayed")
				}
			})
		}
	}
}

func TestResponseDeliveryUninvokedHandler(t *testing.T) {
	for _, concurrent := range []bool{false, true} {
		t.Run(fmt.Sprintf("concurrent=%t", concurrent), func(t *testing.T) {
			recorder := newDeliveryRecorder()
			var calls atomic.Int32
			f := newDeliveryFixture(t, concurrent, "", recorder, func(context.Context, Request) (*Outcome, error) {
				calls.Add(1)
				return &Outcome{Status: "ok"}, nil
			})
			stale := deliveryContext()
			stale.BackendGeneration = "old"
			for _, test := range []struct {
				raw  []byte
				code int32
			}{
				{deliveryRequest(t, "missing-operation", nil, deliveryContext()), -32602},
				{deliveryRequest(t, "stale", optional("exact-op"), stale), -32002},
				{deliveryRequest(t, "bad identity", optional("exact-op"), deliveryContext()), -32600},
			} {
				f.send(t, test.raw)
				if response := f.read(t); response.Error == nil || response.Error.Code != test.code {
					t.Fatalf("invalid identity admitted: %+v", response)
				}
			}
			if calls.Load() != 0 || len(recorder.snapshot()) != 0 {
				t.Fatal("rejected identity invoked owner or callback")
			}
			raw := deliveryRequest(t, "effect", optional("exact-op"), deliveryContext())
			f.send(t, raw)
			if response := f.read(t); response.Result == nil || response.Result.Status != "ok" {
				t.Fatalf("valid request refused: %+v", response)
			}
			assertDeliveryRequest(t, deliveryWait(t, f, recorder.notify), "effect", true)
			f.send(t, raw)
			if response := f.read(t); response.Error == nil || response.Error.Code != -32600 {
				t.Fatalf("duplicate admitted: %+v", response)
			}
			f.shutdown(t)
			if calls.Load() != 1 || len(recorder.snapshot()) != 1 {
				t.Fatal("uninvoked duplicate received a callback")
			}
		})
	}
}

func TestResponseDeliveryConcurrentBackpressureAndCancellation(t *testing.T) {
	recorder := newDeliveryRecorder()
	started := make(chan struct{}, 32)
	var calls atomic.Int32
	var stopped atomic.Int32
	f := newDeliveryFixture(t, true, "", recorder, func(ctx context.Context, _ Request) (*Outcome, error) {
		calls.Add(1)
		started <- struct{}{}
		<-ctx.Done()
		stopped.Add(1)
		return nil, ctx.Err()
	})
	for i := 0; i < 32; i++ {
		f.send(t, deliveryRequest(t, fmt.Sprintf("held-%d", i), optional("exact-op"), deliveryContext()))
		deliveryWait(t, f, started)
	}
	f.send(t, deliveryRequest(t, "overflow", optional("exact-op"), deliveryContext()))
	response := f.read(t)
	if response.Result == nil || response.Result.RequestId != "overflow" || response.Result.Status != "unavailable" || response.Result.Code == nil || *response.Result.Code != "handler_backpressure" {
		t.Fatalf("backpressure: %+v", response)
	}
	f.send(t, deliveryRequest(t, "held-0", optional("exact-op"), deliveryContext()))
	if response := f.read(t); response.Error == nil || response.Error.Code != -32600 {
		t.Fatalf("pending duplicate admitted: %+v", response)
	}
	if calls.Load() != 32 || len(recorder.snapshot()) != 0 {
		t.Fatal("backpressure/duplicate invoked owner or callback")
	}
	f.shutdown(t)
	if calls.Load() != 32 || stopped.Load() != 32 {
		t.Fatal("cancellation did not join exactly the admitted handlers")
	}
	events := recorder.snapshot()
	if len(events) != 32 {
		t.Fatalf("cancellation callbacks: %d, want 32", len(events))
	}
	seen := make(map[string]bool)
	for _, event := range events {
		assertDeliveryRequest(t, event, event.request.RequestID, false)
		if !strings.HasPrefix(event.request.RequestID, "held-") || seen[event.request.RequestID] {
			t.Fatalf("uninvoked or duplicate callback: %+v", event)
		}
		seen[event.request.RequestID] = true
	}
}
