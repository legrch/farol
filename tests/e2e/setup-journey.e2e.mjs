// Built React/Electron/Go with disposable fixtures. No real account or tunnel.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { _electron } from "playwright-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { desktopIdentity } from "../../tooling/harness-identity.ts";
import {
  assertRuntimeObservation,
  observeElectronRuntime,
} from "../../tooling/runtime-contract.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
import {
  waitForReactShell,
  openSetup,
  setupStep,
  connectMac,
  readSetupSettings,
} from "./current-react-setup.mjs";
import {
  startChatGptFixture,
  stopChatGptFixture,
} from "./fixtures/chatgpt-site.mjs";
import {
  beginQuitObservation,
  readQuitObservation,
  assertFreshQuit,
} from "./lib/native-quit-observation.mjs";
import {
  assertNativePreviewAdmission,
  refreshNativePreviewIsolation,
} from "./native-preview-admission.mjs";

assert.equal(process.argv.length, 2, "SETUP_JOURNEY_ARGUMENTS_INVALID");
const root = process.cwd();
const source = sourceIdentity(root);
const buildRoot = path.join(root, "_output/build/app");
const build = await qualifyGoBuild(buildRoot, source);
const runtimeRoot = await fs.realpath(
  process.env.FAROL_RENDERER_TEST_ELECTRON_ROOT ??
    path.join(root, "node_modules/electron"),
);
const runtime = await observeElectronRuntime(runtimeRoot);
assertRuntimeObservation(runtime);
const executablePath = path.join(
  runtimeRoot,
  "dist/Electron.app/Contents/MacOS/Electron",
);
const id = randomUUID();
const output = path.join(root, "_output/evidence/setup-journey", id);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const home = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-e2e-home-")),
);
await fs.chmod(home, 0o700);
const proof = randomUUID();
await fs.writeFile(path.join(home, ".farol-e2e-root"), proof, { mode: 0o600 });
const auxiliary = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-guided-setup-")),
);
await fs.chmod(auxiliary, 0o700);
await fs.writeFile(path.join(auxiliary, ".farol-e2e-root"), proof, {
  mode: 0o600,
});
const appData = path.join(home, "app-data");
const workspace = path.join(auxiliary, "workspace");
await fs.mkdir(appData, { mode: 0o700 });
await fs.mkdir(workspace, { mode: 0o700 });
const tunnel = path.join(auxiliary, "tunnel-client.cjs");
await fs.writeFile(
  tunnel,
  `#!${process.execPath}\n${await fs.readFile(new URL("./tunnel-client.fixture.cjs", import.meta.url), "utf8")}`,
  { mode: 0o700 },
);
const report = {
  schema: 1,
  id,
  status: "running",
  source,
  buildId: build.identity.buildId,
  runtime,
  home,
  mode: "hidden",
  liveProvider: "NOT RUN",
  installed: "NOT RUN",
  steps: {
    signin: "NOT RUN",
    folders: "NOT RUN",
    connection: "NOT RUN",
    attachment: "NOT RUN",
  },
  negativeCases: "NOT RUN",
  cleanup: "pending",
  limits: [
    "Synthetic external provider/tunnel; actual local Go MCP receipt and production UI callbacks",
    "No real OAuth, MFA, live app, installed product or generic descendant proof",
  ],
};
const save = () =>
  fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
await save();
let application,
  page,
  fixture,
  terminal,
  closed,
  userData,
  admission,
  quitAttempted = false;
let sendCount = 0;
const peers = [];
const hash = (x) => createHash("sha256").update(x).digest("hex");
async function bounded(promise, label, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function poll(read, accept, label, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function verify(prompt) {
  sendCount++;
  assert.equal(sendCount, 1, "SETUP_SEND_REPLAYED");
  const current = await readSetupSettings(page);
  const c = current.connectors.secureMcp;
  const challenge = c.challenge;
  assert.ok(
    challenge && current.setup.computer.verified,
    "SETUP_NO_FRESH_CHALLENGE",
  );
  const workspaceId = current.setup.computer.verified.workspaceId;
  assert.equal(
    prompt,
    `Use the selected Farol Dev app to call farol_connector_verify once with challenge "${challenge.value}" and workspaceId "${workspaceId}". Do not read file contents. Reply briefly with the result.`,
  );
  const connectorRoot = path.join(userData, "farol-state/secure-mcp-connector");
  const args = JSON.parse(
    await fs.readFile(
      path.join(connectorRoot, "state/farol-e2e-tunnel-init.json"),
      "utf8",
    ),
  );
  assert.ok(Array.isArray(args) && args.every((v) => typeof v === "string"));
  assert.equal(args.filter((v) => v === "--mcp-command").length, 1);
  const match =
    /'--launch-contract' '(\/private\/tmp\/farol-mcp-[A-Za-z0-9-]+\/computer-go-launch\.json)'$/u.exec(
      args[args.indexOf("--mcp-command") + 1],
    );
  assert.ok(match, "SETUP_GO_LAUNCH_UNRECOGNIZED");
  const launchFile = await fs.realpath(match[1]);
  assert.equal(launchFile, match[1]);
  const launch = JSON.parse(await fs.readFile(launchFile, "utf8"));
  assert.equal(launch.schema, "farol-go-connector/1");
  assert.equal(
    launch.lifecycleRoot,
    await fs.realpath(path.join(connectorRoot, "computer-authority")),
  );
  assert.equal(launch.opened.endpoint.binding.buildId, build.identity.buildId);
  assert.equal(launch.challengeSha256, hash(challenge.value));
  const transport = new StdioClientTransport({
    command: executablePath,
    args: [
      path.join(buildRoot, "computer-mcp.cjs"),
      "--launch-contract",
      launchFile,
    ],
    cwd: root,
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: os.tmpdir(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "setup-journey-fixture",
    version: "1.0.0",
  });
  const peer = { client, transport, closeAttempted: false };
  peers.push(peer);
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const pending = start();
    peer.child = transport._process;
    assert.ok(peer.child && peer.child.pid === transport.pid);
    peer.terminal = once(peer.child, "exit");
    await pending;
  };
  try {
    await bounded(client.connect(transport), "SETUP_MCP_CONNECT_TIMEOUT");
    const result = await bounded(
      client.callTool({
        name: "farol_connector_verify",
        arguments: { challenge: challenge.value, workspaceId },
      }),
      "SETUP_MCP_VERIFY_TIMEOUT",
    );
    assert.equal(result.isError ?? false, false);
    const value = result.structuredContent;
    assert.equal(value?.status, "ok");
    assert.deepEqual(value.data.binding, launch.opened.endpoint.binding);
    assert.deepEqual(value.data.receipt.execution, launch.opened.execution);
    assert.equal(value.data.receipt.workspaceId, workspaceId);
    assert.equal(value.data.receipt.challengeSha256, launch.challengeSha256);
    assert.equal(
      value.data.receiptSha256,
      hash(JSON.stringify(value.data.receipt)),
    );
    report.receipt = {
      workspaceId,
      challengeSha256: launch.challengeSha256,
      receiptSha256: value.data.receiptSha256,
      buildId: build.identity.buildId,
    };
    await save();
  } finally {
    await closePeer(peer);
  }
}
async function closePeer(peer) {
  if (peer.closeAttempted) return;
  peer.closeAttempted = true;
  await bounded(peer.client.close(), "SETUP_MCP_CLOSE_TIMEOUT");
  if (peer.child) {
    if (peer.child.exitCode === null && peer.child.signalCode === null)
      await bounded(peer.terminal, "SETUP_MCP_TERMINAL_TIMEOUT");
    assert.equal(peer.child.exitCode, 0);
    assert.equal(peer.child.signalCode, null);
  }
}
async function quit() {
  assert.equal(quitAttempted, false);
  admission = await refreshNativePreviewIsolation(admission, application);
  quitAttempted = true;
  const stateRoot = path.join(userData, "farol-state");
  const before = await readQuitObservation(stateRoot);
  const request = beginQuitObservation(before, report.pid);
  await bounded(application.close(), "SETUP_QUIT_TIMEOUT");
  const [code, signal] = await bounded(terminal, "SETUP_TERMINAL_TIMEOUT");
  await bounded(closed, "SETUP_CLOSE_TIMEOUT");
  report.terminal = { pid: report.pid, code, signal };
  assert.equal(code, 0);
  assert.equal(signal, null);
  report.quit = assertFreshQuit(
    request,
    await readQuitObservation(stateRoot),
    report.terminal,
  );
  await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
    code: "ENOENT",
  });
  application = null;
  report.cleanup = "confirmed";
  await save();
}
try {
  fixture = await startChatGptFixture({
    setupVerification: { appName: "Farol Dev", verify },
  });
  const launchOptions = {
    executablePath,
    args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    env: {
      FAROL_E2E: "1",
      FAROL_E2E_APP_DATA: appData,
      FAROL_E2E_TEST_ROOT: home,
      FAROL_E2E_TEST_PROOF: proof,
      FAROL_E2E_CHATGPT_URL: fixture.url,
      FAROL_E2E_WORKSPACE_ROOT: workspace,
      FAROL_E2E_TUNNEL_CLIENT: tunnel,
      FAROL_ENVIRONMENT: "dev",
      HOME: home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      TMPDIR: os.tmpdir(),
    },
    timeout: 20000,
  };
  userData = desktopIdentity("dev", appData).userData;
  await fs.mkdir(userData, { mode: 0o700 });
  admission = await assertNativePreviewAdmission(
    path.join(root, "_output/unused-owner-preview-state"),
    {
      profileRoot: home,
      proof,
      launchOptions,
      fixture: fixture.server,
      auxiliaryRoot: auxiliary,
    },
  );
  application = await _electron.launch(launchOptions);
  report.pid = application.process().pid;
  terminal = once(application.process(), "exit");
  closed = once(application.process(), "close");
  page = await application.firstWindow();
  await waitForReactShell(page);
  const paths = await application.evaluate(({ app, BrowserWindow }) => ({
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    windows: BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      focused: w.isFocused(),
    })),
  }));
  userData = paths.userData;
  assert.equal(userData, desktopIdentity("dev", appData).userData);
  assert.equal(paths.sessionData, userData);
  assert.ok(paths.windows.every((w) => !w.visible && !w.focused));
  let settings = await readSetupSettings(page);
  assert.equal(settings.computer.workspaces.length, 0);
  assert.equal(settings.connectors.secureMcp.credential, "missing");
  assert.equal(settings.setup.journey.dismissed, false);
  report.currentStep = "signin";
  await openSetup(page);
  await setupStep(page, "signin");
  await page.getByRole("button", { name: /^(Sign in|Open ChatGPT)$/ }).click();
  await page.locator(".sign-in-context").waitFor();
  const browserId = await poll(
    () =>
      application.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .filter((w) => !w.isDestroyed() && w.getURL() === url)
            .map((w) => w.id),
        fixture.url,
      ),
    (v) => v.length === 1,
    "SETUP_BROWSER_UNCONFIRMED",
  );
  await application.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)
        .executeJavaScript(
          `document.querySelector('[data-testid="login-button"]').click()`,
        ),
    browserId[0],
  );
  await page
    .getByRole("button", { name: "Back to setup", exact: true })
    .click();
  await poll(
    () => readSetupSettings(page),
    (v) => v.setup.chatgpt.reachable === "reachable",
    "SETUP_SIGNIN_NOT_CONFIRMED",
  );
  report.steps.signin = "PASS";
  await save();
  report.currentStep = "folders";
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Add workspace", exact: true })
    .click();
  await page.getByText("✓ Works", { exact: true }).waitFor();
  settings = await readSetupSettings(page);
  assert.equal(settings.computer.workspaces.length, 1);
  assert.equal(settings.computer.workspaces[0].root, workspace);
  report.steps.folders = "PASS";
  report.currentStep = "connection";
  await save();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByLabel("Tunnel ID", { exact: true })
    .fill("tunnel_farol_setup_fixture");
  await page
    .getByLabel("Key", { exact: true })
    .fill("farol-e2e-runtime-key-0002");
  await connectMac(page);
  report.steps.connection = "PASS";
  report.currentStep = "attachment";
  await save();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("textbox", { name: "ChatGPT app name" })
    .fill("Farol Dev");
  await page.getByRole("textbox", { name: "ChatGPT app name" }).blur();
  await poll(
    () => readSetupSettings(page),
    (v) => v.connectors.secureMcp.chatgptApp?.name === "Farol Dev",
    "SETUP_APP_NAME_NOT_SAVED",
  );
  const finish = page.getByRole("button", {
    name: "Start using Farol",
    exact: true,
  });
  assert.equal(await finish.isEnabled(), false);
  await page
    .getByRole("button", { name: "Test in ChatGPT", exact: true })
    .click();
  await poll(
    () => readSetupSettings(page),
    (v) => v.connectors.secureMcp.attachment !== null,
    "SETUP_MATCHING_RECEIPT_NOT_CONFIRMED",
    30000,
  );
  await page
    .getByRole("button", { name: "Back to setup", exact: true })
    .click();
  await page.getByText("✓ Everything works", { exact: true }).waitFor();
  assert.equal(sendCount, 1);
  assert.equal(await finish.isEnabled(), true);
  report.steps.attachment = "PASS";
  await finish.click();
  await poll(
    () => readSetupSettings(page),
    (v) => v.setup.journey.dismissed === true,
    "SETUP_FINISH_NOT_SAVED",
  );
  assert.equal(
    await page
      .locator('.rail [aria-label="Home"]')
      .getAttribute("aria-current"),
    "page",
  );
  report.finalState = "Home";
  report.sendCount = sendCount;
  await save();
  await quit();
  report.status = "passed-fixture-setup";
} catch (error) {
  report.status = "failed";
  report.error = /^[A-Z0-9_:.-]{1,100}$/u.test(error?.message ?? "")
    ? error.message
    : "SETUP_JOURNEY_FAILED";
  process.exitCode = 1;
} finally {
  for (const peer of peers) {
    try {
      await closePeer(peer);
    } catch {
      report.cleanup = "retained";
      process.exitCode = 1;
    }
  }
  if (application && !quitAttempted && userData) {
    try {
      await quit();
    } catch {
      report.cleanup = "retained";
      process.exitCode = 1;
    }
  }
  await stopChatGptFixture(fixture);
  await save();
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      report: path.join(output, "report.json"),
      error: report.error,
    }) + "\n",
  );
}
