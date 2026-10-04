package boot

// Source-only aggregate: shipping TaskRuntime, Service, Owner and concrete Codex
// Client; existing atomic memory backing port and a strict net.Pipe RPC script.
// No native socket/process, filesystem qualification, account or inference.
import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

type taskIngressTestRPC struct {
	ID     json.RawMessage            `json:"id"`
	Method string                     `json:"method"`
	Params map[string]json.RawMessage `json:"params"`
}
type taskIngressTestTurn struct{ ID, Status string }
type taskIngressTestPipe struct {
	selection      codexclient.Selection
	mu             sync.Mutex
	requests       []taskIngressTestRPC
	replyError     string
	turns          []taskIngressTestTurn
	launches       atomic.Int32
	readReplyBytes atomic.Int64
	dropTurn       bool
	bareRead       bool
	notifications  func(taskIngressTestRPC) [][]byte
}
type taskIngressTestProcess struct {
	net.Conn
	done <-chan struct{}
}

func (p *taskIngressTestProcess) Wait(ctx context.Context) error {
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return task.ErrUnknown
	}
}
func (f *taskIngressTestPipe) Verify(ctx context.Context, s codexclient.Selection) error {
	if ctx.Err() != nil || s != f.selection {
		return task.ErrIdentity
	}
	return nil // A matching scripted value is not a native qualification.
}
func (f *taskIngressTestPipe) Launch(ctx context.Context, s codexclient.Selection) (codexclient.Process, error) {
	if err := f.Verify(ctx, s); err != nil {
		return nil, err
	}
	f.launches.Add(1)
	client, server := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer server.Close()
		reader := bufio.NewReader(server)
		line, err := reader.ReadString('\n')
		if err != nil || line != "GET /rpc HTTP/1.1\r\n" {
			return
		}
		key := ""
		for {
			line, err = reader.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
			if strings.HasPrefix(line, "Sec-WebSocket-Key: ") {
				key = strings.TrimSpace(strings.TrimPrefix(line, "Sec-WebSocket-Key: "))
			}
		}
		if key == "" {
			return
		}
		digest := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		if taskIngressTestWrite(server, []byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+base64.StdEncoding.EncodeToString(digest[:])+"\r\n\r\n")) != nil {
			return
		}
		for {
			raw, err := taskIngressTestFrame(reader)
			if err != nil {
				f.mu.Lock()
				f.replyError = "frame: " + err.Error()
				f.mu.Unlock()
				return
			}
			var req taskIngressTestRPC
			if json.Unmarshal(raw, &req) != nil {
				return
			}
			if req.Method == "initialized" && len(req.ID) == 0 {
				continue
			}
			if len(req.ID) == 0 || req.Params == nil {
				return
			}
			f.mu.Lock()
			f.requests = append(f.requests, req)
			out, err := f.reply(req)
			if err != nil {
				f.replyError = req.Method + ": " + err.Error()
			}
			drop := req.Method == "turn/start" && f.dropTurn
			notifications := f.notifications
			f.mu.Unlock()
			if err != nil || drop {
				return
			}
			if notifications != nil {
				for _, notification := range notifications(req) {
					if taskIngressTestSend(server, notification) != nil {
						return
					}
				}
			}
			response, err := json.Marshal(map[string]any{"id": req.ID, "result": out})
			if req.Method == "thread/read" {
				f.readReplyBytes.Store(int64(len(response)))
			}
			f.mu.Lock()
			f.mu.Unlock()
			if err != nil {
				return
			}
			if taskIngressTestSend(server, response) != nil {
				return
			}
		}
	}()
	return &taskIngressTestProcess{Conn: client, done: done}, nil
}
func taskIngressTestSend(w io.Writer, data []byte) error {
	header := []byte{0x81, 0}
	switch {
	case len(data) < 126:
		header[1] = byte(len(data))
	case len(data) <= 65535:
		header[1] = 126
		header = binary.BigEndian.AppendUint16(header, uint16(len(data)))
	default:
		header[1] = 127
		header = binary.BigEndian.AppendUint64(header, uint64(len(data)))
	}
	return taskIngressTestWrite(w, append(header, data...))
}
func taskIngressTestWrite(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrNoProgress
		}
		b = b[n:]
	}
	return nil
}
func taskIngressTestFrame(r io.Reader) ([]byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return nil, err
	}
	if h[0] != 0x81 || h[1]&0x80 == 0 {
		return nil, errors.New("non-text or unmasked script request")
	}
	size := uint64(h[1] & 127)
	if size == 126 {
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return nil, err
		}
		size = uint64(binary.BigEndian.Uint16(b[:]))
	} else if size == 127 {
		var b [8]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return nil, err
		}
		size = binary.BigEndian.Uint64(b[:])
	}
	if size > 65536 {
		return nil, errors.New("oversized script request")
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return nil, err
	}
	b := make([]byte, int(size))
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	for n := range b {
		b[n] ^= mask[n%4]
	}
	return b, nil
}
func taskIngressTestString(m map[string]json.RawMessage, key string) string {
	var s string
	_ = json.Unmarshal(m[key], &s)
	return s
}
func (f *taskIngressTestPipe) reply(q taskIngressTestRPC) (any, error) {
	b := f.selection.Binding
	switch q.Method {
	case "initialize":
		return map[string]any{"codexHome": f.selection.ExpectedCodexHome, "platformFamily": "unix", "platformOs": "macos", "userAgent": "CPU source script"}, nil
	case "model/list":
		return map[string]any{"data": []any{map[string]any{"id": "model-row", "model": b.Model, "displayName": "CPU Fixture", "hidden": false, "supportedReasoningEfforts": []any{map[string]any{"reasoningEffort": b.Effort}}, "defaultReasoningEffort": b.Effort}}, "nextCursor": nil}, nil
	case "project/list":
		return map[string]any{"data": []any{map[string]any{"id": b.ProjectID, "roots": []any{map[string]any{"path": b.Project.Path}}}}, "nextCursor": nil}, nil
	case "thread/start":
		if taskIngressTestString(q.Params, "projectId") != b.ProjectID || taskIngressTestString(q.Params, "cwd") != b.Writer.Path || taskIngressTestString(q.Params, "model") != b.Model || taskIngressTestString(q.Params, "approvalPolicy") != f.selection.ApprovalPolicy {
			return nil, errors.New("thread selection changed")
		}
		return map[string]any{"thread": map[string]any{"id": "thread-exact", "projectId": b.ProjectID}, "cwd": b.Writer.Path, "model": b.Model, "approvalPolicy": f.selection.ApprovalPolicy, "sandbox": map[string]any{"type": "workspaceWrite"}}, nil
	case "turn/start":
		if taskIngressTestString(q.Params, "threadId") != "thread-exact" || taskIngressTestString(q.Params, "cwd") != b.Writer.Path || taskIngressTestString(q.Params, "model") != b.Model || taskIngressTestString(q.Params, "effort") != b.Effort {
			return nil, errors.New("turn selection changed")
		}
		var policy struct {
			Type    string   `json:"type"`
			Network bool     `json:"networkAccess"`
			Roots   []string `json:"writableRoots"`
		}
		if json.Unmarshal(q.Params["sandboxPolicy"], &policy) != nil || policy.Type != "workspaceWrite" || policy.Network || !reflect.DeepEqual(policy.Roots, []string{b.Writer.Path}) {
			return nil, errors.New("policy changed")
		}
		id := fmt.Sprintf("turn-%d", len(f.turns)+1)
		f.turns = append(f.turns, taskIngressTestTurn{id, "inProgress"})
		return map[string]any{"turn": map[string]any{"id": id}}, nil
	case "thread/read":
		if taskIngressTestString(q.Params, "threadId") != "thread-exact" {
			return nil, errors.New("foreign thread")
		}
		thread := map[string]any{"id": "thread-exact", "projectId": b.ProjectID, "cwd": b.Writer.Path, "model": b.Model}
		if !f.bareRead {
			state := "idle"
			if len(f.turns) > 0 && f.turns[len(f.turns)-1].Status == "inProgress" {
				state = "active"
			}
			thread["status"] = map[string]any{"type": state, "activeFlags": []string{}}
		}
		return map[string]any{"thread": thread}, nil
	case "thread/turns/list":
		if taskIngressTestString(q.Params, "threadId") != "thread-exact" {
			return nil, errors.New("foreign turns")
		}
		limit := 100
		_ = json.Unmarshal(q.Params["limit"], &limit)
		rows := []any{}
		for n := len(f.turns) - 1; n >= 0 && len(rows) < limit; n-- {
			turn := f.turns[n]
			rows = append(rows, map[string]any{"id": turn.ID, "status": turn.Status})
		}
		return map[string]any{"data": rows, "nextCursor": nil}, nil
	case "thread/items/list":
		id := taskIngressTestString(q.Params, "turnId")
		if taskIngressTestString(q.Params, "threadId") != "thread-exact" {
			return nil, errors.New("foreign items")
		}
		found := false
		for _, turn := range f.turns {
			if turn.ID == id && turn.Status == "completed" {
				found = true
			}
		}
		if !found {
			return nil, errors.New("terminal item requested before completion")
		}
		return map[string]any{"data": []any{map[string]any{"turnId": id, "item": map[string]any{"id": "final-" + id, "type": "agentMessage", "phase": "final_answer", "text": "retained " + id}}}, "nextCursor": nil}, nil
	}
	return nil, errors.New("unexpected script RPC")
}
func (f *taskIngressTestPipe) count(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.requests {
		if r.Method == method {
			n++
		}
	}
	return n
}
func (f *taskIngressTestPipe) complete(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for n := range f.turns {
		if f.turns[n].ID == id {
			f.turns[n].Status = "completed"
		}
	}
}

type taskIngressTestFixture struct {
	store     *taskRuntimeTestMemory
	owner     *taskrepo.Owner
	route     *taskrepo.Route
	authority *taskRuntimeTestAuthority
	client    *codexclient.Client
	pipe      *taskIngressTestPipe
	ingress   *TaskIngress
}

func taskIngressTestSetup(t *testing.T, drop bool) *taskIngressTestFixture {
	return taskIngressTestSetupProfile(t, drop, "fixture-profile")
}
func taskIngressTestSetupProfile(t *testing.T, drop bool, profile string) *taskIngressTestFixture {
	t.Helper()
	now := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	b := task.Binding{Provider: task.Codex, ProfileID: profile, HostID: "selected-host", ProjectID: "saved-project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "10", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "11", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "selected", Model: "fixture-model", Effort: "high", ConfigDigest: strings.Repeat("a", 64)}
	selected := codexclient.Selection{Binding: b, ExecutablePath: "/fixture/bin/codex", ExecutableSHA256: strings.Repeat("b", 64), SocketPath: "/fixture/codex.sock", ExpectedCodexHome: "/fixture/provider-home", ScratchRoot: "/fixture/scratch", Protocol: "codex-app-server/v2", SchemaSHA256: strings.Repeat("c", 64), Sandbox: "workspace-write", ApprovalPolicy: "never", GrantedAt: now, ExpiresAt: now.Add(time.Hour)}
	pipe := &taskIngressTestPipe{selection: selected, dropTurn: drop}
	a := &taskRuntimeTestAuthority{binding: b}
	client, err := codexclient.New(codexclient.Options{Selection: selected, Boundary: pipe, Now: func() time.Time { return now.Add(time.Minute) }, Recheck: a.Recheck, RecheckDispatch: func(ctx context.Context, intent task.Intent) error {
		if err := a.Recheck(ctx, intent.Binding); err != nil {
			return err
		}
		return a.RecheckParent(ctx, intent.Parent)
	}, Followup: codexclient.FollowupQualification{Selection: selected, Witness: codexclient.FollowupSchemaWitness{Kind: codexclient.FollowupSchemaKind, Protocol: selected.Protocol, BaseSchemaSHA256: selected.SchemaSHA256, SchemaSHA256: strings.Repeat("d", 64)}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := client.Close(ctx); err != nil {
			t.Errorf("script client cleanup: %v", err)
		}
	})
	store := &taskRuntimeTestMemory{ops: map[string]port.Operation{}}
	owner, err := taskrepo.New(store, "task")
	if err != nil {
		t.Fatal(err)
	}
	f := &taskIngressTestFixture{store: store, owner: owner, authority: a, client: client, pipe: pipe}
	f.selectTurn(t, 1)
	return f
}
func (f *taskIngressTestFixture) selectTurn(t *testing.T, epoch uint64) {
	t.Helper()
	route, err := f.owner.Select(port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task", TaskEpoch: epoch, ParticipantID: "participant", TurnID: fmt.Sprintf("farol-turn-%d", epoch)})
	if err != nil {
		t.Fatal(err)
	}
	ingress, err := NewTaskIngress(TaskRuntimeInputs{Route: route, Binding: f.authority.binding, Authority: f.authority, Codex: f.client}, controlct.Parent{ThreadID: "parent", TurnID: "parent-turn"})
	if err != nil {
		t.Fatal(err)
	}
	f.route, f.ingress = route, ingress
}
func taskIngressTestFailure(t *testing.T, err error, code string) {
	t.Helper()
	var failure *TaskIngressFailure
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("error=%v want=%s", err, code)
	}
}

func TestTaskIngressConcreteCodexCreateObserveResultFollowup(t *testing.T) {
	f := taskIngressTestSetup(t, false)
	ctx := context.Background()
	if f.pipe.launches.Load() != 0 {
		t.Fatal("constructor connected")
	}
	resolved, err := f.ingress.Resolve(ctx)
	if err != nil || !resolved.Capabilities.Create || !resolved.Capabilities.Continue || resolved.Capabilities.Message || resolved.Capabilities.Cancel || resolved.Binding.Model != "fixture-model" {
		t.Fatal(resolved, err)
	}
	created, err := f.ingress.Create(ctx, "create-1", TaskIngressCreateRequest{Message: "bounded source task"})
	if err != nil || created.Receipt.State != controlct.Known || created.Receipt.Reference.TurnID != "turn-1" {
		t.Fatal(created, err)
	}
	reads := f.pipe.count("thread/read")
	running, err := f.ingress.Status(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	if err != nil || running.Lifecycle != controlct.Running || running.Pending || running.Retained || f.pipe.count("thread/read") != reads {
		t.Fatal(running, err)
	}
	f.pipe.complete("turn-1")
	observed, err := f.ingress.Observe(ctx)
	if err != nil || observed.DispatchID != "create-1" || observed.Lifecycle != controlct.Completed {
		snapshot, _ := f.store.Read(ctx, "task")
		f.pipe.mu.Lock()
		replyError := f.pipe.replyError
		f.pipe.mu.Unlock()
		t.Fatalf("observe=%+v error=%v script=%s read=%d turns=%d items=%d snapshot=%+v", observed, err, replyError, f.pipe.count("thread/read"), f.pipe.count("thread/turns/list"), f.pipe.count("thread/items/list"), snapshot)
	}
	first, err := f.ingress.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	if err != nil || !first.Retained || first.Text != "retained turn-1" || first.Reference.TurnID != "turn-1" || first.Delivery != "not_observed" {
		t.Fatal(first, err)
	}
	old := f.ingress
	f.selectTurn(t, 2)
	followed, err := f.ingress.Continue(ctx, "follow-2", TaskIngressContinueRequest{DispatchID: "create-1", Message: "bounded follow-up"})
	if err != nil || followed.Receipt.Reference.ThreadID != created.Receipt.Reference.ThreadID || followed.Receipt.Reference.TurnID != "turn-2" {
		t.Fatal(followed, err)
	}
	op, _ := f.store.Lookup(ctx, "follow-2")
	if op.Intent.Admission.TaskEpoch != 2 || op.Intent.Admission.TurnID != "farol-turn-2" || op.Intent.Expected.TurnID != "turn-1" || op.Intent.Binding != f.authority.binding {
		t.Fatal(op)
	}
	reads = f.pipe.count("thread/read")
	historical, err := f.ingress.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	if err != nil || *historical != *first || f.pipe.count("thread/read") != reads {
		t.Fatal("latest substituted for historical", historical, err)
	}
	_, err = old.Observe(ctx)
	// The existing admission capability intentionally classifies owner route
	// failures as unavailable; do not replace that boundary's error policy.
	taskIngressTestFailure(t, err, "TASK_UNAVAILABLE")
	if f.pipe.count("thread/read") != reads {
		t.Fatal("stale epoch observed later task")
	}
	f.pipe.complete("turn-2")
	if _, err = f.ingress.Observe(ctx); err != nil {
		t.Fatal(err)
	}
	f.selectTurn(t, 3)
	before := f.pipe.count("turn/start")
	_, err = f.ingress.Continue(ctx, "follow-3", TaskIngressContinueRequest{DispatchID: "create-1", Message: "stale"})
	taskIngressTestFailure(t, err, "TASK_IDENTITY_MISMATCH")
	if f.pipe.count("turn/start") != before {
		t.Fatal("stale parent dispatched")
	}
	if f.pipe.count("thread/start") != 1 || before != 2 || f.pipe.launches.Load() != 1 {
		t.Fatal("duplicate task/connection")
	}
}

func TestTaskIngressLostACKReconnectIsRetainedAndNeverDispatches(t *testing.T) {
	f := taskIngressTestSetup(t, true)
	ctx := context.Background()
	created, err := f.ingress.Create(ctx, "create-1", TaskIngressCreateRequest{Message: "bounded source task"})
	if err != nil || created.Receipt.State != controlct.Uncertain {
		t.Fatal(created, err)
	}
	before := f.pipe.count("turn/start")
	op, err := f.ingress.Operation(ctx, TaskIngressOperationRequest{OperationID: "create-1"})
	if err != nil || op.Receipt.State != controlct.Uncertain || op.Lineage.ThreadID != "thread-exact" || op.Lineage.TurnID != "" {
		t.Fatal(op, err)
	}
	status, err := f.ingress.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	if err != nil || !status.Pending || status.Retained || status.Text != "" || status.Lifecycle != controlct.Unknown {
		t.Fatal(status, err)
	}
	_, err = f.ingress.Observe(ctx)
	taskIngressTestFailure(t, err, "TASK_UNAVAILABLE")
	_, err = f.ingress.Create(ctx, "replacement", TaskIngressCreateRequest{Message: "must not replay"})
	taskIngressTestFailure(t, err, "TASK_UNAVAILABLE")
	f.selectTurn(t, 2)
	_, err = f.ingress.Continue(ctx, "follow", TaskIngressContinueRequest{DispatchID: "create-1", Message: "must not replay"})
	taskIngressTestFailure(t, err, "TASK_UNAVAILABLE")
	retained, err := f.ingress.Status(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	if err != nil || !retained.Pending {
		t.Fatal(retained, err)
	}
	if f.pipe.count("turn/start") != before || before != 1 || f.pipe.count("thread/start") != 1 || f.pipe.launches.Load() != 1 || f.pipe.count("thread/read") != 0 {
		t.Fatal("lost ACK caused provider replay or observation")
	}
}

func TestTaskIngressRevokedAdmissionCannotObserveOrRegrant(t *testing.T) {
	f := taskIngressTestSetup(t, false)
	ctx := context.Background()
	if _, err := f.ingress.Create(ctx, "create-1", TaskIngressCreateRequest{Message: "bounded source task"}); err != nil {
		t.Fatal(err)
	}
	if err := f.route.Revoke(ctx); err != nil {
		t.Fatal(err)
	}
	reads := f.pipe.count("thread/read")
	effects := f.pipe.count("turn/start")
	_, err := f.ingress.Observe(ctx)
	taskIngressTestFailure(t, err, "TASK_STATE_REFUSED")
	f.authority.errorRead = task.ErrState
	_, err = f.ingress.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	taskIngressTestFailure(t, err, "TASK_UNAVAILABLE")
	_, err = f.ingress.Continue(ctx, "next", TaskIngressContinueRequest{DispatchID: "create-1", Message: "regrant attempt"})
	taskIngressTestFailure(t, err, "TASK_UNAVAILABLE")
	if f.pipe.count("thread/read") != reads || f.pipe.count("turn/start") != effects {
		t.Fatal("revoked epoch reached provider")
	}
}

func TestTaskIngressBodiesCannotSupplyAuthorityAndMissingPrerequisitesClassify(t *testing.T) {
	for _, body := range []any{TaskIngressCreateRequest{}, TaskIngressContinueRequest{}, TaskIngressDispatchRequest{}, TaskIngressOperationRequest{}, TaskIngressObservationRequest{}} {
		typeOf := reflect.TypeOf(body)
		for n := 0; n < typeOf.NumField(); n++ {
			name := typeOf.Field(n).Name
			for _, forbidden := range []string{"TaskID", "OwnerID", "SessionID", "TaskEpoch", "TurnID", "Provider", "Model", "Effort", "Selection", "Grant", "Parent"} {
				if name == forbidden {
					t.Fatal("body carries authority", typeOf, name)
				}
			}
		}
	}
	parent := controlct.Parent{ThreadID: "parent", TurnID: "parent-turn"}
	_, err := NewTaskIngress(TaskRuntimeInputs{}, parent)
	taskIngressTestFailure(t, err, "TASK_RUNTIME_OWNER_UNAVAILABLE")
	f := taskIngressTestSetup(t, false)
	_, err = NewTaskIngress(TaskRuntimeInputs{Route: f.route, Binding: f.authority.binding, Authority: f.authority}, parent)
	taskIngressTestFailure(t, err, "TASK_RUNTIME_CODEX_ADAPTER_UNAVAILABLE")
	_, err = NewTaskIngress(TaskRuntimeInputs{Route: f.route, Binding: f.authority.binding, Authority: f.authority, Codex: f.client}, controlct.Parent{})
	taskIngressTestFailure(t, err, "TASK_INPUT_INVALID")
	claude := f.authority.binding
	claude.Provider = task.Claude
	_, err = NewTaskIngress(TaskRuntimeInputs{Route: f.route, Binding: claude, Authority: f.authority}, parent)
	taskIngressTestFailure(t, err, "TASK_RUNTIME_CLAUDE_SELECTION_UNAVAILABLE")
	if f.pipe.launches.Load() != 0 {
		t.Fatal("missing prerequisite probed provider")
	}
	var absent *TaskIngress
	_, err = absent.Status(context.Background(), TaskIngressDispatchRequest{DispatchID: "none"})
	taskIngressTestFailure(t, err, "TASK_UNAVAILABLE")
}

// The exact 127-byte thread/read reply crosses the 16-bit length boundary.
// Retained result reads must stay exact and cause no extra provider observation.
func TestTaskIngressConcrete127ByteReplyRetainsExactResult(t *testing.T) {
	f := taskIngressTestSetup(t, false)
	ctx := context.Background()
	if _, err := f.ingress.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	created, err := f.ingress.Create(ctx, "create-1", TaskIngressCreateRequest{Message: "bounded source task"})
	if err != nil {
		t.Fatal(err)
	}
	f.pipe.mu.Lock()
	f.pipe.bareRead = true
	f.pipe.mu.Unlock()
	f.pipe.complete("turn-1")
	observed, err := f.ingress.Observe(ctx)
	if err != nil || observed.DispatchID != "create-1" || observed.Lifecycle != controlct.Completed {
		t.Fatal("exact 127-byte reply did not complete observation", observed, err)
	}
	if f.pipe.readReplyBytes.Load() != 127 {
		t.Fatal("boundary witness is not exactly 127 bytes", f.pipe.readReplyBytes.Load())
	}
	reads := f.pipe.count("thread/read")
	retained, err := f.ingress.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	if err != nil || !retained.Retained || retained.Pending || retained.Text != "retained turn-1" || retained.Lifecycle != controlct.Completed || retained.Reference != created.Receipt.Reference || retained.DispatchID != "create-1" || retained.ResultEvidence == "" {
		t.Fatal("completed reply lost its exact retained evidence", retained, err)
	}
	again, err := f.ingress.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	if err != nil || *again != *retained || f.pipe.count("thread/read") != reads {
		t.Fatal("retained result polled or changed", again, err)
	}
	if reads != 1 || f.pipe.count("turn/start") != 1 || f.pipe.count("thread/start") != 1 || f.pipe.launches.Load() != 1 || f.pipe.count("thread/turns/list") != 1 || f.pipe.count("thread/items/list") != 1 {
		t.Fatal("127-byte observation added dispatch/reconnect or lost terminal reads")
	}
}
