"""guest.sh properties that can be checked off-VM. Synthetic only.

guest.sh refuses to run outside a VirtualMac, so its cleanup path guard is
exercised by evaluating the exact guard line in bash with a synthetic HOME,
and the publication/environment rules are checked on the script text.
"""
from pathlib import Path
import re
import subprocess
import tempfile
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


    def guard(self, needle):
        return next(line.strip() for line in self.text.splitlines() if needle in line and line.strip().startswith('if '))

    def run_guard(self, line, setup):
        """Run one guard line under the script's own set -Eeuo pipefail."""
        program = ('set -Eeuo pipefail\nfinish() { printf "%s" "$1" > "$out/finished"; }\n' +
                   setup + '\n' + line + '\necho PASSED\n')
        with tempfile.TemporaryDirectory() as d:
            result = subprocess.run(['/bin/bash', '-c', program, 'guard', d],
                                    env={'PATH': '/usr/bin:/bin', 'out': d},
                                    capture_output=True, text=True, timeout=5)
            finished = (Path(d) / 'finished').read_text() if (Path(d) / 'finished').exists() else None
        return result.returncode, 'PASSED' in result.stdout, finished

    def test_no_and_list_guards_remain_outside_if(self):
        for line in self.text.splitlines():
            stripped = line.strip()
            if '] && [' in stripped or ']] && [' in stripped:
                self.assertTrue(stripped.startswith('if '), stripped)

    def test_existing_e2e_receipt_is_refused_even_when_process_receipt_is_absent(self):
        line = self.guard('$result_dir/result.json')
        for planted, refused in ((None, False), ('result.json', True), ('process.json', True)):
            setup = 'result_dir="$1/e2e"; mkdir -p "$result_dir"'
            if planted:
                setup += '; : > "$result_dir/%s"' % planted
            with self.subTest(planted=planted):
                code, passed, finished = self.run_guard(line, setup)
                self.assertEqual((code, passed, finished), (78, False, 'BLOCKED') if refused else (0, True, None))

    def test_context_and_cleanup_targets_must_be_real_entries_of_the_right_type(self):
        context = self.guard('$context')
        cases = (('context="$1/ctx"; : > "$context"', False),
                 ('context="$1/ctx"; mkdir "$context"', True),
                 ('context="$1/ctx"', True),
                 (': > "$1/real"; context="$1/ctx"; ln -s "$1/real" "$context"', True))
        for setup, refused in cases:
            with self.subTest(setup=setup):
                code, passed, _ = self.run_guard(context, setup)
                self.assertEqual(passed, not refused)
        cleanup = self.guard('[ ! -d "$work" ]')
        cases = (('work="$1/w"; mkdir "$work"', False),
                 ('work="$1/w"; : > "$work"', True),            # a non-directory is refused
                 ('mkdir "$1/real"; work="$1/w"; ln -s "$1/real" "$work"', True))
        for setup, refused in cases:
            with self.subTest(setup=setup):
                code, passed, finished = self.run_guard(cleanup, setup)
                self.assertEqual(passed, not refused)
                if refused:
                    self.assertEqual((code, finished), (74, 'BLOCKED'))

    def test_serve_budget_guard_refuses_out_of_range_values(self):
        line = self.guard('$limit')
        for value, refused in (('30', False), ('600', False), ('29', True), ('601', True), ('x', True), ('', True)):
            with self.subTest(value=value):
                code, passed, _ = self.run_guard(line, 'limit="%s"' % value)
                self.assertEqual(passed, not refused)

if __name__ == '__main__':
    unittest.main()
