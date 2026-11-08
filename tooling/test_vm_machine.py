"""Offline spec/planning tests for the declared-guest provisioner; no VM, no binary."""
import importlib.util
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


if __name__ == '__main__':
    unittest.main()
