import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import {
  captureInstalledProcessStart,
  installedSlotBindingBytes,
  startInstalledUpdateHelper,
} from "../../src/modules/release/infra/native/installed-update-helper.ts";
import { nativeGoExecutable } from "./fixtures/installed-update-go-helper.ts";

// Native lane, off by default: FAROL_DESKTOP_GO_HELPER_NATIVE=1 compiles
// `./cmd/farol` (or uses FAROL_DESKTOP_GO_HELPER_BIN) and drives the REAL TS
// launcher against it over a disposable home with digest-matching inert trees,
// the same oracle images as the boot native lanes. The "live app" is a scratch
// /bin/cat this test starts and ends by exact pid. relaunch is false, so
// /usr/bin/open is never called; no app, Electron, Dev build or profile is
// started or read, and the owner's real home is never opened.
const native = process.env["FAROL_DESKTOP_GO_HELPER_NATIVE"] === "1";
const testdata = path.join(
  process.cwd(),
  "modules/release/infra/native/appidentity/testdata",
);
const BUILD_ID = "a".repeat(64);
const VERSION = "1.2.3-preview.4";
const roots = [];
const scratch = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of scratch.splice(0)) {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise((resolve) => child.once("close", resolve));
    }
  }
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function tree(at, plist) {
  await fs.mkdir(path.join(at, "Contents/Resources/app"), {
    recursive: true,
    mode: 0o700,
  });
  for (const [from, to] of [
    [plist, "Contents/Info.plist"],
    ["oracle.json", "Contents/Resources/app/build-identity.json"],
  ])
    await fs.writeFile(
      path.join(at, to),
      await fs.readFile(path.join(testdata, from)),
      { mode: 0o600 },
    );
  return { digest: await treeDigest(at), version: VERSION, buildId: BUILD_ID };
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-desktop-go-helper-"),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const appPath = path.join(home, "Applications/Farol.app");
  const support = path.join(
    home,
    "Library/Application Support/Farol Next Preview",
  );
  const state = path.join(support, "farol-next-state");
  const operationId = "1".repeat(32);
  const op = path.join(support, "installed-updates", operationId);
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.mkdir(op, { recursive: true, mode: 0o700 });
  const source = await tree(appPath, "oracle.xml");
  const target = await tree(path.join(op, "staged.app"), "oracle.bplist");
  await fs.writeFile(path.join(state, "promotion.lease"), "", { mode: 0o600 });
  const app = spawn("/bin/cat", [], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  scratch.push(app);
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
      startedAt: new Date(Date.now() - 2000).toISOString(),
      bootTime: null,
    }),
    { mode: 0o600 },
  );
  const request = {
    action: "apply",
    installLocation: "legacy",
    operationId,
    source,
    target,
    drain: {
      status: "reconciled",
      acceptedSource: BUILD_ID,
      acceptedTarget: BUILD_ID,
    },
    pid: app.pid,
    processStart,
    waitSeconds: 5,
    relaunch: false,
  };
  // The desktop publishes this canonical binding before it dispatches.
  await fs.writeFile(
    path.join(op, "slot-binding.json"),
    installedSlotBindingBytes(request, "legacy"),
    { mode: 0o600 },
  );
  vi.spyOn(os, "userInfo").mockReturnValue({
    ...os.userInfo(),
    homedir: home,
  });
  return { home, app, appPath, state, op, request };
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
  f.app.stdin.end();
  await exited;
}

async function selection() {
  const executable = await nativeGoExecutable();
  return {
    kind: "go",
    helper: {
      buildId: "7".repeat(64),
      qualify: async () => executable,
      remeasure: async () => executable,
    },
  };
}
const read = (file) => fs.readFile(file, "utf8");
const oracle = (name) => read(path.join(testdata, name));

describe.skipIf(!native)(
  "desktop launcher over the compiled Go live helper (disposable home, relaunch false)",
  () => {
    it("applies Quit-and-install to verified with exit 0 and a pristine predecessor copy", async () => {
      const f = await fixture();
      const launched = await startInstalledUpdateHelper(
        await selection(),
        f.request,
        { readinessTimeoutMs: 15_000 },
      );
      expect(
        launched.status,
        JSON.stringify(launched.operation.observe()),
      ).toBe("ready");
      await quit(f);
      const finished = await launched.operation.completion;
      expect(finished).toMatchObject({
        code: 0,
        signal: null,
        protocolError: null,
        terminal: { phase: "verified", error: null },
      });
      expect(await read(path.join(f.appPath, "Contents/Info.plist"))).toBe(
        await oracle("oracle.bplist"),
      );
      expect(
        await read(path.join(f.op, "previous.app/Contents/Info.plist")),
      ).toBe(await oracle("oracle.xml"));
      await expect(
        fs.lstat(path.join(f.op, "staged.app")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        JSON.parse(await read(path.join(f.op, "journal.json"))).phase,
      ).toBe("verified");
    });

    it("keeps the caller alive and the slot untouched when the helper refuses", async () => {
      const f = await fixture();
      const launched = await startInstalledUpdateHelper(
        await selection(),
        {
          ...f.request,
          target: { ...f.request.target, digest: "0".repeat(64) },
        },
        { readinessTimeoutMs: 15_000 },
      );
      expect(launched.status).toBe("refused");
      expect(launched.reason).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(f.app.exitCode).toBeNull();
      expect((await launched.operation.completion).code).toBe(70);
      expect(await read(path.join(f.appPath, "Contents/Info.plist"))).toBe(
        await oracle("oracle.xml"),
      );
      await expect(
        fs.lstat(path.join(f.op, "journal.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
