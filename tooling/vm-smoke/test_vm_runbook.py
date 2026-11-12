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
        self.assertIn('Dev import and endpoint handoff remain blocked', text)
        self.assertNotIn('The runner opens the fixed system Terminal path through Go to Folder', text)
