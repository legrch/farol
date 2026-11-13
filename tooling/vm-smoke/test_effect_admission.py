"""Fence admission must precede all VM work, including connection-proof.

The current connection-proof implementation performs UI/bootstrap actions;
it cannot be an exception to unresolved-operation admission.
"""
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('effect_admission_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)

class EffectAdmissionTests(unittest.TestCase):
    def test_every_mode_refuses_unresolved_effect_before_any_cli_call(self):
        for connection_proof in (False, True):
            with self.subTest(connection_proof=connection_proof), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                runner = object.__new__(vm.Runner)
                runner.machine = root
                runner.effect_file = root / '.farol-smoke-pending.json'
                runner.effect_file.write_text('{"runId":"synthetic-unknown"}')
                runner.a = SimpleNamespace(connection_proof=connection_proof, vm='synthetic')
                def forbidden_cli(*args):
                    self.fail('an unresolved operation reached VM/bootstrap/guest input')
                runner.cli = forbidden_cli
                with self.assertRaisesRegex(vm.Refused, 'UNRESOLVED_GUEST_OPERATION'):
                    runner.run()
                self.assertEqual(runner.effect_file.read_text(), '{"runId":"synthetic-unknown"}')

    def test_dangling_fence_refuses_before_custody_or_vm_commands(self):
        with tempfile.TemporaryDirectory() as d:
            runner = object.__new__(vm.Runner)
            runner.machine = Path(d)
            runner.effect_file = runner.machine / '.farol-smoke-pending.json'
            runner.effect_file.symlink_to(runner.machine / 'missing-evidence')
            runner.cli = lambda *a: self.fail('VM command reached')
            runner.acquire_input_lease = lambda: self.fail('custody published')
            with self.assertRaisesRegex(vm.Refused, 'UNRESOLVED_GUEST_OPERATION'):
                runner.run()
            self.assertTrue(runner.effect_file.is_symlink())

    def test_absent_gui_requires_classified_marker_absence(self):
        for running, receipt in [('unconfirmed', 'absent'), ('absent', 'unconfirmed'), (None, None)]:
            with self.subTest(running=running, receipt=receipt):
                runner = object.__new__(vm.Runner)
                runner.state = lambda: {'pids': [], 'windows': 0}
                runner.quit_proof = lambda: {'running': False, 'receipt': None,
                    'runningMarker': running, 'receiptMarker': receipt}
                runner.phase = lambda *a: self.fail('effect reached')
                with self.assertRaisesRegex(vm.Refused, 'GUEST_QUIT_DRAIN_UNCONFIRMED'):
                    runner.quit_guest_app()

if __name__ == '__main__':
    unittest.main()
