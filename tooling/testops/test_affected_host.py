"""Host admission protocol controls; no Docker, sockets, product or provider."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from affected_host import iteration_command, iteration_receipt, DEPENDENCIES, TOOLS, IMAGE, required_steps, CancellationControl, cancellation_state, wait_original, validate_counts, drain_after_cleanup_failure, retirement_closed, memory_events_closed
from affected_host_entry import entry
from affected_run import require_host_source
from dag import Job, Outcome, checked_outcome


class AffectedHost(unittest.TestCase):
    def setUp(self):
        self.source = {"head": "a" * 40, "tree": "b" * 40, "workingSourceSha256": "c" * 64,
                       "dirty": False, "trackedAndUntrackedFiles": 123}
        self.bound = {**self.source, "requestedBase": "d" * 40, "changes": {"paths": [{"path": "tests/unit/a.test.mjs"}]}}
        # Synthetic graph input only; real projection/command and scheduler contracts run.
        compiler = patch("affected_host.compiler_affected", side_effect=lambda root, changes, metadata: {
            "kind": "affected-plan-only", "status": "PLAN_ONLY", "executionAllowed": False,
            "acceptance": False, "broadened": [], "selected": [dict(row) for row in changes["paths"]],
            "changes": changes, "mandatoryFinalGates": ["ci"]})
        compiler.start(); self.addCleanup(compiler.stop)

    def test_host_identity_must_match_including_tree_modes_and_dirty_state(self):
        require_host_source(self.source, dict(self.source))
        require_host_source(self.source, None)  # Original direct inner route.
        for key, value in [("head", "e" * 40), ("tree", "f" * 40), ("dirty", True),
                           ("workingSourceSha256", "0" * 64), ("trackedAndUntrackedFiles", 124)]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "HOST_SOURCE_MISMATCH"):
                require_host_source(self.source, {**self.source, key: value})

    def test_cancel_during_host_setup_leaves_docker_child_unissued(self):
        import os
        import affected_host as host
        for phase in ["command-record", "log-setup"]:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix="testops-host-cancel-") as folder:
                root = Path(folder).resolve(); parent = root / "_output/testops"; parent.mkdir(parents=True)
                ref = parent / "reference.json"; ref.write_text("{}")
                (root / "package-lock.json").write_text("{}")
                options = SimpleNamespace(scope="farol-testops-aabbccdd", dependency_reference=ref,
                    dependency_reference_sha256="e" * 64, base="d" * 40, output="cancelled",
                    source_volume="source", seed_volume="seed", sdk_volume="sdk", dependency_volume="deps", focused=True,
                    docker=Path("/not-executed/docker"), socket=Path("/not-executed/socket"))
                changes = {"requestedBase":"d" * 40, "paths":[{"path":"tests/unit/a.test.mjs"}]}
                handlers = {}; outcomes = []
                original_write, original_open = Path.write_text, Path.open
                def write_file(path, *args, **kwargs):
                    result = original_write(path, *args, **kwargs)
                    if phase == "command-record" and path.name == "docker-command.json":
                        handlers[host.signal.SIGINT](None, None)
                    return result
                def open_file(path, *args, **kwargs):
                    handle = original_open(path, *args, **kwargs)
                    if phase == "log-setup" and path.name == "docker.stderr.log":
                        handlers[host.signal.SIGINT](None, None)
                    return handle
                def run_fixed(root, jobs, budget, platform, binding, execute, output, stop):
                    directory = parent / output; directory.mkdir()
                    outcomes.append(execute(jobs[0], directory, binding()))
                    return {"status":outcomes[-1].status}
                with patch.dict(os.environ), patch.object(host, "ROOT", root), \
                        patch.object(host, "require_host_owner"), patch.object(host.argparse.ArgumentParser, "parse_args", return_value=options), \
                        patch.object(host, "identity", return_value=self.source), patch.object(host, "changed", return_value=changes), \
                        patch.object(host, "reference", return_value=host.DEPENDENCIES), patch.object(host, "Docker") as docker, \
                        patch.object(host.signal, "signal", side_effect=lambda sig, handler:handlers.update({sig:handler})), \
                        patch.object(host, "iteration_command", return_value=("unissued", ["NOT_EXECUTED"])), \
                        patch.object(host, "run", side_effect=run_fixed), patch.object(Path, "write_text", new=write_file), \
                        patch.object(Path, "open", new=open_file), \
                        patch.object(host.subprocess, "Popen", side_effect=AssertionError("cancelled Docker must remain unissued")) as launch:
                    docker.return_value.engine.return_value = {"synthetic":True}
                    self.assertEqual(host.main(), 1)
                    launch.assert_not_called()
                    docker.return_value.removed.assert_not_called()
                self.assertEqual(outcomes[0].status, "BLOCKED")
                self.assertTrue(outcomes[0].terminal)
                self.assertEqual(outcomes[0].reason, "CANCELLED_BEFORE_DOCKER")

    def test_unqualified_host_uid_refuses_before_source_docker_or_private_mount_creation(self):
        from affected_host import main, require_host_owner
        with patch("affected_host.os.geteuid", return_value=501):
            require_host_owner()
        for uid in [0, 1000, 1001, True, 501.0]:
            with self.subTest(uid=uid), patch("affected_host.os.geteuid", return_value=uid), \
                    patch("affected_host.argparse.ArgumentParser.parse_args", return_value=SimpleNamespace()), \
                    patch("affected_host.identity") as source, patch("affected_host.Docker") as docker, \
                    patch("affected_host.Path.mkdir") as mkdir:
                with self.assertRaisesRegex(ValueError, "HOST_UID_501_REQUIRED"):
                    main()
                source.assert_not_called(); docker.assert_not_called(); mkdir.assert_not_called()

    def test_inner_rejects_host_mismatch_before_git_discovery_lease_or_compiler(self):
        import os
        with patch.dict(os.environ, {}, clear=True), patch("affected_run.private_container"), \
                patch("affected_run.arguments", return_value=("base", True)), \
                patch("affected_run.binding", return_value={"source": self.source}), \
                patch("affected_run.os.chdir"), patch("affected_run.Path.mkdir"), \
                patch("affected_run.changed") as discovery, patch("affected_run.acquire_attempt") as lease:
            from affected_run import main
            with self.assertRaisesRegex(ValueError, "HOST_SOURCE_MISMATCH"):
                main(expected_source={**self.source, "tree": "e" * 40})
            discovery.assert_not_called()
            lease.assert_not_called()

    def test_bridge_validates_clean_identity_and_closed_flag_before_runner(self):
        import sys
        original = sys.argv
        try:
            with patch("affected_host_entry.main", return_value=17) as runner:
                self.assertEqual(entry(["entry", json.dumps(self.source), "d" * 40, "e" * 12, "--focused"]), 17)
                self.assertEqual(runner.call_args.kwargs["expected_source"], self.source)
                self.assertTrue(callable(runner.call_args.kwargs["host_cancelled"]))
                self.assertEqual(sys.argv[1:], ["--base", "d" * 40, "--focused"])
            for invalid in [None, [], {**self.source, "dirty": True}, {**self.source, "trackedAndUntrackedFiles": True},
                            {**self.source, "head": "HEAD"}, {**self.source, "target": "prod"}]:
                with patch("affected_host_entry.main") as runner, self.assertRaisesRegex(ValueError, "CLEAN_IDENTITY"):
                    entry(["entry", json.dumps(invalid), "base", "e" * 12])
                runner.assert_not_called()
            with patch("affected_host_entry.main") as runner, self.assertRaisesRegex(ValueError, "ENTRY_ARGUMENTS"):
                entry(["entry", json.dumps(self.source), "base", "e" * 12, "--command=other"])
            runner.assert_not_called()
        finally:
            sys.argv = original

    def test_command_has_fixed_bridge_and_readonly_dependencies_without_interpolated_base(self):
        options = SimpleNamespace(scope="farol-testops-aabbccdd", source_volume="source", seed_volume="seed",
                                  sdk_volume="sdk", dependency_volume="dependencies", focused=True)
        docker = SimpleNamespace(prefix=["/docker"], config=Path("/config"))
        hostile = "base; $(touch /unissued)"
        bound = {**self.bound, "requestedBase": hostile}
        _, command = iteration_command(Job("affected"), Path("/owned/job"), bound, options, docker, "unique")
        self.assertIn("none", command)
        self.assertIn("--read-only", command)
        self.assertIn("type=volume,source=dependencies,target=/workspace/node_modules,readonly,volume-nocopy,volume-subpath=node_modules", command)
        self.assertEqual(command[-3:], [hostile, "unique", "--focused"])
        self.assertIn("type=bind,source=/config/control,target=/testops-host-control,readonly", command)
        self.assertNotIn(hostile, command[command.index(IMAGE) + 3])
        self.assertNotIn("gate_observer.py", " ".join(command))
        self.assertNotIn("--privileged", command)
        self.assertIn("type=bind,source=/owned/job/inner,target=/workspace/_output", command)
        self.assertNotIn("type=bind,source=/owned/job,target=/workspace/_output", command)
        self.assertEqual(command[command.index("--cidfile") + 1], "/owned/job/.original-container-affected.cid")

    def packet(self, directory, focused=True):
        cloud = {"version": 1, "scope": "cloud", "mixedSelections": [], "deferredFiles": [], "suites": [{
            "id": "node-cloud-01", "runner": "vitest", "cwd": ".", "workers": 2, "timeoutMs": 300000,
            "files": [row["path"] for row in self.bound["changes"]["paths"] if not row["path"].endswith("_test.go")]}]}
        metadata = {"go": {"gaps": [], "observations": [{"module": "go.mod"}, {"module": "resources/native/go/go.mod"}],
            "packages": [{"files": [row["path"] for row in self.bound["changes"]["paths"] if row["path"].endswith("_test.go")]}]}}
        seals = {}
        for filename, value in [("compiler.json", metadata), ("cloud.json", cloud)]:
            raw = json.dumps(value).encode(); (directory / filename).write_bytes(raw)
            seals[filename] = hashlib.sha256(raw).hexdigest()
        expected = required_steps(self.bound, directory, focused, seals)
        stages = []
        tests = [name for name, _ in expected if name in {"complete-core", "focused-go"} or name.startswith("node-cloud-") and not name.endswith("-validate")]
        for name, command in expected:
            stage = {"id": name, "command": command, "terminal": True, "exitCode": 0, "stdioClosed": True,
                     "originalPid": 100 + len(stages), "pid": 100 + len(stages),
                     "outputErrors": [], "outputTruncated": False, "output": {}}
            for stream in ("stdout", "stderr"):
                raw = (name + stream).encode()
                (directory / (name + "." + stream + ".log")).write_bytes(raw)
                digest = hashlib.sha256(raw).hexdigest()
                stage[stream + "Sha256"] = digest
                stage["output"][stream] = {"observedSha256": digest, "observedBytes": len(raw), "retainedBytes": len(raw)}
            stages.append(stage)
        report = {"schema": 1, "kind": "affected-iteration", "acceptance": False, "route": "focused" if focused else "whole-core-and-batches",
                  "status": "PASS", "complete": True,
                  "binding": {"source": self.source, "dependencies": DEPENDENCIES, "tools": TOOLS},
                  "changes": self.bound["changes"], "lease": "RELEASED", "cancelled": False, "timedOut": False,
                  "outputBudget": {"limitBytes": 32 * 1024**2, "remainingBytes": 32 * 1024**2 - sum(row["output"][stream]["retainedBytes"] for row in stages for stream in ("stdout", "stderr")), "exceeded": False},
                  "descendantRetirement": {"drained": True, "initialPids": [], "remainingPids": [], "reaped": [], "signals": [], "errors": [], "reason": "NATURAL_TERMINAL"},
                  "stages": stages, "metadataSha256": seals, "testChildrenIssued": len(tests), "counts": {name: {"total": 2, "passed": 2, "failed": 0, "skipped": 0, "todo": 0, "reportedSuccess": True} for name in tests if name != "complete-core"},
                  "cgroup": {"memory.max": str(3072 * 1024**2), "cpu.max": "200000 100000", "pids.max": "256",
                             "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n"}}
        (directory / "report.json").write_text(json.dumps(report))
        return report

    def test_complete_bound_original_receipt_is_accepted_as_iteration_only(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            result = iteration_receipt(self.packet(directory), self.bound, directory, True)
            self.assertTrue(result["complete"])
            self.assertFalse(result["acceptance"])
            self.assertEqual(checked_outcome(Job("affected"), Outcome("PASS", True, result), self.bound)["status"], "PASS")
            legacy = {key: result[key] for key in ["complete", "acceptance", "counts", "reportSha256"]}
            self.assertEqual(checked_outcome(Job("affected"), Outcome("PASS", True, legacy), self.bound)["reason"], "INCOMPLETE_OR_MISMATCHED_RECEIPT")

    def test_missing_stages_original_close_stream_identity_and_resources_refuse(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            original = self.packet(directory)
            faults = [lambda r: r.update(lease="HELD"), lambda r: r.update(complete=False),
                      lambda r: r["binding"]["source"].update(dirty=True),
                      lambda r: r["stages"].pop(), lambda r: r.update(stages=r["stages"][:1]),
                      lambda r: r["stages"][1].update(stdioClosed=False),
                      lambda r: r["stages"][1].pop("originalPid"),
                      lambda r: r["stages"][1].update(originalPid=True),
                      lambda r: r["stages"][1].update(pid=999),
                      lambda r: r["stages"][0]["output"]["stdout"].update(observedSha256="e" * 64),
                      lambda r: r["descendantRetirement"].update(initialPids=[999]),
                      lambda r: r.update(testChildrenIssued=2), lambda r: r.update(counts={}),
                      lambda r: r["cgroup"].update(**{"memory.events": "oom 1\noom_kill 0\n"}),
                      lambda r: r["cgroup"].update(**{"memory.max": "max"})]
            for index, fault in enumerate(faults):
                report = copy.deepcopy(original)
                fault(report)
                with self.subTest(fault=index), self.assertRaises(ValueError):
                    iteration_receipt(report, self.bound, directory, True)
            (directory / "compiler.stdout.log").write_text("replaced")
            with self.assertRaisesRegex(ValueError, "STREAM_MISMATCH"):
                iteration_receipt(original, self.bound, directory, True)

    def test_redirected_or_oversized_original_log_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            report = self.packet(directory)
            file = directory / "compiler.stdout.log"
            file.rename(directory / "other.log")
            file.symlink_to(directory / "other.log")
            with self.assertRaisesRegex(ValueError, "EVIDENCE_CHANGED"):
                iteration_receipt(report, self.bound, directory, True)
            file.unlink()
            with file.open("wb") as stream:
                stream.truncate(32 * 1024**2 + 1)
            with self.assertRaisesRegex(ValueError, "EVIDENCE_CHANGED"):
                iteration_receipt(report, self.bound, directory, True)

    def test_required_types_and_go_stages_cannot_be_omitted_from_a_valid_chain(self):
        for paths, remove in [(["tests/unit/a.test.ts"], {"types-main", "types-renderer"}),
                              (["tests/unit/a.test.mjs", "modules/chat/domain/policy_test.go"], {"complete-core", "complete-core-validate"})]:
            with self.subTest(remove=remove), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp).resolve()
                self.bound["changes"]["paths"] = [{"path": name} for name in paths]
                report = self.packet(directory, focused=False)
                self.assertTrue(iteration_receipt(report, self.bound, directory, False)["complete"])
                report["stages"] = [stage for stage in report["stages"] if stage["id"] not in remove]
                with self.assertRaisesRegex(ValueError, "REQUIRED_STAGES_MISMATCH"):
                    iteration_receipt(report, self.bound, directory, False)

    def test_changed_compiler_or_cloud_metadata_and_fixed_argv_refuse(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            report = self.packet(directory)
            report["stages"][1]["command"].append("--testNamePattern=partial")
            with self.assertRaisesRegex(ValueError, "REQUIRED_STAGES_MISMATCH"):
                iteration_receipt(report, self.bound, directory, True)
            for filename in ("compiler.json", "cloud.json"):
                report = self.packet(directory)
                (directory / filename).write_text("{}")
                with self.assertRaisesRegex(ValueError, "METADATA_CHANGED"):
                    iteration_receipt(report, self.bound, directory, True)

    def test_host_cancellation_is_visible_through_readonly_control_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve() / "control"
            control = CancellationControl(directory, "e" * 12)
            self.assertFalse(cancellation_state(directory, "e" * 12))
            with self.assertRaisesRegex(ValueError, "CONTROL_INVALID"):
                cancellation_state(directory, "f" * 12)
            stop = threading.Event(); stop.set()
            child = SimpleNamespace(args=["unissued-fixture"], calls=0)
            def wait(timeout):
                child.calls += 1
                if child.calls == 1:
                    raise subprocess.TimeoutExpired(child.args, timeout)
                return 0
            child.wait = wait
            observation = {}
            self.assertEqual(wait_original(child, stop, control, 2, observation), 0)
            self.assertTrue(cancellation_state(directory, "e" * 12))
            self.assertEqual(observation, {"cancellationPublished": True})
            self.assertEqual(child.calls, 2)

    def test_cancel_write_failure_is_not_retried_and_original_terminal_is_drained(self):
        stop = threading.Event(); stop.set()
        control = SimpleNamespace(cancel=unittest.mock.Mock(side_effect=OSError("injected")))
        child = SimpleNamespace(args=["unissued-fixture"], wait=unittest.mock.Mock(side_effect=[subprocess.TimeoutExpired("fixture", 1), 0]))
        observation = {}
        self.assertEqual(wait_original(child, stop, control, 2, observation), 0)
        control.cancel.assert_called_once()
        self.assertEqual(observation["controlFailure"], "OSError")

    def test_inner_observes_host_cancel_before_git_discovery_and_lease(self):
        import os
        with patch.dict(os.environ, {}, clear=True), patch("affected_run.private_container"), \
                patch("affected_run.arguments", return_value=("base", True)), \
                patch("affected_run.binding", return_value={"source": self.source}), \
                patch("affected_run.os.chdir"), patch("affected_run.Path.mkdir"), \
                patch("affected_run.changed") as discovery, patch("affected_run.acquire_attempt") as lease:
            from affected_run import main
            with self.assertRaisesRegex(ValueError, "HOST_CANCELLED_BEFORE_ADMISSION"):
                main(expected_source=self.source, host_cancelled=lambda: True)
            discovery.assert_not_called(); lease.assert_not_called()

    def test_count_schema_preserves_skips_and_refuses_missing_malformed_or_failed_values(self):
        valid = {"total": 4, "passed": 2, "failed": 0, "skipped": 1, "todo": 1, "reportedSuccess": True}
        validate_counts("node-cloud-01", valid, [])
        for malformed in [{}, {"passed": 2}, {**valid, "passed": True}, {**valid, "skipped": -1},
                          {**valid, "total": 99}, {**valid, "failed": 1}, {**valid, "reportedSuccess": False},
                          {**valid, "extra": 1}, {**valid, "todo": 0.5}, {**valid, "passed": 0},
                          {**valid, "total": 2**53}]:
            with self.subTest(value=malformed), self.assertRaisesRegex(ValueError, "COUNT_SCHEMA_INVALID"):
                validate_counts("node-cloud-01", malformed, [])
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve(); report = self.packet(directory)
            report["counts"]["node-cloud-01"] = {}
            with self.assertRaisesRegex(ValueError, "COUNT_SCHEMA_INVALID"):
                iteration_receipt(report, self.bound, directory, True)

    def test_go_count_membership_matches_selected_policy_and_all_top_level_names(self):
        from affected_focused import POLICY
        package = POLICY["packages"][0]
        rows = [{"package": package["path"], "test": name, "status": "pass"} for name in package["topLevelTests"]]
        count = {"total": len(rows), "passed": len(rows), "failed": 0, "skipped": 0, "todo": 0,
                 "reportedSuccess": True, "packages": 1, "topLevelTests": len(rows), "includesSubtests": True,
                 "caseMembership": rows}
        steps = [("focused-go-validate", [json.dumps([package["path"]])])]
        validate_counts("focused-go", count, steps)
        for key, value in [("packages", True), ("topLevelTests", 1), ("includesSubtests", False),
                           ("caseMembership", rows[:-1]), ("caseMembership", [*rows[:-1], rows[0]]),
                           ("caseMembership", [{**row, "test": "Unknown/subtest"} for row in rows])]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "GO_COUNT_MEMBERSHIP_INVALID"):
                validate_counts("focused-go", {**count, key: value}, steps)

    def test_container_symlink_destinations_are_disjoint_from_host_observer_records(self):
        with tempfile.TemporaryDirectory() as temp:
            host = Path(temp).resolve() / "host"; inner = host / "inner"; inner.mkdir(parents=True)
            victim = host.parent / "victim"; victim.write_text("unchanged")
            names = ["original-docker-terminal.json", "original-draining.json", "original-container-retirement.json",
                     "deadline-container-readback.json", "deadline-container-stop.json"]
            for name in names:
                (inner / name).symlink_to(victim)
                self.assertFalse((host / name).exists())
            child = SimpleNamespace(pid=123, wait=unittest.mock.Mock(return_value=0))
            observation = {}
            self.assertEqual(drain_after_cleanup_failure(child, host, OSError("fixture"), observation), 0)
            self.assertEqual(victim.read_text(), "unchanged")
            self.assertFalse((host / "original-draining.json").is_symlink())
            child.wait.assert_called_once_with()

    def test_original_wait_remains_guaranteed_after_draining_record_enospc(self):
        child = SimpleNamespace(pid=123, wait=unittest.mock.Mock(return_value=7))
        observation = {}
        with patch("affected_host.Path.open", side_effect=OSError(28, "injected ENOSPC")):
            self.assertEqual(drain_after_cleanup_failure(child, Path("/unissued-host"), OSError("cleanup"), observation), 7)
        child.wait.assert_called_once_with()
        self.assertEqual(observation, {"drainingPersistenceFailure": "OSError"})

    def test_retirement_record_requires_all_exact_types_and_empty_original_sets(self):
        valid = {"drained": True, "initialPids": [], "remainingPids": [], "reaped": [],
                 "signals": [], "errors": [], "reason": "NATURAL_TERMINAL"}
        self.assertTrue(retirement_closed(valid))
        for field in valid:
            missing = dict(valid); del missing[field]
            self.assertFalse(retirement_closed(missing))
            for value in [None, {}, "false", 1, False, [123]]:
                if type(value) is type(valid[field]) and value == valid[field]:
                    continue
                self.assertFalse(retirement_closed({**valid, field: value}))
        self.assertFalse(retirement_closed({**valid, "extra": True}))
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve(); report = self.packet(directory)
            report["descendantRetirement"] = {"drained": 1}
            with self.assertRaisesRegex(ValueError, "DESCENDANT_CLOSURE_REQUIRED"):
                iteration_receipt(report, self.bound, directory, True)

    def test_memory_events_reject_duplicates_missing_fields_and_contradictions(self):
        valid = "low 0\nhigh 1\nmax 2\noom 0\noom_kill 0"
        self.assertTrue(memory_events_closed(valid))
        self.assertTrue(memory_events_closed(valid + "\noom_group_kill 0\nsock_throttled 0"))
        for invalid in [None, "", "oom 0\noom_kill 0", valid + "\noom 1", valid + "\noom 0",
                        valid + "\noom_group_kill 1", valid + "\nunknown 0", valid.replace("max 2", "max -1"),
                        valid.replace("oom 0", "oom true"), valid.replace("oom 0", "oom 00")]:
            self.assertFalse(memory_events_closed(invalid))

    def test_original_stream_sizes_and_shared_budget_must_match_retained_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve(); original = self.packet(directory)
            for mutate in [lambda r: r["outputBudget"].pop("limitBytes"),
                           lambda r: r["outputBudget"].update(remainingBytes=True),
                           lambda r: r["outputBudget"].update(remainingBytes=0),
                           lambda r: r["stages"][0]["output"]["stdout"].update(observedBytes=True),
                           lambda r: r["stages"][0]["output"]["stderr"].pop("retainedBytes")]:
                report = copy.deepcopy(original); mutate(report)
                with self.assertRaises(ValueError):
                    iteration_receipt(report, self.bound, directory, True)

    def run_inner_cancel_interleaving(self, phase):
        import os
        import affected_run as inner
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); directory = root / "_output/affected-iteration"
            directory.mkdir(parents=True)
            cgroup = root / "cgroup"; cgroup.mkdir()
            for name in ("memory.max", "memory.peak", "memory.events", "cpu.max", "cpu.stat", "pids.max"):
                (cgroup / name).write_text("protocol-fixture-only")
            published = False; reads = 0
            def binding():
                nonlocal published, reads
                reads += 1
                if reads == 2 and phase == "verification":
                    published = True
                return {"source": self.source}
            original_open = Path.open
            def open_file(file, *args, **kwargs):
                nonlocal published
                handle = original_open(file, *args, **kwargs)
                if phase == "log-setup" and file.name == "compiler.stderr.log":
                    published = True
                return handle
            def mapped_path(*parts):
                if parts[0] == "/tmp/testops-home": return root / "home"
                if parts[0] == "/sys/fs/cgroup": return cgroup.joinpath(*parts[1:])
                return Path(*parts)
            retirement = {"initialPids": [], "remainingPids": [], "reaped": [], "signals": [],
                          "errors": [], "drained": True, "reason": "NATURAL_TERMINAL"}
            lease = SimpleNamespace(release=unittest.mock.Mock())
            with patch.dict(os.environ, {}, clear=True), patch.object(inner, "ROOT", root), \
                    patch.object(inner, "DIRECTORY", directory), patch.object(inner, "private_container"), \
                    patch.object(inner, "arguments", return_value=("base", True)), \
                    patch.object(inner, "environment", return_value={}), patch.object(inner, "binding", side_effect=binding), \
                    patch.object(inner, "changed", return_value=self.bound["changes"]), \
                    patch.object(inner, "acquire_attempt", return_value=lease), patch.object(inner, "signal") as signals, \
                    patch.object(inner.os, "chdir"), patch.object(inner, "Path", side_effect=mapped_path), \
                    patch.object(inner, "retire_private_descendants", return_value=retirement), \
                    patch.object(inner.subprocess, "Popen", side_effect=AssertionError("successor must not issue")) as popen, \
                    patch.object(Path, "open", new=open_file):
                self.assertEqual(inner.main(expected_source=self.source, host_cancelled=lambda: published), 1)
                popen.assert_not_called()
            record = json.loads((directory / "report.json").read_text())
            self.assertTrue(published)
            self.assertTrue(record["cancelled"])
            self.assertEqual(record["reason"], "ValueError:AFFECTED_CANCELLED")
            self.assertEqual(record["testChildrenIssued"], 0)
            self.assertEqual(record["lease"], "HELD")
            lease.release.assert_not_called()

    def test_host_cancel_published_during_verification_prevents_original_successor_popen(self):
        self.run_inner_cancel_interleaving("verification")

    def test_host_cancel_published_during_log_setup_prevents_original_successor_popen(self):
        self.run_inner_cancel_interleaving("log-setup")


if __name__ == "__main__":
    unittest.main()
