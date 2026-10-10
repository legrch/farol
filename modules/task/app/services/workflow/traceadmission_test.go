//go:build darwin || linux

package workflow_test

import (
	"context"
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

// A test-only atomic admission owner serializes reservation + callback and
// retains occupancy on an ambiguous reply. It has no durable implementation,
// background work, or production guard claim. The callback is synchronous.
type traceAtomicAdmission struct {
	mu       sync.Mutex
	parent   wf.Parent
	capacity int
	closed   bool
	occupied map[string]bool
	calls    int
}

func (a *traceAtomicAdmission) Do(ctx context.Context, parent wf.Parent, taskID string, effect func() error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.closed || parent != a.parent || a.occupied[taskID] || len(a.occupied) >= a.capacity {
		return app.ErrState
	}
	a.occupied[taskID] = true
	a.calls++
	return effect()
}

// Both callers compute the same initially ready root before either may request
// admission. This exposes a stale local-policy decision to the shared owner.
type traceComposerBarrier struct {
	app.Composer
	mu      sync.Mutex
	count   int
	arrived chan struct{}
}

func (c *traceComposerBarrier) Compose(ctx context.Context, step wf.Step, deps map[string]string) (app.Selection, string, error) {
	if step.ID == "a" {
		c.mu.Lock()
		c.count++
		if c.count == 2 {
			close(c.arrived)
		}
		c.mu.Unlock()
		select {
		case <-c.arrived:
		case <-ctx.Done():
			return app.Selection{}, "", ctx.Err()
		}
	}
	return c.Composer.Compose(ctx, step, deps)
}

// The original provider records one request and its progress reference, then
// returns a synthetic lost ACK. The gate withholds that reply from Task so
// Reconnect/Cancel can read the actual pending journal while dispatch is live.
type traceReplyGate struct {
	port.Provider
	entered chan struct{}
	release chan struct{}
}

func (p *traceReplyGate) Dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	r, err := p.Provider.Dispatch(ctx, d, progress)
	close(p.entered)
	select {
	case <-p.release:
		return r, err
	case <-ctx.Done():
		return task.Receipt{}, ctx.Err()
	}
}

func TestTraceConcurrentAdmissionAndReconnectDuringLostACK(t *testing.T) {
	owner := newTracePlanOwner(t)
	f := newTraceComposition(t, owner)
	f.provider.lostDispatchACK["task-a"] = true
	gate := &traceReplyGate{Provider: f.provider, entered: make(chan struct{}), release: make(chan struct{})}
	for id, child := range f.tasks.children {
		service, err := tasksvc.NewOwned(child.route, f.authority, map[task.Provider]port.Provider{task.Codex: gate}, f.delivery, intent.Fingerprint, providerclient.NewProgress)
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
	admission := &traceAtomicAdmission{parent: f.plan.Parent, capacity: 1, occupied: map[string]bool{}}
	composer := &traceComposerBarrier{Composer: f.composer, arrived: make(chan struct{})}
	services := make([]*app.Service, 2)
	for i := range services {
		var err error
		services[i], err = app.New(f.tasks, composer, admission)
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(testContext, 5*time.Second)
	var wg sync.WaitGroup
	var release sync.Once
	unblock := func() { release.Do(func() { close(gate.release) }) }
	defer func() { cancel(); unblock(); wg.Wait() }()
	type outcome struct {
		report app.Report
		err    error
	}
	results := make(chan outcome, 2)
	for _, service := range services {
		plan := originalTracePlan(t, owner)
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := service.Tick(ctx, plan, wf.Budget{Slots: 1, Available: map[wf.Capability]bool{wf.CapabilityCreate: true}}, app.AdmitNew)
			results <- outcome{r, err}
		}()
	}
	select {
	case <-gate.entered:
	case <-ctx.Done():
		t.Fatal("two callers did not reach the controlled dispatch boundary", ctx.Err())
	}
	reader, err := app.New(f.tasks, f.composer, admission)
	if err != nil {
		t.Fatal(err)
	}
	before := assertTraceSafety(t, f, owner)
	r, err := reader.Tick(ctx, originalTracePlan(t, owner), wf.Budget{Slots: 2, Available: map[wf.Capability]bool{wf.CapabilityCreate: true}}, app.Reconnect)
	if err != nil || len(r.Started) != 0 || progress(t, r, "a").State != wf.Unknown || progress(t, r, "b").State != wf.Unknown || progress(t, r, "c").State != wf.Unknown {
		t.Fatalf("live lost-ACK reconnect: %+v %v", r, err)
	}
	if _, err := reader.Cancel(ctx, originalTracePlan(t, owner)); err != nil {
		t.Fatal(err)
	}
	if after := assertTraceSafety(t, f, owner); !reflect.DeepEqual(after, before) {
		t.Fatal("reconnect/cancel changed pending effects", after, before)
	}
	unblock()
	outcomes := []outcome{<-results, <-results}
	wg.Wait()
	for _, result := range outcomes {
		if result.err != nil {
			t.Fatal(result.err)
		}
	}
	if admission.calls != 1 || countTraceEffects(f).provider["create-a"] != 1 || len(f.provider.dispatches) != 1 {
		t.Fatalf("stale callers exceeded global reservation: callbacks=%d effects=%+v", admission.calls, countTraceEffects(f))
	}
	reopenTrace(t, f, owner)
	original, err := f.tasks.Read(testContext, "task-a", "create-a")
	if err != nil || !original.Found || original.State != app.Unknown {
		t.Fatalf("original unknown occupancy was not retained: %+v %v", original, err)
	}
	// A fresh controlled admission owner restores its ONE reservation from the
	// original Task operation, not missing children or a workflow summary.
	restored := &traceAtomicAdmission{parent: f.plan.Parent, capacity: 1, occupied: map[string]bool{"task-a": true}}
	f.workflow, err = app.New(f.tasks, f.composer, restored)
	if err != nil {
		t.Fatal(err)
	}
	before = countTraceEffects(f)
	for _, mode := range []app.Mode{app.Reconnect, app.AdmitNew} {
		if r := f.tick(2, mode); len(r.Started) != 0 || progress(t, r, "a").State != wf.Unknown {
			t.Fatalf("restored occupancy dispatched work: %+v", r)
		}
	}
	if !reflect.DeepEqual(countTraceEffects(f), before) || restored.calls != 0 || f.provider.reads != 0 {
		t.Fatal("unknown execution or missing child restored an effect grant")
	}
	f.authority.parentClosed, restored.closed = true, true
	if r := f.tick(3, app.AdmitNew); len(r.Started) != 0 || progress(t, r, "a").State != wf.Unknown {
		t.Fatalf("revoked parent erased original fence or admitted work: %+v", r)
	}
	assertTraceSafety(t, f, owner)
}

func TestTraceMissingGlobalReservationCounterexample(t *testing.T) {
	owner := newTracePlanOwner(t)
	f := newTraceComposition(t, owner)
	f.provider.lostDispatchACK["task-a"] = true
	f.tick(1, app.AdmitNew)
	reopenTrace(t, f, owner)
	// Deliberately omit the global owner. A caller-supplied two-slot policy alone
	// permits B while A is unknown; this is a counterexample to claiming that the
	// existing simple exclusive fixture qualifies a one-slot global resource.
	r := f.tick(2, app.AdmitNew)
	if !reflect.DeepEqual(r.Started, []string{"b"}) || progress(t, r, "a").State != wf.Unknown || countTraceEffects(f).provider["create-b"] != 1 || countTraceEffects(f).provider["create-c"] != 0 {
		t.Fatalf("negative control did not expose missing global reservation: %+v %+v", r, countTraceEffects(f))
	}
	assertTraceSafety(t, f, owner)
}
