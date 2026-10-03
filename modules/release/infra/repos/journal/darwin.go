//go:build darwin

package journal

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func metadata(info os.FileInfo) (fileState, bool) {
	s, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileState{}, false
	}
	return fileState{Device: uint64(s.Dev), Inode: s.Ino, UID: uint64(s.Uid), GID: uint64(s.Gid), Links: uint64(s.Nlink), Mode: uint32(s.Mode), Size: s.Size,
		ModifiedSeconds: s.Mtimespec.Sec, ModifiedNanos: s.Mtimespec.Nsec, ChangedSeconds: s.Ctimespec.Sec, ChangedNanos: s.Ctimespec.Nsec}, true
}
func directoryFlags() int {
	return os.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
}
func fileFlags() int { return os.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK }
func createFlags() int {
	return os.O_WRONLY | os.O_CREATE | os.O_EXCL | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
}
func rename(parent *os.File, temporary string, absent bool) error {
	fd := int(parent.Fd())
	if absent {
		return unix.RenameatxNp(fd, temporary, fd, filename, unix.RENAME_EXCL)
	}
	return unix.Renameat(fd, temporary, fd, filename)
}
