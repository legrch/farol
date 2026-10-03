// Package admission publishes the ordinary Chat current-owner callback seam.
// It is an in-process guard, not a wire endpoint or an admission/grant engine.
package admission

import (
	"context"
	"errors"

	admissionsvc "github.com/legrch/farol/modules/chat/app/services/admission"
)

// TaskBinding is independent of app/domain and Computer/wire DTOs. A Computer
// infra/peer adapter explicitly maps it to its consumer-owned binding language.
// Only the actual owning admission supplies TaskEpoch and ParticipantID.
type TaskBinding struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
}

type Failure struct{ Code, Source, Retry string }

func (f *Failure) Error() string { return f.Code }

func failure(err error) error {
	var classified admissionsvc.Code
	if errors.As(err, &classified) {
		switch classified {
		case admissionsvc.Invalid, admissionsvc.Unavailable, admissionsvc.Mismatch,
			admissionsvc.Unsettled, admissionsvc.Cancelled:
			return &Failure{Code: string(classified), Source: "task-admission", Retry: "never"}
		}
	}
	return &Failure{Code: "CHAT_ADMISSION_UNAVAILABLE", Source: "task-admission", Retry: "never"}
}

// Current is captured from one successful owning admission by trusted assembly.
// It has no body-ID lookup, latest-task lookup or method that creates authority.
// Reuse it throughout one Computer operation and its final disclosure.
type Current struct{ service *admissionsvc.Service }

func New(service *admissionsvc.Service) *Current { return &Current{service: service} }

// WithCurrent calls inspect once under the live Chat owner's no-IO gate. nil is
// absent; errors mean unavailable. Completion/revoke serializes with this entire
// callback, invalidates under Chat's gate, then releases it before Computer updates.
// Computer's native qualification precedes its AccessRepository gate, which
// precedes this gate. Neither callback can perform IO, mutation or reentrancy.
func (c *Current) WithCurrent(ctx context.Context, inspect func(*TaskBinding) error) error {
	if c == nil || c.service == nil || inspect == nil {
		return failure(admissionsvc.Invalid)
	}
	var inspected error
	err := c.service.WithCurrent(ctx, func(binding *admissionsvc.TaskBinding) error {
		if binding == nil {
			inspected = inspect(nil)
			return inspected
		}
		out := TaskBinding{OwnerID: binding.OwnerID, SessionID: binding.SessionID,
			TaskID: binding.TaskID, TaskEpoch: binding.TaskEpoch,
			ParticipantID: binding.ParticipantID, TurnID: binding.TurnID}
		inspected = inspect(&out)
		return inspected
	})
	if inspected != nil {
		return inspected
	}
	if err != nil {
		return failure(err)
	}
	return nil
}
