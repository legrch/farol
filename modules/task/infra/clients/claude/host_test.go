package claude

// CPU-only aggregate tests. The independent scripted process owns its args,
// stdin, handle and byte-range oracle. No CLI, child, account or native grant.
import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	computerprocess "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/domain"
	progress "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
	processpeer "github.com/legrch/farol/modules/task/infra/peer/process"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

var hostTestCtx = context.Background()

type hostTestFrame struct {
	data   string
	final  bool
	change func(*port.ClaudeObservation)
}
type hostTestProcess struct {
	t                                   *testing.T
	operation                           string
	resume                              bool
	frames                              []hostTestFrame
	prepareError, startError, readError error
	preparePanic, startPanic, readPanic bool
	prepares, starts, reads, cancels    int
	stdout, stderr                      uint64
	afterPrepare, afterRead             func()
}

func (p *hostTestProcess) Prepare(_ context.Context, q port.ClaudeInvocation) (port.ClaudePreparation, error) {
	p.t.Helper()
	p.prepares++
	if p.prepares != 1 || q.OperationID != p.operation || q.RuntimeID != "fixture-runtime" || q.SessionID != fixtureSession || q.ModelID != "fixture-model-a" || q.AdmissionID != "authority-correlation" {
		p.t.Fatalf("foreign/duplicate Prepare: %+v", q)
	}
	oracle := strictFixture{resume: p.resume, effort: "high"}
	if err := oracle.submit(q.Arguments, q.Input); err != nil {
		p.t.Fatal(err)
	}
	if p.afterPrepare != nil {
		p.afterPrepare()
	}
	if p.preparePanic {
		panic("private preparation diagnostic")
	}
	if p.prepareError != nil {
		return port.ClaudePreparation{}, p.prepareError
	}
	return port.ClaudePreparation{OperationID: q.OperationID, RuntimeID: q.RuntimeID, SessionID: q.SessionID, ModelID: q.ModelID, AdmissionID: q.AdmissionID, Digest: strings.Repeat("a", 64)}, nil
}
func (p *hostTestProcess) Start(_ context.Context, op string) (string, error) {
	p.starts++
	if p.starts != 1 || op != p.operation {
		p.t.Fatal("foreign/duplicate Start")
	}
	if p.startPanic {
		panic("private start diagnostic")
	}
	if p.startError != nil {
		return "", p.startError
	}
	return "same-owning-handle", nil
}
func (p *hostTestProcess) Read(_ context.Context, q port.ClaudeRead) (port.ClaudeObservation, error) {
	p.t.Helper()
	if q.Handle != "same-owning-handle" || q.StdoutOffset != p.stdout || q.StderrOffset != p.stderr {
		p.t.Fatalf("foreign range: %+v", q)
	}
	p.reads++
	if p.readPanic {
		panic("private read diagnostic")
	}
	if p.readError != nil {
		return port.ClaudeObservation{}, p.readError
	}
	if p.reads > len(p.frames) {
		p.t.Fatal("unexpected extra Read")
	}
	f := p.frames[p.reads-1]
	p.stdout += uint64(len(f.data))
	r := port.ClaudeObservation{Handle: q.Handle, State: "running", RootState: "running", GroupCleanup: "pending", DescendantCleanup: "pending", Stdout: []byte(f.data), StdoutNext: p.stdout, StderrNext: p.stderr, StdoutBytes: p.stdout, StderrBytes: p.stderr}
	if f.final {
		zero := 0
		r.State = "terminal"
		r.RootState = "exited"
		r.RootWaited = true
		r.OutputDrained = true
		r.GroupCleanup = "confirmed"
		r.DescendantCleanup = "confirmed"
		r.ExitCode = &zero
	}
	if f.change != nil {
		f.change(&r)
	}
	if p.afterRead != nil {
		p.afterRead()
	}
	return r, nil
}
func (p *hostTestProcess) Cancel(context.Context, string) (port.ClaudeCancellation, error) {
	p.cancels++
	p.t.Fatal("slice has no qualified active signal capability")
	return port.ClaudeCancellation{}, task.ErrUnsupported
}

type hostTestFixture struct {
	t                        *testing.T
	selection                Selection
	dispatch                 port.Dispatch
	host                     *Host
	process                  *hostTestProcess
	gateError                error
	gateCalls, progressCalls int
	ref                      task.Reference
	sealed                   bool
	outputs                  []string
	events                   []task.ExecutionEvent
}

func hostTestNew(t *testing.T, frames ...hostTestFrame) *hostTestFixture {
	t.Helper()
	s := fixtureSelection()
	d := fixtureDispatch(s)
	f := &hostTestFixture{t: t, selection: s, dispatch: d, process: &hostTestProcess{t: t, operation: "operation", frames: frames}}
	f.host = f.buildHost()
	return f
}
func (f *hostTestFixture) options() HostOptions {
	return HostOptions{Selection: f.selection, OperationID: f.process.operation, Now: func() uint64 { return 1900000000000 }, Recheck: func(_ context.Context, s Selection) (task.Capabilities, error) {
		f.gateCalls++
		if !reflect.DeepEqual(s, f.selection) {
			f.t.Fatal("qualification changed immutable selection")
		}
		if f.gateError != nil {
			return task.Capabilities{}, f.gateError
		}
		// Positive scripted CPU gate, never a shipping native qualification.
		return task.Capabilities{Create: true, Resume: true, Continue: true, Message: true, Cancel: true}, nil
	}, Output: func(_ context.Context, r task.Reference, text string) error {
		if r != f.ref {
			f.t.Fatal("output changed actual lineage")
		}
		f.outputs = append(f.outputs, text)
		return nil
	}}
}
func (f *hostTestFixture) buildHost() *Host {
	f.t.Helper()
	h, err := newHost(f.options(), f.process)
	if err != nil {
		f.t.Fatal(err)
	}
	return h
}
func (f *hostTestFixture) record(ref task.Reference) error {
	f.t.Helper()
	if f.sealed {
		f.t.Fatal("lineage callback escaped dispatch lifetime")
	}
	f.progressCalls++
	f.ref = ref
	if ref != (task.Reference{SessionID: fixtureSession, InvocationID: f.process.operation}) {
		f.t.Fatal("invented thread/turn/provider identity", ref)
	}
	return nil
}
func (f *hostTestFixture) event(_ context.Context, e task.ExecutionEvent) error {
	if f.progressCalls != 1 || e.Reference != f.ref || !e.Valid(task.Claude) || e.Sequence != 0 {
		f.t.Fatal("metadata before actual durable lineage", e)
	}
	f.events = append(f.events, e)
	return nil
}
func (f *hostTestFixture) start() (task.Receipt, error) {
	r, err := f.host.DispatchObserved(hostTestCtx, f.dispatch, f.record, f.event)
	f.sealed = true
	return r, err
}

func TestHostLazyConcreteConstructorAndUnavailableQualification(t *testing.T) {
	s := fixtureSelection()
	p, err := processpeer.New(new(computerprocess.Contract), processpeer.Selection{OperationID: "operation", RuntimeID: s.RuntimeID, SessionID: s.SessionID, ModelID: s.Binding.Model, AdmissionID: s.AdmissionID})
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	o := HostOptions{Selection: s, OperationID: "operation", Process: p, Now: func() uint64 { return 1900000000000 }, Recheck: func(context.Context, Selection) (task.Capabilities, error) {
		calls++
		return task.Capabilities{}, task.ErrUnavailable
	}}
	h, err := NewHost(o)
	if err != nil || h == nil || calls != 0 {
		t.Fatal("constructor probed native owner", err, calls)
	}
	if _, err = h.Supports(hostTestCtx, s.Binding); !errors.Is(err, task.ErrUnavailable) || calls != 1 {
		t.Fatal("unqualified host became available", err)
	}
	_, err = h.Observe(hostTestCtx, s.Binding, task.Reference{SessionID: s.SessionID, InvocationID: "operation"})
	if err == nil {
		t.Fatal("constructor invented operation")
	}
	o.Recheck = nil
	if _, err = NewHost(o); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal(err)
	}
	o.Process = nil
	if _, err = NewHost(o); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal(err)
	}
	o.Process = p
	o.Recheck = func(context.Context, Selection) (task.Capabilities, error) {
		t.Fatal("constructor qualified")
		return task.Capabilities{}, nil
	}
	o.OperationID = "foreign"
	if _, err = NewHost(o); !errors.Is(err, task.ErrIdentity) {
		t.Fatal(err)
	}
	var missing *Host
	if _, err = missing.Supports(hostTestCtx, s.Binding); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal(err)
	}
	f := hostTestNew(t)
	f.gateError = task.ErrUnavailable
	r, err := f.start()
	if err != nil || r.State != task.Rejected || f.process.prepares+f.process.starts+f.process.reads != 0 {
		t.Fatal("unqualified gate caused work", r, err)
	}
}
func TestHostStreamsUsefulOutputAndRetainsQualifiedTerminalOnSameHandle(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{data: fixtureInit[:13]}, hostTestFrame{data: fixtureInit[13:]}, hostTestFrame{data: fixtureDelta[:15]}, hostTestFrame{data: fixtureDelta[15:]}, hostTestFrame{data: fixtureResult}, hostTestFrame{final: true})
	r, err := f.start()
	if err != nil || r.State != task.Known || r.Lifecycle != task.Running || r.Result != "" || f.process.reads != 2 || f.progressCalls != 1 {
		t.Fatal(r, err)
	}
	for n := 0; n < 3; n++ {
		out, err := f.host.Observe(hostTestCtx, f.selection.Binding, f.ref)
		if err != nil || out.Lifecycle != task.Running || out.Result != "" {
			t.Fatal("provider result alone settled", out, err)
		}
	}
	if !reflect.DeepEqual(f.outputs, []string{"Useful café 🐙"}) || len(f.events) != 1 || f.events[0].Kind != task.ProviderStarted {
		t.Fatal(f.outputs, f.events)
	}
	terminal, err := f.host.Observe(hostTestCtx, f.selection.Binding, f.ref)
	if err != nil || terminal.Lifecycle != task.Completed || terminal.Result != "fixture final" {
		t.Fatal(terminal, err)
	}
	if len(f.events) != 2 || f.events[1].Kind != task.ProviderTerminal || f.events[1].ReportedLifecycle != task.Completed {
		t.Fatal(f.events)
	}
	encoded, _ := json.Marshal(f.events)
	if strings.Contains(string(encoded), "HIDDEN_REASONING") || strings.Contains(string(encoded), "Useful") || strings.Contains(string(encoded), "fixture final") {
		t.Fatal("metadata retained private output")
	}
	reads, gates := f.process.reads, f.gateCalls
	if _, err = f.host.Observe(hostTestCtx, f.selection.Binding, f.ref); err != nil || f.process.reads != reads {
		t.Fatal("retained terminal read polled native", err)
	}
	if replay, err := f.host.DispatchObserved(hostTestCtx, f.dispatch, func(task.Reference) error { t.Fatal("replayed callback"); return nil }, f.event); err != nil || replay.State != task.Known || f.process.prepares != 1 || f.process.starts != 1 || f.process.reads != reads {
		t.Fatal("relaunch", replay, err)
	}
	if f.gateCalls <= gates {
		t.Fatal("cached terminal disclosure skipped fresh gate")
	}
	changed := f.dispatch
	changed.Message = "other"
	if out, _ := f.host.Dispatch(hostTestCtx, changed, f.record); out.Code != "CLAUDE_TASK_OPERATION_CONFLICT" {
		t.Fatal(out)
	}
	foreign := f.ref
	foreign.ThreadID = "invented-thread"
	if _, err = f.host.Observe(hostTestCtx, f.selection.Binding, foreign); !errors.Is(err, task.ErrIdentity) || f.process.reads != reads {
		t.Fatal("foreign identity read", err)
	}
	caps, err := f.host.Supports(hostTestCtx, f.selection.Binding)
	if err != nil || !caps.Create || !caps.Resume || caps.Cancel || caps.Message || caps.Continue {
		t.Fatal(caps, err)
	}
	for _, action := range []task.Action{task.Message, task.Continue, task.Cancel} {
		d := f.dispatch
		d.Intent.Action = action
		out, _ := f.host.Dispatch(hostTestCtx, d, f.record)
		if out.State != task.Rejected {
			t.Fatal("active control invented", out)
		}
	}
}
func TestHostExactSessionResumeAndImmutableSelectedInput(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{data: fixtureInit + fixtureResult, final: true})
	f.selection.Scope.TaskEpoch = 2
	f.selection.Scope.TurnID = "farol-turn-2"
	f.process.operation = "resume-2"
	f.process.resume = true
	f.dispatch = fixtureDispatch(f.selection)
	f.dispatch.Intent.OperationID = "resume-2"
	f.dispatch.Intent.Action = task.Resume
	f.dispatch.Intent.Expected = task.Reference{SessionID: fixtureSession, InvocationID: "previous-operation"}
	o := f.options()
	o.Selection.Efforts = append([]EffortMapping(nil), o.Selection.Efforts...)
	var constructorErr error
	f.host, constructorErr = newHost(o, f.process)
	if constructorErr != nil {
		t.Fatal(constructorErr)
	}
	// Mutate caller-owned declaration after capture, including its mapping slice.
	o.Selection.Efforts[0].Argument = "low"
	o.Selection.Binding.Model = "changed-model"
	r, err := f.start()
	if err != nil || r.State != task.Known || r.Reference.SessionID != fixtureSession || r.Reference.InvocationID != "resume-2" || r.Lifecycle != task.Completed {
		t.Fatal(r, err)
	}
	for _, change := range []func(*port.Dispatch){func(d *port.Dispatch) { d.Intent.Expected.SessionID = "other-session" }, func(d *port.Dispatch) { d.Intent.Expected.ThreadID = "foreign" }, func(d *port.Dispatch) { d.Intent.Admission.TaskEpoch++ }, func(d *port.Dispatch) { d.Intent.Binding.Model = "other-model" }} {
		d := f.dispatch
		change(&d)
		out, _ := f.host.Resume(hostTestCtx, d, f.record)
		if out.State != task.Rejected || f.process.starts != 1 {
			t.Fatal("resume changed identity", out)
		}
	}
}
func TestHostMalformedPartialAndUnqualifiedTerminalStayUnknown(t *testing.T) {
	cases := []struct {
		name   string
		frames []hostTestFrame
	}{
		{"no-init", []hostTestFrame{{data: fixtureResult, final: true}}},
		{"stale-session", []hostTestFrame{{data: strings.ReplaceAll(fixtureInit, fixtureSession, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") + fixtureResult, final: true}}},
		{"stale-model", []hostTestFrame{{data: strings.ReplaceAll(fixtureInit, "fixture-model-a", "other-model"), final: true}}},
		{"truncated-final", []hostTestFrame{{data: fixtureInit + strings.TrimSuffix(fixtureResult, "\n"), final: true}}},
		{"root-wait-missing", []hostTestFrame{{data: fixtureInit + fixtureResult, final: true, change: func(r *port.ClaudeObservation) { r.RootWaited = false }}}},
		{"group-unverified", []hostTestFrame{{data: fixtureInit + fixtureResult, final: true, change: func(r *port.ClaudeObservation) { r.GroupCleanup = "unverified" }}}},
		{"descendant-unverified", []hostTestFrame{{data: fixtureInit + fixtureResult, final: true, change: func(r *port.ClaudeObservation) { r.DescendantCleanup = "unverified" }}}},
		{"drain-missing", []hostTestFrame{{data: fixtureInit + fixtureResult, final: true, change: func(r *port.ClaudeObservation) { r.OutputDrained = false }}}},
		{"partial-child", []hostTestFrame{{data: fixtureInit, change: func(r *port.ClaudeObservation) { r.State = "unknown" }}}},
		{"exit-contradiction", []hostTestFrame{{data: fixtureInit + fixtureResult, final: true, change: func(r *port.ClaudeObservation) { one := 1; r.ExitCode = &one }}}},
		{"foreign-handle", []hostTestFrame{{data: fixtureInit, change: func(r *port.ClaudeObservation) { r.Handle = "other-child" }}}},
		{"foreign-offset", []hostTestFrame{{data: fixtureInit, change: func(r *port.ClaudeObservation) { r.StdoutNext++ }}}},
		{"overflow", []hostTestFrame{{data: fixtureInit, change: func(r *port.ClaudeObservation) { r.OutputLimitReached = true }}}},
		{"authority-lost", []hostTestFrame{{data: fixtureInit, change: func(r *port.ClaudeObservation) { r.AuthorityLost = true }}}},
		{"timeout", []hostTestFrame{{data: fixtureInit, change: func(r *port.ClaudeObservation) { r.TimedOut = true }}}},
		{"unknown-empty-startup", []hostTestFrame{{change: func(r *port.ClaudeObservation) { r.State = "unknown" }}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := hostTestNew(t, tc.frames...)
			r, err := f.start()
			if r.State != task.Uncertain || !errors.Is(err, task.ErrUnknown) || r.Result != "" {
				t.Fatal("fabricated settlement", r, err)
			}
			reads, gates := f.process.reads, f.gateCalls
			replay, replayErr := f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
			if replay.State != task.Uncertain || !errors.Is(replayErr, task.ErrUnknown) || f.process.starts != 1 || f.process.prepares != 1 || f.process.reads != reads || f.gateCalls != gates {
				t.Fatal("unknown relaunched", replay, replayErr)
			}
			_, _ = f.host.Observe(hostTestCtx, f.selection.Binding, task.Reference{SessionID: fixtureSession, InvocationID: "operation"})
			if f.process.reads != reads {
				t.Fatal("unknown operation re-read process")
			}
			if len(f.outputs) != 0 {
				t.Fatal("unknown exposed useful output")
			}
		})
	}
}
func TestHostLostAcknowledgementAndBoundaryPanicsNeverRelaunch(t *testing.T) {
	for _, where := range []string{"prepare-unknown", "start-unknown", "read-unknown", "prepare-panic", "start-panic", "read-panic", "prepare-refused", "start-refused"} {
		t.Run(where, func(t *testing.T) {
			f := hostTestNew(t)
			unknown := errors.New("PRIVATE_RUNTIME_DETAIL")
			refused := &port.ClaudeProcessFailure{Code: "SELECTED_REFUSED", Outcome: "refused", Retry: "never"}
			switch where {
			case "prepare-unknown":
				f.process.prepareError = unknown
			case "start-unknown":
				f.process.startError = unknown
			case "read-unknown":
				f.process.readError = unknown
			case "prepare-panic":
				f.process.preparePanic = true
			case "start-panic":
				f.process.startPanic = true
			case "read-panic":
				f.process.readPanic = true
			case "prepare-refused":
				f.process.prepareError = refused
			case "start-refused":
				f.process.startError = refused
			}
			r, err := f.start()
			want := task.Uncertain
			if strings.HasSuffix(where, "refused") {
				want = task.Rejected
			}
			if r.State != want || want == task.Uncertain && !errors.Is(err, task.ErrUnknown) {
				t.Fatal(r, err)
			}
			p, s, n := f.process.prepares, f.process.starts, f.process.reads
			_, _ = f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
			if f.process.prepares != p || f.process.starts != s || f.process.reads != n {
				t.Fatal("retried boundary")
			}
			if err != nil && strings.Contains(err.Error(), "PRIVATE") {
				t.Fatal("raw error exposed")
			}
		})
	}
}
func TestHostPublicationFailuresAndFreshRevocationAreBinding(t *testing.T) {
	for _, where := range []string{"lineage", "lineage-panic", "event", "output", "after-prepare", "after-read"} {
		t.Run(where, func(t *testing.T) {
			f := hostTestNew(t, hostTestFrame{data: fixtureInit + fixtureDelta})
			progressFn := f.record
			eventFn := f.event
			switch where {
			case "lineage":
				progressFn = func(task.Reference) error { return errors.New("lost publication") }
			case "lineage-panic":
				progressFn = func(task.Reference) error { panic("private callback") }
			case "event":
				eventFn = func(context.Context, task.ExecutionEvent) error { return task.ErrUnknown }
			case "output":
				f.host.output = func(context.Context, task.Reference, string) error { return task.ErrUnknown }
			case "after-prepare":
				f.process.afterPrepare = func() { f.gateError = task.ErrUnavailable }
			case "after-read":
				f.process.afterRead = func() { f.gateError = task.ErrUnavailable }
			}
			r, err := f.host.DispatchObserved(hostTestCtx, f.dispatch, progressFn, eventFn)
			want := task.Uncertain
			if where == "after-prepare" {
				want = task.Rejected
			}
			if r.State != want || want == task.Uncertain && !errors.Is(err, task.ErrUnknown) {
				t.Fatal(r, err)
			}
			if where == "after-prepare" && f.process.starts != 0 {
				t.Fatal("revoked before start")
			}
			p, s, n := f.process.prepares, f.process.starts, f.process.reads
			_, _ = f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
			if f.process.prepares != p || f.process.starts != s || f.process.reads != n {
				t.Fatal("publication error replayed effect")
			}
		})
	}
}

// Private memory backing port reused by the actual Task Owner and Service.
// It is not an OS-process crash/persistence or production journal witness.
type hostTestJournal struct {
	mu         sync.Mutex
	snapshot   *port.Snapshot
	ops        map[string]port.Operation
	failFinish bool
}

func (j *hostTestJournal) Lookup(_ context.Context, id string) (*port.Operation, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	out, ok := j.ops[id]
	if !ok {
		return nil, nil
	}
	return &out, nil
}
func (j *hostTestJournal) Read(_ context.Context, id string) (*port.Snapshot, error) {
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
func (j *hostTestJournal) Admit(_ context.Context, i task.Intent, revision uint64, prepared task.Task) (*port.Admission, error) {
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
func (j *hostTestJournal) Progress(_ context.Context, id string, ref task.Reference) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	op, ok := j.ops[id]
	if !ok || j.snapshot.Pending != id || !op.Lineage.Extend(ref, op.Intent.Binding.Provider) {
		return task.ErrIdentity
	}
	op.Lineage = ref
	j.ops[id] = op
	return nil
}
func (j *hostTestJournal) Finish(_ context.Context, id string, r task.Receipt, next task.Task) error {
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
func (j *hostTestJournal) Observe(_ context.Context, before port.Snapshot, next task.Task) error {
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
func (j *hostTestJournal) Invalidate(_ context.Context, before port.Snapshot) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if *j.snapshot != before {
		return task.ErrConflict
	}
	j.snapshot.Task.Admission.State = task.AdmissionRevoked
	j.snapshot.Revision++
	return nil
}

func (j *hostTestJournal) RecordEvent(_ context.Context, e task.ExecutionEvent) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	op, ok := j.ops[e.DispatchID]
	if !ok {
		return task.ErrNotFound
	}
	if op.Lineage != e.Reference {
		return task.ErrIdentity
	}
	log, err := op.Events.Append(e, op.Intent.Binding.Provider)
	if err != nil {
		return err
	}
	op.Events = log
	j.ops[e.DispatchID] = op
	return nil
}

type hostTestAuthority struct {
	binding  task.Binding
	resolves int
}

func (a *hostTestAuthority) Resolve(_ context.Context, q port.Selection) (task.Binding, error) {
	a.resolves++
	b := a.binding
	if q.Provider != b.Provider || q.ProjectID != b.ProjectID || q.WorkspaceID != b.WorkspaceID || q.ModelAlias != b.ModelAlias || q.Effort != b.Effort {
		return task.Binding{}, task.ErrIdentity
	}
	return b, nil
}
func (a *hostTestAuthority) Recheck(_ context.Context, b task.Binding) error {
	if b != a.binding {
		return task.ErrIdentity
	}
	return nil
}
func (*hostTestAuthority) RecheckParent(context.Context, task.Parent) error { return nil }
func hostTestService(t *testing.T, owner *taskrepo.Owner, s Selection, h *Host, a *hostTestAuthority) *tasksvc.Service {
	t.Helper()
	b := s.Scope
	route, err := owner.Select(port.CurrentBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID})
	if err != nil {
		t.Fatal(err)
	}
	svc, err := tasksvc.NewOwned(route, a, map[task.Provider]port.Provider{task.Claude: h}, nil, intent.Fingerprint, progress.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	return svc
}
func hostTestCreateRequest(s Selection) tasksvc.CreateRequest {
	b := s.Binding
	return tasksvc.CreateRequest{OperationID: "operation", TaskID: s.Scope.TaskID, Message: "bounded fixture", Selection: port.Selection{Provider: b.Provider, ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, ModelAlias: b.ModelAlias, Effort: b.Effort}}
}
func TestHostActualTaskServiceRetainsEventsAndPriorExactSessionResult(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{data: fixtureInit}, hostTestFrame{data: fixtureResult, final: true})
	f.host.output = nil
	j := &hostTestJournal{ops: map[string]port.Operation{}}
	owner, err := taskrepo.New(j, "task")
	if err != nil {
		t.Fatal(err)
	}
	a := &hostTestAuthority{binding: f.selection.Binding}
	svc := hostTestService(t, owner, f.selection, f.host, a)
	created, err := svc.Create(hostTestCtx, hostTestCreateRequest(f.selection))
	if err != nil || created.Receipt.State != task.Known || created.Receipt.Lifecycle != task.Running {
		t.Fatal(created, err)
	}
	started, err := svc.Execution(hostTestCtx, tasksvc.ExecutionRequest{TaskID: "task", DispatchID: "operation", Limit: 4, IncludeResult: true})
	if err != nil || len(started.Page.Events) != 1 || started.Retained || started.Delivery != "not_observed" {
		t.Fatal(started, err)
	}
	result, err := svc.Result(hostTestCtx, tasksvc.ResultRequest{TaskID: "task"})
	if err != nil || !result.Retained || result.Text != "fixture final" {
		t.Fatal(result, err)
	}
	retained, err := svc.Execution(hostTestCtx, tasksvc.ExecutionRequest{TaskID: "task", DispatchID: "operation", Limit: 4, IncludeResult: true})
	if err != nil || len(retained.Page.Events) != 2 || !retained.Retained || retained.ResultEvidence != "task_journal" || retained.Delivery != "not_observed" {
		t.Fatal(retained, err)
	}
	oldRef := result.Reference
	g := hostTestNew(t, hostTestFrame{data: fixtureInit}, hostTestFrame{data: strings.ReplaceAll(fixtureResult, "fixture final", "resume final"), final: true})
	g.selection.Scope.TaskEpoch = 2
	g.selection.Scope.TurnID = "farol-turn-2"
	g.process.operation = "resume-2"
	g.process.resume = true
	g.host = g.buildHost()
	g.host.output = nil
	resume := hostTestService(t, owner, g.selection, g.host, a)
	followed, err := resume.Control(hostTestCtx, tasksvc.MutationRequest{OperationID: "resume-2", TaskID: "task", Action: task.Resume, Message: "bounded fixture"})
	if err != nil || followed.Receipt.State != task.Known || followed.Receipt.Reference.SessionID != oldRef.SessionID || followed.Receipt.Reference.InvocationID == oldRef.InvocationID {
		t.Fatal(followed, err)
	}
	result2, err := resume.Result(hostTestCtx, tasksvc.ResultRequest{TaskID: "task"})
	if err != nil || !result2.Retained || result2.Text != "resume final" {
		t.Fatal(result2, err)
	}
	prior, err := resume.Execution(hostTestCtx, tasksvc.ExecutionRequest{TaskID: "task", DispatchID: "operation", Limit: 4, IncludeResult: true})
	if err != nil || !prior.Retained || prior.Result != "fixture final" || prior.Reference != oldRef || len(prior.Page.Events) != 2 {
		t.Fatal("follow-up overwrote retained result", prior, err)
	}
	reads, resolves := g.process.reads, a.resolves
	op, err := svc.Operation(hostTestCtx, tasksvc.OperationRequest{OperationID: "operation"})
	if err != nil || op.Receipt.Result != "fixture final" || op.Receipt.Reference != oldRef || g.process.reads != reads || a.resolves != resolves || f.process.starts != 1 || g.process.starts != 1 {
		t.Fatal("reconnect repeated provider work", op, err)
	}
}
func TestHostTaskServiceLostAckReconnectDoesNotCallReconstructedHost(t *testing.T) {
	for _, where := range []string{"start-ack", "partial-init", "finish-ack"} {
		t.Run(where, func(t *testing.T) {
			f := hostTestNew(t, hostTestFrame{data: fixtureInit, change: func(r *port.ClaudeObservation) { r.State = "unknown" }})
			f.host.output = nil
			if where == "start-ack" {
				f.process.startError = errors.New("private lost start acknowledgement")
			}
			j := &hostTestJournal{ops: map[string]port.Operation{}}
			if where == "finish-ack" {
				j.failFinish = true
				f.process.frames[0].change = nil
			}
			owner, err := taskrepo.New(j, "task")
			if err != nil {
				t.Fatal(err)
			}
			a := &hostTestAuthority{binding: f.selection.Binding}
			svc := hostTestService(t, owner, f.selection, f.host, a)
			out, err := svc.Create(hostTestCtx, hostTestCreateRequest(f.selection))
			if err != nil || out.Receipt.State != task.Uncertain {
				t.Fatal(out, err)
			}
			// Root may reconstruct source facades, but the SAME existing durable
			// intent/owner blocks any reconstructed Host from launching a new child.
			g := hostTestNew(t)
			g.host.output = nil
			reconnected := hostTestService(t, owner, g.selection, g.host, a)
			resolves := a.resolves
			replay, err := reconnected.Create(hostTestCtx, hostTestCreateRequest(g.selection))
			if err != nil || replay.Receipt.State != task.Uncertain || g.process.prepares+g.process.starts+g.process.reads != 0 || g.gateCalls != 0 || a.resolves != resolves {
				t.Fatal("lost ACK reconstructed child", replay, err)
			}
			op, err := reconnected.Operation(hostTestCtx, tasksvc.OperationRequest{OperationID: "operation"})
			if err != nil || op.Receipt.State != task.Uncertain {
				t.Fatal(op, err)
			}
			if (where == "partial-init" || where == "finish-ack") && op.Lineage != (task.Reference{SessionID: fixtureSession, InvocationID: "operation"}) {
				t.Fatal("actual init lineage lost", op)
			}
			if where == "start-ack" && op.Lineage != (task.Reference{}) {
				t.Fatal("Start echo invented provider identity", op)
			}
			retained, err := reconnected.Execution(hostTestCtx, tasksvc.ExecutionRequest{TaskID: "task", DispatchID: "operation", Limit: 4, IncludeResult: true})
			if err != nil || !retained.Pending || retained.Retained || retained.Result != "" {
				t.Fatal("unknown fabricated retained terminal", retained, err)
			}
			if f.process.starts != 1 || g.process.starts != 0 || g.process.reads != 0 {
				t.Fatal("reconnect provider effect")
			}
		})
	}
}

func TestHostQualifiedFailureNeedsInputAndUnreadTerminalRanges(t *testing.T) {
	for _, kind := range []string{"failure", "needs-input", "unread-range"} {
		t.Run(kind, func(t *testing.T) {
			result := fixtureResult
			lifecycle := task.Completed
			var frames []hostTestFrame
			switch kind {
			case "failure":
				result = strings.ReplaceAll(strings.ReplaceAll(result, `"is_error":false`, `"is_error":true`), `"subtype":"success"`, `"subtype":"error_during_execution"`)
				lifecycle = task.Failed
				frames = []hostTestFrame{{data: fixtureInit + result, final: true, change: func(r *port.ClaudeObservation) { one := 1; r.ExitCode = &one }}}
			case "needs-input":
				result = strings.ReplaceAll(result, `"permission_denials":[]`, `"permission_denials":[{"tool_name":"fixture-tool"}]`)
				lifecycle = task.NeedsInput
				frames = []hostTestFrame{{data: fixtureInit + result, final: true}}
			case "unread-range":
				first := fixtureInit + result[:17]
				total := uint64(len(fixtureInit + result))
				frames = []hostTestFrame{{data: first, final: true, change: func(r *port.ClaudeObservation) { r.StdoutBytes = total }}, {data: result[17:], final: true}}
			}
			f := hostTestNew(t, frames...)
			r, err := f.start()
			if err != nil || r.State != task.Known {
				t.Fatal(r, err)
			}
			if kind == "unread-range" {
				if r.Lifecycle != task.Running || r.Result != "" {
					t.Fatal("range boundary became EOF", r)
				}
				observed, e := f.host.Observe(hostTestCtx, f.selection.Binding, f.ref)
				if e != nil {
					t.Fatal(e)
				}
				r.Lifecycle, r.Result = observed.Lifecycle, observed.Result
			}
			if r.Lifecycle != lifecycle || r.Result != "fixture final" {
				t.Fatal(r)
			}
			if kind == "needs-input" && len(f.events) != 1 {
				t.Fatal("invented unsupported terminal metadata", f.events)
			}
		})
	}
}
func TestHostConcurrentSameOperationDispatchHasOnlyOneEffect(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{data: fixtureInit})
	var wait sync.WaitGroup
	results := make(chan task.Receipt, 2)
	for n := 0; n < 2; n++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			r, err := f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
			if err != nil {
				t.Error(err)
			}
			results <- r
		}()
	}
	wait.Wait()
	close(results)
	for r := range results {
		if r.State != task.Known || r.Lifecycle != task.Running {
			t.Fatal(r)
		}
	}
	if f.process.prepares != 1 || f.process.starts != 1 || f.process.reads != 1 || f.progressCalls != 1 {
		t.Fatal("concurrent local replay issued another effect")
	}
}

func TestHostRangeTotalsAndCachedReplayCannotHideAuthorityLoss(t *testing.T) {
	t.Run("retained-byte-count-shrank", func(t *testing.T) {
		total := uint64(len(fixtureInit+fixtureResult) + 7)
		f := hostTestNew(t, hostTestFrame{data: fixtureInit, change: func(r *port.ClaudeObservation) { r.StdoutBytes = total }}, hostTestFrame{data: fixtureResult, final: true})
		if r, err := f.start(); err != nil || r.State != task.Known {
			t.Fatal(r, err)
		}
		if _, err := f.host.Observe(hostTestCtx, f.selection.Binding, f.ref); !errors.Is(err, task.ErrUnknown) {
			t.Fatal("discarded bytes became successful EOF", err)
		}
	})
	t.Run("revoked-known-replay", func(t *testing.T) {
		f := hostTestNew(t, hostTestFrame{data: fixtureInit + fixtureResult, final: true})
		if r, err := f.start(); err != nil || r.State != task.Known {
			t.Fatal(r, err)
		}
		f.gateError = task.ErrUnavailable
		r, err := f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
		if !errors.Is(err, task.ErrUnknown) || r.State != task.Uncertain || r.Result != "" || f.process.starts != 1 || f.process.reads != 1 {
			t.Fatal("revoked replay disclosed retained result", r, err)
		}
	})
}

func TestHostActualInitPrefixSurvivesMalformedRemainderWithoutResult(t *testing.T) {
	f := hostTestNew(t, hostTestFrame{data: fixtureInit + fixtureDelta + `{"type":"unrecognized_provider_record"}` + "\n", final: true})
	r, err := f.start()
	if r.State != task.Uncertain || !errors.Is(err, task.ErrUnknown) || f.progressCalls != 1 || f.ref != (task.Reference{SessionID: fixtureSession, InvocationID: "operation"}) || len(f.outputs) != 0 || len(f.events) != 1 || f.events[0].Kind != task.ProviderStarted {
		t.Fatal("actual init prefix lost or bad-range output released", r, err, f.ref, f.events)
	}
	reads := f.process.reads
	_, _ = f.host.Dispatch(hostTestCtx, f.dispatch, f.record)
	if f.process.starts != 1 || f.process.reads != reads || f.progressCalls != 1 {
		t.Fatal("prefix unknown retried effect/callback")
	}
}
