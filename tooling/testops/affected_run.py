"""Opt-in affected iteration inside the pilot's disposable Linux PID namespace.

No caller-supplied graph, plan, executable, test path or remote target is accepted.
This inner runner requires the same owned offline container as docker_gate.py;
its report does not replace complete CI or native/package/release acceptance.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from testops import changed, compiler_affected, identity, safe_path
from dependency_seal import fingerprint
from gate_observer import TOOLS
from deadline import retire_private_descendants, private_processes, CommandTimeout
from dag import Lease
from bounded_capture import Capture, OutputBudget

ROOT = Path("/workspace")
DIRECTORY = ROOT / "_output/affected-iteration"
NODE = "/usr/local/bin/node"
DEPENDENCIES = {"algorithm": "node-modules-tree-v1",
                "treeSha256": "b86961cc24c49560d4292dc327f768c3a022a7ca3761912cb6f89ae6364c9615",
                "files": 8331, "logicalBytes": 236610628}
LOCK = "d34aab0b859af71838d22ed35f673543c0357fc91352a48a6423b17deebaf013"
DEADLINE = 1800


def projection(plan, cloud, metadata):
    """Widen to unchanged whole portable batches, never execute plan arguments."""
    if (plan.get("kind") != "affected-plan-only" or plan.get("status") != "PLAN_ONLY"
            or plan.get("executionAllowed") is not False or plan.get("acceptance") is not False
            or plan.get("broadened") != []):
        raise ValueError("AFFECTED_MAPPING_REQUIRES_REVIEW")
    selected = [safe_path(row["path"]) for row in plan["selected"]]
    if not selected or len(set(selected)) != len(selected):
        raise ValueError("AFFECTED_SELECTION_EMPTY_OR_DUPLICATE")
    if (cloud.get("version") != 1 or cloud.get("scope") != "cloud" or not isinstance(cloud.get("suites"), list)
            or not isinstance(cloud.get("mixedSelections"), list) or not isinstance(cloud.get("deferredFiles"), list)):
        raise ValueError("AFFECTED_PORTABLE_REGISTRY_REQUIRED")
    suites, covered = [], set()
    go = [file for file in selected if file.endswith("_test.go")]
    if go:
        observed = metadata.get("go", {})
        modules = {row.get("module") for row in observed.get("observations", [])}
        if observed.get("gaps") != [] or modules != {"go.mod", "resources/native/go/go.mod"}:
            raise ValueError("AFFECTED_GO_CORE_MODULE_COVERAGE_UNKNOWN")
        owners = {file for package in observed.get("packages", []) for file in package.get("files", [])}
        if not set(go) <= owners:
            raise ValueError("AFFECTED_GO_SELECTED_FILE_UNOWNED")
    for suite in cloud["suites"]:
        files = suite.get("files", [])
        hits = set(files).intersection(selected)
        if not hits:
            continue
        # A mixed-file regex is partial Mac coverage, never a whole-file result.
        # The first route deliberately admits ordinary Node Vitest batches only.
        if (suite.get("runner") != "vitest" or suite.get("cwd") != "."
                or suite.get("config") or suite.get("testNamePattern")
                or not re.fullmatch(r"node-cloud-\d{2}", suite.get("id", ""))
                or not files or len(files) != len(set(files))
                or any(not safe_path(f).startswith("tests/") or not re.search(r"\.test\.(ts|tsx|mjs)$", f) for f in files)
                or type(suite.get("timeoutMs")) is not int or suite["timeoutMs"] != 300000
                or suite.get("workers") != 2):
            raise ValueError("AFFECTED_PARTIAL_OR_NATIVE_SUITE_REFUSED")
        suites.append(suite)
        covered.update(hits)
    if set(selected) != covered.union(go):
        raise ValueError("AFFECTED_SELECTED_FILE_UNADMITTED")
    if len({s["id"] for s in suites}) != len(suites):
        raise ValueError("AFFECTED_DUPLICATE_SUITE")
    return {"schema": 1, "kind": "affected-iteration-projection", "acceptance": False,
            "selectedFiles": selected, "suites": suites, "completeCore": bool(go),
            "typescriptChecks": any(re.search(r"\.tsx?$", row["path"]) for row in plan["changes"]["paths"]),
            "widening": {"go": "Unchanged complete task test:core" if go else None,
                         "javascript": "Unchanged whole portable registry batches"},
            "mandatoryFinalGates": plan.get("mandatoryFinalGates", [])}


def commands(projected):
    result = []
    if projected["typescriptChecks"]:
        result.extend([("types-main", [NODE, "node_modules/typescript/bin/tsc", "--noEmit"]),
                       ("types-renderer", [NODE, "node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.renderer.json"])])
    if projected["completeCore"]:
        result.append(("complete-core", ["/testops-seed/testops/linux-tools-bootstrap-03/bin/task", "test:core"]))
        result.append(("complete-core-validate", [NODE, "tooling/testops/affected-inputs.mjs", "validate-core"]))
    for suite in projected["suites"]:
        name = suite["id"]
        result.append((name, [NODE, "/workspace/node_modules/vitest/vitest.mjs", "run", *suite["files"],
                             "--pool=threads", "--maxWorkers=2", "--reporter=default", "--reporter=json",
                             "--outputFile.json=" + str(DIRECTORY / (name + ".json"))]))
        result.append((name + "-validate", [NODE, "tooling/testops/affected-inputs.mjs", "validate", name,
                                            json.dumps(suite["files"], separators=(",", ":"))]))
    return result


def environment(focused=False):
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin:/testops-bin", "HOME": "/tmp/testops-home",
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0",
            "CI": "1", "NO_COLOR": "1", "GOENV": "off", "GOWORK": "off", "GOTOOLCHAIN": "local",
            "GOPROXY": "off", "GOSUMDB": "off", "GOMAXPROCS": "2", "GOFLAGS": "-p=2",
            "GOROOT": "/usr/local/go", "GOPATH": "/workspace/_output/gopath",
            "GOCACHE": "/workspace/_output/go-build-cache", "GOMODCACHE": "/workspace/_output/go-mod-cache"}
    if focused:
        env.update(CGO_ENABLED="1", GOOS="linux", GOARCH="arm64", GOFLAGS="-mod=readonly -p=1")
    return env


def private_container():
    if sys.platform != "linux" or platform.machine() not in {"aarch64", "arm64"} or os.getpid() != 1 or os.geteuid() != 501:
        raise ValueError("AFFECTED_PRIVATE_LINUX_PID1_REQUIRED")
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    if int(status["CapEff"].strip(), 16) != 0 or status["NoNewPrivs"].strip() != "1":
        raise ValueError("AFFECTED_UNPRIVILEGED_CONTAINER_REQUIRED")
    entries = [line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines()]
    mounts = {fields[4]: fields[5].split(",") for fields in entries}
    if any("ro" not in mounts.get(mount, []) for mount in ("/", "/workspace", "/usr/local/go")):
        raise ValueError("AFFECTED_READ_ONLY_INPUT_MOUNTS_REQUIRED")
    if {p.name for p in Path("/sys/class/net").iterdir()} != {"lo"}:
        raise ValueError("AFFECTED_NETWORK_NONE_REQUIRED")
    for cache, maximum in {".vite": 256 * 1024**2, ".vite-temp": 128 * 1024**2}.items():
        name = "/workspace/node_modules/" + cache
        rows = [fields for fields in entries if fields[4] == name]
        if (len(rows) != 1 or rows[0][rows[0].index("-") + 1] != "tmpfs"
                or "rw" not in mounts[name]):
            raise ValueError("AFFECTED_FRESH_CACHE_MOUNT_REQUIRED:" + cache)
        directory = Path(name)
        capacity = os.statvfs(directory)
        if (directory.is_symlink() or directory.resolve() != directory
                or capacity.f_blocks * capacity.f_frsize > maximum or any(directory.iterdir())):
            raise ValueError("AFFECTED_FRESH_EMPTY_BOUNDED_CACHE_REQUIRED:" + cache)
    for name, value in {"memory.max": str(3072 * 1024**2), "cpu.max": "200000 100000", "pids.max": "256"}.items():
        if Path("/sys/fs/cgroup", name).read_text().strip() != value:
            raise ValueError("AFFECTED_RESOURCE_CAP_REQUIRED:" + name)


def binding():
    if hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest() != LOCK:
        raise ValueError("AFFECTED_LOCK_UNQUALIFIED")
    dependencies = fingerprint(ROOT / "node_modules")
    if dependencies != DEPENDENCIES:
        raise ValueError("AFFECTED_DEPENDENCIES_UNQUALIFIED")
    tools = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in TOOLS}
    if tools != TOOLS:
        raise ValueError("AFFECTED_TOOLCHAIN_UNQUALIFIED")
    for name, target in {"node": NODE, "go": "/usr/local/go/bin/go", "task": "/testops-seed/testops/linux-tools-bootstrap-03/bin/task"}.items():
        selected = shutil.which(name)
        if not selected or Path(selected).resolve(strict=True) != Path(target).resolve(strict=True):
            raise ValueError("AFFECTED_TOOL_RESOLUTION_UNQUALIFIED:" + name)
    return {"source": identity(ROOT), "dependencies": dependencies, "tools": tools}


def acquire_attempt(root, directory):
    if (directory.parent != root / "_output" or directory.parent.is_symlink()
            or directory.parent.resolve() != directory.parent):
        raise ValueError("AFFECTED_OUTPUT_REDIRECT")
    if directory.exists() or directory.is_symlink():
        raise ValueError("AFFECTED_ATTEMPT_ALREADY_EXISTS")
    parent = root / "_output/testops"
    parent.mkdir(mode=0o700, exist_ok=True)
    if parent.resolve() != parent:
        raise ValueError("AFFECTED_LEASE_PARENT_REDIRECT")
    lease = Lease(parent)
    # Ordinary contention must not reserve the fixed attempt directory. A
    # crash after acquisition still leaves the original conservative fence.
    lease.acquire(directory)
    try:
        directory.mkdir(mode=0o700)
    except Exception:
        # No child or report has been issued; release only this original lease.
        # A failed release retains its identity and remains an explicit error.
        lease.release()
        raise
    return lease


def arguments(argv):
    if (len(argv) not in {3, 4} or argv[1] != "--base" or not argv[2] or len(argv[2]) > 256
            or len(argv) == 4 and argv[3] != "--focused"):
        raise ValueError("AFFECTED_EXPLICIT_BASE_ONLY")
    return argv[2], len(argv) == 4


def stage_deadline(name, focused):
    if name == "complete-core":
        return 1800
    if name == "focused-go":
        return 600
    if focused and name == "compiler":
        return 420  # Six independently bounded 60s Go lists plus TS/setup room.
    if name.endswith("-validate"):
        return 30
    return 120 if name.startswith("types-") else 300


def evidence_bytes(file):
    limit = 32 * 1024**2
    if (file.is_symlink() or file.resolve() != file or not file.is_file()
            or file.stat().st_size > limit):
        raise ValueError("AFFECTED_ORIGINAL_EVIDENCE_CHANGED:" + file.name)
    with file.open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("AFFECTED_ORIGINAL_EVIDENCE_CHANGED:" + file.name)
    return raw


def verify_evidence(originals):
    for file, expected in originals.items():
        if hashlib.sha256(evidence_bytes(file)).hexdigest() != expected:
            raise ValueError("AFFECTED_ORIGINAL_EVIDENCE_CHANGED:" + file.name)


def require_host_source(observed, expected):
    if expected is not None and observed != expected:
        raise ValueError("AFFECTED_HOST_SOURCE_MISMATCH")


def main(expected_source=None, host_cancelled=None):
    base, focused = arguments(sys.argv)
    private_container()
    os.environ.clear()
    os.environ.update(environment(focused))
    os.chdir(ROOT)
    Path("/tmp/testops-home").mkdir(mode=0o700, exist_ok=True)
    before = binding()  # Authenticate installed packages BEFORE Node imports.
    require_host_source(before["source"], expected_source)
    if host_cancelled is not None and host_cancelled():
        raise ValueError("AFFECTED_HOST_CANCELLED_BEFORE_ADMISSION")
    changes = changed(ROOT, base, "HEAD")
    if not changes["paths"]:
        raise ValueError("AFFECTED_NO_CHANGED_PATHS")
    lease = acquire_attempt(ROOT, DIRECTORY)
    cancelled = False
    def cancel(*_):
        nonlocal cancelled
        cancelled = True
    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    report = {"schema": 1, "kind": "affected-iteration", "status": "RUNNING", "acceptance": False,
              "route": "focused" if focused else "whole-core-and-batches",
              "binding": before, "changes": changes, "stages": [], "testChildrenIssued": 0,
              "complete": False, "lease": "HELD", "deadlineSeconds": DEADLINE,
              "limits": ["Iteration only; unchanged complete CI and native/package/release gates remain mandatory",
                         "JavaScript widens to ordinary whole portable batches; partial mixed files, renderer and unknown mappings refuse",
                         "Any Go selection runs the unchanged full core gate, including its existing skip semantics",
                         "Pinned Go executable plus read-only existing SDK; no new full-SDK vendor attestation",
                         "Host must retain the original Docker terminal and prove container retirement separately"]}
    if focused:
        report["limits"][1:3] = [
            "Whole selected ordinary portable JavaScript files; no mixed selectors or native admission",
            "Four audited Go packages only, complete active-file and 66 top-level policy with original JSON case/subtest terminals",
            "Iteration subset; complete core and all final CI/native/package gates remain mandatory",
        ]
    start = time.monotonic()
    timed_out = False
    issued = {}
    captures = []
    output_budget = OutputBudget(32 * 1024**2)
    original_evidence = {}
    validated_counts = {}
    def save():
        (DIRECTORY / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    def check_cancelled():
        nonlocal cancelled
        if host_cancelled is not None and host_cancelled():
            cancelled = True
        if cancelled:
            raise ValueError("AFFECTED_CANCELLED")

    def recheck():
        check_cancelled()
        if binding() != before:
            raise ValueError("AFFECTED_INPUT_DRIFT")
        if changed(ROOT, base, "HEAD") != changes:
            raise ValueError("AFFECTED_CHANGE_SET_DRIFT")
        verify_evidence(original_evidence)
        check_cancelled()
    def execute(name, command, test_child=False):
        recheck()
        if time.monotonic() - start >= DEADLINE:
            raise CommandTimeout("AFFECTED_DEADLINE_EXCEEDED_BEFORE_ISSUANCE")
        limit = stage_deadline(name, focused)
        stage_start = time.monotonic()
        stage = {"id": name, "command": command, "terminal": False, "deadlineSeconds": limit}
        report["stages"].append(stage)
        save()
        if cancelled:
            raise ValueError("AFFECTED_CANCELLED_BEFORE_ISSUANCE")
        stdout = (DIRECTORY / (name + ".stdout.log")).open("xb")
        try:
            stderr = (DIRECTORY / (name + ".stderr.log")).open("xb")
        except Exception:
            stdout.close()
            raise
        try:
            # Verification, persistence and log setup can outlast publication.
            # Refresh at the issuance boundary; do not use an old cached read.
            check_cancelled()
            child = subprocess.Popen(command, cwd=ROOT, env=environment(focused), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            issued[child.pid] = child
            stage["originalPid"] = child.pid
            if test_child:
                report["testChildrenIssued"] += 1
            capture = Capture(child, stdout, stderr, stage, output_budget)
            captures.append(capture)
        except Exception:
            stdout.close()
            stderr.close()
            raise
        save()
        capture.wait(min(limit, max(0.001, DEADLINE - (time.monotonic() - start))))
        capture.close()
        captures.remove(capture)
        stage["wallSeconds"] = time.monotonic() - stage_start
        reaped = []
        remaining = private_processes(reaped)
        if remaining or reaped:
            report["unexpectedDescendants"] = {"after": name, "remainingPids": remaining, "reaped": reaped}
            raise ValueError("AFFECTED_UNEXPECTED_DESCENDANTS_NO_SUCCESSOR")
        for stream in ("stdout", "stderr"):
            file = DIRECTORY / (name + "." + stream + ".log")
            expected = stage["output"][stream]["observedSha256"]
            original_evidence[file] = expected
            stage[stream + "Sha256"] = expected
        verify_evidence(original_evidence)
        save()
        if stage["exitCode"] != 0:
            raise ValueError("AFFECTED_ORIGINAL_CHILD_FAILED:" + name)
        if output_budget.exceeded or stage["outputErrors"] or not stage["stdioClosed"]:
            raise ValueError("AFFECTED_OUTPUT_INCOMPLETE_NO_SUCCESSOR")
        recheck()
    try:
        save()
        execute("compiler", [NODE, "tooling/testops/affected-inputs.mjs", "collect-focused" if focused else "collect"])
        metadata = json.loads((DIRECTORY / "compiler.json").read_text())
        report["metadataSha256"] = {}
        for filename in ("compiler.json", "cloud.json"):
            file = DIRECTORY / filename
            digest = hashlib.sha256(evidence_bytes(file)).hexdigest()
            original_evidence[file] = digest
            report["metadataSha256"][filename] = digest
        plan = compiler_affected(ROOT, changes, metadata)
        (DIRECTORY / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
        cloud = json.loads((DIRECTORY / "cloud.json").read_text())
        if focused:
            from affected_focused import focused_projection, focused_commands
            projected = focused_projection(plan, cloud, metadata)
            steps = focused_commands(projected)
        else:
            projected = projection(plan, cloud, metadata)
            steps = commands(projected)
        (DIRECTORY / "projection.json").write_text(json.dumps(projected, indent=2) + "\n")
        for name, command in steps:
            execute(name, command, not name.endswith("-validate") and not name.startswith("types-"))
            if name.endswith("-validate"):
                key = name.removesuffix("-validate")
                file = DIRECTORY / (key + (".completion.json" if key == "complete-core" else ".counts.json"))
                raw = evidence_bytes(file)
                original_evidence[file] = hashlib.sha256(raw).hexdigest()
                verify_evidence(original_evidence)
                if key != "complete-core":
                    validated_counts[key] = json.loads(raw)
        report["counts"] = validated_counts
        recheck()
        report.update(status="PASS", complete=True)
    except CommandTimeout as error:
        timed_out = True
        report.update(status="FAIL", reason=str(error))
    except Exception as error:
        report.update(status="BLOCKED" if report["testChildrenIssued"] == 0 else "FAIL", reason=type(error).__name__ + ":" + str(error))
    finally:
        # The only allowed signals affect this disposable private PID namespace.
        retirement = retire_private_descendants(timed_out)
        report["descendantRetirement"] = retirement
        for capture in captures:
            capture.finish_after_retirement()
            capture.close()
        for stage in report["stages"]:
            for observed in retirement["reaped"]:
                if observed["pid"] == stage.get("originalPid"):
                    stage.update(observed)
                    issued[observed["pid"]].returncode = observed["exitCode"]
            for stream in ("stdout", "stderr"):
                file = DIRECTORY / (stage["id"] + "." + stream + ".log")
                if file.is_file():
                    stage[stream + "Sha256"] = hashlib.sha256(file.read_bytes()).hexdigest()
        report["outputBudget"] = {"limitBytes": output_budget.limit, "remainingBytes": output_budget.remaining,
                                  "exceeded": output_budget.exceeded}
        if retirement["initialPids"] or timed_out or cancelled or output_budget.exceeded or any(stage.get("outputErrors") for stage in report["stages"]):
            report.update(status="FAIL" if retirement["drained"] else "UNKNOWN", complete=False)
        if not retirement["drained"]:
            report.update(status="UNKNOWN", complete=False)
        report.update(wallSeconds=time.monotonic() - start, cancelled=cancelled, timedOut=timed_out,
                      cgroup={name: Path("/sys/fs/cgroup", name).read_text().strip() for name in
                              ("memory.max", "memory.peak", "memory.events", "cpu.max", "cpu.stat", "pids.max")})
        if re.search(r"^(oom|oom_kill) [1-9]", report["cgroup"]["memory.events"], re.M):
            report.update(status="FAIL", complete=False, reason="AFFECTED_CGROUP_OOM")
        if report["status"] == "PASS":
            try:
                recheck()
                report["lease"] = "RELEASE_PENDING"
                save()
                lease.release()
                report["lease"] = "RELEASED"
            except Exception as error:
                report.update(status="FAIL", complete=False, reason="FINAL_ADMISSION_OR_RELEASE:" + str(error))
        save()
    print(json.dumps({"status": report["status"], "complete": report["complete"], "report": str(DIRECTORY / "report.json")}))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
