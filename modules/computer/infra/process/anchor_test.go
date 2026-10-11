package process

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"sync"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// All native ports, self-group inspection, kqueue, held bootstrap and publication
// are PRIVATE doubles. The empty Cmd is never started or inspected. No native
// constructor, process, signal, endpoint, provider or old cohort is touched.
type heldGateDouble struct {
	events           *[]string
	releaseErr       error
	releases, closes int
	beforeRelease    func()
}

func (g *heldGateDouble) Ready(context.Context) error {
	*g.events = append(*g.events, "ready")
	return nil
}
func (g *heldGateDouble) Release(context.Context) error {
	g.releases++
	*g.events = append(*g.events, "release")
	if g.beforeRelease != nil {
		g.beforeRelease()
	}
	return g.releaseErr
}
func (g *heldGateDouble) Close() error { g.closes++; return nil }

type bootstrapDouble struct {
	stdout, stderr io.Writer
	gate           *heldGateDouble
	events         *[]string
	calls          int
	err            error
	before         func()
}

func (b *bootstrapDouble) StartHeld(_ context.Context, _ Command, out, diagnostic io.Writer) (*exec.Cmd, HeldGate, error) {
	b.stdout, b.stderr = out, diagnostic
	b.calls++
	*b.events = append(*b.events, "bootstrap")
	if b.before != nil {
		b.before()
	}
	return &exec.Cmd{}, b.gate, b.err
}

type stopDouble struct {
	calls int
	err   error
}

func (s *stopDouble) Stop() error { s.calls++; return s.err }

type reporterDouble struct {
	reports []AnchorReport
	err     error
	before  func()
}

func (r *reporterDouble) Publish(_ context.Context, report AnchorReport) error {
	r.reports = append(r.reports, report)
	if r.before != nil {
		r.before()
	}
	return r.err
}

type trackedDouble struct {
	mutex               sync.Mutex
	report              AnchorReport
	err                 error
	closes              int
	waitStarted, closed chan struct{}
	onWait              func()
}

func (g *trackedDouble) Wait() (AnchorReport, error) {
	if g.onWait != nil {
		g.onWait()
	}
	if g.waitStarted != nil {
		close(g.waitStarted)
		<-g.closed
	}
	return g.report, g.err
}
func (g *trackedDouble) Close() error {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	g.closes++
	if g.closed != nil && g.closes == 1 {
		close(g.closed)
	}
	return nil
}
func (g *trackedDouble) closeCount() int { g.mutex.Lock(); defer g.mutex.Unlock(); return g.closes }

type anchorFixtureValue struct {
	anchor         *Anchor
	command        Command
	clock          *testClock
	deadline       time.Time
	control        AnchorControl
	parent, cancel chan struct{}
	gate           *heldGateDouble
	bootstrap      *bootstrapDouble
	stop           *stopDouble
	reporter       *reporterDouble
	guest          *trackedDouble
	events         []string
	checks         int
	checkErrAt     int
}

func anchorFixture(t *testing.T) *anchorFixtureValue {
	t.Helper()
	_, original, _, _, _, clock, deadline := qualificationFixture(t)
	f := &anchorFixtureValue{command: original, clock: clock, deadline: deadline, parent: make(chan struct{}), cancel: make(chan struct{})}
	f.control = AnchorControl{ParentGone: f.parent, Cancel: f.cancel}
	f.gate = &heldGateDouble{events: &f.events}
	f.bootstrap = &bootstrapDouble{gate: f.gate, events: &f.events}
	f.stop = &stopDouble{}
	f.reporter = &reporterDouble{}
	code := 0
	f.guest = &trackedDouble{report: AnchorReport{RootWaited: true, OutputDrained: true, KernelExit: true, ExecObserved: true, ExitCode: &code}}
	f.anchor = &Anchor{bootstrap: f.bootstrap, reporter: f.reporter, stop: f.stop, clock: clock, watch: func(_ context.Context, _ *exec.Cmd, gate HeldGate) (trackedGuest, error) {
		f.events = append(f.events, "watch")
		if gate.Ready(context.Background()) != nil {
			t.Fatal("first barrier")
		}
		f.events = append(f.events, "listener")
		if gate.Ready(context.Background()) != nil {
			t.Fatal("second barrier")
		}
		return f.guest, nil
	}}
	return f
}
func (f *anchorFixtureValue) check(context.Context) error {
	f.checks++
	f.events = append(f.events, "check")
	if f.checks == f.checkErrAt {
		return errors.New("current owner refused")
	}
	return nil
}
func (f *anchorFixtureValue) run(ctx context.Context) (*AnchorReport, error) {
	return f.anchor.Run(ctx, f.command, f.deadline, f.control, f.check, io.Discard, io.Discard)
}
func (f *anchorFixtureValue) requireUnknown(t *testing.T, report *AnchorReport, err error) {
	t.Helper()
	var failed *processsvc.NativeFailure
	if !errors.As(err, &failed) || !failed.Unknown || report == nil || !report.StopRequested || !report.StopUnverified || report.GuestCohortClosed || f.stop.calls != 1 || len(f.reporter.reports) != 1 {
		t.Fatal("unknown/one stop not preserved", report, err)
	}
}
func TestAnchorDoubleInstallsListenerAndCurrentGuardBeforeOneRelease(t *testing.T) {
	f := anchorFixture(t)
	report, err := f.run(context.Background())
	if err != nil || report == nil {
		t.Fatal(err)
	}
	expected := []string{"check", "bootstrap", "watch", "ready", "listener", "ready", "check", "release", "check"}
	if len(f.events) != len(expected) {
		t.Fatal(f.events)
	}
	for i := range expected {
		if f.events[i] != expected[i] {
			t.Fatal(f.events)
		}
	}
	if !report.GuestCohortClosed || f.gate.releases != 1 || f.bootstrap.calls != 1 || len(f.reporter.reports) != 1 || f.stop.calls != 0 || f.gate.closes != 1 || f.guest.closeCount() != 1 {
		t.Fatal("settlement facts / ownership")
	}
	if _, err := f.run(context.Background()); err == nil || f.bootstrap.calls != 1 || f.gate.releases != 1 {
		t.Fatal("second guest attempt")
	}
}
func TestAnchorDoubleIncompleteOrForkedGuestNeverSettlesCohort(t *testing.T) {
	cases := map[string]func(*AnchorReport){
		"no-wait": func(r *AnchorReport) { r.RootWaited = false }, "no-drain": func(r *AnchorReport) { r.OutputDrained = false }, "no-kernel-exit": func(r *AnchorReport) { r.KernelExit = false }, "no-exec": func(r *AnchorReport) { r.ExecObserved = false }, "fork": func(r *AnchorReport) { r.ForkObserved = true }, "ambiguous-exit": func(r *AnchorReport) { r.ExitSignal = 9 }, "missing-exit": func(r *AnchorReport) { r.ExitCode = nil }, "previous-stop": func(r *AnchorReport) { r.StopRequested = true },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := anchorFixture(t)
			change(&f.guest.report)
			r, e := f.run(context.Background())
			f.requireUnknown(t, r, e)
			if f.gate.closes != 1 || f.guest.closeCount() != 1 {
				t.Fatal("owned controls leaked")
			}
		})
	}
}
func TestAnchorDoubleParentAlreadyGoneOrRevokedBeforeBootstrapHasNoEffect(t *testing.T) {
	for _, which := range []string{"parent", "cancel", "owner"} {
		t.Run(which, func(t *testing.T) {
			f := anchorFixture(t)
			switch which {
			case "parent":
				close(f.parent)
			case "cancel":
				close(f.cancel)
			case "owner":
				f.checkErrAt = 1
			}
			if r, e := f.run(context.Background()); r != nil || e == nil || f.bootstrap.calls != 0 || f.stop.calls != 0 || len(f.reporter.reports) != 0 {
				t.Fatal("refusal started guest")
			}
		})
	}
}
func TestAnchorDoubleBootstrapWatchReleaseUnknownHaveNoSecondAttempt(t *testing.T) {
	for _, which := range []string{"bootstrap", "watch", "release", "owner", "expiry"} {
		t.Run(which, func(t *testing.T) {
			f := anchorFixture(t)
			switch which {
			case "bootstrap":
				f.bootstrap.err = errors.New("possible start")
			case "watch":
				f.anchor.watch = func(context.Context, *exec.Cmd, HeldGate) (trackedGuest, error) {
					return nil, errors.New("observer lost")
				}
			case "release":
				f.gate.releaseErr = errors.New("release ACK unknown")
			case "owner":
				f.checkErrAt = 2
			case "expiry":
				f.bootstrap.before = func() { f.clock.value = f.deadline }
			}
			r, e := f.run(context.Background())
			f.requireUnknown(t, r, e)
			calls, releases := f.bootstrap.calls, f.gate.releases
			if _, e := f.run(context.Background()); e == nil || f.bootstrap.calls != calls || f.gate.releases != releases || f.stop.calls != 1 || len(f.reporter.reports) != 1 || f.gate.closes != 1 {
				t.Fatal("reissued unknown guest or publication")
			}
		})
	}
}
func TestAnchorDoubleParentDisconnectAfterReleaseRequestsStopOnce(t *testing.T) {
	f := anchorFixture(t)
	f.guest.waitStarted = make(chan struct{})
	f.guest.closed = make(chan struct{})
	type result struct {
		r *AnchorReport
		e error
	}
	done := make(chan result, 1)
	go func() { r, e := f.run(context.Background()); done <- result{r, e} }()
	<-f.guest.waitStarted
	close(f.parent)
	value := <-done
	f.requireUnknown(t, value.r, value.e)
	if f.gate.releases != 1 || f.guest.closeCount() != 1 {
		t.Fatal("wrong held ownership")
	}
}
func TestAnchorDoublePublicationOrSignalRefusalIsNeverRetried(t *testing.T) {
	for _, which := range []string{"publication", "signal"} {
		t.Run(which, func(t *testing.T) {
			f := anchorFixture(t)
			if which == "publication" {
				f.reporter.err = errors.New("possible result publish")
			} else {
				f.guest.report.ForkObserved = true
				f.stop.err = errors.New("stop refused")
			}
			r, e := f.run(context.Background())
			f.requireUnknown(t, r, e)
			// A publication ACK loss cannot cause a second downgraded receipt write.
			if len(f.reporter.reports) != 1 || f.stop.calls != 1 {
				t.Fatal("retried possible publication/stop")
			}
		})
	}
}
func TestAnchorDoubleFinalOwnerLossOrExpiryCannotBecomeTerminal(t *testing.T) {
	for _, which := range []string{"owner", "expiry", "cancel"} {
		t.Run(which, func(t *testing.T) {
			f := anchorFixture(t)
			switch which {
			case "owner":
				f.checkErrAt = 3
			case "expiry":
				f.guest.onWait = func() { f.clock.value = f.deadline }
			case "cancel":
				f.guest.onWait = func() { close(f.cancel) }
			}
			r, e := f.run(context.Background())
			f.requireUnknown(t, r, e)
		})
	}
}
func TestAnchorDoubleCannotExtendOriginalOrdinaryBudget(t *testing.T) {
	f := anchorFixture(t)
	f.deadline = f.deadline.Add(time.Nanosecond)
	if r, e := f.run(context.Background()); r != nil || e == nil || f.bootstrap.calls != 0 {
		t.Fatal("expanded ordinary budget")
	}
}
