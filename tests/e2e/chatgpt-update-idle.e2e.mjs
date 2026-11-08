import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { desktopIdentity } from "../../tooling/harness-identity.ts";

// Real Electron layout and public-DOM classification in a disposable hidden
// profile. No provider, installed profile, installed update or focus acceptance.
const root = path.resolve(import.meta.dirname, "../..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "farol-idle-native-"));
const entry = path.join(scratch, "fixture.cjs");
const fixtureAppName = desktopIdentity("dev", scratch).applicationName;
try {
  buildSync({
    stdin: {
      contents: `
import assert from 'node:assert/strict';
import { app, BrowserWindow, WebContentsView } from 'electron';
import { chatGptUpdateIdleProbe } from './src/apps/desktop/chatgpt-update-idle.ts';
import { ChatGptRoute, activateTaskScript, bindChatGptAppScript, prepareTaskScript, taskProbeScript } from './src/apps/desktop/chatgpt-route.ts';
import { NativeViewVisibility } from './apps/desktop/bridge/native-view-visibility.ts';
import { deriveSurfaceLayout } from './src/apps/desktop/surface-layout.ts';
app.setPath('userData', ${JSON.stringify(path.join(scratch, "profile"))});
app.dock?.hide();
const fixtureAppName = ${JSON.stringify(fixtureAppName)};
let host, view;
const observations = [];
app.whenReady().then(async () => {
try {
  host = new BrowserWindow({ show: false, width: 1180, height: 760 });
  view = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  }});
  view.setVisible(false);
  const visibility = new NativeViewVisibility();
  const layout = deriveSurfaceLayout({ width: 1180, height: 760, sidebar: 'full',
    sidebarWidth: 180, overlay: 'none', section: 'settings', setupOpen: false,
    runtimeReady: true, selectedTaskPresent: true });
  const html = '<!doctype html><html><body><form><textarea id="prompt-textarea"></textarea>' +
    '<button type="button" aria-label="Add files and more" aria-expanded="false">+</button>' +
    '<button type="button" aria-label="Select ChatGPT model" aria-expanded="false">Model</button>' +
    '<button type="button" aria-label="Start Voice">Voice</button></form></body></html>';
  await view.webContents.loadURL('data:text/html,' + encodeURIComponent(html));
  const probe = () => view.webContents.executeJavaScript(chatGptUpdateIdleProbe);
  assert.deepEqual(await probe(), { state: 'unknown' });
  observations.push('zero-viewport-refused');
  view.setBounds(layout.pageBounds);
  await view.webContents.executeJavaScript('new Promise((resolve, reject) => {' +
    'const expected = ' + JSON.stringify([layout.pageBounds.width, layout.pageBounds.height]) + ';' +
    'let timer; const check = () => { if (innerWidth !== expected[0] || innerHeight !== expected[1]) return;' +
    'clearTimeout(timer); removeEventListener("resize", check); resolve(); };' +
    'addEventListener("resize", check); timer = setTimeout(() => { removeEventListener("resize", check); reject(new Error("fixture viewport not committed")); }, 5000); check(); })');
  assert.deepEqual(await view.webContents.executeJavaScript('[innerWidth, innerHeight]'),
    [layout.pageBounds.width, layout.pageBounds.height]);
  assert.deepEqual(await probe(), { state: 'idle' });
  assert.equal(view.getVisible(), false);
  assert.equal(host.contentView.children.includes(view), false);
  assert.equal(host.isVisible(), false);
  observations.push('initial-hidden-viewport-idle');
  visibility.show(host, view, layout.pageBounds);
  visibility.hide(view);
  assert.deepEqual(await probe(), { state: 'idle' });
  assert.equal(host.contentView.children.includes(view), false);
  assert.equal(view.getVisible(), false);
  observations.push('detached-viewport-retained');
  await view.webContents.executeJavaScript('document.querySelector("textarea").value = "fixture draft"');
  assert.deepEqual(await probe(), { state: 'draft' });
  await view.webContents.executeJavaScript('document.querySelector("textarea").value = ""');
  await view.webContents.executeJavaScript('document.querySelector("form").setAttribute("aria-busy", "true")');
  assert.deepEqual(await probe(), { state: 'running' });
  await view.webContents.executeJavaScript('document.querySelector("form").removeAttribute("aria-busy")');
  await view.webContents.executeJavaScript('(() => { const b=document.createElement("button"); b.type="button"; b.setAttribute("aria-label","Other action"); document.querySelector("form").append(b); })()');
  assert.deepEqual(await probe(), { state: 'unknown' });
  observations.push('draft-running-unknown-action-refused');
  // Exercise Chromium's actual attribute-selector semantics: CSS's i flag
  // does not fold Cyrillic case, unlike the renderer test DOM implementation.
  const russianComposer = '<form><span data-testid="composer-app-chip" aria-label="' + fixtureAppName + '">' + fixtureAppName + '</span>' +
    '<textarea id="prompt-textarea"></textarea><input type="file">' +
    '<button type="button" aria-label="Добавить файлы и другое"></button>' +
    '<button type="button" aria-label="Выбрать модель ChatGPT"></button>' +
    '<button type="button" aria-label="Диктовать"></button>' +
    '<button type="button" aria-label="Отправить" onclick="window.fixtureSends++"></button></form>';
  await view.webContents.executeJavaScript('window.fixtureSends = 0; document.body.innerHTML = ' + JSON.stringify(russianComposer));
  const fixtureHref = view.webContents.getURL();
  for (const label of ['Удалить файл plan.pdf', 'Удалить вложение plan.pdf', 'УДАЛИТЬ ВЛОЖЕНИЕ plan.pdf']) {
    await view.webContents.executeJavaScript('document.querySelector("textarea").value = ""; document.querySelector("form").insertAdjacentHTML("beforeend", ' +
      JSON.stringify('<div id="document-preview" aria-label="' + label + '">plan.pdf</div>') + ')');
    assert.deepEqual(await view.webContents.executeJavaScript(prepareTaskScript('check', fixtureHref, fixtureAppName, undefined, true)), {draftPresent: true});
    assert.deepEqual(await view.webContents.executeJavaScript(bindChatGptAppScript(fixtureAppName, fixtureHref, true)), {state: 'blocked', reason: 'draft_present'});
    await view.webContents.executeJavaScript('document.querySelector("textarea").value = "check"');
    assert.deepEqual(await view.webContents.executeJavaScript(activateTaskScript(fixtureHref, fixtureAppName, false, false, 'check')), {draftPresent: true});
    assert.equal(await view.webContents.executeJavaScript('window.fixtureSends'), 0);
    await view.webContents.executeJavaScript('document.querySelector("#document-preview").remove()');
  }
  observations.push('russian-uploaded-document-fenced-before-bind-prepare-and-send');
  await view.webContents.executeJavaScript('document.body.insertAdjacentHTML("afterbegin", ' + JSON.stringify(
    '<div data-message-id="user-1" data-message-author-role="user">check</div>' +
    '<article><div data-message-id="assistant-1" data-message-author-role="assistant" data-message-channel="final"><div class="markdown"><p>ok</p></div></div><button data-testid="copy-turn-action-button">Copy</button></article>') + ')');
  for (const label of ['Отправить', 'Отправить сообщение']) {
    await view.webContents.executeJavaScript('document.querySelector("button[onclick]").setAttribute("aria-label", ' + JSON.stringify(label) + ')');
    assert.equal((await view.webContents.executeJavaScript(taskProbeScript('check', []))).sendVisible, true);
    const completed = await view.webContents.executeJavaScript(taskProbeScript('check', [], {semantic: true, userId: 'user-1', assistantId: 'assistant-1'}));
    assert.equal(completed.publicFrame.terminal, true);
    assert.equal(completed.publicFrame.messages[0].text, 'ok');
    assert.deepEqual(await view.webContents.executeJavaScript(activateTaskScript(fixtureHref, fixtureAppName, false, false, 'check')), {activated: true});
  }
  assert.equal(await view.webContents.executeJavaScript('window.fixtureSends'), 2);
  await view.webContents.executeJavaScript('document.querySelector("form").insertAdjacentHTML("beforeend", ' + JSON.stringify('<button data-testid="stop-button">Stop</button>') + ')');
  assert.equal((await view.webContents.executeJavaScript(taskProbeScript('check', [], {semantic: true, userId: 'user-1', assistantId: 'assistant-1'}))).publicFrame.terminal, false);
  observations.push('russian-send-observed-without-test-id');
  const route = new ChatGptRoute({homeUrl:'https://chatgpt.com/',initialUrl:'https://chatgpt.com/',e2eOrigin:null,parent:()=>null});
  const contents=view.webContents;
  Reflect.set(route,'routeWindow',{kind:'embedded',webContents:contents,isDestroyed:()=>contents.isDestroyed(),destroy:()=>contents.close({waitForBeforeUnload:false})});
  const admission=await route.acquireUpdateClose();
  assert.equal(admission.ok,true);
  assert.equal(contents.isDestroyed(),true);
  assert.deepEqual(await admission.recheck(),{ok:true});
  assert.deepEqual(await route.open(),{status:'unreachable'});
  await admission.release();
  observations.push('confirmed-native-close-observed-and-fenced');
  process.stdout.write(JSON.stringify({ result: 'PASS', observations,
    mode: 'hidden-disposable-electron', provider: 'NOT_RUN', installedOTA: 'NOT_RUN' }) + '\\n');
} finally {
  const remaining = view?.webContents;
  if (remaining && !remaining.isDestroyed()) remaining.close();
  if (host && !host.isDestroyed()) host.destroy();
  app.quit();
}
}).catch(error => { process.stderr.write(String(error.stack) + '\\n'); app.exit(1); });
`,
      resolveDir: root,
      sourcefile: "idle-native-fixture.ts",
      loader: "ts",
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
  });
  // Electron's default entry supports ESM through the file extension.
  const esmEntry = path.join(scratch, "fixture.mjs");
  await fs.rename(entry, esmEntry);
  const executable = createRequire(import.meta.url)("electron");
  const child = spawn(executable, [esmEntry], {
    env: {
      HOME: os.homedir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: os.tmpdir(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
  const terminal = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  assert.deepEqual(terminal, { code: 0, signal: null }, stderr);
  const report = JSON.parse(stdout.trim());
  assert.equal(report.result, "PASS");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
