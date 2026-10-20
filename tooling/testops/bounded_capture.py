"""Observe an original child and drain pipes with a shared retained-byte budget.

This helper never signals, adopts or discovers processes. A deadline leaves the
same handle/pipes available to the enclosing private-container cleanup protocol.
"""
import os
import hashlib
import selectors
import stat
import subprocess
import time
from pathlib import Path

from deadline import CommandTimeout, usage_record


class CommandCancelled(Exception):
    pass


def read_physical_file(directory, relative, limit):
    """Bound generated evidence reads while pinning non-following descriptors."""
    relative = Path(relative)
    if (type(limit) is not int or limit <= 0 or relative.is_absolute() or not relative.parts
            or ".." in relative.parts or not directory.is_absolute()
            or directory.resolve(strict=True) != directory):
        raise ValueError("PHYSICAL_JOB_EVIDENCE_FILE_REQUIRED")
    descriptors = []
    try:
        descriptors.append(os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for piece in relative.parts[:-1]:
            descriptors.append(os.open(piece, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptors[-1]))
        fd = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptors[-1])
        descriptors.append(fd)
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("PHYSICAL_JOB_EVIDENCE_FILE_REQUIRED")
        if metadata.st_size > limit:
            raise ValueError("JOB_EVIDENCE_SIZE_LIMIT")
        with os.fdopen(os.dup(fd), "rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("JOB_EVIDENCE_SIZE_LIMIT")
        return data
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def validate_retained_log(stage, stream, file, limit):
    """Keep original write evidence even when its writable path is corrupted."""
    try:
        original = stage.get("retainedLogs", {}).get(stream, {})
        data = read_physical_file(file.parent, file.name, limit)
        if (type(original.get("bytesWritten")) is not int or original["bytesWritten"] != len(data)
                or original.get("writeSha256") != hashlib.sha256(data).hexdigest()):
            raise ValueError("ORIGINAL_RETAINED_LOG_MISMATCH")
    except (OSError, ValueError) as error:
        stage.setdefault("outputErrors", []).append(stream + ":FINAL:" + str(error))
        return False
    return True


def start_capture(command, cwd, stdout_path, stderr_path, stage, budget, env=None, cancelled=None):
    """Open fresh bounded logs; retain only the original child and its pipes."""
    stdout = stdout_path.open("xb")
    stderr = None
    try:
        stderr = stdout if stderr_path == stdout_path else stderr_path.open("xb")
        if cancelled is not None and cancelled():
            raise CommandCancelled("COMMAND_CANCELLED_BEFORE_ISSUANCE")
        child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return Capture(child, stdout, stderr, stage, budget)
    except Exception:
        stdout.close()
        if stderr is not None:
            stderr.close()
        raise


class OutputBudget:
    def __init__(self, limit):
        if type(limit) is not int or limit <= 0:
            raise ValueError("POSITIVE_OUTPUT_LIMIT_REQUIRED")
        self.remaining = limit
        self.limit = limit
        self.exceeded = False


class Capture:
    def __init__(self, child, stdout, stderr, stage, budget):
        self.child = child
        self.stage = stage
        self.budget = budget
        self.selector = selectors.DefaultSelector()
        self.logs = {"stdout": stdout, "stderr": stderr}
        self.hashes = {name: hashlib.sha256() for name in self.logs}
        # Merged stdout/stderr share one ordered write digest. Individual pipe
        # digests remain independent and are never reconstructed from log files.
        self.sink_hashes = {id(log): hashlib.sha256() for log in self.logs.values()}
        self.sink_bytes = {key: 0 for key in self.sink_hashes}
        stage["output"] = {name: {"observedBytes": 0, "retainedBytes": 0} for name in self.logs}
        stage["outputErrors"] = []
        stage["outputTruncated"] = False
        stage["stdioClosed"] = False
        for name in self.logs:
            pipe = getattr(child, name)
            os.set_blocking(pipe.fileno(), False)
            self.selector.register(pipe, selectors.EVENT_READ, name)

    def _drain(self, seconds):
        for event, _ in self.selector.select(seconds):
            pipe, name = event.fileobj, event.data
            try:
                chunk = os.read(pipe.fileno(), 65536)
            except BlockingIOError:
                continue
            except OSError as error:
                self.stage["outputErrors"].append(name + ":READ:" + type(error).__name__)
                chunk = b""
            if not chunk:
                self.selector.unregister(pipe)
                pipe.close()
                continue
            observed = self.stage["output"][name]
            self.hashes[name].update(chunk)
            observed["observedBytes"] += len(chunk)
            allowed = min(len(chunk), self.budget.remaining)
            if allowed < len(chunk):
                self.budget.exceeded = True
                self.stage["outputTruncated"] = True
            self.budget.remaining -= allowed
            if allowed and not self.stage["outputErrors"]:
                try:
                    written = self.logs[name].write(chunk[:allowed])
                    if type(written) is not int or not 0 <= written <= allowed:
                        raise OSError("INVALID_LOG_WRITE_COUNT")
                    observed["retainedBytes"] += written
                    key = id(self.logs[name])
                    self.sink_bytes[key] += written
                    self.sink_hashes[key].update(chunk[:written])
                    if written != allowed:
                        raise OSError("INCOMPLETE_LOG_WRITE")
                except OSError as error:
                    self.stage["outputErrors"].append(name + ":WRITE:" + type(error).__name__)
        self.stage["stdioClosed"] = not bool(self.selector.get_map())

    def wait(self, seconds):
        deadline = time.monotonic() + seconds
        while self.child.returncode is None or self.selector.get_map():
            if self.child.returncode is None:
                pid, status, usage = os.wait4(self.child.pid, os.WNOHANG)
                if pid:
                    self.child.returncode = os.waitstatus_to_exitcode(status)
                    self.stage.update(usage_record(pid, status, usage))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CommandTimeout("ORIGINAL_AFFECTED_CHILD_OR_STDIO_DEADLINE")
            self._drain(min(0.05, remaining))

    def finish_after_retirement(self):
        # The caller has already reconciled its private namespace. Preserve a
        # bounded tail, but never turn an initial timeout/unknown into PASS.
        deadline = time.monotonic() + 1
        while self.selector.get_map() and time.monotonic() < deadline:
            self._drain(0.05)

    def close(self):
        for name, digest in self.hashes.items():
            self.stage["output"][name]["observedSha256"] = digest.hexdigest()
        self.stage["retainedLogs"] = {
            name: {"bytesWritten": self.sink_bytes[id(log)], "writeSha256": self.sink_hashes[id(log)].hexdigest()}
            for name, log in self.logs.items()}
        for log in {id(log): log for log in self.logs.values()}.values():
            try:
                log.close()
            except OSError as error:
                self.stage["outputErrors"].append("CLOSE:" + type(error).__name__)
        if self.selector.get_map():
            self.stage["outputErrors"].append("ORIGINAL_STDIO_UNCONFIRMED")
        for event in list(self.selector.get_map().values()):
            self.selector.unregister(event.fileobj)
            event.fileobj.close()
        self.selector.close()
