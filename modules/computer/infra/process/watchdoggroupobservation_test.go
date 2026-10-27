//go:build darwin

package process

import (
	"context"
	"errors"
	"syscall"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// CPU-only syscall/clock values: no OS group is queried or signalled here.
func TestWatchdogGroupObservationIsBoundedReadOnlyAndFailsClosed(t *testing.T) {
	for _, mode := range []string{"gone", "reaped-later", "alive-or-reused", "denied", "unexpected"} {
		t.Run(mode, func(t *testing.T) {
			now := time.Unix(1, 0)
			calls := 0
			result := observeWatchdogGroupGone(1234, now.Add(25*time.Millisecond), func(pid int, sig syscall.Signal) error {
				calls++
				if pid != -1234 || sig != 0 {
					t.Fatal("cleanup probe sent an effect")
				}
				switch mode {
				case "gone":
					return syscall.ESRCH
				case "reaped-later":
					if calls > 1 {
						return syscall.ESRCH
					}
					return nil
				case "denied":
					return syscall.EPERM
				case "unexpected":
					return errors.New("controlled query failure")
				default:
					return nil
				}
			}, func() time.Time { return now }, func(d time.Duration) { now = now.Add(d) })
			if result != (mode == "gone" || mode == "reaped-later") || calls > 4 {
				t.Fatal("group existence/error became cleanup proof or unbounded polling", result, calls)
			}
		})
	}
	if observeWatchdogGroupGone(0, time.Time{}, nil, nil, nil) {
		t.Fatal("unsafe group identity accepted")
	}
}

func TestChildGroupWitnessNeverPromotesDescendantsOrUnknownWait(t *testing.T) {
	for _, bad := range []bool{false, true} {
		code := 0
		root := &ownedDouble{result: make(chan waited, 1)}
		child := &Child{handle: "group-observation", process: root, supervisor: processsvc.SupervisorRunning, root: processsvc.RootRunning, done: make(chan struct{}), signalUnknown: bad}
		root.result <- waited{result: exit{Code: &code, Waited: true, Drained: true, supervisorExited: true, groupGone: true}}
		child.wait()
		out, err := child.Read(context.Background(), processsvc.Window{})
		if err != nil || (out.GroupCleanup == processsvc.CleanupConfirmed) == bad || out.DescendantCleanup != processsvc.CleanupUnverified {
			t.Fatal("group proof repaired unknown control or became arbitrary descendant proof", out, err)
		}
	}
}
