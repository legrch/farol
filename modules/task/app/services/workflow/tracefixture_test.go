//go:build darwin || linux

package workflow_test

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/contracts/control"
	task "github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

// This explicit input port supplies the SAME original plan after each test
// reconstruction. It holds synthetic input in memory, not a new durable store.
// It proves only the consumer of a trusted plan owner; production activation is
// still an external owner seam. No Task progress is copied into this owner.
type tracePlanOwner interface {
	Original(context.Context) (wf.Plan, error)
}
type controlledTracePlanOwner struct{ original wf.Plan }

func (p controlledTracePlanOwner) Original(ctx context.Context) (wf.Plan, error) {
	if err := ctx.Err(); err != nil {
		return wf.Plan{}, err
	}
	return wf.Capture(p.original)
}
func newTracePlanOwner(t *testing.T) tracePlanOwner {
	t.Helper()
	p := fixturePlan("a", "b", "c")
	p.Steps[2].Dependencies = []string{"a", "b"}
	original, err := wf.Capture(p)
	if err != nil {
		t.Fatal(err)
	}
	return controlledTracePlanOwner{original: original}
}
func originalTracePlan(t *testing.T, owner tracePlanOwner) wf.Plan {
	t.Helper()
	p, err := owner.Original(testContext)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func reopenTrace(t *testing.T, f *composition, owner tracePlanOwner) {
	t.Helper()
	p := originalTracePlan(t, owner)
	if !reflect.DeepEqual(p, f.plan) {
		t.Fatal("reconstruction replaced the original immutable plan")
	}
	f.plan = p
	f.reopen()
}

type traceCounts struct {
	provider map[string]int
	parent   map[string]int
}

// The probe observes, never approves or blocks a provider request. Transient
// test evidence is captured at the actual C Dispatch boundary, before returning
// to the workflow; a later settlement cannot repair a premature request witness.
type traceEffectProbe struct {
	mu       sync.Mutex
	requests [][]port.Operation
}
type traceProbeProvider struct {
	port.Provider
	journal port.Journal
	probe   *traceEffectProbe
}

func (p *traceProbeProvider) Dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	if d.Intent.OperationID == "create-c" {
		var originals []port.Operation
		for _, id := range []string{"create-a", "create-b"} {
			op, err := p.journal.Lookup(ctx, id)
			if err == nil && op != nil {
				originals = append(originals, *op)
			}
		}
		p.probe.mu.Lock()
		p.probe.requests = append(p.probe.requests, originals)
		p.probe.mu.Unlock()
	}
	return p.Provider.Dispatch(ctx, d, progress)
}
func (p *traceEffectProbe) validRequests() (int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, originals := range p.requests {
		if len(originals) != 2 {
			return len(p.requests), false
		}
		for i, id := range []string{"a", "b"} {
			op := originals[i]
			if op.Intent.TaskID != "task-"+id || op.Intent.OperationID != "create-"+id || op.Intent.Action != task.Create || op.Intent.Parent != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) || !op.Settled || op.Receipt.State != task.Known || op.Receipt.Lifecycle != task.Completed || op.Receipt.Result != strings.ToUpper(id) || op.Receipt.Reference != (task.Reference{ThreadID: "provider-task-" + id, TurnID: "create-" + id}) {
				return len(p.requests), false
			}
		}
	}
	return len(p.requests), true
}
func newTraceComposition(t *testing.T, owner tracePlanOwner) *composition {
	t.Helper()
	f := newComposition(t, originalTracePlan(t, owner))
	f.trace = &traceEffectProbe{}
	for id, child := range f.tasks.children {
		provider := &traceProbeProvider{Provider: f.provider, journal: f.journal, probe: f.trace}
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
	return f
}

// This cut hides the observation BEFORE writing its result. Reopen may poll the
// original positively-known running operation again; it cannot redispatch it.
type traceBeforeResultRecord struct {
	port.SelectedJournal
	fired bool
}

func (j *traceBeforeResultRecord) Observe(ctx context.Context, before port.Snapshot, next task.Task) error {
	if !j.fired {
		j.fired = true
		return task.ErrUnknown
	}
	return j.SelectedJournal.Observe(ctx, before, next)
}
func cutTraceBeforeResult(t *testing.T, f *composition, taskID string) *traceBeforeResultRecord {
	t.Helper()
	child := f.tasks.children[taskID]
	cut := &traceBeforeResultRecord{SelectedJournal: child.route}
	provider := &traceProbeProvider{Provider: f.provider, journal: f.journal, probe: f.trace}
	service, err := tasksvc.NewOwned(cut, f.authority, map[task.Provider]port.Provider{task.Codex: provider}, f.delivery, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	facade, err := control.New(service)
	if err != nil {
		t.Fatal(err)
	}
	child.service, child.facade = service, facade
	f.tasks.children[taskID] = child
	return cut
}

func countTraceEffects(f *composition) traceCounts {
	c := traceCounts{provider: map[string]int{}, parent: map[string]int{}}
	for _, d := range f.provider.dispatches {
		c.provider[d.Intent.OperationID]++
	}
	for _, d := range f.delivery.sends {
		c.parent[d.operationID]++
	}
	return c
}

// The reference invariant compares actual provider/parent IO logs against the
// fixed plan, and the actual retained operations against aggregation admission.
// It is separate from the workflow's Report and uses no guessed missing state.
func assertTraceSafety(t *testing.T, f *composition, owner tracePlanOwner) traceCounts {
	t.Helper()
	p := originalTracePlan(t, owner)
	counts := countTraceEffects(f)
	if f.trace == nil {
		t.Fatal("trace is missing the effect-boundary dependency probe")
	}
	if n, valid := f.trace.validRequests(); !valid || n != counts.provider["create-c"] {
		t.Fatalf("aggregation was requested before original results were retained: witnesses=%d valid=%t effects=%+v", n, valid, counts)
	}
	for _, n := range counts.provider {
		if n > 1 {
			t.Fatalf("provider effect replayed: %+v", counts)
		}
	}
	for _, n := range counts.parent {
		if n > 1 {
			t.Fatalf("parent effect replayed: %+v", counts)
		}
	}
	for _, d := range f.provider.dispatches {
		var step wf.Step
		for _, s := range p.Steps {
			if s.TaskID == d.Intent.TaskID {
				step = s
			}
		}
		if step.ID == "" || (d.Intent.Action != task.Create && d.Intent.Action != task.Cancel) || d.Intent.Parent != (task.Parent{ThreadID: p.Parent.ThreadID, TurnID: p.Parent.TurnID}) ||
			(d.Intent.Action == task.Create && d.Intent.OperationID != step.OperationID) ||
			(d.Intent.Action == task.Cancel && (d.Intent.OperationID != step.CancelOperationID || d.Intent.Expected != (task.Reference{ThreadID: "provider-" + step.TaskID, TurnID: step.OperationID}))) {
			t.Fatalf("effect escaped original identity/parent: %+v", d)
		}
		if step.ID == "c" && d.Intent.Action == task.Create {
			for _, dependency := range p.Steps[:2] {
				op, err := f.journal.Lookup(testContext, dependency.OperationID)
				if err != nil || op == nil || !op.Settled || op.Receipt.State != task.Known || op.Receipt.Lifecycle != task.Completed || op.Receipt.Result != strings.ToUpper(dependency.ID) {
					t.Fatalf("aggregation consumed unacknowledged original result: %+v %v", op, err)
				}
			}
			if d.Message != "A+B" {
				t.Fatalf("aggregation consumed different outputs: %q", d.Message)
			}
		}
	}
	for _, send := range f.delivery.sends {
		var step wf.Step
		for _, s := range p.Steps {
			if s.DeliveryOperationID == send.operationID {
				step = s
			}
		}
		if step.ID == "" || send.parent != (task.Parent{ThreadID: p.Parent.ThreadID, TurnID: p.Parent.TurnID}) || send.reference != (task.Reference{ThreadID: "provider-" + step.TaskID, TurnID: step.OperationID}) {
			t.Fatalf("delivery escaped original identity/parent: %+v", send)
		}
	}
	return counts
}
