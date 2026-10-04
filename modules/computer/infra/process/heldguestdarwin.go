//go:build darwin

package process

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// RunHeldGuest belongs ONLY to root's same-image held role, already under the
// selected Seatbelt profile. Root parses/validates common transport, supplies the
// exact original stdin on FD0, marks every control/baseline FD close-on-exec, and
// closes them before this one exec. Release is parent-current-authorized; EOF or
// deadline before it refuses. There is no second binary or private wire decoder.
// The native Qualification must be produced in this SAME process before release.
// ready enables root's actual live readiness responses only AFTER native preflight;
// it owns no transport codec and cannot itself release or execute the command.
func RunHeldGuest(ctx context.Context, command, wrapped Command, qualification *NativeQualification, deadline time.Time, release, parentGone <-chan struct{}, ready func(context.Context) error, closeControl func() error) error {
	return runHeldGuest(ctx, command, wrapped, qualification, deadline, release, parentGone, ready, closeControl, nativeHeldBoundary{})
}

type nativeHeldBoundary struct{}

func (nativeHeldBoundary) Prepare(command Command) (func() error, error) {
	if heldLocation(command) != nil {
		return nil, &processsvc.NativeFailure{}
	}
	file, err := pinnedExecutable(ExecutablePin{command.Executable, command.ExecutableSHA256})
	if err != nil {
		return nil, err
	}
	return file.Close, nil
}
func (nativeHeldBoundary) Exec(command Command) error {
	// Successful exec never returns. An error cannot trigger another image/exec.
	return syscall.Exec(command.Executable, append([]string{command.Executable}, command.Args...), append([]string{}, command.Environment...))
}

// Fresh physical checks are not continuous kernel/pathname identity proof; root
// still owns acceptance of that mechanism. No root is inferred from request data.
func heldLocation(command Command) error {
	info, err := os.Lstat(command.Root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return &processsvc.NativeFailure{}
	}
	identity, ok := info.Sys().(*syscall.Stat_t)
	if !ok || strconv.FormatUint(uint64(identity.Dev), 10) != command.RootIdentity.Device || strconv.FormatUint(uint64(identity.Ino), 10) != command.RootIdentity.Inode {
		return &processsvc.NativeFailure{}
	}
	cwd, err := filepath.EvalSymlinks(command.Cwd)
	if err != nil || cwd != command.Cwd {
		return &processsvc.NativeFailure{}
	}
	info, err = os.Lstat(cwd)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return &processsvc.NativeFailure{}
	}
	return nil
}
