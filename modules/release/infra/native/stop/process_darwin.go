//go:build darwin

package stop

import (
	"bytes"
	"context"
	"errors"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"

	"github.com/legrch/farol/modules/release/app/port"
)

type nativeSystem struct{}

// path is proc_info(PIDINFO, pid, PIDPATHINFO), libproc's proc_pidpath; the
// backend is built without cgo. Only ESRCH establishes that the PID is gone.
func (nativeSystem) path(ctx context.Context, pid int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	var buf [4096]byte
	const procInfoCallPIDInfo = 2
	const procPIDPathInfo = 11
	_, _, errno := unix.Syscall6(unix.SYS_PROC_INFO, procInfoCallPIDInfo, uintptr(pid), procPIDPathInfo, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	runtime.KeepAlive(&buf)
	if errno == 0 {
		end := bytes.IndexByte(buf[:], 0)
		if end > 0 && buf[0] == '/' {
			return string(buf[:end]), nil
		}
	}
	if err := unix.Kill(pid, 0); errors.Is(err, unix.ESRCH) {
		return "", nil
	}
	return "", ErrUnknown
}

func (nativeSystem) signal(pid int, s port.ProcessSignal) error {
	sig := unix.SIGTERM
	if s == port.ProcessSignalKill {
		sig = unix.SIGKILL
	}
	if err := unix.Kill(pid, sig); err != nil && !errors.Is(err, unix.ESRCH) {
		return err
	}
	return nil
}
