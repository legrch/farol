"""Focused projection controls: data and argv only; no project/test processes."""
from copy import deepcopy
import unittest
import hashlib
import tempfile
from pathlib import Path

from affected_focused import focused_projection, focused_commands, POLICY
from affected_run import arguments, environment, stage_deadline, verify_evidence


class FocusedAdmission(unittest.TestCase):
    def test_original_log_and_validated_count_drift_or_redirection_cannot_pass(self):
        with tempfile.TemporaryDirectory(prefix="affected-original-evidence-") as name:
            directory = Path(name).resolve()
            file = directory / "child.stdout.log"
            file.write_bytes(b"original pipe bytes")
            expected = {file: hashlib.sha256(file.read_bytes()).hexdigest()}
            verify_evidence(expected)
            file.write_bytes(b"forged passing JSON")
            with self.assertRaisesRegex(ValueError, "EVIDENCE_CHANGED"):
                verify_evidence(expected)
            file.unlink()
            with file.open("wb") as stream:
                stream.truncate(32 * 1024**2 + 1)
            with self.assertRaisesRegex(ValueError, "EVIDENCE_CHANGED"):
                verify_evidence(expected)
            file.unlink()
            other = directory / "other"
            other.write_bytes(b"original pipe bytes")
            file.symlink_to(other)
            with self.assertRaisesRegex(ValueError, "EVIDENCE_CHANGED"):
                verify_evidence(expected)

    def test_route_requires_exact_explicit_flag_and_fixed_race_environment(self):
        self.assertEqual(arguments(["runner", "--base", "HEAD"]), ("HEAD", False))
        self.assertEqual(arguments(["runner", "--base", "HEAD", "--focused"]), ("HEAD", True))
        for argv in [["runner"], ["runner", "--base", "HEAD", "--command"],
                     ["runner", "--base", "HEAD", "--focused", "prod"], ["runner", "--base", ""]]:
            with self.assertRaisesRegex(ValueError, "EXPLICIT_BASE"):
                arguments(argv)
        env = environment(True)
        for key, value in {"CGO_ENABLED": "1", "GOOS": "linux", "GOARCH": "arm64", "GOFLAGS": "-mod=readonly -p=1"}.items():
            self.assertEqual(env[key], value)
        self.assertNotIn("CGO_ENABLED", environment())
        self.assertEqual(stage_deadline("compiler", True), 420)
        self.assertEqual(stage_deadline("compiler", False), 300)
        self.assertEqual(stage_deadline("focused-go", True), 600)
        self.assertEqual(stage_deadline("complete-core", False), 1800)
        self.assertEqual(stage_deadline("focused-go-validate", True), 30)

    def setUp(self):
        self.owned = POLICY["packages"][1]
        file = self.owned["files"][0]
        self.plan = {"kind": "affected-plan-only", "status": "PLAN_ONLY", "executionAllowed": False,
                     "acceptance": False, "broadened": [], "selected": [{"path": file}, {"path": "tests/unit/a.test.ts"}],
                     "changes": {"paths": [{"path": file}]}, "mandatoryFinalGates": ["ci", "native/package"]}
        self.suite = {"id": "node-cloud-01", "runner": "vitest", "cwd": ".", "workers": 2,
                      "timeoutMs": 300000, "files": ["tests/unit/a.test.ts", "tests/unit/unrelated.test.ts"]}
        self.cloud = {"version": 1, "scope": "cloud", "mixedSelections": [], "deferredFiles": [], "suites": [self.suite]}
        self.runtime = {"schema": 1, "kind": "go-runtime-plan-input", "acceptance": False, "executionAllowed": False,
                        "goos": "linux", "goarch": "arm64", "race": True, "cgo": "1", "tags": [],
                        "gaps": [], "packages": [{"path": self.owned["path"], "dir": self.owned["dir"],
                                                  "module": "go.mod", "testFiles": self.owned["files"]}],
                        "observations": [{"module": name, "discovery": "source-owned-package-directories"}
                                         for name in ["go.mod", "resources/native/go/go.mod"]]}
        self.metadata = {"go": {"gaps": [], "observations": [{"module": name} for name in ["go.mod", "resources/native/go/go.mod"]],
                                "packages": [{"files": self.owned["files"]}], "runtime": self.runtime}}

    def project(self):
        return focused_projection(self.plan, self.cloud, self.metadata)

    def test_exact_go_package_and_whole_selected_js_files_without_batch_extras(self):
        before = deepcopy((self.plan, self.cloud, self.metadata))
        result = self.project()
        self.assertEqual(result["goPackages"], [self.owned])
        self.assertEqual(result["suites"][0]["files"], ["tests/unit/a.test.ts"])
        self.assertFalse(result["executionAllowed"])
        self.assertFalse(result["acceptance"])
        self.assertEqual(result["mandatoryFinalGates"], self.plan["mandatoryFinalGates"])
        self.assertEqual((self.plan, self.cloud, self.metadata), before)
        steps = focused_commands(result)
        self.assertEqual(steps[0], ("focused-go", ["/usr/local/go/bin/go", "test", "-json", "-race", "-count=1",
                                                 "-p=1", "-parallel=2", "-timeout=180s", "./" + self.owned["dir"]]))
        self.assertEqual(steps[1][0], "focused-go-validate")
        self.assertNotIn("tests/unit/unrelated.test.ts", steps[2][1])
        self.assertNotIn("--testNamePattern", steps[2][1])
        result["goPackages"][0]["topLevelTests"].clear()
        self.assertTrue(self.project()["goPackages"][0]["topLevelTests"])

    def test_missing_or_wrong_runtime_context_refuses_before_preview(self):
        for key, value in [("schema", True), ("acceptance", 0), ("executionAllowed", True), ("goos", "darwin"),
                           ("goarch", "amd64"), ("race", 1), ("cgo", "0"), ("tags", ["farol_native_process"]),
                           ("gaps", None)]:
            with self.subTest(field=key):
                runtime = {**self.runtime, key: value}
                with self.assertRaisesRegex(ValueError, "RUNTIME_CONTEXT"):
                    focused_projection(self.plan, self.cloud, {"go": {**self.metadata["go"], "runtime": runtime}})
        del self.metadata["go"]["runtime"]
        with self.assertRaisesRegex(ValueError, "RUNTIME_CONTEXT"):
            self.project()

    def test_inactive_or_ignored_selected_test_is_not_a_go_pass(self):
        self.runtime["packages"][0]["testFiles"] = []
        self.runtime["packages"][0]["ignoredFiles"] = self.owned["files"]
        with self.assertRaisesRegex(ValueError, "ACTIVE_MEMBERSHIP"):
            self.project()

    def test_missing_added_or_duplicate_active_test_file_refuses(self):
        for files in [self.owned["files"] + [self.owned["dir"] + "/new_test.go"], self.owned["files"] * 2]:
            self.runtime["packages"][0]["testFiles"] = files
            with self.assertRaisesRegex(ValueError, "PACKAGE_UNQUALIFIED"):
                self.project()

    def test_unselected_active_sibling_file_cannot_be_dropped(self):
        row = POLICY["packages"][0]
        self.plan["selected"] = [{"path": row["files"][0]}]
        self.metadata["go"]["packages"] = [{"files": row["files"]}]
        self.runtime["packages"] = [{**row, "testFiles": row["files"]}]
        with self.assertRaisesRegex(ValueError, "PACKAGE_UNQUALIFIED"):
            self.project()

    def test_selected_package_gap_blocks_but_known_unselected_native_gap_stays_explicit(self):
        self.runtime["gaps"] = [{"package": self.owned["path"], "reason": "GO_RUNTIME_METADATA_INCOMPLETE"}]
        with self.assertRaisesRegex(ValueError, "PACKAGE_UNQUALIFIED"):
            self.project()
        native = "github.com/legrch/farol/tests/native/core"
        self.runtime["packages"].append({"path": native, "testFiles": [], "ignoredFiles": ["tests/native/core/native_test.go"]})
        self.runtime["gaps"] = [{"package": native, "reason": "GO_RUNTIME_METADATA_INCOMPLETE"}]
        self.assertEqual(self.project()["goPackages"], [self.owned])
        self.assertEqual(self.project()["unselectedRuntimeGaps"], self.runtime["gaps"])
        self.runtime["gaps"].append({"reason": "unlocated gap"})
        with self.assertRaisesRegex(ValueError, "GAP_UNQUALIFIED"):
            self.project()

    def test_changed_directory_module_duplicate_package_and_unknown_discovery_refuse(self):
        for key, value in [("dir", "elsewhere"), ("module", "resources/native/go/go.mod")]:
            with self.subTest(field=key):
                old = self.runtime["packages"][0]
                self.runtime["packages"] = [{**old, key: value}]
                with self.assertRaisesRegex(ValueError, "PACKAGE_UNQUALIFIED"):
                    self.project()
                self.runtime["packages"] = [old]
        self.runtime["packages"] *= 2
        with self.assertRaisesRegex(ValueError, "DUPLICATE"):
            self.project()
        self.runtime["packages"] = self.runtime["packages"][:1]
        self.runtime["observations"][0]["discovery"] = "external"
        with self.assertRaisesRegex(ValueError, "DISCOVERY_REQUIRED"):
            self.project()

    def test_unreviewed_go_package_cannot_reuse_an_admitted_file(self):
        self.runtime["packages"][0]["path"] = "github.com/legrch/farol/unreviewed"
        with self.assertRaisesRegex(ValueError, "PACKAGE_UNQUALIFIED"):
            self.project()

    def test_mixed_selector_and_duplicate_js_membership_still_refuse(self):
        self.suite["testNamePattern"] = "portable"
        with self.assertRaisesRegex(ValueError, "PARTIAL_OR_NATIVE"):
            self.project()
        del self.suite["testNamePattern"]
        self.cloud["suites"].append({**self.suite, "id": "node-cloud-02"})
        with self.assertRaisesRegex(ValueError, "JS_MEMBERSHIP_DUPLICATE"):
            self.project()

    def test_js_only_projection_keeps_type_checks_and_needs_no_go_runtime(self):
        self.plan["selected"] = [{"path": "tests/unit/a.test.ts"}]
        self.plan["changes"]["paths"] = self.plan["selected"]
        self.metadata["go"] = None
        result = self.project()
        self.assertEqual(result["goPackages"], [])
        self.assertEqual([name for name, _ in focused_commands(result)],
                         ["types-main", "types-renderer", "node-cloud-01", "node-cloud-01-validate"])


if __name__ == "__main__":
    unittest.main()
