"""Fixed portable source-gate leaves inside an offline, disposable container.

The host supplies isolation and original child reconciliation. This observer is
not a replacement for the existing root CI, native or package acceptance gates.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from testops import identity
from dependency_seal import fingerprint
from deadline import JOB_SECONDS, CommandTimeout, private_processes, retire_private_descendants
from bounded_capture import OutputBudget, start_capture


COMMANDS = {
    "checks-source": [["/usr/bin/python3", "-I", "scripts/assert-owner-untouched.py", "--", "npm", "run", "ci:cloud"]],
    "core": [["task", "test:core"]],
    "scan-secrets": [["task", "scan:secrets"]],
    "pilot-selftests": [
        ["/usr/bin/python3", "-B", "-m", "unittest", "discover", "-s", "tooling/testops", "-p", "test_*.py"],
        ["node", "--test", "--test-reporter=tap", "tooling/testops/catalog.test.mjs"],
        ["node", "--test", "--test-reporter=tap", "tooling/testops/languagegraph.test.mjs"],
        ["node", "--test", "--test-reporter=tap", "tooling/testops/iteration-witness.test.mjs"],
    ],
}

TOOLS = {
    "/usr/local/bin/node": "9507fea66ea788dfb2bbef1380ef6ef8940697ef1de15bee62b279e6cfef035c",
    "/usr/local/go/bin/go": "ccf0a11f03d2eeaa8b67eaad5ed460fd4968a0283adbc8897205d6faca59f0a9",
    "/testops-seed/testops/linux-tools-bootstrap-03/bin/task": "522df5f7b4326cb1d0293e2c721d4f0b2947a25c75dd3d24c75c76bc27150487",
    "/testops-seed/testops/linux-tools-bootstrap-03/bin/gitleaks": "00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b",
}


def cloud_receipt(root):
    reports = list((root / "_output/evidence/test-scopes").glob("*/report.json"))
    if len(reports) != 1:
        raise ValueError("EXACT_CLOUD_REPORT_REQUIRED")
    report = json.loads(reports[0].read_text())
    plan = json.loads(subprocess.check_output(
        ["node", "tooling/test-scopes.mjs", "--scope=cloud", "--list"], cwd=root))
    count = len(plan["suites"])
    if (report.get("status") != "PASS" or report.get("scope") != "cloud"
            or report.get("suites") != plan["suites"]
            or any(type(report.get(k)) is not int or report[k] != count
                   for k in ("selected", "executed", "passed"))
            or any(type(report.get(k)) is not int or report[k] != 0
                   for k in ("failed", "blocked", "notRun"))
            or report.get("scopeErrors") != [] or report.get("prerequisiteError")
            or len(report.get("results", [])) != count
            or {r.get("id") for r in report["results"]} != {s["id"] for s in plan["suites"]}
            or any(r.get("status") != "PASS" or not r.get("counts") for r in report["results"])):
        raise ValueError("CLOUD_PLAN_OR_COMPLETE_REPORT_MISMATCH")
    for result in report["results"]:
        terminal = result.get("terminal", {})
        if (terminal.get("terminal") is not True or type(terminal.get("exit")) is not int
                or terminal["exit"] != 0 or terminal.get("signal") is not None
                or terminal.get("timedOut") is not False or terminal.get("cancelled", False) is not False
                or type(result["counts"].get("failed")) is not int or result["counts"]["failed"] != 0):
            raise ValueError("CLOUD_ORIGINAL_SUITE_TERMINAL_REQUIRED")
    return {"path": str(reports[0].relative_to(root)), "sha256": sha(reports[0]),
            "plan": plan, "counts": [{"id": r["id"], "counts": r["counts"]} for r in report["results"]]}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selftest_count(command, stdout, stderr):
    if command[0] == "node":
        text = stdout.read_text()
        pairs = re.findall(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$", text, re.M)
        values = {key: int(value) for key, value in pairs}
        if (len(pairs) != 6 or set(values) != {"tests", "pass", "fail", "cancelled", "skipped", "todo"}
                or values["tests"] <= 0 or values["pass"] != values["tests"]
                or any(values[k] for k in ("fail", "cancelled", "skipped", "todo"))):
            raise ValueError("NODE_SELFTEST_REPORT_INCOMPLETE")
        return values["pass"]
    text = stderr.read_text()
    found = re.findall(r"^Ran (\d+) tests in [0-9.]+s$", text, re.M)
    if len(found) != 1 or int(found[0]) <= 0 or not text.rstrip().endswith("OK"):
        raise ValueError("PYTHON_SELFTEST_REPORT_INCOMPLETE")
    return int(found[0])


def remaining_processes():
    # This observer runs as PID 1 in the private container PID namespace. It
    # never inventories the host or another container. Reap adopted terminals.
    return private_processes([])


def observe_command(command, root, stdout_path, stderr_path, stage, budget, seconds, issued, captures, on_started=None):
    capture = start_capture(command, root, stdout_path, stderr_path, stage, budget)
    child = capture.child
    issued[child.pid] = child
    captures.append(capture)
    stage["pid"] = child.pid
    if on_started is not None:
        on_started()
    capture.wait(seconds)
    capture.close()
    captures.remove(capture)
    if (child.returncode != 0 or stage["outputTruncated"] or stage["outputErrors"]
            or not stage["stdioClosed"]):
        raise ValueError("ORIGINAL_COMMAND_FAILED")


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in COMMANDS:
        raise ValueError("ONE_FIXED_JOB_AND_SOURCE_BINDING_REQUIRED")
    job = sys.argv[1]
    expected = json.loads(sys.argv[2])
    root = Path("/workspace")
    output = root / "_output"
    source = identity(root)
    source["dependencyTree"] = fingerprint(root / "node_modules")
    source["dependencyReferenceSha256"] = expected.get("dependencyReferenceSha256")
    if source != expected or source["dirty"]:
        raise ValueError("SOURCE_BINDING_MISMATCH")
    tools = {p: sha(Path(p)) for p in TOOLS}
    if tools != TOOLS:
        raise ValueError("PINNED_SOURCE_GATE_TOOLS_REQUIRED")
    for name, target in {"node": "/usr/local/bin/node", "go": "/usr/local/go/bin/go",
                         "task": "/testops-seed/testops/linux-tools-bootstrap-03/bin/task",
                         "gitleaks": "/testops-seed/testops/linux-tools-bootstrap-03/bin/gitleaks"}.items():
        selected = shutil.which(name)
        if not selected or Path(selected).resolve(strict=True) != Path(target).resolve(strict=True):
            raise ValueError("PINNED_COMMAND_RESOLUTION_REQUIRED:" + name)
    report_path = output / "job-report.json"
    if report_path.exists():
        raise ValueError("REPORT_ALREADY_EXISTS")
    commands = COMMANDS[job]
    report = {"schema": 1, "id": job, "source": source, "commands": commands,
              "status": "RUNNING", "complete": False, "acceptance": False,
              "stages": [],
              "toolHashes": tools,
              "deadlineSeconds": JOB_SECONDS[job], "timedOut": False,
              "limits": ["Portable source checks only; native/package/installed/live obligations remain separate",
                         "No new root CI contract or affected-test execution"]}
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    start = time.monotonic()
    issued = {}
    captures = []
    budget = OutputBudget(32 * 1024 * 1024)
    report["retainedOutputLimitBytes"] = budget.limit
    try:
        for index, command in enumerate(commands):
            stdout_path = output / f"command-{index}.stdout.log"
            stderr_path = output / f"command-{index}.stderr.log"
            stage_start = time.monotonic()
            stage = {"command": command, "terminal": False}
            remaining = JOB_SECONDS[job] - (time.monotonic() - start)
            if remaining <= 0:
                raise CommandTimeout("ORIGINAL_JOB_DEADLINE_EXCEEDED")
            report["stages"].append(stage)
            report_path.write_text(json.dumps(report, indent=2) + "\n")
            observe_command(command, root, stdout_path, stderr_path, stage, budget, remaining, issued, captures,
                            lambda: report_path.write_text(json.dumps(report, indent=2) + "\n"))
            stage.update(wallSeconds=time.monotonic() - stage_start,
                         stdoutSha256=sha(stdout_path), stderrSha256=sha(stderr_path))
            if job == "pilot-selftests":
                stage["casesPassed"] = selftest_count(command, stdout_path, stderr_path)
        report.update(exitCode=0, terminal=True)
        if job == "checks-source":
            report["cloud"] = cloud_receipt(root)
        report["sourceAfter"] = identity(root)
        report["sourceAfter"]["dependencyTree"] = fingerprint(root / "node_modules")
        report["sourceAfter"]["dependencyReferenceSha256"] = expected["dependencyReferenceSha256"]
        if report["sourceAfter"] != source:
            raise ValueError("SOURCE_DRIFT")
        if tools != {p: sha(Path(p)) for p in TOOLS}:
            raise ValueError("TOOLCHAIN_DRIFT")
        report.update(status="PASS", complete=True)
    except CommandTimeout as error:
        report.update(status="FAIL", complete=False, terminal=False, timedOut=True,
                      error=str(error))
    except Exception as error:
        report.update(status="FAIL", error=type(error).__name__ + ":" + str(error))
    finally:
        retirement = retire_private_descendants(report["timedOut"])
        for capture in captures:
            capture.finish_after_retirement()
            capture.close()
        report["descendantRetirement"] = retirement
        report["descendantsDrained"] = retirement["drained"]
        for index, stage in enumerate(report["stages"]):
            for observed in retirement["reaped"]:
                if observed["pid"] == stage.get("pid"):
                    stage.update(observed)
                    issued[observed["pid"]].returncode = observed["exitCode"]
            for stream in ("stdout", "stderr"):
                path = output / f"command-{index}.{stream}.log"
                if path.is_file():
                    stage[stream + "Sha256"] = sha(path)
        if retirement["initialPids"] or report["timedOut"]:
            report.update(status="FAIL" if retirement["drained"] else "UNKNOWN", complete=False,
                          terminal=retirement["drained"])
        if not retirement["drained"]:
            report.update(status="UNKNOWN", complete=False, terminal=False)
        report["wallSeconds"] = time.monotonic() - start
        report["cgroup"] = {name: Path("/sys/fs/cgroup", name).read_text().strip()
                            for name in ("memory.max", "memory.peak", "memory.events", "cpu.max", "cpu.stat", "pids.max")}
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"id": job, "status": report["status"], "complete": report["complete"]}), flush=True)
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
