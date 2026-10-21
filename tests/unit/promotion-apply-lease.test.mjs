import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controlled launcher/owner composition only. The actual helper bytes are read
// and verified, but no Python installer, native lease or installation is run.
const fake = vi.hoisted(() => ({
  spawn: vi.fn(),
  transfer: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}));
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual("node:child_process")),
  spawn: fake.spawn,
}));
vi.mock("../../tooling/promotion-lease.mjs", async () => ({
  ...(await vi.importActual("../../tooling/promotion-lease.mjs")),
  createPromotionLeaseTransfer: fake.transfer,
  acquirePromotionLease: fake.acquire,
  verifyPromotionLease: async () => true,
  releasePromotionLease: fake.release,
}));
vi.mock("../../tooling/promotion-obligations.mjs", async () => ({
  ...(await vi.importActual("../../tooling/promotion-obligations.mjs")),
  activationObligations: async (userData) => ({
    userData,
    drained: true,
    obligations: [],
    unreadable: [],
    changed: [],
  }),
}));
import { runPromotionApply } from "../../tooling/promotion-apply.mjs";
import { runPromotionCli } from "../../tooling/promote-preview.mjs";

let lease;
let transfer;
let child;
let stdinBytes;
let requestBytes;
let spawned;
let resolveSpawned;
const roots = [];
const turn = () => new Promise((resolve) => setImmediate(resolve));
function sink(chunks) {
  return new Writable({
    write(chunk, _encoding, done) {
      chunks?.push(Buffer.from(chunk));
      done();
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  stdinBytes = [];
  requestBytes = [];
  spawned = new Promise((resolve) => {
    resolveSpawned = resolve;
  });
  lease = { file: "/private/controlled/farol-state/promotion.lease" };
  transfer = {
    descriptor: 31,
    identity: { device: "10", inode: "30" },
    verify: vi.fn(async () => true),
    release: vi.fn(),
  };
  fake.acquire.mockResolvedValue(lease);
  fake.release.mockResolvedValue(undefined);
  fake.transfer.mockImplementation(async (candidate) => {
    if (candidate !== lease) throw new Error("PROMOTION_LEASE_NOT_HELD");
    return transfer;
  });
  fake.spawn.mockImplementation(() => {
    child = new EventEmitter();
    child.pid = 12345;
    child.stdin = sink(stdinBytes);
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdio = [
      child.stdin,
      child.stdout,
      child.stderr,
      sink(requestBytes),
      sink(),
      sink(),
      null,
      null,
    ];
    child.kill = vi.fn(() => true);
    resolveSpawned(child);
    return child;
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
function request(extra = {}) {
  return {
    home: "/controlled/no-install-home",
    source: "/controlled/no-install-source",
    artifactSha256: "0".repeat(64),
    receiptText: '{"operation":"applied"}',
    lease,
    timeoutMs: 1000,
    ...extra,
  };
}
async function started() {
  await spawned;
  expect(fake.spawn).toHaveBeenCalledTimes(1);
  await turn();
  return child;
}
function close(code = 0, signal = null) {
  child.emit("close", code, signal);
}

describe("promotion inherits the original lease and owns the original child lifetime", () => {
  it.each([
    ["/Applications/Farol.app", "shared"],
    ["/controlled/no-install-home/Applications/Farol.app", "legacy"],
    [undefined, "legacy"],
  ])(
    "sends explicit location for %s without native installation",
    async (destination, expected) => {
      const operation = runPromotionApply(request({ destination }));
      await started();
      expect(
        JSON.parse(Buffer.concat(requestBytes).toString()).installLocation,
      ).toBe(expected);
      child.stdout.write("FAROL_PROMOTION_OK\n");
      close();
      await operation;
    },
  );
  it("refuses an arbitrary promotion path before transferring the original lease", async () => {
    await expect(
      runPromotionApply(request({ destination: "/workspace/Farol.app" })),
    ).rejects.toThrow("PROMOTION_DESTINATION_OUTSIDE_OWNER_APPLICATIONS");
    expect(fake.transfer).not.toHaveBeenCalled();
    expect(fake.spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "inherits exact fd6 and preserves fd0..5 with fd7 ignored (test hook %s)",
    async (testHook) => {
      let closed;
      const operation = runPromotionApply(
        request({
          ...(testHook ? { afterParentOpened: async () => undefined } : {}),
          onChildStarted: (original) => {
            closed = original;
            expect(stdinBytes).toHaveLength(0);
            expect(requestBytes).toHaveLength(0);
          },
        }),
      );
      await started();
      const options = fake.spawn.mock.calls[0][2];
      expect(options.stdio).toEqual([
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        testHook ? "pipe" : "ignore",
        testHook ? "pipe" : "ignore",
        31,
        "ignore",
      ]);
      expect(JSON.parse(Buffer.concat(requestBytes).toString())).toMatchObject({
        lease: { file: lease.file, ...transfer.identity },
        testHook,
      });
      const helper = await fs.readFile(
        new URL("../../tooling/promotion-apply.py", import.meta.url),
      );
      expect(Buffer.concat(stdinBytes)).toEqual(helper);
      expect(createHash("sha256").update(helper).digest("hex")).toHaveLength(
        64,
      );
      child.stdout.write("FAROL_PROMOTION_OK\n");
      close();
      await operation;
      await expect(closed).resolves.toEqual({ code: 0, signal: null });
      expect(transfer.release).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "inherits the original updater descriptor at fd7 without moving fd0..6 (test hook %s)",
    async (testHook) => {
      const originalUpdaterDescriptor = 47;
      const operation = runPromotionApply(
        request({
          updaterLockDescriptor: originalUpdaterDescriptor,
          ...(testHook ? { afterParentOpened: async () => undefined } : {}),
        }),
      );
      await started();
      expect(fake.spawn.mock.calls[0][2].stdio).toEqual([
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        testHook ? "pipe" : "ignore",
        testHook ? "pipe" : "ignore",
        transfer.descriptor,
        originalUpdaterDescriptor,
      ]);
      child.stdout.write("FAROL_PROMOTION_OK\n");
      close();
      await operation;
      expect(transfer.release).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "47", null])(
    "refuses an invalid updater descriptor %j before lease transfer or spawn",
    async (updaterLockDescriptor) => {
      await expect(
        runPromotionApply(request({ updaterLockDescriptor })),
      ).rejects.toThrow("PROMOTION_APPLY_INPUT_INVALID");
      expect(fake.transfer).not.toHaveBeenCalled();
      expect(fake.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, {}, "closed-handle", { file: "/copied/lease" }])(
    "refuses missing/copied/unheld original capability %j before spawn",
    async (candidate) => {
      await expect(
        runPromotionApply(request({ lease: candidate })),
      ).rejects.toThrow("PROMOTION_LEASE_NOT_HELD");
      expect(fake.spawn).not.toHaveBeenCalled();
    },
  );

  it("rechecks original descriptor/current identity after reading exact helper and before spawn", async () => {
    transfer.verify.mockResolvedValue(false);
    await expect(runPromotionApply(request())).rejects.toThrow(
      "PROMOTION_LEASE_LOST",
    );
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("preserves original child error and waits for its terminal close", async () => {
    let settled = false;
    const error = new Error("original-child-error");
    const operation = runPromotionApply(request()).catch((observed) => {
      settled = true;
      return observed;
    });
    await started();
    child.emit("error", error);
    await turn();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    close(null, "SIGKILL");
    expect(await operation).toBe(error);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["stdin", "request", "stdout"])(
    "retains %s pipe failure until the same child closes",
    async (stream) => {
      const error = new Error("original-pipe-failure");
      let settled = false;
      const operation = runPromotionApply(request()).catch((observed) => {
        settled = true;
        return observed;
      });
      await started();
      (stream === "request" ? child.stdio[3] : child[stream]).emit(
        "error",
        error,
      );
      await turn();
      expect(settled).toBe(false);
      close(79);
      expect(await operation).toBe(error);
      expect(child.kill).toHaveBeenCalledTimes(1);
    },
  );

  it("registration failure sends no executable/request bytes and settles only the original child", async () => {
    const error = new Error("owner-registration-failure");
    const operation = runPromotionApply(
      request({
        onChildStarted: () => {
          throw error;
        },
      }),
    ).catch((observed) => observed);
    await started();
    expect(stdinBytes).toHaveLength(0);
    expect(requestBytes).toHaveLength(0);
    expect(child.kill).toHaveBeenCalledTimes(1);
    close(null, "SIGKILL");
    expect(await operation).toBe(error);
  });

  it.each([
    () => 1,
    async () => {
      throw new Error("unconfirmed-async-owner");
    },
  ])(
    "refuses a non-synchronous registration sink before sending effect bytes",
    async (onChildStarted) => {
      const operation = runPromotionApply(request({ onChildStarted })).catch(
        (error) => error,
      );
      await started();
      expect(stdinBytes).toHaveLength(0);
      expect(requestBytes).toHaveLength(0);
      close(null, "SIGKILL");
      expect(await operation).toMatchObject({
        message: "PROMOTION_APPLY_OWNER_INVALID",
      });
      expect(child.kill).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["FAROL_PROMOTION_", "FAROL_PROMOTION_OK\nFAROL_PROMOTION_OK\n", ""])(
    "never upgrades partial, duplicate or lost success acknowledgement %j",
    async (reply) => {
      const operation = runPromotionApply(request()).catch((error) => error);
      await started();
      child.stdout.write(reply);
      close();
      expect(await operation).toMatchObject({
        message: "PROMOTION_APPLY_REFUSED:0",
      });
      expect(fake.spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "deadline keeps original close pending and never retries (kill throws %s)",
    async (killThrows) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let closed;
      let terminal = false;
      const operation = runPromotionApply(
        request({
          onChildStarted: (original) => {
            closed = original;
            void original.then(() => {
              terminal = true;
            });
          },
        }),
      ).catch((error) => error);
      await started();
      if (killThrows)
        child.kill.mockImplementation(() => {
          throw new Error("original-kill-unconfirmed");
        });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await operation).toMatchObject({
        message: "PROMOTION_APPLY_OUTCOME_UNKNOWN",
      });
      expect(terminal).toBe(false);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(fake.spawn).toHaveBeenCalledTimes(1);
      close(null, "SIGKILL");
      await expect(closed).resolves.toEqual({ code: null, signal: "SIGKILL" });
    },
  );

  it("uses the same deadline for a hook still pending after original child close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const operation = runPromotionApply(
      request({ afterParentOpened: () => new Promise(() => {}) }),
    ).catch((error) => error);
    await started();
    child.stdio[4].emit("data", Buffer.from("R"));
    await turn();
    close(79);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await operation).toMatchObject({
      message: "PROMOTION_APPLY_OUTCOME_UNKNOWN",
    });
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });
});

async function cli() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-promotion-owner-control-"),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const candidateRoot = path.join(root, "candidate");
  const app = path.join(candidateRoot, "_output/package/Farol.app");
  await fs.mkdir(path.join(home, "Applications"), {
    recursive: true,
    mode: 0o755,
  });
  await fs.mkdir(app, { recursive: true });
  const identity = {
    commit: "c".repeat(40),
    treeDigest: "d".repeat(64),
    dirty: false,
  };
  await fs.writeFile(
    path.join(path.dirname(app), "artifact.json"),
    JSON.stringify({
      schema: 6,
      product: "Farol",
      version: "0.1.0-preview.0",
      buildId: "b".repeat(64),
      artifactPath: app,
      artifactSha256: "0".repeat(64),
      sourceCommit: identity.commit,
      sourceTreeDigest: identity.treeDigest,
      sourceDirty: false,
    }),
    { mode: 0o600 },
  );
  const stdout = [];
  const stderr = [];
  const operation = runPromotionCli(
    ["--apply", "--destination", path.join(home, "Applications/Farol.app")],
    {
      home,
      candidateRoot,
      sourceIdentity: () => identity,
      verify: async () => ({ status: 0, output: "controlled verifier" }),
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    },
  );
  return { operation, stdout, stderr };
}

describe("actual promotion owner release composition (effect adapter controlled)", () => {
  it("releases the original lease after terminal success", async () => {
    const fixture = await cli();
    await started();
    expect(fake.release).not.toHaveBeenCalled();
    child.stdout.write("FAROL_PROMOTION_OK\n");
    close();
    expect(await fixture.operation).toBe(0);
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it("retains original owner lease on child error until terminal failure", async () => {
    const fixture = await cli();
    await started();
    child.emit("error", new Error("original-child-unconfirmed"));
    await turn();
    expect(fake.release).not.toHaveBeenCalled();
    close(79);
    expect(await fixture.operation).toBe(1);
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it("bounded UNKNOWN retains original lease until late original close without replay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fixture = await cli();
    await started();
    child.kill.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await fixture.operation).toBe(1);
    expect(fixture.stderr.join("")).toContain(
      "PROMOTION_APPLY_OUTCOME_UNKNOWN",
    );
    expect(fake.release).not.toHaveBeenCalled();
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    close(null, "SIGKILL");
    await turn();
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(lease);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });

  it("releases normally when helper preflight refuses before any child exists", async () => {
    transfer.verify.mockResolvedValue(false);
    const fixture = await cli();
    expect(await fixture.operation).toBe(1);
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it("releases normally when spawning fails without an original child", async () => {
    const error = new Error("original-spawn-failure");
    fake.spawn.mockImplementation(() => {
      throw error;
    });
    const fixture = await cli();
    expect(await fixture.operation).toBe(1);
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(lease);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.stderr.join("")).toContain(error.message);
  });
});

const helperPath = path.resolve(
  import.meta.dirname,
  "../../tooling/promotion-apply.py",
);
const guardProgram = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("promotion", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
if sys.argv[3] == "closed":
    os.close(6)
try:
    helper.verify_inherited_lease({"lease": json.loads(sys.argv[2])})
except helper.Refusal as error:
    raise SystemExit(error.status)
print("DESCRIPTOR_GUARD_OK")
`;

describe("Python inherited descriptor identity guards (no installer run)", () => {
  it.each([
    "valid",
    "closed",
    "wrong-inode",
    "wrong-device",
    "replacement",
    "symlink",
    "hardlink",
    "public-file",
    "public-parent",
  ])(
    "fences %s before any copy/publish function is called",
    async (scenario) => {
      const root = await fs.mkdtemp(
        path.join(
          await fs.realpath(os.tmpdir()),
          "farol-promotion-descriptor-only-",
        ),
      );
      roots.push(root);
      const parent = path.join(root, "farol-state");
      await fs.mkdir(parent, { mode: 0o700 });
      const file = path.join(parent, "promotion.lease");
      await fs.writeFile(file, "controlled descriptor only\n", { mode: 0o600 });
      const handle = await fs.open(file, "r+");
      try {
        const original = await handle.stat({ bigint: true });
        const identity = {
          file,
          device: original.dev.toString(),
          inode: original.ino.toString(),
        };
        if (scenario === "wrong-inode")
          identity.inode = (original.ino + 1n).toString();
        if (scenario === "wrong-device")
          identity.device = (original.dev + 1n).toString();
        if (scenario === "replacement" || scenario === "symlink") {
          await fs.rename(file, `${file}.original`);
          if (scenario === "replacement")
            await fs.writeFile(file, "replacement", { mode: 0o600 });
          else await fs.symlink(`${file}.original`, file);
        }
        if (scenario === "hardlink") await fs.link(file, `${file}.second`);
        if (scenario === "public-file") await fs.chmod(file, 0o644);
        if (scenario === "public-parent") await fs.chmod(parent, 0o755);
        const result = spawnSync(
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            "-B",
            "-c",
            guardProgram,
            helperPath,
            JSON.stringify(identity),
            scenario,
          ],
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe",
              "ignore",
              "ignore",
              "ignore",
              handle.fd,
            ],
            encoding: "utf8",
            timeout: 5000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(scenario === "valid" ? 0 : 76);
        expect(result.stdout).toBe(
          scenario === "valid" ? "DESCRIPTOR_GUARD_OK\n" : "",
        );
      } finally {
        await handle.close();
      }
    },
  );
});

// CONTROLLED_PORTABLE_POSIX proof on Linux, never the production Darwin
// O_EXLOCK acquisition route. A subreaper confirms both exact disposable child
// exits; the original flock is inherited at fd6 and is never unlocked/reacquired
// by the worker. Only the helper's non-mutating descriptor guard is invoked.
const inheritanceProgram = `
import ctypes, errno, fcntl, json, os, signal, subprocess, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "subreaper unavailable")
file, mode, helper_path = sys.argv[1:]
fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW)
if fd != 6:
    os.dup2(fd, 6, inheritable=True)
    os.close(fd)
else:
    os.set_inheritable(6, True)
info = os.fstat(6)
identity = json.dumps({"file": file, "device": str(info.st_dev), "inode": str(info.st_ino)})
ready_r, ready_w = os.pipe()
finish_r, finish_w = os.pipe()
worker_program = r'''
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("promotion", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.verify_inherited_lease({"lease": json.loads(sys.argv[2])})
ready, finish = int(sys.argv[3]), int(sys.argv[4])
os.write(ready, (str(os.getpid()) + "\\n").encode())
os.close(ready)
os.read(finish, 1)
os.close(finish)
os._exit(0)
'''
owner = os.fork()
if owner == 0:
    os.close(ready_r)
    os.close(finish_w)
    fcntl.flock(6, fcntl.LOCK_EX | fcntl.LOCK_NB)
    subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-B", "-c", worker_program, helper_path, identity, str(ready_w), str(finish_r)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        pass_fds=(6, ready_w, finish_r))
    os.close(ready_w)
    os.close(finish_r)
    if mode == "parent-death":
        os.kill(os.getpid(), signal.SIGKILL)
    os.close(6)  # normal parent release closes only; no LOCK_UN
    os._exit(0)
os.close(6)
os.close(ready_w)
os.close(finish_r)
worker = None
probe = None
try:
    waited, owner_status = os.waitpid(owner, 0)
    assert waited == owner
    assert os.waitstatus_to_exitcode(owner_status) == (-signal.SIGKILL if mode == "parent-death" else 0)
    raw = bytearray()
    while not raw.endswith(b"\\n"):
        chunk = os.read(ready_r, 1)
        assert chunk, "worker did not validate inherited descriptor"
        raw.extend(chunk)
    worker = int(raw)
    probe = os.open(file, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise AssertionError("original lease released before worker terminal exit")
    os.write(finish_w, b"C")
    waited, worker_status = os.waitpid(worker, 0)
    assert waited == worker and os.waitstatus_to_exitcode(worker_status) == 0
    worker = None
    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("ORIGINAL_LEASE_HELD_UNTIL_WORKER_EXIT:" + mode)
finally:
    os.close(finish_w)
    os.close(ready_r)
    if probe is not None:
        os.close(probe)
    if worker is not None:
        try: os.kill(worker, signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(worker, 0)
    else:
        # Any early failed, adopted worker belongs to this isolated subreaper.
        # Preserve its terminal status and do not leave it for the host's init.
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
`;

describe.skipIf(process.platform !== "linux")(
  "controlled Linux POSIX original lease lifetime",
  () => {
    it.each(["parent-release", "parent-death"])(
      "keeps the original kernel lock through %s until terminal worker exit",
      async (mode) => {
        const root = await fs.mkdtemp(
          path.join(
            await fs.realpath(os.tmpdir()),
            "farol-promotion-posix-only-",
          ),
        );
        roots.push(root);
        const parent = path.join(root, "farol-state");
        await fs.mkdir(parent, { mode: 0o700 });
        const file = path.join(parent, "promotion.lease");
        await fs.writeFile(file, "controlled POSIX lease only\n", {
          mode: 0o600,
        });
        const result = spawnSync(
          "/usr/bin/python3",
          ["-I", "-S", "-B", "-c", inheritanceProgram, file, mode, helperPath],
          {
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 16 * 1024,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(
          `ORIGINAL_LEASE_HELD_UNTIL_WORKER_EXIT:${mode}\n`,
        );
      },
    );
  },
);
