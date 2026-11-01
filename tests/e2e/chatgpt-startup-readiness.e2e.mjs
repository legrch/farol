import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";

// Real hidden Electron with a loopback DOM and deliberately unfinished image.
// Exercises the full connector caller with one synthetic Send; no provider, owner profile or OTA.
const root = path.resolve(import.meta.dirname, "../..");
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-readiness-native-"),
);
const entry = path.join(scratch, "fixture.mjs");
let confirmed = false;
const fixtureAppName = "Readiness Fixture";
const syntheticPage = `<!doctype html><html><body>
<textarea id="prompt-textarea"></textarea>
<button type="button" aria-label="Turn off temporary chat">Temporary chat</button>
<button type="button">Personalized</button>
<button type="button" aria-label="Select ChatGPT model" onclick="document.getElementById('power').hidden=false">6 Instant</button>
<input id="power" type="range" min="0" max="2" value="0" hidden>
<span data-testid="composer-app-chip" data-plugin-id="plugin_asdk_app_ReadinessFixture" data-app-name="${fixtureAppName}">${fixtureAppName}</span>
<button type="button" data-testid="send-button" disabled>Send</button>
<section id="conversation"></section>{{held-image}}
<script>
const composer=document.getElementById('prompt-textarea');
const send=document.querySelector('[data-testid="send-button"]');
composer.addEventListener('input',()=>{send.disabled=!composer.value.trim();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')document.getElementById('power').hidden=true;});
send.onclick=()=>{
 const user=document.createElement('article'); user.setAttribute('data-message-author-role','user');user.setAttribute('data-message-id','fixture-user');user.textContent=composer.value;
 const reply=document.createElement('article');reply.setAttribute('data-message-author-role','assistant');reply.setAttribute('data-message-id','fixture-answer');reply.textContent='Synthetic connection receipt is ready.';
 document.getElementById('conversation').append(user,reply);composer.value='';
 fetch('/receipt',{method:'POST'}).catch(()=>{});
};
</script></body></html>`;

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
let acknowledgeHeld;
const heldArrived = new Promise(resolve => { acknowledgeHeld = resolve; });
let temporaryNavigations = 0, nonGetRequests = 0, finishLoads = 0, syntheticSends = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'GET') nonGetRequests++;
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/receipt' && req.method === 'POST') { syntheticSends++; res.writeHead(200).end('{}'); return; }
  if (url.pathname === '/held.svg') {
    held.add(res);
    acknowledgeHeld();
    res.once('close', () => held.delete(res));
    return;
  }
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }
  const temporary = url.searchParams.get('temporary-chat') === 'true';
  if (temporary) temporaryNavigations++;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(${JSON.stringify(syntheticPage)}.replace('{{held-image}}', temporary ? '<img src="/held.svg">' : ''));
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
      e2eOrigin:origin, parent:()=>null, windowPresentation:{mode:'hidden'},taskTimeoutMs:10000,taskPollMs:30 });
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
    // DOM readiness can precede delivery of the image request to this server.
    // Join that original request; never issue a second navigation or request.
    let heldTimer;
    await Promise.race([heldArrived,new Promise((_resolve,reject)=>{
      heldTimer=setTimeout(()=>reject(Error('Original held resource was not observed')),5000);
    })]).finally(()=>clearTimeout(heldTimer));
    assert.equal(held.size, 1);
    assert.equal(nonGetRequests, 0);
    assert.equal(windows[0].isVisible(), false);
    assert.equal(windows[0].isFocused(), false);
    let observedOutput = false, claims = 0;
    const result = await route.runReadonlyTask('Synthetic startup connector check', [], {
      readConnectorReceipt:async()=>syntheticSends===1 && observedOutput,
      onDispatchIntent:async()=>{claims++;},
      onTextDelta:async()=>{observedOutput=true;},
    }, 'temporary-instant', {name:${JSON.stringify(fixtureAppName)}});
    assert.equal(result.state,'receipt_confirmed', JSON.stringify(result));
    assert.equal(observedOutput,true);
    assert.equal(syntheticSends,1);
    assert.equal(claims,1);
    assert.equal(finishLoads,0);
    assert.equal(temporaryNavigations,1);
    assert.equal(held.size,1);

    process.stdout.write(JSON.stringify({result:'PASS', mode:'hidden-disposable-electron',
      temporaryNavigations, fullLoadFinished:false, heldSubresources:held.size,
      authenticatedCurrentDocument:true, priorObservationInvalidated:true,
      elapsedMs:Math.round(performance.now()-started), provider:'NOT_RUN',
      installedProfile:'NOT_TOUCHED', syntheticSends, claims, fullConnectorTask:result.state, responseProbeObserved:observedOutput})+'\\n');
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
