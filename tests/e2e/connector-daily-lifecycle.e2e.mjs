// Three fresh hidden PACKAGED lifetimes. No installed profile, provider Send,
// hardware sleep, updater, clock injection, process scan or unknown retry.
// Usage (only after the Lead supplies clean, attested owner-beta package bytes):
//   node tests/e2e/connector-daily-lifecycle.e2e.mjs
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { assertBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  candidatePaths,
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
} from "../../tooling/candidate-contract.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { parseQuitReceipt } from "../../src/apps/desktop/quit-receipt.ts";
import { waitForReactShell } from "./current-react-setup.mjs";
import {
  assertNativePreviewAdmission,
  recheckNativePreviewIsolation,
  readOwnedStartupMarker,
} from "./native-preview-admission.mjs";

assert.deepEqual(process.argv.slice(2), [], "DAILY_ARGUMENTS_INVALID");
assert.equal(process.platform, "darwin", "DAILY_MACOS_REQUIRED");
const root = path.resolve(import.meta.dirname, "../..");
const { appPath, artifactFile } = candidatePaths(root);
const resources = path.join(appPath, "Contents/Resources/app");
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
assertCanonicalArtifactPath(root, artifact);
assert.equal(artifact.schema, 7, "DAILY_GO_PACKAGE_REQUIRED");
const build = assertBuildIdentity(
  JSON.parse(
    await fs.readFile(path.join(resources, "build-identity.json"), "utf8"),
  ),
);
assert.match(
  build.version,
  /-owner\.beta\.[0-9]+$/u,
  "DAILY_OWNER_BETA_REQUIRED",
);
assertExactSourceIdentity(sourceIdentity(root), build);
assertExactSourceIdentity(sourceIdentity(root), artifact);
assert.equal(artifact.buildId, build.buildId);
assert.equal(
  await treeDigest(appPath),
  artifact.artifactSha256,
  "DAILY_PACKAGE_CHANGED",
);
const manifest = JSON.parse(
  await fs.readFile(path.join(resources, "build-manifest.json"), "utf8"),
);
assert.equal(manifest.schema, 4);
assert.equal(manifest.inputExact, true);
assert.equal(manifest.core?.build.buildId, build.buildId);
assert.equal(manifest.core?.build.sourceSHA, build.sourceCommit);
const temporaryRoot = await fs.realpath(os.tmpdir());
const suiteId = randomUUID();
const destination = path.join(
  root,
  "_output/evidence/connector-daily-lifecycle",
  `${suiteId}.json`,
);
const report = {
  schema: "farol.connector-daily-lifecycle/1",
  suiteId,
  build,
  artifactSha256: artifact.artifactSha256,
  limits: [
    "Simulated suspend/resume emitted on Electron powerMonitor in the real packaged main process; NOT OS-delivered events or actual hardware sleep",
    "Synthetic loopback tunnel and local external MCP verification; NOT remote network/control-plane recovery or live ChatGPT attachment",
    "Three independent fresh disposable normal profiles; no installed profile access, reopen, updater or grant-expiry claim",
  ],
  cases: [],
};
const execute = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = (error) => ({
  name: error?.name ?? "Error",
  code: String(error?.message ?? "UNKNOWN")
    .split("\n")[0]
    .slice(0, 200),
});
async function bounded(promise, label, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function poll(read, accept, label, ms = 15000) {
  const deadline = Date.now() + ms;
  do {
    const value = await bounded(
      read(),
      label,
      Math.max(1, Math.min(5000, deadline - Date.now())),
    );
    if (accept(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(label);
}
async function privateJson(file, maximum = 16384) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    assert.ok(
      info.isFile() &&
        info.nlink === 1 &&
        info.uid === process.getuid() &&
        (info.mode & 0o077) === 0 &&
        info.size <= maximum,
      "DAILY_PRIVATE_RECORD_UNSAFE",
    );
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    assert.ok(bytesRead <= maximum, "DAILY_RECORD_OVERSIZED");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}
async function optionalText(file) {
  return fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}
async function identity(directory) {
  const info = await fs.lstat(directory);
  assert.ok(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === 0o700,
    "DAILY_ROOT_UNSAFE",
  );
  assert.equal(await fs.realpath(directory), directory);
  return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode };
}
async function sameRoot(record) {
  assert.deepEqual(
    await identity(record.path),
    record.identity,
    "DAILY_ROOT_CHANGED",
  );
}
async function absent(pid, group = false) {
  try {
    process.kill(group ? -pid : pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(
    group ? "DAILY_GROUP_STILL_PRESENT" : "DAILY_PROCESS_STILL_PRESENT",
  );
}
async function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const { stdout } = await execute(
    "/bin/ps",
    ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="],
    {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeout: 3000,
      maxBuffer: 4096,
    },
  );
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(stdout);
  assert.ok(match, "DAILY_PROCESS_IDENTITY_UNAVAILABLE");
  assert.equal(Number(match[1]), pid);
  return {
    pid,
    parentPid: Number(match[2]),
    group: Number(match[3]),
    start: match[4],
  };
}
async function hidden(run) {
  const windows = await bounded(
    run.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    ),
    "DAILY_WINDOW_READ_TIMEOUT",
  );
  assert.ok(
    windows.length &&
      windows.every((window) => !window.visible && !window.focused),
    "DAILY_VISIBLE_OR_FOCUSED_WINDOW",
  );
  return windows;
}
async function settings(run) {
  const result = await bounded(
    run.window.evaluate(() => window.farolNext.bootstrap()),
    "DAILY_BOOTSTRAP_TIMEOUT",
  );
  assert.deepEqual(result.build, build);
  assert.equal(result.configuration.status, "ready");
  return result.configuration.settings;
}
async function configure(run, command) {
  // Exactly one public command. A lost/refused reply terminates this case.
  const result = await bounded(
    run.window.evaluate((value) => window.farolNext.configure(value), command),
    "DAILY_CONFIGURATION_TIMEOUT",
    30000,
  );
  assert.equal(
    result.ok,
    true,
    `DAILY_CONFIGURE_REFUSED:${command.kind}:${result.error ?? "unknown"}`,
  );
  return result;
}
function captureMain(run, application) {
  run.application = application;
  run.child = application.process();
  run.exit = new Promise((resolve) => {
    run.child.once("exit", (code, signal) => resolve({ code, signal }));
    if (run.child.exitCode !== null || run.child.signalCode !== null)
      resolve({ code: run.child.exitCode, signal: run.child.signalCode });
  });
  run.childClose = new Promise((resolve) =>
    run.child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let pending = "";
  run.child.stderr?.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > 65536) {
      run.evidence.diagnosticsOverflow = true;
      pending = "";
      return;
    }
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      const prefix = [
        "FAROL_BACKEND_LIFECYCLE:",
        "FAROL_CONNECTOR_TRANSPORT:",
        "FAROL_DAILY_QUIT:",
      ].find((value) => line.startsWith(value));
      if (!prefix) continue;
      try {
        assert.ok(run.evidence.observations.length < 256);
        run.evidence.observations.push({
          kind: prefix.slice(0, -1),
          ...JSON.parse(line.slice(prefix.length)),
        });
      } catch {
        run.evidence.diagnosticsInvalid = true;
      }
    }
  });
}
async function launch(run) {
  const options = {
    executablePath: path.join(appPath, "Contents/MacOS/Farol Next Preview"),
    args: ["--preview-window-mode=hidden"],
    env: {
      HOME: run.home.path,
      TMPDIR: temporaryRoot,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: run.appData,
      FAROL_NEXT_E2E_TEST_ROOT: run.home.path,
      FAROL_NEXT_E2E_TEST_PROOF: run.proof,
      FAROL_NEXT_E2E_WORKSPACE_ROOT: run.workspace,
      FAROL_NEXT_E2E_CHATGPT_URL: run.fixtureUrl,
      FAROL_NEXT_E2E_TUNNEL_CLIENT: run.tunnelExecutable,
    },
    timeout: 15000,
  };
  // An explicit isolation request never takes the owner-profile idle fallback.
  const admission = await assertNativePreviewAdmission(undefined, {
    profileRoot: run.home.path,
    proof: run.proof,
    launchOptions: options,
    fixture: run.server,
    auxiliaryRoot: run.auxiliary.path,
  });
  run.pendingLaunch = electron.launch(options).then((application) => {
    captureMain(run, application);
    return application;
  });
  await bounded(run.pendingLaunch, "DAILY_LAUNCH_TIMEOUT", 20000);
  run.window = await bounded(
    run.application.firstWindow(),
    "DAILY_SHELL_TIMEOUT",
    30000,
  );
  const actual = await bounded(
    run.application.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid,
      home: app.getPath("home"),
      userData: app.getPath("userData"),
      sessionData: app.getPath("sessionData"),
      temp: app.getPath("temp"),
      windows: BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
      isPackaged: app.isPackaged,
      userDataOverride: app.commandLine.hasSwitch("user-data-dir"),
    })),
    "DAILY_NATIVE_PATH_READBACK_TIMEOUT",
  );
  run.admission = await recheckNativePreviewIsolation(
    admission,
    actual,
    run.child,
  );
  assert.equal(actual.isPackaged, true);
  assert.equal(actual.userDataOverride, false);
  assert.equal(actual.userData, path.join(run.appData, "Farol Next Preview"));
  run.nativePaths = actual;
  run.isolated = true;
  run.userData = actual.userData;
  // This exact singleton was validated by the admission readback above.
  const singletonRoot = await fs.realpath(
    path.dirname(
      await fs.readlink(path.join(actual.userData, "SingletonSocket")),
    ),
  );
  run.singletonRoot = {
    path: singletonRoot,
    identity: await identity(singletonRoot),
  };
  run.state = path.join(actual.userData, "farol-next-state");
  run.connectorRoot = path.join(run.state, "secure-mcp-connector");
  await bounded(
    waitForReactShell(run.window),
    "DAILY_REACT_SHELL_TIMEOUT",
    30000,
  );
  await poll(
    () => optionalText(path.join(run.home.path, ".farol-next-startup-stage")),
    (value) => value.trim() === "startup-complete",
    "DAILY_STARTUP_TIMEOUT",
    30000,
  );
  await poll(
    () =>
      optionalText(
        path.join(run.home.path, ".farol-next-connector-resume-stage"),
      ),
    (value) => value.trim() === "connector-resume-skipped",
    "DAILY_WATCH_STARTUP_TIMEOUT",
  );
  run.marker = await readOwnedStartupMarker(
    run.state,
    run.home.path,
    run.child.pid,
  );
  run.evidence.admission = {
    ...run.admission,
    pid: actual.pid,
    isPackaged: true,
    userDataOverride: false,
  };
  run.evidence.windows = await hidden(run);
  await bounded(
    run.application.evaluate(({ app, BrowserWindow }) => {
      globalThis.__farolDailyVisibilityViolations = [];
      const watch = (window) => {
        for (const event of ["show", "focus"])
          window.on(event, () =>
            globalThis.__farolDailyVisibilityViolations.push(event),
          );
      };
      BrowserWindow.getAllWindows().forEach(watch);
      app.on("browser-window-created", (_event, window) => watch(window));
      for (const event of ["before-quit", "will-quit"])
        app.on(event, () => {
          process.stderr.write(
            "FAROL_DAILY_QUIT:" +
              JSON.stringify({
                event,
                pid: process.pid,
                at: new Date().toISOString(),
                visibilityViolations:
                  globalThis.__farolDailyVisibilityViolations.length,
              }) +
              "\n",
          );
        });
    }),
    "DAILY_VISIBILITY_OBSERVER_TIMEOUT",
  );
}
async function captureLaunch(run, current) {
  const args = await privateJson(
    path.join(run.connectorRoot, "state/farol-e2e-tunnel-init.json"),
  );
  assert.ok(
    Array.isArray(args) && args.every((value) => typeof value === "string"),
  );
  assert.equal(args.filter((value) => value === "--mcp-command").length, 1);
  const command = args[args.indexOf("--mcp-command") + 1];
  const selected =
    /'--launch-contract' '(\/private\/tmp\/farol-mcp-[A-Za-z0-9-]+\/computer-go-launch\.json)'$/u.exec(
      command,
    );
  assert.ok(selected, "DAILY_GO_LAUNCH_UNCONFIRMED");
  const file = selected[1];
  const directory = path.dirname(file);
  const ownedRoot = { path: directory, identity: await identity(directory) };
  const launch = await privateJson(file);
  assert.equal(launch.schema, "farol-go-connector/1");
  assert.equal(
    launch.lifecycleRoot,
    await fs.realpath(path.join(run.connectorRoot, "computer-authority")),
  );
  assert.equal(
    launch.opened.endpoint.socketPath,
    path.join(directory, "computer.sock"),
  );
  assert.equal(launch.opened.endpoint.binding.buildId, build.buildId);
  assert.equal(
    launch.opened.endpoint.binding.connectorGeneration,
    String(current.connectors.secureMcp.generation),
  );
  assert.equal(
    launch.challengeSha256,
    hash(current.connectors.secureMcp.challenge.value),
  );
  assert.ok(
    !run.socketRoots.some((value) => value.path === directory),
    "DAILY_SOCKET_ROOT_REUSED",
  );
  run.socketRoots.push(ownedRoot);
  return { file, launch };
}
async function initialVerify(run, current, selected) {
  assert.equal(
    current.connectors.secureMcp.challenge.runtimeGeneration,
    current.connectors.secureMcp.runtime.runtimeGeneration,
    "DAILY_CHALLENGE_RUNTIME_CHANGED",
  );
  assert.ok(
    current.computer.workspaces.some(
      (workspace) =>
        workspace.workspaceId === current.setup.computer.verified.workspaceId,
    ),
    "DAILY_VERIFIED_WORKSPACE_MISSING",
  );
  const transport = new StdioClientTransport({
    command: path.join(
      appPath,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    ),
    args: [
      path.join(resources, "computer-mcp.cjs"),
      "--launch-contract",
      selected.file,
    ],
    cwd: root,
    env: {
      HOME: run.home.path,
      TMPDIR: temporaryRoot,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "owned-daily-lifecycle-fixture",
    version: "1.0.0",
  });
  const peer = { client, transport, closeAttempted: false };
  run.peers.push(peer);
  const originalStart = transport.start.bind(transport);
  transport.start = async () => {
    const pending = originalStart();
    peer.child = transport._process;
    assert.ok(
      peer.child && peer.child.pid === transport.pid,
      "DAILY_MCP_CHILD_UNOWNED",
    );
    peer.exit = new Promise((resolve) =>
      peer.child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await pending;
  };
  try {
    await bounded(client.connect(transport), "DAILY_MCP_CONNECT_TIMEOUT");
    const result = await bounded(
      client.callTool({
        name: "farol_next_connector_verify",
        arguments: {
          challenge: current.connectors.secureMcp.challenge.value,
          workspaceId: current.setup.computer.verified.workspaceId,
        },
      }),
      "DAILY_INITIAL_VERIFY_TIMEOUT",
    );
    assert.equal(result.isError ?? false, false);
    const verified = result.structuredContent;
    assert.equal(verified?.status, "ok");
    assert.deepEqual(
      verified.data.binding,
      selected.launch.opened.endpoint.binding,
    );
    assert.deepEqual(
      verified.data.receipt.execution,
      selected.launch.opened.execution,
    );
    assert.equal(
      verified.data.receipt.workspaceId,
      current.setup.computer.verified.workspaceId,
    );
    assert.equal(
      verified.data.receipt.challengeSha256,
      selected.launch.challengeSha256,
    );
    assert.equal(
      verified.data.receiptSha256,
      hash(JSON.stringify(verified.data.receipt)),
    );
    run.evidence.initialVerification = {
      binding: verified.data.binding,
      receiptSha256: verified.data.receiptSha256,
    };
  } finally {
    await closePeer(run, peer);
  }
  await configure(run, { kind: "connector.check-attachment" });
  const verified = await settings(run);
  assert.equal(
    verified.connectors.secureMcp.attachment.runtimeGeneration,
    verified.connectors.secureMcp.runtime.runtimeGeneration,
  );
  assert.equal(verified.connectors.secureMcp.challenge, null);
  return verified;
}
async function closePeer(run, peer) {
  if (peer.closeAttempted) return;
  peer.closeAttempted = true;
  const receipt = {
    kind: "original-mcp-close",
    pid: peer.child?.pid ?? null,
    close: "pending",
    terminal: null,
  };
  run.evidence.disposal.push(receipt);
  let originalError;
  try {
    await bounded(peer.client.close(), "DAILY_MCP_CLOSE_TIMEOUT");
    receipt.close = "returned";
  } catch (error) {
    receipt.close = "failed";
    receipt.failure = failure(error);
    originalError = error;
  }
  try {
    assert.ok(peer.exit, "DAILY_MCP_EXIT_UNOWNED");
    receipt.terminal = await bounded(peer.exit, "DAILY_MCP_EXIT_TIMEOUT", 5000);
    assert.deepEqual(receipt.terminal, { code: 0, signal: null });
  } catch (error) {
    run.evidence.cleanupUnknown = true;
    throw originalError ?? error;
  }
  if (originalError) throw originalError;
}
async function tunnelReceipts(run) {
  const directory = path.join(run.connectorRoot, "state");
  const names = (await fs.readdir(directory)).filter((name) =>
    /^daily-tunnel-[0-9a-f-]{36}\.json$/u.test(name),
  );
  assert.ok(names.length <= 2, "DAILY_UNEXPECTED_SUCCESSOR_COUNT");
  return Promise.all(
    names.map(async (name) => {
      const value = await privateJson(path.join(directory, name));
      assert.equal(value.schema, "farol.daily-tunnel-fixture/1");
      assert.equal(name, `daily-tunnel-${value.id}.json`);
      assert.ok(
        Number.isSafeInteger(value.pid) &&
          value.pid > 1 &&
          Number.isSafeInteger(value.parentPid) &&
          value.parentPid > 1,
      );
      assert.ok(["running", "exited"].includes(value.phase));
      return value;
    }),
  );
}
async function ownTunnel(run, receipt) {
  const tunnel = await processIdentity(receipt.pid);
  const anchor = await processIdentity(receipt.parentPid);
  assert.equal(tunnel.parentPid, anchor.pid);
  assert.equal(anchor.parentPid, run.child.pid);
  assert.equal(anchor.group, anchor.pid);
  assert.equal(tunnel.group, anchor.pid);
  run.tunnels.push({ receiptId: receipt.id, tunnel, anchor });
  return run.tunnels.at(-1);
}
async function setup(run) {
  await configure(run, { kind: "connector.select-client" });
  const selected = await settings(run);
  assert.equal(
    selected.connectors.secureMcp.tunnelClient.executablePath,
    run.tunnelExecutable,
  );
  await configure(run, {
    kind: "connector.configure",
    tunnelId: "daily_owned_fixture",
    runtimeKey: "synthetic-daily-owned-runtime-key",
  });
  const added = await configure(run, {
    kind: "computer.add-workspace",
    access: "read",
  });
  await configure(run, {
    kind: "computer.verify-workspace",
    workspaceId: added.evidence.workspaceId,
  });
  await configure(run, { kind: "connector.start" });
  const current = await settings(run);
  assert.equal(current.computer.workspaces.length, 1);
  assert.equal(current.computer.workspaces[0].root, run.workspace);
  assert.equal(current.connectors.secureMcp.runtime.state, "ready");
  const launch = await captureLaunch(run, current);
  const receipts = await tunnelReceipts(run);
  assert.equal(receipts.length, 1);
  await ownTunnel(run, receipts[0]);
  run.baseline = await initialVerify(run, current, launch);
  run.baselineLaunch = launch.launch;
}
async function emitPower(run, event) {
  assert.ok(["suspend", "resume"].includes(event));
  const delivered = await bounded(
    run.application.evaluate(({ powerMonitor }, selected) => {
      const listeners = powerMonitor.listenerCount(selected);
      return { listeners, emitted: powerMonitor.emit(selected) };
    }, event),
    "DAILY_POWER_EVENT_TIMEOUT",
  );
  assert.ok(
    delivered.listeners > 0 && delivered.emitted,
    "DAILY_POWER_HANDLER_MISSING",
  );
  run.evidence.observations.push({
    kind: "simulated-electron-powerMonitor",
    event,
    ...delivered,
    actualHardwareSleep: false,
  });
}
async function exercise(run) {
  if (run.name === "healthy-simulated-suspend-resume") {
    await emitPower(run, "suspend");
    const before = (await tunnelReceipts(run))[0];
    // Cross one real production timer period. Emitting suspend does not freeze
    // the OS, clocks, Go renewal, or fixture; only the production watcher pauses.
    await delay(32000);
    const held = await tunnelReceipts(run);
    assert.equal(held.length, 1);
    assert.equal(
      held[0].healthRequests,
      before.healthRequests,
      "DAILY_HEALTH_PROBED_DURING_SUSPEND",
    );
    await emitPower(run, "resume");
    await poll(
      () => tunnelReceipts(run),
      (values) =>
        values.length === 1 &&
        values[0].healthRequests > held[0].healthRequests,
      "DAILY_RESUME_FRESH_PROBE_TIMEOUT",
      5000,
    );
    const after = await settings(run);
    assert.deepEqual(
      after.connectors.secureMcp,
      run.baseline.connectors.secureMcp,
    );
    assert.equal((await tunnelReceipts(run)).length, 1);
  } else if (run.name === "exact-owned-tunnel-term-recovery") {
    const original = run.tunnels[0];
    assert.deepEqual(
      await processIdentity(original.tunnel.pid),
      original.tunnel,
      "DAILY_TUNNEL_IDENTITY_CHANGED",
    );
    assert.deepEqual(
      await processIdentity(original.anchor.pid),
      original.anchor,
      "DAILY_ANCHOR_IDENTITY_CHANGED",
    );
    // One TERM of the proven tunnel child, never its anchor/group or a PID scan.
    process.kill(original.tunnel.pid, "SIGTERM");
    await poll(
      () => tunnelReceipts(run),
      (values) =>
        values.some(
          (value) =>
            value.id === original.receiptId &&
            value.phase === "exited" &&
            value.termRequested &&
            value.exitCode === 0,
        ),
      "DAILY_ORIGINAL_TUNNEL_EXIT_TIMEOUT",
      5000,
    );
    const after = await poll(
      () => settings(run),
      (value) =>
        value.connectors.secureMcp.runtime?.state === "ready" &&
        value.connectors.secureMcp.challenge !== null &&
        value.connectors.secureMcp.runtime.runtimeGeneration !==
          run.baseline.connectors.secureMcp.runtime.runtimeGeneration,
      "DAILY_KNOWN_DEATH_RECOVERY_TIMEOUT",
      90000,
    );
    assert.deepEqual(after.computer, run.baseline.computer);
    assert.equal(
      after.connectors.secureMcp.generation,
      run.baseline.connectors.secureMcp.generation,
    );
    assert.equal(after.connectors.secureMcp.attachment, null);
    assert.equal(after.setup.connect.verified, null);
    assert.deepEqual(
      after.connectors.secureMcp.lastVerifiedAttachment,
      run.baseline.connectors.secureMcp.lastVerifiedAttachment,
    );
    const next = await captureLaunch(run, after);
    assert.notDeepEqual(
      next.launch.opened.endpoint.binding,
      run.baselineLaunch.opened.endpoint.binding,
    );
    assert.equal(
      next.launch.opened.endpoint.binding.backendGeneration,
      run.baselineLaunch.opened.endpoint.binding.backendGeneration,
    );
    const receipts = await tunnelReceipts(run);
    assert.equal(receipts.length, 2);
    await ownTunnel(
      run,
      receipts.find((value) => value.id !== original.receiptId),
    );
    await absent(original.tunnel.pid);
    await absent(original.anchor.pid);
    await absent(original.anchor.pid, true);
    await poll(
      async () => run.evidence.observations,
      (values) =>
        values.some(
          (value) =>
            value.kind === "FAROL_CONNECTOR_TRANSPORT" &&
            value.code === "recovered_attachment_check_needed" &&
            value.recoveryDisposition === "settled" &&
            value.runtimeId ===
              run.baselineLaunch.opened.endpoint.binding.runtimeId,
        ),
      "DAILY_RECOVERY_RECEIPT_TIMEOUT",
    );
    assert.ok(
      run.evidence.observations.some(
        (value) =>
          value.kind === "FAROL_BACKEND_LIFECYCLE" &&
          value.source === "connector-tunnel" &&
          value.event === "exit" &&
          value.exitCode === 0 &&
          value.runtimeGeneration ===
            run.baseline.connectors.secureMcp.runtime.runtimeGeneration,
      ),
      "DAILY_TERMINAL_PRODUCTION_RECEIPT_MISSING",
    );
    run.evidence.recovery = {
      original: run.baselineLaunch.opened.endpoint.binding,
      successor: next.launch.opened.endpoint.binding,
      successorRuntimeGeneration:
        after.connectors.secureMcp.runtime.runtimeGeneration,
    };
  } else assert.equal(run.name, "normal-quit");
  await hidden(run);
}
async function normalQuit(run) {
  assert.equal(run.quitAttempted, false, "DAILY_QUIT_CANNOT_BE_RETRIED");
  run.quitAttempted = true;
  assert.ok(run.isolated, "DAILY_QUIT_PROFILE_UNCONFIRMED");
  await hidden(run);
  const configHash = hash(
    await fs.readFile(path.join(run.state, "config.json")),
  );
  const requestedAt = Date.now();
  run.evidence.quit = { requestedAt, dispatch: "pending", terminal: null };
  // Keep the original evaluate and child terminal; a transport closing during
  // Quit cannot prove success or justify a replacement Quit.
  run.quitRequest = run.application
    .evaluate(({ app }) => {
      app.quit();
    })
    .then(
      () => {
        run.evidence.quit.dispatch = "returned";
      },
      () => {
        run.evidence.quit.dispatch = "transport-ended-or-rejected";
      },
    );
  const terminal = await bounded(run.exit, "DAILY_NORMAL_QUIT_TIMEOUT", 65000);
  run.evidence.quit.terminal = terminal;
  assert.deepEqual(terminal, { code: 0, signal: null });
  // ChildProcess exit can precede delivery of its final stderr diagnostics.
  // Its original close proves those streams have ended before receipt checks.
  run.evidence.quit.childClose = await bounded(
    run.childClose,
    "DAILY_MAIN_STREAM_CLOSE_TIMEOUT",
    5000,
  );
  assert.deepEqual(run.evidence.quit.childClose, terminal);
  const file = path.join(run.state, "last-quit.json");
  const value = await privateJson(file, 8192);
  const parsed = parseQuitReceipt(JSON.stringify(value));
  assert.ok(parsed.ok, "DAILY_QUIT_RECEIPT_INVALID");
  assert.equal(value.drained, true);
  assert.deepEqual(value.unconfirmed, []);
  assert.ok(
    Date.parse(value.at) >= requestedAt &&
      Date.parse(value.at) >= Date.parse(run.marker.startedAt),
    "DAILY_QUIT_RECEIPT_STALE",
  );
  await assert.rejects(fs.lstat(path.join(run.state, "running.json")), {
    code: "ENOENT",
  });
  assert.equal(
    hash(await fs.readFile(path.join(run.state, "config.json"))),
    configHash,
    "DAILY_QUIT_CHANGED_CONFIGURATION",
  );
  for (const owned of run.tunnels) {
    await absent(owned.tunnel.pid);
    await absent(owned.anchor.pid);
    await absent(owned.anchor.pid, true);
  }
  const receipts = await tunnelReceipts(run);
  assert.equal(receipts.length, run.tunnels.length);
  assert.ok(
    receipts.every(
      (receipt) => receipt.phase === "exited" && receipt.exitCode === 0,
    ),
  );
  run.evidence.tunnels = receipts;
  run.evidence.quit.lastQuit = value;
  assert.ok(
    run.evidence.observations.some(
      (entry) =>
        entry.kind === "FAROL_DAILY_QUIT" &&
        entry.event === "will-quit" &&
        entry.pid === run.child.pid &&
        entry.visibilityViolations === 0,
    ),
    "DAILY_ORIGINAL_QUIT_EVENT_MISSING",
  );
  assert.ok(
    run.evidence.observations.some(
      (entry) =>
        entry.kind === "FAROL_BACKEND_LIFECYCLE" &&
        entry.source === "go-backend" &&
        entry.event === "child-close" &&
        entry.state === "observed" &&
        entry.exitCode === 0 &&
        entry.signal === null &&
        entry.forced === false &&
        entry.hostLifetimeId &&
        entry.childLaunchId,
    ),
    "DAILY_ORIGINAL_GO_CLOSE_RECEIPT_MISSING",
  );
  assert.ok(
    !run.evidence.diagnosticsOverflow && !run.evidence.diagnosticsInvalid,
    "DAILY_DIAGNOSTICS_UNCONFIRMED",
  );
  run.cleanQuit = true;
}
async function originalClose(run) {
  if (run.closeAttempted) return;
  if (!run.application) {
    run.evidence.disposal.push({
      kind: "original-electron-close",
      status: run.pendingLaunch ? "launch-handle-unconfirmed" : "not-launched",
    });
    if (run.pendingLaunch) run.evidence.cleanupUnknown = true;
    return;
  }
  // No second Quit after an unknown request. Close Playwright's original handle
  // only after its exact main has ended, or when no normal Quit was dispatched.
  if (
    run.quitAttempted &&
    run.child.exitCode === null &&
    run.child.signalCode === null
  ) {
    run.evidence.disposal.push({
      kind: "original-electron-close",
      status: "held-original-quit-unknown",
    });
    run.evidence.cleanupUnknown = true;
    return;
  }
  run.closeAttempted = true;
  const receipt = {
    kind: "original-electron-close",
    pid: run.child.pid,
    status: "pending",
    terminal: null,
  };
  run.evidence.disposal.push(receipt);
  try {
    await bounded(
      run.application.close(),
      "DAILY_ORIGINAL_CLOSE_TIMEOUT",
      15000,
    );
    receipt.status = "returned";
  } catch (error) {
    receipt.status = "failed";
    receipt.failure = failure(error);
    throw error;
  }
  receipt.terminal = await bounded(
    run.exit,
    "DAILY_ORIGINAL_CLOSE_EXIT_TIMEOUT",
    65000,
  );
  assert.deepEqual(receipt.terminal, { code: 0, signal: null });
}
async function dispose(run) {
  const errors = [];
  const attempt = async (work) => {
    try {
      await work();
    } catch (error) {
      errors.push(failure(error));
    }
  };
  // Observe the same pending launch once; no new launch/profile after timeout.
  if (run.pendingLaunch)
    await attempt(() =>
      bounded(run.pendingLaunch, "DAILY_LATE_LAUNCH_UNKNOWN", 20000),
    );
  for (const peer of run.peers) await attempt(() => closePeer(run, peer));
  if (run.application && run.isolated && !run.quitAttempted)
    await attempt(() => normalQuit(run));
  await attempt(() => originalClose(run));
  if (run.server)
    await attempt(async () => {
      await bounded(
        new Promise((resolve, reject) => {
          run.server.close((error) => (error ? reject(error) : resolve()));
          run.server.closeAllConnections();
        }),
        "DAILY_HTTP_CLOSE_TIMEOUT",
        5000,
      );
      run.evidence.disposal.push({
        kind: "loopback-server-close",
        status: "returned",
      });
    });
  // Reuse the original admission witness for post-exit singleton/root proof.
  if (
    run.cleanQuit &&
    run.closeAttempted &&
    errors.length === 0 &&
    !run.evidence.failure
  )
    await attempt(async () => {
      run.admission = await recheckNativePreviewIsolation(
        run.admission,
        run.nativePaths,
        run.child,
      );
      await sameRoot(run.home);
      await sameRoot(run.auxiliary);
      assert.equal(
        await fs.readFile(
          path.join(run.home.path, ".farol-next-e2e-root"),
          "utf8",
        ),
        run.proof,
      );
      assert.equal(
        await fs.readFile(
          path.join(run.auxiliary.path, ".farol-next-e2e-root"),
          "utf8",
        ),
        run.proof,
      );
      run.evidence.disposal.push({
        kind: "post-quit-profile-root-proof",
        status: "confirmed",
      });
      const singleton = run.singletonRoot;
      const singletonPresent = await fs.lstat(singleton.path).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (singletonPresent) {
        await sameRoot(singleton);
        assert.ok(
          (await fs.readdir(singleton.path)).every((name) =>
            ["SingletonCookie", "SingletonSocket"].includes(name),
          ),
          "DAILY_SINGLETON_ROOT_UNEXPECTED_ENTRY",
        );
        await fs.rm(singleton.path, { recursive: true });
      }
      run.evidence.disposal.push({
        kind: "owned-singleton-root-disposed",
        ...singleton,
        alreadyAbsent: !singletonPresent,
      });
      for (const record of run.socketRoots) {
        await sameRoot(record);
        assert.ok(
          (await fs.readdir(record.path)).every((name) =>
            ["computer.sock", "computer-go-launch.json"].includes(name),
          ),
          "DAILY_SOCKET_ROOT_UNEXPECTED_ENTRY",
        );
        await fs.rm(record.path, { recursive: true });
        run.evidence.disposal.push({
          kind: "owned-go-socket-root-disposed",
          path: record.path,
          identity: record.identity,
        });
      }
      // The admission names this profile-derived private relay root. No scan.
      const relay = run.admission.relayRoot;
      const relayIdentity = await fs.lstat(relay).then(
        () => identity(relay),
        (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (relayIdentity) {
        await sameRoot({ path: relay, identity: relayIdentity });
        await fs.rm(relay, { recursive: true });
        run.evidence.disposal.push({
          kind: "owned-relay-root-disposed",
          path: relay,
          identity: relayIdentity,
        });
      }
      for (const record of [run.home, run.auxiliary]) {
        await sameRoot(record);
        await fs.rm(record.path, { recursive: true });
        await assert.rejects(fs.lstat(record.path), { code: "ENOENT" });
        run.evidence.disposal.push({ kind: "fresh-root-disposed", ...record });
      }
      run.evidence.disposed = true;
    });
  run.evidence.cleanupFailures = errors;
  if (!run.evidence.disposed) {
    run.evidence.disposal.push({
      kind: "fresh-roots-retained",
      reason: run.evidence.failure ? "case-failure" : "cleanup-unconfirmed",
    });
    // A known failed case retains its evidence even after clean cleanup. It is
    // never eligible for reuse, but retention alone is not an unknown process.
    if (!run.cleanQuit || errors.length || !run.closeAttempted)
      run.evidence.cleanupUnknown = true;
  }
  if (errors.length || run.evidence.cleanupUnknown)
    throw new Error("DAILY_DISPOSAL_UNCONFIRMED");
}
async function fresh(name) {
  const evidence = {
    name,
    status: "pending",
    observations: [],
    disposal: [],
    cleanupUnknown: false,
    disposed: false,
    roots: [],
  };
  report.cases.push(evidence);
  const run = {
    name,
    evidence,
    peers: [],
    tunnels: [],
    socketRoots: [],
    quitAttempted: false,
    closeAttempted: false,
    proof: randomUUID(),
  };
  try {
    // Required prefix belongs to the existing admission contract; this is always
    // a new allocation, never a lookup or adoption of prior fixture roots.
    for (const [key, prefix] of [
      ["home", "farol-next-e2e-home-"],
      ["auxiliary", "farol-guided-setup-"],
    ]) {
      const directory = await fs.realpath(
        await fs.mkdtemp(path.join(temporaryRoot, prefix)),
      );
      run[key] = { path: directory, identity: await identity(directory) };
      evidence.roots.push(run[key]);
      await fs.writeFile(
        path.join(directory, ".farol-next-e2e-root"),
        run.proof,
        { mode: 0o600, flag: "wx" },
      );
    }
    run.appData = path.join(run.home.path, "app-data");
    run.workspace = path.join(run.auxiliary.path, "approved-folder");
    await fs.mkdir(run.appData, { mode: 0o700 });
    await fs.mkdir(path.join(run.appData, "Farol Next Preview"), {
      mode: 0o700,
    });
    await fs.mkdir(run.workspace, { mode: 0o700 });
    await fs.writeFile(
      path.join(run.workspace, "sentinel.txt"),
      "daily disposable workspace\n",
      { mode: 0o600 },
    );
    run.tunnelExecutable = path.join(run.auxiliary.path, "daily-tunnel.cjs");
    await fs.writeFile(
      run.tunnelExecutable,
      `#!${process.execPath}\n${await fs.readFile(new URL("./connector-daily-tunnel.fixture.cjs", import.meta.url), "utf8")}`,
      { mode: 0o700 },
    );
    await fs.copyFile(
      new URL("./tunnel-client.fixture.cjs", import.meta.url),
      path.join(run.auxiliary.path, "tunnel-client.fixture.cjs"),
    );
    run.server = createServer((request, response) => {
      if (request.method !== "GET") {
        evidence.nonReadRequests = (evidence.nonReadRequests ?? 0) + 1;
        response.writeHead(405).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><title>Local lifecycle fixture</title><textarea id="prompt-textarea" aria-label="Fixture composer"></textarea>',
      );
    });
    await bounded(
      new Promise((resolve, reject) => {
        run.server.once("error", reject);
        run.server.listen(0, "127.0.0.1", resolve);
      }),
      "DAILY_HTTP_LISTEN_TIMEOUT",
      5000,
    );
    run.fixtureUrl = `http://127.0.0.1:${run.server.address().port}/`;
    return run;
  } catch (error) {
    evidence.failure = failure(error);
    evidence.status = "failed";
    evidence.cleanupFailures = [];
    // No native launch has been dispatched. Dispose only allocations made by
    // this invocation; any incomplete proof retains that exact root.
    if (run.server?.listening) {
      try {
        await bounded(
          new Promise((resolve, reject) => {
            run.server.close((cause) => (cause ? reject(cause) : resolve()));
            run.server.closeAllConnections();
          }),
          "DAILY_PREPARATION_HTTP_CLOSE_TIMEOUT",
          5000,
        );
        evidence.disposal.push({
          kind: "loopback-server-close",
          status: "returned",
        });
      } catch (cause) {
        evidence.cleanupFailures.push(failure(cause));
      }
    }
    for (const record of evidence.roots) {
      try {
        await sameRoot(record);
        assert.equal(
          await fs.readFile(
            path.join(record.path, ".farol-next-e2e-root"),
            "utf8",
          ),
          run.proof,
        );
        await fs.rm(record.path, { recursive: true });
        await assert.rejects(fs.lstat(record.path), { code: "ENOENT" });
        evidence.disposal.push({ kind: "fresh-root-disposed", ...record });
      } catch (cause) {
        evidence.cleanupFailures.push(failure(cause));
        evidence.disposal.push({
          kind: "fresh-root-retained",
          ...record,
          reason: "preparation-proof-unconfirmed",
        });
      }
    }
    evidence.disposed = evidence.cleanupFailures.length === 0;
    evidence.cleanupUnknown = !evidence.disposed;
    evidence.disposal.push({
      kind: "original-electron-close",
      status: "not-launched",
    });
    throw error;
  }
}

let primary;
try {
  for (const name of [
    "healthy-simulated-suspend-resume",
    "exact-owned-tunnel-term-recovery",
    "normal-quit",
  ]) {
    const run = await fresh(name);
    let caseError;
    try {
      // Each phase has its own finite bound. Do not race this entire chain:
      // an expired outer Promise.race would leave later effects running while
      // cleanup begins. Only an already dispatched original effect may settle.
      await launch(run);
      await setup(run);
      await exercise(run);
      await normalQuit(run);
      assert.equal(
        run.evidence.nonReadRequests ?? 0,
        0,
        "DAILY_BROWSER_SEND_OCCURRED",
      );
    } catch (error) {
      caseError = error;
      run.evidence.failure = failure(error);
    }
    try {
      await dispose(run);
    } catch (error) {
      caseError ??= error;
      run.evidence.failure ??= failure(error);
    }
    run.evidence.status = caseError ? "failed" : "passed";
    if (caseError) throw caseError; // No unknown retry or successor case.
  }
} catch (error) {
  primary = error;
  report.failure = failure(error);
} finally {
  report.status = primary ? "failed" : "passed";
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      status: report.status,
      receipt: destination,
      limits: report.limits,
    }),
  );
}
if (primary) throw primary;
