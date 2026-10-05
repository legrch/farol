package process

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os/exec"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// CPU doubles only: neither exec.Cmd.Start/Wait, NewAnchor, native qualification,
// file measurement, shell, signals nor a provider is invoked. The real app and
// published contract exercise this adapter; typed receipts are not native proof.
type parentClock struct {
	mutex sync.Mutex
	now   time.Time
}

func (c *parentClock) Now() time.Time { c.mutex.Lock(); defer c.mutex.Unlock(); return c.now }
func (c *parentClock) advance(d time.Duration) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.now = c.now.Add(d)
}

type parentLease struct {
	mutex      sync.Mutex
	binding    port.TaskBinding
	deadline   time.Time
	snapshot   port.AccessSnapshot
	inspecting atomic.Bool
	revoked    bool
}

func (e *parentLease) Binding() port.TaskBinding { return e.binding }
func (e *parentLease) Deadline() time.Time       { return e.deadline }
func (e *parentLease) WithSnapshot(_ context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	e.mutex.Lock()
	defer e.mutex.Unlock()
	if id != e.binding.ParticipantID {
		return errors.New("wrong participant")
	}
	e.inspecting.Store(true)
	defer e.inspecting.Store(false)
	if e.revoked {
		return inspect(port.AccessSnapshot{})
	}
	p, a := e.snapshot.Participant.Clone(), e.snapshot.Approval.Clone()
	return inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
}
func (e *parentLease) change(f func(*port.AccessSnapshot)) {
	e.mutex.Lock()
	defer e.mutex.Unlock()
	f(&e.snapshot)
}

type parentReservation struct {
	lease  *parentLease
	calls  int
	intent processsvc.Intent
}

func (r *parentReservation) Reserve(_ context.Context, i processsvc.Intent) (*processsvc.ReservationReceipt, error) {
	if r.lease.inspecting.Load() {
		panic("reservation under owner gate")
	}
	r.calls++
	r.intent = i
	return &processsvc.ReservationReceipt{Status: processsvc.Reserved, Intent: i}, nil
}

type parentLink struct {
	result                  chan *AnchorReceipt
	stopped                 chan struct{}
	receives, stops, closes atomic.Int32
	receiveErr, stopErr     error
}

func (l *parentLink) Receive(ctx context.Context) (*AnchorReceipt, error) {
	l.receives.Add(1)
	select {
	case r := <-l.result:
		return r, l.receiveErr
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (l *parentLink) RequestStop(ctx context.Context) error {
	l.stops.Add(1)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	select {
	case l.stopped <- struct{}{}:
	default:
	}
	return l.stopErr
}
func (l *parentLink) Close() error { l.closes.Add(1); return nil }

type parentBootstrap struct {
	lease                   *parentLease
	cmd                     *exec.Cmd
	link                    *parentLink
	calls                   int
	launch                  AnchorLaunch
	out                     io.Writer
	before                  func()
	startErr                error
	missingCmd, missingLink bool
}

func (b *parentBootstrap) StartAnchor(ctx context.Context, l AnchorLaunch, check func(context.Context) error, out, diag io.Writer) (*exec.Cmd, AnchorLink, error) {
	if b.lease.inspecting.Load() {
		panic("bootstrap under owner gate")
	}
	b.calls++
	b.launch = l
	b.out = out
	if deadline, ok := ctx.Deadline(); !ok || !deadline.Equal(l.Deadline) {
		panic("deadline rebound")
	}
	if b.before != nil {
		b.before()
	}
	if err := check(ctx); err != nil {
		return nil, nil, err
	}
	if b.missingCmd {
		return nil, b.link, b.startErr
	}
	if b.missingLink {
		return b.cmd, nil, b.startErr
	}
	return b.cmd, b.link, b.startErr
}

type parentFixture struct {
	preparer      *Preparer
	route         *processcontract.Contract
	lease         *parentLease
	reservation   *parentReservation
	clock         *parentClock
	boot          *parentBootstrap
	evidence      *confinementEvidenceDouble
	timers        *timers
	waited        chan waited
	waitCalls     atomic.Int32
	measureCloses atomic.Int32
	cancel        context.CancelFunc
}

func newParentFixture(t *testing.T) *parentFixture {
	t.Helper()
	_, selection, command, evidence := confinementFixture(t)
	clock := &parentClock{now: time.UnixMilli(1900000000000)}
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7}, ParticipantID: "participant", TurnID: "turn"}
	selection.Snapshot.Participant.Grant.Identity = binding.Identity
	selection.Snapshot.Participant.Grant.ExpiresAt = clock.Now().Add(time.Hour)
	selection.Snapshot.Approval.ExpiresAt = clock.Now().Add(time.Hour)
	policy, err := NewSeatbelt(selection, evidence)
	if err != nil {
		t.Fatal(err)
	}
	command.Args = nil
	command.Input = nil
	command.Binding = nil
	lease := &parentLease{binding: binding, deadline: clock.Now().Add(15 * time.Second), snapshot: selection.Snapshot}
	link := &parentLink{result: make(chan *AnchorReceipt, 1), stopped: make(chan struct{}, 1)}
	boot := &parentBootstrap{lease: lease, cmd: &exec.Cmd{}, link: link}
	execution, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	preparer, err := NewAnchoredPreparer("operation", "cli", command, policy, boot, execution, clock)
	if err != nil {
		t.Fatal(err)
	}
	f := &parentFixture{preparer: preparer, lease: lease, clock: clock, boot: boot, evidence: evidence, timers: &timers{}, waited: make(chan waited, 1), cancel: cancel}
	preparer.anchor.measure = func(context.Context, Command, *confinedLaunch) (func(), error) {
		if lease.inspecting.Load() {
			panic("measurement under owner gate")
		}
		return func() { f.measureCloses.Add(1) }, nil
	}
	preparer.anchor.wait = func(cmd *exec.Cmd) (exit, error) {
		if cmd != boot.cmd {
			panic("waited replacement Cmd")
		}
		f.waitCalls.Add(1)
		v := <-f.waited
		return v.result, v.err
	}
	f.reservation = &parentReservation{lease: lease}
	service, err := processsvc.NewForInvocation("operation", lease, preparer, f.reservation, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	f.route, err = processcontract.New(service)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func parentInvocation() processcontract.Invocation {
	return processcontract.Invocation{RuntimeID: "cli", SessionID: "session", ModelID: "model", AdmissionID: "authority", Arguments: []string{"arg"}, Input: []byte("input")}
}
func (f *parentFixture) prepare(t *testing.T) {
	t.Helper()
	out, err := f.route.Prepare(context.Background(), processcontract.PrepareRequest{OperationID: "operation", Invocation: parentInvocation()})
	if err != nil || out == nil {
		t.Fatal(out, err)
	}
	f.preparer.selected.schedule = f.timers.schedule
}
func (f *parentFixture) start(t *testing.T) *processcontract.StartResponse {
	t.Helper()
	out, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err != nil || out == nil {
		t.Fatal(out, err)
	}
	return out
}
func (f *parentFixture) child() *Child {
	f.preparer.selected.mutex.Lock()
	defer f.preparer.selected.mutex.Unlock()
	return f.preparer.selected.retained
}
func parentClosedReceipt(f *parentFixture) *AnchorReceipt {
	code := 0
	return &AnchorReceipt{OperationID: f.boot.launch.OperationID, SealDigest: f.boot.launch.SealDigest, Report: AnchorReport{RootWaited: true, OutputDrained: true, KernelExit: true, ExecObserved: true, ExitCode: &code, GuestCohortClosed: true}}
}
func parentWaited() waited {
	code := 0
	return waited{result: exit{Code: &code, Waited: true, Drained: true}}
}
func (f *parentFixture) finish(t *testing.T, r *AnchorReceipt, w waited) {
	t.Helper()
	f.boot.link.result <- r
	f.waited <- w
	select {
	case <-f.child().done:
	case <-time.After(time.Second):
		t.Fatal("CPU wait did not settle")
	}
	if f.waitCalls.Load() != 1 {
		t.Fatal("owning Cmd not waited once")
	}
}
func parentUnknown(t *testing.T, err error) {
	t.Helper()
	var failure *processcontract.Failure
	if !errors.As(err, &failure) || failure.Outcome != "outcome_unknown" || failure.Retry != "never" {
		t.Fatal("not sticky unknown", err)
	}
}

func TestParentPublishedRouteEffectFreePreparationAndQualifiedConjunction(t *testing.T) {
	f := newParentFixture(t)
	if f.boot.calls != 0 || f.evidence.calls != 0 {
		t.Fatal("constructor effects")
	}
	f.prepare(t)
	selected := f.preparer.selected
	f.prepare(t)
	if f.preparer.selected != selected || f.boot.calls != 0 || f.reservation.calls != 0 || f.evidence.calls != 0 {
		t.Fatal("prepare executed or selected replacement")
	}
	changed := parentInvocation()
	changed.Arguments = []string{"other"}
	if _, err := f.preparer.Prepare(context.Background(), processsvc.Invocation{RuntimeID: changed.RuntimeID, SessionID: changed.SessionID, ModelID: changed.ModelID, AdmissionID: changed.AdmissionID, Arguments: changed.Arguments}); err == nil {
		t.Fatal("preparer rebound one anchor")
	}
	original := f.lease.deadline
	f.lease.deadline = original.Add(time.Hour)
	started := f.start(t)
	if !f.boot.launch.Deadline.Equal(original) {
		t.Fatal("reconnect extended original execution deadline")
	}
	if f.reservation.calls != 1 || f.boot.calls != 1 || f.evidence.calls != 0 || f.boot.launch.SealDigest != selected.Seal().Digest || !f.boot.launch.Deadline.Equal(f.reservation.intent.Deadline) || !reflect.DeepEqual(f.boot.launch.Original.Args, []string{"arg"}) || string(f.boot.launch.Original.Input) != "input" || f.boot.launch.Wrapped.Executable != seatbeltExecutable {
		t.Fatal("not exact reserved bounded launch")
	}
	f.boot.out.Write([]byte("synthetic output"))
	f.finish(t, parentClosedReceipt(f), parentWaited())
	out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: started.Handle})
	if err != nil || out == nil || out.State != processcontract.Terminal || out.GroupCleanup != processcontract.CleanupConfirmed || out.DescendantCleanup != processcontract.CleanupConfirmed || !out.OutputDrained || out.StdoutBase64 != base64.StdEncoding.EncodeToString([]byte("synthetic output")) {
		t.Fatal(out, err)
	}
	if f.boot.link.receives.Load() != 1 || f.boot.link.closes.Load() != 1 || f.boot.link.stops.Load() != 0 {
		t.Fatal("control duplicated")
	}
	f.start(t)
	if f.boot.calls != 1 {
		t.Fatal("replayed completed Start")
	}
}

func TestParentMissingOrCrossedEvidenceNeverConfirms(t *testing.T) {
	cases := map[string]func(*AnchorReceipt, *waited){
		"missing-receipt": func(r *AnchorReceipt, w *waited) { r.OperationID = "" },
		"operation":       func(r *AnchorReceipt, w *waited) { r.OperationID = "other" },
		"digest":          func(r *AnchorReceipt, w *waited) { r.SealDigest = "other" },
		"fork":            func(r *AnchorReceipt, w *waited) { r.Report.ForkObserved = true },
		"exec":            func(r *AnchorReceipt, w *waited) { r.Report.ExecObserved = false },
		"kernel-exit":     func(r *AnchorReceipt, w *waited) { r.Report.KernelExit = false },
		"guest-wait":      func(r *AnchorReceipt, w *waited) { r.Report.RootWaited = false },
		"guest-drain":     func(r *AnchorReceipt, w *waited) { r.Report.OutputDrained = false },
		"guest-cohort":    func(r *AnchorReceipt, w *waited) { r.Report.GuestCohortClosed = false },
		"guest-stop":      func(r *AnchorReceipt, w *waited) { r.Report.StopUnverified = true },
		"anchor-wait":     func(r *AnchorReceipt, w *waited) { w.result.Waited = false },
		"anchor-drain":    func(r *AnchorReceipt, w *waited) { w.result.Drained = false },
		"anchor-exit":     func(r *AnchorReceipt, w *waited) { code := 1; w.result.Code = &code },
		"anchor-signal":   func(r *AnchorReceipt, w *waited) { w.result.Signal = 9 },
		"wait-error":      func(r *AnchorReceipt, w *waited) { w.err = errors.New("wait unavailable") },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newParentFixture(t)
			f.prepare(t)
			started := f.start(t)
			r, w := parentClosedReceipt(f), parentWaited()
			change(r, &w)
			if name == "missing-receipt" {
				r = nil
			}
			f.finish(t, r, w)
			out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: started.Handle})
			if err != nil || out == nil || out.State != processcontract.Unknown || out.GroupCleanup != processcontract.CleanupUnverified || out.DescendantCleanup != processcontract.CleanupUnverified {
				t.Fatal(out, err)
			}
			if f.boot.link.closes.Load() != 1 || f.boot.link.receives.Load() != 1 {
				t.Fatal("read/close replayed")
			}
		})
	}
}

func TestParentPossibleStartRetainsWaitAndOneStopWithoutReplay(t *testing.T) {
	for _, mode := range []string{"unknown-ack", "refused-stop", "missing-link"} {
		t.Run(mode, func(t *testing.T) {
			f := newParentFixture(t)
			f.prepare(t)
			f.boot.startErr = errors.New("possible start, ACK lost")
			if mode == "refused-stop" {
				f.boot.link.stopErr = errors.New("stop refused")
			}
			if mode == "missing-link" {
				f.boot.missingLink = true
			}
			out, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			parentUnknown(t, err)
			if out != nil || f.preparer.RetainedHandle() == "" {
				t.Fatal("possible resource forgotten/disclosed")
			}
			f.child().Cancel(context.Background())
			f.child().Cancel(context.Background())
			expected := int32(1)
			if mode == "missing-link" {
				expected = 0
			}
			if f.boot.link.stops.Load() != expected {
				t.Fatal("stop retried")
			}
			f.finish(t, parentClosedReceipt(f), parentWaited())
			observed, _ := f.child().Read(context.Background(), processsvc.Window{})
			if observed.GroupCleanup != processsvc.CleanupUnverified || observed.DescendantCleanup != processsvc.CleanupUnverified {
				t.Fatal("unknown promoted by late receipt")
			}
			v := parentInvocation()
			selected, prepareErr := f.preparer.Prepare(context.Background(), processsvc.Invocation{RuntimeID: v.RuntimeID, SessionID: v.SessionID, ModelID: v.ModelID, AdmissionID: v.AdmissionID, Arguments: v.Arguments, Input: v.Input})
			if prepareErr != nil || selected != f.preparer.selected {
				t.Fatal("preparer reset unknown", prepareErr)
			}
			_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			parentUnknown(t, err)
			if f.boot.calls != 1 || f.reservation.calls != 1 || f.waitCalls.Load() != 1 || f.measureCloses.Load() != 1 {
				t.Fatal("uncertain operation replayed")
			}
		})
	}
}

func TestParentExecutionLifetimeIndependentOfOuterTurn(t *testing.T) {
	f := newParentFixture(t)
	f.prepare(t)
	outer, cancelOuter := context.WithCancel(context.Background())
	started, err := f.route.Start(outer, processcontract.StartRequest{OperationID: "operation"})
	if err != nil {
		t.Fatal(err)
	}
	cancelOuter()
	// Deterministic: the selected Child watches execution, and its link context is
	// derived from that same existing lifetime, not the now-cancelled outer context.
	c := f.child()
	p := c.process.(*parentChild)
	if p.ctx.Err() != nil || f.boot.link.stops.Load() != 0 {
		t.Fatal("outer turn cancelled admitted lease")
	}
	f.cancel()
	select {
	case <-f.boot.link.stopped:
	case <-time.After(time.Second):
		t.Fatal("execution owner did not stop")
	}
	f.finish(t, parentClosedReceipt(f), parentWaited())
	out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: started.Handle})
	if err != nil || out.State != processcontract.Unknown || f.boot.link.stops.Load() != 1 {
		t.Fatal(out, err)
	}
}

func TestParentOriginalDeadlineAndCurrentOwnerWinAtEveryPhase(t *testing.T) {
	for _, phase := range []string{"before-start", "held-release", "wait-expiry", "wait-revoke", "watch-revoke", "timeout"} {
		t.Run(phase, func(t *testing.T) {
			f := newParentFixture(t)
			f.prepare(t)
			revoke := func() { f.lease.change(func(s *port.AccessSnapshot) { s.Approval.Generation++ }) }
			if phase == "before-start" {
				revoke()
				if _, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"}); err == nil || f.boot.calls != 0 {
					t.Fatal("stale generation dispatched")
				}
				return
			}
			if phase == "held-release" {
				f.boot.before = revoke
				_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
				parentUnknown(t, err)
				if f.preparer.RetainedHandle() != "" || f.boot.calls != 1 {
					t.Fatal("revoke bypassed same Check")
				}
				return
			}
			started := f.start(t)
			original := f.boot.launch.Deadline
			switch phase {
			case "wait-expiry":
				f.clock.advance(15 * time.Second)
			case "wait-revoke":
				revoke()
			case "watch-revoke":
				revoke()
				f.timers.at(1).fire()
			case "timeout":
				f.clock.advance(15 * time.Second)
				f.timers.at(0).fire()
			}
			f.finish(t, parentClosedReceipt(f), parentWaited())
			observed, _ := f.child().Read(context.Background(), processsvc.Window{})
			if observed.GroupCleanup != processsvc.CleanupUnverified || observed.DescendantCleanup != processsvc.CleanupUnverified || !f.boot.launch.Deadline.Equal(original) {
				t.Fatal("expiry/revoke promoted or extended")
			}
			if phase == "watch-revoke" || phase == "timeout" {
				f.child().Cancel(context.Background())
				if f.boot.link.stops.Load() != 1 {
					t.Fatal("stop replayed")
				}
			}
			if out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: started.Handle}); err == nil || out != nil {
				t.Fatal("expired/revoked output disclosed")
			}
		})
	}
}

func TestParentMissingResourceAndReceiptErrorRemainOneAttempt(t *testing.T) {
	for _, mode := range []string{"missing-cmd", "receipt-error"} {
		t.Run(mode, func(t *testing.T) {
			f := newParentFixture(t)
			f.prepare(t)
			if mode == "missing-cmd" {
				f.boot.missingCmd = true
				out, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
				parentUnknown(t, err)
				if out != nil || f.preparer.RetainedHandle() != "" || f.boot.link.closes.Load() != 1 || f.waitCalls.Load() != 0 {
					t.Fatal("invented owning Cmd or forgot returned link")
				}
				_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
				parentUnknown(t, err)
			} else {
				f.boot.link.receiveErr = errors.New("receipt ACK unavailable")
				out := f.start(t)
				f.finish(t, parentClosedReceipt(f), parentWaited())
				read, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: out.Handle})
				if err != nil || read.State != processcontract.Unknown {
					t.Fatal("receipt error promoted", read, err)
				}
			}
			if f.boot.calls != 1 || f.reservation.calls != 1 || f.boot.link.stops.Load() != 0 || f.measureCloses.Load() != 1 {
				t.Fatal("unknown retried")
			}
		})
	}
}

func TestParentChangedOwnerPolicyNeverRebindsNativeLaunch(t *testing.T) {
	cases := map[string]func(*parentFixture){
		"generation-both": func(f *parentFixture) {
			f.lease.change(func(s *port.AccessSnapshot) { s.Approval.Generation++; s.Participant.Grant.ComputerGeneration++ })
		},
		"broader-grant": func(f *parentFixture) {
			f.lease.change(func(s *port.AccessSnapshot) { s.Participant.Grant.Workspaces[0].Root = "/approved/work" })
		},
		"exclusion": func(f *parentFixture) {
			f.lease.change(func(s *port.AccessSnapshot) {
				s.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/approved/work/project/private"}}
			})
		},
		"admission": func(f *parentFixture) {
			f.lease.change(func(s *port.AccessSnapshot) { s.Participant.Grant.AuthorityID = "new-grant" })
		},
		"root-identity": func(f *parentFixture) {
			f.lease.change(func(s *port.AccessSnapshot) { s.Approval.Workspaces[0].RootIdentity.Inode = "99" })
		},
		"expired-original": func(f *parentFixture) { f.clock.advance(15 * time.Second) },
		"revoked":          func(f *parentFixture) { f.lease.mutex.Lock(); f.lease.revoked = true; f.lease.mutex.Unlock() },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newParentFixture(t)
			f.prepare(t)
			change(f)
			if out, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"}); err == nil || out != nil || f.boot.calls != 0 || f.reservation.calls != 0 || f.evidence.calls != 0 {
				t.Fatal("policy change dispatched/widened", out, err)
			}
		})
	}
}

func TestParentConstructorAndExpiredSpawnCannotDispatch(t *testing.T) {
	f := newParentFixture(t)
	for _, name := range []string{"extended", "expired"} {
		t.Run(name, func(t *testing.T) {
			p := *f.preparer.anchor
			command := copyCommand(f.preparer.template)
			command.Binding = &InvocationBinding{RuntimeID: "cli", SessionID: "session", ModelID: "model", AdmissionID: "authority"}
			deadline := f.clock.Now().Add(16 * time.Second)
			if name == "expired" {
				deadline = f.clock.Now()
			}
			if _, err := p.StartLease(context.Background(), command, processsvc.SpawnRequest{Deadline: deadline, Check: func(context.Context) error { return nil }}, io.Discard, io.Discard); err == nil || f.boot.calls != 0 {
				t.Fatal("expired or extended lease dispatched")
			}
		})
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewAnchoredPreparer("operation", "cli", f.preparer.template, f.preparer.anchor.policy, f.boot, cancelled, f.clock); err == nil {
		t.Fatal("dead execution constructed")
	}
	if _, err := NewAnchoredPreparer("operation", "cli", f.preparer.template, nil, f.boot, context.Background(), f.clock); err == nil {
		t.Fatal("missing sealed policy constructed")
	}
	if _, err := f.preparer.anchor.Start(context.Background(), f.preparer.template, func(context.Context) error { return nil }, io.Discard, io.Discard); err == nil || f.boot.calls != 0 {
		t.Fatal("legacy Start fabricated deadline")
	}
}
