#!/usr/bin/env python3
"""Read-only TestOps inventory, conservative affected plans and DAG simulation.

This prototype never executes a selected test or changes the accepted CI graph.
Unknown mappings widen selection and require review; a plan is never a test PASS.
The separate `volumes` subcommand (volumes.py) owns labelled Docker volume lifecycle.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
EXTENSIONS = {".ts", ".tsx", ".mjs", ".js", ".jsx", ".go", ".py", ".sh"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    # Caller Git overrides must not redirect inspection to a different index/tree.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_OPTIONAL_LOCKS="0", LC_ALL="C")
    return subprocess.check_output(["git", "-c", "core.fsmonitor=false", "-c",
                                    "core.hooksPath=/dev/null", "-C", str(root), *args], env=env)


def paths_from(raw):
    return sorted(set(x for x in raw.decode("utf-8").split("\0") if x))


def safe_path(value):
    path = PurePosixPath(value)
    if (not value or path.is_absolute() or ".." in path.parts or "\\" in value
            or any(ord(c) < 32 for c in value) or ".git" in path.parts):
        raise ValueError("INVALID_RELATIVE_PATH")
    return value


def source_files(root):
    files = paths_from(git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"))
    return [safe_path(p) for p in files]


def content(root, relative):
    safe_path(relative)
    path = root / relative
    # Never follow a source symlink out of the approved repository.
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("SOURCE_SYMLINK_UNSUPPORTED:" + relative)
    return path.read_bytes() if path.is_file() else b""


def _source_state(root):
    head = git(root, "rev-parse", "HEAD").decode().strip()
    object_format = git(root, "rev-parse", "--show-object-format").decode().strip()
    if object_format not in {"sha1", "sha256"}:
        raise ValueError("UNSUPPORTED_GIT_OBJECT_FORMAT")
    committed = {}
    for item in git(root, "ls-tree", "-r", "-z", "--full-tree", head).split(b"\0"):
        if item:
            metadata, path = item.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split(" ")
            if kind != "blob" or mode not in {"100644", "100755"}:
                raise ValueError("SOURCE_MODE_UNSUPPORTED")
            committed[safe_path(path.decode())] = (mode, oid)
    flags = git(root, "ls-files", "-v", "-z")
    dirty = bool(git(root, "status", "--porcelain=v1", "-z")) or any(
        not item.startswith(b"H ") for item in flags.split(b"\0") if item)
    files = source_files(root)
    entries = []
    physical_changes = set(files) ^ set(committed)
    for path in files:
        data = content(root, path)
        entries.append((path, digest(data)))
        expected = committed.get(path)
        if expected is None:
            dirty = True
            continue
        blob = hashlib.new(object_format)
        blob.update(b"blob " + str(len(data)).encode() + b"\0")
        blob.update(data)
        try:
            info = (root / path).lstat()
            mode = "100755" if info.st_mode & 0o111 else "100644"
            if not stat.S_ISREG(info.st_mode) or (mode, blob.hexdigest()) != expected:
                physical_changes.add(path)
        except FileNotFoundError:
            physical_changes.add(path)
    dirty |= bool(physical_changes)
    # A working digest identifies observed bytes, not membership in HEAD.
    # Reject hidden index flags and compare each regular blob/mode explicitly.
    dirty |= flags != git(root, "ls-files", "-v", "-z") or head != git(root, "rev-parse", "HEAD").decode().strip()
    return ({"head": head,
            "tree": git(root, "rev-parse", head + "^{tree}").decode().strip(),
            "workingSourceSha256": digest(json.dumps(entries, separators=(",", ":")).encode()),
            "dirty": dirty,
            "trackedAndUntrackedFiles": len(entries)}, sorted(physical_changes), flags)


def identity(root):
    return _source_state(root)[0]


def task_blocks(text, source):
    """Static block inventory, deliberately not a YAML or shell interpreter.

    Retains line/byte identity and unresolved shell expressions for later audit.
    Includes attributes cannot be treated as an executable Task dependency DAG.
    """
    lines = text.splitlines()
    active = False
    starts = []
    for i, line in enumerate(lines):
        if line == "tasks:":
            active = True
        elif active and line and not line[0].isspace() and not line.startswith("#"):
            active = False
        if active:
            match = re.fullmatch(r"  ([\w:.*-]+):\s*(?:#.*)?", line)
            if match:
                starts.append((i, match[1]))
    result = []
    for n, (start, name) in enumerate(starts):
        end = starts[n + 1][0] if n + 1 < len(starts) else len(lines)
        block = "\n".join(lines[start:end])
        calls = re.findall(r"^\s+- task:\s*['\"]?([\w:.-]+)", block, re.M)
        result.append({"name": name, "source": source, "line": start + 1,
                       "blockSha256": digest(block.encode()), "taskCalls": calls,
                       "block": block, "resolution": "STATIC_BLOCK_ONLY",
                       "effects": "NEEDS_REVIEW", "platform": "NEEDS_REVIEW",
                       "timeout": None, "resources": None})
    return result


def test_file(path):
    return bool(re.search(r"(_test\.go|\.(test|spec)\.[cm]?[jt]sx?|\.e2e\.mjs|\.selftest\.mjs)$", path)
                or re.search(r"(^|/)test_[^/]+\.py$", path))


def inventory(root):
    files = source_files(root)
    commands, scripts, workflows, tests = [], [], [], []
    for path in files:
        if Path(path).suffix not in EXTENSIONS | {".yml", ".yaml", ".json"}:
            continue
        if Path(path).name == "Taskfile.yml" or re.fullmatch(r"tasks/[^/]+\.ya?ml", path):
            commands.extend(task_blocks(content(root, path).decode(), path))
        if Path(path).name == "package.json":
            for name, command in json.loads(content(root, path)).get("scripts", {}).items():
                scripts.append({"source": path, "name": name, "command": command})
        if path.startswith(".github/workflows/") or path == ".gitlab-ci.yml":
            text = content(root, path).decode()
            workflows.append({"source": path, "sha256": digest(text.encode()),
                              "runners": re.findall(r"runs-on:\s*(.+)", text),
                              "status": "NOT_EXECUTED"})
        if test_file(path):
            text = content(root, path).decode()
            tests.append({"path": path, "sha256": digest(text.encode()),
                          "buildTags": re.findall(r"^//go:build (.+)", text, re.M),
                          "signals": sorted(set(re.findall(
                              r"sandbox-exec|darwin|Keychain|testcontainers|docker|localhost|127\.0\.0\.1|process\.platform|t\.Parallel|test\.skip", text))),
                          "platform": "NEEDS_REVIEW", "effects": "NEEDS_REVIEW"})
    return {"schema": 1, "kind": "static-command-inventory", "identity": identity(root),
            "acceptance": False, "tasks": commands, "npmScripts": scripts,
            "workflows": workflows, "testFiles": tests,
            "limitations": ["Task includes/namespaces and shell calls require semantic audit",
                            "Signals do not establish safety, platform support or gate membership",
                            "Direct shell/Python runners without test naming require manual audit"]}


def changed(root, base, head):
    def commit(ref):
        return git(root, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}").decode().strip()
    base_sha, head_sha = commit(base), commit(head)
    if head_sha != commit("HEAD"):
        raise ValueError("HEAD_MUST_MATCH_WORKING_SOURCE")
    flags = git(root, "ls-files", "-v", "-z")
    if any(not item.startswith(b"H ") for item in flags.split(b"\0") if item):
        raise ValueError("CHANGED_PATHS_HIDDEN_INDEX_FLAGS")
    merge_base = git(root, "merge-base", base_sha, head_sha).decode().strip()
    entries = {}
    queries = [("committed", ("diff", "--name-only", "-z", "--no-renames", merge_base, head_sha, "--")),
               ("staged", ("diff", "--cached", "--name-only", "-z", "--no-renames", head_sha, "--")),
               ("unstaged", ("diff", "--name-only", "-z", "--no-renames", "--")),
               ("untracked", ("ls-files", "--others", "--exclude-standard", "-z"))]
    for origin, args in queries:
        for path in paths_from(git(root, *args)):
            entries.setdefault(safe_path(path), []).append(origin)
    source, physical_changes, observed_flags = _source_state(root)
    if (source["head"] != head_sha or flags != observed_flags
            or flags != git(root, "ls-files", "-v", "-z")):
        raise ValueError("SOURCE_CHANGED_DURING_CHANGE_DISCOVERY")
    for path in physical_changes:
        entries.setdefault(path, []).append("physical-head-difference")
    return {"requestedBase": base_sha, "head": head_sha, "mergeBase": merge_base,
            "paths": [{"path": p, "origins": entries[p]} for p in sorted(entries)]}


def affected(root, changes):
    """Conservative import reachability; unsupported syntax always widens.

    No aliases, compiler flags, generated code or test ownership are guessed.
    Broader final source/native/package gates remain mandatory after selection.
    """
    files = source_files(root)
    tests = sorted(p for p in files if test_file(p))
    texts = {p: content(root, p).decode() for p in files if Path(p).suffix in EXTENSIONS}
    reverse = {}
    unresolved = []
    modules = {}
    for p in files:
        if Path(p).name == "go.mod":
            match = re.search(r"^module\s+(\S+)", content(root, p).decode(), re.M)
            if match:
                modules[str(PurePosixPath(p).parent)] = match[1]
    go_packages = {}
    for p in texts:
        if p.endswith(".go"):
            for directory, module in sorted(modules.items(), key=lambda item: -len(item[0])):
                parent = PurePosixPath(p).parent
                if directory == "." or parent.is_relative_to(directory):
                    suffix = str(parent.relative_to(directory))
                    go_packages.setdefault(module + ("/" + suffix if suffix != "." else ""), []).append(p)
                    break
    for path, text in texts.items():
        targets = []
        if path.endswith(".go"):
            literals = re.findall(r'"([^"\n]+)"', "\n".join(re.findall(
                r"(?m)^import\s+(?:\([\s\S]*?\)|[^\n]+)", text)))
            for literal in literals:
                targets.extend(go_packages.get(literal, []))
            # Any Go change affects its whole package, including sibling tests.
            targets.extend(p for p in texts if p.endswith(".go") and PurePosixPath(p).parent == PurePosixPath(path).parent)
        elif Path(path).suffix in {".ts", ".tsx", ".mjs", ".js", ".jsx"}:
            literals = re.findall(r'(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)[\'\"]([^\'\"]+)[\'\"]', text)
            for literal in literals:
                if literal.startswith("."):
                    stem = Path(os.path.normpath(str(PurePosixPath(path).parent / literal))).as_posix()
                    choices = [stem] + [stem + ext for ext in (".ts", ".tsx", ".mjs", ".js", ".jsx")] + [stem + "/index" + ext for ext in (".ts", ".tsx", ".js")]
                    if stem.endswith(".js"):
                        choices += [stem[:-3] + ".ts", stem[:-3] + ".tsx"]
                    found = [p for p in choices if p in texts]
                    if not found:
                        unresolved.append(path)
                    targets.extend(found)
                else:
                    # Package names may be aliases/workspace packages. No lock/compiler guess.
                    unresolved.append(path)
            if re.search(r"\b(?:import|require)\s*\(\s*[^'\"\s]", text):
                unresolved.append(path)
        for target in targets:
            reverse.setdefault(target, set()).add(path)
    selected = {}
    broaden = []
    for item in changes["paths"]:
        path = safe_path(item["path"])
        if path not in texts:
            broaden.append({"path": path, "reason": "NON_CODE_DELETED_OR_GENERATED_MAPPING"})
            continue
        reached, todo = set(), [path]
        while todo:
            current = todo.pop()
            if current in reached:
                continue
            reached.add(current)
            todo.extend(sorted(reverse.get(current, ())))
        mapped = sorted(set(tests) & reached)
        for test in mapped:
            selected.setdefault(test, []).append("reverse-import-or-package:" + path)
        # Textual reachability cannot prove absence of runtime/resource ownership.
        # Until an audited ownership ledger exists, widen all production changes.
        if not test_file(path) or not mapped:
            broaden.append({"path": path, "reason": "OWNERSHIP_NOT_YET_AUDITED"})
        if path.endswith("_test.go"):
            # The textual graph cannot see JS/TS tests that read Go source as
            # data, so a Go test change keeps every non-Go test, as the
            # compiler-derived route does.
            for consumer in tests:
                if not consumer.endswith(".go"):
                    broaden.append({"path": consumer, "reason": "GO_SOURCE_CONSUMER_OWNERSHIP_UNAUDITED"})
    if unresolved and changes["paths"]:
        broaden.append({"path": "*", "reason": "UNRESOLVED_IMPORTS", "files": sorted(set(unresolved))})
    if broaden:
        for test in tests:
            selected.setdefault(test, []).append("conservative-full-inventory")
    return {"schema": 1, "kind": "affected-plan-only", "status": "NEEDS_REVIEW" if broaden else "PLAN_ONLY",
            "acceptance": False, "executionAllowed": False, "changes": changes,
            "identity": identity(root), "selected": [{"path": p, "reasons": sorted(set(selected[p]))} for p in sorted(selected)],
            "broadened": broaden, "mandatoryFinalGates": ["ci", "applicable native/package/release acceptance"],
            "limitations": ["Textual import graph; ownership and non-language fixtures need audited adapters",
                            "All unknown cases widen; no selected execution is implemented"]}


def compiler_affected(root, changes, metadata):
    """Plan from source-bound native metadata, with conservative ownership fallback.

    Metadata is an iteration input, never an acceptance or execution capability.
    Production, generated, config and unknown ownership still widen completely.
    """
    files = source_files(root)
    hashes = {p: digest(content(root, p)) if (root / p).is_file() else None for p in files}
    source = metadata.get("source", {})
    if (metadata.get("schema") != 1 or metadata.get("kind") != "compiler-graph-plan-input"
            or metadata.get("acceptance") is not False or metadata.get("executionAllowed") is not False
            or source.get("head") != changes["head"] or source.get("files") != hashes):
        raise ValueError("COMPILER_METADATA_SOURCE_MISMATCH")
    typescript = metadata.get("typescript", {})
    if (typescript.get("compiler") != "typescript@7.0.2/unstable/sync"
            or not all(key in typescript for key in ("inputHashes", "edges", "gaps", "configs"))):
        raise ValueError("COMPILER_METADATA_VERSION_UNQUALIFIED")
    for p, expected in typescript.get("inputHashes", {}).items():
        if safe_path(p) not in hashes or hashes[p] != expected:
            raise ValueError("COMPILER_INPUT_MISMATCH")
    tests = sorted(p for p in files if test_file(p))
    reverse, go_owners = {}, {}
    for edge in typescript.get("edges", []):
        consumer, dependency = safe_path(edge["from"]), safe_path(edge["to"])
        if consumer not in hashes or dependency not in hashes:
            raise ValueError("COMPILER_EDGE_OUTSIDE_SOURCE")
        reverse.setdefault(dependency, set()).add(consumer)
    go = metadata.get("go")
    if go is not None:
        packages = {p["path"]: p for p in go["packages"]}
        if len(packages) != len(go["packages"]):
            raise ValueError("COMPILER_DUPLICATE_GO_PACKAGE")
        for name, package in packages.items():
            for p in package["files"]:
                safe_path(p)
                go_owners.setdefault(p, set()).add(name)
            for dependency in package["imports"]:
                if dependency in packages:
                    for p in packages[dependency]["files"]:
                        reverse.setdefault(p, set()).update(package["files"])
            for p in package["files"]:
                reverse.setdefault(p, set()).update(package["files"])
    selected, broadened = {}, []
    def include(seed, reason):
        pending, reached = [seed], set()
        while pending:
            p = pending.pop()
            if p in reached:
                continue
            reached.add(p)
            pending.extend(sorted(reverse.get(p, ())))
        for p in sorted(reached.intersection(tests)):
            selected.setdefault(p, set()).add(reason)
        return reached.intersection(tests)
    for item in changes["paths"]:
        p = safe_path(item["path"])
        if p.endswith("_test.go") and p in go_owners and not go.get("gaps"):
            include(p, "go-compiler-reverse-package:" + p)
            # A native package graph cannot prove which JS/TS tests read Go
            # source. Configured TS imports do not capture these file reads.
            for consumer in tests:
                if consumer not in go_owners:
                    broadened.append({"path": consumer, "reason": "GO_SOURCE_CONSUMER_OWNERSHIP_UNAUDITED"})
        elif (test_file(p) and p in typescript.get("inputHashes", {})
              and not p.endswith((".e2e.mjs", ".d.ts", ".d.mts"))):
            include(p, "typescript-native-reverse-import:" + p)
            for consumer in tests:
                if consumer not in typescript["inputHashes"] and consumer not in go_owners:
                    broadened.append({"path": consumer, "reason": "CONSUMER_OUTSIDE_COMPILER_PROJECTS"})
            for gap in typescript.get("gaps", []):
                owner = safe_path(gap["file"])
                if test_file(owner):
                    include(owner, "conservative-opaque-test-consumer:" + gap["reason"])
                else:
                    broadened.append({"path": owner, "reason": "OPAQUE_CONSUMER_OWNERSHIP_UNKNOWN"})
        else:
            broadened.append({"path": p, "reason": "PRODUCTION_GENERATED_CONFIG_OR_OWNERSHIP_UNAUDITED"})
    if changes["paths"]:
        for p in tests:
            if p.startswith(("tests/architecture/", "tests/contract/")):
                selected.setdefault(p, set()).add("source-introspection-contracts")
    if broadened:
        for p in tests:
            selected.setdefault(p, set()).add("conservative-full-inventory")
    if (source_files(root) != files or
            {p: digest(content(root, p)) if (root / p).is_file() else None for p in files} != hashes
            or git(root, "rev-parse", "HEAD").decode().strip() != changes["head"]):
        raise ValueError("COMPILER_PLAN_SOURCE_CHANGED")
    return {"schema": 1, "kind": "affected-plan-only", "status": "NEEDS_REVIEW" if broadened else "PLAN_ONLY",
            "acceptance": False, "executionAllowed": False, "changes": changes, "identity": identity(root),
            "adapter": "source-bound-native-compiler-metadata",
            "selected": [{"path": p, "reasons": sorted(selected[p])} for p in sorted(selected)],
            "broadened": broadened, "mandatoryChecks": ["applicable architecture/generated checks", "complete TypeScript checks for TS changes"],
            "mandatoryFinalGates": ["ci", "applicable native/package/release acceptance"],
            "limitations": ["Caller-selected metadata is a read-only iteration input, not a trusted acceptance receipt",
                            "No production or runtime-resource ownership narrowing is enabled",
                            "Go metadata targets arm64 Linux/macOS with declared native build tags; this does not execute those targets",
                            "Unconfigured scripts, generated/schema/config changes and unknown ownership widen completely",
                            "No selected execution is implemented"]}


def schedule(nodes, jobs):
    """Deterministic simulation; durations are estimates, never measurements."""
    if type(jobs) is not int or not 1 <= jobs <= 2:
        raise ValueError("JOBS_MUST_BE_1_OR_2")
    if not nodes or len({n["id"] for n in nodes}) != len(nodes):
        raise ValueError("EMPTY_OR_DUPLICATE_DAG")
    lookup = {n["id"]: n for n in nodes}
    for n in nodes:
        if (set(n) != {"id", "deps", "resources", "seconds"} or
                not isinstance(n["id"], str) or not n["id"] or
                not isinstance(n["deps"], list) or not isinstance(n["resources"], list) or
                any(not isinstance(x, str) or not x for x in n["deps"] + n["resources"]) or
                len(n["deps"]) != len(set(n["deps"])) or
                len(n["resources"]) != len(set(n["resources"])) or
                not set(n["deps"]) <= lookup.keys() or
                type(n["seconds"]) not in {int, float} or not 0 < n["seconds"] < 86400):
            raise ValueError("INVALID_DAG_NODE")
    done, running, result = set(), [], []
    now = 0
    while len(done) < len(nodes):
        held = set(r for _, _, resources in running for r in resources)
        for key in sorted(lookup):
            n = lookup[key]
            if (key in done or any(key == r[1] for r in running) or len(running) >= jobs or
                    not set(n["deps"]) <= done or held & set(n["resources"])):
                continue
            finish = now + n["seconds"]
            running.append((finish, key, n["resources"]))
            held.update(n["resources"])
            result.append({"id": key, "start": now, "end": finish})
        if not running:
            raise ValueError("DAG_CYCLE_OR_UNSATISFIED_DEPENDENCY")
        now = min(r[0] for r in running)
        done.update(r[1] for r in running if r[0] == now)
        running = [r for r in running if r[0] != now]
    return {"kind": "simulation-only", "measured": False, "jobs": jobs, "makespanSeconds": now,
            "schedule": result, "acceptance": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("inventory")
    plan = sub.add_parser("affected")
    plan.add_argument("--base", required=True)
    plan.add_argument("--head", default="HEAD")
    plan.add_argument("--explain", action="store_true", help="Reasons are always included")
    plan.add_argument("--compiler-metadata", type=Path,
                      help="Optional source-bound languagegraph.mjs output; iteration planning only")
    dag = sub.add_parser("dag")
    dag.add_argument("--manifest", type=Path, required=True)
    dag.add_argument("--jobs", type=int, default=1)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import volumes
    volumes.add_parser(sub)
    args = parser.parse_args()
    if args.command == "volumes":
        return volumes.command(args, args.root.resolve(strict=True))
    try:
        root = args.root.resolve(strict=True)
        if args.command == "inventory":
            result = inventory(root)
        elif args.command == "affected":
            changes = changed(root, args.base, args.head)
            result = (compiler_affected(root, changes, json.loads(args.compiler_metadata.read_text()))
                      if args.compiler_metadata else affected(root, changes))
        else:
            result = schedule(json.loads(args.manifest.read_text()), args.jobs)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 3 if result.get("status") == "NEEDS_REVIEW" else 0
    except (ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError) as error:
        print(json.dumps({"status": "BLOCKED", "acceptance": False, "reason": str(error)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
