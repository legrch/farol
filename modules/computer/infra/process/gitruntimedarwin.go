//go:build darwin

package process

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"golang.org/x/sys/unix"
)

func (nativePlatformFacts) gitRuntimeFile(ctx context.Context, path string) (platformFileFacts, error) {
	return platformMeasuredFile(ctx, path, 0, 256*1024)
}
func (nativePlatformFacts) gitRuntimeDirectory(ctx context.Context, path string) (gitRuntimeDirectoryFacts, error) {
	refuse := func() (gitRuntimeDirectoryFacts, error) {
		return gitRuntimeDirectoryFacts{}, &processsvc.NativeFailure{}
	}
	if ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	// A dummy leaf makes the existing no-follow parent traversal open this directory.
	dir, err := platformProtectedParent(filepath.Join(path, "resource-anchor"))
	if err != nil {
		return refuse()
	}
	defer dir.Close()
	physical, err := platformDescriptorPath(dir.Fd())
	before, statErr := dir.Stat()
	if err != nil || statErr != nil || physical != path || !before.IsDir() {
		return refuse()
	}
	st, ok := before.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != 0 || before.Mode().Perm()&0022 != 0 {
		return refuse()
	}
	names, err := dir.Readdirnames(33)
	if err != nil && err != io.EOF || len(names) > 32 {
		return refuse()
	}
	slices.Sort(names)
	after, err := dir.Stat()
	named, namedErr := os.Lstat(path)
	if err != nil || namedErr != nil || !os.SameFile(before, after) || !os.SameFile(before, named) ||
		before.Mode() != after.Mode() || before.ModTime() != after.ModTime() || before.Mode() != named.Mode() {
		return refuse()
	}
	afterStat, afterOK := after.Sys().(*syscall.Stat_t)
	namedStat, namedOK := named.Sys().(*syscall.Stat_t)
	stable := func(current *syscall.Stat_t) bool {
		return current.Dev == st.Dev && current.Ino == st.Ino && current.Uid == st.Uid && current.Gid == st.Gid &&
			current.Mode == st.Mode && current.Nlink == st.Nlink && current.Mtimespec == st.Mtimespec && current.Ctimespec == st.Ctimespec
	}
	if !afterOK || !namedOK || !stable(afterStat) || !stable(namedStat) {
		return refuse()
	}
	p, err := (nativePlatformFacts{}).directory(ctx, path)
	if err != nil || (p.identity.Device != strconv.FormatUint(uint64(st.Dev), 10) || p.identity.Inode != strconv.FormatUint(st.Ino, 10)) || ctx.Err() != nil {
		return refuse()
	}
	return gitRuntimeDirectoryFacts{platform: p, mode: before.Mode(), uid: st.Uid, entries: strings.Join(names, "\n"), modified: strconv.FormatInt(st.Mtimespec.Sec, 10) + ":" + strconv.FormatInt(st.Mtimespec.Nsec, 10), changed: strconv.FormatInt(st.Ctimespec.Sec, 10) + ":" + strconv.FormatInt(st.Ctimespec.Nsec, 10)}, nil
}

// Data resources retain their original descriptors through guest preparation.
// No read-data pin grants execution, and root ownership is mandatory.
func (darwinLaunchFilesystem) pinGitRuntimeFile(ctx context.Context, pin ExecutablePin) (executableMeasurement, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	parent, err := platformProtectedParent(pin.Path)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	fd, err := unix.Openat(int(parent.Fd()), filepath.Base(pin.Path), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	file := os.NewFile(uintptr(fd), pin.Path)
	before, err := file.Stat()
	held := &darwinExecutableMeasurement{file: file, selected: pin, original: before, ownerUID: os.Geteuid(), dataOnly: true,
		named: func(path string) (os.FileInfo, error) {
			physical, err := platformDescriptorPath(file.Fd())
			if err != nil || physical != path {
				return nil, &processsvc.NativeFailure{}
			}
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil || resolved != path {
				return nil, &processsvc.NativeFailure{}
			}
			return os.Lstat(path)
		}}
	if err != nil {
		return held, &processsvc.NativeFailure{}
	}
	return held, held.recheck(ctx)
}
