//go:build darwin && farol_native_process

package process

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"syscall"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// One bounded ordinary POSIX tree through the real watchdog and Go decoder.
// Exact reported PIDs are queried read-only with Getpgid; never discovered or
// signalled by this test. Only the original retained Child.Cancel sends Stop.
// This is not Seatbelt/MCP/package or escaped-descendant qualification. Public
// cleanup remains unverified: these observations do not grant new authority.
func TestNativeWatchdogOwnedTreeCancellation(t *testing.T) {
	f := nativeWatchdogStart(t, nativeWatchdogResource(t))
	f.observed.mutex.Lock()
	f.observed.supervisor = processsvc.SupervisorRunning
	f.observed.mutex.Unlock()
	deadline, _ := f.ctx.Deadline()
	leaf := `
setTimeout(() => process.exit(91), Math.max(1, Number(process.argv[1]) - Date.now()));
process.on("SIGTERM", () => process.stdout.write("leaf-final\n", () => process.exit(0)));
process.send({leaf: process.pid});`
	middle := `
let terminating = false;
process.on("SIGTERM", () => { terminating = true; });
setTimeout(() => process.exit(92), Math.max(1, Number(process.argv[1]) - Date.now()));
const child = require("node:child_process").spawn(process.execPath,
  ["-e", ` + strconv.Quote(leaf) + `, "--", process.argv[1]],
  {detached:false, env:{}, stdio:["ignore","inherit","inherit","ipc"]});
child.once("error", () => process.exit(93));
child.once("message", message => process.send({middle:process.pid, leaf:message.leaf}));
child.once("close", (code, signal) => {
  if (!terminating || code !== 0 || signal !== null) process.exit(94);
  process.stdout.write("leaf-waited-0\n", () => process.exit(0));
});`
	command := `
setTimeout(() => process.exit(95), Math.max(1, Number(process.argv[1]) - Date.now()));
const child = require("node:child_process").spawn(process.execPath,
  ["-e", ` + strconv.Quote(middle) + `, "--", process.argv[1]],
  {detached:false, env:{}, stdio:["ignore","inherit","inherit","ipc"]});
child.once("error", () => process.exit(96));
child.once("message", message => process.stdout.write(JSON.stringify({root:process.pid,...message})+"\n"));`
	f.prepare(t, []string{"-e", command, "--", strconv.FormatInt(deadline.UnixMilli(), 10)}, nil, map[string]string{})
	if err := f.child.send(f.ctx, watchdogControl{Type: "start", ID: f.child.id}); err != nil {
		f.fail(t, "one owned tree start unresolved; no retry", err)
	}
	if err := f.child.await(f.ctx, f.child.ready); err != nil {
		f.fail(t, "original tree ready frame unavailable", err)
	}
	var pids struct{ Root, Middle, Leaf int }
	var ready []byte
	for {
		out, err := f.observed.Read(f.ctx, processsvc.Window{})
		if err != nil || out.Root != processsvc.RootRunning || out.CancelRequested || out.OutputDrained {
			f.fail(t, "tree readiness observation invalid", err)
		}
		if bytes.Contains(out.Stdout, []byte("\n")) {
			ready = append([]byte(nil), out.Stdout...)
			if json.Unmarshal(bytes.TrimSpace(ready), &pids) != nil {
				f.fail(t, "owned tree PID record invalid", nil)
			}
			break
		}
		select {
		case <-f.ctx.Done():
			f.fail(t, "owned tree readiness deadline; no retry", f.ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	seen := map[int]bool{f.retained.Pid: true, syscall.Getpid(): true}
	for _, pid := range []int{pids.Root, pids.Middle, pids.Leaf} {
		if pid <= 1 || seen[pid] {
			f.fail(t, "owned tree PID identities overlap", nil)
		}
		seen[pid] = true
		group, err := syscall.Getpgid(pid)
		if err != nil || group != f.retained.Pid {
			f.fail(t, "owned root/child/grandchild group mismatch", err)
		}
	}
	receipt, err := f.observed.Cancel(f.ctx)
	if err != nil || receipt == nil || receipt.Status != processsvc.CancelRequested {
		f.fail(t, "original owned tree Cancel unconfirmed; no retry", err)
	}
	f.settle(t)
	out, err := f.observed.Read(f.ctx, processsvc.Window{})
	want := append(ready, []byte("leaf-final\nleaf-waited-0\n")...)
	if err != nil || out.Root != processsvc.RootExited || !out.Waited || !out.OutputDrained || !out.CancelRequested ||
		out.ExitCode != nil || out.ExitSignal != int(syscall.SIGKILL) || !bytes.Equal(out.Stdout, want) || len(out.Stderr) != 0 ||
		out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified {
		f.fail(t, "owned tree terminal/output facts absent or public cleanup overclaimed", err)
	}
	f.helperExit(t, true)
	// Bounded original readback only. PID reuse fails closed; no PID signal or
	// replacement operation is permitted, even if the original tree survives.
	for _, pid := range []int{pids.Root, pids.Middle, pids.Leaf, f.retained.Pid} {
		for {
			_, err := syscall.Getpgid(pid)
			if errors.Is(err, syscall.ESRCH) {
				break
			}
			if err != nil {
				f.fail(t, "original tree read-only terminal query failed", err)
			}
			select {
			case <-f.ctx.Done():
				f.fail(t, "owned tree/group still exists; cleanup not proven, no retry", f.ctx.Err())
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	// Signal zero is a read-only existence query: it delivers no signal. A
	// reused or surviving group fails closed instead of being killed by the test.
	if err := syscall.Kill(-f.retained.Pid, 0); !errors.Is(err, syscall.ESRCH) {
		f.fail(t, "original anchored group still exists or is unreadable", err)
	}
	t.Logf("owned-tree-only: helper=%d root=%d child=%d grandchild=%d; same PGID before one Cancel; all exact PIDs and anchored group ESRCH after original Wait; leaf exit0 observed by its parent; public group/descendant cleanup remains unverified", f.retained.Pid, pids.Root, pids.Middle, pids.Leaf)
}
