"""The smoke runner consumes the terminal-mac input lease. Offline synthetic only.

No VM, guest or terminal-mac process runs: the CLI boundary is a recording fake
and the guest ACK boundary writes synthetic result files, so the lease files on
the machine directory are the only real state under test.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('input_lease_vm', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='LeaseProduct', bundleId='test.lease',
                   dataLeaf='test.lease', devDataLeaf='LeaseDev')

PNG = b'\x89PNG\r\n\x1a\n' + b'synthetic-capture'


def build_runner(root, visible=False):
    (root / 'machines/pilot/artifacts').mkdir(parents=True)
    executable = root / 'app/Contents/MacOS/terminal-mac'
    executable.parent.mkdir(parents=True)
    executable.write_text('test')
    (executable.parent.parent / 'Info.plist').write_bytes(plistlib.dumps(dict(
        CFBundleIdentifier='dev.terminal-mac.host')))
    (executable.parent.parent / 'Resources/guest-tools').mkdir(parents=True)
    args = SimpleNamespace(
        terminal_mac=str(executable), vm_home=str(root), vm='pilot',
        terminal_point=[100, 100], menu_point=None, timeout=180,
        bootstrap='terminal', visible=visible, connect_dev=False,
        connection_proof=True, release_dev=False, latest=False, artifact=None,
        prepare_test_guest=False, evidence=str(root / 'evidence'))
    return vm.Runner(args)


def snapshot(machine):
    """Lease-relevant filesystem state at one moment of the run."""
    lock = machine / 'input-lease.lock'
    metadata = machine / 'input-lease.json'
    flag = machine / 'exchange' / '.input-lease.json'
    return {'lock': lock.exists(),
            'metadata': json.loads(metadata.read_text()) if metadata.exists() else None,
            'flag': json.loads(flag.read_text()) if flag.exists() else None}


def drive(root, visible=False, cli_fail_at=None, phase_fail_at=None):
    """Run one synthetic --connection-proof flow with a recording fake CLI.

    The fake CLI records argv plus a lease snapshot taken before the command
    runs; the synthetic guest records a snapshot at every phase ACK. An
    advancing fake clock makes refreshed flag deadlines strictly comparable.
    """
    runner = build_runner(root, visible)
    machine = runner.machine
    clock = [1000.0]

    def fake_time():
        clock[0] += 1.0
        return clock[0]

    calls, cli_timeline, phase_timeline = [], [], []

    def fake_cli(*args):
        argv = [str(a) for a in args]
        cli_timeline.append(snapshot(machine))
        calls.append(argv)
        if cli_fail_at is not None and len(calls) == cli_fail_at:
            raise vm.Refused('GUEST_ACTION_FAILED:' + argv[0])
        if argv[0] == 'status':
            return {'name': 'pilot', 'state': 'stopped'}
        if argv[0] == 'start':
            return {'name': 'pilot', 'state': 'running'}
        if argv[0] in ('show', 'hide'):
            return {}
        if argv[0] == 'action':
            if '--output' in argv:
                Path(argv[argv.index('--output') + 1]).write_bytes(PNG)
            if argv[2] == 'status':
                return {'accessibility': 'true', 'screenRecording': 'true',
                        'width': '800', 'height': '600'}
            return {}
        raise AssertionError('unexpected CLI command: ' + argv[0])

    def synthetic_guest(target):
        phase_timeline.append(snapshot(machine))
        if phase_fail_at is not None and len(phase_timeline) == phase_fail_at:
            raise vm.Refused('GUEST_PHASE_FAILED')
        if target.name == 'server.result':
            target.write_text('READY')
            return
        name = target.stem[5:]  # '0001-share-probe' -> 'share-probe'
        if name == 'inspect':
            (target.parent / 'state.json').write_text(json.dumps({'pids': [4242], 'windows': 1}))
        if name == 'connection-proof':
            (target.parent / 'connection.json').write_text(json.dumps({'approvedDev': False}))
        target.write_text('READY')

    runner.cli = fake_cli
    runner.wait_result = synthetic_guest
    result = caught = None
    with patch.object(vm.time, 'time', fake_time), patch.object(vm.time, 'sleep'):
        try:
            result = runner.run()
        except vm.Refused as error:
            caught = error
    return runner, result, caught, calls, cli_timeline, phase_timeline


def probe_lock_free(machine):
    """Succeeds only when nothing still holds the input-lease flock."""
    fd = os.open(machine / 'input-lease.lock', os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def hold_foreign_lease(machine, metadata):
    fd = os.open(machine / 'input-lease.lock', os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if metadata is not None:
        (machine / 'input-lease.json').write_text(metadata)
    return fd


class InputLeaseConsumerTests(unittest.TestCase):
    def test_happy_run_holds_refreshes_then_releases_the_lease(self):
        with tempfile.TemporaryDirectory() as d:
            runner, result, caught, calls, cli_timeline, phase_timeline = drive(Path(d))
            self.assertIsNone(caught)
            machine = runner.machine
            owner = 'farol-smoke:' + runner.run_id
            self.assertEqual(result['status'], 'LOCAL_PROOF_CAPTURED')
            self.assertEqual(result['lease'], {'owner': owner, 'generation': 1})
            self.assertEqual(json.loads((runner.out / 'result.json').read_text())['lease'],
                             {'owner': owner, 'generation': 1})
            # The lease is already held at the first lifecycle call, before any
            # VM status or start reaches the CLI.
            self.assertEqual(calls[0][:2], ['status', 'pilot'])
            first = cli_timeline[0]
            self.assertTrue(first['lock'])
            self.assertEqual(first['metadata']['schema'], 'terminal-mac.input-lease/1')
            self.assertEqual(first['metadata']['owner'], owner)
            self.assertEqual(first['metadata']['generation'], 1)
            self.assertIsInstance(first['metadata']['acquiredAt'], int)
            self.assertEqual(first['flag']['schema'], 'terminal-mac.input-lease-flag/1')
            self.assertEqual(first['flag']['owner'], owner)
            self.assertGreater(first['flag']['deadline'], first['metadata']['acquiredAt'])
            # Every phase observes the full lease and a freshly extended flag.
            deadlines = []
            for state in phase_timeline:
                self.assertTrue(state['lock'])
                self.assertEqual(state['metadata']['owner'], owner)
                self.assertEqual(state['flag']['schema'], 'terminal-mac.input-lease-flag/1')
                self.assertEqual(state['flag']['owner'], owner)
                self.assertIsInstance(state['flag']['deadline'], float)
                deadlines.append(state['flag']['deadline'])
            self.assertGreaterEqual(len(deadlines), 4)
            self.assertTrue(all(later > earlier for earlier, later in zip(deadlines, deadlines[1:])),
                            'every phase must refresh the exchange flag deadline')
            # Only the lease holder's own token rides on guest-input calls.
            for argv in calls:
                if argv[0] == 'action':
                    self.assertEqual(argv[-2:], ['--owner', owner], argv)
                else:
                    self.assertNotIn('--owner', argv, argv)
            self.assertIn(['hide', 'pilot'], calls)
            self.assertTrue(all(argv[0] != 'show' for argv in calls),
                            'a hidden run must never show the window')
            # Release cleared the published files and freed the flock.
            self.assertFalse((machine / 'input-lease.json').exists())
            self.assertFalse((machine / 'exchange' / '.input-lease.json').exists())
            probe_lock_free(machine)
            # A second acquire succeeds and republishes the same evidence.
            runner.acquire_input_lease()
            self.assertEqual(json.loads((machine / 'input-lease.json').read_text())['owner'], owner)
            self.assertEqual((machine / 'input-lease.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual((machine / 'input-lease.lock').stat().st_mode & 0o777, 0o600)
            flag = machine / 'exchange' / '.input-lease.json'
            self.assertEqual(json.loads(flag.read_text())['owner'], owner)
            self.assertEqual(flag.stat().st_mode & 0o777, 0o600)
            runner.release_input_lease()
            runner.release_input_lease()  # Release is idempotent.
            self.assertFalse((machine / 'input-lease.json').exists())
            self.assertFalse(flag.exists())
            probe_lock_free(machine)

    def test_visible_show_forwards_the_lease_owner(self):
        with tempfile.TemporaryDirectory() as d:
            runner, result, caught, calls, cli_timeline, phase_timeline = drive(Path(d), visible=True)
            self.assertIsNone(caught)
            owner = 'farol-smoke:' + runner.run_id
            self.assertIn(['show', 'pilot', '--owner', owner], calls)
            self.assertTrue(all(argv[0] != 'hide' for argv in calls))
            self.assertEqual(result['lease'], {'owner': owner, 'generation': 1})

    def test_foreign_held_lease_refuses_by_name_before_any_cli_effect(self):
        with tempfile.TemporaryDirectory() as d:
            runner = build_runner(Path(d))
            machine = runner.machine
            holder = hold_foreign_lease(machine, json.dumps(
                {'schema': 'terminal-mac.input-lease/1', 'owner': 'other-client',
                 'generation': 3, 'acquiredAt': 1}))
            try:
                calls = []
                runner.cli = lambda *args: calls.append([str(a) for a in args])
                with self.assertRaisesRegex(vm.Refused, 'GUEST_INPUT_LEASE_HELD:other-client'):
                    runner.run()
                self.assertEqual(calls, [], 'a foreign lease must be refused before any CLI call')
                self.assertEqual(runner.log, [], 'no VM start may be recorded')
                self.assertFalse((machine / 'exchange' / '.input-lease.json').exists(),
                                 'refusal must not publish the helper flag')
                self.assertEqual(json.loads((machine / 'input-lease.json').read_text())['owner'],
                                 'other-client', 'foreign metadata stays untouched')
            finally:
                fcntl.flock(holder, fcntl.LOCK_UN)
                os.close(holder)

    def test_unreadable_or_mismatched_lease_metadata_names_unknown(self):
        for garbage in ('not-json', json.dumps({'schema': 'unrelated/1', 'owner': 'ghost'}), None):
            with self.subTest(garbage=garbage), tempfile.TemporaryDirectory() as d:
                runner = build_runner(Path(d))
                machine = runner.machine
                holder = hold_foreign_lease(machine, garbage)
                before = (machine / 'input-lease.json').read_text() if garbage is not None else None
                try:
                    with self.assertRaisesRegex(vm.Refused, 'GUEST_INPUT_LEASE_HELD:unknown'):
                        runner.run()
                finally:
                    fcntl.flock(holder, fcntl.LOCK_UN)
                    os.close(holder)
                after = (machine / 'input-lease.json').read_text() if (machine / 'input-lease.json').exists() else None
                self.assertEqual(after, before, 'refusal never rewrites foreign metadata')

    def test_failed_run_releases_host_flock_but_preserves_guest_update_inhibitor(self):
        for where, kwargs in (('cli-action', dict(cli_fail_at=5)),
                              ('guest-phase', dict(phase_fail_at=3))):
            with self.subTest(where=where), tempfile.TemporaryDirectory() as d:
                runner, result, caught, calls, cli_timeline, phase_timeline = drive(Path(d), **kwargs)
                self.assertIsNone(result)
                self.assertIsInstance(caught, vm.Refused)
                self.assertRegex(str(caught), 'GUEST_(ACTION|PHASE)_FAILED')
                machine = runner.machine
                metadata = machine / 'input-lease.json'
                self.assertTrue(metadata.exists(), 'UNKNOWN preserves machine owner evidence')
                self.assertEqual(json.loads(metadata.read_text())['owner'],
                                 'farol-smoke:' + runner.run_id)
                marker = machine / 'exchange' / '.input-lease.json'
                self.assertTrue(marker.exists(), 'UNKNOWN must retain the helper-update inhibitor')
                self.assertEqual(json.loads(marker.read_text())['owner'],
                                 'farol-smoke:' + runner.run_id)
                probe_lock_free(machine)
                with self.assertRaisesRegex(vm.Refused, 'HELPER_UPDATE_CUSTODY_UNRESOLVED'):
                    runner.acquire_input_lease()  # not an automatic recovery
                self.assertTrue(marker.exists(), 'failed admission must not remove the old flag')
                probe_lock_free(machine)


if __name__ == '__main__':
    unittest.main()
