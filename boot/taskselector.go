package boot

import (
	"context"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

// CodexTaskSource comes from trusted current host/settings composition. It has
// no caller-selected coding Task identity or epoch. Missing host/schema/current
// authority remains unavailable; this value is not provider qualification.
type CodexTaskSource struct {
	Selection  codexclient.Selection
	Followup   codexclient.FollowupQualification
	Authority  port.Authority
	Delivery   port.Delivery
	ChatHandle string
	Parent     controlct.Parent
}

// TaskSelector mints Root-owned facade scopes, not Task execution admissions.
// The existing Owner/journal still performs every admission and dispatch CAS.
// It neither restores scopes from disk nor selects/replaces a provider client.
type TaskSelector struct {
	mu      sync.Mutex
	surface *TaskSurface
	records map[string]*taskSelectorRecord
}

type taskSelectorRecord struct {
	input     CodexTaskTurn
	chat      conversation.Binding
	route     *taskrepo.Route
	selecting bool
	advanced  bool
}

func NewTaskSelector(surface *TaskSurface) (*TaskSelector, error) {
	if surface == nil || surface.profile == nil || surface.profile.available(context.Background()) != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
	}
	return &TaskSelector{surface: surface, records: make(map[string]*taskSelectorRecord)}, nil
}

func (s *TaskSelector) ready(ctx context.Context) error {
	if s == nil || ctx == nil || s.surface == nil || s.surface.profile == nil {
		return taskRuntimeUnavailable("TASK_RUNTIME_INPUT_INVALID")
	}
	return s.surface.profile.available(ctx)
}

// BeginCodex creates independent coding identities. Chat's task epoch, turn
// generation and caller-supplied IDs are not an admission authority source.
// It opens no provider connection and publishes no durable Task intention.
func (s *TaskSelector) BeginCodex(ctx context.Context, source CodexTaskSource) (*wire.TaskHandle, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	if taskRuntimeMissing(source.Authority) {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_AUTHORITY_UNAVAILABLE")
	}
	if err := source.Authority.Recheck(ctx, source.Selection.Binding); err != nil {
		return nil, taskRuntimeError(err)
	}
	var ids [4]string
	for n := range ids {
		id, err := randomIngressID()
		if err != nil {
			return nil, taskRuntimeUnavailable("TASK_RUNTIME_UNAVAILABLE")
		}
		ids[n] = id
	}
	input := CodexTaskTurn{
		Scope:     port.CurrentBinding{OwnerID: s.surface.profile.owner, SessionID: ids[0], TaskID: ids[1], TaskEpoch: 1, ParticipantID: ids[2], TurnID: ids[3]},
		Selection: source.Selection, Followup: source.Followup, Authority: source.Authority, Delivery: source.Delivery, ChatHandle: source.ChatHandle, Parent: source.Parent,
	}
	return s.selectTurn(ctx, input)
}

func (s *TaskSelector) selectTurn(ctx context.Context, input CodexTaskTurn) (*wire.TaskHandle, error) {
	chat, err := s.surface.profile.chat.get(input.ChatHandle)
	if err != nil {
		return nil, taskRuntimeError(task.ErrIdentity)
	}
	handle, err := s.surface.SelectCodex(ctx, input)
	if err != nil {
		return nil, err
	}
	p := s.surface.profile
	p.mu.Lock()
	owned := p.tasks[input.Scope.TaskID]
	var route *taskrepo.Route
	if owned != nil {
		route = owned.turns[input.Scope].route
	}
	p.mu.Unlock()
	if route == nil || p.available(ctx) != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.records) >= 4096 || s.records[handle.HandleId] != nil || p.available(ctx) != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_UNAVAILABLE")
	}
	s.records[handle.HandleId] = &taskSelectorRecord{input: input, chat: chat.binding, route: route}
	return handle, nil
}

// ContinueCodex selects a fresh scope for a known completed exact dispatch.
// This first startup path intentionally selects only completed tasks. The Task
// service remains responsible for capability, parent and journal-CAS admission
// at the later Continue call. Selection itself is no grant or reservation.
func (s *TaskSelector) ContinueCodex(ctx context.Context, prior wire.TaskHandle, dispatchID, chatHandle string) (*wire.TaskHandle, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	if !validIngressID(prior.HandleId) || !task.ID(dispatchID) || !validIngressID(chatHandle) {
		return nil, taskRuntimeError(task.ErrInvalid)
	}
	s.mu.Lock()
	record := s.records[prior.HandleId]
	if record == nil || record.selecting || record.advanced {
		s.mu.Unlock()
		return nil, taskRuntimeError(task.ErrState)
	}
	record.selecting = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); record.selecting = false; s.mu.Unlock() }()
	input := record.input
	parent, err := s.surface.profile.chat.get(chatHandle)
	if err != nil || !taskSelectorSameChatTask(record.chat, parent.binding) {
		return nil, taskRuntimeError(task.ErrIdentity)
	}
	if input.Scope.TaskEpoch == ^uint64(0) {
		return nil, taskRuntimeError(task.ErrState)
	}
	if input.Followup == (codexclient.FollowupQualification{}) {
		return nil, taskRuntimeError(task.ErrUnsupported)
	}
	if err := input.Authority.Recheck(ctx, input.Selection.Binding); err != nil {
		return nil, taskRuntimeError(err)
	}
	before, err := record.completed(ctx, dispatchID)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_UNAVAILABLE")
	}
	input.Scope.TaskEpoch++
	input.Scope.TurnID, input.ChatHandle = id, chatHandle
	if source, ok := input.Authority.(*codexTaskSourceAuthority); ok {
		// Rebind only the actual parent for this same-Chat turn. The selected
		// host/grant reader and original lazy provider client remain fixed.
		input.Authority, err = source.selectParent(ctx, chatHandle)
		if err != nil {
			return nil, taskRuntimeError(err)
		}
	}
	next, err := s.selectTurn(ctx, input)
	if err != nil {
		return nil, err
	}
	// Parent selection can wait. Do not expose the new scope after a concurrent
	// journal change; an unreturned address is retained only for bounded cleanup.
	after, err := record.completed(ctx, dispatchID)
	if err != nil || *after != *before || s.ready(ctx) != nil {
		return nil, taskRuntimeError(task.ErrUnknown)
	}
	s.mu.Lock()
	record.advanced = true
	s.mu.Unlock()
	return next, nil
}

func (r *taskSelectorRecord) completed(ctx context.Context, dispatchID string) (*port.Snapshot, error) {
	state, err := r.route.Read(ctx, r.input.Scope.TaskID)
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, task.ErrNotFound
	}
	if state.Pending != "" {
		return nil, task.ErrUnknown
	}
	b := r.input.Scope
	expected := task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
	v := state.Task
	if v.ID != b.TaskID || v.Binding != r.input.Selection.Binding || v.Parent != (task.Parent{ThreadID: r.input.Parent.ThreadID, TurnID: r.input.Parent.TurnID}) || v.DispatchID != dispatchID || v.Admission.Binding != expected {
		return nil, task.ErrIdentity
	}
	if v.Lifecycle != task.Completed || v.Admission.State != task.AdmissionClosed || !v.Reference.Complete(task.Codex) {
		return nil, task.ErrState
	}
	return state, nil
}

// External Parent IDs are independent of Chat IDs. Root retains their actual
// initial Chat association; an active unrelated Chat must not replace it. The
// existing Chat owner still decides whether this exact new turn is current.
func taskSelectorSameChatTask(old, next conversation.Binding) bool {
	if old.ProfileID != next.ProfileID || old.BackendGeneration != next.BackendGeneration || old.OwnerID != next.OwnerID || old.SessionID != next.SessionID || old.TaskID != next.TaskID || old.TaskEpoch != next.TaskEpoch || old.ParticipantID != next.ParticipantID || next.TurnGeneration < old.TurnGeneration {
		return false
	}
	return next.TurnGeneration > old.TurnGeneration || old == next
}
