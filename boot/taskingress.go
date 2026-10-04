package boot

import (
	"context"
	"errors"

	admissionct "github.com/legrch/farol/modules/task/contracts/admission"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	observationct "github.com/legrch/farol/modules/task/contracts/observation"
	"github.com/legrch/farol/modules/task/domain"
)

// These narrow bodies carry no task, provider, model, epoch or grant selection.
// Transport supplies the existing envelope operation ID separately for effects.
type TaskIngressCreateRequest struct {
	Message string `json:"message"`
}
type TaskIngressContinueRequest struct {
	DispatchID string `json:"dispatchId"`
	Message    string `json:"message"`
}
type TaskIngressResumeRequest struct {
	DispatchID string `json:"dispatchId"`
	Message    string `json:"message"`
}
type TaskIngressDispatchRequest struct {
	DispatchID string `json:"dispatchId"`
}
type TaskIngressOperationRequest struct {
	OperationID string `json:"operationId"`
}
type TaskIngressCursor struct {
	StreamID   string `json:"streamId"`
	Generation uint64 `json:"generation"`
	Sequence   uint64 `json:"sequence"`
}
type TaskIngressObservationRequest struct {
	DispatchID    string            `json:"dispatchId"`
	Cursor        TaskIngressCursor `json:"cursor"`
	Limit         int               `json:"limit"`
	IncludeResult bool              `json:"includeResult"`
}
type TaskIngressDispatchResponse struct {
	TaskID         string              `json:"taskId"`
	DispatchID     string              `json:"dispatchId"`
	Reference      controlct.Reference `json:"reference"`
	Lifecycle      controlct.Lifecycle `json:"lifecycle"`
	Pending        bool                `json:"pending"`
	Retained       bool                `json:"retained"`
	Text           string              `json:"text,omitempty"`
	ResultEvidence string              `json:"resultEvidence,omitempty"`
	Delivery       string              `json:"delivery"`
}
type TaskIngressFailure struct{ Code string }

func (e *TaskIngressFailure) Error() string { return e.Code }

// TaskIngress is one trusted selected turn facade. Root still owns the original
// client, journal and ONE Owner; no request can select another lifetime.
type TaskIngress struct {
	runtime   *TaskRuntime
	scope     admissionct.Binding
	binding   controlct.Binding
	selection controlct.Selection
	parent    controlct.Parent
}

// NewTaskIngress only composes the existing selected runtime and captures value
// inputs. It never opens storage, connects, observes, admits or qualifies a host.
func NewTaskIngress(in TaskRuntimeInputs, parent controlct.Parent) (*TaskIngress, error) {
	if !task.ID(parent.ThreadID) || !task.ID(parent.TurnID) {
		return nil, &TaskIngressFailure{"TASK_INPUT_INVALID"}
	}
	runtime, err := NewTaskRuntime(in)
	if err != nil {
		return nil, taskIngressError(err)
	}
	b := in.Route.Selection()
	selected := in.Binding
	root := func(r task.Root) controlct.Root {
		return controlct.Root{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
	}
	return &TaskIngress{
		runtime:   runtime,
		scope:     admissionct.Binding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID},
		binding:   controlct.Binding{Provider: controlct.Provider(selected.Provider), ProfileID: selected.ProfileID, HostID: selected.HostID, ProjectID: selected.ProjectID, WorkspaceID: selected.WorkspaceID, Project: root(selected.Project), Writer: root(selected.Writer), ModelAlias: selected.ModelAlias, Model: selected.Model, Effort: selected.Effort, ConfigDigest: selected.ConfigDigest},
		selection: controlct.Selection{Provider: controlct.Provider(selected.Provider), ProjectID: selected.ProjectID, WorkspaceID: selected.WorkspaceID, ModelAlias: selected.ModelAlias, Effort: selected.Effort},
		parent:    parent,
	}, nil
}

func taskIngressError(err error) error {
	var c *controlct.Failure
	var o *observationct.Failure
	var a *admissionct.Failure
	var r *TaskRuntimeFailure
	code := "TASK_OUTCOME_UNKNOWN"
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = "TASK_REQUEST_CANCELLED"
	case errors.As(err, &c):
		code = c.Code
	case errors.As(err, &o):
		code = o.Code
	case errors.As(err, &a):
		code = a.Code
	case errors.As(err, &r):
		code = r.Code
	}
	return &TaskIngressFailure{code}
}
func (g *TaskIngress) ready(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return taskIngressError(err)
	}
	if g == nil || g.runtime == nil || g.runtime.Control() == nil || g.runtime.Observation() == nil || g.runtime.Admission() == nil {
		return &TaskIngressFailure{"TASK_UNAVAILABLE"}
	}
	return nil
}
func (g *TaskIngress) selectedAdmission(ctx context.Context, requireActive bool) error {
	err := g.runtime.Admission().WithCurrent(ctx, func(b *admissionct.Binding) error {
		if b == nil {
			if requireActive {
				return &TaskIngressFailure{"TASK_STATE_REFUSED"}
			}
			return nil
		}
		if *b != g.scope {
			return &TaskIngressFailure{"TASK_IDENTITY_MISMATCH"}
		}
		return nil
	})
	if err != nil {
		var own *TaskIngressFailure
		if errors.As(err, &own) {
			return own
		}
		return taskIngressError(err)
	}
	return nil
}

func (g *TaskIngress) Resolve(ctx context.Context) (*controlct.ResolveResponse, error) {
	if err := g.ready(ctx); err != nil {
		return nil, err
	}
	if err := g.selectedAdmission(ctx, false); err != nil {
		return nil, err
	}
	out, err := g.runtime.Control().Resolve(ctx, controlct.ResolveRequest{Selection: g.selection})
	if err != nil {
		return nil, taskIngressError(err)
	}
	if out.Binding != g.binding {
		return nil, &TaskIngressFailure{"TASK_IDENTITY_MISMATCH"}
	}
	return out, nil
}
func (g *TaskIngress) Create(ctx context.Context, operationID string, req TaskIngressCreateRequest) (*controlct.MutationResponse, error) {
	if err := g.ready(ctx); err != nil {
		return nil, err
	}
	if err := g.selectedAdmission(ctx, false); err != nil {
		return nil, err
	}
	out, err := g.runtime.Control().Create(ctx, controlct.CreateRequest{OperationID: operationID, TaskID: g.scope.TaskID, Message: req.Message, Selection: g.selection, Parent: g.parent})
	if err != nil {
		return nil, taskIngressError(err)
	}
	return out, nil
}
func (g *TaskIngress) Continue(ctx context.Context, operationID string, req TaskIngressContinueRequest) (*controlct.MutationResponse, error) {
	if err := g.ready(ctx); err != nil {
		return nil, err
	}
	if err := g.selectedAdmission(ctx, false); err != nil {
		return nil, err
	}
	out, err := g.runtime.Control().ContinueExact(ctx, controlct.ContinueExactRequest{OperationID: operationID, TaskID: g.scope.TaskID, Message: req.Message, ExpectedDispatchID: req.DispatchID})
	if err != nil {
		return nil, taskIngressError(err)
	}
	return out, nil
}

// Resume selects the exact terminal Claude dispatch. The Task owner guards
// that parent in the same journal CAS; the body cannot choose a provider session.
func (g *TaskIngress) Resume(ctx context.Context, operationID string, req TaskIngressResumeRequest) (*controlct.MutationResponse, error) {
	if err := g.ready(ctx); err != nil {
		return nil, err
	}
	if err := g.selectedAdmission(ctx, false); err != nil {
		return nil, err
	}
	out, err := g.runtime.Control().ResumeExact(ctx, controlct.ResumeExactRequest{OperationID: operationID, TaskID: g.scope.TaskID, Message: req.Message, ExpectedDispatchID: req.DispatchID})
	if err != nil {
		return nil, taskIngressError(err)
	}
	return out, nil
}

// Observe explicitly polls only the current selected Task. Exact dispatch reads
// below never call this method, poll a provider or settle an unknown mutation.
func (g *TaskIngress) Observe(ctx context.Context) (*controlct.StatusResponse, error) {
	if err := g.ready(ctx); err != nil {
		return nil, err
	}
	if err := g.selectedAdmission(ctx, true); err != nil {
		return nil, err
	}
	out, err := g.runtime.Control().Status(ctx, controlct.TaskRequest{TaskID: g.scope.TaskID})
	if err != nil {
		return nil, taskIngressError(err)
	}
	if out.TaskID != g.scope.TaskID || out.Binding != g.binding {
		return nil, &TaskIngressFailure{"TASK_IDENTITY_MISMATCH"}
	}
	// A known terminal observation may close this admission. A different active
	// turn is never returned as if it belonged to this selected facade.
	if err := g.selectedAdmission(ctx, false); err != nil {
		return nil, err
	}
	return out, nil
}
func (g *TaskIngress) Observation(ctx context.Context, req TaskIngressObservationRequest) (*observationct.Response, error) {
	if err := g.ready(ctx); err != nil {
		return nil, err
	}
	limit := req.Limit
	if limit == 0 {
		limit = 32
	}
	out, err := g.runtime.Observation().Read(ctx, observationct.Request{TaskID: g.scope.TaskID, DispatchID: req.DispatchID, Cursor: observationct.Cursor{StreamID: req.Cursor.StreamID, Generation: req.Cursor.Generation, Sequence: req.Cursor.Sequence}, Limit: limit, IncludeResult: req.IncludeResult})
	if err != nil {
		return nil, taskIngressError(err)
	}
	if out.TaskID != g.scope.TaskID || out.DispatchID != req.DispatchID {
		return nil, &TaskIngressFailure{"TASK_IDENTITY_MISMATCH"}
	}
	return out, nil
}
func (g *TaskIngress) dispatch(ctx context.Context, req TaskIngressDispatchRequest, includeResult bool) (*TaskIngressDispatchResponse, error) {
	out, err := g.Observation(ctx, TaskIngressObservationRequest{DispatchID: req.DispatchID, Limit: 1, IncludeResult: includeResult})
	if err != nil {
		return nil, err
	}
	lifecycle := controlct.Lifecycle(out.Lifecycle)
	switch lifecycle {
	case controlct.Unknown, controlct.Running, controlct.Completed, controlct.Failed, controlct.Interrupted, controlct.NeedsInput, controlct.Refused:
	default:
		return nil, &TaskIngressFailure{"TASK_OUTCOME_UNKNOWN"}
	}
	return &TaskIngressDispatchResponse{TaskID: out.TaskID, DispatchID: out.DispatchID, Reference: controlct.Reference{SessionID: out.Reference.SessionID, ThreadID: out.Reference.ThreadID, TurnID: out.Reference.TurnID, InvocationID: out.Reference.InvocationID}, Lifecycle: lifecycle, Pending: out.Pending, Retained: out.Retained, Text: out.Result, ResultEvidence: out.ResultEvidence, Delivery: out.Delivery}, nil
}
func (g *TaskIngress) Status(ctx context.Context, req TaskIngressDispatchRequest) (*TaskIngressDispatchResponse, error) {
	return g.dispatch(ctx, req, false)
}
func (g *TaskIngress) Result(ctx context.Context, req TaskIngressDispatchRequest) (*TaskIngressDispatchResponse, error) {
	return g.dispatch(ctx, req, true)
}
func (g *TaskIngress) Operation(ctx context.Context, req TaskIngressOperationRequest) (*controlct.OperationResponse, error) {
	if err := g.ready(ctx); err != nil {
		return nil, err
	}
	out, err := g.runtime.Control().Operation(ctx, controlct.OperationRequest{OperationID: req.OperationID})
	if err != nil {
		return nil, taskIngressError(err)
	}
	if out.TaskID != g.scope.TaskID {
		return nil, &TaskIngressFailure{"TASK_IDENTITY_MISMATCH"}
	}
	return out, nil
}
