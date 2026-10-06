//go:build darwin

package process

import (
	"context"
	"io"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"golang.org/x/sys/unix"
)

type nativeWatchdogHost struct{}
type nativeWatchdogProcess struct{ command *exec.Cmd }

func (nativeWatchdogHost) Start(ctx context.Context, selection WatchdogSelection, cwd string) (watchdogProcess, watchdogChannel, error) {
	image, err := pinnedExecutable(selection.Executable)
	if err != nil {
		return nil, nil, err
	}
	defer image.Close() // Retain measured bytes through the single helper start.
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		return nil, nil, &processsvc.NativeFailure{}
	}
	unix.CloseOnExec(pair[0])
	unix.CloseOnExec(pair[1])
	parent := os.NewFile(uintptr(pair[0]), "watchdog-parent")
	child := os.NewFile(uintptr(pair[1]), "watchdog-child")
	defer child.Close()
	connection, err := net.FileConn(parent)
	parent.Close()
	if err != nil {
		return nil, nil, &processsvc.NativeFailure{}
	}
	command := exec.Command(selection.Executable.Path, "-e", string(selection.Source), "--", "--farol-go-prepared-v1")
	command.Dir = cwd
	command.Env = []string{"ELECTRON_RUN_AS_NODE=1", "NODE_CHANNEL_FD=3", "NODE_CHANNEL_SERIALIZATION_MODE=json", "FAROL_SHELL_WATCHDOG_MODE=" + watchdogMode}
	command.ExtraFiles = []*os.File{child}
	command.Stdout, command.Stderr = io.Discard, io.Discard
	command.WaitDelay = time.Second
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if ctx == nil || ctx.Err() != nil {
		connection.Close()
		return nil, nil, &processsvc.NativeFailure{}
	}
	// No CommandContext, parent signal, inherited environment or second attempt.
	err = command.Start()
	return &nativeWatchdogProcess{command}, connection, err
}
func (p *nativeWatchdogProcess) Wait() error {
	err := p.command.Wait()
	if p.command.ProcessState == nil {
		return &processsvc.NativeFailure{Unknown: true}
	}
	if err == nil {
		return nil
	}
	// The helper normally kills its OWN group after reporting root close. Its
	// exact observed exit is known; it certifies neither command exit nor cleanup.
	if _, ok := err.(*exec.ExitError); ok {
		return nil
	}
	return &processsvc.NativeFailure{Unknown: true}
}
