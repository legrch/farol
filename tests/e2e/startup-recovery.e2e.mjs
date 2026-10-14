// Explicit native lane: exact Go build, synthetic unconfirmed predecessor,
// hidden recovery UI -> ordinary UI Quit -> same-profile reopen. No live
// provider, installed profile, operation replay or arbitrary descendant claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
import {
  ELECTRON_RUNTIME,
  observeElectronRuntime,
  assertRuntimeObservation,
} from "../../tooling/runtime-contract.mjs";
import { _electron as electron } from "playwright-core";
import { isPromotionLeaseHeld } from "../../tooling/promotion-lease.mjs";

assert.deepEqual(
  process.argv.slice(2),
  ["--run-native"],
  "EXPLICIT_NATIVE_RECOVERY_LANE_REQUIRED",
);
assert.equal(process.platform, "darwin");
const root = process.cwd(),
  source = sourceIdentity(root),
  buildRoot = path.join(root, "_output/build/app");
const build = await qualifyGoBuild(buildRoot, source);
assertRuntimeObservation(
  await observeElectronRuntime(path.join(root, "node_modules/electron")),
  ELECTRON_RUNTIME,
);
const temp = await fs.realpath(os.tmpdir());
assert.match(temp, /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u);
const profile = await fs.realpath(
  await fs.mkdtemp(path.join(temp, "farol-dev-onboarding-startup-")),
);
await fs.chmod(profile, 0o700);
const home = path.join(profile, "home"),
  appData = path.join(profile, "app-data");
const userData = path.join(appData, "Farol Dev"),
  stateRoot = path.join(userData, "farol-next-state");
for (const dir of [home, stateRoot])
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const proof = randomUUID();
await fs.writeFile(path.join(profile, ".farol-next-e2e-root"), proof, {
  mode: 0o600,
  flag: "wx",
});
const retained = new Map([
  ["running.json", Buffer.from('{"synthetic":"unconfirmed predecessor"}\n')],
  ["last-quit.json", Buffer.from('{"synthetic":"undrained Quit"}\n')],
  [
    "config.json",
    Buffer.from('{"synthetic":"retained configuration must not be loaded"}\n'),
  ],
]);
for (const [name, bytes] of retained)
  await fs.writeFile(path.join(stateRoot, name), bytes, {
    mode: 0o600,
    flag: "wx",
  });
const evidence = path.join(
  root,
  "_output/evidence",
  `startup-recovery-${randomUUID()}.json`,
);
await fs.mkdir(path.dirname(evidence), { recursive: true, mode: 0o700 });
const report = {
  source,
  buildId: build.identity.buildId,
  profile,
  status: "running",
  launches: [],
  limits:
    "Synthetic predecessor only. No automatic unknown-operation retirement, crashed-descendant settlement, installed acceptance or provider evidence.",
};
const save = () =>
  fs.writeFile(evidence, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const preserved = async () => {
  const result = {};
  for (const [name, bytes] of retained) {
    const actual = await fs.readFile(path.join(stateRoot, name));
    assert.deepEqual(actual, bytes, `PREDECESSOR_CHANGED:${name}`);
    result[name] = hash(actual);
  }
  await assert.rejects(fs.lstat(path.join(stateRoot, "go-core")), {
    code: "ENOENT",
  });
  return result;
};
const children = (pid) =>
  execFileSync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return match && Number(match[2]) === pid
        ? [{ pid: Number(match[1]), command: match[3] }]
        : [];
    });
const bounded = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
};
let app, exit, launch;
try {
  await save();
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    launch = { ordinal, closeRequested: false, cleanupConfirmed: false };
    report.launches.push(launch);
    await save();
    app = await electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
      env: {
        HOME: home,
        TMPDIR: temp,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        FAROL_NEXT_ENVIRONMENT: "dev",
        FAROL_NEXT_E2E: "1",
        FAROL_NEXT_E2E_APP_DATA: appData,
        FAROL_NEXT_E2E_TEST_ROOT: profile,
        FAROL_NEXT_E2E_TEST_PROOF: proof,
      },
      timeout: 15000,
    });
    const child = app.process();
    launch.pid = child.pid;
    exit = once(child, "exit");
    void exit.catch(() => undefined);
    const page = await app.firstWindow({ timeout: 15000 });
    await page
      .getByRole("heading", { name: "Your previous session needs recovery" })
      .waitFor();
    launch.windows = await app.evaluate(({ app, BrowserWindow }) => ({
      userData: app.getPath("userData"),
      windows: BrowserWindow.getAllWindows().map((win) => ({
        visible: win.isVisible(),
        focused: win.isFocused(),
        url: win.webContents.getURL(),
        bounds: win.getBounds(),
      })),
    }));
    assert.equal(launch.windows.userData, userData);
    assert.equal(launch.windows.windows.length, 1);
    assert.equal(launch.windows.windows[0].visible, false);
    assert.equal(launch.windows.windows[0].focused, false);
    assert.ok(
      launch.windows.windows[0].url.endsWith(
        "/shell.html#farol-startup-recovery",
      ),
    );
    launch.api = await page.evaluate(() => ({
      recovery: Object.keys(window.farolRecovery ?? {}).sort(),
      normal: typeof window.farolNext,
    }));
    assert.deepEqual(launch.api, { recovery: ["quit"], normal: "undefined" });
    launch.beforeQuit = await preserved();
    const lease = JSON.parse(
      await fs.readFile(path.join(stateRoot, "promotion.lease"), "utf8"),
    );
    assert.equal(lease.pid, child.pid);
    assert.equal(lease.role, "admission");
    assert.equal(
      await isPromotionLeaseHeld(userData),
      true,
      "RECOVERY_LEASE_NOT_HELD",
    );
    launch.children = children(child.pid);
    assert.equal(
      launch.children.some(({ command }) =>
        /farol-backend|(?:^|\/)runtime\.cjs(?:\s|$)/u.test(command),
      ),
      false,
      "EFFECT_RUNTIME_STARTED",
    );
    if (ordinal === 1) {
      const screenshot = evidence.replace(/\.json$/u, ".png");
      const pixels = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage())
          .toPNG()
          .toString("base64"),
      );
      await fs.writeFile(screenshot, Buffer.from(pixels, "base64"), {
        mode: 0o600,
      });
      report.screenshot = screenshot;
    }
    launch.closeRequested = true;
    await save();
    await page.getByRole("button", { name: "Quit", exact: true }).click();
    const [code, signal] = await bounded(exit, "RECOVERY_QUIT_UNKNOWN");
    assert.equal(code, 0);
    assert.equal(signal, null);
    launch.exitCode = code;
    launch.signal = signal;
    launch.afterQuit = await preserved();
    // The existing lease protocol retains its inode and clears its record.
    // Kernel lock release, not pathname absence, permits the next generation.
    assert.equal(
      await isPromotionLeaseHeld(userData),
      false,
      "RECOVERY_LEASE_RETAINED",
    );
    assert.equal(
      (await fs.readFile(path.join(stateRoot, "promotion.lease"))).length,
      0,
      "RECOVERY_LEASE_RECORD_RETAINED",
    );
    assert.equal(children(child.pid).length, 0, "RECOVERY_CHILDREN_RETAINED");
    launch.cleanupConfirmed = true;
    app = null;
    await save();
  }
  await fs.rm(profile, { recursive: true });
  report.profileRemoved = true;
  report.status =
    "passed-hidden-recovery-quit-reopen-predecessor-preserved-zero-runtime";
} catch (error) {
  report.status = "failed-or-unknown";
  report.error = String(error?.stack ?? error);
  if (app && launch && !launch.closeRequested) {
    // One cleanup request only for the original known test host. Never replay
    // an uncertain renderer Quit or launch another process after failure.
    launch.closeRequested = true;
    try {
      await app.evaluate(({ app }) => app.quit());
      launch.cleanupExit = await bounded(exit, "RECOVERY_CLEANUP_UNKNOWN");
    } catch (cleanupError) {
      launch.cleanupError = String(cleanupError);
    }
  }
  process.exitCode = 1;
} finally {
  await save();
  process.stdout.write(
    `Startup recovery evidence: ${evidence} (${report.status})\n`,
  );
}
