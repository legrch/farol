"""Typed Terminal bootstrap and sanitized diagnostics, synthetic only.

No VM, guest helper, terminal app, network, real clipboard or credentials.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "typed_bootstrap_vm", Path(__file__).parents[1] / "vm-smoke.py"
)
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)

PID = "42"
TOKEN = "00000000-0000-4000-8000-000000000001"
CURRENT_HELPER = {"terminalFocusContract": "terminal-input/2",
                  "terminalLaunchContract": "terminal-launch/1",
                  "shellReadiness": "not-proven"}
# Synthetic FUTURE issuer only. No released terminal-mac helper currently
# implements shell-prompt readiness or this separate contract.
CAPABILITY = dict(CURRENT_HELPER, terminalShellReadinessContract="terminal-shell-readiness/1")
LAUNCHED = dict(CAPABILITY, terminalPID=PID, shellReadiness="not-proven")
FOREGROUND = dict(CAPABILITY, terminalPID=PID, terminalForeground="true")
INPUT = dict(FOREGROUND, terminalInput="true", terminalWindow=TOKEN,
             shellReadiness="proven", terminalShellReadyPID=PID, terminalShellReadyWindow=TOKEN)


def scripted_runner(statuses=None, fail=None):
    runner = object.__new__(vm.Runner)
    runner.a = SimpleNamespace(vm="pilot", bootstrap="finder",
                               terminal_point=[72, 760])
    runner.run_id = "run-" + "a" * 32
    runner.report = Path("/synthetic/exchange/farol-smoke") / runner.run_id
    runner.pending = None
    runner.sequence = 19
    runner.shell_readiness = None
    calls, fences, captures = [], [], []
    answers = iter(statuses or [CAPABILITY, FOREGROUND, INPUT, INPUT])

    def action(*args):
        calls.append(args)
        if fail is not None and fail(args):
            raise vm.Refused("GUEST_ACTION_FAILED:action")
        if args[0] == "status":
            return next(answers)
        if args[0] == "terminal-open":
            return LAUNCHED
        return {}

    runner.action = action
    runner.begin_effect = lambda: fences.append("fenced")
    runner.screenshot = lambda name: captures.append(name)
    runner.wait_result = lambda target: None
    return runner, calls, fences, captures


class TypedBootstrapTests(unittest.TestCase):
    def test_synthetic_future_readiness_issuer_reaches_guarded_flow(self):
        r, calls, fences, captures = scripted_runner()
        with patch.object(vm.time, "sleep", side_effect=AssertionError("blind delay")):
            r.start_guest()
        self.assertEqual(fences, ["fenced"])
        self.assertEqual(r.pending, None)
        self.assertEqual(r.sequence, 0)
        self.assertEqual(r.shell_readiness, "REPORTED_PROVEN_NOT_NATIVE_QUALIFIED")
        self.assertEqual(captures, ["bootstrap-terminal"])
        self.assertNotIn("click", [c[0] for c in calls])
        self.assertNotIn("cmd+shift+g", str(calls))
        self.assertNotIn("cmd+o", str(calls))
        self.assertEqual(sum(c[0] == "terminal-open" for c in calls), 1)
        new = next(c for c in calls if c[:2] == ("key", "cmd+n"))
        self.assertEqual(new, ("key", "cmd+n", "--terminal-proof", "terminal-foreground/2", "--terminal-pid", PID))
        typed = next(c for c in calls if c[0] == "type")
        self.assertIn("terminal-input/2", typed)
        self.assertIn(TOKEN, typed)
        self.assertTrue(typed[1].endswith("/guest.sh' serve") or
                        typed[1].endswith("/guest.sh serve"))
        returned = next(c for c in calls if c[:2] == ("key", "return"))
        self.assertIn("terminal-input/2", returned)
        self.assertIn(TOKEN, returned)

    def test_current_helper_without_shell_readiness_contract_refuses_before_effect(self):
        r, calls, fences, captures = scripted_runner(statuses=[CURRENT_HELPER])
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_SHELL_READINESS_UNPROVEN"):
            r.start_guest()
        self.assertEqual(r.pending, "bootstrap:shell-readiness-capability")
        self.assertEqual(calls, [("status",)])
        self.assertEqual(fences, [])
        self.assertEqual(captures, [])

    def test_unbound_readiness_never_dispatches_shell_text(self):
        missing_binding = dict(INPUT, terminalShellReadyWindow="")
        r, calls, fences, _ = scripted_runner(
            statuses=[CAPABILITY, FOREGROUND, missing_binding])
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_SHELL_READINESS_UNPROVEN"):
            r.start_guest()
        self.assertEqual(r.pending, "bootstrap:shell-readiness")
        self.assertEqual(fences, ["fenced"])
        self.assertFalse(any(c[0] == "type" for c in calls))
        self.assertFalse(any(c[:2] == ("key", "return") for c in calls))

    def test_old_helper_refuses_before_launch_and_before_any_effect(self):
        r, calls, fences, captures = scripted_runner(statuses=[{"version": "0.2.0"}])
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_CAPABILITY_UNSUPPORTED"):
            r.start_guest()
        self.assertEqual(r.pending, "bootstrap:capability")
        self.assertEqual(calls, [("status",)])
        self.assertEqual(fences, [])
        self.assertEqual(captures, [])

    def test_desktop_helper_without_terminal_foreground_never_receives_input(self):
        not_front = dict(FOREGROUND, terminalForeground="false")
        r, calls, fences, _ = scripted_runner(statuses=[CAPABILITY, not_front])
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_FOCUS_UNVERIFIED"):
            r.start_guest()
        self.assertEqual(r.pending, "bootstrap:foreground-proof")
        self.assertEqual(fences, ["fenced"])
        self.assertFalse(any(c[0] == "type" for c in calls))
        self.assertFalse(any(c[:2] == ("key", "return") for c in calls))

    def test_no_terminal_input_area_stops_after_window_open(self):
        no_input = dict(INPUT, terminalInput="false", terminalWindow="")
        r, calls, _, _ = scripted_runner(statuses=[CAPABILITY, FOREGROUND, no_input])
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_FOCUS_UNVERIFIED"):
            r.start_guest()
        self.assertEqual(r.pending, "bootstrap:input-proof")
        self.assertFalse(any(c[0] == "type" for c in calls))

    def test_unconfirmed_window_creation_is_not_retried(self):
        r, calls, fences, _ = scripted_runner(
            fail=lambda a: a[:2] == ("key", "cmd+n"))
        with self.assertRaisesRegex(vm.Refused, "GUEST_ACTION_FAILED"):
            r.start_guest()
        self.assertEqual(r.pending, "bootstrap:terminal-new")
        self.assertEqual(fences, ["fenced"])
        self.assertEqual(sum(c[:2] == ("key", "cmd+n") for c in calls), 1)
        self.assertFalse(any(c[0] == "type" for c in calls))

    def test_lost_target_after_text_prevents_final_return(self):
        changed = dict(INPUT, terminalWindow="00000000-0000-4000-8000-000000000002")
        r, calls, fences, _ = scripted_runner(
            statuses=[CAPABILITY, FOREGROUND, INPUT, changed])
        with self.assertRaisesRegex(vm.Refused, "TERMINAL_FOCUS_UNVERIFIED"):
            r.start_guest()
        self.assertEqual(r.pending, "bootstrap:pre-return")
        self.assertEqual(fences, ["fenced"])
        self.assertEqual(sum(c[0] == "type" for c in calls), 1)
        self.assertFalse(any(c[:2] == ("key", "return") for c in calls))


def cli_runner(directory):
    r = object.__new__(vm.Runner)
    r.binary = Path("/synthetic/terminal-mac")
    r.env = {}
    r.remaining = lambda: 5
    r.run_id = "run-" + "c" * 32
    r.out = directory
    r.pending = "bootstrap:server-command"
    r.first_failure = None
    r.first_failure_persistence = "NOT_RUN"
    r.secondary_failures = []
    return r


class FailureProjectionTests(unittest.TestCase):
    def test_structured_error_preserves_only_known_reason(self):
        with tempfile.TemporaryDirectory() as d:
            r = cli_runner(Path(d))
            synthetic_secret = "SYNTHETIC-SENSITIVE-PAYLOAD"
            diag = {"schema": "terminal-mac.action-error/1",
                    "reason": "TERMINAL_FOCUS_UNVERIFIED", "outcome": "noEffect",
                    "phase": "dispatch"}
            response = SimpleNamespace(returncode=1, stdout=json.dumps(diag),
                                       stderr=synthetic_secret)
            with patch.object(vm.subprocess, "run", return_value=response):
                with self.assertRaisesRegex(vm.Refused, "GUEST_ACTION_FAILED:action"):
                    r.cli("action", "pilot", "terminal-type", "--text", synthetic_secret)
            self.assertEqual(r.first_failure["reason"], "TERMINAL_FOCUS_UNVERIFIED")
            self.assertEqual(r.first_failure["outcome"], "noEffect")
            self.assertEqual(r.first_failure_persistence, "DURABLE")
            text = (Path(d) / "first-failure.json").read_text()
            self.assertNotIn(synthetic_secret, text)
            self.assertNotIn("/synthetic/terminal-mac", text)

    def test_timeout_never_persists_exception_argv_or_output(self):
        with tempfile.TemporaryDirectory() as d:
            r = cli_runner(Path(d))
            error = subprocess.TimeoutExpired(["private", "synthetic-secret"], 2,
                                               output="synthetic-secret")
            with patch.object(vm.subprocess, "run", side_effect=error):
                with self.assertRaisesRegex(vm.Refused, "GUEST_CLI_TIMEOUT"):
                    r.cli("action", "pilot", "terminal-key", "return")
            self.assertEqual(r.first_failure["reason"], "GUEST_CLI_TIMEOUT")
            self.assertEqual(r.first_failure["outcome"], "UNKNOWN")
            self.assertNotIn("synthetic-secret", (Path(d) / "first-failure.json").read_text())

    def test_malformed_successful_json_is_classified_without_copying_text(self):
        with tempfile.TemporaryDirectory() as d:
            r = cli_runner(Path(d))
            with patch.object(vm.subprocess, "run",
                              return_value=SimpleNamespace(returncode=0,
                                   stdout="synthetic-private malformed json", stderr="")):
                with self.assertRaisesRegex(vm.Refused, "GUEST_CLI_REPLY_INVALID"):
                    r.cli("action", "pilot", "terminal-open")
            self.assertEqual(r.first_failure["reason"], "GUEST_CLI_REPLY_INVALID")
            self.assertNotIn("synthetic-private",
                             (Path(d) / "first-failure.json").read_text())

    def test_bad_structured_envelope_stays_unclassified(self):
        for value in ['{"schema":"terminal-mac.action-error/1","reason":[],"outcome":"noEffect","phase":"dispatch"}',
                      '{"schema":"terminal-mac.action-error/1","reason":"synthetic-secret","outcome":"noEffect","phase":"dispatch"}',
                      '{"schema":"terminal-mac.action-error/1","reason":"UNCLASSIFIED","reason":"UNCLASSIFIED","outcome":"noEffect","phase":"dispatch"}']:
            with self.subTest(value=value):
                self.assertIsNone(vm.action_failure_envelope(value))

    def test_first_failure_is_immutable_and_secondary_is_sanitized(self):
        with tempfile.TemporaryDirectory() as d:
            r = cli_runner(Path(d))
            r.record_first_failure("GUEST_CLI_TIMEOUT", "action", "terminal-type", outcome="UNKNOWN")
            first = dict(r.first_failure)
            r.record_first_failure("TERMINAL_GUARD_INVALID", "action", "terminal-key", outcome="noEffect")
            r.record_secondary_failure(PermissionError("/synthetic-secret/location"))
            self.assertEqual(r.first_failure, first)
            self.assertEqual(r.secondary_failures, ["HOST_IO_UNCONFIRMED"])
            self.assertNotIn("synthetic-secret",
                             (Path(d) / "first-failure.json").read_text())

    def test_failed_diagnostic_sync_does_not_mask_primary_failure(self):
        with tempfile.TemporaryDirectory() as d:
            r = cli_runner(Path(d))
            r.sync_directory = lambda _: (_ for _ in ()).throw(PermissionError("synthetic"))
            r.record_first_failure("GUEST_CLI_TIMEOUT", outcome="UNKNOWN")
            self.assertEqual(r.first_failure["reason"], "GUEST_CLI_TIMEOUT")
            self.assertEqual(r.first_failure_persistence, "FAILED")


if __name__ == "__main__":
    unittest.main()
