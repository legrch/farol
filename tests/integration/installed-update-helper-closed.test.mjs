import childProcess, { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import {
  captureInstalledProcessStart,
  startInstalledUpdateHelper,
} from "../../src/modules/release/infra/native/installed-update-helper.ts";

// Native evidence is limited to disposable bundle/state trees and owned Python
// children. No installed app, real profile, provider, or relaunch is exercised.
const helper = path.join(process.cwd(), "resources/native/update_helper.py");
const roots = [];
const children = [];
const handles = new Set();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inode = (stat) => ({ device: String(stat.dev), inode: String(stat.ino) });

function observe(child) {
  let output = "";
  let error = "";
  let failure = null;
  const exited = new Promise((resolve) => {
    child.once("error", (value) => {
      failure = value;
    });
    child.stdout?.on("data", (data) => {
      output += data.toString();
      if (output.length > 8192) {
        failure = new Error("OUTPUT_LIMIT");
        child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (data) => {
      error += data.toString();
      if (error.length > 8192) {
        failure = new Error("ERROR_LIMIT");
        child.kill("SIGKILL");
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, output, error, failure });
    });
  });
  const deadline = setTimeout(() => {
    failure = new Error("CHILD_DEADLINE");
    child.kill("SIGKILL");
  }, 8000);
  children.push({ child, exited });
  return exited;
}

async function python(script, args = [], descriptor) {
  const child = spawn(
    "/usr/bin/python3",
    ["-I", "-S", "-B", "-c", script, ...args],
    {
      stdio:
        descriptor === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", descriptor],
    },
  );
  const result = await observe(child);
  if (result.failure) throw result.failure;
  return result;
}

async function opened(file) {
  const handle = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW);
  handles.add(handle);
  return handle;
}
async function close(handle) {
  if (handles.delete(handle)) await handle.close();
}
async function locked(file, shared = false) {
  const handle = await opened(file);
  // This child locks the inherited open description, then exits normally.
  // The Node fixture retains the same description, not a replacement lease.
  const result = await python(
    `import fcntl; fcntl.flock(3, fcntl.${shared ? "LOCK_SH" : "LOCK_EX"} | fcntl.LOCK_NB)`,
    [],
    handle.fd,
  );
  expect(result.code, result.error).toBe(0);
  return handle;
}
async function isLocked(file) {
  const result = await python(
    "import fcntl, os, sys\nf = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)\ntry:\n fcntl.flock(f, fcntl.LOCK_SH | fcntl.LOCK_NB)\nexcept BlockingIOError:\n sys.exit(23)\nsys.exit(0)",
    [file],
  );
  expect([0, 23], result.error).toContain(result.code);
  return result.code === 23;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { child, exited } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
  for (const handle of [...handles]) await close(handle);
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function bundle(at, version, buildId, payload) {
  await fs.mkdir(path.join(at, "Contents/Resources/app"), { recursive: true });
  await fs.writeFile(
    path.join(at, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.farol.next.preview</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  await fs.writeFile(
    path.join(at, "Contents/Resources/app/build-identity.json"),
    JSON.stringify({ bundleId: "local.farol.next.preview", version, buildId }),
  );
  await fs.writeFile(path.join(at, "Contents/payload"), payload);
  return { digest: await treeDigest(at), version, buildId };
}

async function fixture({ running = false, lock = "exclusive" } = {}) {
  const startedAt = new Date().toISOString();
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-closed-helper-"),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const app = path.join(home, "Applications/Farol.app");
  const profile = path.join(
    home,
    "Library/Application Support/Farol Next Preview",
  );
  const state = path.join(profile, "farol-next-state");
  const operationId = "c".repeat(32);
  const op = path.join(profile, "installed-updates", operationId);
  const source = await bundle(app, "0.1.0", "1".repeat(64), "N");
  const target = await bundle(
    path.join(op, "staged.app"),
    "0.2.0",
    "2".repeat(64),
    "N+1",
  );
  await fs.chmod(home, 0o700);
  await fs.mkdir(state, { mode: 0o700 });
  const leasePath = path.join(state, "promotion.lease");
  await fs.writeFile(leasePath, "retained owner record", { mode: 0o600 });
  const lease =
    lock === "none"
      ? await opened(leasePath)
      : await locked(leasePath, lock === "shared");
  const original = spawn(
    "/usr/bin/python3",
    ["-I", "-S", "-B", "-c", "import sys; sys.stdin.buffer.read(1)"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const originalExit = observe(original);
  await new Promise((resolve, reject) => {
    original.once("spawn", resolve);
    original.once("error", reject);
  });
  const processStart = await captureInstalledProcessStart(original.pid);
  if (!running) {
    original.stdin.end();
    expect((await originalExit).code).toBe(0);
  }
  const quit = {
    schema: 1,
    at: new Date().toISOString(),
    drained: true,
    unconfirmed: [],
  };
  const quitBytes = Buffer.from(JSON.stringify(quit) + "\n");
  await fs.writeFile(path.join(state, "last-quit.json"), quitBytes, {
    mode: 0o600,
  });
  const request = {
    action: "apply",
    operationId,
    source,
    target,
    drain: {
      status: "reconciled",
      acceptedSource: source.buildId,
      acceptedTarget: target.buildId,
    },
    pid: original.pid,
    processStart,
    waitSeconds: 2,
    relaunch: false,
    predecessor: {
      kind: "confirmed_closed",
      startedAt,
      lastQuitSha256: hash(quitBytes),
      stateIdentity: inode(await fs.stat(state, { bigint: true })),
    },
  };
  return {
    root,
    home,
    app,
    state,
    profile,
    op,
    request,
    quit,
    lease,
    leasePath,
    leaseIdentity: inode(await lease.stat({ bigint: true })),
  };
}

function continuation(f) {
  const {
    operationId,
    action,
    source,
    target,
    pid,
    processStart,
    predecessor,
  } = f.request;
  return (
    JSON.stringify({
      schema: "farol.installed-update-continue/1",
      operationId,
      action,
      source,
      target,
      pid,
      processStart,
      predecessor,
      leaseIdentity: f.leaseIdentity,
    }) + "\n"
  );
}
async function launch(f, descriptor = f.lease.fd) {
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", helper], {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", descriptor, "pipe"],
  });
  const exited = observe(child);
  const ack = new Promise((resolve, reject) => {
    let data = "";
    child.stdio[4].on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 4096) reject(new Error("ACK_LIMIT"));
    });
    child.stdio[4].on("error", reject);
    child.stdio[4].on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (error) {
        reject(error);
      }
    });
  });
  child.stdio[3].end(
    JSON.stringify({
      schema: "farol.installed-update/1",
      ...f.request,
      home: f.home,
      leaseIdentity: f.leaseIdentity,
    }),
  );
  return { child, ack, exited };
}
async function unchanged(f) {
  expect(await fs.readFile(path.join(f.app, "Contents/payload"), "utf8")).toBe(
    "N",
  );
  expect(
    await fs.readFile(path.join(f.op, "staged.app/Contents/payload"), "utf8"),
  ).toBe("N+1");
  await expect(fs.lstat(path.join(f.op, "journal.json"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
}
async function refused(f, launched) {
  const ack = await launched.ack;
  expect(ack).toMatchObject({
    phase: "refused",
    operationId: f.request.operationId,
  });
  const result = await launched.exited;
  expect(result.code, result.error).toBe(70);
  await unchanged(f);
  return ack.error;
}

describe("closed installed helper (disposable native filesystem and child fixtures)", () => {
  it("keeps the same exclusive lock after parent close and enters the existing atomic apply once", async () => {
    const f = await fixture();
    const sourceInode = inode(await fs.stat(f.app, { bigint: true }));
    const targetInode = inode(
      await fs.stat(path.join(f.op, "staged.app"), { bigint: true }),
    );
    const launched = await launch(f);
    expect(await launched.ack).toMatchObject({
      phase: "closed_predecessor_ready",
      predecessor: f.request.predecessor,
      leaseIdentity: f.leaseIdentity,
    });
    await unchanged(f);
    await expect(
      fs.lstat(path.join(f.profile, "installed-updates/lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await close(f.lease);
    expect(await isLocked(f.leasePath)).toBe(true);
    launched.child.stdio[6].end(continuation(f));
    const result = await launched.exited;
    expect(result.code, result.error + result.output).toBe(0);
    expect(JSON.parse(result.output).phase).toBe("verified");
    expect(inode(await fs.stat(f.app, { bigint: true }))).toEqual(targetInode);
    expect(
      inode(await fs.stat(path.join(f.op, "previous.app"), { bigint: true })),
    ).toEqual(sourceInode);
    expect(await treeDigest(f.app)).toBe(f.request.target.digest);
    expect(await treeDigest(path.join(f.op, "previous.app"))).toBe(
      f.request.source.digest,
    );
    expect(await isLocked(f.leasePath)).toBe(false);
    expect(await fs.readFile(f.leasePath, "utf8")).toBe(
      "retained owner record",
    );
  });

  it("connects the real helper to the TS transfer barrier with close-only parent release", async () => {
    const f = await fixture();
    const user = os.userInfo();
    vi.spyOn(os, "userInfo").mockReturnValue({ ...user, homedir: f.home });
    const nativeSpawn = childProcess.spawn;
    // Observe the real child, without replacing its process or pipe behavior.
    // afterEach retains this exact handle even if a later assertion fails.
    vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const child = nativeSpawn(...args);
      if (args[1]?.at(-1) === "-") observe(child);
      return child;
    });
    const release = vi.fn(async () => {
      await close(f.lease);
    });
    const result = await startInstalledUpdateHelper(helper, f.request, {
      readinessTimeoutMs: 5000,
      recordSpawn: async (operation) => {
        expect(operation.pid).toBeGreaterThan(1);
      },
      promotionLease: {
        descriptor: f.lease.fd,
        identity: f.leaseIdentity,
        verify: async () =>
          inode(await f.lease.stat({ bigint: true })).inode ===
            f.leaseIdentity.inode && (await isLocked(f.leasePath)),
        release,
      },
    });
    expect(["continued", "terminal"]).toContain(result.status);
    const completed = await result.operation.completion;
    expect(completed.code).toBe(0);
    expect(completed.protocolError).toBeNull();
    expect(completed.terminal?.phase).toBe("verified");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    "missing",
    "unheld",
    "shared",
    "crossed",
    "replaced",
    "hardlinked",
    "public-mode",
    "wrong-identity",
    "wrong-state",
  ])("refuses %s lease ownership before readiness", async (kind) => {
    const f = await fixture({
      lock:
        kind === "unheld" ? "none" : kind === "shared" ? "shared" : "exclusive",
    });
    let descriptor = f.lease.fd;
    if (kind === "missing") descriptor = "ignore";
    if (kind === "crossed") descriptor = (await opened(f.leasePath)).fd;
    if (kind === "replaced") {
      await fs.rename(f.leasePath, f.leasePath + ".old");
      await fs.writeFile(f.leasePath, "new", { mode: 0o600 });
    }
    if (kind === "hardlinked")
      await fs.link(f.leasePath, f.leasePath + ".link");
    if (kind === "public-mode") await fs.chmod(f.leasePath, 0o644);
    if (kind === "wrong-identity") f.leaseIdentity.inode = "0";
    if (kind === "wrong-state") f.request.predecessor.stateIdentity.inode = "0";
    await refused(f, await launch(f, descriptor));
  });

  it.each([
    "running-pid",
    "running-marker",
    "wrong-hash",
    "stale",
    "future",
    "dirty",
    "source",
    "target",
  ])("refuses %s closed proof or package before readiness", async (kind) => {
    const f = await fixture({ running: kind === "running-pid" });
    if (kind === "running-marker")
      await fs.writeFile(path.join(f.state, "running.json"), "{}", {
        mode: 0o600,
      });
    if (kind === "wrong-hash")
      f.request.predecessor.lastQuitSha256 = "0".repeat(64);
    if (["stale", "future", "dirty"].includes(kind)) {
      if (kind === "stale") f.quit.at = f.request.predecessor.startedAt;
      if (kind === "future") f.quit.at = "2999-01-01T00:00:00.000Z";
      if (kind === "dirty") f.quit.unconfirmed = ["owned-child"];
      const bytes = JSON.stringify(f.quit);
      await fs.writeFile(path.join(f.state, "last-quit.json"), bytes);
      f.request.predecessor.lastQuitSha256 = hash(bytes);
    }
    if (kind === "source") f.request.source.digest = "0".repeat(64);
    if (kind === "target") f.request.target.digest = "0".repeat(64);
    await refused(f, await launch(f));
  });

  it.each(["eof", "partial", "duplicate", "crossed", "timeout"])(
    "does not mutate after %s continuation",
    async (kind) => {
      const f = await fixture();
      f.request.waitSeconds = 1;
      const launched = await launch(f);
      expect((await launched.ack).phase).toBe("closed_predecessor_ready");
      await close(f.lease);
      const frame = continuation(f);
      if (kind !== "timeout")
        launched.child.stdio[6].end(
          kind === "eof"
            ? ""
            : kind === "partial"
              ? frame.slice(0, -2)
              : kind === "duplicate"
                ? frame + frame
                : frame.replace(f.request.operationId, "d".repeat(32)),
        );
      const result = await launched.exited;
      expect(result.code).toBe(70);
      await unchanged(f);
    },
  );

  it.each([
    "state",
    "lease",
    "quit",
    "source",
    "target",
    "update-root",
    "operation-root",
  ])(
    "rechecks %s after transfer readiness before any journal or exchange",
    async (kind) => {
      const f = await fixture();
      const launched = await launch(f);
      expect((await launched.ack).phase).toBe("closed_predecessor_ready");
      await close(f.lease);
      if (kind === "state") {
        await fs.rename(f.state, f.state + ".old");
        await fs.mkdir(f.state, { mode: 0o700 });
      }
      if (kind === "lease") {
        await fs.rename(f.leasePath, f.leasePath + ".old");
        await fs.writeFile(f.leasePath, "new", { mode: 0o600 });
      }
      if (kind === "quit")
        await fs.appendFile(path.join(f.state, "last-quit.json"), " ");
      if (kind === "update-root") {
        const update = path.join(f.profile, "installed-updates");
        await fs.rename(update, update + ".old");
        await fs.mkdir(update, { mode: 0o700 });
        f.op = path.join(update + ".old", f.request.operationId);
      }
      if (kind === "operation-root") {
        await fs.rename(f.op, f.op + ".old");
        await fs.mkdir(f.op, { mode: 0o700 });
        f.op += ".old";
      }
      if (kind === "source" || kind === "target")
        await fs.writeFile(
          path.join(
            kind === "source" ? f.app : path.join(f.op, "staged.app"),
            "Contents/changed",
          ),
          "changed",
        );
      launched.child.stdio[6].end(continuation(f));
      const result = await launched.exited;
      expect(result.code, result.error + result.output).toBe(70);
      await unchanged(f);
    },
  );

  it("preserves an operation record that appears after readiness", async () => {
    const f = await fixture();
    const launched = await launch(f);
    expect((await launched.ack).phase).toBe("closed_predecessor_ready");
    await close(f.lease);
    const journal = path.join(f.op, "journal.json");
    await fs.writeFile(journal, "retained other operation record", {
      mode: 0o600,
    });
    launched.child.stdio[6].end(continuation(f));
    const result = await launched.exited;
    expect(result.code, result.error + result.output).toBe(70);
    expect(await fs.readFile(journal, "utf8")).toBe(
      "retained other operation record",
    );
    expect(await treeDigest(f.app)).toBe(f.request.source.digest);
    expect(await treeDigest(path.join(f.op, "staged.app"))).toBe(
      f.request.target.digest,
    );
  });
});
