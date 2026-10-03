// Package admission binds a selected coding-task owner's inspection contract.
// It holds an immutable route identity, never a positive admission cache.
package admission

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type Controller struct {
	owner    port.CurrentTaskAdmission
	selected port.CurrentBinding
}

// New is trusted composition, not request dispatch. The existing lifecycle owner
// supplies this exact selection; a caller cannot select its own task or turn.
func New(owner port.CurrentTaskAdmission, selected port.CurrentBinding) (*Controller, error) {
	if owner == nil {
		return nil, task.ErrUnavailable
	}
	if !valid(selected) {
		return nil, task.ErrInvalid
	}
	return &Controller{owner, selected}, nil
}

func valid(b port.CurrentBinding) bool {
	return task.ID(b.OwnerID) && task.ID(b.SessionID) && task.ID(b.TaskID) && b.TaskEpoch != 0 && task.ID(b.ParticipantID) && task.ID(b.TurnID)
}

func (c *Controller) WithCurrent(ctx context.Context, inspect func(*port.CurrentBinding) error) error {
	if c == nil || c.owner == nil || inspect == nil {
		return task.ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	calls := 0
	var inspected error
	err := c.owner.WithCurrent(ctx, func(current *port.CurrentBinding) (callbackErr error) {
		defer func() { inspected = callbackErr }()
		calls++
		if calls != 1 {
			return task.ErrUnavailable
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if current == nil {
			return inspect(nil)
		}
		if *current != c.selected {
			return task.ErrIdentity
		}
		copy := *current
		return inspect(&copy)
	})
	if err != nil {
		// Preserve the consumer callback's classified refusal unchanged; owner
		// failures cannot disclose native/persistence diagnostics through here.
		if inspected != nil && errors.Is(err, inspected) {
			return inspected
		}
		return task.ErrUnavailable
	}
	if calls != 1 {
		return task.ErrUnavailable
	}
	return inspected
}
