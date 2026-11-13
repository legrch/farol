import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('vm_machine', Path(__file__).parents[1] / 'vm-machine.py')
machine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(machine)


class MachinePlanTests(unittest.TestCase):
    def spec(self):
        return dict(schema=1, name='test-vm', cpu=4, memoryGiB=4, diskGiB=64,
                    width=1280, height=800, network='nat',
                    guestBootstrap='interactive-account-and-helper-permissions')

    def test_spec_produces_argument_array_without_execution(self):
        command = machine.plan(self.spec(), Path('/tool/terminal-mac'), Path('/vm-data'), '/image.ipsw')
        self.assertEqual(command[:5], ['/tool/terminal-mac', 'create', 'test-vm', '--ipsw', '/image.ipsw'])
        self.assertNotIn('--offline', command)
        offline = self.spec()
        offline['network'] = 'offline'
        self.assertIn('--offline', machine.plan(offline, Path('/tool'), Path('/vm'), '/image'))

    def test_secret_or_unknown_spec_fields_refused(self):
        spec = self.spec()
        spec['password'] = 'not-a-credential'
        with self.assertRaisesRegex(ValueError, 'VM_SPEC_FIELDS_INVALID'):
            machine.plan(spec, Path('/tool'), Path('/vm'), None)

    def test_unsafe_name_and_resource_bounds_refused(self):
        for changes in ({'name': '../other'}, {'cpu': 0}, {'network': 'bridged'}, {'guestBootstrap': 'disable-security'}):
            spec = dict(self.spec(), **changes)
            with self.assertRaises(ValueError):
                machine.plan(spec, Path('/tool'), Path('/vm'), None)
