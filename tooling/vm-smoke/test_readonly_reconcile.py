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
        item = machine / '.farol-smoke-pending.json'
        item.write_text(json.dumps(fence))
        item.chmod(0o600)
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
            self.assertEqual(report['fence'], {'present': True, 'state': 'valid', 'runId': 'run-legacy'})
            self.assertNotIn(evidence, output)
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
            invalid = root / 'vmhome/machines/pilot/.farol-smoke-pending.json'
            invalid.write_text('{not-json')
            invalid.chmod(0o600)
            code, output = reconcile(root)
            self.assertEqual(code, 0)
            report = json.loads(output)
            self.assertEqual(report['status'], 'STAGING_RESIDUE_FOUND')
            self.assertEqual(report['fence'], {'present': True, 'state': 'malformed'})

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


    def test_retained_lease_and_marker_cannot_report_clean(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            machine = build_machine(root, residue=False)
            exchange = machine / 'exchange'
            exchange.mkdir()
            lease = machine / 'input-lease.json'
            lease.write_text(json.dumps({
                'schema': 'terminal-mac.input-lease/1', 'owner': 'synthetic-prior',
                'generation': 7, 'acquiredAt': 1}))
            lease.chmod(0o600)
            marker = exchange / '.input-lease.json'
            marker.write_text(json.dumps({
                'schema': 'terminal-mac.input-lease-flag/1',
                'owner': 'synthetic-prior', 'deadline': 1}))
            marker.chmod(0o600)
            before = snapshot(root)
            code, output = reconcile(root)
            self.assertEqual(code, 0)
            report = json.loads(output)
            self.assertEqual(report['status'], 'CUSTODY_UNRESOLVED')
            self.assertEqual(report['custody']['lease'], {
                'state': 'valid', 'ownerPresent': True, 'generation': 7})
            self.assertEqual(report['custody']['helperMarker'],
                             {'state': 'valid', 'expired': True})
            self.assertNotIn('synthetic-prior', output)
            self.assertEqual(snapshot(root), before)

    def test_unsafe_or_malformed_metadata_never_becomes_absent(self):
        import os
        for case in ('symlink', 'dangling', 'fifo', 'hardlink', 'malformed', 'unreadable'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                machine = build_machine(root, residue=False)
                exchange = machine / 'exchange'
                exchange.mkdir()
                item = exchange / '.input-lease.json'
                if case == 'symlink':
                    original = root / 'other.json'
                    original.write_text('{}')
                    item.symlink_to(original)
                elif case == 'dangling':
                    item.symlink_to(root / 'never-created')
                elif case == 'fifo':
                    os.mkfifo(item)
                elif case == 'hardlink':
                    original = root / 'other.json'
                    original.write_text('{}')
                    os.link(original, item)
                else:
                    item.write_text('{broken' if case == 'malformed' else '{}')
                    item.chmod(0o600 if case == 'malformed' else 0o000)
                before = snapshot(root)
                code, output = reconcile(root)
                self.assertEqual(code, 0)
                report = json.loads(output)
                self.assertEqual(report['status'], 'CUSTODY_UNRESOLVED')
                state = report['custody']['helperMarker']['state']
                self.assertNotEqual(state, 'absent')
                if case in ('symlink', 'dangling', 'fifo', 'hardlink'):
                    self.assertEqual(state, 'unsafe')
                if case == 'malformed':
                    self.assertEqual(state, 'malformed')
                self.assertEqual(snapshot(root), before)

    def test_phase_receipt_names_only_never_reads_contents(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            machine = build_machine(root, residue=False)
            receipts = machine / 'exchange' / 'farol-smoke' / ('run-' + 'a' * 32)
            receipts.mkdir(parents=True)
            (receipts / '0001-admit.result').write_text(MARKER)
            before = snapshot(root)
            code, output = reconcile(root)
            self.assertEqual(code, 0)
            report = json.loads(output)
            self.assertEqual(report['phaseReceipts'],
                             [{'runId': 'run-' + 'a' * 32,
                               'receiptNames': ['0001-admit.result']}])
            self.assertNotIn(MARKER, output)
            self.assertEqual(snapshot(root), before)

    def test_unsafe_exchange_directory_fails_closed_without_following_link(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            machine = build_machine(root, residue=False)
            external = root / 'other'
            external.mkdir()
            (machine / 'exchange').symlink_to(external)
            code, output = reconcile(root)
            self.assertEqual(code, 0)
            report = json.loads(output)
            self.assertEqual(report['status'], 'CUSTODY_UNRESOLVED')
            self.assertEqual(report['custody']['helperMarker']['state'], 'unsafe')
            self.assertEqual(report['custody']['exchangeState'], 'unsafe')


if __name__ == '__main__':
    unittest.main()
