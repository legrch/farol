"""Original child/pipe evidence using finite disposable Python processes only."""
from pathlib import Path
import hashlib
import subprocess
import sys
import tempfile
import unittest

from bounded_capture import Capture, OutputBudget
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
