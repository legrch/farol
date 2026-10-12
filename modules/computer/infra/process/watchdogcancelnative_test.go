//go:build darwin && farol_native_process

package process

import (
	"bytes"
	"context"
	"syscall"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Fresh transport-only cancellation: real retained Node child, IPC decoder,
// output and owning Wait. No sandbox, packaged product or descendant proof.
// This never reuses or reconciles a previously unknown native operation.
func TestNativeWatchdogObservedCancellation(t *testing.T) {
	f := nativeWatchdogStart(t, nativeWatchdogResource(t))
	f.observed.mutex.Lock()
	f.observed.supervisor = processsvc.SupervisorRunning
	f.observed.mutex.Unlock()
	f.prepare(t, []string{"-e", `process.stdout.write(Buffer.from([0,255,65,10])); setInterval(() => {}, 1000);`}, nil, map[string]string{})
	if err := f.child.send(f.ctx, watchdogControl{Type: "start", ID: f.child.id}); err != nil {
		f.fail(t, "single cancellation fixture start", err)
	}
	if err := f.child.await(f.ctx, f.child.ready); err != nil {
		f.fail(t, "original ready frame", err)
	}
	// Actual output witnesses command execution before the one cancel request.
	for {
		out, err := f.observed.Read(f.ctx, processsvc.Window{})
		if err != nil {
			f.fail(t, "original output observation", err)
		}
		if bytes.Equal(out.Stdout, []byte{0, 255, 'A', '\n'}) {
			break
		}
		select {
		case <-f.ctx.Done():
			f.fail(t, "output before cancel unavailable", f.ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	receipt, err := f.observed.Cancel(f.ctx)
	if err != nil || receipt == nil || receipt.Status != processsvc.CancelRequested {
		f.fail(t, "original cancel request unresolved", err)
	}
	f.settle(t)
	out, err := f.observed.Read(context.Background(), processsvc.Window{})
	if err != nil || out.Root != processsvc.RootExited || out.Supervisor != processsvc.SupervisorExited ||
		!out.Waited || !out.OutputDrained || out.ExitCode != nil || out.ExitSignal != int(syscall.SIGKILL) ||
		!out.CancelRequested || !bytes.Equal(out.Stdout, []byte{0, 255, 'A', '\n'}) ||
		out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified {
		f.fail(t, "cancelled root result was lost or cleanup invented", err)
	}
	f.helperExit(t, true)
}
