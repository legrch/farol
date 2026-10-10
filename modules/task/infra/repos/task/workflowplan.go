package task

import (
	"context"
	"encoding/json"
	"reflect"

	"github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

// WorkflowPlan is content-free original identity, not execution authority.
// Capacity is selected once by trusted profile composition, never by a renderer.
type WorkflowPlan struct {
	Plan   wf.Plan
	SHA256 string
}

type WorkflowReservation struct {
	WorkflowID, TaskID, OperationID string
	// Claimed is true only for this original known publication. A retained
	// reservation is never another callback/effect permit, including after restart.
	Claimed bool
}

type workflowLaunch struct{ WorkflowID, TaskID, OperationID string }
type workflowImage struct {
	Capacity     int
	Plans        map[string]WorkflowPlan
	Reservations map[string]workflowLaunch
}

func workflowPlan(p wf.Plan) (*WorkflowPlan, error) {
	captured, err := wf.Capture(p)
	if err != nil {
		return nil, task.ErrInvalid
	}
	body, err := json.Marshal(captured)
	if err != nil {
		return nil, task.ErrInvalid
	}
	return &WorkflowPlan{Plan: captured, SHA256: filesystemHash(body)}, nil
}

// SaveWorkflow publishes once through the SAME atomic Task image/lease. It does
// not select a Task route, activate parent admission, reserve, or run a child.
// Identical retained plans are read evidence only; replacement/escalation refuses.
func (j *Filesystem) SaveWorkflow(ctx context.Context, p wf.Plan, capacity int) (*WorkflowPlan, error) {
	if ctx == nil || capacity < 1 || capacity > filesystemMaxTasks {
		return nil, task.ErrInvalid
	}
	plan, err := workflowPlan(p)
	if err != nil {
		return nil, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	image, err := j.load(ctx)
	if err != nil {
		return nil, err
	}
	if image.Workflows != nil {
		if image.Workflows.Capacity != capacity {
			return nil, task.ErrConflict
		}
		if old, found := image.Workflows.Plans[p.ID]; found {
			if !reflect.DeepEqual(old, *plan) {
				return nil, task.ErrConflict
			}
			return workflowPlan(old.Plan)
		}
	}
	err = j.update(ctx, func(image *filesystemImage) (bool, error) {
		if image.Workflows == nil {
			if len(workflowOccupied(image)) > capacity {
				return false, task.ErrState
			}
			image.Workflows = &workflowImage{Capacity: capacity, Plans: map[string]WorkflowPlan{}, Reservations: map[string]workflowLaunch{}}
		}
		if image.Workflows.Capacity != capacity || len(image.Workflows.Plans) >= wf.MaxSteps {
			return false, task.ErrState
		}
		if _, found := image.Workflows.Plans[p.ID]; found {
			return false, task.ErrConflict
		}
		// Workflow task/operation names cannot adopt another plan or a Task that
		// already exists. Only the original plan may create these fixed identities.
		for _, step := range plan.Plan.Steps {
			if _, found := image.Tasks[step.TaskID]; found {
				return false, task.ErrConflict
			}
			for _, operation := range []string{step.OperationID, step.CancelOperationID, step.DeliveryOperationID} {
				if _, found := image.Operations[operation]; found {
					return false, task.ErrConflict
				}
			}
			for _, old := range image.Workflows.Plans {
				for _, prior := range old.Plan.Steps {
					if prior.TaskID == step.TaskID {
						return false, task.ErrConflict
					}
					for _, operation := range []string{step.OperationID, step.CancelOperationID, step.DeliveryOperationID} {
						if operation == prior.OperationID || operation == prior.CancelOperationID || operation == prior.DeliveryOperationID {
							return false, task.ErrConflict
						}
					}
				}
			}
		}
		image.Workflows.Plans[p.ID] = *plan
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	return workflowPlan(plan.Plan)
}

func (j *Filesystem) ReadWorkflow(ctx context.Context, id string) (*WorkflowPlan, error) {
	if ctx == nil || !wf.ID(id) {
		return nil, task.ErrInvalid
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	image, err := j.load(ctx)
	if err != nil {
		return nil, err
	}
	if image.Workflows != nil {
		if p, found := image.Workflows.Plans[id]; found {
			return workflowPlan(p.Plan)
		}
	}
	if j.fenced {
		return nil, task.ErrUnknown
	}
	return nil, task.ErrNotFound
}

// ReserveWorkflow durably consumes the original callback before caller IO. It
// does not grant authority: the existing Task service still rechecks actual
// parent/physical/model authority and publishes its exact intent before dispatch.
func (j *Filesystem) ReserveWorkflow(ctx context.Context, workflowID, taskID, operationID string) (*WorkflowReservation, error) {
	if ctx == nil || !wf.ID(workflowID) || !wf.ID(taskID) || !wf.ID(operationID) {
		return nil, task.ErrInvalid
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	image, err := j.load(ctx)
	if err != nil {
		return nil, err
	}
	launch := workflowLaunch{workflowID, taskID, operationID}
	if image.Workflows != nil {
		if old, found := image.Workflows.Reservations[operationID]; found {
			if old != launch {
				return nil, task.ErrConflict
			}
			return &WorkflowReservation{workflowID, taskID, operationID, false}, nil
		}
	}
	err = j.update(ctx, func(image *filesystemImage) (bool, error) {
		if image.Workflows == nil {
			return false, task.ErrNotFound
		}
		p, found := image.Workflows.Plans[workflowID]
		if !found {
			return false, task.ErrNotFound
		}
		matched := false
		for _, step := range p.Plan.Steps {
			matched = matched || step.TaskID == taskID && step.OperationID == operationID
		}
		if !matched {
			return false, task.ErrIdentity
		}
		if _, found := image.Operations[operationID]; found {
			return false, task.ErrConflict
		}
		if _, found := image.Tasks[taskID]; found {
			return false, task.ErrConflict
		}
		occupied := workflowOccupied(image)
		if len(occupied) >= image.Workflows.Capacity || occupied[taskID] {
			return false, task.ErrState
		}
		image.Workflows.Reservations[operationID] = launch
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	return &WorkflowReservation{workflowID, taskID, operationID, true}, nil
}

func filesystemWorkflowsValid(image *filesystemImage) bool {
	w := image.Workflows
	if w == nil {
		return true
	}
	if w.Capacity < 1 || w.Capacity > filesystemMaxTasks || len(w.Plans) < 1 || len(w.Plans) > wf.MaxSteps || w.Reservations == nil || len(w.Reservations) > filesystemMaxTasks {
		return false
	}
	tasks, operations := map[string]bool{}, map[string]bool{}
	for id, original := range w.Plans {
		p, err := workflowPlan(original.Plan)
		if err != nil || p.Plan.ID != id || p.SHA256 != original.SHA256 {
			return false
		}
		for _, step := range p.Plan.Steps {
			if current, exists := image.Tasks[step.TaskID]; exists {
				r, reserved := w.Reservations[step.OperationID]
				if !reserved || r.WorkflowID != id || r.TaskID != step.TaskID || current.Task.Parent != task.Parent(p.Plan.Parent) {
					return false
				}
			}
			for operation, action := range map[string]task.Action{step.OperationID: task.Create, step.CancelOperationID: task.Cancel, step.DeliveryOperationID: task.Deliver} {
				if op, exists := image.Operations[operation]; exists && (op.Intent.TaskID != step.TaskID || op.Intent.Action != action || op.Intent.Parent != task.Parent(p.Plan.Parent) || action != task.Create && op.Intent.ExactDispatchID != step.OperationID) {
					return false
				}
			}
			if tasks[step.TaskID] {
				return false
			}
			tasks[step.TaskID] = true
			for _, operation := range []string{step.OperationID, step.CancelOperationID, step.DeliveryOperationID} {
				if operations[operation] {
					return false
				}
				operations[operation] = true
			}
		}
	}
	if len(tasks) > filesystemMaxTasks {
		return false
	}
	for id, r := range w.Reservations {
		p, found := w.Plans[r.WorkflowID]
		if !found || id != r.OperationID {
			return false
		}
		matched := false
		for _, step := range p.Plan.Steps {
			matched = matched || step.TaskID == r.TaskID && step.OperationID == r.OperationID
		}
		if !matched {
			return false
		}
		if op, found := image.Operations[id]; found && (op.Intent.TaskID != r.TaskID || op.Intent.Action != task.Create || op.Intent.Parent != task.Parent(p.Plan.Parent)) {
			return false
		}
	}
	return len(workflowOccupied(image)) <= w.Capacity
}

// ReadWorkflowReservation is original content-free callback evidence. Missing
// IDs while fenced remain unknown; this query never changes occupancy or permits.
func (j *Filesystem) ReadWorkflowReservation(ctx context.Context, operationID string) (*WorkflowReservation, error) {
	if ctx == nil || !wf.ID(operationID) {
		return nil, task.ErrInvalid
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	image, err := j.load(ctx)
	if err != nil {
		return nil, err
	}
	if image.Workflows != nil {
		if r, found := image.Workflows.Reservations[operationID]; found {
			return &WorkflowReservation{r.WorkflowID, r.TaskID, r.OperationID, false}, nil
		}
	}
	if j.fenced {
		return nil, task.ErrUnknown
	}
	return nil, task.ErrNotFound
}
