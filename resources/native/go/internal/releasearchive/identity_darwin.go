package releasearchive

import (
	"os"
	"syscall"
)

// File identity includes nanosecond change time, not just portable FileInfo data.
func identify(info os.FileInfo) identity {
	s := info.Sys().(*syscall.Stat_t)
	return identity{int64(s.Dev), s.Ino, uint32(s.Mode), uint64(s.Nlink), s.Uid, s.Gid,
		s.Size, s.Mtimespec.Sec, s.Mtimespec.Nsec, s.Ctimespec.Sec, s.Ctimespec.Nsec}
}
