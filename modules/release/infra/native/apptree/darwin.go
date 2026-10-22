//go:build darwin

package apptree

import "golang.org/x/sys/unix"

func metadata(s unix.Stat_t) fingerprint {
	return fingerprint{device: uint64(s.Dev), inode: s.Ino, mode: uint32(s.Mode), uid: s.Uid, gid: s.Gid, links: uint64(s.Nlink), size: s.Size}
}
