//go:build darwin && farol_native_process

package process

import (
	"bytes"
	"errors"
	"strconv"
	"syscall"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

const nativeGroupCancelReady = "group-child-ready\n"
const nativeGroupCancelFinal = "group-child-final\n"

// The handler is installed before either readiness marker. Both inherited
// streams stay open until TERM flushes the bounded final markers and exits.
// The fallback shares the fixture's original absolute deadline, emits no final
// marker and cannot satisfy successful cancellation assertions.
const nativeGroupCancelChild = `
const deadline = Number(process.argv[1]);
setTimeout(() => process.exit(91), Math.max(1, deadline - Date.now()));
process.on("SIGTERM", () => {
  process.stdout.write("group-child-final\n", () => {
    process.stderr.write("group-child-final\n", () => process.exit(0));
  });
});
process.send("ready", (error) => {
  if (error) { process.exit(94); return; }
  process.stdout.write("group-child-ready\n", () => {
    process.stderr.write("group-child-ready\n");
  });
});`

// Transport ONLY: one real Node root and one ordinary same-group Node child,
// retained watchdog IPC/decoder/output, and exact owning helper Wait. This does
// not qualify Seatbelt, packaging, installed profiles or general tree cleanup.
// Run only with a fresh native-lane grant and an explicit test selector.
func TestNativeWatchdogGroupCancellation(t *testing.T) {
	selection := nativeWatchdogResource(t)
	for _, mode := range []string{"live-root", "exited-root"} {
		if !t.Run(mode, func(t *testing.T) {
			f := nativeWatchdogStart(t, selection) // Separate original 12s deadline and IPC-only cleanup.
			f.observed.mutex.Lock()
			f.observed.supervisor = processsvc.SupervisorRunning
			f.observed.mutex.Unlock()
			deadline, _ := f.ctx.Deadline()
			// detached:false retains the watchdog's anchored group. No shell,
			// PID signalling, process discovery, alternate executable or fallback.
			// The private child IPC lets the root exit after the TERM handler is ready;
			// the watchdog still observes both inherited stdout/stderr directly.
			command := `
const mode = process.argv[1];
const deadline = Number(process.argv[2]);
setTimeout(() => process.exit(90), Math.max(1, deadline - Date.now()));
const child = require("node:child_process").spawn(process.execPath,
  ["-e", ` + strconv.Quote(nativeGroupCancelChild) + `, "--", process.argv[2]],
  { detached: false, env: {}, stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.once("error", () => process.exit(92));
child.once("message", (message) => {
  if (message !== "ready") process.exit(93);
  if (mode === "exited-root") process.exit(7);
});`
			f.prepare(t, []string{"-e", command, "--", mode, strconv.FormatInt(deadline.UnixMilli(), 10)}, nil, map[string]string{})
			if err := f.child.send(f.ctx, watchdogControl{Type: "start", ID: f.child.id}); err != nil {
				f.fail(t, "single original group cancellation start", err)
			}
			if err := f.child.await(f.ctx, f.child.ready); err != nil {
				f.fail(t, "original root ready frame", err)
			}
			nativeGroupCancelBeforeStop(t, f, mode)

			// Exactly one Cancel on this retained Child. Refusal/unknown is a
			// failure, never permission to resend, signal a PID or run another case.
			receipt, err := f.observed.Cancel(f.ctx)
			if err != nil || receipt == nil || receipt.Status != processsvc.CancelRequested || receipt.Handle != f.observed.Handle() {
				f.fail(t, "original group cancel ACK refused/unknown; no retry", err)
			}
			f.settle(t)
			out, err := f.observed.Read(f.ctx, processsvc.Window{})
			if err != nil || out.Root != processsvc.RootExited || out.Supervisor != processsvc.SupervisorExited ||
				!out.Waited || !out.OutputDrained || !out.CancelRequested || out.OutputLimitReached || out.TimedOut || out.AuthorityLost ||
				out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified {
				f.fail(t, "group cancellation settlement unavailable or cleanup overclaimed", err)
			}
			if mode == "live-root" {
				if out.ExitCode != nil || out.ExitSignal != int(syscall.SIGKILL) {
					f.fail(t, "original live root did not exit with signal 9", nil)
				}
			} else if out.ExitCode == nil || *out.ExitCode != 7 || out.ExitSignal != 0 {
				f.fail(t, "known original root exit changed after cancellation", nil)
			}
			want := []byte(nativeGroupCancelReady + nativeGroupCancelFinal)
			if !bytes.Equal(out.Stdout, want) || !bytes.Equal(out.Stderr, want) ||
				out.StdoutBytes != uint64(len(want)) || out.StderrBytes != uint64(len(want)) {
				f.fail(t, "child TERM final markers missing, duplicated or not drained", nil)
			}
			f.child.mutex.Lock()
			closed, uncertain, cohort, ack := f.child.rootClosed, f.child.uncertain, f.child.root.cohort, f.child.stopSeen
			f.child.mutex.Unlock()
			if !closed || uncertain || cohort || !ack {
				f.fail(t, "original decoder closure/ACK unknown or promoted to cleanup evidence", nil)
			}
			// Observe the real channel metadata; no fabricated frame or new owner.
			frames := f.channel.snapshot()
			counts := map[string]int{}
			for _, frame := range frames.Frames {
				if !frame.Complete || !frame.JSONValid {
					f.fail(t, "original group transport frame incomplete", nil)
				}
				counts[frame.Type]++
			}
			if frames.Stopped != "" || counts["prepared"] != 1 || counts["ready"] != 1 ||
				counts["stop-requested"] != 1 || counts["exit"] != 1 || counts["close"] != 1 ||
				counts["signal-refused"] != 0 || counts["error"] != 0 || counts["deadline"] != 0 {
				f.fail(t, "single original start/stop/exit facts unavailable", nil)
			}
			f.helperExit(t, true) // Independent final helper self-group SIGKILL.
			_, err = f.child.Wait()
			var failure *processsvc.NativeFailure
			if !errors.As(err, &failure) || !failure.Unknown || f.witness.calls.Load() != 1 {
				f.fail(t, "repeat decoder Wait reached the retained helper", err)
			}
		}) {
			return // Do not dispatch the next fixture after a refused/unknown failure.
		}
	}
}

func nativeGroupCancelBeforeStop(t *testing.T, f *nativeWatchdogFixture, mode string) {
	t.Helper()
	for {
		out, err := f.observed.Read(f.ctx, processsvc.Window{})
		if err != nil {
			f.fail(t, "original child readiness/root observation unavailable", err)
		}
		f.child.mutex.Lock()
		uncertain, closed, stopped := f.child.uncertain, f.child.rootClosed, f.child.stopSent
		f.child.mutex.Unlock()
		if uncertain || closed || stopped || out.OutputDrained || out.CancelRequested ||
			out.Supervisor != processsvc.SupervisorRunning || out.OutputLimitReached {
			f.fail(t, "original group fixture closed/stopped or became unknown before Cancel", nil)
		}
		ready := bytes.Equal(out.Stdout, []byte(nativeGroupCancelReady)) && bytes.Equal(out.Stderr, []byte(nativeGroupCancelReady))
		if ready {
			if mode == "live-root" {
				if out.Root != processsvc.RootRunning || out.Waited || out.ExitCode != nil || out.ExitSignal != 0 {
					f.fail(t, "original parent was not live before Cancel", nil)
				}
				return
			}
			if out.Root == processsvc.RootExited {
				if !out.Waited || out.ExitCode == nil || *out.ExitCode != 7 || out.ExitSignal != 0 {
					f.fail(t, "original exited parent code unknown before Cancel", nil)
				}
				return // Known exit, inherited pipes open, original supervisor still live.
			}
		}
		select {
		case <-f.observed.done:
			f.fail(t, "original supervisor completed before child readiness/root facts", nil)
		case <-f.ctx.Done():
			f.fail(t, "child readiness/root facts missed original deadline; no retry", f.ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}
