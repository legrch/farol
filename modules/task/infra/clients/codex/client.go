package codex

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type Client struct {
	selection  Selection
	boundary   Boundary
	now        func() time.Time
	recheck    func(context.Context, task.Binding) error
	gate       chan struct{}
	used       map[string][32]byte
	blocked    bool // mutation uncertainty fences all later mutations in this lifetime
	attempted  bool
	mu         sync.Mutex
	connection *proxy
	closed     atomic.Bool
	lifetime   context.Context
	cancel     context.CancelFunc
}

// New is lazy: it does not inspect a host, socket or provider until a method is
// explicitly invoked. Use NativeBoundary for production and an injected pipe
// boundary for hermetic source tests. The current grant checker is mandatory.
func New(o Options) (*Client, error) {
	if !o.Selection.valid() || o.Boundary == nil || o.Now == nil || o.Recheck == nil {
		return nil, task.ErrInvalid
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{selection: o.Selection, boundary: o.Boundary, now: o.Now, recheck: o.Recheck, gate: make(chan struct{}, 1), used: make(map[string][32]byte), lifetime: ctx, cancel: cancel}, nil
}

func (c *Client) enter(parent context.Context) (context.Context, func(), error) {
	duration := min(callBudget, c.selection.ExpiresAt.Sub(c.now()))
	if duration <= 0 {
		return nil, nil, task.ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, duration)
	stop := context.AfterFunc(c.lifetime, cancel)
	finish := func() { stop(); cancel() }
	select {
	case c.gate <- struct{}{}:
		if ctx.Err() != nil || c.closed.Load() {
			<-c.gate
			finish()
			return nil, nil, task.ErrUnavailable
		}
		return ctx, func() { <-c.gate; finish() }, nil
	case <-ctx.Done():
		finish()
		return nil, nil, task.ErrUnavailable
	}
}
func (c *Client) guard(ctx context.Context) error {
	now := c.now()
	if ctx.Err() != nil || c.closed.Load() || now.Before(c.selection.GrantedAt) || !now.Before(c.selection.ExpiresAt) {
		return task.ErrUnavailable
	}
	if err := c.recheck(ctx, c.selection.Binding); err != nil {
		return task.ErrIdentity
	}
	if ctx.Err() != nil || c.closed.Load() || !c.now().Before(c.selection.ExpiresAt) {
		return task.ErrUnavailable
	}
	return nil
}
func (c *Client) verify(ctx context.Context) error {
	if err := c.guard(ctx); err != nil {
		return err
	}
	if err := c.boundary.Verify(ctx, c.selection); err != nil {
		return task.ErrIdentity
	}
	return c.guard(ctx)
}
func (c *Client) ensure(ctx context.Context) error {
	if c.connection != nil {
		if c.connection.lost.Load() {
			return task.ErrUnknown
		}
		return nil
	}
	if c.attempted {
		return task.ErrUnavailable
	}
	c.attempted = true
	p, err := c.boundary.Launch(ctx, c.selection)
	if err != nil || p == nil {
		return task.ErrUnavailable
	}
	conn := newProxy(p)
	c.mu.Lock()
	c.connection = conn
	closed := c.closed.Load()
	c.mu.Unlock()
	if closed {
		conn.fail()
		return task.ErrUnavailable
	}
	if err := conn.connect(ctx, c.selection.ExpectedCodexHome); err != nil {
		conn.fail()
		return task.ErrUnavailable
	}
	return c.guard(ctx)
}
func (c *Client) rpc(ctx context.Context, method string, params any) (map[string]json.RawMessage, error) {
	if err := c.guard(ctx); err != nil {
		return nil, err
	}
	m, err := c.connection.request(ctx, method, params)
	if err != nil {
		return nil, err
	}
	if err := c.guard(ctx); err != nil {
		return nil, err
	}
	return m, nil
}
func (c *Client) qualify(ctx context.Context) (uint64, error) {
	if err := c.verify(ctx); err != nil {
		return 0, err
	}
	if err := c.ensure(ctx); err != nil {
		return 0, err
	}
	epoch := c.connection.epoch.Load()
	if err := c.catalogue(ctx); err != nil {
		return 0, err
	}
	if err := c.project(ctx); err != nil {
		return 0, err
	}
	if err := c.current(ctx, epoch); err != nil {
		return 0, err
	}
	return epoch, nil
}
func (c *Client) current(ctx context.Context, epoch uint64) error {
	if err := c.verify(ctx); err != nil {
		return err
	}
	if c.connection.lost.Load() || c.connection.epoch.Load() != epoch {
		return task.ErrUnknown
	}
	return nil
}

func (c *Client) Supports(parent context.Context, b task.Binding) (task.Capabilities, error) {
	ctx, leave, err := c.enter(parent)
	if err != nil {
		return task.Capabilities{}, err
	}
	defer leave()
	if b != c.selection.Binding {
		return task.Capabilities{}, task.ErrIdentity
	}
	if c.blocked {
		return task.Capabilities{}, task.ErrUnknown
	}
	if _, err := c.qualify(ctx); err != nil {
		return task.Capabilities{}, err
	}
	return task.Capabilities{Create: true}, nil
}

func refused(code string) task.Receipt {
	return task.Receipt{State: task.Rejected, Code: code, Lifecycle: task.Refused}
}
func unknown(ref task.Reference) task.Receipt {
	return task.Receipt{State: task.Uncertain, Code: "CODEX_TASK_OUTCOME_UNKNOWN", Reference: ref, Lifecycle: task.Unknown}
}

func (c *Client) Create(parent context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	ctx, leave, err := c.enter(parent)
	if err != nil {
		return refused("CODEX_TASK_UNAVAILABLE"), nil
	}
	defer leave()
	i := d.Intent
	if i.Action != task.Create || !task.ID(i.OperationID) || !task.ID(i.TaskID) || !task.ID(i.Digest) || i.Binding != c.selection.Binding || i.Expected != (task.Reference{}) || !i.Parent.Valid() || !task.Text(d.Message, 8192) || strings.TrimSpace(d.Message) == "" || progress == nil {
		return refused("CODEX_TASK_INVALID"), nil
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return refused("CODEX_TASK_INVALID"), nil
	}
	fingerprint := sha256.Sum256(raw)
	if old, ok := c.used[i.OperationID]; ok {
		if old != fingerprint {
			return refused("CODEX_OPERATION_CONFLICT"), nil
		}
		return unknown(task.Reference{}), nil
	}
	if c.blocked {
		return unknown(task.Reference{}), nil
	}
	if len(c.used) >= maxOperations {
		return refused("CODEX_OPERATION_CAPACITY"), nil
	}
	// Durable ownership is the outer Task journal. This bounded local fence is
	// additional protection, never persistent admission or permission to replay.
	c.used[i.OperationID] = fingerprint
	epoch, err := c.qualify(ctx)
	if err != nil {
		return refused("CODEX_SELECTION_UNAVAILABLE"), nil
	}
	if err := c.current(ctx, epoch); err != nil {
		return refused("CODEX_SELECTION_CHANGED"), nil
	}
	ref := task.Reference{}
	uncertain := func() (task.Receipt, error) { c.blocked = true; return unknown(ref), nil }
	// From here even a malformed/error/lost reply cannot attest no effect.
	m, err := c.rpc(ctx, "thread/start", map[string]any{
		"projectId": i.Binding.ProjectID, "cwd": i.Binding.Writer.Path, "ephemeral": false, "model": i.Binding.Model,
		"sandbox": c.selection.Sandbox, "approvalPolicy": c.selection.ApprovalPolicy, "allowProviderModelFallback": false,
	})
	if err != nil {
		return uncertain()
	}
	thread, ok := object(m, "thread")
	id, haveID := str(thread, "id")
	sandbox, haveSandbox := object(m, "sandbox")
	kind := "readOnly"
	if c.selection.Sandbox == "workspace-write" {
		kind = "workspaceWrite"
	}
	if !ok || !haveID || !providerID(id) || !equals(thread, "projectId", i.Binding.ProjectID) || !equals(m, "cwd", i.Binding.Writer.Path) || !equals(m, "model", i.Binding.Model) || !equals(m, "approvalPolicy", c.selection.ApprovalPolicy) || !haveSandbox || !equals(sandbox, "type", kind) {
		return uncertain()
	}
	ref.ThreadID = id
	if err := publish(progress, ref); err != nil {
		return uncertain()
	}
	if err := c.current(ctx, epoch); err != nil {
		return uncertain()
	}
	policy := map[string]any{"type": kind, "networkAccess": false}
	if c.selection.Sandbox == "workspace-write" {
		policy["writableRoots"] = []string{i.Binding.Writer.Path}
	}
	params := map[string]any{"threadId": ref.ThreadID, "input": []any{map[string]any{"type": "text", "text": d.Message}}, "cwd": i.Binding.Writer.Path, "model": i.Binding.Model, "approvalPolicy": c.selection.ApprovalPolicy, "sandboxPolicy": policy}
	if i.Binding.Effort != "" {
		params["effort"] = i.Binding.Effort
	}
	m, err = c.rpc(ctx, "turn/start", params)
	if err != nil {
		return uncertain()
	}
	turn, ok := object(m, "turn")
	turnID, haveID := str(turn, "id")
	if !ok || !haveID || !providerID(turnID) {
		return uncertain()
	}
	ref.TurnID = turnID
	if err := publish(progress, ref); err != nil {
		return uncertain()
	}
	if err := c.current(ctx, epoch); err != nil {
		return uncertain()
	}
	return task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}, nil
}

func (c *Client) Observe(parent context.Context, b task.Binding, ref task.Reference) (port.Observation, error) {
	ctx, leave, err := c.enter(parent)
	if err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	defer leave()
	if b != c.selection.Binding || !ref.Complete(task.Codex) || !providerID(ref.ThreadID) || !providerID(ref.TurnID) {
		return port.Observation{}, task.ErrIdentity
	}
	if err := c.verify(ctx); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	if err := c.ensure(ctx); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	epoch := c.connection.epoch.Load()
	m, err := c.rpc(ctx, "thread/read", map[string]any{"threadId": ref.ThreadID, "includeTurns": false})
	if err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	thread, ok := object(m, "thread")
	if !ok || !equals(thread, "id", ref.ThreadID) || !equals(thread, "projectId", b.ProjectID) || !equals(thread, "cwd", b.Writer.Path) || !equals(thread, "model", b.Model) {
		return port.Observation{}, task.ErrUnknown
	}
	lifecycle, err := c.readTurn(ctx, ref)
	if err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	text := ""
	if lifecycle == task.Completed {
		text, err = c.readFinal(ctx, ref)
		if err != nil {
			return port.Observation{}, task.ErrUnknown
		}
	}
	if err := c.current(ctx, epoch); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	return port.Observation{Reference: ref, Lifecycle: lifecycle, Result: text}, nil
}

func (c *Client) readTurn(ctx context.Context, ref task.Reference) (task.Lifecycle, error) {
	var cursor any
	seen := map[string]bool{}
	ids := map[string]bool{}
	lifecycle := task.Unknown
	matches := 0
	for page := 0; page < maxPages; page++ {
		m, err := c.rpc(ctx, "thread/turns/list", map[string]any{"threadId": ref.ThreadID, "cursor": cursor, "limit": pageSize, "itemsView": "notLoaded"})
		if err != nil {
			return task.Unknown, err
		}
		rows, ok := array(m, "data", pageSize)
		if !ok {
			return task.Unknown, protocolError()
		}
		for _, raw := range rows {
			r, err := parse(raw)
			if err != nil {
				return task.Unknown, err
			}
			id, ok := str(r, "id")
			if !ok || !providerID(id) || ids[id] {
				return task.Unknown, protocolError()
			}
			ids[id] = true
			if id == ref.TurnID {
				lifecycle, ok = turnLifecycle(r)
				if !ok {
					return task.Unknown, protocolError()
				}
				matches++
			}
		}
		n, done, ok := next(m)
		if !ok {
			return task.Unknown, protocolError()
		}
		if done {
			if matches == 1 {
				return lifecycle, nil
			}
			return task.Unknown, task.ErrUnknown
		}
		if seen[n] {
			return task.Unknown, protocolError()
		}
		seen[n] = true
		cursor = n
	}
	return task.Unknown, protocolError()
}
func (c *Client) readFinal(ctx context.Context, ref task.Reference) (string, error) {
	var cursor any
	seen := map[string]bool{}
	ids := map[string]bool{}
	matches := 0
	text := ""
	for page := 0; page < maxPages; page++ {
		m, err := c.rpc(ctx, "thread/items/list", map[string]any{"threadId": ref.ThreadID, "turnId": ref.TurnID, "cursor": cursor, "limit": pageSize})
		if err != nil {
			return "", err
		}
		rows, ok := array(m, "data", pageSize)
		if !ok {
			return "", protocolError()
		}
		for _, raw := range rows {
			r, err := parse(raw)
			if err != nil {
				return "", err
			}
			item, ok := object(r, "item")
			id, haveID := str(item, "id")
			if !equals(r, "turnId", ref.TurnID) || !ok || !haveID || !providerID(id) || ids[id] {
				return "", protocolError()
			}
			ids[id] = true
			if equals(item, "type", "agentMessage") && equals(item, "phase", "final_answer") {
				s, ok := str(item, "text")
				if !ok || !task.Text(s, maxResultBytes) {
					return "", protocolError()
				}
				matches++
				text = s
			}
		}
		n, done, ok := next(m)
		if !ok {
			return "", protocolError()
		}
		if done {
			if matches == 1 {
				return text, nil
			}
			return "", task.ErrUnknown
		}
		if seen[n] {
			return "", protocolError()
		}
		seen[n] = true
		cursor = n
	}
	return "", protocolError()
}

func (*Client) Continue(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
	return refused("TASK_CONTROL_NOT_QUALIFIED"), task.ErrUnsupported
}
func (*Client) Message(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
	return refused("TASK_CONTROL_NOT_QUALIFIED"), task.ErrUnsupported
}
func (*Client) Cancel(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
	return refused("TASK_CONTROL_NOT_QUALIFIED"), task.ErrUnsupported
}

// The same producer can be injected into the Task Provider port without a
// second dispatch/journal owner. Controls keep their explicit unsupported state.
func (c *Client) Dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	switch d.Intent.Action {
	case task.Create:
		return c.Create(ctx, d, progress)
	case task.Continue:
		return c.Continue(ctx, d, progress)
	case task.Message:
		return c.Message(ctx, d, progress)
	case task.Cancel:
		return c.Cancel(ctx, d, progress)
	}
	return refused("TASK_CONTROL_NOT_QUALIFIED"), task.ErrUnsupported
}
func publish(callback func(task.Reference) error, ref task.Reference) (err error) {
	defer func() {
		if recover() != nil {
			err = task.ErrUnknown
		}
	}()
	return callback(ref)
}

// Close is exact proxy cleanup only. It never interrupts the provider turn.
// A refused signal or missing exit proof is returned as unknown, without retry.
func (c *Client) Close(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	c.closed.Store(true)
	c.cancel()
	c.mu.Lock()
	conn := c.connection
	c.mu.Unlock()
	if conn == nil {
		return nil
	}
	conn.fail()
	if conn.process.Wait(ctx) != nil {
		return task.ErrUnknown
	}
	return nil
}
