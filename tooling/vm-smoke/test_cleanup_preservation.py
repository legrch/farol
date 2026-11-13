"""Staging cleanup must never mask the primary result. Synthetic only.

No guest, VM or account is involved. Staged bytes are synthetic placeholders.
A run that never reached a guest effect removes its own staging; staging behind
an effect fence is retained evidence and reported as residue.
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
    # The synthetic runner skips normal lease acquisition, but the real run
    # writes this exact marker before any guest effect. Model that precondition.
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


def stage_synthetic_payload(runner):
    runner.prepare_stage()
    (runner.stage / 'app.zip').write_text('synthetic-archive-placeholder')
    (runner.report / 'server.result').write_text('READY')


def deny_rmtree(names):
    """Patch shutil.rmtree so the named directories cannot be removed."""
    original = vm.shutil.rmtree
    attempts = []
    def rmtree(path, *args, **kwargs):
        if Path(path).name in names:
            attempts.append(Path(path).name)
            raise PermissionError('synthetic-cleanup-denied')
        return original(path, *args, **kwargs)
    return rmtree, attempts


def fenced_success(runner):
    """A synthetic successful scenario: effect fenced, guest stopped, staged."""
    stage_synthetic_payload(runner)
    runner.phase('launch')
    runner.phase('stop')
    return dict(status='NEEDS_REVIEW', cleanup=runner.finish_staging(), phases=runner.log)


def run_main(runner, scenario):
    runner.run = lambda: scenario(runner)
    with patch.object(vm, 'arguments', return_value=None), \
         patch.object(vm, 'Runner', return_value=runner), \
         contextlib.redirect_stdout(io.StringIO()):
        code = vm.main()
    result_file = runner.out / 'result.json'
    return code, (json.loads(result_file.read_text()) if result_file.exists() else None)


class CleanupPreservationTests(unittest.TestCase):
    def test_refusal_before_any_effect_removes_this_runs_staging(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            def refuse(runner):
                stage_synthetic_payload(runner)
                raise vm.Refused('TERMINAL_SHELL_READINESS_UNPROVEN')
            code, result = run_main(runner, refuse)
            self.assertEqual(code, 2)
            self.assertEqual(result['reason'], 'TERMINAL_SHELL_READINESS_UNPROVEN')
            self.assertEqual(result['outcome'], 'NOT_STARTED')
            self.assertEqual(result['cleanup'], 'CLEARED')
            self.assertEqual(result['removedStaging'], ['artifacts/run-synthetic', 'exchange/report'])
            self.assertEqual(result['retainedStaging'], [])
            self.assertFalse(runner.stage.exists())
            self.assertFalse(runner.report.exists())
            self.assertFalse(runner.effect_file.exists())

    def test_failed_unstarted_removal_is_reported_and_keeps_primary_reason(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            rmtree, attempts = deny_rmtree({'run-synthetic'})
            def refuse(runner):
                stage_synthetic_payload(runner)
                raise vm.Refused('GUEST_PERMISSIONS_MISSING')
            with patch.object(vm.shutil, 'rmtree', new=rmtree):
                code, result = run_main(runner, refuse)
            self.assertEqual(code, 2)
            self.assertEqual(result['reason'], 'GUEST_PERMISSIONS_MISSING')
            self.assertEqual(result['cleanup'], 'FAILED:STAGING_CLEANUP_UNCONFIRMED')
            self.assertNotIn('synthetic-cleanup-denied', json.dumps(result))
            self.assertEqual(result['retainedStaging'], ['artifacts/run-synthetic', 'exchange/report'])
            self.assertEqual(attempts, ['run-synthetic'], 'finally must not retry a recorded disposition')
            self.assertTrue((runner.stage / 'app.zip').exists())

    def test_failure_after_an_effect_retains_staging_and_fence(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            def fenced_then_refuse(runner):
                stage_synthetic_payload(runner)
                runner.begin_effect()
                raise vm.Refused('GUEST_PHASE_FAILED')
            code, result = run_main(runner, fenced_then_refuse)
            self.assertEqual(code, 2)
            self.assertEqual(result['outcome'], 'UNKNOWN')
            self.assertEqual(result['cleanup'], 'CLEARED')
            self.assertEqual(result['removedStaging'], [])
            self.assertEqual(result['retainedStaging'], ['artifacts/run-synthetic', 'exchange/report'])
            self.assertTrue((runner.stage / 'app.zip').exists())
            self.assertTrue(runner.effect_file.exists())

    def test_failed_stage_removal_after_success_is_recorded_not_raised(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            with patch.object(vm.shutil, 'rmtree', side_effect=PermissionError('synthetic-stage-denied')):
                result = fenced_success(runner)
            self.assertEqual(result['status'], 'NEEDS_REVIEW')
            self.assertEqual(result['cleanup'], 'FAILED:STAGING_CLEANUP_UNCONFIRMED')
            self.assertNotIn('synthetic-stage-denied', str(result))
            self.assertTrue(runner.stage.exists())
            self.assertTrue(runner.effect_file.exists())

    def test_main_keeps_effect_fence_when_cleanup_failed(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            rmtree, attempts = deny_rmtree({'run-synthetic'})
            with patch.object(vm.shutil, 'rmtree', new=rmtree):
                code, result = run_main(runner, fenced_success)
            self.assertEqual(code, 0)
            self.assertEqual(result, None, 'the scenario itself owns result.json on success')
            self.assertTrue(runner.effect_file.exists(), 'main must not unfence a FAILED cleanup')
            self.assertEqual(runner.cleanup_note, 'FAILED:STAGING_CLEANUP_UNCONFIRMED')
            self.assertEqual(attempts, ['run-synthetic'], 'finally must not retry a recorded disposition')

    def test_main_finishes_effect_after_cleanup_cleared(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            code, _ = run_main(runner, fenced_success)
            self.assertEqual(code, 0)
            self.assertEqual(runner.cleanup_note, 'CLEARED')
            self.assertFalse(runner.stage.exists())
            self.assertFalse(runner.effect_file.exists())

    def test_recorded_failed_disposition_is_never_upgraded_by_repeats(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            stage_synthetic_payload(runner)
            rmtree, attempts = deny_rmtree({'run-synthetic'})
            with patch.object(vm.shutil, 'rmtree', new=rmtree):
                first = runner.cleanup_disposition()
                self.assertTrue(first.startswith('FAILED:'))
                self.assertEqual(runner.cleanup_disposition(), first)
                self.assertEqual(runner.finish_staging(), first)
            self.assertEqual(attempts, ['run-synthetic'], 'a recorded disposition never re-runs removal')
            self.assertTrue((runner.stage / 'app.zip').exists())

    def test_recorded_cleared_disposition_runs_removal_once(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            stage_synthetic_payload(runner)
            attempts = []
            original = vm.Runner.clear_unstarted_staging
            def counted(self_inner):
                attempts.append(1)
                return original(self_inner)
            with patch.object(vm.Runner, 'clear_unstarted_staging', counted):
                self.assertEqual(runner.cleanup_disposition(), 'CLEARED')
                self.assertEqual(runner.cleanup_disposition(), 'CLEARED')
                self.assertEqual(runner.finish_staging(), 'CLEARED')
            self.assertEqual(attempts, [1], 'repeats must be deduped, not re-executed')
            self.assertFalse(runner.stage.exists())

    def test_uninspectable_fence_keeps_unstarted_staging(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            stage_synthetic_payload(runner)
            runner.effect_file.symlink_to(Path(d) / 'missing-target')  # not provable absence
            self.assertEqual(runner.cleanup_disposition(), 'CLEARED')
            self.assertEqual(runner.staging_removed, [])
            self.assertTrue((runner.stage / 'app.zip').exists())

    def test_symlinked_stage_is_never_followed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner = synthetic_runner(root)
            outside = root / 'outside'
            outside.mkdir()
            (outside / 'keep').write_text('host bytes')
            runner.stage.parent.mkdir(parents=True)
            runner.stage.symlink_to(outside, target_is_directory=True)
            self.assertTrue(runner.cleanup_disposition().startswith('FAILED:'))
            self.assertTrue((outside / 'keep').exists())


if __name__ == '__main__':
    unittest.main()
