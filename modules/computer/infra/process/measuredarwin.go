//go:build darwin

package process

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"golang.org/x/sys/unix"
)

// measureLaunch uses the same physical measurement boundary for direct and
// anchored starts. Its closer holds ALL measured handles through the attempt;
// pathname measurement alone is not continuous kernel identity evidence.
func measureLaunch(ctx context.Context, command Command, launch *confinedLaunch) (func(), error) {
	return measureLaunchFiles(ctx, command, launch, darwinLaunchFilesystem{})
}

type darwinLaunchFilesystem struct{}

func (darwinLaunchFilesystem) resolve(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
func (darwinLaunchFilesystem) effectiveUID() int { return os.Geteuid() }
func (darwinLaunchFilesystem) pinExecutable(pin ExecutablePin) (io.Closer, error) {
	file, err := pinnedExecutable(pin)
	if file == nil {
		return nil, err
	}
	return file, err
}
func (darwinLaunchFilesystem) openDirectory(path string) (directoryPin, error) {
	if !absolutePolicyPath(path) {
		return nil, &processsvc.NativeFailure{}
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	root := &darwinDirectoryPin{os.NewFile(uintptr(fd), "/")}
	defer root.Close()
	return root.openDirectory(strings.TrimPrefix(path, "/"))
}

type darwinDirectoryPin struct{ *os.File }

func (d *darwinDirectoryPin) inspect(path string) (directoryFacts, error) {
	info, err := d.Stat()
	named, namedErr := os.Lstat(path)
	if err != nil || namedErr != nil || !info.IsDir() || !named.IsDir() || named.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, named) {
		return directoryFacts{}, &processsvc.NativeFailure{}
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return directoryFacts{}, &processsvc.NativeFailure{}
	}
	return directoryFacts{authority.RootIdentity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(uint64(stat.Ino), 10)}, info.Mode(), int(stat.Uid)}, nil
}

// Open each component relative to the retained directory without following
// symlinks. An effective scope never reopens its approved ancestor by name.
func (d *darwinDirectoryPin) openDirectory(relative string) (directoryPin, error) {
	if relative == "" || filepath.IsAbs(relative) || filepath.Clean(relative) != relative {
		return nil, &processsvc.NativeFailure{}
	}
	parts := strings.Split(relative, "/")
	for _, part := range parts {
		if part == ".." || (part == "." && relative != ".") {
			return nil, &processsvc.NativeFailure{}
		}
	}
	// '.' produces an independent close-on-exec handle when scope equals root.
	parent := int(d.Fd())
	var held *os.File
	for _, part := range parts {
		fd, err := unix.Openat(parent, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if held != nil {
			_ = held.Close()
		}
		if err != nil {
			return nil, &processsvc.NativeFailure{}
		}
		held = os.NewFile(uintptr(fd), part)
		parent = fd
	}
	return &darwinDirectoryPin{held}, nil
}
