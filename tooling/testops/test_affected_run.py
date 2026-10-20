"""Admission controls for the fixed inner runner; no Docker or product effects."""
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
from types import SimpleNamespace

from affected_run import projection, commands, environment, private_container, acquire_attempt
from dag import Lease


class AffectedAdmission(unittest.TestCase):
    def setUp(self):
        self.plan = {"kind": "affected-plan-only", "status": "PLAN_ONLY", "executionAllowed": False,
                     "acceptance": False, "broadened": [], "selected": [{"path": "tests/unit/a.test.ts"}],
                     "changes": {"paths": [{"path": "tests/unit/a.test.ts"}]},
                     "mandatoryFinalGates": ["ci", "applicable native/package/release acceptance"]}
        self.suite = {"id": "node-cloud-01", "runner": "vitest", "cwd": ".", "workers": 2,
                      "timeoutMs": 300000, "files": ["tests/unit/a.test.ts", "tests/unit/unrelated.test.mjs"]}
        self.cloud = {"version": 1, "scope": "cloud", "mixedSelections": [], "deferredFiles": [], "suites": [self.suite]}
        self.metadata = {"go": {"gaps": [], "observations": [{"module": "go.mod"}, {"module": "resources/native/go/go.mod"}],
                                "packages": [{"files": ["modules/chat/domain/policy_test.go"]}]}}

    def project(self):
        return projection(self.plan, self.cloud, self.metadata)

    def test_narrow_selection_widens_to_complete_unchanged_portable_batch(self):
        result = self.project()
        self.assertEqual(result["suites"], [self.suite])
        self.assertFalse(result["acceptance"])
        self.assertTrue(result["typescriptChecks"])
        self.assertEqual(result["mandatoryFinalGates"], self.plan["mandatoryFinalGates"])
        issued = commands(result)
        self.assertEqual([name for name, _ in issued], ["types-main", "types-renderer", "node-cloud-01", "node-cloud-01-validate"])
        self.assertIn("tests/unit/unrelated.test.mjs", issued[2][1])
        self.assertNotIn("--testNamePattern", issued[2][1])

    def test_go_keeps_complete_core_plus_all_selected_javascript_contracts(self):
        self.plan["selected"].append({"path": "modules/chat/domain/policy_test.go"})
        self.plan["changes"]["paths"] = [{"path": "modules/chat/domain/policy_test.go"}]
        result = self.project()
        self.assertTrue(result["completeCore"])
        self.assertFalse(result["typescriptChecks"])
        issued = commands(result)
        self.assertEqual(issued[0], ("complete-core", ["/testops-seed/testops/linux-tools-bootstrap-03/bin/task", "test:core"]))
        self.assertEqual(issued[1][0], "complete-core-validate")
        self.assertEqual(issued[2][0], self.suite["id"])

    def test_go_only_can_execute_core_without_dropping_javascript_by_accident(self):
        self.plan["selected"] = [{"path": "modules/chat/domain/policy_test.go"}]
        self.plan["changes"]["paths"] = [{"path": "modules/chat/domain/policy_test.go"}]
        self.assertEqual(len(commands(self.project())), 2)

    def test_unknown_production_or_widened_plan_never_becomes_an_execution_capability(self):
        for key, value in [("status", "NEEDS_REVIEW"), ("executionAllowed", True), ("acceptance", True),
                           ("broadened", [{"reason": "UNKNOWN"}]), ("kind", "arbitrary-command")]:
            with self.subTest(field=key):
                plan = {**self.plan, key: value}
                with self.assertRaisesRegex(ValueError, "MAPPING_REQUIRES_REVIEW"):
                    projection(plan, self.cloud, self.metadata)

    def test_empty_duplicate_unmapped_and_redirected_paths_refuse(self):
        for selected in [[], self.plan["selected"] * 2, [{"path": "tests/renderer/x.test.tsx"}],
                         [{"path": "../outside.test.ts"}], [{"path": "/tmp/remote.test.ts"}],
                         [{"path": "tests/e2e/run.e2e.mjs"}]]:
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                projection({**self.plan, "selected": selected}, self.cloud, self.metadata)

    def test_mixed_partial_native_renderer_and_arbitrary_runner_options_refuse(self):
        for key, value in [("testNamePattern", "portable"), ("config", "vitest.renderer.config.ts"),
                           ("runner", "node"), ("runner", "go"), ("cwd", "elsewhere"),
                           ("id", "node-cloud-mixed-01"), ("workers", 200), ("timeoutMs", True),
                           ("files", ["tests/unit/a.test.ts", "--dangerous.test.ts"]),
                           ("files", self.suite["files"] * 2)]:
            with self.subTest(field=key), self.assertRaisesRegex(ValueError, "PARTIAL_OR_NATIVE"):
                projection(self.plan, {**self.cloud, "suites": [{**self.suite, key: value}]}, self.metadata)

    def test_wrong_registry_or_duplicate_batch_refuses(self):
        with self.assertRaisesRegex(ValueError, "PORTABLE_REGISTRY"):
            projection(self.plan, {**self.cloud, "scope": "unit"}, self.metadata)
        with self.assertRaisesRegex(ValueError, "DUPLICATE_SUITE"):
            projection(self.plan, {**self.cloud, "suites": [self.suite, self.suite]}, self.metadata)

    def test_go_gaps_extra_modules_and_unowned_files_refuse_before_core(self):
        self.plan["selected"].append({"path": "modules/chat/domain/policy_test.go"})
        for key, value in [("gaps", [{"reason": "CGO_NOT_MODELED"}]),
                           ("observations", [{"module": "unmodeled/go.mod"}]), ("packages", [])]:
            with self.subTest(field=key), self.assertRaisesRegex(ValueError, "GO_"):
                projection(self.plan, self.cloud, {"go": {**self.metadata["go"], key: value}})

    def test_environment_is_an_allowlist_without_ambient_targets_or_selectors(self):
        with patch.dict("os.environ", {"NODE_OPTIONS": "--import=evil", "GOFLAGS": "-run=NONE", "TARGET": "prod"}):
            env = environment()
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertNotIn("TARGET", env)
        self.assertEqual(env["GOFLAGS"], "-p=2")
        self.assertEqual(env["GOPROXY"], "off")
        self.assertEqual(env["HOME"], "/tmp/testops-home")

    def test_normal_host_refuses_before_reading_container_state(self):
        with patch("affected_run.os.getpid", return_value=99), patch.object(Path, "read_text", side_effect=AssertionError("no reads")):
            with self.assertRaisesRegex(ValueError, "PRIVATE_LINUX_PID1"):
                private_container()

    def test_container_checks_require_read_only_sources_no_network_and_exact_caps(self):
        data = {"/proc/self/status": "CapEff:\t0000000000000000\nNoNewPrivs:\t1\n",
                "/proc/self/mountinfo": "1 0 0:1 / / ro - overlay overlay ro\n2 1 0:2 / /workspace ro - ext4 volume ro\n3 1 0:3 / /usr/local/go ro - ext4 volume ro\n4 2 0:4 / /workspace/node_modules/.vite rw - tmpfs tmpfs rw\n5 2 0:5 / /workspace/node_modules/.vite-temp rw - tmpfs tmpfs rw\n",
                "/sys/fs/cgroup/memory.max": str(3072 * 1024**2),
                "/sys/fs/cgroup/cpu.max": "200000 100000", "/sys/fs/cgroup/pids.max": "256"}
        def check(current, interfaces, capacity=64 * 1024**2, stale=False):
            with patch("affected_run.sys.platform", "linux"), patch("affected_run.platform.machine", return_value="aarch64"), \
                 patch("affected_run.os.getpid", return_value=1), patch("affected_run.os.geteuid", return_value=501), \
                 patch.object(Path, "read_text", lambda p: current[str(p)]), \
                 patch.object(Path, "iterdir", lambda p: iter(Path(n) for n in (interfaces if str(p) == "/sys/class/net" else ["stale"] if stale else []))), \
                 patch("affected_run.os.statvfs", return_value=SimpleNamespace(f_blocks=capacity, f_frsize=1)):
                private_container()
        check(data, ["lo"])
        for key, value in [("/proc/self/status", "CapEff:\t1\nNoNewPrivs:\t1\n"),
                           ("/proc/self/status", "CapEff:\t0\nNoNewPrivs:\t0\n"),
                           ("/proc/self/mountinfo", data["/proc/self/mountinfo"].replace("/workspace ro", "/workspace rw")),
                           ("/sys/fs/cgroup/pids.max", "max"), ("/sys/fs/cgroup/cpu.max", "max 100000"),
                           ("/sys/fs/cgroup/memory.max", "max")]:
            with self.subTest(field=key), self.assertRaises(ValueError):
                check({**data, key: value}, ["lo"])
        with self.assertRaisesRegex(ValueError, "NETWORK_NONE"):
            check(data, ["lo", "eth0"])
        for current in [data["/proc/self/mountinfo"].replace("/workspace/node_modules/.vite rw", "/elsewhere rw"),
                        data["/proc/self/mountinfo"].replace("- tmpfs tmpfs rw", "- ext4 volume rw"),
                        data["/proc/self/mountinfo"].replace("/workspace/node_modules/.vite rw", "/workspace/node_modules/.vite ro")]:
            with self.assertRaisesRegex(ValueError, "CACHE_MOUNT_REQUIRED"):
                check({**data, "/proc/self/mountinfo": current}, ["lo"])
        for options in [{"capacity": 512 * 1024**2}, {"stale": True}]:
            with self.assertRaisesRegex(ValueError, "FRESH_EMPTY_BOUNDED_CACHE"):
                check(data, ["lo"], **options)

    def test_busy_lease_preserves_owner_without_creating_attempt_directory(self):
        with tempfile.TemporaryDirectory(prefix="affected-busy-lease-") as name:
            root = Path(name).resolve()
            parent = root / "_output/testops"; parent.mkdir(parents=True)
            original = Lease(parent); original.acquire(root / "_output/another-attempt")
            owner = (original.path / "owner.json").read_bytes()
            try:
                with self.assertRaisesRegex(ValueError, "SOURCE_GATE_LEASE_BUSY"):
                    acquire_attempt(root, root / "_output/affected-iteration")
                self.assertFalse((root / "_output/affected-iteration").exists())
                self.assertEqual((original.path / "owner.json").read_bytes(), owner)
            finally:
                original.release()

    def test_existing_attempt_is_preserved_without_acquiring_new_lease(self):
        with tempfile.TemporaryDirectory(prefix="affected-existing-attempt-") as name:
            root = Path(name).resolve(); directory = root / "_output/affected-iteration"
            directory.mkdir(parents=True); (directory / "receipt").write_text("retain")
            with self.assertRaisesRegex(ValueError, "ATTEMPT_ALREADY_EXISTS"):
                acquire_attempt(root, directory)
            self.assertEqual((directory / "receipt").read_text(), "retain")
            self.assertFalse((root / "_output/testops/active-source-gate.lease").exists())

    def test_failed_attempt_creation_releases_only_its_proved_unissued_lease(self):
        with tempfile.TemporaryDirectory(prefix="affected-directory-failure-") as name:
            root = Path(name).resolve(); (root / "_output").mkdir()
            directory = root / "_output/affected-iteration"
            mkdir = Path.mkdir
            def fail(target, *args, **kwargs):
                if target == directory:
                    raise OSError("CONTROLLED_DIRECTORY_CREATION_FAILURE")
                return mkdir(target, *args, **kwargs)
            with patch.object(Path, "mkdir", fail), self.assertRaisesRegex(OSError, "CONTROLLED_DIRECTORY"):
                acquire_attempt(root, directory)
            self.assertFalse((root / "_output/testops/active-source-gate.lease").exists())
            self.assertFalse(directory.exists())

    def test_successful_preissuance_admission_returns_original_lease(self):
        with tempfile.TemporaryDirectory(prefix="affected-lease-admission-") as name:
            root = Path(name).resolve(); (root / "_output").mkdir()
            directory = root / "_output/affected-iteration"
            lease = acquire_attempt(root, directory)
            self.assertTrue(directory.is_dir())
            self.assertTrue((lease.path / "owner.json").is_file())
            lease.release()


if __name__ == "__main__":
    unittest.main()
