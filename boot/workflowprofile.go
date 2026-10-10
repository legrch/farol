package boot

import (
	"context"

	"github.com/legrch/farol/modules/task/app/port"
	workflow "github.com/legrch/farol/modules/task/app/services/workflow"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	parentpeer "github.com/legrch/farol/modules/task/infra/peer/parent"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
	"github.com/legrch/farol/modules/task/infra/workflowruntime"
)

// WorkflowProfileInput is trusted Root composition over ALREADY selected Task
// turns. It grants no selection, account, provider or native storage authority.
// Capacity is an immutable profile-wide bound, not a request-selected budget.
type WorkflowProfileInput struct {
	Scope      []port.CurrentBinding
	ChatHandle string
	Parent     controlct.Parent
	Capacity   int
	Composer   workflow.Composer
}

// WorkflowProfile borrows the original Task profile's journal, controls and
// initiating Chat handle. It owns no engine, client, scheduler or close operation.
// NativeRuntime does not expose or automatically activate this facade.
type WorkflowProfile struct {
	profile *TaskProfile
	store   *taskrepo.Filesystem
	runtime *workflowruntime.Runtime
	parent  controlct.Parent
	handle  chatHandle
	turns   map[string]workflowProfileTask
	order   []string
}

type workflowProfileTask struct {
	owner    *taskProfileOwner
	scope    port.CurrentBinding
	selected taskProfileTurn
	original map[port.CurrentBinding]taskProfileTurn
	binding  task.Binding
}

// NewWorkflow captures immutable associations. It never selects a Task turn,
// connects a provider, persists a plan, reserves capacity or restores admission.
// Only the concrete SAME Task Filesystem can participate in global admission.
func (p *TaskProfile) NewWorkflow(ctx context.Context, in WorkflowProfileInput) (*WorkflowProfile, error) {
	if err := p.available(ctx); err != nil {
		return nil, err
	}
	if !taskProfileIdentity(p.peer, p.owner, p.chat) || len(in.Scope) == 0 || len(in.Scope) > wf.MaxSteps || in.Capacity < 1 || in.Capacity > 1024 || taskRuntimeMissing(in.Composer) || !task.ID(in.Parent.ThreadID) || !task.ID(in.Parent.TurnID) {
		return nil, workflow.ErrInvalid
	}
	handle, err := p.chat.get(in.ChatHandle)
	if err != nil || handle.handle == nil {
		return nil, workflow.ErrIdentity
	}
	w := &WorkflowProfile{profile: p, parent: in.Parent, handle: handle, turns: make(map[string]workflowProfileTask, len(in.Scope))}
	p.mu.Lock()
	store, ok := p.journal.(*taskrepo.Filesystem)
	if !ok || store == nil || p.closed.Load() {
		p.mu.Unlock()
		return nil, workflow.ErrUnavailable
	}
	w.store = store
	for _, scope := range in.Scope {
		record := p.tasks[scope.TaskID]
		if record == nil || w.turns[scope.TaskID].owner != nil || record.parent != in.Parent {
			p.mu.Unlock()
			return nil, workflow.ErrIdentity
		}
		selected, ok := record.turns[scope]
		if !ok || selected.route == nil || selected.route.Selection() != scope || selected.control == nil || selected.authority.parent == nil || selected.chatHandle != in.ChatHandle {
			p.mu.Unlock()
			return nil, workflow.ErrIdentity
		}
		original := make(map[port.CurrentBinding]taskProfileTurn, len(record.turns))
		for key, turn := range record.turns {
			// Earlier operation reads must use their exact retained epoch facade.
			// A later association is never adopted by this captured profile.
			if turn.control != nil && turn.chatHandle == in.ChatHandle {
				original[key] = turn
			}
		}
		w.turns[scope.TaskID] = workflowProfileTask{record, scope, selected, original, record.selection.Binding}
		w.order = append(w.order, scope.TaskID)
	}
	p.mu.Unlock()
	// No profile mutex is held across actual parent, journal or provider IO.
	parent := workflowProfileParent{workflow: w}
	if err = parent.Recheck(ctx, wf.Parent(in.Parent)); err != nil {
		return nil, err
	}
	tasks, err := workflowruntime.NewTasks(workflowProfileRoutes{workflow: w})
	if err != nil {
		return nil, err
	}
	w.runtime, err = workflowruntime.New(store, tasks, in.Composer, parent, in.Capacity)
	if err != nil {
		return nil, err
	}
	if err = w.ready(ctx); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *WorkflowProfile) ready(ctx context.Context) error {
	if w == nil || w.profile == nil || w.store == nil || len(w.turns) == 0 {
		return workflow.ErrUnavailable
	}
	if err := w.profile.available(ctx); err != nil {
		return err
	}
	h, err := w.profile.chat.get(w.handle.id)
	if err != nil || h.handle != w.handle.handle || h.binding != w.handle.binding {
		return workflow.ErrIdentity
	}
	p := w.profile
	p.mu.Lock()
	actual, ok := p.journal.(*taskrepo.Filesystem)
	valid := ok && actual == w.store && !p.closed.Load()
	for id, captured := range w.turns {
		record := p.tasks[id]
		if record != captured.owner || record == nil || record.parent != w.parent || record.selection.Binding != captured.binding {
			valid = false
			break
		}
		turn, ok := record.turns[captured.scope]
		if !ok || turn.control != captured.selected.control || turn.route != captured.selected.route || turn.authority.parent != captured.selected.authority.parent || turn.chatHandle != w.handle.id {
			valid = false
			break
		}
	}
	p.mu.Unlock()
	if !valid {
		return workflow.ErrIdentity
	}
	return p.available(ctx)
}

func (w *WorkflowProfile) capture(plan wf.Plan) (wf.Plan, error) {
	captured, err := wf.Capture(plan)
	if err != nil {
		return wf.Plan{}, workflow.ErrInvalid
	}
	if captured.Parent != wf.Parent(w.parent) {
		return wf.Plan{}, workflow.ErrIdentity
	}
	for _, step := range captured.Steps {
		if w.turns[step.TaskID].owner == nil {
			return wf.Plan{}, workflow.ErrIdentity
		}
	}
	return captured, nil
}

func (w *WorkflowProfile) Activate(ctx context.Context, plan wf.Plan, budget wf.Budget) (workflow.Report, error) {
	if err := w.ready(ctx); err != nil {
		return workflow.Report{}, err
	}
	captured, err := w.capture(plan)
	if err != nil {
		return workflow.Report{}, err
	}
	out, err := w.runtime.Activate(ctx, captured, budget)
	if closed := w.ready(ctx); closed != nil {
		return workflow.Report{}, closed
	}
	return out, err
}

func (w *WorkflowProfile) retained(ctx context.Context, id string) error {
	if err := w.ready(ctx); err != nil {
		return err
	}
	plan, err := w.store.ReadWorkflow(ctx, id)
	if err != nil {
		return err
	}
	if _, err = w.capture(plan.Plan); err != nil {
		return err
	}
	return w.ready(ctx)
}

// Reconnect is observation only; stored plans and captured positive receipts
// cannot restore a Task/Chat admission or issue another callback after restart.
func (w *WorkflowProfile) Reconnect(ctx context.Context, id string, budget wf.Budget) (workflow.Report, error) {
	if err := w.retained(ctx, id); err != nil {
		return workflow.Report{}, err
	}
	out, err := w.runtime.Reconnect(ctx, id, budget)
	if closed := w.ready(ctx); closed != nil {
		return workflow.Report{}, closed
	}
	return out, err
}
func (w *WorkflowProfile) Cancel(ctx context.Context, id string) (workflow.Report, error) {
	if err := w.retained(ctx, id); err != nil {
		return workflow.Report{}, err
	}
	out, err := w.runtime.Cancel(ctx, id)
	if closed := w.ready(ctx); closed != nil {
		return workflow.Report{}, closed
	}
	return out, err
}
func (w *WorkflowProfile) Deliver(ctx context.Context, id string) (workflow.Report, error) {
	if err := w.retained(ctx, id); err != nil {
		return workflow.Report{}, err
	}
	out, err := w.runtime.Deliver(ctx, id)
	if closed := w.ready(ctx); closed != nil {
		return workflow.Report{}, closed
	}
	return out, err
}

type workflowProfileParent struct{ workflow *WorkflowProfile }

func (a workflowProfileParent) Recheck(ctx context.Context, requested wf.Parent) error {
	w := a.workflow
	if err := w.ready(ctx); err != nil {
		return err
	}
	if requested != wf.Parent(w.parent) {
		return workflow.ErrIdentity
	}
	// The actual retained parent peers already own their original Chat current
	// facade and binding. IDs or a newly looked-up parent are never substitutes.
	seen := make(map[*parentpeer.Peer]bool)
	for _, id := range w.order {
		peer := w.turns[id].selected.authority.parent
		if !seen[peer] {
			if err := peer.RecheckParent(ctx, task.Parent(requested)); err != nil {
				return err
			}
			seen[peer] = true
		}
	}
	return w.ready(ctx)
}

type workflowProfileRoutes struct{ workflow *WorkflowProfile }

func (r workflowProfileRoutes) Selected(ctx context.Context, id string) (*controlct.Contract, error) {
	if err := r.workflow.ready(ctx); err != nil {
		return nil, err
	}
	captured, ok := r.workflow.turns[id]
	if !ok || captured.selected.control == nil {
		return nil, workflow.ErrIdentity
	}
	return captured.selected.control, nil
}
func (r workflowProfileRoutes) Original(ctx context.Context, id, operation string) (*controlct.Contract, error) {
	if err := r.workflow.ready(ctx); err != nil {
		return nil, err
	}
	captured, ok := r.workflow.turns[id]
	if !ok {
		return nil, workflow.ErrIdentity
	}
	op, err := r.workflow.store.Lookup(ctx, operation)
	if err != nil {
		return nil, workflow.ErrUnknown
	}
	if err = r.workflow.ready(ctx); err != nil {
		return nil, err
	}
	if op == nil {
		// Only the original facade's TASK_NOT_FOUND read can prove absence.
		return captured.selected.control, nil
	}
	intent := op.Intent
	if intent.TaskID != id || intent.Binding != captured.binding || intent.Parent != task.Parent(r.workflow.parent) {
		return nil, workflow.ErrIdentity
	}
	a := intent.Admission
	scope := port.CurrentBinding{OwnerID: a.OwnerID, SessionID: a.SessionID, TaskID: a.TaskID, TaskEpoch: a.TaskEpoch, ParticipantID: a.ParticipantID, TurnID: a.TurnID}
	turn, ok := captured.original[scope]
	if !ok || turn.control == nil {
		return nil, workflow.ErrIdentity
	}
	return turn.control, nil
}

func workflowProfileBinding(b task.Binding) controlct.Binding {
	root := func(in task.Root) controlct.Root {
		return controlct.Root{Path: in.Path, Device: in.Device, Inode: in.Inode, GitCommonDirectory: in.GitCommonDirectory}
	}
	return controlct.Binding{Provider: controlct.Provider(b.Provider), ProfileID: b.ProfileID, HostID: b.HostID, ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, Project: root(b.Project), Writer: root(b.Writer), ModelAlias: b.ModelAlias, Model: b.Model, Effort: b.Effort, ConfigDigest: b.ConfigDigest}
}
func (r workflowProfileRoutes) Resolve(ctx context.Context, in workflow.Selection) (*controlct.ResolveResponse, error) {
	if err := r.workflow.ready(ctx); err != nil {
		return nil, err
	}
	var captured *workflowProfileTask
	for _, id := range r.workflow.order {
		value := r.workflow.turns[id]
		b := value.binding
		if string(b.Provider) == in.Provider && b.ProjectID == in.ProjectID && b.WorkspaceID == in.WorkspaceID && b.ModelAlias == in.ModelAlias && b.Effort == in.Effort {
			if captured != nil && captured.binding != value.binding {
				return nil, workflow.ErrIdentity
			}
			copy := value
			captured = &copy
		}
	}
	if captured == nil {
		return nil, workflow.ErrIdentity
	}
	out, err := captured.selected.control.Resolve(ctx, controlct.ResolveRequest{Selection: controlct.Selection{Provider: controlct.Provider(in.Provider), ProjectID: in.ProjectID, WorkspaceID: in.WorkspaceID, ModelAlias: in.ModelAlias, Effort: in.Effort}})
	if err != nil {
		return nil, err
	}
	if out == nil || out.Binding != workflowProfileBinding(captured.binding) {
		return nil, workflow.ErrIdentity
	}
	if err = r.workflow.ready(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
