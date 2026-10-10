//go:build darwin || linux

package workflow_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	app "github.com/legrch/farol/modules/task/app/services/workflow"
	"github.com/legrch/farol/modules/task/contracts/control"
	task "github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

func TestCompositionAuditStaleCancellationCannotAffectActiveFollowup(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	if _, err := f.workflow.Cancel(testContext, f.plan); err != nil {
		t.Fatal(err)
	}
	f.provider.settle("task-a", "create-a", task.Interrupted, "")
	if row := progress(t, f.tick(1, app.Reconnect), "a"); row.State != wf.Cancelled || !row.CancelRequested {
		t.Fatalf("original cancellation: %+v", row)
	}
	// Explicit workflow delivery delegates this terminal interruption to the
	// actual Task owner before the supported continuation; it accepts no output.
	delivery, err := f.workflow.Deliver(testContext, f.plan)
	if err != nil || progress(t, delivery, "a").Delivery != app.DeliveryAcknowledged || progress(t, delivery, "a").Accepted {
		t.Fatalf("terminal delivery: %+v %v", delivery, err)
	}
	f.selectFollowup("task-a", "continue-a", 2)
	followup, err := f.workflow.Follow(testContext, f.plan, "a", app.Followup{TaskID: "task-a", OperationID: "continue-a", ExpectedDispatchID: "create-a", Message: "explicit next turn"})
	if err != nil || followup.Outcome != wf.Running || followup.State != app.Known {
		t.Fatalf("new dispatch: %+v %v", followup, err)
	}
	before, err := f.journal.Read(testContext, "task-a")
	if err != nil {
		t.Fatal(err)
	}
	if before.Task.DispatchID != "continue-a" || before.Task.CancelRequested || before.Task.Admission.State != task.AdmissionActive {
		t.Fatalf("followup retained old cancellation: %+v", before)
	}
	count := len(f.provider.dispatches)
	old, err := f.tasks.Read(testContext, "task-a", "create-a")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := f.tasks.Cancel(testContext, app.Target{TaskID: "task-a", OperationID: "cancel-a", ExpectedDispatchID: "create-a", Reference: old.Reference}); !errors.Is(err, app.ErrIdentity) {
			t.Fatalf("stale target accepted: %v", err)
		}
		if _, err := f.workflow.Cancel(testContext, f.plan); err != nil {
			t.Fatal(err)
		}
	}
	after, err := f.journal.Read(testContext, "task-a")
	if err != nil {
		t.Fatal(err)
	}
	if *after != *before || len(f.provider.dispatches) != count {
		t.Fatalf("stale cancellation changed active followup: before=%+v after=%+v dispatches=%d/%d", before, after, count, len(f.provider.dispatches))
	}
	retained, err := f.tasks.Read(testContext, "task-a", "cancel-a")
	if err != nil || retained.State != app.Known || retained.Reference != old.Reference {
		t.Fatalf("original cancellation evidence changed: %+v %v", retained, err)
	}
}

func TestCompositionAuditDuplicateKnownDeliveryACKSendsExactlyOnce(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.tick(1, app.Reconnect)
	first, err := f.workflow.Deliver(testContext, f.plan)
	if err != nil {
		t.Fatal(err)
	}
	if progress(t, first, "a").Delivery != app.DeliveryAcknowledged {
		t.Fatalf("first ACK: %+v", first)
	}
	op, err := f.journal.Lookup(testContext, "deliver-a")
	if err != nil || op == nil || !op.Settled || op.Receipt.State != task.Known || op.Intent.Parent != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) {
		t.Fatalf("durable ACK: %+v %v", op, err)
	}
	for reopen := range 2 {
		if reopen == 1 {
			f.reopen()
		}
		for range 2 {
			r, err := f.workflow.Deliver(testContext, f.plan)
			if err != nil {
				t.Fatal(err)
			}
			if progress(t, r, "a").Delivery != app.DeliveryAcknowledged {
				t.Fatalf("duplicate projection: %+v", r)
			}
			// The actual Task operation replay also returns only retained evidence.
			ack, err := f.tasks.children["task-a"].service.Deliver(testContext, tasksvc.DeliverRequest{TaskID: "task-a", OperationID: "deliver-a"})
			if err != nil || ack.Receipt != op.Receipt {
				t.Fatalf("duplicate owner ACK: %+v %v", ack, err)
			}
		}
	}
	if len(f.delivery.sends) != 1 || len(f.provider.dispatches) != 1 {
		t.Fatalf("known receipt repeated effects: sends=%d dispatches=%d", len(f.delivery.sends), len(f.provider.dispatches))
	}
}

func TestCompositionAuditPartialProjectionReopensAcceptedSiblings(t *testing.T) {
	for _, first := range []string{"a", "b"} {
		t.Run(first+"-first", func(t *testing.T) {
			p := fixturePlan("a", "b", "c")
			p.Steps[2].Dependencies = []string{"a", "b"}
			f := newComposition(t, p)
			f.tick(2, app.AdmitNew)
			output := map[string]string{"a": "A", "b": "B"}
			other := "b"
			if first == "b" {
				other = "a"
			}
			f.provider.settle("task-"+first, "create-"+first, task.Completed, output[first])
			partial := f.tick(2, app.AdmitNew)
			if !progress(t, partial, first).Accepted || progress(t, partial, other).Accepted || len(partial.Started) != 0 {
				t.Fatalf("partial projection: %+v", partial)
			}
			f.provider.settle("task-"+other, "create-"+other, task.Completed, output[other])
			f.faults.observe = true
			ambiguous := f.tick(2, app.AdmitNew)
			if !progress(t, ambiguous, first).Accepted || progress(t, ambiguous, other).State != wf.Unknown || len(ambiguous.Started) != 0 {
				t.Fatalf("ambiguous sibling projection: %+v", ambiguous)
			}
			f.reopen()
			reads := f.provider.reads
			recovered := f.tick(2, app.AdmitNew)
			if !progress(t, recovered, "a").Accepted || !progress(t, recovered, "b").Accepted || !reflect.DeepEqual(recovered.Started, []string{"c"}) {
				t.Fatalf("recovered siblings: %+v", recovered)
			}
			if f.provider.reads != reads || len(f.provider.dispatches) != 3 || f.provider.dispatches[2].Message != "A+B" {
				t.Fatalf("retained outputs replayed or lost: reads=%d/%d dispatches=%+v", reads, f.provider.reads, f.provider.dispatches)
			}
			f.provider.settle("task-c", "create-c", task.Completed, "A+B")
			if !progress(t, f.tick(2, app.Reconnect), "c").Accepted {
				t.Fatal("aggregation did not settle")
			}
			f.reopen()
			for range 2 {
				if r := f.tick(2, app.AdmitNew); len(r.Started) != 0 || !progress(t, r, "c").Accepted {
					t.Fatalf("restored aggregation: %+v", r)
				}
			}
			if len(f.provider.dispatches) != 3 {
				t.Fatal("recovered aggregation redispatched")
			}
		})
	}
}

// The fixture's provider has intentionally simple mutable counters. This
// test-local adapter serializes access to those controls while two independent
// actual Task owners retain their terminal observations concurrently. It does
// not prove concurrent workflow admission or a production resource guard.
type auditSynchronizedProvider struct {
	mu               sync.Mutex
	provider         *controlledProvider
	terminalArrivals map[task.Reference]bool
	arrivalCount     int
	allArrived       chan struct{}
}

func (p *auditSynchronizedProvider) Supports(ctx context.Context, b task.Binding) (task.Capabilities, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.provider.Supports(ctx, b)
}
func (p *auditSynchronizedProvider) Dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.provider.Dispatch(ctx, d, progress)
}
func (p *auditSynchronizedProvider) Observe(ctx context.Context, b task.Binding, ref task.Reference) (port.Observation, error) {
	// Both selected services must enter observation before either receives its
	// terminal reply. This barrier does not hold the controlled provider lock.
	p.mu.Lock()
	var release <-chan struct{}
	if arrived, expected := p.terminalArrivals[ref]; expected {
		if !arrived {
			p.terminalArrivals[ref] = true
			p.arrivalCount++
			if p.arrivalCount == len(p.terminalArrivals) {
				close(p.allArrived)
			}
		}
		release = p.allArrived
	}
	p.mu.Unlock()
	if release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return port.Observation{}, ctx.Err()
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.provider.Observe(ctx, b, ref)
}

func TestCompositionAuditConcurrentIndependentResultsAggregateOnce(t *testing.T) {
	p := fixturePlan("a", "b", "c")
	p.Steps[2].Dependencies = []string{"a", "b"}
	f := newComposition(t, p)
	f.tick(2, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.provider.settle("task-b", "create-b", task.Completed, "B")
	provider := &auditSynchronizedProvider{provider: f.provider, allArrived: make(chan struct{}), terminalArrivals: map[task.Reference]bool{
		{ThreadID: "provider-task-a", TurnID: "create-a"}: false,
		{ThreadID: "provider-task-b", TurnID: "create-b"}: false,
	}}
	for id, child := range f.tasks.children {
		service, err := tasksvc.NewOwned(child.route, f.authority, map[task.Provider]port.Provider{task.Codex: provider}, f.delivery, intent.Fingerprint, providerclient.NewProgress)
		if err != nil {
			t.Fatal(err)
		}
		facade, err := control.New(service)
		if err != nil {
			t.Fatal(err)
		}
		child.service, child.facade = service, facade
		f.tasks.children[id] = child
	}
	type arrival struct {
		taskID string
		result *control.ResultResponse
		err    error
	}
	start := make(chan struct{})
	arrivals := make(chan arrival, 2)
	ctx, cancel := context.WithTimeout(testContext, 3*time.Second)
	defer cancel()
	for _, id := range []string{"task-a", "task-b"} {
		facade := f.tasks.children[id].facade
		go func() {
			<-start
			result, err := facade.Result(ctx, control.TaskRequest{TaskID: id})
			arrivals <- arrival{id, result, err}
		}()
	}
	close(start)
	// Drain both callers before asserting so a failed witness cannot race
	// fixture cleanup against an outstanding selected Task observation.
	results := []arrival{<-arrivals, <-arrivals}
	for _, got := range results {
		if got.err != nil || got.result == nil || !got.result.Retained || got.result.TaskID != got.taskID || got.result.Lifecycle != control.Completed {
			t.Fatalf("concurrent result: %+v", got)
		}
	}
	r := f.tick(2, app.AdmitNew)
	if !progress(t, r, "a").Accepted || !progress(t, r, "b").Accepted || !reflect.DeepEqual(r.Started, []string{"c"}) || len(f.provider.dispatches) != 3 || f.provider.dispatches[2].Message != "A+B" {
		t.Fatalf("concurrent result aggregation: %+v dispatches=%+v", r, f.provider.dispatches)
	}
	for range 2 {
		if r := f.tick(2, app.AdmitNew); len(r.Started) != 0 {
			t.Fatalf("aggregate relaunched: %+v", r)
		}
	}
	if len(f.provider.dispatches) != 3 {
		t.Fatal("concurrent terminal arrivals duplicated aggregation")
	}
}
