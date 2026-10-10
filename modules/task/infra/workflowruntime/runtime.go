package workflowruntime

import (
	"context"
	"errors"

	workflow "github.com/legrch/farol/modules/task/app/services/workflow"
	"github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

// ParentAuthority is selected by Root from the existing initiating Chat owner.
// A parent ID, stored plan, capacity budget, or catalogue is never a grant.
type ParentAuthority interface {
	Recheck(context.Context, wf.Parent) error
}

// Runtime has no journal, loop, timer, retry, provider, or occupancy cache. The
// same profile Task Filesystem owns immutable plans, callback consumption and
// global capacity atomically with ALL normal Task admissions.
type Runtime struct {
	store    *taskrepo.Filesystem
	tasks    *Tasks
	composer workflow.Composer
	parent   ParentAuthority
	capacity int
}

func New(store *taskrepo.Filesystem, tasks *Tasks, composer workflow.Composer, parent ParentAuthority, capacity int) (*Runtime, error) {
	if store == nil || tasks == nil || tasks.routes == nil || composer == nil || parent == nil {
		return nil, workflow.ErrUnavailable
	}
	if capacity < 1 || capacity > 1024 {
		return nil, workflow.ErrInvalid
	}
	return &Runtime{store, tasks, composer, parent, capacity}, nil
}

func (r *Runtime) service(p taskrepo.WorkflowPlan) (*workflow.Service, error) {
	return workflow.New(reservedTasks{Tasks: r.tasks, store: r.store}, r.composer, admission{store: r.store, parent: r.parent, plan: p})
}
func (r *Runtime) ready(ctx context.Context, budget wf.Budget) error {
	if err := validContext(ctx); err != nil {
		return err
	}
	if r == nil || r.store == nil || r.tasks == nil || r.composer == nil || r.parent == nil {
		return workflow.ErrUnavailable
	}
	if budget.Slots < 0 || budget.Slots > r.capacity {
		return workflow.ErrInvalid
	}
	return nil
}

// Activate explicitly retains the exact immutable plan before one finite round.
// It never replaces a plan, infers consent from storage, or waits/retries children.
// A caller chooses only a budget at or below the original Root-selected bound.
func (r *Runtime) Activate(ctx context.Context, plan wf.Plan, budget wf.Budget) (workflow.Report, error) {
	if err := r.ready(ctx, budget); err != nil {
		return workflow.Report{}, err
	}
	p, err := r.store.SaveWorkflow(ctx, plan, r.capacity)
	if err != nil {
		return workflow.Report{}, err
	}
	s, err := r.service(*p)
	if err != nil {
		return workflow.Report{}, err
	}
	report, err := s.Tick(ctx, p.Plan, budget, workflow.AdmitNew)
	// A consumed pre-callback reservation can outlive a later parent refusal.
	// The app's no-callback projection is unavailable; retain the original
	// persisted uncertainty without manufacturing a Task operation/receipt.
	for i, step := range report.Steps {
		if step.State != wf.Unavailable {
			continue
		}
		_, readErr := r.store.ReadWorkflowReservation(ctx, step.OperationID)
		if !errors.Is(readErr, task.ErrNotFound) {
			// Existing consumed callback OR unavailable original storage both
			// prohibit claiming known absence. This only lowers certainty.
			report.Steps[i].State = wf.Unknown
		}
	}
	return report, err
}

// Reconnect reconstructs the ORIGINAL plan for observation only. Neither this
// read nor retained positive Task state restores live admission after restart.
func (r *Runtime) Reconnect(ctx context.Context, workflowID string, budget wf.Budget) (workflow.Report, error) {
	if err := r.ready(ctx, budget); err != nil {
		return workflow.Report{}, err
	}
	p, err := r.store.ReadWorkflow(ctx, workflowID)
	if err != nil {
		return workflow.Report{}, err
	}
	s, err := r.service(*p)
	if err != nil {
		return workflow.Report{}, err
	}
	return s.Tick(ctx, p.Plan, budget, workflow.Reconnect)
}
func (r *Runtime) Cancel(ctx context.Context, workflowID string) (workflow.Report, error) {
	if err := r.ready(ctx, wf.Budget{}); err != nil {
		return workflow.Report{}, err
	}
	p, err := r.store.ReadWorkflow(ctx, workflowID)
	if err != nil {
		return workflow.Report{}, err
	}
	s, err := r.service(*p)
	if err != nil {
		return workflow.Report{}, err
	}
	return s.Cancel(ctx, p.Plan)
}
func (r *Runtime) Deliver(ctx context.Context, workflowID string) (workflow.Report, error) {
	if err := r.ready(ctx, wf.Budget{}); err != nil {
		return workflow.Report{}, err
	}
	p, err := r.store.ReadWorkflow(ctx, workflowID)
	if err != nil {
		return workflow.Report{}, err
	}
	s, err := r.service(*p)
	if err != nil {
		return workflow.Report{}, err
	}
	return s.Deliver(ctx, p.Plan)
}

type reservedTasks struct {
	*Tasks
	store *taskrepo.Filesystem
}

func (t reservedTasks) Read(ctx context.Context, taskID, operationID string) (workflow.Record, error) {
	out, err := t.Tasks.Read(ctx, taskID, operationID)
	if err != nil || out.Found {
		return out, err
	}
	reservation, err := t.store.ReadWorkflowReservation(ctx, operationID)
	if errors.Is(err, task.ErrNotFound) {
		return out, nil
	}
	if err != nil {
		return workflow.Record{}, workflow.ErrUnknown
	}
	if reservation == nil || reservation.TaskID != taskID || reservation.OperationID != operationID {
		return workflow.Record{}, workflow.ErrIdentity
	}
	// Original callback was consumed but no Task receipt proves its outcome.
	// Return uncertainty, never invent a Task operation or another create permit.
	return workflow.Record{}, workflow.ErrUnknown
}

type admission struct {
	store  *taskrepo.Filesystem
	parent ParentAuthority
	plan   taskrepo.WorkflowPlan
}

func (a admission) Do(ctx context.Context, parent wf.Parent, taskID string, callback func() error) error {
	if err := validContext(ctx); err != nil {
		return err
	}
	if callback == nil || parent != a.plan.Plan.Parent {
		return workflow.ErrIdentity
	}
	operationID := ""
	for _, step := range a.plan.Plan.Steps {
		if step.TaskID == taskID {
			operationID = step.OperationID
			break
		}
	}
	if operationID == "" {
		return workflow.ErrIdentity
	}
	if err := a.parent.Recheck(ctx, parent); err != nil {
		return err
	}
	reservation, err := a.store.ReserveWorkflow(ctx, a.plan.Plan.ID, taskID, operationID)
	if err != nil {
		return err
	}
	if reservation == nil || !reservation.Claimed || reservation.WorkflowID != a.plan.Plan.ID || reservation.TaskID != taskID || reservation.OperationID != operationID {
		return workflow.ErrUnknown
	}
	// Recheck after publication waits. A changed/closed parent retains the
	// original consumed reservation rather than freeing or replaying its callback.
	if err := a.parent.Recheck(ctx, parent); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return callback()
}
