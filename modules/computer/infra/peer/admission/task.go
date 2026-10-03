package admission

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	taskct "github.com/legrch/farol/modules/task/contracts/admission"
)

type taskCurrent interface {
	WithCurrent(context.Context, func(*taskct.Binding) error) error
}

type Task struct{ current taskCurrent }

var _ port.CurrentTaskAdmission = (*Task)(nil)

// NewTask takes the selected delegated coding task, never an ordinary Chat turn.
// The owner already bound the Farol authority session and participant; provider
// thread/session/turn IDs and request bodies cannot substitute for that binding.
func NewTask(current *taskct.Contract) (*Task, error) {
	if current == nil {
		return nil, unavailable()
	}
	return &Task{current: current}, nil
}

func (c *Task) WithCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	if c == nil || c.current == nil {
		return unavailable()
	}
	return inspectCurrent(ctx, inspect, func(project func(*port.TaskBinding) error) error {
		return c.current.WithCurrent(ctx, func(binding *taskct.Binding) error {
			if binding == nil {
				return project(nil)
			}
			independent := port.TaskBinding{
				Identity: authority.Identity{OwnerID: binding.OwnerID,
					SessionID: binding.SessionID, TaskID: binding.TaskID, TaskEpoch: binding.TaskEpoch},
				ParticipantID: binding.ParticipantID, TurnID: binding.TurnID,
			}
			return project(&independent)
		})
	}, taskFailure)
}

func taskFailure(err error) error {
	var failure *taskct.Failure
	if errors.As(err, &failure) && failure != nil {
		switch failure.Code {
		case "TASK_IDENTITY_MISMATCH":
			return mismatch()
		case "TASK_REQUEST_CANCELLED":
			return cancelled()
		}
	}
	return unavailable()
}
