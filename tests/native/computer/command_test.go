//go:build darwin

package computer

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// These witnesses exercise disposable Darwin processes only. They specify facts
// a Go supervisor must reconcile; they do not call the product shell/Git route.
// Descendants self-terminate, so cleanup never retries a refused OS signal.
func TestRootExitDoesNotProveGroupCleanup(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "sleep 0.8 >/dev/null 2>&1 & printf '%s' $!; exit 0")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var output bytes.Buffer
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	descendant, err := strconv.Atoi(strings.TrimSpace(output.String()))
	if err != nil {
		t.Fatal(err)
	}
	if cmd.ProcessState.ExitCode() != 0 {
		t.Fatal("root did not exit")
	}
	if err := syscall.Kill(descendant, 0); err != nil {
		t.Fatalf("missing live descendant witness: %v", err)
	}
	if err := syscall.Kill(-cmd.Process.Pid, 0); err != nil {
		t.Fatalf("root exited but owned group should still exist: %v", err)
	}
	observeGroupExit(t, cmd.Process.Pid)
}

func TestRootTimeoutDoesNotConfirmDescendantCancellation(t *testing.T) {
	// CommandContext owns only the root. Its timeout must not be reported as
	// confirmed cancellation of the process group.
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", "sleep 0.8 >/dev/null 2>&1 & printf '%s' $!; wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var output bytes.Buffer
	cmd.Stdout = &output
	if err := cmd.Run(); err == nil {
		t.Fatal("root unexpectedly completed before timeout")
	}
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("wrong deadline: %v", ctx.Err())
	}
	descendant, err := strconv.Atoi(strings.TrimSpace(output.String()))
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(descendant, 0); err != nil {
		t.Fatalf("missing surviving descendant: %v", err)
	}
	observeGroupExit(t, cmd.Process.Pid)
}

func observeGroupExit(t *testing.T, group int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		err := syscall.Kill(-group, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		if err != nil {
			t.Fatalf("cleanup observation unavailable: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("owned self-terminating group did not become observably absent")
}
