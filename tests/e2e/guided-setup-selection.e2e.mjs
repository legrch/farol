// Owned hidden Electron windows and disposable state only. This proves Setup
// selection and IPC/UI integration, never external ChatGPT or live attachment.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { assertBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  assertNativePreviewAdmission,
  recheckNativePreviewIsolation,
  readOwnedStartupMarker,
} from "./native-preview-admission.mjs";

import { waitForOwnedSecondary } from "./owned-background-secondary.mjs";
import {
  waitForReactShell,
  openSetup,
  setupStep,
  readSetupSettings,
  setupAction,
  assertSetupOverview,
  reviewSetupWithoutChanges,
} from "./current-react-setup.mjs";

const uncheckedOverview = {
  ready: false,
  states: {
    signin: "needed",
    folders: "needed",
    connection: "needed",
    attachment: "needed",
  },
};
const workspaceOverview = {
  ...uncheckedOverview,
  states: { ...uncheckedOverview.states, folders: "verified" },
};
const connectedOverview = {
  ...workspaceOverview,
  states: { ...workspaceOverview.states, connection: "verified" },
};
const readyOverview = {
  ready: true,
  states: { ...connectedOverview.states, attachment: "verified" },
};

const packaged = process.argv.includes("--packaged");
const devOnly = process.argv.includes("--dev-only");
const behavior = process.argv.includes("--behavior");
const resumeRefusal = process.argv.includes("--resume-refusal");
assert.deepEqual(process.argv.slice(2), [
  ...(packaged ? ["--packaged"] : devOnly ? ["--dev-only"] : []),
  ...(behavior ? ["--behavior"] : []),
  ...(resumeRefusal ? ["--resume-refusal"] : []),
]);
assert.ok(!resumeRefusal || (packaged && behavior));
assert.ok(!(behavior && devOnly));
const root = process.cwd();
const appRoot = path.join(root, "_output/package/Farol.app");
const executable = packaged
  ? path.join(
      appRoot,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    )
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const entry = packaged
  ? path.join(appRoot, "Contents/Resources/app/main.cjs")
  : path.join(root, "_output/build/app/main.cjs");
// The behavior journey must exercise the accepted source, never retained bytes
// from an earlier package. Admission below still owns native/profile isolation.
let behaviorBuild;
if (behavior) {
  const source = sourceIdentity(root, ".");
  assert.equal(source.dirty, false, "GUIDED_BEHAVIOR_SOURCE_NOT_EXACT");
  behaviorBuild = assertBuildIdentity(
    JSON.parse(
      await fs.readFile(
        path.join(path.dirname(entry), "build-identity.json"),
        "utf8",
      ),
    ),
  );
  assert.equal(behaviorBuild.sourceDirty, false);
  assert.equal(behaviorBuild.sourceCommit, source.commit);
  assert.equal(behaviorBuild.sourceTreeDigest, source.treeDigest);
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(entry), "build-manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.schema, 4, "GUIDED_BEHAVIOR_GO_BUILD_REQUIRED");
  assert.equal(manifest.inputExact, true, "GUIDED_BEHAVIOR_GO_INPUTS_REQUIRED");
  assert.equal(manifest.core?.build.buildId, behaviorBuild.buildId);
  assert.equal(manifest.core?.build.sourceSHA, source.commit);
}
const temporaryRoot = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-guided-setup-")),
);
const proof = randomUUID();
await fs.writeFile(path.join(temporaryRoot, ".farol-next-e2e-root"), proof, {
  mode: 0o600,
});
const workspace = path.join(temporaryRoot, "approved-folder");
await fs.mkdir(workspace, { mode: 0o700 });
const observations = [];
let nonReadRequests = 0;
let fixtureVerifications = 0;
let activeFixtureProfile;
let activeFixtureLaunch;
const backgroundChildren = [];
const mcpChildren = [];
const tunnelFixture = path.join(temporaryRoot, "tunnel-client.cjs");
await fs.writeFile(
  tunnelFixture,
  `#!${process.execPath}\n${await fs.readFile(new URL("./tunnel-client.fixture.cjs", import.meta.url), "utf8")}`,
  { mode: 0o700 },
);
async function fixtureVerification(challenge, settings) {
  assert.match(challenge.value, /^[a-z0-9][a-z0-9-]*$/u);
  assert.ok(challenge.workspaceId);
  fixtureVerifications += 1;
  assert.ok(activeFixtureProfile, "FIXTURE_PROFILE_UNCONFIRMED");
  // The active Go launch lives beside its owned socket, not at the removed
  // legacy computer-launch.json path. Read exactly the command our disposable
  // tunnel-client init recorded; never scan host sockets or evaluate shell text.
  const connectorRoot = path.join(
    activeFixtureProfile.userData,
    "farol-next-state/secure-mcp-connector",
  );
  const initArguments = JSON.parse(
    await fs.readFile(
      path.join(connectorRoot, "state/farol-e2e-tunnel-init.json"),
      "utf8",
    ),
  );
  assert.ok(
    Array.isArray(initArguments) &&
      initArguments.every((value) => typeof value === "string"),
  );
  assert.equal(
    initArguments.filter((value) => value === "--mcp-command").length,
    1,
  );
  const command = initArguments[initArguments.indexOf("--mcp-command") + 1];
  const selected =
    /'--launch-contract' '(\/private\/tmp\/farol-mcp-[A-Za-z0-9-]+\/computer-go-launch\.json)'$/u.exec(
      command,
    );
  assert.ok(selected, "FIXTURE_GO_LAUNCH_NOT_SELECTED");
  const launchFile = await fs.realpath(selected[1]);
  assert.equal(launchFile, selected[1]);
  const launch = JSON.parse(await fs.readFile(launchFile, "utf8"));
  assert.equal(launch.schema, "farol-go-connector/1");
  assert.equal(
    launch.lifecycleRoot,
    await fs.realpath(path.join(connectorRoot, "computer-authority")),
  );
  assert.equal(
    launch.opened.endpoint.socketPath,
    path.join(path.dirname(launchFile), "computer.sock"),
  );
  assert.equal(
    launch.challengeSha256,
    createHash("sha256").update(challenge.value).digest("hex"),
  );
  assert.equal(
    launch.opened.endpoint.binding.buildId,
    settings.connectors.secureMcp.runtime.buildId,
  );
  assert.equal(
    launch.opened.endpoint.binding.connectorGeneration,
    String(settings.connectors.secureMcp.generation),
  );
  const transport = new StdioClientTransport({
    command: executable,
    args: [
      path.join(path.dirname(entry), "computer-mcp.cjs"),
      "--launch-contract",
      launchFile,
    ],
    cwd: root,
    env: {
      HOME: activeFixtureProfile.home,
      TMPDIR: os.tmpdir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "owned-external-setup-fixture",
    version: "1.0.0",
  });
  const start = transport.start.bind(transport);
  let owned;
  transport.start = async () => {
    const started = start();
    // Only the SDK child created by this disposable fixture. Keep its actual
    // terminal event independently of SDK close's bounded signal attempts.
    const child = transport._process;
    assert.ok(child && child.pid === transport.pid);
    owned = { child, terminal: once(child, "exit") };
    mcpChildren.push(owned);
    await started;
  };
  try {
    await bounded(client.connect(transport), "FIXTURE_MCP_CONNECT_TIMEOUT");
    const result = await bounded(
      client.callTool({
        name: "farol_next_connector_verify",
        arguments: {
          challenge: challenge.value,
          workspaceId: challenge.workspaceId,
        },
      }),
      "FIXTURE_MCP_VERIFY_TIMEOUT",
    );
    assert.equal(result.isError ?? false, false, JSON.stringify(result));
    const verified = result.structuredContent;
    assert.equal(verified?.status, "ok", JSON.stringify(result));
    assert.equal(verified.data.receipt.workspaceId, challenge.workspaceId);
    assert.equal(verified.data.receipt.challengeSha256, launch.challengeSha256);
    assert.deepEqual(verified.data.binding, launch.opened.endpoint.binding);
    assert.deepEqual(verified.data.receipt.execution, launch.opened.execution);
    assert.equal(
      verified.data.receiptSha256,
      createHash("sha256")
        .update(JSON.stringify(verified.data.receipt))
        .digest("hex"),
    );
    observations.push({
      kind: "owned-mcp-fixture-verification",
      fixtureVerifications,
    });
  } finally {
    const failures = [];
    try {
      await bounded(client.close(), "FIXTURE_MCP_CLOSE_TIMEOUT");
    } catch (error) {
      failures.push(error);
    }
    if (owned) {
      try {
        if (owned.child.exitCode === null && owned.child.signalCode === null)
          await bounded(owned.terminal, "FIXTURE_MCP_EXIT_TIMEOUT");
        observations.push({
          kind: "owned-mcp-terminal",
          pid: owned.child.pid,
          exit: owned.child.exitCode,
          signal: owned.child.signalCode,
        });
        owned.observed = true;
        assert.equal(owned.child.exitCode, 0);
        assert.equal(owned.child.signalCode, null);
      } catch (error) {
        if (owned.child.exitCode === null && owned.child.signalCode === null) {
          cleanupUnknown = true;
          observations.push({
            kind: "owned-mcp-cleanup-unknown",
            pid: owned.child.pid,
          });
        }
        failures.push(error);
      }
    }
    // A receipt is not cleanup proof. Preserve close failure separately even
    // when the exact same owned child later has a known terminal result.
    cleanupFailures.push(...failures);
    if (failures.length)
      throw new AggregateError(failures, "FIXTURE_MCP_CLEANUP_FAILED");
  }
}
// The browser document remains local and read-only. External attachment is
// simulated only by the owned MCP peer, never by a reply or production seam.
const chatFixture = createServer((request, response) => {
  if (request.method !== "GET") {
    nonReadRequests += 1;
    response.writeHead(405).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><html><head><title>Local Browser fixture</title></head><body><h1>Local Browser fixture</h1><textarea id="prompt-textarea" aria-label="Fixture composer"></textarea></body></html>',
  );
});
await bounded(
  new Promise((resolve) => chatFixture.listen(0, "127.0.0.1", resolve)),
  "BROWSER_FIXTURE_LISTEN_TIMEOUT",
);
const chatAddress = chatFixture.address();
assert.ok(chatAddress && typeof chatAddress !== "string");
const fixtureUrl = `http://127.0.0.1:${chatAddress.port}/`;
const ownerPreviewStateRoot = path.join(
  os.homedir(),
  "Library/Application Support/Farol Next Preview/farol-next-state",
);
const profiles = new Map();
const profileAdmissions = new Map();
let primaryFailure;
const cleanupFailures = [];
let cleanupUnknown = false;
let electronCleanupUnknown = false;
let application;
let profileIsolationConfirmed = false;
let pendingLaunch;
let closingLateLaunch = false;
const childRecords = new Map();

async function bounded(promise, label, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeOwned() {
  if (!application) return;
  const owned = application;
  const child = owned.process();
  const terminal =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "exit");
  try {
    await bounded(owned.close(), "GUIDED_SETUP_CLOSE_TIMEOUT");
    await bounded(terminal, "GUIDED_SETUP_EXIT_TIMEOUT");
  } catch (error) {
    // Observe the SAME pending child exit after a close timeout, never close
    // or signal again. An unknown child stays held and prohibits another launch.
    try {
      await bounded(terminal, "GUIDED_SETUP_EXIT_RECONCILE_TIMEOUT");
    } catch {
      cleanupUnknown = true;
      electronCleanupUnknown = true;
      observations.push({
        kind: "cleanup-unknown",
        pid: child.pid,
        ...childRecords.get(child.pid),
      });
      throw error;
    }
    application = undefined;
    observations.push({
      kind: "owned-process-terminal-after-close-error",
      pid: child.pid,
      exit: child.exitCode,
      signal: child.signalCode,
      ...childRecords.get(child.pid),
    });
    throw error;
  }
  // A terminal nonzero/signal result is known, not an invitation to close again.
  application = undefined;
  observations.push({
    kind: "owned-process-terminal",
    pid: child.pid,
    exit: child.exitCode,
    signal: child.signalCode,
    ...childRecords.get(child.pid),
  });
  assert.equal(child.signalCode, null);
  assert.equal(child.exitCode, 0);
}

async function waitForResumeStage(expected) {
  const file = path.join(
    activeFixtureProfile.home,
    ".farol-next-connector-resume-stage",
  );
  const deadline = Date.now() + 15000;
  for (;;) {
    const stage = (
      await fs.readFile(file, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      })
    ).trim();
    if (stage) {
      assert.equal(stage, expected, "CONNECTOR_RESUME_STAGE_UNEXPECTED");
      return;
    }
    if (Date.now() >= deadline)
      throw new Error("CONNECTOR_RESUME_STAGE_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function verifyDisplayedAttachment(window) {
  await setupStep(window, "attachment", "Add to ChatGPT");
  const card = window.locator(
    '.setup-page [data-connector-challenge="pending"]',
  );
  await card.waitFor({ state: "visible" });
  const displayed = await card.evaluate((node) =>
    Object.fromEntries(
      [...node.querySelectorAll("dl > div")].map((row) => [
        row.querySelector("dt").textContent,
        row.querySelector("dd code").textContent,
      ]),
    ),
  );
  const before = await readSetupSettings(window);
  assert.equal(before.connectors.secureMcp.attachment, null);
  assert.equal(before.setup.connect.verified, null);
  assert.equal(
    displayed.challenge,
    before.connectors.secureMcp.challenge.value,
  );
  assert.equal(
    displayed.workspaceId,
    before.setup.computer.verified.workspaceId,
  );
  await fixtureVerification(
    { value: displayed.challenge, workspaceId: displayed.workspaceId },
    before,
  );
  // A local peer's receipt is not the app's verdict or external ChatGPT proof.
  assert.equal(
    (await readSetupSettings(window)).connectors.secureMcp.attachment,
    null,
  );
  await setupAction(window, "Check attachment");
  await window
    .locator('.setup-page [role="status"]')
    .filter({ hasText: "Attachment checked · Computer ready" })
    .waitFor();
  return before.connectors.secureMcp.challenge;
}

async function launch(environment, mode = "normal", profile = mode) {
  assert.equal(
    cleanupUnknown,
    false,
    "GUIDED_SETUP_PRIOR_RESOURCE_CLEANUP_UNKNOWN",
  );
  assert.equal(
    application,
    undefined,
    "GUIDED_SETUP_PRIOR_INSTANCE_NOT_CLOSED",
  );
  profileIsolationConfirmed = false;
  let profileRoot = profiles.get(profile);
  const freshProfile = !profileRoot;
  if (!profileRoot) {
    profileRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-e2e-home-")),
    );
    await fs.writeFile(path.join(profileRoot, ".farol-next-e2e-root"), proof, {
      mode: 0o600,
    });
    profiles.set(profile, profileRoot);
  }
  // The existing startup receipt contract requires a direct OS-temp test HOME.
  const home = profileRoot;
  const appData = path.join(profileRoot, "app-data");
  const normalPackagedProfile = packaged && mode === "normal-profile";
  const userData =
    environment === "dev"
      ? path.join(appData, "Farol Dev")
      : normalPackagedProfile
        ? path.join(appData, "Farol Next Preview")
        : path.join(profileRoot, "user-data");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(appData, { recursive: true, mode: 0o700 });
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  const startupMarker = path.join(home, ".farol-next-startup-stage");
  await fs.rm(startupMarker, { force: true });
  await fs.rm(path.join(home, ".farol-next-connector-resume-stage"), {
    force: true,
  });
  const launchOptions = {
    executablePath: normalPackagedProfile
      ? path.join(appRoot, "Contents/MacOS/Farol Next Preview")
      : executable,
    args: [
      ...(normalPackagedProfile ? [] : [entry, `--user-data-dir=${userData}`]),
      "--preview-window-mode=hidden",
    ],
    env: {
      HOME: home,
      TMPDIR: os.tmpdir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      ...(environment === "dev" ? { FAROL_NEXT_ENVIRONMENT: "dev" } : {}),
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_TEST_ROOT: profileRoot,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
      FAROL_NEXT_E2E_WORKSPACE_ROOT: workspace,
      FAROL_NEXT_E2E_CHATGPT_URL: fixtureUrl,
      ...(behavior ? { FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelFixture } : {}),
    },
    timeout: 15000,
  };
  const admission = await assertNativePreviewAdmission(ownerPreviewStateRoot, {
    profileRoot,
    proof,
    launchOptions,
    fixture: chatFixture,
    auxiliaryRoot: temporaryRoot,
    previous: profileAdmissions.get(profileRoot),
  });
  observations.push(admission);
  const pending = electron.launch(launchOptions);
  // A late launch stays owned and is closed; never start another on top of it.
  closingLateLaunch = false;
  pendingLaunch = pending.then(async (value) => {
    application = value;
    const child = value.process();
    const record = { stdout: "", stderr: "" };
    childRecords.set(child.pid, record);
    for (const stream of ["stdout", "stderr"]) {
      child[stream]?.on("data", (chunk) => {
        record[stream] = (record[stream] + chunk.toString("utf8")).slice(
          -32768,
        );
      });
    }
    child.once("exit", (exit, signal) => {
      observations.push({
        kind: "native-exit-observed",
        at: new Date().toISOString(),
        pid: child.pid,
        exit,
        signal,
        ...record,
      });
    });
    if (closingLateLaunch) await closeOwned();
    return value;
  });
  application = await bounded(pendingLaunch, "GUIDED_SETUP_LAUNCH_TIMEOUT");
  const window = await bounded(
    application.firstWindow(),
    "GUIDED_SETUP_WINDOW_TIMEOUT",
    30000,
  );
  // Prove selected native paths before touching UI. HOME alone does not
  // select Electron's profile; both environments require the private proof.
  const nativePaths = await application.evaluate(({ app, BrowserWindow }) => ({
    pid: process.pid,
    home: app.getPath("home"),
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    temp: app.getPath("temp"),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
    })),
  }));
  // Metadata only, before admission: retain the exact OS path boundary on
  // refusal without inspecting UI, settings or unqualified profile bytes.
  observations.push({
    kind: "native-profile-path-readback",
    environment,
    profileRoot,
    nativePaths,
  });
  profileAdmissions.set(
    profileRoot,
    await recheckNativePreviewIsolation(
      admission,
      nativePaths,
      application.process(),
    ),
  );
  profileIsolationConfirmed = true;
  activeFixtureLaunch = launchOptions;
  activeFixtureProfile = { home, userData: nativePaths.userData };
  observations.push({
    kind: "native-profile-isolation",
    environment,
    profileRoot,
    nativePaths,
  });
  await bounded(waitForReactShell(window), "GUIDED_SETUP_REACT_SHELL_TIMEOUT");
  const child = application.process();
  const startupDeadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("GUIDED_SETUP_EXIT_BEFORE_STARTUP_COMPLETE");
    const stage = await fs.readFile(startupMarker, "utf8").catch(() => "");
    if (stage.trim() === "startup-complete") break;
    if (Date.now() >= startupDeadline)
      throw new Error("GUIDED_SETUP_STARTUP_COMPLETE_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  observations.push({ kind: "startup-complete", pid: child.pid, environment });
  const ownedStateRoot = path.join(nativePaths.userData, "farol-next-state");
  const runMarker = await readOwnedStartupMarker(
    ownedStateRoot,
    profileRoot,
    child.pid,
  );
  observations.push({
    kind: "owned-startup-marker",
    stateRoot: ownedStateRoot,
    ...runMarker,
  });
  await application.evaluate(({ app }) => {
    app.on("before-quit", () => {
      process.stderr.write(
        `FAROL_E2E_OWNED_BEFORE_QUIT:${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, userData: app.getPath("userData") })}\n`,
      );
    });
  });
  const bootstrap = await window.evaluate(() => window.farolNext.bootstrap());
  if (behavior)
    assert.deepEqual(
      bootstrap.build,
      behaviorBuild,
      "GUIDED_BEHAVIOR_BUILD_CHANGED",
    );
  assert.equal(bootstrap.environment, environment);
  assert.equal(bootstrap.legacySetupTestMode, false);
  if (freshProfile && mode === "normal")
    assert.equal(
      bootstrap.configuration.settings.computer.workspaces.length,
      0,
      "GUIDED_SETUP_PROFILE_NOT_EMPTY",
    );
  const windows = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
    })),
  );
  assert.ok(windows.every((window) => !window.visible && !window.focused));
  observations.push({
    kind: "setup-selection",
    environment,
    mode,
    sourceCommit: bootstrap.build.sourceCommit,
    buildId: bootstrap.build.buildId,
    sourceDirty: bootstrap.build.sourceDirty,
    windows,
  });
  return window;
}

async function checkBackgroundSecondary() {
  assert.ok(application && profileIsolationConfirmed && activeFixtureLaunch);
  const primaryPid = application.process().pid;
  const child = spawn(
    activeFixtureLaunch.executablePath,
    [...activeFixtureLaunch.args, "--owner-background-only"],
    {
      cwd: root,
      env: activeFixtureLaunch.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-32768);
  });
  child.stdout.resume();
  const owned = { child, observed: false };
  backgroundChildren.push(owned);
  const result = await waitForOwnedSecondary(child, {
    onObservation: (observation) => {
      if (observation.kind === "background-secondary-terminal")
        owned.observed = true;
      observations.push(observation);
    },
  });
  if (!result.terminal) cleanupUnknown = true;
  if (result.stopError) cleanupFailures.push(new Error(result.stopError));
  assert.equal(result.terminal, true, "BACKGROUND_SECONDARY_CLEANUP_UNKNOWN");
  assert.equal(result.timedOut, false, "BACKGROUND_SECONDARY_EXIT_TIMEOUT");
  assert.equal(result.exit, 0);
  assert.equal(result.signal, null);
  assert.match(
    stderr,
    /refused the background launch because this exact candidate is already running/u,
  );
  assert.match(stderr, /FAROL_NEXT_SECOND_INSTANCE_RESULT:reopen-failed/u);
  assert.doesNotMatch(stderr, /FAROL_NEXT_SECOND_INSTANCE_RESULT:reopened/u);
  assert.equal(application.process().pid, primaryPid);
  const windows = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
    })),
  );
  assert.ok(windows.length > 0);
  assert.ok(windows.every((window) => !window.visible && !window.focused));
  observations.push({
    kind: "background-second-launch-refused-without-reopen",
    primaryPid,
    secondaryPid: child.pid,
    hidden: true,
    focused: false,
  });
}

try {
  if (packaged) {
    await launch("preview", "normal-profile");
    const identity = await application.evaluate(({ app }) => ({
      name: app.getName(),
      isPackaged: app.isPackaged,
      userData: app.getPath("userData"),
      sessionData: app.getPath("sessionData"),
      userDataOverride: app.commandLine.hasSwitch("user-data-dir"),
    }));
    assert.equal(identity.name, "Farol");
    assert.equal(identity.isPackaged, true);
    assert.equal(identity.userDataOverride, false);
    assert.equal(identity.userData, activeFixtureProfile.userData);
    assert.equal(identity.sessionData, identity.userData);
    assert.equal(path.basename(identity.userData), "Farol Next Preview");
    observations.push({
      kind: "packaged-normal-profile-without-user-data-override",
      ...identity,
    });
    await closeOwned();
  }
  for (const environment of behavior
    ? ["preview"]
    : packaged
      ? ["preview"]
      : devOnly
        ? ["dev"]
        : ["preview", "dev"]) {
    let window = await launch(environment, "normal", environment);
    if (packaged && behavior) await checkBackgroundSecondary();
    await openSetup(window);
    await setupStep(window, "connection", "Connection");
    await window.locator('.setup-page[data-setup-step="connection"]').waitFor();
    if (behavior) {
      // Explicit discovery selects only this run's disposable fixture through
      // the owned E2E seam. Save & connect retains its known refused
      // connection stage before workspace approval; it is not readiness proof.
      await window
        .locator(".setup-page")
        .getByRole("button", { name: "Find connection helper", exact: true })
        .click();
      const discoveryDeadline = Date.now() + 15000;
      for (;;) {
        const result = await window.evaluate(() =>
          window.farolNext.bootstrap(),
        );
        if (
          result.configuration.status === "ready" &&
          result.configuration.settings.connectors.secureMcp.tunnelClient !==
            null
        )
          break;
        if (Date.now() >= discoveryDeadline)
          throw new Error("GUIDED_SETUP_HELPER_DISCOVERY_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await window
        .getByLabel("Tunnel ID", { exact: true })
        .fill("new_fixture_tunnel");
      await window
        .getByLabel("Runtime key", { exact: true })
        .fill("synthetic-owned-fixture-runtime-key");
      await setupAction(window, "Save & connect");
      await window.locator(".credentials-saved").waitFor({ state: "visible" });
      const configured = await readSetupSettings(window);
      assert.ok(configured.connectors.secureMcp.tunnelClient);
      assert.equal(configured.connectors.secureMcp.credential, "stored");
      assert.equal(configured.connectors.secureMcp.runtime, null);
      assert.equal(configured.connectors.secureMcp.attachment, null);
      assert.equal(configured.setup.connect.outcomeUnknown, false);
      await window.getByText("Connection help", { exact: true }).click();
      await window
        .getByRole("button", { name: "Connection diagnostics", exact: true })
        .click();
      await window.getByText("Action details", { exact: true }).click();
      const setupResult = window
        .getByRole("list", { name: "Retained actions", exact: true })
        .locator("li")
        .filter({ hasText: "settings:connector.save-and-connect:" });
      assert.equal(
        await setupResult.count(),
        1,
        "SAVE_CONNECT_ORIGINAL_RESULT_MISSING",
      );
      const originalResult = await setupResult.innerText();
      // No workspaces means no acknowledged authority publication. The host
      // refuses before issuing Go open; never invent an original Go attempt.
      assert.match(
        originalResult,
        /^settings:connector\.save-and-connect:[0-9a-f-]+: refused · CONNECTOR_START_FAILED$/u,
        "SAVE_CONNECT_OUTCOME_UNCONFIRMED",
      );
      await openSetup(window);
      await setupStep(window, "connection", "Connection");
      await window
        .getByRole("button", { name: "Edit connection", exact: true })
        .click();
      assert.equal(
        await window.getByLabel("Runtime key", { exact: true }).inputValue(),
        "",
      );
      await window
        .getByLabel("Runtime key", { exact: true })
        .fill("unused-fixture-replacement-runtime-key");
      await window.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.deepEqual(await readSetupSettings(window), configured);
    }
    // The selected design keeps Workspaces directly reachable from Setup.
    await setupStep(window, "folders", "Workspaces");
    await setupAction(window, "Add workspace…");
    await setupAction(window, "Add selected workspace read-only");
    // Settings retains hidden pages; Diagnostics projects the same folder.
    // Observe only the current guided form, not its hidden diagnostic record.
    const folder = window.locator(".setup-page .workspace-detail:visible");
    await folder.waitFor();
    assert.equal(await folder.count(), 1);
    let saved = await readSetupSettings(window);
    assert.equal(saved.computer.workspaces.length, 1);
    assert.equal(
      saved.computer.workspaces[0].root,
      await fs.realpath(workspace),
    );
    assert.equal(saved.computer.workspaces[0].access, "read");
    assert.notEqual(saved.computer.workspaces[0].gitHistoryApproved, true);
    assert.notEqual(saved.computer.commands, "workspace");
    await setupAction(window, "Verify workspace");
    await window.waitForFunction(() =>
      document
        .querySelector(".setup-page .workspace-detail .badges")
        ?.textContent.includes("Access checked"),
    );
    saved = await readSetupSettings(window);
    const build = (await window.evaluate(() => window.farolNext.bootstrap()))
      .build;
    assert.equal(
      saved.setup.computer.verified.workspaceId,
      saved.computer.workspaces[0].workspaceId,
    );
    assert.equal(saved.setup.computer.verified.buildId, build.buildId);
    assert.equal(
      saved.setup.computer.verified.configRevision,
      saved.computer.generation,
    );
    assert.equal(saved.setup.chatgpt.verified, null);
    assert.equal(saved.setup.connect.verified, null);
    const retainedWorkspaces = saved.computer.workspaces;
    let verifiedWorkspaces = retainedWorkspaces;
    const retainedProfile = { ...activeFixtureProfile };
    const stateRoot = path.join(retainedProfile.userData, "farol-next-state");
    const configFile = path.join(stateRoot, "config.json");
    let policyConfigSha256;
    let policyRunMarker;
    if (behavior) {
      // Supported current React Settings -> IPC owner save only. Reading the
      // owned config observes publication; this test never writes policy bytes.
      const beforePolicy = saved;
      assert.equal(Object.hasOwn(beforePolicy.computer, "filePolicy"), false);
      assert.equal(beforePolicy.connectors.secureMcp.runtime, null);
      await window
        .getByRole("navigation", { name: "Sections", exact: true })
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await window
        .getByRole("navigation", { name: "Settings navigation", exact: true })
        .getByRole("button", { name: "This Mac", exact: true })
        .click();
      await window
        .getByRole("region", {
          name: "Files in approved workspaces",
          exact: true,
        })
        .getByRole("combobox")
        .selectOption("approved-roots-v1");
      await window
        .getByRole("button", { name: "Save file permissions", exact: true })
        .click();
      await window
        .locator('.settings-page > p[role="status"]')
        .filter({
          hasText: /^Action confirmed\. Check the current status below\.$/u,
        })
        .waitFor();
      saved = await readSetupSettings(window);
      assert.equal(saved.computer.filePolicy, "approved-roots-v1");
      assert.equal(saved.revision, beforePolicy.revision + 1);
      assert.equal(
        saved.computer.generation,
        beforePolicy.computer.generation + 1,
      );
      assert.deepEqual(saved.computer.workspaces, retainedWorkspaces);
      assert.equal(saved.computer.commands, beforePolicy.computer.commands);
      assert.equal(saved.setup.computer.verified, null);
      assert.equal(saved.setup.computer.reachable, "unknown");
      assert.equal(saved.setup.computer.outcomeUnknown, false);
      assert.equal(saved.connectors.secureMcp.runtime, null);
      assert.equal(saved.connectors.secureMcp.attachment, null);
      const persisted = await fs.readFile(configFile);
      assert.deepEqual(JSON.parse(persisted).computer, saved.computer);
      policyConfigSha256 = createHash("sha256").update(persisted).digest("hex");
      policyRunMarker = await readOwnedStartupMarker(
        stateRoot,
        retainedProfile.home,
        application.process().pid,
      );
      await openSetup(window);
      observations.push({
        kind: "new-format-file-policy-saved-through-react-settings",
        build: behaviorBuild,
        profile: retainedProfile,
        configFile,
        configSha256: policyConfigSha256,
        computerGeneration: saved.computer.generation,
        workspaceVerification: "invalidated",
      });
    }
    await assertSetupOverview(
      window,
      behavior ? uncheckedOverview : workspaceOverview,
    );
    assert.equal(nonReadRequests, 0);
    // A known graceful quit permits reusing this SAME disposable profile.
    // Approved folders and saved credentials alone never make Computer ready.
    await closeOwned();
    if (behavior) {
      const cleanQuit = JSON.parse(
        await fs.readFile(path.join(stateRoot, "last-quit.json"), "utf8"),
      );
      assert.equal(cleanQuit.schema, 1);
      assert.equal(cleanQuit.drained, true);
      assert.deepEqual(cleanQuit.unconfirmed, []);
      assert.ok(
        Date.parse(cleanQuit.at) >= Date.parse(policyRunMarker.startedAt),
        "POLICY_SAVE_QUIT_RECEIPT_STALE",
      );
      await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
        code: "ENOENT",
      });
      assert.equal(
        createHash("sha256")
          .update(await fs.readFile(configFile))
          .digest("hex"),
        policyConfigSha256,
        "POLICY_CONFIG_CHANGED_ON_QUIT",
      );
      observations.push({
        kind: "new-format-save-normal-clean-quit",
        cleanQuit,
      });
    }
    window = await launch(environment, "normal", environment);
    await waitForResumeStage("connector-resume-skipped");
    const partial = await readSetupSettings(window);
    assert.deepEqual(partial.computer.workspaces, retainedWorkspaces);
    assert.deepEqual(
      partial.setup.computer.verified,
      saved.setup.computer.verified,
    );
    assert.equal(partial.connectors.secureMcp.runtime, null);
    assert.equal(partial.connectors.secureMcp.attachment, null);
    assert.equal(partial.connectors.secureMcp.lastVerifiedAttachment, null);
    assert.equal(partial.setup.connect.verified, null);
    await reviewSetupWithoutChanges(
      window,
      behavior ? uncheckedOverview : workspaceOverview,
    );
    assert.equal(nonReadRequests, 0);
    observations.push({
      kind: "partial-quit-reopen-and-nondestructive-review",
      environment,
    });
    if (behavior) {
      assert.deepEqual(
        activeFixtureProfile,
        retainedProfile,
        "POLICY_REOPEN_PROFILE_CHANGED",
      );
      assert.deepEqual(partial.computer, saved.computer);
      assert.equal(partial.computer.filePolicy, "approved-roots-v1");
      assert.equal(partial.setup.computer.verified, null);
      assert.equal(
        createHash("sha256")
          .update(await fs.readFile(configFile))
          .digest("hex"),
        policyConfigSha256,
        "POLICY_CONFIG_CHANGED_ON_REOPEN",
      );
      assert.equal(fixtureVerifications, 0, "POLICY_SAVE_REPLAYED_ATTACHMENT");
      // Readiness stayed withdrawn through Quit/reopen. Only the normal
      // workspace command performs fresh Go inspection under the new policy.
      await setupStep(window, "folders", "Workspaces");
      const verificationStarted = Date.now();
      await setupAction(window, "Verify workspace");
      const reverified = await readSetupSettings(window);
      assert.equal(
        reverified.setup.computer.verified.workspaceId,
        retainedWorkspaces[0].workspaceId,
      );
      assert.equal(
        reverified.setup.computer.verified.configRevision,
        saved.computer.generation,
      );
      assert.equal(reverified.setup.computer.verified.buildId, build.buildId);
      assert.equal(reverified.computer.filePolicy, "approved-roots-v1");
      // Rechecking publishes a new proof for this generation. It must retain
      // every authority/configuration field and only refresh that proof.
      assert.deepEqual(
        reverified.computer.workspaces.map(
          ({ accessCheck, ...workspace }) => workspace,
        ),
        retainedWorkspaces.map(({ accessCheck, ...workspace }) => workspace),
      );
      const refreshedCheck = reverified.computer.workspaces[0].accessCheck;
      assert.deepEqual(refreshedCheck, {
        ...retainedWorkspaces[0].accessCheck,
        computerGeneration: saved.computer.generation,
        verifiedAt: refreshedCheck.verifiedAt,
      });
      assert.ok(
        Date.parse(refreshedCheck.verifiedAt) >= verificationStarted,
        "POLICY_REVERIFICATION_ACCESS_PROOF_STALE",
      );
      verifiedWorkspaces = reverified.computer.workspaces;
      await assertSetupOverview(window, workspaceOverview);
      observations.push({
        kind: "new-format-policy-retained-reopen-fresh-workspace-verification",
        configSha256: policyConfigSha256,
        readerRollback: "NOT_RUN",
        helperRollback: "NOT_RUN",
        postStartRollback: "NOT_RUN",
      });
    }
    if (!behavior) {
      await closeOwned();
      continue;
    }
    await setupStep(window, "connection", "Connection");
    await setupAction(window, "Connect this Mac");
    let state = await readSetupSettings(window);
    assert.equal(state.connectors.secureMcp.runtime.state, "ready");
    assert.equal(state.connectors.secureMcp.attachment, null);
    assert.equal(state.setup.chatgpt.verified, null);
    const startedRuntime = state.connectors.secureMcp.runtime.runtimeGeneration;
    await setupAction(window, "Check connection");
    await window.getByText("Connection help", { exact: true }).click();
    await window
      .locator(".setup-page")
      .getByRole("button", { name: "Connection diagnostics", exact: true })
      .click();
    await window
      .locator(".settings-page > div:not([hidden])")
      .getByRole("button", { name: "Reconnect", exact: true })
      .click();
    await window
      .locator('.settings-page > p[role="status"]')
      .filter({
        hasText:
          /^Local connection started\. Verify Farol in ChatGPT to confirm external access\.$/u,
      })
      .waitFor();
    await openSetup(window);
    await setupStep(window, "connection", "Connection");
    state = await readSetupSettings(window);
    assert.equal(state.connectors.secureMcp.runtime.state, "ready");
    assert.notEqual(
      state.connectors.secureMcp.runtime.runtimeGeneration,
      startedRuntime,
    );
    assert.deepEqual(state.computer.workspaces, verifiedWorkspaces);
    await assertSetupOverview(window, connectedOverview);
    const verifiedChallenge = await verifyDisplayedAttachment(window);
    state = await readSetupSettings(window);
    const connector = state.connectors.secureMcp;
    assert.equal(
      connector.attachment.runtimeGeneration,
      connector.runtime.runtimeGeneration,
    );
    assert.equal(
      connector.attachment.workspaceId,
      state.setup.computer.verified.workspaceId,
    );
    assert.equal(connector.attachment.buildId, build.buildId);
    assert.equal(
      connector.attachment.connectorGeneration,
      connector.generation,
    );
    assert.equal(
      connector.attachment.computerGeneration,
      state.computer.generation,
    );
    assert.equal(
      connector.attachment.challengeSha256,
      verifiedChallenge.challengeSha256,
    );
    assert.equal(connector.challenge, null, "VERIFIED_CHALLENGE_NOT_CONSUMED");
    assert.equal(
      state.setup.connect.verified.runtimeGeneration,
      connector.runtime.runtimeGeneration,
    );
    assert.deepEqual(connector.lastVerifiedAttachment, connector.attachment);
    assert.equal(
      state.setup.chatgpt.verified,
      null,
      "EXTERNAL_FIXTURE_CREATED_EMBEDDED_SIGN_IN_PROOF",
    );
    await assertSetupOverview(window, readyOverview);
    await reviewSetupWithoutChanges(window, readyOverview);
    assert.equal(
      fixtureVerifications,
      1,
      "REVIEW_SETUP_REPEATED_MCP_VERIFICATION",
    );
    assert.equal(nonReadRequests, 0, "REVIEW_SETUP_SENT_TO_BROWSER_FIXTURE");
    await window
      .getByRole("region", { name: "Setup overview", exact: true })
      .getByRole("button", { name: "Open Home", exact: true })
      .click();
    await window
      .locator('.home-candidate[data-home-view="overview"]')
      .waitFor();
    observations.push({
      kind: "current-react-setup-overview-ready-with-owned-mcp-receipt",
      environment,
      fixtureVerifications,
    });
    const completed = await readSetupSettings(window);
    assert.equal(completed.computer.filePolicy, "approved-roots-v1");
    await closeOwned();
    if (resumeRefusal) {
      // Preserve the existing optional changed-client refusal case. Only our
      // disposable executable changes after confirmed exit; it is never retried.
      const executed = path.join(temporaryRoot, "changed-client-executed");
      const fixtureBytes = await fs.readFile(tunnelFixture, "utf8");
      await fs.writeFile(
        tunnelFixture,
        fixtureBytes.replace(
          "\n",
          `\nrequire("node:fs").writeFileSync(${JSON.stringify(executed)}, "executed");\n`,
        ),
      );
      window = await launch(environment, "normal", environment);
      await waitForResumeStage("connector-resume-refused");
      const refused = await readSetupSettings(window);
      assert.equal(refused.connectors.secureMcp.runtime, null);
      assert.equal(refused.connectors.secureMcp.challenge, null);
      assert.equal(refused.connectors.secureMcp.attachment, null);
      assert.deepEqual(
        refused.connectors.secureMcp.lastVerifiedAttachment,
        completed.connectors.secureMcp.lastVerifiedAttachment,
      );
      assert.equal(refused.setup.connect.verified, null);
      assert.equal(
        refused.setup.connect.unavailable,
        "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
      );
      assert.deepEqual(refused.computer.workspaces, verifiedWorkspaces);
      await reviewSetupWithoutChanges(window, workspaceOverview);
      await assert.rejects(fs.stat(executed), { code: "ENOENT" });
      assert.equal(fixtureVerifications, 1);
      assert.equal(nonReadRequests, 0);
      observations.push({
        kind: "changed-executable-resume-refused-live-proof-withdrawn",
        historicalCompletionPreserved: true,
      });
      await closeOwned();
      break;
    }
    window = await launch(environment, "normal", environment);
    await waitForResumeStage("connector-resumed");
    const resumed = await readSetupSettings(window);
    assert.equal(resumed.computer.filePolicy, "approved-roots-v1");
    assert.equal(resumed.connectors.secureMcp.runtime.state, "ready");
    assert.notEqual(
      resumed.connectors.secureMcp.runtime.runtimeGeneration,
      completed.connectors.secureMcp.runtime.runtimeGeneration,
    );
    assert.equal(resumed.connectors.secureMcp.runtime.buildId, build.buildId);
    assert.deepEqual(resumed.computer.workspaces, verifiedWorkspaces);
    assert.deepEqual(
      resumed.connectors.secureMcp.lastVerifiedAttachment,
      completed.connectors.secureMcp.lastVerifiedAttachment,
    );
    assert.equal(resumed.connectors.secureMcp.attachment, null);
    assert.equal(resumed.setup.connect.verified, null);
    await reviewSetupWithoutChanges(window, connectedOverview);
    assert.equal(fixtureVerifications, 1, "REOPEN_REPLAYED_MCP_VERIFICATION");
    assert.equal(nonReadRequests, 0, "REOPEN_SENT_TO_BROWSER_FIXTURE");
    // Historical completion survives quit; current readiness requires the new
    // displayed challenge, answered once by the owned MCP peer, then Check.
    await verifyDisplayedAttachment(window);
    await assertSetupOverview(window, readyOverview);
    await reviewSetupWithoutChanges(window, readyOverview);
    assert.equal(fixtureVerifications, 2);
    assert.equal(nonReadRequests, 0);
    observations.push({
      kind: "completed-quit-reopen-retains-history-fresh-receipt-restores-readiness",
      environment,
      fixtureVerifications,
    });
    await closeOwned();
  }
} catch (error) {
  primaryFailure = error;
  if (application && profileIsolationConfirmed) {
    try {
      const windows = application.windows();
      const shell = windows.find(
        (window) =>
          window.url().startsWith("file:") &&
          window.url().endsWith("/shell.html"),
      );
      if (shell)
        observations.push({
          kind: "failure-ui-feedback",
          ...(await bounded(
            shell.evaluate(async () => {
              const bootstrap = await window.farolNext.bootstrap();
              return {
                feedback: document.querySelector(
                  '.setup-page .settings-page > p[role="status"]',
                )?.textContent,
                folders: document.querySelector(".setup-page .workspace-detail")
                  ?.textContent,
                workspaces:
                  bootstrap.configuration.settings.computer.workspaces.map(
                    ({ root, access }) => ({ root, access }),
                  ),
                environment: bootstrap.environment,
              };
            }),
            "GUIDED_SETUP_FAILURE_FEEDBACK_TIMEOUT",
          )),
        });
    } catch (feedbackError) {
      observations.push({
        kind: "failure-feedback-unavailable",
        error: String(feedbackError),
      });
    }
  }
  if (application && !profileIsolationConfirmed)
    observations.push({ kind: "failure-feedback-skipped-unverified-profile" });
} finally {
  closingLateLaunch = true;
  if (pendingLaunch) {
    try {
      await bounded(pendingLaunch, "GUIDED_SETUP_LATE_LAUNCH_UNRESOLVED");
    } catch (error) {
      if (application)
        observations.push({
          kind: "late-launch-failed",
          cleanup: "owned cleanup still required",
        });
      // A failed launch already reports its native exit. An unresolved late
      // success remains owned by its completion callback and is never duplicated.
      if (error?.message === "GUIDED_SETUP_LATE_LAUNCH_UNRESOLVED") {
        cleanupUnknown = true;
        electronCleanupUnknown = true;
        cleanupFailures.push(error);
      }
    }
  }
  try {
    if (!electronCleanupUnknown) await closeOwned();
  } catch (error) {
    cleanupFailures.push(error);
  }
  // HTTP cleanup and evidence survive an Electron cleanup refusal/unknown.
  // No second Electron close, signal fallback or replacement app is attempted.
  try {
    await bounded(
      new Promise((resolve, reject) =>
        chatFixture.close((error) => (error ? reject(error) : resolve())),
      ),
      "BROWSER_FIXTURE_CLOSE_TIMEOUT",
    );
    observations.push({ kind: "local-http-fixture-closed", nonReadRequests });
  } catch (error) {
    cleanupFailures.push(error);
    observations.push({ kind: "local-http-fixture-cleanup-unknown" });
  }
  for (const owned of mcpChildren) {
    if (owned.observed) continue;
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      observations.push({
        kind: "owned-mcp-terminal-final-readback",
        pid: owned.child.pid,
        exit: owned.child.exitCode,
        signal: owned.child.signalCode,
      });
      owned.observed = true;
    } else {
      cleanupUnknown = true;
      observations.push({
        kind: "owned-mcp-cleanup-unknown-final-readback",
        pid: owned.child.pid,
      });
    }
  }
  for (const owned of backgroundChildren) {
    if (owned.observed) continue;
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      owned.observed = true;
      observations.push({
        kind: "background-secondary-terminal-final-readback",
        pid: owned.child.pid,
        exit: owned.child.exitCode,
        signal: owned.child.signalCode,
      });
    } else {
      cleanupUnknown = true;
      observations.push({
        kind: "background-secondary-cleanup-unknown",
        pid: owned.child.pid,
      });
    }
  }
  const destination = path.join(
    root,
    "_output/evidence/guided-setup-selection",
    resumeRefusal
      ? "resume-refusal-package.json"
      : behavior
        ? packaged
          ? "behavior-package.json"
          : "behavior-development.json"
        : packaged
          ? "package.json"
          : devOnly
            ? "dev-only.json"
            : "development.json",
  );
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    destination,
    JSON.stringify(
      {
        schema: 1,
        packaged,
        devOnly,
        behavior,
        resumeRefusal,
        observations,
        fixtureVerifications,
        primaryFailure: primaryFailure ? String(primaryFailure) : null,
        cleanupFailures: cleanupFailures.map(String),
        cleanupUnknown,
        limits: [
          "Hidden React renderer and disposable native/IPC fixtures only",
          "Browser pages are read-only local HTTP fixtures, not live ChatGPT",
          "Attachment receipts come from an owned local MCP peer, never external ChatGPT",
          "Browser geometry, legacy/demo modal and embedded Send flows are outside this current-React Setup journey",
          "Native folder picker is replaced by the explicit E2E selection",
          "No live account, provider Send, model inference or real external attachment",
          "Predecessor reader, helper rollback and post-start rollback NOT RUN; new-format save/reopen is not B06 recovery acceptance",
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
if (primaryFailure || cleanupFailures.length > 0 || cleanupUnknown) {
  throw new AggregateError(
    [primaryFailure, ...cleanupFailures].filter(Boolean),
    cleanupUnknown ? "GUIDED_SETUP_CLEANUP_UNKNOWN" : "GUIDED_SETUP_FAILED",
  );
}
process.stdout.write(
  JSON.stringify({
    packaged,
    observations: observations.length,
    cleanup: "owned app exits observed",
    live: "NOT_RUN",
  }) + "\n",
);
