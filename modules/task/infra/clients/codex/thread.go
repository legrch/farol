package codex

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/contracts/selectedthread"
	"github.com/legrch/farol/modules/task/domain"
)

// SelectedThreadReader retains the original selected Client. It owns no
// connection, Task admission, journal, result cache or proxy cleanup lifetime.
type SelectedThreadReader struct {
	client   *Client
	selected selectedthread.Selection
	recheck  func(context.Context, selectedthread.Selection) error
}

func selectedBinding(b control.Binding) task.Binding {
	root := func(r control.Root) task.Root {
		return task.Root{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
	}
	return task.Binding{Provider: task.Provider(b.Provider), ProfileID: b.ProfileID, HostID: b.HostID,
		ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, Project: root(b.Project), Writer: root(b.Writer),
		ModelAlias: b.ModelAlias, Model: b.Model, Effort: b.Effort, ConfigDigest: b.ConfigDigest}
}

func selectedReference(r control.Reference) task.Reference {
	return task.Reference{SessionID: r.SessionID, ThreadID: r.ThreadID, TurnID: r.TurnID, InvocationID: r.InvocationID}
}

// NewSelectedThreadReader is inert. Root supplies a sealed selection and a
// mandatory fresh selection/grant recheck, including the native thread/turn.
// The Client's existing binding/grant and physical checks remain mandatory too.
// A read-only selection never qualifies native execution policy or Task control.
func NewSelectedThreadReader(client *Client, selected selectedthread.Selection, recheck func(context.Context, selectedthread.Selection) error) (*SelectedThreadReader, error) {
	if client == nil || recheck == nil {
		return nil, &selectedthread.Failure{Code: "TASK_UNAVAILABLE"}
	}
	b, ref := selectedBinding(selected.Binding), selectedReference(selected.Reference)
	if b != client.selection.Binding || !ref.Complete(task.Codex) || !providerID(ref.ThreadID) || !providerID(ref.TurnID) {
		return nil, &selectedthread.Failure{Code: "TASK_IDENTITY_MISMATCH"}
	}
	return &SelectedThreadReader{client: client, selected: selected, recheck: recheck}, nil
}

func selectedReadFailure(err error) error {
	code := "TASK_OBSERVATION_UNKNOWN"
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = "TASK_REQUEST_CANCELLED"
	case errors.Is(err, task.ErrIdentity):
		code = "TASK_IDENTITY_MISMATCH"
	case errors.Is(err, task.ErrState):
		code = "TASK_STATE_REFUSED"
	case errors.Is(err, task.ErrUnavailable), errors.Is(err, task.ErrUnsupported):
		code = "TASK_UNAVAILABLE"
	}
	return &selectedthread.Failure{Code: code}
}

func (r *SelectedThreadReader) check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return selectedReadFailure(err)
	}
	if err := r.recheck(ctx, r.selected); err != nil {
		return selectedReadFailure(err)
	}
	if err := ctx.Err(); err != nil {
		return selectedReadFailure(err)
	}
	return nil
}

func (r *SelectedThreadReader) Read(ctx context.Context, req selectedthread.Request) (*selectedthread.Response, error) {
	if ctx == nil {
		return nil, &selectedthread.Failure{Code: "TASK_INPUT_INVALID"}
	}
	if r == nil || r.client == nil || r.recheck == nil {
		return nil, &selectedthread.Failure{Code: "TASK_UNAVAILABLE"}
	}
	if err := ctx.Err(); err != nil {
		return nil, selectedReadFailure(err)
	}
	ref := selectedReference(r.selected.Reference)
	out, err := r.client.observe(ctx, selectedBinding(r.selected.Binding), ref, r.check)
	if err != nil {
		var failure *selectedthread.Failure
		if errors.As(err, &failure) {
			return nil, failure
		}
		return nil, selectedReadFailure(err)
	}
	if out.Reference != ref || !out.Lifecycle.Valid() || out.Lifecycle == task.Unknown || out.Lifecycle == task.Refused {
		return nil, &selectedthread.Failure{Code: "TASK_OBSERVATION_UNKNOWN"}
	}
	response := &selectedthread.Response{Selection: r.selected, Lifecycle: control.Lifecycle(out.Lifecycle), Source: "stored", Snapshot: "non_atomic"}
	if out.Lifecycle == task.Completed {
		response.ResultEvidence = "provider_history"
		if req.IncludeResult {
			response.Text = out.Result
		}
	}
	return response, nil
}

var _ selectedthread.Reader = (*SelectedThreadReader)(nil)
