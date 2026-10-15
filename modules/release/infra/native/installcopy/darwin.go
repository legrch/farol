//go:build darwin

package installcopy

import "golang.org/x/sys/unix"

func metadata(s unix.Stat_t) fingerprint {
	return fingerprint{uint64(s.Dev), s.Ino, uint32(s.Mode), s.Uid, s.Gid, uint64(s.Nlink), s.Size, s.Mtim.Sec, s.Mtim.Nsec, s.Ctim.Sec, s.Ctim.Nsec}
}
