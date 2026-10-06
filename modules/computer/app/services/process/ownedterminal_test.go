package process

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
)

// All children, completions, authorities and outputs are in-memory doubles.
// These tests qualify no OS child, filesystem, provider or stored publication.
type ownedCompletionDouble struct {
	*terminalChildDouble
	handle       string
	waits        atomic.Int32
	wait         func(context.Context) error
	beforeRead   func()
	beforeCancel func()
	readError    error
	nilRead      bool
	cancelStatus CancelStatus
	gate         *sync.Mutex
}

func (c *ownedCompletionDouble) Handle() string { return c.handle }
func (c *ownedCompletionDouble) outsideGate() {
	if !c.gate.TryLock() {
		panic("owned lifecycle call under app gate")
	}
	c.gate.Unlock()
}
func (c *ownedCompletionDouble) WaitForCompletion(ctx context.Context) error {
	c.outsideGate()
	c.waits.Add(1)
	if c.wait != nil {
		return c.wait(ctx)
	}
	return nil
}
func (c *ownedCompletionDouble) Read(ctx context.Context, w Window) (*Observation, error) {
	c.outsideGate()
	if c.beforeRead != nil {
		c.beforeRead()
	}
	if c.readError != nil || c.nilRead {
		c.reads++
		return nil, c.readError
	}
	return c.terminalChildDouble.Read(ctx, w)
}
func (c *ownedCompletionDouble) Cancel(context.Context) (*CancelReceipt, error) {
	c.outsideGate()
	c.cancels++
	if c.beforeCancel != nil {
		c.beforeCancel()
	}
	return &CancelReceipt{Handle: c.handle, Status: c.cancelStatus}, nil
}

type ownedLaunchDouble struct {
	seal  Seal
	child Child
	calls int
	after func()
}

func (p *ownedLaunchDouble) Seal() Seal { return p.seal }
func (p *ownedLaunchDouble) Spawn(ctx context.Context, r SpawnRequest) (Child, error) {
	if err := r.Check(ctx); err != nil {
		return nil, err
	}
	p.calls++
	if p.after != nil {
		p.after()
	}
	return p.child, nil
}

type ownedExecutionDouble struct {
	*execution
	accesses int
	closed   bool
}

func (e *ownedExecutionDouble) Binding() port.TaskBinding {
	e.accesses++
	return e.execution.Binding()
}
func (e *ownedExecutionDouble) Deadline() time.Time {
	e.accesses++
	return e.execution.Deadline()
}
func (e *ownedExecutionDouble) WithSnapshot(ctx context.Context, p string, inspect func(port.AccessSnapshot) error) error {
	e.accesses++
	if e.closed {
		return fail("PROCESS_ADMISSION_UNAVAILABLE", false)
	}
	return e.execution.WithSnapshot(ctx, p, inspect)
}

type ownedFixture struct {
	s      *Service
	child  *ownedCompletionDouble
	launch *ownedLaunchDouble
	lease  *ownedExecutionDouble
	clock  *clock
	r      *reservation
}

func newOwnedFixture(t *testing.T, stdout, stderr []byte, startChild bool) ownedFixture {
	t.Helper()
	_, clock, e, r, p := setup(t)
	gate := &sync.Mutex{}
	child := &ownedCompletionDouble{terminalChildDouble: &terminalChildDouble{stdout: stdout, stderr: stderr},
		handle: "owned-child", gate: gate, cancelStatus: CancelRequested}
	launch := &ownedLaunchDouble{seal: p.seal, child: child}
	lease := &ownedExecutionDouble{execution: e}
	s, err := NewForConnector("operation", connectorScopeDouble(), lease, launch, r, gate, clock)
	if err != nil {
		t.Fatal(err)
	}
	if startChild {
		start(t, s)
	}
	return ownedFixture{s, child, launch, lease, clock, r}
}

func completeOwned(t *testing.T, f ownedFixture) {
	t.Helper()
	if err := f.s.WaitForCompletion(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func refuseOwned(t *testing.T, s *Service) error {
	t.Helper()
	out, err := s.CaptureOwnedTerminal(context.Background())
	if out != nil || err == nil {
		t.Fatal("private retention escaped without known complete ownership", out, err)
	}
	return err
}

func TestOwnedCompletionKnownOnceIsNotTerminalProof(t *testing.T) {
	f := newOwnedFixture(t, nil, nil, true)
	f.child.running = true
	accesses := f.lease.accesses
	completeOwned(t, f)
	completeOwned(t, f)
	if !f.s.completed || f.s.terminal || f.child.waits.Load() != 1 || f.child.reads != 0 || f.child.cancels != 0 ||
		f.lease.accesses != accesses || f.launch.calls != 1 || f.r.calls != 1 {
		t.Fatal("completion inferred terminal state, admission or another effect")
	}
	unknown(t, refuseOwned(t, f.s))
	if !f.s.uncertain || f.s.terminal {
		t.Fatal("notification turned running output into terminal proof")
	}
}

func TestOwnedCompletionMissingUnknownAndCancelledNeverRetry(t *testing.T) {
	for _, fault := range []string{"missing", "unknown", "raw-error", "refused", "cancelled", "late-cancel"} {
		t.Run(fault, func(t *testing.T) {
			f := newOwnedFixture(t, nil, nil, false)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if fault == "missing" {
				f.launch.child = f.child.terminalChildDouble
			} else {
				f.child.wait = func(context.Context) error {
					switch fault {
					case "unknown":
						return &NativeFailure{Unknown: true}
					case "raw-error":
						return errors.New("unknown notification")
					case "refused":
						return &NativeFailure{}
					case "cancelled":
						cancel()
						return ctx.Err()
					case "late-cancel":
						cancel()
						return nil
					}
					return nil
				}
			}
			start(t, f.s)
			if err := f.s.WaitForCompletion(ctx); err == nil {
				t.Fatal("failed notification recorded as completion")
			}
			f.child.wait = nil
			if err := f.s.WaitForCompletion(context.Background()); err == nil || f.s.completed || f.s.terminal {
				t.Fatal("notification was retried or inferred")
			}
			refuseOwned(t, f.s)
			want := int32(1)
			if fault == "missing" {
				want = 0
			}
			if f.child.waits.Load() != want || f.child.reads != 0 || f.child.cancels != 0 || f.launch.calls != 1 || f.r.calls != 1 {
				t.Fatal("failed notification caused IO or another attempt")
			}
		})
	}
}

func TestOwnedCompletionPendingDoesNotStartAnotherWait(t *testing.T) {
	f := newOwnedFixture(t, nil, nil, true)
	entered, release := make(chan struct{}), make(chan struct{})
	f.child.wait = func(context.Context) error { close(entered); <-release; return nil }
	result := make(chan error, 1)
	go func() { result <- f.s.WaitForCompletion(context.Background()) }()
	<-entered
	if err := f.s.WaitForCompletion(context.Background()); err == nil || err.Error() != "PROCESS_COMPLETION_PENDING" {
		t.Fatal("second completion caller did not fence the pending wait", err)
	}
	refuseOwned(t, f.s)
	close(release)
	if err := <-result; err != nil || f.child.waits.Load() != 1 || f.child.reads != 0 {
		t.Fatal("pending wait reissued notification", err)
	}
}

func TestOwnedCompletionLostStartDisclosureStillUsesRetainedChild(t *testing.T) {
	f := newOwnedFixture(t, []byte("known bytes"), nil, false)
	f.launch.after = func() { f.lease.closed = true }
	if out, err := f.s.Start(context.Background(), StartRequest{"operation"}); out != nil || err == nil || !f.s.started || f.s.child != f.child {
		t.Fatal("fixture did not retain child after lost disclosure", err)
	}
	accesses := f.lease.accesses
	completeOwned(t, f)
	out, err := f.s.CaptureOwnedTerminal(context.Background())
	if err != nil || out == nil || string(out.Observation.Stdout) != "known bytes" || f.lease.accesses != accesses || f.child.waits.Load() != 1 || f.launch.calls != 1 || f.r.calls != 1 {
		t.Fatal("lost Start disclosure blocked internal collection or renewed access", err)
	}
}

func TestOwnedCompletionWithoutKnownStartedChildRefuses(t *testing.T) {
	for _, fault := range []string{"not-started", "pending", "lost-child", "start-refusal", "uncertain", "cancelled-context"} {
		t.Run(fault, func(t *testing.T) {
			f := newOwnedFixture(t, nil, nil, fault != "not-started")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "pending":
				f.s.pending = true
			case "lost-child":
				f.s.child = nil
			case "start-refusal":
				f.s.refusal = fail("PROCESS_OUTCOME_UNKNOWN", true)
			case "uncertain":
				f.s.uncertain = true
			case "cancelled-context":
				cancel()
			}
			if err := f.s.WaitForCompletion(ctx); err == nil || f.child.waits.Load() != 0 {
				t.Fatal("completion inferred a missing or fenced start")
			}
			refuseOwned(t, f.s)
		})
	}
}

func TestOwnedCompletionAllowsPendingCancelButCaptureWaitsForACK(t *testing.T) {
	f := newOwnedFixture(t, []byte("cancelled bytes"), nil, true)
	f.child.mutate = func(_ int, out *Observation) { out.CancelRequested = true }
	f.child.beforeCancel = func() {
		completeOwned(t, f)
		if err := refuseOwned(t, f.s); err.Error() != "PROCESS_CANCEL_PENDING" || f.child.reads != 0 || f.s.uncertain {
			t.Fatal("pending cancel blocked completion or escaped retention fence", err)
		}
	}
	if _, err := f.s.Cancel(context.Background(), CancelRequest{"owned-child"}); err != nil {
		t.Fatal(err)
	}
	out, err := f.s.CaptureOwnedTerminal(context.Background())
	if err != nil || out == nil || !out.Observation.CancelRequested || f.child.cancels != 1 || f.child.waits.Load() != 1 {
		t.Fatal("known cancel ACK could not collect fully confirmed terminal facts", err)
	}
}

func TestOwnedTerminalFullWindowsAfterExpiryOrConnectorClosure(t *testing.T) {
	for _, size := range []int{0, 7, WindowBytes + 31, MaximumOutput} {
		for _, mode := range []string{"expired", "closed"} {
			t.Run(mode+"/"+strconv.Itoa(size), func(t *testing.T) {
				stdout := bytes.Repeat([]byte{0xff}, size*3/4)
				stderr := bytes.Repeat([]byte{0}, size-len(stdout))
				f := newOwnedFixture(t, stdout, stderr, true)
				intent, scope := f.s.intent, *f.s.connector
				f.clock.now = f.lease.deadline
				f.lease.closed = mode == "closed"
				f.child.mutate = func(_ int, out *Observation) { out.TimedOut, out.AuthorityLost = true, true }
				accesses := f.lease.accesses
				completeOwned(t, f)
				out, err := f.s.CaptureOwnedTerminal(context.Background())
				if err != nil || out == nil || !ValidTerminalResult(*out) || !bytes.Equal(out.Observation.Stdout, stdout) ||
					!bytes.Equal(out.Observation.Stderr, stderr) || !out.Observation.TimedOut || !out.Observation.AuthorityLost ||
					!sameIntent(out.Intent, intent) || out.Scope != scope || f.lease.accesses != accesses {
					t.Fatal("private retention lost complete original facts or consulted authority", err)
				}
				wantReads := max(1, (max(len(stdout), len(stderr))+WindowBytes-1)/WindowBytes)
				if f.child.reads != wantReads || f.child.waits.Load() != 1 || f.child.cancels != 0 || f.launch.calls != 1 || f.r.calls != 1 {
					t.Fatal("capture exceeded exact windows or made another effect")
				}
				if size > 0 {
					out.Observation.Stdout[0] = 1
					out.Observation.Stderr[0] = 1
					*out.Observation.ExitCode = 0
					if stdout[0] != 0xff || stderr[0] != 0 {
						t.Fatal("capture exposed the child's retained byte slices")
					}
				}
				if out, err := f.s.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil || f.child.reads != wantReads {
					t.Fatal("internal capture granted public execution READ", err)
				}
				current, read := connectorReadSelectionDouble(f.clock, f.lease.execution)
				workspace := workspaceFixture(f.s, read)
				observer, err := f.s.ConnectorObserver(current, workspace)
				if err != nil {
					t.Fatal(err)
				}
				read.revoked = true
				if out, err := observer.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil || workspace.calls != 0 || f.child.reads != wantReads {
					t.Fatal("retention bypassed the current connector READ guard", err)
				}
				if out, err := f.s.CaptureTerminal(context.Background(), current, workspace); out != nil || err == nil || workspace.calls != 0 || f.child.reads != wantReads {
					t.Fatal("public terminal capture bypassed the READ guard", err)
				}
				ordinary := readAuthority(f.clock, f.lease.execution)
				ordinary.revoked = true
				originalObserver, err := f.s.Observer(ordinary, workspaceFixture(f.s, ordinary))
				if err != nil {
					t.Fatal(err)
				}
				if out, err := originalObserver.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil || f.child.reads != wantReads {
					t.Fatal("internal capture granted Task/Chat observation", err)
				}
			})
		}
	}
}

func TestOwnedTerminalRequiresConnectorProvenanceAndKnownCompletion(t *testing.T) {
	f := newOwnedFixture(t, nil, nil, true)
	refuseOwned(t, f.s)
	if f.child.reads != 0 {
		t.Fatal("capture read before known completion")
	}
	f.s.connector = nil // Ordinary construction cannot gain connector provenance.
	completeOwned(t, f)
	refuseOwned(t, f.s)
	if f.child.reads != 0 || f.s.terminal {
		t.Fatal("non-connector completion gained retention provenance")
	}
}

func TestOwnedTerminalFactDriftAndMalformedPagesStayUnknown(t *testing.T) {
	for _, fault := range []string{"exit", "aliased-exit", "signal", "root", "wait", "drain", "group", "descendants", "pending-cleanup", "size", "limit", "cancel", "timeout", "authority", "handle", "offset", "next", "oversize", "window", "zero-progress", "nil"} {
		t.Run(fault, func(t *testing.T) {
			f := newOwnedFixture(t, bytes.Repeat([]byte("x"), WindowBytes+3), nil, true)
			sharedCode := 4
			f.child.mutate = func(page int, out *Observation) {
				if fault == "aliased-exit" {
					out.ExitCode = &sharedCode
				}
				if page != 2 {
					return
				}
				switch fault {
				case "exit":
					*out.ExitCode = 5
				case "aliased-exit":
					sharedCode = 5
				case "signal":
					out.ExitCode, out.ExitSignal = nil, 9
				case "root":
					out.Root = RootRunning
				case "wait":
					out.Waited = false
				case "drain":
					out.OutputDrained = false
				case "group":
					out.GroupCleanup = CleanupUnverified
				case "descendants":
					out.DescendantCleanup = CleanupUnverified
				case "pending-cleanup":
					out.GroupCleanup = CleanupPending
				case "size":
					out.StdoutBytes++
				case "limit":
					out.OutputLimitReached = true
				case "cancel":
					out.CancelRequested = true
				case "timeout":
					out.TimedOut = true
				case "authority":
					out.AuthorityLost = true
				case "handle":
					out.Handle = "other-child"
				case "offset":
					out.StdoutOffset++
				case "next":
					out.StdoutNext++
				case "oversize":
					out.StdoutBytes = MaximumOutput + 1
				case "window":
					out.Stdout = bytes.Repeat([]byte("x"), WindowBytes+1)
				case "zero-progress":
					out.Stdout, out.StdoutNext = nil, out.StdoutOffset
				case "nil":
					out.ExitCode, out.ExitSignal = nil, 0
				}
			}
			completeOwned(t, f)
			unknown(t, refuseOwned(t, f.s))
			if !f.s.uncertain || f.s.terminal || f.child.reads != 2 {
				t.Fatal("drift did not fence retention")
			}
			f.child.mutate = nil
			unknown(t, refuseOwned(t, f.s))
			if f.child.reads != 2 || f.child.cancels != 0 || f.child.waits.Load() != 1 {
				t.Fatal("sticky unknown allowed another IO attempt")
			}
		})
	}
}

func TestOwnedTerminalOwnerDriftDuringWaitOrReadStaysUnknown(t *testing.T) {
	for _, phase := range []string{"wait", "first-page", "last-page"} {
		for _, fault := range []string{"child", "handle", "intent", "scope", "provenance", "uncertain", "cancel-unknown"} {
			t.Run(phase+"/"+fault, func(t *testing.T) {
				f := newOwnedFixture(t, bytes.Repeat([]byte("x"), WindowBytes+1), nil, true)
				mutate := func() {
					f.s.gate.Lock()
					defer f.s.gate.Unlock()
					switch fault {
					case "child":
						f.s.child = &ownedCompletionDouble{handle: "owned-child", gate: f.child.gate}
					case "handle":
						f.child.handle = "other-child"
					case "intent":
						f.s.intent.Binding.TurnID = "other-turn"
					case "scope":
						f.s.connector.Host.ProfileID = "other-profile"
					case "provenance":
						f.s.connector = nil
					case "uncertain":
						f.s.uncertain = true
					case "cancel-unknown":
						f.s.cancelAttempted = true
						f.s.cancellation = &CancelReceipt{Handle: "owned-child", Status: CancelUnknown}
					}
				}
				if phase == "wait" {
					f.child.wait = func(context.Context) error { mutate(); return nil }
					if err := f.s.WaitForCompletion(context.Background()); err == nil || f.s.completed {
						t.Fatal("owner drift during completion became known")
					}
				} else {
					completeOwned(t, f)
					f.child.mutate = func(page int, _ *Observation) {
						if phase == "first-page" && page == 1 || phase == "last-page" && page == 2 {
							mutate()
						}
					}
				}
				refuseOwned(t, f.s)
				if f.s.terminal || f.child.reads > 2 || f.child.waits.Load() != 1 || f.child.cancels != 0 {
					t.Fatal("late owner drift escaped retention fence")
				}
			})
		}
	}
}

func TestOwnedTerminalCancelUnknownAndLateCancellationRefuse(t *testing.T) {
	for _, fault := range []string{"cancel-pending", "cancel-unknown", "cancel-failure", "cancel-handle", "context-before", "context-last-page", "pending-start"} {
		t.Run(fault, func(t *testing.T) {
			f := newOwnedFixture(t, bytes.Repeat([]byte("x"), WindowBytes+1), nil, true)
			completeOwned(t, f)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "cancel-pending":
				f.s.cancelAttempted = true
			case "cancel-unknown":
				f.s.cancelAttempted = true
				f.s.cancellation = &CancelReceipt{Handle: "owned-child", Status: CancelUnknown}
			case "cancel-failure":
				f.s.cancelAttempted, f.s.cancelFailure = true, fail("PROCESS_CANCEL_UNKNOWN", true)
			case "cancel-handle":
				f.s.cancelAttempted = true
				f.s.cancellation = &CancelReceipt{Handle: "other-child", Status: CancelRequested}
			case "context-before":
				cancel()
			case "context-last-page":
				f.child.mutate = func(page int, _ *Observation) {
					if page == 2 {
						cancel()
					}
				}
			case "pending-start":
				f.s.pending = true
			}
			if out, err := f.s.CaptureOwnedTerminal(ctx); out != nil || err == nil || f.s.terminal || f.child.cancels != 0 {
				t.Fatal("pending/uncertain cancellation or late context escaped", err)
			}
			wantReads := 0
			if fault == "context-last-page" {
				wantReads = 2
			}
			if f.child.reads != wantReads {
				t.Fatal("fenced capture still read child")
			}
		})
	}
}

func TestOwnedTerminalBoundsTinyWindows(t *testing.T) {
	f := newOwnedFixture(t, bytes.Repeat([]byte("x"), maximumTerminalPages+1), nil, true)
	f.child.pageBytes = 1
	completeOwned(t, f)
	if err := refuseOwned(t, f.s); err.Error() != "PROCESS_RESULT_WINDOW_LIMIT" || f.child.reads != maximumTerminalPages || f.s.terminal {
		t.Fatal("incomplete bounded capture escaped or looped without bound", err)
	}
}

func TestOwnedTerminalPreservesSignalAndCopiesExitFacts(t *testing.T) {
	f := newOwnedFixture(t, []byte("signal bytes"), nil, true)
	f.child.mutate = func(_ int, out *Observation) { out.ExitCode, out.ExitSignal = nil, 9 }
	completeOwned(t, f)
	out, err := f.s.CaptureOwnedTerminal(context.Background())
	if err != nil || out == nil || out.Observation.ExitCode != nil || out.Observation.ExitSignal != 9 || !ValidTerminalResult(*out) {
		t.Fatal("signal facts lost", err)
	}
}

type uncomparableOwnedChild struct {
	*ownedCompletionDouble
	values []byte
}

type interfaceOwnedChild struct {
	*ownedCompletionDouble
	value any
}

func TestOwnedCompletionUnverifiableChildIdentityFailsClosed(t *testing.T) {
	for _, fault := range []string{"slice", "interface-slice", "typed-nil"} {
		t.Run(fault, func(t *testing.T) {
			f := newOwnedFixture(t, nil, nil, true)
			switch fault {
			case "slice":
				f.s.child = uncomparableOwnedChild{f.child, []byte("value")}
			case "interface-slice":
				f.s.child = interfaceOwnedChild{f.child, []byte("value")}
			case "typed-nil":
				f.s.child = (*ownedCompletionDouble)(nil)
			}
			unknown(t, f.s.WaitForCompletion(context.Background()))
			refuseOwned(t, f.s)
			if f.child.waits.Load() != 0 || f.child.reads != 0 || !f.s.uncertain {
				t.Fatal("unverifiable identity touched completion or output")
			}
		})
	}
}

func TestOwnedTerminalMissingOrRefusedObservationNeverProducesResult(t *testing.T) {
	for _, fault := range []string{"nil", "refused", "unknown", "raw-error", "undrained", "unknown-group", "unknown-descendants"} {
		t.Run(fault, func(t *testing.T) {
			f := newOwnedFixture(t, []byte("retained bytes"), nil, true)
			completeOwned(t, f)
			switch fault {
			case "nil":
				f.child.nilRead = true
			case "refused":
				f.child.readError = &NativeFailure{}
			case "unknown":
				f.child.readError = &NativeFailure{Unknown: true}
			case "raw-error":
				f.child.readError = errors.New("unknown read")
			case "undrained":
				f.child.mutate = func(_ int, out *Observation) { out.OutputDrained = false }
			case "unknown-group":
				f.child.mutate = func(_ int, out *Observation) { out.GroupCleanup = CleanupUnverified }
			case "unknown-descendants":
				f.child.mutate = func(_ int, out *Observation) { out.DescendantCleanup = CleanupUnverified }
			}
			err := refuseOwned(t, f.s)
			if fault == "refused" {
				if err.Error() != "PROCESS_NATIVE_REFUSED" {
					t.Fatal(err)
				}
			} else {
				unknown(t, err)
				unknown(t, refuseOwned(t, f.s))
			}
			if f.child.reads != 1 || f.s.terminal || f.child.cancels != 0 {
				t.Fatal("missing/unknown output escaped or caused another attempt")
			}
		})
	}
}

type forbiddenOwnedClock struct{}

func (forbiddenOwnedClock) Now() time.Time { panic("internal retention consulted authority clock") }

func TestOwnedTerminalMaximumSingleStreamAndImmutableExitCode(t *testing.T) {
	for _, stream := range []string{"stdout", "stderr"} {
		t.Run(stream, func(t *testing.T) {
			data := bytes.Repeat([]byte{0xff}, MaximumOutput)
			var stdout, stderr []byte
			if stream == "stdout" {
				stdout = data
			} else {
				stderr = data
			}
			f := newOwnedFixture(t, stdout, stderr, true)
			code := 4
			f.child.mutate = func(_ int, out *Observation) { out.ExitCode = &code }
			f.s.clock = forbiddenOwnedClock{}
			accesses := f.lease.accesses
			completeOwned(t, f)
			out, err := f.s.CaptureOwnedTerminal(context.Background())
			if err != nil || out == nil || !bytes.Equal(out.Observation.Stdout, stdout) || !bytes.Equal(out.Observation.Stderr, stderr) ||
				f.child.reads != MaximumOutput/WindowBytes || f.lease.accesses != accesses {
				t.Fatal("maximum stream was not collected in exact bounded windows", err)
			}
			code = 9
			if *out.Observation.ExitCode != 4 {
				t.Fatal("exit code remained aliased to child memory")
			}
		})
	}
}
