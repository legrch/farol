//go:build darwin

package boot

import (
	"errors"
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

type darwinProfileOS struct{}

var _ profileOS = darwinProfileOS{}

func qualifyNativeProfile(binding ProfileBinding) (*QualifiedProfile, error) {
	return qualifyProfile(binding, darwinProfileOS{})
}
func (darwinProfileOS) uid() uint32 { return uint32(os.Geteuid()) }

// No create/write flags, no symlink following, no mutation and no retry. The
// injected CPU tests cannot qualify these Darwin flags or kernel behavior.
const profileOpenFlags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC

func (darwinProfileOS) openRoot() (int, error) {
	fd, err := unix.Open("/", profileOpenFlags, 0)
	return fd, profileIOFailure(err)
}
func (darwinProfileOS) openDirectory(parent int, name string) (int, error) {
	fd, err := unix.Openat(parent, name, profileOpenFlags, 0)
	return fd, profileIOFailure(err)
}
func profileStat(stat unix.Stat_t) profileMetadata {
	return profileMetadata{device: uint64(stat.Dev), inode: stat.Ino, uid: stat.Uid, mode: uint32(stat.Mode)}
}
func (darwinProfileOS) stat(fd int) (profileMetadata, error) {
	var stat unix.Stat_t
	err := unix.Fstat(fd, &stat)
	return profileStat(stat), profileIOFailure(err)
}
func (darwinProfileOS) statRoot() (profileMetadata, error) {
	var stat unix.Stat_t
	err := unix.Lstat("/", &stat)
	return profileStat(stat), profileIOFailure(err)
}
func (darwinProfileOS) statEntry(parent int, name string) (profileMetadata, error) {
	var stat unix.Stat_t
	err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW)
	return profileStat(stat), profileIOFailure(err)
}
func (darwinProfileOS) physicalPath(fd int) (string, error) {
	// F_GETPATH checks the kernel's physical spelling, including case/Unicode
	// aliases on Darwin. Do not normalize an alternate spelling into acceptance.
	// Darwin's path buffer is MAXPATHLEN (1024); longer inputs fail closed.
	var path [1024]byte
	// Pin before passing the address through FcntlInt's integer argument.
	var pinned runtime.Pinner
	pinned.Pin(&path[0])
	defer pinned.Unpin()
	_, err := unix.FcntlInt(uintptr(fd), unix.F_GETPATH, int(uintptr(unsafe.Pointer(&path[0]))))
	runtime.KeepAlive(&path)
	if err != nil {
		return "", profileIOFailure(err)
	}
	for i, c := range path {
		if c == 0 {
			if i == 0 {
				return "", profileFailure(ProfileUnavailable)
			}
			return string(path[:i]), nil
		}
	}
	return "", profileFailure(ProfileUnavailable)
}
func (darwinProfileOS) close(fd int) error {
	if unix.Close(fd) != nil {
		return profileFailure(ProfileCleanupUnknown)
	}
	return nil
}
func profileIOFailure(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, unix.ELOOP), errors.Is(err, unix.ENOTDIR), errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
		return profileFailure(ProfileRefused)
	default:
		// Missing children and other OS failures supply no usable roots. EINTR,
		// busy, resource limits and absence are never retried or repaired here.
		return profileFailure(ProfileUnavailable)
	}
}
