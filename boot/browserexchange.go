package boot

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sync"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	browser "github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type browserReplyResult struct {
	reply browser.Reply
	err   error
}
type browserExchangeCall struct {
	command              wire.BrowserCommand
	ctx                  context.Context
	delivered, completed bool
	reply                chan browserReplyResult
}

// BrowserExchange is transport correlation for one inherited host pipe, not a
// scheduler or turn owner. It retains at most eight one-shot reciprocal calls.
// Chat owns all admission, intent, queue, result and retry policy.
type BrowserExchange struct {
	ctx     context.Context
	peer    wire.Context
	mu      sync.Mutex
	pending map[string]*browserExchangeCall
	ready   chan *browserExchangeCall
	issued  uint32
}

func NewBrowserExchange(ctx context.Context, peer wire.Context) (*BrowserExchange, error) {
	if ctx == nil || ctx.Err() != nil || !validIngressID(peer.ProfileId) || !validIngressID(peer.BackendGeneration) {
		return nil, errors.New("browser_exchange_invalid")
	}
	return &BrowserExchange{ctx: ctx, peer: peer, pending: make(map[string]*browserExchangeCall), ready: make(chan *browserExchangeCall, 8)}, nil
}
func browserLease(command browser.Command) (browser.Lease, bool) {
	switch c := command.(type) {
	case browser.PrepareCommand:
		return c.Lease, true
	case browser.VerifySendCommand:
		return c.Binding.Lease, true
	case browser.SendCommand:
		return c.Binding.Lease, true
	case browser.ObserveCommand:
		return c.Binding.Lease, true
	case browser.CancelCommand:
		return c.Binding.Lease, true
	case browser.DisposeCommand:
		return c.Lease, true
	}
	return browser.Lease{}, false
}
func boundedBrowserDeadline(deadline uint64) (time.Time, error) {
	if deadline > math.MaxInt64 {
		return time.Time{}, errors.New("browser_deadline_invalid")
	}
	value := time.UnixMilli(int64(deadline))
	remaining := time.Until(value)
	if remaining <= 0 || remaining > 15*time.Second {
		return time.Time{}, errors.New("browser_deadline_invalid")
	}
	return value, nil
}
func (b *BrowserExchange) Exchange(ctx context.Context, command browser.Command) (browser.Reply, error) {
	if ctx == nil || ctx.Err() != nil || b.ctx.Err() != nil {
		return nil, errors.New("browser_exchange_unavailable")
	}
	lease, ok := browserLease(command)
	if !ok || lease.Identity.ProfileID != b.peer.ProfileId || lease.BackendGeneration != b.peer.BackendGeneration {
		return nil, errors.New("browser_exchange_identity")
	}
	kind, body, deadline, err := encodeBrowserCommand(command)
	if err != nil {
		return nil, err
	}
	until, err := boundedBrowserDeadline(deadline)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithDeadline(ctx, until)
	defer cancel()
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	call := &browserExchangeCall{command: wire.BrowserCommand{CommandId: id, Kind: kind, Body: body}, ctx: callCtx, reply: make(chan browserReplyResult, 1)}
	b.mu.Lock()
	if len(b.pending) >= 8 || b.issued >= 4096 {
		b.mu.Unlock()
		return nil, errors.New("browser_exchange_saturated")
	}
	b.issued++
	b.pending[id] = call
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
	select {
	case b.ready <- call:
	case <-callCtx.Done():
		return nil, callCtx.Err()
	case <-b.ctx.Done():
		return nil, b.ctx.Err()
	default:
		return nil, errors.New("browser_exchange_saturated")
	}
	select {
	case result := <-call.reply:
		return result.reply, result.err
	case <-callCtx.Done():
		return nil, callCtx.Err()
	case <-b.ctx.Done():
		return nil, b.ctx.Err()
	}
}
func (b *BrowserExchange) next(ctx context.Context, deadline uint64) (*wire.BrowserCommand, error) {
	until, err := boundedBrowserDeadline(deadline)
	if err != nil {
		return nil, err
	}
	wait, cancel := context.WithDeadline(ctx, until)
	defer cancel()
	for {
		select {
		case <-b.ctx.Done():
			return nil, b.ctx.Err()
		case <-wait.Done():
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, nil
		case call := <-b.ready:
			b.mu.Lock()
			live := b.pending[call.command.CommandId] == call && !call.delivered && !call.completed && call.ctx.Err() == nil
			if live {
				call.delivered = true
			}
			b.mu.Unlock()
			if live {
				copy := call.command
				copy.Body = append(json.RawMessage(nil), copy.Body...)
				return &copy, nil
			}
		}
	}
}
func (b *BrowserExchange) complete(reply wire.BrowserReply) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	call := b.pending[reply.CommandId]
	if call == nil || !call.delivered || call.completed || call.ctx.Err() != nil || b.ctx.Err() != nil {
		return errors.New("browser_reply_not_current")
	}
	// Consume before parsing. A malformed or crossed reply cannot be corrected by
	// another Send, another completion or a later request with the same call ID.
	call.completed = true
	if reply.Kind != call.command.Kind {
		err := errors.New("browser_reply_kind_mismatch")
		call.reply <- browserReplyResult{err: err}
		return err
	}
	result, err := decodeBrowserReply(reply.Kind, reply.Body)
	call.reply <- browserReplyResult{reply: result, err: err}
	return err
}
func (b *BrowserExchange) Methods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"chat.browser.next": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("BrowserNext", r.Body) != nil {
				return invalidIngress()
			}
			var body wire.BrowserNext
			if json.Unmarshal(r.Body, &body) != nil {
				return invalidIngress()
			}
			command, err := b.next(ctx, wireUint(body.DeadlineMillis))
			if err != nil {
				return &desktop.Outcome{Status: "unavailable", Code: "browser_exchange_unavailable"}, nil
			}
			value := wire.BrowserNextResult{Command: command}
			raw, _ := json.Marshal(value)
			return &desktop.Outcome{Status: "ok", Data: raw}, nil
		}},
		"chat.browser.reply": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ctx.Err() != nil || ipc.ValidateJSON(r.Body) != nil || wire.Validate("BrowserReply", r.Body) != nil {
				return invalidIngress()
			}
			var body wire.BrowserReply
			if json.Unmarshal(r.Body, &body) != nil || r.OperationID != body.CommandId {
				return invalidIngress()
			}
			if err := b.complete(body); err != nil {
				return &desktop.Outcome{Status: "refused", Code: "browser_reply_refused"}, nil
			}
			return &desktop.Outcome{Status: "ok", Data: json.RawMessage(`{}`)}, nil
		}},
	}
}
