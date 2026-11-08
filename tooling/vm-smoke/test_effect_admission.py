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

if __name__ == '__main__':
    unittest.main()
