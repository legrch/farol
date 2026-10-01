// Owned hidden Electron windows and disposable state only. This proves Setup
// selection and IPC/UI integration, never a live account or NEW connector.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import {
  assertOwnerPreviewIdle,
  readOwnedStartupMarker,
} from "./native-preview-admission.mjs";

const packaged = process.argv.includes("--packaged");
const devOnly = process.argv.includes("--dev-only");
const behavior = process.argv.includes("--behavior");
assert.deepEqual(process.argv.slice(2), [
  ...(packaged ? ["--packaged"] : devOnly ? ["--dev-only"] : []),
  ...(behavior ? ["--behavior"] : []),
]);
assert.ok(!(behavior && devOnly));
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
const temporaryRoot = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-guided-setup-")),
);
const proof = randomUUID();
await fs.writeFile(path.join(temporaryRoot, ".farol-next-e2e-root"), proof, {
  mode: 0o600,
});
const workspace = path.join(temporaryRoot, "approved-folder");
await fs.mkdir(workspace, { mode: 0o700 });
const observations = [];
let nonReadRequests = 0;
let fixtureMode = "receipt";
let activeFixtureProfile;
const mcpChildren = [];
const fixtureApp = "NEW fixture";
const tunnelFixture = path.join(temporaryRoot, "tunnel-client.cjs");
await fs.writeFile(
  tunnelFixture,
  `#!${process.execPath}\n${await fs.readFile(new URL("./tunnel-client.fixture.cjs", import.meta.url), "utf8")}`,
  { mode: 0o700 },
);
async function fixtureVerification(prompt) {
  const challenge = /with challenge "([^"]+)" and workspaceId "([^"]+)"/.exec(
    prompt,
  );
  assert.ok(challenge, "FIXTURE_VERIFICATION_PROMPT_INVALID");
  assert.ok(activeFixtureProfile, "FIXTURE_PROFILE_UNCONFIRMED");
  const launchFile = path.join(
    activeFixtureProfile.userData,
    "farol-next-state/secure-mcp-connector/computer-authority/computer-launch.json",
  );
  const transport = new StdioClientTransport({
    command: executable,
    args: [
      path.join(path.dirname(entry), "computer-mcp.cjs"),
      "--launch-contract",
      launchFile,
    ],
    cwd: root,
    env: {
      HOME: activeFixtureProfile.home,
      TMPDIR: os.tmpdir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "owned-embedded-setup-fixture",
    version: "1.0.0",
  });
  const start = transport.start.bind(transport);
  let owned;
  transport.start = async () => {
    const started = start();
    // Only the SDK child created by this disposable fixture. Keep its actual
    // terminal event independently of SDK close's bounded signal attempts.
    const child = transport._process;
    assert.ok(child && child.pid === transport.pid);
    owned = { child, terminal: once(child, "exit") };
    mcpChildren.push(owned);
    await started;
  };
  try {
    await bounded(client.connect(transport), "FIXTURE_MCP_CONNECT_TIMEOUT");
    const result = await bounded(
      client.callTool({
        name: "farol_next_connector_verify",
        arguments: { challenge: challenge[1], workspaceId: challenge[2] },
      }),
      "FIXTURE_MCP_VERIFY_TIMEOUT",
    );
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent?.workspaceId, challenge[2]);
    return "Owned fixture receipt recorded";
  } finally {
    const failures = [];
    try {
      await bounded(client.close(), "FIXTURE_MCP_CLOSE_TIMEOUT");
    } catch (error) {
      failures.push(error);
    }
    if (owned) {
      try {
        if (owned.child.exitCode === null && owned.child.signalCode === null)
          await bounded(owned.terminal, "FIXTURE_MCP_EXIT_TIMEOUT");
        observations.push({
          kind: "owned-mcp-terminal",
          pid: owned.child.pid,
          exit: owned.child.exitCode,
          signal: owned.child.signalCode,
        });
        owned.observed = true;
        assert.equal(owned.child.exitCode, 0);
        assert.equal(owned.child.signalCode, null);
      } catch (error) {
        if (owned.child.exitCode === null && owned.child.signalCode === null) {
          cleanupUnknown = true;
          observations.push({
            kind: "owned-mcp-cleanup-unknown",
            pid: owned.child.pid,
          });
        }
        failures.push(error);
      }
    }
    // A receipt is not cleanup proof. Preserve close failure separately even
    // when the exact same owned child later has a known terminal result.
    cleanupFailures.push(...failures);
    if (failures.length)
      throw new AggregateError(failures, "FIXTURE_MCP_CLEANUP_FAILED");
  }
}
const chatFixture = createServer(async (request, response) => {
  if (
    behavior &&
    request.method === "POST" &&
    request.url === "/fixture-send"
  ) {
    nonReadRequests += 1;
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length < 8192);
      }
      const result =
        fixtureMode === "receipt"
          ? await fixtureVerification(JSON.parse(body).prompt)
          : "Owned fixture reply without a receipt";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }

  if (request.method !== "GET") nonReadRequests += 1;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (behavior) {
    response.end(`<!doctype html><html><head><title>Owned Setup fixture</title></head><body style="margin:24px;font:18px sans-serif">
      <h1>Owned Setup fixture</h1>
      <button aria-label="Close sidebar" onclick="document.body.dataset.sidebarClicks=String(Number(document.body.dataset.sidebarClicks||0)+1);this.setAttribute('aria-label',this.getAttribute('aria-label')==='Close sidebar'?'Open sidebar':'Close sidebar')">Toggle fixture sidebar</button>
      <button aria-label="Turn off temporary chat">Temporary fixture</button><button>Personalized</button><button id="fixture-model-control" aria-label="Select ChatGPT model" onclick="setTimeout(() => { document.querySelector('#fixture-instant-effort').hidden=false; }, 250)">Pro</button><input id="fixture-instant-effort" hidden type="range" min="0" max="5" value="4" aria-label="Fixture Instant effort" oninput="document.querySelector('#fixture-model-control').innerText=this.value==='0'?'Instant':'Pro'" />
      <div id="messages"></div><form onsubmit="return false"><span data-testid="composer-app-chip">${fixtureApp}</span><textarea id="prompt-textarea" aria-label="Fixture composer"></textarea><button type="button" data-testid="send-button" onclick="sendFixture()">Send to owned fixture</button></form>
      <script>
      async function sendFixture() {
        const composer = document.querySelector('#prompt-textarea');
        const prompt = composer.value;
        const user = document.createElement('div');
        user.dataset.messageAuthorRole='user'; user.dataset.messageId='fixture-user-'+Date.now(); user.textContent=prompt;
        document.querySelector('#messages').append(user); composer.value='';
        const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Fixture pending';document.body.append(stop);
        const response=await fetch('/fixture-send',{method:'POST',body:JSON.stringify({prompt})});
        const reply=await response.json();stop.remove();
        const assistant=document.createElement('div');assistant.dataset.messageAuthorRole='assistant';assistant.dataset.messageId='fixture-assistant-'+Date.now();assistant.dataset.parentMessageId=user.dataset.messageId;assistant.textContent=reply.result||reply.error;document.querySelector('#messages').append(assistant);
      }
      </script></body></html>`);
    return;
  }
  response.end(
    `<!doctype html><html><head><title>Local Browser fixture</title></head><body style="margin:24px;font:18px sans-serif"><h1>Local Browser fixture</h1><button aria-label="Close sidebar" onclick="document.body.dataset.sidebarClicks=String(Number(document.body.dataset.sidebarClicks||0)+1);this.setAttribute('aria-label',this.getAttribute('aria-label')==='Close sidebar'?'Open sidebar':'Close sidebar')">Toggle fixture sidebar</button><textarea id="prompt-textarea" aria-label="Fixture composer"></textarea></body></html>`,
  );
});
await bounded(
  new Promise((resolve) => chatFixture.listen(0, "127.0.0.1", resolve)),
  "BROWSER_FIXTURE_LISTEN_TIMEOUT",
);
const chatAddress = chatFixture.address();
assert.ok(chatAddress && typeof chatAddress !== "string");
const fixtureUrl = `http://127.0.0.1:${chatAddress.port}/`;
const ownerPreviewStateRoot = path.join(
  os.homedir(),
  "Library/Application Support/Farol Next Preview/farol-next-state",
);
const profiles = new Map();
let primaryFailure;
const cleanupFailures = [];
let cleanupUnknown = false;
let electronCleanupUnknown = false;
let application;
let profileIsolationConfirmed = false;
let pendingLaunch;
let closingLateLaunch = false;
const childRecords = new Map();

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
    // Observe the SAME pending child exit after a close timeout, never close
    // or signal again. An unknown child stays held and prohibits another launch.
    try {
      await bounded(terminal, "GUIDED_SETUP_EXIT_RECONCILE_TIMEOUT");
    } catch {
      cleanupUnknown = true;
      electronCleanupUnknown = true;
      observations.push({
        kind: "cleanup-unknown",
        pid: child.pid,
        ...childRecords.get(child.pid),
      });
      throw error;
    }
    application = undefined;
    observations.push({
      kind: "owned-process-terminal-after-close-error",
      pid: child.pid,
      exit: child.exitCode,
      signal: child.signalCode,
      ...childRecords.get(child.pid),
    });
    throw error;
  }
  // A terminal nonzero/signal result is known, not an invitation to close again.
  application = undefined;
  observations.push({
    kind: "owned-process-terminal",
    pid: child.pid,
    exit: child.exitCode,
    signal: child.signalCode,
    ...childRecords.get(child.pid),
  });
  assert.equal(child.signalCode, null);
  assert.equal(child.exitCode, 0);
}

async function launch(environment, mode = "normal", profile = mode) {
  assert.equal(
    cleanupUnknown,
    false,
    "GUIDED_SETUP_PRIOR_RESOURCE_CLEANUP_UNKNOWN",
  );
  assert.equal(
    application,
    undefined,
    "GUIDED_SETUP_PRIOR_INSTANCE_NOT_CLOSED",
  );
  observations.push({
    kind: "owner-preview-idle-preflight",
    ...(await assertOwnerPreviewIdle(ownerPreviewStateRoot)),
  });
  profileIsolationConfirmed = false;
  let profileRoot = profiles.get(profile);
  const freshProfile = !profileRoot;
  if (!profileRoot) {
    profileRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-e2e-home-")),
    );
    await fs.writeFile(path.join(profileRoot, ".farol-next-e2e-root"), proof, {
      mode: 0o600,
    });
    profiles.set(profile, profileRoot);
  }
  // The existing startup receipt contract requires a direct OS-temp test HOME.
  const home = profileRoot;
  const appData = path.join(profileRoot, "app-data");
  const userData = path.join(profileRoot, "user-data");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(appData, { recursive: true, mode: 0o700 });
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  const startupMarker = path.join(home, ".farol-next-startup-stage");
  await fs.rm(startupMarker, { force: true });
  await fs.rm(path.join(home, ".farol-next-connector-resume-stage"), {
    force: true,
  });
  const pending = electron.launch({
    executablePath: executable,
    args: [
      entry,
      `--user-data-dir=${userData}`,
      "--preview-window-mode=hidden",
      ...(mode === "demo" ? ["--demo"] : []),
    ],
    env: {
      HOME: home,
      TMPDIR: os.tmpdir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      ...(environment === "dev" ? { FAROL_NEXT_ENVIRONMENT: "dev" } : {}),
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_TEST_ROOT: profileRoot,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
      FAROL_NEXT_E2E_WORKSPACE_ROOT: workspace,
      FAROL_NEXT_E2E_CHATGPT_URL: fixtureUrl,
      ...(behavior ? { FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelFixture } : {}),
      ...(mode === "legacy" ? { FAROL_NEXT_E2E_LEGACY_SETUP: "1" } : {}),
    },
    timeout: 15000,
  });
  // A late launch stays owned and is closed; never start another on top of it.
  closingLateLaunch = false;
  pendingLaunch = pending.then(async (value) => {
    application = value;
    const child = value.process();
    const record = { stdout: "", stderr: "" };
    childRecords.set(child.pid, record);
    for (const stream of ["stdout", "stderr"]) {
      child[stream]?.on("data", (chunk) => {
        record[stream] = (record[stream] + chunk.toString("utf8")).slice(
          -32768,
        );
      });
    }
    child.once("exit", (exit, signal) => {
      observations.push({
        kind: "native-exit-observed",
        at: new Date().toISOString(),
        pid: child.pid,
        exit,
        signal,
        ...record,
      });
    });
    if (closingLateLaunch) await closeOwned();
    return value;
  });
  application = await bounded(pendingLaunch, "GUIDED_SETUP_LAUNCH_TIMEOUT");
  // Preview intentionally ignores the Dev appData override. Prove native
  // paths before touching UI; HOME alone does not select Electron's profile.
  const nativePaths = await application.evaluate(({ app }) => ({
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
  }));
  for (const actual of Object.values(nativePaths)) {
    const physical = await fs.realpath(actual);
    assert.ok(
      physical.startsWith(`${await fs.realpath(profileRoot)}${path.sep}`),
      "GUIDED_SETUP_PROFILE_NOT_OWNED",
    );
  }
  if (environment === "preview")
    assert.equal(
      await fs.realpath(nativePaths.userData),
      await fs.realpath(userData),
    );
  profileIsolationConfirmed = true;
  activeFixtureProfile = { home, userData: nativePaths.userData };
  observations.push({
    kind: "native-profile-isolation",
    environment,
    profileRoot,
    nativePaths,
  });
  const window = await bounded(
    application.firstWindow(),
    "GUIDED_SETUP_WINDOW_TIMEOUT",
    30000,
  );
  await window
    .locator("#sidebar")
    .waitFor({ state: "visible", timeout: 15000 });
  const child = application.process();
  const startupDeadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("GUIDED_SETUP_EXIT_BEFORE_STARTUP_COMPLETE");
    const stage = await fs.readFile(startupMarker, "utf8").catch(() => "");
    if (stage.trim() === "startup-complete") break;
    if (Date.now() >= startupDeadline)
      throw new Error("GUIDED_SETUP_STARTUP_COMPLETE_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  observations.push({ kind: "startup-complete", pid: child.pid, environment });
  const ownedStateRoot = path.join(nativePaths.userData, "farol-next-state");
  const runMarker = await readOwnedStartupMarker(
    ownedStateRoot,
    profileRoot,
    child.pid,
  );
  observations.push({
    kind: "owned-startup-marker",
    stateRoot: ownedStateRoot,
    ...runMarker,
  });
  await application.evaluate(({ app }) => {
    app.on("before-quit", () => {
      process.stderr.write(
        `FAROL_E2E_OWNED_BEFORE_QUIT:${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, userData: app.getPath("userData") })}\n`,
      );
    });
  });
  const bootstrap = await window.evaluate(() => window.farolNext.bootstrap());
  assert.equal(bootstrap.environment, environment);
  assert.equal(bootstrap.legacySetupTestMode, mode === "legacy");
  if (freshProfile && mode === "normal")
    assert.equal(
      bootstrap.configuration.settings.computer.workspaces.length,
      0,
      "GUIDED_SETUP_PROFILE_NOT_EMPTY",
    );
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
    BrowserWindow.getAllWindows()
      .find(
        (window) =>
          window.webContents.getURL().startsWith("file:") &&
          window.webContents.getURL().endsWith("/shell.html"),
      )
      .setContentSize(width, 760);
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
      const owned = BrowserWindow.getAllWindows().find(
        (window) =>
          window.webContents.getURL().startsWith("file:") &&
          window.webContents.getURL().endsWith("/shell.html"),
      );
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
  observations.push({
    kind: "compact-browser-measurement",
    environment,
    width,
    chrome,
    native,
  });
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
  for (const environment of behavior
    ? ["preview"]
    : packaged
      ? ["preview"]
      : devOnly
        ? ["dev"]
        : ["preview", "dev"]) {
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
      undefined,
      { timeout: 15000 },
    );
    // Selection is saved before its access check settles. Do not send the
    // next navigation click while Guided Setup is still deliberately busy.
    await window.waitForFunction(
      () => !document.querySelector("#onboarding-add-folder")?.disabled,
      undefined,
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
    // These are real UI/configuration transitions in the existing owned,
    // hidden fixture. No owner profile, live connector or browser Send.
    await window
      .locator("#onboarding-folder-confirmation")
      .waitFor({ state: "visible" });
    await window.locator("#onboarding-cancel-folder").click();
    assert.equal(
      (await window.evaluate(() => window.farolNext.bootstrap())).configuration
        .settings.computer.workspaces[0].access,
      "read",
    );
    await window
      .locator('.nav-utility .nav-item[data-section="settings"]')
      .click();
    await window
      .locator('#settings-nav [data-settings-category="preferences"]')
      .click();
    await window
      .locator("#computer-workspaces")
      .getByRole("button", { name: "Enable edits", exact: true })
      .click();
    await window
      .locator("#onboarding-folder-confirmation")
      .waitFor({ state: "visible" });
    assert.equal(
      (await window.evaluate(() => window.farolNext.bootstrap())).configuration
        .settings.computer.workspaces[0].access,
      "read",
    );
    await window.locator("#onboarding-confirm-folder").click();
    await window
      .locator('#onboarding-form[aria-busy="false"]')
      .waitFor({ state: "attached" });
    let accessState = await window.evaluate(() => window.farolNext.bootstrap());
    assert.equal(
      accessState.configuration.settings.computer.workspaces[0].access,
      "write",
    );
    assert.notEqual(
      accessState.configuration.settings.computer.commands,
      "workspace",
    );
    assert.notEqual(
      accessState.configuration.settings.computer.workspaces[0]
        .gitHistoryApproved,
      true,
    );
    assert.equal(
      accessState.configuration.settings.connectors.secureMcp.runtime,
      null,
    );
    // Read-only remains actionable even for an incomplete local-work grant.
    await window
      .locator("#onboarding-folder-list")
      .getByRole("button", { name: "Use read-only…", exact: true })
      .click();
    await window.locator("#onboarding-confirm-folder").click();
    await window
      .locator('#onboarding-form[aria-busy="false"]')
      .waitFor({ state: "attached" });
    accessState = await window.evaluate(() => window.farolNext.bootstrap());
    assert.equal(
      accessState.configuration.settings.computer.workspaces[0].access,
      "read",
    );
    assert.notEqual(
      accessState.configuration.settings.computer.workspaces[0]
        .gitHistoryApproved,
      true,
    );
    observations.push({
      kind: "settings-edits-explicit-consent-and-independent-downgrade",
      environment,
      liveSends: 0,
    });
    if (environment === "preview") {
      await window.locator('[data-onboarding-step="app"]').click();
      assert.match(
        await window.locator("#onboarding-copy").innerText(),
        /sends one short message/,
      );
      assert.equal(
        await window.locator("#onboarding-verify-again").isVisible(),
        false,
      );
      await window
        .locator("#onboarding-verification-method")
        .selectOption("external");
      assert.match(
        await window.locator("#onboarding-copy").innerText(),
        /does not send a message/,
      );
      await window
        .locator("#onboarding-verification-method")
        .selectOption("embedded");
    }
    {
      await window
        .locator('.nav-utility .nav-item[data-section="settings"]')
        .click();
      await window.locator('[data-panel="settings"].active').waitFor();
      await window
        .locator("#computer-command-policy")
        .waitFor({ state: "visible" });
      await window
        .locator('#settings-nav [data-settings-category="diagnostics"]')
        .click();
      const connection = window.locator("#connection-diagnostics");
      if (!(await connection.evaluate((details) => details.open)))
        await connection.locator("summary").click();
    }
    await window.locator("#review-setup").click();
    await window.locator("#onboarding-return").click();
    await window.locator('[data-panel="browser"].active').waitFor();
    // The application menu must reach Settings in both normal environments;
    // the disposable, non-installed profile cannot check the live update channel.
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("app.updates");
      if (!item?.click) throw new Error("UPDATE_MENU_ITEM_MISSING");
      item.click();
    });
    await window.locator('[data-panel="settings"].active').waitFor();
    assert.equal(await window.locator("#onboarding-nav").isVisible(), false);
    assert.equal(
      await window.locator(".installed-update-preferences").isVisible(),
      true,
      "UPDATE_MENU_RESULT_HIDDEN",
    );
    assert.equal(
      await window
        .locator('#settings-nav [data-settings-category="preferences"]')
        .getAttribute("aria-current"),
      "page",
    );
    observations.push({ kind: "update-menu-opens-settings", environment });
    // Settings already owns the rail; the former utility item is hidden.
    // Review Setup must remain reachable in an empty profile.
    {
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

    if (behavior) {
      // Real configuration IPC and owned tunnel health, with no embedded login
      // witness yet. Save does not start a process or expose its saved key.
      await window.locator('[data-onboarding-step="tunnel"]').click();
      await window.locator("#onboarding-tunnel-id").fill("new_fixture_tunnel");
      await window
        .locator("#onboarding-runtime-key")
        .fill("synthetic-owned-fixture-runtime-key");
      await window.locator("#onboarding-primary").click();
      await window
        .locator("#onboarding-credentials-saved")
        .waitFor({ state: "visible" });
      let state = await window.evaluate(() => window.farolNext.bootstrap());
      assert.equal(
        state.configuration.settings.connectors.secureMcp.runtime,
        null,
      );
      assert.equal(state.configuration.settings.setup.chatgpt.verified, null);
      await window.locator("#onboarding-replace-credentials").click();
      assert.equal(
        await window.locator("#onboarding-runtime-key").inputValue(),
        "",
      );
      await window
        .locator("#onboarding-runtime-key")
        .fill("unused-fixture-replacement-runtime-key");
      await window.locator("#onboarding-keep-credentials").click();
      assert.deepEqual(
        (await window.evaluate(() => window.farolNext.bootstrap()))
          .configuration,
        state.configuration,
      );
      await window.locator("#onboarding-primary").click();
      await window
        .locator('[data-onboarding-step="tunnel"].complete')
        .waitFor({ timeout: 30000 });
      state = await window.evaluate(() => window.farolNext.bootstrap());
      assert.equal(state.configuration.settings.setup.chatgpt.verified, null);
      assert.equal(
        state.configuration.settings.connectors.secureMcp.runtime.state,
        "ready",
      );
      assert.equal(
        state.configuration.settings.connectors.secureMcp.attachment,
        null,
      );
      const priorRuntime =
        state.configuration.settings.connectors.secureMcp.runtime
          .runtimeGeneration;
      await window.locator('[data-onboarding-step="folder"]').click();
      await window
        .locator("#onboarding-folder-list")
        .getByRole("button", { name: "Allow edits & commands…", exact: true })
        .click();
      await window.locator("#onboarding-confirm-folder").click();
      await window
        .locator('#onboarding-form[aria-busy="false"]')
        .waitFor({ state: "attached", timeout: 30000 });
      state = await window.evaluate(() => window.farolNext.bootstrap());
      assert.equal(
        state.configuration.settings.computer.workspaces[0].access,
        "write",
      );
      assert.equal(state.configuration.settings.computer.commands, "workspace");
      assert.equal(
        state.configuration.settings.computer.workspaces[0].gitHistoryApproved,
        true,
      );
      assert.equal(
        state.configuration.settings.connectors.secureMcp.runtime.state,
        "ready",
      );
      assert.notEqual(
        state.configuration.settings.connectors.secureMcp.runtime
          .runtimeGeneration,
        priorRuntime,
      );
      assert.equal(
        state.configuration.settings.connectors.secureMcp.runtime
          .computerGeneration,
        state.configuration.settings.computer.generation,
      );
      const grantedRuntime =
        state.configuration.settings.connectors.secureMcp.runtime
          .runtimeGeneration;
      assert.equal(nonReadRequests, 0);
      await window
        .locator("#onboarding-folder-list")
        .getByRole("button", { name: "Use read-only…", exact: true })
        .click();
      await window.locator("#onboarding-confirm-folder").click();
      await window
        .locator('#onboarding-form[aria-busy="false"]')
        .waitFor({ state: "attached", timeout: 30000 });
      state = await window.evaluate(() => window.farolNext.bootstrap());
      assert.equal(
        state.configuration.settings.computer.workspaces[0].access,
        "read",
      );
      assert.equal(
        state.configuration.settings.computer.workspaces[0].gitHistoryApproved,
        false,
      );
      assert.equal(
        state.configuration.settings.connectors.secureMcp.runtime.state,
        "ready",
      );
      assert.equal(nonReadRequests, 0);
      assert.notEqual(
        state.configuration.settings.connectors.secureMcp.runtime
          .runtimeGeneration,
        grantedRuntime,
      );
      assert.equal(
        state.configuration.settings.connectors.secureMcp.runtime
          .computerGeneration,
        state.configuration.settings.computer.generation,
      );
      observations.push({
        kind: "local-work-approval-and-revocation-reconnect-without-send",
        environment,
      });
      const noTarget = await window.evaluate(() =>
        window.farolNext.configure({ kind: "connector.verify-app" }),
      );
      assert.equal(noTarget.error, "CONNECTOR_APP_TARGET_REQUIRED");
      assert.equal(nonReadRequests, 0);
      await window.locator('[data-onboarding-step="app"]').click();
      await window.locator("#onboarding-app-name").fill(fixtureApp);
      await window.locator("#onboarding-save-app").click();
      await window
        .locator('#onboarding-form[aria-busy="false"]')
        .waitFor({ state: "attached" });
      state = await window.evaluate(() => window.farolNext.bootstrap());
      assert.equal(
        state.configuration.settings.connectors.secureMcp.chatgptApp.name,
        fixtureApp,
      );
      observations.push({
        kind: "activation-without-embedded-login",
        noTarget: noTarget.error,
        runtime: "ready",
        sends: nonReadRequests,
      });
    }
    // Readiness and task views use only the local composer fixture. No Send,
    // external account, Codex task or inference is performed.
    await window.locator('[data-onboarding-step="chatgpt"]').click();
    await window.locator("#onboarding-open-account").click();
    await window.locator("#sign-in-return").waitFor({ state: "visible" });
    await window.waitForFunction(
      () => document.documentElement.dataset.section === "browser",
    );
    const embedded = await application.evaluate(
      ({ BrowserWindow, WebContentsView }, fixtureUrl) => {
        const windows = BrowserWindow.getAllWindows();
        const shell = windows.find(
          (window) =>
            window.webContents.getURL().startsWith("file:") &&
            window.webContents.getURL().endsWith("/shell.html"),
        );
        return {
          windowCount: windows.length,
          hidden: windows.every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
          pageVisible:
            shell?.contentView.children.some(
              (child) =>
                child instanceof WebContentsView &&
                child.webContents.getURL() === fixtureUrl &&
                child.getVisible(),
            ) ?? false,
        };
      },
      fixtureUrl,
    );
    assert.deepEqual(embedded, {
      windowCount: 1,
      hidden: true,
      pageVisible: true,
    });
    observations.push({
      kind: "embedded-sign-in-surface",
      environment,
      ...embedded,
    });
    let authReturnEventId = null;
    const authReturnHandled = window
      .waitForEvent("console", {
        timeout: 15000,
        predicate: (message) => {
          const match = /^farol\.shell-(action|decision) (.+)$/u.exec(
            message.text(),
          );
          if (!match) return false;
          let event;
          try {
            event = JSON.parse(match[2]);
          } catch {
            return false;
          }
          if (match[1] === "action" && event.source === "auth-window-closed") {
            authReturnEventId = event.eventId;
            return false;
          }
          return (
            match[1] === "decision" &&
            typeof authReturnEventId === "string" &&
            event.eventId === authReturnEventId &&
            event.refreshReadiness === true
          );
        },
      })
      .then(
        () => null,
        (error) => error,
      );
    await window.locator("#sign-in-return").click();
    const authReturnError = await authReturnHandled;
    if (authReturnError) throw authReturnError;
    await window.locator("#onboarding-nav").waitFor({ state: "visible" });
    const readinessDeadline = Date.now() + 15000;
    for (;;) {
      const snapshot = await bounded(
        window.evaluate(() => window.farolNext.bootstrap()),
        "BROWSER_FIXTURE_READINESS_REPLY_TIMEOUT",
        5000,
      );
      if (snapshot.configuration.settings.setup.chatgpt.verified !== null)
        break;
      if (Date.now() >= readinessDeadline)
        throw new Error("BROWSER_FIXTURE_READINESS_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The matching auth-close action and renderer decision were observed.
    // Assert the settled step, not a transient layout before that action.
    assert.equal(
      await window.locator("html").getAttribute("data-section"),
      "computer",
      "SIGN_IN_RETURN_LEFT_GUIDED_SETUP",
    );
    assert.equal(await window.locator("#onboarding-nav").isVisible(), true);
    observations.push({
      kind: "embedded-sign-in-return",
      environment,
      taskCount: (await window.evaluate(() => window.farolNext.bootstrap()))
        .tasks.length,
    });
    if (behavior) {
      await window.locator('[data-onboarding-step="app"]').click();
      await window.locator("#onboarding-primary").click();
      await window
        .locator('#browser-check-banner[data-tone="complete"]')
        .waitFor({ state: "visible", timeout: 30000 });
      assert.equal(nonReadRequests, 1);
      let state = await window.evaluate(() => window.farolNext.bootstrap());
      assert.ok(state.configuration.settings.connectors.secureMcp.attachment);
      assert.equal(
        state.configuration.settings.setup.connect.outcomeUnknown,
        false,
      );
      let visibleReply;
      const visibleReplyDeadline = Date.now() + 30000;
      for (;;) {
        visibleReply = await bounded(
          application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
            const shell = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().endsWith("/shell.html"),
            );
            const page = shell.contentView.children.find(
              (child) => child instanceof WebContentsView && child.getVisible(),
            );
            return {
              url: page.webContents.getURL(),
              reply: await page.webContents.executeJavaScript(
                "document.querySelector('[data-message-author-role=assistant]')?.innerText",
              ),
            };
          }),
          "FIXTURE_VISIBLE_REPLY_READ_TIMEOUT",
          5000,
        );
        if (visibleReply.reply === "Owned fixture receipt recorded") break;
        if (Date.now() >= visibleReplyDeadline)
          throw new Error("FIXTURE_VISIBLE_REPLY_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(visibleReply.url, /temporary-chat=true/);
      assert.equal(visibleReply.reply, "Owned fixture receipt recorded");
      await window.locator("#browser-check-return").click();
      await window.locator("#onboarding-nav").waitFor({ state: "visible" });
      await window.locator('[data-onboarding-step="app"]').click();
      assert.equal(
        await window.locator("#onboarding-verify-again").isVisible(),
        true,
      );
      observations.push({
        kind: "embedded-current-receipt-and-visible-reply",
        sends: nonReadRequests,
        ...visibleReply,
      });
      // Preserve a completed profile, then re-open it. Runtime shutdown makes
      // live attachment stale; no implicit Send may restore it.
      const previousRuntime =
        state.configuration.settings.connectors.secureMcp.runtime;
      const previousWorkspaces =
        state.configuration.settings.computer.workspaces;
      await closeOwned();
      let returning = await launch(environment, "normal", environment);
      // A confirmed Quit permits this configured Computer-only connector to
      // establish a new runtime. It never sends or reuses the old attachment.
      let resumed;
      const resumeDeadline = Date.now() + 15000;
      for (;;) {
        resumed = await bounded(
          returning.evaluate(() => window.farolNext.bootstrap()),
          "FIXTURE_CONNECTOR_RESUME_READ_TIMEOUT",
          5000,
        );
        const runtime =
          resumed.configuration.settings.connectors.secureMcp.runtime;
        if (
          runtime?.state === "ready" &&
          runtime.runtimeGeneration !== previousRuntime.runtimeGeneration
        )
          break;
        if (Date.now() >= resumeDeadline)
          throw new Error("CONFIGURED_COMPUTER_CONNECTOR_NOT_RESUMED");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(nonReadRequests, 1, "CONNECTOR_RESUME_SENT_A_PROMPT");
      assert.equal(
        resumed.configuration.settings.connectors.secureMcp.attachment,
        null,
      );
      assert.equal(resumed.configuration.settings.setup.connect.verified, null);
      assert.equal(
        resumed.configuration.settings.connectors.secureMcp.runtime.buildId,
        resumed.build.buildId,
      );
      assert.deepEqual(
        resumed.configuration.settings.computer.workspaces,
        previousWorkspaces,
      );
      observations.push({
        kind: "configured-computer-connector-resumed-without-send",
        previousRuntime: previousRuntime.runtimeGeneration,
        currentRuntime:
          resumed.configuration.settings.connectors.secureMcp.runtime
            .runtimeGeneration,
        sends: nonReadRequests,
      });
      await returning.locator('[data-onboarding-step="tunnel"]').click();
      await returning
        .locator("#onboarding-recheck")
        .waitFor({ state: "visible" });
      // Stop is an explicit owner decision, not a reason to auto-reconnect.
      const stopped = await returning.evaluate(() =>
        window.farolNext.configure({ kind: "connector.stop" }),
      );
      assert.equal(stopped.ok, true);
      await closeOwned();
      returning = await launch(environment, "normal", environment);
      const stoppedState = await returning.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.equal(
        stoppedState.configuration.settings.connectors.secureMcp.runtime,
        null,
      );
      assert.equal(
        (
          await fs.readFile(
            path.join(
              activeFixtureProfile.home,
              ".farol-next-connector-resume-stage",
            ),
            "utf8",
          )
        ).trim(),
        "connector-resume-skipped",
      );
      assert.equal(nonReadRequests, 1);
      observations.push({
        kind: "explicit-stop-preserved-after-reopen",
        sends: nonReadRequests,
      });
      // The later explicit fresh-check action restores the stopped local
      // fixture through normal UI recovery. Direct IPC would leave the
      // renderer stale and cause a duplicate start before that check.
      await returning.locator('[data-onboarding-step="app"]').click();
      assert.equal(
        await returning.locator("#onboarding-app-name").inputValue(),
        fixtureApp,
      );
      assert.equal(nonReadRequests, 1);
      fixtureMode = "no-receipt";
      await returning.locator("#onboarding-verify-again").click();
      await returning.locator("#onboarding-confirm-new-check").click();
      await returning
        .locator('#browser-check-banner[data-tone="failed"]')
        .waitFor({ state: "visible", timeout: 65000 });
      state = await returning.evaluate(() => window.farolNext.bootstrap());
      assert.equal(
        state.configuration.settings.setup.connect.outcomeUnknown,
        true,
      );
      assert.equal(nonReadRequests, 2);
      const noReplay = await returning.evaluate(() =>
        window.farolNext.configure({ kind: "connector.verify-app" }),
      );
      assert.equal(
        noReplay.error,
        "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
      );
      const noRetarget = await returning.evaluate((name) => {
        return window.farolNext.bootstrap().then(({ configuration }) =>
          window.farolNext.configure({
            kind: "connector.select-chatgpt-app",
            name,
            tunnelId: configuration.settings.connectors.secureMcp.tunnelId,
            connectorGeneration:
              configuration.settings.connectors.secureMcp.generation,
          }),
        );
      }, "Another fixture");
      assert.equal(
        noRetarget.error,
        "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
      );
      await returning.locator("#browser-check-return").click();
      await returning.locator("#onboarding-nav").waitFor({ state: "visible" });
      await returning.locator('[data-onboarding-step="app"]').click();
      await returning.locator("#onboarding-diagnostics").click();
      await returning
        .locator(
          '#settings-nav [data-settings-category="diagnostics"][aria-current="page"]',
        )
        .waitFor({ state: "visible" });
      assert.equal(
        await returning
          .locator("#connection-diagnostics")
          .evaluate((details) => details.open),
        true,
      );
      assert.equal(nonReadRequests, 2);
      observations.push({
        kind: "returning-stale-then-pending-no-replay",
        sends: nonReadRequests,
        noReplay: noReplay.error,
        noRetarget: noRetarget.error,
      });
      const unknownGeneration =
        state.configuration.settings.connectors.secureMcp.runtime
          .runtimeGeneration;
      await closeOwned();
      returning = await launch(environment, "normal", environment);
      const unknownState = await returning.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.equal(
        unknownState.configuration.settings.setup.connect.outcomeUnknown,
        true,
      );
      assert.equal(
        unknownState.configuration.settings.connectors.secureMcp.runtime
          .runtimeGeneration,
        unknownGeneration,
      );
      assert.equal(
        (
          await fs.readFile(
            path.join(
              activeFixtureProfile.home,
              ".farol-next-connector-resume-stage",
            ),
            "utf8",
          )
        ).trim(),
        "connector-resume-skipped",
      );
      assert.equal(nonReadRequests, 2);
      observations.push({
        kind: "unknown-check-not-resumed-after-reopen",
        sends: nonReadRequests,
      });
      await closeOwned();
      break;
    }
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
    // The shell control must operate the visible selected page, not the
    // retained (hidden) home/sign-in route. The fixture has no Send control.
    await window
      .locator("#browser-sidebar-toggle")
      .waitFor({ state: "visible" });
    const sidebarSnapshot = () =>
      application.evaluate(
        async ({ BrowserWindow, WebContentsView }, fixtureUrl) => {
          const shell = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().endsWith("/shell.html"),
          );
          const fixture = new URL(fixtureUrl);
          const pages = shell.contentView.children.filter((child) => {
            if (!(child instanceof WebContentsView)) return false;
            const page = new URL(child.webContents.getURL());
            return (
              page.origin === fixture.origin &&
              page.pathname === fixture.pathname
            );
          });
          return Promise.all(
            pages.map(async (page) => ({
              id: page.webContents.id,
              visible: page.getVisible(),
              url: page.webContents.getURL(),
              clicks: await page.webContents.executeJavaScript(
                "Number(document.body.dataset.sidebarClicks || 0)",
              ),
              sidebar: await page.webContents.executeJavaScript(
                "document.querySelector('button[aria-label]')?.getAttribute('aria-label')",
              ),
            })),
          );
        },
        fixtureUrl,
      );
    // Model the provider control changing state after automatic collapse.
    // Wait for every owned page's initial collapse before measuring the owner
    // toggle; asynchronous initialization is not a manual route effect.
    let sidebarBefore;
    const collapseDeadline = Date.now() + 5000;
    for (;;) {
      sidebarBefore = await bounded(
        sidebarSnapshot(),
        "SIDEBAR_BASELINE_TIMEOUT",
      );
      if (sidebarBefore.every((page) => page.sidebar === "Open sidebar")) break;
      if (Date.now() >= collapseDeadline)
        throw new Error("INITIAL_PAGE_SIDEBAR_NOT_COLLAPSED");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sidebarBefore.filter((page) => page.visible).length, 1);
    assert.equal(
      await window
        .locator("#browser-sidebar-toggle")
        .evaluate((button) =>
          getComputedStyle(button).getPropertyValue("-webkit-app-region"),
        ),
      "no-drag",
      "BROWSER_SIDEBAR_TOGGLE_IS_DRAGGABLE",
    );
    await window.locator("#browser-sidebar-toggle").click();
    let sidebarPages;
    const sidebarDeadline = Date.now() + 5000;
    for (;;) {
      sidebarPages = await bounded(
        sidebarSnapshot(),
        "SIDEBAR_READBACK_TIMEOUT",
        5000,
      );
      if (
        sidebarPages.some(
          (page) =>
            page.visible &&
            page.clicks ===
              sidebarBefore.find((before) => before.id === page.id).clicks + 1,
        )
      )
        break;
      if (Date.now() >= sidebarDeadline)
        throw new Error("SELECTED_PAGE_SIDEBAR_UNCHANGED");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Observe beyond the next hydration retry ticks: the owner's opening
    // must remain in place, not be undone after an initially successful click.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    sidebarPages = await bounded(sidebarSnapshot(), "SIDEBAR_SETTLED_TIMEOUT");
    for (const page of sidebarPages) {
      const before = sidebarBefore.find(
        (candidate) => candidate.id === page.id,
      );
      assert.ok(before);
      assert.equal(page.clicks - before.clicks, page.visible ? 1 : 0);
    }
    observations.push({
      kind: "selected-page-sidebar",
      environment,
      pages: sidebarPages,
    });
    await browserGeometry(window, environment, 1180);
    await browserGeometry(window, environment, 940);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find(
          (window) =>
            window.webContents.getURL().startsWith("file:") &&
            window.webContents.getURL().endsWith("/shell.html"),
        )
        .setContentSize(1180, 760),
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
  for (const mode of devOnly || behavior ? [] : ["legacy", "demo"]) {
    const window = await launch("preview", mode);
    await window.locator("#setup-dialog").waitFor({ state: "visible" });
    assert.equal(await window.locator("#onboarding-nav").isVisible(), false);
    await closeOwned();
  }
} catch (error) {
  primaryFailure = error;
  if (application && profileIsolationConfirmed) {
    try {
      const windows = application.windows();
      const shell = windows.find(
        (window) =>
          window.url().startsWith("file:") &&
          window.url().endsWith("/shell.html"),
      );
      if (shell)
        observations.push({
          kind: "failure-ui-feedback",
          ...(await bounded(
            shell.evaluate(async () => {
              const bootstrap = await window.farolNext.bootstrap();
              return {
                feedback: document.querySelector("#onboarding-feedback")
                  ?.textContent,
                folders: document.querySelector("#onboarding-folder-list")
                  ?.textContent,
                workspaces:
                  bootstrap.configuration.settings.computer.workspaces.map(
                    ({ root, access }) => ({ root, access }),
                  ),
                environment: bootstrap.environment,
              };
            }),
            "GUIDED_SETUP_FAILURE_FEEDBACK_TIMEOUT",
          )),
        });
    } catch (feedbackError) {
      observations.push({
        kind: "failure-feedback-unavailable",
        error: String(feedbackError),
      });
    }
  }
  if (application && !profileIsolationConfirmed)
    observations.push({ kind: "failure-feedback-skipped-unverified-profile" });
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
        electronCleanupUnknown = true;
        cleanupFailures.push(error);
      }
    }
  }
  try {
    if (!electronCleanupUnknown) await closeOwned();
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
  for (const owned of mcpChildren) {
    if (owned.observed) continue;
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      observations.push({
        kind: "owned-mcp-terminal-final-readback",
        pid: owned.child.pid,
        exit: owned.child.exitCode,
        signal: owned.child.signalCode,
      });
      owned.observed = true;
    } else {
      cleanupUnknown = true;
      observations.push({
        kind: "owned-mcp-cleanup-unknown-final-readback",
        pid: owned.child.pid,
      });
    }
  }
  const destination = path.join(
    root,
    "_output/evidence/guided-setup-selection",
    behavior
      ? packaged
        ? "behavior-package.json"
        : "behavior-development.json"
      : packaged
        ? "package.json"
        : devOnly
          ? "dev-only.json"
          : "development.json",
  );
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    destination,
    JSON.stringify(
      {
        schema: 1,
        packaged,
        devOnly,
        behavior,
        observations,
        primaryFailure: primaryFailure ? String(primaryFailure) : null,
        cleanupFailures: cleanupFailures.map(String),
        cleanupUnknown,
        limits: [
          "Hidden renderer, native page bounds and disposable IPC fixtures only",
          behavior
            ? "Embedded Send, app chip and provider reply are owned local HTTP fixtures; no live ChatGPT"
            : "Browser readiness and task pages are local HTTP fixtures, not live ChatGPT",
          "Native folder picker is replaced by the explicit E2E selection",
          "No live account, provider Send, model inference or live NEW connector",
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
