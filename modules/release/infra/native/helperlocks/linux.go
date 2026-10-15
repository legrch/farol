//go:build linux

package helperlocks

import "golang.org/x/sys/unix"

func metadata(s unix.Stat_t) fingerprint {
	return fingerprint{device: uint64(s.Dev), inode: s.Ino, mode: s.Mode, uid: s.Uid, gid: s.Gid, links: uint64(s.Nlink)}
}
