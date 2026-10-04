package boot

import (
	"context"
	"errors"
	"reflect"

	computerprocess "github.com/legrch/farol/modules/computer/contracts/process"
	admissioncap "github.com/legrch/farol/modules/task/app/capabilities/admission"
	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	admissionct "github.com/legrch/farol/modules/task/contracts/admission"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	observationct "github.com/legrch/farol/modules/task/contracts/observation"
	"github.com/legrch/farol/modules/task/domain"
	claudeclient "github.com/legrch/farol/modules/task/infra/clients/claude"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	progress "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
	processpeer "github.com/legrch/farol/modules/task/infra/peer/process"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

// TaskRuntimeInputs is trusted Root composition, never a wire request. Route
// belongs to the ONE existing qualified Task Owner/journal lifetime. Codex is
// the existing concrete selected connection; Claude captures one deferred
// operation. Construction neither connects nor issues admission. Native
// capability qualification and retirement remain separate.
type TaskRuntimeInputs struct {
	Route     *taskrepo.Route
	Binding   task.Binding
	Authority port.Authority
	Delivery  port.Delivery
	Codex     *codexclient.Client
	Claude    *ClaudeTaskInputs
}
type ClaudeTaskInputs struct {
	Selection   claudeclient.Selection
	OperationID string
	Computer    *computerprocess.Contract
	Process     *ClaudeProcessInputs
}
type TaskRuntimeFailure struct{ Code string }

func (e *TaskRuntimeFailure) Error() string { return e.Code }

type TaskRuntime struct {
	service     *tasksvc.Service
	control     *controlct.Contract
	observation *observationct.Contract
	admission   *admissionct.Contract
}

func taskRuntimeUnavailable(code string) error { return &TaskRuntimeFailure{Code: code} }
func taskRuntimeError(err error) error {
	code := "TASK_RUNTIME_UNAVAILABLE"
	switch {
	case errors.Is(err, task.ErrInvalid):
		code = "TASK_RUNTIME_INPUT_INVALID"
	case errors.Is(err, task.ErrIdentity):
		code = "TASK_RUNTIME_IDENTITY_MISMATCH"
	case errors.Is(err, task.ErrUnknown):
		code = "TASK_RUNTIME_OUTCOME_UNKNOWN"
	case errors.Is(err, task.ErrUnsupported):
		code = "TASK_RUNTIME_CAPABILITY_UNAVAILABLE"
	}
	return taskRuntimeUnavailable(code)
}
func taskRuntimeMissing(v any) bool {
	if v == nil {
		return true
	}
	r := reflect.ValueOf(v)
	switch r.Kind() {
	case reflect.Pointer, reflect.Interface, reflect.Func, reflect.Map, reflect.Slice, reflect.Chan:
		return r.IsNil()
	}
	return false
}
func taskRuntimeValidate(in TaskRuntimeInputs) error {
	if in.Route == nil {
		return taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
	}
	b := in.Route.Selection()
	scope := task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
	if !scope.Valid() || !in.Binding.Valid() {
		return taskRuntimeUnavailable("TASK_RUNTIME_INPUT_INVALID")
	}
	if taskRuntimeMissing(in.Authority) {
		return taskRuntimeUnavailable("TASK_RUNTIME_AUTHORITY_UNAVAILABLE")
	}
	return nil
}

// NewTaskRuntime performs only source composition. It never opens storage,
// resolves settings, probes a provider, prepares/spawns a process or changes
// admission. Existing Service/Owner behavior owns every later effect/reconnect.
func NewTaskRuntime(in TaskRuntimeInputs) (*TaskRuntime, error) {
	if err := taskRuntimeValidate(in); err != nil {
		return nil, err
	}
	switch in.Binding.Provider {
	case task.Codex:
		if in.Codex == nil {
			return nil, taskRuntimeUnavailable("TASK_RUNTIME_CODEX_ADAPTER_UNAVAILABLE")
		}
		// Preserve the concrete Client's ObservedProvider implementation and
		// owning lifetime. Root closes it; this per-turn facade does not.
		return taskRuntime(in, in.Codex)
	case task.Claude:
		if in.Claude == nil {
			return nil, taskRuntimeUnavailable("TASK_RUNTIME_CLAUDE_SELECTION_UNAVAILABLE")
		}
		q := in.Claude.Selection
		b := in.Route.Selection()
		scope := task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
		if q.Binding != in.Binding || q.Scope != scope {
			return nil, taskRuntimeUnavailable("TASK_RUNTIME_IDENTITY_MISMATCH")
		}
		selected, err := claudeclient.NewSelection(q)
		if err != nil {
			return nil, taskRuntimeError(err)
		}
		if in.Claude.Process != nil {
			// Normal composition uses the same selected Task route/journal. An
			// explicit trusted port remains available for bounded CPU composition;
			// a typed-nil port is invalid, not a request to choose another owner.
			selected := *in.Claude
			process := *selected.Process
			if process.Reservations == nil {
				reservation, err := newTaskProcessReservation(in.Route)
				if err != nil {
					return nil, err
				}
				process.Reservations = reservation
			}
			selected.Process = &process
			provider, err := newTaskClaudeProvider(&selected)
			if err != nil {
				return nil, err
			}
			return taskRuntime(in, provider)
		}
		if in.Claude.Computer == nil {
			return nil, taskRuntimeUnavailable("TASK_RUNTIME_COMPUTER_PROCESS_UNAVAILABLE")
		}
		_, err = processpeer.New(in.Claude.Computer, processpeer.Selection{OperationID: in.Claude.OperationID, RuntimeID: q.RuntimeID, SessionID: q.SessionID, ModelID: selected.Binding().Model, AdmissionID: q.AdmissionID})
		if err != nil {
			return nil, taskRuntimeError(err)
		}
		// A preselected contract cannot supply the missing deferred native
		// composition/qualification. Preserve the old unavailable boundary;
		// do not fabricate authority or infer a Host from a Prepare echo.
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_CLAUDE_HOST_UNAVAILABLE")
	default:
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_INPUT_INVALID")
	}
}

// Existing consumer ports permit labelled CPU aggregate doubles, matching the
// Computer root pattern. Public New accepts the concrete Codex Client or the
// deferred Claude/Computer composition; it accepts no caller-selected Provider
// map and keeps missing native qualification unavailable.
func taskRuntime(in TaskRuntimeInputs, provider port.Provider) (*TaskRuntime, error) {
	if err := taskRuntimeValidate(in); err != nil {
		return nil, err
	}
	if taskRuntimeMissing(provider) {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_PROVIDER_UNAVAILABLE")
	}
	delivery := in.Delivery
	if taskRuntimeMissing(delivery) {
		delivery = nil
	}
	service, err := tasksvc.NewOwned(in.Route, taskRuntimeAuthority{selected: in.Binding, delegate: in.Authority}, map[task.Provider]port.Provider{in.Binding.Provider: provider}, delivery, intent.Fingerprint, progress.NewProgress)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	controller, err := admissioncap.New(in.Route, in.Route.Selection())
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	control, err := controlct.New(service)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	observation, err := observationct.New(service)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	return &TaskRuntime{service: service, control: control, observation: observation, admission: admissionct.New(controller)}, nil
}

// Root captures one already selected route. Delegate still owns fresh physical,
// account/model/parent authority; a changed resolver cannot substitute a model.
type taskRuntimeAuthority struct {
	selected task.Binding
	delegate port.Authority
}

func (a taskRuntimeAuthority) Resolve(ctx context.Context, q port.Selection) (task.Binding, error) {
	b, err := a.delegate.Resolve(ctx, q)
	if err != nil {
		return task.Binding{}, err
	}
	if b != a.selected {
		return task.Binding{}, task.ErrIdentity
	}
	return b, nil
}
func (a taskRuntimeAuthority) Recheck(ctx context.Context, b task.Binding) error {
	if b != a.selected {
		return task.ErrIdentity
	}
	return a.delegate.Recheck(ctx, b)
}
func (a taskRuntimeAuthority) RecheckParent(ctx context.Context, p task.Parent) error {
	return a.delegate.RecheckParent(ctx, p)
}
func (r *TaskRuntime) Control() *controlct.Contract {
	if r == nil {
		return nil
	}
	return r.control
}
func (r *TaskRuntime) Observation() *observationct.Contract {
	if r == nil {
		return nil
	}
	return r.observation
}
func (r *TaskRuntime) Admission() *admissionct.Contract {
	if r == nil {
		return nil
	}
	return r.admission
}
