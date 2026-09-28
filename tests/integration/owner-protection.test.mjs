import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const homes = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "farol-owner-guard-"));
  homes.push(home);
  return home;
}
function run(home, code) {
  return spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "scripts/assert-owner-untouched.py",
      "--",
      "/usr/bin/python3",
      "-I",
      "-c",
      code,
    ],
    {
      cwd: root,
      env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    },
  );
}
function runOwnerLaunch(home, script, args, code, extraEnvironment = {}) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const fakeNode = path.join(bin, "node");
  fs.writeFileSync(
    fakeNode,
    '#!/bin/sh\nexec /usr/bin/python3 -I -c "$FAKE_NODE_CODE"\n',
    { mode: 0o700 },
  );
  return spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "scripts/assert-owner-untouched.py",
      "--",
      fakeNode,
      script,
      ...args,
    ],
    {
      cwd: root,
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        FAKE_NODE_CODE: code,
        ...extraEnvironment,
      },
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    },
  );
}
// Every probe has a hard deadline and spawnSync reaps its exact owned process.
// Probes use disposable HOME only; fixture children are finite and never detach.
function probe(home, code) {
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      `
import importlib.util, os, signal, stat, sys
from pathlib import Path
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("guard", "scripts/assert-owner-untouched.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
${code}
`,
    ],
    {
      cwd: root,
      env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return result;
}
function fifo(home) {
  const file = path.join(home, ".farol/runtime/hub/fixture/proof.fifo");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const made = spawnSync("/usr/bin/mkfifo", [file], {
    timeout: 5000,
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
  expect(made.error, made.stderr).toBeUndefined();
  expect(made.status, made.stderr).toBe(0);
  return file;
}
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});
describe("standalone owner protection", () => {
  it("detects writes to a synthetic protected path without any V0 imports", () => {
    const home = fixture();
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'.farol/state/settings.json'; p.parent.mkdir(parents=True); p.write_text('changed')",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".farol/state/settings.json");
    expect(result.stderr).toContain(
      "modified the owner's live Farol installation",
    );
  });
  it("permits declared runtime churn and its atomic staging siblings", () => {
    const result = run(
      fixture(),
      "from pathlib import Path; p=Path.home()/'.farol/runtime/hub/farol-full'; p.mkdir(parents=True); [(p/n).write_text('churn') for n in ['codex-route-activity.json','.codex-route-activity.json.tmp','hub-actions.jsonl.reservation']]",
    );
    expect(result.status).toBe(0);
  });
  it("catches an undeclared profile but allows the separately owned V0 development profiles", () => {
    const home = fixture();
    expect(
      run(
        home,
        "from pathlib import Path; p=Path.home()/'.config/tunnel-client'; p.mkdir(parents=True); (p/'farol-dev-full.yaml').write_text('fixture')",
      ).status,
    ).toBe(0);
    const result = run(
      home,
      "from pathlib import Path; (Path.home()/'.config/tunnel-client/unowned.yaml').write_text('fixture')",
    );
    expect(result.status).toBe(1);
  });
  it("catches browser-profile replacement without reading browser content", () => {
    const home = fixture();
    const profile = path.join(home, ".farol/runtime/browser/browser-profile");
    fs.mkdirSync(profile, { recursive: true });
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'.farol/runtime/browser/browser-profile'; p.rename(p.with_name('old')); p.mkdir()",
    );
    expect(result.status).toBe(1);
  });
  it("catches new-product startup markers without scanning profile content", () => {
    const home = fixture();
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'Library/Application Support/Farol Dev/farol-next-state/running.json'; p.parent.mkdir(parents=True); p.write_text('synthetic marker')",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Farol Dev/farol-next-state/running.json");
  });
  it("catches replacement of a new-product profile directory by identity", () => {
    const home = fixture();
    const profile = path.join(
      home,
      "Library/Application Support/Farol Next Preview",
    );
    fs.mkdirSync(profile, { recursive: true });
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'Library/Application Support/Farol Next Preview'; p.rename(p.with_name('old')); p.mkdir()",
    );
    expect(result.status).toBe(1);
  });
  it.each([
    ["Dev", "tooling/dev.mjs", [], "Farol Dev", "Farol Next Preview", {}],
    [
      "Dev acceptance",
      "tooling/dev.mjs",
      ["--acceptance-profile"],
      "Farol Dev Acceptance/Farol Dev",
      "Farol Dev",
      {},
    ],
    [
      "packaged preview",
      "tooling/run-preview.mjs",
      [],
      "Farol Next Preview",
      "Farol Dev",
      { FAROL_NEXT_OWNER_LAUNCH: "1" },
    ],
  ])(
    "allows %s startup markers but still catches another profile",
    (_label, script, args, allowed, denied, environment) => {
      const home = fixture();
      const writeMarker = (profile) =>
        `from pathlib import Path; p=Path.home()/'Library/Application Support/${profile}/farol-next-state/running.json'; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('synthetic marker')`;
      const allowedResult = runOwnerLaunch(
        home,
        script,
        args,
        writeMarker(allowed),
        environment,
      );
      expect(allowedResult.status, allowedResult.stderr).toBe(0);
      const deniedResult = runOwnerLaunch(
        home,
        script,
        args,
        writeMarker(denied),
        environment,
      );
      expect(deniedResult.status).toBe(1);
      expect(deniedResult.stderr).toContain(
        `${denied}/farol-next-state/running.json`,
      );
    },
  );
  it("still catches replacement of the selected owner-launch profile", () => {
    const home = fixture();
    const profile = path.join(home, "Library/Application Support/Farol Dev");
    fs.mkdirSync(profile, { recursive: true });
    const result = runOwnerLaunch(
      home,
      "tooling/dev.mjs",
      [],
      "from pathlib import Path; p=Path.home()/'Library/Application Support/Farol Dev'; p.rename(p.with_name('old')); p.mkdir()",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Farol Dev");
  });
  it("keeps the full guard for check-only Dev commands that never launch", () => {
    const home = fixture();
    const result = runOwnerLaunch(
      home,
      "tooling/dev.mjs",
      ["--check"],
      "from pathlib import Path; p=Path.home()/'Library/Application Support/Farol Dev/farol-next-state/running.json'; p.parent.mkdir(parents=True); p.write_text('synthetic marker')",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Farol Dev/farol-next-state/running.json");
  });
  it("preserves a failing child exit code", () => {
    expect(run(fixture(), "raise SystemExit(17)").status).toBe(17);
  });
});

describe("bounded owner guard startup recovery", () => {
  it("fingerprints an unchanged FIFO without a writer or stream read", () => {
    const home = fixture();
    fifo(home);
    const result = run(home, "raise SystemExit(0)");
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  });
  it.each([
    ["permission mutation", "p.chmod(0o400)"],
    ["replacement", "p.rename(p.with_name('old.fifo')); os.mkfifo(p)"],
    ["type substitution", "p.unlink(); p.write_text('regular')"],
    ["deletion", "p.unlink()"],
  ])("detects FIFO %s without consuming it", (_name, mutation) => {
    const home = fixture();
    fifo(home);
    const result = run(
      home,
      `import os; from pathlib import Path; p=Path.home()/'.farol/runtime/hub/fixture/proof.fifo'; ${mutation}`,
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("proof.fifo");
  });
  it("keeps ordinary file content protection", () => {
    const home = fixture();
    const file = path.join(home, ".farol/state/settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "before");
    const result = run(
      home,
      "from pathlib import Path; (Path.home()/'.farol/state/settings.json').write_text('after!')",
    );
    expect(result.status, result.stderr).toBe(1);
  });
  it("does not follow symlink content and detects target replacement", () => {
    probe(
      fixture(),
      `
p = Path.home()/"link"
target = Path.home()/"target"
target.write_text("one")
p.symlink_to(target)
before = guard._digest(p)
target.write_text("two")
assert guard._digest(p) == before
p.unlink()
p.symlink_to("different")
assert guard._digest(p) != before
`,
    );
  });
  it.each(["fifo", "symlink", "regular"])(
    "rejects a regular-to-%s swap between lstat and open",
    (kind) => {
      probe(
        fixture(),
        `
p = Path.home()/"watched"
p.write_text("before")
original_open = os.open
calls = []
def replace(file, flags, *args, **kwargs):
    if Path(file) == p:
        calls.append(flags)
        p.rename(p.with_name("previous"))
        ${kind === "fifo" ? "os.mkfifo(p)" : kind === "symlink" ? "p.symlink_to(p.with_name('previous'))" : "p.write_text('replaced')"}
    return original_open(file, flags, *args, **kwargs)
guard.os.open = replace
try:
    guard._digest(p)
except guard.FingerprintError:
    pass
else:
    raise AssertionError("an unstable descriptor was accepted")
assert len(calls) == 1
assert calls[0] & os.O_NONBLOCK
assert calls[0] & os.O_NOFOLLOW
`,
      );
    },
  );
  it("bounds regular reads and detects mutation during a read", () => {
    probe(
      fixture(),
      `
p = Path.home()/"watched"
p.write_bytes(b"a" * guard.MAX_FINGERPRINT_BYTES)
original_read = os.read
read_sizes = []
def mutate(fd, size):
    read_sizes.append(size)
    if len(read_sizes) == 1:
        p.write_bytes(b"b" * guard.MAX_FINGERPRINT_BYTES)
    return original_read(fd, size)
guard.os.read = mutate
try:
    guard._digest(p)
except guard.FingerprintError:
    pass
else:
    raise AssertionError("a changing file was accepted")
assert read_sizes and max(read_sizes) <= 65536
assert sum(read_sizes) <= guard.MAX_FINGERPRINT_BYTES + 1
`,
    );
  });
  it.each(["SIGINT", "SIGTERM"])(
    "cancels %s during preflight with zero children",
    (name) => {
      const result = probe(
        fixture(),
        `
marker = Path.home()/"child-started"
def cancel(*args):
    signal.raise_signal(signal.${name})
    raise AssertionError("preflight cancellation was ignored")
guard.fingerprint = cancel
code = guard.main(["--", sys.executable, "-I", "-c", "from pathlib import Path; Path.home().joinpath('child-started').write_text('started')"])
assert code == 128 + signal.${name}, code
assert not marker.exists()
assert guard._CHILD is None
`,
      );
      expect(result.stderr).toContain("cancelled during preflight");
    },
  );
  it("does not report interrupted postflight as successful verification", () => {
    const result = probe(
      fixture(),
      `
calls = []
def fingerprint(*args):
    calls.append(1)
    if len(calls) == 2:
        signal.raise_signal(signal.SIGINT)
    return {}
guard.fingerprint = fingerprint
code = guard.main(["--", sys.executable, "-I", "-c", "raise SystemExit(17)"])
assert code == 130, code
assert guard._CHILD is None
`,
    );
    expect(result.stderr).toContain("cancelled during postflight");
    expect(result.stderr).toContain("child exit 17");
  });
  it.each(["SIGINT", "SIGTERM"])(
    "reaps an externally cancelled %s preflight process before any child starts",
    (name) => {
      probe(
        fixture(),
        `
import select, subprocess, textwrap
marker = Path.home()/"native-child-started"
script = textwrap.dedent("""
import importlib.util, os, sys, time
from pathlib import Path
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("guard", "scripts/assert-owner-untouched.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
def waiting(*args):
    print("preflight-ready:" + str(os.getpid()), flush=True)
    time.sleep(30)
    return {}
guard.fingerprint = waiting
raise SystemExit(guard.main(["--", sys.executable, "-I", "-c", "from pathlib import Path; Path.home().joinpath('native-child-started').write_text('started')"]))
""")
owned = subprocess.Popen([sys.executable, "-I", "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    assert select.select([owned.stdout], [], [], 1.5)[0], "missing bounded readiness"
    assert owned.stdout.readline().strip() == f"preflight-ready:{owned.pid}"
    owned.send_signal(signal.${name})
    stdout, stderr = owned.communicate(timeout=1.5)
    assert owned.returncode == 128 + signal.${name}, (owned.returncode, stderr)
    assert "cancelled during preflight" in stderr
    assert not marker.exists()
finally:
    if owned.poll() is None:
        owned.kill()
    owned.wait(timeout=1)
assert owned.poll() is not None, "exact owned process was not reaped"
`,
      );
    },
  );
  it.each(["S_IFSOCK", "S_IFCHR", "S_IFBLK"])(
    "fingerprints %s metadata without opening a stream",
    (kind) => {
      probe(
        fixture(),
        `
from types import SimpleNamespace
p = Path.home()/"special"
p.write_text("fixture")
regular = p.lstat()
fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_rdev", "st_size", "st_mtime_ns", "st_ctime_ns")
info = SimpleNamespace(**{key: getattr(regular, key) for key in fields})
info.st_mode = stat.${kind} | 0o600
guard.Path.lstat = lambda self: info
def forbidden(*args, **kwargs):
    raise AssertionError("a special stream was opened")
guard.os.open = forbidden
before = guard._digest(p)
assert before.startswith("special:")
info.st_mode = stat.${kind} | 0o400
assert guard._digest(p) != before
`,
      );
    },
  );
  it("fails closed on unreadable preflight without spawning a child", () => {
    const result = probe(
      fixture(),
      `
marker = Path.home()/"child-started"
def unreadable(*args):
    raise guard.FingerprintError("fixture unreadable")
guard.fingerprint = unreadable
assert guard.main(["--", sys.executable, "-I", "-c", "from pathlib import Path; Path.home().joinpath('child-started').write_text('started')"]) == 2
assert not marker.exists()
`,
    );
    expect(result.stderr).toContain(
      "verification incomplete; no child spawned",
    );
  });
  it("retains directory symlinks in a protected recursive tree", () => {
    const home = fixture();
    const dir = path.join(home, ".farol/state");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync("missing-directory", path.join(dir, "link"));
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'.farol/state/link'; p.unlink(); p.symlink_to('different-directory')",
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
  });
  it("prevents spawn for an already pending preflight signal", () => {
    probe(
      fixture(),
      `
marker = Path.home()/"child-started"
old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
try:
    def pending(*args):
        os.kill(os.getpid(), signal.SIGINT)
        return {}
    guard.fingerprint = pending
    assert guard.main(["--", sys.executable, "-I", "-c", "from pathlib import Path; Path.home().joinpath('child-started').write_text('started')"]) == 130
    assert not marker.exists()
    assert signal.sigwait({signal.SIGINT}) == signal.SIGINT
finally:
    signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
`,
    );
  });
  it("restores the original signal mask in the actual command child", () => {
    const result = run(
      fixture(),
      "import signal; blocked=signal.pthread_sigmask(signal.SIG_BLOCK, set()); assert signal.SIGINT not in blocked and signal.SIGTERM not in blocked",
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
  it("retains a refused signal relay until the exact child is reaped", () => {
    const result = probe(
      fixture(),
      `
import errno
original_spawn = guard._spawn_child
owned = []
def spawned(command):
    original_spawn(command)
    owned.append(guard._CHILD)
    def refused(signum):
        raise PermissionError(errno.EPERM, "fixture relay refused")
    guard._CHILD.send_signal = refused
    signal.raise_signal(signal.SIGTERM)
guard._spawn_child = spawned
assert guard.main(["--", sys.executable, "-I", "-c", "import time; time.sleep(0.15)"]) == 2
assert len(owned) == 1 and owned[0].returncode == 0
assert owned[0].poll() == 0
assert guard._CHILD is None
`,
    );
    expect(result.stderr).toContain("cancellation relay refused; child exit 0");
  });
  it("preserves a child signal exit", () => {
    const result = run(
      fixture(),
      "import os, signal; os.kill(os.getpid(), signal.SIGTERM)",
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(143);
  });
});
