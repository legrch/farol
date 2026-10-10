//go:build darwin || linux

package workflow_test

// These fixtures compose the production Task owner, DTO facade and disposable
// filesystem adapter. Providers, authority and parent delivery are controlled.
// They do not qualify a live provider, native executor or power-loss durability.
import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	app "github.com/legrch/farol/modules/task/app/services/workflow"
	"github.com/legrch/farol/modules/task/contracts/control"
	task "github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
	repo "github.com/legrch/farol/modules/task/infra/repos/task"
	"golang.org/x/sys/unix"
)

var testContext = context.Background()

type controlledAuthority struct {
	binding      task.Binding
	parentClosed bool
}

func (a *controlledAuthority) Resolve(context.Context, port.Selection) (task.Binding, error) {
	return a.binding, nil
}
func (*controlledAuthority) Recheck(context.Context, task.Binding) error { return nil }
func (a *controlledAuthority) RecheckParent(_ context.Context, p task.Parent) error {
	if a.parentClosed || p != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) {
		return task.ErrState
	}
	return nil
}

type controlledProvider struct {
	provider        task.Provider
	dispatches      []port.Dispatch
	observations    map[task.Reference]port.Observation
	lostDispatchACK map[string]bool
	immediate       map[string]port.Observation
	reads           int
}

func (*controlledProvider) Supports(_ context.Context, b task.Binding) (task.Capabilities, error) {
	return task.Capabilities{Create: true, Continue: b.Provider == task.Codex, Resume: b.Provider == task.Claude, Message: true, Cancel: true}, nil
}
func (p *controlledProvider) Dispatch(_ context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	p.dispatches = append(p.dispatches, d)
	ref := task.Reference{ThreadID: "provider-" + d.Intent.TaskID, TurnID: d.Intent.OperationID}
	if d.Intent.Binding.Provider == task.Claude {
		ref = task.Reference{SessionID: "provider-" + d.Intent.TaskID, InvocationID: d.Intent.OperationID}
	}
	if d.Intent.Action == task.Cancel || d.Intent.Action == task.Message {
		ref = d.Intent.Expected
	}
	if err := progress(ref); err != nil {
		return task.Receipt{}, err
	}
	r := task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}
	if d.Intent.Action == task.Cancel {
		r.CancelRequested = true
	}
	if terminal, ok := p.immediate[d.Intent.TaskID]; ok && d.Intent.Action == task.Create {
		r.Lifecycle, r.Result = terminal.Lifecycle, terminal.Result
	}
	if p.lostDispatchACK[d.Intent.TaskID] {
		return task.Receipt{}, task.ErrUnknown
	}
	return r, nil
}
func (p *controlledProvider) Observe(_ context.Context, _ task.Binding, ref task.Reference) (port.Observation, error) {
	p.reads++
	if o, ok := p.observations[ref]; ok {
		return o, nil
	}
	return port.Observation{Reference: ref, Lifecycle: task.Running}, nil
}
func (p *controlledProvider) settle(taskID, operationID string, state task.Lifecycle, output string) {
	r := task.Reference{ThreadID: "provider-" + taskID, TurnID: operationID}
	if p.provider == task.Claude {
		r = task.Reference{SessionID: "provider-" + taskID, InvocationID: operationID}
	}
	p.observations[r] = port.Observation{Reference: r, Lifecycle: state, Result: output}
}

type delivered struct {
	parent      task.Parent
	operationID string
	reference   task.Reference
	text        string
}
type controlledDelivery struct {
	sends   []delivered
	lostACK bool
}

func (d *controlledDelivery) Send(_ context.Context, parent task.Parent, id string, ref task.Reference, text string) (task.Receipt, error) {
	d.sends = append(d.sends, delivered{parent, id, ref, text})
	if d.lostACK {
		return task.Receipt{}, task.ErrUnknown
	}
	return task.Receipt{State: task.Known, Reference: ref}, nil
}

// Faults execute the real journal mutation once, then hide its ACK. This tests
// retained evidence after an application-level ambiguous reply, not disk faults.
type journalFaults struct {
	port.AdmissionJournal
	admit, finish, observe bool
}

func (j *journalFaults) Admit(ctx context.Context, i task.Intent, rev uint64, next task.Task) (*port.Admission, error) {
	a, err := j.AdmissionJournal.Admit(ctx, i, rev, next)
	if err == nil && j.admit {
		j.admit = false
		return nil, task.ErrUnknown
	}
	return a, err
}
func (j *journalFaults) Finish(ctx context.Context, id string, r task.Receipt, next task.Task) error {
	err := j.AdmissionJournal.Finish(ctx, id, r, next)
	if err == nil && j.finish {
		j.finish = false
		return task.ErrUnknown
	}
	return err
}
func (j *journalFaults) Observe(ctx context.Context, before port.Snapshot, next task.Task) error {
	err := j.AdmissionJournal.Observe(ctx, before, next)
	if err == nil && j.observe {
		j.observe = false
		return task.ErrUnknown
	}
	return err
}

type childRoute struct {
	owner   *repo.Owner
	route   *repo.Route
	service *tasksvc.Service
	facade  *control.Contract
}
type dtoTasks struct {
	children           map[string]childRoute
	followupOperations map[string]childRoute
	journal            port.Journal
}

func mappedReference(r control.Reference) app.Reference {
	return app.Reference{SessionID: r.SessionID, ThreadID: r.ThreadID, TurnID: r.TurnID, InvocationID: r.InvocationID}
}
func mappedLifecycle(l control.Lifecycle) wf.State {
	switch l {
	case control.Running:
		return wf.Running
	case control.Completed:
		return wf.Completed
	case control.Failed:
		return wf.Failed
	case control.NeedsInput:
		return wf.NeedsInput
	case control.Interrupted:
		return wf.Cancelled
	case control.Refused:
		return wf.Unavailable
	default:
		return wf.Unknown
	}
}
func mappedReceipt(s control.ReceiptState) app.ReceiptState {
	switch s {
	case control.Known:
		return app.Known
	case control.Rejected:
		return app.Refused
	default:
		return app.Unknown
	}
}
func mappedMutation(r *control.MutationResponse, action string) app.Record {
	return app.Record{Found: true, TaskID: r.TaskID, OperationID: r.OperationID, Action: action, State: mappedReceipt(r.Receipt.State), Outcome: mappedLifecycle(r.Receipt.Lifecycle), Reference: mappedReference(r.Receipt.Reference), Output: r.Receipt.Result, CancelRequested: r.Receipt.CancelRequested}
}
func (a *dtoTasks) Read(ctx context.Context, taskID, opID string) (app.Record, error) {
	child := a.children[taskID]
	if follow, ok := a.followupOperations[opID]; ok {
		child = follow
	}
	r, err := child.facade.Operation(ctx, control.OperationRequest{OperationID: opID})
	if err != nil {
		var failure *control.Failure
		if errors.As(err, &failure) && failure.Code == "TASK_NOT_FOUND" {
			return app.Record{}, nil
		}
		return app.Record{}, err
	}
	return app.Record{Found: true, TaskID: r.TaskID, OperationID: r.OperationID, Action: string(r.Action), State: mappedReceipt(r.Receipt.State), Outcome: mappedLifecycle(r.Receipt.Lifecycle), Reference: mappedReference(r.Receipt.Reference), Output: r.Receipt.Result, CancelRequested: r.Receipt.CancelRequested}, nil
}
func selected(s app.Selection) control.Selection {
	return control.Selection{Provider: control.Provider(s.Provider), ProjectID: s.ProjectID, WorkspaceID: s.WorkspaceID, ModelAlias: s.ModelAlias, Effort: s.Effort}
}
func (a *dtoTasks) Resolve(ctx context.Context, s app.Selection) (map[wf.Capability]bool, error) {
	for _, child := range a.children {
		r, err := child.facade.Resolve(ctx, control.ResolveRequest{Selection: selected(s)})
		if err != nil {
			return nil, err
		}
		c := r.Capabilities
		return map[wf.Capability]bool{wf.CapabilityCreate: c.Create, wf.CapabilityContinue: c.Continue, wf.CapabilityResume: c.Resume, wf.CapabilityCancel: c.Cancel, wf.CapabilityMessage: c.Message}, nil
	}
	return nil, app.ErrUnavailable
}
func (a *dtoTasks) Create(ctx context.Context, l app.Launch) (app.Record, error) {
	r, err := a.children[l.TaskID].facade.Create(ctx, control.CreateRequest{OperationID: l.OperationID, TaskID: l.TaskID, Message: l.Message, Selection: selected(l.Selection), Parent: control.Parent{ThreadID: l.Parent.ThreadID, TurnID: l.Parent.TurnID}})
	if err != nil {
		return app.Record{}, err
	}
	return mappedMutation(r, "create"), nil
}
func (a *dtoTasks) Observe(ctx context.Context, taskID string) (app.Result, error) {
	r, err := a.children[taskID].facade.Result(ctx, control.TaskRequest{TaskID: taskID})
	if err != nil {
		return app.Result{}, err
	}
	return app.Result{TaskID: r.TaskID, DispatchID: r.DispatchID, Reference: mappedReference(r.Reference), Outcome: mappedLifecycle(r.Lifecycle), Output: r.Text, Retained: r.Retained}, nil
}

// exactTarget is sufficient only under this fixture's exclusive synchronous
// writer. Integration requires Task-owned atomic CancelExact/DeliverExact; a
// separate snapshot check cannot provide that guarantee to concurrent writers.
func (a *dtoTasks) exactTarget(ctx context.Context, target app.Target) error {
	snapshot, err := a.journal.Read(ctx, target.TaskID)
	if err != nil {
		return err
	}
	if snapshot == nil || snapshot.Task.DispatchID != target.ExpectedDispatchID || (app.Reference{SessionID: snapshot.Task.Reference.SessionID, ThreadID: snapshot.Task.Reference.ThreadID, TurnID: snapshot.Task.Reference.TurnID, InvocationID: snapshot.Task.Reference.InvocationID}) != target.Reference {
		return app.ErrIdentity
	}
	return nil
}
func (a *dtoTasks) Cancel(ctx context.Context, target app.Target) (app.Record, error) {
	if err := a.exactTarget(ctx, target); err != nil {
		return app.Record{}, err
	}
	r, err := a.children[target.TaskID].facade.Cancel(ctx, control.CancelRequest{TaskID: target.TaskID, OperationID: target.OperationID})
	if err != nil {
		return app.Record{}, err
	}
	return mappedMutation(r, "cancel"), nil
}
func (a *dtoTasks) Deliver(ctx context.Context, target app.Target) (app.Record, error) {
	if err := a.exactTarget(ctx, target); err != nil {
		return app.Record{}, err
	}
	// Published control currently has no Deliver method. This explicit seam uses
	// the SAME selected production service; boot still needs a published facade.
	_, err := a.children[target.TaskID].service.Deliver(ctx, tasksvc.DeliverRequest{TaskID: target.TaskID, OperationID: target.OperationID})
	if err != nil {
		return app.Record{}, err
	}
	return a.Read(ctx, target.TaskID, target.OperationID)
}
func (a *dtoTasks) Followup(ctx context.Context, f app.Followup) (app.Record, error) {
	child := a.children[f.TaskID]
	if follow, ok := a.followupOperations[f.OperationID]; ok {
		child = follow
	}
	var r *control.MutationResponse
	var err error
	action := "continue"
	if f.Resume {
		action = "resume"
		r, err = child.facade.ResumeExact(ctx, control.ResumeExactRequest{TaskID: f.TaskID, OperationID: f.OperationID, ExpectedDispatchID: f.ExpectedDispatchID, Message: f.Message})
	} else {
		r, err = child.facade.ContinueExact(ctx, control.ContinueExactRequest{TaskID: f.TaskID, OperationID: f.OperationID, ExpectedDispatchID: f.ExpectedDispatchID, Message: f.Message})
	}
	if err != nil {
		return app.Record{}, err
	}
	return mappedMutation(r, action), nil
}

type controlledComposer struct {
	blocked  map[string]bool
	provider task.Provider
}

func (c *controlledComposer) Compose(_ context.Context, step wf.Step, deps map[string]string) (app.Selection, string, error) {
	if c.blocked[step.ID] {
		return app.Selection{}, "", app.ErrUnavailable
	}
	message := strings.ToUpper(step.ID)
	if len(step.Dependencies) > 0 {
		parts := make([]string, 0, len(step.Dependencies))
		for _, id := range step.Dependencies {
			parts = append(parts, deps[id])
		}
		message = strings.Join(parts, "+")
	}
	return app.Selection{Provider: string(c.provider), ProjectID: "project", WorkspaceID: "writer", ModelAlias: "selected", Effort: "high"}, message, nil
}

type controlledAdmission struct {
	authority *controlledAuthority
	calls     int
}

func (a *controlledAdmission) Do(ctx context.Context, parent wf.Parent, _ string, effect func() error) error {
	if err := a.authority.RecheckParent(ctx, task.Parent{ThreadID: parent.ThreadID, TurnID: parent.TurnID}); err != nil {
		return err
	}
	a.calls++
	return effect() // Controlled, synchronous at-most-once callback; no production grant claim.
}

type composition struct {
	t         *testing.T
	root      repo.FilesystemRoot
	journal   *repo.Filesystem
	faults    *journalFaults
	authority *controlledAuthority
	provider  *controlledProvider
	delivery  *controlledDelivery
	composer  *controlledComposer
	admission *controlledAdmission
	tasks     *dtoTasks
	workflow  *app.Service
	plan      wf.Plan
}

func fixturePlan(ids ...string) wf.Plan {
	p := wf.Plan{ID: "finite-example", Parent: wf.Parent{ThreadID: "parent", TurnID: "parent-turn"}}
	for _, id := range ids {
		p.Steps = append(p.Steps, wf.Step{ID: id, TaskID: "task-" + id, OperationID: "create-" + id, CancelOperationID: "cancel-" + id, DeliveryOperationID: "deliver-" + id, Required: []wf.Capability{wf.CapabilityCreate}, Output: wf.Output{Kind: wf.OutputText, MaxBytes: 1024}})
	}
	return p
}
func newComposition(t *testing.T, plan wf.Plan) *composition {
	return newCompositionFor(t, plan, task.Codex)
}
func newCompositionFor(t *testing.T, plan wf.Plan, kind task.Provider) *composition {
	t.Helper()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	var stat unix.Stat_t
	if err = unix.Lstat(path, &stat); err != nil {
		t.Fatal(err)
	}
	f := &composition{t: t, plan: plan, root: repo.FilesystemRoot{ProfileID: "workflow-fixture", Path: path, Device: uint64(stat.Dev), Inode: uint64(stat.Ino)}}
	f.authority = &controlledAuthority{binding: task.Binding{Provider: kind, ProfileID: f.root.ProfileID, HostID: "controlled-host", ProjectID: "project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "2", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "3", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "selected", Model: "controlled-model", Effort: "high", ConfigDigest: "controlled-config"}}
	f.provider = &controlledProvider{provider: kind, observations: map[task.Reference]port.Observation{}, lostDispatchACK: map[string]bool{}, immediate: map[string]port.Observation{}}
	f.delivery = &controlledDelivery{}
	f.composer = &controlledComposer{provider: kind, blocked: map[string]bool{}}
	f.admission = &controlledAdmission{authority: f.authority}
	f.open()
	t.Cleanup(func() {
		f.fence()
		if f.journal != nil {
			if err := f.journal.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	return f
}
func (f *composition) open() {
	f.t.Helper()
	var err error
	f.journal, err = repo.OpenFilesystem(f.root)
	if err != nil {
		f.t.Fatal(err)
	}
	f.faults = &journalFaults{AdmissionJournal: f.journal}
	f.tasks = &dtoTasks{children: map[string]childRoute{}, followupOperations: map[string]childRoute{}, journal: f.journal}
	for _, step := range f.plan.Steps {
		f.install(step.TaskID, 1)
	}
	f.workflow, err = app.New(f.tasks, f.composer, f.admission)
	if err != nil {
		f.t.Fatal(err)
	}
}
func (f *composition) install(taskID string, epoch uint64) {
	f.t.Helper()
	owner, err := repo.New(f.faults, taskID)
	if err != nil {
		f.t.Fatal(err)
	}
	route, err := owner.Select(port.CurrentBinding{OwnerID: "controlled-owner", SessionID: "authority-session", TaskID: taskID, TaskEpoch: epoch, ParticipantID: "controlled-participant", TurnID: "farol-turn"})
	if err != nil {
		f.t.Fatal(err)
	}
	service, err := tasksvc.NewOwned(route, f.authority, map[task.Provider]port.Provider{f.authority.binding.Provider: f.provider}, f.delivery, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		f.t.Fatal(err)
	}
	facade, err := control.New(service)
	if err != nil {
		f.t.Fatal(err)
	}
	f.tasks.children[taskID] = childRoute{owner, route, service, facade}
}
func (f *composition) reopen() {
	f.t.Helper()
	f.fence()
	if err := f.journal.Close(); err != nil {
		f.t.Fatal(err)
	}
	f.open()
}

func (f *composition) fence() {
	for _, child := range f.tasks.children {
		child.route.Fence()
	}
	for _, child := range f.tasks.followupOperations {
		child.route.Fence()
	}
}

// The controlled upstream supplies the newer epoch explicitly. Original
// operation reads retain their old route; the same Owner selects the follow-up.
func (f *composition) selectFollowup(taskID, operationID string, epoch uint64) {
	f.t.Helper()
	child := f.tasks.children[taskID]
	b := child.route.Selection()
	b.TaskEpoch, b.TurnID = epoch, "farol-followup"
	route, err := child.owner.Select(b)
	if err != nil {
		f.t.Fatal(err)
	}
	service, err := tasksvc.NewOwned(route, f.authority, map[task.Provider]port.Provider{f.authority.binding.Provider: f.provider}, f.delivery, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		f.t.Fatal(err)
	}
	facade, err := control.New(service)
	if err != nil {
		f.t.Fatal(err)
	}
	f.tasks.followupOperations[operationID] = childRoute{child.owner, route, service, facade}
}
func (f *composition) tick(slots int, mode app.Mode) app.Report {
	f.t.Helper()
	r, err := f.workflow.Tick(testContext, f.plan, wf.Budget{Slots: slots, Available: map[wf.Capability]bool{wf.CapabilityCreate: true}}, mode)
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}
func progress(t *testing.T, r app.Report, id string) app.Progress {
	t.Helper()
	for _, row := range r.Steps {
		if row.StepID == id {
			return row
		}
	}
	t.Fatalf("missing step %q in %+v", id, r)
	return app.Progress{}
}
