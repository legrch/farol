// Owned hidden Electron windows and disposable state only. This proves Setup
// selection and IPC/UI integration, never a live account or NEW connector.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
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
let nonReadRequests = 0;
const chatFixture = createServer((request, response) => {
  if (request.method !== "GET") nonReadRequests += 1;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><html><head><title>Local Browser fixture</title></head><body style="margin:24px;font:18px sans-serif"><h1>Local Browser fixture</h1><textarea id="prompt-textarea" aria-label="Fixture composer"></textarea></body></html>',
  );
});
await bounded(
  new Promise((resolve) => chatFixture.listen(0, "127.0.0.1", resolve)),
  "BROWSER_FIXTURE_LISTEN_TIMEOUT",
);
const chatAddress = chatFixture.address();
assert.ok(chatAddress && typeof chatAddress !== "string");
const fixtureUrl = `http://127.0.0.1:${chatAddress.port}/`;
const profiles = new Map();
let primaryFailure;
const cleanupFailures = [];
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
      FAROL_NEXT_E2E_CHATGPT_URL: fixtureUrl,
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

async function browserGeometry(window, environment, width) {
  await application.evaluate(({ BrowserWindow }, width) => {
    BrowserWindow.getAllWindows()[0].setContentSize(width, 760);
  }, width);
  await window.waitForFunction((width) => innerWidth === width, width);
  await window.locator("#browser-status-bar").waitFor({ state: "visible" });
  await window.locator("#task-dossier").waitFor({ state: "hidden" });
  await window.waitForFunction(
    () => document.documentElement.dataset.compactBrowser === "true",
  );
  const chrome = await window.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
      };
    };
    const firstTab = document.querySelector("#task-tabs .task-tab");
    const box = firstTab.getBoundingClientRect();
    const menu = document.querySelector("#browser-task-menu");
    const menuBox = menu.getBoundingClientRect();
    return {
      tabs: rect(".task-bar"),
      footer: rect("#browser-status-bar"),
      surface: rect(".surface"),
      sidebar: rect("#sidebar"),
      toggle: rect("#sidebar-toggle"),
      firstTab: rect("#task-tabs .task-tab"),
      firstTabHittable: firstTab.contains(
        document.elementFromPoint(box.x + 10, box.y + 20),
      ),
      menuHittable: menu.contains(
        document.elementFromPoint(menuBox.x + 16, menuBox.y + 16),
      ),
    };
  });
  const native = await application.evaluate(
    ({ BrowserWindow, WebContentsView }, fixtureUrl) => {
      const owned = BrowserWindow.getAllWindows()[0];
      const page = owned.contentView.children.find(
        (child) =>
          child instanceof WebContentsView &&
          child.getVisible() &&
          child.webContents.getURL().startsWith(fixtureUrl),
      );
      return {
        visible: Boolean(page),
        bounds: page?.getBounds() ?? null,
        focused: owned.isFocused(),
        windowVisible: owned.isVisible(),
      };
    },
    fixtureUrl,
  );
  assert.equal(chrome.tabs.y, 0);
  assert.equal(chrome.tabs.height, 52);
  assert.equal(chrome.footer.y, 735);
  assert.equal(chrome.footer.height, 25);
  assert.equal(chrome.footer.x, chrome.sidebar.width);
  assert.equal(chrome.surface.y, 52);
  assert.equal(chrome.surface.height, 683);
  assert.ok(chrome.firstTab.x >= chrome.toggle.right);
  assert.equal(chrome.firstTabHittable, true);
  assert.equal(chrome.menuHittable, true);
  assert.equal(native.visible, true);
  assert.equal(native.focused, false);
  assert.equal(native.windowVisible, false);
  assert.deepEqual(native.bounds, {
    x: width < 980 ? 72 : 216,
    y: 52,
    width: width - (width < 980 ? 72 : 216),
    height: 683,
  });
  observations.push({
    kind: "compact-browser",
    environment,
    width,
    chrome,
    native,
  });
  const output = path.join(root, "_output/evidence/guided-setup-selection");
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  await window.screenshot({
    path: path.join(
      output,
      `${packaged ? "package" : "development"}-${environment}-browser-${width}.png`,
    ),
  });
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
    // Review Setup must remain reachable in an empty profile.
    await window
      .locator('.nav-utility .nav-item[data-section="settings"]')
      .click();
    if (environment === "dev") {
      await window
        .locator('#settings-nav [data-settings-category="diagnostics"]')
        .click();
      const diagnostics = window.locator("#connection-diagnostics");
      if (!(await diagnostics.evaluate((details) => details.open)))
        await diagnostics.locator("summary").click();
    }
    await window.locator("#review-setup").click();
    observations.push({ kind: "review-setup", environment });
    await window.locator("#onboarding-nav").waitFor({ state: "visible" });
    await window.locator("#setup-dialog").waitFor({ state: "hidden" });
    await window.locator("#onboarding-return").click();
    await window.locator('[data-panel="browser"].active').waitFor();
    await window.locator("#browser-task-menu").click();
    await window.locator("#task-menu-setup").click();
    await window.locator("#onboarding-nav").waitFor({ state: "visible" });
    await window.locator("#setup-dialog").waitFor({ state: "hidden" });
    observations.push({ kind: "task-menu-setup", environment });

    // Readiness and task views use only the local composer fixture. No Send,
    // external account, Codex task or inference is performed.
    const opened = await bounded(
      window.evaluate(() =>
        window.farolNext.configure({ kind: "chatgpt.open-sign-in" }),
      ),
      "BROWSER_FIXTURE_OPEN_TIMEOUT",
    );
    assert.equal(opened.ok, true);
    const verified = await bounded(
      window.evaluate(() =>
        window.farolNext.configure({ kind: "chatgpt.verify" }),
      ),
      "BROWSER_FIXTURE_VERIFY_TIMEOUT",
    );
    assert.equal(verified.ok, true);
    const returned = await bounded(
      window.evaluate(() =>
        window.farolNext.configure({ kind: "chatgpt.sign-in-return" }),
      ),
      "BROWSER_FIXTURE_RETURN_TIMEOUT",
    );
    assert.equal(returned.ok, true);
    await window.locator("#onboarding-return").click();
    for (let index = 0; index < 4; index += 1) {
      const created = await bounded(
        window.evaluate(() =>
          window.farolNext.task({ kind: "task.create-chatgpt" }),
        ),
        "BROWSER_FIXTURE_CREATE_TIMEOUT",
      );
      assert.equal(created.ok, true);
      assert.ok(created.selectedTaskId);
    }
    await window
      .locator('#task-tabs [role="tab"]')
      .nth(3)
      .waitFor({ state: "visible" });
    await browserGeometry(window, environment, 1180);
    await browserGeometry(window, environment, 940);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1180, 760),
    );
    await window.waitForFunction(() => innerWidth === 1180);
    await window.locator('#task-tabs [role="tab"]').first().click();
    assert.equal(
      await window.locator('#task-tabs [aria-selected="true"]').count(),
      1,
    );
    await window.locator("#task-tabs .task-tab-close").last().click();
    await window.waitForFunction(
      () => document.querySelectorAll('#task-tabs [role="tab"]').length === 3,
    );
    await window.locator('.nav-item[data-section="computer"]').click();
    await window.locator("#onboarding-nav").waitFor({ state: "visible" });
    assert.equal(nonReadRequests, 0);
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
} catch (error) {
  primaryFailure = error;
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
      if (error?.message === "GUIDED_SETUP_LATE_LAUNCH_UNRESOLVED") {
        cleanupUnknown = true;
        cleanupFailures.push(error);
      }
    }
  }
  try {
    if (!cleanupUnknown) await closeOwned();
  } catch (error) {
    cleanupFailures.push(error);
  }
  // HTTP cleanup and evidence survive an Electron cleanup refusal/unknown.
  // No second Electron close, signal fallback or replacement app is attempted.
  try {
    await bounded(
      new Promise((resolve, reject) =>
        chatFixture.close((error) => (error ? reject(error) : resolve())),
      ),
      "BROWSER_FIXTURE_CLOSE_TIMEOUT",
    );
    observations.push({ kind: "local-http-fixture-closed", nonReadRequests });
  } catch (error) {
    cleanupFailures.push(error);
    observations.push({ kind: "local-http-fixture-cleanup-unknown" });
  }
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
        primaryFailure: primaryFailure ? String(primaryFailure) : null,
        cleanupFailures: cleanupFailures.map(String),
        cleanupUnknown,
        limits: [
          "Hidden renderer, native page bounds and disposable IPC fixtures only",
          "Browser readiness and task pages are local HTTP fixtures, not live ChatGPT",
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
if (primaryFailure || cleanupFailures.length > 0 || cleanupUnknown) {
  throw new AggregateError(
    [primaryFailure, ...cleanupFailures].filter(Boolean),
    cleanupUnknown ? "GUIDED_SETUP_CLEANUP_UNKNOWN" : "GUIDED_SETUP_FAILED",
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
