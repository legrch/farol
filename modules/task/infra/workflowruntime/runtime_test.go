//go:build darwin || linux

package workflowruntime

// The real Task filesystem/lease, Owner, NewOwned service, published facade and
// Workflow runtime are composed here. Selected authority, parent and provider IO
// are controlled. Linux PASS does not qualify Darwin locking or live providers.
import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	taskservice "github.com/legrch/farol/modules/task/app/services/task"
	workflow "github.com/legrch/farol/modules/task/app/services/workflow"
	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	progress "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
	"golang.org/x/sys/unix"
)

var runtimeCtx = context.Background()

type runtimeAuthority struct {
	binding   task.Binding
	parentErr error
}

func (a *runtimeAuthority) Resolve(_ context.Context, s port.Selection) (task.Binding, error) {
	if s.Provider != a.binding.Provider || s.ProjectID != a.binding.ProjectID || s.WorkspaceID != a.binding.WorkspaceID || s.ModelAlias != a.binding.ModelAlias || s.Effort != a.binding.Effort {
		return task.Binding{}, task.ErrIdentity
	}
	return a.binding, nil
}
func (a *runtimeAuthority) Recheck(_ context.Context, b task.Binding) error {
	if b != a.binding {
		return task.ErrIdentity
	}
	return nil
}
func (a *runtimeAuthority) RecheckParent(_ context.Context, p task.Parent) error {
	if p != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) {
		return task.ErrIdentity
	}
	return a.parentErr
}

type runtimeProvider struct {
	mu                sync.Mutex
	effects, observes int
	unknown           bool
	terminal          bool
	cancelControlled  bool
}

func (p *runtimeProvider) Supports(context.Context, task.Binding) (task.Capabilities, error) {
	return task.Capabilities{Create: true, Continue: true, Cancel: p.cancelControlled}, nil
}
func (p *runtimeProvider) Dispatch(_ context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.effects++
	ref := task.Reference{ThreadID: "provider-" + d.Intent.TaskID, TurnID: d.Intent.OperationID}
	if d.Intent.Action == task.Cancel {
		ref = d.Intent.Expected
	}
	if err := progress(ref); err != nil {
		return task.Receipt{}, err
	}
	if p.unknown {
		return task.Receipt{}, errors.New("controlled lost provider ACK")
	}
	return task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running, CancelRequested: d.Intent.Action == task.Cancel}, nil
}
func (p *runtimeProvider) Observe(_ context.Context, _ task.Binding, ref task.Reference) (port.Observation, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.observes++
	if p.terminal {
		return port.Observation{Reference: ref, Lifecycle: task.Completed, Result: "accepted output"}, nil
	}
	return port.Observation{Reference: ref, Lifecycle: task.Running}, nil
}
func (p *runtimeProvider) count() int { p.mu.Lock(); defer p.mu.Unlock(); return p.effects }

type runtimeDelivery struct {
	calls   int
	unknown bool
}

func (d *runtimeDelivery) Send(_ context.Context, _ task.Parent, _ string, ref task.Reference, _ string) (task.Receipt, error) {
	d.calls++
	if d.unknown {
		return task.Receipt{}, errors.New("controlled lost parent ACK")
	}
	return task.Receipt{State: task.Known, Reference: ref}, nil
}

type runtimeRoutes struct {
	original, selected map[string]*control.Contract
	resolve            *control.Contract
	missing            bool
}

func (r *runtimeRoutes) Original(_ context.Context, taskID, _ string) (*control.Contract, error) {
	if r.missing {
		return nil, workflow.ErrUnavailable
	}
	return r.original[taskID], nil
}
func (r *runtimeRoutes) Selected(_ context.Context, taskID string) (*control.Contract, error) {
	return r.selected[taskID], nil
}
func (r *runtimeRoutes) Resolve(ctx context.Context, s workflow.Selection) (*control.ResolveResponse, error) {
	return r.resolve.Resolve(ctx, control.ResolveRequest{Selection: selection(s)})
}

type runtimeComposer struct {
	selected workflow.Selection
	calls    int
}

func (c *runtimeComposer) Compose(_ context.Context, _ wf.Step, _ map[string]string) (workflow.Selection, string, error) {
	c.calls++
	return c.selected, "controlled instruction", nil
}

type runtimeParent struct {
	mu              sync.Mutex
	calls           int
	closeAfterFirst bool
	err             error
}

func (p *runtimeParent) Recheck(_ context.Context, parent wf.Parent) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	if parent != (wf.Parent{ThreadID: "parent", TurnID: "parent-turn"}) {
		return workflow.ErrIdentity
	}
	if p.closeAfterFirst && p.calls > 1 {
		return workflow.ErrState
	}
	return p.err
}

type runtimeFixture struct {
	root      taskrepo.FilesystemRoot
	store     *taskrepo.Filesystem
	routes    *runtimeRoutes
	tasks     *Tasks
	provider  *runtimeProvider
	delivery  *runtimeDelivery
	authority *runtimeAuthority
	parent    *runtimeParent
	composer  *runtimeComposer
	runtime   *Runtime
	owners    map[string]*taskrepo.Owner
}

func runtimeNewFixture(t *testing.T, capacity int, taskIDs ...string) *runtimeFixture {
	t.Helper()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err != nil {
		t.Fatal(err)
	}
	root := taskrepo.FilesystemRoot{ProfileID: "dev", Path: path, Device: uint64(st.Dev), Inode: uint64(st.Ino)}
	store, err := taskrepo.OpenFilesystem(root)
	if err != nil {
		t.Fatal(err)
	}
	f := &runtimeFixture{root: root, store: store, owners: map[string]*taskrepo.Owner{}, routes: &runtimeRoutes{original: map[string]*control.Contract{}, selected: map[string]*control.Contract{}}, provider: &runtimeProvider{}, delivery: &runtimeDelivery{}, parent: &runtimeParent{}}
	f.authority = &runtimeAuthority{binding: task.Binding{Provider: task.Codex, ProfileID: "dev", HostID: "host", ProjectID: "project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "2", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "3", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "selected", Model: "selected-model", Effort: "high", ConfigDigest: "config"}}
	f.composer = &runtimeComposer{selected: workflow.Selection{Provider: "codex", ProjectID: "project", WorkspaceID: "writer", ModelAlias: "selected", Effort: "high"}}
	for _, id := range taskIDs {
		f.addTask(t, id, store)
	}
	f.tasks, err = NewTasks(f.routes)
	if err != nil {
		t.Fatal(err)
	}
	f.runtime, err = New(store, f.tasks, f.composer, f.parent, capacity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if f.store != nil {
			if e := f.store.Close(); e != nil {
				t.Error(e)
			}
		}
	})
	return f
}
func (f *runtimeFixture) addTask(t *testing.T, id string, store *taskrepo.Filesystem) {
	t.Helper()
	owner, err := taskrepo.New(store, id)
	if err != nil {
		t.Fatal(err)
	}
	f.owners[id] = owner
	route, err := owner.Select(port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session-" + id, TaskID: id, TaskEpoch: 1, ParticipantID: "participant-" + id, TurnID: "farol-turn-" + id})
	if err != nil {
		t.Fatal(err)
	}
	s, err := taskservice.NewOwned(route, f.authority, map[task.Provider]port.Provider{task.Codex: f.provider}, f.delivery, intent.Fingerprint, progress.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	facade, err := control.New(s)
	if err != nil {
		t.Fatal(err)
	}
	f.routes.original[id], f.routes.selected[id] = facade, facade
	f.routes.resolve = facade
}
func runtimePlan(id, taskID string) wf.Plan {
	return wf.Plan{ID: id, Parent: wf.Parent{ThreadID: "parent", TurnID: "parent-turn"}, Steps: []wf.Step{{ID: taskID, TaskID: taskID, OperationID: taskID + "-create", CancelOperationID: taskID + "-cancel", DeliveryOperationID: taskID + "-deliver", Required: []wf.Capability{wf.CapabilityCreate}, Output: wf.Output{Kind: wf.OutputText, MaxBytes: 1024}}}}
}
func runtimeBudget(capacity int) wf.Budget {
	return wf.Budget{Slots: capacity, Available: map[wf.Capability]bool{wf.CapabilityCreate: true}}
}

func TestRuntimeRealTaskActivationReconnectAndIndependentParentDelivery(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child")
	p := runtimePlan("workflow", "child")
	r, err := f.runtime.Activate(runtimeCtx, p, runtimeBudget(1))
	if err != nil || len(r.Started) != 1 || r.Steps[0].State != wf.Running || f.provider.count() != 1 {
		t.Fatal(r, err)
	}
	if f.parent.calls != 2 {
		t.Fatal("original parent must be rechecked after reservation", f.parent.calls)
	}
	f.provider.terminal = true
	r, err = f.runtime.Reconnect(runtimeCtx, p.ID, runtimeBudget(1))
	if err != nil || !r.Steps[0].Accepted || r.Steps[0].Delivery != workflow.DeliveryPending || f.delivery.calls != 0 {
		t.Fatal(r, err)
	}
	r, err = f.runtime.Deliver(runtimeCtx, p.ID)
	if err != nil || r.Steps[0].Delivery != workflow.DeliveryAcknowledged || f.delivery.calls != 1 {
		t.Fatal(r, err)
	}
	r, err = f.runtime.Deliver(runtimeCtx, p.ID)
	if err != nil || r.Steps[0].Delivery != workflow.DeliveryAcknowledged || f.delivery.calls != 1 {
		t.Fatal("parent ACK replayed", r, err)
	}
}
func TestRuntimePersistedPlanReconnectCannotDispatchAfterRealStoreReopen(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child")
	p := runtimePlan("workflow", "child")
	if _, err := f.store.SaveWorkflow(runtimeCtx, p, 1); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	f.store = nil
	store, err := taskrepo.OpenFilesystem(f.root)
	if err != nil {
		t.Fatal(err)
	}
	f.store = store
	f.addTask(t, "child", store)
	f.runtime, err = New(store, f.tasks, f.composer, f.parent, 1)
	if err != nil {
		t.Fatal(err)
	}
	r, err := f.runtime.Reconnect(runtimeCtx, p.ID, runtimeBudget(1))
	if err != nil || len(r.Started) != 0 || r.Steps[0].State != wf.Unknown || f.provider.count() != 0 || f.parent.calls != 0 {
		t.Fatal(r, err)
	}
}
func TestRuntimeLostProviderACKAndOriginalReservationRemainUnknownNoReplay(t *testing.T) {
	for _, mode := range []string{"provider-ack", "parent-closed-after-reservation"} {
		t.Run(mode, func(t *testing.T) {
			f := runtimeNewFixture(t, 1, "child", "other")
			p := runtimePlan("workflow", "child")
			if mode == "provider-ack" {
				f.provider.unknown = true
			} else {
				f.parent.closeAfterFirst = true
			}
			r, err := f.runtime.Activate(runtimeCtx, p, runtimeBudget(1))
			if err != nil {
				t.Fatal(r, err)
			}
			effects := f.provider.count()
			r, err = f.runtime.Activate(runtimeCtx, p, runtimeBudget(1))
			if err != nil || r.Steps[0].State != wf.Unknown || len(r.Started) != 0 || f.provider.count() != effects {
				t.Fatal("unknown original callback replayed", r, err)
			}
			f.parent.closeAfterFirst = false
			f.provider.unknown = false
			r, err = f.runtime.Activate(runtimeCtx, runtimePlan("other-workflow", "other"), runtimeBudget(1))
			if err != nil || len(r.Started) != 0 || f.provider.count() != effects {
				t.Fatal("unknown occupancy was released", r, err)
			}
		})
	}
}
func TestRuntimeCapacityAcrossIndependentCallsAndOrdinaryTaskFacade(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child", "ordinary")
	if _, err := f.store.SaveWorkflow(runtimeCtx, runtimePlan("workflow", "child"), 1); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	started := 0
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		r, e := f.runtime.Activate(runtimeCtx, runtimePlan("workflow", "child"), runtimeBudget(1))
		if e != nil {
			t.Error(e)
			return
		}
		if len(r.Started) > 0 {
			mu.Lock()
			started++
			mu.Unlock()
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		out, e := f.tasks.Create(runtimeCtx, workflow.Launch{TaskID: "ordinary", OperationID: "ordinary-create", Message: "controlled instruction", Selection: f.composer.selected, Parent: wf.Parent{ThreadID: "parent", TurnID: "parent-turn"}})
		if e == nil && out.State == workflow.Known {
			mu.Lock()
			started++
			mu.Unlock()
		}
	}()
	close(start)
	wg.Wait()
	if started != 1 || f.provider.count() != 1 {
		t.Fatal("workflow/normal Task oversubscribed", started, f.provider.count())
	}
}
func TestRuntimeUnsupportedCancelAndLostParentACKDoNotUpgradeUnknown(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child")
	p := runtimePlan("workflow", "child")
	if _, err := f.runtime.Activate(runtimeCtx, p, runtimeBudget(1)); err != nil {
		t.Fatal(err)
	}
	r, err := f.runtime.Cancel(runtimeCtx, p.ID)
	if err != nil || r.Steps[0].CancelRequested || f.provider.count() != 1 {
		t.Fatal("invented production Cancel support", r, err)
	}
	f.provider.terminal = true
	f.delivery.unknown = true
	r, err = f.runtime.Deliver(runtimeCtx, p.ID)
	if err != nil || r.Steps[0].Delivery != workflow.DeliveryUnknown || f.delivery.calls != 1 {
		t.Fatal(r, err)
	}
	r, err = f.runtime.Deliver(runtimeCtx, p.ID)
	if err != nil || r.Steps[0].Delivery != workflow.DeliveryUnknown || f.delivery.calls != 1 {
		t.Fatal("unknown delivery replayed", r, err)
	}
}
func TestTasksReadClassifiedAbsenceAndUnavailableRouteStayDistinct(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child")
	r, err := f.tasks.Read(runtimeCtx, "child", "child-create")
	if err != nil || r.Found {
		t.Fatal(r, err)
	}
	f.routes.missing = true
	if _, err = f.tasks.Read(runtimeCtx, "child", "child-create"); !errors.Is(err, workflow.ErrUnavailable) {
		t.Fatal("unavailable became absent", err)
	}
	if _, err = f.tasks.Read(nil, "child", "child-create"); !errors.Is(err, workflow.ErrInvalid) {
		t.Fatal(err)
	}
}

func TestRuntimeParentClosureAfterReservationHasImmediateUnknownProjection(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child")
	f.parent.closeAfterFirst = true
	r, err := f.runtime.Activate(runtimeCtx, runtimePlan("workflow", "child"), runtimeBudget(1))
	if err != nil || r.Steps[0].State != wf.Unknown || f.provider.count() != 0 {
		t.Fatalf("consumed original callback was reported known unavailable: %+v %v", r, err)
	}
}
func TestRuntimeParentRefusedBeforeReservationConsumesNoSlot(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child", "other")
	f.parent.err = workflow.ErrState
	r, err := f.runtime.Activate(runtimeCtx, runtimePlan("workflow", "child"), runtimeBudget(1))
	if err != nil || r.Steps[0].State != wf.Unavailable || f.provider.count() != 0 {
		t.Fatal(r, err)
	}
	if _, err := f.store.ReadWorkflowReservation(runtimeCtx, "child-create"); !errors.Is(err, task.ErrNotFound) {
		t.Fatal("known parent refusal reserved", err)
	}
	f.parent.err = nil
	r, err = f.runtime.Activate(runtimeCtx, runtimePlan("other-workflow", "other"), runtimeBudget(1))
	if err != nil || len(r.Started) != 1 || f.provider.count() != 1 {
		t.Fatal("known no-write refusal consumed capacity", r, err)
	}
}
func TestRuntimeOriginalUnknownSurvivesConcreteJournalAndOwnerReopen(t *testing.T) {
	for _, mode := range []string{"provider-ack", "parent-closed-after-reservation"} {
		t.Run(mode, func(t *testing.T) {
			f := runtimeNewFixture(t, 1, "child", "other")
			p := runtimePlan("workflow", "child")
			if mode == "provider-ack" {
				f.provider.unknown = true
			} else {
				f.parent.closeAfterFirst = true
			}
			if _, err := f.runtime.Activate(runtimeCtx, p, runtimeBudget(1)); err != nil {
				t.Fatal(err)
			}
			effects := f.provider.count()
			if err := f.store.Close(); err != nil {
				t.Fatal(err)
			}
			f.store = nil
			store, err := taskrepo.OpenFilesystem(f.root)
			if err != nil {
				t.Fatal(err)
			}
			f.store = store
			f.addTask(t, "child", store)
			f.addTask(t, "other", store)
			f.runtime, err = New(store, f.tasks, f.composer, f.parent, 1)
			if err != nil {
				t.Fatal(err)
			}
			f.parent.closeAfterFirst = false
			f.provider.unknown = false
			r, err := f.runtime.Reconnect(runtimeCtx, p.ID, runtimeBudget(1))
			if err != nil || r.Steps[0].State != wf.Unknown || f.provider.count() != effects {
				t.Fatal(r, err)
			}
			r, err = f.runtime.Activate(runtimeCtx, p, runtimeBudget(1))
			if err != nil || len(r.Started) != 0 || r.Steps[0].State != wf.Unknown || f.provider.count() != effects {
				t.Fatal("restart replayed original", r, err)
			}
			r, err = f.runtime.Activate(runtimeCtx, runtimePlan("other-workflow", "other"), runtimeBudget(1))
			if err != nil || len(r.Started) != 0 || f.provider.count() != effects {
				t.Fatal("restart freed unknown slot", r, err)
			}
		})
	}
}

func TestTasksExactTargetsRejectDispatchAndReferenceChangesBeforeEffects(t *testing.T) {
	for _, action := range []string{"cancel", "deliver"} {
		for _, variant := range []string{"dispatch", "reference"} {
			t.Run(action+"/"+variant, func(t *testing.T) {
				f := runtimeNewFixture(t, 1, "child")
				p := runtimePlan("workflow", "child")
				if _, err := f.runtime.Activate(runtimeCtx, p, runtimeBudget(1)); err != nil {
					t.Fatal(err)
				}
				r, err := f.tasks.Read(runtimeCtx, "child", "child-create")
				if err != nil {
					t.Fatal(err)
				}
				if action == "deliver" {
					f.provider.terminal = true
					if _, err := f.tasks.Observe(runtimeCtx, "child"); err != nil {
						t.Fatal(err)
					}
				}
				q := workflow.Target{TaskID: "child", OperationID: "child-" + action, ExpectedDispatchID: "child-create", Reference: r.Reference}
				if variant == "dispatch" {
					q.ExpectedDispatchID = "stale"
				} else {
					q.Reference.TurnID = "stale"
				}
				if action == "cancel" {
					_, err = f.tasks.Cancel(runtimeCtx, q)
				} else {
					_, err = f.tasks.Deliver(runtimeCtx, q)
				}
				var failure *control.Failure
				if !errors.As(err, &failure) || failure.Code != "TASK_IDENTITY_MISMATCH" || f.provider.count() != 1 || f.delivery.calls != 0 {
					t.Fatal("exact target crossed before effects", err)
				}
				if op, err := f.store.Lookup(runtimeCtx, q.OperationID); err != nil || op != nil {
					t.Fatal("stale exact mutation recorded", op, err)
				}
			})
		}
	}
}
func TestTasksWrongOriginalRouteCannotAdoptAnotherTasksOperation(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child", "other")
	if _, err := f.runtime.Activate(runtimeCtx, runtimePlan("workflow", "child"), runtimeBudget(1)); err != nil {
		t.Fatal(err)
	}
	// Even if composition picks another route, DTO identity cannot be rewritten.
	f.routes.original["other"] = f.routes.original["child"]
	if _, err := f.tasks.Read(runtimeCtx, "other", "child-create"); !errors.Is(err, workflow.ErrIdentity) {
		t.Fatal("cross-task operation adopted", err)
	}
}

func TestTasksContinueUsesFreshSameOwnerScopeAndOriginalExactDispatch(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child")
	p := runtimePlan("workflow", "child")
	if _, err := f.runtime.Activate(runtimeCtx, p, runtimeBudget(1)); err != nil {
		t.Fatal(err)
	}
	f.provider.terminal = true
	if _, err := f.runtime.Deliver(runtimeCtx, p.ID); err != nil {
		t.Fatal(err)
	}
	owner := f.owners["child"]
	route, err := owner.Select(port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session-child", TaskID: "child", TaskEpoch: 2, ParticipantID: "participant-child", TurnID: "fresh-farol-turn"})
	if err != nil {
		t.Fatal(err)
	}
	service, err := taskservice.NewOwned(route, f.authority, map[task.Provider]port.Provider{task.Codex: f.provider}, f.delivery, intent.Fingerprint, progress.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	facade, err := control.New(service)
	if err != nil {
		t.Fatal(err)
	}
	f.routes.selected["child"] = facade
	f.provider.terminal = false
	out, err := f.tasks.Followup(runtimeCtx, workflow.Followup{TaskID: "child", OperationID: "child-follow", ExpectedDispatchID: "child-create", Message: "controlled follow-up"})
	if err != nil || out.State != workflow.Known || out.Reference.ThreadID != "provider-child" || out.Reference.TurnID != "child-follow" || f.provider.count() != 2 {
		t.Fatal(out, err)
	}
	original, err := f.tasks.Read(runtimeCtx, "child", "child-create")
	if err != nil || original.Outcome != wf.Completed || original.Reference.TurnID != "child-create" || original.Output != "accepted output" {
		t.Fatal("follow-up changed original receipt", original, err)
	}
	if operation, err := f.store.Lookup(runtimeCtx, "child-follow"); err != nil || operation.Intent.Admission.TaskEpoch != 2 || operation.Intent.Expected.TurnID != "child-create" {
		t.Fatal(operation, err)
	}
}

func TestRuntimeControlledCancellationACKKeepsOriginalCapacityOccupied(t *testing.T) {
	f := runtimeNewFixture(t, 1, "child", "other")
	f.provider.cancelControlled = true // Controlled capability only, never Codex support evidence.
	p := runtimePlan("workflow", "child")
	if _, err := f.runtime.Activate(runtimeCtx, p, runtimeBudget(1)); err != nil {
		t.Fatal(err)
	}
	r, err := f.runtime.Cancel(runtimeCtx, p.ID)
	if err != nil || r.Steps[0].State != wf.Running || !r.Steps[0].CancelRequested || r.Steps[0].Cancellation != workflow.CancellationAcknowledged || f.provider.count() != 2 {
		t.Fatal("cancel ACK was treated as terminal", r, err)
	}
	r, err = f.runtime.Activate(runtimeCtx, runtimePlan("other-workflow", "other"), runtimeBudget(1))
	if err != nil || len(r.Started) != 0 || f.provider.count() != 2 {
		t.Fatal("cancel ACK/revoke released global occupancy", r, err)
	}
	snapshot, err := f.store.Read(runtimeCtx, "child")
	if err != nil || !snapshot.Task.CancelRequested || snapshot.Task.Lifecycle != task.Running || snapshot.Task.Admission.State != task.AdmissionRevoked {
		t.Fatal(snapshot, err)
	}
}
