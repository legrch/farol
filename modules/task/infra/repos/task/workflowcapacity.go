package task

import "github.com/legrch/farol/modules/task/domain"

// Count actual Task occupancy and original workflow callback reservations in
// one image, deduplicated by coding Task. Unknown/missing work occupies a slot.
// Cancellation/revoke/paused parent and restart do not release execution slots.
func workflowOccupied(image *filesystemImage) map[string]bool {
	occupied := map[string]bool{}
	for id, snapshot := range image.Tasks {
		if snapshot.Pending != "" || snapshot.Task.Lifecycle == task.Running || snapshot.Task.Lifecycle == task.Unknown {
			occupied[id] = true
		}
	}
	if image.Workflows == nil {
		return occupied
	}
	for id, reservation := range image.Workflows.Reservations {
		op, found := image.Operations[id]
		if found && op.Settled && (op.Receipt.State == task.Rejected || op.Receipt.State == task.Known && op.Receipt.Lifecycle.Terminal()) {
			continue
		}
		occupied[reservation.TaskID] = true
	}
	return occupied
}

// Called inside the original Task Admit atomic update for all launch routes.
// Non-workflow launches consume this same capacity; there is no parallel journal
// or in-memory permit whose loss/restart could make unknown work disappear.
func filesystemWorkflowCapacity(image *filesystemImage, in task.Intent) error {
	w := image.Workflows
	if w == nil {
		return nil
	}
	for _, p := range w.Plans {
		for _, step := range p.Plan.Steps {
			for operation, action := range map[string]task.Action{step.OperationID: task.Create, step.CancelOperationID: task.Cancel, step.DeliveryOperationID: task.Deliver} {
				if in.OperationID == operation && (in.TaskID != step.TaskID || in.Action != action || in.Parent != task.Parent(p.Plan.Parent) || action != task.Create && in.ExactDispatchID != step.OperationID) {
					return task.ErrIdentity
				}
			}
		}
	}
	if in.Action != task.Create && in.Action != task.Continue && in.Action != task.Resume {
		return nil
	}
	if in.Action == task.Create {
		for _, p := range w.Plans {
			for _, step := range p.Plan.Steps {
				if step.TaskID == in.TaskID {
					r, reserved := w.Reservations[in.OperationID]
					if !reserved || r.WorkflowID != p.Plan.ID || r.TaskID != in.TaskID || r.OperationID != step.OperationID || in.Parent != task.Parent(p.Plan.Parent) {
						return task.ErrIdentity
					}
				}
			}
		}
	}
	occupied := workflowOccupied(image)
	if occupied[in.TaskID] {
		// Only the matching original workflow pre-callback reservation may be
		// converted into its first Task intent, never an unknown existing task.
		reservation, found := w.Reservations[in.OperationID]
		_, taskExists := image.Tasks[in.TaskID]
		if in.Action != task.Create || !found || reservation.TaskID != in.TaskID || taskExists {
			return task.ErrUnknown
		}
		return nil
	}
	if len(occupied) >= w.Capacity {
		return task.ErrState
	}
	return nil
}
