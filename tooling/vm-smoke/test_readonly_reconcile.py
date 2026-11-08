"""--reconcile-staging is a read-only report: names and fence metadata only.

The operation must never construct a Runner, touch the VM, take the lock,
write or delete anything, or read residue file contents. Synthetic files only.
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

spec = importlib.util.spec_from_file_location('readonly_reconcile_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='ReconcileProduct', bundleId='test.reconcile',
                   dataLeaf='test.reconcile', devDataLeaf='ReconcileDev')

MARKER = 'synthetic-key-must-never-be-read'


def build_machine(root, residue=True, fence=None):
    machine = root / 'vmhome' / 'machines' / 'pilot'
    (machine / 'artifacts').mkdir(parents=True)
    if residue:
        stage = machine / 'artifacts' / 'run-legacy'
        stage.mkdir()
        key = stage / 'dev-key'
        key.write_text(MARKER)
        key.chmod(0o000)  # Any content read would fail this operation loudly.
        (stage / 'dev-connection.json').write_text('{"schema":1,"tunnelId":"synthetic"}')
        (stage / 'guest.sh').write_text('# synthetic stage script\n')
    if fence is not None:
        (machine / '.farol-smoke-pending.json').write_text(json.dumps(fence))
    return machine


def snapshot(root):
    """Names and metadata only; no file contents are involved."""
    state = {}
    for path in sorted(root.rglob('*')):
        relative = str(path.relative_to(root))
        state[relative] = (path.is_symlink(), path.is_dir(),
                           'link' if path.is_symlink() else oct(path.stat().st_mode & 0o7777))
    return state


def reconcile(root):
    args = SimpleNamespace(reconcile_staging=True, vm_home=str(root / 'vmhome'), vm='pilot')
    out = io.StringIO()
    with patch.object(vm, 'arguments', return_value=args), contextlib.redirect_stdout(out):
        code = vm.main()
    return code, out.getvalue()


class ReconcileStagingTests(unittest.TestCase):
    def test_residue_and_fence_reported_without_reading_contents(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            evidence = str(root / 'ev')
            build_machine(root, fence={'runId': 'run-legacy', 'evidence': evidence})
            before = snapshot(root)
            code, output = reconcile(root)
            self.assertEqual(code, 0, 'exit 0 proves the unreadable key was never opened')
            report = json.loads(output)
            self.assertEqual(report['status'], 'STAGING_RESIDUE_FOUND')
            self.assertEqual(report['fence'], {'present': True, 'runId': 'run-legacy', 'evidence': evidence})
            self.assertEqual(report['residue'], [
                {'directory': 'run-legacy', 'entries': ['dev-key', 'dev-connection.json'], 'fence': True}])
            self.assertIn('manual', report['requiredAction'].lower())
            self.assertIn('clear', report['requiredAction'].lower())
            self.assertNotIn(MARKER, output)
            self.assertEqual(snapshot(root), before, 'reconcile must write and delete nothing')

    def test_clean_machine_reports_clean(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            build_machine(root, residue=False)
            before = snapshot(root)
            code, output = reconcile(root)
            self.assertEqual(code, 0)
            report = json.loads(output)
            self.assertEqual(report['status'], 'CLEAN')
            self.assertIsNone(report['fence'])
            self.assertEqual(report['residue'], [])
            self.assertIn('residue-free', report['requiredAction'])
            self.assertEqual(snapshot(root), before)

    def test_unreadable_fence_is_still_reported_present(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            build_machine(root, residue=False, fence=None)
            (root / 'vmhome/machines/pilot/.farol-smoke-pending.json').write_text('{not-json')
            code, output = reconcile(root)
            self.assertEqual(code, 0)
            report = json.loads(output)
            self.assertEqual(report['status'], 'STAGING_RESIDUE_FOUND')
            self.assertEqual(report['fence'], {'present': True, 'runId': None, 'evidence': None})

    def test_works_without_terminal_mac_binary_and_is_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            build_machine(root, residue=False)
            args = vm.arguments(['--reconcile-staging', '--vm-home', str(root / 'vmhome'), '--vm', 'pilot'])
            self.assertTrue(args.reconcile_staging)
            self.assertEqual(args.vm, 'pilot')
            with self.assertRaises(SystemExit):
                vm.arguments(['--reconcile-staging', '--latest', '--vm-home', str(root / 'vmhome'), '--vm', 'pilot'])

    def test_machine_inside_host_product_profile_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()  # Match reconcile's strict resolution (e.g. /var -> /private/var).
            protected = root / 'Library' / 'Application Support' / vm.IDENTITY['dataLeaf']
            (protected / 'machines' / 'pilot' / 'artifacts').mkdir(parents=True)
            args = SimpleNamespace(reconcile_staging=True, vm_home=str(protected), vm='pilot')
            with self.assertRaisesRegex(vm.Refused, 'HOST_PRODUCT_PROFILE_FORBIDDEN'):
                vm.reconcile_staging(args, home=root)

    def test_missing_machine_refused_without_side_effects(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            before = snapshot(root)
            args = SimpleNamespace(reconcile_staging=True, vm_home=str(root), vm='pilot')
            with self.assertRaisesRegex(vm.Refused, 'VM_MISSING'):
                vm.reconcile_staging(args, home=root)
            self.assertEqual(snapshot(root), before)


if __name__ == '__main__':
    unittest.main()
