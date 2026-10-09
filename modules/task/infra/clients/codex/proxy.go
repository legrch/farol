package codex

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/legrch/farol/modules/task/domain"
)

type reply struct {
	value map[string]json.RawMessage
	err   error
}
type proxy struct {
	notification func(map[string]json.RawMessage) error
	process      Process
	ws           *websocket
	once         sync.Once
	lost         atomic.Bool
	epoch        atomic.Uint64
	done         chan struct{}
	mu           sync.Mutex
	nextID       uint64
	pendingID    uint64
	pending      chan reply
}

func newProxy(p Process) *proxy {
	return &proxy{process: p, ws: newWebsocket(p), done: make(chan struct{}), nextID: 1}
}
func (p *proxy) fail() {
	p.once.Do(func() { p.lost.Store(true); close(p.done); _ = p.process.Close() })
}
func (p *proxy) connect(ctx context.Context, home string) error {
	ready := make(chan error, 1)
	go func() { ready <- p.ws.handshake() }()
	select {
	case err := <-ready:
		if err != nil {
			p.fail()
			return task.ErrUnavailable
		}
	case <-ctx.Done():
		p.fail()
		return task.ErrUnavailable
	case <-p.done:
		return task.ErrUnavailable
	}
	go p.receive()
	m, err := p.request(ctx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "farol-shared-handoff", "version": "1"}, "capabilities": map[string]any{"experimentalApi": true}})
	if err != nil || !equals(m, "codexHome", home) || !equals(m, "platformFamily", "unix") || !equals(m, "platformOs", "macos") {
		p.fail()
		return task.ErrUnavailable
	}
	if _, ok := str(m, "userAgent"); !ok {
		p.fail()
		return task.ErrUnavailable
	}
	if err := p.notify(ctx, map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		p.fail()
		return task.ErrUnavailable
	}
	return nil
}
func allowed(method string) bool {
	switch method {
	case "initialize", "model/list", "project/list", "thread/start", "turn/start", "turn/steer", "thread/read", "thread/turns/list", "thread/items/list":
		return true
	}
	return false
}
func mutationMethod(method string) bool {
	return method == "thread/start" || method == "turn/start" || method == "turn/steer"
}

func (p *proxy) request(ctx context.Context, method string, params any) (map[string]json.RawMessage, error) {
	return p.requestChecked(ctx, method, params, nil)
}
func (p *proxy) requestChecked(ctx context.Context, method string, params any, beforeWrite func() error) (map[string]json.RawMessage, error) {
	if mutationMethod(method) && beforeWrite == nil {
		return nil, task.ErrUnsupported
	}
	if !allowed(method) || ctx.Err() != nil || p.lost.Load() {
		return nil, task.ErrUnavailable
	}
	p.mu.Lock()
	if p.pending != nil || p.nextID > 9007199254740991 {
		p.mu.Unlock()
		return nil, task.ErrUnavailable
	}
	id := p.nextID
	p.nextID++
	done := make(chan reply, 1)
	p.pendingID = id
	p.pending = done
	p.mu.Unlock()
	raw, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil || len(raw) > maxMessageBytes {
		p.fail()
		return nil, task.ErrUnknown
	}
	if err := p.sendChecked(ctx, raw, beforeWrite); err != nil {
		return nil, err
	}
	select {
	case r := <-done:
		return r.value, r.err
	case <-ctx.Done():
		p.fail()
		return nil, task.ErrUnknown
	case <-p.done:
		return nil, task.ErrUnknown
	}
}
func (p *proxy) notify(ctx context.Context, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return task.ErrUnknown
	}
	return p.send(ctx, raw)
}
func (p *proxy) send(ctx context.Context, raw []byte) error {
	return p.sendChecked(ctx, raw, nil)
}
func (p *proxy) sendChecked(ctx context.Context, raw []byte, beforeWrite func() error) error {
	if ctx.Err() != nil || p.lost.Load() {
		return task.ErrUnknown
	}
	written := make(chan error, 1)
	go func() {
		written <- p.ws.sendChecked(1, raw, func() error {
			// A cancelled/lost request queued behind the write lock must never
			// write later, even if the outer send already returned unknown.
			if ctx.Err() != nil || p.lost.Load() {
				return task.ErrUnknown
			}
			if beforeWrite != nil {
				if err := beforeWrite(); err != nil {
					return err
				}
			}
			if ctx.Err() != nil || p.lost.Load() {
				return task.ErrUnknown
			}
			return nil
		})
	}()
	select {
	case err := <-written:
		if err != nil {
			p.fail()
			return task.ErrUnknown
		}
		return nil
	case <-ctx.Done():
		p.fail()
		return task.ErrUnknown
	case <-p.done:
		return task.ErrUnknown
	}
}
func consent(method string) bool {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request", "execCommandApproval", "applyPatchApproval":
		return true
	}
	return false
}
func (p *proxy) receive() {
	for {
		raw, err := p.ws.receive()
		if err != nil {
			p.fail()
			return
		}
		m, err := parse(raw)
		if err != nil {
			p.fail()
			return
		}
		id, hasID := m["id"]
		method, hasMethod := str(m, "method")
		_, methodField := m["method"]
		_, hasResult := m["result"]
		_, hasError := m["error"]
		if methodField && !hasMethod {
			p.fail()
			return
		}
		if hasID && hasMethod {
			if hasResult || hasError || !rpcID(id) {
				p.fail()
				return
			}
			// No ownership of another client's consent request. Do not reply or
			// retain its params; no approval, token refresh or user-input route.
			if consent(method) {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), callBudget)
			err := p.notify(ctx, map[string]any{"id": id, "error": map[string]any{"code": -32601, "message": "Method not available"}})
			cancel()
			if err != nil {
				return
			}
			continue
		}
		if !hasID {
			if !hasMethod || hasResult || hasError {
				p.fail()
				return
			}
			if method == "account/updated" || method == "account/login/completed" {
				p.epoch.Add(1)
			} else if p.notification != nil && p.notification(m) != nil {
				p.fail()
				return
			}
			continue
		}
		if hasMethod || hasResult == hasError {
			p.fail()
			return
		}
		n, err := strconv.ParseUint(string(id), 10, 53)
		if err != nil || n == 0 {
			p.fail()
			return
		}
		p.mu.Lock()
		ch := p.pending
		expected := p.pendingID
		if ch == nil || n != expected {
			p.mu.Unlock()
			p.fail()
			return
		}
		p.pending = nil
		p.pendingID = 0
		p.mu.Unlock()
		if hasError { // Even a valid RPC error is not a no-effect mutation receipt.
			p.fail()
			ch <- reply{err: task.ErrUnknown}
			return
		}
		out, err := parse(m["result"])
		if err != nil {
			p.fail()
			ch <- reply{err: task.ErrUnknown}
			return
		}
		ch <- reply{value: out}
	}
}
func rpcID(raw json.RawMessage) bool {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return token(s, 128)
	}
	n, err := strconv.ParseInt(string(raw), 10, 64)
	return err == nil && n >= -9007199254740991 && n <= 9007199254740991
}
