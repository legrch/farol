//go:build darwin

package execution

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
)

// Native witness for the relaunch Milestone. It is gated: a real apply to
// verified over scratch bundles on the real filesystem, the real journal, the
// real tree and identity verification, then the relaunch through Execute. It
// never runs Farol, Electron or any installed app, and it signals only the exact
// pid it started.
//
// What is NOT exercised here: LaunchServices. The identity policy requires the
// production bundle id, which an owner's running Farol also carries, so a
// scratch bundle launched through /usr/bin/open would collide with it. The open
// is therefore replaced by a direct exec of the installed scratch executable
// with the very argument open would pass. Whether LaunchServices starts the
// image is the platform's contract, as for Sparkle and Squirrel.Mac.
func requireNative(t *testing.T) {
	t.Helper()
	if os.Getenv("FAROL_RELAUNCH_NATIVE") != "1" {
		t.Skip("set FAROL_RELAUNCH_NATIVE=1 to run the real-filesystem relaunch witness")
	}
}

// spawnOpen stands in for /usr/bin/open: it runs the fences like the production
// open, starts the installed scratch executable and reports a nonzero status
// when exit is set.
type spawnOpen struct {
	app    string
	exit   error // returned instead of starting anything, like a nonzero open
	opens  int
	cmd    *exec.Cmd
	reaped chan struct{}
	t      *testing.T
}

func (p *spawnOpen) open(ctx context.Context, _ time.Time, arguments []string, fence func(context.Context) error) error {
	p.opens++
	if err := fence(ctx); err != nil {
		return err
	}
	if p.exit != nil {
		return p.exit
	}
	cmd := exec.Command(p.app+"/Contents/MacOS/Sleeper", arguments[4])
	cmd.Dir, cmd.Env = "/", []string{"PATH=/usr/bin:/bin"}
	if err := cmd.Start(); err != nil {
		return err
	}
	p.cmd, p.reaped = cmd, make(chan struct{})
	reaped := p.reaped
	go func() { _ = cmd.Wait(); close(reaped) }()
	p.t.Cleanup(func() {
		// Exact pid only; a no-op once the process is already gone.
		_ = cmd.Process.Kill()
		<-reaped
	})
	return fence(ctx)
}

func (p *spawnOpen) alive() bool {
	select {
	case <-p.reaped:
		return false
	default:
		return syscall.Kill(p.cmd.Process.Pid, 0) == nil
	}
}

// The whole Milestone, end to end: a real apply to verified over scratch
// bundles, then the relaunch through Execute. The process that runs is the
// installed target's executable, started with the protocol hint, and a returned
// zero open completes the journal. A nonzero open is the clean launch_failed.
func TestNativeMilestoneRelaunchEndToEnd(t *testing.T) {
	requireNative(t)
	exe := scratchExecutable(t, "good")
	for _, tc := range []struct {
		name string
		exit error
	}{
		{"zero open completes", nil},
		{"nonzero open is launch_failed", fail("launch_failed", false, false, errors.New("open exited with status 1"))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spawn := &spawnOpen{t: t, exit: tc.exit}
			f := newRelaunchLifecycle(t, exe, func(*relaunchLifecycle) openFunc { return spawn.open })
			spawn.app = f.app
			m, ready := f.prepare(t, "apply", true)
			result, err := f.run(t, m, ready)
			if err != nil {
				t.Fatal(describe(err))
			}
			if spawn.opens != 1 {
				t.Fatal("expected exactly one open", spawn.opens)
			}
			if tc.exit != nil {
				if result == nil || *result != (executionapp.Result{Phase: "launch_requested", Code: "launch_failed"}) {
					t.Fatal("a nonzero open was not the clean launch_failed", result)
				}
				f.physical(t, f.repo, "launch_requested")
				return
			}
			if result == nil || *result != (executionapp.Result{Phase: "completed"}) {
				t.Fatal("a zero open did not complete", result)
			}
			f.physical(t, f.repo, "completed")
			if !spawn.alive() {
				t.Fatal("the launched process was not left running")
			}
			lifecycleRequireTree(t, f.app, f.target)
		})
	}
}
