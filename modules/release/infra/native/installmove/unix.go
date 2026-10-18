//go:build darwin || linux

package installmove

import (
	"errors"
	"strconv"

	"golang.org/x/sys/unix"
)

// effect is supplied only by Darwin production or a private disposable test.
type unixBackend struct {
	effect func(int, string, int, string, bool) error
}

func (unixBackend) held(fd int) (metadata, error) {
	var s unix.Stat_t
	err := unix.Fstat(fd, &s)
	return statMetadata(s), err
}
func (unixBackend) named(fd int, name string) (metadata, bool, error) {
	var s unix.Stat_t
	err := unix.Fstatat(fd, name, &s, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return metadata{}, false, nil
	}
	return statMetadata(s), err == nil, err
}
func statMetadata(s unix.Stat_t) metadata {
	return metadata{identity: Identity{Device: strconv.FormatUint(uint64(s.Dev), 10), Inode: strconv.FormatUint(uint64(s.Ino), 10)}, mode: uint32(s.Mode), uid: s.Uid, gid: s.Gid, directory: s.Mode&unix.S_IFMT == unix.S_IFDIR, owner: s.Uid == uint32(unix.Geteuid()), protected: s.Mode&0022 == 0}
}
func (unixBackend) pin(fd int, name string) (int, error) {
	pin, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.ELOOP) {
		return -1, errEntryChanged
	}
	return pin, err
}
func (unixBackend) close(fd int) error { return unix.Close(fd) }
func (b unixBackend) move(l int, ln string, r int, rn string, exchange bool) error {
	return b.effect(l, ln, r, rn, exchange)
}
func (unixBackend) sync(fd int) error { return unix.Fsync(fd) }
func (unixBackend) classify(err error, exchange bool) (string, bool) {
	if !exchange && errors.Is(err, unix.EEXIST) {
		return "destination_exists", true
	}
	if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EXDEV) || errors.Is(err, unix.EINVAL) {
		return unsupported(exchange), true
	}
	return "", false
}
