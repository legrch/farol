"""Pure, synthetic VM Dev controller checks.

No VM process, installed app, host profile, network, TerminalMac binary, shell
or real producer is started. Effects and os.execve are injected/mocked.
"""
import argparse
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("vm_dev_session_test", ROOT / "vm-dev-session.py")
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="farol-vm-dev-controller-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.settings = self.home / "Library/Application Support/Farol Testing"
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
        self.base_receipt.chmod(0o600)
        self.binary = self.root / "terminal-mac-test-only"
        self.binary.write_text("synthetic placeholder, never executed")
        self.binary.chmod(0o700)
        self.output = self.home / "selected-output"
        self.output.mkdir(mode=0o700)
        self.archive = self.output / "Farol-Dev.zip"
        self.archive.write_bytes(b"PK\x03\x04synthetic fixture bytes")
        self.archive.chmod(0o600)
        self.receipt = self.output / "vm-dev-artifact.json"
        self.selected = dict(
            schema="farol.vm-dev-artifact/1", kind="local-dev-derivative",
            environment="dev", appName="Farol Dev.app", bundleId="local.farol.dev",
            officialRelease=False, hostLaunch=False, profileImport=False,
            artifactSha256="e"*64)
        self.receipt.write_text(json.dumps(self.selected))
        self.receipt.chmod(0o600)
        self.digest = hashlib.sha256(self.receipt.read_bytes()).hexdigest()
        self.options = dev.parse_options(["--artifact", str(self.archive),
                                          "--receipt", str(self.receipt),
                                          "--expected-receipt-sha256", self.digest])


class AdmissionTests(Fixture):
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
                        binary_admission=lambda _: True,
                        clone_effect=lambda *a: calls.append("clone"))
        self.assertEqual(calls, [])

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
        def handed(binary, root, name, stage, session, evidence, env):
            calls.append(("mcp", name, session))
            self.assertEqual(session["manifestSHA256"], "a"*64)
            self.assertEqual(session["acceptanceSHA256"], "b"*64)
            self.assertEqual(env["TERMINAL_MAC_HOME"], str(self.root))
        with mock.patch.object(dev, "_guest_grants", return_value=None):
            dev.execute(self.options,
                infrastructure=lambda: (self.binary, self.root, self.settings),
                identity_factory=lambda: (clone, run),
                clone_effect=cloned, start_effect=started, producer=producer,
                binary_admission=lambda _: True, exec_effect=handed)
        self.assertEqual([entry[0] for entry in calls], ["clone", "producer", "start", "mcp"])
        self.assertTrue((self.settings / "instance-receipts" / (clone + ".json")).is_file())
        evidence = self.settings / "vm-dev-sessions" / clone
        self.assertEqual(json.loads((evidence / "selection.json").read_text())["runId"], run)
        self.assertTrue((evidence / "stage-receipt.json").is_file())
        self.assertFalse((evidence / "handoff.json").exists(),
                         "mocked exec does not invent a native MCP terminal receipt")

    def test_failed_stage_keeps_original_intent_and_partial_clone(self):
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
        with self.assertRaisesRegex(dev.VMDevError, "VM_DEV_STAGING_UNCONFIRMED"), \
             mock.patch.object(dev, "_guest_grants") as grants:
            dev.execute(self.options,
                infrastructure=lambda: (self.binary, self.root, self.settings),
                identity_factory=lambda: (clone, run),
                clone_effect=cloned, start_effect=lambda *a: self.fail("start"),
                producer=broken, binary_admission=lambda _: True,
                exec_effect=lambda *a: self.fail("exec"))
        evidence = self.settings / "vm-dev-sessions" / clone
        self.assertTrue((evidence / "stage-intent.json").is_file())
        self.assertFalse((evidence / "stage-receipt.json").exists())
        self.assertTrue((self.root / "machines" / clone / "artifacts" / run / "blob-synthetic").exists())
        grants.assert_not_called()


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

    def test_handoff_only_execs_native_mcp_with_inherited_stdio(self):
        evidence = self.settings / "handoff-evidence"
        evidence.mkdir(mode=0o700)
        session = dict(runId="run-" + "a"*32,
                       manifestSHA256="b"*64, acceptanceSHA256="c"*64)
        with mock.patch.object(dev.os, "execve", return_value=None) as invoked:
            dev._exec_mcp(self.binary, self.root, "farol-qa-" + "f"*16,
                          self.output, session, evidence, {"HOME": "/synthetic"})
        invoked.assert_called_once()
        binary, argv, env = invoked.call_args.args
        self.assertEqual(binary, str(self.binary))
        self.assertEqual(argv, [str(self.binary), "mcp", "farol-qa-" + "f"*16,
                                "--app-run", session["runId"],
                                "--app-manifest", session["manifestSHA256"],
                                "--app-acceptance", session["acceptanceSHA256"]])
        self.assertEqual(env["TERMINAL_MAC_HOME"], str(self.root))
        handoff = json.loads((evidence / "handoff.json").read_text())
        self.assertEqual(handoff["status"], "exec-pending")
        self.assertTrue((evidence / "mcp-intent.json").is_file())
        self.assertNotIn("password", str(handoff).lower())


if __name__ == "__main__":
    unittest.main()
