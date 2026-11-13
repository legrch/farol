"""guest.sh properties that can be checked off-VM. Synthetic only.

guest.sh refuses to run outside a VirtualMac, so its cleanup path guard is
exercised by evaluating the exact guard line in bash with a synthetic HOME,
and the publication/environment rules are checked on the script text.
"""
from pathlib import Path
import re
import subprocess
import unittest

GUEST = Path(__file__).with_name('guest.sh')


class GuestScriptTests(unittest.TestCase):
    def setUp(self):
        self.text = GUEST.read_text()

    def test_cleanup_guard_admits_only_the_exact_mktemp_directory(self):
        guard = next(line.strip() for line in self.text.splitlines()
                     if 'farol-vm-smoke' in line and '|| exit 74' in line)
        home = '/Users/synthetic'
        cases = {
            home + '/Library/Caches/farol-vm-smoke.Ab12Cd': True,
            home + '/Library/Caches/farol-vm-smoke./../..': False,   # '?' glob matched '/'
            home + '/Library/Caches/farol-vm-smoke.ab/cde': False,
            home + '/Library/Caches/farol-vm-smoke.Ab12Cd/x': False,
            '/tmp/farol-vm-smoke.Ab12Cd': False,
        }
        for work, admitted in cases.items():
            with self.subTest(work=work):
                result = subprocess.run(['/bin/bash', '-c', 'work="$1"; ' + guard + '; echo ADMIT', 'guard', work],
                                        env={'HOME': home, 'PATH': '/usr/bin:/bin'},
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode == 0 and 'ADMIT' in result.stdout, admitted, result)
                if not admitted:
                    self.assertEqual(result.returncode, 74)

    def test_server_ready_is_published_atomically(self):
        self.assertNotRegex(self.text, r"> \"\$report/server\.result\"\n")
        self.assertIn('mv "$report/server.result.tmp" "$report/server.result"', self.text)

    def test_driver_runs_with_a_pinned_minimal_environment(self):
        block = self.text[self.text.index('  e2e)'):]
        self.assertRegex(block, r'/usr/bin/env -i HOME="\$HOME" PATH=/usr/bin:/bin \\\n\s+VM_E2E_RESULT_DIR=')
        self.assertNotIn('export VM_E2E_RESULT_DIR', block)
        self.assertEqual(len(re.findall(r'"\$node_bin" "\$bundle"', block)), 1)

    def test_no_credential_import_phase_remains(self):
        self.assertNotIn('import-dev', self.text)


if __name__ == '__main__':
    unittest.main()
