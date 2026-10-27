package process

import (
	"context"
	"errors"
	"fmt"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"io"
	"os"
	"sync"
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
				result = waited{result: exit{Code: &code, Waited: true, Drained: true, supervisorExited: true, groupGone: true, cohort: true}}
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
