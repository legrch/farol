package boot

// Root composition only: CPU provider and journal ports, no native execution.
import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

type taskBudgetObservedTest struct {
	port.Provider
	dispatch func(context.Context, port.Dispatch, func(task.Reference) error, func(context.Context, task.ExecutionEvent) error) (task.Receipt, error)
}

func (p *taskBudgetObservedTest) DispatchObserved(ctx context.Context, d port.Dispatch, progress func(task.Reference) error, record func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
	return p.dispatch(ctx, d, progress, record)
}

type taskBudgetReadTest struct {
	port.Provider
	want context.Context
	t    *testing.T
}

func (p *taskBudgetReadTest) Observe(ctx context.Context, _ task.Binding, ref task.Reference) (port.Observation, error) {
	if ctx != p.want {
		p.t.Fatal("observation context was replaced")
	}
	return port.Observation{Reference: ref, Lifecycle: task.Running}, nil
}

func TestTaskRequestBudgetPreservesOptionalObservationAndActualReceipt(t *testing.T) {
	f := taskRuntimeTestNewFixture(t, task.Codex)
	readCtx := context.Background()
	plain := &taskBudgetReadTest{Provider: f.provider, want: readCtx, t: t}
	if _, ok := taskDeadlineProvider(plain).(port.ObservedProvider); ok {
		t.Fatal("wrapper invented observed dispatch support")
	}
	ref := taskRuntimeTestRef(task.Codex, "turn-1", "create-1")
	executionDeadline := time.Now().Add(30 * time.Millisecond)
	total, cancel := context.WithDeadline(context.Background(), executionDeadline.Add(2*time.Second))
	defer cancel()
	ctx := context.WithValue(total, taskExecutionDeadlineKey{}, executionDeadline)
	providerErr := errors.New("original lost acknowledgement")
	actual := task.Receipt{State: task.Uncertain, Reference: ref, Code: "ORIGINAL_UNKNOWN"}
	callbackCtx := context.WithValue(context.Background(), taskExecutionDeadlineKey{}, "provider observation lifetime")
	progressCalls, eventCalls, dispatchCalls := 0, 0, 0
	selected := &taskBudgetObservedTest{Provider: plain, dispatch: func(execution context.Context, d port.Dispatch, progress func(task.Reference) error, record func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
		dispatchCalls++
		deadline, _ := execution.Deadline()
		if !deadline.Equal(executionDeadline) || d.Intent.OperationID != "create-1" {
			t.Fatal("original dispatch budget or identity changed")
		}
		if err := progress(ref); err != nil {
			t.Fatal(err)
		}
		if err := record(callbackCtx, task.ExecutionEvent{}); err != nil {
			t.Fatal(err)
		}
		<-execution.Done()
		return actual, providerErr
	}}
	wrapped := taskDeadlineProvider(selected)
	observed, ok := wrapped.(port.ObservedProvider)
	if !ok {
		t.Fatal("original observed dispatch support lost")
	}
	receipt, err := observed.DispatchObserved(ctx, port.Dispatch{Intent: task.Intent{OperationID: "create-1"}}, func(got task.Reference) error {
		progressCalls++
		if got != ref {
			t.Fatal("original lineage changed")
		}
		return nil
	}, func(got context.Context, _ task.ExecutionEvent) error {
		eventCalls++
		if got != callbackCtx {
			t.Fatal("retained observation lifetime replaced")
		}
		return nil
	})
	if receipt != actual || err != providerErr || dispatchCalls != 1 || progressCalls != 1 || eventCalls != 1 || ctx.Err() != nil {
		t.Fatal("possible effect reclassified or callbacks/settlement lost", receipt, err)
	}
	observation, err := wrapped.Observe(readCtx, task.Binding{}, ref)
	if err != nil || observation.Reference != ref {
		t.Fatal(observation, err)
	}
}

func TestTaskRequestBudgetOnlyRefusesBeforeDelegation(t *testing.T) {
	f := taskRuntimeTestNewFixture(t, task.Codex)
	provider := &taskDeadlineProviderTest{Provider: f.provider, support: func(context.Context) error { return nil }, dispatch: func(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
		t.Fatal("expired dispatch called provider")
		return task.Receipt{}, nil
	}}
	observed := &taskBudgetObservedTest{Provider: provider, dispatch: func(context.Context, port.Dispatch, func(task.Reference) error, func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
		t.Fatal("expired observed dispatch called provider")
		return task.Receipt{}, nil
	}}
	for _, selected := range []port.Provider{provider, observed} {
		wrapped := taskDeadlineProvider(selected)
		total, cancel := context.WithCancel(context.Background())
		ctx := context.WithValue(total, taskExecutionDeadlineKey{}, time.Now().Add(-time.Second))
		call := func() (task.Receipt, error) {
			if p, ok := wrapped.(port.ObservedProvider); ok {
				return p.DispatchObserved(ctx, port.Dispatch{}, nil, nil)
			}
			return wrapped.Dispatch(ctx, port.Dispatch{}, nil)
		}
		receipt, err := call()
		if err != nil || receipt.State != task.Rejected || receipt.Code != "TASK_REQUEST_DEADLINE_EXPIRED" || receipt.Reference != (task.Reference{}) {
			t.Fatal("pre-effect expiry did not attest known refusal", receipt, err)
		}
		cancel()
		receipt, err = call()
		if !errors.Is(err, context.Canceled) || receipt.State == task.Rejected {
			t.Fatal("parent cancellation fabricated a refusal", receipt, err)
		}
	}
}

type taskBudgetAdmissionTest struct{ *taskDeadlineJournalTest }

func (j *taskBudgetAdmissionTest) Admit(ctx context.Context, intent task.Intent, revision uint64, prepared task.Task) (*port.Admission, error) {
	// Qualification succeeded, then admission consumed the execution remainder.
	timer := time.NewTimer(time.Until(j.execution) + 10*time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return j.taskRuntimeTestMemory.Admit(ctx, intent, revision, prepared)
}

func TestTaskRequestBudgetAdmissionWaitSettlesKnownPreEffectRefusal(t *testing.T) {
	f := taskRuntimeTestNewFixture(t, task.Codex)
	deadline := time.Now().Add(2100 * time.Millisecond).Truncate(time.Millisecond)
	journal := &taskBudgetAdmissionTest{&taskDeadlineJournalTest{taskRuntimeTestMemory: f.journal, t: t, settlement: deadline, execution: deadline.Add(-2 * time.Second)}}
	owner, err := taskrepo.New(journal, "task")
	if err != nil {
		t.Fatal(err)
	}
	route, err := owner.Select(f.route.Selection())
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	provider := &taskDeadlineProviderTest{Provider: f.provider, support: func(context.Context) error { return nil }, dispatch: func(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
		calls++
		return task.Receipt{}, errors.New("unexpected provider call")
	}}
	runtime, err := taskRuntime(TaskRuntimeInputs{Route: route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority}, provider)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel, err := taskEffectContext(context.Background(), strconv.FormatInt(deadline.UnixMilli(), 10), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	out, err := runtime.Control().Create(ctx, f.createRequest())
	if err != nil || out == nil || out.OperationID != "create-1" || out.Receipt.State != controlct.Rejected || out.Receipt.Code != "TASK_REQUEST_DEADLINE_EXPIRED" || !journal.finish || calls != 0 {
		t.Fatal("admission wait allowed effect or lost original settlement", out, err, calls)
	}
	retained, err := runtime.Control().Operation(context.Background(), controlct.OperationRequest{OperationID: "create-1"})
	if err != nil || retained.Receipt.State != controlct.Rejected || retained.Lineage != (controlct.Reference{}) || !f.journal.ops["create-1"].Settled {
		t.Fatal("original admitted refusal was not retained", retained, err)
	}
}
