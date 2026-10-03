package task

import (
	"context"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

func (r *Route) Admit(ctx context.Context, intent task.Intent, revision uint64, prepared task.Task) (*port.Admission, error) {
	o := r.owner
	o.write.Lock()
	defer o.write.Unlock()
	if intent.TaskID != o.taskID || intent.Admission != r.binding || prepared.ID != o.taskID || prepared.Admission.Binding != r.binding {
		return nil, task.ErrIdentity
	}
	if op, err := r.operation(ctx, intent.OperationID); err != nil {
		return nil, err
	} else if op != nil {
		// An existing intent is a read receipt, never an activation/retry.
		if op.Intent != intent {
			return nil, task.ErrConflict
		}
		snap, err := r.Read(ctx, o.taskID)
		if err != nil {
			return nil, err
		}
		if snap == nil {
			r.Fence()
			return nil, task.ErrUnknown
		}
		return &port.Admission{Operation: *op, Snapshot: *snap}, nil
	}
	before, err := r.Read(ctx, o.taskID)
	if err != nil {
		return nil, err
	}
	launch := intent.Action == task.Create || intent.Action == task.Continue || intent.Action == task.Resume
	if launch {
		if prepared.Admission.State != task.AdmissionActive {
			return nil, task.ErrState
		}
		if intent.Action == task.Create {
			if before != nil {
				return nil, task.ErrConflict
			}
		} else if before == nil || before.Pending != "" || !r.binding.Advances(before.Task.Admission.Binding) || before.Task.Admission.State == task.AdmissionActive || !(before.Task.Lifecycle == task.Completed || before.Task.Lifecycle == task.Failed || before.Task.Lifecycle == task.Interrupted) {
			return nil, task.ErrState
		}
	} else if before == nil || before.Task.Admission.Binding != r.binding {
		return nil, task.ErrIdentity
	}
	version, err := r.begin(launch, intent.Action == task.Cancel, intent.Action == task.Message)
	if err != nil {
		return nil, err
	}
	admitted, err := o.store.Admit(ctx, intent, revision, prepared)
	if err != nil {
		r.Fence()
		return nil, err
	}
	if admitted == nil || admitted.Operation.Intent != intent || admitted.Snapshot.Task.ID != o.taskID ||
		admitted.Snapshot.Task.Admission != prepared.Admission || (admitted.Claimed &&
		(admitted.Snapshot.Task != prepared || admitted.Snapshot.Pending != intent.OperationID ||
			admitted.Snapshot.Revision <= revision || admitted.Operation.Settled)) {
		r.Fence()
		return nil, task.ErrUnknown
	}
	if admitted.Claimed && !r.published(version, prepared.Admission.State, launch) {
		return nil, task.ErrUnknown
	}
	return admitted, nil
}
func (r *Route) Progress(ctx context.Context, id string, ref task.Reference) error {
	o := r.owner
	o.write.Lock()
	defer o.write.Unlock()
	op, err := r.operation(ctx, id)
	if err != nil {
		return err
	}
	if op == nil || op.Settled {
		return task.ErrState
	}
	version, err := r.begin(false, false, false)
	if err != nil {
		return err
	}
	if err := o.store.Progress(ctx, id, ref); err != nil {
		r.Fence()
		return err
	}
	r.published(version, task.AdmissionActive, false)
	return nil
}
func (r *Route) Finish(ctx context.Context, id string, receipt task.Receipt, next task.Task) error {
	o := r.owner
	o.write.Lock()
	defer o.write.Unlock()
	op, err := r.operation(ctx, id)
	if err != nil {
		return err
	}
	if op == nil || op.Settled {
		return task.ErrState
	}
	if next.ID != o.taskID || next.Admission.Binding != r.binding {
		return task.ErrIdentity
	}
	current, err := r.Read(ctx, o.taskID)
	if err != nil {
		return err
	}
	if current == nil || current.Pending != id || current.Task.Admission.Binding != r.binding {
		return task.ErrState
	}
	// A completion after durable revoke must retain the revoked admission even
	// when its known provider receipt still reports a running task.
	if current.Task.Admission.State == task.AdmissionRevoked || (current.Task.Admission.State == task.AdmissionClosed && next.Admission.State == task.AdmissionActive) {
		next.Admission.State = current.Task.Admission.State
	}
	if receipt.State != task.Known && receipt.State != task.Rejected {
		r.Fence()
		return task.ErrUnknown
	}
	if !next.Admission.State.Valid() || (next.Admission.State == task.AdmissionActive && (next.Lifecycle.Terminal() || next.Lifecycle == task.Refused || next.CancelRequested)) {
		r.Fence()
		return task.ErrState
	}
	terminal := next.Admission.State != task.AdmissionActive
	version, err := r.begin(false, terminal, false)
	if err != nil {
		return err
	}
	if err := o.store.Finish(ctx, id, receipt, next); err != nil {
		r.Fence()
		return err
	}
	r.published(version, next.Admission.State, false)
	return nil
}
func (r *Route) Observe(ctx context.Context, before port.Snapshot, next task.Task) error {
	o := r.owner
	o.write.Lock()
	defer o.write.Unlock()
	if before.Task.ID != o.taskID || next.ID != o.taskID || before.Task.Admission.Binding != r.binding || next.Admission.Binding != r.binding {
		return task.ErrIdentity
	}
	if before.Task.Admission.State == task.AdmissionRevoked {
		next.Admission.State = task.AdmissionRevoked
	}
	if next.Admission.State == task.AdmissionActive && before.Task.Admission.State != task.AdmissionActive {
		return task.ErrState
	}
	if !next.Admission.State.Valid() || (next.Admission.State == task.AdmissionActive && (next.Lifecycle.Terminal() || next.Lifecycle == task.Refused || next.CancelRequested)) {
		r.Fence()
		return task.ErrState
	}
	terminal := next.Admission.State != task.AdmissionActive
	version, err := r.begin(false, terminal, false)
	if err != nil {
		return err
	}
	if err := o.store.Observe(ctx, before, next); err != nil {
		r.Fence()
		return err
	}
	r.published(version, next.Admission.State, false)
	return nil
}

// Revoke fences BEFORE waiting for any writer or persistence. WithCurrent holds
// no IO lock. Any separate Computer update belongs to the caller after return.
func (r *Route) Revoke(ctx context.Context) error {
	r.Fence()
	o := r.owner
	o.write.Lock()
	defer o.write.Unlock()
	before, err := r.Read(ctx, o.taskID)
	if err != nil {
		return err
	}
	if before == nil {
		return task.ErrNotFound
	}
	if before.Task.Admission.Binding != r.binding {
		return task.ErrIdentity
	}
	if before.Task.Admission.State == task.AdmissionRevoked {
		version, err := r.begin(false, true, false)
		if err != nil {
			return err
		}
		r.published(version, task.AdmissionRevoked, false)
		return nil
	}
	version, err := r.begin(false, true, false)
	if err != nil {
		return err
	}
	if err := o.store.Invalidate(ctx, *before); err != nil {
		r.Fence()
		return err
	}
	r.published(version, task.AdmissionRevoked, false)
	return nil
}
