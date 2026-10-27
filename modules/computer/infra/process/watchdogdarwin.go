//go:build darwin

package process

import (
	"context"
	"errors"
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

func (nativeWatchdogHost) Start(ctx context.Context, selection WatchdogSelection, cwd string, check func() error) (watchdogProcess, watchdogChannel, error) {
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
	// Image measurement and IPC setup precede the SAME final owner check.
	// No CommandContext, parent signal, inherited environment or second attempt.
	process, channel, startErr := startWatchdogHelper(ctx, check, func() (watchdogProcess, watchdogChannel, error) {
		err := command.Start()
		return &nativeWatchdogProcess{command}, connection, err
	})
	if process == nil {
		connection.Close()
	}
	return process, channel, startErr
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

// GroupGone only queries the PGID established by this retained helper. A reused
// group can make the answer unverified, never authorize a new signal. Cleanup
// signals remain inside the live watchdog, which still anchors its own group.
func (p *nativeWatchdogProcess) GroupGone(deadline time.Time) bool {
	if p == nil || p.command == nil || p.command.Process == nil || p.command.ProcessState == nil ||
		p.command.Process.Pid <= 1 || p.command.ProcessState.Pid() != p.command.Process.Pid ||
		p.command.SysProcAttr == nil || !p.command.SysProcAttr.Setpgid {
		return false
	}
	return observeWatchdogGroupGone(p.command.Process.Pid, deadline, syscall.Kill, time.Now, time.Sleep)
}

func observeWatchdogGroupGone(pgid int, deadline time.Time, query func(int, syscall.Signal) error, now func() time.Time, pause func(time.Duration)) bool {
	if pgid <= 1 || query == nil || now == nil || pause == nil {
		return false
	}
	end := now().Add(250 * time.Millisecond)
	if deadline.Before(end) {
		end = deadline
	}
	for {
		err := query(-pgid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return true
		}
		if err != nil || !now().Before(end) {
			return false
		}
		remaining := end.Sub(now())
		if remaining <= 0 {
			return false
		}
		pause(min(10*time.Millisecond, remaining))
	}
}
