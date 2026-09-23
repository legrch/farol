// Real Electron, isolated synthetic home, no account or model traffic.
// Captures only this owned window, never the desktop or another application's UI.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const root = process.cwd();
const label = "guided";
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
await fs.mkdir(home, { recursive: true, mode: 0o700 });
await fs.mkdir(appData, { recursive: true, mode: 0o700 });
await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
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
  const steps = ["chatgpt", "folder", "tunnel", "app", "finish"];
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
  assert.equal(await window.locator("#onboarding-primary").isEnabled(), false);
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
  await window
    .locator('[data-onboarding-content="app"] > .onboarding-help > summary')
    .click();
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
    .locator('#onboarding-primary:disabled:text("Working…")')
    .waitFor({ state: "visible" });
  await window.screenshot({ path: path.join(output, "07-folder-busy.png") });
  await window
    .locator('[data-onboarding-step="folder"].complete')
    .waitFor({ state: "visible" });
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
  await window.locator("#onboarding-runtime-key").fill("");
  console.log(
    JSON.stringify({
      label,
      placement,
      screenshots: steps.length + 6,
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
