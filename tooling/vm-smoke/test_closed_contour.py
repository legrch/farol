"""Closed-contour admission and driver staging; offline synthetic only.

No VM, guest or terminal-mac process runs: the CLI boundary is a recording
fake, the guest ACK boundary writes synthetic result files, and the driver
payloads are synthetic text files with hand-written manifests. machine.json
and the staged files are the only real state under test.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('closed_contour_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
# Synthetic identity only: these checks never open a real desktop or profile.
vm.IDENTITY = dict(name='ClosedProduct', bundleId='test.closed',
                   dataLeaf='test.closed', devDataLeaf='ClosedDev')

PNG = b'\x89PNG\r\n\x1a\n' + b'synthetic-capture'
BUNDLE_TEXT = '// synthetic vm-e2e driver bundle; no scenario, no network\n'
NODE_TEXT = '#!/bin/sh\n# synthetic pinned node stand-in, never executed\n'
NETWORK_POLICY = {'mode': 'guest-offline-local-fixtures', 'machineNetwork': False,
                  'receipt': 'machine.json-offline-configured', 'runtimeEgress': 'not-verified'}
PACKAGE_RESULT_KEYS = {'status', 'lifecycle', 'ui', 'tunnel', 'profile', 'version',
                       'archiveSha256', 'initial', 'stopped', 'relaunched', 'menu',
                       'cleanup', 'phases', 'lease'}


def canonical_tree_digest(app):
    """The canonical farol.tree-digest/v2 digest via the repository's Node
    implementation, so verify() admits the synthetic package."""
    program = ('const {treeDigest}=await import(process.argv[1]); '
               'console.log(await treeDigest(process.argv[2]));')
    result = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', program,
                             (Path(__file__).parents[1] / 'artifact-digest.mjs').as_uri(), str(app)],
                            capture_output=True, text=True, timeout=10,
                            env={'PATH': os.environ.get('PATH', ''), 'NODE_NO_WARNINGS': '1'})
    if result.returncode:
        raise AssertionError('canonical digest tool failed: ' + result.stderr)
    return result.stdout.strip()


def build_release_archive(root):
    """A valid producer-shaped package for the ordinary --artifact path."""
    app = root / 'ClosedProduct.app'
    (app / 'Contents').mkdir(parents=True)
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(dict(
        CFBundleIdentifier='test.closed', CFBundleShortVersionString='1.2.3')))
    archive = root / 'ClosedProduct-1.2.3-darwin-arm64.zip'
    m = dict(schema='farol.github-release/1', repository='legrch/farol',
             product='ClosedProduct', bundleId='test.closed', channel='stable',
             sourceDirty=False, platform='darwin', arch='arm64', signing='unsigned',
             notarized=False, version='1.2.3', sourceCommit='a'*40,
             sourceTreeDigest='b'*64, buildId='c'*64,
             artifactSha256=canonical_tree_digest(app), archiveName=archive.name)
    with zipfile.ZipFile(archive, 'w') as z:
        z.write(app, app.name)
        for item in sorted(app.rglob('*')):
            z.write(item, str(item.relative_to(root)))
        z.writestr('artifact.json', json.dumps(dict(m, signing={'kind': 'unsigned'})))
    m.update(archiveSize=archive.stat().st_size, archiveSha256=vm.digest(archive))
    (root / 'farol-release.json').write_text(json.dumps(m))
    (root / 'SHA256SUMS').write_text(f"{m['archiveSha256']}  {archive.name}\n")
    return archive


def build_runner(root, **overrides):
    (root / 'machines/pilot/artifacts').mkdir(parents=True)
    executable = root / 'app/Contents/MacOS/terminal-mac'
    executable.parent.mkdir(parents=True)
    executable.write_text('test')
    (executable.parent.parent / 'Info.plist').write_bytes(plistlib.dumps(dict(
        CFBundleIdentifier='dev.terminal-mac.host')))
    (executable.parent.parent / 'Resources/guest-tools').mkdir(parents=True)
    args = SimpleNamespace(
        terminal_mac=str(executable), vm_home=str(root), vm='pilot',
        terminal_point=[100, 100], menu_point=None, timeout=180,
        bootstrap='terminal', visible=False, connect_dev=False,
        connection_proof=False, release_dev=False, latest=False, artifact=None,
        prepare_test_guest=False, evidence=str(root / 'evidence'))
    for key, value in overrides.items():
        setattr(args, key, value)
    return vm.Runner(args)


def write_machine_json(machine, machine_json):
    file = machine / 'machine.json'
    if isinstance(machine_json, str):
        file.write_text(machine_json)
    else:
        file.write_text(json.dumps(machine_json))


def drive_closed_package(root, machine_json, closed=True, driver=False, clone_receipt=None,
                         guest_hook=None, execute=None, initial_vm_state='stopped', start_state='running',
                         boot_config=None):
    """One synthetic package run: --artifact admission, a recording fake CLI
    and a synthetic guest that ACKs every phase with result files. With
    driver=True the run carries a --e2e-driver payload and the synthetic
    guest writes the driver's own durable result before ACKing the phase."""
    payload = root / 'package'
    payload.mkdir()
    archive = build_release_archive(payload)
    driver_dir = None
    if driver:
        driver_dir, _manifest = build_driver_dir(root)
        if guest_hook is None:
            _manifest['entry'] = 'egress-probe-entry.mjs'
            (driver_dir / 'manifest.json').write_text(json.dumps(_manifest))
    runner = build_runner(root, closed=closed, artifact=str(archive),
                          e2e_driver=str(driver_dir) if driver else None)
    machine = runner.machine
    if machine_json is not None:
        write_machine_json(machine, machine_json)
    machine_before = (machine / 'machine.json').read_text() if (machine / 'machine.json').exists() else None
    state = {'pids': [4242]}
    next_pid = [4242]
    quit_requested = []
    proof_count = [0]
    calls = []

    def fake_cli(*args):
        argv = [str(a) for a in args]
        calls.append(argv)
        if argv[0] == 'status':
            return {'name': 'pilot', 'state': initial_vm_state}
        if argv[0] == 'start':
            if boot_config is not None:
                write_machine_json(machine, boot_config)
            return {'name': 'pilot', 'state': start_state}
        if argv[0] in ('show', 'hide'):
            return {}
        if argv[0] == 'action':
            if '--output' in argv:
                Path(argv[argv.index('--output') + 1]).write_bytes(PNG)
            if argv[2] == 'status':
                return {'accessibility': 'true', 'screenRecording': 'true',
                        'width': '800', 'height': '600'}
            if argv[2] == 'key' and 'cmd+q' in argv:
                quit_requested.append(True)
                state['pids'] = []
            return {}
        raise AssertionError('unexpected CLI command: ' + argv[0])

    def synthetic_guest(target):
        if target.name == 'server.result':
            target.write_text('READY')
            return
        name = target.stem[5:]  # '0001-share-probe' -> 'share-probe'
        if name in ('launch', 'relaunch'):
            state['pids'] = [next_pid[0]]
            next_pid[0] += 101
        if name == 'inspect':
            (target.parent / 'state.json').write_text(json.dumps(
                {'pids': list(state['pids']), 'windows': 1, 'foreground': True}))
        if name == 'quit-proof':
            proof_count[0] += 1
            (target.parent / 'quit-proof.json').write_text(json.dumps(
                {'runningMarker': 'absent' if quit_requested else 'present',
                 'receiptMarker': 'present' if quit_requested else 'absent',
                 'running': not quit_requested, 'drained': bool(quit_requested),
                 'receipt': f'proof-{proof_count[0]}', 'quitAt': 1000, 'observedAt': 1000}))
        if name == 'connection-proof':
            (target.parent / 'connection.json').write_text(json.dumps({'approvedDev': False}))
        if name == 'e2e' and guest_hook is None:
            from e2e_result_test_support import publish_result
            publish_result(runner, target, diagnostic=True)
        if guest_hook is not None:
            guest_hook(runner, name, target)
        target.write_text('READY')

    if clone_receipt is not None:
        # Simulate a machine that terminal-mac clone provisioned from a base.
        (runner.machine / 'clone.json').write_text(clone_receipt)
    runner.cli = fake_cli
    runner.wait_result = synthetic_guest
    # This suite exercises result/egress admission with an inert synthetic guest.
    # It never qualifies the deliberately blocked live Terminal bootstrap.
    # Bootstrap refusal is covered by test_bootstrap_diagnostics independently.
    def synthetic_start():
        runner.begin_effect()
        synthetic_guest(runner.report / 'server.result')
        runner.sequence = 0
        runner.pending = None
    runner.start_guest = synthetic_start
    result = caught = None
    with patch.object(vm.subprocess, 'check_output', return_value=''), patch.object(vm.time, 'sleep'):
        try:
            result = execute(runner) if execute is not None else runner.run()
        except vm.Refused as error:
            caught = error
    return runner, result, caught, calls, machine_before


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def build_driver_dir(root, *, manifest_changes=None, raw_manifest=None, manifest_link=False,
                     bundle_present=True, bundle_link=False, bundle_tamper=b'', bundle_bytes=None,
                     bundle_sha=None, node_present=True, node_link=False, node_tamper=b'',
                     node_bytes=None, node_sha=None):
    """A synthetic tooling/vm-e2e/bundle-driver.mjs output: manifest.json and
    the bundle inside the driver directory, the pinned Node runtime outside
    it, exactly like the producer shape. The manifest records the synthetic
    content digests unless a test overrides them, so on-disk tampering stays
    detectable."""
    source = root / 'driver'
    runtime = root / 'runtime'
    source.mkdir()
    runtime.mkdir()
    bundle = source / 'driver.bundle.mjs'
    node = runtime / 'node'
    if node_present:
        if node_link:
            real = runtime / 'real-node'
            real.write_bytes(NODE_TEXT.encode())
            node.symlink_to(real)
        else:
            node.write_bytes(NODE_TEXT.encode() + node_tamper)
    if bundle_present:
        if bundle_link:
            real = source / 'real-bundle.mjs'
            real.write_bytes(BUNDLE_TEXT.encode())
            bundle.symlink_to(real)
        else:
            bundle.write_bytes(BUNDLE_TEXT.encode() + bundle_tamper)
    manifest = {
        'schema': 'farol.vm-e2e.driver-manifest/1',
        'tool': 'farol.vm-e2e/1',
        'entry': 'synthetic-entry.mjs',
        'bundler': 'inline',
        'bundle': {'file': 'driver.bundle.mjs', 'sha256': bundle_sha or sha256_bytes(BUNDLE_TEXT.encode()),
                   'bytes': bundle_bytes if bundle_bytes is not None else len(BUNDLE_TEXT)},
        'node': {'path': str(node), 'size': node_bytes if node_bytes is not None else len(NODE_TEXT),
                 'sha256': node_sha or sha256_bytes(NODE_TEXT.encode())},
    }
    for key, value in (manifest_changes or {}).items():
        manifest[key] = value
    text = raw_manifest if raw_manifest is not None else json.dumps(manifest, indent=2) + '\n'
    if manifest_link:
        real = root / 'real-manifest.json'
        real.write_text(text)
        (source / 'manifest.json').symlink_to(real)
    else:
        (source / 'manifest.json').write_text(text)
    return source, manifest


class ClosedAdmissionTests(unittest.TestCase):
    def test_closed_flag_combinations_refuse_at_arguments(self):
        for args, reason in [
                (['--closed', '--latest'], 'CLOSED_DOWNLOAD_FORBIDDEN'),
                (['--closed', '--release-dev'], 'CLOSED_MODE_INVALID'),
                (['--closed', '--connection-proof'], 'CLOSED_MODE_INVALID'),
                (['--closed', '--connect-dev'], 'DEV_IMPORT_UNQUALIFIED'),
                (['--closed', '--artifact', ''], 'CLOSED_DOWNLOAD_FORBIDDEN')]:
            with self.subTest(args=' '.join(args)):
                with self.assertRaisesRegex(vm.Refused, reason):
                    vm.arguments(args)
        # The source group still requires one source; --closed alone parses no run.
        with self.assertRaises(SystemExit):
            vm.arguments(['--closed'])

    def test_closed_flag_combines_with_artifact_and_prepare_test_guest(self):
        args = vm.arguments(['--closed', '--artifact', 'release.zip', '--prepare-test-guest',
                             '--terminal-mac', '/unused', '--vm-home', '/unused',
                             '--terminal-point', '100', '100'])
        self.assertTrue(args.closed)
        self.assertTrue(args.prepare_test_guest)
        self.assertEqual(args.artifact, 'release.zip')
        self.assertFalse(args.latest)

    def admit_runner(self, root):
        machine = root / 'machines' / 'pilot'
        machine.mkdir(parents=True)
        runner = object.__new__(vm.Runner)
        runner.machine = machine
        return runner

    def test_admit_closed_accepts_an_offline_machine(self):
        with tempfile.TemporaryDirectory() as d:
            runner = self.admit_runner(Path(d))
            write_machine_json(runner.machine,
                               {'schema': 1, 'name': 'pilot', 'cpu': 4, 'network': False})
            self.assertEqual(runner.admit_closed(), NETWORK_POLICY)

    def test_admit_closed_refuses_a_machine_that_is_not_offline(self):
        for value in (True, None, 'false', 0, 1, 'offline'):
            with self.subTest(value=repr(value)), tempfile.TemporaryDirectory() as d:
                runner = self.admit_runner(Path(d))
                write_machine_json(runner.machine, {'name': 'pilot', 'network': value})
                with self.assertRaisesRegex(vm.Refused, 'CLOSED_REQUIRES_OFFLINE_MACHINE'):
                    runner.admit_closed()

    def test_admit_closed_refuses_an_invalid_machine_file(self):
        for case in ('absent', 'not-json', 'array', 'symlink', 'hardlink', 'fifo',
                     'oversized', 'directory', 'duplicate-network', 'wrong-name'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as d:
                runner = self.admit_runner(Path(d))
                file = runner.machine / 'machine.json'
                if case == 'not-json':
                    file.write_text('{not-json')
                elif case == 'array':
                    file.write_text('[1, 2]')
                elif case == 'symlink':
                    real = Path(d) / 'real-machine.json'
                    real.write_text('{"network": false}')
                    file.symlink_to(real)
                elif case == 'hardlink':
                    real = Path(d) / 'real-machine.json'
                    real.write_text('{"name":"pilot","network":false}')
                    os.link(real, file)
                elif case == 'fifo':
                    os.mkfifo(file)
                elif case == 'oversized':
                    file.write_text('{"network": false, "pad": "' + 'x' * 70000 + '"}')
                elif case == 'directory':
                    file.mkdir()
                elif case == 'duplicate-network':
                    file.write_text('{"name":"pilot","network":true,"network":false}')
                elif case == 'wrong-name':
                    file.write_text('{"name":"other","network":false}')
                with self.assertRaisesRegex(vm.Refused, 'VM_MACHINE_FILE_INVALID'):
                    runner.admit_closed()

    def test_closed_run_refuses_before_any_guest_action(self):
        for machine_json, reason in [({'name': 'pilot', 'network': True}, 'CLOSED_REQUIRES_OFFLINE_MACHINE'),
                                     ('{not-json', 'VM_MACHINE_FILE_INVALID'),
                                     (None, 'VM_MACHINE_FILE_INVALID')]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                runner, result, caught, calls, _ = drive_closed_package(root, machine_json)
                self.assertIsNone(result)
                self.assertRegex(str(caught), reason)
                self.assertEqual(calls, [], 'admission must precede every CLI contact')
                self.assertEqual(runner.log, [])
                self.assertIsNone(runner.pending)
                self.assertIsNone(runner.network_policy)
                self.assertFalse(runner.effect_file.exists())
                self.assertFalse((runner.machine / 'input-lease.json').exists(),
                                 'a refused closed run must not acquire the input lease')
                self.assertFalse((runner.machine / 'exchange' / '.input-lease.json').exists())

    def test_closed_run_refuses_an_existing_or_racing_vm_before_guest_actions(self):
        # The disk config may differ from the already-running VZ configuration.
        # An already-running response to start is also a race, not our fresh boot.
        for initial, start, expected in [('running', 'running', ['status']),
                                         ('stopped', 'already-running', ['status', 'start'])]:
            with self.subTest(initial=initial, start=start), tempfile.TemporaryDirectory() as d:
                runner, result, caught, calls, _ = drive_closed_package(
                    Path(d), {'name': 'pilot', 'network': False},
                    initial_vm_state=initial, start_state=start)
                self.assertIsNone(result)
                self.assertRegex(str(caught), 'CLOSED_REQUIRES_FRESH_VM_BOOT')
                self.assertEqual([call[0] for call in calls], expected)
                self.assertIsNone(runner.pending)
                self.assertFalse(runner.effect_file.exists())
                self.assertFalse((runner.machine / 'input-lease.json').exists())

    def test_closed_run_rechecks_config_after_start_before_guest_actions(self):
        with tempfile.TemporaryDirectory() as d:
            runner, result, caught, calls, _ = drive_closed_package(
                Path(d), {'name': 'pilot', 'network': False},
                boot_config={'name': 'pilot', 'network': True})
            self.assertIsNone(result)
            self.assertRegex(str(caught), 'CLOSED_REQUIRES_OFFLINE_MACHINE')
            self.assertEqual([call[0] for call in calls], ['status', 'start'])
            self.assertIsNone(runner.pending)
            self.assertFalse(runner.effect_file.exists())

    def test_closed_package_run_records_network_policy_and_keeps_existing_keys(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner, result, caught, calls, machine_before = drive_closed_package(
                root, {'name': 'pilot', 'network': False})
            self.assertIsNone(caught)
            owner = 'farol-smoke:' + runner.run_id
            self.assertEqual(result['status'], 'NEEDS_REVIEW')
            self.assertEqual(result['lifecycle'], 'PASS')
            self.assertEqual(result['ui'], 'NEEDS_REVIEW')
            self.assertEqual(result['version'], '1.2.3')
            self.assertEqual(result['menu'], 'NOT_RUN')
            self.assertEqual(result['cleanup'], 'CLEARED')
            self.assertEqual(result['lease'], {'owner': owner, 'generation': 1})
            self.assertEqual(result['networkPolicy'], NETWORK_POLICY)
            self.assertEqual(runner.network_policy, NETWORK_POLICY)
            self.assertEqual(set(result), PACKAGE_RESULT_KEYS | {'networkPolicy'})
            self.assertEqual(json.loads((runner.out / 'result.json').read_text()), result)
            self.assertEqual(result['phases'][-1], 'stop')
            # The flock is released, but evidence remains until the effect fence
            # is explicitly cleared by the caller, as in main().
            self.assertEqual((runner.machine / 'machine.json').read_text(), machine_before)
            self.assertIsNone(runner.lease_fd)
            self.assertTrue((runner.machine / 'input-lease.json').exists())
            self.assertTrue((runner.exchange / '.input-lease.json').exists())
            runner.finish_effect()
            self.assertFalse(runner.effect_file.exists())
            self.assertFalse((runner.machine / 'input-lease.json').exists())
            self.assertFalse((runner.exchange / '.input-lease.json').exists())

    def test_cloned_instance_records_provenance_and_corrupt_receipt_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            top = Path(d)
            for sub in ('a', 'b', 'c'):
                (top / sub).mkdir()
            good = json.dumps({'schema': 'terminal-mac.clone/1', 'from': 'farol-base-1',
                               'to': 'pilot', 'identitySha256': 'e' * 64, 'at': 1700000000})
            # An ordinary (non-cloned) machine adds no instance key.
            runner, result, caught, _, _ = drive_closed_package(top / 'a', {'name': 'pilot', 'network': False})
            self.assertIsNone(caught)
            self.assertNotIn('instance', result)
            runner2, result2, caught2, _, _ = drive_closed_package(
                top / 'b', {'name': 'pilot', 'network': False}, clone_receipt=good)
            self.assertIsNone(caught2)
            self.assertEqual(result2['instance']['clonedFrom'], 'farol-base-1')
            self.assertEqual(result2['instance']['instance'], 'pilot')
            self.assertEqual(set(result2), PACKAGE_RESULT_KEYS | {'networkPolicy', 'instance'})
            self.assertEqual(json.loads((runner2.out / 'result.json').read_text()), result2)
            runner3, _, caught3, _, _ = drive_closed_package(
                top / 'c', {'name': 'pilot', 'network': False}, clone_receipt='{not-json')
            self.assertIsNotNone(caught3)
            self.assertIn('INSTANCE_RECEIPT_INVALID', str(caught3))

    def test_closed_run_with_driver_records_the_e2e_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner, result, caught, calls, machine_before = drive_closed_package(
                root, {'name': 'pilot', 'network': False}, driver=True)
            self.assertIsNone(caught)
            self.assertEqual(result['status'], 'NEEDS_REVIEW')
            # The e2e phase ran behind the ordinary lifecycle, its receipt is
            # the driver's own durable result, and the staged payload reached
            # the guest through the exact digests.
            self.assertIn('e2e', result['phases'])
            self.assertIn('install', result['phases'])
            self.assertLess(result['phases'].index('install'), result['phases'].index('e2e'),
                            'the driver runs after the app under test is installed and launched')
            self.assertEqual(result['e2e']['scenario'], 'vm-e2e-egress-probe')
            self.assertEqual(result['e2e']['status'], 'REPORTED')
            self.assertEqual(result['test']['status'], 'REPORTED')
            self.assertFalse(result['e2e']['qualificationEligible'])
            self.assertEqual(set(result), PACKAGE_RESULT_KEYS | {'networkPolicy', 'e2e', 'test', 'operation'})
            self.assertEqual(json.loads((runner.out / 'result.json').read_text()), result)
            # The staged payload carried the manifest digests into the guest
            # share and is gone with the cleaned stage afterwards.
            self.assertEqual(result['cleanup'], 'CLEARED')
            self.assertFalse(runner.stage.exists())

    def test_ordinary_artifact_run_records_no_network_policy(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner, result, caught, calls, _ = drive_closed_package(root, None, closed=False)
            self.assertIsNone(caught)
            self.assertIsNone(runner.network_policy)
            self.assertNotIn('networkPolicy', result)
            self.assertEqual(set(result), PACKAGE_RESULT_KEYS)


class DriverStagingTests(unittest.TestCase):
    def staged_runner(self, root):
        runner = build_runner(root)
        runner.stage.mkdir(mode=0o700)

        def forbidden_cli(*args):
            raise AssertionError('stage_driver must never invoke terminal-mac')
        runner.cli = forbidden_cli
        return runner

    def refuse(self, root, **kwargs):
        source, manifest = build_driver_dir(root, **kwargs)
        runner = self.staged_runner(root)
        caught = None
        try:
            runner.stage_driver(source)
        except vm.Refused as error:
            caught = error
        return runner, caught, manifest

    def test_stage_driver_stages_the_verified_payload(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source, manifest = build_driver_dir(root)
            runner = self.staged_runner(root)
            staged = runner.stage_driver(source)
            expected = {'schema': 'farol.vm-e2e.driver-manifest/1', 'tool': 'farol.vm-e2e/1',
                        'entry': 'synthetic-entry.mjs', 'bundler': 'inline',
                        'bundle': {'file': 'driver.bundle.mjs', 'sha256': manifest['bundle']['sha256'],
                                   'bytes': manifest['bundle']['bytes']},
                        'node': {'path': 'node', 'size': manifest['node']['size'],
                                 'sha256': manifest['node']['sha256']},
                        'staged': True}
            self.assertEqual(staged, expected)
            self.assertEqual(set(p.name for p in runner.stage.iterdir()), set(vm.DRIVER_STAGE_NAMES))
            self.assertEqual((runner.stage / 'driver.bundle.mjs').read_bytes(), BUNDLE_TEXT.encode())
            self.assertEqual((runner.stage / 'node').read_bytes(), NODE_TEXT.encode())
            self.assertEqual((runner.stage / 'node').stat().st_mode & 0o777, 0o700)
            self.assertEqual((runner.stage / 'driver.bundle.mjs').stat().st_mode & 0o777, 0o600)
            self.assertEqual((runner.stage / 'driver.manifest.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((runner.stage / 'driver.manifest.json').read_text()), expected)
            # No host path and no unexpected material reaches the guest-visible share.
            manifest_text = (runner.stage / 'driver.manifest.json').read_text()
            self.assertNotIn(str(root), manifest_text)
            self.assertNotIn(str(source), manifest_text)

    def test_stage_driver_refuses_digest_or_size_mismatch(self):
        for kwargs, reason in [
                (dict(bundle_tamper=b'tampered'), 'DRIVER_BUNDLE_DIGEST_INVALID'),
                (dict(bundle_bytes=len(BUNDLE_TEXT) + 1), 'DRIVER_BUNDLE_DIGEST_INVALID'),
                (dict(bundle_sha='a' * 64), 'DRIVER_BUNDLE_DIGEST_INVALID'),
                (dict(node_tamper=b'tampered'), 'DRIVER_NODE_DIGEST_INVALID'),
                (dict(node_bytes=len(NODE_TEXT) + 1), 'DRIVER_NODE_DIGEST_INVALID'),
                (dict(node_sha='b' * 64), 'DRIVER_NODE_DIGEST_INVALID')]:
            with self.subTest(**kwargs), tempfile.TemporaryDirectory() as d:
                runner, caught, manifest = self.refuse(Path(d), **kwargs)
                self.assertIsNotNone(caught)
                self.assertRegex(str(caught), reason)
                self.assertEqual(list(runner.stage.iterdir()), [], 'a refusal leaves no driver residue')

    def test_stage_driver_refuses_invalid_manifests(self):
        node_digest = sha256_bytes(NODE_TEXT.encode())
        for kwargs, reason in [
                (dict(raw_manifest='{not-json'), 'DRIVER_MANIFEST_INVALID'),
                (dict(manifest_changes={'schema': 'farol.vm-e2e.driver-manifest/2'}), 'DRIVER_MANIFEST_INVALID'),
                (dict(manifest_changes={'bundler': 'magic'}), 'DRIVER_MANIFEST_INVALID'),
                (dict(manifest_changes={'bundle': {'file': '../escape.mjs',
                                                   'sha256': sha256_bytes(BUNDLE_TEXT.encode()),
                                                   'bytes': len(BUNDLE_TEXT)}}), 'DRIVER_MANIFEST_INVALID'),
                (dict(manifest_changes={'node': {'path': 'runtime/node', 'size': len(NODE_TEXT),
                                                 'sha256': node_digest}}), 'DRIVER_MANIFEST_INVALID'),
                (dict(manifest_changes={'node': {'path': str(Path.home() / 'Library/Application Support' /
                                                            'test.closed/runtime/node'),
                                                 'size': len(NODE_TEXT), 'sha256': node_digest}}),
                 'HOST_PRODUCT_PROFILE_FORBIDDEN'),
                (dict(manifest_link=True), 'DRIVER_MANIFEST_INVALID'),
                (dict(raw_manifest='{"schema": "farol.vm-e2e.driver-manifest/1", "pad": "' + 'x' * 70000 + '"}'),
                 'DRIVER_MANIFEST_INVALID')]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as d:
                runner, caught, manifest = self.refuse(Path(d), **kwargs)
                self.assertIsNotNone(caught)
                self.assertRegex(str(caught), reason)
                self.assertEqual(list(runner.stage.iterdir()), [])

    def test_stage_driver_refuses_missing_or_linked_payloads(self):
        for kwargs, reason in [
                (dict(node_present=False), 'DRIVER_NODE_MISSING'),
                (dict(bundle_present=False), 'DRIVER_BUNDLE_MISSING'),
                (dict(bundle_link=True), 'DRIVER_BUNDLE_UNSAFE'),
                (dict(node_link=True), 'DRIVER_NODE_UNSAFE')]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as d:
                runner, caught, manifest = self.refuse(Path(d), **kwargs)
                self.assertIsNotNone(caught)
                self.assertRegex(str(caught), reason)
                self.assertEqual(list(runner.stage.iterdir()), [])

    def test_stage_driver_refuses_a_missing_or_linked_driver_directory(self):
        for linked in (False, True):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                source, manifest = build_driver_dir(root)
                runner = self.staged_runner(root)
                target = root / 'absent'
                if linked:
                    target.symlink_to(source)
                with self.assertRaisesRegex(vm.Refused, 'DRIVER_MANIFEST_INVALID'):
                    runner.stage_driver(target)
                self.assertEqual(list(runner.stage.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
