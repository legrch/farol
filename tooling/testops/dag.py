"""Bounded Product pilot scheduling; exact executors still own test acceptance.

There is no arbitrary-command or selected-test CLI here. Unknown child outcomes
retain a persistent writer-local lease. Cancellation drains issued work without
signalling it. This does not coordinate or claim ownership of another writer.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import stat
import threading
import time
import uuid


class Blocked(ValueError):
    pass


@dataclass(frozen=True)
class Job:
    id: str
    deps: tuple[str, ...] = ()
    resources: tuple[str, ...] = ()
    cpu: int = 1
    memory_mib: int = 256
    platform: str = "portable"
    target: str = "local"
    effects: str = "source-read"


@dataclass(frozen=True)
class Budget:
    jobs: int = 1
    cpu: int = 2
    memory_mib: int = 3072


@dataclass(frozen=True)
class Outcome:
    status: str
    terminal: bool
    receipt: dict | None = None
    reason: str | None = None


def validate(jobs, budget, platform):
    if (not isinstance(budget, Budget) or type(budget.jobs) is not int or not 1 <= budget.jobs <= 2
            or type(budget.cpu) is not int or not 1 <= budget.cpu <= 4
            or type(budget.memory_mib) is not int or not 1 <= budget.memory_mib <= 6144
            or platform not in {"macos", "linux"}):
        raise Blocked("BUDGET_OR_HOST_INVALID")
    if (type(jobs) not in {list, tuple} or not jobs
            or any(not isinstance(j, Job) or not isinstance(j.id, str) for j in jobs)):
        raise Blocked("EMPTY_OR_INVALID_JOBS")
    ids = {j.id for j in jobs}
    if len(ids) != len(jobs):
        raise Blocked("DUPLICATE_JOB")
    for j in jobs:
        if (not isinstance(j.id, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", j.id)
                or type(j.deps) is not tuple or type(j.resources) is not tuple
                or any(not isinstance(v, str) or not v for v in j.deps + j.resources)
                or len(set(j.deps)) != len(j.deps) or len(set(j.resources)) != len(j.resources)
                or any(not re.fullmatch(r"[a-z0-9][a-z0-9:._/-]{0,127}", r) or ".." in r for r in j.resources)
                or not set(j.deps) <= ids or j.id in j.deps
                or type(j.cpu) is not int or not 1 <= j.cpu <= budget.cpu
                or type(j.memory_mib) is not int or not 1 <= j.memory_mib <= budget.memory_mib
                or j.platform not in {"portable", "macos", "linux"}
                or j.target != "local" or j.effects not in {"source-read", "owned-fixture"}):
            raise Blocked("JOB_METADATA_OR_AUTHORITY_INVALID:" + j.id)
    reached = set()
    while True:
        expanded = reached | {j.id for j in jobs if set(j.deps) <= reached}
        if expanded == reached:
            break
        reached = expanded
    if reached != ids:
        raise Blocked("DEPENDENCY_CYCLE")


def owned_directory(root, relative):
    root = root.resolve(strict=True)
    pieces = Path(relative).parts
    if (not pieces or Path(relative).is_absolute() or pieces[:2] != ("_output", "testops")
            or any(p in {"..", ".git"} for p in pieces)):
        raise Blocked("OUTPUT_OUTSIDE_PILOT")
    current = root
    for piece in pieces:
        current = current / piece
        if current.is_symlink():
            raise Blocked("OUTPUT_REDIRECT_REFUSED")
        current.mkdir(exist_ok=True, mode=0o700)
        if not current.is_dir():
            raise Blocked("OUTPUT_NOT_DIRECTORY")
    return current


class Lease:
    """Crash residue fences admission; PID age is never recovery authority."""

    def __init__(self, parent):
        self.path = parent / "active-source-gate.lease"
        self.nonce = uuid.uuid4().hex
        self.identity = None

    def acquire(self, output):
        try:
            self.path.mkdir(mode=0o700)
        except FileExistsError as error:
            raise Blocked("SOURCE_GATE_LEASE_BUSY") from error
        info = self.path.lstat()
        self.identity = (info.st_dev, info.st_ino)
        descriptor = None
        owner_identity = None
        try:
            descriptor = os.open(self.path / "owner.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            owner = os.fstat(descriptor)
            owner_identity = (owner.st_dev, owner.st_ino)
            stream = os.fdopen(descriptor, "w")
            descriptor = None  # The stream now owns the original descriptor.
            with stream:
                json.dump({"schema": 1, "leaseId": self.nonce, "pid": os.getpid(), "output": str(output)}, stream)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
        except Exception as error:
            if descriptor is not None:
                os.close(descriptor)
            try:
                info = self.path.lstat()
                if (not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != self.identity
                        or set(os.listdir(self.path)) != ({"owner.json"} if owner_identity else set())):
                    raise Blocked("LEASE_SETUP_IDENTITY_CHANGED")
                if owner_identity:
                    path = self.path / "owner.json"
                    owner = path.lstat()
                    if (not stat.S_ISREG(owner.st_mode) or owner.st_nlink != 1 or owner.st_uid != os.getuid()
                            or (owner.st_dev, owner.st_ino) != owner_identity):
                        raise Blocked("LEASE_SETUP_OWNER_CHANGED")
                    path.unlink()
                self.path.rmdir()
            except Exception as cleanup_error:
                raise Blocked("LEASE_SETUP_FAILED;ORIGINAL_CLEANUP_UNCONFIRMED") from cleanup_error
            raise Blocked("LEASE_SETUP_FAILED;PRE_JOB_LEASE_RELEASED") from error

    def release(self):
        info = self.path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != self.identity
                or set(os.listdir(self.path)) != {"owner.json"}):
            raise Blocked("LEASE_IDENTITY_CHANGED")
        owner = self.path / "owner.json"
        info = owner.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_size > 8192 or json.loads(owner.read_text()).get("leaseId") != self.nonce):
            raise Blocked("LEASE_OWNER_CHANGED")
        owner.unlink()
        self.path.rmdir()


def checked_outcome(job, outcome, source):
    if (not isinstance(outcome, Outcome) or type(outcome.terminal) is not bool
            or outcome.status == "UNKNOWN" or not outcome.terminal):
        return {"id": job.id, "status": "UNKNOWN", "terminal": False, "reason": "ORIGINAL_OUTCOME_UNCONFIRMED"}
    if outcome.status not in {"PASS", "FAIL", "BLOCKED"}:
        return {"id": job.id, "status": "FAIL", "terminal": True, "reason": "INVALID_EXECUTOR_STATUS"}
    if outcome.status == "PASS":
        r = outcome.receipt
        if (not isinstance(r, dict) or type(r.get("schema")) is not int or r.get("schema") != 1 or r.get("id") != job.id
                or r.get("source") != source or type(r.get("exitCode")) is not int
                or r.get("exitCode") != 0 or r.get("complete") is not True):
            return {"id": job.id, "status": "FAIL", "terminal": True, "reason": "INCOMPLETE_OR_MISMATCHED_RECEIPT"}
    return {"id": job.id, "status": outcome.status, "terminal": True,
            "reason": outcome.reason, "receipt": outcome.receipt}


def run(root, jobs, budget, platform, identity, execute, output_name, stop=None):
    """Run only caller-audited executors; never accept a command from a report.

    An executor must wait on its original children and validate its complete
    reports before returning. UNKNOWN leaves the lease fenced for reconciliation.
    A known failure stops new admissions but drains in-flight independent work.
    """
    validate(jobs, budget, platform)
    stop = stop if stop is not None else threading.Event()
    parent = owned_directory(root, "_output/testops")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", output_name):
        raise Blocked("OUTPUT_NAME_INVALID")
    output = parent / output_name
    if output.exists() or output.is_symlink():
        raise Blocked("OUTPUT_ALREADY_EXISTS")
    lease = Lease(parent)
    lease.acquire(output)
    try:
        output.mkdir(mode=0o700)
    except Exception as error:
        # No executor exists yet. A known output-creation failure must not
        # strand our successfully acquired lease or touch a competing output.
        try:
            lease.release()
        except Exception as release_error:
            raise Blocked("OUTPUT_CREATION_FAILED;LEASE_RELEASE_UNCONFIRMED") from release_error
        raise Blocked("OUTPUT_CREATION_FAILED;PRE_JOB_LEASE_RELEASED") from error
    started = time.monotonic()
    source = None
    after = None
    records = {}
    trace = []
    unconfirmed = False
    release_error = None
    source_error = None
    running = {}
    try:
        source = json.loads(json.dumps(identity(), allow_nan=False))
        if not isinstance(source, dict) or not source:
            raise Blocked("SOURCE_IDENTITY_MISSING")
        pending = {j.id: j for j in jobs}
        halted = False
        with ThreadPoolExecutor(max_workers=budget.jobs) as pool:
            while pending or running:
                cancelled = stop.is_set()
                if cancelled:
                    halted = True
                if halted:
                    for key in sorted(pending):
                        records[key] = {"id": key, "status": "NOT_RUN", "terminal": True,
                                        "reason": "CANCELLED" if cancelled else "PRIOR_FAILURE_OR_UNKNOWN"}
                    pending.clear()
                held = {r for j in running.values() for r in j.resources}
                used_cpu = sum(j.cpu for j in running.values())
                used_memory = sum(j.memory_mib for j in running.values())
                for key in sorted(list(pending)):
                    if stop.is_set():
                        break
                    j = pending[key]
                    if not all(d in records and records[d]["status"] == "PASS" for d in j.deps):
                        continue
                    if j.platform not in {"portable", platform}:
                        records[key] = {"id": key, "status": "NOT_RUN", "terminal": True,
                                        "reason": "MAC_REQUIRED" if j.platform == "macos" else "LINUX_REQUIRED"}
                        del pending[key]
                        continue
                    if (len(running) >= budget.jobs or held.intersection(j.resources)
                            or used_cpu + j.cpu > budget.cpu or used_memory + j.memory_mib > budget.memory_mib):
                        continue
                    directory = output / key
                    directory.mkdir(mode=0o700)
                    if stop.is_set():
                        break
                    future = pool.submit(execute, j, directory, json.loads(json.dumps(source)))
                    running[future] = j
                    trace.append({"id": key, "event": "start", "seconds": time.monotonic() - started})
                    held.update(j.resources)
                    used_cpu += j.cpu
                    used_memory += j.memory_mib
                    del pending[key]
                if not running:
                    for key in sorted(pending):
                        records[key] = {"id": key, "status": "NOT_RUN", "terminal": True,
                                        "reason": "CANCELLED" if stop.is_set() else "DEPENDENCY_NOT_PASSED"}
                    break
                completed, _ = wait(running, timeout=0.1, return_when=FIRST_COMPLETED)
                for future in sorted(completed, key=lambda f: running[f].id):
                    j = running.pop(future)
                    try:
                        result = checked_outcome(j, future.result(), source)
                    except Exception as error:
                        result = {"id": j.id, "status": "UNKNOWN", "terminal": False,
                                  "reason": "EXECUTOR_EXCEPTION:" + type(error).__name__}
                    records[j.id] = result
                    trace.append({"id": j.id, "event": "observed", "status": result["status"], "seconds": time.monotonic() - started})
                    if result["status"] != "PASS":
                        halted = True
                    unconfirmed |= not result["terminal"]
        after = json.loads(json.dumps(identity(), allow_nan=False))
    except KeyboardInterrupt:
        stop.set()
        source_error = "INTERRUPTED; issued work drained before release"
    except Exception as error:
        source_error = type(error).__name__ + ":" + str(error)
    finally:
        # Admission or report I/O may fail after a sibling started. Observe every
        # original future even on that path before considering lease release.
        for future, j in list(running.items()):
            try:
                result = checked_outcome(j, future.result(), source)
            except Exception as error:
                result = {"id": j.id, "status": "UNKNOWN", "terminal": False,
                          "reason": "DRAIN_EXCEPTION:" + type(error).__name__}
            records[j.id] = result
            unconfirmed |= not result["terminal"]
            trace.append({"id": j.id, "event": "drained", "status": result["status"], "seconds": time.monotonic() - started})
        for j in jobs:
            records.setdefault(j.id, {"id": j.id, "status": "NOT_RUN", "terminal": True, "reason": "PREFLIGHT_OR_RUN_INCOMPLETE"})
        if not unconfirmed:
            try:
                lease.release()
            except Exception as error:
                release_error = type(error).__name__
                unconfirmed = True
    complete = all(r["status"] == "PASS" for r in records.values())
    status = ("UNKNOWN" if unconfirmed else "CANCELLED" if stop.is_set() else
              "FAIL" if source_error or source != after or any(r["status"] == "FAIL" for r in records.values()) else
              "BLOCKED" if any(r["status"] == "BLOCKED" for r in records.values()) else
              "PASS" if complete else "INCOMPLETE")
    report = {"schema": 1, "kind": "bounded-pilot-DAG-execution", "status": status,
              "acceptance": False, "sourceBefore": source, "sourceAfter": after,
              "sourceUnchanged": source is not None and source == after,
              "leaseRetained": unconfirmed, "leaseReleaseError": release_error, "sourceError": source_error,
              "cancellation": "DRAIN_ISSUED_WORK_NO_SIGNALS", "jobs": [records[k] for k in sorted(records)],
              "trace": trace, "wallSeconds": time.monotonic() - started,
              "limits": ["Writer-local lease only; no foreign-root resource ownership",
                         "Executors own exact command, case, artifact and teardown validation",
                         "No execution/acceptance authority follows from metadata or a graph alone"]}
    with (output / "report.json").open("x") as stream:
        json.dump(report, stream, indent=2, sort_keys=True)
        stream.write("\n")
    return report
