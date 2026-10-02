package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
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
