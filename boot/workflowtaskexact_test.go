package boot

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	workflowapp "github.com/legrch/farol/modules/task/app/services/workflow"
	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

// Controlled composition witness: the real Workflow consumer calls the published
// Task facade on the existing Task owner/journal. Provider, parent, backing store,
// and launch admission are CPU fixtures. This is not shipping Workflow wiring,
// physical durability, global capacity enforcement, or live/native qualification.
type workflowTaskExactPeer struct {
	f           *taskRuntimeTestFixture
	before      func()
	lastTarget  workflowapp.Target
	lastFailure error
	mutations   int
}

var _ workflowapp.Tasks = (*workflowTaskExactPeer)(nil)

func workflowTaskExactOutcome(l control.Lifecycle) wf.State {
	switch l {
	case control.Running:
		return wf.Running
	case control.Completed:
		return wf.Completed
	case control.Failed:
		return wf.Failed
	case control.Interrupted:
		return wf.Cancelled
	case control.NeedsInput:
		return wf.NeedsInput
	default:
		return wf.Unknown
	}
}
func workflowTaskExactRecord(taskID, operationID string, action control.Action, r control.Receipt) workflowapp.Record {
	return workflowapp.Record{Found: true, TaskID: taskID, OperationID: operationID, Action: string(action), State: workflowapp.ReceiptState(r.State), Outcome: workflowTaskExactOutcome(r.Lifecycle), Reference: workflowapp.Reference(r.Reference), Output: r.Result, CancelRequested: r.CancelRequested}
}
func (a *workflowTaskExactPeer) Read(ctx context.Context, taskID, operationID string) (workflowapp.Record, error) {
	r, err := a.f.facade.Operation(ctx, control.OperationRequest{OperationID: operationID})
	var failure *control.Failure
	if errors.As(err, &failure) && failure.Code == "TASK_NOT_FOUND" {
		return workflowapp.Record{}, nil
	}
	if err != nil {
		return workflowapp.Record{}, err
	}
	return workflowTaskExactRecord(r.TaskID, r.OperationID, r.Action, r.Receipt), nil
}
func (a *workflowTaskExactPeer) Resolve(ctx context.Context, s workflowapp.Selection) (map[wf.Capability]bool, error) {
	r, err := a.f.facade.Resolve(ctx, control.ResolveRequest{Selection: control.Selection{Provider: control.Provider(s.Provider), ProjectID: s.ProjectID, WorkspaceID: s.WorkspaceID, ModelAlias: s.ModelAlias, Effort: s.Effort}})
	if err != nil {
		return nil, err
	}
	c := r.Capabilities
	return map[wf.Capability]bool{wf.CapabilityCreate: c.Create, wf.CapabilityCancel: c.Cancel, wf.CapabilityContinue: c.Continue, wf.CapabilityResume: c.Resume, wf.CapabilityMessage: c.Message}, nil
}
func (a *workflowTaskExactPeer) Create(ctx context.Context, q workflowapp.Launch) (workflowapp.Record, error) {
	s := q.Selection
	r, err := a.f.facade.Create(ctx, control.CreateRequest{OperationID: q.OperationID, TaskID: q.TaskID, Message: q.Message, Selection: control.Selection{Provider: control.Provider(s.Provider), ProjectID: s.ProjectID, WorkspaceID: s.WorkspaceID, ModelAlias: s.ModelAlias, Effort: s.Effort}, Parent: control.Parent(q.Parent)})
	if err != nil {
		return workflowapp.Record{}, err
	}
	return workflowTaskExactRecord(r.TaskID, r.OperationID, control.Create, r.Receipt), nil
}
func (a *workflowTaskExactPeer) Observe(ctx context.Context, taskID string) (workflowapp.Result, error) {
	r, err := a.f.facade.Result(ctx, control.TaskRequest{TaskID: taskID})
	if err != nil {
		return workflowapp.Result{}, err
	}
	return workflowapp.Result{TaskID: r.TaskID, DispatchID: r.DispatchID, Reference: workflowapp.Reference(r.Reference), Outcome: workflowTaskExactOutcome(r.Lifecycle), Output: r.Text, Retained: r.Retained}, nil
}
func (a *workflowTaskExactPeer) mutation(ctx context.Context, q workflowapp.Target, action control.Action) (workflowapp.Record, error) {
	a.lastTarget = q
	a.mutations++
	if a.before != nil {
		before := a.before
		a.before = nil
		before() // Controlled interleaving after Workflow's read, before Task admission.
	}
	var r *control.MutationResponse
	var err error
	if action == control.Cancel {
		r, err = a.f.facade.CancelExact(ctx, control.CancelExactRequest{OperationID: q.OperationID, TaskID: q.TaskID, ExpectedDispatchID: q.ExpectedDispatchID, ExpectedReference: control.Reference(q.Reference)})
	} else {
		r, err = a.f.facade.DeliverExact(ctx, control.DeliverExactRequest{OperationID: q.OperationID, TaskID: q.TaskID, ExpectedDispatchID: q.ExpectedDispatchID, ExpectedReference: control.Reference(q.Reference)})
	}
	a.lastFailure = err
	if err != nil {
		return workflowapp.Record{}, err
	}
	return workflowTaskExactRecord(r.TaskID, r.OperationID, action, r.Receipt), nil
}
func (a *workflowTaskExactPeer) Cancel(ctx context.Context, q workflowapp.Target) (workflowapp.Record, error) {
	return a.mutation(ctx, q, control.Cancel)
}
func (a *workflowTaskExactPeer) Deliver(ctx context.Context, q workflowapp.Target) (workflowapp.Record, error) {
	return a.mutation(ctx, q, control.Deliver)
}
func (a *workflowTaskExactPeer) Followup(ctx context.Context, q workflowapp.Followup) (workflowapp.Record, error) {
	var r *control.MutationResponse
	var err error
	action := control.Continue
	if q.Resume {
		action = control.Resume
		r, err = a.f.facade.ResumeExact(ctx, control.ResumeExactRequest{OperationID: q.OperationID, TaskID: q.TaskID, Message: q.Message, ExpectedDispatchID: q.ExpectedDispatchID})
	} else {
		r, err = a.f.facade.ContinueExact(ctx, control.ContinueExactRequest{OperationID: q.OperationID, TaskID: q.TaskID, Message: q.Message, ExpectedDispatchID: q.ExpectedDispatchID})
	}
	if err != nil {
		return workflowapp.Record{}, err
	}
	return workflowTaskExactRecord(r.TaskID, r.OperationID, action, r.Receipt), nil
}

type workflowTaskExactCompose struct{ f *taskRuntimeTestFixture }

func (c workflowTaskExactCompose) Compose(_ context.Context, _ wf.Step, _ map[string]string) (workflowapp.Selection, string, error) {
	s := c.f.createRequest().Selection
	return workflowapp.Selection{Provider: string(s.Provider), ProjectID: s.ProjectID, WorkspaceID: s.WorkspaceID, ModelAlias: s.ModelAlias, Effort: s.Effort}, "initial", nil
}
func (c workflowTaskExactCompose) Do(ctx context.Context, p wf.Parent, taskID string, callback func() error) error {
	if taskID != "task" {
		return workflowapp.ErrIdentity
	}
	if err := c.f.taskRuntimeTestAuthority.RecheckParent(ctx, task.Parent(p)); err != nil {
		return err
	}
	// One finite CPU callback; this fixture does not implement global reservation.
	return callback()
}
func workflowTaskExactService(t *testing.T, peer *workflowTaskExactPeer) *workflowapp.Service {
	t.Helper()
	c := workflowTaskExactCompose{f: peer.f}
	s, err := workflowapp.New(peer, c, c)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func workflowTaskExactNew(t *testing.T, provider task.Provider, action control.Action) (*taskRuntimeTestFixture, *workflowTaskExactPeer, *workflowapp.Service, wf.Plan) {
	t.Helper()
	f := taskRuntimeTestNewFixture(t, provider)
	if action == control.Cancel {
		f.provider.caps.Cancel = true // Controlled capability, not Codex transport evidence.
		f.provider.observed = port.Observation{Reference: f.provider.steps[0].reference, Lifecycle: task.Running}
		f.provider.steps = append(f.provider.steps, taskRuntimeTestStep{action: task.Cancel, operation: "cancel-1", expected: f.provider.steps[0].reference, reference: f.provider.steps[0].reference, lifecycle: task.Running, cancel: true})
	}
	peer := &workflowTaskExactPeer{f: f}
	s := workflowTaskExactService(t, peer)
	p := wf.Plan{ID: "workflow", Parent: wf.Parent{ThreadID: "parent", TurnID: "parent-turn"}, Steps: []wf.Step{{ID: "child", TaskID: "task", OperationID: "create-1", CancelOperationID: "cancel-1", DeliveryOperationID: "deliver-1", Required: []wf.Capability{wf.CapabilityCreate}, Output: wf.Output{Kind: wf.OutputText, MaxBytes: 1024}}}}
	r, err := s.Tick(taskRuntimeTestCtx, p, wf.Budget{Slots: 1, Available: map[wf.Capability]bool{wf.CapabilityCreate: true}}, workflowapp.AdmitNew)
	if err != nil || len(r.Started) != 1 || r.Started[0] != "child" || f.provider.effects != 1 {
		t.Fatalf("controlled Workflow create: %+v, %v, effects=%d", r, err, f.provider.effects)
	}
	return f, peer, s, p
}
func workflowTaskExactCall(t *testing.T, s *workflowapp.Service, p wf.Plan, action control.Action) workflowapp.Progress {
	t.Helper()
	var r workflowapp.Report
	var err error
	if action == control.Cancel {
		r, err = s.Cancel(taskRuntimeTestCtx, p)
	} else {
		r, err = s.Deliver(taskRuntimeTestCtx, p)
	}
	if err != nil || len(r.Steps) != 1 {
		t.Fatalf("Workflow report: %+v %v", r, err)
	}
	return r.Steps[0]
}
func workflowTaskExactRequireGuard(t *testing.T, f *taskRuntimeTestFixture, q workflowapp.Target) port.Operation {
	t.Helper()
	op, err := f.journal.Lookup(taskRuntimeTestCtx, q.OperationID)
	if err != nil || op == nil || op.Intent.ExactDispatchID != q.ExpectedDispatchID || op.Intent.Expected != task.Reference(q.Reference) || !task.ID(op.Intent.Digest) {
		t.Fatalf("original exact intent not retained: %+v %v target=%+v", op, err, q)
	}
	return *op
}

func TestWorkflowTaskExactFreshFullTarget(t *testing.T) {
	for _, provider := range []task.Provider{task.Codex, task.Claude} {
		for _, action := range []control.Action{control.Cancel, control.Deliver} {
			t.Run(string(provider)+"/"+string(action), func(t *testing.T) {
				f, peer, s, p := workflowTaskExactNew(t, provider, action)
				row := workflowTaskExactCall(t, s, p, action)
				q := peer.lastTarget
				if q.TaskID != "task" || q.OperationID != string(action)+"-1" || q.ExpectedDispatchID != "create-1" || task.Reference(q.Reference) != f.provider.steps[0].reference || peer.lastFailure != nil || peer.mutations != 1 {
					t.Fatalf("wrong full consumer target: %+v %v", q, peer.lastFailure)
				}
				op := workflowTaskExactRequireGuard(t, f, q)
				if !op.Settled || op.Receipt.State != task.Known {
					t.Fatalf("original receipt: %+v", op)
				}
				if action == control.Cancel {
					if row.State != wf.Running || !row.CancelRequested || row.Cancellation != workflowapp.CancellationAcknowledged || f.provider.effects != 2 || f.delivery.calls != 0 {
						t.Fatalf("cancel ACK is not terminal: %+v", row)
					}
				} else if row.State != wf.Completed || !row.Accepted || row.Delivery != workflowapp.DeliveryAcknowledged || f.provider.effects != 1 || f.delivery.calls != 1 {
					t.Fatalf("independent delivery receipt missing: %+v", row)
				}
			})
		}
	}
}

func TestWorkflowTaskExactRejectsSuccessorBetweenReadAndMutation(t *testing.T) {
	for _, provider := range []task.Provider{task.Codex, task.Claude} {
		for _, action := range []control.Action{control.Cancel, control.Deliver} {
			t.Run(string(provider)+"/"+string(action), func(t *testing.T) {
				f, peer, s, p := workflowTaskExactNew(t, provider, action)
				var successor port.Snapshot
				peer.before = func() {
					// Force another owner-selected caller to finish/continue between the
					// Workflow read and exact control. Channel completion orders all fixture
					// access; the target still came from the original Workflow read.
					done := make(chan struct{})
					go func() {
						defer close(done)
						old := f.provider.steps[0].reference
						f.provider.observed = port.Observation{Reference: old, Lifecycle: task.Completed, Result: "retained result"}
						if _, err := f.facade.Result(taskRuntimeTestCtx, control.TaskRequest{TaskID: "task"}); err != nil {
							t.Error(err)
							return
						}
						next := taskRuntimeTestRef(provider, "turn-2", "follow-2")
						follow := task.Continue
						if provider == task.Claude {
							follow = task.Resume
						}
						f.provider.steps = f.provider.steps[:1]
						f.provider.steps = append(f.provider.steps, taskRuntimeTestStep{action: follow, operation: "follow-2", message: "follow-up", expected: old, reference: next, lifecycle: task.Running})
						f.selectRoute(2)
						var err error
						if provider == task.Codex {
							_, err = f.facade.ContinueExact(taskRuntimeTestCtx, control.ContinueExactRequest{OperationID: "follow-2", TaskID: "task", Message: "follow-up", ExpectedDispatchID: "create-1"})
						} else {
							_, err = f.facade.ResumeExact(taskRuntimeTestCtx, control.ResumeExactRequest{OperationID: "follow-2", TaskID: "task", Message: "follow-up", ExpectedDispatchID: "create-1"})
						}
						if err != nil {
							t.Error(err)
						}
						successor = *f.journal.snapshot
					}()
					<-done
				}
				row := workflowTaskExactCall(t, s, p, action)
				taskRuntimeTestRequireFailure(t, peer.lastFailure, "TASK_IDENTITY_MISMATCH")
				if successor.Task.DispatchID != "follow-2" || *f.journal.snapshot != successor || f.provider.effects != 2 || f.delivery.calls != 0 {
					t.Fatalf("stale consumer changed successor: %+v %+v", successor, f.journal.snapshot)
				}
				if op, _ := f.journal.Lookup(taskRuntimeTestCtx, string(action)+"-1"); op != nil {
					t.Fatalf("stale target admitted auxiliary intent: %+v", op)
				}
				if peer.lastTarget.ExpectedDispatchID != "create-1" || task.Reference(peer.lastTarget.Reference) != f.provider.steps[0].reference || row.Cancellation == workflowapp.CancellationAcknowledged || row.Delivery == workflowapp.DeliveryAcknowledged {
					t.Fatalf("stale target manufactured acknowledgement: %+v %+v", peer.lastTarget, row)
				}
			})
		}
	}
}

func TestWorkflowTaskExactRetainedGuardReconnect(t *testing.T) {
	for _, action := range []control.Action{control.Cancel, control.Deliver} {
		for _, state := range []task.ReceiptState{task.Known, task.Rejected, task.Uncertain} {
			t.Run(string(action)+"/"+string(state), func(t *testing.T) {
				f, peer, s, p := workflowTaskExactNew(t, task.Codex, action)
				if action == control.Cancel {
					f.provider.steps[1].lostAck = state == task.Uncertain
					if state == task.Rejected {
						f.provider.steps[1].rejection = "CANCEL_REFUSED"
					}
				} else {
					f.delivery.lostAck = state == task.Uncertain
					f.delivery.refused = state == task.Rejected
				}
				first := workflowTaskExactCall(t, s, p, action)
				q := peer.lastTarget
				original := workflowTaskExactRequireGuard(t, f, q)
				if original.Receipt.State != state {
					t.Fatalf("wrong original receipt: %+v", original)
				}
				effects, sends, reads := f.provider.effects, f.delivery.calls, f.provider.reads
				// New real repository Owner/Route and service over the SAME retained CPU
				// backing store. No operation repair, new epoch, or physical-disk claim.
				var err error
				f.owner, err = taskrepo.New(f.journal, "task")
				if err != nil {
					t.Fatal(err)
				}
				f.selectRoute(1)
				reconnected := &workflowTaskExactPeer{f: f}
				row := workflowTaskExactCall(t, workflowTaskExactService(t, reconnected), p, action)
				expected := first
				if action == control.Cancel && state == task.Uncertain {
					// The original in-call projection was running; recovery sees Task's
					// unsettled cancellation fence and conservatively reports unknown.
					expected.State = wf.Unknown
				}
				if row != expected || reconnected.mutations != 0 || f.provider.effects != effects || f.delivery.calls != sends {
					t.Fatalf("reconnect changed receipt/repeated effect: before=%+v after=%+v calls=%d", first, row, reconnected.mutations)
				}
				var replay workflowapp.Record
				if action == control.Cancel {
					replay, err = reconnected.Cancel(taskRuntimeTestCtx, q)
				} else {
					replay, err = reconnected.Deliver(taskRuntimeTestCtx, q)
				}
				if err != nil || replay.State != workflowapp.ReceiptState(state) || f.provider.effects != effects || f.delivery.calls != sends {
					t.Fatalf("exact original replay: %+v %v", replay, err)
				}
				// Same operation key cannot substitute either target identity.
				changed := []workflowapp.Target{q, q}
				changed[0].Reference.TurnID = "changed-turn"
				changed[1].ExpectedDispatchID = "changed-dispatch"
				for _, target := range changed {
					if action == control.Cancel {
						_, err = reconnected.Cancel(taskRuntimeTestCtx, target)
					} else {
						_, err = reconnected.Deliver(taskRuntimeTestCtx, target)
					}
					taskRuntimeTestRequireFailure(t, err, "TASK_OPERATION_CONFLICT")
				}
				if retained, _ := f.journal.Lookup(taskRuntimeTestCtx, q.OperationID); retained == nil || !reflect.DeepEqual(*retained, original) || f.provider.effects != effects || f.delivery.calls != sends {
					t.Fatalf("changed target altered original fingerprint/receipt: %+v", retained)
				}
				if state == task.Uncertain && f.provider.reads != reads {
					t.Fatal("UNKNOWN reconnect called provider observation")
				}
			})
		}
	}
}

func TestWorkflowTaskExactUnavailableCancelDoesNotAdmit(t *testing.T) {
	f, peer, s, p := workflowTaskExactNew(t, task.Codex, control.Cancel)
	f.provider.caps.Cancel = false // Scripted unsupported capability; no live transport.
	row := workflowTaskExactCall(t, s, p, control.Cancel)
	taskRuntimeTestRequireFailure(t, peer.lastFailure, "TASK_CAPABILITY_UNAVAILABLE")
	if op, _ := f.journal.Lookup(taskRuntimeTestCtx, "cancel-1"); op != nil || f.provider.effects != 1 || f.delivery.calls != 0 || row.Cancellation != workflowapp.CancellationPending || row.CancelRequested {
		t.Fatalf("unsupported cancellation acquired an effect/receipt: %+v %+v", op, row)
	}
}
