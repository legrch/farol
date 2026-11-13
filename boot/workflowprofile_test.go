//go:build darwin || linux

package boot

// Actual TaskProfile + original Chat admission + concrete same Task Filesystem
// + Codex facade/client are composed here. Native root qualification, selected
// account/host, net.Pipe RPC and parent delivery remain controlled fixture IO.
// This is not public OpenTaskProfile, shipping wire or live-provider acceptance.
import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	workflow "github.com/legrch/farol/modules/task/app/services/workflow"
	"github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
	"golang.org/x/sys/unix"
)

type workflowProfileComposer struct {
	selection workflow.Selection
	before    func()
}

func (c *workflowProfileComposer) Compose(context.Context, wf.Step, map[string]string) (workflow.Selection, string, error) {
	if c.before != nil {
		c.before()
	}
	return c.selection, "controlled finite child", nil
}

type workflowProfileDelivery struct{ calls atomic.Int32 }

func (d *workflowProfileDelivery) Send(_ context.Context, p task.Parent, operationID string, ref task.Reference, result string) (task.Receipt, error) {
	if p != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) || operationID != "workflow-deliver" || result != "retained turn-1" {
		return task.Receipt{}, task.ErrIdentity
	}
	d.calls.Add(1)
	return task.Receipt{State: task.Known, Reference: ref}, nil
}

type workflowProfileFixture struct {
	*taskProfileTestFixture
	store    *taskrepo.Filesystem
	root     taskrepo.FilesystemRoot
	composer *workflowProfileComposer
	delivery *workflowProfileDelivery
	selected *TaskIngress
	workflow *WorkflowProfile
}

func workflowProfileSetup(t *testing.T, lost bool, epoch uint64) *workflowProfileFixture {
	t.Helper()
	f := taskProfileTestSetup(t, lost)
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	var st unix.Stat_t
	if err = unix.Lstat(path, &st); err != nil {
		t.Fatal(err)
	}
	root := taskrepo.FilesystemRoot{ProfileID: f.profile.peer.ProfileId, Path: path, Device: uint64(st.Dev), Inode: uint64(st.Ino)}
	store, err := taskrepo.OpenFilesystem(root)
	if err != nil {
		t.Fatal(err)
	}
	f.profile.journal = store
	f.profile.closeJournal = func() error { f.closed.Add(1); return store.Close() }
	delivery := &workflowProfileDelivery{}
	f.input.Delivery = delivery
	selected := f.selectTurn(t, epoch)
	b := f.input.Selection.Binding
	composer := &workflowProfileComposer{selection: workflow.Selection{Provider: string(b.Provider), ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, ModelAlias: b.ModelAlias, Effort: b.Effort}}
	x := &workflowProfileFixture{taskProfileTestFixture: f, store: store, root: root, composer: composer, delivery: delivery, selected: selected}
	x.workflow, err = f.profile.NewWorkflow(context.Background(), x.inputForWorkflow())
	if err != nil {
		t.Fatal(err)
	}
	return x
}
func (f *workflowProfileFixture) inputForWorkflow() WorkflowProfileInput {
	b := f.selected.scope
	return WorkflowProfileInput{Scope: []port.CurrentBinding{{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}}, ChatHandle: f.input.ChatHandle, Parent: f.input.Parent, Capacity: 1, Composer: f.composer}
}
func workflowProfilePlan() wf.Plan {
	return wf.Plan{ID: "workflow", Parent: wf.Parent{ThreadID: "parent", TurnID: "parent-turn"}, Steps: []wf.Step{{ID: "step", TaskID: "task", OperationID: "workflow-create", CancelOperationID: "workflow-cancel", DeliveryOperationID: "workflow-deliver", Required: []wf.Capability{wf.CapabilityCreate}, Output: wf.Output{Kind: wf.OutputText, MaxBytes: 4096}}}}
}
func workflowProfileBudget() wf.Budget {
	return wf.Budget{Slots: 1, Available: map[wf.Capability]bool{wf.CapabilityCreate: true}}
}

func TestWorkflowProfileOriginalOwnerJournalAndIndependentDelivery(t *testing.T) {
	f := workflowProfileSetup(t, false, 1)
	ctx := context.Background()
	routes := workflowProfileRoutes{f.workflow}
	original, err := routes.Original(ctx, "task", "workflow-create")
	if err != nil || original != f.selected.runtime.control {
		t.Fatal("original facade replaced", original, err)
	}
	selected, err := routes.Selected(ctx, "task")
	if err != nil || selected != original {
		t.Fatal("selected facade replaced", selected, err)
	}
	if f.workflow.store != f.profile.journal || len(f.profile.tasks) != 1 || len(f.profile.clients) != 1 || f.task.pipe.launches.Load() != 0 {
		t.Fatal("constructed a new runtime owner or launched on selection")
	}
	if _, err = f.store.ReadWorkflow(ctx, "workflow"); !errors.Is(err, task.ErrNotFound) {
		t.Fatal("construction activated or persisted workflow", err)
	}
	report, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget())
	if err != nil || len(report.Started) != 1 || report.Steps[0].State != wf.Running {
		t.Fatal(report, err)
	}
	f.task.pipe.complete("turn-1")
	report, err = f.workflow.Reconnect(ctx, "workflow", workflowProfileBudget())
	if err != nil || report.Steps[0].State != wf.Completed || !report.Steps[0].Accepted || len(report.Started) != 0 || f.delivery.calls.Load() != 0 {
		t.Fatal(report, err)
	}
	report, err = f.workflow.Deliver(ctx, "workflow")
	if err != nil || report.Steps[0].Delivery != workflow.DeliveryAcknowledged || f.delivery.calls.Load() != 1 {
		t.Fatal(report, err)
	}
	if _, err = f.workflow.Deliver(ctx, "workflow"); err != nil || f.delivery.calls.Load() != 1 {
		t.Fatal("replayed original parent delivery", err)
	}
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("new provider lifetime or task engine")
	}
}

func TestWorkflowProfileRejectsWrongOriginalAssociationBeforeAnyEffect(t *testing.T) {
	for _, change := range []string{"memory-journal", "missing-scope", "different-epoch", "duplicate-task", "wrong-parent", "missing-chat", "other-chat", "nil-composer", "invalid-capacity", "closed"} {
		t.Run(change, func(t *testing.T) {
			f := workflowProfileSetup(t, false, 1)
			input := f.inputForWorkflow()
			switch change {
			case "memory-journal":
				f.profile.journal = f.task.store
			case "missing-scope":
				input.Scope = nil
			case "different-epoch":
				input.Scope[0].TaskEpoch = 9
			case "duplicate-task":
				input.Scope = append(input.Scope, input.Scope[0])
			case "wrong-parent":
				input.Parent.TurnID = "wrong-parent"
			case "missing-chat":
				input.ChatHandle = "missing"
			case "other-chat":
				other, err := f.chat.ingress.create(context.Background(), "other", chatComputerInput(true))
				if err != nil {
					t.Fatal(err)
				}
				input.ChatHandle = other.HandleId
			case "nil-composer":
				input.Composer = nil
			case "invalid-capacity":
				input.Capacity = 0
			case "closed":
				if err := f.profile.Close(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.profile.NewWorkflow(context.Background(), input); err == nil {
				t.Fatal("substituted association accepted")
			}
			if f.task.pipe.launches.Load() != 0 || len(f.profile.tasks) != 1 || len(f.profile.routes) != 1 || f.delivery.calls.Load() != 0 {
				t.Fatal("constructor created provider or owner effects")
			}
		})
	}
}

func TestWorkflowProfileUnselectedPlanAndSelectionRefusedBeforeReservation(t *testing.T) {
	for _, change := range []string{"task", "parent", "selection"} {
		t.Run(change, func(t *testing.T) {
			f := workflowProfileSetup(t, false, 1)
			plan := workflowProfilePlan()
			switch change {
			case "task":
				plan.Steps[0].TaskID = "not-selected"
			case "parent":
				plan.Parent.TurnID = "other-parent"
			case "selection":
				f.composer.selection.ProjectID = "other-project"
			}
			report, err := f.workflow.Activate(context.Background(), plan, workflowProfileBudget())
			if change != "selection" && err == nil {
				t.Fatal("wrong plan accepted", report)
			}
			if f.task.pipe.launches.Load() != 0 || f.task.pipe.count("turn/start") != 0 {
				t.Fatal("unselected plan/selection dispatched")
			}
			if _, err = f.store.ReadWorkflowReservation(context.Background(), "workflow-create"); !errors.Is(err, task.ErrNotFound) {
				t.Fatal("unselected plan/selection reserved global capacity", err)
			}
		})
	}
}

func TestWorkflowProfileParentWithdrawalAndLostAckNeverReplay(t *testing.T) {
	for _, cut := range []string{"parent-before-constructor", "parent-after-compose", "provider-lost-ack"} {
		t.Run(cut, func(t *testing.T) {
			f := workflowProfileSetup(t, cut == "provider-lost-ack", 1)
			ctx := context.Background()
			if cut == "parent-before-constructor" {
				if err := f.parent.handle.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
				if _, err := f.profile.NewWorkflow(ctx, f.inputForWorkflow()); err == nil {
					t.Fatal("closed original parent selected")
				}
				return
			}
			if cut == "parent-after-compose" {
				f.composer.before = func() {
					if err := f.parent.handle.Cancel(ctx); err != nil {
						t.Fatal(err)
					}
				}
			}
			report, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget())
			if err != nil {
				t.Fatal(report, err)
			}
			if cut == "parent-after-compose" {
				if f.task.pipe.count("thread/start") != 0 || f.task.pipe.count("turn/start") != 0 {
					t.Fatal("parent withdrawal dispatched")
				}
				return
			}
			if report.Steps[0].State != wf.Unknown || f.task.pipe.count("turn/start") != 1 {
				t.Fatal(report)
			}
			for i := 0; i < 2; i++ {
				report, err = f.workflow.Reconnect(ctx, "workflow", workflowProfileBudget())
				if err != nil || report.Steps[0].State != wf.Unknown || len(report.Started) != 0 {
					t.Fatal(report, err)
				}
			}
			if _, err = f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget()); err != nil || f.task.pipe.count("turn/start") != 1 || f.task.pipe.launches.Load() != 1 {
				t.Fatal("unknown original replayed", err)
			}
		})
	}
}

func TestWorkflowProfileCloseFencesEveryFacadeWithoutRepeatingCleanup(t *testing.T) {
	f := workflowProfileSetup(t, false, 1)
	ctx := context.Background()
	if _, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget()); err != nil {
		t.Fatal(err)
	}
	if err := f.profile.Close(ctx); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"activate", "reconnect", "cancel", "deliver", "resolve", "original", "selected"} {
		t.Run(operation, func(t *testing.T) {
			var err error
			switch operation {
			case "activate":
				_, err = f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget())
			case "reconnect":
				_, err = f.workflow.Reconnect(ctx, "workflow", workflowProfileBudget())
			case "cancel":
				_, err = f.workflow.Cancel(ctx, "workflow")
			case "deliver":
				_, err = f.workflow.Deliver(ctx, "workflow")
			case "resolve":
				_, err = (workflowProfileRoutes{f.workflow}).Resolve(ctx, f.composer.selection)
			case "original":
				_, err = (workflowProfileRoutes{f.workflow}).Original(ctx, "task", "workflow-create")
			case "selected":
				_, err = (workflowProfileRoutes{f.workflow}).Selected(ctx, "task")
			}
			if err == nil {
				t.Fatal("closed profile facade stayed available")
			}
		})
	}
	if err := f.profile.Close(ctx); err != nil || f.closed.Load() != 1 || f.delivery.calls.Load() != 0 || f.task.pipe.count("turn/start") != 1 {
		t.Fatal("closed facade replayed cleanup/effect", err)
	}
}

func TestWorkflowProfileReadsOriginalEpochWhileMutationRouteStaysSelected(t *testing.T) {
	f := workflowProfileSetup(t, false, 1)
	ctx := context.Background()
	if _, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget()); err != nil {
		t.Fatal(err)
	}
	first := f.selected
	f.task.pipe.complete("turn-1")
	if _, err := f.workflow.Reconnect(ctx, "workflow", workflowProfileBudget()); err != nil {
		t.Fatal(err)
	}
	f.selected = f.selectTurn(t, 2)
	input := f.inputForWorkflow()
	current, err := f.profile.NewWorkflow(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Scope[0].TaskEpoch = 999 // The facade retains values, not this input slice.
	routes := workflowProfileRoutes{current}
	original, err := routes.Original(ctx, "task", "workflow-create")
	if err != nil || original != first.runtime.control {
		t.Fatal("original epoch was retargeted", original, err)
	}
	selected, err := routes.Selected(ctx, "task")
	if err != nil || selected != f.selected.runtime.control {
		t.Fatal("current selected epoch lost", selected, err)
	}
	report, err := current.Reconnect(ctx, "workflow", workflowProfileBudget())
	if err != nil || report.Steps[0].State != wf.Completed || !report.Steps[0].Accepted || len(report.Started) != 0 {
		t.Fatal(report, err)
	}
	if f.task.pipe.count("turn/start") != 1 || len(f.profile.tasks) != 1 || len(f.profile.clients) != 1 {
		t.Fatal("reconnect fabricated a new selection or provider effect")
	}
}

func TestWorkflowProfileRestartReadsOriginalUnknownWithoutRestoringAdmission(t *testing.T) {
	f := workflowProfileSetup(t, true, 1)
	ctx := context.Background()
	report, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget())
	if err != nil || report.Steps[0].State != wf.Unknown {
		t.Fatal(report, err)
	}
	if err = f.profile.Close(ctx); err != nil {
		t.Fatal(err)
	}
	store, err := taskrepo.OpenFilesystem(f.root)
	if err != nil {
		t.Fatal(err)
	}
	// Reopen with original, explicitly trusted selections, not a storage-derived
	// grant. The parent's actual existing Chat admission remains the same here.
	p := newTaskProfile(f.profile.peer, f.profile.owner, f.chat.ingress, store, store.Close)
	p.newClient = f.profile.newClient
	t.Cleanup(func() { _ = p.Close(context.Background()) })
	ingress, err := p.SelectCodex(ctx, f.input)
	if err != nil {
		t.Fatal(err)
	}
	in := f.inputForWorkflow()
	w, err := p.NewWorkflow(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	report, err = w.Reconnect(ctx, "workflow", workflowProfileBudget())
	if err != nil || report.Steps[0].State != wf.Unknown || len(report.Started) != 0 {
		t.Fatal(report, err)
	}
	if w.turns["task"].selected.control != ingress.runtime.control {
		t.Fatal("reopen retained a different facade")
	}
	if err = p.routes[0].WithCurrent(ctx, func(current *port.CurrentBinding) error {
		if current != nil {
			t.Fatal("storage read restored admission")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Activate(ctx, workflowProfilePlan(), workflowProfileBudget()); err != nil || f.task.pipe.launches.Load() != 1 || f.task.pipe.count("turn/start") != 1 {
		t.Fatal("original unknown was replayed after restart", err)
	}
}

func TestWorkflowProfileSharesCapacityWithOrdinaryOriginalTaskIngress(t *testing.T) {
	f := workflowProfileSetup(t, false, 1)
	ctx := context.Background()
	if _, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget()); err != nil {
		t.Fatal(err)
	}
	input := f.input
	input.Scope.TaskID = "ordinary-task"
	other, err := f.profile.SelectCodex(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := other.Create(ctx, "ordinary-create", TaskIngressCreateRequest{Message: "must share global capacity"}); err == nil && out.Receipt.State == "known" {
		t.Fatal("ordinary task bypassed original global capacity", out)
	}
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 {
		t.Fatal("normal Task facade bypassed workflow occupancy")
	}
	if op, err := f.store.Lookup(ctx, "ordinary-create"); err != nil || op != nil {
		t.Fatal("capacity refusal created a second intent", op, err)
	}
}

func TestWorkflowProfileUnsupportedCancellationCannotReleaseRunningCapacity(t *testing.T) {
	f := workflowProfileSetup(t, false, 1)
	ctx := context.Background()
	resolved, err := (workflowProfileRoutes{f.workflow}).Resolve(ctx, f.composer.selection)
	if err != nil || resolved.Capabilities.Cancel {
		t.Fatal("invented independent Codex cancellation support", resolved, err)
	}
	if _, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget()); err != nil {
		t.Fatal(err)
	}
	report, err := f.workflow.Cancel(ctx, "workflow")
	if err != nil || report.Steps[0].State != wf.Running || report.Steps[0].Cancellation == workflow.CancellationAcknowledged {
		t.Fatal("unsupported cancel qualified or made original Task terminal", report, err)
	}
	if op, err := f.store.Lookup(ctx, "workflow-cancel"); err != nil || op != nil {
		t.Fatal("unsupported cancel created an effect intent", op, err)
	}
	other := wf.Plan{ID: "second", Parent: workflowProfilePlan().Parent, Steps: []wf.Step{{ID: "other", TaskID: "other-task", OperationID: "other-create", CancelOperationID: "other-cancel", DeliveryOperationID: "other-deliver", Output: wf.Output{Kind: wf.OutputText, MaxBytes: 64}}}}
	if _, err := f.store.SaveWorkflow(ctx, other, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ReserveWorkflow(ctx, "second", "other-task", "other-create"); !errors.Is(err, task.ErrState) {
		t.Fatal("unsupported cancel freed original capacity", err)
	}
	if f.task.pipe.count("turn/start") != 1 {
		t.Fatal("unsupported cancellation dispatched")
	}
}

func TestWorkflowProfileOriginalFacadeIsNotSubstitutedByLaterTaskEpoch(t *testing.T) {
	f := workflowProfileSetup(t, false, 1)
	ctx := context.Background()
	if _, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget()); err != nil {
		t.Fatal(err)
	}
	f.task.pipe.complete("turn-1")
	if _, err := f.workflow.Reconnect(ctx, "workflow", workflowProfileBudget()); err != nil {
		t.Fatal(err)
	}
	second := f.selectTurn(t, 2)
	if _, err := second.Continue(ctx, "follow-2", TaskIngressContinueRequest{DispatchID: "workflow-create", Message: "ordinary exact original follow-up"}); err != nil {
		t.Fatal(err)
	}
	routes := workflowProfileRoutes{f.workflow}
	if _, err := routes.Original(ctx, "task", "follow-2"); !errors.Is(err, workflow.ErrIdentity) {
		t.Fatal("captured workflow adopted later unselected epoch", err)
	}
	if actual, err := routes.Selected(ctx, "task"); err != nil || actual != f.selected.runtime.control {
		t.Fatal("captured current scope was silently moved", actual, err)
	}
	report, err := f.workflow.Reconnect(ctx, "workflow", workflowProfileBudget())
	if err != nil || report.Steps[0].State != wf.Completed || !report.Steps[0].Accepted {
		t.Fatal("new running dispatch replaced retained original outcome", report, err)
	}
	if f.task.pipe.count("turn/start") != 2 {
		t.Fatal("read replayed another provider operation")
	}
}

func TestWorkflowProfileFullCapturedBindingAndCloseDuringComposeFenceEffects(t *testing.T) {
	for _, cut := range []string{"binding", "close"} {
		t.Run(cut, func(t *testing.T) {
			f := workflowProfileSetup(t, false, 1)
			ctx := context.Background()
			f.composer.before = func() {
				if cut == "binding" {
					f.task.authority.binding.HostID = "another-host"
				} else if err := f.profile.Close(ctx); err != nil {
					t.Fatal(err)
				}
			}
			_, err := f.workflow.Activate(ctx, workflowProfilePlan(), workflowProfileBudget())
			if cut == "close" && err == nil {
				t.Fatal("late closed result disclosed as active")
			}
			if f.task.pipe.count("turn/start") != 0 || f.task.pipe.count("thread/start") != 0 || f.delivery.calls.Load() != 0 {
				t.Fatal("late identity/close admitted effects")
			}
			store := f.store
			if cut == "close" {
				var openErr error
				store, openErr = taskrepo.OpenFilesystem(f.root)
				if openErr != nil {
					t.Fatal(openErr)
				}
				defer store.Close()
			}
			if reservation, err := store.ReadWorkflowReservation(ctx, "workflow-create"); !errors.Is(err, task.ErrNotFound) || reservation != nil {
				t.Fatal("late identity/close consumed callback", reservation, err)
			}
		})
	}
}
