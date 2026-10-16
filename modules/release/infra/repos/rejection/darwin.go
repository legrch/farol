//go:build darwin

package rejection

import "golang.org/x/sys/unix"

func metadata(s unix.Stat_t) fingerprint {
	return fingerprint{device: uint64(s.Dev), inode: s.Ino, mode: uint32(s.Mode), uid: s.Uid, gid: s.Gid, links: uint64(s.Nlink), size: s.Size, mtimeSec: s.Mtim.Sec, mtimeNano: s.Mtim.Nsec, ctimeSec: s.Ctim.Sec, ctimeNano: s.Ctim.Nsec}
}
func nativeSupported() bool { return true }
func publish(fd int, temp string) error {
	return unix.RenameatxNp(fd, temp, fd, filename, unix.RENAME_EXCL)
}
