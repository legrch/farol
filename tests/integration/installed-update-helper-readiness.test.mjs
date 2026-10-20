import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { installedUpdateHelperModule } from "./fixtures/installed-update-helper-module.ts";
import {
  captureInstalledProcessStart,
  startInstalledUpdateHelper,
} from "../../src/modules/release/infra/native/installed-update-helper.ts";
import { referenceGoHelper } from "./fixtures/installed-update-go-helper.ts";

// Real children over real descriptors. The executable is the disposable
// reference wrapper around the retired Python program, so the launcher's
// readiness handoff is proven without a build. The compiled Go entry is driven
// by installed-update-helper-go-native.test.mjs.
const roots = [];
const apps = [];
const helpers = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const launched of helpers.splice(0)) {
    // Every PID here belongs to a helper this test launched. Retain old-number
    // cleanup as well so the regression is safe to run against the RED version.
    const pid =
      typeof launched === "number" ? launched : launched.operation.pid;
    if (
      pid &&
      (typeof launched === "number" || !launched.operation.observe().exit)
    ) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (typeof launched !== "number") await launched.operation.completion;
  }
  for (const app of apps.splice(0)) {
    if (app.exitCode === null) {
      app.stdin.end("quit\n");
      await new Promise((resolve) => app.once("close", resolve));
    }
  }
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
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-update-ready-"),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const appPath = path.join(home, "Applications/Farol.app");
  const userData = path.join(
    home,
    "Library/Application Support/Farol Next Preview",
  );
  const state = path.join(userData, "farol-next-state");
  const operationId = "e".repeat(32);
  const op = path.join(userData, "installed-updates", operationId);
  const source = await bundle(appPath, "0.1.0", "1".repeat(64), "N");
  const target = await bundle(
    path.join(op, "staged.app"),
    "0.1.1",
    "2".repeat(64),
    "N+1",
  );
  await fs.chmod(home, 0o700);
  await fs.mkdir(state, { mode: 0o700 });
  await fs.writeFile(path.join(state, "promotion.lease"), "", { mode: 0o600 });
  const app = spawn(
    "/usr/bin/python3",
    ["-I", "-S", "-B", "-c", "import sys; sys.stdin.readline()"],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  apps.push(app);
  await new Promise((resolve, reject) => {
    app.once("spawn", resolve);
    app.once("error", reject);
  });
  const processStart = await captureInstalledProcessStart(app.pid);
  await fs.writeFile(
    path.join(state, "running.json"),
    JSON.stringify({
      schema: 1,
      pid: app.pid,
      processStart,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      bootTime: null,
    }),
    { mode: 0o600 },
  );
  const user = os.userInfo();
  vi.spyOn(os, "userInfo").mockReturnValue({ ...user, homedir: home });
  const selection = await referenceGoHelper(root);
  const executable = await selection.helper.qualify();
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
    pid: app.pid,
    processStart,
    waitSeconds: 5,
    relaunch: false,
  };
  return { home, app, appPath, state, op, request, selection, executable };
}
async function quit(f) {
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
  const exited = new Promise((resolve) => f.app.once("close", resolve));
  f.app.stdin.end("quit\n");
  await exited;
}

describe("installed update readiness handoff", () => {
  it("completes when the caller quits immediately after launcher readiness", async () => {
    const f = await fixture();
    const launched = await startInstalledUpdateHelper(f.selection, f.request, {
      readinessTimeoutMs: 5000,
    });
    helpers.push(launched);
    expect(launched.status, JSON.stringify(launched.operation.observe())).toBe(
      "ready",
    );
    // No arbitrary grace period: the caller may quit as soon as this resolves.
    await quit(f);
    const finished = await launched.operation.completion;
    expect(finished.code).toBe(0);
    expect(finished.terminal?.phase).toBe("verified");
    expect(
      await fs.readFile(path.join(f.appPath, "Contents/payload"), "utf8"),
    ).toBe("N+1");
    expect(
      await fs.readFile(
        path.join(f.op, "previous.app/Contents/payload"),
        "utf8",
      ),
    ).toBe("N");
  });

  it("lets the exact launcher process exit naturally while helper finishes without its observer", async () => {
    const f = await fixture();
    const moduleURL = await installedUpdateHelperModule(f.home);
    await quit(f);
    const caller = spawn(
      process.execPath,
      [
        path.join(
          process.cwd(),
          "tests/integration/fixtures/installed-update-ready-child.mjs",
        ),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const output = [];
    const errors = [];
    caller.stdout.on("data", (chunk) => output.push(chunk));
    caller.stderr.on("data", (chunk) => errors.push(chunk));
    const code = new Promise((resolve, reject) => {
      caller.once("close", resolve);
      caller.once("error", reject);
    });
    const deadline = setTimeout(() => caller.kill("SIGTERM"), 7000);
    caller.stdin.end(
      JSON.stringify({
        home: f.home,
        executable: f.executable,
        request: f.request,
        moduleURL,
      }),
    );
    try {
      expect(await code, Buffer.concat(errors).toString()).toBe(0);
      expect(JSON.parse(Buffer.concat(output).toString()).status).toBe("ready");
      await vi.waitFor(
        async () => {
          const journal = JSON.parse(
            await fs.readFile(path.join(f.op, "journal.json"), "utf8"),
          );
          expect(journal.phase).toBe("verified");
        },
        { timeout: 5000, interval: 25 },
      );
      expect(
        await fs.readFile(path.join(f.appPath, "Contents/payload"), "utf8"),
      ).toBe("N+1");
    } finally {
      clearTimeout(deadline);
    }
  });

  it("reports refusal before readiness and keeps the caller alive", async () => {
    const f = await fixture();
    const launched = await startInstalledUpdateHelper(
      f.selection,
      { ...f.request, target: { ...f.request.target, digest: "0".repeat(64) } },
      { readinessTimeoutMs: 5000 },
    );
    helpers.push(launched);
    expect(launched.status).toBe("refused");
    expect(launched.reason).toBe("digest");
    expect(f.app.exitCode).toBeNull();
    expect(
      await fs.readFile(path.join(f.appPath, "Contents/payload"), "utf8"),
    ).toBe("N");
    expect((await launched.operation.completion).code).toBe(70);
    await expect(
      fs.lstat(path.join(f.op, "journal.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
