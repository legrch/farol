package process

import (
	"context"
	"errors"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// CPU-only boundary and manual timers: these cases control callback ordering,
// not native scheduling, signal delivery, descendant cleanup or runtime timing.
func TestCurrentWatchPreservesOriginalDeadlineStopReason(t *testing.T) {
	for _, test := range []struct {
		name          string
		first         string
		elapsed       time.Duration
		timedOut      bool
		authorityLost bool
	}{
		{name: "watch-at-deadline", first: "watch", elapsed: 15 * time.Second, timedOut: true, authorityLost: true},
		{name: "watch-after-deadline", first: "watch", elapsed: 15*time.Second + time.Millisecond, timedOut: true, authorityLost: true},
		{name: "deadline-first", first: "deadline", elapsed: 15 * time.Second, timedOut: true},
		{name: "denial-before-deadline", first: "watch", elapsed: 15*time.Second - time.Millisecond, authorityLost: true},
		{name: "cancel-before-deadline", first: "cancel", elapsed: 15*time.Second - time.Millisecond},
	} {
		t.Run(test.name, func(t *testing.T) {
			p, boundary, clock, scheduled := fixture(t)
			started := clock.Now()
			originalDeadline := started.Add(15 * time.Second)
			denied := false
			child := spawn(t, p, clock, func(context.Context) error {
				if !clock.Now().Before(originalDeadline) {
					return authority.Fail("AUTHORITY_EXPIRED", "task-grant")
				}
				if denied {
					return errors.New("current owner denied")
				}
				return nil
			})
			if scheduled.at(0).duration != originalDeadline.Sub(started) {
				t.Error("selected deadline changed")
			}
			clock.value, denied = started.Add(test.elapsed), true
			switch test.first {
			case "watch":
				scheduled.at(1).fire()
			case "deadline":
				scheduled.at(0).fire()
			case "cancel":
				if receipt, err := child.Cancel(context.Background()); err != nil || receipt == nil || receipt.Status != processsvc.CancelRequested {
					t.Error("original cancellation was not acknowledged", receipt, err)
				}
			}
			// Later callbacks and callers join the original stop. They cannot
			// reclassify a cancellation or denial chosen before the deadline.
			clock.value = originalDeadline.Add(time.Second)
			scheduled.at(0).fire()
			scheduled.at(1).fire()
			if receipt, err := child.Cancel(context.Background()); err != nil || receipt == nil || receipt.Status != processsvc.CancelRequested {
				t.Error("joining cancellation changed the original acknowledgement", receipt, err)
			}
			select {
			case <-child.done:
				t.Error("stop acknowledgement supplied the original Wait")
			default:
			}
			pending, pendingErr := child.Read(context.Background(), processsvc.Window{})
			finish(t, child, boundary, true)
			out, err := child.Read(context.Background(), processsvc.Window{})
			if pendingErr != nil || pending == nil || pending.Root != processsvc.RootRunning || pending.Waited || pending.OutputDrained ||
				pending.GroupCleanup != processsvc.CleanupPending || pending.DescendantCleanup != processsvc.CleanupPending {
				t.Fatal("stop request invented root completion or cleanup", pending, pendingErr)
			}
			if err != nil || out == nil || !out.CancelRequested || out.TimedOut != test.timedOut || out.AuthorityLost != test.authorityLost {
				t.Fatal("original stop reason changed", out, err)
			}
			if boundary.calls != 1 || boundary.root.killCount() != 1 || out.Root != processsvc.RootExited || !out.Waited || !out.OutputDrained ||
				out.ExitCode == nil || *out.ExitCode != 0 || out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified {
				t.Fatal("original start/stop/Wait ownership changed or cleanup was promoted", out)
			}
		})
	}
}
