import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { parseOwnerLaunchResult } from "../../tooling/owner-launch-result.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { verifyInputManifest } from "../../tooling/build-contract.mjs";
import { verifyGoCoreArtifact } from "../../tooling/go-core-artifact.mjs";
import {
  shellGeometry,
  shellRailWidth,
} from "../../src/pkg/shell-layout/geometry.ts";
import {
  startChatGptFixture,
  stopChatGptFixture,
} from "./fixtures/chatgpt-site.mjs";

import {
  openSetup,
  setupStep,
  setupAction,
  assertSetupOverview,
} from "./current-react-setup.mjs";

const uncheckedOverview = {
  ready: false,
  signIn: "unknown",
  states: {
    signin: "unknown",
    folders: "needed",
    connection: "needed",
    attachment: "needed",
  },
};

const root = process.cwd();
const useInstalledTunnelClient = process.argv.includes(
  "--installed-tunnel-client",
);
const buildRoot = path.join(root, "_output/build/app");
const executable = path.join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
// Drive exact built React bytes. This hidden lane proves DOM/application
// integration through normal Go startup, not native focus, the OS folder dialog,
// external ChatGPT attachment or a live provider. The ordinary Dev supplies the
// separate external witness; these profiles never borrow its credential.
const source = sourceIdentity(root, ".");
const build = JSON.parse(
  await fs.readFile(path.join(buildRoot, "build-manifest.json"), "utf8"),
);
assert.equal(source.dirty, false, "DEV_REACT_SOURCE_NOT_EXACT");
assert.equal(
  build.sourceCommit,
  source.commit,
  "DEV_REACT_BUILD_COMMIT_MISMATCH",
);
assert.equal(
  build.sourceTreeDigest,
  source.treeDigest,
  "DEV_REACT_BUILD_TREE_MISMATCH",
);
assert.equal(build.dirty, false, "DEV_REACT_BUILD_DIRTY");
assert.equal(build.inputExact, true, "DEV_REACT_INPUTS_NOT_EXACT");
await verifyInputManifest(buildRoot, build);
assert.equal(build.schema, 4, "DEV_SETUP_REQUIRES_GO_BUILD");
const identity = JSON.parse(
  await fs.readFile(path.join(buildRoot, "build-identity.json"), "utf8"),
);
await verifyGoCoreArtifact(buildRoot, build.core, identity);
const attemptId = randomUUID();
const evidenceRoot = path.join(root, "_output/evidence/react-setup", attemptId);
await fs.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const report = {
  attemptId,
  source,
  buildId: identity.buildId,
  launches: [],
  checks: [],
  status: "running",
};
const save = () =>
  fs.writeFile(
    path.join(evidenceRoot, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
await save();
const temporaryRoot = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-onboarding-startup-")),
);
const isolatedHome = path.join(temporaryRoot, "home");
const isolatedAppData = path.join(temporaryRoot, "app-data");
await fs.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
await fs.mkdir(isolatedAppData, { recursive: true, mode: 0o700 });
const e2eRootProof = randomUUID();
await fs.writeFile(
  path.join(temporaryRoot, ".farol-next-e2e-root"),
  e2eRootProof,
  { mode: 0o600 },
);
const tunnelFixture = path.join(temporaryRoot, "tunnel-client.cjs");
const tunnelFixtureSource = await fs.readFile(
  new URL("./tunnel-client.fixture.cjs", import.meta.url),
  "utf8",
);
await fs.writeFile(
  tunnelFixture,
  `#!${process.execPath}\n${tunnelFixtureSource}`,
  { mode: 0o700 },
);

const environment = {
  FAROL_NEXT_E2E: "1",
  FAROL_NEXT_E2E_APP_DATA: isolatedAppData,
  FAROL_NEXT_E2E_TEST_ROOT: temporaryRoot,
  FAROL_NEXT_E2E_TEST_PROOF: e2eRootProof,
  ...(useInstalledTunnelClient
    ? {}
    : { FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelFixture }),
  FAROL_NEXT_ENVIRONMENT: "dev",
  HOME: isolatedHome,
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: os.tmpdir(),
};

const stopRequested = new WeakSet();
let cleanupConfirmed = true;
let launchUnresolved = false;
let passed = false;
const ownedLaunches = new WeakMap();
async function launchApplication(env) {
  launchUnresolved = true;
  const result = await electron.launch({
    executablePath: executable,
    args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    env,
    timeout: 15_000,
  });
  launchUnresolved = false;
  // Retain the returned child before diagnostic I/O can fail. The outer
  // finally still owns one ordinary close even if startup observation fails.
  application = result;
  const record = { pid: result.process().pid, status: "child-returned" };
  ownedLaunches.set(result, record);
  report.launches.push(record);
  await save();
  const first = await result.firstWindow({ timeout: 15_000 });
  await ready(first);
  await assertHiddenWindows(result);
  const userData = await result.evaluate(({ app }) => app.getPath("userData"));
  record.stateRoot = path.join(userData, "farol-next-state");
  const marker = JSON.parse(
    await fs.readFile(path.join(record.stateRoot, "running.json"), "utf8"),
  );
  assert.equal(marker.pid, result.process().pid);
  record.startedAt = marker.startedAt;
  record.status = "ready";
  await save();
  return result;
}
async function stopApplication(application, ownerSignal) {
  assert.equal(
    stopRequested.has(application),
    false,
    "DEV_REACT_STOP_ALREADY_REQUESTED",
  );
  stopRequested.add(application);
  const child = application.process();
  const closed = once(application, "close");
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("DEV_REACT_CLOSE_UNCONFIRMED")),
      10_000,
    );
    timer.unref();
  });
  try {
    if (ownerSignal) child.kill("SIGINT");
    else await Promise.race([application.close(), deadline]);
    await Promise.race([closed, deadline]);
    assert.equal(child.signalCode, null, "DEV_REACT_SIGNAL_DEATH");
    assert.equal(child.exitCode, 0, "DEV_REACT_NONZERO_EXIT");
    const record = ownedLaunches.get(application);
    assert.ok(record, "OWNED_SETUP_LAUNCH_REQUIRED");
    record.terminal = { exitCode: child.exitCode, signal: child.signalCode };
    const quit = JSON.parse(
      await fs.readFile(path.join(record.stateRoot, "last-quit.json"), "utf8"),
    );
    record.quit = quit;
    await save();
    assert.equal(quit.drained, true, "SETUP_QUIT_NOT_DRAINED");
    assert.deepEqual(quit.unconfirmed, [], "SETUP_QUIT_UNCONFIRMED");
    assert.ok(
      Date.parse(quit.at) >= Date.parse(record.startedAt),
      "SETUP_QUIT_RECEIPT_STALE",
    );
    await assert.rejects(
      fs.lstat(path.join(record.stateRoot, "running.json")),
      { code: "ENOENT" },
    );
    record.status = "closed-cleanly";
    await save();
  } catch (error) {
    cleanupConfirmed = false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const closeApplication = (application) => stopApplication(application, false);
const stopApplicationWithOwnerSignal = (application) =>
  stopApplication(application, true);
async function assertHiddenWindows(application) {
  const windows = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((owner) => ({
      id: owner.id,
      visible: owner.isVisible(),
      focused: owner.isFocused(),
    })),
  );
  assert.ok(windows.length > 0, "HIDDEN_SETUP_WINDOW_REQUIRED");
  for (const owner of windows) {
    assert.equal(owner.visible, false, `HIDDEN_SETUP_WINDOW_SHOWN:${owner.id}`);
    assert.equal(
      owner.focused,
      false,
      `HIDDEN_SETUP_WINDOW_FOCUSED:${owner.id}`,
    );
  }
}
async function ready(window) {
  await window.locator(".desktop").waitFor({ state: "visible" });
  // Native bootstrap is asynchronous; Playwright predicates do not establish
  // awaited IPC completion. Poll only this bounded read-only projection.
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await window.evaluate(() => window.farolNext.bootstrap());
    if (
      value.runtimeState === "ready" &&
      value.configuration.status === "ready"
    )
      return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("DEV_REACT_BOOTSTRAP_NOT_READY");
}
async function settingsPage(window, name) {
  await window.getByRole("button", { name: "Settings", exact: true }).click();
  await window
    .locator(".contextual-sidebar")
    .getByRole("button", {
      name: name === "Shortcuts" ? "Keyboard shortcuts" : name,
      exact: true,
    })
    .click();
  await window
    .locator(".toolbar-title strong")
    .getByText(name === "Shortcuts" ? "Keyboard shortcuts" : name, {
      exact: true,
    })
    .waitFor();
}

async function fixtureContents(taskId = null) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const surface = await application.evaluate(
      async ({ webContents }, input) => {
        const matches = webContents.getAllWebContents().filter((contents) => {
          if (contents.isDestroyed()) return false;
          try {
            const url = new URL(contents.getURL());
            const fixture = new URL(input.url);
            return (
              url.origin === fixture.origin &&
              url.pathname === fixture.pathname &&
              url.searchParams.get("farol-e2e-task") === input.taskId
            );
          } catch {
            return false;
          }
        });
        if (matches.length > 1) throw new Error("FIXTURE_CONTENTS_AMBIGUOUS");
        const contents = matches[0];
        if (!contents || contents.isLoading()) return null;
        const state = await contents.executeJavaScript(`(() => ({
          ready: document.querySelector('#prompt-textarea') !== null,
          submits: window.__farolSubmitCount
        }))()`);
        return { id: contents.id, ...state };
      },
      { url: browserFixture.url, taskId },
    );
    if (surface?.ready) {
      assert.equal(surface.submits, 0, "SETUP_MUST_NOT_SEND");
      return surface;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`FIXTURE_CONTENTS_NOT_READY:${taskId ?? "home"}`);
}

async function assertContentsAlive(id) {
  assert.equal(
    await application.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id);
      return Boolean(contents && !contents.isDestroyed());
    }, id),
    true,
    "HIDDEN_BROWSER_LIFETIME_MUST_REMAIN",
  );
}

let application;
let browserFixture;
try {
  browserFixture = await startChatGptFixture();
  // Reuse the existing local provider fixture for browser ownership only.
  // No sign-in, model turn, Send, or answer is requested by this journey.
  environment.FAROL_NEXT_E2E_CHATGPT_URL = browserFixture.url;
  // A missing override must fail before the first app-ready boundary and
  // leave even a synthetic ordinary-Dev startup marker untouched.
  const ordinaryMarker = path.join(
    isolatedHome,
    "Library/Application Support/Farol Dev/farol-next-state/running.json",
  );
  await fs.mkdir(path.dirname(ordinaryMarker), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(ordinaryMarker, "synthetic owner marker\n", {
    mode: 0o600,
  });
  const missingOverrideEnv = { ...environment };
  delete missingOverrideEnv.FAROL_NEXT_E2E_APP_DATA;
  launchUnresolved = true;
  const refusedProfile = await runBoundedProcess(
    executable,
    [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    { cwd: root, env: missingOverrideEnv, timeoutMs: 5_000 },
  );
  launchUnresolved = false;
  assert.equal(
    refusedProfile.status,
    1,
    `${refusedProfile.stdout}${refusedProfile.stderr}`,
  );
  assert.equal(refusedProfile.signal, null);
  assert.equal(
    parseOwnerLaunchResult(`${refusedProfile.stdout}${refusedProfile.stderr}`),
    "startup-failed",
  );
  assert.match(refusedProfile.stderr, /DESKTOP_E2E_APP_DATA_INVALID/u);
  assert.equal(
    await fs.readFile(ordinaryMarker, "utf8"),
    "synthetic owner marker\n",
  );

  application = await launchApplication(environment);
  let stderr = "";
  application.process().stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const window = await application.firstWindow({ timeout: 15_000 });
  const bootstrap = await ready(window);
  await window
    .locator(".toolbar-title strong")
    .getByText("Overview", { exact: true })
    .waitFor();
  assert.equal(bootstrap.environment, "dev");
  assert.equal(bootstrap.displayName, "Farol Dev");
  assert.equal(bootstrap.applicationId, "local.farol.dev");
  assert.equal(bootstrap.partition, "persist:farol-dev-runtime");
  assert.equal(bootstrap.chatgptPartition, "persist:farol-dev-chatgpt");
  const paths = await application.evaluate(({ app }) => ({
    name: app.getName(),
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
  }));
  const expectedUserData = path.join(isolatedAppData, "Farol Dev");
  assert.deepEqual(paths, {
    name: "Farol Dev",
    userData: expectedUserData,
    sessionData: expectedUserData,
  });
  assert.equal(
    paths.userData.startsWith(`${temporaryRoot}${path.sep}`),
    true,
    "DEV_STARTUP_SMOKE_ESCAPED_TEMP_HOME",
  );

  assert.equal(
    await window.locator("#setup-dialog, #guided-onboarding").count(),
    0,
  );
  // Current React Setup, not the retained legacy wizard selectors.
  const beforeReview = bootstrap.configuration;
  await openSetup(window);
  for (const [step, label] of [
    ["overview", "Overview"],
    ["signin", "Sign in"],
    ["folders", "Workspaces"],
    ["connection", "Connection"],
    ["attachment", "Add to ChatGPT"],
  ]) {
    await setupStep(window, step, label);
    assert.equal(
      await window
        .locator('.rail [aria-label="Setup"]')
        .getAttribute("aria-current"),
      "page",
    );
  }
  await assertSetupOverview(window, uncheckedOverview);
  assert.equal(
    await window.locator('.rail [aria-label="New chat"]').count(),
    0,
  );
  assert.deepEqual(
    (await window.evaluate(() => window.farolNext.bootstrap())).configuration,
    beforeReview,
  );
  report.checks.push(
    "fresh-current-React-Setup-navigation-no-effects-no-false-ready",
  );
  await save();
  await window
    .getByRole("navigation", { name: "Sections", exact: true })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  for (const name of [
    "General",
    "Appearance",
    "Workspaces",
    "This Mac",
    "Connection",
    "Shortcuts",
    "Updates",
    "Diagnostics",
  ]) {
    await settingsPage(window, name);
  }
  await settingsPage(window, "Appearance");
  await window.getByRole("button", { name: "Graphite", exact: true }).click();
  await window
    .getByRole("button", { name: "Cobalt accent", exact: true })
    .click();
  await window
    .getByRole("combobox", { name: "Typeface", exact: true })
    .selectOption("system");
  await window.waitForFunction(() => {
    const element = document.querySelector(".desktop");
    return (
      element?.dataset.theme === "graphite" &&
      element.dataset.accent === "cobalt" &&
      element.dataset.font === "system"
    );
  });
  assert.deepEqual(
    await window
      .locator(".desktop")
      .evaluate((element) => [
        element.dataset.theme,
        element.dataset.accent,
        element.dataset.font,
      ]),
    ["graphite", "cobalt", "system"],
  );
  await window.getByRole("button", { name: "Home", exact: true }).click();
  await window
    .getByRole("button", { name: "Find a page", exact: true })
    .click();
  await window
    .getByRole("dialog")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  assert.equal(await window.getByRole("dialog").count(), 0);
  assert.equal(await window.locator("main").getAttribute("inert"), null);
  // Establish admission using the existing production observation command.
  // Only the test side operates the local fixture's synthetic login control;
  // no ready settings or expected provider answer enter the adapter directly.
  const opened = await window.evaluate(() =>
    window.farolNext.configure({ kind: "chatgpt.open-browser" }),
  );
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const fixtureHome = await fixtureContents();
  assert.equal(
    await application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) return false;
      return contents.executeJavaScript(`(() => {
        const login = document.querySelector('[data-testid="login-button"]');
        if (!(login instanceof HTMLButtonElement) || login.hidden || login.disabled) return false;
        login.click();
        return true;
      })()`);
    }, fixtureHome.id),
    true,
    "FIXTURE_LOGIN_CONTROL_REQUIRED",
  );
  const readiness = await window.evaluate(() =>
    window.farolNext.configure({ kind: "chatgpt.verify" }),
  );
  assert.equal(readiness.ok, true, JSON.stringify(readiness));
  assert.equal(readiness.evidence?.kind, "chatgpt.readiness");
  assert.equal(readiness.evidence.state, "authenticated");
  assert.equal(readiness.snapshot.settings.setup.chatgpt.configured, true);
  assert.equal(
    readiness.snapshot.settings.setup.chatgpt.reachable,
    "reachable",
  );
  assert.ok(readiness.snapshot.settings.setup.chatgpt.verified);
  await window.getByRole("button", { name: "Home", exact: true }).click();
  // Create one real, idle native task through the application owner. The
  // resulting task event does not imply that the renderer selected it. Home
  // must still conceal its browser; no automatic task replacement is allowed.
  const created = await window.evaluate(() =>
    window.farolNext.task({ kind: "task.create-chatgpt" }),
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  const retainedTaskId = created.selectedTaskId;
  assert.equal(typeof retainedTaskId, "string");
  assert.ok(retainedTaskId.length > 0);
  const createdContents = await fixtureContents(retainedTaskId);
  const openedViews = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().flatMap((owner) =>
      owner.contentView.children
        .filter(
          (view) =>
            "webContents" in view &&
            view.webContents.id !== owner.webContents.id,
        )
        .map((view) => ({
          id: view.webContents.id,
          visible: view.getVisible(),
        })),
    ),
  );
  assert.equal(openedViews.length, 1, "CREATED_NATIVE_BROWSER_REQUIRED");
  assert.equal(openedViews[0].id, createdContents.id);
  assert.equal(openedViews[0].visible, true);
  await window.getByRole("button", { name: "ChatGPT", exact: true }).click();
  await window.getByRole("button", { name: "Home", exact: true }).click();
  async function assertBrowserDetached() {
    let views = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      views = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().flatMap((owner) =>
          owner.contentView.children
            .filter(
              (view) =>
                "webContents" in view &&
                view.webContents.id !== owner.webContents.id,
            )
            .map((view) => ({
              id: view.webContents.id,
              visible: view.getVisible(),
            })),
        ),
      );
      await assertHiddenWindows(application);
      if (views.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(views, [], "HOME_MUST_DETACH_RETAINED_BROWSER");
  }
  await assertBrowserDetached();
  await assertContentsAlive(createdContents.id);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    ),
    false,
    "DEV_REACT_HIDDEN_WINDOW_SHOWN",
  );

  await stopApplicationWithOwnerSignal(application);
  application = undefined;
  assert.doesNotMatch(stderr, /INSTANCE_BUILD_IDENTITY_INVALID/u);
  assert.doesNotMatch(stderr, /App threw an error during load/u);

  // Reopen the exact same disposable ordinary-Dev profile after a confirmed
  // quit, rather than claiming persistence from the previous DOM projection.
  application = await launchApplication(environment);
  const reopenedWindow = await application.firstWindow({ timeout: 15_000 });
  const reopened = await ready(reopenedWindow);
  assert.equal(
    reopened.selectedTaskId,
    retainedTaskId,
    "RESTORED_SELECTED_TASK_NOT_PROJECTED",
  );
  assert.ok(reopened.tasks.some((task) => task.taskId === retainedTaskId));
  await reopenedWindow
    .locator(".toolbar-title strong")
    .getByText("Overview", { exact: true })
    .waitFor();
  // An empty child list alone is not restoration evidence: first witness the
  // exact task's loaded, live native contents in this new Electron lifetime.
  const reopenedContents = await fixtureContents(retainedTaskId);
  await assertBrowserDetached();
  await assertContentsAlive(reopenedContents.id);
  await reopenedWindow
    .getByRole("button", { name: "Setup", exact: true })
    .click();
  await reopenedWindow
    .getByRole("button", { name: "ChatGPT", exact: true })
    .click();
  let restoredAttached = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    restoredAttached = await application.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows().some((owner) =>
          owner.contentView.children.some(
            (view) => view.webContents?.id === id && view.getVisible(),
          ),
        ),
      reopenedContents.id,
    );
    if (restoredAttached) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(restoredAttached, true, "RESTORED_TASK_RAIL_SELECTION_REQUIRED");
  // Extend this same restored idle browser, without another app/provider lane.
  // Electron attachment and CSS rectangles are hidden evidence only: input
  // below is renderer-directed, not visible compositor, OS AX, focus or IME QA.
  const button = (name) =>
    reopenedWindow.getByRole("button", { name, exact: true });
  const originalWindow = await application.evaluate(({ BrowserWindow }, id) => {
    const owner = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.contentView.children.some(
        (view) => view.webContents?.id === id,
      ),
    );
    if (!owner) throw new Error("RESTORED_BROWSER_OWNER_REQUIRED");
    return {
      id: owner.id,
      bounds: owner.getBounds(),
      size: owner.getContentSize(),
    };
  }, reopenedContents.id);
  const originalShell = await reopenedWindow
    .locator(".desktop")
    .evaluate((element) => ({
      theme: element.dataset.theme,
      sidebar: element.dataset.sidebar,
      width: Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--page-list-width"),
      ),
    }));
  async function setContentSize(width) {
    await application.evaluate(
      ({ BrowserWindow }, input) => {
        BrowserWindow.fromId(input.id).setContentSize(
          input.width,
          input.height,
        );
      },
      { id: originalWindow.id, width, height: originalWindow.size[1] },
    );
    await reopenedWindow.waitForFunction(
      (width) => window.innerWidth === width,
      width,
    );
    assert.deepEqual(
      await application.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id).getContentSize(),
        originalWindow.id,
      ),
      [width, originalWindow.size[1]],
      "REQUESTED_CONTENT_SIZE_REQUIRED",
    );
  }
  async function assertBrowserGeometry(theme, sidebar, pageListWidth) {
    await reopenedWindow.waitForFunction(
      ({ theme, sidebar, pageListWidth }) => {
        const shell = document.querySelector(".desktop");
        return (
          shell?.dataset.theme === theme &&
          shell.dataset.sidebar === sidebar &&
          shell.dataset.sidebarResizing === "false" &&
          Number.parseFloat(
            getComputedStyle(shell).getPropertyValue("--page-list-width"),
          ) === pageListWidth
        );
      },
      { theme, sidebar, pageListWidth },
    );
    let native;
    let expected;
    for (let attempt = 0; attempt < 100; attempt++) {
      await assertHiddenWindows(application);
      native = await application.evaluate(({ BrowserWindow }, id) => {
        const owner = BrowserWindow.fromId(id);
        return {
          size: owner.getContentSize(),
          views: owner.contentView.children
            .filter(
              (view) =>
                "webContents" in view &&
                view.webContents.id !== owner.webContents.id,
            )
            .map((view) => ({
              id: view.webContents.id,
              visible: view.getVisible(),
              bounds: view.getBounds(),
            })),
        };
      }, originalWindow.id);
      const x =
        shellRailWidth(native.size[0]) +
        (sidebar === "full" ? pageListWidth : 0);
      expected = {
        x,
        y: shellGeometry.windowBar,
        width: native.size[0] - x,
        height: native.size[1] - shellGeometry.windowBar,
      };
      if (
        native.views.length === 1 &&
        native.views[0].id === reopenedContents.id &&
        native.views[0].visible &&
        Object.entries(expected).every(
          ([key, value]) => native.views[0].bounds[key] === value,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      native.views,
      [{ id: reopenedContents.id, visible: true, bounds: expected }],
      "RESTORED_NATIVE_BROWSER_GEOMETRY",
    );
    const dom = await reopenedWindow.evaluate(() => {
      const rect = (selector) => {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      };
      const sidebar = document.querySelector(".contextual-sidebar");
      const divider = document.querySelector(".page-list-resizer");
      const line = divider && getComputedStyle(divider, "::after");
      return {
        size: [window.innerWidth, window.innerHeight],
        stage: rect(".stage"),
        rail: rect(".rail"),
        toolbar: rect(".toolbar"),
        sidebar: sidebar ? rect(".contextual-sidebar") : null,
        divider: divider
          ? {
              count: document.querySelectorAll(".page-list-resizer").length,
              right: divider.getBoundingClientRect().right,
              lineWidth: line.width,
              content: line.content,
              background: line.backgroundColor,
              sidebarBorder: getComputedStyle(sidebar).borderRightWidth,
              stageBorder: getComputedStyle(document.querySelector(".stage"))
                .borderLeftWidth,
            }
          : null,
      };
    });
    assert.deepEqual(
      dom.size,
      native.size,
      "RENDERER_NATIVE_CONTENT_SIZE_DRIFT",
    );
    assert.deepEqual(
      dom.stage,
      expected,
      "RENDERER_NATIVE_BROWSER_BOUNDS_DRIFT",
    );
    assert.equal(dom.rail.width, shellRailWidth(native.size[0]));
    assert.equal(dom.toolbar.height, shellGeometry.windowBar);
    if (sidebar === "full") {
      assert.deepEqual(dom.sidebar, {
        x: shellRailWidth(native.size[0]),
        y: expected.y,
        width: pageListWidth,
        height: expected.height,
      });
      assert.equal(dom.divider.count, 1, "SINGLE_PAGE_LIST_DIVIDER_REQUIRED");
      assert.equal(dom.divider.right, expected.x);
      assert.equal(dom.divider.lineWidth, "1px");
      assert.equal(dom.divider.content, '""');
      assert.notEqual(dom.divider.background, "rgba(0, 0, 0, 0)");
      assert.equal(
        dom.divider.sidebarBorder,
        "0px",
        "DUPLICATE_SIDEBAR_DIVIDER",
      );
      assert.equal(dom.divider.stageBorder, "0px", "DUPLICATE_STAGE_DIVIDER");
    } else {
      assert.equal(dom.sidebar, null);
      assert.equal(dom.divider, null);
    }
    assert.equal(
      (await fixtureContents(retainedTaskId)).id,
      reopenedContents.id,
      "RESTORED_BROWSER_IDENTITY_DRIFT",
    );
    report.checks.push(
      `restored-idle-${theme}-${sidebar}-${pageListWidth}-bounds:${JSON.stringify(expected)}`,
    );
    return { size: native.size, stage: dom.stage, sidebar: dom.sidebar };
  }
  // A local DOM probe records whether renderer-directed overlay interaction
  // leaked into this exact synthetic provider. Never send input via its owner.
  await application.evaluate(async ({ webContents }, id) => {
    await webContents.fromId(id).executeJavaScript(`(() => {
      window.__farolOverlayInputCount = 0;
      for (const event of ['pointerdown', 'keydown', 'input'])
        document.addEventListener(event, () => window.__farolOverlayInputCount++, true);
    })()`);
  }, reopenedContents.id);
  async function assertOverlayBlocksBrowser() {
    await assertBrowserDetached();
    await assertContentsAlive(reopenedContents.id);
    assert.notEqual(
      await reopenedWindow.locator("main").getAttribute("inert"),
      null,
    );
    const input = await application.evaluate(
      async ({ webContents }, id) =>
        webContents.fromId(id).executeJavaScript(`(() => ({
        events: window.__farolOverlayInputCount,
        prompt: document.querySelector('#prompt-textarea').textContent,
        submits: window.__farolSubmitCount
      }))()`),
      reopenedContents.id,
    );
    assert.deepEqual(
      input,
      { events: 0, prompt: "", submits: 0 },
      "OVERLAY_PROVIDER_INPUT_LEAK",
    );
  }
  async function checkSearchOverlay(theme, sidebar, geometry) {
    await button("Find a page").click();
    await assertOverlayBlocksBrowser();
    const search = reopenedWindow.getByRole("dialog", {
      name: "Find a page",
      exact: true,
    });
    await search
      .getByRole("textbox", { name: "Find a page", exact: true })
      .fill("ChatGPT");
    await search
      .getByRole("textbox", { name: "Find a page", exact: true })
      .press("ArrowDown");
    await assertOverlayBlocksBrowser();
    await search.getByRole("button", { name: "Close", exact: true }).click();
    assert.deepEqual(
      await assertBrowserGeometry(theme, sidebar, originalShell.width),
      geometry,
      "SEARCH_DISMISS_WIDTH_DRIFT",
    );
  }
  const geometryByTheme = [];
  for (const theme of ["Light", "Graphite"]) {
    const geometry = (sidebar, width = originalShell.width) =>
      assertBrowserGeometry(theme.toLowerCase(), sidebar, width);
    await setContentSize(
      shellGeometry.compactMaxWidth + shellGeometry.pageListDefault,
    );
    if (
      (await reopenedWindow
        .locator(".desktop")
        .getAttribute("data-sidebar")) !== "full"
    )
      await button("Toggle sidebar").click();
    await settingsPage(reopenedWindow, "Appearance");
    await button(theme).click();
    await button("ChatGPT").click();
    const normal = await geometry("full");
    await checkSearchOverlay(theme.toLowerCase(), "full", normal);
    const divider = reopenedWindow.getByRole("separator", {
      name: "Resize page list",
      exact: true,
    });
    for (const [key, width] of [
      ["Home", shellGeometry.pageListMin],
      ["ArrowLeft", shellGeometry.pageListMin],
      ["End", shellGeometry.pageListMax],
      ["ArrowRight", shellGeometry.pageListMax],
    ]) {
      await divider.press(key);
      await geometry("full", width);
    }
    // Restore the non-step-aligned original width through the actual resizer.
    const handle = await divider.boundingBox();
    assert.ok(handle, "PAGE_LIST_RESIZER_BOUNDS_REQUIRED");
    await reopenedWindow.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await reopenedWindow.mouse.down();
    await reopenedWindow.mouse.move(
      handle.x +
        handle.width / 2 +
        originalShell.width -
        shellGeometry.pageListMax,
      handle.y + handle.height / 2,
    );
    await assertBrowserDetached();
    await reopenedWindow.mouse.up();
    assert.deepEqual(
      await geometry("full"),
      normal,
      "RESIZE_RESTORE_WIDTH_DRIFT",
    );
    await button("Toggle sidebar").click();
    await geometry("rail");
    await button("Toggle sidebar").click();
    await geometry("full");
    await setContentSize(
      Math.max(
        640,
        shellGeometry.compactMaxWidth - shellGeometry.pageListDefault,
      ),
    );
    const compact = await geometry("rail");
    await button("Toggle sidebar").click();
    await reopenedWindow.locator(".sidebar-overlay").waitFor();
    await assertOverlayBlocksBrowser();
    await button("Toggle sidebar").press("ArrowDown");
    await assertOverlayBlocksBrowser();
    await button("Close sidebar").click();
    assert.deepEqual(
      await geometry("rail"),
      compact,
      "SIDEBAR_DISMISS_WIDTH_DRIFT",
    );
    await checkSearchOverlay(theme.toLowerCase(), "rail", compact);
    geometryByTheme.push({ normal, compact });
  }
  assert.deepEqual(
    geometryByTheme[0],
    geometryByTheme[1],
    "LIGHT_GRAPHITE_WIDTH_DRIFT",
  );
  await setContentSize(
    shellGeometry.compactMaxWidth + shellGeometry.pageListDefault,
  );
  await button("Toggle sidebar").click();
  await settingsPage(reopenedWindow, "Appearance");
  await reopenedWindow
    .getByRole("button", {
      name: originalShell.theme[0].toUpperCase() + originalShell.theme.slice(1),
      exact: true,
    })
    .click();
  await button("ChatGPT").click();
  if (originalShell.sidebar !== "full") await button("Toggle sidebar").click();
  await application.evaluate(
    ({ BrowserWindow }, original) =>
      BrowserWindow.fromId(original.id).setBounds(original.bounds),
    originalWindow,
  );
  await assertBrowserGeometry(
    originalShell.theme,
    originalShell.sidebar,
    originalShell.width,
  );
  assert.deepEqual(
    await application.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id).getBounds(),
      originalWindow.id,
    ),
    originalWindow.bounds,
    "ORIGINAL_WINDOW_BOUNDS_NOT_RESTORED",
  );
  report.checks.push(
    "restored-idle-Light-Graphite-normal-compact-bounded-resize-single-divider-overlay-detach-no-renderer-input-original-state-restored",
  );
  await save();
  await reopenedWindow
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await assertBrowserDetached();
  await assertContentsAlive(reopenedContents.id);
  report.checks.push(
    "retained-idle-task-Quit-reopen-bootstrap-identity-and-Home-native-detachment",
  );
  await save();
  await settingsPage(reopenedWindow, "Appearance");
  assert.deepEqual(
    await reopenedWindow
      .locator(".desktop")
      .evaluate((element) => [
        element.dataset.theme,
        element.dataset.accent,
        element.dataset.font,
      ]),
    ["graphite", "cobalt", "system"],
    "DEV_REACT_APPEARANCE_NOT_RETAINED",
  );
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    ),
    false,
    "DEV_REACT_REOPEN_SHOWN",
  );
  await closeApplication(application);
  application = undefined;

  // A legacy-spelled DEV directory is synthetic owner data, not a migration
  // input. Reopening must keep the same storage object and saved folder grant.
  const legacyAppData = path.join(temporaryRoot, "legacy-app-data");
  const legacyDirectory = path.join(legacyAppData, "Farol DEV");
  const workspaceRoot = path.join(temporaryRoot, "approved-folder");
  await fs.mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const marker = path.join(legacyDirectory, "retained-marker.txt");
  await fs.writeFile(marker, "synthetic pre-existing DEV profile\n", {
    mode: 0o600,
  });
  const legacyIdentity = await fs.stat(legacyDirectory);
  const expectedLegacyPath = await fs.realpath(legacyDirectory);
  const legacyEnvironment = {
    ...environment,
    FAROL_NEXT_E2E_APP_DATA: legacyAppData,
    FAROL_NEXT_E2E_WORKSPACE_ROOT: workspaceRoot,
  };
  let savedWorkspace;
  for (let launch = 0; launch < 2; launch += 1) {
    application = await launchApplication(legacyEnvironment);
    const legacyWindow = await application.firstWindow({ timeout: 15_000 });
    await ready(legacyWindow);
    assert.equal(
      await legacyWindow.locator("#setup-dialog, #guided-onboarding").count(),
      0,
    );
    const actualPath = await application.evaluate(({ app }) =>
      app.getPath("userData"),
    );
    assert.equal(actualPath, expectedLegacyPath);
    const actualIdentity = await fs.stat(actualPath);
    assert.equal(actualIdentity.dev, legacyIdentity.dev);
    assert.equal(actualIdentity.ino, legacyIdentity.ino);
    assert.equal(
      await fs.readFile(marker, "utf8"),
      "synthetic pre-existing DEV profile\n",
    );
    if (launch === 0) {
      await openSetup(legacyWindow);
      await setupStep(legacyWindow, "folders", "Workspaces");
      await setupAction(legacyWindow, "Add workspace…");
      await setupAction(legacyWindow, "Add selected workspace read-only");
      const detail = legacyWindow.locator(
        ".setup-page .workspace-detail:visible",
      );
      await detail.waitFor();
      assert.equal(await detail.count(), 1);
      // The current Verify workspace action checks access and binds the
      // selected workspace in one command; there is no separate Check access.
      await setupAction(legacyWindow, "Verify workspace");
      await detail
        .locator(".badges")
        .filter({ hasText: /^Access checked$/u })
        .waitFor();
      let value;
      for (let attempt = 0; attempt < 100; attempt++) {
        value = await legacyWindow.evaluate(() => window.farolNext.bootstrap());
        const settings =
          value.configuration.status === "ready"
            ? value.configuration.settings
            : null;
        if (
          settings?.setup.computer.verified?.workspaceId ===
            settings?.computer.workspaces[0]?.workspaceId &&
          settings?.computer.workspaces.length === 1
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(value.configuration.status, "ready");
      savedWorkspace = {
        workspaces: value.configuration.settings.computer.workspaces,
        verified: value.configuration.settings.setup.computer.verified,
      };
      assert.equal(
        savedWorkspace.workspaces.length,
        1,
        JSON.stringify({
          status: value.configuration.status,
          workspaces: value.configuration.settings.computer.workspaces,
        }),
      );
      assert.equal(
        savedWorkspace.verified?.workspaceId,
        savedWorkspace.workspaces[0].workspaceId,
        "DEV_STARTUP_SMOKE_WORKSPACE_VERIFICATION_MISSING",
      );
    } else {
      // A saved verified folder is still partial without connection/attachment.
      await legacyWindow
        .locator(".toolbar-title strong")
        .getByText("Overview", { exact: true })
        .waitFor();
      await legacyWindow
        .getByRole("button", { name: "Continue setup", exact: true })
        .click();
      assert.equal(
        await legacyWindow
          .locator(".setup-page")
          .getAttribute("data-setup-step"),
        "connection",
      );
      await assertSetupOverview(legacyWindow, {
        ready: false,
        signIn: uncheckedOverview.signIn,
        states: { ...uncheckedOverview.states, folders: "verified" },
      });
      report.checks.push(
        "partial-folder-Quit-reopen-retained-obvious-continuation-no-false-ready",
      );
      await save();
      const value = await legacyWindow.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.deepEqual(
        value.configuration.settings.computer.workspaces,
        savedWorkspace.workspaces,
      );
      assert.deepEqual(
        value.configuration.settings.setup.computer.verified,
        savedWorkspace.verified,
      );
    }
    await assertHiddenWindows(application);
    await closeApplication(application);
    application = undefined;
  }

  const brokenRoot = path.join(temporaryRoot, "broken-app");
  await fs.cp(buildRoot, brokenRoot, { recursive: true });
  await fs.writeFile(path.join(brokenRoot, "build-manifest.json"), "{}\n", {
    mode: 0o600,
  });
  launchUnresolved = true;
  const broken = await runBoundedProcess(
    executable,
    [path.join(brokenRoot, "main.cjs"), "--preview-window-mode=hidden"],
    {
      cwd: root,
      env: environment,
      timeoutMs: 5_000,
    },
  );
  launchUnresolved = false;
  assert.equal(broken.status, 1, `${broken.stdout}${broken.stderr}`);
  assert.equal(broken.signal, null);
  assert.equal(
    parseOwnerLaunchResult(`${broken.stdout}${broken.stderr}`),
    "startup-failed",
  );
  assert.match(
    broken.stderr,
    /FAROL_NEXT_STARTUP_FAILURE:INSTANCE_BUILD_IDENTITY_INVALID/u,
  );
  assert.doesNotMatch(broken.stderr, /App threw an error during load/u);
  assert.doesNotMatch(broken.stderr, /Uncaught Exception/u);

  passed = true;
  report.status = "passed";
  report.limits = [
    "Fresh/partial current React and real Go startup/retention only",
    "Hidden Electron bounds/child attachment, computed divider source and renderer-directed overlay input only; window visibility/focus checked at sampled boundaries",
    "No visible compositor, OS AX, IME, native keyboard focus or installed/browser-provider qualification",
    "No external attachment, provider Send, live credentials, native dialog or visible focus acceptance",
    "Ready-profile Review Setup and actual external retained observation have separate ordinary Dev evidence",
  ];
} finally {
  if (application && !stopRequested.has(application)) {
    await closeApplication(application).catch(() => {
      cleanupConfirmed = false;
    });
  }
  if (browserFixture) {
    await stopChatGptFixture(browserFixture).catch(() => {
      cleanupConfirmed = false;
    });
  }
  report.status =
    passed && cleanupConfirmed && !launchUnresolved ? "passed" : "failed";
  report.cleanup = {
    cleanupConfirmed,
    launchUnresolved,
    retainedRoot:
      passed && cleanupConfirmed && !launchUnresolved ? null : temporaryRoot,
  };
  await save();
  if (passed && cleanupConfirmed && !launchUnresolved)
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  else process.stderr.write(`DEV_REACT_RESOURCES_RETAINED:${temporaryRoot}\n`);
  if (passed && (!cleanupConfirmed || launchUnresolved))
    throw new Error("DEV_REACT_CLEANUP_UNCONFIRMED");
}
process.stdout.write(
  `Farol Dev React Setup: PASS; exact source ${source.commit}; evidence ${evidenceRoot}\n`,
);
