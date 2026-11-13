"""Unexpected exceptions and signals end as classified results. Synthetic only.

Exit 1 is reserved for a known test FAIL and exit 2 for BLOCKED/UNKNOWN. An
unexpected exception type (non-object guest JSON, deep nesting, a failing
process probe, an unsupported ZIP method) or a hang-up signal must not escape as
a Python traceback with exit 1 and no result.json, and an owned fence stays.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('unclassified_exits_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='ExitProduct', bundleId='test.exit', dataLeaf='test.exit', devDataLeaf='ExitDev')


def synthetic_runner(root, failure, fenced):
    runner = object.__new__(vm.Runner)
    runner.machine = root
    runner.stage = root / 'artifacts' / 'run-exit'
    runner.out = root / 'evidence'
    runner.out.mkdir()
    runner.log = []
    runner.pending = None
    runner.effect_owned = False
    runner.effect_file = root / '.farol-smoke-pending.json'
    runner.run_id = 'run-exit'
    runner.cleanup_note = None
    def run():
        if fenced:
            runner.begin_effect()
            runner.pending = 'inspect'
        raise failure
    runner.run = run
    return runner


class UnclassifiedExitTests(unittest.TestCase):
    def drive(self, failure, fenced):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d), failure, fenced)
            output = io.StringIO()
            with patch.object(vm, 'arguments', return_value=None), \
                 patch.object(vm, 'Runner', return_value=runner), \
                 contextlib.redirect_stdout(output):
                code = vm.main()
            result = json.loads((runner.out / 'result.json').read_text())
            return code, result, json.loads(output.getvalue()), runner.effect_file.exists()

    def test_unexpected_exception_types_write_a_classified_result(self):
        failures = {
            'attribute': AttributeError("'list' object has no attribute 'get'"),
            'recursion': RecursionError('maximum recursion depth exceeded'),
            'called-process': subprocess.CalledProcessError(1, ['/bin/ps']),
            'not-implemented': NotImplementedError('compression method'),
            'runtime': RuntimeError('anything else'),
        }
        for name, failure in failures.items():
            for fenced in (False, True):
                with self.subTest(failure=name, fenced=fenced):
                    code, result, printed, fence = self.drive(failure, fenced)
                    self.assertEqual(code, 2)
                    self.assertEqual(result, printed)
                    self.assertEqual(result['status'], 'BLOCKED')
                    self.assertEqual(result['reason'], 'UNCLASSIFIED')
                    self.assertNotIn(str(failure), json.dumps(result))
                    self.assertEqual(result['outcome'], 'UNKNOWN' if fenced else 'NOT_STARTED')
                    self.assertEqual(fence, fenced, 'an owned fence is kept, never cleared')

    def test_hangup_is_a_classified_cancellation(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d), None, True)
            def run():
                runner.begin_effect()
                runner.pending = 'install'
                vm.signal.raise_signal(vm.signal.SIGHUP)
            runner.run = run
            previous = vm.signal.getsignal(vm.signal.SIGHUP)
            with patch.object(vm, 'arguments', return_value=None), \
                 patch.object(vm, 'Runner', return_value=runner), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(vm.main(), 2)
            result = json.loads((runner.out / 'result.json').read_text())
            self.assertEqual(result['reason'], 'RUN_INTERRUPTED')
            self.assertEqual(result['outcome'], 'UNKNOWN')
            self.assertTrue(runner.effect_file.exists())
            self.assertEqual(vm.signal.getsignal(vm.signal.SIGHUP), previous)

    def test_failed_process_census_is_a_classified_refusal(self):
        for failure in (subprocess.CalledProcessError(1, ['/bin/ps']), OSError('ps missing'),
                        subprocess.TimeoutExpired(['/bin/ps'], 10)):
            with self.subTest(failure=type(failure).__name__), \
                 patch.object(vm.subprocess, 'check_output', side_effect=failure):
                with self.assertRaisesRegex(vm.Refused, 'HOST_PROCESS_PROBE_FAILED'):
                    vm.require_host_dev_stopped(vm.IDENTITY, Path('/synthetic-home'))

    def test_unknown_operation_dominates_a_guest_fail_receipt(self):
        self.assertEqual(vm.result_exit_code({'test': {'status': 'FAIL'},
                                              'operation': {'status': 'UNKNOWN'}}), 2)
        self.assertEqual(vm.result_exit_code({'test': {'status': 'FAIL'},
                                              'operation': {'status': 'COMPLETED'}}), 1)


if __name__ == '__main__':
    unittest.main()
