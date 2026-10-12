//go:build darwin

package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	measurement, err := retainLaunch(ctx, command, launch)
	if err != nil {
		return nil, err
	}
	return measurement.Close, nil
}

// retainLaunch keeps the same native descriptors through the watchdog release
// barrier. Direct and anchored callers retain the closer-only compatibility API.
func retainLaunch(ctx context.Context, command Command, launch *confinedLaunch) (*retainedLaunchMeasurement, error) {
	return retainLaunchFiles(ctx, command, launch, darwinLaunchFilesystem{})
}

type darwinLaunchFilesystem struct{}

func (darwinLaunchFilesystem) resolve(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
func (darwinLaunchFilesystem) effectiveUID() int { return os.Geteuid() }
func (darwinLaunchFilesystem) pinExecutable(ctx context.Context, pin ExecutablePin) (executableMeasurement, error) {
	if ctx == nil || ctx.Err() != nil || !absolutePolicyPath(pin.Path) {
		return nil, &processsvc.NativeFailure{}
	}
	file, err := os.OpenFile(pin.Path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	before, err := file.Stat()
	held := &darwinExecutableMeasurement{file: file, selected: pin, original: before, ownerUID: os.Geteuid(), named: func(path string) (os.FileInfo, error) {
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
	// Return partial ownership even on error; retainLaunchFiles closes it.
	if err != nil {
		return held, &processsvc.NativeFailure{}
	}
	return held, held.recheck(ctx)
}

// The private file/metadata seam permits CPU doubles of the actual descriptor
// verifier. Production always uses the originally opened file and os.Lstat.
type executableMeasurementFile interface {
	io.ReaderAt
	io.Closer
	Stat() (os.FileInfo, error)
}
type darwinExecutableMeasurement struct {
	file     executableMeasurementFile
	selected ExecutablePin
	original os.FileInfo
	ownerUID int
	dataOnly bool
	named    func(string) (os.FileInfo, error)
}

func (p *darwinExecutableMeasurement) Close() error { return p.file.Close() }
func (p *darwinExecutableMeasurement) unchanged(info os.FileInfo) bool {
	if info == nil || p.original == nil || !info.Mode().IsRegular() || (!p.dataOnly && info.Mode().Perm()&0111 == 0) ||
		info.Mode().Perm()&0022 != 0 || info.Size() < 0 || info.Size() > 128*1024*1024 || (p.dataOnly && info.Size() > 256*1024) ||
		info.Mode() != p.original.Mode() ||
		info.Size() != p.original.Size() || !info.ModTime().Equal(p.original.ModTime()) {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	original, originalOK := p.original.Sys().(*syscall.Stat_t)
	return ok && originalOK && stat.Dev == original.Dev && stat.Ino == original.Ino &&
		stat.Nlink == 1 && stat.Uid == original.Uid &&
		(stat.Uid == 0 || (!p.dataOnly && int(stat.Uid) == p.ownerUID)) &&
		(!p.dataOnly || stat.Gid == original.Gid && stat.Ctimespec == original.Ctimespec)
}
func (p *darwinExecutableMeasurement) recheck(ctx context.Context) error {
	refuse := func() error { return &processsvc.NativeFailure{} }
	if ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	before, err := p.file.Stat()
	if err != nil || !p.unchanged(before) {
		return refuse()
	}
	hash := sha256.New()
	// ReadAt keeps every hash on the same descriptor and leaves its offset alone.
	reader := &measurementContextReader{ctx, io.NewSectionReader(p.file, 0, 128*1024*1024+1)}
	count, err := io.Copy(hash, reader)
	if err != nil || count != before.Size() || hex.EncodeToString(hash.Sum(nil)) != p.selected.SHA256 {
		return refuse()
	}
	after, err := p.file.Stat()
	named, namedErr := p.named(p.selected.Path)
	if err != nil || namedErr != nil || !p.unchanged(after) || !p.unchanged(named) || ctx.Err() != nil {
		return refuse()
	}
	return nil
}

type measurementContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *measurementContextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(b)
	if contextErr := r.ctx.Err(); contextErr != nil {
		return n, contextErr
	}
	return n, err
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
