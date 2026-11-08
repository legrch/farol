"""Legacy staging residue must block admission before any guest action.

Pre-fence failures could leave raw staging (dev-key / dev-connection.json)
inside machine/artifacts/run-*/ without any fence. Admission scans by owned
name only, never reads file contents, and deletes nothing. Synthetic only.
"""
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('staging_residue_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='ResidueProduct', bundleId='test.residue',
                   dataLeaf='test.residue', devDataLeaf='ResidueDev')


class BoundaryReached(Exception):
    pass


def synthetic_runner(root):
    runner = object.__new__(vm.Runner)
    runner.machine = root
    runner.inbox = root / 'artifacts'
    runner.inbox.mkdir(parents=True)
    runner.stage = runner.inbox / 'run-current'
    runner.out = root / 'evidence'
    runner.out.mkdir()
    runner.effect_file = root / '.farol-smoke-pending.json'
    runner.effect_owned = False
    runner.pending = None
    runner.run_id = 'run-current'
    runner.log = []
    runner.a = SimpleNamespace(vm='pilot', visible=False, connect_dev=False,
                               connection_proof=False, release_dev=False)
    def forbidden_cli(*args):
        raise AssertionError('This synthetic test must never invoke terminal-mac')
    runner.cli = forbidden_cli
    return runner


def legacy_residue(inbox, name='run-deadbeef', payload=('dev-key', 'dev-connection.json')):
    residue = inbox / name
    residue.mkdir()
    for entry in payload:
        target = residue / entry
        target.write_text('synthetic-marker-not-a-real-credential')
        target.chmod(0o600)
    return residue


class StagingResidueTests(unittest.TestCase):
    def test_legacy_raw_staging_refuses_before_any_guest_action(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            residue = legacy_residue(runner.inbox)
            with self.assertRaisesRegex(vm.Refused, 'UNRECONCILED_STAGING_RESIDUE'):
                runner.run()
            self.assertTrue((residue / 'dev-key').exists(), 'admission must not delete residue')
            self.assertTrue((residue / 'dev-connection.json').exists())
            self.assertFalse(runner.effect_file.exists(), 'no guest effect may begin past residue')

    def test_refusal_lists_directory_names_but_never_contents(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            legacy_residue(runner.inbox, 'run-aaa', ('dev-key',))
            legacy_residue(runner.inbox, 'run-zzz', ('dev-connection.json',))
            with self.assertRaises(vm.Refused) as caught:
                runner.run()
            message = str(caught.exception)
            self.assertIn('UNRECONCILED_STAGING_RESIDUE', message)
            self.assertIn('run-aaa', message)
            self.assertIn('run-zzz', message)
            self.assertNotIn('synthetic-marker-not-a-real-credential', message)

    def test_payload_free_run_directory_admits_to_status_boundary(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            stale = runner.inbox / 'run-previous'
            stale.mkdir()
            (stale / 'guest.sh').write_text('# synthetic stage script without raw payload\n')
            (stale / 'dev-key.txt').write_text('synthetic')  # not an exact owned name
            calls = []
            def boundary_cli(*args):
                calls.append(args)
                raise BoundaryReached()
            runner.cli = boundary_cli
            with self.assertRaises(BoundaryReached):
                runner.run()
            self.assertEqual(calls[0][:2], ('status', 'pilot'))

    def test_existing_fence_still_refuses_before_residue_scan(self):
        with tempfile.TemporaryDirectory() as d:
            runner = synthetic_runner(Path(d))
            legacy_residue(runner.inbox)
            runner.effect_file.write_text('{"runId":"previous"}')
            with self.assertRaisesRegex(vm.Refused, 'UNRESOLVED_GUEST_OPERATION'):
                runner.run()
            self.assertTrue((runner.inbox / 'run-deadbeef' / 'dev-key').exists())


if __name__ == '__main__':
    unittest.main()
