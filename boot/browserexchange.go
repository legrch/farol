package boot

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	browser "github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/pkg/exchange"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type browserReplyResult struct {
	reply browser.Reply
	err   error
}

// browserLiveCalls bounds the reciprocal calls one exchange retains.
const browserLiveCalls = 8

// BrowserExchange is transport correlation for one inherited host pipe, not a
// scheduler or turn owner. It retains at most eight one-shot reciprocal calls.
// Memory is bounded by those live calls only: a settled call leaves the queue
// and its random command ID is never reissued, so a late or repeated reply is
// refused without a lifetime history. Chat owns all admission, intent, queue,
// result and retry policy.
type BrowserExchange struct {
	ctx   context.Context
	peer  wire.Context
	queue *exchange.Queue[browser.Reply]
}

func NewBrowserExchange(ctx context.Context, peer wire.Context) (*BrowserExchange, error) {
	if ctx == nil || ctx.Err() != nil || !validIngressID(peer.ProfileId) || !validIngressID(peer.BackendGeneration) {
		return nil, errors.New("browser_exchange_invalid")
	}
	queue, err := exchange.New[browser.Reply](ctx, browserLiveCalls)
	if err != nil {
		return nil, errors.New("browser_exchange_invalid")
	}
	return &BrowserExchange{ctx: ctx, peer: peer, queue: queue}, nil
}

// QuiescePolling is transport shutdown after the actual Chat owner retires.
// It wakes an idle reciprocal poll without closing the pipe needed for the
// retirement ACK. Outstanding effects must settle first; this supplies no
// provider cleanup or retirement proof and cannot be reversed.
func (b *BrowserExchange) QuiescePolling() error {
	if b.queue.Quiesce() != nil {
		return errors.New("browser_exchange_not_quiescent")
	}
	return nil
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
	value, err := exchange.Deadline(deadline)
	if err != nil {
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
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	call, err := b.queue.Submit(ctx, until, exchange.Command{ID: id, Kind: kind, Body: body})
	if err != nil {
		return nil, browserSubmitError(err)
	}
	defer call.Release()
	return call.Wait()
}
func browserSubmitError(err error) error {
	if errors.Is(err, exchange.ErrQuiesced) {
		return errors.New("browser_exchange_quiesced")
	}
	if errors.Is(err, exchange.ErrSaturated) {
		return errors.New("browser_exchange_saturated")
	}
	return errors.New("browser_exchange_unavailable")
}
func (b *BrowserExchange) next(ctx context.Context, deadline uint64) (*wire.BrowserCommand, error) {
	until, err := boundedBrowserDeadline(deadline)
	if err != nil {
		return nil, err
	}
	command, err := b.queue.Next(ctx, until)
	if err != nil || command == nil {
		return nil, err
	}
	return &wire.BrowserCommand{CommandId: command.ID, Kind: command.Kind, Body: command.Body}, nil
}
func (b *BrowserExchange) complete(reply wire.BrowserReply) error {
	// The queue consumes the call before this parses. A malformed or crossed
	// reply cannot be corrected by another Send, another completion or a later
	// request with the same call ID.
	err := b.queue.Complete(reply.CommandId, func(sent exchange.Command) (browser.Reply, error) {
		if reply.Kind != sent.Kind {
			return nil, errors.New("browser_reply_kind_mismatch")
		}
		return decodeBrowserReply(reply.Kind, reply.Body)
	})
	if errors.Is(err, exchange.ErrNotCurrent) {
		return errors.New("browser_reply_not_current")
	}
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
