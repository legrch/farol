// Package control publishes independent coding-task DTOs for trusted Root consumers.
// It delegates to the existing service; it owns no journal, provider or lifecycle.
package control

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/domain"
)

type Provider string

const (
	Codex  Provider = "codex"
	Claude Provider = "claude"
)

type Action string

const (
	Create   Action = "create"
	Continue Action = "continue"
	Resume   Action = "resume"
	Message  Action = "message"
	Cancel   Action = "cancel"
	Deliver  Action = "deliver"
)

type Lifecycle string

const (
	Unknown     Lifecycle = "outcome_unknown"
	Running     Lifecycle = "running"
	Completed   Lifecycle = "completed"
	Failed      Lifecycle = "failed"
	Interrupted Lifecycle = "interrupted"
	NeedsInput  Lifecycle = "needs_input"
	Refused     Lifecycle = "refused"
)

type ReceiptState string

const (
	Known     ReceiptState = "known"
	Uncertain ReceiptState = "outcome_unknown"
	Rejected  ReceiptState = "refused"
)

type Selection struct {
	Provider                                   Provider
	ProjectID, WorkspaceID, ModelAlias, Effort string
}
type Root struct{ Path, Device, Inode, GitCommonDirectory string }
type Binding struct {
	Provider                                  Provider
	ProfileID, HostID, ProjectID, WorkspaceID string
	Project, Writer                           Root
	ModelAlias, Model, Effort, ConfigDigest   string
}
type Parent struct{ ThreadID, TurnID string }
type Reference struct{ SessionID, ThreadID, TurnID, InvocationID string }
type Capabilities struct{ Create, Continue, Resume, Message, Cancel bool }
type Receipt struct {
	State           ReceiptState
	Code            string
	Reference       Reference
	Lifecycle       Lifecycle
	Result          string
	CancelRequested bool
}
type ResolveRequest struct{ Selection Selection }
type ResolveResponse struct {
	Binding      Binding
	Capabilities Capabilities
}
type CreateRequest struct {
	OperationID, TaskID, Message string
	Selection                    Selection
	Parent                       Parent
}
type FollowupRequest struct{ OperationID, TaskID, Message string }

// ContinueExactRequest is the opt-in dispatch-scoped contract. The expected
// dispatch is mandatory; existing FollowupRequest callers retain their semantics.
type ContinueExactRequest struct {
	OperationID, TaskID, Message, ExpectedDispatchID string
}

// ResumeExactRequest publishes the dispatch-scoped resume guard independently.
// Root selects authority and invocation; this body cannot select either.
type ResumeExactRequest struct {
	OperationID, TaskID, Message, ExpectedDispatchID string
}
type CancelRequest struct{ OperationID, TaskID string }
type TaskRequest struct{ TaskID string }
type OperationRequest struct{ OperationID string }
type MutationResponse struct {
	OperationID, TaskID string
	Receipt             Receipt
}
type StatusResponse struct {
	TaskID    string
	Binding   Binding
	Parent    Parent
	Reference Reference
	Lifecycle Lifecycle
	// DeliveryDispatchID marks the dispatch with a settled delivery operation;
	// it is not that operation ID and does not prove parent acknowledgement.
	DispatchID, PendingOperationID, DeliveryDispatchID string
	CancelRequested                                    bool
}
type ResultResponse struct {
	TaskID, DispatchID string
	Reference          Reference
	Lifecycle          Lifecycle
	Text               string
	Retained           bool
}
type OperationResponse struct {
	OperationID, TaskID string
	Action              Action
	Lineage             Reference
	Receipt             Receipt
}
type Failure struct{ Code string }

func (e *Failure) Error() string { return e.Code }

type Contract struct{ service *tasksvc.Service }

// New retains the actual service supplied by composition, never a second owner.
// Root must supply the SAME NewOwned service/route used by admission/observation.
func New(service *tasksvc.Service) (*Contract, error) {
	if service == nil {
		return nil, &Failure{Code: "TASK_UNAVAILABLE"}
	}
	return &Contract{service: service}, nil
}
func (c *Contract) ready(ctx context.Context) error {
	if c == nil || c.service == nil {
		return &Failure{Code: "TASK_UNAVAILABLE"}
	}
	if ctx == nil {
		return &Failure{Code: "TASK_INPUT_INVALID"}
	}
	return nil
}
func classify(err error) error {
	code := "TASK_OUTCOME_UNKNOWN"
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = "TASK_REQUEST_CANCELLED"
	case errors.Is(err, task.ErrInvalid):
		code = "TASK_INPUT_INVALID"
	case errors.Is(err, task.ErrConflict):
		code = "TASK_OPERATION_CONFLICT"
	case errors.Is(err, task.ErrIdentity):
		code = "TASK_IDENTITY_MISMATCH"
	case errors.Is(err, task.ErrNotFound):
		code = "TASK_NOT_FOUND"
	case errors.Is(err, task.ErrUnsupported):
		code = "TASK_CAPABILITY_UNAVAILABLE"
	case errors.Is(err, task.ErrUnavailable):
		code = "TASK_UNAVAILABLE"
	case errors.Is(err, task.ErrState):
		code = "TASK_STATE_REFUSED"
	}
	return &Failure{Code: code}
}
func selection(s Selection) (port.Selection, error) {
	if s.Provider != Codex && s.Provider != Claude {
		return port.Selection{}, &Failure{Code: "TASK_INPUT_INVALID"}
	}
	return port.Selection{Provider: task.Provider(s.Provider), ProjectID: s.ProjectID, WorkspaceID: s.WorkspaceID, ModelAlias: s.ModelAlias, Effort: s.Effort}, nil
}
func root(r task.Root) Root {
	return Root{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
}
func binding(b task.Binding) Binding {
	return Binding{Provider: Provider(b.Provider), ProfileID: b.ProfileID, HostID: b.HostID, ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, Project: root(b.Project), Writer: root(b.Writer), ModelAlias: b.ModelAlias, Model: b.Model, Effort: b.Effort, ConfigDigest: b.ConfigDigest}
}
func reference(r task.Reference) Reference {
	return Reference{SessionID: r.SessionID, ThreadID: r.ThreadID, TurnID: r.TurnID, InvocationID: r.InvocationID}
}
func receipt(r task.Receipt) Receipt {
	// Classification labels alone cross this diagnostic field. Result text is
	// an explicit authorized result surface, never an error/telemetry fallback.
	code := r.Code
	if code != "" {
		valid := len(code) <= 128
		for _, ch := range code {
			if !(ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_') {
				valid = false
			}
		}
		if !valid {
			code = "TASK_PROVIDER_REPORTED"
		}
	}
	return Receipt{State: ReceiptState(r.State), Code: code, Reference: reference(r.Reference), Lifecycle: Lifecycle(r.Lifecycle), Result: r.Result, CancelRequested: r.CancelRequested}
}
func mutation(r *tasksvc.MutationResponse) *MutationResponse {
	return &MutationResponse{OperationID: r.OperationID, TaskID: r.TaskID, Receipt: receipt(r.Receipt)}
}

func (c *Contract) Resolve(ctx context.Context, req ResolveRequest) (*ResolveResponse, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	selected, err := selection(req.Selection)
	if err != nil {
		return nil, err
	}
	out, err := c.service.Resolve(ctx, tasksvc.ResolveRequest{Selection: selected})
	if err != nil {
		return nil, classify(err)
	}
	caps := out.Capabilities
	return &ResolveResponse{Binding: binding(out.Binding), Capabilities: Capabilities{Create: caps.Create, Continue: caps.Continue, Resume: caps.Resume, Message: caps.Message, Cancel: caps.Cancel}}, nil
}
func (c *Contract) Create(ctx context.Context, req CreateRequest) (*MutationResponse, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	selected, err := selection(req.Selection)
	if err != nil {
		return nil, err
	}
	out, err := c.service.Create(ctx, tasksvc.CreateRequest{OperationID: req.OperationID, TaskID: req.TaskID, Message: req.Message, Selection: selected, Parent: task.Parent{ThreadID: req.Parent.ThreadID, TurnID: req.Parent.TurnID}})
	if err != nil {
		return nil, classify(err)
	}
	return &MutationResponse{OperationID: out.OperationID, TaskID: out.TaskID, Receipt: receipt(out.Receipt)}, nil
}

// Status/Result preserve the service's exact running-provider observation and
// persistence semantics. For a read without provider calls use Operation or the
// existing observation.Read contract, never a repeated mutation.
func (c *Contract) Status(ctx context.Context, req TaskRequest) (*StatusResponse, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	out, err := c.service.Status(ctx, tasksvc.StatusRequest{TaskID: req.TaskID})
	if err != nil {
		return nil, classify(err)
	}
	t := out.Task
	return &StatusResponse{TaskID: t.ID, Binding: binding(t.Binding), Parent: Parent{ThreadID: t.Parent.ThreadID, TurnID: t.Parent.TurnID}, Reference: reference(t.Reference), Lifecycle: Lifecycle(t.Lifecycle), DispatchID: t.DispatchID, PendingOperationID: out.PendingOperationID, DeliveryDispatchID: t.DeliveryDispatchID, CancelRequested: t.CancelRequested}, nil
}
func (c *Contract) Result(ctx context.Context, req TaskRequest) (*ResultResponse, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	out, err := c.service.Result(ctx, tasksvc.ResultRequest{TaskID: req.TaskID})
	if err != nil {
		return nil, classify(err)
	}
	return &ResultResponse{TaskID: out.TaskID, DispatchID: out.DispatchID, Reference: reference(out.Reference), Lifecycle: Lifecycle(out.Lifecycle), Text: out.Text, Retained: out.Retained}, nil
}
func (c *Contract) followup(ctx context.Context, req FollowupRequest, action task.Action) (*MutationResponse, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	out, err := c.service.Control(ctx, tasksvc.MutationRequest{OperationID: req.OperationID, TaskID: req.TaskID, Message: req.Message, Action: action})
	if err != nil {
		return nil, classify(err)
	}
	return mutation(out), nil
}
func (c *Contract) Continue(ctx context.Context, req FollowupRequest) (*MutationResponse, error) {
	return c.followup(ctx, req, task.Continue)
}

// ContinueExact checks the requested parent inside the mutation owner, not by
// resolving a dispatch and then calling the unguarded Continue method.
func (c *Contract) ContinueExact(ctx context.Context, req ContinueExactRequest) (*MutationResponse, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	out, err := c.service.ContinueExact(ctx, tasksvc.ContinueExactRequest{OperationID: req.OperationID, TaskID: req.TaskID, Message: req.Message, ExpectedDispatchID: req.ExpectedDispatchID})
	if err != nil {
		return nil, classify(err)
	}
	return mutation(out), nil
}

// ResumeExact delegates directly to the same mutation owner and snapshot CAS.
func (c *Contract) ResumeExact(ctx context.Context, req ResumeExactRequest) (*MutationResponse, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	out, err := c.service.ResumeExact(ctx, tasksvc.ResumeExactRequest{OperationID: req.OperationID, TaskID: req.TaskID, Message: req.Message, ExpectedDispatchID: req.ExpectedDispatchID})
	if err != nil {
		return nil, classify(err)
	}
	return mutation(out), nil
}
func (c *Contract) Resume(ctx context.Context, req FollowupRequest) (*MutationResponse, error) {
	return c.followup(ctx, req, task.Resume)
}
func (c *Contract) Message(ctx context.Context, req FollowupRequest) (*MutationResponse, error) {
	return c.followup(ctx, req, task.Message)
}
func (c *Contract) Cancel(ctx context.Context, req CancelRequest) (*MutationResponse, error) {
	return c.followup(ctx, FollowupRequest{OperationID: req.OperationID, TaskID: req.TaskID}, task.Cancel)
}

// Operation is the existing read-only reconnect query: no Resolve, Supports,
// provider Observe/Dispatch, owner construction or automatic delivery.
func (c *Contract) Operation(ctx context.Context, req OperationRequest) (*OperationResponse, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	out, err := c.service.Operation(ctx, tasksvc.OperationRequest{OperationID: req.OperationID})
	if err != nil {
		return nil, classify(err)
	}
	return &OperationResponse{OperationID: out.OperationID, TaskID: out.TaskID, Action: Action(out.Action), Lineage: reference(out.Lineage), Receipt: receipt(out.Receipt)}, nil
}
