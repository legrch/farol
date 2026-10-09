package boot

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	parentpeer "github.com/legrch/farol/modules/task/infra/peer/parent"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

// TaskProfile retains the one Task journal and one Owner per TaskID for a
// backend lifetime. It composes existing facades; it owns no lifecycle engine,
// admission epoch producer, account qualification, reconnect or recovery policy.
// NativeRuntime must not expose it until actual trusted selection is connected.
type TaskProfile struct {
	mu           sync.Mutex
	peer         wire.Context
	owner        string
	chat         *ChatIngress
	journal      port.AdmissionJournal
	closeJournal func() error
	tasks        map[string]*taskProfileOwner
	clients      map[*codexclient.Client]string
	read         *taskReadSlot
	routes       []*taskrepo.Route
	closed       atomic.Bool
	closeDone    chan struct{}
	closeErr     error
	newClient    func(codexclient.Selection, codexclient.FollowupQualification, func(context.Context, task.Binding) error, func(context.Context, task.Intent) error) (*codexclient.Client, error)
}

type taskProfileOwner struct {
	owner     *taskrepo.Owner
	selection codexclient.Selection
	followup  codexclient.FollowupQualification
	parent    controlct.Parent
	client    *codexclient.Client
	turns     map[port.CurrentBinding]taskProfileTurn
}

type taskProfileTurn struct {
	route     *taskrepo.Route
	authority taskProfileAuthority
}

// OpenTaskProfile uses only the selected profile's already qualified fixed Task
// child. It never creates a missing profile child or restores active admissions.
// Physical storage qualification/exclusive old-writer handoff are separate gates.
func OpenTaskProfile(profile *QualifiedProfile, peer wire.Context, owner string, chat *ChatIngress) (*TaskProfile, error) {
	if profile == nil || !taskProfileIdentity(peer, owner, chat) {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_INPUT_INVALID")
	}
	root, err := profile.TaskRoot()
	if err != nil || root.ProfileID != peer.ProfileId {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
	}
	journal, err := taskrepo.OpenFilesystem(taskrepo.FilesystemRoot{ProfileID: root.ProfileID, Path: root.Path, Device: root.Device, Inode: root.Inode})
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	current, err := profile.TaskRoot()
	if err != nil || current != root {
		return nil, errors.Join(taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE"), journal.Close())
	}
	return newTaskProfile(peer, owner, chat, journal, journal.Close), nil
}

func taskProfileIdentity(peer wire.Context, owner string, chat *ChatIngress) bool {
	return validateIngress("Context", peer) == nil && validIngressID(owner) && chat != nil && chat.peer == peer && chat.owner == owner
}

// Private seam only for labelled CPU journal boundaries. The public constructor
// always opens the qualified native repository above, once for the profile.
func newTaskProfile(peer wire.Context, owner string, chat *ChatIngress, journal port.AdmissionJournal, closeJournal func() error) *TaskProfile {
	return &TaskProfile{peer: peer, owner: owner, chat: chat, journal: journal, closeJournal: closeJournal, tasks: make(map[string]*taskProfileOwner), clients: make(map[*codexclient.Client]string), closeDone: make(chan struct{}), newClient: func(s codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		return codexclient.New(codexclient.Options{Selection: s, Followup: q, Boundary: codexclient.NativeBoundary(), Now: time.Now, Recheck: grant, RecheckDispatch: dispatch})
	}}
}

// CodexTaskTurn is trusted Root selection, never a renderer/wire body. Scope is
// independently selected Task identity: it is not derived from Chat's epoch or
// turn generation. Parent explicitly names the original external initiating turn.
// The profile creates and retains its original lazy Client with its dispatch
// guard from the outset; an external Client or later guard rebinding is excluded.
// Selection is lazy: it does not connect, publish admission or start a provider turn.
type CodexTaskTurn struct {
	Scope      port.CurrentBinding
	Selection  codexclient.Selection
	Followup   codexclient.FollowupQualification
	Authority  port.Authority
	Delivery   port.Delivery
	ChatHandle string
	Parent     controlct.Parent
}

func (p *TaskProfile) SelectCodex(ctx context.Context, input CodexTaskTurn) (*TaskIngress, error) {
	b := input.Scope
	admission := task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
	if p == nil || ctx == nil || ctx.Err() != nil || !admission.Valid() || !input.Selection.Binding.Valid() || input.Selection.Binding.Provider != task.Codex || taskRuntimeMissing(input.Authority) || !task.ID(input.Parent.ThreadID) || !task.ID(input.Parent.TurnID) {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_INPUT_INVALID")
	}
	if b.OwnerID != p.owner || input.Selection.Binding.ProfileID != p.peer.ProfileId || !taskProfileIdentity(p.peer, p.owner, p.chat) {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_IDENTITY_MISMATCH")
	}
	h, err := p.chat.get(input.ChatHandle)
	if err != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_IDENTITY_MISMATCH")
	}
	current, err := h.handle.Admission()
	if err != nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_AUTHORITY_UNAVAILABLE")
	}
	cb := h.binding
	parent, err := parentpeer.New(current, parentpeer.Selection{Parent: task.Parent{ThreadID: input.Parent.ThreadID, TurnID: input.Parent.TurnID}, Binding: parentpeer.Binding{OwnerID: cb.OwnerID, SessionID: cb.SessionID, TaskID: cb.TaskID, TaskEpoch: cb.TaskEpoch, ParticipantID: cb.ParticipantID, TurnID: cb.TurnID}})
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	if err = parent.RecheckParent(ctx, task.Parent{ThreadID: input.Parent.ThreadID, TurnID: input.Parent.TurnID}); err != nil {
		return nil, taskRuntimeError(err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed.Load() || ctx.Err() != nil || len(p.routes) >= 4096 {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_UNAVAILABLE")
	}
	record := p.tasks[b.TaskID]
	if record == nil {
		if len(p.tasks) >= 1024 || p.newClient == nil {
			return nil, taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
		}
		owner, err := taskrepo.New(p.journal, b.TaskID)
		if err != nil {
			return nil, taskRuntimeError(err)
		}
		client, err := p.newClient(input.Selection, input.Followup, input.Authority.Recheck, func(ctx context.Context, intent task.Intent) error {
			if intent.TaskID != b.TaskID {
				return task.ErrIdentity
			}
			return p.recheckDispatch(ctx, intent)
		})
		if err != nil {
			return nil, taskRuntimeError(err)
		}
		if client == nil || p.clients[client] != "" {
			return nil, taskRuntimeUnavailable("TASK_RUNTIME_OWNER_UNAVAILABLE")
		}
		record = &taskProfileOwner{owner: owner, selection: input.Selection, followup: input.Followup, parent: input.Parent, client: client, turns: make(map[port.CurrentBinding]taskProfileTurn)}
	} else if record.selection != input.Selection || record.followup != input.Followup || record.parent != input.Parent {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_IDENTITY_MISMATCH")
	}
	if _, exists := record.turns[b]; exists {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_IDENTITY_MISMATCH")
	}
	route, err := record.owner.Select(b)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	authority := taskProfileAuthority{profile: p, delegate: input.Authority, parent: parent}
	ingress, err := NewTaskIngress(TaskRuntimeInputs{Route: route, Binding: input.Selection.Binding, Authority: authority, Delivery: input.Delivery, Codex: record.client}, input.Parent)
	if err != nil {
		return nil, err
	}
	p.tasks[b.TaskID] = record
	p.clients[record.client] = b.TaskID
	record.turns[b] = taskProfileTurn{route: route, authority: authority}
	p.routes = append(p.routes, route)
	return ingress, nil
}

// The immutable Client hook carries the original intent explicitly to its
// physical write boundary. It checks the same durable pending operation, current
// Task route and actual parent after provider waits; reads grant no fresh admission.
func (p *TaskProfile) recheckDispatch(ctx context.Context, intent task.Intent) error {
	if err := p.available(ctx); err != nil {
		return err
	}
	a := intent.Admission
	scope := port.CurrentBinding{OwnerID: a.OwnerID, SessionID: a.SessionID, TaskID: a.TaskID, TaskEpoch: a.TaskEpoch, ParticipantID: a.ParticipantID, TurnID: a.TurnID}
	p.mu.Lock()
	record := p.tasks[intent.TaskID]
	if record == nil || record.selection.Binding != intent.Binding || record.parent.ThreadID != intent.Parent.ThreadID || record.parent.TurnID != intent.Parent.TurnID || !a.Valid() || a.TaskID != intent.TaskID || (intent.Action != task.Create && intent.Action != task.Continue && intent.Action != task.Message) {
		p.mu.Unlock()
		return task.ErrIdentity
	}
	turn, ok := record.turns[scope]
	p.mu.Unlock()
	if !ok {
		return task.ErrIdentity
	}
	operation, err := turn.route.Lookup(ctx, intent.OperationID)
	if err != nil {
		return err
	}
	if operation == nil || operation.Settled || operation.Intent != intent {
		return task.ErrUnknown
	}
	if intent.Action == task.Message {
		// Steer controls the existing running dispatch, never a newly selected
		// turn. A matching pending intent alone cannot refresh its active target.
		snapshot, readErr := turn.route.Read(ctx, intent.TaskID)
		if readErr != nil {
			return readErr
		}
		if snapshot == nil || snapshot.Pending != intent.OperationID || snapshot.Task.ID != intent.TaskID || snapshot.Task.Binding != intent.Binding || snapshot.Task.Parent != intent.Parent || snapshot.Task.Reference != intent.Expected || !intent.Expected.Complete(task.Codex) || snapshot.Task.Lifecycle != task.Running || snapshot.Task.CancelRequested || snapshot.Task.Admission.Binding != a || snapshot.Task.Admission.State != task.AdmissionActive {
			return task.ErrState
		}
	}
	if err = turn.authority.Recheck(ctx, intent.Binding); err != nil {
		return err
	}
	err = turn.route.WithCurrent(ctx, func(current *port.CurrentBinding) error {
		if current == nil || *current != scope {
			return task.ErrState
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Complete Task-owner waiting before the final actual Chat parent read.
	// No journal/host work or profile mutex acquisition follows that read.
	if err = turn.authority.RecheckParent(ctx, intent.Parent); err != nil {
		return err
	}
	return p.available(ctx)
}

func (p *TaskProfile) available(ctx context.Context) error {
	if p == nil || ctx == nil || ctx.Err() != nil {
		return task.ErrUnavailable
	}
	if p.closed.Load() {
		return task.ErrUnavailable
	}
	return nil
}

type taskProfileAuthority struct {
	profile  *TaskProfile
	delegate port.Authority
	parent   *parentpeer.Peer
}

func (a taskProfileAuthority) Resolve(ctx context.Context, s port.Selection) (task.Binding, error) {
	if err := a.profile.available(ctx); err != nil {
		return task.Binding{}, err
	}
	b, err := a.delegate.Resolve(ctx, s)
	if err != nil {
		return task.Binding{}, err
	}
	if err = a.profile.available(ctx); err != nil {
		return task.Binding{}, err
	}
	return b, nil
}
func (a taskProfileAuthority) Recheck(ctx context.Context, b task.Binding) error {
	if err := a.profile.available(ctx); err != nil {
		return err
	}
	if err := a.delegate.Recheck(ctx, b); err != nil {
		return err
	}
	return a.profile.available(ctx)
}
func (a taskProfileAuthority) RecheckParent(ctx context.Context, parent task.Parent) error {
	if err := a.profile.available(ctx); err != nil {
		return err
	}
	if err := a.delegate.RecheckParent(ctx, parent); err != nil {
		return err
	}
	if err := a.parent.RecheckParent(ctx, parent); err != nil {
		return err
	}
	return a.profile.available(ctx)
}

// Close first withdraws facade authority and fences all retained Task routes,
// then closes each exact owned Client and the sole journal. It never cancels a
// provider task, retries unknown cleanup or closes the outer profile owner.
func (p *TaskProfile) Close(ctx context.Context) error {
	if p == nil {
		return nil
	}
	if ctx == nil {
		return task.ErrUnavailable
	}
	p.mu.Lock()
	if p.closeDone == nil {
		p.mu.Unlock()
		return task.ErrUnavailable
	}
	if p.closed.Load() {
		done := p.closeDone
		p.mu.Unlock()
		// A retained completed cleanup wins over a later caller cancellation.
		select {
		case <-done:
			p.mu.Lock()
			defer p.mu.Unlock()
			return p.closeErr
		default:
		}
		select {
		case <-done:
			p.mu.Lock()
			defer p.mu.Unlock()
			return p.closeErr
		case <-ctx.Done():
			return task.ErrUnknown
		}
	}
	p.closed.Store(true)
	routes := append([]*taskrepo.Route(nil), p.routes...)
	clients := make([]*codexclient.Client, 0, len(p.clients))
	for client := range p.clients {
		clients = append(clients, client)
	}
	p.mu.Unlock()
	for _, route := range routes {
		route.Fence()
	}
	var failures []error
	for _, client := range clients {
		failures = append(failures, client.Close(ctx))
	}
	if p.closeJournal != nil {
		failures = append(failures, p.closeJournal())
	}
	p.mu.Lock()
	p.closeErr = errors.Join(failures...)
	close(p.closeDone)
	err := p.closeErr
	p.mu.Unlock()
	return err
}
