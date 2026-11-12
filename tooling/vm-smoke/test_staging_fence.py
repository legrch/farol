"""Regression/fault tests for Dev staging. Synthetic files only; no Mac or account.

Run from the repository root: python3 -B -m unittest discover -s tooling/vm-smoke \
    -p 'test_staging_fence.py' -v
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('staging_fence_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='SyntheticProduct', bundleId='test.synthetic',
                   dataLeaf='test.synthetic', devDataLeaf='SyntheticDev')




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

def synthetic_runner(root):
    runner = object.__new__(vm.Runner)
    runner.machine = root
    runner.stage = root / 'artifacts' / 'run-synthetic'
    runner.report = root / 'report'
    runner.out = root / 'evidence'
    runner.out.mkdir()
    runner.effect_file = root / '.farol-smoke-pending.json'
    runner.effect_owned = False
    # The real run publishes the helper-update marker while holding its lease.
    # This synthetic guest runner bypasses lease acquisition, so model that
    # exact precondition without a VM or a test credential.
    runner.exchange.mkdir()
    (runner.exchange / '.input-lease.json').write_text(json.dumps({
        'schema': 'terminal-mac.input-lease-flag/1',
        'owner': 'farol-smoke:run-synthetic', 'deadline': 9999999999}))
    runner.pending = None
    runner.run_id = 'run-synthetic'
    runner.log = []
    runner.sequence = 0
    runner.a = SimpleNamespace(connection_proof=False)
    def prepare():
        runner.stage.mkdir(parents=True)
        runner.report.mkdir()
    runner.prepare_stage = prepare
    runner.start_guest = lambda: None
    runner.quit_guest_app = lambda: False  # Critical: no earlier Quit creates a fence.
    runner.wait_result = lambda target: None  # Synthetic ACK; no guest involved.
    runner.wait_state = lambda *a, **k: None
    runner.screenshot = lambda *a: None
    def forbidden_cli(*args):
        raise AssertionError('This synthetic test must never invoke terminal-mac')
    runner.cli = forbidden_cli
    seed_synthetic_owned_lease(runner)
    return runner


def write_synthetic_payload(stage, _identity):
    (stage / 'dev-key').write_text('synthetic-test-key-not-a-real-secret')
    (stage / 'dev-key').chmod(0o600)
    (stage / 'dev-connection.json').write_text('{"schema":1,"tunnelId":"synthetic"}')


class StagingFenceTests(unittest.TestCase):
    def test_stopped_guest_fence_is_durable_before_any_export(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            events = []
            real_fsync = os.fsync
            def sync(fd):
                events.append('dir-sync' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file-sync')
                real_fsync(fd)
            def export(stage, identity):
                self.assertTrue(runner.effect_owned, 'raw key reached staging before effect ownership')
                self.assertEqual(events, ['file-sync', 'dir-sync'])
                self.assertEqual(json.loads(runner.effect_file.read_text())['runId'], runner.run_id)
                self.assertEqual(runner.effect_file.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('import-dev', runner.log)
                events.append('export')
                write_synthetic_payload(stage, identity)
            with patch.object(vm.os, 'fsync', side_effect=sync), \
                 patch.object(vm, 'export_dev_connection', side_effect=export), \
                 patch.object(vm, 'require_host_dev_stopped'):
                runner.connect_dev()
                self.assertTrue(runner.effect_file.exists())
                runner.finish_effect()
            self.assertEqual(events, ['file-sync', 'dir-sync', 'export', 'dir-sync', 'dir-sync', 'dir-sync'],
                             'confirmed finish durably removes both the effect fence and update marker')
            self.assertFalse(runner.stage.exists())
            self.assertFalse(runner.effect_file.exists())

    def test_file_or_directory_sync_failure_prevents_export_and_import(self):
        for fail_directory in (False, True):
            with self.subTest(directory=fail_directory), tempfile.TemporaryDirectory() as d:
                runner = synthetic_runner(Path(d))
                real_fsync = os.fsync
                def sync(fd):
                    if stat.S_ISDIR(os.fstat(fd).st_mode) == fail_directory:
                        raise OSError('synthetic-sync-failure')
                    real_fsync(fd)
                with patch.object(vm.os, 'fsync', side_effect=sync), \
                     patch.object(vm, 'export_dev_connection') as exported, \
                     patch.object(vm, 'require_host_dev_stopped'):
                    with self.assertRaisesRegex(OSError, 'synthetic-sync-failure'):
                        runner.connect_dev()
                    exported.assert_not_called()
                self.assertFalse((runner.stage / 'dev-key').exists())
                self.assertNotIn('import-dev', runner.log)
                self.assertFalse(runner.effect_owned)
                self.assertTrue(runner.effect_file.exists())
                with self.assertRaisesRegex(vm.Refused, 'UNRESOLVED_GUEST_OPERATION'):
                    runner.begin_effect()

    def test_existing_fence_prevents_any_new_export(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            runner.effect_file.write_text('{"runId":"previous"}')
            with patch.object(vm, 'export_dev_connection') as exported, \
                 patch.object(vm, 'require_host_dev_stopped'):
                with self.assertRaisesRegex(vm.Refused, 'UNRESOLVED_GUEST_OPERATION'):
                    runner.connect_dev()
                exported.assert_not_called()
            self.assertEqual(json.loads(runner.effect_file.read_text())['runId'], 'previous')

    def test_catchable_partial_export_cleans_payload_but_keeps_fence(self):
        for failure in ('io', 'keyboard', 'term'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as d:
                runner = synthetic_runner(Path(d))
                def export(stage, identity):
                    write_synthetic_payload(stage, identity)
                    if failure == 'keyboard':
                        raise KeyboardInterrupt()
                    if failure == 'term':
                        vm.signal.raise_signal(vm.signal.SIGTERM)
                    raise OSError('synthetic-export-failure')
                runner.run = runner.connect_dev
                with patch.object(vm, 'export_dev_connection', side_effect=export), \
                     patch.object(vm, 'require_host_dev_stopped'), \
                     patch.object(vm, 'arguments', return_value=None), \
                     patch.object(vm, 'Runner', return_value=runner), \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(vm.main(), 2)
                self.assertFalse((runner.stage / 'dev-key').exists())
                self.assertFalse((runner.stage / 'dev-connection.json').exists())
                self.assertTrue(runner.effect_file.exists(), 'cleanup must not erase uncertainty')
                self.assertNotIn('import-dev', runner.log)
                result = json.loads((runner.out / 'result.json').read_text())
                self.assertEqual(result['outcome'], 'UNKNOWN')
                self.assertNotIn('synthetic-test-key', json.dumps(result))

    def test_failure_between_export_and_import_retains_fence(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            with patch.object(vm, 'export_dev_connection', side_effect=write_synthetic_payload), \
                 patch.object(vm, 'require_host_dev_stopped', side_effect=vm.Refused('HOST_DEV_STILL_RUNNING')):
                with self.assertRaisesRegex(vm.Refused, 'HOST_DEV_STILL_RUNNING'):
                    runner.connect_dev()
            self.assertTrue((runner.stage / 'dev-key').exists())
            self.assertTrue(runner.effect_file.exists())
            self.assertNotIn('import-dev', runner.log)
            runner.clear_dev_payload()  # The main handler owns this in a normal invocation.
            self.assertTrue(runner.effect_file.exists())

    def test_cleanup_failure_does_not_unfence_partial_export(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            def export(stage, identity):
                write_synthetic_payload(stage, identity)
                raise OSError('synthetic-export-failure')
            with patch.object(vm, 'export_dev_connection', side_effect=export):
                with self.assertRaisesRegex(OSError, 'synthetic-export-failure'):
                    runner.connect_dev()
            original = Path.unlink
            def unlink(path, *args, **kwargs):
                if path.name == 'dev-key':
                    raise PermissionError('synthetic-cleanup-denied')
                return original(path, *args, **kwargs)
            with patch.object(Path, 'unlink', new=unlink):
                with self.assertRaises(PermissionError):
                    runner.clear_dev_payload()
            self.assertTrue(runner.effect_file.exists())
            self.assertTrue((runner.stage / 'dev-key').exists())
            runner.clear_dev_payload()

    def test_probe_failure_never_reaches_export(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            runner.wait_result = lambda target: (_ for _ in ()).throw(vm.Refused('synthetic-probe-failure'))
            with patch.object(vm, 'export_dev_connection') as exported:
                with self.assertRaisesRegex(vm.Refused, 'synthetic-probe-failure'):
                    runner.connect_dev()
                exported.assert_not_called()
            self.assertFalse(runner.effect_file.exists())

    def test_abrupt_exit_after_export_leaves_fence_and_blocks_next_run(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            # Reuse this synthetic fixture in a child; os._exit intentionally skips finally.
            program = '''import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("synthetic_test", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
r = m.synthetic_runner(Path(sys.argv[2]))
def crash(stage, identity):
    m.write_synthetic_payload(stage, identity)
    os._exit(77)
m.vm.export_dev_connection = crash
m.vm.require_host_dev_stopped = lambda *a: None
r.connect_dev()
'''
            child = subprocess.run([sys.executable, '-B', '-c', program, __file__, str(root)],
                                   capture_output=True, text=True, timeout=5)
            self.assertEqual(child.returncode, 77, child.stderr)
            stage = root / 'artifacts/run-synthetic'
            self.assertTrue((stage / 'dev-key').exists())
            fence = root / '.farol-smoke-pending.json'
            self.assertTrue(fence.exists(), 'abrupt exit left raw staging without a durable owner fence')
            later = object.__new__(vm.Runner)
            later.machine = root
            later.effect_file = fence
            later.a = SimpleNamespace(connection_proof=False)
            later.cli = lambda *a: self.fail('unresolved previous operation reached guest')
            with self.assertRaisesRegex(vm.Refused, 'UNRESOLVED_GUEST_OPERATION'):
                later.run()
            self.assertTrue((stage / 'dev-key').exists(), 'admission must not silently delete unknown state')


if __name__ == '__main__':
    unittest.main()
