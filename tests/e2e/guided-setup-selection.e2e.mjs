// Owned hidden Electron windows and disposable state only. This proves Setup
// selection and IPC/UI integration, never a live account or NEW connector.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const packaged = process.argv.includes("--packaged");
assert.deepEqual(process.argv.slice(2), packaged ? ["--packaged"] : []);
const root = process.cwd();
const appRoot = path.join(root, "_output/package/Farol Next Preview.app");
const executable = packaged
  ? path.join(
      appRoot,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    )
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const entry = packaged
  ? path.join(appRoot, "Contents/Resources/app/main.cjs")
  : path.join(root, "_output/build/app/main.cjs");
const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-guided-setup-"),
);
const proof = randomUUID();
await fs.writeFile(path.join(temporaryRoot, ".farol-next-e2e-root"), proof, {
  mode: 0o600,
});
const workspace = path.join(temporaryRoot, "approved-folder");
await fs.mkdir(workspace, { mode: 0o700 });
const observations = [];
const profiles = new Map();
let cleanupUnknown = false;
let application;
let pendingLaunch;
let closingLateLaunch = false;

async function bounded(promise, label, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeOwned() {
  if (!application) return;
  const owned = application;
  const child = owned.process();
  const terminal =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "exit");
  try {
    await bounded(owned.close(), "GUIDED_SETUP_CLOSE_TIMEOUT");
    await bounded(terminal, "GUIDED_SETUP_EXIT_TIMEOUT");
  } catch (error) {
    cleanupUnknown = true;
    observations.push({ kind: "cleanup-unknown", pid: child.pid });
    throw error;
  }
  assert.equal(child.signalCode, null);
  assert.equal(child.exitCode, 0);
  observations.push({
    kind: "owned-process-terminal",
    pid: child.pid,
    exit: child.exitCode,
    signal: child.signalCode,
  });
  application = undefined;
}

async function launch(environment, mode = "normal", profile = mode) {
  assert.equal(
    application,
    undefined,
    "GUIDED_SETUP_PRIOR_INSTANCE_NOT_CLOSED",
  );
  let profileRoot = profiles.get(profile);
  if (!profileRoot) {
    profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-e2e-home-"),
    );
    await fs.writeFile(path.join(profileRoot, ".farol-next-e2e-root"), proof, {
      mode: 0o600,
    });
    profiles.set(profile, profileRoot);
  }
  const home = path.join(profileRoot, "home");
  const appData = path.join(profileRoot, "app-data");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(appData, { recursive: true, mode: 0o700 });
  const pending = electron.launch({
    executablePath: executable,
    args: [
      entry,
      "--preview-window-mode=hidden",
      ...(mode === "demo" ? ["--demo"] : []),
    ],
    env: {
      HOME: home,
      TMPDIR: temporaryRoot,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      ...(environment === "dev" ? { FAROL_NEXT_ENVIRONMENT: "dev" } : {}),
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_TEST_ROOT: profileRoot,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
      FAROL_NEXT_E2E_WORKSPACE_ROOT: workspace,
      ...(mode === "legacy" ? { FAROL_NEXT_E2E_LEGACY_SETUP: "1" } : {}),
    },
    timeout: 15000,
  });
  // A late launch stays owned and is closed; never start another on top of it.
  closingLateLaunch = false;
  pendingLaunch = pending.then(async (value) => {
    application = value;
    if (closingLateLaunch) await closeOwned();
    return value;
  });
  application = await bounded(pendingLaunch, "GUIDED_SETUP_LAUNCH_TIMEOUT");
  const window = await bounded(
    application.firstWindow(),
    "GUIDED_SETUP_WINDOW_TIMEOUT",
  );
  await window
    .locator("#sidebar")
    .waitFor({ state: "visible", timeout: 15000 });
  const bootstrap = await window.evaluate(() => window.farolNext.bootstrap());
  assert.equal(bootstrap.environment, environment);
  assert.equal(bootstrap.legacySetupTestMode, mode === "legacy");
  const windows = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
    })),
  );
  assert.ok(windows.every((window) => !window.visible && !window.focused));
  observations.push({
    kind: "setup-selection",
    environment,
    mode,
    sourceCommit: bootstrap.build.sourceCommit,
    buildId: bootstrap.build.buildId,
    sourceDirty: bootstrap.build.sourceDirty,
    windows,
  });
  return window;
}

try {
  for (const environment of packaged ? ["preview"] : ["preview", "dev"]) {
    const window = await launch(environment, "normal", environment);
    await window.locator("#onboarding-nav").waitFor({ state: "visible" });
    await window.locator("#setup-dialog").waitFor({ state: "hidden" });
    await window.locator("#guided-onboarding").waitFor({ state: "visible" });
    await window.locator('[data-onboarding-step="folder"]').click();
    await window.locator("#onboarding-add-folder").click();
    await window.waitForFunction(
      () =>
        document
          .querySelector("#onboarding-folder-list")
          ?.textContent?.includes("approved-folder"),
      { timeout: 15000 },
    );
    const saved = await window.evaluate(() => window.farolNext.bootstrap());
    assert.equal(saved.configuration.settings.computer.workspaces.length, 1);
    assert.equal(
      saved.configuration.settings.computer.workspaces[0].root,
      await fs.realpath(workspace),
    );
    assert.equal(
      saved.configuration.settings.computer.workspaces[0].access,
      "read",
    );
    assert.equal(saved.configuration.settings.setup.chatgpt.verified, null);
    const inode =
      saved.configuration.settings.computer.workspaces[0].rootIdentity;
    if (environment === "preview") {
      await window.locator('[data-onboarding-step="app"]').click();
      assert.match(
        await window.locator("#onboarding-copy").innerText(),
        /does not send a message/,
      );
      assert.equal(
        await window.locator("#onboarding-verify-again").isVisible(),
        false,
      );
      await window
        .locator('.nav-utility .nav-item[data-section="settings"]')
        .click();
      await window.locator('[data-panel="settings"].active').waitFor();
      await window
        .locator("#computer-command-policy")
        .waitFor({ state: "visible" });
    }
    if (environment === "preview")
      await window.locator('.nav-item[data-section="computer"]').click();
    await window.locator("#onboarding-return").click();
    await window.locator('[data-panel="browser"].active').waitFor();
    await window
      .locator("#task-menu-button:visible, #browser-task-menu:visible")
      .first()
      .click();
    await window.locator("#task-menu-setup").click();
    await window.locator("#onboarding-nav").waitFor({ state: "visible" });
    await window.locator("#setup-dialog").waitFor({ state: "hidden" });
    await window.locator("#onboarding-return").click();
    await window.locator('[data-panel="browser"].active').waitFor();
    await window.locator('.nav-item[data-section="computer"]').click();
    await window.locator("#onboarding-nav").waitFor({ state: "visible" });
    await closeOwned();
    const reopened = await launch(environment, "normal", environment);
    await reopened.locator("#onboarding-nav").waitFor({ state: "visible" });
    const readback = await reopened.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.deepEqual(
      readback.configuration.settings.computer.workspaces[0].rootIdentity,
      inode,
    );
    assert.equal(
      readback.configuration.settings.computer.workspaces[0].root,
      await fs.realpath(workspace),
    );
    await closeOwned();
  }
  for (const mode of ["legacy", "demo"]) {
    const window = await launch("preview", mode);
    await window.locator("#setup-dialog").waitFor({ state: "visible" });
    assert.equal(await window.locator("#onboarding-nav").isVisible(), false);
    await closeOwned();
  }
} finally {
  closingLateLaunch = true;
  if (pendingLaunch) {
    try {
      await bounded(pendingLaunch, "GUIDED_SETUP_LATE_LAUNCH_UNRESOLVED");
    } catch (error) {
      if (application)
        observations.push({
          kind: "late-launch-failed",
          cleanup: "owned cleanup still required",
        });
      // A failed launch already reports its native exit. An unresolved late
      // success remains owned by its completion callback and is never duplicated.
      if (error?.message === "GUIDED_SETUP_LATE_LAUNCH_UNRESOLVED")
        cleanupUnknown = true;
    }
  }
  if (!cleanupUnknown) await closeOwned();
  const destination = path.join(
    root,
    "_output/evidence/guided-setup-selection",
    packaged ? "package.json" : "development.json",
  );
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    destination,
    JSON.stringify(
      {
        schema: 1,
        packaged,
        observations,
        limits: [
          "Hidden renderer and disposable IPC fixtures only",
          "Native folder picker is replaced by the explicit E2E selection",
          "No live account, Browser Send, model inference or NEW connector",
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
process.stdout.write(
  JSON.stringify({
    packaged,
    observations: observations.length,
    cleanup: "owned app exits observed",
    live: "NOT_RUN",
  }) + "\n",
);
