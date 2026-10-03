package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/domain"
)

func TestSourceOnlyStrictJSON(t *testing.T) {
	for _, raw := range [][]byte{[]byte(`{"id":1,"id":2}`), []byte(`{"nested":{"x":1,"x":2}}`), []byte(`{} {}`), []byte(`null`), []byte(`[]`), {123, 34, 120, 34, 58, 34, 255, 34, 125}, []byte(strings.Repeat(`{"x":`, 70) + `0` + strings.Repeat("}", 70))} {
		if _, err := parse(raw); err == nil {
			t.Fatalf("accepted malformed JSON of %d bytes", len(raw))
		}
	}
	if _, err := parse([]byte(`{"extensions":{"legal":true},"id":1}`)); err != nil {
		t.Fatal(err)
	}
}
func TestSourceOnlyConnectionEpochChangeFencesBeforeMutation(t *testing.T) {
	c, f := newFixture(t)
	f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
		if q.method == "model/list" {
			raw, _ := json.Marshal(map[string]any{"method": "account/updated", "params": map[string]any{}})
			return fixtureSend(conn, 1, raw)
		}
		return nil
	}
	r, _ := c.Create(context.Background(), dispatch(c.selection, "changed-epoch"), func(task.Reference) error { t.Fatal("epoch change published lineage"); return nil })
	if r.State != task.Rejected || len(f.seen("thread/start")) != 0 {
		t.Fatal("changed epoch allowed effect")
	}
}
func TestSourceOnlySharedConsentIsUnanswered(t *testing.T) {
	for _, method := range []string{"item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request", "execCommandApproval", "applyPatchApproval"} {
		t.Run(method, func(t *testing.T) {
			c, f := newFixture(t)
			f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
				if q.method == "model/list" {
					raw, _ := json.Marshal(map[string]any{"id": "unowned-consent", "method": method, "params": map[string]any{}})
					return fixtureSend(conn, 1, raw)
				}
				return nil
			}
			// The peer accepts only actual client method requests, so an error/answer
			// to consent would close it before the project catalogue can complete.
			if caps, err := c.Supports(context.Background(), c.selection.Binding); err != nil || !caps.Create {
				t.Fatalf("consent answered or blocked reader: %+v %v", caps, err)
			}
		})
	}
}
func TestSourceOnlyUnownedServerRequestGetsNoApproval(t *testing.T) {
	c, f := newFixture(t)
	answered := false
	f.beforeReply = func(q fixtureRequest, conn net.Conn, r *bufio.Reader) error {
		if q.method != "model/list" {
			return nil
		}
		raw, _ := json.Marshal(map[string]any{"id": "unowned-tool", "method": "item/tool/call", "params": map[string]any{}})
		if err := fixtureSend(conn, 1, raw); err != nil {
			return err
		}
		_, reply, err := fixtureRead(r)
		if err != nil {
			return err
		}
		m, err := parse(reply)
		if err != nil {
			return err
		}
		e, ok := object(m, "error")
		answered = equals(m, "id", "unowned-tool") && ok && string(e["code"]) == "-32601"
		return nil
	}
	if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil || !answered {
		t.Fatal("unsupported request response missing or not exact")
	}
}
func TestSourceOnlyPingUsesMaskedPong(t *testing.T) {
	c, f := newFixture(t)
	pong := false
	f.beforeReply = func(q fixtureRequest, conn net.Conn, r *bufio.Reader) error {
		if q.method != "model/list" {
			return nil
		}
		if err := fixtureSend(conn, 9, []byte("fixture-ping")); err != nil {
			return err
		}
		op, raw, err := fixtureRead(r)
		pong = op == 10 && string(raw) == "fixture-ping"
		return err
	}
	if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil || !pong {
		t.Fatal("ping handling failed")
	}
}

type memoryStream struct {
	io.Reader
	writer bytes.Buffer
}

func (s *memoryStream) Write(b []byte) (int, error) { return s.writer.Write(b) }
func (*memoryStream) Close() error                  { return nil }
func TestSourceOnlyFragmentedWebSocketAndInvalidFrames(t *testing.T) {
	valid := []byte{0x01, 2, 'h', 'i', 0x80, 1, '!'}
	s := &memoryStream{Reader: bytes.NewReader(valid)}
	message, err := newWebsocket(s).receive()
	if err != nil || string(message) != "hi!" {
		t.Fatalf("fragmentation: %q %v", message, err)
	}
	oversized := []byte{0x81, 127}
	oversized = binary.BigEndian.AppendUint64(oversized, maxMessageBytes+1)
	for name, raw := range map[string][]byte{"masked-server": {0x81, 0x80}, "binary": {0x82, 0}, "reserved": {0xc1, 0}, "bad-continuation": {0x80, 0}, "nonminimal-length": {0x81, 126, 0, 1}, "oversized": oversized, "bad-utf8": {0x81, 1, 255}, "fragmented-control": {0x09, 0}, "interleaved-message": {0x01, 1, 'x', 0x81, 1, 'y'}} {
		t.Run(name, func(t *testing.T) {
			if _, err := newWebsocket(&memoryStream{Reader: bytes.NewReader(raw)}).receive(); err == nil {
				t.Fatal("invalid frame accepted")
			}
		})
	}
}
func TestSourceOnlyInvalidSelectionIsInert(t *testing.T) {
	for _, mode := range []string{"provider", "relative-executable", "hash", "socket-root", "protocol", "schema", "sandbox", "approval", "grant", "root", "missing-boundary", "missing-grant-check", "missing-clock"} {
		t.Run(mode, func(t *testing.T) {
			s := testSelection()
			f := &pipeFixture{selection: s}
			o := Options{Selection: s, Boundary: f, Now: time.Now, Recheck: func(context.Context, task.Binding) error { return nil }}
			switch mode {
			case "provider":
				o.Selection.Binding.Provider = task.Claude
			case "relative-executable":
				o.Selection.ExecutablePath = "bin/codex"
			case "hash":
				o.Selection.ExecutableSHA256 = "not-a-digest"
			case "socket-root":
				o.Selection.SocketPath = "/"
			case "protocol":
				o.Selection.Protocol = "unknown"
			case "schema":
				o.Selection.SchemaSHA256 = ""
			case "sandbox":
				o.Selection.Sandbox = "danger-full-access"
			case "approval":
				o.Selection.ApprovalPolicy = "unknown"
			case "grant":
				o.Selection.ExpiresAt = o.Selection.GrantedAt
			case "root":
				o.Selection.Binding.Writer.Path = "/fixture/../other"
			case "missing-boundary":
				o.Boundary = nil
			case "missing-grant-check":
				o.Recheck = nil
			case "missing-clock":
				o.Now = nil
			}
			if _, err := New(o); !errors.Is(err, task.ErrInvalid) {
				t.Fatal("invalid selection accepted")
			}
			if f.launches.Load() != 0 || f.checks.Load() != 0 {
				t.Fatal("invalid selection performed OS operations")
			}
		})
	}
}
func TestSourceOnlyPanicInProgressRemainsUnknown(t *testing.T) {
	c, f := newFixture(t)
	r, _ := c.Create(context.Background(), dispatch(c.selection, "panic-callback"), func(task.Reference) error { panic("source-only callback failure") })
	if r.State != task.Uncertain || len(f.seen("turn/start")) != 0 {
		t.Fatal("panic broke the mutation fence")
	}
}
func TestSourceOnlyConcurrentOperationReplaysNeverDispatchTwice(t *testing.T) {
	c, f := newFixture(t)
	d := dispatch(c.selection, "same-concurrent-operation")
	var wg sync.WaitGroup
	states := make(chan task.ReceiptState, 2)
	for range 2 {
		wg.Go(func() {
			r, _ := c.Create(context.Background(), d, func(task.Reference) error { return nil })
			states <- r.State
		})
	}
	wg.Wait()
	close(states)
	known := 0
	unknown := 0
	for s := range states {
		if s == task.Known {
			known++
		}
		if s == task.Uncertain {
			unknown++
		}
	}
	if known != 1 || unknown != 1 || len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 1 {
		t.Fatal("concurrent operation fence failed")
	}
}
func TestSourceOnlyCallerCancellationDoesNotReconnect(t *testing.T) {
	c, f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	f.beforeReply = func(q fixtureRequest, _ net.Conn, _ *bufio.Reader) error {
		if q.method == "thread/start" {
			cancel()
		}
		return nil
	}
	r, _ := c.Create(ctx, dispatch(c.selection, "cancelled-request"), func(task.Reference) error { return nil })
	if r.State != task.Uncertain {
		t.Fatal("cancelled possible mutation lost uncertainty")
	}
	_, _ = c.Supports(context.Background(), c.selection.Binding)
	if f.launches.Load() != 1 || len(f.seen("turn/start")) != 0 {
		t.Fatal("cancellation caused reconnect/effect")
	}
}

func TestSourceOnlyRPCErrorAfterPossibleMutationIsUnknown(t *testing.T) {
	c, f := newFixture(t)
	f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
		if q.method != "turn/start" {
			return nil
		}
		raw, _ := json.Marshal(map[string]any{"id": q.id, "error": map[string]any{"code": -32603, "message": "synthetic source-only error"}})
		if err := fixtureSend(conn, 1, raw); err != nil {
			return err
		}
		return errors.New("fixture completed its error response")
	}
	r, _ := c.Create(context.Background(), dispatch(c.selection, "rpc-error"), func(task.Reference) error { return nil })
	if r.State != task.Uncertain || r.Reference != (task.Reference{ThreadID: "thread-exact"}) {
		t.Fatalf("RPC error misclassified: %+v", r)
	}
	again, _ := c.Create(context.Background(), dispatch(c.selection, "after-rpc-error"), func(task.Reference) error { return nil })
	if again.State != task.Uncertain || len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 1 {
		t.Fatal("RPC error authorized mutation retry")
	}
}
func TestSourceOnlyFullLocalOperationFenceHasNoEffect(t *testing.T) {
	c, f := newFixture(t)
	for i := 0; i < maxOperations; i++ {
		c.used[strings.Repeat("x", i/128)+string(rune(i%128))] = [32]byte{}
	}
	r, _ := c.Create(context.Background(), dispatch(c.selection, "over-capacity"), func(task.Reference) error { t.Fatal("capacity callback"); return nil })
	if r.State != task.Rejected || r.Code != "CODEX_OPERATION_CAPACITY" || f.launches.Load() != 0 {
		t.Fatal("full fence dispatched or evicted an operation")
	}
}
