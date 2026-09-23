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
    '<!doctype html><html><head><title>ChatGPT sign-in fixture</title></head><body style="background:#f5f5f5;color:#202020;font:24px sans-serif;padding:48px"><h1>ChatGPT sign-in fixture</h1><button>Log in</button></body></html>',
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
  assert.equal(await window.locator("#guided-onboarding details").count(), 0);
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
    "Save credentials",
  );
  // Saving is independent; an app check still routes to missing sign-in.
  await window.locator('[data-onboarding-step="app"]').click();
  assert.equal(
    await window.locator("#onboarding-primary").innerText(),
    "Go to Sign in",
  );
  await window.locator("#onboarding-primary").click();
  assert.equal(
    await window.locator('[data-onboarding-content="chatgpt"]').isVisible(),
    true,
  );
  await window.screenshot({
    path: path.join(output, "09-activation-blocked.png"),
  });
  await window.locator('[data-onboarding-step="chatgpt"]').click();
  await window.locator("#onboarding-primary").click();
  await window.locator("#sign-in-return").waitFor({ state: "visible" });
  await window.locator('[data-panel="browser"].active').waitFor();
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
      };
    },
  );
  assert.deepEqual(signInSurface, { windows: 1, pages: 1 });
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
  await window.locator("#onboarding-primary").click();
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
  await window.locator("#onboarding-recheck").click();
  await window
    .locator('#onboarding-primary:not(:disabled):text("Continue")')
    .waitFor();
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
  await window.locator("#onboarding-add-folder").click();
  await window
    .locator("#onboarding-folder-confirmation")
    .waitFor({ state: "visible" });
  await window.locator("#onboarding-cancel-folder").click();
  const cancelledConfiguration = (
    await window.evaluate(() => window.farolNext.bootstrap())
  ).configuration;
  assert.equal(
    cancelledConfiguration.settings.connectors.secureMcp.runtime
      .runtimeGeneration,
    runtimeGeneration,
    "CANCELLED_FOLDER_CHANGE_RESTARTED_TUNNEL",
  );
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
  await new Promise((resolve) => chatGptFixture.close(resolve));
}
