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
	eventMu         sync.Mutex
	events          *eventRoute
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
func (c *Client) rpc(ctx context.Context, method string, params any) (map[string]json.RawMessage, error) {
	return c.rpcChecked(ctx, method, params, nil)
}

// mutationRPC carries the actual immutable intent explicitly to the write
// boundary. It never stores operation authority in context or retargets a Client.
func (c *Client) mutationRPC(ctx context.Context, method string, params any, intent task.Intent, qualified qualification) (map[string]json.RawMessage, error) {
	if !mutationMethod(method) {
		return nil, task.ErrIdentity
	}
	return c.rpcChecked(ctx, method, params, func() error {
		// The write lock has been acquired. Retain the originally qualified
		// connection/epoch across lock waiting; do not snapshot a newer epoch.
		if err := qualified.check(c); err != nil {
			return err
		}
		// Binding checks can await. Keep the Parent/intent check last, while the
		// transport write lock is held, after all qualification and frame work.
		if err := c.guard(ctx); err != nil {
			return err
		}
		if c.dispatchRecheck == nil {
			return task.ErrUnsupported
		}
		if err := checkDispatch(c.dispatchRecheck, ctx, intent); err != nil {
			return task.ErrIdentity
		}
		if ctx.Err() != nil || c.closed.Load() || !c.now().Before(c.selection.ExpiresAt) {
			return task.ErrUnavailable
		}
		// Account notifications are consumed independently while either guard
		// awaits. Match the same connection/epoch again, just before writing.
		return qualified.check(c)
	})
}

// The callback is an injected authority boundary. A panic refuses dispatch,
// without leaking a diagnostic or crashing the asynchronous transport writer.
func checkDispatch(check func(context.Context, task.Intent) error, ctx context.Context, intent task.Intent) (err error) {
	defer func() {
		if recover() != nil {
			err = task.ErrIdentity
		}
	}()
	return check(ctx, intent)
}

func (c *Client) rpcChecked(ctx context.Context, method string, params any, beforeWrite func() error) (map[string]json.RawMessage, error) {
	if err := c.guard(ctx); err != nil {
		return nil, err
	}
	m, err := c.connection.requestChecked(ctx, method, params, beforeWrite)
	if err != nil {
		return nil, err
	}
	if err := c.guard(ctx); err != nil {
		return nil, err
	}
	return m, nil
}

// qualification is a retained connection/account-epoch witness, not new Task
// admission or a grant. The selected connection is never replaced/requalified
// to recover an invalidated witness.
type qualification struct {
	connection *proxy
	epoch      uint64
}

func (q qualification) check(c *Client) error {
	c.mu.Lock()
	same := q.connection != nil && c.connection == q.connection
	c.mu.Unlock()
	if !same || q.connection.lost.Load() || q.connection.epoch.Load() != q.epoch {
		return task.ErrUnknown
	}
	return nil
}

func (c *Client) qualify(ctx context.Context) (qualification, error) {
	if err := c.verify(ctx); err != nil {
		return qualification{}, err
	}
	if err := c.ensure(ctx); err != nil {
		return qualification{}, err
	}
	qualified := qualification{connection: c.connection, epoch: c.connection.epoch.Load()}
	if err := c.catalogue(ctx); err != nil {
		return qualification{}, err
	}
	if err := c.project(ctx); err != nil {
		return qualification{}, err
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return qualification{}, err
	}
	if err := qualified.check(c); err != nil {
		return qualification{}, err
	}
	return qualified, nil
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
	if c.dispatchRecheck == nil {
		return task.Capabilities{}, task.ErrUnsupported
	}
	if _, err := c.qualify(ctx); err != nil {
		return task.Capabilities{}, err
	}
	return task.Capabilities{Create: true, Continue: c.followup.valid(c.selection)}, nil
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

func (c *Client) Observe(parent context.Context, b task.Binding, ref task.Reference) (port.Observation, error) {
	return c.observe(parent, b, ref, nil)
}

// observe keeps an optional sealed read selection inside the original Client
// gate/budget and carries one connection witness through the last awaited check.
// Public Observe retains its existing producer port and binding-only authority.
func (c *Client) observe(parent context.Context, b task.Binding, ref task.Reference, recheckSelection func(context.Context) error) (port.Observation, error) {
	ctx, leave, err := c.enter(parent)
	if err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	defer leave()
	if b != c.selection.Binding || !ref.Complete(task.Codex) || !providerID(ref.ThreadID) || !providerID(ref.TurnID) {
		return port.Observation{}, task.ErrIdentity
	}
	if recheckSelection != nil {
		if err := recheckSelection(ctx); err != nil {
			return port.Observation{}, err
		}
	}
	if err := c.verify(ctx); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	if err := c.ensure(ctx); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	qualified := qualification{connection: c.connection, epoch: c.connection.epoch.Load()}
	read := c.rpc
	if recheckSelection != nil {
		read = func(ctx context.Context, method string, params any) (map[string]json.RawMessage, error) {
			return c.rpcChecked(ctx, method, params, func() error {
				// After binding checks, frame construction and write-lock waiting:
				// the sealed selection must still authorize this exact history read.
				if err := qualified.check(c); err != nil {
					return err
				}
				if err := recheckSelection(ctx); err != nil {
					return err
				}
				return c.readWitness(ctx, qualified)
			})
		}
	}
	if err := readThread(ctx, read, b, ref.ThreadID); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	lifecycle, err := readTurn(ctx, read, ref)
	if err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	text := ""
	if lifecycle == task.Completed {
		text, err = readFinal(ctx, read, ref)
		if err != nil {
			return port.Observation{}, task.ErrUnknown
		}
	}
	// History is a non-atomic read. Check exact membership again after awaited
	// turn/item pages; a changed project/writer/model cannot disclose the result.
	if err := readThread(ctx, read, b, ref.ThreadID); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	if recheckSelection != nil {
		if err := recheckSelection(ctx); err != nil {
			return port.Observation{}, err
		}
		if err := c.readWitness(ctx, qualified); err != nil {
			return port.Observation{}, task.ErrUnknown
		}
	}
	return port.Observation{Reference: ref, Lifecycle: lifecycle, Result: text}, nil
}

// readWitness is value-only and runs after the last awaited selection check.
// It never acquires a newer epoch or invokes a grant/native/provider callback.
func (c *Client) readWitness(ctx context.Context, qualified qualification) error {
	now := c.now()
	if ctx.Err() != nil || c.lifetime.Err() != nil || c.closed.Load() || now.Before(c.selection.GrantedAt) || !now.Before(c.selection.ExpiresAt) {
		return task.ErrUnknown
	}
	return qualified.check(c)
}

type historyRead func(context.Context, string, any) (map[string]json.RawMessage, error)

func readThread(ctx context.Context, read historyRead, b task.Binding, id string) error {
	m, err := read(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false})
	if err != nil {
		return err
	}
	thread, ok := object(m, "thread")
	if !ok || !equals(thread, "id", id) || !equals(thread, "projectId", b.ProjectID) || !equals(thread, "cwd", b.Writer.Path) || !equals(thread, "model", b.Model) {
		return task.ErrUnknown
	}
	return nil
}

func readTurn(ctx context.Context, read historyRead, ref task.Reference) (task.Lifecycle, error) {
	var cursor any
	seen := map[string]bool{}
	ids := map[string]bool{}
	lifecycle := task.Unknown
	matches := 0
	for page := 0; page < maxPages; page++ {
		m, err := read(ctx, "thread/turns/list", map[string]any{"threadId": ref.ThreadID, "cursor": cursor, "limit": pageSize, "itemsView": "notLoaded"})
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
func readFinal(ctx context.Context, read historyRead, ref task.Reference) (string, error) {
	var cursor any
	seen := map[string]bool{}
	ids := map[string]bool{}
	matches := 0
	text := ""
	for page := 0; page < maxPages; page++ {
		m, err := read(ctx, "thread/items/list", map[string]any{"threadId": ref.ThreadID, "turnId": ref.TurnID, "cursor": cursor, "limit": pageSize})
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

func (*Client) Message(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
	return refused("TASK_CONTROL_NOT_QUALIFIED"), task.ErrUnsupported
}
func (*Client) Cancel(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
	return refused("TASK_CONTROL_NOT_QUALIFIED"), task.ErrUnsupported
}

// The same producer can be injected into the Task Provider port without a
// second dispatch/journal owner. Active controls remain explicitly unsupported.
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
type clientProcess struct {
	Process
	once sync.Once
	err  error
}

func (p *clientProcess) Close() error {
	p.once.Do(func() { p.err = p.Process.Close() })
	return p.err
}

// scheduleCleanup starts only after the original Launch has registered its
// result. It never waits on the read gate or holds the mutex during process IO.
// The first Close's budget is fixed; late registration cannot renew it.
func (c *Client) scheduleCleanup() {
	c.mu.Lock()
	if !c.closeStarted || c.launching || c.cleanupStarted {
		c.mu.Unlock()
		return
	}
	c.cleanupStarted = true
	conn, launchErr, ctx, cancel := c.connection, c.launchErr, c.closeCtx, c.closeCancel
	if conn == nil {
		if launchErr != nil {
			c.closeErr = task.ErrUnknown
		}
		close(c.closeDone)
		c.mu.Unlock()
		cancel()
		return
	}
	c.mu.Unlock()
	go func() {
		defer cancel()
		conn.fail()
		// This reads the wrapper's retained result, never another termination.
		terminationErr := conn.process.Close()
		exitErr := conn.process.Wait(ctx)
		c.mu.Lock()
		if launchErr != nil || terminationErr != nil || exitErr != nil {
			c.closeErr = task.ErrUnknown
		}
		// A caller's earlier unproved timeout/cancellation remains unknown even
		// if the original child supplies exit proof after that caller returned.
		close(c.closeDone)
		c.mu.Unlock()
	}()
}

// Close fences both an in-flight Launch and the retained original proxy. It
// never interrupts a provider turn or repeats termination/exit collection. Its
// bounded wait runs outside the read gate, including from authority callbacks.
func (c *Client) Close(ctx context.Context) error {
	if ctx == nil {
		return task.ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	c.mu.Lock()
	if !c.closeStarted {
		c.closed.Store(true)
		c.closeStarted = true
		// Cleanup stays owned when a caller is cancelled, including by closing
		// this same Client lifetime from its own authority callback.
		c.closeCtx, c.closeCancel = context.WithTimeout(context.Background(), 2*time.Second)
	}
	c.mu.Unlock()
	c.cancel()
	c.scheduleCleanup()
	// Completed cleanup wins over a later caller cancellation.
	select {
	case <-c.closeDone:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.closeErr
	default:
	}
	c.mu.Lock()
	retained := c.closeErr
	c.mu.Unlock()
	if retained != nil {
		return retained
	}
	select {
	case <-c.closeDone:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.closeErr
	case <-ctx.Done():
		c.mu.Lock()
		defer c.mu.Unlock()
		select {
		case <-c.closeDone:
			return c.closeErr
		default:
			c.closeErr = task.ErrUnknown
			return c.closeErr
		}
	}
}
