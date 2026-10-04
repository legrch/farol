package boot

import (
	"context"
	"encoding/json"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// TaskSurface routes an opaque handle to an already selected Task/turn facade.
// The trusted Root selects the original profile, authority and parent. Neither
// the handle nor a request body can create an Owner, select a provider or grant
// admission. One surface belongs to the same profile/backend as its Server.
// NativeRuntime registration still requires actual trusted selection producers.
type TaskSurface struct {
	profile *TaskProfile
	mu      sync.Mutex
	handles map[string]*TaskIngress
}

func NewTaskSurface(profile *TaskProfile) (*TaskSurface, error) {
	if profile == nil || profile.available(context.Background()) != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
	}
	return &TaskSurface{profile: profile, handles: make(map[string]*TaskIngress)}, nil
}

// SelectCodex is trusted composition, not a wire method. It returns only the
// address of the selected facade; selection remains lazy and does not dispatch.
func (s *TaskSurface) SelectCodex(ctx context.Context, input CodexTaskTurn) (*wire.TaskHandle, error) {
	if s == nil || s.profile == nil || s.profile.available(ctx) != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_UNAVAILABLE")
	}
	// Selection can wait on the parent owner. Do not hold the address map
	// mutex across that work; the profile bounds its selected routes to 4096.
	g, err := s.profile.SelectCodex(ctx, input)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = s.profile.available(ctx); err != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
	}
	if len(s.handles) >= 4096 || s.handles[id] != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_UNAVAILABLE")
	}
	s.handles[id] = g
	return &wire.TaskHandle{HandleId: id}, nil
}

func (s *TaskSurface) Methods() map[string]desktop.Method {
	if s == nil || s.profile == nil {
		return nil
	}
	shapes := map[string]string{
		"task.resolve":          "TaskRoutedRequest",
		"task.create":           "TaskRoutedCreate",
		"task.continue":         "TaskRoutedContinue",
		"task.resume":           "TaskRoutedResume",
		"task.observe":          "TaskRoutedRequest",
		"task.status":           "TaskRoutedDispatchRequest",
		"task.result":           "TaskRoutedDispatchRequest",
		"task.operation.status": "TaskRoutedOperationRequest",
		"task.observation.read": "TaskRoutedObservationRequest",
	}
	methods := make(map[string]desktop.Method, len(shapes))
	for name, shape := range shapes {
		methods[name] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if wire.RequiresOperationID(name) != (r.OperationID != "") || ipc.ValidateJSON(r.Body) != nil || wire.Validate(shape, r.Body) != nil {
				return invalidIngress()
			}
			if s.profile.available(ctx) != nil {
				return taskWireFailure(taskIngressError(taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")))
			}
			var in struct {
				HandleID string          `json:"handleId"`
				Request  json.RawMessage `json:"request"`
			}
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			s.mu.Lock()
			g := s.handles[in.HandleID]
			s.mu.Unlock()
			if g == nil {
				return taskWireFailure(&TaskIngressFailure{"TASK_NOT_FOUND"})
			}
			// Retained facade checks its own captured Task scope and authority.
			// Delegation does not reselect from IDs, journal contents or EOF.
			inner := r
			inner.Body = in.Request
			if len(inner.Body) == 0 {
				inner.Body = json.RawMessage(`{}`)
			}
			return g.Methods()[name].Handle(ctx, inner)
		}}
	}
	return methods
}
