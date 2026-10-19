"""Original child/pipe evidence using finite disposable Python processes only."""
from pathlib import Path
import hashlib
import subprocess
import sys
import tempfile
import unittest

from bounded_capture import Capture, OutputBudget
from gate_observer import observe_command
import measure
from deadline import CommandTimeout


class BoundedOutput(unittest.TestCase):
    def exercise(self, program, limit=32768, write_error=False, timeout=3):
        with tempfile.TemporaryDirectory(prefix="testops-bounded-output-") as name:
            root = Path(name)
            stdout = (root / "stdout").open("xb")
            stderr = (root / "stderr").open("xb")
            if write_error:
                class Refusing:
                    def write(self, _):
                        raise OSError("CONTROLLED_LOG_FAILURE")
                    def close(self):
                        stdout.close()
                sink = Refusing()
            else:
                sink = stdout
            child = subprocess.Popen([sys.executable, "-c", program], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stage, budget = {}, OutputBudget(limit)
            capture = Capture(child, sink, stderr, stage, budget)
            expired = False
            try:
                capture.wait(timeout)
            except CommandTimeout:
                expired = True
            finally:
                # The finite deadline fixture is observed through this SAME
                # original handle, without a signal, lookup or replacement.
                code = child.wait()
                capture.finish_after_retirement()
                capture.close()
            return {"stage": stage, "budget": budget, "exit": code, "expired": expired,
                    "stdout": (root / "stdout").read_bytes(), "stderr": (root / "stderr").read_bytes()}

    def test_both_original_terminal_and_stdio_eof_are_observed(self):
        result = self.exercise("import os;os.write(1,b'hello');os.write(2,b'world')")
        self.assertEqual(result["exit"], 0)
        self.assertTrue(result["stage"]["terminal"])
        self.assertTrue(result["stage"]["stdioClosed"])
        self.assertEqual(result["stdout"], b"hello")
        self.assertEqual(result["stderr"], b"world")
        self.assertFalse(result["budget"].exceeded)
        self.assertEqual(result["stage"]["outputErrors"], [])
        for stream in ("stdout", "stderr"):
            self.assertEqual(result["stage"]["output"][stream]["observedSha256"], hashlib.sha256(result[stream]).hexdigest())

    def test_output_flood_drains_but_cannot_exceed_shared_retained_bytes(self):
        result = self.exercise("import os;os.write(1,b'x'*1048576);os.write(2,b'y'*1048576)")
        self.assertEqual(result["exit"], 0)
        self.assertTrue(result["budget"].exceeded)
        self.assertTrue(result["stage"]["outputTruncated"])
        self.assertEqual(len(result["stdout"]) + len(result["stderr"]), 32768)
        self.assertEqual(sum(row["observedBytes"] for row in result["stage"]["output"].values()), 2097152)
        self.assertTrue(result["stage"]["stdioClosed"])
        self.assertEqual(result["stage"]["output"]["stdout"]["observedSha256"], hashlib.sha256(b'x'*1048576).hexdigest())
        self.assertEqual(result["stage"]["output"]["stderr"]["observedSha256"], hashlib.sha256(b'y'*1048576).hexdigest())

    def test_budget_is_shared_between_successive_children(self):
        budget = OutputBudget(7)
        budget.remaining = 2
        with self.assertRaisesRegex(ValueError, "POSITIVE_OUTPUT"):
            OutputBudget(True)
        # The observer passes the same mutable budget to every capture. This
        # independent second capture must respect already consumed capacity.
        with tempfile.TemporaryDirectory(prefix="testops-shared-output-") as name:
            root = Path(name)
            child = subprocess.Popen([sys.executable, "-c", "print('abcd')"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            capture = Capture(child, (root / 'o').open('xb'), (root / 'e').open('xb'), {}, budget)
            try:
                capture.wait(3)
            finally:
                child.wait(); capture.finish_after_retirement(); capture.close()
            self.assertEqual((root / 'o').read_bytes(), b'ab')
            self.assertTrue(budget.exceeded)

    def test_persistence_error_latches_even_when_original_child_exits_zero(self):
        result = self.exercise("print('content')", write_error=True)
        self.assertEqual(result["exit"], 0)
        self.assertTrue(result["stage"]["outputErrors"])
        self.assertEqual(result["stdout"], b"")

    def test_deadline_does_not_invent_terminal_or_discard_original_handle(self):
        result = self.exercise("import time;time.sleep(.08);print('late')", timeout=.005)
        self.assertTrue(result["expired"])
        self.assertNotIn("terminal", result["stage"])
        self.assertEqual(result["exit"], 0)
        self.assertTrue(result["stage"]["stdioClosed"])
        self.assertEqual(result["stdout"], b"late\n")

    def test_nonzero_original_exit_is_preserved_with_complete_output(self):
        result = self.exercise("import sys;print('PASS prefix');sys.exit(9)")
        self.assertEqual(result["stage"]["exitCode"], 9)
        self.assertEqual(result["exit"], 9)
        self.assertEqual(result["stdout"], b"PASS prefix\n")


class CallerOutputLimits(unittest.TestCase):
    def test_gate_rejects_zero_exit_flood_and_shares_budget_across_commands(self):
        with tempfile.TemporaryDirectory(prefix="testops-gate-output-") as name:
            root = Path(name)
            budget = OutputBudget(32768)
            issued, captures = {}, []
            for index in range(2):
                stage = {}
                with self.assertRaisesRegex(ValueError, "ORIGINAL_COMMAND_FAILED"):
                    observe_command([sys.executable, "-c", "import os;os.write(1,b'x'*65536);os.write(2,b'y'*65536)"],
                                    root, root / f"{index}.o", root / f"{index}.e",
                                    stage, budget, 3, issued, captures)
                self.assertEqual(stage["exitCode"], 0)
                self.assertTrue(stage["terminal"] and stage["stdioClosed"])
                self.assertTrue(stage["outputTruncated"])
                self.assertEqual(captures, [])
            self.assertEqual(sum(p.stat().st_size for p in root.iterdir()), 32768)
            self.assertTrue(all(p.returncode == 0 for p in issued.values()))

    def test_gate_retains_complete_successful_output(self):
        with tempfile.TemporaryDirectory(prefix="testops-gate-success-") as name:
            root = Path(name)
            stage = {}
            observe_command([sys.executable, "-c", "print('ordinary')"], root,
                            root / "o", root / "e", stage, OutputBudget(32768), 3, {}, [])
            self.assertEqual((root / "o").read_bytes(), b"ordinary\n")
            self.assertTrue(stage["terminal"] and stage["stdioClosed"])
            self.assertFalse(stage["outputTruncated"])

    def test_measurement_flood_is_bounded_and_never_passes(self):
        with tempfile.TemporaryDirectory(prefix="testops-measure-flood-") as name:
            root = Path(name)
            measure.STOP.clear()
            result = measure.run_probe(("flood", [sys.executable, "-c", "import os;os.write(1,b'x'*2097152);os.write(2,b'y'*2097152)"]), root, None)
            self.assertEqual(result["status"], "FAIL")
            self.assertLessEqual((root / "flood.log").stat().st_size, 1024 * 1024)
            self.assertTrue(result["originalChild"]["terminal"])
            self.assertTrue(result["originalChild"]["outputTruncated"])

    def test_measurement_retains_normal_exit_and_nonzero_status(self):
        with tempfile.TemporaryDirectory(prefix="testops-measure-status-") as name:
            root = Path(name)
            measure.STOP.clear()
            for code in (0, 9):
                result = measure.run_probe((str(code), [sys.executable, "-c", f"import sys;print('hello');print('error',file=sys.stderr);sys.exit({code})"]), root, None)
                self.assertEqual(result["status"], "PASS" if code == 0 else "FAIL")
                self.assertEqual(result["exitCode"], code)
                self.assertTrue(result["originalChild"]["terminal"] and result["originalChild"]["stdioClosed"])
                self.assertEqual(set((root / f"{code}.log").read_text().splitlines()), {"hello", "error"})
