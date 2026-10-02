package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
func handshake(s *Server) wire.Response {
	return s.dispatch(context.Background(), request("hello", "core.handshake", `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, nil))
}
func TestHandshakeBeforeCommands(t *testing.T) {
	s := server(t)
	if s.dispatch(context.Background(), request("no", "core.status", `{}`, nil)).Error == nil {
		t.Fatal("unhandshaken status")
	}
	if handshake(s).Result == nil {
		t.Fatal("valid handshake refused")
	}
	for _, body := range []string{`{"protocolMajor":2,"protocolMinor":0,"buildId":"build","profileId":"test"}`, `{"protocolMajor":1,"protocolMinor":1,"buildId":"build","profileId":"test"}`, `{"protocolMajor":1,"protocolMinor":0,"buildId":"wrong","profileId":"test"}`, `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"other"}`} {
		if server(t).dispatch(context.Background(), request("hello", "core.handshake", body, nil)).Error == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}
func TestIdentityAndAvailability(t *testing.T) {
	s := server(t)
	handshake(s)
	ctx := s.context()
	for _, method := range []string{"computer.workspace.read", "task.create", "chat.turn", "release.status"} {
		r := s.dispatch(context.Background(), request(method, method, `{}`, &ctx))
		if r.Result == nil || r.Result.Status != "unavailable" || r.Result.RequestId != method {
			t.Fatalf("%+v", r)
		}
	}
	r := s.dispatch(context.Background(), request("unsupported", "core.operation.status", `{}`, &ctx))
	if r.Result.Status != "unsupported" {
		t.Fatal(r)
	}
	if s.dispatch(context.Background(), request("unknown", "eval", `{}`, &ctx)).Error.Code != -32601 {
		t.Fatal("unknown method admitted")
	}
	ctx.BackendGeneration = "old"
	if s.dispatch(context.Background(), request("stale", "core.status", `{}`, &ctx)).Error.Code != -32002 {
		t.Fatal("stale generation admitted")
	}
	ctx = s.context()
	r = s.dispatch(context.Background(), request("status", "core.status", `{ }`, &ctx))
	if r.Result == nil || r.Result.Status != "ok" {
		t.Fatal(r)
	}
	if s.dispatch(context.Background(), request("status", "core.status", `{}`, &ctx)).Error == nil {
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
	ipc.WriteFrame(&in, request("hello", "core.handshake", `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, nil))
	if err := server(t).Serve(context.Background(), io.NopCloser(&in), failedWriter{}); err == nil {
		t.Fatal("lost response marked success")
	}
}

type failedWriter struct{}

func (failedWriter) Write([]byte) (int, error) { return 0, errors.New("lost") }
func (failedWriter) Close() error              { return nil }
func TestRegisteredReadAndOperationIdentity(t *testing.T) {
	count := 0
	s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{"computer.workspace.read": {Handle: func(_ context.Context, r Request) (*Outcome, error) {
		count++
		if r.RequestID != "read" || r.OperationID != "" {
			t.Fatal(r)
		}
		return &Outcome{Status: "refused", Code: "workspace_not_approved"}, nil
	}}}})
	if err != nil {
		t.Fatal(err)
	}
	handshake(s)
	ctx := s.context()
	data := request("read", "computer.workspace.read", `{}`, &ctx)
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
	if err := ipc.WriteFrame(&input, request("hello", "core.handshake", `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, nil)); err != nil {
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
	for _, number := range []string{"1", "1.0", "1e0", "10e-1", "1.00000000000000001", "0.99999999999999999"} {
		response := server(t).dispatch(context.Background(), request("hello", "core.handshake", `{"protocolMajor":`+number+`,"protocolMinor":0.0,"buildId":"build","profileId":"test"}`, nil))
		if response.Result == nil || response.Result.Status != "ok" {
			t.Fatalf("%s: %+v", number, response)
		}
	}
}

func TestServeHardAttemptBudgetIncludesInvalidRequests(t *testing.T) {
	for _, invalid := range []bool{false, true} {
		var frames bytes.Buffer
		for i := 0; i < 4097; i++ {
			body := []byte(`{}`)
			if !invalid {
				if i == 0 {
					body = request("hello", "core.handshake", `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, nil)
				} else {
					body = request(fmt.Sprintf("status-%d", i), "core.status", `{}`, &wire.Context{ProfileId: "test", BackendGeneration: "generation"})
				}
			}
			if err := ipc.WriteFrame(&frames, body); err != nil {
				t.Fatal(err)
			}
		}
		input := bytes.NewReader(frames.Bytes())
		out := &bufferWriter{}
		err := server(t).Serve(context.Background(), io.NopCloser(input), out)
		if err == nil || err.Error() != "request attempt budget exhausted" {
			t.Fatalf("budget: %v", err)
		}
		if input.Len() == 0 {
			t.Fatal("admitted frame after attempt limit")
		}
		count := 0
		for out.Len() > 0 {
			if _, err := ipc.ReadFrame(out); err != nil {
				t.Fatal(err)
			}
			count++
		}
		if count != 4096 {
			t.Fatalf("responses: %d", count)
		}
	}
}

type bufferWriter struct{ bytes.Buffer }

func (*bufferWriter) Close() error { return nil }

func TestServeBoundsOwnerOutputBeforeEncoding(t *testing.T) {
	for _, data := range []json.RawMessage{json.RawMessage(`"` + strings.Repeat("a", ipc.MaxFrameBytes) + `"`), json.RawMessage(`"` + strings.Repeat("<", 262144) + `"`)} {
		var frames bytes.Buffer
		_ = ipc.WriteFrame(&frames, request("hello", "core.handshake", `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, nil))
		_ = ipc.WriteFrame(&frames, request("read", "computer.workspace.read", `{}`, &wire.Context{ProfileId: "test", BackendGeneration: "generation"}))
		_ = ipc.WriteFrame(&frames, request("status", "core.status", `{}`, &wire.Context{ProfileId: "test", BackendGeneration: "generation"}))
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
				s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{test.name: {Handle: func(_ context.Context, r Request) (*Outcome, error) {
					calls++
					if r.RequestID != "probe" {
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
				raw, _ := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: "probe", Method: test.name, Params: call})
				response := s.dispatch(context.Background(), raw)
				if test.effect != hasOperation {
					if response.Error == nil || response.Error.Code != -32602 || calls != 0 {
						t.Fatalf("missing/extra identity dispatched: %+v calls=%d", response, calls)
					}
				} else {
					if response.Result == nil || response.Result.Status != "ok" || response.Result.RequestId != "probe" || calls != 1 {
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
