package task

import (
	"context"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

var _ port.ReservationJournal = (*Filesystem)(nil)
var _ port.SelectedReservation = (*Route)(nil)

// ReserveNative uses the existing atomic image/lease. All publication must go
// through the SAME Owner; this storage method never supplies live admission.
func (j *Filesystem) ReserveNative(ctx context.Context, in task.NativeReservation) (*port.ReservationReceipt, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if ctx == nil || !in.Valid() {
		return nil, task.ErrInvalid
	}
	image, err := j.load(ctx)
	if err != nil {
		return nil, err
	}
	op, found := image.Operations[in.OperationID]
	if !found {
		if j.fenced {
			return nil, task.ErrUnknown
		}
		return nil, task.ErrNotFound
	}
	if !in.Matches(op.Intent) {
		return nil, task.ErrIdentity
	}
	if op.Reservation != (task.NativeReservation{}) {
		if op.Reservation != in {
			return nil, task.ErrConflict
		}
		return &port.ReservationReceipt{Status: port.Existing, Intent: op.Reservation}, nil
	}
	err = j.update(ctx, func(image *filesystemImage) (bool, error) {
		op, snapshot, err := filesystemPending(image, in.OperationID)
		if err != nil {
			return false, err
		}
		if !in.Matches(op.Intent) || snapshot.Task.Admission.Binding != in.Admission {
			return false, task.ErrIdentity
		}
		if snapshot.Task.Admission.State != task.AdmissionActive {
			return false, task.ErrState
		}
		if op.Reservation != (task.NativeReservation{}) {
			return false, task.ErrConflict
		}
		op.Reservation = in
		image.Operations[in.OperationID] = op
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	return &port.ReservationReceipt{Status: port.Reserved, Intent: in}, nil
}

// ReserveNative serializes with the original admission/progress/completion and
// revoke writers. The no-IO gate is released before journal publication. A
// concurrent Fence consumes the token and prevents a positive returned permit.
func (r *Route) ReserveNative(ctx context.Context, in task.NativeReservation) (*port.ReservationReceipt, error) {
	if r == nil || r.owner == nil || ctx == nil || !in.Valid() {
		return nil, task.ErrInvalid
	}
	if in.Admission != r.binding || in.Admission.TaskID != r.owner.taskID {
		return nil, task.ErrIdentity
	}
	o := r.owner
	o.write.Lock()
	defer o.write.Unlock()
	op, err := r.operation(ctx, in.OperationID)
	if err != nil {
		return nil, err
	}
	if op == nil {
		return nil, task.ErrNotFound
	}
	if !in.Matches(op.Intent) {
		return nil, task.ErrIdentity
	}
	if op.Reservation != (task.NativeReservation{}) {
		if op.Reservation != in {
			return nil, task.ErrConflict
		}
		return &port.ReservationReceipt{Status: port.Existing, Intent: op.Reservation}, nil
	}
	if op.Settled {
		return nil, task.ErrState
	}
	journal, ok := o.store.(port.ReservationJournal)
	if !ok {
		return nil, task.ErrUnsupported
	}
	version, err := r.begin(false, false, true)
	if err != nil {
		// An unavailable original route retains its unknown boundary. Absence
		// after restart remains a refusal, never proof of a fresh publication.
		o.gate.Lock()
		unknown := o.state == unavailable && o.binding == r.binding
		o.gate.Unlock()
		if unknown {
			return nil, task.ErrUnknown
		}
		return nil, err
	}
	out, err := journal.ReserveNative(ctx, in)
	if err != nil {
		r.Fence()
		return nil, err
	}
	if out == nil || out.Intent != in || (out.Status != port.Reserved && out.Status != port.Existing) || ctx.Err() != nil {
		r.Fence()
		return nil, task.ErrUnknown
	}
	if !r.published(version, task.AdmissionActive, false) {
		return nil, task.ErrUnknown
	}
	return out, nil
}
