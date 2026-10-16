//go:build linux

package rejection

import "golang.org/x/sys/unix"

func metadata(s unix.Stat_t) fingerprint {
	return fingerprint{device: uint64(s.Dev), inode: s.Ino, mode: s.Mode, uid: s.Uid, gid: s.Gid, links: uint64(s.Nlink), size: s.Size, mtimeSec: s.Mtim.Sec, mtimeNano: s.Mtim.Nsec, ctimeSec: s.Ctim.Sec, ctimeNano: s.Ctim.Nsec}
}

// The production helper's native publication capability is Darwin-only.
func nativeSupported() bool     { return false }
func publish(int, string) error { return unix.ENOTSUP }
