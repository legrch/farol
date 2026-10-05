//go:build darwin

package process

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// measureLaunch checks the same physical roots and executable pins for both
// direct and anchored starts. It grants no authority or confinement proof.
// The returned closure retains measured descriptors through the start attempt;
// pathname measurement alone is not continuous kernel identity evidence.
func measureLaunch(ctx context.Context, command Command, launch *confinedLaunch) (func(), error) {
	if ctx == nil || ctx.Err() != nil || launch == nil {
		return nil, &processsvc.NativeFailure{}
	}
	root, err := os.Lstat(command.Root)
	if err != nil || !root.IsDir() || root.Mode()&os.ModeSymlink != 0 {
		return nil, &processsvc.NativeFailure{}
	}
	identity, ok := root.Sys().(*syscall.Stat_t)
	if !ok || strconv.FormatUint(uint64(identity.Dev), 10) != command.RootIdentity.Device || strconv.FormatUint(uint64(identity.Ino), 10) != command.RootIdentity.Inode {
		return nil, &processsvc.NativeFailure{}
	}
	cwd, err := filepath.EvalSymlinks(command.Cwd)
	if err != nil || cwd != command.Cwd {
		return nil, &processsvc.NativeFailure{}
	}
	scratch, err := os.Lstat(launch.scratch)
	if err != nil || !scratch.IsDir() || scratch.Mode()&os.ModeSymlink != 0 || scratch.Mode().Perm() != 0700 {
		return nil, &processsvc.NativeFailure{}
	}
	scratchID, ok := scratch.Sys().(*syscall.Stat_t)
	if !ok || int(scratchID.Uid) != os.Geteuid() || strconv.FormatUint(uint64(scratchID.Dev), 10) != launch.scratchIdentity.Device || strconv.FormatUint(uint64(scratchID.Ino), 10) != launch.scratchIdentity.Inode {
		return nil, &processsvc.NativeFailure{}
	}
	// Keep every measured descriptor open through the single start attempt.
	// This still requires independently qualified pathname/descriptor continuity.
	var files []*os.File
	retained := false
	closeFiles := func() {
		for _, file := range files {
			_ = file.Close()
		}
	}
	defer func() {
		if !retained {
			closeFiles()
		}
	}()
	for _, pin := range launch.pins {
		if ctx.Err() != nil {
			return nil, &processsvc.NativeFailure{}
		}
		file, err := pinnedExecutable(pin)
		if err != nil {
			return nil, &processsvc.NativeFailure{}
		}
		files = append(files, file)
	}

	if ctx.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	retained = true
	return closeFiles, nil
}
