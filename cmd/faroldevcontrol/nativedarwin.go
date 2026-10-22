//go:build darwin

package main

import (
	"bytes"
	"errors"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

func nativePorts() ports {
	return ports{supported: true, inspect: nativeInspect, command: nativeCommand, signal: func(q request) response {
		return checkedSignal(q, nativeInspect, nativeCallerUID, nativeCommand, nativeKill)
	}}
}

func nativeCallerUID() (uint32, bool) {
	uid := unix.Getuid()
	return uint32(uid), uid >= 0 && uid == unix.Geteuid()
}

func nativeInspect(pid int) response {
	if !validPID(pid) {
		return response{Status: "error", Reason: "INVALID_REQUEST"}
	}
	// Only this exact PID is queried. KinfoProc includes other kernel fields,
	// but no command, environment, groups or parent data is read or emitted.
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		if errors.Is(err, unix.ESRCH) {
			return response{Status: "absent"}
		}
		if errors.Is(err, unix.EIO) {
			// x/sys v0.35.0 maps a zero-sized result to EIO. Confirm the
			// zero-sized exact-PID result without treating arbitrary EIO,
			// EPERM or EACCES as absence. A new nonempty result fails closed.
			raw, rawErr := unix.SysctlRaw("kern.proc.pid", pid)
			if rawErr == nil && len(raw) == 0 || errors.Is(rawErr, unix.ESRCH) {
				return response{Status: "absent"}
			}
			if rawErr != nil {
				return readFailure(rawErr)
			}
		}
		return readFailure(err)
	}
	if kp == nil || int(kp.Proc.P_pid) != pid || kp.Eproc.Pcred.P_ruid != kp.Eproc.Ucred.Uid {
		return response{Status: "unreadable", Reason: "IDENTITY_UNREADABLE"}
	}
	boot, err := unix.Sysctl("kern.bootsessionuuid")
	if err != nil {
		// Failure of the boot read cannot prove absence of the process.
		return readFailure(err)
	}
	token, ok := lifetimeToken(boot, kp.Proc.P_starttime.Sec, int64(kp.Proc.P_starttime.Usec))
	if !ok {
		return response{Status: "unreadable", Reason: "IDENTITY_UNREADABLE"}
	}
	return response{Status: "present", identity: &identity{
		PID: pid, UID: kp.Eproc.Ucred.Uid, Token: token,
	}}
}

func nativeCommand(q request) response {
	if !validPID(q.PID) || !validCommandScope(q) {
		return response{Status: "refused", Reason: "COMMAND_MISMATCH"}
	}
	// proc_pidpath's kernel operation, without enabling CGO in the authenticated
	// helper build. This is independent of argv[0] and KERN_PROCARGS2's exec string.
	executable, err := nativeExecutable(q.PID)
	if err != nil {
		return readFailure(err)
	}
	if executable != q.Executable {
		return response{Status: "refused", Reason: "WRITER_EXECUTABLE_MISMATCH"}
	}
	raw, err := unix.SysctlRaw("kern.procargs2", q.PID)
	if errors.Is(err, unix.ESRCH) {
		return response{Status: "absent"}
	}
	if err != nil {
		return readFailure(err)
	}
	return inspectProcessCommand(executable, raw, q)
}

func readFailure(err error) response {
	if errors.Is(err, unix.EPERM) || errors.Is(err, unix.EACCES) {
		return response{Status: "unreadable", Reason: "INSPECTION_PERMISSION_DENIED"}
	}
	return response{Status: "unreadable", Reason: "IDENTITY_UNREADABLE"}
}

func nativeKill(pid int, name string) response {
	// Defense in depth: never allow kill(0), kill(-pid), or other signals.
	if !validPID(pid) || !validSignal(name) {
		return response{Status: "error", Reason: "INVALID_REQUEST"}
	}
	signal := unix.SIGTERM
	if name == "SIGKILL" {
		signal = unix.SIGKILL
	}
	err := unix.Kill(pid, signal)
	switch {
	case err == nil:
		// Kernel acceptance only; no claim of exit, drain or descendant closure.
		return response{Status: "sent"}
	case errors.Is(err, unix.ESRCH):
		return response{Status: "absent"}
	case errors.Is(err, unix.EPERM), errors.Is(err, unix.EACCES):
		return response{Status: "refused", Reason: "SIGNAL_PERMISSION_DENIED"}
	default:
		// Never retry an unclassified signal outcome.
		return response{Status: "unknown", Reason: "SIGNAL_OUTCOME_UNKNOWN"}
	}
}

// Apple libproc's proc_pidpath uses __proc_info(2, pid, 11, 0, buffer, size).
// https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c
func nativeExecutable(pid int) (string, error) {
	var buffer [4096]byte
	_, _, errno := syscall.Syscall6(unix.SYS_PROC_INFO, 2, uintptr(pid), 11, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if errno != 0 {
		return "", errno
	}
	// The kernel returns zero on success; libproc derives the length from NUL.
	end := bytes.IndexByte(buffer[:], 0)
	if end <= 0 || !canonicalPath(string(buffer[:end])) {
		return "", unix.EIO
	}
	return string(buffer[:end]), nil
}
