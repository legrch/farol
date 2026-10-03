package admission

import (
	"context"
	"errors"

	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// The private interface permits labelled contract doubles in adapter tests.
// Production construction accepts only the concrete published selected owner.
type chatCurrent interface {
	WithCurrent(context.Context, func(*chatct.TaskBinding) error) error
}

type Chat struct{ current chatCurrent }

var _ port.CurrentTaskAdmission = (*Chat)(nil)

// NewChat takes the ordinary model turn's already selected owning handle.
// It neither inspects nor creates admission; request IDs cannot select a route.
func NewChat(current *chatct.Current) (*Chat, error) {
	if current == nil {
		return nil, unavailable()
	}
	return &Chat{current: current}, nil
}

func (c *Chat) WithCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	if c == nil || c.current == nil {
		return unavailable()
	}
	return inspectCurrent(ctx, inspect, func(project func(*port.TaskBinding) error) error {
		return c.current.WithCurrent(ctx, func(binding *chatct.TaskBinding) error {
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
	}, chatFailure)
}

func chatFailure(err error) error {
	var failure *chatct.Failure
	if errors.As(err, &failure) && failure != nil {
		switch failure.Code {
		case "CHAT_ADMISSION_MISMATCH":
			return mismatch()
		case "CHAT_ADMISSION_CANCELLED":
			return cancelled()
		}
	}
	// Invalid, absent infrastructure, unsettled and unknown owner errors all
	// refuse under the existing Computer vocabulary, never as known absence.
	return unavailable()
}
