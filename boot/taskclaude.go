package boot

import (
	"context"
	"sync"

	computerport "github.com/legrch/farol/modules/computer/app/port"
	execution "github.com/legrch/farol/modules/computer/app/services/execution"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	claude "github.com/legrch/farol/modules/task/infra/clients/claude"
	processpeer "github.com/legrch/farol/modules/task/infra/peer/process"
)

// ClaudeProcessInputs belongs to trusted Root composition. Issuer captures the
// SAME Task admission facade and Computer ceiling; none of these values is a
// request or a positive native grant. Production must supply qualified native
// preparation/reservation and a fresh route-specific Host Recheck separately.
type ClaudeProcessInputs struct {
	Issuer   *execution.Service
	Preparer processsvc.InvocationPreparer
	// Nil selects the original Task route's durable reservation in Root.
	// Explicit ports belong to trusted composition, never request data.
	Reservations processsvc.Reservation
	Clock        computerport.Clock
	Recheck      func(context.Context, claude.Selection) (task.Capabilities, error)
	Output       func(context.Context, task.Reference, string) error
}

// One selected operation only. The Task Service/Owner remains the lifecycle and
// durable intent owner. No process, lease or Host exists before admitted dispatch.
type taskClaudeProvider struct {
	mu        sync.Mutex
	selection claude.Selection
	selected  *claude.Selected
	operation string
	inputs    ClaudeProcessInputs
	attempted bool
	pending   bool
	host      *claude.Host
	failure   error
}

var _ port.ObservedProvider = (*taskClaudeProvider)(nil)

func newTaskClaudeProvider(in *ClaudeTaskInputs) (*taskClaudeProvider, error) {
	if in == nil || in.Process == nil || in.Process.Issuer == nil || taskRuntimeMissing(in.Process.Preparer) || taskRuntimeMissing(in.Process.Reservations) || taskRuntimeMissing(in.Process.Clock) || in.Process.Recheck == nil {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_CLAUDE_HOST_UNAVAILABLE")
	}
	if !task.ID(in.OperationID) {
		return nil, taskRuntimeUnavailable("TASK_RUNTIME_INPUT_INVALID")
	}
	selected, err := claude.NewSelection(in.Selection)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	q := in.Selection
	q.Efforts = append([]claude.EffortMapping(nil), q.Efforts...)
	return &taskClaudeProvider{selection: q, selected: selected, operation: in.OperationID, inputs: *in.Process}, nil
}

func (p *taskClaudeProvider) qualify(ctx context.Context, q claude.Selection) (caps task.Capabilities, err error) {
	defer func() {
		if recover() != nil {
			caps, err = task.Capabilities{}, task.ErrUnknown
		}
	}()
	if ctx == nil || ctx.Err() != nil {
		return task.Capabilities{}, task.ErrUnavailable
	}
	q.Efforts = append([]claude.EffortMapping(nil), q.Efforts...)
	caps, err = p.inputs.Recheck(ctx, q)
	if err != nil {
		return task.Capabilities{}, err
	}
	if ctx.Err() != nil {
		return task.Capabilities{}, task.ErrUnavailable
	}
	// A declaration for an active control cannot enable it in this Host slice.
	return task.Capabilities{Create: caps.Create, Resume: caps.Resume && p.selection.ExactResume}, nil
}
func (p *taskClaudeProvider) Supports(ctx context.Context, b task.Binding) (task.Capabilities, error) {
	if b != p.selection.Binding {
		return task.Capabilities{}, task.ErrIdentity
	}
	p.mu.Lock()
	h, pending, failure := p.host, p.pending, p.failure
	p.mu.Unlock()
	if pending || failure != nil {
		return task.Capabilities{}, task.ErrUnknown
	}
	if h != nil {
		return h.Supports(ctx, b)
	}
	// Capability qualification precedes Task admission and must not Admit a
	// Computer lease. Missing real native qualification remains unavailable.
	return p.qualify(ctx, p.selection)
}
func (p *taskClaudeProvider) selectHost(ctx context.Context, d port.Dispatch) (host *claude.Host, err error) {
	defer func() {
		if recover() != nil {
			host, err = nil, task.ErrUnknown
		}
	}()
	caps, err := p.qualify(ctx, p.selection)
	if err != nil || !caps.Supports(d.Intent.Action) {
		return nil, task.ErrUnavailable
	}
	lease, err := p.inputs.Issuer.Admit(ctx, authority.Shell)
	if err != nil {
		return nil, err
	}
	scope := p.selection.Scope
	expected := computerport.TaskBinding{Identity: authority.Identity{OwnerID: scope.OwnerID, SessionID: scope.SessionID, TaskID: scope.TaskID, TaskEpoch: scope.TaskEpoch}, ParticipantID: scope.ParticipantID, TurnID: scope.TurnID}
	if lease.Binding() != expected || lease.Participant().Grant.AuthorityID != p.selection.AdmissionID {
		return nil, task.ErrIdentity
	}
	service, err := processsvc.NewForInvocation(p.operation, lease, p.inputs.Preparer, p.inputs.Reservations, &sync.Mutex{}, p.inputs.Clock)
	if err != nil {
		return nil, err
	}
	contract, err := processct.New(service)
	if err != nil {
		return nil, err
	}
	peer, err := processpeer.New(contract, processpeer.Selection{OperationID: p.operation, RuntimeID: p.selection.RuntimeID, SessionID: p.selection.SessionID, ModelID: p.selection.Binding.Model, AdmissionID: p.selection.AdmissionID})
	if err != nil {
		return nil, err
	}
	return claude.NewHost(claude.HostOptions{Selection: p.selection, OperationID: p.operation, Process: peer, Recheck: p.qualify, Output: p.inputs.Output, Now: func() uint64 {
		n := p.inputs.Clock.Now().UnixMilli()
		if n <= 0 || n > 9007199254740991 {
			return 0
		}
		return uint64(n)
	}})
}
func (p *taskClaudeProvider) Dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	return p.dispatch(ctx, d, progress, nil)
}
func (p *taskClaudeProvider) DispatchObserved(ctx context.Context, d port.Dispatch, progress func(task.Reference) error, record func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
	if record == nil {
		return task.Receipt{State: task.Rejected, Code: "CLAUDE_TASK_INVALID"}, nil
	}
	return p.dispatch(ctx, d, progress, record)
}
func (p *taskClaudeProvider) dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error, record func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
	if progress == nil || d.Intent.OperationID != p.operation {
		return task.Receipt{State: task.Rejected, Code: "CLAUDE_TASK_IDENTITY_MISMATCH"}, nil
	}
	if _, err := p.selected.Build(d); err != nil {
		return task.Receipt{State: task.Rejected, Code: "CLAUDE_TASK_SELECTION_REFUSED"}, nil
	}
	p.mu.Lock()
	if p.pending || p.failure != nil || p.attempted && p.host == nil {
		p.mu.Unlock()
		return task.Receipt{State: task.Uncertain}, task.ErrUnknown
	}
	host := p.host
	if host == nil {
		p.attempted, p.pending = true, true
	}
	p.mu.Unlock()
	if host == nil {
		var err error
		host, err = p.selectHost(ctx, d)
		p.mu.Lock()
		p.host, p.failure, p.pending = host, err, false
		p.mu.Unlock()
		if err != nil || host == nil {
			return task.Receipt{State: task.Uncertain}, task.ErrUnknown
		}
	}
	if record != nil {
		return host.DispatchObserved(ctx, d, progress, record)
	}
	return host.Dispatch(ctx, d, progress)
}
func (p *taskClaudeProvider) Observe(ctx context.Context, b task.Binding, ref task.Reference) (port.Observation, error) {
	p.mu.Lock()
	host, pending, failure := p.host, p.pending, p.failure
	p.mu.Unlock()
	if host == nil || pending || failure != nil {
		return port.Observation{}, task.ErrUnknown
	}
	return host.Observe(ctx, b, ref)
}
