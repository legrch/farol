//go:build darwin

package stop

import (
	"context"
	"errors"
	"os/exec"
	"syscall"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

// A real child outside the bound slot is read through the kernel path and is
// never signalled; a reaped PID reads as gone.
func TestNativeRefusesAProcessOutsideTheSlot(t *testing.T) {
	child := exec.Command("/bin/sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	path, err := nativeSystem{}.path(context.Background(), child.Process.Pid)
	if err != nil || path != "/bin/sleep" {
		t.Fatal(path, err)
	}
	term, err := New(child.Process.Pid, "/Applications/Farol.app")
	if err != nil {
		t.Fatal(err)
	}
	if err := term.Signal(context.Background(), port.ProcessSignalKill); !errors.Is(err, ErrPath) {
		t.Fatal("signalled outside the slot", err)
	}
	if err := child.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("child no longer running", err)
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	if path, err := (nativeSystem{}).path(context.Background(), child.Process.Pid); err != nil || path != "" {
		t.Fatal("reaped PID not gone", path, err)
	}
}
