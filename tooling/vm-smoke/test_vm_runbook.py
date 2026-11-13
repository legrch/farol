"""Keep operational examples aligned with fail-closed VM route admission."""
from pathlib import Path
import unittest


class RunbookTests(unittest.TestCase):
    def test_runbook_marks_legacy_blocked_and_requires_native_digest(self):
        text = (Path(__file__).resolve().parents[2] / 'docs/development/vm-smoke.md').read_text()
        self.assertIn('Legacy Terminal workflows are BLOCKED', text)
        self.assertIn('terminal-shell-readiness/1', text)
        self.assertIn('task qa:smoke -- --native-app-service --native-relaunch', text)
        self.assertIn('--expected-app-sha256 <independently-accepted-tree-sha256>', text)
        self.assertIn('refuses with `DEV_IMPORT_UNQUALIFIED`', text)
        self.assertNotIn('one-time offline Dev import', text)
        self.assertNotIn('The runner opens the fixed system Terminal path through Go to Folder', text)

    def test_task_and_testing_contract_do_not_advertise_a_dev_import(self):
        root = Path(__file__).resolve().parents[2]
        taskfile = (root / 'Taskfile.yml').read_text()
        block = taskfile[taskfile.index('  qa:connect-dev:'):]
        block = block[:block.index('\n\n')]
        self.assertIn('BLOCKED', block)
        self.assertNotIn('Import only', block)
        testing = (root / 'docs/development/vm-testing.md').read_text()
        self.assertNotIn('one-time offline Dev import', testing)
        self.assertIn('`qa:connect-dev` is BLOCKED', testing)
