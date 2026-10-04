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
	if c == nil || c.current == nil || inspect == nil {
		return failure(lifecycle.Invalid)
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

type SendAuthorization interface {
	Authorize(context.Context, *SendCurrent) error
}
type sendAuthorization struct{ selected SendAuthorization }

func (a sendAuthorization) Authorize(ctx context.Context, current port.SendCurrent) error {
	return a.selected.Authorize(ctx, &SendCurrent{current: current})
}

func (f *Facade) PromoteReadIntentAuthorized(ctx context.Context, r *ReadIntent, input Input, authorization SendAuthorization) (*Handle, error) {
	if f == nil || f.service == nil || r == nil || r.facade != f || r.actual == nil || authorization == nil {
		return nil, failure(lifecycle.Invalid)
	}
	c, err := f.service.PromoteConversationAuthorized(ctx, r.actual, toInput(input), sendAuthorization{selected: authorization})
	if err != nil {
		return nil, failure(err)
	}
	return &Handle{facade: f, current: c}, nil
}
