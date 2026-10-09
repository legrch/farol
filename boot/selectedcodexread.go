package boot

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	control "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/contracts/selectedthread"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

const selectedCodexReadMethod = "task.codex.selected.read"

// Trusted composition only. It reuses one original Task reader and owns no
// Client, admission, journal or native qualification. Normal startup leaves nil.
type connectorCodexRead struct {
	hostID string
	reader selectedthread.Reader
}

type selectedCodexReadFunc func(context.Context, selectedthread.Request) (*selectedthread.Response, error)

func (f selectedCodexReadFunc) Read(ctx context.Context, in selectedthread.Request) (*selectedthread.Response, error) {
	return f(ctx, in)
}

type connectorCodexReadSeal struct {
	source    connectorCodexRead
	authority codexclient.AuthoritySnapshot
	selection wire.TaskSelectedCodexReadSelection
}

// Captured under the connector owner's existing current-publication gate. This
// callback only copies values; it performs no IO or Task/Computer reentry.
func (s *computerConnector) codexReadSeal(slot *connectorSlot) *connectorCodexReadSeal {
	if s.codexRead == nil || s.codexRead.reader == nil || s.codexRead.hostID != "codex" {
		return nil
	}
	var seal *connectorCodexReadSeal
	err := slot.owner.WithCurrent(s.lifetime, func(binding *computerport.TaskBinding) error {
		p := s.root.publication
		if binding == nil || p == nil || p.taskCodex == nil || p.taskCodexRead == nil {
			return task.ErrUnavailable
		}
		a := *p.taskCodex
		selected := taskReadSelection(a.Selection.Binding, taskReference(*p.taskCodexRead))
		selected.Binding.HostID = s.codexRead.hostID
		value := wire.TaskSelectedCodexReadSelection{Binding: taskWireBinding(selected.Binding), Reference: *p.taskCodexRead}
		if validateIngress("TaskSelectedCodexReadSelection", value) != nil || value.Binding.Provider != "codex" {
			return task.ErrUnavailable
		}
		seal = &connectorCodexReadSeal{source: *s.codexRead, authority: a, selection: value}
		return nil
	})
	if err != nil {
		return nil
	}
	return seal
}

func taskReference(r wire.TaskCodexReadSelection) control.Reference {
	return control.Reference{ThreadID: r.ThreadId, TurnID: r.TurnId}
}

func (s *computerConnector) selectedCodexReadRoute(slot *connectorSlot, seal *connectorCodexReadSeal) desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if ctx == nil || request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("TaskSelectedCodexReadRequest", request.Body) != nil {
			return selectedCodexReadOutcome(task.ErrInvalid)
		}
		var in wire.TaskSelectedCodexReadRequest
		if json.Unmarshal(request.Body, &in) != nil {
			return selectedCodexReadOutcome(task.ErrInvalid)
		}
		// A single existing Computer read lease narrows this socket operation.
		// It does not create a Task or Chat parent, and cannot grow after IO.
		lease, err := slot.route.admit(ctx, authority.Read)
		if err != nil {
			return selectedCodexReadOutcome(task.ErrUnavailable)
		}
		readCtx, cancel := context.WithDeadline(ctx, lease.Deadline())
		defer cancel()
		check := func() error {
			if err := slot.owner.WithCurrent(readCtx, func(binding *computerport.TaskBinding) error {
				p := s.root.publication
				if binding == nil || p == nil || p.taskCodex == nil || p.taskCodexRead == nil || *p.taskCodex != seal.authority || *p.taskCodexRead != seal.selection.Reference {
					return task.ErrUnavailable
				}
				return nil
			}); err != nil {
				return task.ErrUnavailable
			}
			return lease.WithSnapshot(readCtx, lease.Binding().ParticipantID, func(computerport.AccessSnapshot) error { return nil })
		}
		if err = check(); err != nil {
			return selectedCodexReadOutcome(task.ErrUnavailable)
		}
		include := in.IncludeResult != nil && *in.IncludeResult
		out, err := seal.source.reader.Read(readCtx, selectedthread.Request{IncludeResult: include})
		if err != nil {
			return selectedCodexReadOutcome(err)
		}
		if err = check(); err != nil {
			return selectedCodexReadOutcome(task.ErrUnavailable)
		}
		if out == nil {
			return selectedCodexReadOutcome(task.ErrUnknown)
		}
		selected := wire.TaskSelectedCodexReadSelection{Binding: taskWireBinding(out.Selection.Binding), Reference: wire.TaskCodexReadSelection{ThreadId: out.Selection.Reference.ThreadID, TurnId: out.Selection.Reference.TurnID}}
		if selected != seal.selection || out.Selection.Reference.SessionID != "" || out.Selection.Reference.InvocationID != "" || out.Retained || (!include && out.Text != "") || (out.Lifecycle != "completed" && (out.Text != "" || out.ResultEvidence != "")) || (out.Lifecycle == "completed" && out.ResultEvidence != "provider_history") {
			return selectedCodexReadOutcome(task.ErrUnknown)
		}
		value := wire.TaskSelectedCodexReadResponse{Selection: selected, Lifecycle: string(out.Lifecycle), Text: out.Text, Source: out.Source, Snapshot: out.Snapshot, Retained: out.Retained, ResultEvidence: out.ResultEvidence}
		if validateIngress("TaskSelectedCodexReadResponse", value) != nil {
			return selectedCodexReadOutcome(task.ErrUnknown)
		}
		return taskWireOutcome("TaskSelectedCodexReadResponse", value)
	}}
}

func selectedCodexReadOutcome(err error) (*desktop.Outcome, error) {
	var failure *selectedthread.Failure
	code := nativeCodexReadFailure(err).(*selectedthread.Failure).Code
	if errors.As(err, &failure) {
		code = failure.Code
	}
	status := "unknown"
	switch code {
	case "TASK_INPUT_INVALID", "TASK_IDENTITY_MISMATCH", "TASK_STATE_REFUSED":
		status = "refused"
	case "TASK_UNAVAILABLE":
		status = "unavailable"
	case "TASK_REQUEST_CANCELLED", "TASK_OBSERVATION_UNKNOWN":
	default:
		code = "TASK_OBSERVATION_UNKNOWN"
	}
	return &desktop.Outcome{Status: status, Code: code}, nil
}
