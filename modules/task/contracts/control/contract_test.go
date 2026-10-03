package control_test

// Shipping facade/service/admission owner are composed here. Only the storage,
// authority and provider ports are scripted; no native or live qualification.
import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	admissioncap "github.com/legrch/farol/modules/task/app/capabilities/admission"
	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/contracts/admission"
	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	progress "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

var ctx = context.Background()

// Private one-task in-memory backing port, not a shipping persistence engine.
type memory struct {
	mu         sync.Mutex
	snapshot   *port.Snapshot
	ops        map[string]port.Operation
	failFinish bool
}

func (j *memory) Lookup(_ context.Context, id string) (*port.Operation, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	out, ok := j.ops[id]
	if !ok {
		return nil, nil
	}
	return &out, nil
}
func (j *memory) Read(_ context.Context, id string) (*port.Snapshot, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.snapshot == nil {
		return nil, nil
	}
	if j.snapshot.Task.ID != id {
		return nil, task.ErrNotFound
	}
	out := *j.snapshot
	return &out, nil
}
func (j *memory) Admit(_ context.Context, i task.Intent, revision uint64, prepared task.Task) (*port.Admission, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if op, ok := j.ops[i.OperationID]; ok {
		return &port.Admission{Operation: op, Snapshot: *j.snapshot}, nil
	}
	if j.snapshot == nil {
		if i.Action != task.Create || revision != 0 {
			return nil, task.ErrState
		}
		j.snapshot = &port.Snapshot{Task: prepared}
	} else if i.Action == task.Create || j.snapshot.Revision != revision || j.snapshot.Pending != "" {
		return nil, task.ErrConflict
	}
	j.snapshot.Task = prepared
	j.snapshot.Pending = i.OperationID
	j.snapshot.Revision++
	op := port.Operation{Intent: i, Receipt: task.Receipt{State: task.Uncertain}}
	j.ops[i.OperationID] = op
	return &port.Admission{Operation: op, Snapshot: *j.snapshot, Claimed: true}, nil
}
func (j *memory) Progress(_ context.Context, id string, ref task.Reference) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	op, ok := j.ops[id]
	if !ok || j.snapshot.Pending != id || !op.Lineage.Extend(ref, op.Intent.Binding.Provider) {
		return task.ErrIdentity
	}
	op.Lineage = ref
	j.ops[id] = op
	return nil
}
func (j *memory) Finish(_ context.Context, id string, r task.Receipt, next task.Task) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	op, ok := j.ops[id]
	if !ok || op.Settled || j.snapshot.Pending != id {
		return task.ErrState
	}
	if j.failFinish {
		return errors.New("private journal finish unknown")
	}
	op.Receipt = r
	op.Settled = true
	j.ops[id] = op
	j.snapshot.Task = next
	j.snapshot.Pending = ""
	j.snapshot.Revision++
	return nil
}
func (j *memory) Observe(_ context.Context, before port.Snapshot, next task.Task) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if *j.snapshot != before || before.Pending != "" || before.Task.Reference != next.Reference {
		return task.ErrConflict
	}
	j.snapshot.Task = next
	j.snapshot.Revision++
	if next.Lifecycle.Terminal() {
		op := j.ops[next.DispatchID]
		op.Receipt.Lifecycle = next.Lifecycle
		op.Receipt.Result = next.Result
		j.ops[next.DispatchID] = op
	}
	return nil
}
func (j *memory) Invalidate(_ context.Context, before port.Snapshot) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if *j.snapshot != before {
		return task.ErrConflict
	}
	j.snapshot.Task.Admission.State = task.AdmissionRevoked
	j.snapshot.Revision++
	return nil
}

type authority struct {
	binding               task.Binding
	resolves              int
	resolveErr, errorRead error
}

func (a *authority) Resolve(_ context.Context, q port.Selection) (task.Binding, error) {
	a.resolves++
	if a.resolveErr != nil {
		return task.Binding{}, a.resolveErr
	}
	b := a.binding
	if q.Provider != b.Provider || q.ProjectID != b.ProjectID || q.WorkspaceID != b.WorkspaceID || q.ModelAlias != b.ModelAlias || q.Effort != b.Effort {
		return task.Binding{}, task.ErrUnavailable
	}
	return b, nil
}
func (a *authority) Recheck(_ context.Context, b task.Binding) error {
	if a.errorRead != nil {
		return a.errorRead
	}
	if b != a.binding {
		return task.ErrIdentity
	}
	return nil
}
func (*authority) RecheckParent(_ context.Context, p task.Parent) error {
	if p != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) {
		return task.ErrIdentity
	}
	return nil
}

type step struct {
	action              task.Action
	operation, message  string
	expected, reference task.Reference
	lifecycle           task.Lifecycle
	cancel, lostAck     bool
	rejection           string
}
type boundary struct {
	t                        *testing.T
	binding                  task.Binding
	caps                     task.Capabilities
	steps                    []step
	effects, reads, supports int
	admission                *admission.Contract
	observed                 port.Observation
}

func (p *boundary) Supports(_ context.Context, b task.Binding) (task.Capabilities, error) {
	p.supports++
	if b != p.binding {
		p.t.Fatal("Supports changed immutable binding")
	}
	return p.caps, nil
}
func (p *boundary) Dispatch(c context.Context, d port.Dispatch, record func(task.Reference) error) (task.Receipt, error) {
	p.t.Helper()
	if p.effects >= len(p.steps) {
		p.t.Fatal("unexpected extra provider effect")
	}
	want := p.steps[p.effects]
	i := d.Intent
	if i.Action != want.action || i.OperationID != want.operation || i.TaskID != "task" || i.Binding != p.binding || i.Expected != want.expected || i.Parent != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) || d.Message != want.message || !task.ID(i.Digest) || i.Admission.TaskID != "task" {
		p.t.Fatalf("wrong selected provider request: %+v", i)
	}
	if err := p.admission.WithCurrent(c, func(b *admission.Binding) error {
		if want.action == task.Cancel {
			if b != nil {
				p.t.Fatal("cancel left positive admission")
			}
		} else if b == nil || b.TaskEpoch != i.Admission.TaskEpoch || b.TurnID != i.Admission.TurnID || b.SessionID != "authority-session" {
			p.t.Fatal("effect did not use same admission owner")
		}
		return nil
	}); err != nil {
		p.t.Fatal(err)
	}
	p.effects++
	if want.rejection != "" {
		return task.Receipt{State: task.Rejected, Code: want.rejection}, nil
	}
	if err := record(want.reference); err != nil {
		return task.Receipt{}, err
	}
	if want.lostAck {
		return task.Receipt{}, errors.New("private provider reply lost")
	}
	return task.Receipt{State: task.Known, Reference: want.reference, Lifecycle: want.lifecycle, CancelRequested: want.cancel}, nil
}
func (p *boundary) Observe(_ context.Context, b task.Binding, r task.Reference) (port.Observation, error) {
	p.reads++
	if b != p.binding || len(p.steps) == 0 || r != p.steps[p.effects-1].reference {
		p.t.Fatal("observation substituted model/session/turn")
	}
	return p.observed, nil
}

// Delivery is an independent parent boundary, exercised only by an explicit
// existing Service.Deliver call; facade reads must never call this script.
type deliveryBoundary struct {
	t                *testing.T
	reference        task.Reference
	calls            int
	refused, lostAck bool
}

func (d *deliveryBoundary) Send(_ context.Context, p task.Parent, op string, r task.Reference, text string) (task.Receipt, error) {
	if d.calls != 0 || p != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) || op != "deliver-1" || r != d.reference || text != "retained result" {
		d.t.Fatal("wrong or duplicate parent delivery")
	}
	d.calls++
	if d.lostAck {
		return task.Receipt{}, errors.New("parent reply lost")
	}
	if d.refused {
		return task.Receipt{State: task.Rejected, Code: "DELIVERY_REFUSED"}, nil
	}
	return task.Receipt{State: task.Known, Reference: r}, nil
}

type fixture struct {
	t         *testing.T
	journal   *memory
	authority *authority
	owner     *taskrepo.Owner
	delivery  *deliveryBoundary
	provider  *boundary
	service   *tasksvc.Service
	facade    *control.Contract
}

func ref(p task.Provider, turn, op string) task.Reference {
	if p == task.Codex {
		return task.Reference{ThreadID: "thread-exact", TurnID: turn}
	}
	return task.Reference{SessionID: "claude-session-exact", InvocationID: op}
}
func newFixture(t *testing.T, p task.Provider) *fixture {
	t.Helper()
	b := task.Binding{Provider: p, ProfileID: "profile", HostID: "selected-host", ProjectID: "saved-project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "2", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "3", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "selected-alias", Model: "selected-runtime-model", Effort: "high", ConfigDigest: "config-A"}
	j := &memory{ops: map[string]port.Operation{}}
	owner, err := taskrepo.New(j, "task")
	if err != nil {
		t.Fatal(err)
	}
	initial := ref(p, "turn-1", "create-1")
	f := &fixture{t: t, journal: j, authority: &authority{binding: b}, owner: owner, provider: &boundary{t: t, binding: b, caps: task.Capabilities{Create: true, Continue: p == task.Codex, Resume: p == task.Claude}, steps: []step{{action: task.Create, operation: "create-1", message: "initial", reference: initial, lifecycle: task.Running}}, observed: port.Observation{Reference: initial, Lifecycle: task.Completed, Result: "retained result"}}}
	f.delivery = &deliveryBoundary{t: t, reference: initial}
	f.selectRoute(1)
	return f
}
func (f *fixture) selectRoute(epoch uint64) {
	f.t.Helper()
	route, err := f.owner.Select(port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task", TaskEpoch: epoch, ParticipantID: "participant", TurnID: "farol-turn-" + strconv.FormatUint(epoch, 10)})
	if err != nil {
		f.t.Fatal(err)
	}
	controller, err := admissioncap.New(route, route.Selection())
	if err != nil {
		f.t.Fatal(err)
	}
	f.provider.admission = admission.New(controller)
	f.service, err = tasksvc.NewOwned(route, f.authority, map[task.Provider]port.Provider{f.provider.binding.Provider: f.provider}, f.delivery, intent.Fingerprint, progress.NewProgress)
	if err != nil {
		f.t.Fatal(err)
	}
	f.facade, err = control.New(f.service)
	if err != nil {
		f.t.Fatal(err)
	}
}
func (f *fixture) createRequest() control.CreateRequest {
	b := f.authority.binding
	return control.CreateRequest{OperationID: "create-1", TaskID: "task", Message: "initial", Selection: control.Selection{Provider: control.Provider(b.Provider), ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, ModelAlias: b.ModelAlias, Effort: b.Effort}, Parent: control.Parent{ThreadID: "parent", TurnID: "parent-turn"}}
}
func (f *fixture) create() *control.MutationResponse {
	f.t.Helper()
	out, err := f.facade.Create(ctx, f.createRequest())
	if err != nil {
		f.t.Fatal(err)
	}
	return out
}
func requireFailure(t *testing.T, err error, code string) {
	t.Helper()
	var e *control.Failure
	if !errors.As(err, &e) || e.Code != code || err.Error() != code {
		t.Fatalf("failure %v, want %s", err, code)
	}
}

func TestNormalFacadeJourneyDelegatesToSameRealOwnerForBothProviders(t *testing.T) {
	for _, p := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(p), func(t *testing.T) {
			f := newFixture(t, p)
			resolved, err := f.facade.Resolve(ctx, control.ResolveRequest{Selection: f.createRequest().Selection})
			if err != nil {
				t.Fatal(err)
			}
			if resolved.Binding.Model != "selected-runtime-model" || resolved.Binding.ModelAlias != "selected-alias" || resolved.Binding.HostID != "selected-host" || resolved.Binding.Writer.Inode != "3" || resolved.Capabilities.Continue != (p == task.Codex) || resolved.Capabilities.Resume != (p == task.Claude) || resolved.Capabilities.Message || resolved.Capabilities.Cancel || f.provider.effects != 0 {
				t.Fatalf("wrong binding/capabilities: %+v", resolved)
			}
			resolved.Binding.Model = "consumer mutation"
			resolved.Binding.Writer.Inode = "other"
			created := f.create()
			if created.OperationID != "create-1" || created.TaskID != "task" || created.Receipt.State != control.Known || created.Receipt.Lifecycle != control.Running || created.Receipt.Reference.SessionID == "authority-session" {
				t.Fatalf("wrong create %+v", created)
			}
			if err := f.provider.admission.WithCurrent(ctx, func(b *admission.Binding) error {
				if b == nil || b.TaskEpoch != 1 {
					t.Fatal("create not active in same owner")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			created.Receipt.Reference.SessionID = "caller mutation"
			status, err := f.facade.Status(ctx, control.TaskRequest{TaskID: "task"})
			if err != nil {
				t.Fatal(err)
			}
			if status.Lifecycle != control.Completed || status.Binding.Model != "selected-runtime-model" || status.Parent.ThreadID != "parent" || status.DispatchID != "create-1" || status.DeliveryDispatchID != "" {
				t.Fatalf("wrong status %+v", status)
			}
			result, err := f.facade.Result(ctx, control.TaskRequest{TaskID: "task"})
			if err != nil || !result.Retained || result.Text != "retained result" || result.Reference != status.Reference || result.DispatchID != "create-1" {
				t.Fatalf("wrong result %+v %v", result, err)
			}
			if err := f.provider.admission.WithCurrent(ctx, func(b *admission.Binding) error {
				if b != nil {
					t.Fatal("terminal falsely retains active admission")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			oldFacade := f.facade
			beforeResolves := f.authority.resolves
			beforeSupports := f.provider.supports
			reconnected, err := control.New(f.service)
			if err != nil {
				t.Fatal(err)
			}
			old, err := reconnected.Operation(ctx, control.OperationRequest{OperationID: "create-1"})
			if err != nil || old.Receipt.Result != "retained result" || old.Action != control.Create {
				t.Fatalf("wrong reconnect %+v %v", old, err)
			}
			if f.provider.effects != 1 || f.provider.reads != 1 || f.authority.resolves != beforeResolves || f.provider.supports != beforeSupports {
				t.Fatal("reconnect performed provider work")
			}
			previous := ref(p, "turn-1", "create-1")
			next := ref(p, "turn-2", "follow-2")
			action := task.Continue
			if p == task.Claude {
				action = task.Resume
			}
			f.provider.steps = append(f.provider.steps, step{action: action, operation: "follow-2", message: "follow-up", expected: previous, reference: next, lifecycle: task.Running})
			f.selectRoute(2)
			req := control.FollowupRequest{OperationID: "follow-2", TaskID: "task", Message: "follow-up"}
			var followed *control.MutationResponse
			if p == task.Codex {
				followed, err = f.facade.Continue(ctx, req)
			} else {
				followed, err = f.facade.Resume(ctx, req)
			}
			if err != nil || followed.Receipt.State != control.Known || followed.Receipt.Reference == status.Reference || f.provider.effects != 2 || f.authority.resolves != beforeResolves {
				t.Fatalf("follow-up %+v %v", followed, err)
			}
			historical, err := oldFacade.Operation(ctx, control.OperationRequest{OperationID: "create-1"})
			if err != nil || historical.Receipt.Result != "retained result" || historical.Receipt.Reference != status.Reference {
				t.Fatalf("old result overwritten %+v %v", historical, err)
			}
		})
	}
}

func TestUnknownReconnectAndReplayNeverDispatchOrChangeSelection(t *testing.T) {
	for _, p := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(p), func(t *testing.T) {
			f := newFixture(t, p)
			f.provider.steps[0].lostAck = true
			out := f.create()
			if out.Receipt.State != control.Uncertain {
				t.Fatalf("unknown %+v", out)
			}
			resolves, supports := f.authority.resolves, f.provider.supports
			// Reconstruct only the facade, preserving the same service/owner.
			var err error
			f.facade, err = control.New(f.service)
			if err != nil {
				t.Fatal(err)
			}
			replay := f.create()
			if replay.Receipt.State != control.Uncertain {
				t.Fatal("replay changed unknown")
			}
			op, err := f.facade.Operation(ctx, control.OperationRequest{OperationID: "create-1"})
			if err != nil || op.Receipt.State != control.Uncertain || op.Lineage.SessionID != outReference(p).SessionID || op.Lineage.ThreadID != outReference(p).ThreadID {
				t.Fatalf("lost lineage %+v %v", op, err)
			}
			status, err := f.facade.Status(ctx, control.TaskRequest{TaskID: "task"})
			if err != nil || status.PendingOperationID != "create-1" || status.Lifecycle != control.Unknown {
				t.Fatalf("pending %+v %v", status, err)
			}
			_, err = f.facade.Result(ctx, control.TaskRequest{TaskID: "task"})
			requireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
			changed := f.createRequest()
			changed.Selection.ModelAlias = "new-model"
			_, err = f.facade.Create(ctx, changed)
			requireFailure(t, err, "TASK_OPERATION_CONFLICT")
			for _, controlCall := range []func(context.Context, control.FollowupRequest) (*control.MutationResponse, error){f.facade.Continue, f.facade.Resume, f.facade.Message} {
				_, err = controlCall(ctx, control.FollowupRequest{OperationID: "different-op", TaskID: "task", Message: "attempt"})
				requireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
			}
			_, err = f.facade.Cancel(ctx, control.CancelRequest{OperationID: "cancel", TaskID: "task"})
			requireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
			if f.provider.effects != 1 || f.provider.reads != 0 || f.authority.resolves != resolves || f.provider.supports != supports {
				t.Fatal("unknown caused extra provider call or resolve")
			}
			fresh := f.createRequest()
			fresh.OperationID = "new-key"
			_, err = f.facade.Create(ctx, fresh)
			requireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
			if f.provider.effects != 1 {
				t.Fatal("new key bypassed owner unknown fence")
			}
		})
	}
}
func outReference(p task.Provider) control.Reference {
	r := ref(p, "turn-1", "create-1")
	return control.Reference{SessionID: r.SessionID, ThreadID: r.ThreadID, TurnID: r.TurnID, InvocationID: r.InvocationID}
}

func TestCapabilityAndRunningResumeRefusalsHaveNoExtraEffect(t *testing.T) {
	f := newFixture(t, task.Claude)
	f.create()
	req := control.FollowupRequest{OperationID: "unsupported", TaskID: "task", Message: "input"}
	for _, call := range []func(context.Context, control.FollowupRequest) (*control.MutationResponse, error){f.facade.Continue, f.facade.Message} {
		_, err := call(ctx, req)
		requireFailure(t, err, "TASK_CAPABILITY_UNAVAILABLE")
	}
	_, err := f.facade.Cancel(ctx, control.CancelRequest{OperationID: "cancel", TaskID: "task"})
	requireFailure(t, err, "TASK_CAPABILITY_UNAVAILABLE")
	_, err = f.facade.Resume(ctx, req)
	requireFailure(t, err, "TASK_STATE_REFUSED")
	if f.provider.effects != 1 || f.provider.reads != 0 {
		t.Fatal("unsupported input sent")
	}
	f.provider.observed.Lifecycle = task.NeedsInput
	_, err = f.facade.Status(ctx, control.TaskRequest{TaskID: "task"})
	if err != nil {
		t.Fatal(err)
	}
	f.selectRoute(2)
	_, err = f.facade.Resume(ctx, req)
	requireFailure(t, err, "TASK_STATE_REFUSED")
	if f.provider.effects != 1 {
		t.Fatal("approval-blocked session resumed")
	}
}

func TestDeclaredMessageAndCancelKeepExactIssuedIdentityAndNoTerminalACK(t *testing.T) {
	f := newFixture(t, task.Codex)
	// Synthetic selected boundary declaration, not current CLI capability proof.
	f.provider.caps.Message = true
	f.provider.caps.Cancel = true
	f.create()
	r := ref(task.Codex, "turn-1", "create-1")
	f.provider.steps = append(f.provider.steps, step{action: task.Message, operation: "message-1", message: "steer", expected: r, reference: r, lifecycle: task.Running}, step{action: task.Cancel, operation: "cancel-1", expected: r, reference: r, lifecycle: task.Running, cancel: true})
	out, err := f.facade.Message(ctx, control.FollowupRequest{OperationID: "message-1", TaskID: "task", Message: "steer"})
	if err != nil || out.Receipt.Reference != outReference(task.Codex) {
		t.Fatalf("message %+v %v", out, err)
	}
	out, err = f.facade.Cancel(ctx, control.CancelRequest{OperationID: "cancel-1", TaskID: "task"})
	if err != nil || !out.Receipt.CancelRequested || out.Receipt.Lifecycle != control.Running {
		t.Fatalf("cancel %+v %v", out, err)
	}
	out, err = f.facade.Cancel(ctx, control.CancelRequest{OperationID: "cancel-1", TaskID: "task"})
	if err != nil || !out.Receipt.CancelRequested || f.provider.effects != 3 {
		t.Fatal("cancel replay resent")
	}
	f.provider.observed = port.Observation{Reference: r, Lifecycle: task.Running}
	result, err := f.facade.Result(ctx, control.TaskRequest{TaskID: "task"})
	if err != nil || result.Retained || result.Lifecycle != control.Running {
		t.Fatalf("ACK falsely terminal %+v %v", result, err)
	}
	if err := f.provider.admission.WithCurrent(ctx, func(b *admission.Binding) error {
		if b != nil {
			t.Fatal("cancel read reactivated owner")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestForeignObservationAndRevokedReadDoNotDiscloseOrSettle(t *testing.T) {
	for _, p := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(p), func(t *testing.T) {
			f := newFixture(t, p)
			f.create()
			f.provider.observed.Reference = ref(p, "foreign-turn", "foreign-invocation")
			if p == task.Claude {
				f.provider.observed.Reference.SessionID = "foreign-session"
			}
			_, err := f.facade.Status(ctx, control.TaskRequest{TaskID: "task"})
			requireFailure(t, err, "TASK_IDENTITY_MISMATCH")
			snap, _ := f.journal.Read(ctx, "task")
			if snap.Task.Lifecycle != task.Running || snap.Task.Result != "" {
				t.Fatal("foreign result persisted")
			}
			f.authority.errorRead = task.ErrState
			_, err = f.facade.Operation(ctx, control.OperationRequest{OperationID: "create-1"})
			requireFailure(t, err, "TASK_STATE_REFUSED")
			_, err = f.facade.Result(ctx, control.TaskRequest{TaskID: "task"})
			requireFailure(t, err, "TASK_STATE_REFUSED")
			if f.provider.effects != 1 || f.provider.reads != 1 {
				t.Fatal("revoked read probed provider")
			}
		})
	}
}

func TestFacadeErrorProjectionAndInvalidRequestsPreserveNoEffect(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		code string
	}{
		{"invalid", task.ErrInvalid, "TASK_INPUT_INVALID"}, {"identity", task.ErrIdentity, "TASK_IDENTITY_MISMATCH"}, {"conflict", task.ErrConflict, "TASK_OPERATION_CONFLICT"}, {"not-found", task.ErrNotFound, "TASK_NOT_FOUND"}, {"unsupported", task.ErrUnsupported, "TASK_CAPABILITY_UNAVAILABLE"}, {"unavailable", task.ErrUnavailable, "TASK_UNAVAILABLE"}, {"refused", task.ErrState, "TASK_STATE_REFUSED"}, {"unknown", task.ErrUnknown, "TASK_OUTCOME_UNKNOWN"}, {"cancelled", context.Canceled, "TASK_REQUEST_CANCELLED"}, {"deadline", context.DeadlineExceeded, "TASK_REQUEST_CANCELLED"}, {"private", errors.New("private credentials and provider details"), "TASK_OUTCOME_UNKNOWN"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t, task.Codex)
			f.authority.resolveErr = test.err
			_, err := f.facade.Resolve(ctx, control.ResolveRequest{Selection: f.createRequest().Selection})
			requireFailure(t, err, test.code)
			if f.provider.effects != 0 {
				t.Fatal("failed resolve executed")
			}
		})
	}
	f := newFixture(t, task.Codex)
	for _, change := range []func(*control.CreateRequest){func(q *control.CreateRequest) { q.Selection.Provider = "other" }, func(q *control.CreateRequest) { q.TaskID = "" }, func(q *control.CreateRequest) { q.OperationID = "" }, func(q *control.CreateRequest) { q.Message = strings.Repeat("x", 32769) }} {
		q := f.createRequest()
		change(&q)
		_, err := f.facade.Create(ctx, q)
		requireFailure(t, err, "TASK_INPUT_INVALID")
	}
	if f.provider.effects != 0 || f.authority.resolves != 0 {
		t.Fatal("invalid request reached provider selection")
	}
	_, err := f.facade.Status(ctx, control.TaskRequest{TaskID: "missing"})
	// Preserve the existing service classification of an unavailable read.
	requireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
	_, err = f.facade.Operation(ctx, control.OperationRequest{OperationID: "missing"})
	requireFailure(t, err, "TASK_NOT_FOUND")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = f.facade.Create(cancelled, f.createRequest())
	requireFailure(t, err, "TASK_REQUEST_CANCELLED")
	if f.provider.effects != 0 {
		t.Fatal("cancelled request executed")
	}
}

func TestRefusedReceiptAndPublicationLossRemainDistinct(t *testing.T) {
	f := newFixture(t, task.Codex)
	f.provider.steps[0].rejection = "private provider diagnostic"
	out := f.create()
	if out.Receipt.State != control.Rejected || out.Receipt.Code != "TASK_PROVIDER_REPORTED" || out.Receipt.Reference != (control.Reference{}) {
		t.Fatalf("raw diagnostic %+v", out)
	}
	replay := f.create()
	if replay.Receipt != out.Receipt || f.provider.effects != 1 {
		t.Fatal("refusal replay invoked provider")
	}
	f = newFixture(t, task.Claude)
	f.journal.failFinish = true
	out = f.create()
	if out.Receipt.State != control.Uncertain || f.provider.effects != 1 {
		t.Fatal("publication loss claimed success")
	}
	op, err := f.facade.Operation(ctx, control.OperationRequest{OperationID: "create-1"})
	if err != nil || op.Receipt.State != control.Uncertain || op.Lineage.InvocationID != "create-1" {
		t.Fatalf("publication reconnect %+v %v", op, err)
	}
	f.create()
	if f.provider.effects != 1 {
		t.Fatal("publication loss replay resent")
	}
}

func TestMissingOwnerAndNilContextNeverPanicOrReachProvider(t *testing.T) {
	_, err := control.New(nil)
	requireFailure(t, err, "TASK_UNAVAILABLE")
	f := newFixture(t, task.Codex)
	calls := func(c *control.Contract) []func(context.Context) error {
		return []func(context.Context) error{
			func(ctx context.Context) error { _, e := c.Resolve(ctx, control.ResolveRequest{}); return e }, func(ctx context.Context) error { _, e := c.Create(ctx, control.CreateRequest{}); return e }, func(ctx context.Context) error { _, e := c.Status(ctx, control.TaskRequest{}); return e }, func(ctx context.Context) error { _, e := c.Result(ctx, control.TaskRequest{}); return e }, func(ctx context.Context) error { _, e := c.Continue(ctx, control.FollowupRequest{}); return e }, func(ctx context.Context) error { _, e := c.Resume(ctx, control.FollowupRequest{}); return e }, func(ctx context.Context) error { _, e := c.Message(ctx, control.FollowupRequest{}); return e }, func(ctx context.Context) error { _, e := c.Cancel(ctx, control.CancelRequest{}); return e }, func(ctx context.Context) error { _, e := c.Operation(ctx, control.OperationRequest{}); return e },
		}
	}
	for _, c := range []*control.Contract{nil, {}} {
		for _, call := range calls(c) {
			requireFailure(t, call(ctx), "TASK_UNAVAILABLE")
		}
	}
	for _, call := range calls(f.facade) {
		requireFailure(t, call(nil), "TASK_INPUT_INVALID")
	}
	if f.provider.effects != 0 || f.authority.resolves != 0 {
		t.Fatal("invalid facade reached boundary")
	}
}

func TestConsumerDTOsAreIndependentAndCannotSelectFollowupExecution(t *testing.T) {
	for _, value := range []any{control.Selection{}, control.Root{}, control.Binding{}, control.Reference{}, control.Parent{}, control.Capabilities{}, control.Receipt{}} {
		if reflect.TypeOf(value).PkgPath() != "github.com/legrch/farol/modules/task/contracts/control" {
			t.Fatalf("exported type alias %T", value)
		}
	}
	for _, value := range []any{control.FollowupRequest{}, control.CancelRequest{}, control.OperationRequest{}, control.TaskRequest{}} {
		ty := reflect.TypeOf(value)
		for _, name := range []string{"Selection", "Model", "Effort", "Provider", "Expected", "Handle", "Root", "Action"} {
			if _, found := ty.FieldByName(name); found {
				t.Fatalf("caller execution override %s", name)
			}
		}
	}
}

func TestDeliveryDispatchMarkerDoesNotInventParentAcknowledgement(t *testing.T) {
	for _, name := range []string{"known", "refused", "lost-ack"} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, task.Codex)
			f.create()
			if _, err := f.facade.Status(ctx, control.TaskRequest{TaskID: "task"}); err != nil {
				t.Fatal(err)
			}
			if f.delivery.calls != 0 {
				t.Fatal("terminal/result automatically delivered")
			}
			f.delivery.refused = name == "refused"
			f.delivery.lostAck = name == "lost-ack"
			if _, err := f.service.Deliver(ctx, tasksvc.DeliverRequest{OperationID: "deliver-1", TaskID: "task"}); err != nil {
				t.Fatal(err)
			}
			status, err := f.facade.Status(ctx, control.TaskRequest{TaskID: "task"})
			if err != nil {
				t.Fatal(err)
			}
			expectedMarker := "create-1"
			expectedState := control.Known
			if name == "refused" {
				expectedState = control.Rejected
			}
			if name == "lost-ack" {
				expectedMarker = ""
				expectedState = control.Uncertain
				if status.PendingOperationID != "deliver-1" {
					t.Fatal("lost parent ACK released fence")
				}
			}
			if status.DeliveryDispatchID != expectedMarker || status.Lifecycle != control.Completed {
				t.Fatalf("marker changed identity or completion %+v", status)
			}
			op, err := f.facade.Operation(ctx, control.OperationRequest{OperationID: "deliver-1"})
			if err != nil || op.Action != control.Deliver || op.Receipt.State != expectedState {
				t.Fatalf("delivery evidence %+v %v", op, err)
			}
			if f.delivery.calls != 1 || f.provider.effects != 1 || f.provider.reads != 1 {
				t.Fatal("read delivered or dispatched again")
			}
		})
	}
}
