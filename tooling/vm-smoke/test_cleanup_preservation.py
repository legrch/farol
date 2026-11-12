"""Staging cleanup failures must never mask the primary result. Synthetic only.

No guest, VM or account is involved. Raw payload bytes are synthetic and never
real credentials; results must not embed them.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup_preservation_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='CleanupProduct', bundleId='test.cleanup',
                   dataLeaf='test.cleanup', devDataLeaf='CleanupDev')




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
    # The synthetic runner skips normal lease acquisition, but the real producer
    # writes this exact marker before importing a Dev key. Model that precondition.
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


def deny_unlink(names):
    """Patch Path.unlink so the named payload entries cannot be removed."""
    original = Path.unlink
    attempts = []
    def unlink(path, *args, **kwargs):
        if path.name in names:
            attempts.append(path.name)
            raise PermissionError('synthetic-cleanup-denied')
        return original(path, *args, **kwargs)
    return unlink, attempts


class CleanupPreservationTests(unittest.TestCase):
    def test_failed_midflow_cleanup_preserves_primary_result_and_fence(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            unlink, attempts = deny_unlink({'dev-key'})
            with patch.object(vm, 'export_dev_connection', side_effect=write_synthetic_payload), \
                 patch.object(vm, 'require_host_dev_stopped'), \
                 patch.object(Path, 'unlink', new=unlink):
                result = runner.connect_dev()
            self.assertEqual(result['status'], 'NEEDS_REVIEW')
            self.assertTrue(result['cleanup'].startswith('FAILED:'))
            self.assertEqual(attempts, ['dev-key'])
            self.assertTrue((runner.stage / 'dev-key').exists())
            self.assertTrue((runner.stage / 'dev-connection.json').exists())
            self.assertTrue(runner.effect_file.exists(), 'a cleanup failure keeps the effect fence')
            self.assertNotIn('synthetic-test-key', json.dumps(result))

    def test_failed_stage_removal_is_recorded_not_raised(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            with patch.object(vm, 'export_dev_connection', side_effect=write_synthetic_payload), \
                 patch.object(vm, 'require_host_dev_stopped'), \
                 patch.object(vm.shutil, 'rmtree', side_effect=PermissionError('synthetic-stage-denied')):
                result = runner.connect_dev()
            self.assertEqual(result['status'], 'NEEDS_REVIEW')
            self.assertEqual(result['cleanup'], 'FAILED:STAGING_CLEANUP_UNCONFIRMED')
            self.assertNotIn('synthetic-stage-denied', str(result))
            self.assertTrue(runner.stage.exists())
            self.assertFalse((runner.stage / 'dev-key').exists(), 'raw payload itself is still cleared')
            self.assertFalse((runner.stage / 'dev-connection.json').exists())
            self.assertTrue(runner.effect_file.exists())

    def test_main_keeps_effect_fence_when_cleanup_failed(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            unlink, attempts = deny_unlink({'dev-key'})
            runner.run = runner.connect_dev
            with patch.object(vm, 'export_dev_connection', side_effect=write_synthetic_payload), \
                 patch.object(vm, 'require_host_dev_stopped'), \
                 patch.object(Path, 'unlink', new=unlink), \
                 patch.object(vm, 'arguments', return_value=None), \
                 patch.object(vm, 'Runner', return_value=runner), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(vm.main(), 0)
            result = json.loads((runner.out / 'result.json').read_text())
            self.assertEqual(result['status'], 'NEEDS_REVIEW')
            self.assertTrue(result['cleanup'].startswith('FAILED:'))
            self.assertTrue(runner.effect_file.exists(), 'main must not unfence a FAILED cleanup')
            self.assertEqual(attempts, ['dev-key'], 'finally must not retry a recorded disposition')

    def test_main_finishes_effect_after_cleanup_cleared(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            runner.run = runner.connect_dev
            with patch.object(vm, 'export_dev_connection', side_effect=write_synthetic_payload), \
                 patch.object(vm, 'require_host_dev_stopped'), \
                 patch.object(vm, 'arguments', return_value=None), \
                 patch.object(vm, 'Runner', return_value=runner), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(vm.main(), 0)
            result = json.loads((runner.out / 'result.json').read_text())
            self.assertEqual(result['status'], 'NEEDS_REVIEW')
            self.assertEqual(result['cleanup'], 'CLEARED')
            self.assertFalse(runner.stage.exists())
            self.assertFalse(runner.effect_file.exists())

    def test_finally_cleanup_failure_preserves_primary_reason(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            unlink, attempts = deny_unlink({'dev-key'})
            def fenced_then_refuse():
                runner.prepare_stage()
                write_synthetic_payload(runner.stage, vm.IDENTITY)
                runner.begin_effect()
                raise vm.Refused('PRIMARY_REASON')
            runner.run = fenced_then_refuse
            with patch.object(Path, 'unlink', new=unlink), \
                 patch.object(vm, 'arguments', return_value=None), \
                 patch.object(vm, 'Runner', return_value=runner), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(vm.main(), 2)
            result = json.loads((runner.out / 'result.json').read_text())
            self.assertEqual(result['status'], 'BLOCKED')
            self.assertEqual(result['reason'], 'UNCLASSIFIED')
            self.assertNotIn('PRIMARY_REASON', str(result))
            self.assertTrue(result['cleanup'].startswith('FAILED:'))
            self.assertEqual(attempts, ['dev-key'], 'the except path records; finally never retries')
            self.assertTrue((runner.stage / 'dev-key').exists())
            self.assertTrue(runner.effect_file.exists())

    def test_recorded_failed_disposition_is_never_upgraded_by_repeats(self):
        with tempfile.TemporaryDirectory() as d:
            runner = object.__new__(vm.Runner)
            runner.stage = Path(d) / 'stage'
            runner.stage.mkdir()
            (runner.stage / 'dev-key').write_text('synthetic')
            (runner.stage / 'dev-connection.json').write_text('{}')
            unlink, attempts = deny_unlink({'dev-key'})
            with patch.object(Path, 'unlink', new=unlink):
                first = runner.cleanup_disposition()
            self.assertTrue(first.startswith('FAILED:'))
            self.assertEqual(runner.cleanup_disposition(), first)
            self.assertEqual(runner.cleanup_disposition(), first)
            self.assertEqual(attempts, ['dev-key'], 'a recorded disposition never re-runs removal')
            self.assertNotEqual(runner.cleanup_note, 'CLEARED')
            self.assertTrue((runner.stage / 'dev-key').exists())

    def test_recorded_cleared_disposition_runs_removal_once(self):
        with tempfile.TemporaryDirectory() as d:
            runner = object.__new__(vm.Runner)
            runner.stage = Path(d) / 'stage'
            runner.stage.mkdir()
            (runner.stage / 'dev-key').write_text('synthetic')
            attempts = []
            original = vm.Runner.clear_dev_payload
            def counted(self_inner):
                attempts.append(1)
                original(self_inner)
            with patch.object(vm.Runner, 'clear_dev_payload', counted):
                self.assertEqual(runner.cleanup_disposition(), 'CLEARED')
                self.assertEqual(runner.cleanup_disposition(), 'CLEARED')
                self.assertEqual(runner.finish_staging(), 'CLEARED')
            self.assertEqual(attempts, [1], 'repeats must be deduped, not re-executed')
            self.assertFalse(runner.stage.exists())

    def test_failed_payload_cleanup_skips_stage_removal(self):
        with tempfile.TemporaryDirectory() as d:
            runner = object.__new__(vm.Runner)
            runner.stage = Path(d) / 'stage'
            runner.stage.mkdir()
            (runner.stage / 'dev-key').write_text('synthetic')
            (runner.stage / 'dev-connection.json').write_text('{}')
            removals = []
            original_rmtree = vm.shutil.rmtree
            def counted_rmtree(path, *args, **kwargs):
                removals.append(path)
                return original_rmtree(path, *args, **kwargs)
            unlink, _ = deny_unlink({'dev-key'})
            with patch.object(Path, 'unlink', new=unlink), \
                 patch.object(vm.shutil, 'rmtree', counted_rmtree):
                self.assertTrue(runner.finish_staging().startswith('FAILED:'))
            self.assertEqual(removals, [], 'raw-payload failure must keep staging untouched')
            self.assertTrue((runner.stage / 'dev-key').exists())
            self.assertTrue((runner.stage / 'dev-connection.json').exists())


if __name__ == '__main__':
    unittest.main()
