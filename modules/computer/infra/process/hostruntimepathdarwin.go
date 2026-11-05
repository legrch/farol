//go:build darwin

package process

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"syscall"
	"time"
)

const hostEnvironmentOutputLimit = 64 << 10

type UserExecutableEnvironment struct {
	Path, Home, User, Shell, XDGConfigHome, DeveloperDir, ZDotDir string
	Source, CapturedAt                                            string
}

func validHostSearchPath(value string) bool {
	return ValidUserExecutablePath(value)
}

type boundedHostOutput struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (b *boundedHostOutput) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > b.limit {
		b.overflow = true
		return 0, errShellEnvironmentUnknown
	}
	return b.buffer.Write(p)
}

func (b *boundedHostOutput) Bytes() []byte { return b.buffer.Bytes() }

// runHostProbe retains the original process through Wait, including timeout.
// It does not read inherited environment, stdin or arbitrary child output.
func runHostProbe(ctx context.Context, executable string, args, environment []string, home string, limit int) ([]byte, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, errShellEnvironmentUnknown
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.Command(executable, args...)
	command.Env = environment
	command.Dir = home
	command.Stdin = bytes.NewReader(nil)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.WaitDelay = time.Second
	stdout := &boundedHostOutput{limit: limit}
	stderr := &boundedHostOutput{limit: hostEnvironmentOutputLimit}
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Start(); err != nil {
		return nil, errShellEnvironmentUnknown
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if errors.Is(err, exec.ErrWaitDelay) {
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		}
		if err != nil || probe.Err() != nil || stdout.overflow || stderr.overflow || stderr.buffer.Len() != 0 {
			return nil, errShellEnvironmentUnknown
		}
		return bytes.Clone(stdout.Bytes()), nil
	case <-probe.Done():
		// Kill the owned cohort and wait for the original root; a lost Wait stays
		// UNKNOWN and cannot authorize another probe in this Shell session.
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			return nil, errShellEnvironmentUnknown
		}
		if errors.Is(probe.Err(), context.DeadlineExceeded) {
			return nil, errShellEnvironmentTimeout
		}
		return nil, errShellEnvironmentUnknown
	}
}

func DiscoverInstalledHostRuntimeForPath(ctx context.Context, searchPath string) (*HostRuntimePlan, error) {
	if !validHostSearchPath(searchPath) {
		return nil, errHostRuntime
	}
	return discoverHostRuntime(ctx, nativeHostRuntimeFilesystem{}, searchPath)
}

func DiscoverInstalledHostRuntimeForEnvironment(ctx context.Context, environment UserExecutableEnvironment) (*HostRuntimePlan, error) {
	if !validHostSearchPath(environment.Path) || environment.XDGConfigHome != "" || environment.DeveloperDir != "" || environment.ZDotDir != "" {
		return nil, errHostRuntime
	}
	return discoverHostRuntime(ctx, nativeHostRuntimeFilesystem{}, environment.Path)
}
