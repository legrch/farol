//go:build darwin

package process

import (
	"os"
	"os/exec"
	"syscall"
)

func configure(cmd *exec.Cmd) error {
	// A dedicated group prevents inheriting the backend's group. We never signal
	// its numeric PGID or infer cohort completion after the leader is reaped.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return nil
}
func exitDetails(state *os.ProcessState) exit {
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok {
		return exit{}
	}
	if status.Signaled() {
		return exit{Signal: int(status.Signal()), Waited: true}
	}
	if status.Exited() {
		code := status.ExitStatus()
		return exit{Code: &code, Waited: true}
	}
	return exit{}
}
