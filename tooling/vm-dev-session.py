#!/usr/bin/env python3
"""One-shot Dev-app VM controller; stdout belongs exclusively to native MCP.

It reuses vm-machine's approved infrastructure and prepared-base contracts,
and vm_app_service.prepare_dev_session for accepted native payload publication.
It never opens a host product profile, reads keys, sends guest input or runs a
generic guest command. Every effect has a create-only private intent.

The controller removes what it creates. After a clean MCP close (exit 0 and
terminal-mac's own CLOSED terminal receipt), after a known refusal and after a
failure before the guest ran, it stops the guest it started and deletes the
clone it created. When an outcome is unknown, or when a teardown step cannot
be confirmed, it keeps exactly the VM, runtime, staging and evidence, records
why in result.json and prints the retained paths on stderr. Its own evidence
directory under vm-dev-sessions/ is always kept.

Exit status: 0 closed and removed; 1 refused with nothing retained beyond the
evidence directory; 2 something retained (outcome unknown or unconfirmed).
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
HEX64 = re.compile(r"[a-f0-9]{64}\Z")
RUN = re.compile(r"run-[a-f0-9]{32}\Z")
CLONE = re.compile(r"farol-qa-[a-f0-9]{16}\Z")
START_LIMIT = 180
CLONE_LIMIT = 1800
STOP_LIMIT = 180
STOPPED_LIMIT = 60
# terminal-mac mcp publishes this immutable record into
# machines/<clone>/mcp-app-sessions/<run>/terminal.json only after a clean EOF
# whose normal Quit and close were observed (both original exits, verified tree).
MCP_SESSION_CONTRACT = "terminal-mac.mcp-app-session/1"
SESSION_EVIDENCE_LIMIT = 256 * 1024
SESSION_EVIDENCE_FILES = 4096
SESSION_EVIDENCE_TOTAL = 16 * 1024 * 1024

# Codes after which an effect of THIS run may still be in flight or unobserved.
# Everything they touched is retained; nothing is stopped, deleted or replayed.
UNKNOWN_CODES = frozenset((
    "VM_DEV_CLONE_START_UNKNOWN", "VM_DEV_CLONE_OUTCOME_UNKNOWN",
    "VM_DEV_INSTANCE_RECEIPT_UNCONFIRMED", "VM_DEV_START_OUTCOME_UNKNOWN",
    "VM_DEV_RUNTIME_START_UNKNOWN", "VM_DEV_RUNTIME_NOT_READY",
    "VM_DEV_RUNTIME_IDENTITY_INVALID", "VM_DEV_MCP_OUTCOME_UNKNOWN",
    "VM_DEV_SESSION_CLOSE_UNPROVEN", "VM_DEV_CANCELLED", "VM_DEV_UNCLASSIFIED",
))


class VMDevError(Exception):
    """A closed, content-free diagnostics code with an optional safe detail.

    The detail carries only validated machine names and fixed guidance text,
    never tool output, exception messages or private paths.
    """
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code = code
        self.detail = detail


class Cancelled(BaseException):
    """SIGTERM/SIGHUP/SIGINT before the MCP handoff: stop before the next effect."""


def demand(condition, code):
    if not condition:
        raise VMDevError(code)


def module_from(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    demand(spec is not None and spec.loader is not None, "VM_DEV_MODULE_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_options(argv):
    demand(argv.count("--visible") <= 1 and argv.count("--config") <= 1,
           "VM_DEV_OPTIONS_INVALID")
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--artifact", required=True)
    args.add_argument("--receipt", required=True)
    args.add_argument("--expected-receipt-sha256", required=True)
    args.add_argument("--visible", action="store_true")
    args.add_argument("--config")
    a = args.parse_args(argv)
    demand(bool(HEX64.fullmatch(a.expected_receipt_sha256)), "VM_DEV_RECEIPT_INVALID")
    for value in (a.artifact, a.receipt):
        demand(Path(value).is_absolute() and "\0" not in value and
               str(Path(value)) == value, "VM_DEV_INPUT_PATH_INVALID")
    if a.config is not None:
        demand(Path(a.config).is_absolute() and "\0" not in a.config and
               str(Path(a.config)) == a.config, "VM_DEV_CONFIG_INVALID")
    return a


def identities():
    return "farol-qa-" + uuid.uuid4().hex[:16], "run-" + uuid.uuid4().hex


def _regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        demand(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
               before.st_uid == os.geteuid() and not before.st_mode & 0o077 and
               0 < before.st_size <= limit, "VM_DEV_INPUT_UNSAFE")
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        demand(len(data) == before.st_size and
               (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
               (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
               "VM_DEV_INPUT_CHANGED")
        return data


def preflight_inputs(args):
    raw = _regular(Path(args.receipt), 16384)
    demand(hashlib.sha256(raw).hexdigest() == args.expected_receipt_sha256,
           "VM_DEV_RECEIPT_CHANGED")
    try:
        receipt = json.loads(raw)
    except (ValueError, UnicodeError):
        raise VMDevError("VM_DEV_RECEIPT_INVALID") from None
    try:
        identity = module_from(HERE / "vm_dev_identity.py", "farol_vm_dev_identity").dev_identity()
    except ValueError:
        raise VMDevError("VM_DEV_IDENTITY_INVALID") from None
    demand(isinstance(receipt, dict) and
           receipt.get("schema") == "farol.vm-dev-artifact/1" and
           receipt.get("kind") == "local-dev-derivative" and
           receipt.get("environment") == "dev" and
           receipt.get("appName") == identity["appName"] and
           receipt.get("bundleId") == identity["bundleId"] and
           receipt.get("officialRelease") is False and
           receipt.get("hostLaunch") is False and
           receipt.get("profileImport") is False and
           isinstance(receipt.get("artifactSha256"), str) and
           bool(HEX64.fullmatch(receipt["artifactSha256"])),
           "VM_DEV_RECEIPT_INVALID")
    archive = Path(args.artifact)
    demand(archive.name == identity["archiveName"], "VM_DEV_ARCHIVE_INVALID")
    info = archive.lstat()
    demand(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
           info.st_nlink == 1 and not info.st_mode & 0o077 and
           0 < info.st_size <= 2 * 1024**3, "VM_DEV_ARCHIVE_UNSAFE")
    # This inexpensive pre-clone check is not acceptance of ZIP contents.
    # prepare_dev_session independently checks the full archive and policy.
    return receipt


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _private_directory(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        # Also sync on reentry: a prior failed sync must never become an
        # apparently admitted directory merely because its entry is visible.
        _sync_directory(path.parent)
    info = path.lstat()
    demand(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and
           info.st_uid == os.geteuid() and not info.st_mode & 0o077,
           "VM_DEV_DIRECTORY_UNSAFE")
    return path


def _write_once(directory, leaf, document):
    demand(re.fullmatch(r"[a-z][a-z0-9_-]{0,80}\.json", leaf) is not None,
           "VM_DEV_EVIDENCE_UNSAFE")
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        fd = os.open(leaf, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=descriptor)
        with os.fdopen(fd, "wb") as output:
            data = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()
            demand(len(data) <= 16384, "VM_DEV_EVIDENCE_OVERSIZE")
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _receipt(directory, step, operation, status, **values):
    _write_once(directory, step + "-receipt.json",
                dict(schema="farol.vm-dev-operation/1", operationId=operation,
                     status=status, **values))


def _intent(directory, step, operation, **values):
    _write_once(directory, step + "-intent.json",
                dict(schema="farol.vm-dev-operation/1", operationId=operation,
                     kind=step, publication="intent-before-effect", **values))


def _one_clone(command, evidence, terminal, env, run):
    operation = str(uuid.uuid4())
    _intent(evidence, "clone", operation, runId=run, instance=command[3], base=command[2])
    try:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                 stdout=sys.stderr, stderr=sys.stderr, env=env,
                                 start_new_session=True)
    except OSError:
        # Popen failure is not proof of guest/clone absence.
        raise VMDevError("VM_DEV_CLONE_START_UNKNOWN") from None
    try:
        result = child.wait(timeout=CLONE_LIMIT)
    except subprocess.TimeoutExpired:
        raise VMDevError("VM_DEV_CLONE_OUTCOME_UNKNOWN") from None
    if result != 0:
        raise VMDevError("VM_DEV_CLONE_OUTCOME_UNKNOWN")
    _receipt(evidence, "clone", operation, "exited-zero",
             pid=child.pid, exitCode=result, descendantCleanup="unverified")
    return child.pid


def _stage_path(machine, run):
    _private_directory(machine)
    artifacts = machine / "artifacts"
    _private_directory(artifacts, create=True)
    fd = os.open(artifacts, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.mkdir(run, mode=0o700, dir_fd=fd)
        os.fsync(fd)
    finally:
        os.close(fd)
    stage = artifacts / run
    _private_directory(stage)
    return stage


def _stage(stage, args, evidence, selected, producer):
    operation = str(uuid.uuid4())
    _intent(evidence, "stage", operation, runId=stage.name,
            expectedReceiptSHA256=args.expected_receipt_sha256,
            artifactSHA256=selected["artifactSha256"])
    try:
        result = producer(Path(args.artifact), Path(args.receipt),
                          args.expected_receipt_sha256, stage)
    except Exception:
        # Staging is not a guest effect, but publication can be partial/unknown:
        # preserve every blob and its original intent for a separate inspection.
        raise VMDevError("VM_DEV_STAGING_UNCONFIRMED") from None
    demand(isinstance(result, dict) and
           set(result) == {"runId", "manifestSHA256", "acceptanceSHA256", "artifactSHA256"} and
           result["runId"] == stage.name and
           all(isinstance(result[k], str) and bool(HEX64.fullmatch(result[k]))
               for k in ("manifestSHA256", "acceptanceSHA256", "artifactSHA256")) and
           result["artifactSHA256"] == selected["artifactSha256"],
           "VM_DEV_STAGING_UNCONFIRMED")
    _receipt(evidence, "stage", operation, "published",
             runId=result["runId"], manifestSHA256=result["manifestSHA256"],
             acceptanceSHA256=result["acceptanceSHA256"],
             artifactSHA256=result["artifactSHA256"])
    return result


def _host_status(binary, clone, env):
    # Every poll uses a NEW read-only status request; never repeats start.
    try:
        status = subprocess.run([str(binary), "status", clone],
                                stdin=subprocess.DEVNULL, capture_output=True,
                                env=env, timeout=8, check=False)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if status.returncode != 0 or len(status.stdout) > 8192:
        return None
    try:
        value = json.loads(status.stdout)
    except (UnicodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _capacity(binary, root, env):
    """Read-only store census before allocating another clone; no auto-stop.

    This host rejected its third active macOS VM. Other stores and concurrent
    starts remain outside this preflight; the native start is authoritative.
    """
    active = 0
    for entry in sorted((root / "machines").iterdir()):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", entry.name):
            continue
        if not entry.is_dir() or entry.is_symlink():
            raise VMDevError("VM_DEV_CAPACITY_UNKNOWN", _capacity_guidance(entry.name, "not-a-directory"))
        value = _host_status(binary, entry.name, env)
        state = value.get("state") if isinstance(value, dict) else None
        if not (value is not None and value.get("name") == entry.name and
                state in ("running", "stopped", "stopping", "paused", "starting",
                          "stopping-awaiting-guest-confirmation")):
            # One leftover partial clone or an "error" VM blocks every later
            # capacity census. Name it and the manual resolution; never delete.
            observed = state if isinstance(state, str) and re.fullmatch(r"[a-z-]{1,48}", state) else "unreadable"
            raise VMDevError("VM_DEV_CAPACITY_UNKNOWN", _capacity_guidance(entry.name, observed))
        active += state != "stopped"
    demand(active < 2, "VM_DEV_CAPACITY_BUSY")
    return active


def _capacity_guidance(name, state):
    return ("machine=%s state=%s; resolve manually: inspect `terminal-mac status %s` and its "
            "vm-dev-sessions/%s evidence, reconcile any unknown outcome, then stop it or remove "
            "the partial clone by hand. The controller never stops or deletes another machine."
            % (name, state, name, name))


def _one_start(binary, clone, visible, evidence, env):
    command = [str(binary), "start", clone] + (["--window"] if visible else [])
    operation = str(uuid.uuid4())
    _intent(evidence, "start", operation, instance=clone, visible=visible)
    try:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                 stdout=sys.stderr, stderr=sys.stderr, env=env,
                                 start_new_session=True)
    except OSError:
        raise VMDevError("VM_DEV_START_OUTCOME_UNKNOWN") from None
    started_at = time.monotonic()
    while time.monotonic() - started_at < START_LIMIT:
        # start is a launcher: exit 0 hands ownership to a detached runtime.
        # A fresh status attests that runtime; the launcher's PID never does.
        launcher_exit = child.poll()
        if launcher_exit is not None and launcher_exit != 0:
            raise VMDevError("VM_DEV_START_OUTCOME_UNKNOWN")
        value = _host_status(binary, clone, env)
        if value is not None:
            if value.get("state") == "running":
                runtime_pid = value.get("pid")
                demand(value.get("name") == clone and isinstance(runtime_pid, str) and
                       bool(re.fullmatch(r"[1-9][0-9]{0,9}", runtime_pid)) and
                       int(runtime_pid) > 1 and int(runtime_pid) != child.pid,
                       "VM_DEV_RUNTIME_IDENTITY_INVALID")
                if not (value.get("artifactShareReadOnly") == "true" and
                        value.get("artifactShareEvidence") == "live-vz-configuration/1"):
                    # The runtime IS attested running; only its grants are wrong.
                    # A known refusal: the caller stops this guest it started.
                    error = VMDevError("VM_DEV_HOST_GRANTS_INVALID")
                    error.running = True
                    raise error
                _receipt(evidence, "start", operation, "running-attested",
                         launcherPID=child.pid, launcherExit=launcher_exit,
                         runtimePID=int(runtime_pid), instance=clone,
                         hostVZReadOnly=True, descendantCleanup="unverified")
                return int(runtime_pid)
            if value.get("state") in ("stopping", "stopping-awaiting-guest-confirmation",
                                      "paused", "error"):
                raise VMDevError("VM_DEV_RUNTIME_NOT_READY")
        time.sleep(1)
    raise VMDevError("VM_DEV_RUNTIME_START_UNKNOWN")


HELPER_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,95}\Z")


def base_helper_identity(base_receipt):
    """The helper version/build the operator recorded for the prepared base.

    Base receipts are written by the operator procedure, not by this
    repository. Older receipts lack these fields: they stay unbound (recorded
    as such), never guessed. A present but malformed value is refused.
    """
    try:
        receipt = json.loads(base_receipt)
    except (ValueError, UnicodeError):
        raise VMDevError("VM_DEV_BASE_NOT_READY") from None
    expected = {}
    for key in ("helperVersion", "helperBuild"):
        if key in receipt:
            value = receipt[key]
            demand(isinstance(value, str) and bool(HELPER_TOKEN.fullmatch(value)),
                   "VM_DEV_BASE_NOT_READY")
            expected[key] = value
    return expected


def _guest_grants(binary, clone, evidence, env, expected=None):
    """Bounded READ-only helper startup check, never guest input or replay.

    When the base receipt records the helper version/build, the live helper of
    this clone must report exactly that identity: a rebuilt or reinstalled
    helper in the base (which voids its privacy grants) is a known refusal.
    """
    expected = expected or {}
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            result = subprocess.run(
                [str(binary), "action", "--vm", clone, "status", "--timeout", "5"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=env, timeout=9, check=False)
        except (subprocess.TimeoutExpired, OSError):
            result = None
        if result is not None and result.returncode == 0 and len(result.stdout) <= 8192:
            try:
                values = json.loads(result.stdout)
            except (ValueError, UnicodeError):
                values = None
            if isinstance(values, dict):
                # Admission is repeated inside the LIVE MCP under its lease.
                # This preflight never declares application READY.
                demand(values.get("appServiceContract") == "terminal-mac.app-service/4" and
                       values.get("appServiceExecutor") == "compiled-native-helper" and
                       values.get("appServiceLaunchIdentityContract") == "terminal-mac.launch-identity/1",
                       "VM_DEV_HELPER_INCOMPATIBLE")
                demand(values.get("appServiceAdmission") == "available",
                       "VM_DEV_HELPER_CUSTODY_UNRESOLVED")
                demand(values.get("accessibility") == "true" and
                       values.get("screenRecording") == "true",
                       "VM_DEV_NEEDS_OWNER_PERMISSIONS")
                observed = {key: values.get(field) for key, field in
                            (("helperVersion", "version"), ("helperBuild", "build"))}
                demand(all(observed[key] == value for key, value in expected.items()),
                       "VM_DEV_HELPER_BUILD_MISMATCH")
                _write_once(evidence, "helper-preflight.json", {
                    "schema": "farol.vm-dev-helper-preflight/1",
                    "state": "AVAILABLE_NOT_APP_READY",
                    "appServiceContract": "terminal-mac.app-service/4",
                    "launchIdentityContract": "terminal-mac.launch-identity/1",
                    "permissions": "guest-true",
                    "helperIdentity": {key: value if isinstance(value, str) and
                                       HELPER_TOKEN.fullmatch(value) else None
                                       for key, value in observed.items()},
                    "baseHelperBinding": ("bound:" + ",".join(sorted(expected))
                                          if expected else "unbound-base-receipt"),
                    "guestDiskBinding": "unbound-no-disk-identity-in-receipt"
                })
                return
        time.sleep(1)
    raise VMDevError("VM_DEV_NEEDS_OWNER_HELPER_UNAVAILABLE")


class _SignalGate:
    """Owns SIGTERM/SIGHUP/SIGINT for the controller's lifetime.

    Before the MCP handoff a signal raises Cancelled: the controller stops
    before its next effect and retains whatever exists. While the MCP child
    owns stdio, SIGTERM and SIGHUP are forwarded to it (SIGINT already reaches
    it through the shared process group). During teardown a signal is only
    recorded: no further stop or delete starts, and everything is retained.
    """
    SIGNALS = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)

    def __init__(self):
        self.mode = "before-mcp"
        self.child = None
        self.requested = None
        self.previous = {}

    def install(self):
        for number in self.SIGNALS:
            self.previous[number] = signal.signal(number, self.handle)
        return self

    def restore(self):
        for number, handler in self.previous.items():
            signal.signal(number, handler)
        self.previous = {}

    def handle(self, number, _frame):
        self.requested = self.requested or number
        if self.mode == "before-mcp":
            raise Cancelled()
        if self.mode == "mcp" and self.child is not None and number != signal.SIGINT:
            try:
                self.child.send_signal(number)
            except OSError:
                pass


def _run_mcp(binary, root, clone, stage, session, evidence, env, gate=None):
    """Run terminal-mac mcp with the agent's stdin/stdout inherited unchanged.

    The child inherits file descriptors 0 and 1 directly: no Python stream or
    pipe sits between the agent and terminal-mac's stdio owner, and this
    process never writes stdout. The child takes the ONE input lease and owns
    it through EOF. Its exit status is recorded once; it is never restarted.
    """
    operation = str(uuid.uuid4())
    _intent(evidence, "mcp", operation, instance=clone, runId=session["runId"],
            manifestSHA256=session["manifestSHA256"],
            acceptanceSHA256=session["acceptanceSHA256"])
    _write_once(evidence, "handoff.json", {
        "schema": "farol.vm-dev-mcp-handoff/1",
        "operationId": operation, "status": "mcp-pending",
        "runId": session["runId"], "instance": clone,
        "manifestSHA256": session["manifestSHA256"],
        "acceptanceSHA256": session["acceptanceSHA256"],
        "mcpOwner": "created-by-terminal-mac-mcp-only",
        "stdout": "mcp-jsonrpc-only"
    })
    executable = str(binary)
    argv = [executable, "mcp", clone, "--app-run", session["runId"],
            "--app-manifest", session["manifestSHA256"],
            "--app-acceptance", session["acceptanceSHA256"]]
    child_env = dict(env, TERMINAL_MAC_HOME=str(root))
    try:
        # stdin/stdout/stderr None: inherit the controller's descriptors.
        child = subprocess.Popen(argv, executable=executable, env=child_env)
    except OSError:
        # Nothing ran: a known no-effect refusal, cleaned up like any other.
        raise VMDevError("VM_DEV_MCP_SPAWN_REFUSED") from None
    if gate is not None:
        gate.child = child
        gate.mode = "mcp"
    # This process never writes stdout; release its copy so only the MCP
    # child holds the agent's stdout descriptor.
    try:
        devnull = os.open(os.devnull, os.O_WRONLY | os.O_CLOEXEC)
        try:
            os.dup2(devnull, 1)
        finally:
            os.close(devnull)
    except OSError:
        pass
    while True:
        try:
            status = child.wait()
            break
        except InterruptedError:
            continue
    if gate is not None:
        gate.mode = "teardown"
        gate.child = None
    _receipt(evidence, "mcp", operation, "exited",
             exitCode=status if status >= 0 else None,
             signal=-status if status < 0 else None)
    return status


def _closed_session(root, clone, run):
    """terminal-mac's immutable clean-close record for THIS run, or None."""
    directory = root / "machines" / clone / "mcp-app-sessions" / run
    try:
        for path in (directory.parent, directory):
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
                return None
        value = json.loads(_regular(directory / "terminal.json", 16384))
    except (OSError, ValueError, UnicodeError, VMDevError):
        return None
    if (isinstance(value, dict) and value.get("schema") == MCP_SESSION_CONTRACT and
            value.get("state") == "CLOSED" and value.get("runID") == run and
            value.get("rootExit") == "observed" and value.get("uiPrimaryExit") == "observed" and
            value.get("installationEvidence") == "verified-at-close"):
        return value
    return None


def _preserve_session_evidence(root, clone, run, evidence):
    """Copy terminal-mac's own session records for THIS run before the clone
    is deleted. Bounded regular files only; links and special files are not
    followed and fail the copy, which then retains the clone instead."""
    source = root / "machines" / clone / "mcp-app-sessions" / run
    try:
        info = source.lstat()
    except FileNotFoundError:
        return 0
    demand(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid(),
           "VM_DEV_SESSION_EVIDENCE_UNSAFE")
    target = evidence / "terminal-mac-session"
    target.mkdir(mode=0o700)
    _sync_directory(evidence)
    names = sorted(entry.name for entry in os.scandir(source))
    demand(len(names) <= SESSION_EVIDENCE_FILES, "VM_DEV_SESSION_EVIDENCE_UNSAFE")
    total = 0
    for name in names:
        demand(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", name) is not None,
               "VM_DEV_SESSION_EVIDENCE_UNSAFE")
        data = _session_file(source / name)
        total += len(data)
        demand(total <= SESSION_EVIDENCE_TOTAL, "VM_DEV_SESSION_EVIDENCE_UNSAFE")
        fd = os.open(target / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    _sync_directory(target)
    return len(names)


def _session_file(path):
    """A terminal-mac session record: owned single-link regular file, possibly
    empty (a lock), never followed through a link, read exactly once."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        raise VMDevError("VM_DEV_SESSION_EVIDENCE_UNSAFE") from None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        demand(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
               info.st_uid == os.geteuid() and info.st_size <= SESSION_EVIDENCE_LIMIT,
               "VM_DEV_SESSION_EVIDENCE_UNSAFE")
        data = stream.read(SESSION_EVIDENCE_LIMIT + 1)
    demand(len(data) == info.st_size, "VM_DEV_SESSION_EVIDENCE_UNSAFE")
    return data


def _one_stop(binary, clone, evidence, env):
    """Stop ONLY the guest this run started, once; never --force, never retried."""
    operation = str(uuid.uuid4())
    _intent(evidence, "stop", operation, instance=clone)
    try:
        child = subprocess.Popen([str(binary), "stop", clone, "--confirm-guest-dialog"],
                                 stdin=subprocess.DEVNULL, stdout=sys.stderr,
                                 stderr=sys.stderr, env=env, start_new_session=True)
    except OSError:
        raise VMDevError("VM_DEV_STOP_OUTCOME_UNKNOWN") from None
    try:
        result = child.wait(timeout=STOP_LIMIT)
    except subprocess.TimeoutExpired:
        raise VMDevError("VM_DEV_STOP_OUTCOME_UNKNOWN") from None
    if result != 0:
        raise VMDevError("VM_DEV_STOP_OUTCOME_UNKNOWN")
    _require_stopped(binary, clone, env, STOPPED_LIMIT)
    _receipt(evidence, "stop", operation, "stopped-attested", instance=clone, exitCode=result)


def _require_stopped(binary, clone, env, seconds):
    deadline = time.monotonic() + seconds
    while True:
        value = _host_status(binary, clone, env)
        if value is not None and value.get("name") == clone and value.get("state") == "stopped":
            return
        if time.monotonic() >= deadline:
            raise VMDevError("VM_DEV_STOP_UNCONFIRMED")
        time.sleep(1)


def _delete_clone(binary, root, clone, base, instance_receipt, instance_digest, evidence, env):
    """Remove the stopped clone THIS run created; terminal-mac has no delete.

    Positive identification only: the clone name grammar (never a base), this
    run's own instance receipt with the digest recorded when it was written,
    terminal-mac's clone record naming this base, a physical owned directory
    directly inside the machines root, and a fresh `stopped` status.
    """
    demand(bool(CLONE.fullmatch(clone)) and not clone.startswith("farol-base-") and clone != base,
           "VM_DEV_CLONE_DELETE_REFUSED")
    raw = _regular(instance_receipt, 65536)
    demand(hashlib.sha256(raw).hexdigest() == instance_digest, "VM_DEV_CLONE_DELETE_REFUSED")
    receipt = json.loads(raw)
    clone_record = receipt.get("cloneReceipt") if isinstance(receipt, dict) else None
    demand(isinstance(receipt, dict) and receipt.get("schema") == "farol.vm-instance/1" and
           receipt.get("name") == clone and receipt.get("base") == base and
           isinstance(clone_record, dict) and clone_record.get("to") == clone and
           clone_record.get("from", base) == base,
           "VM_DEV_CLONE_DELETE_REFUSED")
    machines = root / "machines"
    machine = machines / clone
    for path in (machines, machine):
        info = path.lstat()
        demand(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and
               info.st_uid == os.geteuid() and path.resolve(strict=True) == path,
               "VM_DEV_CLONE_DELETE_REFUSED")
    demand(machine.parent == machines and machine.name == clone, "VM_DEV_CLONE_DELETE_REFUSED")
    _require_stopped(binary, clone, env, 0)
    operation = str(uuid.uuid4())
    _intent(evidence, "delete", operation, instance=clone, base=base)
    try:
        shutil.rmtree(machine)  # does not follow links inside the clone
        _sync_directory(machines)
    except OSError:
        raise VMDevError("VM_DEV_CLONE_DELETE_UNCONFIRMED") from None
    _receipt(evidence, "delete", operation, "removed", instance=clone)


class _Custody:
    """What this run created, as far as it has positively confirmed."""
    def __init__(self):
        self.clone = None
        self.base = None
        self.evidence = None
        self.instance_receipt = None
        self.instance_digest = None
        self.created = False      # clone exit 0 and own instance receipt written
        self.started = False      # start dispatched (attested or not)
        self.running = False      # start attested by a fresh runtime status
        self.run = None
        self.binary = self.root = self.env = None


def _teardown(custody, error, binary, root, env, gate):
    """Remove what this run created unless an outcome is unknown.

    Returns (status, removed, retained, reason). Never raises.
    """
    removed, retained = [], []
    machine = root / "machines" / custody.clone if custody.clone else None
    reason = error.code if error is not None else None
    present = machine is not None and (machine.exists() or machine.is_symlink())
    if error is not None and error.code in UNKNOWN_CODES:
        # An unknown effect may still be in flight (a clone or start launcher
        # is never killed): retain whatever exists and touch nothing.
        if present:
            retained.append(str(machine))
        return "RETAINED", removed, retained, reason
    if not present:
        return ("CLOSED_AND_REMOVED" if error is None else "REFUSED_AND_REMOVED"), removed, retained, reason
    if not custody.created or (custody.started and not custody.running):
        retained.append(str(machine))
        return "RETAINED", removed, retained, reason or "VM_DEV_CLONE_UNCONFIRMED"
    try:
        if gate is not None and gate.requested:
            raise VMDevError("VM_DEV_TEARDOWN_CANCELLED")
        if custody.running:
            _one_stop(binary, custody.clone, custody.evidence, env)
        if gate is not None and gate.requested:
            raise VMDevError("VM_DEV_TEARDOWN_CANCELLED")
        _preserve_session_evidence(root, custody.clone, custody.run, custody.evidence)
        _delete_clone(binary, root, custody.clone, custody.base, custody.instance_receipt,
                      custody.instance_digest, custody.evidence, env)
    except VMDevError as failure:
        retained.append(str(machine))
        return "RETAINED", removed, retained, (reason + "+" if reason else "") + failure.code
    except Exception:
        retained.append(str(machine))
        return "RETAINED", removed, retained, (reason + "+" if reason else "") + "VM_DEV_TEARDOWN_UNCLASSIFIED"
    removed.append(str(machine))
    return ("CLOSED_AND_REMOVED" if error is None else "REFUSED_AND_REMOVED"), removed, retained, reason


def execute(args, infrastructure=None, plan=None, producer=None,
            clone_effect=None, start_effect=None, mcp_effect=None,
            identity_factory=None, binary_admission=None, capacity_probe=None,
            gate=None):
    """Run one session and tear down what it created.

    Returns the result record; raises VMDevError (with .result attached when
    a session record exists) for every refusal or unknown outcome.
    """
    custody = _Custody()
    error = None
    try:
        _session(args, custody, infrastructure, plan, producer, clone_effect,
                                     start_effect, mcp_effect, identity_factory,
                                     binary_admission, capacity_probe, gate)
    except VMDevError as failure:
        error = failure
    except Cancelled:
        error = VMDevError("VM_DEV_CANCELLED")
    except Exception:
        error = VMDevError("VM_DEV_UNCLASSIFIED")
    if custody.evidence is None:
        if error is not None:
            raise error
        raise VMDevError("VM_DEV_UNCLASSIFIED")
    if gate is not None:
        gate.mode = "teardown"
    status, removed, retained, reason = _teardown(custody, error, custody.binary, custody.root,
                                                  custody.env, gate)
    retained.append(str(custody.evidence))
    result = {"schema": "farol.vm-dev-result/1", "status": status,
              "instance": custody.clone, "runId": custody.run,
              "code": reason, "outcome": ("clean" if error is None else
                                          "unknown" if error.code in UNKNOWN_CODES else "known-refusal"),
              "removed": removed, "retained": retained}
    try:
        _write_once(custody.evidence, "result.json", result)
    except Exception:
        result["status"] = "RETAINED"
        result["resultRecord"] = "unconfirmed"
    if error is None and status == "CLOSED_AND_REMOVED":
        return result
    final = error if error is not None else VMDevError(reason or "VM_DEV_UNCLASSIFIED")
    if status == "RETAINED" and final.code not in UNKNOWN_CODES:
        final = VMDevError(reason or final.code, final.detail)
    final.result = result
    raise final


def _session(args, custody, infrastructure, plan, producer, clone_effect, start_effect,
             mcp_effect, identity_factory, binary_admission, capacity_probe, gate):
    if args.config is not None:
        os.environ["FAROL_VM_CONFIG"] = args.config
    # Production dependencies: ONLY existing task-owned VM contract and
    # accepted local-Dev producer. A missing producer is a BLOCKED prerequisite,
    # never replaced by ad-hoc extraction or a fallback to stable ZIP.
    machine = module_from(HERE / "vm-machine.py", "farol_vm_dev_machine")
    application = module_from(HERE / "vm_app_service.py", "farol_vm_dev_producer")
    producer = producer if producer is not None else getattr(application, "prepare_dev_session", None)
    demand(callable(producer), "VM_DEV_PRODUCER_UNAVAILABLE")
    infrastructure = infrastructure or machine.infrastructure
    plan = plan or machine.plan_instance
    selected = preflight_inputs(args)
    try:
        binary, root, settings = infrastructure()
    except (ValueError, OSError, KeyError, TypeError):
        # The existing configuration resolver is the sole authority. Never
        # print its raw exception, private config filename or unknown values.
        raise VMDevError("VM_DEV_CONFIG_INVALID") from None
    try:
        base = machine.prepared_base(settings)
    except (ValueError, OSError, TypeError):
        raise VMDevError("VM_DEV_CONFIG_INVALID") from None
    admission = binary_admission or (lambda p: p.is_file() and os.access(p, os.X_OK))
    demand(admission(binary), "VM_DEV_TERMINAL_MAC_UNAVAILABLE")
    _private_directory(root)
    _private_directory(root / "machines")
    _private_directory(settings)
    env = {key: os.environ[key] for key in ("HOME", "USER", "TMPDIR") if key in os.environ}
    env.update(PATH="/usr/bin:/bin:/usr/sbin:/sbin", TERMINAL_MAC_HOME=str(root))
    (capacity_probe or _capacity)(binary, root, env)
    clone, run = (identity_factory or identities)()
    demand(CLONE.fullmatch(clone) and RUN.fullmatch(run), "VM_DEV_IDENTITY_INVALID")
    try:
        command, base_receipt, instance_receipt = plan(
            clone, base, binary, root, settings, offline=False)
    except ValueError as error:
        code = str(error)
        if code in ("INSTANCE_COLLISION_REFUSED", "INSTANCE_IDENTITY_INVALID"):
            raise VMDevError("VM_DEV_PREDECESSOR_COLLISION") from None
        if code in ("BASE_RECEIPT_MISSING", "BASE_RECEIPT_INVALID",
                    "OWNER_BASE_NOT_READY", "BASE_MACHINE_MISSING"):
            raise VMDevError("VM_DEV_BASE_NOT_READY") from None
        raise VMDevError("VM_DEV_INSTANCE_PLAN_BLOCKED") from None
    except (OSError, TypeError):
        raise VMDevError("VM_DEV_INSTANCE_PLAN_BLOCKED") from None
    demand(command == [str(binary), "clone", base, clone] and
           not instance_receipt.exists() and not instance_receipt.is_symlink() and
           not (root / "machines" / clone).exists() and
           not (root / "machines" / clone).is_symlink(),
           "VM_DEV_PREDECESSOR_COLLISION")
    # Refuse a malformed recorded helper identity before any effect.
    helper_identity = base_helper_identity(base_receipt)
    _private_directory(settings / "vm-dev-sessions", create=True)
    evidence = settings / "vm-dev-sessions" / clone
    evidence.mkdir(mode=0o700)
    _sync_directory(evidence.parent)
    _private_directory(evidence)
    custody.evidence, custody.clone, custody.base, custody.run = evidence, clone, base, run
    custody.binary, custody.root, custody.env = binary, root, env
    custody.instance_receipt = instance_receipt
    _write_once(evidence, "selection.json", {
        "schema": "farol.vm-dev-selection/1",
        "runId": run, "instance": clone, "base": base,
        "baseReceiptSHA256": hashlib.sha256(base_receipt).hexdigest(),
        "acceptedReceiptSHA256": args.expected_receipt_sha256,
        "acceptedArtifactSHA256": selected["artifactSha256"],
        "network": "base-network-unmodified",
        "visible": args.visible
    })
    # A clone is an effect and is never retried/repaired after a lost terminal.
    (clone_effect or _one_clone)(command, evidence, binary, env, run)
    # Existing task machine provenance (same contract as vm:setup).
    try:
        machine.write_instance_receipt(instance_receipt, clone, base, base_receipt, root)
        custody.instance_digest = hashlib.sha256(_regular(instance_receipt, 65536)).hexdigest()
    except Exception:
        raise VMDevError("VM_DEV_INSTANCE_RECEIPT_UNCONFIRMED") from None
    custody.created = True
    stage = _stage_path(root / "machines" / clone, run)
    payload = _stage(stage, args, evidence, selected, producer)
    _write_once(evidence, "payload.json", {
        "schema": "farol.vm-dev-accepted-stage/1", "runId": run,
        "manifestSHA256": payload["manifestSHA256"],
        "acceptanceSHA256": payload["acceptanceSHA256"],
        "artifactSHA256": payload["artifactSHA256"]
    })
    custody.started = True
    try:
        (start_effect or _one_start)(binary, clone, args.visible, evidence, env)
    except VMDevError as error:
        custody.running = getattr(error, "running", False)
        raise
    custody.running = True
    # Do not start the application session against a legacy/absent helper.
    # The native MCP repeats all prerequisites under its actual InputLease.
    _guest_grants(binary, clone, evidence, env, helper_identity)
    status = (mcp_effect or _run_mcp)(binary, root, clone, stage, payload, evidence, env, gate)
    if status != 0:
        raise VMDevError("VM_DEV_MCP_OUTCOME_UNKNOWN")
    if _closed_session(root, clone, run) is None:
        raise VMDevError("VM_DEV_SESSION_CLOSE_UNPROVEN")


def main(argv=None):
    args = parse_options(sys.argv[1:] if argv is None else argv)
    gate = _SignalGate().install()
    try:
        execute(args, gate=gate)
    except VMDevError as error:
        # stdout belongs only to the MCP. Diagnostics carry closed codes, a
        # validated detail and, when something is kept, the retained paths.
        print(error.code + (" " + error.detail if error.detail else ""), file=sys.stderr, flush=True)
        result = getattr(error, "result", None)
        if result is None:
            return 2 if error.code in UNKNOWN_CODES else 1
        for path in result.get("retained", []):
            print("VM_DEV_RETAINED " + path, file=sys.stderr, flush=True)
        return 2 if result.get("status") == "RETAINED" else 1
    except (Exception, Cancelled):
        print("VM_DEV_UNCLASSIFIED", file=sys.stderr, flush=True)
        return 2
    finally:
        gate.restore()
    return 0


if __name__ == "__main__":
    sys.exit(main())
