import importlib.util
import contextlib
import io
import json
import os
import stat
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

spec = importlib.util.spec_from_file_location('vm_runner', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
# Synthetic identity only: these checks never open a real desktop or profile.
vm.IDENTITY = dict(name='TestProduct', bundleId='test.product', dataLeaf='test.product', devDataLeaf='TestDev')


def canonical_tree_digest(app):
    """The canonical farol.tree-digest/v2 digest via the repository's Node
    implementation — the same invocation the physical digest regression uses."""
    program = ('const {treeDigest}=await import(process.argv[1]); '
               'console.log(await treeDigest(process.argv[2]));')
    result = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', program,
                             (Path(__file__).parents[1] / 'artifact-digest.mjs').as_uri(), str(app)],
                            capture_output=True, text=True, timeout=10,
                            env={'PATH': os.environ.get('PATH', ''), 'NODE_NO_WARNINGS': '1'})
    if result.returncode:
        raise AssertionError('canonical digest tool failed: ' + result.stderr)
    return result.stdout.strip()




def seed_synthetic_owned_lease(runner):
    """Model exactly the run-owned host record when bypassing actual acquisition.

    Pure Dev/effect tests construct Runner without invoking lease acquisition;
    they must now supply BOTH files that production acquisition publishes.
    This is not a shortcut for the dedicated acquire_input_lease regressions.
    """
    value = {'schema': 'terminal-mac.input-lease/1',
             'owner': 'farol-smoke:' + runner.run_id,
             'generation': 1, 'acquiredAt': 123}
    file = runner.machine / 'input-lease.json'
    file.write_text(json.dumps(value))
    stat = file.stat()
    runner.lease_metadata_value = value
    runner.lease_metadata_identity = (stat.st_dev, stat.st_ino)
    runner.lease_metadata_owned = True
    runner.helper_update_flag_owned = True

class AdmissionTests(unittest.TestCase):
    def asset(self, root, extra=None):
        # A valid producer-shaped package: the archive carries the physical app
        # tree with explicit entries and modes, and artifactSha256 is the
        # canonical digest of that tree, so verify() admits it.
        app = root / 'TestProduct.app'
        (app / 'Contents').mkdir(parents=True)
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(dict(
            CFBundleIdentifier='test.product', CFBundleShortVersionString='1.2.3')))
        archive = root / 'TestProduct-1.2.3-darwin-arm64.zip'
        m = dict(schema='farol.github-release/1', repository='legrch/farol',
                 product='TestProduct', bundleId='test.product', channel='stable',
                 sourceDirty=False, platform='darwin', arch='arm64', signing='unsigned',
                 notarized=False, version='1.2.3', sourceCommit='a'*40,
                 sourceTreeDigest='b'*64, buildId='c'*64,
                 artifactSha256=canonical_tree_digest(app), archiveName=archive.name)
        with zipfile.ZipFile(archive, 'w') as z:
            z.write(app, app.name)
            for item in sorted(app.rglob('*')):
                z.write(item, str(item.relative_to(root)))
            z.writestr('artifact.json', json.dumps(dict(m, signing={'kind': 'unsigned'})))
            if extra:
                z.writestr(*extra)
        m.update(archiveSize=archive.stat().st_size, archiveSha256=vm.digest(archive))
        (root / 'farol-release.json').write_text(json.dumps(m))
        (root / 'SHA256SUMS').write_text(f"{m['archiveSha256']}  {archive.name}\n")
        return archive

    def test_exact_archive_and_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(vm.verify(self.asset(Path(d)))['version'], '1.2.3')

    def test_altered_archive_refused(self):
        with tempfile.TemporaryDirectory() as d:
            archive = self.asset(Path(d))
            with archive.open('ab') as f:
                f.write(b'changed')
            with self.assertRaisesRegex(vm.Refused, 'ARCHIVE_DIGEST'):
                vm.verify(archive)

    def test_traversal_refused_before_guest_install(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(vm.Refused, 'ARCHIVE_PATH'):
                vm.verify(self.asset(Path(d), ('TestProduct.app/../../host.txt', b'x')))

    def test_escaping_symlink_refused(self):
        with tempfile.TemporaryDirectory() as d:
            link = zipfile.ZipInfo('TestProduct.app/link')
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            with self.assertRaisesRegex(vm.Refused, 'ARCHIVE_LINK_'):
                vm.verify(self.asset(Path(d), (link, '../outside')))

    def test_foreign_profile_identity_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            archive = self.asset(root)
            p = root / 'farol-release.json'
            m = json.loads(p.read_text())
            m['bundleId'] = 'foreign.production'
            p.write_text(json.dumps(m))
            with self.assertRaisesRegex(vm.Refused, 'RELEASE_IDENTITY'):
                vm.verify(archive)

    def test_symlink_input_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            archive = self.asset(root)
            link = root / 'link.zip'
            link.symlink_to(archive)
            with self.assertRaisesRegex(vm.Refused, 'ASSET_FILE'):
                vm.verify(link)

    def test_invalid_vm_and_unbounded_timeout(self):
        base = ['--latest', '--terminal-mac', '/unused', '--vm-home', '/unused', '--terminal-point', '100', '100']
        for args in [['--vm', '../prod'], ['--timeout', '100000']]:
            with self.assertRaises(vm.Refused):
                vm.arguments(base + args)

    def test_cli_environment_and_deadline(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'machines/pilot/artifacts').mkdir(parents=True)
            executable = root / 'app/Contents/MacOS/terminal-mac'
            executable.parent.mkdir(parents=True)
            executable.write_text('test')
            (executable.parent.parent / 'Info.plist').write_bytes(plistlib.dumps(dict(
                CFBundleIdentifier='dev.terminal-mac.host')))
            (executable.parent.parent / 'Resources/guest-tools').mkdir(parents=True)
            args = vm.arguments(['--latest', '--terminal-mac', str(executable),
                                 '--vm-home', str(root), '--terminal-point', '100', '100', '--evidence', str(root / 'evidence')])
            with patch.dict(os.environ, {'FAROL_ENVIRONMENT': 'dev', 'NODE_OPTIONS': 'unsafe',
                                        'HTTPS_PROXY': 'private-proxy'}):
                runner = vm.Runner(args)
            self.assertNotIn('FAROL_ENVIRONMENT', runner.env)
            self.assertNotIn('NODE_OPTIONS', runner.env)
            self.assertNotIn('HTTPS_PROXY', runner.env)
            runner.deadline = 0
            with self.assertRaisesRegex(vm.Refused, 'DEADLINE'):
                runner.cli('status', 'pilot')

    def test_private_config_rejects_profile_or_credential_fields(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / 'config.json'
            file.write_text(json.dumps({'profile': '/owner/profile', 'credential': 'not-a-secret'}))
            with self.assertRaisesRegex(vm.Refused, 'CONFIG_FIELDS_INVALID'):
                vm.arguments(['--latest', '--config', str(file)])

    def test_linked_archive_is_not_resolved_by_runner_admission(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            archive = self.asset(root)
            alias = root / 'alias.zip'
            alias.symlink_to(archive)
            with self.assertRaisesRegex(vm.Refused, 'ASSET_FILE_INVALID'):
                vm.verify(alias.absolute())

    def test_dev_export_copies_only_tunnel_and_key(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            profile = root / 'Library/Application Support/TestDev'
            (profile / 'farol-state').mkdir(parents=True)
            key_dir = profile / 'farol-private/secure-mcp-connector'
            key_dir.mkdir(parents=True)
            key = key_dir / 'control-plane-api-key'
            key.write_text('synthetic-test-key-no-real-secret')
            key.chmod(0o600)
            config = {'connectors': {'secureMcp': {'tunnelId': 'test-only', 'credential': 'stored'}},
                      'computer': {'workspaces': ['/never-copy-this-host-folder']}, 'runtime': 'never-copy'}
            (profile / 'farol-state/config.json').write_text(json.dumps(config))
            stage = root / 'stage'
            stage.mkdir()
            with patch.object(vm.subprocess, 'check_output', return_value=''):
                vm.export_dev_connection(stage, vm.IDENTITY, root)
            self.assertEqual(json.loads((stage / 'dev-connection.json').read_text()),
                             {'schema': 1, 'tunnelId': 'test-only'})
            self.assertEqual((stage / 'dev-key').read_bytes(), key.read_bytes())
            self.assertEqual((stage / 'dev-key').stat().st_mode & 0o777, 0o600)
            self.assertEqual(set(x.name for x in stage.iterdir()), {'dev-key', 'dev-connection.json'})
            with patch.object(vm.subprocess, 'check_output', return_value=str(profile)):
                with self.assertRaisesRegex(vm.Refused, 'HOST_DEV_STILL_RUNNING'):
                    vm.export_dev_connection(stage, vm.IDENTITY, root)

    def test_transient_dev_payload_is_not_preserved_as_failed_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name in ('dev-key', 'dev-connection.json', 'receipt.json'):
                (root / name).write_text('synthetic')
            runner = object.__new__(vm.Runner)
            runner.stage = root
            runner.clear_dev_payload()
            runner.clear_dev_payload()
            self.assertEqual([p.name for p in root.iterdir()], ['receipt.json'])

    def test_runtime_and_evidence_paths_cannot_target_host_product_profiles(self):
        home = Path('/fake-home')
        for leaf in (vm.IDENTITY['dataLeaf'], vm.IDENTITY['devDataLeaf']):
            protected = home / 'Library/Application Support' / leaf
            for target in (protected, protected / 'evidence/run', Path(str(protected).upper())):
                with self.assertRaisesRegex(vm.Refused, 'HOST_PRODUCT_PROFILE_FORBIDDEN'):
                    vm.refuse_host_profile_path(target, vm.IDENTITY, home)
        vm.refuse_host_profile_path(home / 'Library/Application Support/test-machines', vm.IDENTITY, home)

    def test_cold_helper_readiness_recovers_but_permission_denial_stops(self):
        runner = object.__new__(vm.Runner)
        runner.deadline = vm.time.monotonic() + 30
        ready = {'accessibility': 'true', 'screenRecording': 'true'}
        with patch.object(runner, 'action', side_effect=[vm.Refused('GUEST_ACTION_FAILED:action'), ready]) as action:
            with patch.object(vm.time, 'sleep'):
                self.assertEqual(runner.wait_guest_ready(), ready)
            self.assertEqual(action.call_count, 2)
        with patch.object(runner, 'action', return_value={'accessibility': 'false', 'screenRecording': 'true'}) as action:
            with self.assertRaisesRegex(vm.Refused, 'GUEST_PERMISSIONS_MISSING'):
                runner.wait_guest_ready()
            self.assertEqual(action.call_count, 1)

    def test_expired_deadline_refuses_further_actions(self):
        runner = object.__new__(vm.Runner)
        runner.deadline = 0
        with self.assertRaisesRegex(vm.Refused, 'DEADLINE'):
            runner.remaining()

    def test_fifo_dev_key_refuses_within_a_bounded_process(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            profile = root / 'Library/Application Support/TestDev'
            (profile / 'farol-state').mkdir(parents=True)
            keys = profile / 'farol-private/secure-mcp-connector'
            keys.mkdir(parents=True)
            os.mkfifo(keys / 'control-plane-api-key', 0o600)
            (profile / 'farol-state/config.json').write_text(json.dumps({'connectors': {'secureMcp': {'tunnelId': 'test-only', 'credential': 'stored'}}}))
            stage = root / 'stage'
            stage.mkdir()
            copied_source = root / 'runner-source.py'
            copied_source.write_bytes(Path(spec.origin).read_bytes())
            script = '''import importlib.util,json,sys
from pathlib import Path
sys.pycache_prefix=None
s=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.subprocess.check_output=lambda *a,**k:''
m.export_dev_connection(Path(sys.argv[2]),json.loads(sys.argv[3]),Path(sys.argv[4]))
'''
            result = subprocess.run([sys.executable, '-B', '-c', script, str(copied_source), str(stage), json.dumps(vm.IDENTITY), str(root)], capture_output=True, text=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('DEV_KEY_UNSAFE', result.stderr)
            self.assertEqual(list(stage.iterdir()), [])
            self.assertFalse((root / '__pycache__').exists())

    def test_dev_missing_credential_refuses_before_key_access(self):
        for value in ('missing', None):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                profile = root / 'Library/Application Support/TestDev'
                (profile / 'farol-state').mkdir(parents=True)
                (profile / 'farol-private/secure-mcp-connector').mkdir(parents=True)
                connector = {'tunnelId': 'test-only', 'credential': value}
                (profile / 'farol-state/config.json').write_text(json.dumps({'connectors': {'secureMcp': connector}}))
                with patch.object(vm.os, 'open') as opened:
                    with self.assertRaisesRegex(vm.Refused, 'DEV_CREDENTIAL_NOT_STORED'):
                        vm.export_dev_connection(root, vm.IDENTITY, root)
                    opened.assert_not_called()

    def test_fence_syncs_file_then_directory_before_effect_and_keeps_failure_fenced(self):
        for fail_directory in (False, True):
            with self.subTest(fail_directory=fail_directory), tempfile.TemporaryDirectory() as d:
                runner = object.__new__(vm.Runner)
                runner.effect_file = Path(d) / '.farol-smoke-pending.json'
                runner.effect_owned = False
                runner.run_id = 'durability-test'
                runner.out = Path(d) / 'evidence'
                runner.machine = Path(d)
                runner.cleanup_note = 'CLEARED'
                # This test bypasses lease acquisition, which normally publishes
                # the exact helper-update marker before any guest effect.
                runner.exchange.mkdir()
                (runner.exchange / '.input-lease.json').write_text(json.dumps({
                    'schema': 'terminal-mac.input-lease-flag/1',
                    'owner': 'farol-smoke:durability-test', 'deadline': 9999999999}))
                seed_synthetic_owned_lease(runner)
                synced = []
                fsync = os.fsync
                def sync(fd):
                    directory = stat.S_ISDIR(os.fstat(fd).st_mode)
                    synced.append('directory' if directory else 'file')
                    if directory and fail_directory:
                        raise OSError('directory-sync-failed')
                    fsync(fd)
                with patch.object(vm.os, 'fsync', side_effect=sync):
                    if fail_directory:
                        # No phase request may be constructed when durability fails.
                        with self.assertRaisesRegex(OSError, 'directory-sync-failed'):
                            runner.phase('install')
                        self.assertFalse(runner.effect_owned)
                        self.assertTrue(runner.effect_file.exists())
                        with self.assertRaisesRegex(vm.Refused, 'UNRESOLVED_GUEST_OPERATION'):
                            runner.begin_effect()
                    else:
                        runner.begin_effect()
                        self.assertTrue(runner.effect_owned)
                        runner.log = ['stop']
                        runner.finish_effect()
                        self.assertFalse(runner.effect_file.exists())
                self.assertEqual(synced, ['file', 'directory'] if fail_directory else
                                 ['file', 'directory', 'directory', 'directory', 'directory'])

    def test_preflight_failure_without_stage_preserves_original_result(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner = object.__new__(vm.Runner)
            runner.stage = root / 'stage-never-created'
            runner.out = root
            runner.pending = None
            runner.log = []
            runner.run = lambda: (_ for _ in ()).throw(vm.Refused('GUEST_PERMISSIONS_MISSING'))
            with patch.object(vm, 'arguments', return_value=None), patch.object(vm, 'Runner', return_value=runner), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(vm.main(), 2)
            result = json.loads((root / 'result.json').read_text())
            self.assertEqual(result['reason'], 'GUEST_PERMISSIONS_MISSING')
            self.assertEqual(result['outcome'], 'NOT_STARTED')
            self.assertFalse(runner.stage.exists())

    def test_source_uncertainty_refuses_before_key_access(self):
        for flag in ('setup', 'runtime', 'verification'):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                profile = root / 'Library/Application Support/TestDev'
                (profile / 'farol-state').mkdir(parents=True)
                (profile / 'farol-private/secure-mcp-connector').mkdir(parents=True)
                connector = {'tunnelId': 'test-only', 'credential': 'stored'}
                config = {'connectors': {'secureMcp': connector}}
                if flag == 'setup': config['setup'] = {'connect': {'outcomeUnknown': True}}
                if flag == 'runtime': connector['runtime'] = {'state': 'outcome_unknown'}
                if flag == 'verification': connector['appVerificationPending'] = True
                (profile / 'farol-state/config.json').write_text(json.dumps(config))
                with patch.object(vm.os, 'open') as opened:
                    with self.assertRaisesRegex(vm.Refused, 'DEV_EFFECT_UNKNOWN'):
                        vm.export_dev_connection(root, vm.IDENTITY, root)
                    opened.assert_not_called()

    def test_process_guard_matches_legacy_case_spelling(self):
        home = Path('/fake-home')
        row = str(home / 'Library/Application Support/TestDev').upper()
        with patch.object(vm.subprocess, 'check_output', return_value=row):
            with self.assertRaisesRegex(vm.Refused, 'HOST_DEV_STILL_RUNNING'):
                vm.require_host_dev_stopped(vm.IDENTITY, home)

    def test_unresolved_effect_fences_later_mutation_and_needs_clean_stop(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            first = object.__new__(vm.Runner)
            first.machine = root
            first.effect_file = root / '.farol-smoke-pending.json'
            first.effect_owned = False
            first.run_id = 'original'
            first.out = root / 'evidence'
            first.log = []
            first.cleanup_note = 'CLEARED'
            first.exchange.mkdir()
            (first.exchange / '.input-lease.json').write_text(json.dumps({
                'schema': 'terminal-mac.input-lease-flag/1',
                'owner': 'farol-smoke:original', 'deadline': 9999999999}))
            seed_synthetic_owned_lease(first)
            first.begin_effect()
            later = object.__new__(vm.Runner)
            later.machine = root
            later.effect_file = first.effect_file
            later.effect_owned = False
            later.run_id = 'later'
            later.out = root / 'later'
            later.a = SimpleNamespace(connection_proof=False)
            later.cli = lambda *a: self.fail('A later unresolved run reached the guest')
            with self.assertRaisesRegex(vm.Refused, 'UNRESOLVED_GUEST_OPERATION'):
                later.run()
            with self.assertRaisesRegex(vm.Refused, 'GUEST_SERVER_NOT_STOPPED'):
                first.finish_effect()
            self.assertTrue(first.effect_file.exists())
            first.log = ['stop']
            first.finish_effect()
            self.assertFalse(first.effect_file.exists())

    def test_drain_requires_a_fresh_confirmed_receipt_without_running_marker(self):
        runner = object.__new__(vm.Runner)
        before = {'observedAt': 100, 'receipt': 'old'}
        valid = {'runningMarker': 'absent', 'receiptMarker': 'present', 'observedAt': 300, 'quitAt': 200, 'receipt': 'new', 'running': False, 'drained': True}
        for change in ({}, {'running': True}, {'drained': False}, {'quitAt': 99}, {'quitAt': 301}, {'receipt': 'old'}):
            with patch.object(runner, 'quit_proof', return_value=dict(valid, **change)):
                if not change: runner.require_quit_drain(before)
                else:
                    with self.assertRaisesRegex(vm.Refused, 'GUEST_QUIT_DRAIN_UNCONFIRMED'):
                        runner.require_quit_drain(before)

    def test_dev_transport_probe_precedes_any_export(self):
        runner = object.__new__(vm.Runner)
        runner.prepare_stage = lambda: None
        runner.start_guest = lambda: None
        runner.phase = lambda name: (_ for _ in ()).throw(vm.Refused('probe-failed'))
        with patch.object(vm, 'export_dev_connection') as export:
            with self.assertRaisesRegex(vm.Refused, 'probe-failed'):
                runner.connect_dev()
            export.assert_not_called()

    def test_catchable_cancellation_cleans_credentials_through_main(self):
        for kind in ('keyboard', 'term'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                runner = object.__new__(vm.Runner)
                runner.stage = root / 'stage'
                runner.stage.mkdir()
                runner.out = root / 'evidence'
                runner.out.mkdir()
                runner.log = []
                runner.pending = 'import-dev'
                runner.effect_owned = False
                runner.effect_file = root / '.farol-smoke-pending.json'
                runner.run_id = 'cancelled-test'
                for name in ('dev-key', 'dev-connection.json'):
                    (runner.stage / name).write_text('synthetic-only')
                def cancel():
                    runner.begin_effect()
                    if kind == 'term': vm.signal.raise_signal(vm.signal.SIGTERM)
                    raise KeyboardInterrupt()
                runner.run = cancel
                previous = vm.signal.getsignal(vm.signal.SIGTERM)
                with patch.object(vm, 'arguments', return_value=None), patch.object(vm, 'Runner', return_value=runner), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(vm.main(), 2)
                self.assertEqual(list(runner.stage.iterdir()), [])
                self.assertTrue(runner.effect_file.exists())
                self.assertEqual(json.loads((runner.out / 'result.json').read_text())['outcome'], 'UNKNOWN')
                self.assertEqual(vm.signal.getsignal(vm.signal.SIGTERM), previous)


if __name__ == '__main__':
    unittest.main()
