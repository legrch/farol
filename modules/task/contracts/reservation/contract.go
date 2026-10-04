// Package reservation publishes durable native-launch correlation for one
// trusted selected Task route. It never prepares/spawns a process or issues an
// execution lease. Root maps the consumer's own DTOs explicitly.
package reservation

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type Binding struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
}
type RootIdentity struct{ Device, Inode string }
type Seal struct {
	Digest, WorkspaceID, Root, Cwd string
	RootIdentity                   RootIdentity
	Write                          bool
}
type Intent struct {
	OperationID      string
	Binding          Binding
	Seal             Seal
	DeadlineUnixNano int64
}
type Status string

const (
	Reserved Status = "reserved"
	Existing Status = "existing"
)

type Receipt struct {
	Status Status
	Intent Intent
}
type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

type Contract struct {
	owner    port.SelectedReservation
	selected task.AdmissionBinding
}

func New(owner port.SelectedReservation) (contract *Contract, err error) {
	// Selection is a pure application port. A typed-nil route cannot supply a
	// binding; reject its dereference without reflection or diagnostic disclosure.
	defer func() {
		if recover() != nil {
			contract, err = nil, &Failure{"TASK_RESERVATION_UNAVAILABLE"}
		}
	}()
	if owner == nil {
		return nil, &Failure{"TASK_RESERVATION_UNAVAILABLE"}
	}
	b := owner.Selection()
	selected := task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
	if !selected.Valid() {
		return nil, &Failure{"TASK_INPUT_INVALID"}
	}
	return &Contract{owner, selected}, nil
}
func toIntent(in Intent) task.NativeReservation {
	b, s := in.Binding, in.Seal
	return task.NativeReservation{OperationID: in.OperationID,
		Admission: task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID},
		Seal:      task.NativeSeal{Digest: s.Digest, WorkspaceID: s.WorkspaceID, Root: s.Root, Cwd: s.Cwd, RootIdentity: task.NativeRootIdentity{Device: s.RootIdentity.Device, Inode: s.RootIdentity.Inode}, Write: s.Write}, DeadlineUnixNano: in.DeadlineUnixNano}
}
func fromIntent(in task.NativeReservation) Intent {
	b, s := in.Admission, in.Seal
	return Intent{OperationID: in.OperationID,
		Binding: Binding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID},
		Seal:    Seal{Digest: s.Digest, WorkspaceID: s.WorkspaceID, Root: s.Root, Cwd: s.Cwd, RootIdentity: RootIdentity{Device: s.RootIdentity.Device, Inode: s.RootIdentity.Inode}, Write: s.Write}, DeadlineUnixNano: in.DeadlineUnixNano}
}
func failure(err error) error {
	code := "TASK_RESERVATION_UNKNOWN"
	switch {
	case errors.Is(err, task.ErrInvalid):
		code = "TASK_INPUT_INVALID"
	case errors.Is(err, task.ErrIdentity):
		code = "TASK_IDENTITY_MISMATCH"
	case errors.Is(err, task.ErrConflict):
		code = "TASK_OPERATION_CONFLICT"
	case errors.Is(err, task.ErrNotFound):
		code = "TASK_NOT_FOUND"
	case errors.Is(err, task.ErrState):
		code = "TASK_STATE_REFUSED"
	case errors.Is(err, task.ErrUnavailable), errors.Is(err, task.ErrUnsupported):
		code = "TASK_RESERVATION_UNAVAILABLE"
	}
	return &Failure{code}
}

// Reserve delegates to the application-selected Owner port. A retained Existing
// receipt is never converted into Reserved, even after restart or a new epoch.
func (c *Contract) Reserve(ctx context.Context, in Intent) (*Receipt, error) {
	if c == nil || c.owner == nil {
		return nil, &Failure{"TASK_RESERVATION_UNAVAILABLE"}
	}
	i := toIntent(in)
	if ctx == nil || !i.Valid() {
		return nil, &Failure{"TASK_INPUT_INVALID"}
	}
	if err := ctx.Err(); err != nil {
		return nil, failure(err)
	}
	if i.Admission != c.selected {
		return nil, &Failure{"TASK_IDENTITY_MISMATCH"}
	}
	out, err := c.owner.ReserveNative(ctx, i)
	if err != nil {
		return nil, failure(err)
	}
	if out == nil || out.Intent != i {
		return nil, &Failure{"TASK_RESERVATION_UNKNOWN"}
	}
	var status Status
	switch out.Status {
	case port.Reserved:
		status = Reserved
	case port.Existing:
		status = Existing
	default:
		return nil, &Failure{"TASK_RESERVATION_UNKNOWN"}
	}
	return &Receipt{Status: status, Intent: fromIntent(out.Intent)}, nil
}
