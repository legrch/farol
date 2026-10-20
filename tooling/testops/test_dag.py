"""Execution/ownership regressions for the bounded writer-local pilot scheduler."""
import json
import os
import select
import signal
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from dag import Blocked, Budget, Job, Lease, Outcome, run


class Scheduler(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="farol-testops-dag-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = {"head": "fixture", "tree": "unchanged"}

    def good(self, job, directory, source):
        return Outcome("PASS", True, {"schema": 1, "id": job.id, "source": source,
                                      "exitCode": 0, "complete": True})

    def invoke(self, jobs, execute=None, budget=None, name="run", identity=None, stop=None, platform="linux"):
        return run(self.root, jobs, budget or Budget(), platform, identity or (lambda: self.source),
                   execute or self.good, name, stop)

    def test_independent_jobs_really_overlap_and_dependent_waits(self):
        barrier = threading.Barrier(2)
        ended = set()
        lock = threading.Lock()
        def execute(job, directory, source):
            if job.id in {"a", "b"}:
                barrier.wait(timeout=5)
                with lock:
                    ended.add(job.id)
            else:
                self.assertEqual(ended, {"a", "b"})
            return self.good(job, directory, source)
        report = self.invoke([Job("a"), Job("b"), Job("c", deps=("a", "b"))], execute, Budget(2, 2, 512))
        self.assertEqual(report["status"], "PASS", report["jobs"])
        self.assertFalse(report["leaseRetained"])

    def test_output_creation_race_releases_only_its_pre_job_lease(self):
        output = self.root / "_output/testops/collision"
        original_mkdir = Path.mkdir
        issued = []
        def race(path, *args, **kwargs):
            if path == output:
                original_mkdir(path, *args, **kwargs)
                (path / "competing-writer.txt").write_text("preserve")
                raise FileExistsError("injected output creation race")
            return original_mkdir(path, *args, **kwargs)
        with patch.object(Path, "mkdir", race):
            with self.assertRaises((Blocked, FileExistsError)):
                self.invoke([Job("a")], lambda *args: issued.append(args), name="collision")
        self.assertFalse(issued)
        self.assertEqual((output / "competing-writer.txt").read_text(), "preserve")
        self.assertFalse((self.root / "_output/testops/active-source-gate.lease").exists())
        self.assertEqual(self.invoke([Job("a")], name="after-collision")["status"], "PASS")

    def test_known_lease_setup_failures_release_only_their_pre_job_files(self):
        for failure in ("open", "write", "fsync"):
            with self.subTest(failure=failure):
                parent = self.root / failure
                parent.mkdir()
                lease = Lease(parent)
                def partial(value, stream):
                    stream.write('{"partial":')
                    raise OSError("injected partial owner write")
                target = {"open": "dag.os.open", "write": "dag.json.dump", "fsync": "dag.os.fsync"}[failure]
                action = partial if failure == "write" else OSError("injected lease setup failure")
                with patch(target, side_effect=action), self.assertRaises((Blocked, OSError)):
                    lease.acquire(parent / "output")
                self.assertFalse(lease.path.exists())
                successor = Lease(parent)
                successor.acquire(parent / "next")
                successor.release()

    def test_substituted_lease_after_setup_failure_is_never_reclaimed(self):
        parent = self.root / "substitution"
        parent.mkdir()
        lease = Lease(parent)
        preserved = parent / "original-preserved"
        def substitute(*args):
            lease.path.rename(preserved)
            lease.path.mkdir()
            (lease.path / "competitor").write_text("preserve")
            raise OSError("injected sync failure after substitution")
        with patch("dag.os.fsync", side_effect=substitute), self.assertRaises((Blocked, OSError)):
            lease.acquire(parent / "output")
        self.assertEqual((lease.path / "competitor").read_text(), "preserve")
        self.assertTrue((preserved / "owner.json").is_file())

    def test_exclusive_port_resource_serializes_real_socket_users(self):
        active = 0
        maximum = 0
        port = None
        lock = threading.Lock()
        def execute(job, directory, source):
            nonlocal active, maximum, port
            with lock:
                active += 1
                maximum = max(maximum, active)
            with socket.socket() as server:
                server.bind(("127.0.0.1", port or 0))
                port = server.getsockname()[1]
                server.listen()
                time.sleep(0.03)
            with lock:
                active -= 1
            return self.good(job, directory, source)
        report = self.invoke([Job("a", resources=("port:fixture",)), Job("b", resources=("port:fixture",))],
                             execute, Budget(2, 2, 512))
        self.assertEqual(report["status"], "PASS", report["jobs"])
        self.assertEqual(maximum, 1)

    def test_memory_and_cpu_budgets_prevent_oversubscription(self):
        for budget, jobs, name in [
            (Budget(2, 2, 512), [Job("a", memory_mib=400), Job("b", memory_mib=400)], "memory"),
            (Budget(2, 2, 1024), [Job("a", cpu=2), Job("b", cpu=2)], "cpu"),
        ]:
            active = 0
            maximum = 0
            lock = threading.Lock()
            def execute(job, directory, source):
                nonlocal active, maximum
                with lock:
                    active += 1
                    maximum = max(maximum, active)
                time.sleep(0.02)
                with lock:
                    active -= 1
                return self.good(job, directory, source)
            self.assertEqual(self.invoke(jobs, execute, budget, name=name)["status"], "PASS")
            self.assertEqual(maximum, 1)

    def test_cancellation_drains_actual_original_child_without_a_signal(self):
        stop = threading.Event()
        executed = []
        def execute(job, directory, source):
            executed.append(job.id)
            child = subprocess.Popen([sys.executable, "-B", "-I", "-c",
                                      "import time; print('START',flush=True); time.sleep(.05); print('CLOSED',flush=True)"],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, start_new_session=True)
            self.assertEqual(child.stdout.readline().strip(), "START")
            stop.set()
            stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(stdout.strip(), "CLOSED")
            self.assertEqual(stderr, "")
            return self.good(job, directory, source)
        report = self.invoke([Job("a"), Job("b", deps=("a",))], execute, stop=stop)
        self.assertEqual(report["status"], "CANCELLED")
        self.assertEqual(executed, ["a"])
        self.assertFalse(report["leaseRetained"])
        self.assertEqual(report["jobs"][1]["reason"], "CANCELLED")

    def test_cancellation_during_independent_admission_prevents_submission(self):
        stop = threading.Event()
        first_started = threading.Event()
        issued = []
        original_mkdir = Path.mkdir
        def execute(job, directory, source):
            issued.append(job.id)
            if job.id == "a":
                stop.set()
                first_started.set()
            return self.good(job, directory, source)
        def mkdir(path, *args, **kwargs):
            original_mkdir(path, *args, **kwargs)
            if path.name == "b":
                self.assertTrue(first_started.wait(5))
                self.assertTrue(stop.is_set())
        with patch.object(Path, "mkdir", mkdir):
            report = self.invoke([Job("a"), Job("b")], execute, Budget(2, 2, 512), stop=stop)
        self.assertEqual(issued, ["a"])
        self.assertEqual(report["status"], "CANCELLED")
        self.assertEqual(report["jobs"][1]["reason"], "CANCELLED")
        self.assertFalse(report["leaseRetained"])

    def test_cancellation_during_first_directory_creation_issues_nothing(self):
        stop = threading.Event()
        issued = []
        original_mkdir = Path.mkdir
        def mkdir(path, *args, **kwargs):
            original_mkdir(path, *args, **kwargs)
            if path.name == "a":
                stop.set()
        with patch.object(Path, "mkdir", mkdir):
            report = self.invoke([Job("a")], lambda *args: issued.append(args), stop=stop)
        self.assertFalse(issued)
        self.assertEqual(report["status"], "CANCELLED")
        self.assertEqual(report["jobs"][0]["reason"], "CANCELLED")
        self.assertFalse(report["leaseRetained"])

    def test_existing_lease_blocks_a_second_actual_process_without_pid_reclaim(self):
        parent = self.root / "_output/testops"
        parent.mkdir(parents=True)
        lease = Lease(parent)
        lease.acquire(parent / "original")
        script = ("import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); "
                  "from dag import Lease,Blocked; "
                  "p=Path(sys.argv[2]);\ntry: Lease(p).acquire(p/'second')\n"
                  "except Blocked as e: print(str(e)); sys.exit(0)\n"
                  "sys.exit(3)\n")
        child = subprocess.run([sys.executable, "-B", "-I", "-c", script, str(Path(__file__).parent), str(parent)],
                               capture_output=True, text=True, timeout=5)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(child.stdout.strip(), "SOURCE_GATE_LEASE_BUSY")
        lease.release()

    def test_actual_sigint_to_parent_drains_child_and_blocks_successor(self):
        script = '''import json,signal,subprocess,sys,threading
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from dag import run,Job,Budget,Outcome
root=Path(sys.argv[2]); stop=threading.Event()
signal.signal(signal.SIGINT,lambda *_:stop.set())
def execute(job,directory,source):
    if job.id != 'a': raise AssertionError('successor admitted after cancellation')
    code="import time,sys; from pathlib import Path; print('START',flush=True); time.sleep(.2); Path(sys.argv[1]).write_text('CLOSED')"
    child=subprocess.Popen([sys.executable,'-B','-I','-c',code,str(root/'closed')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
    assert child.stdout.readline().strip()=='START'
    print('READY',flush=True)
    child.communicate(timeout=5); assert child.returncode==0
    return Outcome('PASS',True,{'schema':1,'id':job.id,'source':source,'exitCode':0,'complete':True})
report=run(root,[Job('a'),Job('b',deps=('a',))],Budget(),'linux',lambda:{'head':'fixture'},execute,'signal',stop)
print(json.dumps({'status':report['status'],'leaseRetained':report['leaseRetained']}),flush=True)
sys.exit(130 if report['status']=='CANCELLED' else 3)
'''
        child = subprocess.Popen([sys.executable, "-B", "-I", "-c", script, str(Path(__file__).parent), str(self.root)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, start_new_session=True)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 5)[0], "parent never became ready")
            self.assertEqual(child.stdout.readline().strip(), "READY")
            os.kill(child.pid, signal.SIGINT)
            stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 130, stderr)
            self.assertEqual(json.loads(stdout), {"status": "CANCELLED", "leaseRetained": False})
            self.assertEqual((self.root / "closed").read_text(), "CLOSED")
            report = json.loads((self.root / "_output/testops/signal/report.json").read_text())
            self.assertEqual(report["jobs"][1]["reason"], "CANCELLED")
        finally:
            if child.poll() is None:
                child.wait(timeout=5)

    def test_unknown_outcome_and_spawn_exception_keep_lease_fenced(self):
        def unknown(job, directory, source):
            return Outcome("UNKNOWN", False, reason="unknown original child")
        report = self.invoke([Job("a")], unknown)
        self.assertEqual(report["status"], "UNKNOWN")
        self.assertTrue(report["leaseRetained"])
        with self.assertRaisesRegex(Blocked, "LEASE_BUSY"):
            self.invoke([Job("a")], name="second")

    def test_executor_exception_after_a_real_spawn_does_not_become_pass(self):
        children = []
        def execute(job, directory, source):
            children.append(subprocess.Popen([sys.executable, "-B", "-I", "-c", "import time; time.sleep(.03)"],
                                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                             stderr=subprocess.DEVNULL, start_new_session=True))
            raise OSError("synthetic observation failure after spawn")
        try:
            report = self.invoke([Job("a")], execute)
            self.assertEqual(report["status"], "UNKNOWN")
            self.assertTrue(report["leaseRetained"])
        finally:
            for child in children:
                self.assertEqual(child.wait(timeout=5), 0)
        self.assertTrue((self.root / "_output/testops/active-source-gate.lease").exists())

    def test_admission_io_failure_still_observes_an_inflight_unknown_result(self):
        original = Path.mkdir
        def fail_second(path, *args, **kwargs):
            if path.name == "c" and path.parent.name == "exception":
                raise OSError("synthetic output failure after first admission")
            return original(path, *args, **kwargs)
        def execute(job, directory, source):
            time.sleep(0.02)
            return Outcome("UNKNOWN", False)
        with patch.object(Path, "mkdir", autospec=True, side_effect=fail_second):
            report = self.invoke([Job("a"), Job("c")], execute, Budget(2, 2, 512), name="exception")
        self.assertEqual(report["status"], "UNKNOWN")
        self.assertTrue(report["leaseRetained"])
        self.assertEqual(report["jobs"][0]["status"], "UNKNOWN")

    def test_exit_success_without_complete_source_bound_report_is_failure(self):
        for receipt, name in [(None, "missing"), ({"schema": 1}, "partial"),
                              ({"schema": 1, "id": "a", "source": self.source, "exitCode": False, "complete": True}, "boolean")]:
            report = self.invoke([Job("a")], lambda *args: Outcome("PASS", True, receipt), name=name)
            self.assertEqual(report["status"], "FAIL")
            self.assertEqual(report["jobs"][0]["reason"], "INCOMPLETE_OR_MISMATCHED_RECEIPT")

    def test_known_failure_stops_new_admissions_and_preserves_not_run(self):
        executed = []
        def execute(job, directory, source):
            executed.append(job.id)
            return Outcome("FAIL", True, reason="original assertion failed")
        report = self.invoke([Job("a"), Job("b", deps=("a",))], execute)
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(executed, ["a"])
        self.assertEqual(report["jobs"][1]["status"], "NOT_RUN")

    def test_mac_obligation_on_linux_is_incomplete_not_pass(self):
        executed = []
        def execute(job, directory, source):
            executed.append(job.id)
            return self.good(job, directory, source)
        report = self.invoke([Job("a", platform="macos"), Job("b", deps=("a",))], execute)
        self.assertEqual(report["status"], "INCOMPLETE")
        self.assertEqual(executed, [])
        self.assertEqual(report["jobs"][0]["reason"], "MAC_REQUIRED")

    def test_source_drift_and_executor_metadata_mutation_cannot_rewrite_before(self):
        def drift(job, directory, source):
            self.source["tree"] = "changed"
            return self.good(job, directory, source)
        report = self.invoke([Job("a")], drift)
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["sourceBefore"]["tree"], "unchanged")
        self.assertEqual(report["sourceAfter"]["tree"], "changed")
        def mutate(job, directory, source):
            source["head"] = "forged"
            return self.good(job, directory, source)
        self.assertEqual(self.invoke([Job("a")], mutate, name="mutate")["status"], "FAIL")

    def test_lease_substitution_prevents_release_and_never_claims_green(self):
        def execute(job, directory, source):
            owner = self.root / "_output/testops/active-source-gate.lease/owner.json"
            owner.write_text(json.dumps({"leaseId": "different owner"}))
            return self.good(job, directory, source)
        report = self.invoke([Job("a")], execute)
        self.assertEqual(report["status"], "UNKNOWN")
        self.assertTrue(report["leaseRetained"])

    def test_invalid_effect_target_budget_cycle_and_resource_metadata_never_execute(self):
        bad = [[Job("a", target="prod")], [Job("a", effects="remote-write")],
               [Job("a", resources=("Native:Alias",))], [Job("a", cpu=3)],
               [Job("a", deps=("b",)), Job("b", deps=("a",))], [Job("a", deps=("absent",))]]
        for jobs in bad:
            with self.assertRaises(Blocked):
                self.invoke(jobs, lambda *args: self.fail("invalid graph executed"))
        self.assertFalse((self.root / "_output").exists())

    def test_output_symlink_cannot_redirect_writes(self):
        outside = self.root / "other"
        outside.mkdir()
        (self.root / "_output").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(Blocked, "REDIRECT"):
            self.invoke([Job("a")])
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
