"""Pure, synthetic VM Dev controller checks.

No VM process, installed app, host profile, network, TerminalMac binary, shell
or real producer is started. Effects, the MCP child, stop and status are
injected/mocked; clone deletion runs against synthetic temporary directories.
"""
import argparse
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_IDENTITY = {"product": "Example Dev", "appName": "Example Dev.app", "bundleId": "local.example.dev",
                      "archiveName": "Example-Dev.zip", "executable": "Example"}
os.environ["FAROL_VM_DEV_IDENTITY"] = json.dumps(SYNTHETIC_IDENTITY)
spec = importlib.util.spec_from_file_location("vm_dev_session_test", ROOT / "vm-dev-session.py")
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


def closed_session_mcp(root, calls=None, status=0, terminal=True):
    """A synthetic MCP child: optionally publishes terminal-mac's CLOSED record."""
    def mcp(binary, vm_root, name, stage, session, evidence, env, gate=None):
        if calls is not None:
            calls.append(("mcp", name, session))
        if terminal:
            run = vm_root / "machines" / name / "mcp-app-sessions" / session["runId"]
            run.mkdir(parents=True, mode=0o700)
            (run / "session.json").write_text(json.dumps({"status": "pending"}))
            (run / "service.lock").write_bytes(b"")  # an empty lock is copied, not refused
            (run / "terminal.json").write_text(json.dumps({
                "schema": dev.MCP_SESSION_CONTRACT, "state": "CLOSED", "runID": session["runId"],
                "helperInstance": "synthetic", "rootExit": "observed", "uiPrimaryExit": "observed",
                "installationEvidence": "verified-at-close"}))
            for item in run.iterdir():
                item.chmod(0o600)
        return status
    return mcp


def stopped_status(binary, name, env):
    return {"name": name, "state": "stopped"}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="farol-vm-dev-controller-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.settings = self.home / "Library/Application Support/Example Testing"
        self.settings.mkdir(parents=True, mode=0o700)
        self.root = self.home / "Library/Application Support/terminal-mac"
        base = self.root / "machines/farol-base-1"
        base.mkdir(parents=True, mode=0o700)
        # parent=True creates intermediate directories with default umask;
        # the real VM store requires private owned 0700 on both.
        self.root.chmod(0o700)
        (self.root / "machines").chmod(0o700)
        (base / "machine.json").write_text('{"name":"farol-base-1","installed":true}')
        source = self.settings / "base-receipts"
        source.mkdir(mode=0o700)
        self.base_receipt = source / "farol-base-1.json"
        self.base_receipt.write_text(json.dumps({
            "schema": "farol.vm-base/1", "base": "farol-base-1",
            "helper": "READY", "account": "tester-ready"}))
        (base / 'hardware.bin').write_bytes(b'synthetic hardware identity')
        machine = dev.module_from(ROOT / 'vm-machine.py', 'binding_fixture')
        value = json.loads(self.base_receipt.read_text())
        value.update(machine.base_binding(self.root, 'farol-base-1', 'hardware.bin'))
        self.base_receipt.write_text(json.dumps(value))
        self.base_receipt.chmod(0o600)
        self.binary = self.root / "terminal-mac-test-only"
        self.binary.write_text("synthetic placeholder, never executed")
        self.binary.chmod(0o700)
        self.output = self.home / "selected-output"
        self.output.mkdir(mode=0o700)
        self.archive = self.output / "Example-Dev.zip"
        self.archive.write_bytes(b"PK\x03\x04synthetic fixture bytes")
        self.archive.chmod(0o600)
        self.receipt = self.output / "vm-dev-artifact.json"
        self.selected = dict(
            schema="farol.vm-dev-artifact/1", kind="local-dev-derivative",
            environment="dev", appName="Example Dev.app", bundleId="local.example.dev",
            officialRelease=False, hostLaunch=False, profileImport=False,
            artifactSha256="e"*64)
        self.receipt.write_text(json.dumps(self.selected))
        self.receipt.chmod(0o600)
        self.digest = hashlib.sha256(self.receipt.read_bytes()).hexdigest()
        self.options = dev.parse_options(["--artifact", str(self.archive),
                                          "--receipt", str(self.receipt),
                                          "--expected-receipt-sha256", self.digest])


class AdmissionTests(Fixture):
    def test_fixture_admits_paths_beneath_a_symlinked_temp_prefix(self):
        alias = self.home / "temp-alias"
        alias.symlink_to(self.home, target_is_directory=True)
        temporary_directory = tempfile.TemporaryDirectory
        with mock.patch.object(tempfile, "TemporaryDirectory",
                               side_effect=lambda **kw: temporary_directory(dir=alias, **kw)):
            fixture = Fixture()
            try:
                fixture.setUp()
                self.assertEqual(fixture.home, fixture.home.resolve(strict=True))
                self.assertEqual(dev.preflight_inputs(fixture.options), fixture.selected)
            finally:
                fixture.doCleanups()

    def test_explicit_artifact_receipt_and_digest_are_required(self):
        with self.assertRaises(SystemExit), mock.patch("sys.stderr", new_callable=io.StringIO):
            dev.parse_options([])
        for extra in (["--visible", "--visible"], ["--config", "relative/path"]):
            with self.subTest(extra=extra):
                if extra[0] == "--visible":
                    with self.assertRaises(dev.VMDevError):
                        dev.parse_options(["--artifact", str(self.archive),
                            "--receipt", str(self.receipt),
                            "--expected-receipt-sha256", self.digest] + extra)
                else:
                    with self.assertRaises(dev.VMDevError):
                        dev.parse_options(["--artifact", str(self.archive),
                            "--receipt", str(self.receipt),
                            "--expected-receipt-sha256", self.digest] + extra)
        self.assertEqual(dev.preflight_inputs(self.options), self.selected)
        self.options.expected_receipt_sha256 = "a"*64
        with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_RECEIPT_CHANGED"):
            dev.preflight_inputs(self.options)

    def test_private_receipt_symlink_and_wrong_product_are_refused(self):
        other = self.output / "alias.json"
        other.symlink_to(self.receipt)
        original = self.options.receipt
        self.options.receipt = str(other)
        with self.assertRaises(OSError):
            dev.preflight_inputs(self.options)
        self.options.receipt = original
        self.selected["officialRelease"] = True
        self.receipt.write_text(json.dumps(self.selected))
        self.options.expected_receipt_sha256 = hashlib.sha256(self.receipt.read_bytes()).hexdigest()
        with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_RECEIPT_INVALID"):
            dev.preflight_inputs(self.options)

    def test_existing_clone_collision_refuses_before_any_effect(self):
        clone = "farol-qa-" + "a"*16
        (self.root / "machines" / clone).mkdir(mode=0o700)
        calls = []
        with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_PREDECESSOR_COLLISION"):
            dev.execute(self.options, infrastructure=lambda: (self.binary, self.root, self.settings),
                        identity_factory=lambda: (clone, "run-" + "c"*32),
                        binary_admission=lambda _: True, capacity_probe=lambda *a: 0,
                        clone_effect=lambda *a: calls.append("clone"))
        self.assertEqual(calls, [])

    def test_directory_publication_sync_failure_stops_before_clone(self):
        for failed_parent in (self.settings, self.settings / "vm-dev-sessions"):
            clone = "farol-qa-" + ("1" if failed_parent == self.settings else "2")*16
            actual = dev._sync_directory
            def sync(path):
                if path == failed_parent:
                    raise OSError("synthetic directory sync failure")
                actual(path)
            with self.subTest(parent=failed_parent.name), mock.patch.object(dev, "_sync_directory", side_effect=sync):
                # An unexpected host error is classified, never a raw traceback.
                with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_UNCLASSIFIED"):
                    dev.execute(self.options,
                        infrastructure=lambda: (self.binary, self.root, self.settings),
                        identity_factory=lambda: (clone, "run-" + "c"*32),
                        binary_admission=lambda _: True, capacity_probe=lambda *a: 0,
                        producer=lambda *a: self.fail("producer invoked"),
                        clone_effect=lambda *a: self.fail("clone invoked"))

    def test_missing_native_dev_producer_is_blocked_before_clone(self):
        actual = dev.module_from
        def loading(path, name):
            if name == "farol_vm_dev_producer":
                return SimpleNamespace()
            return actual(path, name)
        with mock.patch.object(dev, "module_from", side_effect=loading):
            with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_PRODUCER_UNAVAILABLE"):
                dev.execute(self.options, infrastructure=lambda: (self.binary, self.root, self.settings),
                            clone_effect=lambda *a: self.fail("clone invoked"))

    def test_clone_planning_and_stage_use_original_VM_contract_no_live_effect(self):
        clone = "farol-qa-" + "a"*16
        run = "run-" + "c"*32
        calls = []
        def cloned(command, evidence, binary, env, candidate):
            calls.append(("clone", command))
            self.assertEqual(command, [str(self.binary), "clone", "farol-base-1", clone])
            machine = self.root / "machines" / clone
            machine.mkdir(mode=0o700)
            (machine / "machine.json").write_text(json.dumps({"name": clone, "network": True}))
            (machine / "clone.json").write_text(json.dumps({
                "schema": "terminal-mac.clone/1", "from": "farol-base-1", "to": clone}))
            return 1234
        def producer(archive, receipt, digest, stage):
            calls.append(("producer", archive, receipt, digest, stage))
            self.assertEqual(archive, self.archive)
            self.assertEqual(receipt, self.receipt)
            self.assertEqual(digest, self.digest)
            self.assertTrue(stage.is_dir())
            return {"runId": run, "manifestSHA256": "a"*64,
                    "acceptanceSHA256": "b"*64, "artifactSHA256": "e"*64}
        def started(binary, name, visible, evidence, env):
            calls.append(("start", name, visible))
            self.assertFalse(visible)
            self.assertTrue((evidence / "selection.json").exists())
            self.assertTrue((evidence / "payload.json").exists())
        closed = closed_session_mcp(self.root)
        def handed(binary, root, name, stage, session, evidence, env, gate=None):
            calls.append(("mcp", name, session))
            self.assertEqual(session["manifestSHA256"], "a"*64)
            self.assertEqual(session["acceptanceSHA256"], "b"*64)
            self.assertEqual(env["TERMINAL_MAC_HOME"], str(self.root))
            return closed(binary, root, name, stage, session, evidence, env, gate)
        with mock.patch.object(dev, "_guest_grants", return_value=None), \
             mock.patch.object(dev, "_one_stop", side_effect=lambda *a: calls.append(("stop",))), \
             mock.patch.object(dev, "_host_status", side_effect=stopped_status):
            result = dev.execute(self.options,
                infrastructure=lambda: (self.binary, self.root, self.settings),
                identity_factory=lambda: (clone, run),
                clone_effect=cloned, start_effect=started, producer=producer,
                binary_admission=lambda _: True, capacity_probe=lambda *a: 0, mcp_effect=handed)
        self.assertEqual([entry[0] for entry in calls], ["clone", "producer", "start", "mcp", "stop"])
        self.assertEqual(result["status"], "CLOSED_AND_REMOVED")
        self.assertTrue((self.settings / "instance-receipts" / (clone + ".json")).is_file())
        evidence = self.settings / "vm-dev-sessions" / clone
        self.assertEqual(json.loads((evidence / "selection.json").read_text())["runId"], run)
        self.assertTrue((evidence / "stage-receipt.json").is_file())
        self.assertFalse((evidence / "handoff.json").exists(),
                         "mocked exec does not invent a native MCP terminal receipt")

    def test_repeated_sessions_allocate_new_clones_and_keep_original_evidence(self):
        sessions = []
        def cloned(command, evidence, binary, env, run):
            clone = command[3]
            machine = self.root / "machines" / clone
            machine.mkdir(mode=0o700)
            (machine / "machine.json").write_text(json.dumps({"name": clone, "network": True}))
            (machine / "clone.json").write_text(json.dumps({"to": clone}))
            sessions.append(clone)
            return 1234
        def producer(archive, receipt, digest, stage):
            return {"runId": stage.name, "manifestSHA256": "a"*64,
                    "acceptanceSHA256": "b"*64, "artifactSHA256": "e"*64}
        retained = {}
        for digit in ("1", "2"):
            clone, run = "farol-qa-" + digit*16, "run-" + digit*32
            with mock.patch.object(dev, "_guest_grants", return_value=None), \
                 mock.patch.object(dev, "_one_stop"), \
                 mock.patch.object(dev, "_host_status", side_effect=stopped_status):
                dev.execute(self.options,
                    infrastructure=lambda: (self.binary, self.root, self.settings),
                    identity_factory=lambda: (clone, run), clone_effect=cloned,
                    start_effect=lambda *a: None, producer=producer,
                    binary_admission=lambda _: True, capacity_probe=lambda *a: 0,
                    mcp_effect=closed_session_mcp(self.root))
            for path, original in retained.items():
                self.assertEqual(path.read_bytes(), original)
            evidence = self.settings / "vm-dev-sessions" / clone
            retained.update({path: path.read_bytes() for path in evidence.glob("*.json")})
            self.assertTrue((evidence / "stage-receipt.json").is_file())
        self.assertEqual(sessions, ["farol-qa-" + "1"*16, "farol-qa-" + "2"*16])

    def test_failed_stage_keeps_evidence_but_removes_the_never_started_clone(self):
        clone = "farol-qa-" + "f"*16
        run = "run-" + "c"*32
        def cloned(command, evidence, binary, env, candidate):
            machine = self.root / "machines" / clone
            machine.mkdir(mode=0o700)
            (machine / "machine.json").write_text(json.dumps({"name": clone, "network": True}))
            (machine / "clone.json").write_text(json.dumps({"to": clone}))
        def broken(archive, receipt, digest, stage):
            (stage / "blob-synthetic").write_text("partial")
            raise RuntimeError("unclassified synthetic error")
        with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_STAGING_UNCONFIRMED") as raised, \
             mock.patch.object(dev, "_guest_grants") as grants, \
             mock.patch.object(dev, "_one_stop") as stop, \
             mock.patch.object(dev, "_host_status", side_effect=stopped_status):
            dev.execute(self.options,
                infrastructure=lambda: (self.binary, self.root, self.settings),
                identity_factory=lambda: (clone, run),
                clone_effect=cloned, start_effect=lambda *a: self.fail("start"),
                producer=broken, binary_admission=lambda _: True, capacity_probe=lambda *a: 0,
                mcp_effect=lambda *a: self.fail("mcp"))
        evidence = self.settings / "vm-dev-sessions" / clone
        self.assertTrue((evidence / "stage-intent.json").is_file())
        self.assertFalse((evidence / "stage-receipt.json").exists())
        # Staging is host-only and the guest never started: the clone it
        # created (including the partial blobs) is removed, the evidence kept.
        self.assertFalse((self.root / "machines" / clone).exists())
        self.assertEqual(raised.exception.result["status"], "REFUSED_AND_REMOVED")
        self.assertEqual(json.loads((evidence / "result.json").read_text())["code"],
                         "VM_DEV_STAGING_UNCONFIRMED")
        grants.assert_not_called()
        stop.assert_not_called()


class EffectsTests(Fixture):
    def test_clone_effect_once_and_original_pid_are_recorded(self):
        directory = self.settings / "clone-evidence"
        directory.mkdir(mode=0o700)
        command = [str(self.binary), "clone", "farol-base-1", "farol-qa-" + "a"*16]
        class Fake:
            pid = 4291
            def wait(self, timeout):
                self.last = timeout
                return 0
        calls = []
        with mock.patch.object(dev.subprocess, "Popen", side_effect=lambda *a, **k: (
            calls.append((a, k)) or Fake())):
            dev._one_clone(command, directory, self.binary, {}, "run-" + "b"*32)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["stdin"], subprocess.DEVNULL)
        self.assertTrue((directory / "clone-intent.json").exists())
        value = json.loads((directory / "clone-receipt.json").read_text())
        self.assertEqual(value["pid"], 4291)
        self.assertEqual(value["descendantCleanup"], "unverified")

    def test_unknown_clone_never_creates_success_receipt_or_replays(self):
        directory = self.settings / "unknown-evidence"
        directory.mkdir(mode=0o700)
        class Unknown:
            pid = 4381
            def wait(self, timeout):
                raise subprocess.TimeoutExpired(cmd=["synthetic"], timeout=1)
        with mock.patch.object(dev.subprocess, "Popen", return_value=Unknown()) as started:
            with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_CLONE_OUTCOME_UNKNOWN"):
                dev._one_clone([str(self.binary), "clone", "farol-base-1",
                                "farol-qa-" + "a"*16], directory, self.binary,
                               {}, "run-" + "b"*32)
        started.assert_called_once()
        self.assertTrue((directory / "clone-intent.json").exists())
        self.assertFalse((directory / "clone-receipt.json").exists())

    def test_start_default_hidden_visible_explicit_and_no_second_start(self):
        for visible in (False, True):
            with self.subTest(visible=visible):
                evidence = self.settings / ("start-" + str(visible))
                evidence.mkdir(mode=0o700)
                class Runtime:
                    pid = 5201
                    def poll(self): return None
                with mock.patch.object(dev.subprocess, "Popen", return_value=Runtime()) as popen, \
                     mock.patch.object(dev, "_host_status", return_value={
                         "state": "running", "pid": "6201", "name": "farol-qa-" + "a"*16,
                         "artifactShareReadOnly": "true",
                         "artifactShareEvidence": "live-vz-configuration/1"}):
                    dev._one_start(self.binary, "farol-qa-" + "a"*16, visible, evidence, {})
                self.assertEqual(popen.call_count, 1)
                self.assertEqual(popen.call_args.args[0][-1:] == ["--window"], visible)
                self.assertTrue((evidence / "start-receipt.json").exists())

    def test_detached_launcher_exit_zero_requires_fresh_runtime_identity(self):
        for pid, error in [("6201", None), (None, "VM_DEV_RUNTIME_IDENTITY_INVALID"),
                           ("5201", "VM_DEV_RUNTIME_IDENTITY_INVALID")]:
            with self.subTest(pid=pid):
                evidence = self.settings / ("detached-" + str(pid))
                evidence.mkdir(mode=0o700)
                launcher = SimpleNamespace(pid=5201, poll=lambda: 0)
                status = dict(state="running", pid=pid, name="farol-qa-" + "a"*16,
                              artifactShareReadOnly="true",
                              artifactShareEvidence="live-vz-configuration/1")
                with mock.patch.object(dev.subprocess, "Popen", return_value=launcher) as started, \
                     mock.patch.object(dev, "_host_status", return_value=status) as observed:
                    if error:
                        with self.assertRaisesRegex(dev.VMDevError, error):
                            dev._one_start(self.binary, status["name"], False, evidence, {})
                        self.assertFalse((evidence / "start-receipt.json").exists())
                    else:
                        self.assertEqual(dev._one_start(self.binary, status["name"], False,
                                                        evidence, {}), 6201)
                        receipt = json.loads((evidence / "start-receipt.json").read_text())
                        self.assertEqual(receipt["launcherPID"], 5201)
                        self.assertEqual(receipt["launcherExit"], 0)
                        self.assertEqual(receipt["runtimePID"], 6201)
                started.assert_called_once()
                observed.assert_called_once()

    def test_capacity_refuses_two_active_or_unknown_without_starting(self):
        second = self.root / "machines/farol-other"
        second.mkdir(mode=0o700)
        for states, error in [(["running", "running"], "VM_DEV_CAPACITY_BUSY"),
                              (["running", "unconfirmed"], "VM_DEV_CAPACITY_UNKNOWN"),
                              # A stop waiting on the guest's own confirmation still holds a slot.
                              (["running", "stopping-awaiting-guest-confirmation"], "VM_DEV_CAPACITY_BUSY"),
                              (["stopped", "running"], None)]:
            replies = [dict(name=name, state=state) for name, state in zip(
                ["farol-base-1", "farol-other"], states)]
            with mock.patch.object(dev, "_host_status", side_effect=replies), \
                 mock.patch.object(dev.subprocess, "Popen") as effect:
                if error:
                    with self.assertRaisesRegex(dev.VMDevError, error):
                        dev._capacity(self.binary, self.root, {})
                else:
                    self.assertEqual(dev._capacity(self.binary, self.root, {}), 1)
                effect.assert_not_called()

    def test_failed_launcher_does_not_replay_start(self):
        evidence = self.settings / "failed-launcher"
        evidence.mkdir(mode=0o700)
        with mock.patch.object(dev.subprocess, "Popen",
                               return_value=SimpleNamespace(pid=5201, poll=lambda: 1)) as started:
            with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_START_OUTCOME_UNKNOWN"):
                dev._one_start(self.binary, "farol-qa-" + "a"*16, False, evidence, {})
        started.assert_called_once()
        self.assertFalse((evidence / "start-receipt.json").exists())

    def test_helper_preflight_is_readonly_and_requires_version_permissions(self):
        evidence = self.settings / "helper"
        evidence.mkdir(mode=0o700)
        values = dict(appServiceContract="terminal-mac.app-service/4",
                      appServiceExecutor="compiled-native-helper",
                      appServiceLaunchIdentityContract="terminal-mac.launch-identity/1",
                      appServiceAdmission="available", accessibility="true",
                      screenRecording="true")
        def response(**changes):
            return SimpleNamespace(returncode=0,
                stdout=json.dumps(dict(values, **changes)).encode(), stderr=b"")
        with mock.patch.object(dev.subprocess, "run", return_value=response()) as probe:
            dev._guest_grants(self.binary, "farol-qa-" + "a"*16, evidence, {})
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(probe.call_args.args[0][1:5],
                         ["action", "--vm", "farol-qa-" + "a"*16, "status"])
        self.assertEqual(json.loads((evidence / "helper-preflight.json").read_text())["state"],
                         "AVAILABLE_NOT_APP_READY")
        for result, error in [
            (response(appServiceContract="terminal-mac.app-service/1"), "VM_DEV_HELPER_INCOMPATIBLE"),
            (response(accessibility="false"), "VM_DEV_NEEDS_OWNER_PERMISSIONS"),
            (response(appServiceAdmission="active-or-unresolved"), "VM_DEV_HELPER_CUSTODY_UNRESOLVED"),
        ]:
            with self.subTest(error=error), mock.patch.object(dev.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(dev.VMDevError, error):
                    dev._guest_grants(self.binary, "farol-qa-" + "a"*16,
                                      self.settings, {})

    def test_helper_unavailable_reports_needs_owner_without_guest_mutation(self):
        evidence = self.settings / "missing-helper"
        evidence.mkdir(mode=0o700)
        with mock.patch.object(dev.time, "monotonic", side_effect=[100, 161]), \
             mock.patch.object(dev.subprocess, "run") as probe:
            with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_NEEDS_OWNER_HELPER_UNAVAILABLE"):
                dev._guest_grants(self.binary, "farol-qa-" + "b"*16, evidence, {})
        probe.assert_not_called()
        self.assertFalse((evidence / "helper-preflight.json").exists())

    def test_runtime_readonly_share_drift_blocks_and_retains_start_intent(self):
        evidence = self.settings / "bad-share"
        evidence.mkdir(mode=0o700)
        class Running:
            pid = 4101
            def poll(self): return None
        with mock.patch.object(dev.subprocess, "Popen", return_value=Running()) as started, \
             mock.patch.object(dev, "_host_status", return_value={
                 "state": "running", "pid": "6201", "name": "farol-qa-" + "a"*16,
                 "artifactShareReadOnly": "false",
                 "artifactShareEvidence": "live-vz-configuration/1"}):
            with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_HOST_GRANTS_INVALID"):
                dev._one_start(self.binary, "farol-qa-" + "a"*16, False, evidence, {})
        started.assert_called_once()
        self.assertTrue((evidence / "start-intent.json").exists())
        self.assertFalse((evidence / "start-receipt.json").exists())

    def test_mcp_child_inherits_stdio_and_records_its_exit_once(self):
        evidence = self.settings / "handoff-evidence"
        evidence.mkdir(mode=0o700)
        session = dict(runId="run-" + "a"*32,
                       manifestSHA256="b"*64, acceptanceSHA256="c"*64)
        class Child:
            pid = 7001
            def wait(self):
                return 0
        with mock.patch.object(dev.subprocess, "Popen", return_value=Child()) as spawned, \
             mock.patch.object(dev.os, "dup2") as dup2:
            status = dev._run_mcp(self.binary, self.root, "farol-qa-" + "f"*16,
                                  self.output, session, evidence, {"HOME": "/synthetic"})
        self.assertEqual(status, 0)
        spawned.assert_called_once()
        argv = spawned.call_args.args[0]
        options = spawned.call_args.kwargs
        self.assertEqual(argv, [str(self.binary), "mcp", "farol-qa-" + "f"*16,
                                "--app-run", session["runId"],
                                "--app-manifest", session["manifestSHA256"],
                                "--app-acceptance", session["acceptanceSHA256"]])
        for stream in ("stdin", "stdout", "stderr"):
            self.assertNotIn(stream, options, "stdio is inherited, never piped")
        self.assertEqual(options["env"]["TERMINAL_MAC_HOME"], str(self.root))
        self.assertEqual(dup2.call_args.args[1], 1, "the controller drops its own stdout copy")
        handoff = json.loads((evidence / "handoff.json").read_text())
        self.assertEqual(handoff["status"], "mcp-pending")
        self.assertTrue((evidence / "mcp-intent.json").is_file())
        receipt = json.loads((evidence / "mcp-receipt.json").read_text())
        self.assertEqual((receipt["exitCode"], receipt["signal"]), (0, None))
        self.assertNotIn("password", str(handoff).lower())

    def test_mcp_spawn_failure_is_a_known_refusal(self):
        evidence = self.settings / "spawn-evidence"
        evidence.mkdir(mode=0o700)
        session = dict(runId="run-" + "a"*32, manifestSHA256="b"*64, acceptanceSHA256="c"*64)
        with mock.patch.object(dev.subprocess, "Popen", side_effect=OSError("synthetic")):
            with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_MCP_SPAWN_REFUSED"):
                dev._run_mcp(self.binary, self.root, "farol-qa-" + "f"*16,
                             self.output, session, evidence, {})
        self.assertNotIn("VM_DEV_MCP_SPAWN_REFUSED", dev.UNKNOWN_CODES)



class TeardownTests(Fixture):
    """The controller removes what it creates, except where an outcome is unknown."""
    clone = "farol-qa-" + "d"*16
    run_id = "run-" + "d"*32

    def cloned(self, command, evidence, binary, env, run):
        machine = self.root / "machines" / command[3]
        machine.mkdir(mode=0o700)
        (machine / "machine.json").write_text(json.dumps({"name": command[3], "network": True}))
        (machine / "clone.json").write_text(json.dumps({
            "schema": "terminal-mac.clone/1", "from": "farol-base-1", "to": command[3]}))
        (machine / "disk.img").write_bytes(b"synthetic disk")
        return 1234

    @staticmethod
    def producer(archive, receipt, digest, stage):
        (stage / "blob-synthetic").write_text("staged")
        return {"runId": stage.name, "manifestSHA256": "a"*64,
                "acceptanceSHA256": "b"*64, "artifactSHA256": "e"*64}

    def session(self, mcp=None, start=None, grants=None, stop=None, status=stopped_status, gate=None):
        effects = []
        def started(*a):
            effects.append("start")
            if start is not None:
                start()
        def stopped(binary, name, evidence, env):
            effects.append("stop")
            if stop is not None:
                stop()
        def granted(*a):
            effects.append("grants")
            if grants is not None:
                grants()
        error = None
        with mock.patch.object(dev, "_guest_grants", side_effect=granted), \
             mock.patch.object(dev, "_one_stop", side_effect=stopped), \
             mock.patch.object(dev, "_host_status", side_effect=status):
            try:
                result = dev.execute(self.options,
                    infrastructure=lambda: (self.binary, self.root, self.settings),
                    identity_factory=lambda: (self.clone, self.run_id),
                    clone_effect=self.cloned, start_effect=started, producer=self.producer,
                    binary_admission=lambda _: True, capacity_probe=lambda *a: 0,
                    mcp_effect=mcp or closed_session_mcp(self.root), gate=gate)
            except dev.VMDevError as raised:
                error, result = raised, raised.result
        evidence = self.settings / "vm-dev-sessions" / self.clone
        return error, result, effects, evidence, self.root / "machines" / self.clone

    def test_clean_close_stops_the_guest_and_deletes_only_its_own_clone(self):
        error, result, effects, evidence, machine = self.session()
        self.assertIsNone(error)
        self.assertEqual(effects, ["start", "grants", "stop"])
        self.assertEqual(result["status"], "CLOSED_AND_REMOVED")
        self.assertEqual(result["outcome"], "clean")
        self.assertFalse(machine.exists())
        self.assertTrue((self.root / "machines/farol-base-1/machine.json").is_file(), "the base is untouched")
        self.assertTrue((self.settings / "instance-receipts" / (self.clone + ".json")).is_file())
        # terminal-mac's own session records survive the clone deletion.
        copied = evidence / "terminal-mac-session" / "terminal.json"
        self.assertEqual(json.loads(copied.read_text())["state"], "CLOSED")
        self.assertEqual((evidence / "terminal-mac-session" / "service.lock").read_bytes(), b"")
        self.assertTrue((evidence / "delete-intent.json").is_file())
        self.assertTrue((evidence / "delete-receipt.json").is_file())
        self.assertEqual(json.loads((evidence / "result.json").read_text())["removed"], [str(machine)])

    def test_known_refusal_after_a_confirmed_start_stops_and_removes(self):
        for code in ("VM_DEV_HELPER_INCOMPATIBLE", "VM_DEV_NEEDS_OWNER_PERMISSIONS",
                     "VM_DEV_HELPER_CUSTODY_UNRESOLVED", "VM_DEV_NEEDS_OWNER_HELPER_UNAVAILABLE"):
            with self.subTest(code=code):
                self.clone = "farol-qa-" + hashlib.sha256(code.encode()).hexdigest()[:16]
                def refuse(code=code):
                    raise dev.VMDevError(code)
                error, result, effects, evidence, machine = self.session(
                    grants=refuse, mcp=lambda *a: self.fail("mcp after refusal"))
                self.assertEqual(error.code, code)
                self.assertEqual(effects, ["start", "grants", "stop"])
                self.assertEqual(result["status"], "REFUSED_AND_REMOVED")
                self.assertEqual(result["outcome"], "known-refusal")
                self.assertFalse(machine.exists())

    def test_writable_share_after_attested_start_is_stopped_and_removed(self):
        def writable():
            error = dev.VMDevError("VM_DEV_HOST_GRANTS_INVALID")
            error.running = True
            raise error
        error, result, effects, _, machine = self.session(start=writable)
        self.assertEqual(error.code, "VM_DEV_HOST_GRANTS_INVALID")
        self.assertEqual(effects, ["start", "stop"])
        self.assertEqual(result["status"], "REFUSED_AND_REMOVED")
        self.assertFalse(machine.exists())

    def test_unknown_outcomes_retain_vm_clone_and_evidence(self):
        cases = {
            "mcp-nonzero": dict(mcp=closed_session_mcp(self.root, status=201)),
            "mcp-signal": dict(mcp=closed_session_mcp(self.root, status=-15)),
            "mcp-close-unproven": dict(mcp=closed_session_mcp(self.root, terminal=False)),
            "start-unknown": dict(start=lambda: (_ for _ in ()).throw(dev.VMDevError("VM_DEV_RUNTIME_START_UNKNOWN"))),
            "unclassified": dict(grants=lambda: (_ for _ in ()).throw(RuntimeError("synthetic"))),
        }
        for name, options in cases.items():
            with self.subTest(case=name):
                self.clone = "farol-qa-" + hashlib.sha256(name.encode()).hexdigest()[:16]
                error, result, effects, evidence, machine = self.session(**options)
                self.assertIn(error.code, dev.UNKNOWN_CODES)
                self.assertNotIn("stop", effects, "an unknown outcome is never stopped")
                self.assertEqual(result["status"], "RETAINED")
                self.assertEqual(result["outcome"], "unknown")
                self.assertTrue((machine / "disk.img").exists())
                self.assertEqual(result["retained"], [str(machine), str(evidence)])
                self.assertFalse((evidence / "delete-intent.json").exists())

    def test_unknown_clone_without_a_directory_is_still_retained_as_unknown(self):
        def lost(command, evidence, binary, env, run):
            raise dev.VMDevError("VM_DEV_CLONE_OUTCOME_UNKNOWN")
        self.cloned = lost
        error, result, effects, evidence, machine = self.session()
        self.assertEqual(error.code, "VM_DEV_CLONE_OUTCOME_UNKNOWN")
        self.assertEqual(result["status"], "RETAINED")
        self.assertEqual(result["retained"], [str(evidence)])
        self.assertEqual(effects, [])

    def test_unconfirmed_teardown_retains_and_reports(self):
        cases = {
            "stop-unknown": dict(stop=lambda: (_ for _ in ()).throw(dev.VMDevError("VM_DEV_STOP_OUTCOME_UNKNOWN"))),
            "not-stopped": dict(status=lambda binary, name, env: {"name": name, "state": "running"}),
        }
        for name, options in cases.items():
            with self.subTest(case=name):
                self.clone = "farol-qa-" + hashlib.sha256(name.encode()).hexdigest()[:16]
                error, result, _, evidence, machine = self.session(**options)
                self.assertEqual(result["status"], "RETAINED")
                self.assertTrue(machine.exists())
                self.assertEqual(result["outcome"], "clean", "the session itself closed cleanly")
                self.assertIn(error.code, ("VM_DEV_STOP_OUTCOME_UNKNOWN", "VM_DEV_CLONE_DELETE_REFUSED",
                                           "VM_DEV_STOP_UNCONFIRMED"))

    def test_deletion_requires_positive_identification(self):
        def tamper_receipt(*a):
            receipt = self.settings / "instance-receipts" / (self.clone + ".json")
            value = json.loads(receipt.read_text())
            value["base"] = "farol-base-2"
            receipt.write_text(json.dumps(value))
        def symlinked_machine(*a):
            machine = self.root / "machines" / self.clone
            moved = self.root / "elsewhere"
            machine.rename(moved)
            machine.symlink_to(moved, target_is_directory=True)
        for name, mutate in (("receipt-changed", tamper_receipt), ("machine-symlink", symlinked_machine)):
            with self.subTest(case=name):
                self.clone = "farol-qa-" + hashlib.sha256(name.encode()).hexdigest()[:16]
                closed = closed_session_mcp(self.root)
                def mcp(*args, mutate=mutate, closed=closed):
                    status = closed(*args)
                    mutate()
                    return status
                error, result, _, evidence, machine = self.session(mcp=mcp)
                self.assertEqual(result["status"], "RETAINED")
                self.assertFalse((evidence / "delete-intent.json").exists())
                self.assertTrue(machine.exists() or machine.is_symlink())
                if name == "machine-symlink":
                    self.assertTrue((self.root / "elsewhere" / "disk.img").exists())
                    (self.root / "machines" / self.clone).unlink()
                    shutil.rmtree(self.root / "elsewhere")

    def test_linked_session_record_is_never_followed_and_retains_the_clone(self):
        outside = self.home / "host-only.json"
        outside.write_text("host bytes")
        closed = closed_session_mcp(self.root)
        def mcp(binary, vm_root, name, stage, session, evidence, env, gate=None):
            status = closed(binary, vm_root, name, stage, session, evidence, env, gate)
            run = vm_root / "machines" / name / "mcp-app-sessions" / session["runId"]
            (run / "planted.json").symlink_to(outside)
            return status
        self.clone = "farol-qa-" + "7"*16
        error, result, _, evidence, machine = self.session(mcp=mcp)
        self.assertEqual(result["status"], "RETAINED")
        self.assertIn("VM_DEV_SESSION_EVIDENCE_UNSAFE", error.code)
        self.assertTrue(machine.exists())
        copied = evidence / "terminal-mac-session"
        self.assertFalse((copied / "planted.json").exists())

    def test_base_and_foreign_names_are_never_deleted(self):
        evidence = self.settings / "guard"
        evidence.mkdir(mode=0o700)
        for name in ("farol-base-1", "farol-qa-short", "../farol-base-1"):
            with self.subTest(name=name), mock.patch.object(dev, "_host_status", side_effect=stopped_status):
                with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_CLONE_DELETE_REFUSED"):
                    dev._delete_clone(self.binary, self.root, name, "farol-base-1",
                                      self.base_receipt, "0"*64, evidence, {})
        self.assertTrue((self.root / "machines/farol-base-1").is_dir())
        self.assertFalse((evidence / "delete-intent.json").exists())

    def test_cancellation_before_mcp_retains_and_teardown_cancel_retains(self):
        def cancel():
            raise dev.Cancelled()
        error, result, effects, _, machine = self.session(grants=cancel)
        self.assertEqual(error.code, "VM_DEV_CANCELLED")
        self.assertNotIn("stop", effects)
        self.assertEqual(result["status"], "RETAINED")
        self.assertTrue(machine.exists())
        self.clone = "farol-qa-" + "9"*16
        gate = dev._SignalGate()
        closed = closed_session_mcp(self.root)
        def mcp(*args):
            gate.requested = 15  # a signal arrived while the MCP child owned stdio
            return closed(*args)
        error, result, effects, _, machine = self.session(mcp=mcp, gate=gate)
        self.assertEqual(error.code, "VM_DEV_TEARDOWN_CANCELLED")
        self.assertNotIn("stop", effects)
        self.assertEqual(result["status"], "RETAINED")
        self.assertTrue(machine.exists())

    def test_main_exit_codes_and_retained_paths(self):
        self.clone = "farol-qa-" + "8"*16
        def run_main(execute):
            lines = []
            with mock.patch.object(dev, "parse_options", return_value=self.options), \
                 mock.patch.object(dev, "execute", side_effect=execute), \
                 mock.patch.object(dev, "_diagnose", side_effect=lines.append), \
                 redirect_stdout(io.StringIO()) as stdout:
                code = dev.main([])
            self.assertEqual(stdout.getvalue(), "", "stdout belongs to the MCP only")
            return code, "\n".join(lines)
        self.assertEqual(run_main(lambda *a, **k: {"status": "CLOSED_AND_REMOVED"})[0], 0)
        def refused(*a, **k):
            error = dev.VMDevError("VM_DEV_HELPER_INCOMPATIBLE")
            error.result = {"status": "REFUSED_AND_REMOVED", "retained": ["/evidence"]}
            raise error
        self.assertEqual(run_main(refused)[0], 1)
        def retained(*a, **k):
            error = dev.VMDevError("VM_DEV_MCP_OUTCOME_UNKNOWN")
            error.result = {"status": "RETAINED", "retained": ["/machines/x", "/evidence"]}
            raise error
        code, text = run_main(retained)
        self.assertEqual(code, 2)
        self.assertIn("VM_DEV_RETAINED /machines/x", text)
        self.assertEqual(run_main(lambda *a, **k: (_ for _ in ()).throw(dev.VMDevError("VM_DEV_CAPACITY_BUSY")))[0], 1)
        self.assertEqual(run_main(lambda *a, **k: (_ for _ in ()).throw(KeyError("x")))[0], 2)



class HelperBindingTests(Fixture):
    values = dict(appServiceContract="terminal-mac.app-service/4",
                  appServiceExecutor="compiled-native-helper",
                  appServiceLaunchIdentityContract="terminal-mac.launch-identity/1",
                  appServiceAdmission="available", accessibility="true",
                  screenRecording="true", version="0.2.0", build="19")

    def probe(self, expected, **changes):
        evidence = self.settings / ("helper-" + hashlib.sha256(repr((expected, changes)).encode()).hexdigest()[:8])
        evidence.mkdir(mode=0o700)
        reply = SimpleNamespace(returncode=0, stdout=json.dumps(dict(self.values, **changes)).encode(), stderr=b"")
        with mock.patch.object(dev.subprocess, "run", return_value=reply):
            dev._guest_grants(self.binary, "farol-qa-" + "a"*16, evidence, {}, expected)
        return json.loads((evidence / "helper-preflight.json").read_text())

    def test_live_helper_must_match_the_base_receipt_build(self):
        expected = {"helperVersion": "0.2.0", "helperBuild": "19"}
        record = self.probe(expected)
        self.assertEqual(record["helperIdentity"], {"helperVersion": "0.2.0", "helperBuild": "19"})
        self.assertEqual(record["baseHelperBinding"], "bound:helperBuild,helperVersion")
        self.assertEqual(record["guestDiskBinding"], "unbound-no-disk-identity-in-receipt")
        for changes in ({"build": "20"}, {"version": "0.3.0"}, {"build": None}):
            with self.subTest(changes=changes), self.assertRaisesRegex(dev.VMDevError, "VM_DEV_HELPER_BUILD_MISMATCH"):
                self.probe(expected, **changes)
        self.assertNotIn("VM_DEV_HELPER_BUILD_MISMATCH", dev.UNKNOWN_CODES)

    def test_receipt_without_helper_fields_is_recorded_unbound(self):
        record = self.probe({})
        self.assertEqual(record["baseHelperBinding"], "unbound-base-receipt")

    def test_base_helper_identity_reads_only_existing_receipt_fields(self):
        self.assertEqual(dev.base_helper_identity(self.base_receipt.read_bytes()), {})
        value = json.loads(self.base_receipt.read_text())
        value.update(helperVersion="0.2.0", helperBuild="19", diskSha256=None)
        self.assertEqual(dev.base_helper_identity(json.dumps(value).encode()),
                         {"helperVersion": "0.2.0", "helperBuild": "19"})
        for bad in ({"helperBuild": 19}, {"helperBuild": "../19"}, {"helperVersion": ""}):
            with self.subTest(bad=bad), self.assertRaisesRegex(dev.VMDevError, "VM_DEV_BASE_NOT_READY"):
                dev.base_helper_identity(json.dumps(dict(value, **bad)).encode())

    def test_malformed_recorded_helper_identity_refuses_before_any_clone(self):
        value = json.loads(self.base_receipt.read_text())
        value["helperBuild"] = 19
        self.base_receipt.write_text(json.dumps(value))
        with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_BASE_NOT_READY"):
            dev.execute(self.options, infrastructure=lambda: (self.binary, self.root, self.settings),
                        identity_factory=lambda: ("farol-qa-" + "b"*16, "run-" + "b"*32),
                        binary_admission=lambda _: True, capacity_probe=lambda *a: 0,
                        clone_effect=lambda *a: self.fail("clone invoked"))


class ExitStatusRobustnessTests(Fixture):
    """Exit status and records survive a dead agent host and badly timed signals."""
    PROGRAM = """import importlib.util, json, os, sys
os.environ["FAROL_VM_DEV_IDENTITY"] = sys.argv[2]
spec = importlib.util.spec_from_file_location("closed_pipe_dev", sys.argv[1])
dev = importlib.util.module_from_spec(spec); spec.loader.exec_module(dev)
def execute(*args, **kwargs):
    error = dev.VMDevError(sys.argv[3])
    error.result = {"status": sys.argv[4], "retained": ["/machines/x", "/evidence"]}
    raise error
dev.execute = execute
dev.parse_options = lambda argv: None
dev.run_cli([])
"""

    def run_with_closed_stderr(self, code, status):
        read, write = os.pipe()
        os.close(read)  # the agent host is gone: every stderr write gets EPIPE
        try:
            child = subprocess.run(
                [sys.executable, "-B", "-c", self.PROGRAM, str(ROOT / "vm-dev-session.py"),
                 json.dumps(SYNTHETIC_IDENTITY), code, status],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=write, timeout=30)
        finally:
            os.close(write)
        return child.returncode

    def test_retained_run_exits_2_even_when_stderr_is_a_closed_pipe(self):
        self.assertEqual(self.run_with_closed_stderr("VM_DEV_MCP_OUTCOME_UNKNOWN", "RETAINED"), 2)
        self.assertEqual(self.run_with_closed_stderr("VM_DEV_STOP_OUTCOME_UNKNOWN", "RETAINED"), 2)
        self.assertEqual(self.run_with_closed_stderr("VM_DEV_HELPER_INCOMPATIBLE", "REFUSED_AND_REMOVED"), 1)

    def test_failed_result_record_on_a_clean_close_never_exits_0(self):
        teardown = TeardownTests(methodName="test_clean_close_stops_the_guest_and_deletes_only_its_own_clone")
        teardown.setUp()
        self.addCleanup(teardown.doCleanups)
        teardown.clone = "farol-qa-" + "6"*16
        actual = dev._write_once
        def write_once(directory, leaf, document):
            if leaf == "result.json":
                raise OSError("synthetic result write failure")
            return actual(directory, leaf, document)
        with mock.patch.object(dev, "_write_once", side_effect=write_once):
            error, result, _, _, machine = teardown.session()
        self.assertEqual(error.code, "VM_DEV_RESULT_UNCONFIRMED")
        self.assertEqual(result["status"], "RESULT_UNCONFIRMED")
        self.assertEqual(dev.exit_status(error), 2)

    def test_signal_during_spawn_is_forwarded_and_before_spawn_starts_nothing(self):
        evidence = self.settings / "spawn-signal"
        evidence.mkdir(mode=0o700)
        session = dict(runId="run-" + "a"*32, manifestSHA256="b"*64, acceptanceSHA256="c"*64)
        gate = dev._SignalGate()
        sent = []
        class Child:
            def send_signal(self, number):
                sent.append(number)
            def wait(self):
                return -15
        def spawn(*args, **kwargs):
            # The signal arrives while Popen runs: it must be recorded, not raised.
            gate.handle(dev.signal.SIGTERM, None)
            return Child()
        with mock.patch.object(dev.subprocess, "Popen", side_effect=spawn), mock.patch.object(dev.os, "dup2"):
            status = dev._run_mcp(self.binary, self.root, "farol-qa-" + "f"*16, self.output,
                                  session, evidence, {}, gate)
        self.assertEqual(status, -15)
        self.assertEqual(sent, [dev.signal.SIGTERM], "the child is signalled, not orphaned")
        early = dev._SignalGate()
        early.mode = "before-mcp"
        early.requested = dev.signal.SIGTERM
        evidence2 = self.settings / "spawn-signal-early"
        evidence2.mkdir(mode=0o700)
        with mock.patch.object(dev.subprocess, "Popen") as popen:
            with self.assertRaises(dev.Cancelled):
                dev._run_mcp(self.binary, self.root, "farol-qa-" + "f"*16, self.output,
                             session, evidence2, {}, early)
        popen.assert_not_called()

    def test_signal_after_the_session_returns_cannot_skip_the_result_record(self):
        teardown = TeardownTests(methodName="test_clean_close_stops_the_guest_and_deletes_only_its_own_clone")
        teardown.setUp()
        self.addCleanup(teardown.doCleanups)
        teardown.clone = "farol-qa-" + "5"*16
        gate = dev._SignalGate()
        closed = closed_session_mcp(teardown.root)
        def mcp(*args):
            status = closed(*args)
            gate.mode = "before-mcp"  # the window: session returning, teardown not yet entered
            return status
        original = dev._closed_session
        def closed_then_signal(*args):
            value = original(*args)
            gate.handle(dev.signal.SIGTERM, None)  # raises Cancelled in before-mcp mode
            return value
        with mock.patch.object(dev, "_closed_session", side_effect=closed_then_signal):
            error, result, effects, evidence, machine = teardown.session(mcp=mcp, gate=gate)
        self.assertEqual(error.code, "VM_DEV_CANCELLED")
        self.assertEqual(result["status"], "RETAINED")
        self.assertTrue((evidence / "result.json").is_file())
        self.assertNotIn("stop", effects)
        self.assertTrue(machine.exists(), "nothing is deleted on this path")
        self.assertEqual(gate.mode, "teardown")

    def test_stop_is_one_exact_invocation_without_force(self):
        evidence = self.settings / "stop-argv"
        evidence.mkdir(mode=0o700)
        calls = []
        class Child:
            def wait(self, timeout):
                return 0
        def spawn(argv, **kwargs):
            calls.append((argv, kwargs))
            return Child()
        with mock.patch.object(dev.subprocess, "Popen", side_effect=spawn), \
             mock.patch.object(dev, "_host_status", side_effect=stopped_status):
            dev._one_stop(self.binary, "farol-qa-" + "f"*16, evidence, {})
        self.assertEqual([argv for argv, _ in calls],
                         [[str(self.binary), "stop", "farol-qa-" + "f"*16, "--confirm-guest-dialog"]])
        self.assertEqual(calls[0][1]["stdin"], subprocess.DEVNULL)
        self.assertTrue((evidence / "stop-intent.json").is_file())
        self.assertEqual(json.loads((evidence / "stop-receipt.json").read_text())["status"], "stopped-attested")

class CapacityGuidanceTests(Fixture):
    def test_unknown_machine_is_named_with_manual_resolution_and_not_deleted(self):
        leftover = self.root / "machines/farol-qa-0123456789abcdef"
        leftover.mkdir(mode=0o700)
        replies = {"farol-base-1": {"name": "farol-base-1", "state": "stopped"},
                   leftover.name: {"name": leftover.name, "state": "error"}}
        with mock.patch.object(dev, "_host_status", side_effect=lambda b, name, e: replies[name]):
            with self.assertRaises(dev.VMDevError) as raised:
                dev._capacity(self.binary, self.root, {})
        self.assertEqual(raised.exception.code, "VM_DEV_CAPACITY_UNKNOWN")
        self.assertIn("machine=farol-qa-0123456789abcdef state=error", raised.exception.detail)
        self.assertIn("resolve manually", raised.exception.detail)
        self.assertTrue(leftover.is_dir(), "never auto-deleted")
        replies[leftover.name] = None
        with self.assertRaises(dev.VMDevError) as raised:
            with mock.patch.object(dev, "_host_status", side_effect=lambda b, name, e: replies[name]):
                dev._capacity(self.binary, self.root, {})
        self.assertIn("state=unreadable", raised.exception.detail)

if __name__ == "__main__":
    unittest.main()
