//go:build darwin || linux

package descriptor

import "golang.org/x/sys/unix"

// Stat reads the metadata of an open descriptor. On error the returned value
// is whatever the kernel left in it; callers must check the error first.
func Stat(fd int) (unix.Stat_t, error) {
	var s unix.Stat_t
	err := unix.Fstat(fd, &s)
	return s, err
}

// Same reports whether two stats name the same object (device and inode).
func Same(a, b unix.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }

// Stable reports whether two stats of the same object show no change: mode,
// owner, link count, size, modification and status-change time all match.
func Stable(a, b unix.Stat_t) bool {
	return Same(a, b) && a.Mode == b.Mode && a.Uid == b.Uid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

// Private reports whether s is exactly of type kind (unix.S_IFREG,
// unix.S_IFDIR, ...) with permission bits mode (setuid, setgid and sticky
// included), owned by uid and, unless kind is a directory, with a single link.
// A symlink never passes for another kind because lstat-style callers see its
// own type.
func Private(s unix.Stat_t, kind, mode, uid uint32) bool {
	return uint32(s.Mode)&unix.S_IFMT == kind && uint32(s.Mode)&07777 == mode && s.Uid == uid && (kind == unix.S_IFDIR || s.Nlink == 1)
}
