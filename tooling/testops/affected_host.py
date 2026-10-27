"""Opt-in Docker adapter for affected iteration; public task stays PLAN_ONLY.

Requires already prepared, owned source/SDK/seed/dependency volumes. It never
pulls, installs, prepares source, adopts historical attempts or contacts a target.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from affected_run import DEPENDENCIES, evidence_bytes, projection, commands, NODE
from dag import Budget, Job, Outcome, run, Blocked
from volumes import locked as volume_lock
from dependency_seal import reference
from docker_gate import Docker, ROOT, IMAGE, TOOLS, container_command, memory_events_closed
from testops import identity, changed, compiler_affected

SOURCE_KEYS = ("head", "tree", "workingSourceSha256", "dirty", "trackedAndUntrackedFiles")


def require_host_owner():
    # The qualified private bind mounts and container are owned by UID501.
    # Another host UID needs separate ownership qualification, never chmod/chown.
    uid = os.geteuid()
    if type(uid) is not int or uid != 501:
        raise Blocked("AFFECTED_HOST_UID_501_REQUIRED")


def cancellation_state(directory, nonce):
    file = directory / "state.json"
    if file.stat().st_size > 4096:
        raise Blocked("AFFECTED_HOST_CONTROL_INVALID")
    state = json.loads(evidence_bytes(file))
    if (not isinstance(state, dict) or set(state) != {"schema", "runId", "cancelled"}
            or type(state.get("schema")) is not int or state["schema"] != 1
            or state.get("runId") != nonce or type(state.get("cancelled")) is not bool):
        raise Blocked("AFFECTED_HOST_CONTROL_INVALID")
    return state["cancelled"]


class CancellationControl:
    """Host-owned writer; container receives only a read-only directory mount."""
    def __init__(self, directory, nonce):
        self.directory, self.nonce = directory, nonce
        directory.mkdir(mode=0o700)
        if directory.resolve() != directory:
            raise Blocked("AFFECTED_HOST_CONTROL_REDIRECT")
        with (directory / "state.json").open("x") as stream:
            json.dump({"schema": 1, "runId": nonce, "cancelled": False}, stream)

    def cancel(self):
        if cancellation_state(self.directory, self.nonce):
            return
        temporary = self.directory / ("cancel-" + uuid.uuid4().hex)
        with temporary.open("x") as stream:
            json.dump({"schema": 1, "runId": self.nonce, "cancelled": True}, stream)
        temporary.replace(self.directory / "state.json")


def wait_original(child, stop, control, seconds, observation):
    deadline = time.monotonic() + seconds
    attempted = False
    while True:
        if stop.is_set() and not attempted:
            attempted = True  # A denied/unknown write is never retried.
            try:
                control.cancel()
                observation["cancellationPublished"] = True
            except Exception as error:
                observation["controlFailure"] = type(error).__name__
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(child.args, seconds)
        try:
            return child.wait(timeout=min(1, remaining))
        except subprocess.TimeoutExpired:
            pass


def required_steps(bound, directory, focused, seals):
    values = {}
    for filename in ("compiler.json", "cloud.json"):
        raw = evidence_bytes(directory / filename)
        if hashlib.sha256(raw).hexdigest() != seals.get(filename):
            raise Blocked("AFFECTED_METADATA_CHANGED")
        values[filename] = json.loads(raw)
    plan = compiler_affected(ROOT, bound["changes"], values["compiler.json"])
    if focused:
        from affected_focused import focused_projection, focused_commands
        selected = focused_commands(focused_projection(plan, values["cloud.json"], values["compiler.json"]))
    else:
        selected = commands(projection(plan, values["cloud.json"], values["compiler.json"]))
    return [("compiler", [NODE, "tooling/testops/affected-inputs.mjs", "collect-focused" if focused else "collect"]), *selected]


def validate_counts(name, value, expected_steps):
    common = {"total", "passed", "failed", "skipped", "todo", "reportedSuccess"}
    extra = {"packages", "includesSubtests", "topLevelTests", "caseMembership"} if name == "focused-go" else set()
    if (not isinstance(value, dict) or set(value) != common | extra
            or any(type(value.get(key)) is not int or not 0 <= value[key] <= 2**53 - 1
                   for key in common - {"reportedSuccess"})
            or value["reportedSuccess"] is not True or value["failed"] != 0 or value["passed"] < 1
            or value["total"] != sum(value[key] for key in ("passed", "failed", "skipped", "todo"))):
        raise Blocked("AFFECTED_COUNT_SCHEMA_INVALID")
    if name != "focused-go":
        return
    from affected_focused import POLICY
    packages = json.loads(next(command[-1] for ident, command in expected_steps if ident == "focused-go-validate"))
    owned = {row["path"]: set(row["topLevelTests"]) for row in POLICY["packages"] if row["path"] in packages}
    rows = value["caseMembership"]
    if (type(value["packages"]) is not int or value["packages"] != len(packages)
            or type(value["topLevelTests"]) is not int or value["topLevelTests"] != sum(map(len, owned.values()))
            or value["includesSubtests"] is not True or value["skipped"] or value["todo"]
            or not isinstance(rows, list) or len(rows) != value["total"]):
        raise Blocked("AFFECTED_GO_COUNT_MEMBERSHIP_INVALID")
    seen, top = set(), set()
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {"package", "test", "status"}
                or not isinstance(row.get("package"), str) or row["package"] not in owned
                or not isinstance(row.get("test"), str) or not row["test"]
                or row["test"].split("/", 1)[0] not in owned[row["package"]]
                or row.get("status") != "pass"):
            raise Blocked("AFFECTED_GO_COUNT_MEMBERSHIP_INVALID")
        key = (row["package"], row["test"])
        if key in seen:
            raise Blocked("AFFECTED_GO_COUNT_MEMBERSHIP_INVALID")
        seen.add(key)
        if "/" not in row["test"]:
            top.add(key)
    if top != {(package, test) for package, tests in owned.items() for test in tests}:
        raise Blocked("AFFECTED_GO_COUNT_MEMBERSHIP_INVALID")


def drain_after_cleanup_failure(child, directory, error, observation):
    try:
        with (directory / "original-draining.json").open("x") as stream:
            json.dump({"status": "UNKNOWN_DRAINING_ORIGINAL", "error": type(error).__name__, "originalPid": child.pid}, stream)
    except Exception as persistence_error:
        observation["drainingPersistenceFailure"] = type(persistence_error).__name__
    finally:
        # Persistence is subordinate to custody, including ENOSPC/denied writes.
        code = child.wait()
    return code


def retirement_closed(record):
    fields = {"initialPids", "remainingPids", "reaped", "signals", "errors", "drained", "reason"}
    return (isinstance(record, dict) and set(record) == fields and record["drained"] is True
            and record["reason"] == "NATURAL_TERMINAL"
            and all(type(record[key]) is list and record[key] == []
                    for key in fields - {"drained", "reason"}))


def source_only(binding):
    return {key: binding[key] for key in SOURCE_KEYS}


def iteration_command(job, directory, bound, options, docker, nonce):
    # The container may mutate only this child directory, never its host
    # observer logs, CID, terminal, deadline or retirement record destinations.
    name, command = container_command(job, directory / "inner", bound, options, docker, nonce)
    index = command.index(IMAGE)
    mounts = ["--mount", "type=volume,source=" + options.dependency_volume +
              ",target=/workspace/node_modules,readonly,volume-nocopy,volume-subpath=node_modules",
              "--mount", "type=bind,source=" + str(docker.config / "control") +
              ",target=/testops-host-control,readonly"]
    # Fixed bridge/argv; no shell interpolation of the base or source record.
    setup = ("mkdir -p /tmp/testops-home; "
             "cp -a /testops-seed/testops/go-mod-cache /workspace/_output/go-mod-cache; "
             "cp -a /testops-seed/testops/go-build-cache /workspace/_output/go-build-cache; "
             "exec /usr/bin/python3 -I tooling/testops/affected_host_entry.py \"$@\"")
    return name, command[:index] + mounts + [IMAGE, "sh", "-ec", setup, "sh",
               json.dumps(source_only(bound), separators=(",", ":")), bound["requestedBase"], nonce,
               *(["--focused"] if options.focused else [])]


def iteration_receipt(report, bound, directory, focused):
    expected = {"source": source_only(bound), "dependencies": DEPENDENCIES, "tools": TOOLS}
    if (report.get("schema") != 1 or type(report.get("schema")) is not int
            or report.get("kind") != "affected-iteration" or report.get("acceptance") is not False
            or report.get("route") != ("focused" if focused else "whole-core-and-batches")
            or report.get("status") != "PASS" or report.get("complete") is not True
            or report.get("binding") != expected or report.get("changes") != bound["changes"]
            or report.get("lease") != "RELEASED" or report.get("cancelled") is not False
            or report.get("timedOut") is not False or report.get("outputBudget", {}).get("exceeded") is not False):
        raise Blocked("AFFECTED_COMPLETE_BOUND_RECEIPT_REQUIRED")
    if not retirement_closed(report.get("descendantRetirement")):
        raise Blocked("AFFECTED_ORIGINAL_DESCENDANT_CLOSURE_REQUIRED")
    stages = report.get("stages", [])
    if not stages or stages[0].get("id") != "compiler" or len({s.get("id") for s in stages}) != len(stages):
        raise Blocked("AFFECTED_ORIGINAL_STAGES_REQUIRED")
    expected_steps = required_steps(bound, directory, focused, report.get("metadataSha256", {}))
    if [(stage.get("id"), stage.get("command")) for stage in stages] != expected_steps:
        raise Blocked("AFFECTED_REQUIRED_STAGES_MISMATCH")
    ids = [s.get("id") for s in stages]
    remaining = ids[1:]
    if remaining[:1] == ["types-main"]:
        if remaining[:2] != ["types-main", "types-renderer"]:
            raise Blocked("AFFECTED_STAGE_CHAIN_INCOMPLETE")
        remaining = remaining[2:]
    native = "focused-go" if focused else "complete-core"
    tests = []
    if remaining[:1] == [native]:
        tests.append(native)
        if remaining[:2] != [native, native + "-validate"]:
            raise Blocked("AFFECTED_STAGE_CHAIN_INCOMPLETE")
        remaining = remaining[2:]
    while remaining:
        name = remaining[0]
        if (not isinstance(name, str) or not re.fullmatch(r"node-cloud-\d{2}", name)
                or remaining[:2] != [name, name + "-validate"]):
            raise Blocked("AFFECTED_STAGE_CHAIN_INCOMPLETE")
        tests.append(name)
        remaining = remaining[2:]
    if (not tests or type(report.get("testChildrenIssued")) is not int
            or report["testChildrenIssued"] != len(tests)
            or not isinstance(report.get("counts"), dict)
            or set(report["counts"]) != set(tests) - {"complete-core"}):
        raise Blocked("AFFECTED_TEST_ACCOUNTING_INCOMPLETE")
    for name, counts in report["counts"].items():
        validate_counts(name, counts, expected_steps)
    retained = 0
    for stage in stages:
        if (stage.get("terminal") is not True or type(stage.get("exitCode")) is not int
                or stage["exitCode"] != 0 or stage.get("stdioClosed") is not True
                or type(stage.get("originalPid")) is not int or stage["originalPid"] <= 1
                or type(stage.get("pid")) is not int or stage["pid"] != stage["originalPid"]
                or stage.get("outputErrors") != [] or stage.get("outputTruncated") is not False):
            raise Blocked("AFFECTED_ORIGINAL_STAGE_CLOSURE_REQUIRED")
        name = stage["id"]
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name):
            raise Blocked("AFFECTED_STAGE_NAME_INVALID")
        for stream in ("stdout", "stderr"):
            raw = evidence_bytes(directory / (name + "." + stream + ".log"))
            digest = hashlib.sha256(raw).hexdigest()
            if digest != stage.get(stream + "Sha256") or digest != stage.get("output", {}).get(stream, {}).get("observedSha256"):
                raise Blocked("AFFECTED_ORIGINAL_STREAM_MISMATCH")
            observed = stage["output"][stream]
            if (set(observed) != {"observedBytes", "retainedBytes", "observedSha256"}
                    or any(type(observed.get(key)) is not int or observed[key] != len(raw)
                           for key in ("observedBytes", "retainedBytes"))):
                raise Blocked("AFFECTED_ORIGINAL_STREAM_SIZE_MISMATCH")
            retained += len(raw)
    budget = report["outputBudget"]
    if (set(budget) != {"limitBytes", "remainingBytes", "exceeded"}
            or type(budget.get("limitBytes")) is not int or budget["limitBytes"] != 32 * 1024**2
            or type(budget.get("remainingBytes")) is not int or not 0 <= retained <= budget["limitBytes"]
            or budget["remainingBytes"] != budget["limitBytes"] - retained):
        raise Blocked("AFFECTED_OUTPUT_BUDGET_MISMATCH")
    caps = report.get("cgroup", {})
    if (caps.get("memory.max") != str(3072 * 1024**2) or caps.get("cpu.max") != "200000 100000"
            or caps.get("pids.max") != "256" or
            not memory_events_closed(caps.get("memory.events"))):
        raise Blocked("AFFECTED_CAP_OR_OOM_MISMATCH")
    return {"schema": 1, "id": "affected", "source": bound, "exitCode": 0,
            "complete": True, "acceptance": False, "counts": report.get("counts"),
            "reportSha256": hashlib.sha256(evidence_bytes(directory / "report.json")).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("docker", "socket", "dependency-reference"):
        parser.add_argument("--" + flag, type=Path, required=True)
    for flag in ("scope", "source-volume", "seed-volume", "sdk-volume", "dependency-volume",
                 "dependency-reference-sha256", "base", "output"):
        parser.add_argument("--" + flag, required=True)
    parser.add_argument("--focused", action="store_true")
    options = parser.parse_args()
    require_host_owner()
    if not re.fullmatch(r"farol-testops-[a-f0-9]{8}", options.scope):
        raise Blocked("OWNED_SCOPE_REQUIRED")
    os.environ["PATH"] = "/usr/bin:/bin"
    source = identity(ROOT)
    if source["dirty"]:
        raise Blocked("CLEAN_COMMITTED_SOURCE_REQUIRED")
    original_changes = changed(ROOT, options.base, "HEAD")
    if not original_changes["paths"]:
        raise Blocked("AFFECTED_NO_CHANGED_PATHS")
    parent = ROOT / "_output/testops"
    if parent.is_symlink() or not parent.is_dir() or parent.resolve() != parent:
        raise Blocked("OWNED_OUTPUT_PARENT_REQUIRED")
    ref = options.dependency_reference
    if ref.is_symlink() or not ref.resolve(strict=True).is_relative_to(parent):
        raise Blocked("DEPENDENCY_REFERENCE_OUTSIDE_OWNED_EVIDENCE")

    def bound_source():
        current = identity(ROOT)
        changes = changed(ROOT, options.base, "HEAD")
        declared = reference(ref, options.dependency_reference_sha256,
                             hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest(),
                             IMAGE, TOOLS["/usr/local/bin/node"])
        if {key: declared[key] for key in DEPENDENCIES} != DEPENDENCIES:
            raise Blocked("AFFECTED_DEPENDENCIES_UNQUALIFIED")
        return {**current, "changes": changes, "requestedBase": original_changes["requestedBase"],
                "dependencyReferenceSha256": options.dependency_reference_sha256}

    initial = bound_source()
    if source_only(initial) != source or initial["changes"] != original_changes:
        raise Blocked("SOURCE_CHANGED_DURING_ADMISSION")
    config = parent / ("docker-client-" + uuid.uuid4().hex)
    config.mkdir(mode=0o700)
    state = {"retain": False}
    try:
        return iterate(options, parent, source, bound_source, config, state)
    finally:
        # Containers bind-mount this config; keep it while any retirement is unconfirmed.
        if not state["retain"]:
            shutil.rmtree(config)


def iterate(options, parent, source, bound_source, config, state):
    (config / "config.json").write_text("{}\n")
    (config / "passwd").write_text("root:x:0:0:root:/root:/bin/sh\ntestops:x:501:20:TestOps:/tmp/testops-home:/bin/sh\n")
    (config / "group").write_text("root:x:0:\nstaff:x:20:testops\n")
    (config / "bin").mkdir(mode=0o700)
    for tool in ("task", "gitleaks"):
        (config / "bin" / tool).symlink_to("/testops-seed/testops/linux-tools-bootstrap-03/bin/" + tool)
    docker = Docker(options.docker, options.socket, config)
    engine = docker.engine()
    # Admit volumes under the lifecycle lock: a concurrent prune cannot remove
    # them between its check and its rm, and this command line names them after.
    with volume_lock(ROOT, 120):
        for volume in (options.source_volume, options.seed_volume, options.sdk_volume, options.dependency_volume):
            docker.volume(volume, options.scope, source["head"] if volume == options.source_volume else None)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    nonce = uuid.uuid4().hex[:12]
    control = CancellationControl(config / "control", nonce)

    def execute(job, directory, bound):
        if docker.engine() != engine:
            return Outcome("BLOCKED", True, reason="ENGINE_IDENTITY_CHANGED")
        if stop.is_set():
            return Outcome("BLOCKED", True, reason="CANCELLED_BEFORE_DOCKER")
        (directory / "inner").mkdir(mode=0o700)
        name, command = iteration_command(job, directory, bound, options, docker, nonce)
        (directory / "docker-command.json").write_text(json.dumps(command, indent=2) + "\n")
        timed_out = False
        observation = {"cancellationPublished": False}
        with (directory / "docker.stdout.log").open("xb") as stdout, (directory / "docker.stderr.log").open("xb") as stderr:
            if stop.is_set():
                return Outcome("BLOCKED", True, reason="CANCELLED_BEFORE_DOCKER")
            child = subprocess.Popen(command, env=docker.env, stdin=subprocess.DEVNULL,
                                     stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                code = wait_original(child, stop, control, 5400, observation)
            except subprocess.TimeoutExpired:
                timed_out = True
                stop.set()
                try:
                    docker.stop_owned_after_deadline(directory / ".original-container-affected.cid", name, options.scope, directory, engine)
                    code = child.wait(timeout=30)
                except Exception as error:
                    code = drain_after_cleanup_failure(child, directory, error, observation)
        (directory / "original-docker-terminal.json").write_text(json.dumps({"terminal": True, "pid": child.pid, "exitCode": code, "timedOut": timed_out, **observation}) + "\n")
        if not docker.removed(name, directory, engine):
            return Outcome("UNKNOWN", False, reason="ORIGINAL_CONTAINER_RETIREMENT_UNCONFIRMED")
        if code != 0 or timed_out or observation.get("controlFailure"):
            return Outcome("FAIL", True, reason="AFFECTED_ORIGINAL_DOCKER_NON_SUCCESS:" + str(code))
        directory = directory / "inner/affected-iteration"
        report = json.loads(evidence_bytes(directory / "report.json"))
        return Outcome("PASS", True, iteration_receipt(report, bound, directory, options.focused))

    state["retain"] = True
    result = run(ROOT, [Job("affected", cpu=2, memory_mib=3072, effects="owned-fixture")],
                 Budget(1, 2, 3072), "linux", bound_source, execute, options.output, stop)
    state["retain"] = bool(result.get("leaseRetained"))
    print(json.dumps({"status": result["status"], "acceptance": False,
                      "report": str(parent / options.output / "report.json"),
                      "limits": ["Opt-in iteration only; public task remains PLAN_ONLY; full CI/native/package gates remain mandatory"]}))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
