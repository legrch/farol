"""Offline spec/planning tests for the declared-guest provisioner; no VM, no binary."""
import importlib.util
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).parents[1]
spec_source = importlib.util.spec_from_file_location('vm_machine_under_test', ROOT / 'tooling/vm-machine.py')
vm_machine = importlib.util.module_from_spec(spec_source)
spec_source.loader.exec_module(vm_machine)

BASE_SPEC = {'schema': 1, 'name': 'pilot', 'cpu': 4, 'memoryGiB': 4, 'diskGiB': 64,
             'width': 1280, 'height': 800, 'network': 'nat',
             'guestBootstrap': 'interactive-account-and-helper-permissions'}


def planned(spec, binary='/bin/terminal-mac', root='/tmp/terminal-mac'):
    return vm_machine.plan(spec, binary, root, None)


class VmMachineSpecTests(unittest.TestCase):
    def test_plan_builds_the_exact_create_command(self):
        command = planned(dict(BASE_SPEC))
        self.assertEqual(command, ['/bin/terminal-mac', 'create', 'pilot', '--ipsw', 'APPLE_RESTORE_IPSW_REQUIRED',
                                   '--cpus', '4', '--memory', '4', '--disk', '64', '--width', '1280', '--height', '800'])
        self.assertEqual(planned(dict(BASE_SPEC, network='offline')), command + ['--offline'])

    def test_name_grammar_matches_the_terminal_store_limit(self):
        # The same 1-48 grammar as terminal-mac validateName; longer names would
        # pass here and fail at create, so the pre-filter must not diverge.
        self.assertEqual(planned(dict(BASE_SPEC, name='x' * 48))[2], 'x' * 48)
        with self.assertRaisesRegex(ValueError, 'VM_SPEC_IDENTITY_INVALID'):
            planned(dict(BASE_SPEC, name='x' * 49))
        for name in ('', '-lead', 'a/b', '../pilot'):
            with self.assertRaisesRegex(ValueError, 'VM_SPEC_IDENTITY_INVALID'):
                planned(dict(BASE_SPEC, name=name))

    def test_static_bounds_match_the_terminal_create_ranges(self):
        for key, ok, bad in [('diskGiB', (32, 2048), (31, 2049)),
                             ('width', (800, 3840), (799, 3841)),
                             ('height', (600, 2160), (599, 2161)),
                             ('cpu', (2, 32), (1, 33)),
                             ('memoryGiB', (2, 128), (1, 129))]:
            for value in ok:
                self.assertEqual(planned(dict(BASE_SPEC, **{key: value}))[2], BASE_SPEC['name'])
            for value in bad:
                with self.assertRaisesRegex(ValueError, 'VM_SPEC_RESOURCE_INVALID'):
                    planned(dict(BASE_SPEC, **{key: value}))

    def test_spec_fields_and_bootstrap_grammar(self):
        with self.assertRaisesRegex(ValueError, 'VM_SPEC_FIELDS_INVALID'):
            planned(dict(BASE_SPEC, extra='field'))
        with self.assertRaisesRegex(ValueError, 'VM_SPEC_BOOTSTRAP_INVALID'):
            planned(dict(BASE_SPEC, network='bridged'))
        with self.assertRaisesRegex(ValueError, 'VM_SPEC_BOOTSTRAP_INVALID'):
            planned(dict(BASE_SPEC, guestBootstrap='automatic'))

    def test_infrastructure_reads_the_private_config_and_bounds_the_root(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            settings = home / 'Library/Application Support/Example Testing'
            settings.mkdir(parents=True)
            config = settings / 'vm-smoke.json'
            config.write_text(json.dumps({'terminal_mac': str(home / 'tools/terminal-mac'),
                                          'vm_home': str(home / 'Library/Application Support/terminal-mac'),
                                          'vm': 'pilot', 'terminal_point': [1, 2], 'timeout': 180}))
            os.environ['FAROL_VM_TESTING_DIRECTORY'] = settings.name
            try:
                binary, root, resolved = vm_machine.infrastructure(home=home)
                self.assertEqual(binary, home / 'tools/terminal-mac')
                self.assertEqual(root, home / 'Library/Application Support/terminal-mac')
                self.assertEqual(resolved, settings)
            finally:
                os.environ.pop('FAROL_VM_TESTING_DIRECTORY', None)

    def test_prepared_base_defaults_and_follows_the_private_config(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            settings = home / 'Library/Application Support/Example Testing'
            settings.mkdir(parents=True)
            os.environ.pop('FAROL_VM_CONFIG', None)
            self.assertEqual(vm_machine.prepared_base(settings), 'farol-base-1')
            config = settings / 'vm-smoke.json'
            base = {'terminal_mac': str(home / 'tools/terminal-mac'),
                    'vm_home': str(home / 'Library/Application Support/terminal-mac'), 'vm': 'pilot'}
            config.write_text(json.dumps(base))
            self.assertEqual(vm_machine.prepared_base(settings), 'farol-base-1')
            config.write_text(json.dumps(dict(base, prepared_base='example-base-2')))
            self.assertEqual(vm_machine.prepared_base(settings), 'example-base-2')
            os.environ['FAROL_VM_TESTING_DIRECTORY'] = settings.name
            try:
                # The infrastructure resolver accepts the same key.
                self.assertEqual(vm_machine.infrastructure(home=home)[2], settings)
            finally:
                os.environ.pop('FAROL_VM_TESTING_DIRECTORY', None)
            for value in ['', '../base', 'x' * 49, 7, None]:
                config.write_text(json.dumps(dict(base, prepared_base=value)))
                with self.assertRaisesRegex(ValueError, 'PREPARED_BASE_INVALID'):
                    vm_machine.prepared_base(settings)

    def test_prepared_base_config_is_compatible_with_qa_parser(self):
        spec = importlib.util.spec_from_file_location('qa_config_test', ROOT / 'tooling/vm-smoke.py')
        qa = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(qa)
        qa.IDENTITY = {'name': 'Example'}
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            settings = home / 'Library/Application Support/Example Testing'
            settings.mkdir(parents=True)
            config = settings / 'vm-smoke.json'
            value = {'terminal_mac': '/synthetic/tool', 'vm_home': str(home / 'Library/Application Support/terminal-mac'),
                     'vm': 'test-vm', 'prepared_base': 'example-base-2'}
            config.write_text(json.dumps(value))
            with mock.patch.dict(os.environ, FAROL_VM_TESTING_DIRECTORY=settings.name, FAROL_VM_CONFIG=str(config)):
                self.assertEqual(vm_machine.infrastructure(home)[2], settings)
                self.assertEqual(qa.arguments(['--config', str(config), '--reconcile-staging']).vm, 'test-vm')
                for bad in (None, 7, '', '../base'):
                    config.write_text(json.dumps(dict(value, prepared_base=bad)))
                    with self.assertRaisesRegex(ValueError, 'PREPARED_BASE_INVALID'):
                        vm_machine.infrastructure(home)
                    with self.assertRaisesRegex(qa.Refused, 'PREPARED_BASE_INVALID'):
                        qa.arguments(['--config', str(config), '--reconcile-staging'])

    def test_infrastructure_refuses_roots_outside_the_terminal_mac_data_root(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            settings = home / 'Library/Application Support/Example Testing'
            settings.mkdir(parents=True)
            config = settings / 'vm-smoke.json'
            config.write_text(json.dumps({'terminal_mac': str(home / 't/terminal-mac'),
                                          'vm_home': str(home / 'farol-host-profile'),
                                          'vm': 'pilot', 'terminal_point': [1, 2]}))
            os.environ['FAROL_VM_TESTING_DIRECTORY'] = settings.name
            os.environ['FAROL_VM_CONFIG'] = str(config)
            try:
                with self.assertRaisesRegex(ValueError, 'VM_HOME_OUTSIDE_TERMINAL_MAC_ROOT'):
                    vm_machine.infrastructure(home=home)
            finally:
                os.environ.pop('FAROL_VM_TESTING_DIRECTORY', None)
                os.environ.pop('FAROL_VM_CONFIG', None)

    def test_infrastructure_refuses_alias_config_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            settings = home / 'Library/Application Support/Example Testing'
            settings.mkdir(parents=True)
            alias = home / 'elsewhere-terminal-mac'
            alias.mkdir()
            os.symlink(alias, home / 'terminal-mac-alias')
            config = settings / 'vm-smoke.json'
            config.write_text(json.dumps({'terminal_mac': str(home / 't/terminal-mac'),
                                          'vm_home': str(home / 'terminal-mac-alias'),
                                          'vm': 'pilot', 'terminal_point': [1, 2]}))
            os.environ['FAROL_VM_TESTING_DIRECTORY'] = settings.name
            os.environ['FAROL_VM_CONFIG'] = str(config)
            try:
                with self.assertRaisesRegex(ValueError, 'TESTING_DIRECTORY_ALIAS_FORBIDDEN'):
                    vm_machine.infrastructure(home=home)
            finally:
                os.environ.pop('FAROL_VM_TESTING_DIRECTORY', None)
                os.environ.pop('FAROL_VM_CONFIG', None)

    def test_root_rejects_traversal_and_ancestor_aliases_before_invocation(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            canonical = home / 'Library/Application Support/terminal-mac'
            canonical.mkdir(parents=True)
            outside = home / 'outside'
            outside.mkdir()
            (canonical / 'alias').symlink_to(outside, target_is_directory=True)
            for root in (canonical / '../product', canonical / 'alias/nested', home / 'terminal-mac/unrelated'):
                with self.subTest(root=root), mock.patch.object(vm_machine.subprocess, 'run') as invoked:
                    with self.assertRaises(ValueError):
                        vm_machine.admit_vm_root(root, home)
                    invoked.assert_not_called()
            vm_machine.admit_vm_root(canonical / 'new-store', home)

    def test_infrastructure_requires_a_single_level_testing_directory(self):
        original = os.environ.get('FAROL_VM_TESTING_DIRECTORY')
        os.environ['FAROL_VM_TESTING_DIRECTORY'] = 'nested/dir'
        try:
            with self.assertRaisesRegex(ValueError, 'TESTING_DIRECTORY_INVALID'):
                vm_machine.infrastructure()
        finally:
            if original is None:
                os.environ.pop('FAROL_VM_TESTING_DIRECTORY', None)
            else:
                os.environ['FAROL_VM_TESTING_DIRECTORY'] = original


class VmInstanceProvisioningTests(unittest.TestCase):
    BASE_RECEIPT = {'schema': 'farol.vm-base/1', 'base': 'farol-base-1', 'helper': 'READY',
                    'account': 'tester-ready', 'hardwareSha256': 'a' * 64}

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        home = Path(self.directory.name).resolve()
        self.settings = home / 'Library/Application Support/Example Testing'
        self.settings.mkdir(parents=True)
        self.root = home / 'Library/Application Support/terminal-mac'
        (self.root / 'machines/farol-base-1').mkdir(parents=True)
        (self.root / 'machines/farol-base-1/machine.json').write_text('{}')
        receipt_dir = self.settings / 'base-receipts'
        receipt_dir.mkdir()
        self.receipt_file = receipt_dir / 'farol-base-1.json'
        (self.root / 'machines/farol-base-1/hardware.bin').write_bytes(b'synthetic immutable hardware')
        self.base_receipt = dict(self.BASE_RECEIPT, **vm_machine.base_binding(self.root, 'farol-base-1', 'hardware.bin'))
        self.receipt_file.write_text(json.dumps(self.base_receipt))

    def test_fixture_admits_paths_beneath_a_symlinked_temp_prefix(self):
        alias = self.settings.parents[2] / 'temp-alias'
        alias.symlink_to(self.settings.parents[2], target_is_directory=True)
        temporary_directory = tempfile.TemporaryDirectory
        with mock.patch.object(tempfile, 'TemporaryDirectory',
                               side_effect=lambda: temporary_directory(dir=alias)):
            fixture = VmInstanceProvisioningTests()
            try:
                fixture.setUp()
                self.assertEqual(fixture.root, fixture.root.resolve(strict=True))
                fixture.planned()
            finally:
                fixture.doCleanups()

    def planned(self, name='farol-test-1', base='farol-base-1'):
        return vm_machine.plan_instance(name, base, '/bin/terminal-mac', self.root, self.settings)

    def test_unknown_clone_is_retained_and_subsequent_provision_is_refused(self):
        import subprocess
        binary = self.root / 'fake-tool'
        binary.write_text('not executed')
        with mock.patch('sys.argv', ['vm-machine.py', '--provision-instance', 'farol-test-1']), mock.patch.object(vm_machine, 'infrastructure', return_value=(binary, self.root, self.settings)), mock.patch.object(vm_machine.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['synthetic'], 1)) as invoked:
            with self.assertRaises(subprocess.TimeoutExpired):
                vm_machine.main()
            with self.assertRaisesRegex(ValueError, 'PROVISION_OPERATION_UNRESOLVED'):
                vm_machine.main()
            invoked.assert_called_once()

    def test_plan_builds_the_exact_clone_command_and_receipt_paths(self):
        command, receipt_file, instance_receipt = self.planned()
        self.assertEqual(command, ['/bin/terminal-mac', 'clone', 'farol-base-1', 'farol-test-1'])
        self.assertEqual(receipt_file, self.receipt_file.read_bytes())
        self.assertEqual(instance_receipt, self.settings / 'instance-receipts' / 'farol-test-1.json')

    def test_base_readiness_is_bound_to_store_machine_and_hardware(self):
        for change in ({'base': 'other-base'}, {'vmHome': str(self.root / 'other')},
                       {'storeIdentity': [0, 0]}, {'machineIdentity': [0, 0]},
                       {'machineSha256': '0'*64}, {'hardwareSha256': '0'*64},
                       {'hardwareFile': '../hardware.bin'}):
            with self.subTest(change=change):
                self.receipt_file.write_text(json.dumps(dict(self.base_receipt, **change)))
                with self.assertRaisesRegex(ValueError, 'BASE_RECEIPT_INVALID'):
                    self.planned()
        self.receipt_file.write_text(json.dumps(self.base_receipt))
        (self.root / 'machines/farol-base-1/hardware.bin').write_bytes(b'replaced hardware')
        with self.assertRaisesRegex(ValueError, 'BASE_RECEIPT_INVALID'):
            self.planned()

    def test_provenance_uses_original_accepted_receipt_bytes(self):
        _, accepted, destination = self.planned()
        self.receipt_file.write_text('{"changed":"after admission"}')
        clone = self.root / 'machines/farol-test-1'
        clone.mkdir()
        (clone / 'clone.json').write_text('{"to":"farol-test-1"}')
        vm_machine.write_instance_receipt(destination, 'farol-test-1', 'farol-base-1', accepted, self.root)
        self.assertEqual(json.loads(destination.read_text())['baseReceiptSha256'], hashlib.sha256(accepted).hexdigest())

    def test_offline_instance_plan_requests_an_offline_clone(self):
        command, _, _ = vm_machine.plan_instance('farol-test-1', 'farol-base-1',
                                                 '/bin/terminal-mac', self.root, self.settings,
                                                 offline=True)
        self.assertEqual(command, ['/bin/terminal-mac', 'clone', 'farol-base-1',
                                   'farol-test-1', '--offline'])

    def test_offline_config_requires_one_matching_disabled_network(self):
        machine = self.root / 'machines/farol-test-1'
        machine.mkdir()
        config = machine / 'machine.json'
        config.write_text('{"name":"farol-test-1","network":false}')
        vm_machine.require_offline_instance(self.root, 'farol-test-1')

        for value in ('{"name":"farol-test-1","network":true}',
                      '{"name":"farol-test-1","network":0}',
                      '{"name":"other","network":false}',
                      '{"name":"farol-test-1","network":true,"network":false}',
                      '{"name":"farol-test-1",', '[]', ''):
            with self.subTest(value=value):
                config.write_text(value)
                with self.assertRaisesRegex(ValueError, 'OFFLINE_CLONE_CONFIG_INVALID'):
                    vm_machine.require_offline_instance(self.root, 'farol-test-1')
        config.unlink()
        with self.assertRaisesRegex(ValueError, 'OFFLINE_CLONE_CONFIG_INVALID'):
            vm_machine.require_offline_instance(self.root, 'farol-test-1')

    def test_offline_config_refuses_aliases_and_fifo_without_changing_target(self):
        machine = self.root / 'machines/farol-test-1'
        machine.mkdir()
        config = machine / 'machine.json'
        target = machine / 'target.json'
        contents = '{"name":"farol-test-1","network":false}'
        target.write_text(contents)
        for kind in ('symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind):
                if kind == 'symlink':
                    config.symlink_to(target)
                elif kind == 'hardlink':
                    os.link(target, config)
                else:
                    os.mkfifo(config)
                with self.assertRaisesRegex(ValueError, 'OFFLINE_CLONE_CONFIG_INVALID'):
                    vm_machine.require_offline_instance(self.root, 'farol-test-1')
                config.unlink()
                self.assertEqual(target.read_text(), contents)

    def test_offline_flag_requires_instance_before_infrastructure_access(self):
        with mock.patch('sys.argv', ['vm-machine.py', '--offline']), \
             mock.patch.object(vm_machine, 'infrastructure') as infra, \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_status:
                vm_machine.main()
        self.assertEqual(exit_status.exception.code, 2)
        infra.assert_not_called()

    def test_offline_provision_receipt_requires_valid_cloned_config(self):
        fake = self.root / 'fake-terminal-mac'
        fake.write_text('synthetic placeholder')
        for name, network in [('offline-good', False), ('offline-bad', True)]:
            def clone(command, **kwargs):
                self.assertEqual(command, [str(fake), 'clone', 'farol-base-1', name, '--offline'])
                machine = self.root / 'machines' / name
                machine.mkdir()
                (machine / 'machine.json').write_text(json.dumps({'name': name, 'network': network}))
                (machine / 'clone.json').write_text(json.dumps({'to': name}))

            with self.subTest(name=name), \
                 mock.patch('sys.argv', ['vm-machine.py', '--provision-instance', name, '--offline']), \
                 mock.patch.object(vm_machine, 'infrastructure', return_value=(fake, self.root, self.settings)), \
                 mock.patch.object(vm_machine.subprocess, 'run', side_effect=clone), \
                 contextlib.redirect_stdout(io.StringIO()):
                receipt = self.settings / 'instance-receipts' / (name + '.json')
                if network:
                    with self.assertRaisesRegex(ValueError, 'OFFLINE_CLONE_CONFIG_INVALID'):
                        vm_machine.main()
                    self.assertFalse(receipt.exists())
                    self.assertTrue((self.root / 'machines' / name / 'machine.json').exists())
                else:
                    vm_machine.main()
                    self.assertEqual(json.loads(receipt.read_text())['name'], name)

    def test_refuses_unready_base_and_bad_names(self):
        self.receipt_file.write_text(json.dumps(dict(self.BASE_RECEIPT, helper='NOT_INSTALLED_SETUP_ASSISTANT_PENDING')))
        with self.assertRaisesRegex(ValueError, 'OWNER_BASE_NOT_READY'):
            self.planned()
        self.receipt_file.write_text(json.dumps(dict(self.BASE_RECEIPT, account='pending')))
        with self.assertRaisesRegex(ValueError, 'OWNER_BASE_NOT_READY'):
            self.planned()
        with self.assertRaisesRegex(ValueError, 'VM_SPEC_IDENTITY_INVALID'):
            self.planned(name='../escape')
        with self.assertRaisesRegex(ValueError, 'INSTANCE_IDENTITY_INVALID'):
            self.planned(name='farol-base-1')
        self.receipt_file.unlink()
        with self.assertRaisesRegex(ValueError, 'BASE_RECEIPT_MISSING'):
            self.planned()

    def test_refuses_missing_base_machine_and_collisions(self):
        for child in (self.root / 'machines/farol-base-1').iterdir():
            child.unlink()
        (self.root / 'machines/farol-base-1').rmdir()
        with self.assertRaisesRegex(ValueError, 'BASE_MACHINE_MISSING'):
            self.planned()
        (self.root / 'machines/farol-base-1').mkdir()
        (self.root / 'machines/farol-base-1/machine.json').write_text('{}')
        (self.root / 'machines/farol-base-1/hardware.bin').write_bytes(b'synthetic immutable hardware')
        self.receipt_file.write_text(json.dumps(dict(self.BASE_RECEIPT, **vm_machine.base_binding(self.root, 'farol-base-1', 'hardware.bin'))))
        (self.root / 'machines/farol-test-1').mkdir()
        with self.assertRaisesRegex(ValueError, 'INSTANCE_COLLISION_REFUSED'):
            self.planned()

    def test_execution_writes_a_durable_provenance_receipt(self):
        command, receipt_file, instance_receipt = self.planned()
        # A fake terminal-mac: records argv, materializes the clone receipt the
        # real clone command writes, and exits cleanly.
        fake = self.root / 'fake-terminal-mac'
        fake_script = (
            '#!/bin/bash\n'
            'mkdir -p "' + str(self.root) + '/machines/$3"\n'
            'printf \'{"schema":"terminal-mac.clone/1","from":"farol-base-1","to":"%s","at":1}\' "$3" '
            '> "' + str(self.root) + '/machines/$3/clone.json"\n'
            'exit 0\n'
        )
        fake.write_text(fake_script)
        fake.chmod(0o755)
        command, _, _ = self.planned()
        command[0] = str(fake)
        env = dict(os.environ, FAROL_VM_TESTING_DIRECTORY='Example Testing', FAROL_VM_CONFIG=str(self.settings / 'vm-smoke.json'))
        (self.settings / 'vm-smoke.json').write_text(json.dumps({
            'terminal_mac': str(fake), 'vm_home': str(self.root), 'vm': 'farol-test-1'}))
        import subprocess
        subprocess.run(command, env=env, check=True, timeout=30)
        vm_machine.write_instance_receipt(instance_receipt, 'farol-test-1', 'farol-base-1', receipt_file, self.root)
        receipt = json.loads(instance_receipt.read_text())
        self.assertEqual(receipt['schema'], 'farol.vm-instance/1')
        self.assertEqual(receipt['base'], 'farol-base-1')
        self.assertEqual(receipt['cloneReceipt']['to'], 'farol-test-1')
        self.assertEqual(receipt['baseReceiptSha256'], hashlib.sha256(receipt_file).hexdigest())
        self.assertFalse(list(instance_receipt.parent.glob('.*.tmp')))
        self.assertEqual(instance_receipt.stat().st_mode & 0o777, 0o600)


class ProvisionIntentTests(unittest.TestCase):
    def test_each_effect_syncs_file_and_directory_before_dispatch(self):
        for kind in ('create', 'clone', 'start'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                settings = Path(tmp).resolve() / 'settings'
                settings.mkdir(mode=0o700)
                synced = []
                actual = os.fsync
                def sync(fd):
                    info = os.fstat(fd)
                    synced.append(('directory' if __import__('stat').S_ISDIR(info.st_mode) else 'file', info.st_ino))
                    actual(fd)
                def effect(*args, **kwargs):
                    directory = vm_machine.operation_directory(settings, 'synthetic')
                    intent = directory / (kind + '-intent.json')
                    self.assertEqual(json.loads(intent.read_text())['status'], 'unreconciled')
                    self.assertIn(('file', intent.stat().st_ino), synced)
                    self.assertEqual(synced[-1], ('directory', directory.stat().st_ino))
                with mock.patch.object(vm_machine.os, 'fsync', side_effect=sync), mock.patch.object(vm_machine.subprocess, 'run', side_effect=effect) as invoked:
                    vm_machine.provision_effect(['/synthetic/tool', kind, 'synthetic'], settings, 'synthetic', kind, {}, 1)
                    invoked.assert_called_once()
                with self.assertRaisesRegex(ValueError, 'PROVISION_OPERATION_UNRESOLVED'):
                    vm_machine.require_no_operations(settings, 'synthetic')
                self.assertEqual(vm_machine.reconcile_operations(settings, 'synthetic')['status'], 'UNRESOLVED')
                self.assertTrue(intent_exists(settings, kind))

    def test_sync_failure_never_reaches_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Path(tmp).resolve()
            with mock.patch.object(vm_machine.os, 'fsync', side_effect=OSError('synthetic sync failure')), mock.patch.object(vm_machine.subprocess, 'run') as invoked:
                with self.assertRaises(OSError):
                    vm_machine.provision_effect(['/synthetic/tool'], settings, 'synthetic', 'start', {}, 1)
                invoked.assert_not_called()

    def test_unknown_create_and_start_are_not_replayed_by_setup(self):
        import plistlib
        import subprocess
        for kind in ('create', 'start'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp).resolve()
                settings = home / 'settings'
                settings.mkdir(mode=0o700)
                root = home / 'terminal-mac'
                binary = home / 'Tool.app/Contents/MacOS/terminal-mac'
                binary.parent.mkdir(parents=True)
                binary.write_text('never executed')
                (binary.parent.parent / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'dev.terminal-mac.host'}))
                spec = home / 'spec.json'
                spec.write_text(json.dumps(BASE_SPEC))
                ipsw = home / 'restore.ipsw'
                ipsw.write_bytes(b'synthetic')
                if kind == 'start':
                    machine = root / 'machines/pilot'
                    machine.mkdir(parents=True)
                    (machine / 'machine.json').write_text(json.dumps(dict(BASE_SPEC, network=True)))
                with mock.patch('sys.argv', ['vm-machine.py', '--spec', str(spec), '--ipsw', str(ipsw)]), mock.patch.object(vm_machine, 'infrastructure', return_value=(binary, root, settings)), mock.patch.object(vm_machine.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['synthetic'], 1)) as invoked:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        vm_machine.main()
                    invoked.assert_called_once()
                    with self.assertRaisesRegex(ValueError, 'PROVISION_OPERATION_UNRESOLVED'):
                        vm_machine.main()
                    invoked.assert_called_once()


def intent_exists(settings, kind):
    return (vm_machine.operation_directory(settings, 'synthetic') / (kind + '-intent.json')).is_file()


if __name__ == '__main__':
    unittest.main()
