package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync/atomic"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

// In-memory framed server fixtures only; no native process, socket or provider.

func readResponses(t *testing.T, out *bufferWriter) []wire.Response {
	t.Helper()
	var responses []wire.Response
	for out.Len() > 0 {
		raw, err := ipc.ReadFrame(out)
		if err != nil {
			t.Fatal(err)
		}
		var response wire.Response
		if err := json.Unmarshal(raw, &response); err != nil {
			t.Fatal(err)
		}
		responses = append(responses, response)
	}
	return responses
}

// One connection serves far more than the former 4096-request lifetime cap,
// reads and effects alike, while the server keeps only its sequence state.
func TestServeHasNoLifetimeRequestCap(t *testing.T) {
	const requests = 12000
	var reads, effects atomic.Int32
	s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{
		"computer.workspace.read": {Handle: func(context.Context, Request) (*Outcome, error) {
			reads.Add(1)
			return &Outcome{Status: "ok"}, nil
		}},
		"task.create": {Handle: func(_ context.Context, r Request) (*Outcome, error) {
			effects.Add(1)
			return &Outcome{Status: "ok"}, nil
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := s.context()
	var frames bytes.Buffer
	_ = ipc.WriteFrame(&frames, request(seq(1), "core.handshake", helloBody, nil))
	for i := uint64(2); i <= requests+1; i++ {
		call := wire.Call{Context: &ctx, Body: json.RawMessage(`{}`)}
		method := "computer.workspace.read"
		if i%2 == 0 {
			method = "task.create"
			call.OperationId = optional(fmt.Sprintf("operation-%d", i))
		}
		raw, _ := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: seq(i), Method: method, Params: call})
		_ = ipc.WriteFrame(&frames, raw)
	}
	out := &bufferWriter{}
	if err := s.Serve(context.Background(), io.NopCloser(&frames), out); err != nil {
		t.Fatalf("connection ended before EOF: %v", err)
	}
	responses := readResponses(t, out)
	if len(responses) != requests+1 {
		t.Fatalf("responses: %d", len(responses))
	}
	for i, response := range responses {
		if response.Result == nil || response.Result.Status != "ok" || response.Result.RequestId != seq(uint64(i)+1) {
			t.Fatalf("response %d: %+v", i, response)
		}
	}
	if reads.Load() != requests/2 || effects.Load() != requests/2 {
		t.Fatalf("owner calls: reads=%d effects=%d", reads.Load(), effects.Load())
	}
	if s.nonce != testNonce || s.next != requests+1 || len(s.polls) != 0 {
		t.Fatalf("state is not constant: nonce=%q next=%d polls=%v", s.nonce, s.next, s.polls)
	}
}

func TestOrdinarySequenceRefusals(t *testing.T) {
	const other = "a0000000-0000-4000-8000-000000000002"
	for _, test := range []struct{ name, id, message string }{
		{"duplicate", seq(2), "invalid request sequence"},
		{"older", seq(1), "invalid request sequence"},
		{"gap", seq(4), "invalid request sequence"},
		{"zero", "desktop-call:" + testNonce + ":0", "unsequenced request ID"},
		{"leading-zero", "desktop-call:" + testNonce + ":03", "unsequenced request ID"},
		{"overflow", "desktop-call:" + testNonce + ":18446744073709551616", "invalid request sequence"},
		{"foreign-nonce", sequenced(other, 3), "invalid request sequence"},
		{"malformed-nonce", "desktop-call:not-a-nonce:3", "unsequenced request ID"},
		{"uuid", "4f1c6c8e-8d1e-4c4e-9a52-6c1b7e9f0a11", "unsequenced request ID"},
		{"poll-lane-for-ordinary-call", "desktop-poll-browser:" + testNonce + ":1", "invalid ordered poll"},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{"task.create": {Handle: func(context.Context, Request) (*Outcome, error) {
				calls++
				return &Outcome{Status: "ok"}, nil
			}}}})
			if err != nil {
				t.Fatal(err)
			}
			handshake(s)
			ctx := s.context()
			effect := func(id string) wire.Response {
				raw, _ := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: id, Method: "task.create", Params: wire.Call{Context: &ctx, OperationId: optional("operation"), Body: json.RawMessage(`{}`)}})
				return s.dispatch(context.Background(), raw)
			}
			if response := effect(seq(2)); response.Result == nil || response.Result.Status != "ok" {
				t.Fatalf("first effect refused: %+v", response)
			}
			response := effect(test.id)
			if response.Error == nil || response.Error.Code != -32600 || response.Error.Message != test.message || calls != 1 {
				t.Fatalf("refusal: %+v calls=%d", response, calls)
			}
			// A refused sequence consumes nothing: the exact next one still runs.
			if response := effect(seq(3)); response.Result == nil || response.Result.Status != "ok" || calls != 2 {
				t.Fatalf("next sequence refused after a refusal: %+v", response)
			}
			if s.nonce != testNonce || s.next != 3 {
				t.Fatalf("state: nonce=%q next=%d", s.nonce, s.next)
			}
		})
	}
}

// A sequence is consumed when admitted, before handshake, context, method or
// identity checks: the refused request is never resendable and the stream
// does not stall behind it.
func TestRefusedAdmittedRequestConsumesItsSequence(t *testing.T) {
	s := server(t)
	if response := s.dispatch(context.Background(), request(seq(1), "core.status", `{}`, nil)); response.Error == nil || response.Error.Code != -32001 {
		t.Fatalf("status before handshake: %+v", response)
	}
	if response := s.dispatch(context.Background(), request(seq(2), "core.handshake", helloBody, nil)); response.Result == nil {
		t.Fatalf("handshake after a refused first request: %+v", response)
	}
	ctx := s.context()
	stale := ctx
	stale.BackendGeneration = "old"
	if response := s.dispatch(context.Background(), request(seq(3), "core.status", `{}`, &stale)); response.Error == nil || response.Error.Code != -32002 {
		t.Fatalf("stale context: %+v", response)
	}
	for _, id := range []string{seq(3), seq(5)} {
		if response := s.dispatch(context.Background(), request(id, "core.status", `{}`, &ctx)); response.Error == nil || response.Error.Message != "invalid request sequence" {
			t.Fatalf("%s admitted: %+v", id, response)
		}
	}
	if response := s.dispatch(context.Background(), request(seq(4), "core.status", `{}`, &ctx)); response.Result == nil || response.Result.Status != "ok" {
		t.Fatalf("stream stalled behind a refused request: %+v", response)
	}
}

func TestOrdinarySequenceCannotWrap(t *testing.T) {
	s := server(t)
	handshake(s)
	ctx := s.context()
	s.next = ^uint64(0) - 1
	last := "desktop-call:" + testNonce + ":18446744073709551615"
	if response := s.dispatch(context.Background(), request(last, "core.status", `{}`, &ctx)); response.Result == nil {
		t.Fatal("last uint64 sequence refused")
	}
	for _, id := range []string{last, "desktop-call:" + testNonce + ":18446744073709551616", seq(1)} {
		if response := s.dispatch(context.Background(), request(id, "core.status", `{}`, &ctx)); response.Error == nil {
			t.Fatalf("wrapped/replayed sequence admitted: %s", id)
		}
	}
}

// Each connection gets a fresh Server: a reconnect starts at sequence 1 under
// a new nonce and cannot continue, or replay into, the previous connection.
func TestReconnectStartsAFreshSequence(t *testing.T) {
	first := server(t)
	handshake(first)
	ctx := first.context()
	for i := 0; i < 3; i++ {
		if response := first.dispatch(context.Background(), request(nextID(first), "core.status", `{}`, &ctx)); response.Result == nil {
			t.Fatal("first connection refused")
		}
	}
	const nonce = "a0000000-0000-4000-8000-000000000003"
	second := server(t)
	for _, id := range []string{seq(5), seq(1)} {
		// The old nonce cannot continue on the new connection; the first
		// sequenced ID adopts the connection nonce, so seq(1) does here.
		response := second.dispatch(context.Background(), request(id, "core.handshake", helloBody, nil))
		if id == seq(5) && response.Error == nil {
			t.Fatal("continued the previous sequence on a new connection")
		}
		if id == seq(1) && response.Result == nil {
			t.Fatalf("fresh connection handshake refused: %+v", response)
		}
	}
	third := server(t)
	if response := third.dispatch(context.Background(), request(sequenced(nonce, 1), "core.handshake", helloBody, nil)); response.Result == nil {
		t.Fatal("fresh nonce refused")
	}
	if response := third.dispatch(context.Background(), request(seq(2), "core.status", `{}`, &ctx)); response.Error == nil || response.Error.Message != "invalid request sequence" {
		t.Fatalf("previous connection's nonce admitted: %+v", response)
	}
	if response := third.dispatch(context.Background(), request(sequenced(nonce, 2), "core.status", `{}`, &ctx)); response.Result == nil {
		t.Fatal("fresh connection did not continue its own sequence")
	}
}

// A protocol 1.0 peer sends caller-chosen IDs: it is refused before the
// handshake is evaluated, with a classified fault, and never reaches an owner.
// A 2.0 sequenced handshake declaring major 1 gets the identity refusal.
func TestProtocolOnePeerIsRefused(t *testing.T) {
	s := server(t)
	legacy := `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`
	response := s.dispatch(context.Background(), request("4f1c6c8e-8d1e-4c4e-9a52-6c1b7e9f0a11", "core.handshake", legacy, nil))
	if response.Error == nil || response.Error.Code != -32600 || response.Error.Message != "unsequenced request ID" || s.connected || s.nonce != "" {
		t.Fatalf("protocol 1.0 handshake: %+v", response)
	}
	response = s.dispatch(context.Background(), request(seq(1), "core.handshake", legacy, nil))
	if response.Error == nil || response.Error.Code != -32003 || s.connected {
		t.Fatalf("major 1 identity: %+v", response)
	}
}

// A long-running owner keeps its original correlation while far more
// requests than the former cap pass it on the same connection.
func TestInFlightRequestSurvivesLaterSequences(t *testing.T) {
	held := make(chan struct{})
	started := make(chan struct{}, 1)
	f := concurrentServer(t, func(ctx context.Context, r Request) (*Outcome, error) {
		started <- struct{}{}
		select {
		case <-held:
			return &Outcome{Status: "ok"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	ctx := wire.Context{ProfileId: "test", BackendGeneration: "generation"}
	original := f.id()
	f.send(t, request(original, "computer.workspace.read", `{}`, &ctx))
	<-started
	for i := 0; i < 5000; i++ {
		id := f.id()
		f.send(t, request(id, "core.status", `{}`, &ctx))
		if response := f.read(t); response.Result == nil || response.Result.RequestId != id {
			t.Fatalf("later request %d: %+v", i, response)
		}
	}
	close(held)
	if response := f.read(t); response.Result == nil || response.Result.RequestId != original || response.Result.Status != "ok" {
		t.Fatalf("lost the in-flight response: %+v", response)
	}
}
