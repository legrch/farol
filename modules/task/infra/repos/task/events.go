package task

import (
	"context"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

var _ port.EventJournal = (*Filesystem)(nil)
var _ port.EventJournal = (*Route)(nil)
var _ port.RetainedLookup = (*Route)(nil)

func (j *Filesystem) RecordEvent(ctx context.Context, e task.ExecutionEvent) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.update(ctx, func(image *filesystemImage) (bool, error) {
		op, ok := image.Operations[e.DispatchID]
		if !ok {
			return false, task.ErrNotFound
		}
		i := op.Intent
		ref := op.Lineage
		if op.Settled && op.Receipt.State == task.Known {
			ref = op.Receipt.Reference
		}
		if i.TaskID != e.RunID || e.Reference != ref || !e.Valid(i.Binding.Provider) || i.Action != task.Create && i.Action != task.Continue && i.Action != task.Resume {
			return false, task.ErrIdentity
		}
		if op.Settled && (op.Receipt.State != task.Known || op.Receipt.Lifecycle.Terminal()) {
			return false, task.ErrState
		}
		if !op.Events.Valid(i.TaskID, i.OperationID, i.Binding.Provider, ref) {
			return false, task.ErrUnknown
		}
		next, err := op.Events.Append(e, i.Binding.Provider)
		if err != nil {
			return false, err
		}
		if next.LastSequence == op.Events.LastSequence && next.LastSource == op.Events.LastSource {
			return false, nil
		}
		op.Events = next
		image.Operations[e.DispatchID] = op
		return true, nil
	})
}
func (r *Route) RecordEvent(ctx context.Context, e task.ExecutionEvent) error {
	o := r.owner
	o.write.Lock()
	defer o.write.Unlock()
	op, err := r.operation(ctx, e.DispatchID)
	if err != nil {
		return err
	}
	if op == nil || e.RunID != o.taskID {
		return task.ErrIdentity
	}
	journal, ok := o.store.(port.EventJournal)
	if !ok {
		return task.ErrUnsupported
	}
	// Read the current publication token without changing admission. Fence can
	// invalidate it during IO; metadata never republishes a positive projection.
	o.gate.Lock()
	version := o.version
	available := o.binding == r.binding && o.state != unavailable && o.state != absent
	o.gate.Unlock()
	if !available {
		return task.ErrUnavailable
	}
	if err := journal.RecordEvent(ctx, e); err != nil {
		if err == task.ErrUnknown {
			r.Fence()
		}
		return err
	}
	o.gate.Lock()
	current := o.version == version && o.binding == r.binding && o.state != unavailable
	o.gate.Unlock()
	if !current {
		return task.ErrUnknown
	}
	return nil
}
func (r *Route) LookupRetained(ctx context.Context, id string) (*port.Operation, error) {
	op, err := r.owner.store.Lookup(ctx, id)
	if err != nil {
		r.Fence()
		return nil, task.ErrUnknown
	}
	if op == nil {
		return nil, nil
	}
	b := op.Intent.Admission
	current := r.binding
	if op.Intent.TaskID != r.owner.taskID || b.OwnerID != current.OwnerID || b.SessionID != current.SessionID || b.ParticipantID != current.ParticipantID || b.TaskID != current.TaskID || b.TaskEpoch > current.TaskEpoch || b.TaskEpoch == current.TaskEpoch && b.TurnID != current.TurnID {
		return nil, task.ErrIdentity
	}
	return op, nil // Retained access does not issue execution admission.
}
