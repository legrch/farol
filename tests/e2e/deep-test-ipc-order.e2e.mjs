import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";

// Hidden disposable Electron; synthetic app and connector. This proves IPC
// scheduling and the real host function, not provider/native/install behavior.
const root = path.resolve(import.meta.dirname, "../..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "farol-deep-ipc-"));
const source = await fs.readFile(
  path.join(root, "src/apps/desktop/main.ts"),
  "utf8",
);
const begin = source.indexOf("async function runManualDeepTest(");
const end = source.indexOf("function deepTestStatus()", begin);
assert.ok(begin >= 0 && end > begin);
const entry = path.join(scratch, "entry.cjs");
let child;
try {
  buildSync({
    stdin: {
      resolveDir: root,
      sourcefile: "deep-test-fixture.ts",
      loader: "ts",
      contents: `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain } from 'electron';
import { PrivateChatGptTaskJournal } from './src/apps/desktop/chatgpt-task-journal.ts';
import { ChatGptTaskJournalOperationIdSchema } from './src/apps/desktop/chatgpt-task-journal-record.ts';
import { readFlatDeepTestRecords } from './src/apps/desktop/legacy-activation-obligations.ts';
const root = ${JSON.stringify(scratch)};
app.setPath('userData', root); app.dock?.hide();
const binding = { buildId:'build', connectorGeneration:'1' };
const desktopGoCore = { backendAvailable:true, currentComputerConnectorBinding: () => binding };
const secureMcpConnectorRuntime = { isRunning: () => true, hasUnresolvedEffect: () => false, getTunnelObservation:()=>null };
const snapshot = { status:'ready', settings:{ setup:{chatgpt:{outcomeUnknown:false},computer:{outcomeUnknown:false}}, computer:{generation:1,pendingEdit:null}, connectors:{secureMcp:{tunnelId:'tunnel',generation:1,runtime:{runtimeGeneration:'runtime'}}}} };
const configuration = {snapshot:()=>snapshot};
let sends=0, observedOverlay='';
const chatGptRoute = {captureManualTaskTarget:()=>()=>true,runReadonlyTask:async(prompt,_attachments,observer)=>{ observedOverlay=shellOverlay; await observer.onDispatchIntent(); assert.equal(observer.beforeSend(),true); sends++; return {state:'completed',code:null,deltaCount:1,observedCharacters:1}; }};
const liveTaskRoutes=new Map(), buildIdentity={buildId:'build'}, liveTaskRegistry={};
let selectedTaskId='', deepTestRecoveryReady=true, recoverableDeepTests=[], quitInProgress=false, installedUpdateAdmission=false, chatGptTaskAdmission=false, connectorTaskAdmission=false, connectorStartInFlight=null, browserHomeSurfaceOpen=true, section='browser', shellOverlay='task-menu', pendingChatGptReadonlyTask=null, pendingChatGptAttachmentTask=null, recoverableChatGptTask=null;
const chatGptConversationAdmissionFailure=()=>null;
const connectorRuntimeUncertain=()=>false, computerConnectorAdmission=()=>({admissible:true}), summaryFenceRecovery={};
const chatGptTaskAdmissionReady=()=>true, currentSurfaceLayout=()=>({pageVisible:shellOverlay==='none'}), currentConnectorAttachment=()=>({challengeSha256:'hash',workspaceId:null}), selectedConnectorApp=()=> 'Farol', connectorAppBindingCurrent=()=>true;
const journalUnderPromotionLease=async(_owner,work)=>work(), configurationFailure=(error)=>({ok:false,error}), ProductConfigurationResultSchema={parse:(v)=>v};
${source.slice(begin, end)}
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(path.join(root,'farol-state'),{mode:0o700});
    ipcMain.on('fixture-layout',()=>setTimeout(()=>{shellOverlay='none'},75));
    ipcMain.handle('fixture-run',(_event,id)=>runManualDeepTest(id,''));
    const win=new BrowserWindow({show:false,focusable:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
    await win.loadURL('data:text/html,<html><body>fixture</body></html>');
    const result=await win.webContents.executeJavaScript(\`(async()=>{const {ipcRenderer}=require('electron');ipcRenderer.send('fixture-layout');return ipcRenderer.invoke('fixture-run',\${JSON.stringify(randomUUID())});})()\`);
    assert.equal(result.ok,true); assert.equal(result.evidence.state,'completed'); assert.equal(observedOverlay,'none'); assert.equal(sends,1);
    assert.equal(win.isVisible(),false); win.destroy(); process.stdout.write('DEEP_TEST_IPC_ORDER_OK\\n'); app.exit(0);
  } catch(e) { console.error(e); app.exit(1); }
});
`,
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  child = spawn(createRequire(import.meta.url)("electron"), [entry], {
    env: {
      HOME: scratch,
      TMPDIR: scratch,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error("DEEP_TEST_IPC_TIMEOUT"));
    }, 20000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(result, 0, output);
  assert.match(output, /DEEP_TEST_IPC_ORDER_OK/u);
  process.stdout.write(
    "PASS: hidden Electron delayed layout IPC, one synthetic send\n",
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await fs.rm(scratch, { recursive: true, force: true });
}
