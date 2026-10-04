//go:build darwin

package process

import (
	"os/exec"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func waitAnchor(cmd *exec.Cmd) (exit, error) {
	if cmd == nil || cmd.Process == nil || cmd.ProcessState != nil || cmd.Cancel != nil || cmd.WaitDelay <= 0 || cmd.WaitDelay > time.Second {
		return exit{}, &processsvc.NativeFailure{Unknown: true}
	}
	err := cmd.Wait()
	if cmd.ProcessState == nil {
		return exit{}, &processsvc.NativeFailure{Unknown: true}
	}
	result := exitDetails(cmd.ProcessState)
	// Only the expected clean anchor exit can establish successful bounded drain.
	// ExitError may hide a pipe/drain error, and remains unqualified.
	result.Drained = err == nil
	return result, err
}
