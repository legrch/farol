package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

func server(t *testing.T) *Server {
	t.Helper()
	s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation"})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func request(id, method, body string, contextValue *wire.Context) []byte {
	data, _ := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: id, Method: method, Params: wire.Call{Context: contextValue, Body: json.RawMessage(body)}})
	return data
}

// Every ordinary test request uses the connection's sequenced namespace.
const testNonce = "a0000000-0000-4000-8000-000000000001"
const helloBody = `{"protocolMajor":2,"protocolMinor":0,"buildId":"build","profileId":"test"}`

// sequenced spells the wire grammar for an ordinary request independently of
// the server's parser: desktop-call:<connection nonce>:<one-based sequence>.
func sequenced(nonce string, n uint64) string {
	return "desktop-call:" + nonce + ":" + strconv.FormatUint(n, 10)
}

// seq names the n-th ordinary request on a test connection.
func seq(n uint64) string { return sequenced(testNonce, n) }

// nextID names the ordinary request the server admits next.
func nextID(s *Server) string { return seq(s.next + 1) }

func handshake(s *Server) wire.Response {
	return s.dispatch(context.Background(), request(nextID(s), "core.handshake", helloBody, nil))
}
func TestHandshakeBeforeCommands(t *testing.T) {
	s := server(t)
	if s.dispatch(context.Background(), request(nextID(s), "core.status", `{}`, nil)).Error == nil {
		t.Fatal("unhandshaken status")
	}
	if handshake(s).Result == nil {
		t.Fatal("valid handshake refused")
	}
	for _, body := range []string{`{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, `{"protocolMajor":3,"protocolMinor":0,"buildId":"build","profileId":"test"}`, `{"protocolMajor":2,"protocolMinor":1,"buildId":"build","profileId":"test"}`, `{"protocolMajor":2,"protocolMinor":0,"buildId":"wrong","profileId":"test"}`, `{"protocolMajor":2,"protocolMinor":0,"buildId":"build","profileId":"other"}`} {
		if server(t).dispatch(context.Background(), request(seq(1), "core.handshake", body, nil)).Error == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}
func TestIdentityAndAvailability(t *testing.T) {
	s := server(t)
	handshake(s)
	ctx := s.context()
	for _, method := range []string{"computer.workspace.read", "task.create", "chat.turn", "release.status"} {
		id := nextID(s)
		raw := request(id, method, `{}`, &ctx)
		if method == "task.create" || method == "chat.turn" {
			var call wire.Request
			json.Unmarshal(raw, &call)
			call.Params.OperationId = optional("exact-op")
			raw, _ = json.Marshal(call)
		}
		r := s.dispatch(context.Background(), raw)
		if r.Result == nil || r.Result.Status != "unavailable" || r.Result.RequestId != id {
			t.Fatalf("%+v", r)
		}
	}
	r := s.dispatch(context.Background(), request(nextID(s), "core.operation.status", `{}`, &ctx))
	if r.Result.Status != "unsupported" {
		t.Fatal(r)
	}
	if s.dispatch(context.Background(), request(nextID(s), "eval", `{}`, &ctx)).Error.Code != -32601 {
		t.Fatal("unknown method admitted")
	}
	ctx.BackendGeneration = "old"
	if s.dispatch(context.Background(), request(nextID(s), "core.status", `{}`, &ctx)).Error.Code != -32002 {
		t.Fatal("stale generation admitted")
	}
	ctx = s.context()
	status := nextID(s)
	r = s.dispatch(context.Background(), request(status, "core.status", `{ }`, &ctx))
	if r.Result == nil || r.Result.Status != "ok" {
		t.Fatal(r)
	}
	if s.dispatch(context.Background(), request(status, "core.status", `{}`, &ctx)).Error == nil {
		t.Fatal("duplicate ID admitted")
	}
}
func TestMalformedAndResponseLoss(t *testing.T) {
	s := server(t)
	for _, data := range []string{`{"id":"a","id":"b"}`, `{"jsonrpc":"2.0","id":42,"method":"core.status","params":{"body":{}}}`, `{"jsonrpc":"2.0","id":"a","method":"core.status","params":{"body":{}},"extra":true}`} {
		if s.dispatch(context.Background(), []byte(data)).Error == nil {
			t.Fatalf("accepted %s", data)
		}
	}
	var in bytes.Buffer
	ipc.WriteFrame(&in, request(seq(1), "core.handshake", helloBody, nil))
	if err := server(t).Serve(context.Background(), io.NopCloser(&in), failedWriter{}); err == nil {
		t.Fatal("lost response marked success")
	}
}

type failedWriter struct{}

func (failedWriter) Write([]byte) (int, error) { return 0, errors.New("lost") }
func (failedWriter) Close() error              { return nil }
func TestRegisteredReadAndOperationIdentity(t *testing.T) {
	count := 0
	read := seq(2)
	s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{"computer.workspace.read": {Handle: func(_ context.Context, r Request) (*Outcome, error) {
		count++
		if r.RequestID != read || r.OperationID != "" {
			t.Fatal(r)
		}
		return &Outcome{Status: "refused", Code: "workspace_not_approved"}, nil
	}}}})
	if err != nil {
		t.Fatal(err)
	}
	handshake(s)
	ctx := s.context()
	data := request(read, "computer.workspace.read", `{}`, &ctx)
	if r := s.dispatch(context.Background(), data); r.Result.Status != "refused" || count != 1 {
		t.Fatal(r, count)
	}
	if s.dispatch(context.Background(), data).Error == nil || count != 1 {
		t.Fatal("duplicate dispatch")
	}
}

func TestServeCancellationInterruptsIdleInput(t *testing.T) {
	in, producer := io.Pipe()
	defer producer.Close()
	out := &closedWriter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	terminal := make(chan error, 1)
	started := make(chan struct{})
	go func() {
		terminal <- serverForCancellation().Serve(ctx, &observedReader{ReadCloser: in, started: started}, out)
	}()
	<-started
	cancel()
	select {
	case err := <-terminal:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("idle read retained after cancellation")
	}
	if !out.closed {
		t.Fatal("owned output not closed")
	}
}

func TestServeCancellationInterruptsBlockedOutput(t *testing.T) {
	var input bytes.Buffer
	if err := ipc.WriteFrame(&input, request(seq(1), "core.handshake", helloBody, nil)); err != nil {
		t.Fatal(err)
	}
	consumer, out := io.Pipe()
	defer consumer.Close()
	started := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	terminal := make(chan error, 1)
	go func() {
		terminal <- serverForCancellation().Serve(ctx, io.NopCloser(&input), &observedWriter{PipeWriter: out, started: started})
	}()
	<-started
	cancel()
	select {
	case err := <-terminal:
		if err == nil {
			t.Fatal("undelivered response reported success")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked write retained after cancellation")
	}
}
func serverForCancellation() *Server {
	s, _ := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation"})
	return s
}

type closedWriter struct{ closed bool }

func (*closedWriter) Write(p []byte) (int, error) { return len(p), nil }
func (w *closedWriter) Close() error              { w.closed = true; return nil }

type observedWriter struct {
	*io.PipeWriter
	started chan struct{}
}

func (w *observedWriter) Write(p []byte) (int, error) { close(w.started); return w.PipeWriter.Write(p) }

type observedReader struct {
	io.ReadCloser
	started chan struct{}
}

func (r *observedReader) Read(p []byte) (int, error) { close(r.started); return r.ReadCloser.Read(p) }

func TestHandshakeEquivalentIntegerSpellings(t *testing.T) {
	for _, number := range []string{"2", "2.0", "2e0", "20e-1", "2.00000000000000001", "1.99999999999999999"} {
		response := server(t).dispatch(context.Background(), request(seq(1), "core.handshake", `{"protocolMajor":`+number+`,"protocolMinor":0.0,"buildId":"build","profileId":"test"}`, nil))
		if response.Result == nil || response.Result.Status != "ok" {
			t.Fatalf("%s: %+v", number, response)
		}
	}
}

// The lifetime attempt budget is gone; a peer that only sends requests
// refused before any owner runs is cut off after a short consecutive bound,
// and any admitted request resets it.
func TestServeBoundsConsecutiveInvalidRequests(t *testing.T) {
	bound := wire.MaxConsecutiveInvalidRequests
	ctx := &wire.Context{ProfileId: "test", BackendGeneration: "generation"}
	for _, invalid := range []struct {
		name  string
		frame func(i int) []byte
	}{
		{"malformed", func(int) []byte { return []byte(`{}`) }},
		{"unsequenced", func(i int) []byte { return request(fmt.Sprintf("status-%d", i), "core.status", `{}`, ctx) }},
		{"replayed", func(int) []byte { return request(seq(1), "core.status", `{}`, ctx) }},
		{"skipped", func(i int) []byte { return request(seq(uint64(i)+3), "core.status", `{}`, ctx) }},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			var frames bytes.Buffer
			_ = ipc.WriteFrame(&frames, request(seq(1), "core.handshake", helloBody, nil))
			for i := 0; i < bound+1; i++ {
				_ = ipc.WriteFrame(&frames, invalid.frame(i))
			}
			input := bytes.NewReader(frames.Bytes())
			out := &bufferWriter{}
			err := server(t).Serve(context.Background(), io.NopCloser(input), out)
			if err == nil || err.Error() != "consecutive invalid request bound exhausted" {
				t.Fatalf("bound: %v", err)
			}
			if input.Len() == 0 {
				t.Fatal("read a frame after the consecutive invalid bound")
			}
			count := 0
			for out.Len() > 0 {
				raw, err := ipc.ReadFrame(out)
				if err != nil {
					t.Fatal(err)
				}
				var response wire.Response
				if err := json.Unmarshal(raw, &response); err != nil {
					t.Fatal(err)
				}
				if count > 0 && response.Error == nil {
					t.Fatalf("invalid request admitted: %+v", response)
				}
				count++
			}
			if count != bound+1 {
				t.Fatalf("responses: %d", count)
			}
		})
	}
	t.Run("reset by an admitted request", func(t *testing.T) {
		var frames bytes.Buffer
		_ = ipc.WriteFrame(&frames, request(seq(1), "core.handshake", helloBody, nil))
		sequence := uint64(1)
		for round := 0; round < 3; round++ {
			for i := 0; i < bound-1; i++ {
				_ = ipc.WriteFrame(&frames, []byte(`{}`))
			}
			sequence++
			_ = ipc.WriteFrame(&frames, request(seq(sequence), "core.status", `{}`, ctx))
		}
		if err := server(t).Serve(context.Background(), io.NopCloser(&frames), &bufferWriter{}); err != nil {
			t.Fatalf("interleaved invalid requests ended a valid stream: %v", err)
		}
	})
}

type bufferWriter struct{ bytes.Buffer }

func (*bufferWriter) Close() error { return nil }

func TestServeBoundsOwnerOutputBeforeEncoding(t *testing.T) {
	for _, data := range []json.RawMessage{json.RawMessage(`"` + strings.Repeat("a", ipc.MaxFrameBytes) + `"`), json.RawMessage(`"` + strings.Repeat("<", 262144) + `"`)} {
		var frames bytes.Buffer
		_ = ipc.WriteFrame(&frames, request(seq(1), "core.handshake", helloBody, nil))
		_ = ipc.WriteFrame(&frames, request(seq(2), "computer.workspace.read", `{}`, &wire.Context{ProfileId: "test", BackendGeneration: "generation"}))
		_ = ipc.WriteFrame(&frames, request(seq(3), "core.status", `{}`, &wire.Context{ProfileId: "test", BackendGeneration: "generation"}))
		s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{"computer.workspace.read": {Handle: func(context.Context, Request) (*Outcome, error) { return &Outcome{Status: "ok", Data: data}, nil }}}})
		if err != nil {
			t.Fatal(err)
		}
		out := &bufferWriter{}
		if err := s.Serve(context.Background(), io.NopCloser(&frames), out); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 3; i++ {
			raw, err := ipc.ReadFrame(out)
			if err != nil {
				t.Fatal(err)
			}
			var response wire.Response
			if err := json.Unmarshal(raw, &response); err != nil {
				t.Fatal(err)
			}
			if i == 1 {
				if response.Result == nil || response.Result.Status != "unknown" || response.Result.Data != nil || response.Result.Code == nil || *response.Result.Code != "owner_output_bound" {
					t.Fatalf("bounded owner: %+v", response)
				}
			} else if response.Result == nil || response.Result.Status != "ok" {
				t.Fatalf("unrelated response: %+v", response)
			}
		}
	}
}

func TestServeNormalEOFClosesOwnedOutput(t *testing.T) {
	in, producer := io.Pipe()
	_ = producer.Close()
	consumer, out := io.Pipe()
	defer consumer.Close()
	eof := make(chan error, 1)
	go func() { _, err := io.ReadAll(consumer); eof <- err }()
	if err := server(t).Serve(context.Background(), in, out); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-eof:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("owned output retained after EOF")
	}
}

func TestServeHeaderOnlyTruncation(t *testing.T) {
	output := &closedWriter{}
	err := server(t).Serve(context.Background(), io.NopCloser(bytes.NewReader([]byte{0, 0, 0, 3})), output)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("header-only truncation: %v", err)
	}
	if !output.closed {
		t.Fatal("owned output retained after truncation")
	}
}

func TestCanonicalMethodOperationIdentity(t *testing.T) {
	for _, test := range []struct {
		name   string
		effect bool
	}{{"task.create", true}, {"chat.turn", true}, {"computer.workspace.read", false}, {"release.status", false}} {
		for _, hasOperation := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/operation=%t", test.name, hasOperation), func(t *testing.T) {
				calls := 0
				probe := seq(2)
				s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{test.name: {Handle: func(_ context.Context, r Request) (*Outcome, error) {
					calls++
					if r.RequestID != probe {
						t.Fatal(r)
					}
					if hasOperation && r.OperationID != "exact-operation-1" {
						t.Fatal(r)
					}
					return &Outcome{Status: "ok"}, nil
				}}}})
				if err != nil {
					t.Fatal(err)
				}
				handshake(s)
				bound := s.context()
				call := wire.Call{Context: &bound, Body: json.RawMessage(`{}`)}
				if hasOperation {
					id := "exact-operation-1"
					call.OperationId = &id
				}
				raw, _ := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: probe, Method: test.name, Params: call})
				response := s.dispatch(context.Background(), raw)
				if test.effect != hasOperation {
					if response.Error == nil || response.Error.Code != -32602 || calls != 0 {
						t.Fatalf("missing/extra identity dispatched: %+v calls=%d", response, calls)
					}
				} else {
					if response.Result == nil || response.Result.Status != "ok" || response.Result.RequestId != probe || calls != 1 {
						t.Fatalf("valid identity: %+v calls=%d", response, calls)
					}
					if hasOperation && (response.Result.OperationId == nil || *response.Result.OperationId != "exact-operation-1") {
						t.Fatal("operation identity lost")
					}
				}
			})
		}
	}
}

func TestOperationIdentityBeforeAvailability(t *testing.T) {
	for _, test := range []struct {
		method    string
		operation *string
	}{{"computer.workspace.read", optional("op")}, {"core.operation.status", optional("op")}, {"task.create", nil}, {"chat.turn", nil}} {
		s := server(t)
		handshake(s)
		bound := s.context()
		raw, _ := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: nextID(s), Method: test.method, Params: wire.Call{Context: &bound, OperationId: test.operation, Body: json.RawMessage(`{}`)}})
		if response := s.dispatch(context.Background(), raw); response.Error == nil || response.Error.Code != -32602 {
			t.Fatalf("%s: malformed identity admitted %+v", test.method, response)
		}
	}
}

type captureWriter struct{ bytes.Buffer }

func (*captureWriter) Close() error { return nil }
func TestMalformedOwnerOutputIsContained(t *testing.T) {
	for _, bad := range []Outcome{{Status: "invalid"}, {Status: "ok", Data: json.RawMessage(`{`)}, {Status: "ok", Code: "bad\ncode"}, {Status: "ok", Data: json.RawMessage(`"\ud800"`)}, {Status: "ok", Data: json.RawMessage(`{"x":1,"x":2}`)}} {
		calls := 0
		s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{"task.create": {Handle: func(context.Context, Request) (*Outcome, error) { calls++; return &bad, nil }}}})
		if err != nil {
			t.Fatal(err)
		}
		var input bytes.Buffer
		ipc.WriteFrame(&input, request(seq(1), "core.handshake", helloBody, nil))
		bound := s.context()
		effect, _ := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: seq(2), Method: "task.create", Params: wire.Call{Context: &bound, OperationId: optional("exact-op"), Body: json.RawMessage(`{}`)}})
		ipc.WriteFrame(&input, effect)
		ipc.WriteFrame(&input, request(seq(3), "core.status", `{}`, &bound))
		output := &captureWriter{}
		if err := s.Serve(context.Background(), io.NopCloser(&input), output); err != nil {
			t.Fatalf("optional owner closed pipe: %v", err)
		}
		for index := 0; index < 3; index++ {
			raw, err := ipc.ReadFrame(&output.Buffer)
			if err != nil {
				t.Fatal(err)
			}
			var result wire.Response
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			if index == 1 {
				if result.Result == nil || result.Result.Status != "unknown" || result.Result.Code == nil || *result.Result.Code != "owner_output_invalid" || result.Result.RequestId != seq(2) || result.Result.Context != bound || result.Id == nil || *result.Id != seq(2) || result.Result.OperationId == nil || *result.Result.OperationId != "exact-op" || len(result.Result.Data) != 0 {
					t.Fatalf("uncorrelated invalid owner: %+v", result)
				}
			} else if result.Result == nil || result.Result.Status != "ok" {
				t.Fatalf("unrelated reply lost: %+v", result)
			}
		}
		if calls != 1 {
			t.Fatalf("owner replayed %d times", calls)
		}
	}
}
