//go:build darwin && farol_native_process

package process

import (
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Actual retained Node watchdog and POSIX group; command is intentionally
// unconfined. This proves group cleanup, not Seatbelt/MCP/package or setsid.
func TestNativeWatchdogOrdinaryExitConfirmsGroup(t *testing.T) {
	selection := nativeWatchdogResource(t)
	for _, background := range []bool{false, true} {
		if !t.Run(map[bool]string{false: "exit-0", true: "background-inherited-pipe"}[background], func(t *testing.T) {
			f := nativeWatchdogStart(t, selection)
			f.observed.mutex.Lock()
			f.observed.supervisor = processsvc.SupervisorRunning
			f.observed.mutex.Unlock()
			command := "process.stdout.write('done\\n',()=>process.exit(0));"
			if background {
				command = `require("node:child_process").spawn("/bin/sleep",["8"],{detached:false,stdio:["ignore","inherit","inherit"]}).once("spawn",()=>process.stdout.write("done\n",()=>process.exit(0)));`
			}
			f.prepare(t, []string{"-e", command}, nil, map[string]string{})
			if err := f.child.send(f.ctx, watchdogControl{Type: "start", ID: f.child.id}); err != nil {
				f.fail(t, "single ordinary start unknown; no retry", err)
			}
			if err := f.child.await(f.ctx, f.child.ready); err != nil {
				f.fail(t, "original ready missing", err)
			}
			f.settle(t)
			out, err := f.observed.Read(f.ctx, processsvc.Window{})
			if err != nil || out.Supervisor != processsvc.SupervisorExited || out.ExitCode == nil || *out.ExitCode != 0 || !out.OutputDrained ||
				out.GroupCleanup != processsvc.CleanupConfirmed || out.DescendantCleanup != processsvc.CleanupUnverified || string(out.Stdout) != "done\n" {
				f.fail(t, "ordinary root/group cleanup unconfirmed or escaped descendants promoted", err)
			}
			f.helperExit(t, true)
		}) {
			return
		}
	}
}
