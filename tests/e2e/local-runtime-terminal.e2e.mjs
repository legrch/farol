// Explicit hidden native lane. Synthetic profile, failed in-memory helper,
// ordinary Quit, then one clean same-profile successor. No installed or provider proof.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { _electron as electron } from "playwright-core";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
import { QuitReceiptSchema } from "../../src/apps/desktop/quit-receipt.ts";
import {
  ELECTRON_RUNTIME,
  observeElectronRuntime,
  assertRuntimeObservation,
} from "../../tooling/runtime-contract.mjs";

assert.deepEqual(process.argv.slice(2), ["--run-native"]);
assert.equal(process.platform, "darwin");
const root = process.cwd(),
  source = sourceIdentity(root);
const buildRoot = path.join(root, "_output/build/app");
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
  stateRoot = path.join(userData, "farol-state");
for (const dir of [home, stateRoot])
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const proof = randomUUID();
await fs.writeFile(path.join(profile, ".farol-e2e-root"), proof, {
  mode: 0o600,
  flag: "wx",
});
const evidence = path.join(
  root,
  "_output/evidence",
  `local-runtime-terminal-${randomUUID()}.json`,
);
await fs.mkdir(path.dirname(evidence), { recursive: true, mode: 0o700 });
const report = {
  source,
  buildId: build.identity.buildId,
  profile,
  status: "running",
  launches: [],
  limits:
    "Failed in-memory preview only; no arbitrary descendants, installed profile, live provider or Computer operations.",
};
const save = () =>
  fs.writeFile(evidence, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const bounded = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
};
try {
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    const launch = { ordinal, closeRequested: false, cleanupConfirmed: false };
    report.launches.push(launch);
    await save();
    const application = await electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [
        path.join(buildRoot, "main.cjs"),
        "--preview-window-mode=hidden",
        ...(ordinal === 1 ? ["--preview-runtime-start-failure"] : []),
      ],
      env: {
        HOME: home,
        TMPDIR: temp,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        FAROL_ENVIRONMENT: "dev",
        FAROL_E2E: "1",
        FAROL_E2E_APP_DATA: appData,
        FAROL_E2E_TEST_ROOT: profile,
        FAROL_E2E_TEST_PROOF: proof,
      },
      timeout: 15000,
    });
    launch.pid = application.process().pid;
    // Renderer bootstrap can precede the owner's Quit handlers. Observe the
    // fixed startup token before asking for Quit; no sleep implies readiness.
    let startupTokens = "";
    application.process().stderr.on("data", (chunk) => {
      startupTokens = (startupTokens + chunk.toString()).slice(-8192);
    });
    const exit = once(application.process(), "exit");
    void exit.catch(() => undefined);
    const page = await application.firstWindow({ timeout: 15000 });
    await page.waitForFunction(
      (expected) =>
        window.farol &&
        window.farol
          .bootstrap()
          .then((value) => value.runtimeState === expected),
      ordinal === 1 ? "failed" : "ready",
      { timeout: 15000 },
    );
    const bootstrap = await page.evaluate(() => window.farol.bootstrap());
    assert.equal(bootstrap.build.buildId, build.identity.buildId);
    assert.equal(bootstrap.runtimeState, ordinal === 1 ? "failed" : "ready");
    launch.runtimeState = bootstrap.runtimeState;
    launch.windows = await application.evaluate(({ app, BrowserWindow }) => ({
      userData: app.getPath("userData"),
      windows: BrowserWindow.getAllWindows().map((w) => ({
        visible: w.isVisible(),
        focused: w.isFocused(),
        url: w.webContents.getURL(),
      })),
    }));
    assert.equal(launch.windows.userData, userData);
    assert.ok(launch.windows.windows.length >= 1);
    assert.ok(
      launch.windows.windows.every(
        (w) =>
          !w.visible &&
          !w.focused &&
          !w.url.includes("#farol-startup-recovery"),
      ),
    );
    await bounded(
      new Promise((resolve, reject) => {
        let observations = 0;
        const inspect = () => {
          if (++observations > 700) {
            reject(Error("ORIGINAL_STARTUP_COMPLETION_UNKNOWN"));
            return;
          }
          if (startupTokens.includes("FAROL_STARTUP_STAGE:startup-complete")) {
            resolve();
            return;
          }
          if (application.process().exitCode !== null) {
            reject(Error("ORIGINAL_STARTUP_TERMINAL_BEFORE_QUIT_READY"));
            return;
          }
          setTimeout(inspect, 20);
        };
        inspect();
      }),
      "ORIGINAL_STARTUP_COMPLETION_UNKNOWN",
    );
    launch.startupComplete = true;
    launch.closeRequested = true;
    await save();
    await application.evaluate(({ app }) => app.quit());
    const [code, signal] = await bounded(exit, "ORIGINAL_QUIT_UNKNOWN");
    launch.exit = { code, signal };
    await save();
    assert.equal(code, 0);
    assert.equal(signal, null);
    const quit = QuitReceiptSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(stateRoot, "last-quit.json"), "utf8"),
      ),
    );
    assert.equal(quit.drained, true);
    assert.deepEqual(quit.unconfirmed, []);
    await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
      code: "ENOENT",
    });
    launch.quit = quit;
    launch.cleanupConfirmed = true;
    await save();
  }
  assert.deepEqual(sourceIdentity(root), source);
  report.status =
    "passed-hidden-failed-preview-quit-clean-successor-zero-authority";
  await fs.rm(profile, { recursive: true });
  report.temporaryRemoved = true;
} catch (error) {
  report.status = "failed-or-unknown";
  report.error = String(error?.message ?? error);
  throw error;
} finally {
  await save();
  process.stdout.write(
    `Local runtime terminal evidence: ${evidence} (${report.status})\n`,
  );
}
