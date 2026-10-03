//go:build darwin

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

type nativeBoundary struct{ qualification Qualification }
type nativeChild struct{ command *exec.Cmd }

func (n nativeBoundary) Start(ctx context.Context, command Command, check func(context.Context) error, stdout, stderr io.Writer) (owned, error) {
	if ctx == nil || ctx.Err() != nil || check == nil {
		return nil, &processsvc.NativeFailure{}
	}
	launch, err := selectedLaunch(n.qualification, command)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	// These are fresh native measurements of the selected physical root and exact
	// executable bytes, never request-body permission or a startup approval cache.
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
	defer func() {
		for _, file := range files {
			file.Close()
		}
	}()
	for _, pin := range launch.pins {
		file, err := pinnedExecutable(pin)
		if err != nil {
			return nil, &processsvc.NativeFailure{}
		}
		files = append(files, file)
	}
	if ctx.Err() != nil || launch.qualification.Qualify(ctx, copyCommand(launch.command)) != nil {
		return nil, &processsvc.NativeFailure{}
	}
	cmd := exec.Command(launch.command.Executable, launch.command.Args...)
	cmd.Env = append([]string{}, command.Environment...)
	cmd.Dir = command.Cwd
	cmd.Stdin = bytes.NewReader(command.Input)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// A root can exit while descendants keep pipes open. Bounded drain is not
	// descendant/group termination proof and cannot turn into terminal-complete.
	cmd.WaitDelay = time.Second
	if err = configure(cmd); err != nil {
		return nil, err
	}
	if ctx.Err() != nil || check(ctx) != nil {
		return nil, &processsvc.NativeFailure{}
	}
	// Exactly one native attempt. CommandContext/default cancellation is avoided
	// because all signalling belongs to the retained owning handle below.
	if err = cmd.Start(); err != nil {
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	return &nativeChild{command: cmd}, nil
}
func (n *nativeChild) Wait() (exit, error) {
	err := n.command.Wait()
	if n.command.ProcessState == nil {
		return exit{}, &processsvc.NativeFailure{Unknown: true}
	}
	result := exitDetails(n.command.ProcessState)
	result.Drained = err == nil
	if _, exited := err.(*exec.ExitError); exited {
		result.Drained = true
	}
	return result, nil
}
func (n *nativeChild) Kill() error { return n.command.Process.Kill() }

// No startup cache, symlink, writable group/world executable or inherited lookup.
func pinnedExecutable(pin ExecutablePin) (*os.File, error) {
	file, err := os.OpenFile(pin.Path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	refuse := func() (*os.File, error) { file.Close(); return nil, &processsvc.NativeFailure{} }
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Mode().Perm()&0111 == 0 || before.Mode().Perm()&0022 != 0 || before.Size() > 128*1024*1024 {
		return refuse()
	}
	identity, ok := before.Sys().(*syscall.Stat_t)
	if !ok || identity.Nlink != 1 || (identity.Uid != 0 && int(identity.Uid) != os.Geteuid()) {
		return refuse()
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, io.LimitReader(file, 128*1024*1024+1)); err != nil || hex.EncodeToString(hash.Sum(nil)) != pin.SHA256 {
		return refuse()
	}
	after, err := file.Stat()
	named, namedErr := os.Lstat(pin.Path)
	if err != nil || namedErr != nil || !os.SameFile(before, after) || !os.SameFile(after, named) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || named.Mode()&os.ModeSymlink != 0 {
		return refuse()
	}
	return file, nil
}
