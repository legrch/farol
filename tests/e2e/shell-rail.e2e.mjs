// Built shipping renderer in hidden Electron with a disposable, synthetic preload.
// Native geometry probes use a disposable local WebContentsView and the unchanged
// shipping host layout function. No backend, account, connection or owner profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { _electron } from "playwright-core";
const root = process.cwd();
let deriveSurfaceLayout;
const output = path.join(root, "_output/shell-screens");
await fs.mkdir(output, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "farol-shell-rail-"));
const report = {
  mode: "hidden",
  fixture: true,
  checks: [],
  windows: [],
  screenshots: [],
  nativeGeometry: [],
  screenshotSurface:
    "renderer only; native child bounds asserted separately, no compositor or live-provider claim",
  walkthroughGeometry: [],
  cleanup: "pending",
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceDirty:
    execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim() !== "",
  builtBytes: {},
};
let app;
let page;
const errors = [];
async function capture(page, name) {
  await page.mouse.move(300, 20);
  await page.evaluate(async () => {
    if (!document.querySelector("[data-fixture-label]")) {
      const badge = document.createElement("div");
      badge.dataset.fixtureLabel = "true";
      badge.textContent = "Synthetic renderer fixture · no live connection";
      badge.style.cssText =
        "position:fixed;bottom:4px;right:14px;font:10px system-ui;color:#6b6b76;z-index:100;pointer-events:none";
      document.body.append(badge);
    }
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: path.join(output, name + ".png") });
  report.screenshots.push(name + ".png");
}
async function captureWalkthrough(name) {
  const geometry = await page
    .locator(".walkthrough-cards")
    .evaluate((list) => ({
      viewport: innerWidth,
      width: list.getBoundingClientRect().width,
      height: list.getBoundingClientRect().height,
      overflow: list.scrollWidth > list.clientWidth,
      cards: [...list.children].map((card) => ({
        width: card.getBoundingClientRect().width,
        height: card.getBoundingClientRect().height,
      })),
    }));
  assert.equal(geometry.overflow, false, "walkthrough must fit the window");
  assert.ok(
    geometry.height >= 120 && geometry.height <= 155,
    "three compact drawn cards, about 120px tall",
  );
  report.walkthroughGeometry.push({ name, ...geometry });
  await capture(page, name);
}
// A real hidden native child uses the host's unchanged geometry and current renderer
// layout arguments. This witnesses native bounds only, not composition or a live route.
async function captureNativeGeometry(name, expectedWidth) {
  const dom = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      width: innerWidth,
      height: innerHeight,
      stage: rect(".stage"),
      rail: rect(".rail"),
      args: window.shellRailTest.layout(),
    };
  });
  const [section, , setupOpen, , sidebar, overlay, sidebarWidth] = dom.args;
  const expected = deriveSurfaceLayout({
    width: dom.width,
    height: dom.height,
    section,
    setupOpen,
    sidebar,
    overlay,
    sidebarWidth,
    runtimeReady: true,
    selectedTaskPresent: true,
  }).pageBounds;
  assert.equal(dom.rail.width, expectedWidth);
  assert.deepEqual(
    dom.stage,
    expected,
    "renderer must meet the unchanged native browser edge",
  );
  assert.equal(dom.rail.x + dom.rail.width, expected.x);
  assert.equal(expected.x + expected.width, dom.width);
  const native = await app.evaluate(
    async ({ BrowserWindow, WebContentsView }, bounds) => {
      const w = BrowserWindow.getAllWindows()[0];
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      try {
        w.contentView.addChildView(view);
        view.setBounds(bounds);
        const actual = view.getBounds();
        return { actual, visible: w.isVisible(), focused: w.isFocused() };
      } finally {
        w.contentView.removeChildView(view);
        view.webContents.close();
      }
    },
    expected,
  );
  assert.deepEqual(native.actual, expected);
  assert.equal(native.visible, false);
  assert.equal(native.focused, false);
  await capture(page, name);
  report.nativeGeometry.push({
    name,
    dom,
    expected,
    actual: native.actual,
    visible: native.visible,
    focused: native.focused,
    childClosed: true,
  });
}
try {
  await build({
    entryPoints: ["tests/e2e/shell-rail-fixture.ts"],
    outfile: path.join(temp, "fixture.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const { shellRailFixture } = createRequire(import.meta.url)(
    path.join(temp, "fixture.cjs"),
  );
  await build({
    entryPoints: ["src/ui/renderer/entry.tsx"],
    outfile: path.join(temp, "shell.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    target: ["chrome145"],
  });
  await fs.copyFile(
    "src/ui/renderer/shell.html",
    path.join(temp, "shell.html"),
  );
  await fs.writeFile(
    path.join(temp, "shell.css"),
    (
      await Promise.all(
        [
          "src/ui/renderer/shell.css",
          "src/ui/renderer/home.css",
          "src/ui/renderer/setup.css",
          "apps/desktop/renderer/recovery/view.css",
        ].map((p) => fs.readFile(p, "utf8")),
      )
    ).join("\n"),
  );
  await fs.copyFile(
    "design-lab/fonts/geist/Geist-Variable.woff2",
    path.join(temp, "Geist-Variable.woff2"),
  );
  for (const file of ["shell.js", "shell.css"])
    report.builtBytes[file] = createHash("sha256")
      .update(await fs.readFile(path.join(temp, file)))
      .digest("hex");
  await build({
    entryPoints: ["src/apps/desktop/surface-layout.ts"],
    outfile: path.join(temp, "native-layout.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  ({ deriveSurfaceLayout } = createRequire(import.meta.url)(
    path.join(temp, "native-layout.cjs"),
  ));
  const bootstrap = shellRailFixture(true);
  await fs.writeFile(
    path.join(temp, "preload.cjs"),
    `
const {contextBridge}=require('electron');
const ready=${JSON.stringify(bootstrap)};
const unfinished=${JSON.stringify(shellRailFixture(false))};
const listeners=new Map();const calls=[];let sequence=0;let lastLayout=[];let snapshot=localStorage.getItem("shell-rail-fixture") === "unfinished" ? unfinished : ready;
const listen=name=>fn=>{listeners.set(name,fn);return ()=>listeners.delete(name)};
contextBridge.exposeInMainWorld('farolRecovery',{
 state:async()=>({status:"ready",revision:1,folders:[{workspaceId:"22222222-2222-4222-8222-222222222222",label:"Synthetic workspace",root:"/synthetic/workspace"}],computer:"available",archive:"available"}),
 read:async()=>({status:"refused"}),quit:()=>{}
});
contextBridge.exposeInMainWorld('farol',{
 bootstrap:async()=>snapshot,snapshot:async()=>snapshot,
 configure:async(command)=>{calls.push(command.kind);if(command.kind==='chatgpt.observe-sign-in')return {ok:true,snapshot:snapshot.configuration,evidence:{kind:'chatgpt.sign-in-status',observationId:command.observationId,buildId:command.buildId,state:'authenticated',binding:{documentGeneration:0,sequence:1}}};if(command.kind==='chatgpt.verify')return {ok:true,snapshot:snapshot.configuration,evidence:{kind:'chatgpt.readiness',state:'authenticated',code:null}};return {ok:true,snapshot:snapshot.configuration};},
 installedUpdate:async()=>({ok:true,view:{phase:'idle',checkedAt:null}}),
 task:async()=>{throw Error('NO_TASK_EFFECT_ALLOWED')},setNavigationShortcuts:async()=>({ok:true}),
 layout:(...args)=>{lastLayout=args},onConfigurationChanged:listen('configuration'),onTasksState:listen('tasks'),onRuntimeEvent:listen('event'),onRuntimeState:listen('runtime'),onInstalledUpdateState:listen('update'),onBrowserRouteState:listen('route'),onTaskSurfaceState:listen('surface'),onLayout:listen('layout'),onShellAction:listen('action'),onWindowState:listen('window'),onConnectionStatus:listen('connection'),
});
contextBridge.exposeInMainWorld('shellRailTest',{
 emit:(name,value)=>listeners.get(name)?.(value),calls:()=>[...calls],layout:()=>lastLayout,
 unfinished:()=>{snapshot=unfinished;listeners.get('configuration')?.()},
 toggle:()=>listeners.get('action')?.({action:'toggle-sidebar',source:'sidebar-command',eventId:'11111111-1111-4111-8111-'+String(++sequence).padStart(12,'0'),authWindowGeneration:null})
});`,
  );
  await fs.writeFile(
    path.join(temp, "main.cjs"),
    `
const {app,BrowserWindow}=require('electron');const path=require('node:path');
process.on('uncaughtException',e=>{console.error(e);app.exit(1)});
app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{const w=new BrowserWindow({width:1100,height:760,show:false,frame:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',(e)=>e.preventDefault());await w.loadFile(path.join(__dirname,'shell.html'));});app.on('window-all-closed',()=>app.quit());`,
  );
  app = await _electron.launch({
    executablePath: path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.join(temp, "main.cjs")],
    timeout: 30000,
  });
  const child = app.process();
  const terminal = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.evaluate(() => {
    const badge = document.createElement("div");
    badge.dataset.fixtureLabel = "true";
    badge.textContent = "Synthetic renderer fixture · no live connection";
    badge.style.cssText =
      "position:fixed;bottom:4px;right:14px;font:10px system-ui;color:#6b6b76;z-index:100;pointer-events:none";
    document.body.append(badge);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .locator(".rail")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.locator(".home-setup-card").waitFor();
  assert.equal(
    await page.locator(".desktop").getAttribute("data-sidebar"),
    "full",
  );
  await capture(page, "b2-default-expanded-fixture");
  await capture(page, "home-unfinished");
  assert.equal(await page.locator(".home-candidate section").count(), 1);
  await page
    .getByRole("button", { name: "Continue setup", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check sign-in", exact: true })
    .click();
  await page.getByText("✓ Sign-in checked", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await capture(page, "setup-rail");
  await captureWalkthrough("b3-connect-this-mac");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("heading", { name: "Add Farol to ChatGPT", exact: true })
    .waitFor();
  await captureWalkthrough("b3-add-to-chatgpt");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    () => !document.querySelector(".walkthrough-cursor"),
  );
  assert.equal(await page.locator(".walkthrough-cursor").count(), 0);
  await capture(page, "b3-add-to-chatgpt-reduced");
  await page
    .locator(".setup-wizard-footer")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await capture(page, "b3-connect-this-mac-reduced");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(620, 760),
  );
  await page.waitForFunction(() => innerWidth === 620);
  await captureWalkthrough("b3-connect-this-mac-compact");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await captureWalkthrough("b3-add-to-chatgpt-compact");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 760),
  );
  await page.waitForFunction(() => innerWidth === 1100);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  report.checks.push(
    "both compact walkthroughs rendered, including reduced-motion static cards",
  );
  assert.equal(
    await page
      .locator('.rail [aria-current="page"]')
      .getAttribute("aria-label"),
    "Setup",
  );
  assert.equal(await page.locator(".setup-progress").count(), 1);
  await page
    .locator(".rail")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.getByText("Farol is working", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.shellRailTest.emit("tasks", {
      revision: 1,
      tasks: [
        {
          taskId: "task-1",
          sessionId: "task-1",
          turnId: "task-1",
          label: "Review project notes",
          provider: "chatgpt",
          requestedModel: null,
          observedModel: null,
          requestedMode: null,
          observedMode: null,
          hasComputer: false,
          pinned: false,
          lifecycle: "completed",
        },
      ],
    });
    for (const [index, kind] of [
      "turn.phase",
      "computer.requested",
      "computer.completed",
    ].entries())
      window.shellRailTest.emit("event", {
        ownerId: "fixture",
        sessionId: "task-1",
        taskId: "task-1",
        turnId: "task-1",
        generation: 1,
        at: Date.now() - index * 60000,
        kind,
        ...(kind === "turn.phase"
          ? { phase: "completed" }
          : {
              callId: "fixture-call",
              ...(kind === "computer.requested"
                ? { operation: "workspace.read" }
                : {}),
            }),
      });
  });
  assert.equal(await page.locator(".home-recent .home-row").count(), 3);
  await capture(page, "home-working");
  await capture(page, "rail-collapsed");
  await captureNativeGeometry("b3-rail-wide", 62);
  assert.equal(
    await page
      .locator(".rail")
      .evaluate((e) => e.getBoundingClientRect().width),
    62,
  );
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".rail").getBoundingClientRect().width === 214,
  );
  await capture(page, "rail-expanded");
  await captureNativeGeometry("b3-rail-expanded", 214);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(620, 760),
  );
  await page.waitForFunction(
    () => document.querySelector(".rail").getBoundingClientRect().width === 58,
  );
  await capture(page, "narrow-window");
  await captureNativeGeometry("b3-rail-compact", 58);
  for (const [width, expected] of [
    [850, 58],
    [851, 214],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, 760),
      width,
    );
    await page.waitForFunction(
      (width) =>
        document.querySelector(".rail").getBoundingClientRect().width === width,
      expected,
    );
    await captureNativeGeometry(`b3-rail-boundary-${width}`, expected);
  }
  assert.equal(
    await page
      .locator(".sidebar-overlay,.contextual-sidebar,.sidebar-scrim")
      .count(),
    0,
  );
  assert.equal(await page.locator("main").getAttribute("inert"), null);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 760),
  );
  await page.waitForFunction(
    () => document.querySelector(".rail").getBoundingClientRect().width === 214,
  );
  report.checks.push(
    "62/58/214px widths, automatic compact collapse and restored preference",
  );
  // Keyboard events target only the hidden renderer. This proves DOM focus, not OS focus.
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .locator(".rail")
    .getByRole("button", { name: "Home", exact: true })
    .focus();
  for (const label of ["ChatGPT", "Activity", "Setup"]) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement.getAttribute("aria-label"),
      ),
      label,
    );
  }
  await capture(page, "rail-keyboard-focus");
  assert.equal(await page.locator(".rail button:focus-visible").count(), 1);
  await page.keyboard.press("Enter");
  assert.equal(
    await page
      .locator('.rail [aria-current="page"]')
      .getAttribute("aria-label"),
    "Setup",
  );
  report.checks.push(
    "keyboard-only Tab order and Enter navigation; visible DOM focus ring",
  );
  await page.evaluate(() => window.shellRailTest.toggle());
  assert.equal(
    await page.locator(".desktop").getAttribute("data-sidebar"),
    "full",
  );
  report.checks.push("native View-menu action adapter toggles sidebar");
  await page
    .locator(".rail")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  const callsBefore = await page.evaluate(() => window.shellRailTest.calls());
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.shellRailTest.calls())).filter(
      (k) => k === "connector.check-health",
    ).length,
    callsBefore.filter((k) => k === "connector.check-health").length + 1,
  );
  report.checks.push(
    "Check now calls the existing health command exactly once",
  );
  await page.evaluate(() =>
    window.shellRailTest.emit("event", {
      ownerId: "fixture",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      kind: "turn.phase",
      at: Date.now(),
      phase: "completed",
    }),
  );
  await page
    .locator(".rail")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await capture(page, "settings-inner-sections");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".desktop")
      .evaluate((e) => getComputedStyle(e).transitionDuration),
    "0s",
  );
  report.checks.push(
    "width changes snap to native geometry; reduced motion has no width transition",
  );
  await page.evaluate(() =>
    localStorage.setItem("shell-rail-fixture", "unfinished"),
  );
  await page.reload();
  await page
    .locator(".rail")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.getByText("Finish setup", { exact: true }).waitFor();
  await capture(page, "home-not-connected");
  assert.equal(
    await page.locator(".home-setup-steps [data-state=done]").count(),
    0,
  );
  assert.equal(
    await page.locator(".rail-connection").getAttribute("data-connected"),
    "false",
  );
  await page.goto(page.url().split("#")[0] + "#farol-startup-recovery");
  await page.reload();
  await page
    .getByRole("button", { name: "Check previous operations", exact: true })
    .waitFor();
  await capture(page, "b2-recovery-fixture");
  await page
    .getByRole("button", { name: "Check previous operations", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open with commands paused", exact: true })
    .click();
  await capture(page, "b2-recovery-paused-fixture");
  report.windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      focused: w.isFocused(),
      bounds: w.getBounds(),
    })),
  );
  assert.ok(report.windows.every((w) => !w.visible && !w.focused));
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  assert.deepEqual(await terminal, { code: 0, signal: null });
  report.cleanup = "owned Electron exited 0; disposable profile removed";
} catch (error) {
  if (page) {
    console.error(await page.locator("body").innerText());
    await page.screenshot({ path: path.join(output, "failure.png") });
  }
  console.error(errors);
  throw error;
} finally {
  if (app) await app.close();
  await fs.rm(temp, { recursive: true, force: true });
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(JSON.stringify(report, null, 2));
