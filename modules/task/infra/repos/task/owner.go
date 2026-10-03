// Package task owns one coding task's lifecycle publication through its existing
// durable Journal. It issues no grants and owns no provider/process engine.
package task

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type gateState uint8

const (
	absent gateState = iota
	unavailable
	active
	closed
)

// Owner has one backend/profile lifetime and one TaskID. All writers of this
// Task's journal must go through this object. No active state is restored merely
// by construction, Read, Lookup or a provider observation after restart.
type Owner struct {
	store       port.AdmissionJournal
	taskID      string
	write       sync.Mutex
	gate        sync.Mutex
	binding     task.AdmissionBinding
	state       gateState
	issued      bool
	version     uint64
	closedEpoch uint64
}
type Route struct {
	owner   *Owner
	binding task.AdmissionBinding
}

var _ port.SelectedJournal = (*Route)(nil)

func New(store port.AdmissionJournal, taskID string) (*Owner, error) {
	if store == nil {
		return nil, task.ErrUnavailable
	}
	if !task.ID(taskID) {
		return nil, task.ErrInvalid
	}
	return &Owner{store: store, taskID: taskID}, nil
}

// Select is trusted composition. It changes no lifecycle/admission state. A new
// turn must carry a strictly newer existing task-admission epoch, never a caller
// fabricated generation. Reusing any closed/revoked epoch is prohibited.
func (o *Owner) Select(b port.CurrentBinding) (*Route, error) {
	binding := task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
	if o == nil || !binding.Valid() || binding.TaskID != o.taskID {
		return nil, task.ErrIdentity
	}
	return &Route{o, binding}, nil
}
func (r *Route) Selection() port.CurrentBinding {
	b := r.binding
	return port.CurrentBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
}
func (r *Route) WithCurrent(ctx context.Context, inspect func(*port.CurrentBinding) error) error {
	if r == nil || r.owner == nil || inspect == nil {
		return task.ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	o := r.owner
	o.gate.Lock()
	defer o.gate.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if o.state == unavailable {
		return task.ErrUnavailable
	}
	if o.state != active {
		return inspect(nil)
	}
	if o.binding != r.binding {
		return task.ErrIdentity
	}
	b := r.Selection()
	return inspect(&b)
}

// Fence performs no IO. It invalidates an in-flight publication token as well
// as an already positive projection. An old route cannot fence a newer turn.
func (r *Route) Fence() {
	o := r.owner
	o.gate.Lock()
	defer o.gate.Unlock()
	if o.binding != (task.AdmissionBinding{}) && o.binding != r.binding {
		return
	}
	o.binding = r.binding
	if o.version != ^uint64(0) {
		o.version++
	}
	o.issued = false
	o.state = unavailable
	if r.binding.TaskEpoch > o.closedEpoch {
		o.closedEpoch = r.binding.TaskEpoch
	}
}
func (r *Route) begin(launch, revoke, requireActive bool) (uint64, error) {
	o := r.owner
	o.gate.Lock()
	defer o.gate.Unlock()
	if o.version == ^uint64(0) {
		o.state = unavailable
		o.issued = false
		return 0, task.ErrUnavailable
	}
	if requireActive && (o.state != active || !o.issued) {
		return 0, task.ErrState
	}
	if launch {
		if r.binding.TaskEpoch <= o.closedEpoch || (o.binding != (task.AdmissionBinding{}) && r.binding.TaskEpoch <= o.binding.TaskEpoch) {
			return 0, task.ErrState
		}
		o.binding = r.binding
		o.issued = false
	} else if o.binding != (task.AdmissionBinding{}) && o.binding != r.binding {
		return 0, task.ErrIdentity
	} else if o.binding == (task.AdmissionBinding{}) {
		o.binding = r.binding // Retained observation still cannot issue admission.
	}
	o.version++
	o.state = unavailable // Release the gate BEFORE durable IO.
	if revoke {
		o.issued = false
		if r.binding.TaskEpoch > o.closedEpoch {
			o.closedEpoch = r.binding.TaskEpoch
		}
	}
	return o.version, nil
}
func (r *Route) published(version uint64, state task.AdmissionState, launch bool) bool {
	o := r.owner
	o.gate.Lock()
	defer o.gate.Unlock()
	if o.version != version || o.binding != r.binding || (state == task.AdmissionActive && r.binding.TaskEpoch <= o.closedEpoch) {
		return false
	}
	if state == task.AdmissionActive && r.binding.TaskEpoch > o.closedEpoch {
		if launch {
			o.issued = true
		}
		if o.issued {
			o.state = active
			return true
		}
	}
	o.issued = false
	o.state = closed
	if state != task.AdmissionActive && r.binding.TaskEpoch > o.closedEpoch {
		o.closedEpoch = r.binding.TaskEpoch
	}
	return true
}
func (r *Route) operation(ctx context.Context, id string) (*port.Operation, error) {
	op, err := r.owner.store.Lookup(ctx, id)
	if err != nil {
		r.Fence()
		return nil, task.ErrUnknown
	}
	if op != nil && (op.Intent.TaskID != r.owner.taskID || op.Intent.Admission != r.binding) {
		return nil, task.ErrIdentity
	}
	return op, nil
}
func (r *Route) Lookup(ctx context.Context, id string) (*port.Operation, error) {
	return r.operation(ctx, id)
}
func (r *Route) Read(ctx context.Context, id string) (*port.Snapshot, error) {
	if id != r.owner.taskID {
		return nil, task.ErrIdentity
	}
	out, err := r.owner.store.Read(ctx, id)
	if err != nil {
		r.Fence()
		return nil, err
	}
	return out, nil // Never refresh/activate a positive projection from a read.
}
