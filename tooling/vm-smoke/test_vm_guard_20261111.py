"""Isolated November 11 policy regressions: no VM, network, or host subprocess.

All guest actions are in-memory stubs and deliberately cannot publish events.
"""
import importlib.util
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location(
    "vm_policy_20261111", Path(__file__).parents[1] / "vm-smoke.py"
)
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)

FOCUS = {"terminalFocusContract": "terminal-input/2",
         "terminalLaunchContract": "terminal-launch/1",
         "shellReadiness": "not-proven"}
READY_CONTRACT = dict(FOCUS, terminalShellReadinessContract="terminal-shell-readiness/1")
TOKEN = "00000000-0000-4000-8000-000000000001"


class ClosedFailureCodes(unittest.TestCase):
    def test_uppercase_private_text_is_not_a_code(self):
        for value in ("SYNTHETIC_PRIVATE_TOKEN_12345678", "PASSWORD_1234",
                      "UNEXPECTED_ACCOUNT_IDENTIFIER", "PRIVATE_PATH_ABC"):
            with self.subTest(value=value):
                self.assertEqual(vm.safe_failure_code(vm.Refused(value)), "UNCLASSIFIED")
                runner = object.__new__(vm.Runner)
                runner.run_id = "run-" + "a" * 32
                runner.pending = "bootstrap:server-command"
                runner.out = None
                runner.first_failure = None
                runner.record_first_failure(value)
                self.assertEqual(runner.first_failure["reason"], "UNCLASSIFIED")
                self.assertNotIn(value, str(runner.first_failure))

    def test_known_reason_and_bounded_dynamic_prefix(self):
        self.assertEqual(vm.safe_failure_code(vm.Refused("TERMINAL_FOCUS_UNVERIFIED")),
                         "TERMINAL_FOCUS_UNVERIFIED")
        self.assertEqual(vm.safe_failure_code(vm.Refused("TERMINAL_SHELL_READINESS_UNPROVEN")),
                         "TERMINAL_SHELL_READINESS_UNPROVEN")
        self.assertEqual(vm.safe_failure_code(
            vm.Refused("GUEST_INPUT_LEASE_HELD:SYNTHETIC_PRIVATE_TOKEN")),
            "GUEST_INPUT_LEASE_HELD")
        self.assertEqual(vm.safe_failure_code(vm.Refused("NEEDS_OWNER")), "NEEDS_OWNER")
        self.assertEqual(vm.safe_failure_code(vm.Refused("FAILED:SYNTHETIC_PRIVATE_TOKEN")),
                         "STAGING_CLEANUP_UNCONFIRMED")
        self.assertEqual(vm.safe_failure_code(vm.Refused("TOKEN_LOOKS_VALID_BUT_NOT_LISTED")),
                         "UNCLASSIFIED")

    def test_exception_args_and_output_are_never_exposed(self):
        error = subprocess.TimeoutExpired(
            ["/synthetic/private/path", "--text", "SYNTHETIC_SECRET"], 3,
            output=b"SYNTHETIC_SECRET")
        self.assertEqual(vm.safe_failure_code(error), "GUEST_CLI_TIMEOUT")
        self.assertEqual(vm.safe_failure_code(
            PermissionError("SYNTHETIC_SECRET")), "HOST_IO_UNCONFIRMED")
        self.assertEqual(vm.safe_failure_code(
            ValueError("SYNTHETIC_SECRET")), "UNCLASSIFIED")


class ReadinessStopsBeforeInput(unittest.TestCase):
    def new_runner(self, status):
        runner = object.__new__(vm.Runner)
        runner.pending = None
        runner.a = SimpleNamespace(vm="synthetic")
        runner.shell_readiness = None
        calls = []
        def action(*args):
            calls.append(args)
            self.assertEqual(args, ("status",),
                             "a missing shell readiness contract must stop before any guest effect")
            return status
        runner.action = action
        runner.begin_effect = lambda: self.fail("effect started with unproven shell")
        runner.screenshot = lambda _: self.fail("screenshot used as proof")
        return runner, calls

    def test_current_real_helper_refuses_before_terminal_launch(self):
        runner, calls = self.new_runner(FOCUS)
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_SHELL_READINESS_UNPROVEN"):
            runner.start_guest()
        self.assertEqual(runner.pending, "bootstrap:shell-readiness-capability")
        self.assertEqual(runner.shell_readiness, None)
        self.assertEqual(calls, [("status",)])

    def test_claimed_proof_without_versioned_issuer_still_refuses(self):
        unqualified = dict(FOCUS, shellReadiness="proven")
        runner, calls = self.new_runner(unqualified)
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_SHELL_READINESS_UNPROVEN"):
            runner.start_guest()
        self.assertEqual(calls, [("status",)])

    def test_future_issuer_missing_pid_window_binding_never_types(self):
        runner = object.__new__(vm.Runner)
        runner.a = SimpleNamespace(vm="synthetic")
        runner.run_id = "run-" + "b" * 32
        runner.pending = None
        effects = []
        calls = []
        replies = iter([
            READY_CONTRACT,
            {"terminalLaunchContract": "terminal-launch/1",
             "terminalFocusContract": "terminal-input/2", "terminalPID": "42",
             "shellReadiness": "not-proven"},
            dict(READY_CONTRACT, terminalPID="42", terminalForeground="true"),
            dict(READY_CONTRACT, terminalPID="42", terminalForeground="true",
                 terminalInput="true", terminalWindow=TOKEN,
                 shellReadiness="proven", terminalShellReadyPID="42",
                 terminalShellReadyWindow="00000000-0000-4000-8000-000000000002"),
        ])
        def action(*args):
            calls.append(args)
            if args[0] in ("status", "terminal-open"):
                return next(replies)
            if args[:2] == ("key", "cmd+n"):
                return {}
            self.fail("unexpected typing or Return before bound readiness")
        runner.action = action
        runner.begin_effect = lambda: effects.append("once")
        runner.screenshot = lambda _: self.fail("unverified screenshot")
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_SHELL_READINESS_UNPROVEN"):
            runner.start_guest()
        self.assertEqual(runner.pending, "bootstrap:shell-readiness")
        self.assertEqual(effects, ["once"])
        self.assertFalse(any(a[0] == "type" for a in calls))
        self.assertFalse(any(a[:2] == ("key", "return") for a in calls))


if __name__ == "__main__":
    unittest.main()
