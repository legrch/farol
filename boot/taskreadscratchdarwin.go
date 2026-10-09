//go:build darwin

package boot

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"unsafe"

	"golang.org/x/sys/unix"
)

// The existing physical-profile boundary owns descriptor-relative no-follow
// opens, F_GETPATH spelling checks, stat mapping and checked original closes.
type darwinTaskScratchOS struct{ darwinProfileOS }

var _ taskScratchOS = darwinTaskScratchOS{}

func nativeTaskScratchOS() taskScratchOS { return darwinTaskScratchOS{} }

func (darwinTaskScratchOS) name() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", taskScratchFailure(TaskReadScratchUnavailable)
	}
	return "farol-codex-read-" + hex.EncodeToString(bytes[:]), nil
}

func (darwinTaskScratchOS) mkdir(parent int, name string) error {
	// Exactly one exclusive mkdir. EEXIST, EINTR and all other failures are
	// sticky; no preexisting child is adopted and no permissions are repaired.
	return profileIOFailure(unix.Mkdirat(parent, name, 0700))
}

func (darwinTaskScratchOS) empty(fd int) error {
	var before, after unix.Stat_t
	if err := unix.Fstat(fd, &before); err != nil {
		return profileIOFailure(err)
	}
	if _, err := unix.Seek(fd, 0, 0); err != nil {
		return profileIOFailure(err)
	}
	// Bound the inventory to four 4096-byte reads. Any entry beyond dot/dot-dot
	// refuses qualification. ReadDirent's Darwin library adapter uses temporary
	// directory streams internally; this resource retains and checks closes of
	// its ORIGINAL descriptor pins. No stream opens are lifetime replacements.
	var buf [4096]byte
	ended := false
	for i := 0; i < 4; i++ {
		n, err := unix.ReadDirent(fd, buf[:])
		if err != nil {
			return profileIOFailure(err)
		}
		if n == 0 {
			ended = true
			break
		}
		if n < 0 || n > len(buf) {
			return taskScratchFailure(TaskReadScratchUnavailable)
		}
		if err := taskScratchDarwinDirents(buf[:n]); err != nil {
			return err
		}
	}
	if !ended {
		return taskScratchFailure(TaskReadScratchUnavailable)
	}
	if err := unix.Fstat(fd, &after); err != nil {
		return profileIOFailure(err)
	}
	if profileStat(before) != profileStat(after) || before.Mtim != after.Mtim || before.Ctim != after.Ctim {
		return taskScratchFailure(TaskReadScratchChanged)
	}
	return nil
}

// Unlike ParseDirent's best-effort parser, truncated/zero/deleted/unknown
// records cannot become an empty observation. ReadDirent supplies Darwin dirent
// records in native byte order. Only well-formed dot and dot-dot are ignored.
func taskScratchDarwinDirents(buf []byte) error {
	const (
		ino  = int(unsafe.Offsetof(unix.Dirent{}.Ino))
		rec  = int(unsafe.Offsetof(unix.Dirent{}.Reclen))
		nam  = int(unsafe.Offsetof(unix.Dirent{}.Namlen))
		name = int(unsafe.Offsetof(unix.Dirent{}.Name))
	)
	for len(buf) != 0 {
		if len(buf) < name+1 {
			return taskScratchFailure(TaskReadScratchUnavailable)
		}
		size := int(binary.NativeEndian.Uint16(buf[rec : rec+2]))
		length := int(binary.NativeEndian.Uint16(buf[nam : nam+2]))
		if size < name+1 || size > len(buf) || length < 1 || length > 255 || name+length >= size || buf[name+length] != 0 || binary.NativeEndian.Uint64(buf[ino:ino+8]) == 0 {
			return taskScratchFailure(TaskReadScratchUnavailable)
		}
		entry := string(buf[name : name+length])
		if entry != "." && entry != ".." {
			return taskScratchFailure(TaskReadScratchNonEmpty)
		}
		buf = buf[size:]
	}
	return nil
}
