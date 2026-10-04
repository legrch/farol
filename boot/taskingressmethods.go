package boot

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// Methods binds one already selected Task/turn facade. Root owns selection and
// lifetime; these bodies cannot supply an Owner, route, epoch, model or grant.
// This is not NativeRuntime registration or native provider qualification.
func (g *TaskIngress) Methods() map[string]desktop.Method {
	if g == nil {
		return nil
	}
	methods := make(map[string]desktop.Method)
	add := func(name, shape string, handle func(context.Context, desktop.Request) (*desktop.Outcome, error)) {
		methods[name] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if wire.RequiresOperationID(name) != (r.OperationID != "") || ipc.ValidateJSON(r.Body) != nil || wire.Validate(shape, r.Body) != nil {
				return invalidIngress()
			}
			return handle(ctx, r)
		}}
	}
	add("task.resolve", "Empty", func(ctx context.Context, _ desktop.Request) (*desktop.Outcome, error) {
		value, err := g.Resolve(ctx)
		if err != nil {
			return taskWireFailure(err)
		}
		return taskWireOutcome("TaskResolution", taskWireResolution(value))
	})
	add("task.create", "TaskCreate", func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.TaskCreate
		if json.Unmarshal(r.Body, &in) != nil {
			return invalidIngress()
		}
		value, err := g.Create(ctx, r.OperationID, TaskIngressCreateRequest{Message: in.Message})
		if err != nil {
			return taskWireFailure(err)
		}
		return taskWireMutation(value)
	})
	add("task.continue", "TaskContinue", func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.TaskContinue
		if json.Unmarshal(r.Body, &in) != nil {
			return invalidIngress()
		}
		value, err := g.Continue(ctx, r.OperationID, TaskIngressContinueRequest{DispatchID: in.DispatchId, Message: in.Message})
		if err != nil {
			return taskWireFailure(err)
		}
		return taskWireMutation(value)
	})
	add("task.resume", "TaskResume", func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.TaskResume
		if json.Unmarshal(r.Body, &in) != nil {
			return invalidIngress()
		}
		value, err := g.Resume(ctx, r.OperationID, TaskIngressResumeRequest{DispatchID: in.DispatchId, Message: in.Message})
		if err != nil {
			return taskWireFailure(err)
		}
		return taskWireMutation(value)
	})
	// Explicit provider observation is a read: it cannot issue a new provider turn.
	// Its selected owner may retain observed state; unknown never becomes dispatch.
	add("task.observe", "Empty", func(ctx context.Context, _ desktop.Request) (*desktop.Outcome, error) {
		value, err := g.Observe(ctx)
		if err != nil {
			return taskWireFailure(err)
		}
		return taskWireOutcome("TaskStatus", taskWireStatus(value))
	})
	for _, name := range []string{"task.status", "task.result"} {
		add(name, "TaskDispatchRequest", func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.TaskDispatchRequest
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			var value *TaskIngressDispatchResponse
			var err error
			if name == "task.result" {
				value, err = g.Result(ctx, TaskIngressDispatchRequest{DispatchID: in.DispatchId})
			} else {
				value, err = g.Status(ctx, TaskIngressDispatchRequest{DispatchID: in.DispatchId})
			}
			if err != nil {
				return taskWireFailure(err)
			}
			return taskWireOutcome("TaskDispatch", taskWireDispatch(value))
		})
	}
	add("task.operation.status", "TaskOperationRequest", func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.TaskOperationRequest
		if json.Unmarshal(r.Body, &in) != nil {
			return invalidIngress()
		}
		value, err := g.Operation(ctx, TaskIngressOperationRequest{OperationID: in.OperationId})
		if err != nil {
			return taskWireFailure(err)
		}
		return taskWireOutcome("TaskOperation", taskWireOperation(value))
	})
	add("task.observation.read", "TaskObservationRequest", func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.TaskObservationRequest
		if json.Unmarshal(r.Body, &in) != nil {
			return invalidIngress()
		}
		req := TaskIngressObservationRequest{DispatchID: in.DispatchId}
		if in.Cursor != nil {
			req.Cursor = TaskIngressCursor{StreamID: in.Cursor.StreamId, Generation: wireUint(in.Cursor.Generation), Sequence: wireUint(in.Cursor.Sequence)}
		}
		if in.Limit != nil {
			req.Limit = int(*in.Limit)
		}
		if in.IncludeResult != nil {
			req.IncludeResult = *in.IncludeResult
		}
		value, err := g.Observation(ctx, req)
		if err != nil {
			return taskWireFailure(err)
		}
		return taskWireOutcome("TaskObservation", taskWireObservation(value))
	})
	return methods
}

func taskWireFailure(err error) (*desktop.Outcome, error) {
	var failure *TaskIngressFailure
	if !errors.As(err, &failure) {
		return nil, err
	}
	code := failure.Code
	if len(code) == 0 || len(code) > 128 {
		code = "TASK_OUTCOME_UNKNOWN"
	}
	for _, r := range code {
		if !(r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			code = "TASK_OUTCOME_UNKNOWN"
			break
		}
	}
	status := "unknown"
	switch code {
	case "TASK_INPUT_INVALID", "TASK_IDENTITY_MISMATCH", "TASK_NOT_FOUND", "TASK_OPERATION_CONFLICT", "TASK_STATE_REFUSED", "TASK_RUNTIME_INPUT_INVALID", "TASK_RUNTIME_IDENTITY_MISMATCH":
		status = "refused"
	case "TASK_UNAVAILABLE", "TASK_CAPABILITY_UNAVAILABLE", "TASK_RUNTIME_UNAVAILABLE", "TASK_RUNTIME_OWNER_UNAVAILABLE", "TASK_RUNTIME_AUTHORITY_UNAVAILABLE", "TASK_RUNTIME_CODEX_ADAPTER_UNAVAILABLE", "TASK_RUNTIME_CLAUDE_SELECTION_UNAVAILABLE", "TASK_RUNTIME_COMPUTER_PROCESS_UNAVAILABLE", "TASK_RUNTIME_CLAUDE_HOST_UNAVAILABLE", "TASK_RUNTIME_PROVIDER_UNAVAILABLE", "TASK_RUNTIME_CAPABILITY_UNAVAILABLE":
		status = "unavailable"
	}
	// Cancellation can follow a possible effect. It does not establish refusal.
	return &desktop.Outcome{Status: status, Code: code}, nil
}
func taskWireOutcome(shape string, value any) (*desktop.Outcome, error) {
	raw, err := json.Marshal(value)
	if err != nil || ipc.ValidateJSON(raw) != nil || wire.Validate(shape, raw) != nil {
		return nil, errors.New("task_response_invalid")
	}
	return &desktop.Outcome{Status: "ok", Data: raw}, nil
}
