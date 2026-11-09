"""Synthetic bootstrap checkpoints; no guest or terminal-mac process."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vm_bootstrap_check', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)


class BootstrapDiagnosticsTests(unittest.TestCase):
    def test_failed_key_keeps_exact_pending_step(self):
        for key, expected in [('cmd+o', 'bootstrap:finder-open'), ('cmd+n', 'bootstrap:terminal-new')]:
            with self.subTest(key=key):
                runner = object.__new__(vm.Runner)
                runner.a = SimpleNamespace(terminal_point=[72, 760], bootstrap='finder')
                def action(*args):
                    if args == ('key', key):
                        raise vm.Refused('GUEST_ACTION_FAILED:action')
                runner.action = action
                runner.screenshot = lambda _: None
                with patch.object(vm.time, 'sleep'), self.assertRaises(vm.Refused):
                    runner.start_guest()
                self.assertEqual(runner.pending, expected)

    def test_failed_finder_capture_keeps_capture_step(self):
        runner = object.__new__(vm.Runner)
        runner.a = SimpleNamespace(terminal_point=[72, 760], bootstrap='finder')
        runner.action = lambda *args: None
        def screenshot(label):
            if label == 'bootstrap-finder-selection':
                raise vm.Refused('GUEST_ACTION_FAILED:action')
        runner.screenshot = screenshot
        with patch.object(vm.time, 'sleep'), self.assertRaises(vm.Refused):
            runner.start_guest()
        self.assertEqual(runner.pending, 'bootstrap:finder-selection-capture')
