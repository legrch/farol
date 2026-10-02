package releasearchive

import (
	"os"
	"syscall"
)

func identify(info os.FileInfo) identity {
	s := info.Sys().(*syscall.Stat_t)
	return identity{int64(s.Dev), s.Ino, s.Mode, uint64(s.Nlink), s.Uid, s.Gid,
		s.Size, s.Mtim.Sec, s.Mtim.Nsec, s.Ctim.Sec, s.Ctim.Nsec}
}
