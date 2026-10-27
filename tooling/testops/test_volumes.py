"""Owned volume lifecycle against a recording fake Docker CLI; no daemon calls."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import volumes

TESTOPS = Path(__file__).resolve().parent / "testops.py"
SCOPE = "farol-testops-0a1b2c3d"
NAMES = [SCOPE + "-source", SCOPE + "-seed", SCOPE + "-sdk"]

# The fake Docker keeps state and an argv log next to itself: the real adapter
# passes only a fixed environment allowlist, so no test variables reach it.
FAKE = r'''#!/usr/bin/python3
import fcntl, json, sys
from pathlib import Path
here = Path(__file__).resolve().parent
args = sys.argv[1:]
with open(here / "argv.log", "a") as raw:
    raw.write(json.dumps(args) + "\n")
while args and args[0] in ("--host", "--config"):
    args = args[2:]
if args[:2] == ["context", "inspect"]:
    print("unix:///fake/docker.sock")
    raise SystemExit(0)
with open(here / "state.lock", "w") as guard:
    fcntl.flock(guard, fcntl.LOCK_EX)
    with open(here / "docker.log", "a") as log:
        log.write(json.dumps(args) + "\n")
    state = json.loads((here / "state.json").read_text())
    vols, conts, fail = state["volumes"], state["containers"], state.get("fail", {})
    def save():
        (here / "state.json").write_text(json.dumps(state))
    def filters():
        return [args[i + 1] for i, a in enumerate(args) if a == "--filter"]
    def mounted(name):
        return [c for c in conts if name in c["mounts"]]
    out, err, code = [], [], 0
    if args[:2] == ["volume", "create"]:
        name = args[-1]
        if "create:" + name in fail:
            err.append(fail["create:" + name]); code = 1
        else:
            labels = dict(args[i + 1].split("=", 1) for i, a in enumerate(args) if a == "--label")
            vols.setdefault(name, {"Labels": labels}); save(); out.append(name)
    elif args[:2] == ["volume", "inspect"]:
        found = []
        for name in args[2:]:
            if name in vols:
                found.append({"Name": name, "Driver": "local", "Options": None,
                              "Labels": vols[name]["Labels"], "CreatedAt": "2026-10-27T00:00:00Z"})
            else:
                err.append("Error response from daemon: get " + name + ": no such volume"); code = 1
        out.append(json.dumps(found))
    elif args[:2] == ["volume", "ls"]:
        for name, value in sorted(vols.items()):
            ok = True
            for f in filters():
                key, _, wanted = f[len("label="):].partition("=")
                labels = value["Labels"] or {}
                ok = ok and key in labels and (not wanted or labels[key] == wanted)
            if ok:
                out.append(name)
    elif args[:2] == ["volume", "rm"]:
        name = args[2]
        if "rm:" + name in fail:
            err.append(fail["rm:" + name]); code = 1
        elif name not in vols:
            err.append("Error response from daemon: get " + name + ": no such volume"); code = 1
        elif mounted(name):
            err.append("Error response from daemon: remove " + name + ": volume is in use"); code = 1
        else:
            del vols[name]; save(); out.append(name)
    elif args[:1] == ["ps"]:
        for c in conts:
            ok = True
            for f in filters():
                kind, _, value = f.partition("=")
                if kind == "volume":
                    ok = ok and value in c["mounts"]
                else:
                    key, _, wanted = value.partition("=")
                    ok = ok and c["labels"].get(key) == wanted
            if ok:
                out.append(c["id"] if args[-1] == "{{.ID}}" else c["id"] + " " + c["name"])
    elif args[:1] == ["rm"]:
        state["containers"] = [c for c in conts if c["id"] != args[-1]]; save()
    else:
        err.append("unsupported"); code = 1
print("\n".join(out))
print("\n".join(err), file=sys.stderr)
sys.exit(code)
'''


class Volumes(unittest.TestCase):
    def write_own_lease(self, names):
        volumes.output_dirs(self.root)
        volumes.write_lease(self.lease(), {"schema": 1, "scope": SCOPE, "created": "now",
                                           "owner": {"pid": os.getpid(), "start": volumes.process_start(os.getpid())},
                                           "volumes": [{"name": n, "retain": "run"} for n in names]})

    def test_release_needs_this_checkouts_lease_and_verified_volumes(self):
        foreign = {volumes.LABEL: SCOPE[-8:], volumes.CHECKOUT: "0" * 16}
        self.set_state({NAMES[0]: {"Labels": foreign}, NAMES[1]: {"Labels": {volumes.LABEL: SCOPE[-8:]}}},
                       containers=[{"id": "c9", "name": SCOPE + "-nonce-core", "mounts": [NAMES[0]],
                                    "labels": {volumes.LABEL: SCOPE[-8:]}}])
        # No local lease: nothing is touched, not even a scope-labelled container.
        code, result = self.cli("release", "--scope", SCOPE)
        self.assertEqual((code, result["status"]), (2, "BLOCKED"))
        # A stale or lost-race lease naming another checkout's or an unlabelled volume.
        self.write_own_lease(NAMES[:2])
        code, result = self.cli("release", "--scope", SCOPE)
        self.assertEqual((code, result["status"], result["removed"], result["removedContainers"]),
                         (1, "INCOMPLETE", [], []))
        self.assertEqual(sorted(e.split(":")[0] for e in result["errors"]), ["NOT_THIS_CHECKOUT"] * 2)
        self.assertEqual(set(self.state()["volumes"]), set(NAMES[:2]))
        self.assertFalse([argv for argv in self.log() if argv[:1] == ["rm"] or argv[:2] == ["volume", "rm"]])

    def test_every_call_is_pinned_to_the_endpoint_resolved_at_start(self):
        code, _ = self.cli("prepare", *self.prepare_args(NAMES[:1]))
        self.assertEqual(code, 0)
        code, _ = self.cli("release", "--scope", SCOPE)
        self.assertEqual(code, 0)
        raw = [json.loads(line) for line in (self.docker.parent / "argv.log").read_text().splitlines()]
        self.assertTrue(raw)
        for argv in raw:
            if argv[:2] == ["context", "inspect"]:
                continue
            self.assertEqual(argv[:2], ["--host", "unix:///fake/docker.sock"], argv)

    def test_checkout_identity_is_minted_once_and_not_derived_from_the_path(self):
        first = volumes.checkout_id(self.root)
        self.assertEqual(volumes.checkout_id(self.root), first)
        # Another client at the same path has its own identity.
        (self.root / "_output/testops/checkout.id").unlink()
        self.assertNotEqual(volumes.checkout_id(self.root), first)

    def here(self):
        return {volumes.CHECKOUT: volumes.checkout_id(self.root)}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="testops-volumes-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "repo"
        self.root.mkdir()
        bin_dir = Path(self.temp.name).resolve() / "fake"
        bin_dir.mkdir()
        self.docker = bin_dir / "docker"
        self.docker.write_text(FAKE)
        self.docker.chmod(0o700)
        self.state_file, self.log_file = bin_dir / "state.json", bin_dir / "docker.log"
        self.set_state({})

    def set_state(self, vols, containers=(), fail=None):
        self.state_file.write_text(json.dumps({"volumes": vols, "containers": list(containers),
                                               "fail": fail or {}}))

    def state(self):
        return json.loads(self.state_file.read_text())

    def log(self):
        if not self.log_file.exists():
            return []
        return [json.loads(line) for line in self.log_file.read_text().splitlines()]

    def argv(self, action, *extra):
        return ["/usr/bin/python3", "-B", str(TESTOPS), "--root", str(self.root), "volumes", action,
                "--docker", str(self.docker), "--lock-timeout", "20", *extra]

    def cli(self, action, *extra):
        result = subprocess.run(self.argv(action, *extra), capture_output=True, text=True, timeout=60)
        return result.returncode, json.loads(result.stdout)

    def prepare_args(self, names=NAMES):
        values = []
        for name in names:
            values += ["--volume", name]
        return ["--scope", SCOPE, *values]

    def lease(self, scope=SCOPE):
        return self.root / "_output/testops/scopes" / (scope + ".json")

    def owner(self):
        child = subprocess.Popen(["/bin/sleep", "60"])
        self.addCleanup(lambda: (child.poll() is None and child.kill(), child.wait()))
        return child

    def assert_released(self, names):
        log = self.log()
        for name in names:
            rm = log.index(["volume", "rm", name])
            self.assertIn(["volume", "inspect", name], log[rm + 1:], name)
        self.assertEqual(set(self.state()["volumes"]) & set(names), set())

    def runner(self, body):
        """A runner process: prepares as lease owner (the CLI's parent), then runs `body`."""
        code = ("import json, subprocess, sys, time\n"
                "prepare, release = json.loads(sys.argv[1]), json.loads(sys.argv[2])\n"
                "subprocess.run(prepare, check=True, stdout=subprocess.DEVNULL)\n"
                "print('prepared', flush=True)\n" + body)
        prepare = self.argv("prepare", *self.prepare_args())
        return subprocess.Popen(["/usr/bin/python3", "-B", "-c", code, json.dumps(prepare),
                                 json.dumps(self.argv("release", "--scope", SCOPE))],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    def test_release_after_job_error_removes_every_scope_volume(self):
        runner = self.runner("try:\n    raise RuntimeError('job failed')\n"
                             "finally:\n    subprocess.run(release, stdout=subprocess.DEVNULL)\n")
        runner.communicate(timeout=60)
        self.assertEqual(runner.returncode, 1)
        self.assert_released(NAMES)
        self.assertFalse(self.lease().exists())

    def test_release_after_runner_sigterm_removes_every_scope_volume(self):
        runner = self.runner("time.sleep(60)\n")
        self.assertEqual(runner.stdout.readline().strip(), "prepared")
        lease = json.loads(self.lease().read_text())
        self.assertEqual(lease["owner"]["pid"], runner.pid)
        self.assertEqual([r["name"] for r in lease["volumes"]], NAMES)
        code, result = self.cli("prune")  # Live runner: its volumes are never pruned.
        self.assertEqual((code, result["removed"]), (0, []))
        runner.send_signal(signal.SIGTERM)
        runner.communicate(timeout=30)
        self.assertEqual(runner.returncode, -signal.SIGTERM)
        self.assertEqual(set(self.state()["volumes"]), set(NAMES))
        code, result = self.cli("release", "--scope", SCOPE)
        self.assertEqual((code, result["status"], sorted(result["removed"])), (0, "PASS", sorted(NAMES)))
        self.assert_released(NAMES)
        self.assertFalse(self.lease().exists())

    def test_partial_prepare_is_accounted_and_cleaned_by_release_or_prune(self):
        for route in ("release", "prune"):
            with self.subTest(route=route):
                self.set_state({}, fail={"create:" + NAMES[2]: "Error response from daemon: disk full"})
                if self.lease().exists():
                    self.lease().unlink()
                owner = self.owner()
                code, result = self.cli("prepare", *self.prepare_args(), "--owner-pid", str(owner.pid))
                self.assertEqual((code, result["status"], result["created"]), (1, "INCOMPLETE", NAMES[:2]))
                self.assertEqual([r["name"] for r in json.loads(self.lease().read_text())["volumes"]], NAMES)
                self.assertEqual(set(self.state()["volumes"]), set(NAMES[:2]))
                if route == "release":
                    code, result = self.cli("release", "--scope", SCOPE)
                else:
                    owner.kill(); owner.wait()
                    code, result = self.cli("prune")
                    self.assertEqual(result["droppedLeases"], [SCOPE])
                self.assertEqual((code, result["status"]), (0, "PASS"))
                self.assertEqual(sorted(result["removed"]), sorted(NAMES[:2]))
                if route == "release":
                    self.assertEqual(result["alreadyAbsent"], [NAMES[2]])
                self.assert_released(NAMES[:2])
                self.assertFalse(self.lease().exists())

    def test_prune_touches_only_unreferenced_labelled_volumes_without_live_lease(self):
        orphan, used, cached = "farol-testops-0000000a-old", "farol-testops-0000000b-src", "farol-testops-0000000c-x"
        # Another checkout's lease is invisible here; an unlabelled one has no owner at all.
        foreign, legacy = "farol-testops-0000000d-other", "farol-testops-0000000e-legacy"
        self.set_state({"partners-service_db": {"Labels": {}}, "taplex-cache": {"Labels": None},
                        "sc-platform_pg": {"Labels": {"com.docker.compose.project": "sc"}},
                        orphan: {"Labels": {volumes.LABEL: "0000000a", **self.here()}},
                        foreign: {"Labels": {volumes.LABEL: "0000000d", volumes.CHECKOUT: "0" * 16}},
                        legacy: {"Labels": {volumes.LABEL: "0000000e"}},
                        used: {"Labels": {volumes.LABEL: "0000000b", volumes.RETAIN: "run", **self.here()}},
                        cached: {"Labels": {volumes.LABEL: "0000000c", volumes.RETAIN: "bogus", **self.here()}}},
                       containers=[{"id": "c1", "name": "other", "labels": {}, "mounts": [used]}])
        code, result = self.cli("prepare", *self.prepare_args(NAMES[:1]))
        self.assertEqual((code, result["status"]), (0, "PASS"))  # Owner: this live test process.
        code, result = self.cli("prune")
        self.assertEqual((code, result["status"], result["removed"]), (0, "PASS", [orphan]))
        kept = {row["name"]: (row["state"], row["reason"]) for row in result["kept"]}
        self.assertEqual(kept, {NAMES[0]: ("active", "LIVE_LEASE"), used: ("active", "CONTAINER_REFERENCE"),
                                cached: ("unknown", "RETAIN_OR_CACHE_KEY_LABEL_INVALID"),
                                foreign: ("unknown", "NOT_THIS_CHECKOUT"),
                                legacy: ("unknown", "NOT_THIS_CHECKOUT")})
        for argv in self.log():
            if argv[:1] != ["volume"] or argv[1] == "ls":
                continue
            self.assertFalse({"partners-service_db", "taplex-cache", "sc-platform_pg"} & set(argv), argv)
        self.assertTrue({"partners-service_db", "taplex-cache", "sc-platform_pg", NAMES[0], used, cached}
                        <= set(self.state()["volumes"]))

    def test_concurrent_prune_waits_for_lease_registration_and_keeps_its_volume(self):
        with volumes.locked(self.root, 5):
            pruning = subprocess.Popen(self.argv("prune"), stdout=subprocess.PIPE, text=True)
            time.sleep(1.0)
            self.assertIsNone(pruning.poll())
            self.assertEqual(self.log(), [])  # No check or rm while prepare holds the lock.
            # Prepare's critical section: lease first, then create; no container exists yet.
            volumes.write_lease(self.lease(), {"schema": 1, "scope": SCOPE, "created": "now",
                                               "owner": {"pid": os.getpid(), "start": volumes.process_start(os.getpid())},
                                               "volumes": [{"name": NAMES[0], "retain": "run"}]})
            self.set_state({NAMES[0]: {"Labels": {volumes.LABEL: SCOPE[-8:], volumes.RETAIN: "run"}}})
        output, _ = pruning.communicate(timeout=30)
        result = json.loads(output)
        self.assertEqual((pruning.returncode, result["removed"]), (0, []))
        self.assertIn(NAMES[0], self.state()["volumes"])
        self.assertNotIn(["volume", "rm", NAMES[0]], self.log())

    def test_rm_error_reports_incomplete_and_keeps_lease(self):
        code, _ = self.cli("prepare", *self.prepare_args())
        self.assertEqual(code, 0)
        busy = {"rm:" + NAMES[1]: "Error response from daemon: remove: volume is in use"}
        state = self.state()
        self.set_state(state["volumes"], fail=busy)
        code, result = self.cli("release", "--scope", SCOPE)
        self.assertEqual((code, result["status"]), (1, "INCOMPLETE"))
        self.assertIn(NAMES[1], result["errors"][0])
        self.assertTrue(self.lease().exists())
        self.assertEqual(set(self.state()["volumes"]), {NAMES[1]})
        self.lease().unlink()  # Owner-less now: prune must also report the busy volume.
        code, result = self.cli("prune")
        self.assertEqual((code, result["status"], result["removed"]), (1, "INCOMPLETE", []))
        self.assertIn(NAMES[1], self.state()["volumes"])

    def test_release_removes_owned_containers_first_and_keeps_cache(self):
        cache = SCOPE + "-gomod"
        self.set_state({NAMES[0]: {"Labels": {volumes.LABEL: SCOPE[-8:], **self.here()}},
                        cache: {"Labels": {volumes.LABEL: SCOPE[-8:], volumes.RETAIN: "cache",
                                           volumes.CACHE_KEY: "go-1", **self.here()}}},
                       containers=[{"id": "c1", "name": SCOPE + "-nonce-core", "mounts": [NAMES[0]],
                                    "labels": {volumes.LABEL: SCOPE[-8:]}}])
        self.write_own_lease([NAMES[0]])
        code, result = self.cli("release", "--scope", SCOPE)
        self.assertEqual((code, result["removedContainers"], result["removed"], result["retainedCache"]),
                         (0, ["c1"], [NAMES[0]], [cache]))
        log = self.log()
        self.assertLess(log.index(["rm", "--force", "c1"]), log.index(["volume", "rm", NAMES[0]]))

    def test_status_and_prune_keep_two_newest_unreferenced_caches_per_key(self):
        def cache(scope, created, key):
            return {"Labels": {volumes.LABEL: scope, volumes.RETAIN: "cache", volumes.CACHE_KEY: key,
                               volumes.CREATED: created, **self.here()}}
        names = ["farol-testops-0000000%d-gomod" % i for i in range(4)]
        self.set_state({names[0]: cache("00000000", "2026-10-01T00:00:00.000000Z", "go-1"),
                        names[1]: cache("00000001", "2026-10-02T00:00:00.000000Z", "go-1"),
                        names[2]: cache("00000002", "2026-10-03T00:00:00.000000Z", "go-1"),
                        names[3]: cache("00000003", "2026-09-01T00:00:00.000000Z", "go-2")})
        code, result = self.cli("status")
        states = {row["name"]: row["state"] for row in result["volumes"]}
        self.assertEqual((code, states), (0, {names[0]: "removable", names[1]: "protected",
                                              names[2]: "protected", names[3]: "protected"}))
        self.assertNotIn(["volume", "rm", names[0]], self.log())  # Status is read-only.
        code, result = self.cli("prune")
        self.assertEqual((code, result["removed"]), (0, [names[0]]))


if __name__ == "__main__":
    unittest.main()
