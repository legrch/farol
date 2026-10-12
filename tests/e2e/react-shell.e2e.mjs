// Hidden built Electron, disposable profile, synthetic provider document.
// No installed app, connector, provider Send, or dependency installation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { _electron as electron } from "playwright-core";
import {
  assertRuntimeObservation,
  observeElectronRuntime,
} from "../../tooling/runtime-contract.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
import { waitForReactShell } from "./current-react-setup.mjs";
import {
  shellGeometry,
  shellRailWidth,
} from "../../src/pkg/shell-layout/geometry.ts";

const root = await fs.realpath(process.cwd());
const buildRoot = path.join(root, "_output/build/app");
const attemptId = randomUUID();
const output = path.join(root, "_output/evidence/react-shell", attemptId);
const expectedSource = sourceIdentity(root, ".");
assert.equal(expectedSource.dirty, false, "RENDERER_SOURCE_NOT_EXACT");
async function qualifiedBuild() {
  const source = sourceIdentity(root, ".");
  assert.deepEqual(source, expectedSource, "RENDERER_SOURCE_CHANGED");
  const {
    manifest: build,
    identity,
    manifestSha256,
  } = await qualifyGoBuild(buildRoot, source);
  return {
    sourceCommit: source.commit,
    sourceTreeDigest: source.treeDigest,
    buildId: identity.buildId,
    manifestSha256,
    inputLedgerSha256: build.inputLedgerSha256,
    entrySha256: build.entrySha256,
  };
}
const build = await qualifiedBuild();
const declaredRuntimeRoot = process.env.FAROL_RENDERER_TEST_ELECTRON_ROOT;
assert.ok(
  declaredRuntimeRoot && path.isAbsolute(declaredRuntimeRoot),
  "EXPLICIT_ABSOLUTE_REVIEWED_ELECTRON_ROOT_REQUIRED",
);
const runtimeRoot = await fs.realpath(declaredRuntimeRoot);
const runtime = await observeElectronRuntime(runtimeRoot);
assertRuntimeObservation(runtime);
const executable = path.join(
  runtimeRoot,
  "dist/Electron.app/Contents/MacOS/Electron",
);
const directory = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-e2e-home-")),
);
const proof = randomUUID();
await fs.mkdir(output, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(directory, ".farol-next-e2e-root"), proof, {
  mode: 0o600,
});
await fs.mkdir(path.join(directory, "app-data"), { mode: 0o700 });
const workspace = path.join(directory, "approved-folder");
await fs.mkdir(workspace, { mode: 0o700 });
let serverViolation = null;
let documentRequests = 0;
const server = createServer((req, res) => {
  if (req.method !== "GET") {
    serverViolation = "NO_PROVIDER_MUTATION";
    res.writeHead(405);
    res.end();
    return;
  }
  if (req.url !== `/fixture/${attemptId}`) {
    res.writeHead(404);
    res.end();
    return;
  }
  documentRequests++;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><title>Owned synthetic browser</title><p id="fixture" data-attempt="${attemptId}">Owned synthetic browser</p>`,
  );
});
let app;
let child;
let terminal;
let terminalObservation = null;
let launchAttempted = false;
let launchUnresolved = false;
let closeRequested = false;
let closePromise;
let serverClosePromise;
let cancelledBy = null;
let failure;
let assertionsComplete = false;
let rootDisposition = "retained";
const cleanupFailures = [];
const hiddenSnapshots = [];
const observations = [];
async function bounded(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function closeApplicationOnce() {
  if (closePromise) return closePromise;
  assert.ok(app && child && terminal, "OWNED_CHILD_REQUIRED_FOR_CLOSE");
  assert.equal(closeRequested, false, "CLOSE_ALREADY_REQUESTED");
  closeRequested = true;
  closePromise = (async () => {
    const [, exit] = await bounded(
      Promise.all([app.close(), terminal]),
      10000,
      "OWNED_CHILD_CLOSE_UNCONFIRMED",
    );
    assert.deepEqual(
      exit,
      { pid: child.pid, code: 0, signal: null },
      "OWNED_CHILD_CLEAN_TERMINAL_REQUIRED",
    );
  })();
  return closePromise;
}
function closeServerOnce() {
  if (serverClosePromise) return serverClosePromise;
  serverClosePromise = bounded(
    new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      // Only this in-process GET fixture's sockets are released.
      server.closeAllConnections();
    }),
    3000,
    "OWNED_HTTP_CLOSE_UNCONFIRMED",
  );
  return serverClosePromise;
}
function cancel(signal) {
  cancelledBy ??= signal;
  // A launch without a returned handle remains unknown. A later returned
  // handle is captured below and closed once through the same finally path.
  if (app) void closeApplicationOnce().catch(() => {});
}
const onInterrupt = () => cancel("SIGINT");
const onTerminate = () => cancel("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
try {
  server.listen(0, "127.0.0.1");
  await bounded(
    once(server, "listening"),
    3000,
    "OWNED_HTTP_LISTEN_UNCONFIRMED",
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(cancelledBy, null, "FIXTURE_CANCELLED");
  const fixtureUrl = `http://127.0.0.1:${address.port}/fixture/${attemptId}`;
  assert.equal(launchAttempted, false, "LAUNCH_ALREADY_ATTEMPTED");
  launchAttempted = true;
  launchUnresolved = true;
  app = await electron.launch({
    executablePath: executable,
    args: [
      path.join(root, "_output/build/app/main.cjs"),
      `--user-data-dir=${path.join(directory, "user-data")}`,
      "--preview-window-mode=hidden",
    ],
    env: {
      HOME: directory,
      TMPDIR: os.tmpdir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_ENVIRONMENT: "dev",
      FAROL_NEXT_E2E_APP_DATA: path.join(directory, "app-data"),
      FAROL_NEXT_E2E_TEST_ROOT: directory,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
      FAROL_NEXT_E2E_WORKSPACE_ROOT: workspace,
      FAROL_NEXT_E2E_CHATGPT_URL: fixtureUrl,
    },
    timeout: 15000,
  });
  child = app.process();
  assert.ok(
    Number.isSafeInteger(child?.pid) && child.pid > 1,
    "OWNED_CHILD_REQUIRED",
  );
  const ownedPid = child.pid;
  terminal = new Promise((resolve) => {
    const observedExit = (code, signal) => {
      terminalObservation ??= { pid: ownedPid, code, signal };
      resolve(terminalObservation);
    };
    child.once("exit", observedExit);
    if (child.exitCode !== null || child.signalCode !== null)
      observedExit(child.exitCode, child.signalCode);
  });
  launchUnresolved = false;
  assert.equal(cancelledBy, null, "FIXTURE_CANCELLED");
  app.context().setDefaultTimeout(10000);
  app.context().setDefaultNavigationTimeout(10000);
  async function assertHiddenWindows() {
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    );
    hiddenSnapshots.push(windows);
    assert.ok(
      windows.every((window) => !window.visible && !window.focused),
      "ALL_OWNED_WINDOWS_MUST_STAY_HIDDEN",
    );
  }
  await assertHiddenWindows();
  const page = await bounded(
    app.firstWindow(),
    10000,
    "OWNED_WINDOW_UNCONFIRMED",
  );
  await waitForReactShell(page);
  const initialProjection = await page.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(
    initialProjection.environment,
    "dev",
    "ORDINARY_DEV_ROUTE_REQUIRED",
  );
  assert.equal(
    initialProjection.build.buildId,
    build.buildId,
    "RENDERER_RUNNING_BUILD_ID",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1180, 760),
  );
  await page.screenshot({ path: path.join(output, "appearance-light.png") });
  const light = await page
    .locator(".settings-group:visible")
    .first()
    .boundingBox();
  await page.getByRole("button", { name: "Graphite", exact: true }).click();
  const dark = await page
    .locator(".settings-group:visible")
    .first()
    .boundingBox();
  assert.deepEqual(dark, light, "THEME_GEOMETRY_DRIFT");
  await page.screenshot({ path: path.join(output, "appearance-graphite.png") });
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Find a page", exact: true })
    .fill("Workspaces");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".toolbar-title strong");
  assert.equal(
    await page.locator(".toolbar-title strong").textContent(),
    "Workspaces",
  );
  assert.equal(await page.locator("dialog[open]").count(), 0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "NEW_PROFILE_LEGACY_MODAL",
  );
  await page.screenshot({ path: path.join(output, "home.png") });
  // Explicit current rail navigation owns browser presentation. The retired
  // placeholder launcher must not submit another open command.
  await page
    .getByRole("navigation", { name: "Sections", exact: true })
    .getByRole("button", { name: "ChatGPT", exact: true })
    .click();
  const surfaces = async () => {
    await assertHiddenWindows();
    return app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        views: window.contentView.children
          .filter((view) => "webContents" in view)
          .map((view) => ({
            id: view.webContents.id,
            url: view.webContents.getURL(),
            visible: view.getVisible(),
            bounds: view.getBounds(),
          })),
      })),
    );
  };
  await page.waitForTimeout(150);
  let state = await surfaces();
  assert.ok(
    state.every((window) => !window.visible),
    "HIDDEN_WINDOW_REQUIRED",
  );
  const view = state
    .flatMap((window) => window.views)
    .find((view) => view.url === fixtureUrl);
  assert.ok(view, "NATIVE_BROWSER_VIEW_MISSING");
  assert.equal(view.visible, true);
  assert.equal(view.bounds.y, shellGeometry.windowBar);
  const browserId = view.id;
  // Set once in this document's JS world. A same-URL reload in the same
  // WebContents clears this proof even if the server returns identical HTML.
  const documentProof = randomUUID();
  await app.evaluate(
    async ({ webContents }, { id, proof }) => {
      await webContents
        .fromId(id)
        .executeJavaScript(
          `window.__farolNativeDocumentProof = ${JSON.stringify(proof)}`,
        );
    },
    { id: browserId, proof: documentProof },
  );
  const assertBrowserDetachedAndAlive = async (state, code) => {
    assert.equal(
      state
        .flatMap((window) => window.views)
        .some((view) => view.id === browserId),
      false,
      code,
    );
    // Covered views leave the native host/AX tree; their exact WebContents and
    // document must survive until the overlay is dismissed.
    const retained = await app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) return null;
      return {
        id: contents.id,
        url: contents.getURL(),
        attempt: await contents.executeJavaScript(
          "document.getElementById('fixture')?.dataset.attempt",
        ),
        documentProof: await contents.executeJavaScript(
          "window.__farolNativeDocumentProof",
        ),
      };
    }, browserId);
    assert.deepEqual(
      retained,
      { id: browserId, url: fixtureUrl, attempt: attemptId, documentProof },
      "DETACHED_BROWSER_LIFETIME_CHANGED",
    );
  };
  assert.equal(
    await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            "document.getElementById('fixture')?.dataset.attempt",
          ),
      browserId,
    ),
    attemptId,
    "NATIVE_DOCUMENT_ATTEMPT_MISMATCH",
  );
  for (const x of [
    shellGeometry.sidebarRail,
    shellGeometry.sidebarRail + shellGeometry.pageListDefault,
  ]) {
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().getMenuItemById("view.toggle-sidebar").click(),
    );
    await page.waitForTimeout(150);
    const actual = await surfaces();
    assert.equal(
      actual.flatMap((w) => w.views).find((v) => v.id === browserId)?.bounds.x,
      x,
      "NATIVE_MENU_SIDEBAR_BOUNDS",
    );
    assert.equal(
      await page.locator(".contextual-sidebar").count(),
      x === shellGeometry.sidebarRail ? 0 : 1,
      "NATIVE_MENU_RENDERER_SIDEBAR",
    );
  }

  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page.waitForTimeout(100);
  state = await surfaces();
  await assertBrowserDetachedAndAlive(state, "NATIVE_OVERLAY_OCCLUSION");
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    assert.equal(
      await page.evaluate(
        () => document.activeElement?.closest("dialog") !== null,
      ),
      true,
      "MODAL_FOCUS_ESCAPED",
    );
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  state = await surfaces();
  assert.equal(
    state
      .flatMap((window) => window.views)
      .find((view) => view.id === browserId)?.visible,
    true,
  );
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("button", { name: "ChatGPT", exact: true })
    .first()
    .click();
  await page.waitForTimeout(100);
  state = await surfaces();
  assert.ok(
    state
      .flatMap((window) => window.views)
      .some((view) => view.id === browserId),
    "BROWSER_LIFETIME_CHANGED",
  );
  // Resize and compact sidebar are host-owned geometry, not CSS stacking proof.
  await page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(740, 620),
  );
  await page.waitForTimeout(100);
  let compactState = await surfaces();
  assert.equal(
    compactState.flatMap((w) => w.views).find((v) => v.id === browserId)?.bounds
      .x,
    shellRailWidth(740),
    "COMPACT_NATIVE_BOUNDS",
  );
  assert.equal(
    compactState.flatMap((w) => w.views).find((v) => v.id === browserId)
      ?.visible,
    true,
    "COMPACT_RAIL_HID_BROWSER",
  );
  await page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .click();
  await page.waitForTimeout(100);
  compactState = await surfaces();
  await assertBrowserDetachedAndAlive(
    compactState,
    "COMPACT_SIDEBAR_OCCLUSION",
  );
  await page
    .getByRole("button", { name: "Close sidebar", exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1180, 760),
  );
  await page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .click();
  // Synthetic task projection through the real named preload event. This
  // qualifies Chromium field behavior, not backend task admission/lifetime.
  const taskId = "renderer-composition-fixture";
  await app.evaluate(({ BrowserWindow }, taskId) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send("farol-next:tasks-state", {
      revision: 1,
      tasks: [
        {
          taskId,
          sessionId: taskId,
          turnId: taskId,
          label: "Composition fixture",
          provider: "chatgpt",
          requestedModel: null,
          observedModel: null,
          requestedMode: null,
          observedMode: null,
          hasComputer: false,
          pinned: false,
          lifecycle: "idle",
        },
      ],
    });
  }, taskId);
  // Layout events are mirrors, not selection authority. Select this synthetic
  // projection through the current search UI before opening its draft editor.
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Find a page", exact: true })
    .getByRole("button", { name: "Composition fixture", exact: true })
    .click();
  await page.getByRole("button", { name: "Chat options", exact: true }).click();
  const field = page.locator("#agent-objective");
  await field.fill("folder inventory");
  await field.focus();
  await field.evaluate((input) => {
    window.__ownedDraftNode = input;
    window.__compositionCounts = { start: 0, end: 0 };
    input.addEventListener(
      "compositionstart",
      () => window.__compositionCounts.start++,
    );
    input.addEventListener(
      "compositionend",
      () => window.__compositionCounts.end++,
    );
    input.setSelectionRange(6, 6);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "日本",
    selectionStart: 2,
    selectionEnd: 2,
    replacementStart: 6,
    replacementEnd: 6,
  });
  const composing = await field.evaluate((input) => ({
    value: input.value,
    start: input.selectionStart,
    end: input.selectionEnd,
  }));

  await app.evaluate(({ BrowserWindow }, taskId) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    for (let n = 0; n < 24; n++) {
      contents.send("farol-next:layout", {
        section: "browser",
        taskId,
        setupOpen: false,
        sidebar: "full",
        overlay: "none",
      });
      contents.send("farol-next:window-state", {
        focused: false,
        fullScreen: false,
        trafficLightPosition: { x: 14, y: 18 },
      });
    }
  }, taskId);
  await page.waitForTimeout(100);
  assert.equal(
    await field.evaluate((input) => input === window.__ownedDraftNode),
    true,
    "IME_NODE_REPLACED",
  );
  assert.deepEqual(
    await field.evaluate((input) => ({
      value: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
    })),
    composing,
    "IME_CARET_DRIFT",
  );
  assert.equal(
    await page.locator("dialog[open]").count(),
    1,
    "OLD_LAYOUT_CLOSED_TASK_MENU",
  );
  assert.equal(
    await field.evaluate(() => window.__compositionCounts.end),
    0,
    "HOST_EVENT_ENDED_COMPOSITION",
  );
  await cdp.send("Input.insertText", { text: "日本" });
  await field.evaluate((input) =>
    input.setSelectionRange(input.value.length, input.value.length),
  );
  await page.keyboard.insertText("\nsecond line");
  assert.equal(
    await field.inputValue(),
    "folder日本 inventory\nsecond line",
    "IME_MULTILINE_TRUNCATED",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Run Agent", exact: true })
      .isDisabled(),
    true,
    "UNAPPROVED_AGENT_ENABLED",
  );
  await cdp.detach();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  observations.push({
    compactState,
    composition: {
      backgroundEvents: 48,
      nodeStable: true,
      selection: composing.start,
      compositionRetained: true,
      multilinePreserved: true,
    },
  });
  const isolated = await page.evaluate(() => ({
    node: typeof process === "undefined",
    require: typeof require === "undefined",
    ipc: "ipcRenderer" in window.farolNext,
  }));
  assert.deepEqual(isolated, { node: true, require: true, ipc: false });
  const providerIsolation = await app.evaluate(
    async ({ webContents }, id) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          "({api: typeof window.farolNext, node: typeof process, require: typeof require})",
        ),
    browserId,
  );
  assert.deepEqual(
    providerIsolation,
    { api: "undefined", node: "undefined", require: "undefined" },
    "PROVIDER_BRIDGE_LEAK",
  );
  observations.push({
    mode: "hidden",
    windows: state,
    nativeViewId: browserId,
    themeGeometry: light,
    isolation: isolated,
    providerIsolation,
  });
  const requestsBeforeClose = documentRequests;
  const closed = page.waitForEvent("close", { timeout: 10000 });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await closed;
  assert.equal((await surfaces()).length, 0, "CLOSED_WINDOW_NOT_REMOVED");
  const detachedView = await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    return contents && !contents.isDestroyed()
      ? { id: contents.id, url: contents.getURL() }
      : null;
  }, browserId);
  assert.deepEqual(
    detachedView,
    { id: browserId, url: fixtureUrl },
    "WINDOW_CLOSE_DESTROYED_RETAINED_VIEW",
  );
  const replacementPromise = app.waitForEvent("window", { timeout: 10000 });
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().getMenuItemById("app.updates");
    item.click();
  });
  const replacement = await replacementPromise;
  await replacement
    .getByRole("dialog", { name: "Farol updates unavailable", exact: true })
    .waitFor({ state: "visible", timeout: 10000 });
  assert.equal(
    await replacement.locator(".toolbar-title strong").textContent(),
    "Updates",
    "MENU_UPDATES_AFTER_WINDOW_CLOSE",
  );
  assert.ok(
    (await surfaces()).every((w) => !w.visible),
    "REPLACEMENT_WINDOW_TOOK_FOCUS",
  );
  await assertBrowserDetachedAndAlive(
    await surfaces(),
    "REOPEN_UPDATE_OVERLAY_NOT_OCCLUDED",
  );
  await replacement
    .getByRole("dialog", { name: "Farol updates unavailable", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await replacement
    .getByRole("button", { name: "ChatGPT", exact: true })
    .first()
    .click();
  await replacement.waitForTimeout(100);
  const reopenedView = (await surfaces())
    .flatMap((window) => window.views)
    .find((candidate) => candidate.id === browserId);
  assert.ok(reopenedView, "REOPEN_DID_NOT_REATTACH_RETAINED_VIEW");
  assert.equal(reopenedView.url, fixtureUrl, "REOPEN_NAVIGATED_RETAINED_VIEW");
  assert.equal(
    reopenedView.visible,
    true,
    "REOPEN_BROWSER_NOT_VISIBLE_AFTER_DISMISS",
  );
  assert.equal(
    documentRequests,
    requestsBeforeClose,
    "WINDOW_REOPEN_RELOADED_DOCUMENT",
  );
  observations.push({
    menuUpdatesAfterClose: true,
    replacementHidden: true,
    retainedViewAfterClose: detachedView,
    retainedViewAfterReopen: reopenedView,
    documentRequestsBeforeClose: requestsBeforeClose,
    documentRequestsAfterReopen: documentRequests,
  });
  assert.deepEqual(
    await qualifiedBuild(),
    build,
    "RENDERER_BUILD_CHANGED_DURING_RUN",
  );
  assert.deepEqual(
    await observeElectronRuntime(runtimeRoot),
    runtime,
    "RENDERER_RUNTIME_CHANGED_DURING_RUN",
  );
  assert.equal(serverViolation, null, "NO_PROVIDER_MUTATION");
  assert.equal(cancelledBy, null, "FIXTURE_CANCELLED");
  assertionsComplete = true;
} catch (error) {
  failure = error;
} finally {
  try {
    if (app) await closeApplicationOnce();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await closeServerOnce();
  } catch (error) {
    cleanupFailures.push(error);
  }
  // No process lookup, guessed PID, kill fallback, launch retry or close retry.
  // Unknown launch/exit or a failed assertion retains the actual fresh root.
  if (
    !failure &&
    cancelledBy === null &&
    serverViolation === null &&
    cleanupFailures.length === 0 &&
    !launchUnresolved &&
    terminalObservation?.code === 0 &&
    terminalObservation.signal === null
  ) {
    try {
      rootDisposition = "removal-unconfirmed";
      await fs.rm(directory, { recursive: true, force: false });
      rootDisposition = "removed";
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}
const passed =
  assertionsComplete &&
  !failure &&
  cleanupFailures.length === 0 &&
  cancelledBy === null &&
  serverViolation === null &&
  !launchUnresolved &&
  terminalObservation?.code === 0 &&
  terminalObservation.signal === null &&
  rootDisposition === "removed";
const rootRetained =
  rootDisposition === "removal-unconfirmed"
    ? null
    : rootDisposition === "retained";
await fs.writeFile(
  path.join(output, "observations.json"),
  JSON.stringify(
    {
      scope: "built-hidden-disposable-fixture",
      cases: [
        "R04",
        "R25",
        "R26",
        "R29-chromium-composition-fixture",
        "R32",
        "R33",
        "R34",
        "R37-resize-compact",
      ],
      status: passed ? "PASS" : "FAILED",
      attemptId,
      environment: "dev",
      sourceCommit: build.sourceCommit,
      build,
      runtime,
      lifecycle: {
        launchAttempted,
        launchUnresolved,
        closeRequested,
        childTerminal: terminalObservation,
        cancelledBy,
        rootRetained,
        rootDisposition,
        retainedRoot: rootDisposition === "removed" ? null : directory,
        failure: failure?.message ?? null,
        cleanupFailures: cleanupFailures.map((error) => error.message),
      },
      hiddenSnapshots,
      observations,
      limits: [
        "No visible focus/fullscreen/compositor claim",
        "No real folder dialog",
        "CDP composition and synthetic task projection, not OS input method, backend task execution or keyboard layout",
        "No live provider, production connector or installed update",
        "Ordinary Dev application route with proof-bound fresh app-data and a synthetic loopback document, not task/backend or installed Dev acceptance",
        "Hidden-window snapshots do not prove native focus, absence of transient presentation, OS dialogs or Tray popup",
        "Playwright launch rejection has no owned child handle; the attempt is unknown and its fresh root is retained without retry",
        "Only the returned Electron child has terminal evidence; vendor cleanup alone, descendant-process quiescence and abrupt runner termination are not qualified",
      ],
    },
    null,
    2,
  ) + "\n",
);
if (!passed) {
  console.error(
    `FAILED: evidence ${output}; fixture root ${rootDisposition} at ${directory}`,
  );
  throw (
    failure ?? cleanupFailures[0] ?? new Error("RENDERER_FIXTURE_UNCONFIRMED")
  );
}
console.log(
  `PASS: built hidden Dev React fixture, native view occlusion/lifetime; evidence ${output}`,
);
