// Package admission projects the existing ordinary Chat owner for Computer.
// It creates no admission, task lifecycle, grant, journal or browser operation.
package admission

import (
	"context"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_ADMISSION_INVALID"
	Unavailable Code = "CHAT_ADMISSION_UNAVAILABLE"
	Mismatch    Code = "CHAT_ADMISSION_MISMATCH"
	Unsettled   Code = "CHAT_ADMISSION_UNSETTLED"
	Cancelled   Code = "CHAT_ADMISSION_CANCELLED"
)

// TaskBinding is membership/correlation, not a Computer grant or execution lease.
// Its values come only from the live owning admission under the callback gate.
type TaskBinding struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
}

type Service struct {
	owner port.BoundTurn
	fixed port.TurnBinding
}

// New captures the owner handle and its immutable route correlation. Neither
// construction nor Binding alone grants current admission; every phase calls
// WithCurrent again. Trusted composition supplies the actual owning handle.
func New(owner port.BoundTurn) (*Service, error) {
	if owner == nil {
		return nil, Unavailable
	}
	fixed := owner.Binding()
	if !validBinding(fixed) {
		return nil, Invalid
	}
	return &Service{owner: owner, fixed: fixed}, nil
}

// WithCurrent is a synchronous, no-IO guard. The inspect callback must be pure,
// non-reentrant and complete under the owner's gate, including final disclosure.
func (s *Service) WithCurrent(ctx context.Context, inspect func(*TaskBinding) error) error {
	if s == nil || s.owner == nil || ctx == nil || inspect == nil {
		return Invalid
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	calls := 0
	var rejected error
	var inspected error
	err := s.owner.WithCurrent(ctx, func(current *port.CurrentTurn) error {
		calls++
		if calls != 1 {
			rejected = Unavailable
			return rejected
		}
		if ctx.Err() != nil {
			rejected = Cancelled
			return rejected
		}
		binding, err := s.project(current)
		if err != nil {
			rejected = err
			return err
		}
		inspected = inspect(binding)
		return inspected
	})
	// Broken owner callback protocol cannot turn into a successful empty read.
	if calls != 1 {
		return Unavailable
	}
	if rejected != nil {
		return rejected
	}
	if inspected != nil {
		return inspected
	}
	if err != nil {
		// Raw storage/native diagnostics cannot escape this owning boundary.
		return Unavailable
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}

func (s *Service) project(current *port.CurrentTurn) (*TaskBinding, error) {
	if current == nil {
		return nil, nil
	}
	if current.Binding != s.fixed || current.Turn.Identity != identity(s.fixed) {
		return nil, Mismatch
	}
	if current.Persistence != port.Committed {
		return nil, Unsettled
	}
	view := current.Turn
	if view.Phase == turn.Unknown || (view.HasResult && view.Result.Outcome == turn.UnknownOutcome) {
		return nil, Unsettled
	}
	switch view.Phase {
	case turn.Admitted, turn.Pending, turn.Running, turn.AwaitingOwner:
		if view.HasResult {
			return nil, Invalid
		}
		// These phases restrict a real admission; they never create one from
		// provider status. The injected live owner is the source of membership.
	case turn.ResultReady, turn.Delivered, turn.Cancelled:
		if !view.HasResult {
			return nil, Invalid
		}
		return nil, nil
	default:
		return nil, Invalid
	}
	return &TaskBinding{OwnerID: s.fixed.OwnerID, SessionID: s.fixed.SessionID,
		TaskID: s.fixed.TaskID, TaskEpoch: s.fixed.TaskEpoch,
		ParticipantID: s.fixed.ParticipantID, TurnID: s.fixed.TurnID}, nil
}

func identity(binding port.TurnBinding) turn.Identity {
	return turn.Identity{ProfileID: binding.ProfileID, OwnerID: binding.OwnerID,
		SessionID: binding.SessionID, TaskID: binding.TaskID, TurnID: binding.TurnID,
		OperationID: binding.OperationID, Generation: binding.TurnGeneration}
}

func validBinding(binding port.TurnBinding) bool {
	for _, value := range []string{binding.ProfileID, binding.BackendGeneration,
		binding.OwnerID, binding.SessionID, binding.TaskID, binding.ParticipantID,
		binding.TurnID, binding.OperationID} {
		if len(value) == 0 || len(value) > 120 || !utf8.ValidString(value) {
			return false
		}
		for _, ch := range value {
			if ch <= 32 || ch == 127 {
				return false
			}
		}
	}
	return binding.TurnGeneration > 0
}
