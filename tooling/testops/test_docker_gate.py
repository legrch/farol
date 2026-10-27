"""Admission negatives for the fixed Docker source-gate adapter; no daemon calls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

from dag import Blocked, Job
from docker_gate import receipt, container_command, container_absent, validate_disposable_container, IMAGE, Docker, host_record, wait_container, execute_container, job_file
from gate_observer import (COMMANDS, TOOLS, selftest_count, remaining_processes, cloud_receipt,
                           evidence_file, validate_stage_logs, natural_retirement, observe_command)
from bounded_capture import OutputBudget
from testops import task_blocks


class Receipts(unittest.TestCase):
    def test_all_pilot_node_selftests_have_a_fixed_gate_command(self):
        directory = Path(__file__).resolve().parent
        expected = {"tooling/testops/" + p.name for p in directory.glob("*.test.mjs")}
        registered = {p for command in COMMANDS["pilot-selftests"] for p in command
                      if p.startswith("tooling/testops/") and p.endswith(".test.mjs")}
        self.assertEqual(registered, expected)
        taskfile = directory.parents[1] / "Taskfile.yml"
        tooling = next(task for task in task_blocks(taskfile.read_text(), "Taskfile.yml")
                       if task["name"] == "test:tooling")
        public = set(re.findall(r"tooling/testops/[^\s]+\.test\.mjs", tooling["block"]))
        self.assertEqual(public, expected)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name).resolve()
        self.source = {"head": "a" * 40, "dirty": False, "dependencyReferenceSha256": "c" * 64,
                       "dependencyTree": {"algorithm": "node-modules-tree-v1", "treeSha256": "d" * 64,
                                          "files": 1, "logicalBytes": 12}}
        self.job = Job("core")
        self.report = {"schema": 1, "id": "core", "source": self.source, "sourceAfter": self.source,
                       "commands": COMMANDS["core"], "complete": True, "status": "PASS",
                       "terminal": True, "exitCode": 0, "descendantsDrained": True, "toolHashes": TOOLS,
                       "descendantRetirement": {"initialPids": [], "remainingPids": [], "reaped": [],
                           "signals": [], "errors": [], "drained": True, "reason": "NATURAL_TERMINAL"},
                       "deadlineSeconds": 1800, "timedOut": False,
                       "cgroup": {"memory.max": str(3072 * 1024 * 1024), "cpu.max": "200000 100000",
                                  "pids.max": "256", "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n"},
                       "stages": [{"command": COMMANDS["core"][0], "exitCode": 0, "terminal": True,
                                   "output": {}, "stdioClosed": True, "outputErrors": [], "outputTruncated": False}]}
        for stream in ("stdout", "stderr"):
            data = ("original " + stream).encode()
            (self.output / f"command-0.{stream}.log").write_bytes(data)
            self.report["stages"][0][stream + "Sha256"] = hashlib.sha256(data).hexdigest()
            self.report["stages"][0]["output"][stream] = {"observedBytes": len(data), "retainedBytes": len(data),
                "observedSha256": hashlib.sha256(data).hexdigest()}
        (self.output / "job-report.json").write_text(json.dumps(self.report))

    def test_complete_original_receipt_with_bound_logs(self):
        self.assertTrue(receipt(self.job, self.report, self.source, self.output)["complete"])

    def test_recomputed_file_hash_cannot_replace_original_pipe_evidence(self):
        for stream in ("stdout", "stderr"):
            data = (self.output / f"command-0.{stream}.log").read_bytes()
            self.report["stages"][0].setdefault("output", {})[stream] = {
                "observedBytes": len(data), "retainedBytes": len(data),
                "observedSha256": hashlib.sha256(data).hexdigest()}
        self.report["stages"][0].update(stdioClosed=True, outputErrors=[], outputTruncated=False)
        replacement = b"later successful command substituted this log"
        (self.output / "command-0.stderr.log").write_bytes(replacement)
        self.report["stages"][0]["stderrSha256"] = hashlib.sha256(replacement).hexdigest()
        with self.assertRaisesRegex(Blocked, "ORIGINAL_STAGE_LOG"):
            receipt(self.job, self.report, self.source, self.output)

    def test_already_reaped_unexpected_descendant_prevents_success(self):
        for exit_code in (0, 7):
            self.report["descendantRetirement"] = {"initialPids": [], "remainingPids": [],
                "reaped": [{"pid": 42, "terminal": True, "exitCode": exit_code}],
                "signals": [], "errors": [], "drained": True, "reason": "NATURAL_TERMINAL"}
            with self.subTest(exitCode=exit_code), self.assertRaisesRegex(Blocked, "DESCENDANT"):
                receipt(self.job, self.report, self.source, self.output)

    def test_each_stream_requires_closed_finite_original_pipe_metadata(self):
        for field, value in (("stdioClosed", False), ("outputTruncated", True), ("outputErrors", ["WRITE:OSError"]),
                             ("output", {})):
            candidate = copy.deepcopy(self.report)
            candidate["stages"][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(Blocked, "ORIGINAL_STAGE_LOG"):
                receipt(self.job, candidate, self.source, self.output)
        for key, value in (("observedBytes", True), ("retainedBytes", 0), ("observedSha256", "a" * 64)):
            candidate = copy.deepcopy(self.report)
            candidate["stages"][0]["output"]["stderr"][key] = value
            with self.subTest(field=key), self.assertRaisesRegex(Blocked, "ORIGINAL_STAGE_LOG"):
                receipt(self.job, candidate, self.source, self.output)

    def test_retirement_must_be_natural_without_hidden_children_or_actions(self):
        original = self.report["descendantRetirement"]
        self.assertTrue(natural_retirement(original))
        for field, value in (("initialPids", [42]), ("remainingPids", [42]), ("reaped", [{"exitCode": 0}]),
                             ("signals", [{"signal": 15}]), ("errors", ["UNKNOWN"]),
                             ("reason", "UNEXPECTED_DESCENDANTS"), ("drained", 1)):
            candidate = copy.deepcopy(self.report)
            candidate["descendantRetirement"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(Blocked, "DESCENDANT"):
                receipt(self.job, candidate, self.source, self.output)

    def test_log_total_cannot_exceed_shared_retained_budget(self):
        with patch("gate_observer.OUTPUT_LIMIT_BYTES", 5), \
                patch("gate_observer.evidence_file", return_value=b"abc"), \
                patch("gate_observer.original_stream"):
            with self.assertRaisesRegex(ValueError, "LOG_BUDGET_EXCEEDED"):
                validate_stage_logs([{}], self.output)

    def test_source_and_tool_hashes_without_installed_dependency_binding_refuse(self):
        missing = dict(self.source)
        del missing["dependencyTree"]
        with self.assertRaisesRegex(Blocked, "DEPENDENCY_BINDING_REQUIRED"):
            receipt(self.job, self.report, missing, self.output)

    def test_exact_original_container_absence_does_not_mask_permission_or_transport_errors(self):
        name = "farol-testops-01234567-original"
        record = {"container": name, "exitCode": 1, "stdout": "\n",
                  "stderr": "Error response from daemon: No such container: " + name + "\n"}
        self.assertTrue(container_absent(record, name))
        for key, value in (("exitCode", True), ("stdout", '{"Running":true}'),
                           ("stderr", "permission denied"), ("container", "another-container"),
                           ("stderr", "Error response from daemon: No such container: another-container")):
            with self.subTest(field=key):
                candidate = dict(record)
                candidate[key] = value
                self.assertFalse(container_absent(candidate, name))

    def test_deadline_cleanup_requires_exact_id_owner_and_private_isolation(self):
        cid = "a" * 64
        name = "farol-testops-01234567-original"
        scope = "farol-testops-01234567"
        value = {"Id": cid, "Name": "/" + name, "Labels": {"farol.testops.task": "01234567"},
                 "User": "501:20", "NetworkMode": "none", "PidMode": "",
                 "Privileged": False, "ReadonlyRootfs": True}
        validate_disposable_container(value, cid, name, scope)
        for key, replacement in (("Id", "b" * 64), ("Name", "/another-container"), ("Labels", {}),
                                 ("User", "0:0"), ("NetworkMode", "host"), ("PidMode", "host"),
                                 ("Privileged", True), ("ReadonlyRootfs", False)):
            with self.subTest(field=key), self.assertRaises(Blocked):
                validate_disposable_container({**value, key: replacement}, cid, name, scope)

    def test_missing_changed_or_redirected_log_cannot_pass(self):
        p = self.output / "command-0.stdout.log"
        original = p.read_bytes()
        for mode in ("changed", "missing", "redirected"):
            with self.subTest(mode=mode):
                p.unlink()
                if mode == "changed":
                    p.write_bytes(b"substituted")
                elif mode == "redirected":
                    p.symlink_to(self.output / "command-0.stderr.log")
                with self.assertRaises(Blocked):
                    receipt(self.job, self.report, self.source, self.output)
                if p.exists() or p.is_symlink():
                    p.unlink()
                p.write_bytes(original)

    def test_partial_source_tool_command_and_terminal_receipts_refuse(self):
        changes = [("schema", True), ("complete", False), ("terminal", False), ("exitCode", False), ("stages", []),
                   ("timedOut", True), ("deadlineSeconds", None),
                   ("sourceAfter", {"head": "b" * 40}), ("toolHashes", {}),
                   ("commands", [["task", "verify:prod"]]), ("descendantsDrained", False)]
        for key, value in changes:
            with self.subTest(field=key):
                candidate = copy.deepcopy(self.report)
                candidate[key] = value
                with self.assertRaises(Blocked):
                    receipt(self.job, candidate, self.source, self.output)

    def test_resource_caps_and_oom_are_required(self):
        for key, value in (("memory.max", "max"), ("cpu.max", "max 100000"), ("pids.max", "max"),
                           ("memory.events", "oom 1\noom_kill 0\n")):
            with self.subTest(field=key):
                candidate = copy.deepcopy(self.report)
                candidate["cgroup"][key] = value
                with self.assertRaises(Blocked):
                    receipt(self.job, candidate, self.source, self.output)

    def test_memory_events_require_complete_unique_canonical_zero_oom_counters(self):
        valid = self.report["cgroup"]["memory.events"]
        for value in (valid + "oom 1\n", valid + "oom_kill 1\n", valid + "oom_group_kill 1\n",
                      valid.replace("high 0\n", ""), valid.replace("oom 0", "oom 00"),
                      valid + "unknown 0\n", None, 0):
            candidate = copy.deepcopy(self.report)
            candidate["cgroup"]["memory.events"] = value
            with self.subTest(value=value), self.assertRaises(Blocked):
                receipt(self.job, candidate, self.source, self.output)

    def test_missing_cloud_report_even_after_other_success_refuses(self):
        candidate = copy.deepcopy(self.report)
        candidate.update(id="checks-source", commands=COMMANDS["checks-source"])
        candidate["stages"][0]["command"] = COMMANDS["checks-source"][0]
        with self.assertRaisesRegex(Blocked, "CLOUD_REPORT_REQUIRED"):
            receipt(Job("checks-source"), candidate, self.source, self.output)
        candidate["cloud"] = {"path": "_output/evidence/test-scopes/one/report.json", "sha256": "a" * 64}
        with self.assertRaisesRegex(Blocked, "ORIGINAL_CLOUD_REPORT_MISSING_OR_CHANGED"):
            receipt(Job("checks-source"), candidate, self.source, self.output)

    def test_report_counts_do_not_replace_actual_selftest_execution(self):
        stdout = self.output / "tap.log"
        stderr = self.output / "unittest.log"
        stdout.write_text("# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n")
        stderr.write_text("..\nRan 2 tests in 0.01s\n\nOK\n")
        self.assertEqual(selftest_count(["node"], stdout, stderr), 2)
        self.assertEqual(selftest_count(["python"], stdout, stderr), 2)
        for bad in ("# tests 0\n# pass 0\n", "# tests 2\n# pass 1\n# fail 1\n"):
            stdout.write_text(bad)
            with self.assertRaises(ValueError):
                selftest_count(["node"], stdout, stderr)
        stderr.write_text("Ran 0 tests in 0.01s\nOK\n")
        with self.assertRaises(ValueError):
            selftest_count(["python"], stdout, stderr)

    def test_process_inventory_refuses_the_host_namespace(self):
        with self.assertRaisesRegex(ValueError, "PRIVATE_PID_NAMESPACE_REQUIRED"):
            remaining_processes()

    def test_cloud_report_requires_the_original_plan_and_terminal_suite_receipts(self):
        path = self.output / "_output/evidence/test-scopes/one/report.json"
        path.parent.mkdir(parents=True)
        plan = {"suites": [{"id": "one", "runner": "vitest", "files": ["one.test.mjs"]}]}
        report = {"scope": "cloud", "status": "PASS", "suites": plan["suites"],
                  "selected": 1, "executed": 1, "passed": 1, "failed": 0, "blocked": 0, "notRun": 0,
                  "scopeErrors": [], "results": [{"id": "one", "status": "PASS", "counts": {"failed": 0},
                      "terminal": {"terminal": True, "exit": 0, "signal": None, "timedOut": False}}]}
        with patch("gate_observer.subprocess.check_output", return_value=json.dumps(plan).encode()):
            path.write_text(json.dumps(report))
            self.assertEqual(cloud_receipt(self.output)["plan"], plan)
            for field, value in (("results", []), ("passed", True), ("suites", [])):
                candidate = copy.deepcopy(report)
                candidate[field] = value
                path.write_text(json.dumps(candidate))
                with self.subTest(field=field), self.assertRaises(ValueError):
                    cloud_receipt(self.output)
            for key, value in (("terminal", False), ("exit", False), ("timedOut", True), ("cancelled", True)):
                candidate = copy.deepcopy(report)
                candidate["results"][0]["terminal"][key] = value
                path.write_text(json.dumps(candidate))
                with self.subTest(field=key), self.assertRaises(ValueError):
                    cloud_receipt(self.output)

    def test_container_has_closed_network_caps_mounts_and_original_handle_controls(self):
        class Options:
            scope = "farol-testops-01234567"
            source_volume = scope + "-source"
            seed_volume = scope + "-seed"
            sdk_volume = scope + "-sdk"
        class Client:
            prefix = ["/selected/docker", "--host", "unix:///selected/local.sock"]
            config = self.output
        name, command = container_command(self.job, self.output, self.source, Options(), Client(), "fixed")
        self.assertTrue(name.startswith(Options.scope))
        for option, value in (("--network", "none"), ("--cpus", "2"), ("--memory", "3072m"), ("--pids-limit", "256")):
            self.assertEqual(command[command.index(option) + 1], value)
        self.assertIn("--sig-proxy=false", command)
        self.assertIn("--read-only", command)
        self.assertIn(IMAGE, command)
        self.assertNotIn("--privileged", command)
        self.assertFalse(any("docker.sock,target=" in v for v in command))
        self.assertEqual(command[-2], "core")
        self.assertEqual(json.loads(command[-1]), self.source)

    def test_optional_sealed_dependency_mount_is_explicit_read_only_and_scope_bound(self):
        options = SimpleNamespace(scope="farol-testops-01234567", source_volume="source",
                                  seed_volume="seed", sdk_volume="sdk")
        docker = SimpleNamespace(prefix=["NOT_EXECUTED"], config=self.output)
        volume = options.scope + "-sealed-dependencies"
        _, original = container_command(self.job, self.output, self.source, options, docker, "nonce")
        _, mounted = container_command(self.job, self.output, self.source, options, docker, "nonce", dependency_volume=volume)
        mount = "type=volume,source=" + volume + ",target=/workspace/node_modules,readonly,volume-nocopy,volume-subpath=node_modules"
        self.assertIn(mount, mounted)
        self.assertNotIn(mount, original)
        self.assertEqual(mounted[-6:], original[-6:])
        for foreign in ("another-scope-deps", volume + ",readonly=false", volume + "/node_modules"):
            with self.subTest(volume=foreign), self.assertRaises(Blocked):
                container_command(self.job, self.output, self.source, options, docker, "nonce", dependency_volume=foreign)


class HostCustody(unittest.TestCase):
    """Host filesystem/process protocol controls; no daemon or test payload runs."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.options = SimpleNamespace(scope="farol-testops-01234567", dependency_volume=None)
        self.job = Job("core")
        self.docker = Mock()
        self.engine = {"idSha256": "a" * 64}
        self.child = Mock(pid=12345, returncode=None)
        self.stop, self.deadline = threading.Event(), threading.Event()

    def original_terminal(self, timeout=None):
        self.child.returncode = 0
        return 0

    def test_unqualified_uid_refuses_before_identity_or_docker_setup(self):
        from docker_gate import main
        arguments = ["docker_gate.py", "--docker", "/NOT_EXECUTED", "--socket", "/NOT_EXECUTED",
                     "--scope", self.options.scope, "--source-volume", "source", "--seed-volume", "seed",
                     "--sdk-volume", "sdk", "--dependency-reference", "/NOT_EXECUTED",
                     "--dependency-reference-sha256", "a" * 64, "--jobs", "1", "--output", "not-issued"]
        for uid in (0, 1000, 1001, 501.0, True):
            with self.subTest(uid=uid), patch.object(sys, "argv", arguments), \
                    patch("docker_gate.os.geteuid", return_value=uid), \
                    patch("docker_gate.identity") as source, patch("docker_gate.Docker") as docker:
                with self.assertRaisesRegex(Blocked, "QUALIFIED_HOST_UID_501_REQUIRED"):
                    main()
                source.assert_not_called()
                docker.assert_not_called()

    def timed_wait(self, timeout=None):
        if timeout == 1920:
            raise subprocess.TimeoutExpired("original", timeout)
        return self.original_terminal(timeout)

    def wait(self):
        return wait_container(self.child, self.job, "original", self.directory,
                              self.options, self.docker, self.stop, self.deadline, self.engine)

    def test_new_private_record_is_exclusive(self):
        host_record(self.directory, "terminal.json", {"terminal": True})
        file = self.directory / "terminal.json"
        self.assertEqual(json.loads(file.read_text()), {"terminal": True})
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            host_record(self.directory, "terminal.json", {"terminal": False})
        self.assertTrue(json.loads(file.read_text())["terminal"])

    def test_job_report_and_nested_ancestors_cannot_redirect_host_reads(self):
        original = self.directory / "original.json"
        original.write_text("{}")
        (self.directory / "redirect.json").symlink_to(original)
        (self.directory / "redirect").symlink_to(self.directory, target_is_directory=True)
        for relative in ("redirect.json", "redirect/original.json", "../original.json", str(original)):
            with self.subTest(relative=relative), self.assertRaises(Blocked):
                job_file(self.directory, relative)
        self.assertEqual(job_file(self.directory, "original.json"), b"{}")

    def test_sparse_oversized_report_is_refused_before_host_allocation(self):
        path = self.directory / "oversized.json"
        with path.open("wb") as output:
            output.truncate(16 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(Blocked, "EVIDENCE_SIZE_LIMIT"):
            job_file(self.directory, path.name)

    def test_size_growth_after_stat_is_still_bounded(self):
        path = self.directory / "growing.json"
        path.write_bytes(b"a")
        original = os.fstat
        def grow(fd):
            metadata = original(fd)
            path.write_bytes(b"a" * 33)
            return metadata
        with patch("gate_observer.os.fstat", side_effect=grow), self.assertRaisesRegex(ValueError, "EVIDENCE_SIZE_LIMIT"):
            evidence_file(self.directory, path.name, limit=32)

    def test_later_real_child_cannot_rebase_an_earlier_captured_log(self):
        stages, issued, captures = [], {}, []
        budget = OutputBudget(4096)
        commands = [[sys.executable, "-c", "import sys; print('original', file=sys.stderr)"],
                    [sys.executable, "-c", "from pathlib import Path; Path('command-0.stderr.log').write_text('replacement')"]]
        for index, command in enumerate(commands):
            stage = {"command": command}; stages.append(stage)
            observe_command(command, self.directory, self.directory / f"command-{index}.stdout.log",
                            self.directory / f"command-{index}.stderr.log", stage, budget, 15, issued, captures)
            for stream in ("stdout", "stderr"):
                stage[stream + "Sha256"] = stage["output"][stream]["observedSha256"]
            if index == 0:
                validate_stage_logs(stages, self.directory)
        original_digest = stages[0]["output"]["stderr"]["observedSha256"]
        with self.assertRaisesRegex(ValueError, "ORIGINAL_STAGE_LOG"):
            validate_stage_logs(stages, self.directory)
        self.assertEqual(stages[0]["stderrSha256"], original_digest)
        self.assertTrue(all(child.returncode == 0 for child in issued.values()))
        self.assertEqual(captures, [])

    def test_existing_symlink_hardlink_regular_and_fifo_never_redirect_host_write(self):
        victim = self.directory / "victim.txt"
        victim.write_text("retained original")
        file = self.directory / "terminal.json"
        for kind in ("symlink", "hardlink", "regular", "fifo"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    file.symlink_to(victim)
                elif kind == "hardlink":
                    os.link(victim, file)
                elif kind == "fifo":
                    os.mkfifo(file)
                else:
                    file.write_text("retained record")
                with self.assertRaises(FileExistsError):
                    host_record(self.directory, "terminal.json", {"terminal": True})
                self.assertEqual(victim.read_text(), "retained original")
                file.unlink()

    def test_parent_redirect_shared_permissions_and_path_traversal_refuse(self):
        alias = self.directory / "alias"
        alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(Blocked):
            host_record(alias, "terminal.json", {})
        for name in ("../terminal.json", "/terminal.json", "nested/terminal.json"):
            with self.subTest(name=name), self.assertRaises(Blocked):
                host_record(self.directory, name, {})
        self.directory.chmod(0o777)
        try:
            with self.assertRaises(Blocked):
                host_record(self.directory, "terminal.json", {})
        finally:
            self.directory.chmod(0o700)

    def test_original_retirement_writer_refuses_redirect_instead_of_claiming_absence(self):
        victim = self.directory / "victim.txt"
        victim.write_text("retained")
        (self.directory / "original-container-retirement.json").symlink_to(victim)
        docker = Docker.__new__(Docker)
        docker.prefix, docker.env = ["NOT_EXECUTED"], {}
        docker.engine = Mock(return_value=self.engine)
        response = SimpleNamespace(returncode=1, stdout=b"", stderr=b"Error: No such container: original")
        with patch("docker_gate.subprocess.run", return_value=response) as call:
            with self.assertRaises(FileExistsError):
                docker.removed("original", self.directory, self.engine)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(victim.read_text(), "retained")

    def test_natural_original_wait_does_not_issue_cleanup_or_deadline_records(self):
        self.child.wait.side_effect = self.original_terminal
        self.assertEqual(self.wait(), (0, False))
        self.docker.stop_owned_after_deadline.assert_not_called()
        self.assertFalse(self.stop.is_set())
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_deadline_records_bind_exact_unmounted_original_cid(self):
        self.child.wait.side_effect = self.timed_wait
        self.assertEqual(self.wait(), (0, True))
        self.assertTrue(self.stop.is_set() and self.deadline.is_set())
        self.docker.stop_owned_after_deadline.assert_called_once_with(
            self.directory / ".original-container-core.cid", "original", self.options.scope, self.directory, self.engine)
        self.assertEqual(json.loads((self.directory / "original-docker-deadline.json").read_text())["originalDockerPid"], 12345)
        self.assertFalse((self.directory / "original-docker-draining.json").exists())

    def test_unknown_cleanup_is_not_retried_and_retains_both_distinct_records(self):
        self.child.wait.side_effect = self.timed_wait
        self.docker.stop_owned_after_deadline.side_effect = OSError("unknown cleanup")
        self.assertEqual(self.wait(), (0, True))
        self.assertEqual(self.docker.stop_owned_after_deadline.call_count, 1)
        initial = json.loads((self.directory / "original-docker-deadline.json").read_text())
        draining = json.loads((self.directory / "original-docker-draining.json").read_text())
        self.assertEqual(initial["status"], "DEADLINE_EXCEEDED")
        self.assertEqual(draining["status"], "UNKNOWN_DRAINING_ORIGINAL")
        self.assertEqual(self.child.wait.call_args.kwargs, {})

    def test_persistence_failure_still_waits_original_without_issuing_cleanup(self):
        self.child.wait.side_effect = self.timed_wait
        with patch("docker_gate.host_record", side_effect=OSError("full output")):
            with self.assertRaises(OSError):
                self.wait()
        self.assertEqual(self.child.returncode, 0)
        self.assertEqual(self.child.wait.call_count, 2)
        self.docker.stop_owned_after_deadline.assert_not_called()
        self.assertTrue(self.stop.is_set() and self.deadline.is_set())

    def test_draining_persistence_failure_still_waits_original_after_one_cleanup(self):
        self.child.wait.side_effect = self.timed_wait
        self.docker.stop_owned_after_deadline.side_effect = OSError("unknown cleanup")
        with patch("docker_gate.host_record", side_effect=[None, OSError("full output")]):
            with self.assertRaises(OSError):
                self.wait()
        self.assertEqual(self.child.returncode, 0)
        self.assertEqual(self.child.wait.call_count, 2)
        self.assertEqual(self.docker.stop_owned_after_deadline.call_count, 1)

    def test_deadline_readback_collision_cannot_redirect_record_or_issue_stop(self):
        cid = "a" * 64
        cidfile = self.directory / "original.cid"
        cidfile.write_text(cid)
        victim = self.directory / "victim.txt"
        victim.write_text("retained")
        (self.directory / "deadline-container-readback.json").symlink_to(victim)
        docker = Docker.__new__(Docker)
        docker.prefix, docker.env = ["NOT_EXECUTED"], {}
        docker.engine = Mock(return_value=self.engine)
        response = SimpleNamespace(returncode=1, stdout=b"", stderr=("Error: No such container: " + cid).encode())
        with patch("docker_gate.subprocess.run", return_value=response) as call:
            with self.assertRaises(FileExistsError):
                docker.stop_owned_after_deadline(cidfile, "original", self.options.scope, self.directory, self.engine)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(victim.read_text(), "retained")

    def test_engine_change_cannot_prove_retirement_or_issue_stop(self):
        docker = Docker.__new__(Docker)
        docker.prefix, docker.env = ["NOT_EXECUTED"], {}
        cid = "a" * 64
        cidfile = self.directory / "original.cid"; cidfile.write_text(cid)
        for operation in ("removed", "stop"):
            docker.engine = Mock(return_value={"idSha256": "b" * 64})
            with self.subTest(operation=operation), patch("docker_gate.subprocess.run") as run:
                with self.assertRaisesRegex(Blocked, "ENGINE_IDENTITY_CHANGED"):
                    if operation == "removed":
                        docker.removed("original", self.directory, self.engine)
                    else:
                        docker.stop_owned_after_deadline(cidfile, "original", self.options.scope, self.directory, self.engine)
                run.assert_not_called()

    def test_absence_on_a_changed_engine_after_inspect_is_unknown(self):
        docker = Docker.__new__(Docker)
        docker.prefix, docker.env = ["NOT_EXECUTED"], {}
        docker.engine = Mock(side_effect=[self.engine, {"idSha256": "b" * 64}])
        response = SimpleNamespace(returncode=1, stdout=b"", stderr=b"Error: No such container: original")
        with patch("docker_gate.subprocess.run", return_value=response) as run:
            with self.assertRaisesRegex(Blocked, "ENGINE_IDENTITY_CHANGED"):
                docker.removed("original", self.directory, self.engine)
        self.assertEqual(run.call_count, 1)

    def test_engine_change_after_owned_cid_inspect_prevents_stop(self):
        docker = Docker.__new__(Docker)
        docker.prefix, docker.env = ["NOT_EXECUTED"], {}
        cid = "a" * 64; cidfile = self.directory / "original.cid"; cidfile.write_text(cid)
        docker.engine = Mock(side_effect=[self.engine, {"idSha256": "b" * 64}])
        response = SimpleNamespace(returncode=0, stdout=b"{}", stderr=b"")
        with patch("docker_gate.subprocess.run", return_value=response) as run:
            with self.assertRaisesRegex(Blocked, "ENGINE_IDENTITY_CHANGED"):
                docker.stop_owned_after_deadline(cidfile, "original", self.options.scope, self.directory, self.engine)
        self.assertEqual(run.call_count, 1)

    def test_engine_read_failure_never_falls_through_to_container_api(self):
        docker = Docker.__new__(Docker)
        docker.prefix, docker.env = ["NOT_EXECUTED"], {}
        docker.engine = Mock(side_effect=OSError("controlled endpoint unavailable"))
        with patch("docker_gate.subprocess.run") as run, self.assertRaises(OSError):
            docker.removed("original", self.directory, self.engine)
        run.assert_not_called()

    def test_unchanged_engine_allows_only_the_exact_original_stop(self):
        docker = Docker.__new__(Docker)
        docker.prefix, docker.env = ["NOT_EXECUTED"], {}
        docker.engine = Mock(return_value=self.engine)
        cid = "a" * 64; cidfile = self.directory / "original.cid"; cidfile.write_text(cid)
        value = {"Id": cid, "Name": "/original", "Labels": {"farol.testops.task": "01234567"},
                 "User": "501:20", "NetworkMode": "none", "PidMode": "",
                 "Privileged": False, "ReadonlyRootfs": True}
        responses = [SimpleNamespace(returncode=0, stdout=json.dumps(value).encode(), stderr=b""),
                     SimpleNamespace(returncode=0, stdout=cid.encode(), stderr=b"")]
        with patch("docker_gate.subprocess.run", side_effect=responses) as run:
            result = docker.stop_owned_after_deadline(cidfile, "original", self.options.scope, self.directory, self.engine)
        self.assertEqual(result, {"containerId": cid, "alreadyAbsent": False})
        self.assertEqual(run.call_args.args[0], ["NOT_EXECUTED", "stop", "--time", "5", cid])
        self.assertEqual(run.call_count, 2)
        self.assertEqual(docker.engine.call_count, 4)

    def test_terminal_persistence_failure_retains_unknown_after_original_wait(self):
        self.docker.engine.return_value = {"qualified": "synthetic"}
        self.child.wait.side_effect = self.original_terminal
        original = host_record

        def write(directory, name, record):
            if name == "original-docker-terminal.json":
                raise OSError("full output")
            original(directory, name, record)

        with patch("docker_gate.container_command", return_value=("original", ["NOT_EXECUTED"])), \
                patch("docker_gate.subprocess.Popen", return_value=self.child), \
                patch("docker_gate.host_record", side_effect=write):
            outcome = execute_container(self.job, self.directory, {}, self.options, self.docker,
                                        "nonce", self.docker.engine.return_value, self.stop, self.deadline)
        self.assertEqual(outcome.status, "UNKNOWN")
        self.assertFalse(outcome.terminal)
        self.assertEqual(self.child.returncode, 0)
        self.docker.removed.assert_not_called()

    def test_cancellation_during_command_record_prevents_original_issuance(self):
        self.docker.engine.return_value = {"qualified": "synthetic"}
        original = host_record

        def write(directory, name, record):
            original(directory, name, record)
            self.stop.set()

        with patch("docker_gate.container_command", return_value=("original", ["NOT_EXECUTED"])), \
                patch("docker_gate.subprocess.Popen") as launch, \
                patch("docker_gate.host_record", side_effect=write):
            outcome = execute_container(self.job, self.directory, {}, self.options, self.docker,
                                        "nonce", self.docker.engine.return_value, self.stop, self.deadline)
        self.assertEqual(outcome.status, "BLOCKED")
        launch.assert_not_called()
        self.docker.removed.assert_not_called()

    def test_generic_executor_binds_only_inner_and_keeps_host_destinations_outside(self):
        self.options.source_volume = "source"
        self.options.seed_volume = "seed"
        self.options.sdk_volume = "sdk"
        self.docker.prefix, self.docker.config, self.docker.env = ["NOT_EXECUTED"], self.directory, {}
        self.docker.engine.return_value = {"qualified": "synthetic"}
        self.docker.removed.return_value = True
        victim = self.directory / "victim.txt"
        victim.write_text("retained")
        self.child.wait.side_effect = self.original_terminal

        def payload(*args, **kwargs):
            inner = self.directory / "inner"
            for name in ("original-docker-terminal.json", "original-container-retirement.json", "docker.stdout.log"):
                (inner / name).symlink_to(victim)
            (inner / "job-report.json").write_text("{}")
            return self.child

        with patch("docker_gate.subprocess.Popen", side_effect=payload) as launch, \
                patch("docker_gate.receipt", return_value={"complete": True}) as validate:
            outcome = execute_container(self.job, self.directory, {}, self.options, self.docker,
                                        "nonce", self.docker.engine.return_value, self.stop, self.deadline)
        self.assertEqual(outcome.status, "PASS")
        self.assertEqual(victim.read_text(), "retained")
        command = launch.call_args.args[0]
        self.assertIn(f"type=bind,source={self.directory / 'inner'},target=/workspace/_output", command)
        self.assertNotIn(f"type=bind,source={self.directory},target=/workspace/_output", command)
        self.assertEqual(command[command.index("--cidfile") + 1], str(self.directory / ".original-container-core.cid"))
        self.assertEqual(validate.call_args.args[-1], self.directory / "inner")
        self.assertTrue(json.loads((self.directory / "original-docker-terminal.json").read_text())["terminal"])


GATE_FAKE_DOCKER = r'''#!/usr/bin/python3
import json, sys
from pathlib import Path
here = Path(__file__).resolve().parent
args = sys.argv[5:]  # --config DIR --host unix://SOCKET
with open(here / "docker.log", "a") as log:
    log.write(json.dumps(args) + "\n")
if args[0] == "info":
    if (here / "fail-info").exists():
        sys.exit("Cannot connect to the Docker daemon")
    print(json.dumps({"ID": "engine", "OSType": "linux", "Architecture": "aarch64", "NCPU": 8,
                      "MemTotal": 16 * 1024**3, "ServerVersion": "fake"}))
elif args[:2] == ["volume", "inspect"]:
    labels = {"farol.testops.task": "0a1b2c3d", "farol.testops.source": "a" * 40}
    print(json.dumps([{"Name": args[2], "Driver": "local", "Options": None, "Labels": labels}]))
else:
    sys.exit("unexpected docker call")
'''


class ClientConfigCleanup(unittest.TestCase):
    """docker_gate owns only its per-run client config; borrowed volumes are never removed."""

    def setUp(self):
        import socket
        self.temp = tempfile.TemporaryDirectory(prefix="gate-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.root, fake = base / "repo", base / "fake"
        self.parent = self.root / "_output/testops"
        self.parent.mkdir(parents=True)
        fake.mkdir()
        (self.root / "package-lock.json").write_text("{}")
        self.reference = self.parent / "reference.json"
        self.reference.write_text("{}")
        self.docker = fake / "docker"
        self.docker.write_text(GATE_FAKE_DOCKER)
        self.docker.chmod(0o700)
        self.log, self.fail_info = fake / "docker.log", fake / "fail-info"
        self.socket_path = base / "d.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.socket_path))
        self.addCleanup(listener.close)

    def main(self, outcome, refuse=None):
        from docker_gate import main
        scope = "farol-testops-0a1b2c3d"
        argv = ["docker_gate.py", "--docker", str(self.docker), "--socket", str(self.socket_path),
                "--scope", scope, "--source-volume", scope + "-source", "--seed-volume", scope + "-seed",
                "--sdk-volume", scope + "-sdk", "--dependency-reference", str(self.reference),
                "--dependency-reference-sha256", "c" * 64, "--jobs", "1", "--output", "failed-run"]
        tree = {"algorithm": "node-modules-tree-v1", "treeSha256": "d" * 64, "files": 1, "logicalBytes": 1}

        def scheduler(*args, **kwargs):
            if refuse:
                raise refuse
            (self.parent / "failed-run").mkdir()
            return outcome

        with patch.object(sys, "argv", argv), patch("docker_gate.os.geteuid", return_value=501), \
                patch("docker_gate.ROOT", self.root), patch("docker_gate.signal.signal"), \
                patch("docker_gate.identity", return_value={"head": "a" * 40, "dirty": False}), \
                patch("docker_gate.reference", return_value=tree), \
                patch("docker_gate.run", side_effect=scheduler):
            return main()

    def assert_clean(self):
        self.assertEqual(sorted(p.name for p in self.parent.glob("docker-client-*")), [])
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertTrue(calls)
        self.assertFalse([c for c in calls if c[:1] == ["rm"] or c[:2] == ["volume", "rm"]])

    def test_failed_run_removes_client_config_and_leaves_borrowed_volumes(self):
        self.assertEqual(self.main({"status": "FAIL", "leaseRetained": False}), 1)
        self.assertEqual(json.loads((self.parent / "failed-run/report.json").read_text())["status"], "FAIL")
        self.assert_clean()

    def test_a_refusal_before_any_container_removes_the_config(self):
        with self.assertRaises(RuntimeError):
            self.main({"status": "FAIL"}, refuse=RuntimeError("OUTPUT_ALREADY_EXISTS"))
        self.assertEqual(list(self.parent.glob("docker-client-*")), [])

    def test_volume_admission_holds_the_lifecycle_lock(self):
        import contextlib
        events = []
        @contextlib.contextmanager
        def recording(root, timeout):
            events.append(("lock", Path(root), timeout))
            yield
            events.append(("unlock",))
        with patch("docker_gate.volume_lock", recording):
            self.main({"status": "FAIL", "leaseRetained": False})
        self.assertEqual(events, [("lock", self.root, 120), ("unlock",)])

    def test_unconfirmed_container_retirement_keeps_the_bind_mounted_config(self):
        self.assertEqual(self.main({"status": "UNKNOWN", "leaseRetained": True}), 1)
        self.assertEqual(len(list(self.parent.glob("docker-client-*"))), 1)

    def test_engine_error_still_removes_client_config(self):
        self.fail_info.write_text("")
        with self.assertRaises(subprocess.CalledProcessError):
            self.main({"status": "PASS"})
        self.assert_clean()


if __name__ == "__main__":
    unittest.main()
