// Exact built Electron/Go + disposable local browser fixture. No Google,
// ChatGPT account, Send, tunnel, installed app or owner profile participates.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { _electron } from "playwright-core";
import { desktopIdentity } from "../../tooling/harness-identity.ts";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { ProductConfigurationCommandSchema } from "../../src/pkg/product-settings/contract.ts";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
import {
  assertRuntimeObservation,
  observeElectronRuntime,
} from "../../tooling/runtime-contract.mjs";
import { setupStep } from "./current-react-setup.mjs";
import {
  readQuitObservation,
  beginQuitObservation,
  assertFreshQuit,
} from "./lib/native-quit-observation.mjs";
import {
  collectWindowObservation,
  assertWindowSnapshot,
  assertWindowLifetime,
} from "./lib/native-window-observation.mjs";
import {
  startChatGptFixture,
  stopChatGptFixture,
} from "./fixtures/chatgpt-site.mjs";

assert.equal(process.argv.length, 2, "SIGN_IN_CONTINUITY_ARGUMENTS_INVALID");
const root = process.cwd();
const source = sourceIdentity(root);
const buildRoot = path.join(root, "_output/build/app");
const build = await qualifyGoBuild(buildRoot, source);
const declaredRuntime = process.env.FAROL_RENDERER_TEST_ELECTRON_ROOT;
assert.ok(
  declaredRuntime && path.isAbsolute(declaredRuntime),
  "EXPLICIT_ABSOLUTE_REVIEWED_ELECTRON_ROOT_REQUIRED",
);
const runtimeRoot = await fs.realpath(declaredRuntime);
const runtime = await observeElectronRuntime(runtimeRoot);
assertRuntimeObservation(runtime);
const executablePath = path.join(
  runtimeRoot,
  "dist/Electron.app/Contents/MacOS/Electron",
);
const attemptId = randomUUID();
const observationCommand = ProductConfigurationCommandSchema.parse({
  kind: "chatgpt.observe-sign-in",
  observationId: attemptId,
  buildId: build.identity.buildId,
});
const output = path.join(
  root,
  "_output/evidence/sign-in-continuity",
  attemptId,
);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const profile = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-e2e-home-")),
);
await fs.chmod(profile, 0o700);
const appData = path.join(profile, "app-data");
await fs.mkdir(appData, { mode: 0o700 });
const proof = randomUUID();
await fs.writeFile(path.join(profile, ".farol-e2e-root"), proof, {
  mode: 0o600,
});
const report = {
  attemptId,
  source,
  buildId: build.identity.buildId,
  runtime,
  profile,
  mode: "hidden",
  status: "running",
  checks: [],
  snapshots: [],
  screenshots: [],
  limits: [
    "Synthetic loopback browser and popup only; no live sign-in or provider acceptance",
    "Hidden native attachment/bounds and renderer interaction; no foreground OS focus qualification",
    "Shell and browser images are separate surfaces, never a composited native screenshot",
  ],
};
const save = () =>
  fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
await save();
let fixture,
  application,
  page,
  terminal,
  closed,
  windowObservation,
  mainId,
  stateRoot;
let stopped = false;
async function poll(read, accept, label) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function native() {
  return application.evaluate(
    async ({ BrowserWindow, webContents }, input) => {
      const main = BrowserWindow.fromId(input.mainId);
      const fixtureUrl = new URL(input.url);
      const documents = [];
      for (const c of webContents.getAllWebContents()) {
        if (c.isDestroyed()) continue;
        let url;
        try {
          url = new URL(c.getURL());
        } catch {
          continue;
        }
        if (
          url.origin !== fixtureUrl.origin ||
          url.pathname !== fixtureUrl.pathname ||
          c.isLoading()
        )
          continue;
        const state = await c.executeJavaScript(
          "({submits: window.__farolSubmitCount, marker: window.__continuityMarker ?? null})",
        );
        documents.push({ id: c.id, ...state });
      }
      return {
        windows: BrowserWindow.getAllWindows().map((w) => ({
          id: w.id,
          visible: w.isVisible(),
          focused: w.isFocused(),
          bounds: w.getBounds(),
        })),
        size: main.getContentSize(),
        children: main.contentView.children.map((v) => ({
          id: v.webContents?.id ?? null,
          visible: v.getVisible(),
          bounds: v.getBounds(),
        })),
        documents,
      };
    },
    { mainId, url: fixture.url },
  );
}
async function observe(label, documentId, attached) {
  const state = await poll(
    native,
    (s) => {
      const document = s.documents.find((d) => d.id === documentId);
      return (
        document &&
        s.children.some((v) => v.id === documentId && v.visible) === attached
      );
    },
    "SIGN_IN_NATIVE_LAYOUT_TIMEOUT:" + label,
  );
  assert.ok(state.windows.length > 0);
  for (const w of state.windows) {
    assert.equal(w.visible, false, "SIGN_IN_TEST_WINDOW_VISIBLE");
    assert.equal(w.focused, false, "SIGN_IN_TEST_WINDOW_FOCUSED");
  }
  assert.equal(
    state.documents.length,
    1,
    "SIGN_IN_DOCUMENT_REPLACED_OR_DUPLICATED",
  );
  assert.equal(state.documents[0].submits, 0, "SIGN_IN_TEST_MUST_NOT_SEND");
  assert.equal(
    state.documents[0].marker,
    attemptId,
    "SIGN_IN_DOCUMENT_RELOADED",
  );
  if (attached) {
    assert.equal(state.children.length, 1, "SIGN_IN_NATIVE_STACK_AMBIGUOUS");
    const bounds = state.children[0].bounds;
    const shell = await page.locator(".rail").boundingBox();
    assert.ok(shell);
    assert.equal(bounds.x, Math.round(shell.width));
    assert.equal(bounds.y, 58);
    assert.equal(bounds.width, state.size[0] - bounds.x);
    assert.equal(bounds.height, state.size[1] - bounds.y);
    assert.equal(
      await page.locator(".setup-page").count(),
      0,
      "SIGN_IN_SETUP_UNDERLAY",
    );
    assert.equal(
      await page
        .locator('.rail [aria-label="ChatGPT"]')
        .getAttribute("aria-current"),
      "page",
    );
  }
  report.snapshots.push({ label, ...state });
  await save();
}
async function screenshot(label, documentId) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const shell = path.join(output, label + "-shell.png");
  await page.screenshot({ path: shell });
  // Native child WebContents are captured independently. Do not present this
  // as the whole OS window or infer stacking from a renderer image.
  const browser = await application.evaluate(async ({ webContents }, id) => {
    const image = await webContents
      .fromId(id)
      .capturePage(undefined, { stayHidden: true });
    return image.toPNG().toString("base64");
  }, documentId);
  const browserPath = path.join(output, label + "-browser.png");
  await fs.writeFile(browserPath, Buffer.from(browser, "base64"), {
    mode: 0o600,
  });
  report.screenshots.push({
    shell,
    browser: browserPath,
    separateSurfaces: true,
  });
  await save();
}
async function close() {
  assert.equal(stopped, false, "SIGN_IN_CLOSE_ALREADY_REQUESTED");
  const windowBefore = await application.evaluate(({ app }) =>
    typeof app.__farolE2EWindowLifetime === "function"
      ? app.__farolE2EWindowLifetime()
      : null,
  );
  assertWindowSnapshot(windowBefore, report.pid);
  report.quitBefore = await readQuitObservation(stateRoot);
  report.quitRequest = beginQuitObservation(report.quitBefore, report.pid);
  stopped = true;
  const owned = application;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("SIGN_IN_CLOSE_UNCONFIRMED")),
      15000,
    );
  });
  try {
    await Promise.race([owned.close(), deadline]);
    const [exitCode, signal] = await Promise.race([terminal, deadline]);
    report.terminal = { exitCode, signal };
    await save();
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    await Promise.race([closed, deadline]);
    const exit = { pid: report.pid, code: exitCode, signal };
    report.windowLifetime = assertWindowLifetime(
      windowBefore,
      windowObservation.snapshot(),
      exit,
    );
    report.quitAfter = await readQuitObservation(stateRoot);
    report.quit = assertFreshQuit(report.quitRequest, report.quitAfter, exit);
    await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
      code: "ENOENT",
    });
    application = null;
  } finally {
    clearTimeout(timer);
    await save();
  }
}
try {
  fixture = await startChatGptFixture();
  application = await _electron.launch({
    executablePath,
    args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    env: {
      FAROL_E2E: "1",
      FAROL_E2E_APP_DATA: appData,
      FAROL_E2E_TEST_ROOT: profile,
      FAROL_E2E_TEST_PROOF: proof,
      FAROL_E2E_CHATGPT_URL: fixture.url,
      FAROL_ENVIRONMENT: "dev",
      HOME: profile,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: os.tmpdir(),
    },
    timeout: 20000,
  });
  terminal = once(application.process(), "exit");
  closed = once(application.process(), "close");
  windowObservation = collectWindowObservation(application.process().stderr);
  report.pid = application.process().pid;
  let stderr = "";
  application.process().stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  page = await application.firstWindow({ timeout: 20000 });
  await poll(
    () => page.evaluate(() => window.farol.bootstrap()),
    (b) => b.runtimeState === "ready" && b.configuration.status === "ready",
    "SIGN_IN_BOOTSTRAP_TIMEOUT",
  );
  const paths = await application.evaluate(({ app, BrowserWindow }) => ({
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    id: BrowserWindow.getAllWindows()[0].id,
    windowObservation:
      typeof app.__farolE2EWindowLifetime === "function"
        ? app.__farolE2EWindowLifetime()
        : null,
  }));
  assertWindowSnapshot(paths.windowObservation, report.pid);
  report.windowInitial = paths.windowObservation;
  mainId = paths.id;
  assert.equal(paths.userData, desktopIdentity("dev", appData).userData);
  assert.equal(paths.sessionData, paths.userData);
  stateRoot = path.join(paths.userData, "farol-state");
  const running = JSON.parse(
    await fs.readFile(path.join(stateRoot, "running.json"), "utf8"),
  );
  assert.equal(running.pid, report.pid);
  await setupStep(page, "signin");
  const opening = page
    .locator('.setup-page[data-setup-step="signin"]')
    .getByRole("button", { name: /^(Sign in|Open ChatGPT)$/ });
  await opening.waitFor();
  report.openAction = await opening.textContent();
  await opening.click();
  await page.locator(".sign-in-context").waitFor();
  const first = await poll(
    native,
    (s) => s.documents.length === 1,
    "SIGN_IN_FIXTURE_NOT_READY",
  );
  const documentId = first.documents[0].id;
  report.documentId = documentId;
  await application.evaluate(
    ({ webContents }, { id, marker }) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          "window.__continuityMarker = " + JSON.stringify(marker),
        ),
    { id: documentId, marker: attemptId },
  );
  // Fresh profiles offer Open ChatGPT until a bound page read is available.
  // Enter the explicit host sign-in command once on that already selected
  // surface, so Return exercises the real sign-in outcome callback too.
  await page.evaluate(() => {
    window.__continuityActions = [];
    window.farol.onShellAction((event) => {
      if (event.source === "auth-window-closed")
        window.__continuityActions.push({
          action: event.action,
          generation: event.authWindowGeneration,
        });
    });
  });
  const signInOpen = await page.evaluate(() =>
    window.farol.configure({ kind: "chatgpt.open-sign-in" }),
  );
  assert.equal(signInOpen.ok, true, "SIGN_IN_FIXTURE_OPEN_REFUSED");
  report.explicitHostSignIn = "opened-once-on-retained-document";
  await observe("opened-wide", documentId, true);
  await screenshot("wide", documentId);
  assert.equal(await page.locator(".sign-in-context").count(), 1);
  assert.deepEqual(await page.evaluate(() => window.__continuityActions), []);
  // Exercise a full local Next/Continue navigation on the retained embedded
  // browser before any Back-to-Setup workaround. This is not Google MFA.
  await application.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          "document.querySelector('[data-testid=next-page-button]').click()",
        ),
    documentId,
  );
  const next = await poll(
    () =>
      application.evaluate(
        async ({ webContents, BrowserWindow }, input) => {
          const c = webContents.fromId(input.id);
          const main = BrowserWindow.fromId(input.mainId);
          return {
            id: c.id,
            ready: await c.executeJavaScript(
              "Boolean(document.querySelector('[data-testid=next-page-ready]'))",
            ),
            attached: main.contentView.children.some(
              (v) => v.webContents?.id === c.id && v.getVisible(),
            ),
          };
        },
        { id: documentId, mainId },
      ),
    (s) => s.ready && s.attached,
    "SIGN_IN_NEXT_NOT_INTERACTIVE",
  );
  assert.equal(next.id, documentId);
  await screenshot("next-before-return", documentId);
  await application.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          "document.querySelector('[data-testid=next-page-return]').click()",
        ),
    documentId,
  );
  const returned = await poll(
    native,
    (s) => s.documents.length === 1 && s.documents[0].id === documentId,
    "SIGN_IN_NEXT_RETURN_LOST_DOCUMENT",
  );
  assert.equal(returned.documents[0].submits, 0);
  assert.equal(await page.locator(".sign-in-context").count(), 1);
  assert.deepEqual(await page.evaluate(() => window.__continuityActions), []);
  report.checks.push("local-next-and-continue-without-setup-workaround");
  // Next intentionally replaces the DOM in the same WebContents. Establish
  // the next canary before testing Setup return/reopen preservation.
  await application.evaluate(
    ({ webContents }, { id, marker }) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          "window.__continuityMarker = " + JSON.stringify(marker),
        ),
    { id: documentId, marker: attemptId },
  );
  // The popup is an entirely local synthetic auth cancellation, with no login.
  await application.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          "document.querySelector('[data-testid=popup-button]').click()",
        ),
    documentId,
  );
  const popup = await poll(
    native,
    (s) => s.windows.some((w) => w.id !== mainId),
    "SIGN_IN_FIXTURE_POPUP_MISSING",
  );
  assert.equal(popup.windows.length, 2);
  for (const w of popup.windows) {
    assert.equal(w.visible, false);
    assert.equal(w.focused, false);
  }
  const popupId = popup.windows.find((w) => w.id !== mainId).id;
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(),
    popupId,
  );
  await poll(
    native,
    (s) => s.windows.length === 1,
    "SIGN_IN_FIXTURE_POPUP_CLOSE_UNKNOWN",
  );
  // Join the normal bounded observation after popup closure. It cannot prove
  // authentication or own a destination change.
  const observed = await page.evaluate(
    (command) => window.farol.configure(command),
    observationCommand,
  );
  assert.equal(observed.ok, true, "SIGN_IN_FIXTURE_OBSERVATION_REFUSED");
  assert.equal(observed.evidence.kind, "chatgpt.sign-in-status");
  assert.equal(observed.evidence.state, "signed_out");
  assert.notEqual(observed.evidence.binding, null);
  report.signInObservation = {
    state: observed.evidence.state,
    bound: observed.evidence.binding !== null,
  };
  await observe("cancelled-popup-retains-browser", documentId, true);
  assert.equal(await page.locator(".sign-in-context").count(), 1);
  await application.evaluate(
    ({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id).setContentSize(640, 600),
    mainId,
  );
  await poll(
    () => page.evaluate(() => innerWidth),
    (width) => width === 640,
    "SIGN_IN_COMPACT_VIEWPORT",
  );
  await observe("compact-640x600", documentId, true);
  await screenshot("compact", documentId);
  // Renderer controls must fit without being covered by the native viewport.
  const geometry = await page.locator(".toolbar").evaluate((toolbar) => ({
    width: toolbar.clientWidth,
    scrollWidth: toolbar.scrollWidth,
    buttons: [...toolbar.querySelectorAll("button")]
      .filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => ({
        label: b.getAttribute("aria-label") || b.textContent.trim(),
        left: b.getBoundingClientRect().left,
        right: b.getBoundingClientRect().right,
      })),
  }));
  assert.ok(
    geometry.scrollWidth <= geometry.width,
    "SIGN_IN_COMPACT_TOOLBAR_OVERFLOW",
  );
  assert.ok(
    geometry.buttons.every((b) => b.left >= 0 && b.right <= 640),
    "SIGN_IN_COMPACT_CONTROL_OFFSCREEN",
  );
  await page
    .getByRole("button", { name: "Back to setup", exact: true })
    .click();
  await page.locator('.setup-page[data-setup-step="signin"]').waitFor();
  await observe("explicit-return-exact-signin", documentId, false);
  await page.waitForFunction(() =>
    window.__continuityActions.some((event) => event.generation !== null),
  );
  report.returnActions = await page.evaluate(() => window.__continuityActions);
  assert.equal(
    await page.locator('.setup-page[data-setup-step="signin"]').count(),
    1,
  );
  await page.locator('.rail [aria-label="ChatGPT"]').click();
  await observe("reopen-same-document", documentId, true);
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Find a page", exact: true })
    .waitFor();
  await observe("search-conceals-native-input", documentId, false);
  await page.keyboard.press("Escape");
  await observe("dismiss-search-restores-document", documentId, true);
  report.checks.push(
    "single-shell-and-correct-native-bounds",
    "popup-cancellation-no-navigation-or-destruction",
    "explicit-return-to-signin",
    "same-browser-after-setup-navigation",
    "search-detaches-native-input",
    "compact-controls-fit",
    "zero-submits",
  );
  await close();
  assert.doesNotMatch(
    stderr,
    /VISIBLE_TEST_VIEWPORT_UNAVAILABLE|renderer-failed|NATIVE_REMOVE_FAILED/u,
  );
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error?.stack ?? error);
  throw error;
} finally {
  try {
    if (application && !stopped) await close();
  } catch (error) {
    report.status = "FAIL";
    report.cleanupError = String(error?.stack ?? error);
    throw error;
  } finally {
    await stopChatGptFixture(fixture);
    if (report.status === "PASS" && application === null) {
      await fs.rm(profile, { recursive: true });
      report.profileReleased = true;
    }
    await save();
    console.log(
      JSON.stringify({
        status: report.status,
        report: path.join(output, "report.json"),
      }),
    );
  }
}
