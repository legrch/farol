"""Original-child deadlines and bounded cleanup in a private PID namespace."""
from __future__ import annotations

import math
import os
from pathlib import Path
import signal
import sys
import time

JOB_SECONDS = {"checks-source": 1800, "core": 1800, "pilot-selftests": 300, "scan-secrets": 600}


class CommandTimeout(TimeoutError):
    pass


def usage_record(pid, status, usage):
    return {"pid": pid, "terminal": True, "exitCode": os.waitstatus_to_exitcode(status),
            "userCpuSeconds": usage.ru_utime, "systemCpuSeconds": usage.ru_stime,
            "maxIndividualReapedChildRssBytes": usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024)}


def wait_original(child, seconds):
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("POSITIVE_FINITE_COMMAND_DEADLINE_REQUIRED")
    deadline = time.monotonic() + seconds
    while True:
        if time.monotonic() >= deadline:
            raise CommandTimeout("ORIGINAL_COMMAND_DEADLINE_EXCEEDED")
        pid, status, usage = os.wait4(child.pid, os.WNOHANG)
        if pid:
            child.returncode = os.waitstatus_to_exitcode(status)
            return usage_record(pid, status, usage)
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))


def private_processes(reaped):
    if os.getpid() != 1:
        raise ValueError("PRIVATE_PID_NAMESPACE_REQUIRED")
    while True:
        try:
            pid, status, usage = os.wait4(-1, os.WNOHANG)
            if not pid:
                break
            reaped.append(usage_record(pid, status, usage))
        except ChildProcessError:
            break
    return sorted(int(p.name) for p in Path("/proc").iterdir()
                  if p.name.isdigit() and int(p.name) != 1)


def retire_private_descendants(timed_out, natural_seconds=2, term_seconds=3, kill_seconds=3):
    """Only PID1 of the disposable non-root/no-network container may call this.

    Ordinary cancellation drains naturally. A command deadline or leaked child
    is a failed test attempt; bounded signals clean only that owned namespace.
    No outcome on this cleanup path can turn the test into PASS.
    """
    reaped = []
    initial = private_processes(reaped)
    remaining = initial
    actions = []
    errors = []
    phases = [] if timed_out else [(None, natural_seconds)]
    phases += [(signal.SIGTERM, term_seconds), (signal.SIGKILL, kill_seconds)]
    for selected_signal, seconds in phases:
        until = time.monotonic() + seconds
        signalled = set()
        while remaining:
            if selected_signal is not None:
                for pid in remaining:
                    if pid in signalled:
                        continue
                    try:
                        os.kill(pid, selected_signal)
                        actions.append({"pid": pid, "signal": int(selected_signal)})
                        signalled.add(pid)
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        errors.append({"pid": pid, "error": "PERMISSION_DENIED"})
                        signalled.add(pid)
            if time.monotonic() >= until:
                break
            time.sleep(0.05)
            remaining = private_processes(reaped)
        if not remaining:
            break
    remaining = private_processes(reaped)
    return {"initialPids": initial, "remainingPids": remaining, "reaped": reaped,
            "signals": actions, "errors": errors, "drained": not remaining,
            "reason": "COMMAND_DEADLINE" if timed_out else "UNEXPECTED_DESCENDANTS" if initial else "NATURAL_TERMINAL"}
