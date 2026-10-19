"""Negative and parity tests for the isolated, non-executing TestOps pilot."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import shlex
import atexit
import unittest
from unittest.mock import patch

import testops
import measure


# Share only disposable tool caches; every fixture still has its own repository.
_git_environment = tempfile.TemporaryDirectory(prefix="testops-fixture-git-env-")
_git_home = Path(_git_environment.name) / "home"
_git_temporary = Path(_git_environment.name) / "tmp"
_git_home.mkdir()
_git_temporary.mkdir()
atexit.register(_git_environment.cleanup)


class FixtureIsolation(unittest.TestCase):
    def test_fixture_setup_cannot_follow_ambient_repository_or_index(self):
        self.exercise_hostile_fixture("repository")

    def test_fixture_setup_cannot_inherit_hooks_templates_or_signing(self):
        self.exercise_hostile_fixture("configuration")

    def exercise_hostile_fixture(self, mode):
        with tempfile.TemporaryDirectory(prefix="testops-fixture-git-isolation-") as folder:
            root = Path(folder).resolve(); victim = root / "victim"; victim.mkdir()
            env = {"PATH":"/usr/bin:/bin", "HOME":str(root), "TMPDIR":str(root), "LC_ALL":"C",
                   "GIT_CONFIG_NOSYSTEM":"1", "GIT_CONFIG_GLOBAL":os.devnull, "GIT_OPTIONAL_LOCKS":"0"}
            def own_git(*args):
                return subprocess.check_output(["/usr/bin/git", "-c", "core.hooksPath=/dev/null",
                    "-c", "commit.gpgSign=false", "-c", "init.templateDir=", "-c", "user.name=Victim Fixture",
                    "-c", "user.email=victim@example.invalid", "-C",str(victim),*args],env=env)
            own_git("init","-q");(victim/"tracked.txt").write_text("original\n")
            own_git("add",".");own_git("commit","-qm","fixture baseline")
            (victim/"tracked.txt").write_text("preserve unstaged\n")
            (victim/"staged.txt").write_text("preserve staged\n");own_git("add","staged.txt")
            (victim/"untracked.txt").write_text("preserve untracked\n")
            def seal():
                return {str(p.relative_to(victim)):testops.digest(p.read_bytes())
                        for p in victim.rglob('*') if p.is_file()}
            before = seal()
            hostile = dict(env)
            if mode == "repository":
                hostile.update(GIT_DIR=str(victim/".git"),GIT_WORK_TREE=str(victim),
                               GIT_COMMON_DIR=str(victim/".git"),GIT_INDEX_FILE=str(victim/".git/index"))
            else:
                hooks=root/"hostile-hooks";hooks.mkdir();template=root/"hostile-template";(template/"hooks").mkdir(parents=True)
                marker=root/"hook-ran";signer_marker=root/"signer-ran"
                hook="#!/bin/sh\nprintf ran > "+shlex.quote(str(marker))+"\nexit 0\n"
                for p in [hooks/"pre-commit",template/"hooks/pre-commit"]:p.write_text(hook);p.chmod(0o700)
                signer=root/"signer";signer.write_text("#!/bin/sh\nprintf ran > "+shlex.quote(str(signer_marker))+"\nexit 1\n");signer.chmod(0o700)
                config=root/"hostile.gitconfig"
                config.write_text("[core]\n hooksPath = "+json.dumps(str(hooks))+"\n[commit]\n gpgSign = true\n[gpg]\n program = "+json.dumps(str(signer))+"\n")
                hostile.update(GIT_CONFIG_GLOBAL=str(config),GIT_TEMPLATE_DIR=str(template),GIT_CONFIG_COUNT="3",
                    GIT_CONFIG_KEY_0="core.hooksPath",GIT_CONFIG_VALUE_0=str(hooks),
                    GIT_CONFIG_KEY_1="commit.gpgSign",GIT_CONFIG_VALUE_1="true",
                    GIT_CONFIG_KEY_2="gpg.program",GIT_CONFIG_VALUE_2=str(signer),
                    GIT_CONFIG_PARAMETERS="'commit.gpgsign=true'")
            fixture=Repository("test_no_changes_is_not_a_test_pass")
            try:
                with patch.dict(os.environ,hostile,clear=True):
                    fixture.setUp()
                    self.assertEqual(seal(),before)
                    self.assertEqual(Path(fixture.run_git("rev-parse","--show-toplevel").strip()),fixture.root.resolve())
                self.assertEqual(seal(),before)
                self.assertFalse((root/"hook-ran").exists())
                self.assertFalse((root/"signer-ran").exists())
            finally:
                fixture.doCleanups()


class Repository(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="testops-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run_git("init", "-q")
        self.run_git("config", "user.name", "Fixture")
        self.run_git("config", "user.email", "fixture@example.invalid")
        self.write("go.mod", "module example.invalid/demo\n\ngo 1.26\n")
        self.write("modules/a/value.go", 'package a\nfunc Value() int { return 1 }\n')
        self.write("modules/a/value_test.go", 'package a\nimport "testing"\nfunc TestValue(t *testing.T) {}\n')
        self.write("modules/b/use.go", 'package b\nimport "example.invalid/demo/modules/a"\n')
        self.write("modules/b/use_test.go", 'package b\nimport "testing"\nfunc TestUse(t *testing.T) {}\n')
        self.write("src/a.ts", "export const value = 1;\n")
        self.write("tests/a.test.ts", "import {value} from '../src/a.js';\n")
        self.write("Taskfile.yml", "version: '3'\ntasks:\n  ci:\n    cmds:\n      - task: test:unit\n  test:unit:\n    cmds:\n      - go test ./...\n")
        self.commit()
        self.base = self.run_git("rev-parse", "HEAD").strip()

    def run_git(self, *args):
        env = {"PATH":"/usr/bin:/bin", "HOME":str(_git_home), "TMPDIR":str(_git_temporary),
               "LC_ALL":"C", "GIT_CONFIG_NOSYSTEM":"1", "GIT_CONFIG_GLOBAL":os.devnull,
               "GIT_OPTIONAL_LOCKS":"0", "GIT_TERMINAL_PROMPT":"0"}
        return subprocess.check_output(["/usr/bin/git", "-c", "core.fsmonitor=false",
            "-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=",
            "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
            "-C", str(self.root), *args], env=env, text=True)

    def write(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)

    def commit(self):
        self.run_git("add", "--all")
        self.run_git("commit", "-qm", "fixture")

    def changes(self):
        return testops.changed(self.root, self.base, "HEAD")

    def plan(self):
        return testops.affected(self.root, self.changes())

    def test_inventory_retains_task_calls_and_all_tests(self):
        report = testops.inventory(self.root)
        self.assertEqual(len(report["testFiles"]), 3)
        self.assertEqual(report["tasks"][0]["taskCalls"], ["test:unit"])
        self.assertFalse(report["acceptance"])
        self.assertEqual(report["tasks"][0]["resolution"], "STATIC_BLOCK_ONLY")

    def test_no_changes_is_not_a_test_pass(self):
        plan = self.plan()
        self.assertEqual(plan["status"], "PLAN_ONLY")
        self.assertEqual(plan["selected"], [])
        self.assertFalse(plan["executionAllowed"])

    def test_staged_unstaged_untracked_and_committed_union(self):
        self.write("src/a.ts", "export const value = 2;\n")
        self.commit()
        self.write("modules/a/value.go", "package a\n")
        self.run_git("add", "modules/a/value.go")
        self.write("modules/b/use.go", "package b\n")
        self.write("new-schema.json", "{}")
        origins = {x["path"]: x["origins"] for x in self.changes()["paths"]}
        self.assertIn("committed", origins["src/a.ts"])
        self.assertIn("staged", origins["modules/a/value.go"])
        self.assertIn("unstaged", origins["modules/b/use.go"])
        self.assertIn("untracked", origins["new-schema.json"])

    def test_rename_and_delete_preserve_old_and_new_paths(self):
        self.run_git("mv", "src/a.ts", "src/moved.ts")
        self.run_git("rm", "modules/a/value.go")
        self.assertEqual({x["path"] for x in self.changes()["paths"]},
                         {"src/a.ts", "src/moved.ts", "modules/a/value.go"})
        self.assertEqual(self.plan()["status"], "NEEDS_REVIEW")

    def test_unknown_and_schema_broaden_to_every_test(self):
        for path in ("new-schema.json", "new.file"):
            self.write(path, "{}")
        plan = self.plan()
        self.assertEqual(len(plan["selected"]), 3)
        self.assertEqual(plan["status"], "NEEDS_REVIEW")

    def test_go_reverse_import_reasons_without_tool_execution(self):
        self.write("modules/a/value.go", "package a\n")
        plan = self.plan()
        reasons = {x["path"]: x["reasons"] for x in plan["selected"]}
        self.assertIn("reverse-import-or-package:modules/a/value.go", reasons["modules/b/use_test.go"])
        self.assertFalse(plan["executionAllowed"])

    def test_typescript_js_extension_maps_to_typescript_source(self):
        self.write("src/a.ts", "export const value = 2;\n")
        row = next(x for x in self.plan()["selected"] if x["path"] == "tests/a.test.ts")
        self.assertIn("reverse-import-or-package:src/a.ts", row["reasons"])

    def compiler_metadata(self):
        hashes = {p: testops.digest(testops.content(self.root, p))
                  if (self.root / p).is_file() else None for p in testops.source_files(self.root)}
        return {"schema": 1, "kind": "compiler-graph-plan-input", "acceptance": False,
                "executionAllowed": False, "source": {"head": self.base, "files": hashes},
                "typescript": {"compiler": "typescript@7.0.2/unstable/sync", "configs": [],
                               "inputHashes": {p: h for p, h in hashes.items() if p.endswith(".ts")},
                               "edges": [{"from": "tests/a.test.ts", "to": "src/a.ts"}], "gaps": []},
                "go": {"gaps": [], "packages": [
                    {"path": "example.invalid/demo/modules/a", "dir": "modules/a",
                     "files": ["modules/a/value.go", "modules/a/value_test.go"], "imports": []},
                    {"path": "example.invalid/demo/modules/b", "dir": "modules/b",
                     "files": ["modules/b/use.go", "modules/b/use_test.go"],
                     "imports": ["example.invalid/demo/modules/a"]}]}}

    def test_native_go_test_change_does_not_widen_for_unrelated_typescript_aliases(self):
        (self.root / "tests/a.test.ts").unlink()
        self.commit()
        self.base = self.run_git("rev-parse", "HEAD").strip()
        self.write("modules/a/value_test.go", 'package a\nimport "testing"\nfunc TestOther(t *testing.T) {}\n')
        metadata = self.compiler_metadata()
        metadata["typescript"]["edges"] = []
        metadata["typescript"]["gaps"] = [{"file": "src/a.ts", "reason": "DYNAMIC_IMPORT"}]
        plan = testops.compiler_affected(self.root, self.changes(), metadata)
        self.assertEqual(plan["status"], "PLAN_ONLY")
        self.assertEqual({p["path"] for p in plan["selected"]},
                         {"modules/a/value_test.go", "modules/b/use_test.go"})
        self.assertFalse(plan["executionAllowed"])

    def exercise_go_source_consumer(self, extension):
        consumer = "tests/source-consumer.test." + extension
        self.write(consumer, 'import fs from "node:fs";\n'
                   'const text = fs.readFileSync("modules/a/value_test.go", "utf8");\n'
                   'if (/^func TestMain\\(/m.test(text)) throw new Error("TEST_MAIN_NOT_ADMITTED");\n')
        self.commit()
        self.base = self.run_git("rev-parse", "HEAD").strip()
        self.write("modules/a/value_test.go", 'package a\nimport "testing"\n'
                   'func TestValue(t *testing.T) {}\nfunc TestMain(m *testing.M) { m.Run() }\n')
        changes = self.changes()
        self.assertEqual([row["path"] for row in changes["paths"]], ["modules/a/value_test.go"])
        plan = testops.compiler_affected(self.root, changes, self.compiler_metadata())
        self.assertEqual(plan["status"], "NEEDS_REVIEW")
        self.assertEqual({row["path"] for row in plan["selected"]},
                         {p for p in testops.source_files(self.root) if testops.test_file(p)})
        self.assertIn({"path": consumer, "reason": "GO_SOURCE_CONSUMER_OWNERSHIP_UNAUDITED"}, plan["broadened"])

    def test_go_test_change_retains_unconfigured_javascript_source_consumer(self):
        self.exercise_go_source_consumer("mjs")

    def test_go_test_change_retains_configured_typescript_source_consumer(self):
        self.exercise_go_source_consumer("ts")

    def test_native_ts_test_plan_adds_opaque_consumers_and_reverse_importers(self):
        self.write("tests/a.test.ts", "export const caseName = 'changed';\n")
        self.write("tests/opaque.test.ts", "import(target);\n")
        self.write("tests/consumer.test.ts", "import './a.test';\n")
        metadata = self.compiler_metadata()
        metadata["typescript"]["edges"].append({"from": "tests/consumer.test.ts", "to": "tests/a.test.ts"})
        metadata["typescript"]["gaps"] = [{"file": "tests/opaque.test.ts", "reason": "DYNAMIC_IMPORT"}]
        plan = testops.compiler_affected(self.root, self.changes(), metadata)
        self.assertEqual(plan["status"], "PLAN_ONLY")
        self.assertEqual({p["path"] for p in plan["selected"]},
                         {"tests/a.test.ts", "tests/consumer.test.ts", "tests/opaque.test.ts"})

    def test_native_metadata_production_schema_and_missing_go_still_widen(self):
        for p, contents in [("modules/a/value.go", "package a\n"), ("schema.json", "{}")]:
            self.write(p, contents)
        plan = testops.compiler_affected(self.root, self.changes(), self.compiler_metadata())
        self.assertEqual(plan["status"], "NEEDS_REVIEW")
        self.assertEqual(len(plan["selected"]), 3)
        self.write("modules/a/value_test.go", "package a\n")
        metadata = self.compiler_metadata(); metadata["go"] = None
        self.assertEqual(testops.compiler_affected(self.root, self.changes(), metadata)["status"], "NEEDS_REVIEW")

    def test_unchanged_consumer_outside_compiler_project_prevents_narrowing(self):
        self.write("tests/consumer.test.mjs", "import './a.test.ts';\n")
        self.commit()
        self.base = self.run_git("rev-parse", "HEAD").strip()
        self.write("tests/a.test.ts", "export const changed = 2;\n")
        changes = self.changes()
        self.assertEqual([row["path"] for row in changes["paths"]], ["tests/a.test.ts"])
        plan = testops.compiler_affected(self.root, changes, self.compiler_metadata())
        self.assertEqual(plan["status"], "NEEDS_REVIEW")
        self.assertEqual({p["path"] for p in plan["selected"]},
                         {p for p in testops.source_files(self.root) if testops.test_file(p)})
        self.assertIn({"path": "tests/consumer.test.mjs", "reason": "CONSUMER_OUTSIDE_COMPILER_PROJECTS"}, plan["broadened"])

    def test_native_metadata_stale_incomplete_and_redirected_inputs_block(self):
        metadata = self.compiler_metadata()
        self.write("src/a.ts", "export const changed = 1;\n")
        with self.assertRaisesRegex(ValueError, "SOURCE_MISMATCH"):
            testops.compiler_affected(self.root, self.changes(), metadata)
        metadata = self.compiler_metadata(); del metadata["typescript"]["edges"]
        with self.assertRaisesRegex(ValueError, "VERSION_UNQUALIFIED"):
            testops.compiler_affected(self.root, self.changes(), metadata)
        metadata = self.compiler_metadata(); metadata["typescript"]["edges"].append({"from": "../escape", "to": "src/a.ts"})
        with self.assertRaisesRegex(ValueError, "INVALID_RELATIVE_PATH"):
            testops.compiler_affected(self.root, self.changes(), metadata)

    def test_native_metadata_incomplete_go_cannot_select_only_its_package(self):
        self.write("modules/a/value_test.go", "package a\n")
        metadata = self.compiler_metadata(); metadata["go"]["gaps"] = [{"reason": "GO_METADATA_INCOMPLETE"}]
        plan = testops.compiler_affected(self.root, self.changes(), metadata)
        self.assertEqual(plan["status"], "NEEDS_REVIEW")
        self.assertEqual(len(plan["selected"]), 3)

    def test_native_plan_refuses_source_drift_during_dependency_walk(self):
        self.write("tests/a.test.ts", "export const selected = 1;\n")
        metadata = self.compiler_metadata()
        write = self.write
        class DriftingMetadata(dict):
            def get(self, key, default=None):
                if key == "go":
                    write("src/a.ts", "export const changedDuringPlan = 1;\n")
                return super().get(key, default)
        with self.assertRaisesRegex(ValueError, "SOURCE_CHANGED"):
            testops.compiler_affected(self.root, self.changes(), DriftingMetadata(metadata))

    def test_unresolved_alias_and_dynamic_import_never_narrow(self):
        self.write("tests/alias.test.ts", "import {x} from '@app/a'; import(target);\n")
        plan = self.plan()
        self.assertEqual(plan["status"], "NEEDS_REVIEW")
        self.assertEqual(len(plan["selected"]), 4)

    def test_new_unregistered_test_is_visible(self):
        self.write("tests/new.test.ts", "const value = 1;\n")
        self.assertIn("tests/new.test.ts", [x["path"] for x in self.plan()["selected"]])

    def test_invalid_base_blocks(self):
        with self.assertRaises(subprocess.CalledProcessError):
            testops.changed(self.root, "missing-reference", "HEAD")

    def test_old_head_does_not_claim_current_graph(self):
        self.write("src/a.ts", "export const value = 3;\n")
        self.commit()
        with self.assertRaisesRegex(ValueError, "HEAD_MUST_MATCH"):
            testops.changed(self.root, self.base, self.base)

    def test_git_environment_cannot_redirect_inventory(self):
        with patch.dict(os.environ, {"GIT_INDEX_FILE": "/nonexistent/index", "GIT_WORK_TREE": "/nonexistent"}):
            self.assertEqual(testops.identity(self.root)["head"], self.base)

    def test_source_edit_changes_snapshot(self):
        before = testops.identity(self.root)
        self.write("src/a.ts", "export const value = 4;\n")
        self.assertNotEqual(before["workingSourceSha256"], testops.identity(self.root)["workingSourceSha256"])

    def test_hidden_index_flags_do_not_admit_modified_committed_source(self):
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag):
                self.run_git("update-index", flag, "src/a.ts")
                self.write("src/a.ts", "process.exit(0);\n")
                self.assertEqual(self.run_git("status", "--porcelain=v1"), "")
                self.assertTrue(testops.identity(self.root)["dirty"])
                self.run_git("update-index", "--no-assume-unchanged", "src/a.ts")
                self.run_git("update-index", "--no-skip-worktree", "src/a.ts")
                self.run_git("checkout", "--", "src/a.ts")

    def test_hidden_executable_mode_does_not_admit_committed_source(self):
        self.run_git("config", "core.filemode", "false")
        (self.root / "src/a.ts").chmod(0o755)
        self.assertEqual(self.run_git("status", "--porcelain=v1"), "")
        self.assertTrue(testops.identity(self.root)["dirty"])

    def test_unchanged_flagged_file_is_not_accepted_as_clean(self):
        self.run_git("update-index", "--skip-worktree", "src/a.ts")
        self.assertEqual(self.run_git("status", "--porcelain=v1"), "")
        self.assertTrue(testops.identity(self.root)["dirty"])

    def test_affected_refuses_changes_hidden_by_index_flags(self):
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag):
                self.run_git("update-index", flag, "src/a.ts")
                self.write("src/a.ts", "export const value = 4;\n")
                self.assertEqual(self.run_git("status", "--porcelain=v1"), "")
                with self.assertRaisesRegex(ValueError, "HIDDEN_INDEX_FLAGS"):
                    self.plan()
                self.run_git("update-index", "--no-assume-unchanged", "src/a.ts")
                self.run_git("update-index", "--no-skip-worktree", "src/a.ts")
                self.run_git("checkout", "--", "src/a.ts")

    def test_hidden_mode_change_is_retained_alongside_an_ordinary_edit(self):
        self.run_git("config", "core.filemode", "false")
        (self.root / "src/a.ts").chmod(0o755)
        self.write("tests/a.test.ts", "import {value} from '../src/a.js'; // edited\n")
        changes = self.changes()
        by_path = {row["path"]: row["origins"] for row in changes["paths"]}
        self.assertIn("physical-head-difference", by_path["src/a.ts"])
        self.assertIn("unstaged", by_path["tests/a.test.ts"])
        self.assertTrue(self.plan()["selected"])

    def test_hidden_mode_change_without_other_edits_is_not_an_empty_plan(self):
        self.run_git("config", "core.filemode", "false")
        (self.root / "src/a.ts").chmod(0o755)
        self.assertEqual(self.run_git("status", "--porcelain=v1"), "")
        self.assertEqual([row["path"] for row in self.changes()["paths"]], ["src/a.ts"])
        self.assertTrue(self.plan()["selected"])

    def test_symlink_does_not_read_outside_repository(self):
        (self.root / "tests/escape.test.ts").symlink_to("/etc/passwd")
        with self.assertRaisesRegex(ValueError, "SOURCE_SYMLINK"):
            testops.inventory(self.root)

    def test_bad_paths_rejected(self):
        for value in ("", "../x", "/tmp/x", "a\\b", "a\nx", ".git/config"):
            with self.assertRaises(ValueError):
                testops.safe_path(value)

    def test_cli_has_no_remote_or_execute_switch(self):
        script = Path(testops.__file__)
        for option in ("--execute", "--target=prod", "--target=dev"):
            child = subprocess.run(["python3", "-B", str(script), "--root", str(self.root),
                                    "affected", "--base", self.base, option], capture_output=True)
            self.assertNotEqual(child.returncode, 0)


class Schedule(unittest.TestCase):
    def node(self, name, deps=(), resources=(), seconds=1):
        return dict(id=name, deps=list(deps), resources=list(resources), seconds=seconds)

    def test_safe_parallel_branches_join(self):
        result = testops.schedule([self.node("a"), self.node("b"), self.node("c", ["a", "b"])], 2)
        self.assertEqual(result["makespanSeconds"], 2)
        self.assertFalse(result["measured"])

    def test_shared_artifact_or_port_serializes(self):
        nodes = [self.node("a", resources=["artifact", "port:1234"]), self.node("b", resources=["artifact"])]
        self.assertEqual(testops.schedule(nodes, 2)["makespanSeconds"], 2)

    def test_cycles_missing_dependency_and_duplicate_fail(self):
        for nodes in ([self.node("a", ["a"])], [self.node("a", ["b"])], [self.node("a"), self.node("a")], []):
            with self.assertRaises(ValueError):
                testops.schedule(nodes, 2)

    def test_unknown_resources_or_durations_are_not_free(self):
        for node in (dict(id="a", deps=[], seconds=1), self.node("a", seconds=None), self.node("a", seconds=float("nan"))):
            with self.assertRaises(ValueError):
                testops.schedule([node], 2)

    def test_fanout_is_bounded(self):
        for value in (0, 3, True):
            with self.assertRaises(ValueError):
                testops.schedule([self.node("a")], value)


class Measurement(unittest.TestCase):
    def test_cancel_during_log_setup_leaves_measurement_child_unissued(self):
        with tempfile.TemporaryDirectory(prefix="testops-measure-cancel-") as folder:
            original = Path.open
            def open_file(path, *args, **kwargs):
                handle = original(path, *args, **kwargs)
                if path.name == "cancelled.log":
                    measure.STOP.set()
                return handle
            measure.STOP.clear()
            try:
                with patch.object(Path, "open", new=open_file), \
                        patch("bounded_capture.subprocess.Popen", side_effect=AssertionError("cancelled child must remain unissued")) as launch:
                    result = measure.run_probe(("cancelled", ["NOT_EXECUTED"]), Path(folder), None)
                    self.assertEqual(result["status"], "NOT_RUN")
                    self.assertEqual(result["reason"], "CANCELLED")
                    launch.assert_not_called()
            finally:
                measure.STOP.clear()

    def test_impersonating_node_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            fake = Path(folder) / "node"
            fake.write_text("#!/bin/sh\necho v26.7.0\n")
            fake.chmod(0o700)
            with self.assertRaisesRegex(ValueError, "NODE_BINARY_DIGEST_MISMATCH"):
                measure.trusted_node(fake, "0" * 64)

    def test_selected_node_digest_is_validated(self):
        with tempfile.TemporaryDirectory() as folder:
            selected = Path(folder) / "selected"
            selected.write_bytes(b"independently approved fixture executable")
            expected = testops.digest(selected.read_bytes())
            self.assertEqual(measure.trusted_node(selected, expected), selected.resolve())
            selected.write_bytes(b"changed with the same claimed version")
            with self.assertRaisesRegex(ValueError, "DIGEST_MISMATCH"):
                measure.trusted_node(selected, expected)

    def test_ignored_go_input_changes_measurement_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "artifacts").mkdir()
            first = measure.architecture_inputs(root)
            (root / "artifacts/extra.go").write_text("package extra\n")
            second = measure.architecture_inputs(root)
            (root / "artifacts/extra.go").write_text("package changed\n")
            third = measure.architecture_inputs(root)
            self.assertNotEqual(first, second)
            self.assertNotEqual(second, third)
            (root / "_output").mkdir()
            (root / "_output/ignored.go").write_text("excluded by the actual checker")
            self.assertEqual(third, measure.architecture_inputs(root))

    def test_nested_module_and_symlink_match_checker_policy(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "resources/native/go").mkdir(parents=True)
            (root / "resources/native/go/go.mod").write_text("module fixture")
            (root / "resources/native/go/excluded.go").write_text("excluded nested module")
            first = measure.architecture_inputs(root)
            (root / "resources/native/go/excluded.go").write_text("still excluded")
            self.assertEqual(first, measure.architecture_inputs(root))
            (root / "escape.go").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "ARCHITECTURE_SOURCE_SYMLINK"):
                measure.architecture_inputs(root)

    def baseline(self):
        source = {"head": "a" * 40, "dirty": False}
        return dict(schema=1, jobs=1, status="PASS", identity=source, finalIdentity=source,
                    sourceUnchanged=True, node={"path": "/fixture/node", "version": "v26.7.0"},
                    python="fixture", platform="fixture", probeSetSha256="fixture",
                    rounds=[{"leaves": [dict(id=name, status="PASS", exitCode=0,
                            wallSeconds=0.1, terminationRequested=False)
                            for name, _ in measure.probes(Path("/fixture/node"))]}])

    def test_incomplete_or_failed_baseline_cannot_enable_parallel(self):
        for mutation in ("missing", "duplicate", "failed", "changed"):
            baseline = self.baseline()
            current = self.baseline()
            if mutation == "missing":
                baseline["rounds"][0]["leaves"].pop()
            elif mutation == "duplicate":
                baseline["rounds"][0]["leaves"][1]["id"] = "docs-links"
            elif mutation == "failed":
                baseline["rounds"][0]["leaves"][0]["status"] = "FAIL"
            else:
                baseline["sourceUnchanged"] = False
            with self.assertRaisesRegex(ValueError, "BASELINE_INCOMPLETE"):
                measure.validate_comparison(baseline, current)

    def test_mismatched_source_or_toolchain_blocks(self):
        for field in ("identity", "node", "python", "platform", "probeSetSha256"):
            baseline = self.baseline()
            current = self.baseline()
            current[field] = "changed"
            with self.assertRaisesRegex(ValueError, "MISMATCH"):
                measure.validate_comparison(baseline, current)

    def test_exact_baseline_is_comparable(self):
        measure.validate_comparison(self.baseline(), self.baseline())

    def test_environment_drops_provider_and_node_injection(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-not-a-secret", "NODE_OPTIONS": "--require=unsafe", "GIT_DIR": "/redirect"}):
            env = measure.environment(Path("/fixture/node"))
        for key in ("OPENAI_API_KEY", "NODE_OPTIONS", "GIT_DIR"):
            self.assertNotIn(key, env)


if __name__ == "__main__":
    unittest.main()
