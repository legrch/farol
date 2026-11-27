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
	task "github.com/legrch/farol/modules/task/domain"
)

type Client struct {
	eventMu         sync.Mutex
	events          *eventRoute
	steer           atomic.Pointer[steerWitness] // transient exact-target completion fence
	selection       Selection
	followup        FollowupQualification
	boundary        Boundary
	now             func() time.Time
	recheck         func(context.Context, task.Binding) error
	dispatchRecheck func(context.Context, task.Intent) error
	gate            chan struct{}
	used            map[string][32]byte
	blocked         bool // mutation uncertainty fences all later mutations in this lifetime
	attempted       bool
	mu              sync.Mutex
	connection      *proxy
	launching       bool
	launchErr       error
	closeStarted    bool
	cleanupStarted  bool
	closeDone       chan struct{}
	closeErr        error
	closeCtx        context.Context
	closeCancel     context.CancelFunc
	closed          atomic.Bool
	lifetime        context.Context
	cancel          context.CancelFunc
}

// New is lazy: it does not inspect a host, socket or provider until a method is
// explicitly invoked. Use NativeBoundary for production and an injected pipe
// boundary for hermetic source tests. The current grant checker is mandatory.
func New(o Options) (*Client, error) {
	if !o.Selection.valid() || o.Boundary == nil || o.Now == nil || o.Recheck == nil || (o.Followup != (FollowupQualification{}) && !o.Followup.valid(o.Selection)) {
		return nil, task.ErrInvalid
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{selection: o.Selection, followup: o.Followup, boundary: o.Boundary, now: o.Now, recheck: o.Recheck, dispatchRecheck: o.RecheckDispatch, gate: make(chan struct{}, 1), used: make(map[string][32]byte), closeDone: make(chan struct{}), lifetime: ctx, cancel: cancel}, nil
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
	c.mu.Lock()
	if c.closed.Load() || ctx.Err() != nil {
		c.mu.Unlock()
		return task.ErrUnavailable
	}
	if conn := c.connection; conn != nil {
		c.mu.Unlock()
		if conn.lost.Load() {
			return task.ErrUnknown
		}
		return nil
	}
	if c.attempted {
		c.mu.Unlock()
		return task.ErrUnavailable
	}
	c.attempted = true
	c.launching = true
	c.mu.Unlock()
	p, err := c.boundary.Launch(ctx, c.selection)
	var conn *proxy
	if p != nil {
		conn = newProxy(&clientProcess{Process: p})
		conn.notification = c.notification
	}
	c.mu.Lock()
	c.connection = conn
	c.launching = false
	if err != nil || p == nil {
		// A failed launch supplies no complete child/exit proof. Keep the
		// original attempt terminal, including a child returned with an error.
		c.launchErr = task.ErrUnknown
	}
	closed := c.closed.Load()
	c.mu.Unlock()
	if closed {
		// Close may already have returned unknown after its bounded wait. The
		// late original still belongs to this lifetime and is cleaned once.
		c.scheduleCleanup()
		return task.ErrUnavailable
	}
	if err != nil || conn == nil || ctx.Err() != nil || c.closed.Load() {
		if conn != nil {
			conn.fail()
		}
		return task.ErrUnavailable
	}
	if err := conn.connect(ctx, c.selection.ExpectedCodexHome); err != nil {
		conn.fail()
		return task.ErrUnavailable
	}
	return c.guard(ctx)
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
	if c.dispatchRecheck == nil {
		return task.Capabilities{}, task.ErrUnsupported
	}
	if _, err := c.qualify(ctx); err != nil {
		return task.Capabilities{}, err
	}
	return task.Capabilities{Create: true, Continue: c.followup.valid(c.selection), Message: true}, nil
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
	if c.dispatchRecheck == nil {
		c.blocked = true
		return unknown(task.Reference{}), nil
	}
	qualified, err := c.qualify(ctx)
	if err != nil {
		return refused("CODEX_SELECTION_UNAVAILABLE"), nil
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return refused("CODEX_SELECTION_CHANGED"), nil
	}
	ref := task.Reference{}
	uncertain := func() (task.Receipt, error) { c.blocked = true; return unknown(ref), nil }
	// From here even a malformed/error/lost reply cannot attest no effect.
	m, err := c.mutationRPC(ctx, "thread/start", map[string]any{
		"projectId": i.Binding.ProjectID, "cwd": i.Binding.Writer.Path, "ephemeral": false, "model": i.Binding.Model,
		"sandbox": c.selection.Sandbox, "approvalPolicy": c.selection.ApprovalPolicy, "allowProviderModelFallback": false,
	}, i, qualified)
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
	if err := c.current(ctx, qualified.epoch); err != nil {
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
	m, err = c.mutationRPC(ctx, "turn/start", params, i, qualified)
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
	if err := c.current(ctx, qualified.epoch); err != nil {
		return uncertain()
	}
	return task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}, nil
}

func (*Client) Cancel(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
	return refused("TASK_CONTROL_NOT_QUALIFIED"), task.ErrUnsupported
}

// The same producer can be injected into the Task Provider port without a
// second dispatch/journal owner. Cancel remains explicitly unsupported.
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

// clientProcess retains the original termination result even when proxy.fail
// discards it. Every proxy failure and Close shares this one termination attempt.
