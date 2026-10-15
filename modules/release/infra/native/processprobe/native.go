//go:build darwin || linux

package processprobe

import (
	"errors"
	"io"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

type nativeBoundary struct{}
type nativeChild struct{ command *exec.Cmd }

func (nativeBoundary) prepare(pid int, stdout, stderr io.Writer) child {
	cmd := exec.Command("/bin/ps", "-p", strconv.Itoa(pid), "-o", "lstart=")
	cmd.Dir = "/"
	cmd.Env = []string{"LANG=C.UTF-8", "PATH=/usr/bin:/bin"}
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// A child may exit with a descendant retaining its pipe. WaitDelay bounds
	// those copiers; forced closure is deliberately not an actual EOF witness.
	cmd.WaitDelay = time.Second
	return &nativeChild{command: cmd}
}

func (nativeBoundary) absent(pid int) bool {
	return absenceError(syscall.Kill(pid, 0))
}

func absenceError(err error) bool { return errors.Is(err, syscall.ESRCH) }

func (n *nativeChild) start() error { return n.command.Start() }
func (n *nativeChild) kill() error  { return n.command.Process.Kill() }
func (n *nativeChild) wait() (status, error) {
	err := n.command.Wait()
	if n.command.ProcessState == nil {
		return status{}, err
	}
	s := status{exited: true, code: n.command.ProcessState.ExitCode()}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		// An exit status is interpreted only alongside both independent EOF
		// witnesses. ExitError alone can hide an output copier error.
		err = nil
	}
	return s, err
}
