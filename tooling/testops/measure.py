#!/usr/bin/env python3
"""Measure three audited read-only source leaves; never run product CI or E2E.

Baseline first (--jobs 1); --jobs 2 changes only this experimental probe schedule.
This cannot establish whole-CI speed or replace the source/package/native gates.
"""
from concurrent.futures import ThreadPoolExecutor
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import threading
import time

import testops
from bounded_capture import OutputBudget, start_capture
from deadline import CommandTimeout

ROOT = testops.ROOT
STOP = threading.Event()


def environment(node):
    result = {k: os.environ[k] for k in ("HOME", "TMPDIR", "LANG", "LC_ALL") if k in os.environ}
    result.update(PATH=str(node.parent) + os.pathsep + "/usr/bin:/bin:/usr/sbin:/sbin",
                  GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                  GIT_OPTIONAL_LOCKS="0", CI="1", NO_COLOR="1",
                  PYTHONDONTWRITEBYTECODE="1", GOPROXY="off", GOSUMDB="off", GOTOOLCHAIN="local")
    return result


def probes(node):
    # These read source and use disposable synthetic Git fixtures only. No
    # artifact writes, shared port, GUI, profile, provider or application launch.
    return [
        ("docs-links", [sys.executable, "-B", "docs/tools/check.py"]),
        ("docs-contracts", [sys.executable, "-B", "-m", "unittest", "discover", "-s", "docs/tools", "-p", "test_*.py"]),
        ("go-import-boundaries", [str(node), "tooling/check-go-architecture.mjs"]),
    ]


def trusted_node(path, expected_sha256):
    # The caller supplies an independently approved digest, not a value inferred
    # from --version or self-approved from the file during this invocation.
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("NODE_DIGEST_REQUIRED")
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or testops.digest(resolved.read_bytes()) != expected_sha256:
        raise ValueError("NODE_BINARY_DIGEST_MISMATCH")
    return resolved


def architecture_inputs(root):
    # Match checkGoArchitecture's physical scan, including ignored Go files.
    # Git identity alone omits inputs such as artifacts/extra.go. Symlinks are
    # refused before measurement, matching the checker's source-tree policy.
    entries = []
    skip = {".git", "node_modules", "_output", "dist", "tests"}

    def walk(directory):
        for path in sorted(directory.iterdir()):
            relative = path.relative_to(root).as_posix()
            if relative in skip:
                continue
            if path.is_symlink():
                raise ValueError("ARCHITECTURE_SOURCE_SYMLINK:" + relative)
            if relative == "resources/native/go" and path.is_dir() and (path / "go.mod").is_file():
                entries.append((relative + "/go.mod", "explicit-nested-module-exclusion"))
                continue
            if path.is_dir():
                walk(path)
            elif path.name.endswith(".go") or path.name == "go.mod":
                entries.append((relative, testops.digest(path.read_bytes())))
    walk(root)
    return {"sha256": testops.digest(json.dumps(entries, separators=(",", ":")).encode()),
            "files": len(entries)}


def measurement_identity(root):
    return {**testops.identity(root), "architecturePhysicalInputs": architecture_inputs(root)}


def run_probe(probe, directory, env):
    name, command = probe
    if STOP.is_set():
        return {"id": name, "status": "NOT_RUN", "reason": "CANCELLED"}
    start = time.monotonic()
    log = directory / (name + ".log")
    stage = {}
    budget = OutputBudget(1024 * 1024)
    capture = start_capture(command, ROOT, log, log, stage, budget, env=env)
    child = capture.child
    stop_sent = None
    forced = False
    try:
        while child.returncode is None or not stage["stdioClosed"]:
            try:
                capture.wait(0.05)
            except CommandTimeout:
                pass
            elapsed = time.monotonic() - start
            if STOP.is_set() or elapsed > 60 or budget.exceeded or stage["outputErrors"]:
                if stop_sent is None:
                    if child.returncode is None:
                        child.terminate()
                    stop_sent = time.monotonic()
                elif time.monotonic() - stop_sent > 3 and not forced:
                    if child.returncode is None:
                        child.kill()
                    forced = True
                if forced and child.returncode is not None:
                    break
    finally:
        capture.close()
    return {"id": name, "command": command, "exitCode": child.returncode,
            "status": "PASS" if (child.returncode == 0 and stop_sent is None and stage["stdioClosed"]
                                  and not stage["outputErrors"] and not budget.exceeded) else "FAIL",
            "wallSeconds": time.monotonic() - start,
            "userCpuSeconds": stage.get("userCpuSeconds"), "systemCpuSeconds": stage.get("systemCpuSeconds"),
            "peakRssBytes": stage.get("maxIndividualReapedChildRssBytes"),
            "originalChild": stage, "retainedOutputLimitBytes": budget.limit,
            "logSha256": testops.digest((directory / (name + ".log")).read_bytes()),
            "terminationRequested": stop_sent is not None,
            "descendantCleanup": "NOT_PROVEN" if stop_sent is not None else "normal-terminal"}


def validate_comparison(baseline, current):
    fields = ["identity", "node", "python", "platform", "probeSetSha256"]
    if baseline.get("schema") != 1 or baseline.get("jobs") != 1 or baseline.get("status") != "PASS":
        raise ValueError("COMPARISON_REQUIRES_PASSED_SERIAL_BASELINE")
    if any(baseline.get(key) != current.get(key) for key in fields):
        raise ValueError("BASELINE_SOURCE_TOOLCHAIN_OR_PROBE_MISMATCH")
    if not baseline.get("rounds") or baseline.get("sourceUnchanged") is not True or baseline.get("finalIdentity") != baseline.get("identity"):
        raise ValueError("BASELINE_INCOMPLETE")
    required = {name for name, _ in probes(Path(current["node"]["path"]))}
    for run in baseline["rounds"]:
        leaves = run.get("leaves", [])
        if (len(leaves) != len(required) or {leaf.get("id") for leaf in leaves} != required or
                any(leaf.get("status") != "PASS" or leaf.get("exitCode") != 0 or
                    leaf.get("terminationRequested") is not False or
                    not isinstance(leaf.get("wallSeconds"), (float, int)) or
                    not math.isfinite(leaf["wallSeconds"]) or leaf["wallSeconds"] <= 0
                    for leaf in leaves)):
            raise ValueError("BASELINE_INCOMPLETE")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--node-sha256", required=True, help="Independently approved executable digest; checked before execution")
    parser.add_argument("--jobs", type=int, choices=(1, 2), default=1)
    parser.add_argument("--repeats", type=int, choices=range(1, 8), default=3)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    if Path.cwd().resolve() != ROOT:
        parser.error("run from the pilot repository root")
    if args.jobs == 2 and args.baseline is None:
        parser.error("parallel experiment requires --baseline")
    node = trusted_node(args.node, args.node_sha256)
    env = environment(node)
    node_version = subprocess.check_output([str(node), "--version"], env=env, text=True).strip()
    if node_version not in ("v24.20.0", "v26.7.0"):
        parser.error("Farol's declared Node version is required")
    before = measurement_identity(ROOT)
    if before["dirty"]:
        parser.error("clean committed source required")
    report = {"schema": 1, "kind": "source-check-subset-measurement", "acceptance": False,
              "startedAt": datetime.now(timezone.utc).isoformat(),
              "identity": before, "node": {"path": str(node), "version": node_version, "sha256": args.node_sha256,
                                          "trust": "caller-supplied-independent-digest"},
              "python": {"path": sys.executable, "version": platform.python_version()},
              "platform": {"system": platform.system(), "machine": platform.machine()},
              "jobs": args.jobs, "cache": "uncontrolled-existing-host-cache-no-purge",
              "probeSetSha256": testops.digest(json.dumps(probes(node)).encode()),
              "rounds": [], "status": "NOT_RUN",
              "limits": ["Three existing source-check leaves only; no whole-CI speed claim",
                         "RSS is per-child high-water, not simultaneous machine memory peak",
                         "No cold-cache, setup/download, build, native, package or Linux qualification",
                         "No machine-wide resource reservation; fan-out limited to two cheap processes"]}
    if args.baseline:
        validate_comparison(json.loads(args.baseline.read_text()), report)
    output = args.output.resolve()
    if not output.is_relative_to((ROOT / "_output/testops").resolve()):
        parser.error("output must be a fresh directory under _output/testops")
    output.mkdir(parents=True, exist_ok=False)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: STOP.set())
    for index in range(args.repeats):
        directory = output / str(index + 1)
        directory.mkdir()
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            leaves = list(pool.map(lambda probe: run_probe(probe, directory, env), probes(node)))
        report["rounds"].append({"number": index + 1, "wallSeconds": time.monotonic() - started, "leaves": leaves})
        if STOP.is_set() or any(leaf["status"] != "PASS" for leaf in leaves):
            break
    after = measurement_identity(ROOT)
    node_unchanged = testops.digest(node.read_bytes()) == args.node_sha256
    report.update(endedAt=datetime.now(timezone.utc).isoformat(), finalIdentity=after,
                  sourceUnchanged=before == after, nodeUnchanged=node_unchanged)
    report["status"] = "PASS" if (before == after and node_unchanged and not STOP.is_set() and
        len(report["rounds"]) == args.repeats and all(
            leaf["status"] == "PASS" for run in report["rounds"] for leaf in run["leaves"])) else "FAIL"
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "report": str(output / "report.json")}))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "BLOCKED", "acceptance": False, "reason": str(error)}))
        raise SystemExit(2)
