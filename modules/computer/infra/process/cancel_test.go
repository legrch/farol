package process

import (
	"context"
	"errors"
	"fmt"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// Existing Wait/Kill gates model OS reap before the Child waiter can publish.
// No OS process, signal, lease, disk state or group is created by these tests.
func TestCancelReapedRootWaitsForOriginalPublication(t *testing.T) {
	for _, done := range []error{os.ErrProcessDone, fmt.Errorf("retained root: %w", os.ErrProcessDone), syscall.ESRCH} {
		t.Run(done.Error(), func(t *testing.T) {
			child, root := settlementFixture(t)
			result := settlementCancel(child, context.Background())
			settlementReceive(t, root.killStarted)
			child.mutex.Lock()
			signalDone := child.signalDone
			child.mutex.Unlock()
			root.killResult <- done
			settlementReceive(t, signalDone)
			select {
			case got := <-result:
				t.Fatal("Cancel returned before original Wait publication", got)
			default:
			}
			code := 0
			root.waitResult <- waited{result: exit{Code: &code, Waited: true, Drained: true, supervisorExited: true, groupGone: true}}
			got := settlementReceive(t, result)
			if got.err != nil || got.receipt == nil || got.receipt.Status != processsvc.AlreadyTerminal {
				t.Fatal("reaped root poisoned by no-effect Kill", got)
			}
			out, err := child.Read(context.Background(), processsvc.Window{})
			if err != nil || out.Supervisor != processsvc.SupervisorExited || out.GroupCleanup != processsvc.CleanupConfirmed || out.DescendantCleanup != processsvc.CleanupUnverified {
				t.Fatal("wait/group facts lost or descendants promoted", out, err)
			}
			again, err := child.Cancel(context.Background())
			if err != nil || again.Status != processsvc.AlreadyTerminal || root.kills.Load() != 1 || root.waits.Load() != 1 {
				t.Fatal("original terminal control was replayed", again, err)
			}
		})
	}
}

func TestCancelReapedSignalCannotRepairUnknownWaitOrPriorControl(t *testing.T) {
	for _, priorUnknown := range []bool{false, true} {
		t.Run(fmt.Sprint("prior-unknown-", priorUnknown), func(t *testing.T) {
			child, root := settlementFixture(t)
			pending := settlementCancel(child, context.Background())
			settlementReceive(t, root.killStarted)
			child.mutex.Lock()
			signalDone := child.signalDone
			child.mutex.Unlock()
			root.killResult <- os.ErrProcessDone
			settlementReceive(t, signalDone)
			code := 0
			result := waited{err: errors.New("original Wait unavailable")}
			if priorUnknown {
				child.mutex.Lock()
				child.signalUnknown = true
				child.mutex.Unlock()
				result = waited{result: exit{Code: &code, Waited: true, Drained: true, supervisorExited: true, groupGone: true}}
			}
			root.waitResult <- result
			got := settlementReceive(t, pending)
			if got.err != nil || got.receipt == nil || got.receipt.Status != processsvc.CancelUnknown {
				t.Fatal("no-effect stop repaired missing/prior-unknown facts", got)
			}
			out, err := child.Read(context.Background(), processsvc.Window{})
			if err != nil || out.Supervisor != processsvc.SupervisorUnknown || out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified {
				t.Fatal("uncertain original evidence promoted", out, err)
			}
		})
	}
}

type heldCleanupHelper struct {
	entered, release chan struct{}
	gone             bool
}

func (*heldCleanupHelper) Wait() error                { return nil }
func (h *heldCleanupHelper) GroupGone(time.Time) bool { close(h.entered); <-h.release; return h.gone }

type closedCleanupControl struct{}

func (closedCleanupControl) Read([]byte) (int, error)         { return 0, io.EOF }
func (closedCleanupControl) Write([]byte) (int, error)        { return 0, io.ErrClosedPipe }
func (closedCleanupControl) Close() error                     { return nil }
func (closedCleanupControl) SetReadDeadline(time.Time) error  { return io.ErrClosedPipe }
func (closedCleanupControl) SetWriteDeadline(time.Time) error { return io.ErrClosedPipe }

// Real watchdog event publication plus a gated existing GroupGone port covers
// the root-waited/helper-reaped window without a timing sleep or PID lookup.
func TestCancelPublishedRootWaitsForWatchdogGroupPublication(t *testing.T) {
	for _, mode := range []string{"gone", "group-unverified", "observer-expired"} {
		t.Run(mode, func(t *testing.T) {
			helper := &heldCleanupHelper{entered: make(chan struct{}), release: make(chan struct{}), gone: mode != "group-unverified"}
			var once sync.Once
			release := func() { once.Do(func() { close(helper.release) }) }
			defer release()
			child := &Child{handle: "held-cleanup", supervisor: processsvc.SupervisorRunning, root: processsvc.RootRunning, done: make(chan struct{})}
			watchdog := newWatchdogChild(helper, closedCleanupControl{}, time.Now().Add(time.Minute), &testClock{value: time.Now()}, output{child, false}, output{child, true})
			watchdog.id = "held-cleanup"
			watchdog.readySeen = true
			child.process = watchdog
			if err := watchdog.event([]byte(`{"type":"close","id":"held-cleanup","code":0,"signal":null}`)); err != nil {
				t.Fatal(err)
			}
			close(watchdog.done)
			go child.wait()
			settlementReceive(t, helper.entered)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			marked := &settlementContext{Context: ctx, waiting: make(chan struct{})}
			pending := settlementCancel(child, marked)
			settlementReceive(t, marked.waiting)
			if mode == "observer-expired" {
				cancel()
				got := settlementReceive(t, pending)
				var failure *processsvc.NativeFailure
				if !errors.As(got.err, &failure) || !failure.Unknown {
					t.Fatal("expired observation claimed a terminal receipt", got)
				}
			}
			release()
			if mode != "observer-expired" {
				got := settlementReceive(t, pending)
				if got.err != nil || got.receipt == nil || got.receipt.Status != processsvc.AlreadyTerminal {
					t.Fatal("published root caused a new stop", got)
				}
			}
			settlementReceive(t, child.done)
			out, err := child.Read(context.Background(), processsvc.Window{})
			if err != nil || out.Supervisor != processsvc.SupervisorExited || (out.GroupCleanup == processsvc.CleanupConfirmed) != helper.gone || out.DescendantCleanup != processsvc.CleanupUnverified {
				t.Fatal("observer poisoned late cleanup or invented group proof", out, err)
			}
			if watchdog.stopSent {
				t.Fatal("stop sent to already-closed control channel")
			}
		})
	}
}

// CPU doubles only. The original Wait and Kill have independent release gates;
// no native process, signal, IPC, filesystem or cleanup qualification is used.
type settlementOwner struct {
	waitResult   chan waited
	killResult   chan error
	killStarted  chan struct{}
	waits, kills atomic.Int32
}

func (o *settlementOwner) Wait() (exit, error) {
	o.waits.Add(1)
	result := <-o.waitResult
	return result.result, result.err
}

func (o *settlementOwner) Kill() error {
	if o.kills.Add(1) == 1 {
		close(o.killStarted)
	}
	return <-o.killResult
}

func settlementFixture(t *testing.T) (*Child, *settlementOwner) {
	t.Helper()
	root := &settlementOwner{waitResult: make(chan waited, 1), killResult: make(chan error, 1), killStarted: make(chan struct{})}
	c := &Child{handle: "cpu-settlement", process: root, supervisor: processsvc.SupervisorRunning,
		root: processsvc.RootRunning, group: processsvc.CleanupPending, descendants: processsvc.CleanupPending, done: make(chan struct{})}
	go c.wait()
	// Release outstanding doubles even when a regression assertion fails.
	t.Cleanup(func() {
		select {
		case root.waitResult <- waited{}:
		default:
		}
		select {
		case root.killResult <- errors.New("fixture closed"):
		default:
		}
	})
	return c, root
}

type settlementCancelResult struct {
	receipt *processsvc.CancelReceipt
	err     error
}

func settlementCancel(c *Child, ctx context.Context) <-chan settlementCancelResult {
	result := make(chan settlementCancelResult, 1)
	go func() { receipt, err := c.Cancel(ctx); result <- settlementCancelResult{receipt, err} }()
	return result
}

func settlementReceive[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case result := <-ch:
		return result
	case <-time.After(time.Second):
		t.Fatal("CPU settlement did not resolve")
	}
	var zero T
	return zero
}

func settlementRootWait(t *testing.T, c *Child, root *settlementOwner) {
	t.Helper()
	code := 7
	root.waitResult <- waited{result: exit{Code: &code, Waited: true, Drained: true, supervisorExited: true}}
	deadline := time.After(time.Second)
	for {
		out, err := c.Read(context.Background(), processsvc.Window{})
		if err != nil {
			t.Fatal(err)
		}
		if out.Waited {
			if out.Root != processsvc.RootExited || !out.OutputDrained || out.ExitCode == nil || *out.ExitCode != 7 {
				t.Fatal("original root facts lost", out)
			}
			return
		}
		select {
		case <-deadline:
			t.Fatal("original root Wait was blocked by control settlement")
		case <-time.After(time.Millisecond):
		}
	}
}

func requireSettlement(t *testing.T, c *Child, root *settlementOwner, want processsvc.SupervisorState) {
	t.Helper()
	settlementReceive(t, c.done)
	out, err := c.Read(context.Background(), processsvc.Window{})
	if err != nil || out == nil || out.Supervisor != want || out.Root != processsvc.RootExited || !out.Waited || !out.OutputDrained ||
		!out.CancelRequested || out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified ||
		root.waits.Load() != 1 || root.kills.Load() != 1 {
		t.Fatal("settlement lost facts, replayed control or promoted cleanup", out, err)
	}
}

func TestChildCancellationSettlementWaitBeforeKillResolution(t *testing.T) {
	for _, name := range []string{"acknowledged", "refused", "unknown"} {
		t.Run(name, func(t *testing.T) {
			c, root := settlementFixture(t)
			cancel := settlementCancel(c, context.Background())
			settlementReceive(t, root.killStarted)
			settlementRootWait(t, c, root)
			select {
			case <-c.done:
				t.Fatal("root Wait notified completion before original Kill resolved")
			default:
			}
			select {
			case result := <-cancel:
				t.Fatal("pending control produced a cancellation result", result)
			default:
			}
			var stopErr error
			wantStatus, wantSupervisor := processsvc.CancelRequested, processsvc.SupervisorExited
			if name != "acknowledged" {
				stopErr = &processsvc.NativeFailure{Unknown: name == "unknown"}
				wantStatus, wantSupervisor = processsvc.CancelUnknown, processsvc.SupervisorUnknown
			}
			root.killResult <- stopErr
			result := settlementReceive(t, cancel)
			if result.err != nil || result.receipt == nil || result.receipt.Status != wantStatus {
				t.Fatal("Wait/ACK race changed the original control result", result)
			}
			requireSettlement(t, c, root, wantSupervisor)
			for range 2 {
				receipt, err := c.Cancel(context.Background())
				if err != nil || receipt == nil || receipt.Status != wantStatus || root.kills.Load() != 1 {
					t.Fatal("settled control was lost or replayed", receipt, err)
				}
			}
		})
	}
}

// The marker proves a joining Cancel has reached its pending-result select;
// assertions do not depend on a goroutine merely having been scheduled.
type settlementContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *settlementContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestChildCancellationSettlementConcurrentRequests(t *testing.T) {
	for _, origin := range []string{"cancel", "deadline"} {
		for _, name := range []string{"acknowledged", "refused", "unknown"} {
			t.Run(origin+"/"+name, func(t *testing.T) {
				c, root := settlementFixture(t)
				var first <-chan settlementCancelResult
				automatic := make(chan struct{})
				if origin == "cancel" {
					first = settlementCancel(c, context.Background())
				} else {
					go func() { c.stop(true); close(automatic) }()
				}
				settlementReceive(t, root.killStarted)
				requests := make([]<-chan settlementCancelResult, 8)
				for i := range requests {
					ctx := &settlementContext{Context: context.Background(), waiting: make(chan struct{})}
					requests[i] = settlementCancel(c, ctx)
					settlementReceive(t, ctx.waiting)
					select {
					case result := <-requests[i]:
						t.Fatal("concurrent request escaped pending original control", result)
					default:
					}
				}
				settlementRootWait(t, c, root)
				var stopErr error
				status, supervisor := processsvc.CancelRequested, processsvc.SupervisorExited
				if name != "acknowledged" {
					stopErr = &processsvc.NativeFailure{Unknown: name == "unknown"}
					status, supervisor = processsvc.CancelUnknown, processsvc.SupervisorUnknown
				}
				root.killResult <- stopErr
				if first != nil {
					requests = append(requests, first)
				} else {
					settlementReceive(t, automatic)
				}
				for _, request := range requests {
					result := settlementReceive(t, request)
					if result.err != nil || result.receipt == nil || result.receipt.Status != status {
						t.Fatal("concurrent control result changed", result)
					}
				}
				requireSettlement(t, c, root, supervisor)
				out, _ := c.Read(context.Background(), processsvc.Window{})
				if out.TimedOut != (origin == "deadline") {
					t.Fatal("joining cancellation changed the original timeout", out)
				}
			})
		}
	}
}

func TestChildCancellationSettlementContextLossStaysUnknown(t *testing.T) {
	for _, origin := range []string{"cancel", "automatic"} {
		t.Run(origin, func(t *testing.T) {
			c, root := settlementFixture(t)
			automatic := make(chan struct{})
			if origin == "automatic" {
				go func() { c.stop(false); close(automatic) }()
				settlementReceive(t, root.killStarted)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			marked := &settlementContext{Context: ctx, waiting: make(chan struct{})}
			request := settlementCancel(c, marked)
			settlementReceive(t, root.killStarted)
			settlementReceive(t, marked.waiting)
			settlementRootWait(t, c, root)
			cancel()
			result := settlementReceive(t, request)
			var failure *processsvc.NativeFailure
			if result.receipt != nil || !errors.As(result.err, &failure) || !failure.Unknown {
				t.Fatal("context loss acknowledged unresolved control", result)
			}
			select {
			case <-c.done:
				t.Fatal("context loss completed pending original Kill")
			default:
			}
			root.killResult <- nil // Later original success cannot repair lost acknowledgement.
			if origin == "automatic" {
				settlementReceive(t, automatic)
			}
			requireSettlement(t, c, root, processsvc.SupervisorUnknown)
			receipt, err := c.Cancel(context.Background())
			if err != nil || receipt == nil || receipt.Status != processsvc.CancelUnknown || root.kills.Load() != 1 {
				t.Fatal("lost acknowledgement cleared or replayed", receipt, err)
			}
		})
	}
}

func TestChildCancellationSettlementLateContextLoss(t *testing.T) {
	c, root := settlementFixture(t)
	root.killResult <- nil
	// Err passes at admission and fails after the completed Kill select.
	result := settlementReceive(t, settlementCancel(c, &completionLateContext{Context: context.Background()}))
	var failure *processsvc.NativeFailure
	if result.receipt != nil || !errors.As(result.err, &failure) || !failure.Unknown {
		t.Fatal("late caller loss was acknowledged", result)
	}
	settlementRootWait(t, c, root)
	requireSettlement(t, c, root, processsvc.SupervisorUnknown)
}

func TestChildCancellationSettlementAcknowledgementAloneIsNotCompletion(t *testing.T) {
	c, root := settlementFixture(t)
	root.killResult <- nil
	result := settlementReceive(t, settlementCancel(c, context.Background()))
	if result.err != nil || result.receipt == nil || result.receipt.Status != processsvc.CancelRequested {
		t.Fatal(result)
	}
	select {
	case <-c.done:
		t.Fatal("stop acknowledgement supplied original Wait")
	default:
	}
	out, err := c.Read(context.Background(), processsvc.Window{})
	if err != nil || out.Supervisor != processsvc.SupervisorRunning || out.Waited || out.OutputDrained || out.Root != processsvc.RootRunning ||
		out.GroupCleanup != processsvc.CleanupPending || out.DescendantCleanup != processsvc.CleanupPending {
		t.Fatal("stop intent invented completion or cleanup", out, err)
	}
	settlementRootWait(t, c, root)
	requireSettlement(t, c, root, processsvc.SupervisorExited)
}

func TestChildCancellationSettlementLegacyCleanupRemainsUnverified(t *testing.T) {
	c, root := settlementFixture(t)
	c.mutex.Lock()
	c.supervisor = ""
	c.mutex.Unlock()
	root.killResult <- nil
	result := settlementReceive(t, settlementCancel(c, context.Background()))
	if result.err != nil || result.receipt == nil || result.receipt.Status != processsvc.CancelRequested {
		t.Fatal(result)
	}
	settlementRootWait(t, c, root)
	requireSettlement(t, c, root, "")
}

func TestChildCancellationSettlementAcknowledgementCannotRepairIncompleteWait(t *testing.T) {
	for _, name := range []string{"prior-unknown", "helper-unverified", "root-unwaited", "undrained", "wait-error"} {
		t.Run(name, func(t *testing.T) {
			c, root := settlementFixture(t)
			code := 7
			result := waited{result: exit{Code: &code, Waited: true, Drained: true, supervisorExited: true}}
			switch name {
			case "prior-unknown":
				c.mutex.Lock()
				c.supervisor = processsvc.SupervisorUnknown
				c.mutex.Unlock()
			case "helper-unverified":
				result.result.supervisorExited = false
			case "root-unwaited":
				result.result.Waited = false
			case "undrained":
				result.result.Drained = false
			case "wait-error":
				result.err = errors.New("original Wait unresolved")
			}
			root.killResult <- nil
			cancel := settlementReceive(t, settlementCancel(c, context.Background()))
			if cancel.err != nil || cancel.receipt == nil || cancel.receipt.Status != processsvc.CancelRequested {
				t.Fatal("original acknowledged control changed", cancel)
			}
			root.waitResult <- result
			settlementReceive(t, c.done)
			out, err := c.Read(context.Background(), processsvc.Window{})
			if err != nil || out == nil || out.Supervisor != processsvc.SupervisorUnknown ||
				out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified ||
				root.waits.Load() != 1 || root.kills.Load() != 1 {
				t.Fatal("acknowledgement repaired incomplete Wait or uncertainty", out, err)
			}
		})
	}
}

func TestChildCancellationSettlementFenceWhileControlPendingStaysUnknown(t *testing.T) {
	c, root := settlementFixture(t)
	cancel := settlementCancel(c, context.Background())
	settlementReceive(t, root.killStarted)
	settlementRootWait(t, c, root)
	// Simulate the existing IPC fence after positive Wait, before delayed ACK.
	c.mutex.Lock()
	c.supervisor = processsvc.SupervisorUnknown
	c.mutex.Unlock()
	root.killResult <- nil
	result := settlementReceive(t, cancel)
	if result.err != nil || result.receipt == nil || result.receipt.Status != processsvc.CancelRequested {
		t.Fatal("original control result changed", result)
	}
	requireSettlement(t, c, root, processsvc.SupervisorUnknown)
}
