//go:build darwin

package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"golang.org/x/sys/unix"
)

type nativePlatformFacts struct{}

func (nativePlatformFacts) effectiveUID() uint32 { return uint32(os.Geteuid()) }

// Read-only native facts: no exec, probe, policy application, network, writable
// descriptor, runtime version command or filesystem mutation. Tests never call it.
func (nativePlatformFacts) platform(ctx context.Context) (platformFacts, error) {
	refuse := func() (platformFacts, error) { return platformFacts{}, &processsvc.NativeFailure{} }
	if ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	osName, err := unix.Sysctl("kern.ostype")
	if err != nil || osName != "Darwin" {
		return refuse()
	}
	build, err := unix.Sysctl("kern.osversion")
	if err != nil {
		return refuse()
	}
	hardwareArm, err := unix.SysctlUint32("hw.optional.arm64")
	// No Rosetta/emulation or unknown hardware class is implicitly supported.
	if err != nil || (runtime.GOARCH == "arm64" && hardwareArm != 1) ||
		(runtime.GOARCH == "amd64" && hardwareArm != 0) ||
		(runtime.GOARCH != "arm64" && runtime.GOARCH != "amd64") || ctx.Err() != nil {
		return refuse()
	}
	return platformFacts{"darwin", build, runtime.GOARCH}, nil
}

func (nativePlatformFacts) backend(ctx context.Context) (string, error) {
	if ctx == nil || ctx.Err() != nil {
		return "", &processsvc.NativeFailure{}
	}
	path, err := os.Executable()
	if err != nil {
		return "", &processsvc.NativeFailure{}
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil || !absolutePolicyPath(path) || ctx.Err() != nil {
		return "", &processsvc.NativeFailure{}
	}
	return path, nil
}

// Image parents must be system/owner-owned without group/world write access.
// Open each component without following symlinks; the release supplies canonical
// paths. These held descriptors still do not make pathname exec atomic.
func platformProtectedParent(path string) (*os.File, error) {
	refuse := func() (*os.File, error) { return nil, &processsvc.NativeFailure{} }
	if !absolutePolicyPath(path) {
		return refuse()
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return refuse()
	}
	parent := os.NewFile(uintptr(fd), "/")
	for _, component := range strings.Split(strings.TrimPrefix(filepath.Dir(path), "/"), "/") {
		info, err := parent.Stat()
		if err != nil {
			parent.Close()
			return refuse()
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || (st.Uid != 0 && st.Uid != uint32(os.Geteuid())) || !info.IsDir() || info.Mode().Perm()&0022 != 0 {
			parent.Close()
			return refuse()
		}
		if component == "" {
			continue
		}
		fd, err := unix.Openat(int(parent.Fd()), component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		parent.Close()
		if err != nil {
			return refuse()
		}
		parent = os.NewFile(uintptr(fd), component)
	}
	info, err := parent.Stat()
	if err != nil {
		parent.Close()
		return refuse()
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (st.Uid != 0 && st.Uid != uint32(os.Geteuid())) || !info.IsDir() || info.Mode().Perm()&0022 != 0 {
		parent.Close()
		return refuse()
	}
	return parent, nil
}

func (nativePlatformFacts) file(ctx context.Context, path string) (platformFileFacts, error) {
	return platformMeasuredFile(ctx, path, 1, 128*1024*1024)
}
func platformMeasuredFile(ctx context.Context, path string, minimum, maximum int64) (platformFileFacts, error) {
	refuse := func() (platformFileFacts, error) { return platformFileFacts{}, &processsvc.NativeFailure{} }
	if ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	parent, err := platformProtectedParent(path)
	if err != nil {
		return refuse()
	}
	defer parent.Close()
	fd, err := unix.Openat(int(parent.Fd()), filepath.Base(path), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return refuse()
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	physical, err := platformDescriptorPath(file.Fd())
	if err != nil || physical != path {
		return refuse()
	}
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() < minimum || before.Size() > maximum {
		return refuse()
	}
	stat, ok := before.Sys().(*syscall.Stat_t)
	if !ok || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid())) || stat.Nlink != 1 || before.Mode().Perm()&0022 != 0 {
		return refuse()
	}
	hash := sha256.New()
	buffer := make([]byte, 32*1024)
	remaining := before.Size()
	for remaining > 0 {
		if ctx.Err() != nil {
			return refuse()
		}
		n, err := io.ReadFull(file, buffer[:min(int64(len(buffer)), remaining)])
		if err != nil {
			return refuse()
		}
		_, _ = hash.Write(buffer[:n])
		remaining -= int64(n)
	}
	after, err := file.Stat()
	named, namedErr := os.Lstat(path)
	if err != nil || namedErr != nil || named.Mode()&os.ModeSymlink != 0 || !os.SameFile(before, after) || !os.SameFile(after, named) {
		return refuse()
	}
	afterStat, ok := after.Sys().(*syscall.Stat_t)
	namedStat, namedOK := named.Sys().(*syscall.Stat_t)
	stable := func(st *syscall.Stat_t) bool {
		return st.Size == stat.Size && st.Mode == stat.Mode && st.Uid == stat.Uid && st.Gid == stat.Gid && st.Nlink == stat.Nlink &&
			st.Mtimespec == stat.Mtimespec && st.Ctimespec == stat.Ctimespec
	}
	if !ok || !namedOK || !stable(afterStat) || !stable(namedStat) || ctx.Err() != nil {
		return refuse()
	}
	return platformFileFacts{identity: authority.RootIdentity{Device: strconv.FormatUint(uint64(afterStat.Dev), 10), Inode: strconv.FormatUint(uint64(afterStat.Ino), 10)},
		size: after.Size(), path: path, sha256: hex.EncodeToString(hash.Sum(nil)), mode: after.Mode(), uid: afterStat.Uid, links: uint64(afterStat.Nlink)}, nil
}

func (nativePlatformFacts) directory(ctx context.Context, path string) (platformDirectoryFacts, error) {
	refuse := func() (platformDirectoryFacts, error) { return platformDirectoryFacts{}, &processsvc.NativeFailure{} }
	if ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	pin, err := (darwinLaunchFilesystem{}).openDirectory(path)
	if err != nil || pin == nil {
		return refuse()
	}
	defer pin.Close()
	dir, ok := pin.(*darwinDirectoryPin)
	if !ok {
		return refuse()
	}
	physical, err := platformDescriptorPath(dir.Fd())
	if err != nil || physical != path {
		return refuse()
	}
	measured, err := dir.inspect(path)
	if err != nil {
		return refuse()
	}
	var fs unix.Statfs_t
	if unix.Fstatfs(int(dir.Fd()), &fs) != nil {
		return refuse()
	}
	text := func(bytes []byte) string { return strings.TrimRight(string(bytes), "\x00") }
	mount := text(fs.Mntonname[:])
	count, err := unix.Getfsstat(nil, unix.MNT_NOWAIT)
	if err != nil || count <= 0 || count > 1024 {
		return refuse()
	}
	mounts := make([]unix.Statfs_t, count+1)
	n, err := unix.Getfsstat(mounts, unix.MNT_NOWAIT)
	if err != nil || n != count {
		return refuse()
	}
	var nestedMounts []string
	// Compare both APFS namespace spellings without broadening root grants.
	for _, candidate := range mounts[:n] {
		p := text(candidate.Mntonname[:])
		if p != "/" && !absolutePolicyPath(p) {
			return refuse()
		}
		if platformNestedMount(path, mount, p) {
			nestedMounts = append(nestedMounts, logicalMountPath(path, mount, p))
		}
	}
	again, err := dir.inspect(path)
	if err != nil || again.identity != measured.identity || ctx.Err() != nil {
		return refuse()
	}
	slices.Sort(nestedMounts)
	nestedMounts = slices.Compact(nestedMounts)
	return platformDirectoryFacts{path, text(fs.Fstypename[:]), mount, measured.identity, fs.Flags&unix.MNT_LOCAL != 0, len(nestedMounts) > 0, strings.Join(nestedMounts, "\n")}, nil
}
