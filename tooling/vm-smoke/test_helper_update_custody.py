"""Synthetic host-side custody tests; no VM, providers, secrets, or network."""
import importlib.util
import json
import os
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).parents[1] / 'vm-smoke.py'
spec = importlib.util.spec_from_file_location('farol_custody_runner', SOURCE)
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='SyntheticProduct', bundleId='test.product',
                   dataLeaf='test.product', devDataLeaf='SyntheticDev')


def runner(root):
    from types import SimpleNamespace
    (root / 'machines/farol/artifacts').mkdir(parents=True)
    executable = root / 'app/Contents/MacOS/terminal-mac'
    executable.parent.mkdir(parents=True)
    executable.write_text('synthetic fake, never invoked')
    (executable.parent.parent / 'Info.plist').write_bytes(__import__('plistlib').dumps(
        {'CFBundleIdentifier': 'dev.terminal-mac.host'}))
    (executable.parent.parent / 'Resources/guest-tools').mkdir(parents=True)
    args = SimpleNamespace(terminal_mac=str(executable), vm_home=str(root), vm='farol',
                           terminal_point=[100, 100], menu_point=None, timeout=180,
                           bootstrap='terminal', visible=False, connect_dev=False,
                           connection_proof=True, release_dev=False, latest=False,
                           artifact=None, prepare_test_guest=False, evidence=str(root / 'evidence'))
    return vm.Runner(args)


class GuestHelperUpdateCustodyTests(unittest.TestCase):
    def test_hardlinked_lock_does_not_change_its_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            r = runner(root)
            target = root / 'synthetic-sentinel'
            target.write_text('unchanged')
            target.chmod(0o644)
            os.link(target, r.machine / 'input-lease.lock')
            try:
                with self.assertRaisesRegex(vm.Refused, 'GUEST_INPUT_LEASE_LOCK_UNSAFE'):
                    r.acquire_input_lease()
            finally:
                if getattr(r, 'lease_fd', None) is not None:
                    r.release_input_lease()
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
            self.assertEqual(target.read_text(), 'unchanged')

    def test_symlink_and_public_lock_are_refused_without_mutation(self):
        for kind in ('symlink', 'public'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                r = runner(root)
                target = root / 'synthetic-sentinel'
                target.write_text('unchanged')
                target.chmod(0o644)
                lock = r.machine / 'input-lease.lock'
                if kind == 'symlink':
                    lock.symlink_to(target)
                else:
                    lock.write_text('public lock')
                    lock.chmod(0o644)
                with self.assertRaises((vm.Refused, OSError)):
                    r.acquire_input_lease()
                self.assertEqual(target.read_text(), 'unchanged')
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
                if kind == 'public':
                    self.assertEqual(stat.S_IMODE(lock.stat().st_mode), 0o644)
                self.assertFalse((r.machine / 'input-lease.json').exists())

    def test_first_use_and_clean_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            r.acquire_input_lease()
            flag = r.exchange / '.input-lease.json'
            self.assertEqual(json.loads(flag.read_text())['owner'], 'farol-smoke:' + r.run_id)
            r.release_input_lease()
            self.assertFalse(flag.exists(), 'clean read-only release removes only its own marker')

    def test_expired_malformed_and_symlink_markers_are_not_overwritten(self):
        variants = [b'bad-json', json.dumps({'schema': 'terminal-mac.input-lease-flag/1',
                                             'owner': 'old', 'deadline': -100}).encode()]
        for before in variants:
            with self.subTest(before=before), tempfile.TemporaryDirectory() as tmp:
                r = runner(Path(tmp)); r.exchange.mkdir()
                flag = r.exchange / '.input-lease.json'
                flag.write_bytes(before)
                with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_UNRESOLVED'):
                    r.acquire_input_lease()
                self.assertEqual(flag.read_bytes(), before, 'failed acquisition may not erase predecessor evidence')
                self.assertIsNone(r.lease_fd)
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp)); r.exchange.mkdir()
            flag = r.exchange / '.input-lease.json'
            flag.symlink_to('missing-marker')
            with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_UNRESOLVED'):
                r.acquire_input_lease()
            self.assertTrue(flag.is_symlink())

    def test_unconfirmed_operation_preserves_flag_after_flock_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp)); r.acquire_input_lease()
            r.pending = 'guest-input'
            r.release_input_lease()
            flag = r.exchange / '.input-lease.json'
            self.assertTrue(flag.exists())
            with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_UNRESOLVED'):
                r.acquire_input_lease()
            self.assertTrue(flag.exists())

    def test_durable_effect_fence_requires_complete_stop_before_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp)); r.acquire_input_lease(); r.begin_effect()
            r.log = ['install', 'stop']; r.cleanup_note = 'CLEARED'
            r.release_input_lease()
            flag = r.exchange / '.input-lease.json'
            self.assertTrue(flag.exists(), 'host flock release is not effect completion')
            self.assertTrue(r.effect_file.exists())
            r.finish_effect()
            self.assertFalse(flag.exists())
            self.assertFalse(r.effect_file.exists())

    def test_failed_or_missing_cleanup_never_clears_effect_fence_or_marker(self):
        for cleanup in (None, 'FAILED:synthetic'):
            with self.subTest(cleanup=cleanup), tempfile.TemporaryDirectory() as tmp:
                r = runner(Path(tmp)); r.acquire_input_lease(); r.begin_effect()
                r.log = ['install', 'stop']; r.cleanup_note = cleanup
                r.release_input_lease()
                with self.assertRaisesRegex(vm.Refused, 'GUEST_CLEANUP_UNCONFIRMED'):
                    r.finish_effect()
                self.assertTrue(r.effect_file.exists())
                self.assertTrue((r.exchange / '.input-lease.json').exists())

    def test_corrupt_or_foreign_marker_prevents_clean_release(self):
        for new_payload in (b'corrupt', json.dumps({'schema': 'terminal-mac.input-lease-flag/1',
                                                   'owner': 'foreign', 'deadline': 1000}).encode()):
            with self.subTest(payload=new_payload), tempfile.TemporaryDirectory() as tmp:
                r = runner(Path(tmp)); r.acquire_input_lease()
                flag = r.exchange / '.input-lease.json'; flag.write_bytes(new_payload)
                with self.assertRaises(Exception):
                    r.release_input_lease()
                self.assertEqual(flag.read_bytes(), new_payload)
                self.assertIsNone(r.lease_fd, 'host lock still released for recovery')

    def test_predecessor_marker_and_metadata_survive_refused_acquisition(self):
        # Real Runner.acquire_input_lease(), not a mocked admission decision.
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            r.exchange.mkdir()
            marker = r.exchange / '.input-lease.json'
            metadata = r.machine / 'input-lease.json'
            old_flag = b'{"schema":"terminal-mac.input-lease-flag/1","owner":"predecessor","deadline":-1}'
            old_meta = b'{"schema":"terminal-mac.input-lease/1","owner":"predecessor","generation":4,"acquiredAt":123}'
            marker.write_bytes(old_flag)
            metadata.write_bytes(old_meta)
            before = metadata.stat().st_ino
            with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_UNRESOLVED'):
                r.acquire_input_lease()
            self.assertEqual(marker.read_bytes(), old_flag)
            self.assertEqual(metadata.read_bytes(), old_meta, 'failed acquisition deleted predecessor metadata')
            self.assertEqual(metadata.stat().st_ino, before)
            self.assertIsNone(r.lease_fd)

    def test_predecessor_metadata_alone_requires_reconciliation(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            metadata = r.machine / 'input-lease.json'
            old_meta = b'{"schema":"terminal-mac.input-lease/1","owner":"previous-run","generation":7,"acquiredAt":99}'
            metadata.write_bytes(old_meta)
            with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_UNRESOLVED'):
                r.acquire_input_lease()
            self.assertEqual(metadata.read_bytes(), old_meta)
            self.assertFalse((r.exchange / '.input-lease.json').exists())
            self.assertIsNone(r.lease_fd)

    def test_uncertain_metadata_sync_retains_publication_for_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            with patch.object(r, 'sync_directory', side_effect=OSError('SYNTHETIC_METADATA_FSYNC_FAILURE')):
                with self.assertRaisesRegex(OSError, 'SYNTHETIC_METADATA_FSYNC_FAILURE'):
                    r.acquire_input_lease()
            metadata = r.machine / 'input-lease.json'
            self.assertTrue(metadata.exists(), 'an uncertain metadata publish must not be deleted')
            self.assertEqual(json.loads(metadata.read_text())['owner'], 'farol-smoke:' + r.run_id)
            self.assertFalse((r.exchange / '.input-lease.json').exists())
            self.assertIsNone(r.lease_fd)
            with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_UNRESOLVED'):
                r.acquire_input_lease()
            self.assertTrue(metadata.exists())

    def test_uncertain_marker_sync_retains_both_publications(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            original = r.sync_directory
            calls = [0]
            def inject(path):
                calls[0] += 1
                if calls[0] == 2:
                    raise OSError('SYNTHETIC_MARKER_FSYNC_FAILURE')
                return original(path)
            with patch.object(r, 'sync_directory', side_effect=inject):
                with self.assertRaisesRegex(OSError, 'SYNTHETIC_MARKER_FSYNC_FAILURE'):
                    r.acquire_input_lease()
            metadata = r.machine / 'input-lease.json'
            marker = r.exchange / '.input-lease.json'
            self.assertTrue(metadata.exists())
            self.assertTrue(marker.exists())
            self.assertEqual(json.loads(metadata.read_text())['owner'], 'farol-smoke:' + r.run_id)
            self.assertEqual(json.loads(marker.read_text())['owner'], 'farol-smoke:' + r.run_id)
            self.assertIsNone(r.lease_fd)

    def test_modified_metadata_not_removed_by_clean_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            r.acquire_input_lease()
            metadata = r.machine / 'input-lease.json'
            forged = '{"schema":"terminal-mac.input-lease/1","owner":"foreign","generation":8,"acquiredAt":17}'
            metadata.write_text(forged)
            with self.assertRaisesRegex(vm.Refused, 'GUEST_INPUT_LEASE_METADATA_CHANGED'):
                r.release_input_lease()
            self.assertEqual(metadata.read_text(), forged)
            self.assertTrue((r.exchange / '.input-lease.json').exists())
            self.assertIsNone(r.lease_fd)

    def test_unresolved_operation_preserves_both_owned_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            r.acquire_input_lease()
            r.pending = 'synthetic-unknown'
            r.release_input_lease()
            metadata = r.machine / 'input-lease.json'
            marker = r.exchange / '.input-lease.json'
            self.assertTrue(metadata.exists(), 'UNKNOWN should retain run metadata for reconciliation')
            self.assertTrue(marker.exists())
            self.assertIsNone(r.lease_fd)

    def test_reconciled_effect_removes_both_verified_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            r.acquire_input_lease()
            r.begin_effect()
            r.log = ['install', 'stop']
            r.cleanup_note = 'CLEARED'
            r.release_input_lease()
            metadata = r.machine / 'input-lease.json'
            marker = r.exchange / '.input-lease.json'
            self.assertTrue(metadata.exists(), 'retain operation metadata until proven stop')
            self.assertTrue(marker.exists())
            r.finish_effect()
            self.assertFalse(metadata.exists())
            self.assertFalse(marker.exists())
            self.assertFalse(r.effect_file.exists())

    def test_same_bytes_new_inode_is_not_run_owned_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            r.acquire_input_lease()
            metadata = r.machine / 'input-lease.json'
            original = metadata.read_bytes()
            replacement = r.machine / 'another-run-file'
            replacement.write_bytes(original)
            os.replace(replacement, metadata)
            with self.assertRaisesRegex(vm.Refused, 'GUEST_INPUT_LEASE_METADATA_CHANGED'):
                r.release_input_lease()
            self.assertEqual(metadata.read_bytes(), original)
            self.assertTrue((r.exchange / '.input-lease.json').exists())
            self.assertIsNone(r.lease_fd)

    def test_foreign_marker_arriving_during_publication_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            marker = r.exchange / '.input-lease.json'
            old_payload = b'{"schema":"terminal-mac.input-lease-flag/1","owner":"arriving-owner","deadline":1}'
            # Simulates a noncooperating writer arriving after the initial
            # path checks but before the exclusive marker publication.
            original = getattr(r, 'write_durable_json_exclusive', None)
            if original is None:
                # On the old code there is no exclusive marker path at all.
                with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_UNRESOLVED'):
                    r.acquire_input_lease()
                return
            def inject(path, payload):
                if path == marker:
                    marker.write_bytes(old_payload)
                return original(path, payload)
            with patch.object(r, 'write_durable_json_exclusive', side_effect=inject):
                with self.assertRaises(FileExistsError):
                    r.acquire_input_lease()
            self.assertEqual(marker.read_bytes(), old_payload)
            self.assertEqual(json.loads((r.machine / 'input-lease.json').read_text())['owner'],
                             'farol-smoke:' + r.run_id)
            self.assertIsNone(r.lease_fd)

    def test_dangling_effect_fence_does_not_clear_owned_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = runner(Path(tmp))
            r.acquire_input_lease()
            r.effect_file.symlink_to('unresolved-missing-fence-target')
            r.release_input_lease()
            self.assertTrue(r.effect_file.is_symlink())
            self.assertTrue((r.machine / 'input-lease.json').exists())
            self.assertTrue((r.exchange / '.input-lease.json').exists())
            self.assertIsNone(r.lease_fd)
