//go:build darwin

package computer

import (
	"context"
	"errors"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// These disposable Darwin witnesses exercise a closed, two-process fixture,
// not the product shell/Git route. The descendant stays behind an owned pipe
// barrier. Register its kernel exit listener while both processes are still
// held; never look up a PID/PGID after the execution root has been reaped.
func TestRootExitDoesNotProveGroupCleanup(t *testing.T) {
	fixture := newCommandWitness(t)
	fixture.send(t, fixture.rootControl, "exit-root")
	if err := fixture.waitRoot(); err != nil {
		t.Fatalf("root did not exit successfully: %v", err)
	}
	fixture.requireSurvivingDescendant(t)
	// Cleanup releases the descendant's owned barrier and requires NOTE_EXIT
	// from the listener installed before root release. Root Wait alone never
	// satisfies that obligation.
}

func TestRootTimeoutDoesNotConfirmDescendantCancellation(t *testing.T) {
	fixture := newCommandWitness(t)
	// Start the deadline after readiness and exit-listener installation. The
	// root's only cancellation is one Kill on its retained os.Process; timeout
	// is not a cancellation receipt for its descendant.
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	<-ctx.Done()
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("wrong deadline: %v", ctx.Err())
	}
	if err := fixture.root.Process.Kill(); err != nil {
		t.Fatalf("owned root cancellation unavailable; no retry: %v", err)
	}
	err := fixture.waitRoot()
	var exited *exec.ExitError
	if !errors.As(err, &exited) {
		t.Fatalf("missing root cancellation terminal receipt: %v", err)
	}
	status, ok := exited.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatalf("wrong root cancellation receipt: %v", err)
	}
	fixture.requireSurvivingDescendant(t)
}
