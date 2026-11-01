import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";

// Real hidden Electron with a loopback DOM and deliberately unfinished image.
// This qualifies navigation/readiness only: no provider, Send, owner profile or OTA.
const root = path.resolve(import.meta.dirname, "../..");
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-readiness-native-"),
);
const entry = path.join(scratch, "fixture.mjs");
let confirmed = false;
try {
  buildSync({
    stdin: {
      contents: `
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, BrowserWindow } from 'electron';
import { ChatGptRoute } from './src/apps/desktop/chatgpt-route.ts';
import { waitForConnectorCheckReadiness } from './apps/desktop/bridge/connector-check-readiness.ts';
app.setPath('userData', ${JSON.stringify(path.join(scratch, "profile"))});
app.dock?.hide();
let route;
const held = new Set();
let temporaryNavigations = 0, nonGetRequests = 0, finishLoads = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'GET') nonGetRequests++;
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/held.svg') {
    held.add(res);
    res.once('close', () => held.delete(res));
    return;
  }
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }
  const temporary = url.searchParams.get('temporary-chat') === 'true';
  if (temporary) temporaryNavigations++;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body><textarea id="prompt-textarea"></textarea>' +
    (temporary ? '<img src="/held.svg">' : '') + '</body></html>');
});
const closeServer = async () => {
  for (const res of held) res.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};
app.whenReady().then(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    route = new ChatGptRoute({ homeUrl:origin+'/', initialUrl:origin+'/',
      e2eOrigin:origin, parent:()=>null, windowPresentation:{mode:'hidden'} });
    assert.deepEqual(await route.preload(), {status:'opened'});
    const windows = BrowserWindow.getAllWindows();
    assert.equal(windows.length, 1);
    const contents = windows[0].webContents;
    contents.on('did-finish-load', () => {
      if (new URL(contents.getURL()).searchParams.get('temporary-chat') === 'true') finishLoads++;
    });
    const initialObservation = await route.observeSignInStatus();
    assert.equal(initialObservation.state, 'authenticated');
    const started = performance.now();
    assert.deepEqual(await route.openTemporaryChat(), {status:'opened'});
    assert.equal(await waitForConnectorCheckReadiness(route, () => true), true);
    assert.equal(route.isCurrentSignInStatus(initialObservation), false);
    assert.equal(temporaryNavigations, 1);
    assert.equal(finishLoads, 0);
    assert.equal(held.size, 1);
    assert.equal(nonGetRequests, 0);
    assert.equal(windows[0].isVisible(), false);
    assert.equal(windows[0].isFocused(), false);
    process.stdout.write(JSON.stringify({result:'PASS', mode:'hidden-disposable-electron',
      temporaryNavigations, fullLoadFinished:false, heldSubresources:held.size,
      authenticatedCurrentDocument:true, priorObservationInvalidated:true,
      elapsedMs:Math.round(performance.now()-started), provider:'NOT_RUN',
      installedProfile:'NOT_TOUCHED', sends:0})+'\\n');
  } finally {
    route?.dispose();
    await closeServer();
    app.quit();
  }
}).catch(error => { process.stderr.write(String(error.stack)+'\\n'); app.exit(1); });
`,
      resolveDir: root,
      sourcefile: "startup-readiness-native-fixture.ts",
      loader: "ts",
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
  });
  const child = spawn(createRequire(import.meta.url)("electron"), [entry], {
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
  const timeout = setTimeout(() => child.kill("SIGTERM"), 45_000);
  const terminal = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  assert.deepEqual(terminal, { code: 0, signal: null }, stderr);
  const report = JSON.parse(stdout.trim());
  assert.equal(report.result, "PASS");
  confirmed = true;
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  if (confirmed) await fs.rm(scratch, { recursive: true, force: true });
  else
    process.stderr.write(
      `Retained failed or unconfirmed fixture: ${scratch}\n`,
    );
}
