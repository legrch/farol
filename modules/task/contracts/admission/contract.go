// Package admission publishes inspection of one trusted selected coding task.
// This contract does not admit tasks, issue Computer grants or observe providers.
package admission

import (
	"context"
	"errors"

	admissioncap "github.com/legrch/farol/modules/task/app/capabilities/admission"
	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type Binding struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
}

type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

type Contract struct{ controller *admissioncap.Controller }

func New(controller *admissioncap.Controller) *Contract { return &Contract{controller} }

// WithCurrent preserves the owner's synchronous, no-IO gate through explicit
// DTO conversion. The Computer peer maps this value to its consumer-owned port.
// Computer acquires its qualified AccessRepository snapshot before entering
// this callback. inspect must perform no IO, mutation or reentrancy. A nil
// binding means absent/revoked, while a Failure means unavailable or mismatch.
// Ordinary Chat model turns are owned and selected through Chat, never here.
func (c *Contract) WithCurrent(ctx context.Context, inspect func(*Binding) error) error {
	if c == nil || c.controller == nil || inspect == nil {
		return &Failure{"TASK_UNAVAILABLE"}
	}
	var inspected error
	err := c.controller.WithCurrent(ctx, func(current *port.CurrentBinding) error {
		var out *Binding
		if current != nil {
			out = &Binding{OwnerID: current.OwnerID, SessionID: current.SessionID, TaskID: current.TaskID,
				TaskEpoch: current.TaskEpoch, ParticipantID: current.ParticipantID, TurnID: current.TurnID}
		}
		inspected = inspect(out)
		return inspected
	})
	if err == nil {
		return nil
	}
	if inspected != nil && errors.Is(err, inspected) {
		return inspected
	}
	code := "TASK_UNAVAILABLE"
	if errors.Is(err, task.ErrIdentity) {
		code = "TASK_IDENTITY_MISMATCH"
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		code = "TASK_REQUEST_CANCELLED"
	}
	return &Failure{code}
}
