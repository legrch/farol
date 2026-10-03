package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync/atomic"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

// Real serialized pipe framing; no native child/browser/provider is simulated
// as qualified by these tests. A held reciprocal handler is the protocol peer.
type concurrentFixture struct {
	input    *io.PipeWriter
	output   *io.PipeReader
	terminal chan error
	cancel   context.CancelFunc
}

func concurrentServer(t *testing.T, handler func(context.Context, Request) (*Outcome, error)) *concurrentFixture {
	t.Helper()
	server, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{
		"computer.workspace.read": {Concurrent: true, Handle: handler},
	}})
	if err != nil {
		t.Fatal(err)
	}
	in, input := io.Pipe()
	output, out := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	f := &concurrentFixture{input: input, output: output, terminal: make(chan error, 1), cancel: cancel}
	go func() { f.terminal <- server.Serve(ctx, in, out) }()
	t.Cleanup(func() {
		cancel()
		input.Close()
		output.Close()
		select {
		case <-f.terminal:
		case <-time.After(2 * time.Second):
			t.Error("server retained an owned handler after cancellation")
		}
	})
	f.send(t, request("hello", "core.handshake", `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, nil))
	if f.read(t).Result == nil {
		t.Fatal("handshake refused")
	}
	return f
}
func (f *concurrentFixture) send(t *testing.T, raw []byte) {
	t.Helper()
	if err := ipc.WriteFrame(f.input, raw); err != nil {
		t.Fatal(err)
	}
}
func (f *concurrentFixture) read(t *testing.T) wire.Response {
	t.Helper()
	type readResult struct {
		response wire.Response
		err      error
	}
	result := make(chan readResult, 1)
	go func() {
		raw, err := ipc.ReadFrame(f.output)
		var response wire.Response
		if err == nil {
			err = json.Unmarshal(raw, &response)
		}
		result <- readResult{response, err}
	}()
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatal(got.err)
		}
		return got.response
	case <-time.After(2 * time.Second):
		f.cancel()
		t.Fatal("reciprocal transport reader was blocked")
		return wire.Response{}
	}
}
func TestConcurrentHandlerAllowsReciprocalTrafficAndDeduplicatesBeforeDispatch(t *testing.T) {
	held := make(chan struct{})
	started := make(chan struct{}, 1)
	var calls atomic.Int32
	f := concurrentServer(t, func(ctx context.Context, r Request) (*Outcome, error) {
		calls.Add(1)
		started <- struct{}{}
		select {
		case <-held:
			return &Outcome{Status: "ok"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	ctx := wire.Context{ProfileId: "test", BackendGeneration: "generation"}
	raw := request("held", "computer.workspace.read", `{}`, &ctx)
	f.send(t, raw)
	<-started
	f.send(t, request("status", "core.status", `{}`, &ctx))
	response := f.read(t)
	if response.Result == nil || response.Result.RequestId != "status" {
		t.Fatalf("status blocked or crossed: %+v", response)
	}
	f.send(t, raw)
	if f.read(t).Error == nil {
		t.Fatal("duplicate admitted while original handler awaits peer")
	}
	if calls.Load() != 1 {
		t.Fatal("owner reentered")
	}
	close(held)
	response = f.read(t)
	if response.Result == nil || response.Result.RequestId != "held" || response.Result.Status != "ok" {
		t.Fatalf("lost original response: %+v", response)
	}
}
func TestConcurrentSaturationRefusesWithoutBlockingCompletionTraffic(t *testing.T) {
	held := make(chan struct{})
	started := make(chan struct{}, 32)
	var calls atomic.Int32
	f := concurrentServer(t, func(ctx context.Context, r Request) (*Outcome, error) {
		calls.Add(1)
		started <- struct{}{}
		select {
		case <-held:
			return &Outcome{Status: "ok"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	ctx := wire.Context{ProfileId: "test", BackendGeneration: "generation"}
	for i := 0; i < 32; i++ {
		f.send(t, request(fmt.Sprintf("held-%d", i), "computer.workspace.read", `{}`, &ctx))
		<-started
	}
	f.send(t, request("overflow", "computer.workspace.read", `{}`, &ctx))
	response := f.read(t)
	if response.Result == nil || response.Result.Status != "unavailable" || response.Result.Code == nil || *response.Result.Code != "handler_backpressure" {
		t.Fatalf("missing saturation refusal: %+v", response)
	}
	f.send(t, request("still-readable", "core.status", `{}`, &ctx))
	if f.read(t).Result.RequestId != "still-readable" {
		t.Fatal("completion reader blocked by saturation")
	}
	if calls.Load() != 32 {
		t.Fatal("overflow invoked owner")
	}
	close(held)
	seen := map[string]bool{}
	for i := 0; i < 32; i++ {
		response = f.read(t)
		if response.Result == nil || seen[response.Result.RequestId] {
			t.Fatal("response corruption or duplication")
		}
		seen[response.Result.RequestId] = true
	}
}
func TestConcurrentBoundaryValidationPrecedesOwnerDispatch(t *testing.T) {
	var calls atomic.Int32
	f := concurrentServer(t, func(context.Context, Request) (*Outcome, error) { calls.Add(1); return &Outcome{Status: "ok"}, nil })
	stale := wire.Context{ProfileId: "test", BackendGeneration: "other"}
	f.send(t, request("stale", "computer.workspace.read", `{}`, &stale))
	if f.read(t).Error == nil || calls.Load() != 0 {
		t.Fatal("stale request reached owner")
	}
}
func TestConcurrentCancellationWaitsForExactHandlerTerminal(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	f := concurrentServer(t, func(ctx context.Context, r Request) (*Outcome, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return nil, ctx.Err()
	})
	ctx := wire.Context{ProfileId: "test", BackendGeneration: "generation"}
	f.send(t, request("held", "computer.workspace.read", `{}`, &ctx))
	<-started
	f.cancel()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("handler did not receive cancellation")
	}
	// Fixture cleanup independently requires Serve terminal after worker join.
}
