package boot

// Shipping facade/service/admission owner are composed here. Only the storage,
// authority and provider ports are scripted; no native or live qualification.
import (
	"context"
	"errors"
	computerprocess "github.com/legrch/farol/modules/computer/contracts/process"
	observationct "github.com/legrch/farol/modules/task/contracts/observation"
	claudeclient "github.com/legrch/farol/modules/task/infra/clients/claude"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/contracts/admission"
	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"

	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

var taskRuntimeTestCtx = context.Background()

// Private one-task in-memory backing port, not a shipping persistence engine.
type taskRuntimeTestMemory struct {
	mu                      sync.Mutex
	snapshot                *port.Snapshot
	ops                     map[string]port.Operation
	failFinish              bool
	eventPublicationUnknown bool
}

func (j *taskRuntimeTestMemory) Lookup(_ context.Context, id string) (*port.Operation, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	out, ok := j.ops[id]
	if !ok {
		return nil, nil
	}
	return &out, nil
}
func (j *taskRuntimeTestMemory) Read(_ context.Context, id string) (*port.Snapshot, error) {
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
func (j *taskRuntimeTestMemory) Admit(_ context.Context, i task.Intent, revision uint64, prepared task.Task) (*port.Admission, error) {
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
func (j *taskRuntimeTestMemory) Progress(_ context.Context, id string, taskRuntimeTestRef task.Reference) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	op, ok := j.ops[id]
	if !ok || j.snapshot.Pending != id || !op.Lineage.Extend(taskRuntimeTestRef, op.Intent.Binding.Provider) {
		return task.ErrIdentity
	}
	op.Lineage = taskRuntimeTestRef
	j.ops[id] = op
	return nil
}
func (j *taskRuntimeTestMemory) Finish(_ context.Context, id string, r task.Receipt, next task.Task) error {
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
func (j *taskRuntimeTestMemory) Observe(_ context.Context, before port.Snapshot, next task.Task) error {
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
func (j *taskRuntimeTestMemory) Invalidate(_ context.Context, before port.Snapshot) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if *j.snapshot != before {
		return task.ErrConflict
	}
	j.snapshot.Task.Admission.State = task.AdmissionRevoked
	j.snapshot.Revision++
	return nil
}

type taskRuntimeTestAuthority struct {
	binding               task.Binding
	resolves              int
	resolveErr, errorRead error
}

func (a *taskRuntimeTestAuthority) Resolve(_ context.Context, q port.Selection) (task.Binding, error) {
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
func (a *taskRuntimeTestAuthority) Recheck(_ context.Context, b task.Binding) error {
	if a.errorRead != nil {
		return a.errorRead
	}
	if b != a.binding {
		return task.ErrIdentity
	}
	return nil
}
func (*taskRuntimeTestAuthority) RecheckParent(_ context.Context, p task.Parent) error {
	if p != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) {
		return task.ErrIdentity
	}
	return nil
}

type taskRuntimeTestStep struct {
	action              task.Action
	operation, message  string
	expected, reference task.Reference
	lifecycle           task.Lifecycle
	cancel, lostAck     bool
	rejection           string
}
type taskRuntimeTestBoundary struct {
	t                        *testing.T
	binding                  task.Binding
	caps                     task.Capabilities
	steps                    []taskRuntimeTestStep
	effects, reads, supports int
	admission                *admission.Contract
	observed                 port.Observation
}

func (p *taskRuntimeTestBoundary) Supports(_ context.Context, b task.Binding) (task.Capabilities, error) {
	p.supports++
	if b != p.binding {
		p.t.Fatal("Supports changed immutable binding")
	}
	return p.caps, nil
}
func (p *taskRuntimeTestBoundary) Dispatch(c context.Context, d port.Dispatch, record func(task.Reference) error) (task.Receipt, error) {
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
func (p *taskRuntimeTestBoundary) Observe(_ context.Context, b task.Binding, r task.Reference) (port.Observation, error) {
	p.reads++
	if b != p.binding || len(p.steps) == 0 || r != p.steps[p.effects-1].reference {
		p.t.Fatal("observation substituted model/session/turn")
	}
	return p.observed, nil
}

// Delivery is an independent parent boundary, exercised only by an explicit
// existing Service.Deliver call; facade reads must never call this script.
type taskRuntimeTestDeliveryBoundary struct {
	t                *testing.T
	reference        task.Reference
	calls            int
	refused, lostAck bool
}

func (d *taskRuntimeTestDeliveryBoundary) Send(_ context.Context, p task.Parent, op string, r task.Reference, text string) (task.Receipt, error) {
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

type taskRuntimeTestFixture struct {
	t                        *testing.T
	journal                  *taskRuntimeTestMemory
	taskRuntimeTestAuthority *taskRuntimeTestAuthority
	owner                    *taskrepo.Owner
	delivery                 *taskRuntimeTestDeliveryBoundary
	provider                 *taskRuntimeTestBoundary
	service                  *tasksvc.Service
	facade                   *control.Contract
	runtime                  *TaskRuntime
	route                    *taskrepo.Route
}

func taskRuntimeTestRef(p task.Provider, turn, op string) task.Reference {
	if p == task.Codex {
		return task.Reference{ThreadID: "thread-exact", TurnID: turn}
	}
	return task.Reference{SessionID: "claude-session-exact", InvocationID: op}
}
func taskRuntimeTestNewFixture(t *testing.T, p task.Provider) *taskRuntimeTestFixture {
	t.Helper()
	b := task.Binding{Provider: p, ProfileID: "profile", HostID: "selected-host", ProjectID: "saved-project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "2", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "3", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "selected-alias", Model: "selected-runtime-model", Effort: "high", ConfigDigest: "config-A"}
	j := &taskRuntimeTestMemory{ops: map[string]port.Operation{}}
	owner, err := taskrepo.New(j, "task")
	if err != nil {
		t.Fatal(err)
	}
	initial := taskRuntimeTestRef(p, "turn-1", "create-1")
	f := &taskRuntimeTestFixture{t: t, journal: j, taskRuntimeTestAuthority: &taskRuntimeTestAuthority{binding: b}, owner: owner, provider: &taskRuntimeTestBoundary{t: t, binding: b, caps: task.Capabilities{Create: true, Continue: p == task.Codex, Resume: p == task.Claude}, steps: []taskRuntimeTestStep{{action: task.Create, operation: "create-1", message: "initial", reference: initial, lifecycle: task.Running}}, observed: port.Observation{Reference: initial, Lifecycle: task.Completed, Result: "retained result"}}}
	f.delivery = &taskRuntimeTestDeliveryBoundary{t: t, reference: initial}
	f.selectRoute(1)
	return f
}
func (f *taskRuntimeTestFixture) selectRoute(epoch uint64) {
	f.t.Helper()
	route, err := f.owner.Select(port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task", TaskEpoch: epoch, ParticipantID: "participant", TurnID: "farol-turn-" + strconv.FormatUint(epoch, 10)})
	if err != nil {
		f.t.Fatal(err)
	}
	f.route = route
	f.runtime, err = taskRuntime(TaskRuntimeInputs{Route: route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority, Delivery: f.delivery}, f.provider)
	if err != nil {
		f.t.Fatal(err)
	}
	f.provider.admission = f.runtime.Admission()
	f.service = f.runtime.service
	f.facade = f.runtime.Control()
}
func (f *taskRuntimeTestFixture) createRequest() control.CreateRequest {
	b := f.taskRuntimeTestAuthority.binding
	return control.CreateRequest{OperationID: "create-1", TaskID: "task", Message: "initial", Selection: control.Selection{Provider: control.Provider(b.Provider), ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, ModelAlias: b.ModelAlias, Effort: b.Effort}, Parent: control.Parent{ThreadID: "parent", TurnID: "parent-turn"}}
}
func (f *taskRuntimeTestFixture) create() *control.MutationResponse {
	f.t.Helper()
	out, err := f.facade.Create(taskRuntimeTestCtx, f.createRequest())
	if err != nil {
		f.t.Fatal(err)
	}
	return out
}
func taskRuntimeTestRequireFailure(t *testing.T, err error, code string) {
	t.Helper()
	var e *control.Failure
	if !errors.As(err, &e) || e.Code != code || err.Error() != code {
		t.Fatalf("failure %v, want %s", err, code)
	}
}

func TestTaskRuntimeSameOwnerFacadesAndExactFollowup(t *testing.T) {
	for _, p := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(p), func(t *testing.T) {
			f := taskRuntimeTestNewFixture(t, p)
			resolved, err := f.facade.Resolve(taskRuntimeTestCtx, control.ResolveRequest{Selection: f.createRequest().Selection})
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
			if err := f.provider.admission.WithCurrent(taskRuntimeTestCtx, func(b *admission.Binding) error {
				if b == nil || b.TaskEpoch != 1 {
					t.Fatal("create not active in same owner")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			created.Receipt.Reference.SessionID = "caller mutation"
			status, err := f.facade.Status(taskRuntimeTestCtx, control.TaskRequest{TaskID: "task"})
			if err != nil {
				t.Fatal(err)
			}
			if status.Lifecycle != control.Completed || status.Binding.Model != "selected-runtime-model" || status.Parent.ThreadID != "parent" || status.DispatchID != "create-1" || status.DeliveryDispatchID != "" {
				t.Fatalf("wrong status %+v", status)
			}
			result, err := f.facade.Result(taskRuntimeTestCtx, control.TaskRequest{TaskID: "task"})
			if err != nil || !result.Retained || result.Text != "retained result" || result.Reference != status.Reference || result.DispatchID != "create-1" {
				t.Fatalf("wrong result %+v %v", result, err)
			}
			if err := f.provider.admission.WithCurrent(taskRuntimeTestCtx, func(b *admission.Binding) error {
				if b != nil {
					t.Fatal("terminal falsely retains active admission")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			retained, readErr := f.runtime.Observation().Read(taskRuntimeTestCtx, observationct.Request{TaskID: "task", DispatchID: "create-1", Limit: 1, IncludeResult: true})
			if readErr != nil || !retained.Retained || retained.Result != "retained result" || retained.ResultEvidence != "task_journal" || retained.Delivery != "not_observed" {
				t.Fatalf("normal observation %+v %v", retained, readErr)
			}
			if f.delivery.calls != 0 {
				t.Fatal("factory/facade auto-delivered result")
			}
			oldFacade := f.facade
			beforeResolves := f.taskRuntimeTestAuthority.resolves
			beforeSupports := f.provider.supports
			reconnected, err := control.New(f.service)
			if err != nil {
				t.Fatal(err)
			}
			old, err := reconnected.Operation(taskRuntimeTestCtx, control.OperationRequest{OperationID: "create-1"})
			if err != nil || old.Receipt.Result != "retained result" || old.Action != control.Create {
				t.Fatalf("wrong reconnect %+v %v", old, err)
			}
			if f.provider.effects != 1 || f.provider.reads != 1 || f.taskRuntimeTestAuthority.resolves != beforeResolves || f.provider.supports != beforeSupports {
				t.Fatal("reconnect performed provider work")
			}
			previous := taskRuntimeTestRef(p, "turn-1", "create-1")
			next := taskRuntimeTestRef(p, "turn-2", "follow-2")
			action := task.Continue
			if p == task.Claude {
				action = task.Resume
			}
			f.provider.steps = append(f.provider.steps, taskRuntimeTestStep{action: action, operation: "follow-2", message: "follow-up", expected: previous, reference: next, lifecycle: task.Running})
			f.selectRoute(2)
			req := control.FollowupRequest{OperationID: "follow-2", TaskID: "task", Message: "follow-up"}
			var followed *control.MutationResponse
			if p == task.Codex {
				followed, err = f.facade.Continue(taskRuntimeTestCtx, req)
			} else {
				followed, err = f.facade.Resume(taskRuntimeTestCtx, req)
			}
			if err != nil || followed.Receipt.State != control.Known || followed.Receipt.Reference == status.Reference || f.provider.effects != 2 || f.taskRuntimeTestAuthority.resolves != beforeResolves {
				t.Fatalf("follow-up %+v %v", followed, err)
			}
			prior, readErr := f.runtime.Observation().Read(taskRuntimeTestCtx, observationct.Request{TaskID: "task", DispatchID: "create-1", Limit: 1, IncludeResult: true})
			if readErr != nil || !prior.Retained || prior.Result != "retained result" || prior.Reference.TurnID != status.Reference.TurnID || prior.Reference.SessionID != status.Reference.SessionID {
				t.Fatalf("old retained observation %+v %v", prior, readErr)
			}
			historical, err := oldFacade.Operation(taskRuntimeTestCtx, control.OperationRequest{OperationID: "create-1"})
			if err != nil || historical.Receipt.Result != "retained result" || historical.Receipt.Reference != status.Reference {
				t.Fatalf("old result overwritten %+v %v", historical, err)
			}
		})
	}
}

func TestTaskRuntimeUnknownReconnectNeverDispatchesOrReselects(t *testing.T) {
	for _, p := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(p), func(t *testing.T) {
			f := taskRuntimeTestNewFixture(t, p)
			f.provider.steps[0].lostAck = true
			out := f.create()
			if out.Receipt.State != control.Uncertain {
				t.Fatalf("unknown %+v", out)
			}
			resolves, supports := f.taskRuntimeTestAuthority.resolves, f.provider.supports
			// Recompose the service/facades on the SAME existing owner and store.
			var err error
			f.selectRoute(1) // same original Owner/Route; no new journal or admission engine
			f.facade, err = control.New(f.service)
			if err != nil {
				t.Fatal(err)
			}
			replay := f.create()
			if replay.Receipt.State != control.Uncertain {
				t.Fatal("replay changed unknown")
			}
			op, err := f.facade.Operation(taskRuntimeTestCtx, control.OperationRequest{OperationID: "create-1"})
			if err != nil || op.Receipt.State != control.Uncertain || op.Lineage.SessionID != taskRuntimeTestOutReference(p).SessionID || op.Lineage.ThreadID != taskRuntimeTestOutReference(p).ThreadID {
				t.Fatalf("lost lineage %+v %v", op, err)
			}
			status, err := f.facade.Status(taskRuntimeTestCtx, control.TaskRequest{TaskID: "task"})
			if err != nil || status.PendingOperationID != "create-1" || status.Lifecycle != control.Unknown {
				t.Fatalf("pending %+v %v", status, err)
			}
			_, err = f.facade.Result(taskRuntimeTestCtx, control.TaskRequest{TaskID: "task"})
			taskRuntimeTestRequireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
			changed := f.createRequest()
			changed.Selection.ModelAlias = "new-model"
			_, err = f.facade.Create(taskRuntimeTestCtx, changed)
			taskRuntimeTestRequireFailure(t, err, "TASK_OPERATION_CONFLICT")
			for _, controlCall := range []func(context.Context, control.FollowupRequest) (*control.MutationResponse, error){f.facade.Continue, f.facade.Resume, f.facade.Message} {
				_, err = controlCall(taskRuntimeTestCtx, control.FollowupRequest{OperationID: "different-op", TaskID: "task", Message: "attempt"})
				taskRuntimeTestRequireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
			}
			_, err = f.facade.Cancel(taskRuntimeTestCtx, control.CancelRequest{OperationID: "cancel", TaskID: "task"})
			taskRuntimeTestRequireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
			if f.provider.effects != 1 || f.provider.reads != 0 || f.taskRuntimeTestAuthority.resolves != resolves || f.provider.supports != supports {
				t.Fatal("unknown caused extra provider call or resolve")
			}
			retained, readErr := f.runtime.Observation().Read(taskRuntimeTestCtx, observationct.Request{TaskID: "task", DispatchID: "create-1", Limit: 1, IncludeResult: true})
			if readErr != nil || !retained.Pending || retained.Retained || retained.Result != "" {
				t.Fatalf("unknown read fabricated result %+v %v", retained, readErr)
			}
			fresh := f.createRequest()
			fresh.OperationID = "new-key"
			_, err = f.facade.Create(taskRuntimeTestCtx, fresh)
			taskRuntimeTestRequireFailure(t, err, "TASK_OUTCOME_UNKNOWN")
			if f.provider.effects != 1 {
				t.Fatal("new key bypassed owner unknown fence")
			}
		})
	}
}
func taskRuntimeTestOutReference(p task.Provider) control.Reference {
	r := taskRuntimeTestRef(p, "turn-1", "create-1")
	return control.Reference{SessionID: r.SessionID, ThreadID: r.ThreadID, TurnID: r.TurnID, InvocationID: r.InvocationID}
}

func TestTaskRuntimeCapturedSelectionCannotChangeOrAcquireAnotherProvider(t *testing.T) {
	f := taskRuntimeTestNewFixture(t, task.Codex)
	f.taskRuntimeTestAuthority.binding.Model = "different-model"
	_, err := f.facade.Resolve(taskRuntimeTestCtx, control.ResolveRequest{Selection: f.createRequest().Selection})
	taskRuntimeTestRequireFailure(t, err, "TASK_IDENTITY_MISMATCH")
	if f.provider.effects != 0 || f.provider.supports != 0 {
		t.Fatal("changed model reached provider")
	}
	f = taskRuntimeTestNewFixture(t, task.Codex)
	q := f.createRequest()
	q.Selection.Provider = control.Claude
	_, err = f.facade.Create(taskRuntimeTestCtx, q)
	taskRuntimeTestRequireFailure(t, err, "TASK_UNAVAILABLE")
	if f.provider.effects != 0 {
		t.Fatal("factory switched executor")
	}
}

type noLaunchBoundary struct{ calls int }

func (b *noLaunchBoundary) Verify(context.Context, codexclient.Selection) error {
	b.calls++
	return errors.New("native inspection forbidden in source constructor")
}
func (b *noLaunchBoundary) Launch(context.Context, codexclient.Selection) (codexclient.Process, error) {
	b.calls++
	return nil, errors.New("native launch forbidden in source constructor")
}

func runtimeFailure(t *testing.T, err error, code string) {
	t.Helper()
	var f *TaskRuntimeFailure
	if !errors.As(err, &f) || f.Code != code || err.Error() != code {
		t.Fatalf("runtime error %v want %s", err, code)
	}
}
func TestTaskRuntimeProductionConstructorIsLazyAndUsesConcreteCodex(t *testing.T) {
	f := taskRuntimeTestNewFixture(t, task.Codex)
	native := &noLaunchBoundary{}
	now := time.Unix(1900000000, 0)
	client, err := codexclient.New(codexclient.Options{Selection: codexclient.Selection{Binding: f.taskRuntimeTestAuthority.binding, ExecutablePath: "/fixture/codex", ExecutableSHA256: strings.Repeat("a", 64), SocketPath: "/fixture/socket", ExpectedCodexHome: "/fixture/home", ScratchRoot: "/fixture/scratch", Protocol: "codex-app-server/v2", SchemaSHA256: strings.Repeat("b", 64), Sandbox: "read-only", ApprovalPolicy: "never", GrantedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour)}, Boundary: native, Now: func() time.Time { return now }, Recheck: f.taskRuntimeTestAuthority.Recheck})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close(taskRuntimeTestCtx)
	r, err := NewTaskRuntime(TaskRuntimeInputs{Route: f.route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority, Codex: client})
	if err != nil || r.Control() == nil || r.Admission() == nil || r.Observation() == nil {
		t.Fatalf("composition %+v %v", r, err)
	}
	if err := r.Admission().WithCurrent(taskRuntimeTestCtx, func(b *admission.Binding) error {
		if b != nil {
			t.Fatal("factory issued admission")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if native.calls != 0 || f.taskRuntimeTestAuthority.resolves != 0 || f.provider.effects != 0 {
		t.Fatal("factory performed native/provider work")
	}
	if _, err := r.Control().Operation(taskRuntimeTestCtx, control.OperationRequest{OperationID: "missing"}); err == nil {
		t.Fatal("constructed fake operation")
	}
	if native.calls != 0 {
		t.Fatal("reconnect launched real client")
	}
	// The concrete client still checks its own original model identity before
	// any native boundary access; Root does not convert another binding into it.
	f.taskRuntimeTestAuthority.binding.Model = "another-model"
	mismatch, err := NewTaskRuntime(TaskRuntimeInputs{Route: f.route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority, Codex: client})
	if err != nil {
		t.Fatal(err)
	}
	_, err = mismatch.Control().Resolve(taskRuntimeTestCtx, control.ResolveRequest{Selection: f.createRequest().Selection})
	taskRuntimeTestRequireFailure(t, err, "TASK_IDENTITY_MISMATCH")
	if native.calls != 0 {
		t.Fatal("mismatched concrete client reached native boundary")
	}
}

func TestTaskRuntimeProductionMissingPrerequisitesNeverEnableClaude(t *testing.T) {
	f := taskRuntimeTestNewFixture(t, task.Claude)
	in := TaskRuntimeInputs{Route: f.route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority}
	_, err := NewTaskRuntime(TaskRuntimeInputs{})
	runtimeFailure(t, err, "TASK_RUNTIME_OWNER_UNAVAILABLE")
	invalid := in
	invalid.Route = &taskrepo.Route{}
	_, err = NewTaskRuntime(invalid)
	runtimeFailure(t, err, "TASK_RUNTIME_INPUT_INVALID")
	invalid = in
	invalid.Authority = nil
	_, err = NewTaskRuntime(invalid)
	runtimeFailure(t, err, "TASK_RUNTIME_AUTHORITY_UNAVAILABLE")
	var typedNil *taskRuntimeTestAuthority
	invalid = in
	invalid.Authority = typedNil
	_, err = NewTaskRuntime(invalid)
	runtimeFailure(t, err, "TASK_RUNTIME_AUTHORITY_UNAVAILABLE")
	_, err = NewTaskRuntime(in)
	runtimeFailure(t, err, "TASK_RUNTIME_CLAUDE_SELECTION_UNAVAILABLE")
	b := f.route.Selection()
	scope := task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
	in.Claude = &ClaudeTaskInputs{OperationID: "create-1", Selection: claudeclient.Selection{Binding: in.Binding, Scope: scope, RuntimeID: "claude-runtime", AdmissionID: "selected-admission", SessionID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ReportedModel: "selected-reported-model", Efforts: []claudeclient.EffortMapping{{Requested: "high", Argument: "high"}}}}
	_, err = NewTaskRuntime(in)
	runtimeFailure(t, err, "TASK_RUNTIME_COMPUTER_PROCESS_UNAVAILABLE")
	// A present but unqualified public contract cannot replace a real native
	// ClaudeHost. No process method is invoked on this deliberately empty value.
	in.Claude.Computer = new(computerprocess.Contract)
	_, err = NewTaskRuntime(in)
	runtimeFailure(t, err, "TASK_RUNTIME_CLAUDE_HOST_UNAVAILABLE")
	in.Claude.Selection.Scope.TaskEpoch++
	_, err = NewTaskRuntime(in)
	runtimeFailure(t, err, "TASK_RUNTIME_IDENTITY_MISMATCH")
	if f.provider.effects != 0 || f.provider.reads != 0 || f.taskRuntimeTestAuthority.resolves != 0 {
		t.Fatal("unavailable native prerequisites produced work")
	}
	f = taskRuntimeTestNewFixture(t, task.Codex)
	_, err = NewTaskRuntime(TaskRuntimeInputs{Route: f.route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority})
	runtimeFailure(t, err, "TASK_RUNTIME_CODEX_ADAPTER_UNAVAILABLE")
	_, err = taskRuntime(TaskRuntimeInputs{Route: f.route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority}, nil)
	runtimeFailure(t, err, "TASK_RUNTIME_PROVIDER_UNAVAILABLE")
	var absent *TaskRuntime
	if absent.Control() != nil || absent.Admission() != nil || absent.Observation() != nil {
		t.Fatal("nil runtime fabricated a facade")
	}
}
