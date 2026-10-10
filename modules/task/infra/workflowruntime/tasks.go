// Package workflowruntime adapts finite workflows to the existing Task owner.
// It creates no provider, authority, journal, timer, or Task owner.
package workflowruntime

import (
	"context"
	"errors"

	workflow "github.com/legrch/farol/modules/task/app/services/workflow"
	"github.com/legrch/farol/modules/task/contracts/control"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

// Routes is supplied by trusted composition on the SAME selected TaskProfile.
// Original selects the retained operation's original epoch for read-only access;
// Selected supplies the already approved current mutation/observation route.
// Resolve reads the existing selected host/model authority, never a catalogue guess.
// Implementations must not manufacture an Owner, admission epoch, or provider.
type Routes interface {
	Original(context.Context, string, string) (*control.Contract, error)
	Selected(context.Context, string) (*control.Contract, error)
	Resolve(context.Context, workflow.Selection) (*control.ResolveResponse, error)
}

type Tasks struct{ routes Routes }

var _ workflow.Tasks = (*Tasks)(nil)

func NewTasks(routes Routes) (*Tasks, error) {
	if routes == nil {
		return nil, workflow.ErrUnavailable
	}
	return &Tasks{routes: routes}, nil
}

func validContext(ctx context.Context) error {
	if ctx == nil {
		return workflow.ErrInvalid
	}
	return ctx.Err()
}
func (t *Tasks) selected(ctx context.Context, id string) (*control.Contract, error) {
	if err := validContext(ctx); err != nil {
		return nil, err
	}
	if t == nil || t.routes == nil {
		return nil, workflow.ErrUnavailable
	}
	if !wf.ID(id) {
		return nil, workflow.ErrInvalid
	}
	c, err := t.routes.Selected(ctx, id)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, workflow.ErrUnavailable
	}
	return c, nil
}
func lifecycle(state control.Lifecycle) wf.State {
	switch state {
	case control.Running:
		return wf.Running
	case control.Completed:
		return wf.Completed
	case control.Failed:
		return wf.Failed
	case control.Interrupted:
		return wf.Cancelled
	case control.NeedsInput:
		return wf.NeedsInput
	default:
		return wf.Unknown
	}
}
func record(taskID, operationID string, action control.Action, receipt control.Receipt) (workflow.Record, error) {
	if !wf.ID(taskID) || !wf.ID(operationID) || (action != control.Create && action != control.Continue && action != control.Resume && action != control.Message && action != control.Cancel && action != control.Deliver) ||
		(receipt.State != control.Known && receipt.State != control.Uncertain && receipt.State != control.Rejected) {
		return workflow.Record{}, workflow.ErrUnknown
	}
	return workflow.Record{Found: true, TaskID: taskID, OperationID: operationID, Action: string(action), State: workflow.ReceiptState(receipt.State), Outcome: lifecycle(receipt.Lifecycle), Reference: workflow.Reference(receipt.Reference), Output: receipt.Result, CancelRequested: receipt.CancelRequested}, nil
}
func mutation(out *control.MutationResponse, err error, taskID, operationID string, action control.Action) (workflow.Record, error) {
	if err != nil {
		return workflow.Record{}, err
	}
	if out == nil || out.TaskID != taskID || out.OperationID != operationID {
		return workflow.Record{}, workflow.ErrIdentity
	}
	return record(out.TaskID, out.OperationID, action, out.Receipt)
}
func selection(in workflow.Selection) control.Selection {
	return control.Selection{Provider: control.Provider(in.Provider), ProjectID: in.ProjectID, WorkspaceID: in.WorkspaceID, ModelAlias: in.ModelAlias, Effort: in.Effort}
}

// Only a classified successful missing-operation query proves absence. Missing
// routes, lost ACKs and identity errors never become another launch opportunity.
func (t *Tasks) Read(ctx context.Context, taskID, operationID string) (workflow.Record, error) {
	if err := validContext(ctx); err != nil {
		return workflow.Record{}, err
	}
	if t == nil || t.routes == nil {
		return workflow.Record{}, workflow.ErrUnavailable
	}
	if !wf.ID(taskID) || !wf.ID(operationID) {
		return workflow.Record{}, workflow.ErrInvalid
	}
	c, err := t.routes.Original(ctx, taskID, operationID)
	if err != nil {
		return workflow.Record{}, err
	}
	if c == nil {
		return workflow.Record{}, workflow.ErrUnavailable
	}
	out, err := c.Operation(ctx, control.OperationRequest{OperationID: operationID})
	var failure *control.Failure
	if errors.As(err, &failure) && failure.Code == "TASK_NOT_FOUND" {
		return workflow.Record{}, nil
	}
	if err != nil {
		return workflow.Record{}, err
	}
	if out == nil || out.TaskID != taskID || out.OperationID != operationID {
		return workflow.Record{}, workflow.ErrIdentity
	}
	return record(out.TaskID, out.OperationID, out.Action, out.Receipt)
}
func (t *Tasks) Resolve(ctx context.Context, in workflow.Selection) (map[wf.Capability]bool, error) {
	if err := validContext(ctx); err != nil {
		return nil, err
	}
	if t == nil || t.routes == nil {
		return nil, workflow.ErrUnavailable
	}
	if in.Provider != string(control.Codex) && in.Provider != string(control.Claude) {
		return nil, workflow.ErrInvalid
	}
	out, err := t.routes.Resolve(ctx, in)
	if err != nil {
		return nil, err
	}
	if out == nil || out.Binding.Provider != control.Provider(in.Provider) || out.Binding.ProjectID != in.ProjectID || out.Binding.WorkspaceID != in.WorkspaceID || out.Binding.ModelAlias != in.ModelAlias || out.Binding.Effort != in.Effort {
		return nil, workflow.ErrIdentity
	}
	c := out.Capabilities
	return map[wf.Capability]bool{wf.CapabilityCreate: c.Create, wf.CapabilityCancel: c.Cancel, wf.CapabilityContinue: c.Continue, wf.CapabilityResume: c.Resume, wf.CapabilityMessage: c.Message}, nil
}
func (t *Tasks) Create(ctx context.Context, q workflow.Launch) (workflow.Record, error) {
	c, err := t.selected(ctx, q.TaskID)
	if err != nil {
		return workflow.Record{}, err
	}
	out, err := c.Create(ctx, control.CreateRequest{OperationID: q.OperationID, TaskID: q.TaskID, Message: q.Message, Selection: selection(q.Selection), Parent: control.Parent(q.Parent)})
	return mutation(out, err, q.TaskID, q.OperationID, control.Create)
}
func (t *Tasks) Observe(ctx context.Context, taskID string) (workflow.Result, error) {
	c, err := t.selected(ctx, taskID)
	if err != nil {
		return workflow.Result{}, err
	}
	out, err := c.Result(ctx, control.TaskRequest{TaskID: taskID})
	if err != nil {
		return workflow.Result{}, err
	}
	if out == nil || out.TaskID != taskID || !wf.ID(out.DispatchID) {
		return workflow.Result{}, workflow.ErrIdentity
	}
	return workflow.Result{TaskID: out.TaskID, DispatchID: out.DispatchID, Reference: workflow.Reference(out.Reference), Outcome: lifecycle(out.Lifecycle), Output: out.Text, Retained: out.Retained}, nil
}
func (t *Tasks) Cancel(ctx context.Context, q workflow.Target) (workflow.Record, error) {
	c, err := t.selected(ctx, q.TaskID)
	if err != nil {
		return workflow.Record{}, err
	}
	out, err := c.CancelExact(ctx, control.CancelExactRequest{OperationID: q.OperationID, TaskID: q.TaskID, ExpectedDispatchID: q.ExpectedDispatchID, ExpectedReference: control.Reference(q.Reference)})
	return mutation(out, err, q.TaskID, q.OperationID, control.Cancel)
}
func (t *Tasks) Deliver(ctx context.Context, q workflow.Target) (workflow.Record, error) {
	c, err := t.selected(ctx, q.TaskID)
	if err != nil {
		return workflow.Record{}, err
	}
	out, err := c.DeliverExact(ctx, control.DeliverExactRequest{OperationID: q.OperationID, TaskID: q.TaskID, ExpectedDispatchID: q.ExpectedDispatchID, ExpectedReference: control.Reference(q.Reference)})
	return mutation(out, err, q.TaskID, q.OperationID, control.Deliver)
}
func (t *Tasks) Followup(ctx context.Context, q workflow.Followup) (workflow.Record, error) {
	c, err := t.selected(ctx, q.TaskID)
	if err != nil {
		return workflow.Record{}, err
	}
	var out *control.MutationResponse
	action := control.Continue
	if q.Resume {
		action = control.Resume
		out, err = c.ResumeExact(ctx, control.ResumeExactRequest{OperationID: q.OperationID, TaskID: q.TaskID, ExpectedDispatchID: q.ExpectedDispatchID, Message: q.Message})
	} else {
		out, err = c.ContinueExact(ctx, control.ContinueExactRequest{OperationID: q.OperationID, TaskID: q.TaskID, ExpectedDispatchID: q.ExpectedDispatchID, Message: q.Message})
	}
	return mutation(out, err, q.TaskID, q.OperationID, action)
}
