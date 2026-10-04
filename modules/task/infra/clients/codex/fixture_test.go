package codex

// Source-only peer over net.Pipe: no native socket, executable, account, provider,
// filesystem qualification or child-process cleanup evidence is produced here.
import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type fixtureRequest struct {
	id     json.RawMessage
	method string
	params map[string]json.RawMessage
}
type pipeFixture struct {
	valid        atomic.Bool
	launches     atomic.Int32
	checks       atomic.Int32
	closes       atomic.Int32
	mu           sync.Mutex
	requests     []fixtureRequest
	selection    Selection
	handle       func(fixtureRequest) (any, bool)
	beforeReply  func(fixtureRequest, net.Conn, *bufio.Reader) error
	badHandshake bool
	badID        string
	launchError  bool
	waitUnknown  bool
}
type pipeProcess struct {
	net.Conn
	fixture *pipeFixture
	done    chan struct{}
	once    sync.Once
}

func (p *pipeProcess) Close() error {
	var err error
	p.once.Do(func() { p.fixture.closes.Add(1); err = p.Conn.Close() })
	return err
}
func (p *pipeProcess) Wait(ctx context.Context) error {
	if p.fixture.waitUnknown {
		return task.ErrUnknown
	}
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return task.ErrUnknown
	}
}
func (f *pipeFixture) Verify(ctx context.Context, s Selection) error {
	f.checks.Add(1)
	if !f.valid.Load() || s != f.selection || ctx.Err() != nil {
		return task.ErrIdentity
	}
	return nil
}
func (f *pipeFixture) Launch(ctx context.Context, s Selection) (Process, error) {
	f.launches.Add(1)
	if f.launchError {
		return nil, task.ErrUnavailable
	}
	client, server := net.Pipe()
	p := &pipeProcess{Conn: client, fixture: f, done: make(chan struct{})}
	go func() {
		defer close(p.done)
		defer server.Close()
		reader := bufio.NewReader(server)
		if fixtureUpgrade(server, reader, f.badHandshake) != nil {
			return
		}
		for {
			op, raw, err := fixtureRead(reader)
			if err != nil {
				return
			}
			if op != 1 {
				return
			}
			m, err := parse(raw)
			if err != nil {
				return
			}
			method, ok := str(m, "method")
			if !ok {
				return
			}
			if method == "initialized" {
				continue
			}
			params, ok := object(m, "params")
			if !ok {
				return
			}
			request := fixtureRequest{id: m["id"], method: method, params: params}
			f.mu.Lock()
			f.requests = append(f.requests, request)
			f.mu.Unlock()
			result, drop := f.response(request)
			if f.handle != nil {
				result, drop = f.handle(request)
			}
			if drop {
				return
			}
			if f.beforeReply != nil {
				if f.beforeReply(request, server, reader) != nil {
					return
				}
			}
			id := request.id
			if f.badID == method {
				id = json.RawMessage("99999")
			}
			response, err := json.Marshal(map[string]any{"id": id, "result": result})
			if err != nil {
				return
			}
			if fixtureSend(server, 1, response) != nil {
				return
			}
		}
	}()
	return p, nil
}
func fixtureUpgrade(w io.Writer, r *bufio.Reader, bad bool) error {
	line, err := r.ReadString('\n')
	if err != nil || line != "GET /rpc HTTP/1.1\r\n" {
		return fmt.Errorf("bad fixture upgrade")
	}
	key := ""
	for {
		line, err = r.ReadString('\n')
		if err != nil {
			return err
		}
		if line == "\r\n" {
			break
		}
		if strings.HasPrefix(line, "Sec-WebSocket-Key: ") {
			key = strings.TrimSpace(strings.TrimPrefix(line, "Sec-WebSocket-Key: "))
		}
	}
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(h[:])
	if bad {
		accept = "invalid"
	}
	return writeAll(w, []byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n"))
}
func fixtureRead(r io.Reader) (byte, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	if h[0]&0x80 == 0 || h[1]&0x80 == 0 {
		return 0, nil, fmt.Errorf("unmasked/non-final client frame")
	}
	size := uint64(h[1] & 127)
	if size == 126 {
		var n [2]byte
		if _, err := io.ReadFull(r, n[:]); err != nil {
			return 0, nil, err
		}
		size = uint64(binary.BigEndian.Uint16(n[:]))
	} else if size == 127 {
		var n [8]byte
		if _, err := io.ReadFull(r, n[:]); err != nil {
			return 0, nil, err
		}
		size = binary.BigEndian.Uint64(n[:])
	}
	if size > maxMessageBytes {
		return 0, nil, fmt.Errorf("oversized fixture request")
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return 0, nil, err
	}
	raw := make([]byte, int(size))
	if _, err := io.ReadFull(r, raw); err != nil {
		return 0, nil, err
	}
	for i := range raw {
		raw[i] ^= mask[i%4]
	}
	return h[0] & 15, raw, nil
}
func fixtureSend(w io.Writer, op byte, raw []byte) error {
	h := []byte{0x80 | op, 0}
	if len(raw) < 126 {
		h[1] = byte(len(raw))
	} else if len(raw) <= 65535 {
		h[1] = 126
		h = binary.BigEndian.AppendUint16(h, uint16(len(raw)))
	} else {
		h[1] = 127
		h = binary.BigEndian.AppendUint64(h, uint64(len(raw)))
	}
	return writeAll(w, append(h, raw...))
}
func (f *pipeFixture) response(r fixtureRequest) (any, bool) {
	s := f.selection
	b := s.Binding
	switch r.method {
	case "initialize":
		return map[string]any{"codexHome": s.ExpectedCodexHome, "platformFamily": "unix", "platformOs": "macos", "userAgent": "source-only-fixture"}, false
	case "model/list":
		return map[string]any{"data": []any{map[string]any{"id": "catalogue-id", "model": b.Model, "displayName": "Fixture Model", "hidden": false, "supportedReasoningEfforts": []any{map[string]any{"reasoningEffort": "high"}}, "defaultReasoningEffort": "high"}}, "nextCursor": nil}, false
	case "project/list":
		return map[string]any{"data": []any{map[string]any{"id": b.ProjectID, "roots": []any{map[string]any{"path": b.Project.Path}}}}, "nextCursor": nil}, false
	case "thread/start":
		kind := "readOnly"
		if s.Sandbox == "workspace-write" {
			kind = "workspaceWrite"
		}
		return map[string]any{"thread": map[string]any{"id": "thread-exact", "projectId": b.ProjectID}, "cwd": b.Writer.Path, "model": b.Model, "approvalPolicy": s.ApprovalPolicy, "sandbox": map[string]any{"type": kind}}, false
	case "turn/start":
		return map[string]any{"turn": map[string]any{"id": "turn-exact"}}, false
	case "thread/read":
		return map[string]any{"thread": map[string]any{"id": "thread-exact", "projectId": b.ProjectID, "cwd": b.Writer.Path, "model": b.Model}}, false
	case "thread/turns/list":
		return map[string]any{"data": []any{map[string]any{"id": "turn-exact", "status": "completed"}}, "nextCursor": nil}, false
	case "thread/items/list":
		return map[string]any{"data": []any{map[string]any{"turnId": "turn-exact", "item": map[string]any{"id": "final-exact", "type": "agentMessage", "phase": "final_answer", "text": "source-only final"}}}, "nextCursor": nil}, false
	}
	return nil, true
}
func (f *pipeFixture) seen(method string) []fixtureRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fixtureRequest
	for _, r := range f.requests {
		if r.method == method {
			out = append(out, r)
		}
	}
	return out
}
func testSelection() Selection {
	start := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	return Selection{Binding: task.Binding{Provider: task.Codex, ProfileID: "fixture-profile", HostID: "selected-host", ProjectID: "saved-project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "10", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "11", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "selected", Model: "fixture-model", Effort: "high", ConfigDigest: strings.Repeat("a", 64)}, ExecutablePath: "/fixture/bin/codex", ExecutableSHA256: strings.Repeat("b", 64), SocketPath: "/fixture/codex.sock", ExpectedCodexHome: "/fixture/provider-home", ScratchRoot: "/fixture/scratch", Protocol: "codex-app-server/v2", SchemaSHA256: strings.Repeat("c", 64), Sandbox: "workspace-write", ApprovalPolicy: "never", GrantedAt: start, ExpiresAt: start.Add(time.Hour)}
}
func newFixture(t *testing.T) (*Client, *pipeFixture) {
	t.Helper()
	s := testSelection()
	f := &pipeFixture{selection: s}
	f.valid.Store(true)
	c, err := New(Options{Selection: s, Boundary: f, Now: func() time.Time { return s.GrantedAt.Add(time.Minute) }, Recheck: func(context.Context, task.Binding) error { return nil }, RecheckDispatch: fixtureDispatchCheck})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = c.Close(ctx)
	})
	return c, f
}
func dispatch(s Selection, id string) port.Dispatch {
	return port.Dispatch{Intent: task.Intent{OperationID: id, TaskID: "task-exact", Digest: strings.Repeat("d", 64), Action: task.Create, Binding: s.Binding, Parent: task.Parent{ThreadID: "initiator", TurnID: "initiator-turn"}}, Message: "source-only bounded request"}
}
func completeRef() task.Reference {
	return task.Reference{ThreadID: "thread-exact", TurnID: "turn-exact"}
}

// Explicit fake policy, not native Parent/Task authority qualification.
func fixtureDispatchCheck(context.Context, task.Intent) error { return nil }
