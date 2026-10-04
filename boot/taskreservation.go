package boot

import (
	"context"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	reservationct "github.com/legrch/farol/modules/task/contracts/reservation"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

// The selected Task route owns the existing journal and admission. Root only
// maps immutable correlation into its published reservation contract; it never
// creates a journal, extends a deadline or turns retained state into permission.
type taskProcessReservation struct{ selected *reservationct.Contract }

var _ processsvc.Reservation = (*taskProcessReservation)(nil)

func newTaskProcessReservation(route *taskrepo.Route) (*taskProcessReservation, error) {
	selected, err := reservationct.New(route)
	if err != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_RESERVATION_UNAVAILABLE")
	}
	return &taskProcessReservation{selected: selected}, nil
}

func (r *taskProcessReservation) Reserve(ctx context.Context, in processsvc.Intent) (*processsvc.ReservationReceipt, error) {
	unknown := func() (*processsvc.ReservationReceipt, error) {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_RESERVATION_UNKNOWN")
	}
	if r == nil || r.selected == nil || ctx == nil || ctx.Err() != nil {
		return unknown()
	}
	// UnixNano overflows outside its representable interval. Require the original
	// positive instant to round-trip, retaining its monotonic component on return.
	deadline := in.Deadline.UnixNano()
	if deadline <= 0 || !time.Unix(0, deadline).Equal(in.Deadline) {
		return unknown()
	}
	b, s := in.Binding, in.Seal
	mapped := reservationct.Intent{OperationID: in.OperationID,
		Binding:          reservationct.Binding{OwnerID: b.Identity.OwnerID, SessionID: b.Identity.SessionID, TaskID: b.Identity.TaskID, TaskEpoch: b.Identity.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID},
		Seal:             reservationct.Seal{Digest: s.Digest, WorkspaceID: s.WorkspaceID, Root: s.Root, Cwd: s.Cwd, RootIdentity: reservationct.RootIdentity{Device: s.RootIdentity.Device, Inode: s.RootIdentity.Inode}, Write: s.Write},
		DeadlineUnixNano: deadline,
	}
	out, err := r.selected.Reserve(ctx, mapped)
	if err != nil || out == nil || out.Intent != mapped || ctx.Err() != nil {
		return unknown()
	}
	var status processsvc.ReservationStatus
	switch out.Status {
	case reservationct.Reserved:
		status = processsvc.Reserved
	case reservationct.Existing:
		status = processsvc.Existing
	default:
		return unknown()
	}
	return &processsvc.ReservationReceipt{Status: status, Intent: in}, nil
}
