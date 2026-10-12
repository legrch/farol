import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import {
  acquirePromotionLease,
  releasePromotionLease,
} from "../../tooling/promotion-lease.mjs";

const helper = path.join(process.cwd(), "resources/native/update_helper.py");
const roots = [];
const children = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function bundle(at, version, buildId, contents) {
  await fs.mkdir(path.join(at, "Contents/Resources/app"), { recursive: true });
  await fs.writeFile(
    path.join(at, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.farol.next.preview</string><key>CFBundleShortVersionString</key><string>${version.split("-")[0]}</string></dict></plist>`,
  );
  await fs.writeFile(
    path.join(at, "Contents/Resources/app/build-identity.json"),
    JSON.stringify({ bundleId: "local.farol.next.preview", version, buildId }),
  );
  await fs.writeFile(path.join(at, "Contents/payload"), contents);
  return { digest: await treeDigest(at), version, buildId };
}
async function fixture(sourceVersion = "0.1.0", targetVersion = "0.1.1") {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-installed-update-"),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const applications = path.join(home, "Applications");
  const app = path.join(applications, "Farol.app");
  const operationId = "a".repeat(32);
  const op = path.join(
    home,
    "Library/Application Support/Farol Next Preview/installed-updates",
    operationId,
  );
  await fs.mkdir(applications, { recursive: true });
  await fs.mkdir(op, { recursive: true });
  await fs.chmod(home, 0o700);
  const source = await bundle(app, sourceVersion, "1".repeat(64), "N");
  const target = await bundle(
    path.join(op, "staged.app"),
    targetVersion,
    "2".repeat(64),
    "N+1",
  );
  const child = spawn("/bin/sleep", ["20"], { stdio: "ignore" });
  children.push(child);
  const started = await new Promise((resolve, reject) => {
    const poll = async () => {
      let ps;
      try {
        ps = spawn("/bin/ps", ["-p", String(child.pid), "-o", "lstart="]);
      } catch (error) {
        reject(error);
        return;
      }
      let output = "";
      ps.stdout.on("data", (data) => {
        output += data;
      });
      ps.on("close", () =>
        output.trim() ? resolve(output.trim()) : setTimeout(poll, 10),
      );
      ps.on("error", reject);
    };
    poll();
  });
  const state = path.join(
    home,
    "Library/Application Support/Farol Next Preview/farol-next-state",
  );
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.chmod(state, 0o700);
  await fs.writeFile(path.join(state, "promotion.lease"), "", { mode: 0o600 });
  await setMarker(state, child.pid, started);
  const request = {
    schema: "farol.installed-update/1",
    action: "apply",
    home,
    operationId,
    source,
    target,
    drain: {
      status: "reconciled",
      acceptedSource: source.buildId,
      acceptedTarget: target.buildId,
    },
    pid: child.pid,
    processStart: started,
    waitSeconds: 5,
    relaunch: false,
  };
  return { root, home, applications, app, op, state, request, child };
}
async function setMarker(state, pid, processStart) {
  await fs.writeFile(
    path.join(state, "running.json"),
    JSON.stringify({
      schema: 1,
      pid,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      bootTime: null,
      processStart,
    }),
    { mode: 0o600 },
  );
}
async function confirmQuit(f) {
  await fs.writeFile(
    path.join(f.state, "last-quit.json"),
    JSON.stringify({
      schema: 1,
      at: new Date().toISOString(),
      drained: true,
      unconfirmed: [],
    }),
    { mode: 0o600 },
  );
  await fs.unlink(path.join(f.state, "running.json"));
}
function observeHelper(child, expectTerminal = true) {
  children.push(child);
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Refusal tests consume only the terminal result.
  void ready.catch(() => {});
  const result = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let handoff = "";
    let failure;
    const stop = (error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const deadline = setTimeout(
      () => stop(new Error("helper test deadline")),
      10_000,
    );
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.length > 32_768) stop(new Error("helper output limit"));
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.length > 32_768) stop(new Error("helper error output limit"));
    });
    child.stdio[4].on("data", (data) => {
      handoff += data;
      if (handoff.length > 8192) stop(new Error("helper handoff limit"));
    });
    child.stdio[4].on("end", () => {
      try {
        const event = JSON.parse(handoff);
        if (event.phase !== "waiting_for_exit")
          throw new Error("helper refused readiness");
        resolveReady(event);
      } catch (error) {
        rejectReady(error);
      }
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (exitCode) => {
      clearTimeout(deadline);
      rejectReady(failure ?? new Error("helper exited before readiness"));
      if (failure) {
        reject(failure);
        return;
      }
      try {
        resolve({
          exitCode,
          result: expectTerminal ? JSON.parse(stdout) : null,
          stderr,
          handoff,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
  result.ready = ready;
  return result;
}
function invoke(request) {
  const code = readFileSync(helper);
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
    cwd: "/",
    env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const result = observeHelper(child);
  child.stdin.end(code);
  child.stdio[3].end(JSON.stringify(request));
  return result;
}
function invokeCrashAtExchange(request, side) {
  const program = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("update_helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
exchange = helper.exchange_checked
def interrupt(*args, **kwargs):
    if sys.argv[2] == "before":
        os._exit(91)
    exchange(*args, **kwargs)
    os._exit(92)
helper.exchange_checked = interrupt
helper.main()
`;
  const child = spawn(
    "/usr/bin/python3",
    ["-I", "-S", "-B", "-c", program, helper, side],
    {
      cwd: "/",
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const result = observeHelper(child, false);
  child.stdio[3].end(JSON.stringify(request));
  return result;
}
function invokeWithFakeOpen(request, log, captureArguments = false) {
  const program = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("update_helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
original = helper.subprocess.run
def run(command, *args, **kwargs):
    if command[0] == "/usr/bin/open":
        with open(sys.argv[2], "a", encoding="utf-8") as file:
            file.write(json.dumps(command) + "\\n" if sys.argv[3] == "arguments" else "open\\n")
        return type("Result", (), {"returncode": 0})()
    return original(command, *args, **kwargs)
helper.subprocess.run = run
helper.main()
`;
  const child = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      program,
      helper,
      log,
      captureArguments ? "arguments" : "count",
    ],
    {
      cwd: "/",
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const result = observeHelper(child);
  child.stdio[3].end(JSON.stringify(request));
  return result;
}
function invokeWithPostSwapCorruption(request, crashSide = "none") {
  const program = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("update_helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
original = helper.write_record
def corrupt_after_move(parent, name, record):
    original(parent, name, record)
    if name == "journal.json" and record["phase"] == "new_installed":
        with open(sys.argv[2] + "/Applications/Farol.app/Contents/payload", "wb") as file:
            file.write(b"corrupt")
helper.write_record = corrupt_after_move
exchange = helper.exchange_checked
swaps = 0
def interrupt_rollback(*args, **kwargs):
    global swaps
    swaps += 1
    if swaps == 2 and sys.argv[3] == "before":
        os._exit(91)
    exchange(*args, **kwargs)
    if swaps == 2 and sys.argv[3] == "after":
        os._exit(92)
helper.exchange_checked = interrupt_rollback
try:
    helper.run(json.loads(sys.stdin.read()))
except helper.Refusal as error:
    print(json.dumps({"phase": error.phase, "error": error.code}))
    raise SystemExit(70)
`;
  const child = spawn(
    "/usr/bin/python3",
    ["-I", "-S", "-B", "-c", program, helper, request.home, crashSide],
    { cwd: "/", stdio: ["pipe", "pipe", "pipe", "ignore", "pipe"] },
  );
  const result = observeHelper(child, crashSide === "none");
  child.stdin.end(JSON.stringify(request));
  return result;
}

async function phase(f, value) {
  await fs.writeFile(
    path.join(f.op, "journal.json"),
    JSON.stringify({
      schema: "farol.installed-update-journal/1",
      operationId: f.request.operationId,
      source: f.request.source,
      target: f.request.target,
      phase: value,
    }),
  );
}

describe("installed update helper", () => {
  for (const side of ["before", "after"]) {
    it(`keeps the fixed slot present across an interrupted apply exchange (${side})`, async () => {
      const f = await fixture();
      const pending = invokeCrashAtExchange(f.request, side);
      await pending.ready;
      await confirmQuit(f);
      f.child.kill("SIGTERM");
      expect((await pending).exitCode).toBe(side === "before" ? 91 : 92);
      expect((await fs.lstat(f.app)).isDirectory()).toBe(true);
      const recovered = await invoke({ ...f.request, action: "recover" });
      expect(recovered.result.phase).toBe(
        side === "before" ? "cancelled" : "verified",
      );
      expect(
        await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
      ).toBe(side === "before" ? "N" : "N+1");
      if (side === "after") {
        expect(
          await fs.readFile(
            path.join(f.op, "previous.app/Contents/payload"),
            "utf8",
          ),
        ).toBe("N");
        expect(
          (await invoke({ ...f.request, action: "recover" })).result.phase,
        ).toBe("verified");
      }
    });

    it(`keeps the fixed slot present across an interrupted rollback exchange (${side})`, async () => {
      const f = await fixture();
      const applied = invoke(f.request);
      await applied.ready;
      await confirmQuit(f);
      f.child.kill("SIGTERM");
      expect((await applied).result.phase).toBe("verified");
      const rollbackProcess = spawn("/bin/sleep", ["20"], { stdio: "ignore" });
      children.push(rollbackProcess);
      const started = execFileSync(
        "/bin/ps",
        ["-p", String(rollbackProcess.pid), "-o", "lstart="],
        { encoding: "utf8" },
      ).trim();
      await setMarker(f.state, rollbackProcess.pid, started);
      const rollback = invokeCrashAtExchange(
        {
          ...f.request,
          action: "rollback",
          pid: rollbackProcess.pid,
          processStart: started,
        },
        side,
      );
      await rollback.ready;
      await confirmQuit(f);
      rollbackProcess.kill("SIGTERM");
      expect((await rollback).exitCode).toBe(side === "before" ? 91 : 92);
      expect((await fs.lstat(f.app)).isDirectory()).toBe(true);
      expect(
        (await invoke({ ...f.request, action: "recover" })).result.phase,
      ).toBe("rolled_back");
      expect(
        await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
      ).toBe("N");
      expect(
        await fs.readFile(
          path.join(f.op, "failed.app/Contents/payload"),
          "utf8",
        ),
      ).toBe("N+1");
      expect(
        (await invoke({ ...f.request, action: "recover" })).result.phase,
      ).toBe("rolled_back");
    });
  }
  it("settles a live prepared recovery without launching the older source", async () => {
    const f = await fixture();
    const interrupted = invokeCrashAtExchange(f.request, "before");
    await interrupted.ready;
    await confirmQuit(f);
    f.child.kill("SIGTERM");
    expect((await interrupted).exitCode).toBe(91);
    const log = path.join(f.root, "open.log");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = spawn("/bin/sleep", ["20"], { stdio: "ignore" });
      children.push(current);
      const started = execFileSync(
        "/bin/ps",
        ["-p", String(current.pid), "-o", "lstart="],
        { encoding: "utf8" },
      ).trim();
      await setMarker(f.state, current.pid, started);
      const recovery = invokeWithFakeOpen(
        {
          ...f.request,
          action: "recover",
          pid: current.pid,
          processStart: started,
          relaunch: true,
        },
        log,
      );
      await recovery.ready;
      await confirmQuit(f);
      current.kill("SIGTERM");
      expect((await recovery).result.phase).toBe("cancelled");
      await expect(fs.lstat(log)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
    expect(
      (await invoke({ ...f.request, action: "recover" })).result.phase,
    ).toBe("cancelled");
  });
  it("replaces fixed NEW slot only after exact PID exits, preserves N, and rolls back", async () => {
    const f = await fixture();
    const pending = invoke(f.request);
    await pending.ready;
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
    await confirmQuit(f);
    f.child.kill("SIGTERM");
    expect((await pending).result.phase).toBe("verified");
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N+1");
    expect(
      await fs.readFile(
        path.join(f.op, "previous.app/Contents/payload"),
        "utf8",
      ),
    ).toBe("N");
    const rollbackProcess = spawn("/bin/sleep", ["20"], { stdio: "ignore" });
    children.push(rollbackProcess);
    const ps = spawn("/bin/ps", [
      "-p",
      String(rollbackProcess.pid),
      "-o",
      "lstart=",
    ]);
    let rollbackStart = "";
    ps.stdout.on("data", (data) => {
      rollbackStart += data;
    });
    await new Promise((resolve) => ps.on("close", resolve));
    await setMarker(f.state, rollbackProcess.pid, rollbackStart.trim());
    const launchLog = path.join(f.root, "rollback-open.log");
    const rollback = invokeWithFakeOpen(
      {
        ...f.request,
        action: "rollback",
        pid: rollbackProcess.pid,
        processStart: rollbackStart.trim(),
        relaunch: true,
      },
      launchLog,
    );
    await rollback.ready;
    await confirmQuit(f);
    rollbackProcess.kill("SIGTERM");
    expect((await rollback).result.phase).toBe("rolled_back");
    await expect(fs.lstat(launchLog)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
    expect(
      await fs.readFile(path.join(f.op, "failed.app/Contents/payload"), "utf8"),
    ).toBe("N+1");
  });

  it("restores N if final N+1 bytes fail verification after the swap", async () => {
    const f = await fixture();
    const pending = invokeWithPostSwapCorruption(f.request);
    await pending.ready;
    await confirmQuit(f);
    f.child.kill("SIGTERM");
    const outcome = await pending;
    expect(outcome).toMatchObject({
      exitCode: 70,
      result: { phase: "rolled_back", error: "target_verification" },
    });
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
    expect(
      await fs.readFile(path.join(f.op, "failed.app/Contents/payload"), "utf8"),
    ).toBe("corrupt");
    const rejected = JSON.parse(
      await fs.readFile(path.join(f.op, "rejected-target.json"), "utf8"),
    );
    const metadata = await fs.lstat(path.join(f.op, "failed.app"), {
      bigint: true,
    });
    expect(rejected).toEqual({
      schema: "farol.rejected-update-target/1",
      operationId: f.request.operationId,
      source: f.request.source,
      target: f.request.target,
      directoryIdentity: {
        device: String(metadata.dev),
        inode: String(metadata.ino),
      },
    });
  });

  for (const side of ["before", "after"]) {
    it(`refuses to displace unbound rejected target after rollback crashes ${side} exchange`, async () => {
      const f = await fixture();
      const pending = invokeWithPostSwapCorruption(f.request, side);
      await pending.ready;
      await confirmQuit(f);
      f.child.kill("SIGTERM");
      expect((await pending).exitCode).toBe(side === "before" ? 91 : 92);
      expect((await fs.lstat(f.app)).isDirectory()).toBe(true);
      const recovery = await invoke({ ...f.request, action: "recover" });
      expect(recovery.exitCode).not.toBe(0);
      expect(recovery.result.error).toBe("digest");
      expect(
        JSON.parse(await fs.readFile(path.join(f.op, "journal.json"), "utf8"))
          .phase,
      ).toBe("rollback_started");
      expect(
        await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
      ).toBe(side === "before" ? "corrupt" : "N");
      expect(
        await fs.readFile(
          path.join(f.op, "previous.app/Contents/payload"),
          "utf8",
        ),
      ).toBe(side === "before" ? "N" : "corrupt");
      await expect(
        fs.lstat(path.join(f.op, "failed.app")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("refuses bad digest, build identity and a foreign destination without moving N", async () => {
    for (const mutate of [
      (f) => {
        f.request.target.digest = "0".repeat(64);
      },
      (f) => {
        f.request.target.buildId = "3".repeat(64);
        f.request.drain.acceptedTarget = f.request.target.buildId;
      },
      async (f) => {
        await fs.writeFile(
          path.join(f.app, "Contents/Info.plist"),
          `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.foreign.app</string></dict></plist>`,
        );
        f.request.source.digest = await treeDigest(f.app);
      },
    ]) {
      const f = await fixture();
      await mutate(f);
      const outcome = await invoke(f.request);
      expect(outcome.exitCode).not.toBe(0);
      expect(
        await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
      ).toBe("N");
      await expect(
        fs.lstat(path.join(f.op, "previous.app")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("refuses wrong PID birth, running process deadline and symlinked parent", async () => {
    const f = await fixture();
    expect(
      (await invoke({ ...f.request, processStart: "wrong" })).result.error,
    ).toBe("run_marker_mismatch");
    expect((await invoke({ ...f.request, waitSeconds: 1 })).result.error).toBe(
      "process_running",
    );
    const pinned = f.applications + ".pinned";
    await fs.rename(f.applications, pinned);
    await fs.symlink(pinned, f.applications);
    expect((await invoke(f.request)).exitCode).not.toBe(0);
    expect(
      await fs.readFile(
        path.join(pinned, "Farol.app/Contents/payload"),
        "utf8",
      ),
    ).toBe("N");
  });

  it("recovers predecessor saved before install and finalizes after install without duplicate rename", async () => {
    const before = await fixture();
    await phase(before, "prepared");
    await fs.rename(before.app, path.join(before.op, "previous.app"));
    await confirmQuit(before);
    before.child.kill("SIGTERM");
    expect(
      (await invoke({ ...before.request, action: "recover" })).result.phase,
    ).toBe("rolled_back");
    expect(
      await fs.readFile(path.join(before.app, "Contents/payload"), "utf8"),
    ).toBe("N");
    const after = await fixture();
    await phase(after, "predecessor_saved");
    await fs.rename(after.app, path.join(after.op, "previous.app"));
    await fs.rename(path.join(after.op, "staged.app"), after.app);
    await confirmQuit(after);
    after.child.kill("SIGTERM");
    expect(
      (await invoke({ ...after.request, action: "recover" })).result.phase,
    ).toBe("verified");
    expect(
      (await invoke({ ...after.request, action: "recover" })).result.phase,
    ).toBe("verified");
    expect(
      await fs.readFile(
        path.join(after.op, "previous.app/Contents/payload"),
        "utf8",
      ),
    ).toBe("N");
  });

  it("refuses an injected destination and a stale quit receipt", async () => {
    const f = await fixture();
    const injected = await invoke({
      ...f.request,
      destination: path.join(f.root, "foreign.app"),
    });
    expect(injected.result.error).toBe("input");
    const pending = invoke(f.request);
    await pending.ready;
    await fs.writeFile(
      path.join(f.state, "last-quit.json"),
      JSON.stringify({
        schema: 1,
        at: "2020-01-01T00:00:00.000Z",
        drained: true,
        unconfirmed: [],
      }),
      { mode: 0o600 },
    );
    await fs.unlink(path.join(f.state, "running.json"));
    f.child.kill("SIGTERM");
    expect((await pending).result.error).toBe("quit_stale");
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
  });

  it("refuses a crash without the owner's confirmed quit receipt", async () => {
    const f = await fixture();
    const pending = invoke(f.request);
    await pending.ready;
    f.child.kill("SIGTERM");
    expect((await pending).result.error).toBe("run_marker_present");
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
  });

  it("refuses when the existing owner promotion lease is held", async () => {
    const f = await fixture();
    const lease = await acquirePromotionLease(
      path.dirname(f.state),
      "fixture",
      "promotion",
    );
    expect(lease).not.toBeNull();
    try {
      const pending = invoke(f.request);
      await pending.ready;
      await confirmQuit(f);
      f.child.kill("SIGTERM");
      expect((await pending).result.error).toBe("owner_lease_held");
      expect(
        await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
      ).toBe("N");
    } finally {
      if (lease) await releasePromotionLease(lease);
    }
  });

  it("refuses a FIFO inside staged bytes and leaves all fixture paths intact", async () => {
    const f = await fixture();
    const fifo = path.join(f.op, "staged.app/Contents/fifo");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const result = await invoke(f.request);
    expect(result.exitCode).not.toBe(0);
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
    expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
  });

  it("does not install into an Applications directory displaced during PID wait", async () => {
    const f = await fixture();
    const pending = invoke(f.request);
    await pending.ready;
    const pinned = f.applications + ".pinned";
    const foreign = path.join(f.root, "foreign");
    await fs.mkdir(foreign);
    await fs.rename(f.applications, pinned);
    await fs.symlink(foreign, f.applications);
    await confirmQuit(f);
    f.child.kill("SIGTERM");
    expect((await pending).result.error).toBe("path_type");
    expect(
      await fs.readFile(
        path.join(pinned, "Farol.app/Contents/payload"),
        "utf8",
      ),
    ).toBe("N");
    expect(await fs.readdir(foreign)).toEqual([]);
  });

  it("exposes rollback_started without replay and preserves both bundles", async () => {
    const f = await fixture();
    await phase(f, "rollback_started");
    await fs.rename(f.app, path.join(f.op, "previous.app"));
    await fs.rename(path.join(f.op, "staged.app"), f.app);
    await confirmQuit(f);
    f.child.kill("SIGTERM");
    expect(
      (await invoke({ ...f.request, action: "recover" })).result.phase,
    ).toBe("rolled_back");
    expect(
      await fs.readFile(path.join(f.op, "failed.app/Contents/payload"), "utf8"),
    ).toBe("N+1");
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
  });

  // Actual Python helper and disposable filesystem/process fixtures only;
  // these cases do not qualify a packaged app, live startup or provider.
  it("recovers an incompatible beta11-to-beta12 rollback forward without moving either exact bundle or changing owner state", async () => {
    const f = await fixture("0.2.0-owner.beta.11", "0.2.0-owner.beta.12");
    const previous = path.join(f.op, "previous.app");
    await fs.rename(f.app, previous);
    await fs.rename(path.join(f.op, "staged.app"), f.app);
    await phase(f, "rollback_started");
    await fs.writeFile(
      path.join(f.state, "settings.json"),
      "fixture newer settings must remain unchanged\n",
    );
    await fs.mkdir(path.join(f.state, "retained"));
    await fs.writeFile(
      path.join(f.state, "retained/completed-shell.json"),
      "fixture v6 completed Shell bytes must remain unchanged\n",
    );
    const workspace = path.join(f.home, "Documents/fixture-workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "notes.txt"),
      "fixture owner data\n",
    );
    await confirmQuit(f);
    const closed = once(f.child, "close");
    f.child.kill("SIGTERM");
    await closed;
    const appBefore = await fs.lstat(f.app, { bigint: true });
    const previousBefore = await fs.lstat(previous, { bigint: true });
    const stateBefore = await treeDigest(f.state);
    const workspaceBefore = await treeDigest(workspace);
    const entriesBefore = (await fs.readdir(f.op)).sort();

    const recovery = await invoke({ ...f.request, action: "recover" });

    expect(recovery).toMatchObject({
      exitCode: 0,
      result: { phase: "verified", operationId: f.request.operationId },
      handoff: "",
    });
    expect(
      JSON.parse(await fs.readFile(path.join(f.op, "journal.json"), "utf8")),
    ).toEqual({
      schema: "farol.installed-update-journal/1",
      operationId: f.request.operationId,
      source: f.request.source,
      target: f.request.target,
      phase: "verified",
    });
    for (const [at, before, build] of [
      [f.app, appBefore, f.request.target],
      [previous, previousBefore, f.request.source],
    ]) {
      const after = await fs.lstat(at, { bigint: true });
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(await treeDigest(at)).toBe(build.digest);
    }
    expect((await fs.readdir(f.op)).sort()).toEqual(entriesBefore);
    expect(await treeDigest(f.state)).toBe(stateBefore);
    expect(await treeDigest(workspace)).toBe(workspaceBefore);
  });

  it("completes live forward recovery with one recover/completed target relaunch hint", async () => {
    const f = await fixture("0.2.0-owner.beta.11", "0.2.0-owner.beta.12");
    const previous = path.join(f.op, "previous.app");
    await fs.rename(f.app, previous);
    await fs.rename(path.join(f.op, "staged.app"), f.app);
    await phase(f, "rollback_started");
    const log = path.join(f.root, "open-arguments.jsonl");
    // Real helper/lease/handoff; only the OS application launcher is doubled.
    const recovery = invokeWithFakeOpen(
      { ...f.request, action: "recover", relaunch: true },
      log,
      true,
    );
    await recovery.ready;
    await expect(fs.lstat(log)).rejects.toMatchObject({ code: "ENOENT" });
    await confirmQuit(f);
    const closed = once(f.child, "close");
    f.child.kill("SIGTERM");
    await closed;
    expect(await recovery).toMatchObject({
      exitCode: 0,
      result: { phase: "completed" },
    });
    const launches = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(launches).toHaveLength(1);
    expect(launches[0].slice(0, 4)).toEqual([
      "/usr/bin/open",
      "-a",
      f.app,
      "--args",
    ]);
    expect(launches[0]).toHaveLength(5);
    const prefix = "--farol-installed-update-relaunch=";
    expect(launches[0][4].startsWith(prefix)).toBe(true);
    expect(JSON.parse(launches[0][4].slice(prefix.length))).toMatchObject({
      operationId: f.request.operationId,
      action: "recover",
      phase: "completed",
      buildId: f.request.target.buildId,
      helper: { pid: expect.any(Number), processStart: expect.any(String) },
    });
    expect(
      JSON.parse(await fs.readFile(path.join(f.op, "journal.json"), "utf8"))
        .phase,
    ).toBe("completed");
    expect(await treeDigest(f.app)).toBe(f.request.target.digest);
    expect(await treeDigest(previous)).toBe(f.request.source.digest);
  });

  for (const targetSlot of ["previous.app", "failed.app"]) {
    it(`refuses incompatible rollback_started recovery with source in slot and target in ${targetSlot} before Quit handoff`, async () => {
      const f = await fixture("0.2.0-owner.beta.11", "0.2.0-owner.beta.12");
      const target = path.join(f.op, targetSlot);
      await fs.rename(path.join(f.op, "staged.app"), target);
      await phase(f, "rollback_started");
      const journalPath = path.join(f.op, "journal.json");
      const journalBefore = await fs.readFile(journalPath);
      const journalStatBefore = await fs.lstat(journalPath, { bigint: true });
      const appBefore = await fs.lstat(f.app, { bigint: true });
      const targetBefore = await fs.lstat(target, { bigint: true });
      const stateBefore = await treeDigest(f.state);
      const entriesBefore = (await fs.readdir(f.op)).sort();

      // Keep the controlled source alive: a parent may Quit only after ready.
      // No fake open is needed because admission must refuse before readiness.
      const pending = invoke({
        ...f.request,
        action: "recover",
        relaunch: true,
      });
      const recovery = await pending;

      expect(recovery).toMatchObject({
        exitCode: 70,
        result: {
          phase: "refused",
          error: "predecessor_state_unqualified",
          operationId: f.request.operationId,
        },
      });
      expect(JSON.parse(recovery.handoff)).toMatchObject({
        phase: "refused",
        error: "predecessor_state_unqualified",
      });
      await expect(pending.ready).rejects.toThrow("helper refused readiness");
      expect(f.child.exitCode).toBeNull();
      expect(f.child.signalCode).toBeNull();
      expect(
        execFileSync("/bin/ps", ["-p", String(f.child.pid), "-o", "lstart="], {
          encoding: "utf8",
        }).trim(),
      ).toBe(f.request.processStart);
      await expect(
        fs.lstat(path.join(f.state, "last-quit.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(journalPath)).toEqual(journalBefore);
      const journalAfter = await fs.lstat(journalPath, { bigint: true });
      expect([journalAfter.dev, journalAfter.ino]).toEqual([
        journalStatBefore.dev,
        journalStatBefore.ino,
      ]);
      for (const [at, before, build] of [
        [f.app, appBefore, f.request.source],
        [target, targetBefore, f.request.target],
      ]) {
        const after = await fs.lstat(at, { bigint: true });
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
        expect(await treeDigest(at)).toBe(build.digest);
      }
      expect((await fs.readdir(f.op)).sort()).toEqual(entriesBefore);
      expect(await treeDigest(f.state)).toBe(stateBefore);
    });
  }

  it("refuses FIFO staging and existing rollback path without deleting either", async () => {
    const f = await fixture();
    await fs.rename(
      path.join(f.op, "staged.app"),
      path.join(f.op, "original.app"),
    );
    await fs.symlink(
      path.join(f.op, "original.app"),
      path.join(f.op, "staged.app"),
    );
    expect((await invoke(f.request)).exitCode).not.toBe(0);
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
  });
});
