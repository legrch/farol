"""Guest-written reports are read without following links. Synthetic only.

The exchange report directory is writable by the guest. A guest process can
replace `connection.json` (or any report) with a symlink to a host file, a FIFO,
a hard link or an oversized file. The host must refuse those instead of copying
host bytes into evidence. No VM, guest or account is involved.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import unittest.mock

spec = importlib.util.spec_from_file_location('guest_report_reads_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='ReportProduct', bundleId='test.report',
                   dataLeaf='test.report', devDataLeaf='ReportDev')


def release_dev_runner(root, plant):
    """A release_dev run whose synthetic guest writes connection.json via plant()."""
    runner = object.__new__(vm.Runner)
    runner.machine = root
    runner.stage = root / 'artifacts' / 'run-synthetic'
    runner.report = root / 'report'
    runner.out = root / 'evidence'
    runner.out.mkdir()
    runner.effect_file = root / '.farol-smoke-pending.json'
    runner.effect_owned = False
    runner.pending = None
    runner.run_id = 'run-synthetic'
    runner.log = []
    runner.sequence = 0
    runner.cleanup_note = None
    runner.a = SimpleNamespace(connection_proof=False)
    def prepare():
        runner.stage.mkdir(parents=True)
        runner.report.mkdir()
    runner.prepare_stage = prepare
    runner.start_guest = lambda: None
    runner.quit_guest_app = lambda: True
    def guest(target):
        if target.name.endswith('connection-proof.result'):
            plant(runner.report / 'connection.json')
    runner.wait_result = guest
    runner.lease_evidence = lambda: {}
    return runner


class GuestReportReadTests(unittest.TestCase):
    def test_release_dev_refuses_a_symlink_to_a_host_file(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            secret = root / 'host-only-file'
            secret.write_text('{"hostOnly": "must-not-be-copied"}')
            runner = release_dev_runner(root, lambda file: file.symlink_to(secret))
            with self.assertRaisesRegex(vm.Refused, 'ASSET_FILE_INVALID'):
                runner.release_dev()
            self.assertFalse((runner.out / 'connection.json').exists())
            self.assertNotIn('must-not-be-copied', ''.join(
                p.read_text() for p in runner.out.iterdir() if p.is_file()))

    def test_release_dev_refuses_oversized_hard_linked_and_non_object_reports(self):
        cases = {
            'oversized': (lambda file: file.write_text('{"a": "' + 'x' * 5000 + '"}'), 'ASSET_FILE_INVALID'),
            'hard-link': (lambda file: (file.write_text('{}'), os.link(file, file.parent / 'second')),
                          'ASSET_FILE_INVALID'),
            'fifo': (lambda file: os.mkfifo(file), 'ASSET_FILE_INVALID'),
            'array': (lambda file: file.write_text('[]'), 'GUEST_STATE_INVALID'),
            'duplicate-key': (lambda file: file.write_text('{"a": 1, "a": 2}'), 'GUEST_STATE_INVALID'),
            'deep-nesting': (lambda file: file.write_text('[' * 2000 + ']' * 2000), 'GUEST_STATE_INVALID'),
        }
        for name, (plant, code) in cases.items():
            with self.subTest(case=name), tempfile.TemporaryDirectory() as d:
                runner = release_dev_runner(Path(d), plant)
                with self.assertRaisesRegex(vm.Refused, code):
                    runner.release_dev()
                self.assertFalse((runner.out / 'connection.json').exists())

    def test_release_dev_reserializes_an_admitted_report(self):
        with tempfile.TemporaryDirectory() as d:
            runner = release_dev_runner(Path(d), lambda file: file.write_text('{"approvedDev": false}'))
            result = runner.release_dev()
            self.assertEqual(result['status'], 'GUEST_APP_QUIT')
            self.assertEqual(json.loads((runner.out / 'connection.json').read_text()), {'approvedDev': False})
            self.assertFalse((runner.out / 'connection.json').is_symlink())

    def test_guest_state_and_quit_proof_must_be_objects(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner = release_dev_runner(root, lambda file: None)
            runner.report.mkdir()
            runner.phase = lambda name: None
            (runner.report / 'state.json').write_text('[]')
            with self.assertRaisesRegex(vm.Refused, 'GUEST_STATE_INVALID'):
                runner.state()
            (runner.report / 'quit-proof.json').write_text('"text"')
            with self.assertRaisesRegex(vm.Refused, 'GUEST_STATE_INVALID'):
                runner.quit_proof()


    def test_symlinked_parent_directory_is_never_followed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            host = root / 'host-directory'
            host.mkdir()
            (host / 'connection.json').write_text('{"hostOnly": "must-not-be-copied"}')
            def swap_parent(file):
                # The guest replaces the whole run report directory.
                report = file.parent
                for item in report.iterdir():
                    item.unlink()
                report.rmdir()
                report.symlink_to(host, target_is_directory=True)
            runner = release_dev_runner(root, swap_parent)
            with self.assertRaisesRegex(vm.Refused, 'ASSET_FILE_INVALID'):
                runner.release_dev()
            self.assertFalse((runner.out / 'connection.json').exists())

    def test_e2e_directory_swapped_between_check_and_open_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner = release_dev_runner(root, lambda file: None)
            e2e = runner.report / 'e2e'
            e2e.mkdir(parents=True)
            (e2e / 'result.json').write_text('{"guest": true}')
            host = root / 'host'
            host.mkdir()
            (host / 'result.json').write_text('{"hostOnly": "must-not-be-copied"}')
            real_open = os.open
            def swapping_open(path, flags, *args, **kwargs):
                if path == 'e2e' and e2e.is_dir() and not e2e.is_symlink():
                    # Simulate the race: swap right after any check, right before open.
                    (e2e / 'result.json').unlink()
                    e2e.rmdir()
                    e2e.symlink_to(host, target_is_directory=True)
                return real_open(path, flags, *args, **kwargs)
            with unittest.mock.patch.object(vm.os, 'open', side_effect=swapping_open):
                data, error = runner.read_e2e_file('result', 262144)
            self.assertIsNone(data)
            self.assertEqual(error, 'E2E_RESULT_UNSAFE')
            self.assertFalse(any(runner.out.iterdir()), 'no host bytes reach evidence')

    def test_phase_result_and_marker_are_bounded_and_never_block(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner = release_dev_runner(root, lambda file: None)
            runner.report.mkdir(parents=True)
            runner.deadline = vm.time.monotonic() + 30
            big = root / 'big-host-file'
            big.write_bytes(b'READY' + b' ' * 100000)
            target = runner.report / '0001-install.result'
            target.symlink_to(big)
            with self.assertRaisesRegex(vm.Refused, 'ASSET_FILE_INVALID'):
                vm.Runner.wait_result(runner, target)
            fifo = runner.report / '0002-install.result'
            os.mkfifo(fifo)
            started = vm.time.monotonic()
            with self.assertRaisesRegex(vm.Refused, 'ASSET_FILE_INVALID'):
                vm.Runner.wait_result(runner, fifo)
            self.assertLess(vm.time.monotonic() - started, 5, 'a FIFO must not block the host')
            runner.helper_update_flag_owned = True
            exchange = root / 'exchange'
            exchange.mkdir()
            marker = exchange / '.input-lease.json'
            marker.write_text(json.dumps({'schema': 'terminal-mac.input-lease-flag/1',
                                          'owner': 'farol-smoke:run-synthetic',
                                          'deadline': vm.time.time() + 600, 'pad': 'x' * 5000}))
            with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_CHANGED'):
                runner.require_own_update_marker()
            marker.unlink()
            os.mkfifo(marker)
            with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_CHANGED'):
                runner.require_own_update_marker()
            marker.unlink()
            exchange.rmdir()
            elsewhere = root / 'elsewhere'
            elsewhere.mkdir()
            (elsewhere / '.input-lease.json').write_text(json.dumps({
                'schema': 'terminal-mac.input-lease-flag/1', 'owner': 'farol-smoke:run-synthetic',
                'deadline': vm.time.time() + 600}))
            exchange.symlink_to(elsewhere, target_is_directory=True)
            with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_CHANGED'):
                runner.require_own_update_marker()

if __name__ == '__main__':
    unittest.main()
