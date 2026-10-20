"""Real original-child observation, without host namespace enumeration/signals."""
import subprocess
import sys
import time
import unittest

from deadline import CommandTimeout, wait_original, retire_private_descendants


class Deadlines(unittest.TestCase):
    def test_observes_the_original_child_and_nonzero_exit(self):
        child = subprocess.Popen([sys.executable, "-B", "-I", "-c", "raise SystemExit(7)"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        result = wait_original(child, 5)
        self.assertEqual(result["pid"], child.pid)
        self.assertTrue(result["terminal"])
        self.assertEqual(result["exitCode"], 7)
        self.assertEqual(child.returncode, 7)

    def test_deadline_returns_without_signalling_or_replacing_original_child(self):
        child = subprocess.Popen([sys.executable, "-B", "-I", "-c", "import sys; sys.stdin.buffer.read(1)"],
                                 stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            started = time.monotonic()
            with self.assertRaises(CommandTimeout):
                wait_original(child, 0.03)
            self.assertLess(time.monotonic() - started, 1)
            self.assertIsNone(child.returncode)
            child.stdin.write(b"x")
            child.stdin.close()
            result = wait_original(child, 5)
            self.assertEqual(result["pid"], child.pid)
            self.assertEqual(result["exitCode"], 0)
        finally:
            if child.returncode is None:
                child.terminate()
                child.wait(timeout=5)

    def test_namespace_cleanup_cannot_enumerate_or_signal_the_host(self):
        with self.assertRaisesRegex(ValueError, "PRIVATE_PID_NAMESPACE_REQUIRED"):
            retire_private_descendants(True)

    def test_invalid_deadline_does_not_consume_the_original_child(self):
        child = subprocess.Popen([sys.executable, "-B", "-I", "-c", "raise SystemExit(0)"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for value in (False, 0, -1, float("inf"), float("nan")):
            with self.assertRaises(ValueError):
                wait_original(child, value)
        self.assertEqual(wait_original(child, 5)["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
