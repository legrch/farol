package claude

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/domain"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

// Existing strict process oracle plus an independent startup-context witness.
type startupTestProcess struct{ *hostTestProcess }

func (p startupTestProcess) Read(ctx context.Context, q port.ClaudeRead) (port.ClaudeObservation, error) {
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > 2*time.Second {
		p.t.Fatal("startup Read lacks fixed deadline")
	}
	return p.hostTestProcess.Read(ctx, q)
}
func TestStartupKnownEmptyRunningWaitsForMatchingInitOnSameHandle(t *testing.T) {
	for _, action := range []task.Action{task.Create, task.Resume} {
		t.Run(string(action), func(t *testing.T) {
			f := hostTestNew(t, hostTestFrame{}, hostTestFrame{data: fixtureInit[:19]}, hostTestFrame{data: fixtureInit[19:]})
			if action == task.Resume {
				f.selection.Scope.TaskEpoch = 2
				f.selection.Scope.TurnID = "turn-2"
				f.process.operation = "resume-2"
				f.process.resume = true
				f.dispatch = fixtureDispatch(f.selection)
				f.dispatch.Intent.OperationID = "resume-2"
				f.dispatch.Intent.Action = task.Resume
				f.dispatch.Intent.Expected = task.Reference{SessionID: fixtureSession, InvocationID: "old-operation"}
				f.host = f.buildHost()
			}
			f.host.process = startupTestProcess{f.process}
			pauses := 0
			f.host.startupPause = func(ctx context.Context) error {
				pauses++
				if _, ok := ctx.Deadline(); !ok || f.process.reads != 1 || f.process.starts != 1 || f.progressCalls != 0 {
					t.Fatal("idle range spun, relaunched or invented init")
				}
				return nil // deterministic CPU pause seam, no native qualification
			}
			r, err := f.start()
			if err != nil || r.State != task.Known || r.Lifecycle != task.Running || pauses != 1 || f.process.prepares != 1 || f.process.starts != 1 || f.process.reads != 3 || f.progressCalls != 1 || len(f.events) != 1 || r.Reference.SessionID != fixtureSession || r.Reference.InvocationID != f.process.operation {
				t.Fatal(r, err, pauses)
			}
			reads := f.process.reads
			_, _ = f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
			if f.process.starts != 1 || f.process.reads != reads {
				t.Fatal("startup replay restarted child")
			}
		})
	}
}
func TestStartupCancellationWhileIdleRetainsUnknownWithoutSignalOrRelaunch(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{})
	f.host.process = startupTestProcess{f.process}
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	waiting := make(chan struct{})
	done := make(chan struct {
		r   task.Receipt
		err error
	}, 1)
	f.host.startupPause = func(ctx context.Context) error { close(waiting); <-ctx.Done(); return ctx.Err() }
	go func() {
		r, err := f.host.DispatchObserved(parent, f.dispatch, f.record, f.event)
		done <- struct {
			r   task.Receipt
			err error
		}{r, err}
	}()
	select {
	case <-waiting:
	case <-time.After(time.Second):
		t.Fatal("did not enter caller-driven idle wait")
	}
	cancel()
	var out struct {
		r   task.Receipt
		err error
	}
	select {
	case out = <-done:
	case <-time.After(time.Second):
		t.Fatal("caller cancellation did not end wait")
	}
	if out.r.State != task.Uncertain || !errors.Is(out.err, task.ErrUnknown) || f.process.prepares != 1 || f.process.starts != 1 || f.process.reads != 1 || f.process.cancels != 0 || f.progressCalls != 0 {
		t.Fatal(out.r, out.err)
	}
	_, _ = f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
	if f.process.starts != 1 || f.process.reads != 1 {
		t.Fatal("cancelled startup retried")
	}
}
func TestStartupCallerDeadlineIsEarlierAndNeverReset(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{})
	f.host.process = startupTestProcess{f.process}
	parent, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	wanted, _ := parent.Deadline()
	calls := 0
	f.host.startupPause = func(ctx context.Context) error {
		calls++
		actual, ok := ctx.Deadline()
		if !ok || !actual.Equal(wanted) {
			t.Fatal("caller deadline was extended", actual, wanted)
		}
		<-ctx.Done()
		if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			t.Fatal("deadline did not terminate idle wait", ctx.Err())
		}
		return ctx.Err()
	}
	r, err := f.host.Dispatch(hostTestCtxWith(parent), f.dispatch, f.record)
	if r.State != task.Uncertain || !errors.Is(err, task.ErrUnknown) || calls != 1 || f.process.starts != 1 || f.process.reads != 1 || f.progressCalls != 0 {
		t.Fatal(r, err, calls)
	}
	_, _ = f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
	if f.process.starts != 1 || f.process.reads != 1 {
		t.Fatal("deadline reset on replay")
	}
}

// No context substitution; named helper makes the exact caller path explicit.
func hostTestCtxWith(ctx context.Context) context.Context { return ctx }
func TestStartupUnknownRefusedOrChangedAuthorityCannotResumeObservation(t *testing.T) {
	for _, where := range []string{"unknown-read", "refused-read", "foreign-handle", "foreign-session", "authority-change", "exited-root"} {
		t.Run(where, func(t *testing.T) {
			f := hostTestNew(t, hostTestFrame{}, hostTestFrame{data: fixtureInit})
			pauses := 0
			f.host.startupPause = func(context.Context) error {
				pauses++
				switch where {
				case "unknown-read":
					f.process.readError = errors.New("private unknown output")
				case "refused-read":
					f.process.readError = &port.ClaudeProcessFailure{Code: "READ_REFUSED", Outcome: "refused", Retry: "never"}
				case "foreign-handle":
					f.process.frames[1].change = func(r *port.ClaudeObservation) { r.Handle = "other-child" }
				case "foreign-session":
					f.process.frames[1].data = `{"type":"system","subtype":"init","session_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","cwd":"/fixture/writer","model":"fixture-model-a","permissionMode":"default"}` + "\n"
				case "authority-change":
					f.gateError = task.ErrIdentity
				case "exited-root":
					f.process.frames[1].data = ""
					f.process.frames[1].final = true
				}
				return nil
			}
			r, err := f.start()
			if r.State != task.Uncertain || !errors.Is(err, task.ErrUnknown) || pauses != 1 || f.process.prepares != 1 || f.process.starts != 1 || f.progressCalls != 0 {
				t.Fatal("invalid read recovered", r, err, pauses)
			}
			reads := f.process.reads
			_, _ = f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
			if f.process.starts != 1 || f.process.reads != reads {
				t.Fatal("unknown/refused output retried")
			}
			if where == "authority-change" && reads != 1 {
				t.Fatal("changed authority reached another Read")
			}
		})
	}
}
func TestStartupRealCancellableTimerPreventsIdleSpin(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{}, hostTestFrame{}, hostTestFrame{data: fixtureInit})
	started := time.Now()
	r, err := f.start()
	if err != nil || r.State != task.Known || f.process.reads != 3 || f.process.starts != 1 || time.Since(started) < 50*time.Millisecond {
		t.Fatal("idle snapshots spun instead of pausing", r, err, time.Since(started))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := hostStartupPause(ctx); err == nil {
		t.Fatal("cancelled timer accepted")
	}
}
func TestStartupActualTaskServiceRetainsDelayedInitWithoutUnknownFence(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{}, hostTestFrame{data: fixtureInit}, hostTestFrame{data: fixtureResult, final: true})
	f.host.output = nil
	f.host.startupPause = func(ctx context.Context) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return nil
	}
	j := &hostTestJournal{ops: map[string]port.Operation{}}
	owner, err := taskrepo.New(j, "task")
	if err != nil {
		t.Fatal(err)
	}
	a := &hostTestAuthority{binding: f.selection.Binding}
	svc := hostTestService(t, owner, f.selection, f.host, a)
	created, err := svc.Create(hostTestCtx, hostTestCreateRequest(f.selection))
	if err != nil || created.Receipt.State != task.Known || created.Receipt.Lifecycle != task.Running {
		t.Fatal("known empty-running became unknown admission", created, err)
	}
	result, err := svc.Result(hostTestCtx, tasksvc.ResultRequest{TaskID: "task"})
	if err != nil || !result.Retained || result.Text != "fixture final" {
		t.Fatal(result, err)
	}
	events, err := svc.Execution(hostTestCtx, tasksvc.ExecutionRequest{TaskID: "task", DispatchID: "operation", Limit: 4, IncludeResult: true})
	if err != nil || events.Pending || !events.Retained || len(events.Page.Events) != 2 || events.Delivery != "not_observed" {
		t.Fatal(events, err)
	}
	if f.process.prepares != 1 || f.process.starts != 1 || f.process.reads != 3 {
		t.Fatal("delayed init duplicated execution")
	}
}
