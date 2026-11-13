"""The guest Dev credential import is refused before any effect. Synthetic only.

No guest importer is qualified (tooling/vm-smoke/import-dev.js always refuses),
so `--connect-dev` / `task qa:connect-dev` must refuse before configuration is
read, before any lease, staging directory, effect fence, VM start, guest action
or host key read, and no code path may write a key into a guest-visible share.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

TOOLING = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('dev_import_refused_vm', TOOLING / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='SyntheticProduct', bundleId='test.synthetic',
                   dataLeaf='test.synthetic', devDataLeaf='SyntheticDev')


class DevImportRefusedTests(unittest.TestCase):
    def test_connect_dev_refuses_before_reading_configuration(self):
        with tempfile.TemporaryDirectory() as d:
            config = Path(d) / 'vm-smoke.json'
            config.write_text('{"terminal_mac": "/synthetic", "vm_home": "/synthetic"}')
            read = []
            original = Path.read_text
            def tracking(path, *args, **kwargs):
                read.append(path)
                return original(path, *args, **kwargs)
            with patch.object(Path, 'read_text', tracking):
                with self.assertRaisesRegex(vm.Refused, 'DEV_IMPORT_UNQUALIFIED'):
                    vm.arguments(['--connect-dev', '--config', str(config)])
            self.assertEqual(read, [], 'refusal precedes the configuration read')

    def test_main_refusal_has_zero_side_effects(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            machine = home / 'vm-home/machines/pilot'
            (machine / 'artifacts').mkdir(parents=True)
            key = home / 'Library/Application Support/SyntheticDev/farol-private/secure-mcp-connector/control-plane-api-key'
            key.parent.mkdir(parents=True)
            key.write_text('synthetic-test-key-not-a-real-secret')
            key.chmod(0o600)
            before = sorted(str(p.relative_to(home)) for p in home.rglob('*'))
            opened = []
            real_open = os.open
            def tracking_open(path, *args, **kwargs):
                opened.append(str(path))
                return real_open(path, *args, **kwargs)
            argv = ['vm-smoke.py', '--connect-dev', '--vm-home', str(home / 'vm-home'), '--vm', 'pilot',
                    '--terminal-mac', '/synthetic/terminal-mac', '--terminal-point', '1', '1',
                    '--evidence', str(home / 'evidence')]
            output = io.StringIO()
            with patch.object(vm.sys, 'argv', argv), \
                 patch.object(vm.os, 'open', tracking_open), \
                 patch.object(vm, 'Runner', side_effect=AssertionError('no runner may be constructed')), \
                 patch.object(vm.subprocess, 'run', side_effect=AssertionError('no terminal-mac call')), \
                 patch.dict(os.environ, {'HOME': str(home)}), \
                 contextlib.redirect_stdout(output):
                code = vm.main()
            self.assertEqual(code, 2)
            result = json.loads(output.getvalue())
            self.assertEqual(result['status'], 'BLOCKED')
            self.assertEqual(result['reason'], 'DEV_IMPORT_UNQUALIFIED')
            self.assertEqual(result['outcome'], 'NOT_STARTED')
            self.assertEqual(opened, [], 'no key, lease, fence or staging file is opened')
            after = sorted(str(p.relative_to(home)) for p in home.rglob('*'))
            self.assertEqual(after, before, 'no staging dir, fence, lease or evidence is created')
            self.assertNotIn('synthetic-test-key', output.getvalue())

    def test_no_code_path_reads_the_dev_key_or_writes_one_into_a_share(self):
        self.assertFalse(hasattr(vm, 'export_dev_connection'))
        self.assertFalse(hasattr(vm.Runner, 'connect_dev'))
        for name in ('vm-smoke.py', 'vm-dev-session.py', 'vm-machine.py', 'vm_app_service.py',
                     'vm-dev.mjs', 'vm-dev-artifact.mjs'):
            source = (TOOLING / name).read_text()
            with self.subTest(source=name):
                self.assertNotIn('control-plane-api-key', source)
                self.assertNotIn('secure-mcp-connector', source)
        source = (TOOLING / 'vm-smoke.py').read_text()
        # The only remaining mention is the read-only residue detector, which
        # names legacy staging by name without opening it.
        self.assertEqual(len(re.findall(r"'dev-key'", source)), 1)
        self.assertIn("for name in ('dev-key', 'dev-connection.json', 'app-payload.json')", source)
        guest = (TOOLING / 'vm-smoke' / 'guest.sh').read_text()
        self.assertNotIn('dev-key', guest)

    def test_closed_mode_never_reaches_the_import_route_either(self):
        with self.assertRaisesRegex(vm.Refused, 'DEV_IMPORT_UNQUALIFIED'):
            vm.arguments(['--connect-dev', '--closed', '--artifact', '/synthetic.zip'])


if __name__ == '__main__':
    unittest.main()
