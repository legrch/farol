"""Bounded affected projection for the opt-in inner Linux route.

Only four audited Go packages and whole selected portable Vitest files qualify.
The original core and public affected commands keep their existing behavior.
"""
import json
from pathlib import Path

from affected_run import projection, NODE, DIRECTORY

POLICY = json.loads(Path(__file__).with_name("affected-go-policy.json").read_text())


def focused_projection(plan, cloud, metadata):
    coarse = projection(plan, cloud, metadata)
    selected = set(coarse["selectedFiles"])
    go = {file for file in selected if file.endswith("_test.go")}
    packages = []
    if go:
        runtime = metadata.get("go", {}).get("runtime", {})
        if any(type(runtime.get(key)) is not type(value) or runtime.get(key) != value for key, value in {
            "schema": 1, "kind": "go-runtime-plan-input", "acceptance": False,
            "executionAllowed": False, "goos": "linux", "goarch": "arm64",
            "race": True, "cgo": "1", "tags": [],
        }.items()) or not isinstance(runtime.get("gaps"), list):
            raise ValueError("AFFECTED_FOCUSED_RUNTIME_CONTEXT_REQUIRED")
        observations = runtime.get("observations", [])
        if (len(observations) != 2 or
                {row.get("module") for row in observations} != {"go.mod", "resources/native/go/go.mod"} or
                any(row.get("discovery") != "source-owned-package-directories" for row in observations)):
            raise ValueError("AFFECTED_FOCUSED_RUNTIME_DISCOVERY_REQUIRED")
        admitted = {row["path"]: row for row in POLICY["packages"]}
        runtime_packages = runtime.get("packages", [])
        runtime_paths = {row.get("path") for row in runtime_packages}
        if any(gap.get("package") not in runtime_paths or gap.get("reason") not in {
            "GO_RUNTIME_METADATA_INCOMPLETE", "GO_RUNTIME_CGO_OR_SWIG_UNQUALIFIED",
        } for gap in runtime["gaps"]):
            raise ValueError("AFFECTED_FOCUSED_RUNTIME_GAP_UNQUALIFIED")
        covered = set()
        paths = set()
        for row in runtime_packages:
            path = row.get("path")
            if path in paths:
                raise ValueError("AFFECTED_FOCUSED_RUNTIME_PACKAGE_DUPLICATE")
            paths.add(path)
            files = row.get("testFiles", [])
            if not go.intersection(files):
                continue
            owned = admitted.get(path)
            if (not owned or row.get("module") != owned["module"] or row.get("dir") != owned["dir"] or
                    not isinstance(files, list) or len(files) != len(set(files)) or
                    sorted(files) != owned["files"] or not set(files) <= go or
                    any(gap.get("package") == path for gap in runtime["gaps"])):
                raise ValueError("AFFECTED_FOCUSED_GO_PACKAGE_UNQUALIFIED")
            packages.append({**owned, "files": list(owned["files"]), "topLevelTests": list(owned["topLevelTests"])})
            covered.update(files)
        if go != covered:
            raise ValueError("AFFECTED_FOCUSED_GO_ACTIVE_MEMBERSHIP_REQUIRED")
    # Preserve ordinary registry membership/config checks from the coarse route,
    # then run each selected file in full. No mixed regex is admitted here.
    suites = [{**suite, "files": [file for file in suite["files"] if file in selected]}
              for suite in coarse["suites"]]
    if sum(len(suite["files"]) for suite in suites) != len(selected - go):
        raise ValueError("AFFECTED_FOCUSED_JS_MEMBERSHIP_DUPLICATE")
    return {"schema": 1, "kind": "bounded-affected-projection-prototype", "acceptance": False,
            "executionAllowed": False, "selectedFiles": coarse["selectedFiles"],
            "goPackages": sorted(packages, key=lambda row: row["path"]), "suites": suites,
            "unselectedRuntimeGaps": [dict(gap) for gap in metadata["go"]["runtime"]["gaps"]] if go else [],
            "typescriptChecks": coarse["typescriptChecks"],
            "mandatoryFinalGates": coarse["mandatoryFinalGates"],
            "limits": ["Opt-in inner route only; no external plan or command authority",
                       "Complete selected ordinary JS files and four audited Go packages only",
                       "Full core/CI/native/package/release requirements remain separate"]}


def focused_commands(projected):
    """Fixed argv preview only. Nothing in this module launches a child."""
    result = []
    if projected["typescriptChecks"]:
        result.extend([("types-main", [NODE, "node_modules/typescript/bin/tsc", "--noEmit"]),
                       ("types-renderer", [NODE, "node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.renderer.json"])])
    if projected["goPackages"]:
        result.append(("focused-go", ["/usr/local/go/bin/go", "test", "-json", "-race", "-count=1",
                                      "-p=1", "-parallel=2", "-timeout=180s",
                                      *("./" + row["dir"] for row in projected["goPackages"])]))
        result.append(("focused-go-validate", [NODE, "tooling/testops/affected-focused.mjs", "validate-go",
                                               json.dumps([row["path"] for row in projected["goPackages"]], separators=(",", ":"))]))
    for suite in projected["suites"]:
        name = suite["id"]
        result.append((name, [NODE, "/workspace/node_modules/vitest/vitest.mjs", "run", *suite["files"],
                             "--pool=threads", "--maxWorkers=2", "--reporter=default", "--reporter=json",
                             "--outputFile.json=" + str(DIRECTORY / (name + ".json"))]))
        result.append((name + "-validate", [NODE, "tooling/testops/affected-inputs.mjs", "validate", name,
                                            json.dumps(suite["files"], separators=(",", ":"))]))
    return result
