package boot

import (
	"io"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// Run owns descriptor 3 in this child, selected only by the explicit flag. No
// filename, alternate descriptor, stdin fallback or second read attempt exists.
// Set nonblocking before NewFile so Go registers the inherited stream with its
// poller. A bounded EOF read must finish before parsing or native composition.
func readShellLaunchPipe() ([]byte, error) { return consumeShellLaunchPipe(3) }

func consumeShellLaunchPipe(fd int) (raw []byte, result error) {
	var owned *os.File
	defer func() {
		var err error
		if owned == nil {
			err = unix.Close(fd)
		} else {
			err = owned.Close()
		}
		if err != nil {
			raw, result = nil, shellLaunchRefusal()
		}
	}()
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || (stat.Mode&unix.S_IFMT != unix.S_IFIFO && stat.Mode&unix.S_IFMT != unix.S_IFSOCK) {
		return nil, shellLaunchRefusal()
	}
	unix.CloseOnExec(fd)
	if unix.SetNonblock(fd, true) != nil {
		return nil, shellLaunchRefusal()
	}
	owned = os.NewFile(uintptr(fd), "farol-shell-launch")
	if owned == nil || owned.SetReadDeadline(time.Now().Add(2*time.Second)) != nil {
		return nil, shellLaunchRefusal()
	}
	raw, err := io.ReadAll(io.LimitReader(owned, shellLaunchMaximumBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > shellLaunchMaximumBytes {
		return nil, shellLaunchRefusal()
	}
	return raw, nil
}
