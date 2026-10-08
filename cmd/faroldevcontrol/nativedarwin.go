//go:build darwin

package main

import (
	"errors"

	"golang.org/x/sys/unix"
)

func nativePorts() ports {
	return ports{supported: true, inspect: nativeInspect, signal: func(q request) response {
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
	if !validPID(q.PID) || !validDevPaths(q.Executable, q.AppPath) {
		return response{Status: "refused", Reason: "COMMAND_MISMATCH"}
	}
	raw, err := unix.SysctlRaw("kern.procargs2", q.PID)
	if errors.Is(err, unix.ESRCH) {
		return response{Status: "absent"}
	}
	if err != nil {
		return readFailure(err)
	}
	if !matchesProcArgs(raw, q) {
		return response{Status: "refused", Reason: "COMMAND_MISMATCH"}
	}
	return response{Status: "present"}
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
