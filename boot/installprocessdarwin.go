//go:build darwin

package boot

import (
	"bytes"
	"context"
	"errors"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

// proc_info(PIDINFO, pid, PIDPATHINFO) is the kernel operation behind
// libproc's proc_pidpath. The Go backend is built without cgo.
func resolveInstallExecutable(ctx context.Context, pid int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", errors.New("INSTALL_PROCESS_OBSERVATION_UNKNOWN")
	}
	var path [4096]byte
	const procInfoCallPIDInfo = 2
	const procPIDPathInfo = 11
	_, _, errno := unix.Syscall6(unix.SYS_PROC_INFO, procInfoCallPIDInfo, uintptr(pid), procPIDPathInfo, 0, uintptr(unsafe.Pointer(&path[0])), uintptr(len(path)))
	runtime.KeepAlive(&path)
	if ctx.Err() != nil {
		return "", errors.New("INSTALL_PROCESS_OBSERVATION_UNKNOWN")
	}
	if errno == 0 {
		end := bytes.IndexByte(path[:], 0)
		if end > 0 && path[0] == '/' {
			return string(path[:end]), nil
		}
	}
	// A process can vanish between ps and proc_info. Only ESRCH confirms
	// that it is gone; every live but unreadable process remains a refusal.
	if err := unix.Kill(pid, 0); errors.Is(err, unix.ESRCH) {
		return "", nil
	}
	return "", errors.New("INSTALL_PROCESS_OBSERVATION_UNKNOWN")
}
