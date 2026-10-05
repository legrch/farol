package conversation

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
)

// SendCurrent wraps one private live dispatch capability, with independent DTOs.
// It authorizes only this Send's final disclosure, not another Computer operation.
type SendCurrent struct{ current port.SendCurrent }

func (c *SendCurrent) WithCurrent(ctx context.Context, inspect func(*Binding) error) error {
	if c == nil || c.current == nil {
		return failure(lifecycle.Invalid)
	}
	if inspect == nil {
		// The live owner must invalidate an earlier positive inspection, even
		// when this wrapper can already classify the new callback as invalid.
		return failure(c.current.WithCurrent(ctx, nil))
	}
	var inspected error
	err := c.current.WithCurrent(ctx, func(b port.TurnBinding) error {
		out := fromBinding(b)
		inspected = inspect(&out)
		return inspected
	})
	if inspected != nil {
		return inspected
	}
	return failure(err)
}

// AccountSnapshot is a detached fact projection, never a grant or an approval.
// Zero denotes an unqualified witness. The underlying current expires at dispatch.
type AccountSnapshot struct {
	State, Source, PrincipalKey       string
	ObservedAtMillis, ExpiresAtMillis uint64
}

func (c *SendCurrent) AccountSnapshot(ctx context.Context) (*AccountSnapshot, error) {
	if c == nil || c.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	v, err := c.current.AccountSnapshot(ctx)
	if err != nil {
		return nil, failure(err)
	}
	return &AccountSnapshot{State: v.State, Source: v.Source, PrincipalKey: v.PrincipalKey, ObservedAtMillis: v.ObservedAtMillis, ExpiresAtMillis: v.ExpiresAtMillis}, nil
}

// The function port makes missing callbacks unambiguous without reflection.
type SendAuthorization func(context.Context, *SendCurrent) error

func mapSendAuthorization(selected SendAuthorization) port.SendAuthorization {
	return func(ctx context.Context, current port.SendCurrent) error {
		return selected(ctx, &SendCurrent{current: current})
	}
}

// CreateAuthorized captures the final Send guard in the existing Chat lifecycle.
func (f *Facade) CreateAuthorized(ctx context.Context, input Input, authorization SendAuthorization) (*Handle, error) {
	if f == nil || f.service == nil || authorization == nil {
		return nil, failure(lifecycle.Invalid)
	}
	c, err := f.service.CreateConversationAuthorized(ctx, toInput(input), mapSendAuthorization(authorization))
	if c == nil {
		return nil, failure(err)
	}
	return &Handle{facade: f, current: c}, failure(err)
}

func (f *Facade) PromoteReadIntentAuthorized(ctx context.Context, r *ReadIntent, input Input, authorization SendAuthorization) (*Handle, error) {
	if f == nil || f.service == nil || r == nil || r.facade != f || r.actual == nil || authorization == nil {
		return nil, failure(lifecycle.Invalid)
	}
	c, err := f.service.PromoteConversationAuthorized(ctx, r.actual, toInput(input), mapSendAuthorization(authorization))
	if err != nil {
		return nil, failure(err)
	}
	return &Handle{facade: f, current: c}, nil
}
