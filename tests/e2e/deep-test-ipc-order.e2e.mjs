import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { productName } from "../../tooling/harness-identity.ts";

// Hidden disposable Electron; synthetic app and connector. This proves IPC
// scheduling and the real host function, not provider/native/install behavior.
const root = path.resolve(import.meta.dirname, "../..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "farol-deep-ipc-"));
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
import os from 'node:os';
import { desktopStatePaths } from './apps/desktop/host/paths.ts';
import { DesktopAdmission } from './apps/desktop/host/admission.ts';
import { createConfigurationDeep } from './apps/desktop/configuration/deep.ts';
import { fixtureBuildId, guidedSettingsFixture } from './tests/fixtures/guided-onboarding.ts';
const root = ${JSON.stringify(scratch)};
app.setPath('userData', root); app.dock?.hide();
const statePaths = () => desktopStatePaths({ userData: app.getPath('userData'), tmpdir: os.tmpdir() });
const binding = { buildId:fixtureBuildId, connectorGeneration:'1' };
const desktopGoCore = { backendAvailable:true, currentComputerConnectorBinding: () => binding };
const secureMcpConnectorRuntime = { isRunning: () => true, hasUnresolvedEffect: () => false, getTunnelObservation:()=>null };
const snapshot = { status:'ready', settings:guidedSettingsFixture() };
const configuration = {snapshot:()=>snapshot};
let sends=0, observedOverlay='';
const chatGptRoute = {captureManualTaskTarget:()=>()=>true,runReadonlyTask:async(prompt,_attachments,observer)=>{ observedOverlay=shellOverlay; await observer.onDispatchIntent(); assert.equal(observer.beforeSend(),true); assert.equal(observer.manualSubmissionOnly,true); sends++; return {state:'send_requested',code:null,deltaCount:0,observedCharacters:0}; }};
const liveTaskRoutes=new Map(), buildIdentity={buildId:fixtureBuildId};
const liveTaskRegistry={withPromotionLease:async(work)=>({ok:true,value:await work(async()=>{})})};
let selectedTaskId='', deepTestRecoveryReady=true, recoverableDeepTests=[], connectorStartInFlight=null, browserHomeSurfaceOpen=true, section='browser', shellOverlay='task-menu', pendingChatGptReadonlyTask=null, pendingChatGptAttachmentTask=null, recoverableChatGptTask=null;
const desktopAdmission = new DesktopAdmission({
  chatGptReadonlyTask:()=>pendingChatGptReadonlyTask!==null,
  directChatStart:()=>false,
  chatGptAttachmentTask:()=>pendingChatGptAttachmentTask!==null,
  workspaceEdit:()=>false, computer:()=>false, codexAgent:()=>false,
  hostCheck:()=>false, connectorStart:()=>connectorStartInFlight!==null,
});
const chatGptConversationAdmissionFailure=()=>null;
const connectorRuntimeUncertain=()=>false, computerConnectorAdmission=()=>({admissible:true});
const connectorWorkspaceSelection=()=>null;
const currentSurfaceLayout=()=>({pageVisible:shellOverlay==='none'}), currentConnectorAttachment=()=>({challengeSha256:'hash',workspaceId:null}), selectedConnectorApp=()=> ${JSON.stringify(productName)}, connectorAppBindingCurrent=()=>true;
const configurationFailure=(error)=>({ok:false,error});
const { runManualDeepTest } = createConfigurationDeep({
  configuration: () => configuration, desktopGoCore: () => desktopGoCore,
  secureMcpConnectorRuntime: () => secureMcpConnectorRuntime, chatGptRoute: () => chatGptRoute,
  liveTaskRoutes, selectedTaskId: () => selectedTaskId, section: () => section,
  shellOverlay: () => shellOverlay, browserHomeSurfaceOpen: () => browserHomeSurfaceOpen,
  setBrowserHomeSurfaceOpen: (value) => { browserHomeSurfaceOpen = value; },
  deepTestRecoveryReady: () => deepTestRecoveryReady,
  setDeepTestRecoveryReady: (value) => { deepTestRecoveryReady = value; },
  recoverableDeepTests: () => recoverableDeepTests,
  setRecoverableDeepTests: (value) => { recoverableDeepTests = value; },
  pendingChatGptReadonlyTask: () => pendingChatGptReadonlyTask,
  pendingChatGptAttachmentTask: () => pendingChatGptAttachmentTask,
  recoverableChatGptTask: () => recoverableChatGptTask,
  connectorStartInFlight: () => connectorStartInFlight,
  summaryFenceRecovery: () => null,
  desktopAdmission, liveTaskRegistry, buildIdentity, statePaths, configurationFailure,
  chatGptConversationAdmissionFailure, currentSurfaceLayout, connectorRuntimeUncertain,
  computerConnectorAdmission, currentConnectorAttachment, selectedConnectorApp,
  connectorWorkspaceSelection, connectorAppBindingCurrent,
});
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(path.join(root,'farol-state'),{mode:0o700});
    ipcMain.on('fixture-layout',()=>setTimeout(()=>{shellOverlay='none'},75));
    ipcMain.handle('fixture-run',(_event,id)=>runManualDeepTest(id,''));
    const win=new BrowserWindow({show:false,focusable:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
    await win.loadURL('data:text/html,<html><body>fixture</body></html>');
    const result=await win.webContents.executeJavaScript(\`(async()=>{const {ipcRenderer}=require('electron');ipcRenderer.send('fixture-layout');return ipcRenderer.invoke('fixture-run',\${JSON.stringify(randomUUID())});})()\`);
    assert.equal(result.ok,true); assert.equal(result.evidence.state,'send_requested'); assert.equal(observedOverlay,'none'); assert.equal(sends,1);
    assert.equal(desktopAdmission.occupied('chatgpt-task'),false); assert.equal(desktopAdmission.occupied('connector-task'),false); assert.equal(desktopAdmission.closed(),false);
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
