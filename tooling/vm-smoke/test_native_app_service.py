"""Data-only Farol app-service producer and native runner: disposable fixtures.

This suite neither imports host profiles/credentials nor boots/contacts a VM.
It is a NEW leaf, not the old outcome-unknown or denied Python test execution.
Synthetic ZIPs are NOT qualified Farol releases: production must call verify().
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import stat
import tempfile
import time
from types import SimpleNamespace
import unittest
import uuid
import zipfile

TOOLING = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, TOOLING / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


producer = load("vm_app_service_fixture", "vm_app_service.py")
runner_module = load("vm_smoke_native_fixture", "vm-smoke.py")
IDENTITY = {"name": "Fixture", "bundleId": "test.fixture",
            "dataLeaf": "fixture", "devDataLeaf": "fixture-dev"}
runner_module.IDENTITY = dict(IDENTITY)
RUN = "run-" + "a" * 32
NONCE = "b" * 64
MANIFEST = "c" * 64
OWNER = "farol-smoke:" + RUN
HELPER = "00000000-0000-4000-8000-000000000010"


def add_zip(z, name, data, mode=0o644, kind=stat.S_IFREG):
    item = zipfile.ZipInfo(name)
    item.create_system = 3
    item.external_attr = (kind | mode) << 16
    z.writestr(item, data)


def sample_archive(root, special=None):
    archive = root / "Fixture-0.5.23-darwin-arm64.zip"
    info = plistlib.dumps({"CFBundleIdentifier": IDENTITY["bundleId"],
                           "CFBundleShortVersionString": "0.5.23",
                           "CFBundleExecutable": "Fixture"},
                          fmt=plistlib.FMT_XML)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
        add_zip(z, "Fixture.app/Contents/Info.plist", info)
        add_zip(z, "Fixture.app/Contents/MacOS/Fixture", b"synthetic-not-executed", 0o755)
        add_zip(z, "Fixture.app/Contents/Resources/empty", b"", 0o644)
        add_zip(z, "Fixture.app/Contents/Resources/payload", b"same-bytes")
        add_zip(z, "Fixture.app/Contents/Resources/payload-copy", b"same-bytes")
        add_zip(z, "Fixture.app/Contents/Frameworks/Example.framework/Versions/A/Resources/item", b"resource")
        add_zip(z, "Fixture.app/Contents/Frameworks/Example.framework/Versions/Current", b"A",
                0o777, stat.S_IFLNK)
        add_zip(z, "Fixture.app/Contents/Frameworks/Example.framework/Resources",
                b"Versions/Current/Resources", 0o777, stat.S_IFLNK)
        if special:
            special(z)
    release = {"schema": "farol.github-release/1", "product": IDENTITY["name"],
               "bundleId": IDENTITY["bundleId"], "version": "0.5.23",
               "artifactSha256": "e" * 64,
               "archiveSha256": producer.sha256_file(archive)}
    return archive, release


class DataProducerTests(unittest.TestCase):
    def test_stages_closed_manifest_and_exact_deduplicated_blobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, release = sample_archive(root)
            stage = root / "stage"
            stage.mkdir(mode=0o700)
            receipt = producer.stage_release_payload(archive, release, stage, IDENTITY)
            raw = (stage / "app-payload.json").read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), receipt["manifestSHA256"])
            self.assertEqual(receipt["archiveSHA256"], release["archiveSha256"])
            payload = json.loads(raw)
            self.assertEqual(set(payload), {"schema", "appName", "bundleID", "version",
                                            "artifactSHA256", "archiveSHA256", "entries"})
            self.assertEqual(payload["schema"], "terminal-mac.app-payload/1")
            self.assertEqual(payload["appName"], "Fixture.app")
            self.assertEqual(payload["bundleID"], IDENTITY["bundleId"])
            self.assertEqual(payload["version"], "0.5.23")
            self.assertEqual(len(payload["entries"]), len({e["path"] for e in payload["entries"]}))
            self.assertEqual(payload["entries"], sorted(payload["entries"], key=lambda e: e["path"]))
            entries = {e["path"]: e for e in payload["entries"]}
            self.assertEqual(entries["Contents"]["kind"], "directory")
            self.assertEqual(entries["Contents/MacOS"]["kind"], "directory")
            self.assertEqual(entries["Contents/MacOS/Fixture"]["mode"], 0o755)
            self.assertEqual(entries["Contents/Frameworks/Example.framework/Resources"]["target"],
                             "Versions/Current/Resources")
            self.assertEqual(entries["Contents/Frameworks/Example.framework/Versions/Current"]["target"], "A")
            self.assertEqual(entries["Contents/Resources/payload"]["blob"],
                             entries["Contents/Resources/payload-copy"]["blob"])
            self.assertEqual(entries["Contents/Resources/empty"]["bytes"], 0)
            self.assertEqual((stage / entries["Contents/Resources/payload"]["blob"]).read_bytes(), b"same-bytes")
            self.assertEqual(len(list(stage.glob("blob-*"))), receipt["blobCount"])
            self.assertFalse(any(p.suffix in (".sh", ".js", ".mjs") for p in stage.iterdir()))
            self.assertEqual(oct((stage / "app-payload.json").stat().st_mode & 0o777), "0o600")

    def test_changed_outer_archive_digest_refuses_before_any_blob(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, release = sample_archive(root)
            release["archiveSha256"] = "f" * 64
            stage = root / "stage"
            stage.mkdir(mode=0o700)
            with self.assertRaisesRegex(producer.ProducerRefusal, "APP_PAYLOAD_DIGEST"):
                producer.stage_release_payload(archive, release, stage, IDENTITY)
            self.assertEqual(list(stage.iterdir()), [])

    def test_refuses_case_alias_traversal_and_extra_archive_root(self):
        for path in ("Fixture.app/Contents/Resources/PAYLOAD",
                     "Fixture.app/Contents/../escape", "other.app/fail"):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive, release = sample_archive(root,
                    lambda z: add_zip(z, path, b"synthetic"))
                stage = root / "stage"
                stage.mkdir(mode=0o700)
                with self.assertRaises(producer.ProducerRefusal):
                    producer.stage_release_payload(archive, release, stage, IDENTITY)
                self.assertEqual(list(stage.iterdir()), [])

    def test_refuses_symlink_cycle_and_escaping_target(self):
        for target in ("Current", "../outside", "/outside"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive, release = sample_archive(root,
                    lambda z: add_zip(z, "Fixture.app/Contents/Resources/alias",
                                      target.encode("ascii"), 0o777, stat.S_IFLNK))
                stage = root / "stage"
                stage.mkdir(mode=0o700)
                with self.assertRaises(producer.ProducerRefusal):
                    producer.stage_release_payload(archive, release, stage, IDENTITY)
                self.assertEqual(list(stage.iterdir()), [])

    def test_stage_must_be_private_and_not_a_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, release = sample_archive(root)
            stage = root / "stage"
            stage.mkdir(mode=0o755)
            with self.assertRaisesRegex(producer.ProducerRefusal, "APP_PAYLOAD_UNSAFE"):
                producer.stage_release_payload(archive, release, stage, IDENTITY)
            stage.chmod(0o700)
            alias = root / "link"
            alias.symlink_to(stage, target_is_directory=True)
            with self.assertRaisesRegex(producer.ProducerRefusal, "APP_PAYLOAD_UNSAFE"):
                producer.stage_release_payload(archive, release, alias, IDENTITY)

    def test_refuses_archive_symlink_and_hardlink_alias_before_publication(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, release = sample_archive(root)
            alias = root / "alias.zip"
            alias.symlink_to(archive)
            stage = root / "stage"
            stage.mkdir(mode=0o700)
            with self.assertRaisesRegex(producer.ProducerRefusal, "APP_PAYLOAD_UNSAFE"):
                producer.stage_release_payload(alias, release, stage, IDENTITY)
            self.assertEqual(list(stage.iterdir()), [])
            alias.unlink()
            os.link(archive, alias)
            with self.assertRaisesRegex(producer.ProducerRefusal, "APP_PAYLOAD_UNSAFE"):
                producer.stage_release_payload(archive, release, stage, IDENTITY)
            self.assertEqual(list(stage.iterdir()), [])

    def test_archive_mutation_during_materialization_keeps_stage_unadoptable(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, release = sample_archive(root)
            stage = root / "stage"
            stage.mkdir(mode=0o700)
            original = producer._write_exclusive
            modified = []
            def mutate_after_first_blob(fd, name, data):
                result = original(fd, name, data)
                if name.startswith("blob-") and not modified:
                    modified.append(True)
                    with archive.open("ab") as output:
                        output.write(b"synthetic appended mutation")
                return result
            with patch.object(producer, "_write_exclusive", side_effect=mutate_after_first_blob):
                with self.assertRaises(producer.ProducerRefusal):
                    producer.stage_release_payload(archive, release, stage, IDENTITY)
            self.assertTrue(modified)
            self.assertFalse((stage / "app-payload.json").exists(),
                             "never publish final manifest after archive identity changes")
            self.assertTrue(list(stage.glob("blob-*")),
                            "partial blobs are retained for explicit reconciliation")

    def test_cannot_overwrite_existing_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, release = sample_archive(root)
            stage = root / "stage"
            stage.mkdir(mode=0o700)
            (stage / "app-payload.json").write_text("synthetic-prior")
            with self.assertRaises(FileExistsError):
                producer.stage_release_payload(archive, release, stage, IDENTITY)
            self.assertEqual((stage / "app-payload.json").read_text(), "synthetic-prior")


def reply(session, command, operation, pid=None, broken=None):
    i = session.next_sequence
    state = session.states[i]
    if pid is None and state == "running":
        pid = "42"
    values = {"serviceContract": "terminal-mac.app-service/4",
              "executor": "compiled-native-helper", "serverCodeSource": "helper-binary",
              "shell": "not-used", "runId": session.run_id, "nonce": session.nonce,
              "manifestSHA256": session.manifest, "acceptanceSHA256": session.acceptance, "operationId": operation,
              "sequence": str(i), "state": state, "pending": "",
              "restoredObservation": "false",
              "serviceReady": "false" if command == "close" else "true",
              "helperInstance": HELPER, "applicationPID": pid or "",
              "applicationRunning": "true" if state == "running" else "false",
              "foreground": "true" if command == "activate" else "false",
              "windows": "1" if state == "running" else "0",
              "rootExit": ("not-observed" if state == "running" else
                           "observed" if command in ("quit", "close") else "no-owned-root"),
              "installationRoot": "/Applications",
              "installationLocation": "guest-applications/1",
              "installedApplication": "" if command == "open" else "/Applications/Fixture.app",
              "installationEvidence": ("not-installed" if command == "open" else
                                       "verified-at-close" if command == "close" else
                                       "verified-at-install")}
    if broken:
        values.update(broken)
    return values


class ServiceSessionTests(unittest.TestCase):
    def test_ordered_commands_bind_nonce_digest_sequence_and_helper(self):
        session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64)
        for command in session.steps:
            operation = str(uuid.uuid4())
            args = session.arguments(command, operation)
            self.assertEqual(args[0], "app-service")
            self.assertEqual(args[args.index("--service-run")+1], RUN)
            self.assertEqual(args[args.index("--service-nonce")+1], NONCE)
            self.assertEqual(args[args.index("--service-sequence")+1],
                             str(session.next_sequence))
            receipt = session.admit_reply(command, operation, reply(session, command, operation))
            self.assertEqual(receipt["state"], session.states[receipt["sequence"]])
        self.assertEqual(session.next_sequence, 6)
        self.assertEqual(session.launch_pids, ["42"])

    def test_relaunch_requires_a_fresh_valid_sequence_and_keeps_pids(self):
        session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64, relaunch=True)
        for command in session.steps:
            operation = str(uuid.uuid4())
            pid = "77" if session.next_sequence >= 5 and command in ("launch", "activate") else None
            session.admit_reply(command, operation, reply(session, command, operation, pid=pid))
        self.assertEqual(session.next_sequence, 9)
        self.assertEqual(session.launch_pids, ["42", "77"])

    def test_observe_is_readonly_and_binds_the_last_completed_operation(self):
        session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64)
        operation = str(uuid.uuid4())
        wire = reply(session, "open", operation)
        receipt = session.admit_reply("open", operation, wire)
        arguments = session.observation_arguments(receipt)
        self.assertEqual(arguments[arguments.index("--service-command")+1], "observe")
        self.assertNotEqual(arguments[arguments.index("--service-operation")+1], operation)
        self.assertEqual(arguments[arguments.index("--service-sequence")+1], "0")
        observed = session.admit_observation(receipt, wire)
        self.assertEqual(observed["operationId"], operation)
        self.assertEqual(observed["state"], "ready")
        self.assertEqual(session.next_sequence, 1)
        for tampered in ({"nonce": "f"*64}, {"operationId": str(uuid.uuid4())},
                         {"helperInstance": str(uuid.uuid4())},
                         {"restoredObservation": "true"}, {"state": "unknown"},
                         {"applicationPID": "88"}):
            with self.subTest(tampered=tampered):
                with self.assertRaises(producer.ProducerRefusal):
                    session.admit_observation(receipt, {**wire, **tampered})
                self.assertEqual(session.next_sequence, 1)

    def test_activation_observation_pending_only_with_exact_binding(self):
        session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64)
        open_operation = str(uuid.uuid4())
        session.admit_reply("open", open_operation, reply(session, "open", open_operation))
        install_operation = str(uuid.uuid4())
        session.admit_reply("install", install_operation, reply(session, "install", install_operation))
        launch_operation = str(uuid.uuid4())
        session.admit_reply("launch", launch_operation, reply(session, "launch", launch_operation))
        operation = str(uuid.uuid4())
        early = reply(session, "activate", operation, broken={"foreground": "false"})
        receipt = session.admit_reply("activate", operation, early)
        self.assertIsNone(session.admit_observation(
            receipt, early, allow_pending_foreground=True))
        with self.assertRaises(producer.ProducerRefusal):
            session.admit_observation(receipt, early)
        for changed in ({"nonce": "f"*64}, {"operationId": str(uuid.uuid4())},
                        {"applicationPID": "43"}, {"restoredObservation": "true"}):
            with self.subTest(changed=changed), self.assertRaises(producer.ProducerRefusal):
                session.admit_observation(receipt, {**early, **changed},
                                          allow_pending_foreground=True)
        positive = dict(early, foreground="true")
        self.assertEqual(session.admit_observation(receipt, positive)["state"], "running")
        self.assertEqual(session.next_sequence, 4)

    def test_rejects_cached_or_unverified_installation_provenance(self):
        cached = "/Users/tester/Library/Caches/terminal-mac-app-service/Fixture.app"
        for changed in (
            {"installedApplication": cached},
            {"installationRoot": cached.rsplit("/", 1)[0]},
            {"installationLocation": "guest-private-cache/1"},
            {"installationEvidence": "unconfirmed"},
            {"rootExit": "unconfirmed"},
        ):
            with self.subTest(changed=changed):
                session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64)
                operation = str(uuid.uuid4())
                with self.assertRaises(producer.ProducerRefusal):
                    session.admit_reply("open", operation, {
                        **reply(session, "open", operation), **changed
                    })
                self.assertEqual(session.next_sequence, 0)

    def test_quit_requires_observed_original_root_exit(self):
        session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64)
        for command in ("open", "install", "launch", "activate"):
            operation = str(uuid.uuid4())
            session.admit_reply(command, operation, reply(session, command, operation))
        operation = str(uuid.uuid4())
        unconfirmed = reply(session, "quit", operation, broken={"rootExit": "unconfirmed"})
        with self.assertRaises(producer.ProducerRefusal):
            session.admit_reply("quit", operation, unconfirmed)
        self.assertEqual(session.next_sequence, 4)
        good = reply(session, "quit", operation)
        receipt = session.admit_reply("quit", operation, good)
        self.assertEqual(receipt["rootExit"], "observed")
        self.assertEqual(receipt["installedApplication"], "/Applications/Fixture.app")

    def test_farol_ui_activation_requires_observed_ax_window_and_foreground(self):
        session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64)
        for command in ("open", "install", "launch"):
            operation = str(uuid.uuid4())
            session.admit_reply(command, operation, reply(session, command, operation))
        operation = str(uuid.uuid4())
        ack = reply(session, "activate", operation, broken={"windows": "unconfirmed"})
        receipt = session.admit_reply("activate", operation, ack)
        self.assertEqual(session.next_sequence, 4)
        for pending in ("unconfirmed", "0"):
            pending_reply = {**ack, "windows": pending, "foreground": "true"}
            self.assertIsNone(session.admit_observation(
                receipt, pending_reply, allow_pending_foreground=True))
            with self.assertRaises(producer.ProducerRefusal):
                session.admit_observation(receipt, pending_reply)
        for invalid in ("synthetic-secret", "-1", "1.5", "2", "64", "65", "999", ""):
            with self.subTest(invalid=invalid), self.assertRaises(producer.ProducerRefusal):
                session.admit_observation(receipt, {**ack, "windows": invalid,
                                                    "foreground": "true"},
                                          allow_pending_foreground=True)
        ui = session.admit_observation(receipt, {**ack, "windows": "1",
                                                "foreground": "true"})
        self.assertEqual(ui["windows"], "1")
        self.assertEqual(ui["installedApplication"], "/Applications/Fixture.app")
        self.assertEqual(session.next_sequence, 4,
                         "read-only UI observation cannot advance the mutating sequence")

    def test_malformed_or_unbound_ack_never_advances_sequence(self):
        for bad in ({"serviceContract": "legacy"}, {"runId": "run-" + "f"*32},
                    {"manifestSHA256": "f"*64}, {"operationId": str(uuid.uuid4())},
                    {"nonce": "f"*64}, {"state": "closed"},
                    {"restoredObservation": "true"}, {"serviceReady": "false"}):
            with self.subTest(bad=bad):
                session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64)
                operation = str(uuid.uuid4())
                with self.assertRaises(producer.ProducerRefusal):
                    session.admit_reply("open", operation, reply(session, "open", operation, broken=bad))
                self.assertEqual(session.next_sequence, 0)
        session = producer.ServiceAdmission(RUN, NONCE, MANIFEST, OWNER, "Fixture.app", acceptance="d" * 64)
        with self.assertRaises(producer.ProducerRefusal):
            session.arguments("install", str(uuid.uuid4()))


class NativeOpenRecoveryTests(unittest.TestCase):
    def test_native_marker_is_immutable_across_steps(self):
        import test_input_lease_consumer as lease_fixture
        with tempfile.TemporaryDirectory() as tmp:
            initial = lease_fixture.build_runner(Path(tmp))
            initial.a.native_app_service = True
            runner = runner_module.Runner(initial.a)
            runner.acquire_input_lease()
            try:
                marker = runner.exchange / '.input-lease.json'
                before = marker.stat()
                content = marker.read_bytes()
                runner.publish_lease_flag()
                runner.publish_lease_flag()
                self.assertEqual(marker.read_bytes(), content)
                self.assertEqual((marker.stat().st_ino, marker.stat().st_mtime_ns),
                                 (before.st_ino, before.st_mtime_ns))
                marker.write_text(json.dumps({'schema':'terminal-mac.input-lease-flag/1',
                    'owner':'foreign-owner', 'deadline':time.time()+1000}))
                with self.assertRaises(runner_module.Refused):
                    runner.publish_lease_flag()
            finally:
                # Foreign marker is deliberately preserved, never adopted.
                with self.assertRaises(runner_module.Refused):
                    runner.release_input_lease()
                self.assertIsNone(runner.lease_fd)

    def test_noeffect_staging_is_retained_without_blocking_next_admission(self):
        import test_input_lease_consumer as lease_fixture
        with tempfile.TemporaryDirectory() as tmp:
            initial = lease_fixture.build_runner(Path(tmp))
            runner = runner_module.Runner(initial.a)
            runner.stage.mkdir()
            (runner.stage / 'blob').write_bytes(b'accepted artifact evidence')
            runner.acquire_input_lease()
            try:
                runner.begin_effect()
                runner.finish_no_effect_open(str(uuid.uuid4()), {'reason':'APP_SERVICE_UNSAFE_PATH'})
                self.assertFalse(runner.stage.exists())
                receipt = json.loads((runner.out / 'native-stage-retained.json').read_text())
                self.assertEqual(Path(receipt['retainedAt']).joinpath('blob').read_bytes(),
                                 b'accepted artifact evidence')
                self.assertFalse(receipt['deleted'])
                self.assertEqual(runner.cleanup_disposition(), 'RETAINED_NO_EFFECT')
            finally:
                runner.release_input_lease()
            self.assertFalse((runner.exchange / '.input-lease.json').exists())
            self.assertFalse(runner.effect_file.exists())

    def test_noeffect_retention_refuses_linked_stage_and_preserves_fence(self):
        import test_input_lease_consumer as lease_fixture
        with tempfile.TemporaryDirectory() as tmp:
            initial = lease_fixture.build_runner(Path(tmp))
            runner = runner_module.Runner(initial.a)
            unrelated = Path(tmp) / 'unrelated'; unrelated.mkdir()
            (unrelated / 'keep').write_text('untouched')
            runner.stage.symlink_to(unrelated, target_is_directory=True)
            runner.acquire_input_lease()
            try:
                runner.begin_effect()
                with self.assertRaises(runner_module.Refused):
                    runner.finish_no_effect_open(str(uuid.uuid4()), {'reason':'APP_SERVICE_UNSAFE_PATH'})
                self.assertTrue(runner.effect_file.exists())
                self.assertEqual((unrelated / 'keep').read_text(), 'untouched')
            finally:
                runner.release_input_lease()

    def test_only_exact_first_open_noeffect_ack_clears_its_fence(self):
        import test_input_lease_consumer as lease_fixture
        for outcome, prior_effect in [("noEffect", False), ("UNKNOWN", False), ("noEffect", True)]:
            with self.subTest(outcome=outcome, prior_effect=prior_effect), tempfile.TemporaryDirectory() as tmp:
                initial = lease_fixture.build_runner(Path(tmp))
                runner = runner_module.Runner(initial.a)
                runner.acquire_input_lease()
                try:
                    runner.begin_effect()
                    if prior_effect:
                        runner.log.append('native:open')
                    session = producer.ServiceAdmission(runner.run_id, NONCE, MANIFEST,
                        runner.lease_owner, "Fixture.app", acceptance="d" * 64)
                    runner.native_service_producer = producer
                    def reject(*args):
                        runner.record_first_failure('APP_SERVICE_UNSAFE_PATH', 'action', 'app-service', 1, outcome)
                        raise runner_module.Refused('GUEST_ACTION_FAILED:action')
                    runner.action = reject
                    with self.assertRaises(runner_module.Refused):
                        runner.native_app_action(session, 'open')
                    ended = outcome == 'noEffect' and not prior_effect
                    self.assertEqual(runner.effect_file.exists(), not ended)
                    self.assertEqual(runner.pending is None, ended)
                    self.assertEqual((runner.out / 'native-open-no-effect.json').exists(), ended)
                    self.assertTrue((runner.out / 'native-intent-00-open.json').is_file())
                finally:
                    runner.release_input_lease()
                self.assertEqual((runner.exchange / '.input-lease.json').exists(), not ended)

    def test_native_mode_ignores_only_legacy_config_menu_coordinates(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.json'
            config.write_text(json.dumps({'terminal_mac':'/unused', 'vm_home':'/unused',
                'menu_point':[100,12], 'terminal_point':[2,2]}))
            argv = ['--config', str(config), '--artifact', 'fixture.zip', '--native-app-service',
                    '--expected-app-sha256', 'a'*64]
            self.assertIsNone(runner_module.arguments(argv).menu_point)
            with self.assertRaisesRegex(runner_module.Refused, 'APP_SERVICE_OPTIONS_INVALID'):
                runner_module.arguments(argv + ['--menu-point','100','12'])


class RunnerNativeTests(unittest.TestCase):
    def fixture(self, root):
        archive, release = sample_archive(root)
        runner = object.__new__(runner_module.Runner)
        runner.run_id = RUN
        runner.lease_owner = OWNER
        runner.a = SimpleNamespace(native_relaunch=False,
                                   expected_app_sha256=release['artifactSha256'])
        runner.network_policy = None
        runner.log = []
        runner.pending = None
        runner.deadline = time.monotonic() + 180
        runner.stage = root / "artifacts" / RUN
        runner.stage.parent.mkdir(mode=0o700)
        runner.out = root / "evidence"
        runner.out.mkdir(mode=0o700)
        # This fixture does not attest publisher signatures. Its finite synthetic
        # bundle policy is injected only here; production always selects Farol's.
        native_module = runner.native_service_module()
        native_module.farol_release_policy = lambda payload: {
            "schema": "terminal-mac.signature-policy/1", "outer": "signed-bundle", "checks": []}
        runner.native_service_module = lambda: native_module
        runner.instance_clone_receipt = lambda: None
        runner.lease_evidence = lambda: {"owner": OWNER, "generation": 1}
        actions = []
        effects = []
        images = []
        last_ack = [None]
        runner.begin_effect = lambda: effects.append("fenced")
        runner.publish_lease_flag = lambda: effects.append("marker-refreshed")
        runner.screenshot = lambda label: images.append(label)
        runner.finish_staging = lambda: "CLEARED"

        def action(*args):
            actions.append(args)
            self.assertEqual(args[0], "app-service")
            self.assertIn("fenced", effects)
            options = dict(zip(args[1::2], args[2::2]))
            seq = int(options["--service-sequence"])
            command = options["--service-command"]
            if command == "observe":
                # The observed guest returns the RECEIPT of the last native
                # mutating request, not the new read-only operation identity.
                self.assertIsNotNone(last_ack[0])
                self.assertEqual(str(seq), last_ack[0]["sequence"])
                self.assertTrue((runner.out / (
                    "native-receipt-%02d-%s.json" % (seq, last_ack[0]["command"]))
                    ).is_file())
                return {k: v for k, v in last_ack[0].items() if k != "command"}
            self.assertTrue((runner.out / ("native-intent-%02d-%s.json" % (seq, command))).is_file())
            manifest = options["--service-manifest"]
            self.assertEqual(hashlib.sha256((runner.stage / "app-payload.json").read_bytes()).hexdigest(), manifest)
            payload = {"serviceContract": "terminal-mac.app-service/4",
                       "executor": "compiled-native-helper",
                       "serverCodeSource": "helper-binary", "shell": "not-used",
                       "runId": RUN, "nonce": options["--service-nonce"],
                       "manifestSHA256": manifest, "acceptanceSHA256": options["--service-acceptance"],
                       "operationId": options["--service-operation"],
                       "sequence": str(seq), "pending": "",
                       "restoredObservation": "false",
                       "helperInstance": HELPER,
                       "state": {"open": "ready", "install": "installed",
                                 "launch": "running", "activate": "running",
                                 "quit": "installed", "close": "closed"}[command],
                       "serviceReady": "false" if command == "close" else "true",
                       "applicationPID": "42" if command in ("launch", "activate") else "",
                       "applicationRunning": "true" if command in ("launch", "activate") else "false",
                       "foreground": "true" if command == "activate" else "false",
                       "windows": "1",
                       "rootExit": ("not-observed" if command in ("launch", "activate") else
                                    "observed" if command in ("quit", "close") else "no-owned-root"),
                       "installationRoot": "/Applications",
                       "installationLocation": "guest-applications/1",
                       "installedApplication": "" if command == "open" else "/Applications/Fixture.app",
                       "installationEvidence": ("not-installed" if command == "open" else
                                                "verified-at-close" if command == "close" else
                                                "verified-at-install")}
            last_ack[0] = dict(payload, command=command)
            return payload

        runner.action = action
        return runner, archive, release, actions, effects, images

    def test_native_install_collision_preserves_closed_structured_diagnostic(self):
        envelope = {"schema": "terminal-mac.action-error/1",
                    "reason": "APP_SERVICE_INSTALLED_COLLISION",
                    "outcome": "noEffect", "phase": "admission"}
        accepted = runner_module.action_failure_envelope(json.dumps(envelope))
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted["reason"], "APP_SERVICE_INSTALLED_COLLISION")
        self.assertEqual(accepted["outcome"], "noEffect")
        self.assertEqual(runner_module.safe_failure_code(
            runner_module.Refused("APP_SERVICE_INSTALLED_COLLISION")),
            "APP_SERVICE_INSTALLED_COLLISION")
        unknown = dict(envelope, reason="SYNTHETIC_UPPERCASE_PRIVATE_VALUE")
        self.assertIsNone(runner_module.action_failure_envelope(json.dumps(unknown)))
        self.assertEqual(runner_module.safe_failure_code(
            runner_module.Refused(unknown["reason"])), "UNCLASSIFIED")

    def test_unknown_uppercase_error_is_not_an_allowlisted_failure_code(self):
        secret = "PRIMARY_REASON"
        self.assertEqual(runner_module.safe_failure_code(
            runner_module.Refused(secret)), "UNCLASSIFIED")
        owner = object.__new__(runner_module.Runner)
        owner.run_id = RUN
        owner.out = None
        owner.pending = "native:stage"
        owner.first_failure = None
        owner.record_first_failure(secret)
        self.assertEqual(owner.first_failure["reason"], "UNCLASSIFIED")
        self.assertNotIn(secret, str(owner.first_failure))

    def test_run_consumes_one_finite_native_contract_without_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, archive, release, actions, effects, images = self.fixture(Path(tmp))
            grants = {"appServiceContract": "terminal-mac.app-service/4",
                      "appServiceExecutor": "compiled-native-helper", "appServiceLaunchIdentityContract": "terminal-mac.launch-identity/1",
                      "appServiceAdmission": "available"}
            result = runner.run_native_app_service(archive, release, grants)
            self.assertEqual(result["status"], "NEEDS_REVIEW")
            self.assertEqual(result["lifecycle"], "NATIVE_APP_SERVICE_CLOSED_REPORTED")
            self.assertEqual(result["test"]["status"], "NOT_RUN")
            self.assertEqual(result["shell"], "NOT_USED")
            self.assertEqual(result["guestInstallation"], {
                "location": "guest-applications/1",
                "application": "/Applications/Fixture.app",
                "verification": "verified-at-close",
                "rootExit": "observed",
                "preservedAfterClose": True,
                "existingAppWasReplaced": False,
            })
            self.assertEqual([r["command"] for r in result["nativeReceipts"]],
                             ["open", "install", "launch", "activate", "quit", "close"])
            self.assertEqual(effects, ["fenced"] + ["marker-refreshed"]*6)
            self.assertEqual(len(actions), 12)
            self.assertEqual(sum('--service-command' in a and
                                 a[a.index('--service-command')+1] == 'observe'
                                 for a in actions), 6)
            self.assertTrue((runner.out / 'native-observation-05-close.json').is_file())
            self.assertEqual(images, ["native-02-launch", "native-03-activate"])
            self.assertEqual(runner.pending, None)
            self.assertEqual(runner.log[-1], "native:close")
            self.assertFalse(any(f.name.endswith(".sh") for f in runner.stage.iterdir()))
            self.assertNotIn(json.loads((runner.out / "native-session.json").read_text())["nonce"],
                             (runner.out / "result.json").read_text())

    def test_activation_awaits_only_bound_readonly_observation(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            runner, archive, release, actions, effects, images = self.fixture(Path(tmp))
            original = runner.action
            frontmost_probes = []
            def delayed_foreground(*args):
                if "--service-command" not in args:
                    return original(*args)
                verb = args[args.index("--service-command") + 1]
                seq = args[args.index("--service-sequence") + 1]
                if verb == "activate":
                    ack = original(*args)
                    ack["foreground"] = "false"  # native ACK preceded UI transition
                    return ack
                if verb == "observe" and seq == "3":
                    observed = original(*args)
                    frontmost_probes.append(1)
                    observed["foreground"] = "false" if len(frontmost_probes) == 1 else "true"
                    return observed
                return original(*args)
            runner.action = delayed_foreground
            grants = {"appServiceContract": "terminal-mac.app-service/4",
                      "appServiceExecutor": "compiled-native-helper", "appServiceLaunchIdentityContract": "terminal-mac.launch-identity/1",
                      "appServiceAdmission": "available"}
            clock = [runner_module.time.monotonic()]
            def cold_window_wait(_):
                clock[0] += 20  # A real cold GUI may exceed the former five seconds.
            with patch.object(runner_module.time, "sleep", side_effect=cold_window_wait), \
                 patch.object(runner_module.time, "monotonic", side_effect=lambda: clock[0]):
                result = runner.run_native_app_service(archive, release, grants)
            self.assertEqual(result["lifecycle"], "NATIVE_APP_SERVICE_CLOSED_REPORTED")
            self.assertEqual(len(frontmost_probes), 2)
            self.assertEqual(sum(a[a.index("--service-command")+1] == "activate"
                                 for a in actions), 1)
            self.assertTrue((runner.out / "native-observation-03-activate.json").is_file())
            self.assertEqual(effects, ["fenced"] + ["marker-refreshed"]*6)
            self.assertEqual(images, ["native-02-launch", "native-03-activate"])

    def test_mismatched_readonly_observation_stops_after_known_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, archive, release, actions, effects, _ = self.fixture(Path(tmp))
            original = runner.action
            def wrong_observation(*args):
                if "--service-command" in args and args[args.index("--service-command")+1] == "observe":
                    return {"serviceContract": "legacy"}
                return original(*args)
            runner.action = wrong_observation
            grants = {"appServiceContract": "terminal-mac.app-service/4",
                      "appServiceExecutor": "compiled-native-helper", "appServiceLaunchIdentityContract": "terminal-mac.launch-identity/1",
                      "appServiceAdmission": "available"}
            with self.assertRaisesRegex(runner_module.Refused, "APP_SERVICE_REPLY_INVALID"):
                runner.run_native_app_service(archive, release, grants)
            self.assertEqual(effects, ["fenced", "marker-refreshed"])
            self.assertTrue((runner.out / "native-intent-00-open.json").exists())
            self.assertTrue((runner.out / "native-receipt-00-open.json").exists())
            self.assertFalse((runner.out / "native-observation-00-open.json").exists())
            self.assertEqual(runner.pending, "native:open:observe")
            self.assertEqual(sum(a[0] == "app-service" and "--service-command" in a
                                 and a[a.index("--service-command")+1] == "open"
                                 for a in actions), 1)
            self.assertFalse(any(a[a.index("--service-command")+1] == "install"
                                 for a in actions))

    def test_external_owner_digest_is_required_before_staging_or_guest_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, archive, release, actions, effects, _ = self.fixture(Path(tmp))
            grants = {"appServiceContract": "terminal-mac.app-service/4",
                      "appServiceExecutor": "compiled-native-helper", "appServiceLaunchIdentityContract": "terminal-mac.launch-identity/1",
                      "appServiceAdmission": "available"}
            for invalid in (None, "f" * 64, "not-hex"):
                with self.subTest(invalid=invalid):
                    runner.a.expected_app_sha256 = invalid
                    with self.assertRaisesRegex(runner_module.Refused, "APP_PAYLOAD_UNQUALIFIED"):
                        runner.run_native_app_service(archive, release, grants)
                    self.assertFalse(runner.stage.exists())
                    self.assertEqual(actions, [])
                    self.assertEqual(effects, [])

    def test_native_args_need_explicit_artifact_and_owner_digest_not_terminal_point(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            opts = ["--artifact", "synthetic-release.zip", "--native-app-service",
                    "--terminal-mac", "/synthetic/TerminalMac.app/Contents/MacOS/terminal-mac",
                    "--vm-home", str(root / "vmhome"), "--vm", "pilot"]
            with patch.object(runner_module.Path, "home", return_value=root):
                with self.assertRaisesRegex(runner_module.Refused, "APP_SERVICE_OPTIONS_INVALID"):
                    runner_module.arguments(opts)
                args = runner_module.arguments(opts + ["--expected-app-sha256", "e" * 64])
                self.assertTrue(args.native_app_service)
                self.assertIsNone(args.terminal_point)
                self.assertEqual(args.expected_app_sha256, "e" * 64)
                with self.assertRaisesRegex(runner_module.Refused, "E2E_DRIVER_REQUIRES_CLOSED"):
                    runner_module.arguments(opts + ["--expected-app-sha256", "e" * 64,
                                                    "--e2e-driver", "synthetic"])

    def test_old_helper_refused_before_stage_or_effect(self):
        for grants in [{"version":"0.2.0"},
                       {"appServiceContract":"terminal-mac.app-service/4",
                        "appServiceExecutor":"compiled-native-helper",
                        "appServiceAdmission":"available"}]:
            with self.subTest(grants=grants), tempfile.TemporaryDirectory() as tmp:
                runner, archive, release, actions, effects, _ = self.fixture(Path(tmp))
                with self.assertRaisesRegex(runner_module.Refused, "APP_SERVICE_UNAVAILABLE"):
                    runner.run_native_app_service(archive, release, grants)
                self.assertEqual(actions, [])
                self.assertEqual(effects, [])
                self.assertFalse(runner.stage.exists())

    def test_unconfirmed_ack_retains_exact_original_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, archive, release, actions, effects, _ = self.fixture(Path(tmp))
            runner.action = lambda *args: {"schema": "legacy"}
            grants = {"appServiceContract": "terminal-mac.app-service/4",
                      "appServiceExecutor": "compiled-native-helper", "appServiceLaunchIdentityContract": "terminal-mac.launch-identity/1",
                      "appServiceAdmission": "available"}
            with self.assertRaisesRegex(runner_module.Refused, "APP_SERVICE_REPLY_INVALID"):
                runner.run_native_app_service(archive, release, grants)
            self.assertEqual(effects, ["fenced", "marker-refreshed"])
            self.assertTrue((runner.out / "native-intent-00-open.json").exists())
            self.assertFalse((runner.out / "native-receipt-00-open.json").exists())
            self.assertEqual(runner.pending, "native:open")
            self.assertTrue(runner.stage.exists())


if __name__ == "__main__":
    unittest.main()
