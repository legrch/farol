#!/usr/bin/env python3
"""One-shot Dev-app VM controller; stdout belongs exclusively to native MCP.

It reuses vm-machine's approved infrastructure and prepared-base contracts,
and vm_app_service.prepare_dev_session for accepted native payload publication.
It never opens a host product profile, reads keys, sends guest input or runs a
generic guest command. Every effect has a create-only private intent. On an
unknown effect, it leaves the VM, runtime, staging and evidence untouched.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
HEX64 = re.compile(r"[a-f0-9]{64}\Z")
RUN = re.compile(r"run-[a-f0-9]{32}\Z")
CLONE = re.compile(r"farol-qa-[a-f0-9]{16}\Z")
BASE = "farol-base-1"
START_LIMIT = 180
CLONE_LIMIT = 1800


class VMDevError(Exception):
    """A closed, content-free diagnostics code."""
    pass


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


def _private_directory(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
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
        demand(entry.is_dir() and not entry.is_symlink(), "VM_DEV_CAPACITY_UNKNOWN")
        value = _host_status(binary, entry.name, env)
        demand(value is not None and value.get("name") == entry.name and
               value.get("state") in ("running", "stopped", "stopping", "paused", "starting"),
               "VM_DEV_CAPACITY_UNKNOWN")
        active += value["state"] != "stopped"
    demand(active < 2, "VM_DEV_CAPACITY_BUSY")
    return active


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
                demand(value.get("name") == clone and
                       value.get("artifactShareReadOnly") == "true" and
                       value.get("artifactShareEvidence") == "live-vz-configuration/1",
                       "VM_DEV_HOST_GRANTS_INVALID")
                runtime_pid = value.get("pid")
                demand(isinstance(runtime_pid, str) and
                       bool(re.fullmatch(r"[1-9][0-9]{0,9}", runtime_pid)) and
                       int(runtime_pid) > 1 and int(runtime_pid) != child.pid,
                       "VM_DEV_RUNTIME_IDENTITY_INVALID")
                _receipt(evidence, "start", operation, "running-attested",
                         launcherPID=child.pid, launcherExit=launcher_exit,
                         runtimePID=int(runtime_pid), instance=clone,
                         hostVZReadOnly=True, descendantCleanup="unverified")
                return int(runtime_pid)
            if value.get("state") in ("stopping", "paused", "error"):
                raise VMDevError("VM_DEV_RUNTIME_NOT_READY")
        time.sleep(1)
    raise VMDevError("VM_DEV_RUNTIME_START_UNKNOWN")


def _guest_grants(binary, clone, evidence, env):
    """Bounded READ-only helper startup check, never guest input or replay."""
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
                _write_once(evidence, "helper-preflight.json", {
                    "schema": "farol.vm-dev-helper-preflight/1",
                    "state": "AVAILABLE_NOT_APP_READY",
                    "appServiceContract": "terminal-mac.app-service/4",
                    "launchIdentityContract": "terminal-mac.launch-identity/1",
                    "permissions": "guest-true"
                })
                return
        time.sleep(1)
    raise VMDevError("VM_DEV_NEEDS_OWNER_HELPER_UNAVAILABLE")


def _exec_mcp(binary, root, clone, stage, session, evidence, env):
    operation = str(uuid.uuid4())
    _intent(evidence, "mcp", operation, instance=clone, runId=session["runId"],
            manifestSHA256=session["manifestSHA256"],
            acceptanceSHA256=session["acceptanceSHA256"])
    # Publication of controller handoff precedes exec. The single native MCP
    # process takes the ONE InputLease on this VM and owns it through EOF.
    _write_once(evidence, "handoff.json", {
        "schema": "farol.vm-dev-mcp-handoff/1",
        "operationId": operation, "status": "exec-pending",
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
    # Keep stdin and stdout exactly inherited. Do not pass a Python stream or
    # pipe between the agent and terminal-mac's stdio owner.
    child_env = dict(env, TERMINAL_MAC_HOME=str(root))
    os.execve(executable, argv, child_env)


def execute(args, infrastructure=None, plan=None, producer=None,
            clone_effect=None, start_effect=None, exec_effect=None,
            identity_factory=None, binary_admission=None, capacity_probe=None):
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
            clone, BASE, binary, root, settings, offline=False)
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
    demand(command == [str(binary), "clone", BASE, clone] and
           not instance_receipt.exists() and not instance_receipt.is_symlink() and
           not (root / "machines" / clone).exists() and
           not (root / "machines" / clone).is_symlink(),
           "VM_DEV_PREDECESSOR_COLLISION")
    _private_directory(settings / "vm-dev-sessions", create=True)
    evidence = settings / "vm-dev-sessions" / clone
    evidence.mkdir(mode=0o700)
    _private_directory(evidence)
    _write_once(evidence, "selection.json", {
        "schema": "farol.vm-dev-selection/1",
        "runId": run, "instance": clone, "base": BASE,
        "baseReceiptSHA256": hashlib.sha256(_regular(base_receipt, 65536)).hexdigest(),
        "acceptedReceiptSHA256": args.expected_receipt_sha256,
        "acceptedArtifactSHA256": selected["artifactSha256"],
        "network": "base-network-unmodified",
        "visible": args.visible
    })
    env = {key: os.environ[key] for key in ("HOME", "USER", "TMPDIR") if key in os.environ}
    env.update(PATH="/usr/bin:/bin:/usr/sbin:/sbin", TERMINAL_MAC_HOME=str(root))
    # A clone is an effect and is never retried/repaired after a lost terminal.
    (clone_effect or _one_clone)(command, evidence, binary, env, run)
    # Existing task machine provenance (same contract as vm:setup).
    try:
        machine.write_instance_receipt(instance_receipt, clone, BASE, base_receipt, root)
    except Exception:
        raise VMDevError("VM_DEV_INSTANCE_RECEIPT_UNCONFIRMED") from None
    stage = _stage_path(root / "machines" / clone, run)
    payload = _stage(stage, args, evidence, selected, producer)
    _write_once(evidence, "payload.json", {
        "schema": "farol.vm-dev-accepted-stage/1", "runId": run,
        "manifestSHA256": payload["manifestSHA256"],
        "acceptanceSHA256": payload["acceptanceSHA256"],
        "artifactSHA256": payload["artifactSHA256"]
    })
    (start_effect or _one_start)(binary, clone, args.visible, evidence, env)
    # Do not start the application session against a legacy/absent helper.
    # The native MCP repeats all prerequisites under its actual InputLease.
    _guest_grants(binary, clone, evidence, env)
    (exec_effect or _exec_mcp)(binary, root, clone, stage, payload, evidence, env)


def main(argv=None):
    args = parse_options(sys.argv[1:] if argv is None else argv)
    try:
        execute(args)
    except VMDevError as error:
        # stdout belongs only to the eventual MCP. Do not print paths, tool
        # outputs or exception argv in diagnostics; retain receipts privately.
        print(error.args[0], file=sys.stderr, flush=True)
        return 1
    except Exception:
        print("VM_DEV_UNCLASSIFIED", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
