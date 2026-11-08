"""Offline spec/planning tests for the declared-guest provisioner; no VM, no binary."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

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
            home = Path(directory)
            settings = home / 'Library/Application Support/Farol Testing'
            settings.mkdir(parents=True)
            config = settings / 'vm-smoke.json'
            config.write_text(json.dumps({'terminal_mac': str(home / 'tools/terminal-mac'),
                                          'vm_home': str(settings / 'terminal-mac'),
                                          'vm': 'pilot', 'terminal_point': [1, 2], 'timeout': 180}))
            os.environ['FAROL_VM_TESTING_DIRECTORY'] = settings.name
            try:
                binary, root, resolved = vm_machine.infrastructure(home=home)
                self.assertEqual(binary, home / 'tools/terminal-mac')
                self.assertEqual(root, settings / 'terminal-mac')
                self.assertEqual(resolved, settings)
            finally:
                os.environ.pop('FAROL_VM_TESTING_DIRECTORY', None)

    def test_infrastructure_refuses_roots_outside_the_terminal_mac_data_root(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            settings = home / 'Library/Application Support/Farol Testing'
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
            home = Path(directory)
            settings = home / 'Library/Application Support/Farol Testing'
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
        home = Path(self.directory.name)
        self.settings = home / 'Library/Application Support/Farol Testing'
        self.settings.mkdir(parents=True)
        self.root = home / 'Library/Application Support/terminal-mac'
        (self.root / 'machines/farol-base-1').mkdir(parents=True)
        (self.root / 'machines/farol-base-1/machine.json').write_text('{}')
        receipt_dir = self.settings / 'base-receipts'
        receipt_dir.mkdir()
        self.receipt_file = receipt_dir / 'farol-base-1.json'
        self.receipt_file.write_text(json.dumps(self.BASE_RECEIPT))

    def planned(self, name='farol-test-1', base='farol-base-1'):
        return vm_machine.plan_instance(name, base, '/bin/terminal-mac', self.root, self.settings)

    def test_plan_builds_the_exact_clone_command_and_receipt_paths(self):
        command, receipt_file, instance_receipt = self.planned()
        self.assertEqual(command, ['/bin/terminal-mac', 'clone', 'farol-base-1', 'farol-test-1'])
        self.assertEqual(receipt_file, self.receipt_file)
        self.assertEqual(instance_receipt, self.settings / 'instance-receipts' / 'farol-test-1.json')

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
        env = dict(os.environ, FAROL_VM_TESTING_DIRECTORY='Farol Testing', FAROL_VM_CONFIG=str(self.settings / 'vm-smoke.json'))
        (self.settings / 'vm-smoke.json').write_text(json.dumps({
            'terminal_mac': str(fake), 'vm_home': str(self.root), 'vm': 'farol-test-1'}))
        import subprocess
        subprocess.run(command, env=env, check=True, timeout=30)
        vm_machine.write_instance_receipt(instance_receipt, 'farol-test-1', 'farol-base-1', receipt_file, self.root)
        receipt = json.loads(instance_receipt.read_text())
        self.assertEqual(receipt['schema'], 'farol.vm-instance/1')
        self.assertEqual(receipt['base'], 'farol-base-1')
        self.assertEqual(receipt['cloneReceipt']['to'], 'farol-test-1')
        self.assertEqual(receipt['baseReceiptSha256'], hashlib.sha256(receipt_file.read_bytes()).hexdigest())
        self.assertFalse(list(instance_receipt.parent.glob('.*.tmp')))
        self.assertEqual(instance_receipt.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
