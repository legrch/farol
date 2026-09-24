// Real Electron, isolated synthetic home, no account or model traffic.
// Captures only this owned window, never the desktop or another application's UI.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const root = process.cwd();
const label = "guided-owner-editable";
const output = path.resolve(root, "../_output/onboarding-visual", label);
const tempParent = path.resolve(root, "../_output/tmp");
await fs.mkdir(output, { recursive: true, mode: 0o700 });
await fs.mkdir(tempParent, { recursive: true, mode: 0o700 });
const temporaryRoot = await fs.mkdtemp(
  path.join(tempParent, "onboarding-visual-"),
);
const home = path.join(temporaryRoot, "home");
const appData = path.join(temporaryRoot, "app-data");
const workspaceRoot = path.join(temporaryRoot, "approved-folder");
const secondWorkspaceRoot = path.join(temporaryRoot, "another-project");
await fs.mkdir(home, { recursive: true, mode: 0o700 });
await fs.mkdir(appData, { recursive: true, mode: 0o700 });
await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
await fs.mkdir(secondWorkspaceRoot, { recursive: true, mode: 0o700 });
const tunnelFixture = path.join(temporaryRoot, "tunnel-client.cjs");
const chatGptFixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><html><head><title>ChatGPT sign-in fixture</title></head><body style="background:#f5f5f5;color:#202020;font:24px sans-serif;padding:48px"><h1>ChatGPT sign-in fixture</h1><button>Log in</button><button id="fixture-sidebar-toggle" style="pointer-events:none" aria-label="Close sidebar" aria-expanded="true" onclick="this.setAttribute(\'aria-label\', \'Open sidebar\'); this.setAttribute(\'aria-expanded\', \'false\')">Toggle sidebar</button></body></html>',
  );
});
await new Promise((resolve) => chatGptFixture.listen(0, "127.0.0.1", resolve));
const chatGptAddress = chatGptFixture.address();
assert.ok(chatGptAddress && typeof chatGptAddress !== "string");
await fs.writeFile(
  tunnelFixture,
  `#!${process.execPath}\n${await fs.readFile(new URL("./tunnel-client.fixture.cjs", import.meta.url), "utf8")}`,
  { mode: 0o700 },
);
let application;
try {
  application = await electron.launch({
    executablePath: path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [
      path.join(root, "dist/app/main.cjs"),
      "--preview-window-mode=secondary-visible",
    ],
    env: {
      HOME: home,
      TMPDIR: temporaryRoot,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      FAROL_NEXT_ENVIRONMENT: "dev",
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_WORKSPACE_ROOT: workspaceRoot,
      FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelFixture,
      FAROL_NEXT_E2E_CHATGPT_URL: `http://127.0.0.1:${chatGptAddress.port}/`,
    },
    timeout: 15000,
  });
  const window = await application.firstWindow({ timeout: 15000 });
  await window
    .locator('#runtime-pill[data-state="ready"]')
    .waitFor({ timeout: 15000 });
  await window.locator('[data-panel="computer"].active').waitFor();
  const placement = await application.evaluate(({ BrowserWindow, screen }) => {
    const owned = BrowserWindow.getAllWindows()[0];
    const display = screen.getDisplayMatching(owned.getBounds());
    return {
      visible: owned.isVisible(),
      focused: owned.isFocused(),
      internal: display.internal,
      primary: display.id === screen.getPrimaryDisplay().id,
      bounds: owned.getBounds(),
    };
  });
  assert.equal(placement.visible, true);
  assert.equal(
    placement.focused,
    false,
    "The capture must not take native focus.",
  );
  assert.equal(
    placement.internal,
    true,
    "Only the built-in display is approved for this capture.",
  );
  assert.equal(
    placement.primary,
    false,
    "Do not use the owner's primary display.",
  );
  await window.locator("#onboarding-nav").waitFor({ state: "visible" });
  await window.locator("#setup-dialog").waitFor({ state: "hidden" });
  await window.locator("#sidebar-toggle").click();
  await window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "rail",
  );
  await window.locator("#sidebar-toggle").click();
  await window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "full",
  );
  await window.locator("#command-button").click();
  await window.locator("#command-dialog").waitFor({ state: "visible" });
  await window.mouse.click(1120, 500);
  await window.locator("#command-dialog").waitFor({ state: "hidden" });
  assert.equal(
    await window.locator("#connection-diagnostics").getAttribute("open"),
    null,
  );
  assert.equal(
    await window.locator("#connection-permission").isVisible(),
    false,
  );
  // Layout fixture only: expose the existing permission card without creating
  // a task or granting authority. Its real pending state is owned by the host.
  await window.locator("#connection-permission").evaluate((card) => {
    card.hidden = false;
    card.querySelector("button").disabled = false;
  });
  const permissionLayout = await window.evaluate(() => {
    const card = document
      .querySelector("#connection-permission")
      .getBoundingClientRect();
    const footer = document
      .querySelector("#onboarding-primary")
      .getBoundingClientRect();
    const button = document.querySelector("#approve-tool");
    const target = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      target.x + target.width / 2,
      target.y + target.height / 2,
    );
    return {
      cardTop: card.top,
      cardBottom: card.bottom,
      footerBottom: footer.bottom,
      viewportHeight: innerHeight,
      buttonHittable: hit === button || button.contains(hit),
    };
  });
  assert.ok(
    permissionLayout.cardTop >= permissionLayout.footerBottom,
    "GUIDED_PERMISSION_OVERLAPS_FOOTER",
  );
  assert.ok(
    permissionLayout.cardBottom <= permissionLayout.viewportHeight,
    "GUIDED_PERMISSION_CLIPPED",
  );
  assert.ok(
    permissionLayout.buttonHittable,
    "GUIDED_PERMISSION_BUTTON_OBSCURED",
  );
  await window.screenshot({
    path: path.join(output, "permission-layout-fixture.png"),
  });
  await window.locator("#connection-permission").evaluate((card) => {
    card.hidden = true;
  });
  assert.equal(
    await window.locator('[data-onboarding-content="finish"]').isVisible(),
    true,
  );
  assert.equal(
    await window.locator("#onboarding-finish-list button").count(),
    4,
  );
  assert.equal(await window.locator("#onboarding-app-guide ol li").count(), 3);
  assert.equal(await window.locator("#onboarding-flow").count(), 0);
  const scrollRail = await window.evaluate(() => ({
    rail: document.querySelector("#onboarding-scroll").getBoundingClientRect()
      .right,
    panel: document
      .querySelector('[data-panel="computer"].active')
      .getBoundingClientRect().right,
  }));
  assert.ok(
    Math.abs(scrollRail.rail - scrollRail.panel) <= 1,
    "GUIDED_SCROLLBAR_SHOULD_REACH_PANEL_EDGE",
  );
  assert.equal(await window.locator("#onboarding-folder-choice").count(), 0);
  assert.equal(
    await window.locator("#connection-diagnostics").isVisible(),
    false,
  );
  const steps = ["chatgpt", "folder", "tunnel", "app", "finish"];
  let footerY = null;
  const completedBefore = await window
    .locator("[data-onboarding-step].complete")
    .count();
  for (const [index, step] of steps.entries()) {
    await window.locator(`[data-onboarding-step="${step}"]`).click();
    await window
      .locator(`[data-onboarding-content="${step}"]`)
      .waitFor({ state: "visible" });
    const primary = window.locator("#onboarding-primary");
    await primary.scrollIntoViewIfNeeded();
    const geometry = await primary.boundingBox();
    if (footerY === null) footerY = geometry?.y ?? null;
    assert.ok(
      geometry && footerY !== null && Math.abs(geometry.y - footerY) < 1,
      `GUIDED_FOOTER_MOVED:${step}`,
    );
    await window.locator("#onboarding-scroll").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const afterScroll = await primary.boundingBox();
    assert.ok(
      afterScroll && geometry && Math.abs(afterScroll.y - geometry.y) < 1,
      `GUIDED_FOOTER_SCROLLED:${step}`,
    );
    await window.locator("#onboarding-scroll").evaluate((node) => {
      node.scrollTop = 0;
    });
    const viewport = await window.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    assert.ok(
      geometry &&
        geometry.x >= 0 &&
        geometry.y >= 0 &&
        geometry.x + geometry.width <= viewport.width &&
        geometry.y + geometry.height <= viewport.height,
      `GUIDED_PRIMARY_CLIPPED:${step}`,
    );
    assert.equal(
      await window
        .locator("#guided-onboarding .onboarding-primary:visible")
        .count(),
      1,
    );
    await window.screenshot({
      path: path.join(
        output,
        `${String(index + 1).padStart(2, "0")}-${step}.png`,
      ),
    });
  }
  assert.equal(
    await window.locator("[data-onboarding-step].complete").count(),
    completedBefore,
    "VISITING_IS_NOT_VERIFICATION",
  );
  await window.locator('[data-onboarding-step="tunnel"]').click();
  assert.equal(await window.locator("#onboarding-primary").isEnabled(), true);
  assert.equal(
    await window.locator("#onboarding-primary").innerText(),
    "Continue without local access",
  );
  // Without a shared folder, local Computer access remains off and the app
  // check can be skipped without claiming that the connection was verified.
  await window.locator('[data-onboarding-step="app"]').click();
  assert.equal(
    await window.locator("#onboarding-primary").innerText(),
    "Continue without local access",
  );
  await window.locator("#onboarding-primary").click();
  assert.equal(
    await window.locator('[data-onboarding-content="finish"]').isVisible(),
    true,
  );
  assert.equal(
    await window.locator('[data-onboarding-step="app"].complete').count(),
    0,
  );
  await window.locator('[data-onboarding-step="chatgpt"]').click();
  assert.equal(
    await window.locator('[data-onboarding-content="chatgpt"]').isVisible(),
    true,
  );
  await window.screenshot({
    path: path.join(output, "09-activation-blocked.png"),
  });
  await window.locator("#onboarding-primary").click();
  await window.locator("#sign-in-return").waitFor({ state: "visible" });
  await window.locator('[data-panel="browser"].active').waitFor();
  assert.equal(
    await window.locator("#task-tabs").isVisible(),
    false,
    "SIGN_IN_SHOULD_NOT_SHOW_EMPTY_TASK_TABS",
  );
  assert.equal(
    await window.locator("#task-dossier").isVisible(),
    false,
    "SIGN_IN_SHOULD_NOT_SHOW_TASK_DIAGNOSTICS",
  );
  assert.match(
    await window.locator("#browser-state-title").innerText(),
    /^(Opening ChatGPT|ChatGPT is open)$/u,
  );
  const signInSurface = await application.evaluate(
    ({ BrowserWindow, WebContentsView }) => {
      const windows = BrowserWindow.getAllWindows();
      return {
        windows: windows.length,
        pages:
          windows[0]?.contentView.children.filter(
            (child) =>
              child instanceof WebContentsView &&
              child.getVisible() &&
              child.webContents.getURL().startsWith("http://127.0.0.1:"),
          ).length ?? 0,
        pageTop:
          windows[0]?.contentView.children
            .find(
              (child) =>
                child instanceof WebContentsView &&
                child.getVisible() &&
                child.webContents.getURL().startsWith("http://127.0.0.1:"),
            )
            ?.getBounds().y ?? null,
      };
    },
  );
  assert.deepEqual(signInSurface, { windows: 1, pages: 1, pageTop: 52 });
  assert.equal(
    await application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const page = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (child) =>
          child instanceof WebContentsView &&
          child.getVisible() &&
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
      );
      if (!page) throw new Error("CHATGPT_SIDEBAR_FIXTURE_MISSING");
      return page.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const timer = setInterval(() => {
            if (document.querySelector('#fixture-sidebar-toggle')?.getAttribute('aria-label') === 'Open sidebar') {
              clearInterval(timer);
              resolve(true);
            }
          }, 50);
          setTimeout(() => { clearInterval(timer); resolve(false); }, 3000);
        })`,
        true,
      );
    }),
    true,
    "CHATGPT_HOME_SIDEBAR_NOT_COLLAPSED",
  );
  assert.equal(
    await application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const page = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (child) =>
          child instanceof WebContentsView &&
          child.getVisible() &&
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
      );
      return page?.webContents.executeJavaScript(
        'document.querySelector("#farol-sign-in-banner") === null',
        true,
      );
    }),
    true,
    "EMBEDDED_SIGN_IN_MUST_USE_THE_SHELL_RETURN_CONTROL",
  );
  await window.screenshot({
    path: path.join(output, "06-sign-in-shell.png"),
  });
  const embeddedCapture = await application.evaluate(
    async ({ BrowserWindow, WebContentsView }) => {
      const page = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (child) =>
          child instanceof WebContentsView &&
          child.getVisible() &&
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
      );
      if (!page) throw new Error("EMBEDDED_SIGN_IN_PAGE_MISSING");
      return (await page.webContents.capturePage()).toPNG().toString("base64");
    },
  );
  await fs.writeFile(
    path.join(output, "06-sign-in-page.png"),
    Buffer.from(embeddedCapture, "base64"),
    { mode: 0o600 },
  );
  await window.locator("#sign-in-return").click();
  await window.locator("#guided-onboarding").waitFor({ state: "visible" });
  await window.locator("#sign-in-return").waitFor({ state: "hidden" });
  await window.locator("#onboarding-recheck").click();
  await window
    .locator('#onboarding-status:text("Sign-in is not complete yet")')
    .waitFor();
  assert.equal(
    await window.locator('[data-onboarding-step="chatgpt"].complete').count(),
    0,
    "A read-only signed-out check must not turn the step green",
  );
  await window
    .locator('#onboarding-primary:text("Sign in to ChatGPT")')
    .waitFor();
  await window.locator("#onboarding-primary").click();
  await window.locator("#sign-in-return").waitFor({ state: "visible" });
  const verificationSurfaceId = await application.evaluate(
    async ({ BrowserWindow, WebContentsView }) => {
      const page = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (child) =>
          child instanceof WebContentsView &&
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
      );
      if (!page) throw new Error("VERIFICATION_SURFACE_MISSING");
      await page.webContents.executeJavaScript(
        `document.querySelector("button").remove();
         const composer = document.createElement("textarea");
         composer.id = "prompt-textarea";
         composer.value = "retained-synthetic-draft";
         document.body.append(composer);`,
        true,
      );
      return page.webContents.id;
    },
  );
  const taskCountBeforeRecovery = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).tasks.length;
  await window.locator("#sign-in-return").click();
  await window.locator("#guided-onboarding").waitFor({ state: "visible" });
  await window.locator("#sign-in-return").waitFor({ state: "hidden" });
  await window
    .locator('[data-onboarding-step="chatgpt"].complete')
    .waitFor({ state: "visible" });
  await window.locator('[data-onboarding-step="app"]').click();
  await window.locator("#onboarding-open-chatgpt").click();
  await window.locator("#sign-in-return").waitFor({ state: "visible" });
  const recoveredSurface = await application.evaluate(
    async ({ BrowserWindow, WebContentsView }) => {
      const page = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (child) =>
          child instanceof WebContentsView &&
          child.getVisible() &&
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
      );
      if (!page) return null;
      return {
        id: page.webContents.id,
        draft: await page.webContents.executeJavaScript(
          'document.querySelector("#prompt-textarea")?.value',
          true,
        ),
      };
    },
  );
  assert.deepEqual(recoveredSurface, {
    id: verificationSurfaceId,
    draft: "retained-synthetic-draft",
  });
  assert.equal(
    (await window.evaluate(() => window.farolNext.bootstrap())).tasks.length,
    taskCountBeforeRecovery,
    "APP_RECOVERY_CREATED_UNRELATED_TASK",
  );
  await window.locator("#sign-in-return").click();
  await window.locator("#guided-onboarding").waitFor({ state: "visible" });
  await window.locator('[data-onboarding-step="folder"]').click();
  await window.locator('[data-onboarding-step="folder"].complete').waitFor();
  assert.equal(
    await window.locator("#onboarding-primary").innerText(),
    "Continue",
  );
  await window.locator("#onboarding-primary").click();
  await window
    .locator('[data-onboarding-content="tunnel"]')
    .waitFor({ state: "visible" });
  assert.equal(
    await window.locator("#onboarding-primary").innerText(),
    "Continue without local access",
  );
  await window.locator("#onboarding-primary").click();
  await window
    .locator('[data-onboarding-content="finish"]')
    .waitFor({ state: "visible" });
  assert.equal(
    await window.locator("#onboarding-primary").innerText(),
    "Open ChatGPT",
  );
  await window.locator('[data-onboarding-step="folder"]').click();
  await window.locator("#onboarding-add-folder").click();
  await window
    .locator('#onboarding-form[aria-busy="false"]')
    .waitFor({ state: "visible" });
  await window
    .locator('[data-onboarding-step="folder"].complete')
    .waitFor({ state: "visible" });
  assert.equal(
    await window.locator("#onboarding-status").getAttribute("data-state"),
    "ready",
  );
  assert.equal(
    await window.locator(".onboarding-folder-path").innerText(),
    workspaceRoot,
  );
  // The same native pick is a no-op addition; it must not duplicate the grant.
  await window.locator("#onboarding-add-folder").click();
  await window
    .locator('#onboarding-primary:not(:disabled):text("Continue")')
    .waitFor();
  assert.equal(
    await window.locator(".onboarding-folder-path").innerText(),
    workspaceRoot,
  );
  assert.equal(await window.locator(".onboarding-folder-card").count(), 1);
  await application.evaluate((_electron, selectedRoot) => {
    process.env.FAROL_NEXT_E2E_WORKSPACE_ROOT = selectedRoot;
  }, secondWorkspaceRoot);
  await window.locator("#onboarding-add-folder").click();
  await window
    .locator('#onboarding-primary:not(:disabled):text("Continue")')
    .waitFor();
  assert.equal(
    await window.locator('.onboarding-folder-card[data-state="ready"]').count(),
    2,
  );
  assert.deepEqual(
    await window.locator(".onboarding-folder-path").allTextContents(),
    [workspaceRoot, secondWorkspaceRoot],
  );
  await window.screenshot({
    path: path.join(output, "07-multiple-folders.png"),
  });
  await window
    .getByRole("button", {
      name: "Remove another-project from Farol",
      exact: true,
    })
    .click();
  await window.locator("#onboarding-confirm-folder").click();
  await window
    .locator('#onboarding-primary:not(:disabled):text("Continue")')
    .waitFor();
  assert.equal(await window.locator(".onboarding-folder-card").count(), 1);
  assert.equal(
    (await fs.stat(secondWorkspaceRoot)).isDirectory(),
    true,
    "REMOVE_DELETED_OWNER_FILES",
  );
  assert.equal(
    await window.locator("#onboarding-status").getAttribute("data-state"),
    "ready",
  );
  assert.equal(await window.locator("#onboarding-recheck").isVisible(), false);
  await window.screenshot({
    path: path.join(output, "08-folder-verified.png"),
  });
  await window.locator('[data-onboarding-step="tunnel"]').click();
  assert.equal(await window.locator("#onboarding-primary").isEnabled(), true);
  await window.screenshot({
    path: path.join(output, "10-activation-ready.png"),
  });
  await window.locator("#onboarding-tunnel-id").fill("tunnel_ui_fixture");
  await window
    .locator("#onboarding-runtime-key")
    .fill("synthetic-ui-fixture-not-a-real-key");
  await window.locator('[data-onboarding-step="folder"]').click();
  await window.locator('[data-onboarding-step="tunnel"]').click();
  assert.equal(
    await window.locator("#onboarding-tunnel-id").inputValue(),
    "tunnel_ui_fixture",
  );
  assert.equal(
    await window.locator("#onboarding-runtime-key").inputValue(),
    "synthetic-ui-fixture-not-a-real-key",
  );
  assert.equal(
    await window.locator("#onboarding-runtime-key").getAttribute("type"),
    "password",
  );
  await window.locator("#onboarding-primary").click();
  await window
    .locator("#onboarding-credentials-saved")
    .waitFor({ state: "visible" });
  assert.equal(
    await window.locator("#onboarding-connection-guide").isVisible(),
    false,
    "SAVED_CONNECTION_REPEATED_CREATION_GUIDE",
  );
  assert.equal(
    await window.locator("#onboarding-connection-help").isVisible(),
    false,
  );
  const statusAlignment = await window.evaluate(() => ({
    heading: document.querySelector("#onboarding-title").getBoundingClientRect()
      .left,
    status: document.querySelector("#onboarding-status").getBoundingClientRect()
      .left,
  }));
  assert.ok(
    Math.abs(statusAlignment.heading - statusAlignment.status) <= 1,
    "STATUS_NOT_ALIGNED_WITH_CONTENT",
  );
  assert.equal(
    await window.locator("#onboarding-tunnel-fields").isVisible(),
    false,
  );
  assert.equal(
    await window.locator("#onboarding-primary").innerText(),
    "Activate and check",
  );
  const savedConfiguration = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).configuration;
  assert.equal(savedConfiguration.status, "ready");
  assert.equal(
    savedConfiguration.settings.connectors.secureMcp.runtime,
    null,
    "SAVE_STARTED_THE_TUNNEL",
  );
  await window.screenshot({
    path: path.join(output, "11-credentials-saved.png"),
  });
  await window.locator("#onboarding-replace-credentials").click();
  assert.equal(
    await window.locator("#onboarding-runtime-key").inputValue(),
    "",
    "SAVED_KEY_ENTERED_THE_RENDERER",
  );
  await window
    .locator("#onboarding-runtime-key")
    .fill("sk-synthetic-unsaved-replacement-123456");
  await window
    .locator("#onboarding-tunnel-id")
    .fill("tunnel_unsaved_replacement");
  await window.locator("#onboarding-keep-credentials").click();
  await window
    .locator("#onboarding-credentials-saved")
    .waitFor({ state: "visible" });
  assert.equal(
    await window.locator("#onboarding-runtime-key").inputValue(),
    "",
  );
  const keptConfiguration = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).configuration;
  assert.deepEqual(
    keptConfiguration,
    savedConfiguration,
    "CANCELLED_REPLACEMENT_CHANGED_SETTINGS",
  );
  await window.locator("#onboarding-primary").click();
  await window
    .locator('[data-onboarding-step="tunnel"].complete')
    .waitFor({ state: "visible", timeout: 30000 });
  await window
    .locator('#onboarding-primary:not(:disabled):text("Continue")')
    .waitFor();
  await window.locator("#onboarding-primary").click();
  await window
    .locator('[data-onboarding-content="app"]')
    .waitFor({ state: "visible" });
  await window.locator('[data-onboarding-step="tunnel"]').click();
  const activeConfiguration = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).configuration;
  assert.equal(activeConfiguration.status, "ready");
  const runtimeGeneration =
    activeConfiguration.settings.connectors.secureMcp.runtime.runtimeGeneration;
  assert.equal(
    activeConfiguration.settings.connectors.secureMcp.attachment,
    null,
    "LOCAL_READY_IS_NOT_MCP_PROOF",
  );
  await window.locator("#onboarding-recheck").click();
  await window
    .locator('#onboarding-primary:not(:disabled):text("Continue")')
    .waitFor();
  const checkedConfiguration = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).configuration;
  assert.equal(
    checkedConfiguration.settings.connectors.secureMcp.runtime
      .runtimeGeneration,
    runtimeGeneration,
    "HEALTH_CHECK_RESTARTED_TUNNEL",
  );
  await window.screenshot({ path: path.join(output, "12-tunnel-checked.png") });
  // A failed pre-submit app check exits route sign-in mode. Return to Setup
  // must still work; otherwise the embedded ChatGPT page traps the owner.
  await window.locator('[data-onboarding-step="app"]').click();
  await window.locator("#onboarding-primary").click();
  await window
    .locator('#onboarding-form[aria-busy="false"]')
    .waitFor({ state: "attached", timeout: 15000 });
  await window.locator("#sign-in-return").waitFor({ state: "visible" });
  await window.locator("#sign-in-return").click();
  await window.locator("#guided-onboarding").waitFor({
    state: "visible",
    timeout: 3000,
  });
  await window.screenshot({
    path: path.join(output, "13-return-after-app-check.png"),
  });
  await window.locator('[data-onboarding-step="folder"]').click();
  await application.evaluate(() => {
    process.env.FAROL_NEXT_E2E_CANCEL_WORKSPACE_PICKER = "1";
  });
  await window.locator("#onboarding-add-folder").click();
  await window
    .locator('#onboarding-form[aria-busy="false"]')
    .waitFor({ state: "attached" });
  await application.evaluate(() => {
    delete process.env.FAROL_NEXT_E2E_CANCEL_WORKSPACE_PICKER;
  });
  assert.equal(
    await window.locator("#onboarding-folder-confirmation").isVisible(),
    false,
  );
  const cancelledConfiguration = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).configuration;
  assert.equal(
    cancelledConfiguration.settings.connectors.secureMcp.runtime
      .runtimeGeneration,
    runtimeGeneration,
    "CANCELLED_FOLDER_CHANGE_RESTARTED_TUNNEL",
  );
  await window.locator("#onboarding-add-folder").click();
  await window.waitForFunction(
    () =>
      document.querySelectorAll('.onboarding-folder-card[data-state="ready"]')
        .length === 2 &&
      document.querySelector("#onboarding-form")?.getAttribute("aria-busy") ===
        "false",
  );
  const addedWhileRunning = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).configuration;
  assert.equal(
    addedWhileRunning.settings.connectors.secureMcp.runtime.state,
    "ready",
  );
  assert.notEqual(
    addedWhileRunning.settings.connectors.secureMcp.runtime.runtimeGeneration,
    runtimeGeneration,
    "FOLDER_SCOPE_CHANGE_REUSED_OLD_CONNECTOR",
  );
  assert.equal(
    addedWhileRunning.settings.connectors.secureMcp.attachment,
    null,
  );
  await window.screenshot({
    path: path.join(output, "13-folder-added-while-connected.png"),
  });
  const tasksBeforeBrowser = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).tasks.length;
  await window.locator("#onboarding-return").click();
  await window.locator('[data-panel="browser"].active').waitFor();
  const plainBrowser = await application.evaluate(
    ({ BrowserWindow, WebContentsView }) => {
      const owned = BrowserWindow.getAllWindows()[0];
      const page = owned.contentView.children.find(
        (child) =>
          child instanceof WebContentsView &&
          child.getVisible() &&
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
      );
      return {
        visible: Boolean(page),
        pageTop: page?.getBounds().y ?? null,
      };
    },
  );
  assert.deepEqual(plainBrowser, { visible: true, pageTop: 52 });
  assert.equal(
    (await window.evaluate(() => window.farolNext.bootstrap())).tasks.length,
    tasksBeforeBrowser,
    "OPENING_BROWSER_CREATED_A_TASK",
  );
  assert.equal(await window.locator("#task-tabs").isVisible(), false);
  await window.screenshot({ path: path.join(output, "14-browser-home.png") });
  const created = await window.evaluate(() =>
    window.farolNext.task({ kind: "task.create-chatgpt" }),
  );
  assert.equal(created.ok, true, "SYNTHETIC_CHATGPT_TASK_NOT_CREATED");
  await window.locator("#task-tabs .task-tab").waitFor({ state: "visible" });
  assert.equal(await window.locator("#task-dossier").isVisible(), false);
  assert.equal(await window.locator("#new-task").isVisible(), false);
  assert.equal(await window.locator("#browser-status-bar").isVisible(), true);
  const compactLayout = await application.evaluate(
    ({ BrowserWindow, WebContentsView }) => {
      const owned = BrowserWindow.getAllWindows()[0];
      const page = owned.contentView.children.find(
        (child) => child instanceof WebContentsView && child.getVisible(),
      );
      return {
        y: page?.getBounds().y ?? null,
        height: page?.getBounds().height ?? null,
      };
    },
  );
  assert.equal(compactLayout.y, 52);
  assert.equal(compactLayout.height, 683);
  await window.locator("#sidebar-toggle").click();
  await window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "rail",
  );
  const railChrome = await window.evaluate(() => {
    const tab = document.querySelector("#task-tabs .task-tab");
    const tabRect = tab.getBoundingClientRect();
    const toggleRect = document
      .querySelector("#sidebar-toggle")
      .getBoundingClientRect();
    const footerRect = document
      .querySelector("#browser-status-bar")
      .getBoundingClientRect();
    return {
      tabLeft: tabRect.left,
      toggleRight: toggleRect.right,
      footerLeft: footerRect.left,
      sidebarWidth: document.querySelector("#sidebar").getBoundingClientRect()
        .width,
      firstTabHittable: tab.contains(
        document.elementFromPoint(tabRect.left + 15, tabRect.top + 20),
      ),
    };
  });
  assert.ok(railChrome.tabLeft >= railChrome.toggleRight);
  assert.equal(railChrome.footerLeft, railChrome.sidebarWidth);
  assert.equal(railChrome.firstTabHittable, true);
  await window.locator("#sidebar-toggle").click();
  await window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "full",
  );
  const fullChrome = await window.evaluate(() => ({
    footerLeft: document
      .querySelector("#browser-status-bar")
      .getBoundingClientRect().left,
    sidebarWidth: document.querySelector("#sidebar").getBoundingClientRect()
      .width,
  }));
  assert.equal(fullChrome.footerLeft, fullChrome.sidebarWidth);
  await window.locator("#command-button").click();
  await window.locator("#command-dialog").waitFor({ state: "visible" });
  await window.mouse.click(1120, 500);
  await window.locator("#command-dialog").waitFor({ state: "hidden" });
  await window.screenshot({ path: path.join(output, "14-compact-task.png") });
  await window.locator("#task-tabs .task-tab-close").click();
  await window.locator("#task-tabs .task-tab").waitFor({ state: "hidden" });
  await window.locator('.nav-item[data-section="settings"]').click();
  await window.locator("#settings-nav").waitFor({ state: "visible" });
  assert.equal(await window.locator("#nav").isVisible(), false);
  assert.equal(
    await window.locator('.nav-utility [data-section="settings"]').isVisible(),
    false,
  );
  assert.equal(await window.locator("#settings-return").isVisible(), true);
  assert.equal(
    await window
      .locator("#settings-nav")
      .evaluate((nav) => nav.parentElement.id),
    "sidebar",
    "SETTINGS_CATEGORIES_NOT_IN_FAROL_SIDEBAR",
  );
  assert.equal(
    await window.locator("#settings-computer-title").isVisible(),
    false,
    "SETTINGS_DUPLICATED_SETUP",
  );
  await window.locator("#settings-general-title").waitFor({ state: "visible" });
  await window.locator('[data-settings-category="model"]').click();
  await window.locator("#settings-model-title").waitFor({ state: "visible" });
  await window.locator('[data-settings-category="diagnostics"]').click();
  await window.locator("#diagnostics-group").waitFor({ state: "visible" });
  await window.locator("#settings-return").click();
  await window.locator('[data-panel="browser"]').waitFor({ state: "visible" });
  await window.locator('.nav-item[data-section="settings"]').click();
  await window.locator('[data-settings-category="shortcuts"]').click();
  await window.locator("#settings-shortcuts-title").waitFor({
    state: "visible",
  });
  await window.locator("#setting-sidebar-shortcut").selectOption("b");
  await window.locator("#apply-shortcuts").click();
  await window.locator('#shortcut-feedback[data-state="ready"]').waitFor();
  await window.keyboard.press("Control+Meta+B");
  await window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "rail",
  );
  await window.keyboard.press("Control+Meta+B");
  await window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "full",
  );
  const savedBeforeConflict = await window.evaluate(() =>
    localStorage.getItem("farol.next.navigation-shortcuts.v1"),
  );
  await window.locator('[data-shortcut-section="browser"]').selectOption("4");
  await window.locator("#apply-shortcuts").click();
  assert.equal(
    await window.locator("#shortcut-feedback").getAttribute("data-state"),
    "error",
  );
  assert.equal(
    await window.evaluate(() =>
      localStorage.getItem("farol.next.navigation-shortcuts.v1"),
    ),
    savedBeforeConflict,
  );
  await window.locator('[data-shortcut-section="settings"]').selectOption("1");
  await window.locator("#apply-shortcuts").click();
  assert.equal(
    await window.locator("#shortcut-feedback").getAttribute("data-state"),
    "ready",
  );
  assert.equal(
    await window.evaluate(
      () =>
        JSON.parse(localStorage.getItem("farol.next.navigation-shortcuts.v1"))
          .browser,
    ),
    4,
  );
  await window.reload();
  await window.locator('.nav-item[data-section="settings"]').click();
  await window.locator('[data-settings-category="shortcuts"]').click();
  assert.equal(
    await window.locator('[data-shortcut-section="browser"]').inputValue(),
    "4",
  );
  await window.screenshot({
    path: path.join(output, "14-settings-shortcuts.png"),
  });
  await window.keyboard.press("Meta+4");
  await window.locator('[data-panel="browser"].active').waitFor();
  await window.locator('.nav-item[data-section="settings"]').click();
  await window.locator('[data-shortcut-section="browser"]').selectOption("0");
  await window.locator("#apply-shortcuts").click();
  await window.locator('#shortcut-feedback[data-state="ready"]').waitFor();
  await window.keyboard.press("Meta+4");
  await window.locator('[data-panel="settings"].active').waitFor();
  assert.equal(
    await window.locator('[data-panel="browser"]').isVisible(),
    false,
    "UNBOUND_SHORTCUT_NAVIGATED",
  );
  await window.locator("#reset-shortcuts").click();
  await window.locator('#shortcut-feedback[data-state="ready"]').waitFor();
  assert.equal(
    await window.evaluate(
      () =>
        JSON.parse(localStorage.getItem("farol.next.navigation-shortcuts.v1"))
          .browser,
    ),
    1,
  );
  await window.locator('[data-settings-category="diagnostics"]').click();
  await window.locator("#connection-diagnostics").waitFor({
    state: "visible",
  });
  await window.locator("#connection-diagnostics > summary").click();
  await window.locator("#connections-readiness-title").waitFor({
    state: "visible",
  });
  await window.locator('[data-settings-category="preferences"]').click();
  await window.locator("#settings-general-title").waitFor({
    state: "visible",
  });
  await window.locator("#settings-return").click();
  await window.locator('.nav-item[data-section="activity"]').click();
  await window.locator("#activity-setup-note").waitFor({ state: "visible" });
  console.log(
    JSON.stringify({
      label,
      placement,
      screenshots: (await fs.readdir(output)).filter((file) =>
        file.endsWith(".png"),
      ).length,
      multipleFoldersChecked: true,
      removePreservedFiles: true,
      cancelledCredentialReplacementPreservedSettings: true,
      healthCheckDidNotRestart: true,
      signInSurface,
      navigationChangesNoReadiness: true,
      modelSends: 0,
      externalResourcesCreated: 0,
      evidence: "real-electron-synthetic-home",
    }),
  );
  await application.close();
  application = undefined;

  // A cold Browser open must end in a visible error if its page cannot load.
  // This second instance has its own empty fixture profile and no live traffic.
  await new Promise((resolve) => chatGptFixture.close(resolve));
  const failedAppData = path.join(temporaryRoot, "failed-app-data");
  const failedHome = path.join(temporaryRoot, "failed-home");
  const failedUrl = `http://127.0.0.1:${chatGptAddress.port}/failure-only-${process.pid}-${Date.now()}`;
  await fs.mkdir(failedAppData, { recursive: true, mode: 0o700 });
  await fs.mkdir(failedHome, { recursive: true, mode: 0o700 });
  application = await electron.launch({
    executablePath: path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [
      path.join(root, "dist/app/main.cjs"),
      "--preview-window-mode=secondary-visible",
    ],
    env: {
      HOME: failedHome,
      TMPDIR: temporaryRoot,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      FAROL_NEXT_ENVIRONMENT: "dev",
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: failedAppData,
      FAROL_NEXT_E2E_WORKSPACE_ROOT: workspaceRoot,
      FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelFixture,
      FAROL_NEXT_E2E_CHATGPT_URL: failedUrl,
    },
    timeout: 15000,
  });
  const failedWindow = await application.firstWindow({ timeout: 15000 });
  await failedWindow.locator('[data-panel="computer"].active').waitFor();
  assert.equal(
    await application.evaluate(({ BrowserWindow, screen }) => {
      const owned = BrowserWindow.getAllWindows()[0];
      const display = screen.getDisplayMatching(owned.getBounds());
      return (
        owned.isVisible() &&
        !owned.isFocused() &&
        display.internal &&
        display.id !== screen.getPrimaryDisplay().id
      );
    }),
    true,
    "FAILED_BROWSER_CASE_MUST_STAY_ON_INACTIVE_SECONDARY_DISPLAY",
  );
  await failedWindow.locator("#onboarding-return").click();
  await failedWindow.locator('[data-panel="browser"].active').waitFor();
  await failedWindow.screenshot({
    path: path.join(output, "15-browser-opening.png"),
  });
  await failedWindow.waitForTimeout(2000);
  console.log(
    JSON.stringify({
      failedFixtureListening: chatGptFixture.listening,
      failedWindowState: await failedWindow.evaluate(async () => {
        const state = await window.farolNext.bootstrap();
        return {
          environment: state.environment,
          taskCount: state.tasks.length,
          section: document.documentElement.dataset.section,
          title: document.querySelector("#browser-state-title")?.textContent,
        };
      }),
      failedNativeState: await application.evaluate(
        ({ BrowserWindow, WebContentsView }) =>
          BrowserWindow.getAllWindows()[0]
            .contentView.children.filter(
              (child) => child instanceof WebContentsView,
            )
            .map((child) => ({
              url: child.webContents.getURL(),
              visible: child.getVisible(),
              loading: child.webContents.isLoading(),
            })),
      ),
    }),
  );
  await failedWindow
    .locator('#browser-state-title:text("ChatGPT could not open")')
    .waitFor({ timeout: 40000 });
  assert.equal(await failedWindow.locator("#browser-retry").isVisible(), true);
  await failedWindow.screenshot({
    path: path.join(output, "15-browser-open-failed.png"),
  });
  await new Promise((resolve) =>
    chatGptFixture.listen(chatGptAddress.port, "127.0.0.1", resolve),
  );
  await failedWindow.locator("#browser-retry").click();
  await failedWindow.locator('#browser-loading[data-state="ready"]').waitFor();
  const recoveredNativePage = await application.evaluate(
    ({ BrowserWindow, WebContentsView }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.some(
        (child) =>
          child instanceof WebContentsView &&
          child.getVisible() &&
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
      ),
  );
  assert.equal(recoveredNativePage, true, "RETRY_DID_NOT_REOPEN_EMBEDDED_PAGE");
  await new Promise((resolve) => chatGptFixture.close(resolve));
  await application.evaluate(
    async ({ BrowserWindow, WebContentsView }, url) => {
      const page = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (child) =>
          child instanceof WebContentsView &&
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
      );
      if (!page) throw new Error("RECOVERED_PAGE_MISSING");
      await page.webContents.loadURL(url).catch(() => undefined);
    },
    `http://127.0.0.1:${chatGptAddress.port}/unavailable`,
  );
  await failedWindow
    .locator('#browser-state-title:text("ChatGPT could not open")')
    .waitFor({ timeout: 15000 });
  await failedWindow.screenshot({
    path: path.join(output, "16-browser-late-failure.png"),
  });
  console.log(
    JSON.stringify({
      failedBrowserRecoveryVisible: true,
      laterNavigationFailureVisible: true,
    }),
  );
} finally {
  if (application) {
    const child = application.process();
    let timer;
    try {
      await Promise.race([
        application.close(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("OWNED_WINDOW_CLOSE_TIMEOUT")),
            10000,
          );
        }),
      ]);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true });
  if (chatGptFixture.listening) {
    await new Promise((resolve) => chatGptFixture.close(resolve));
  }
}
