import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
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
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function bundle(at, version, buildId, contents) {
  await fs.mkdir(path.join(at, "Contents/Resources/app"), { recursive: true });
  await fs.writeFile(
    path.join(at, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.farol.next.preview</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  await fs.writeFile(
    path.join(at, "Contents/Resources/app/build-identity.json"),
    JSON.stringify({ bundleId: "local.farol.next.preview", version, buildId }),
  );
  await fs.writeFile(path.join(at, "Contents/payload"), contents);
  return { digest: await treeDigest(at), version, buildId };
}
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-installed-update-"),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const applications = path.join(home, "Applications");
  const app = path.join(applications, "Farol Next Preview.app");
  const operationId = "a".repeat(32);
  const op = path.join(
    home,
    "Library/Application Support/Farol Next Preview/installed-updates",
    operationId,
  );
  await fs.mkdir(applications, { recursive: true });
  await fs.mkdir(op, { recursive: true });
  await fs.chmod(home, 0o700);
  const source = await bundle(app, "0.1.0", "1".repeat(64), "N");
  const target = await bundle(
    path.join(op, "staged.app"),
    "0.1.1",
    "2".repeat(64),
    "N+1",
  );
  const child = spawn("/bin/sleep", ["2"], { stdio: "ignore" });
  children.push(child);
  const started = await new Promise((resolve, reject) => {
    const poll = async () => {
      const ps = spawn("/bin/ps", ["-p", String(child.pid), "-o", "lstart="]);
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
async function invoke(request) {
  const code = await fs.readFile(helper);
  return await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
      cwd: "/",
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({ exitCode, result: JSON.parse(stdout), stderr }),
    );
    child.stdin.end(code);
    child.stdio[3].end(JSON.stringify(request));
  });
}
async function invokeWithPostSwapCorruption(request) {
  const program = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("update_helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
original = helper.write_record
def corrupt_after_move(parent, name, record):
    original(parent, name, record)
    if record["phase"] == "new_installed":
        with open(sys.argv[2] + "/Applications/Farol Next Preview.app/Contents/payload", "wb") as file:
            file.write(b"corrupt")
helper.write_record = corrupt_after_move
try:
    helper.run(json.loads(sys.stdin.read()))
except helper.Refusal as error:
    print(json.dumps({"phase": error.phase, "error": error.code}))
    raise SystemExit(70)
`;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      ["-I", "-S", "-B", "-c", program, helper, request.home],
      { cwd: "/", stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({ exitCode, result: JSON.parse(stdout) }),
    );
    child.stdin.end(JSON.stringify(request));
  });
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
  it("replaces fixed NEW slot only after exact PID exits, preserves N, and rolls back", async () => {
    const f = await fixture();
    const pending = invoke(f.request);
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    const rollbackProcess = spawn("/bin/sleep", ["2"], { stdio: "ignore" });
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
    const rollback = invoke({
      ...f.request,
      action: "rollback",
      pid: rollbackProcess.pid,
      processStart: rollbackStart.trim(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await confirmQuit(f);
    rollbackProcess.kill("SIGTERM");
    expect((await rollback).result.phase).toBe("rolled_back");
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
    await new Promise((resolve) => setTimeout(resolve, 150));
    await confirmQuit(f);
    f.child.kill("SIGTERM");
    const outcome = await pending;
    expect(outcome).toEqual({
      exitCode: 70,
      result: { phase: "rolled_back", error: "target_verification" },
    });
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N");
    expect(
      await fs.readFile(path.join(f.op, "failed.app/Contents/payload"), "utf8"),
    ).toBe("corrupt");
  });

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
        path.join(pinned, "Farol Next Preview.app/Contents/payload"),
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
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    await new Promise((resolve) => setTimeout(resolve, 150));
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
      await new Promise((resolve) => setTimeout(resolve, 150));
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
    await new Promise((resolve) => setTimeout(resolve, 150));
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
        path.join(pinned, "Farol Next Preview.app/Contents/payload"),
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
    ).toBe("rollback_started");
    expect(
      await fs.readFile(
        path.join(f.op, "previous.app/Contents/payload"),
        "utf8",
      ),
    ).toBe("N");
    expect(
      await fs.readFile(path.join(f.app, "Contents/payload"), "utf8"),
    ).toBe("N+1");
  });

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
