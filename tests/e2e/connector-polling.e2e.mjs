import { pollingTunnelStore } from "./lib/polling-tunnel-store.mjs";
import { readNativePreviewEcho } from "./lib/native-preview-echo.mjs";
// Exact attested Dev Electron/Go, synthetic loopback child and disposable roots.
// No installed profile, live provider/control plane, actual OS sleep or effect.
// --go-callback-delay adds one original Go SIGSTOP/SIGCONT while the real main
// loop is blocked. --network-loss closes the helper's loopback connections (no
// HTTP status) for a bounded window, then restores them; the product must show a
// degraded status, probe on its documented backoff and recover on its own.
// A failure retains its original profile/report; never replay.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
import {
  ELECTRON_RUNTIME,
  observeElectronRuntime,
  assertRuntimeObservation,
} from "../../tooling/runtime-contract.mjs";
import {
  assertNativePreviewAdmission,
  recheckNativePreviewIsolation,
  readOwnedStartupMarker,
} from "./native-preview-admission.mjs";
import { startControlledChatGptSite } from "./fixtures/chatgpt-controlled-site.mjs";
import { waitForReactShell } from "./current-react-setup.mjs";

const args = process.argv.slice(2);
assert.ok(
  JSON.stringify(args) === '["--run-native"]' ||
    JSON.stringify(args) === '["--run-native","--go-callback-delay"]' ||
    JSON.stringify(args) === '["--run-native","--health-status"]' ||
    JSON.stringify(args) === '["--run-native","--network-loss"]',
  "POLLING_NATIVE_ARGUMENTS",
);
const goDelay = args.includes("--go-callback-delay");
const healthStatus = args.includes("--health-status");
const networkLoss = args.includes("--network-loss");
assert.equal(process.platform, "darwin");
const root = process.cwd(),
  source = sourceIdentity(root),
  buildRoot = path.join(root, "_output/build/app");
const qualified = await qualifyGoBuild(buildRoot, source);
assertRuntimeObservation(
  await observeElectronRuntime(path.join(root, "node_modules/electron")),
  ELECTRON_RUNTIME,
);
const temporary = await fs.realpath(os.tmpdir()),
  proof = randomUUID();
const home = await fs.realpath(
  await fs.mkdtemp(path.join(temporary, "farol-next-e2e-home-")),
);
const auxiliary = await fs.realpath(
  await fs.mkdtemp(path.join(temporary, "farol-guided-setup-")),
);
for (const directory of [home, auxiliary]) {
  await fs.chmod(directory, 0o700);
  await fs.writeFile(path.join(directory, ".farol-next-e2e-root"), proof, {
    mode: 0o600,
    flag: "wx",
  });
}
const appData = path.join(home, "app-data"),
  userData = path.join(appData, "Farol Dev"),
  workspace = path.join(auxiliary, "approved-folder");
for (const directory of [appData, userData, workspace])
  await fs.mkdir(directory, { mode: 0o700 });
const canary = Buffer.from("Synthetic polling native canary\n");
await fs.writeFile(path.join(workspace, "sentinel.txt"), canary, {
  mode: 0o600,
  flag: "wx",
});
const executable = path.join(auxiliary, "polling-tunnel.cjs");
await fs.writeFile(
  executable,
  `#!${process.execPath}\n${await fs.readFile(new URL("./connector-polling-tunnel.fixture.cjs", import.meta.url), "utf8")}`,
  { mode: 0o700, flag: "wx" },
);
await fs.copyFile(
  new URL("./tunnel-client.fixture.cjs", import.meta.url),
  path.join(auxiliary, "tunnel-client.fixture.cjs"),
);
const state = path.join(userData, "farol-next-state"),
  tunnelStore = pollingTunnelStore(path.join(state, "secure-mcp-connector"));
const evidence = path.join(
  root,
  "_output/evidence",
  `connector-polling-${randomUUID()}.json`,
);
const report = {
  source,
  buildId: qualified.identity.buildId,
  home,
  auxiliary,
  healthStatus,
  networkLoss,
  fault: networkLoss
    ? "synthetic-loopback-connection-loss-and-restore"
    : goDelay
      ? "original-Go-paused-main-loop-delay-resume"
      : "HTTP-polling-and-main-loop-delay",
  status: "preparing",
  launches: [],
  limits:
    "Real hidden Dev Electron and attested Go/private IPC, synthetic loopback tunnel metrics and controlled provider fixture. No live control plane, actual OS sleep, production profile, interrupted workspace/provider effect, arbitrary descendant or installed acceptance.",
};
await fs.mkdir(path.dirname(evidence), { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const transient = new Set([
  "application",
  "child",
  "page",
  "pending",
  "ended",
  "closed",
  "quitRequest",
  "settingsBeforeQuit",
]);
const save = () =>
  fs.writeFile(
    evidence,
    JSON.stringify(
      report,
      (key, value) => (transient.has(key) ? undefined : value),
      2,
    ) + "\n",
    {
      mode: 0o600,
    },
  );
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function bounded(promise, label, milliseconds = 15000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function poll(read, accept, label, milliseconds = 15000) {
  const until = Date.now() + milliseconds;
  do {
    const result = await read();
    if (accept(result)) return result;
    await delay(25);
  } while (Date.now() < until);
  throw new Error(label);
}
const receiptList = tunnelStore.receipts;
const control = tunnelStore.control;

function children(parent) {
  let ids;
  try {
    ids = execFileSync("/usr/bin/pgrep", ["-P", String(parent)], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/u);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  assert.ok(ids.length <= 32 && ids.every((id) => /^[1-9][0-9]*$/u.test(id)));
  return execFileSync(
    "/bin/ps",
    ["-ww", "-p", ids.join(","), "-o", "pid=,ppid=,command="],
    { encoding: "utf8", maxBuffer: 32768 },
  )
    .trim()
    .split("\n")
    .map((line) => {
      const found = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      assert.ok(found);
      assert.equal(Number(found[2]), parent);
      return { pid: Number(found[1]), command: found[3] };
    });
}
function absent(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
  return false;
}
function captureLifecycle(run, child) {
  run.lifecycle = [];
  let buffered = "",
    bytes = 0;
  child.stderr?.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024 || run.lifecycle.length >= 64) {
      run.lifecycleBudgetExceeded = true;
      return;
    }
    buffered += chunk.toString("utf8");
    if (Buffer.byteLength(buffered) > 65536) {
      run.lifecycleBudgetExceeded = true;
      buffered = "";
      return;
    }
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const prefix = "FAROL_BACKEND_LIFECYCLE:";
      if (!line.startsWith(prefix)) continue;
      try {
        const value = JSON.parse(line.slice(prefix.length));
        if (
          !["go-backend", "connector-tunnel", "connector-anchor"].includes(
            value.source,
          ) ||
          !["startup", "active", "closing"].includes(value.phase) ||
          ![
            "failure",
            "child-close",
            "cleanup-unknown",
            "exit",
            "close",
            "error",
            "disconnect",
            "invalid-receipt",
          ].includes(value.event) ||
          !["observed", "outcome_unknown", "unavailable"].includes(
            value.state,
          ) ||
          !/^[A-Za-z_]{1,96}$/u.test(value.code) ||
          typeof value.forced !== "boolean"
        )
          continue;
        const entry = {
          source: value.source,
          phase: value.phase,
          event: value.event,
          state: value.state,
          code: value.code,
          forced: value.forced,
          exitCode: Number.isSafeInteger(value.exitCode)
            ? value.exitCode
            : null,
          signal:
            typeof value.signal === "string" &&
            /^SIG[A-Z0-9]{1,16}$/u.test(value.signal)
              ? value.signal
              : null,
        };
        for (const key of [
          "hostLifetimeId",
          "childLaunchId",
          "runtimeGeneration",
        ])
          if (
            typeof value[key] === "string" &&
            /^[a-f0-9-]{16,64}$/u.test(value[key])
          )
            entry[key] = value[key];
        if (run.lifecycle.length < 64) run.lifecycle.push(entry);
      } catch {
        run.lifecycleInvalid = true;
      }
    }
  });
}

let site, admission, activeRun;
async function launch(ordinal) {
  const run = {
    ordinal,
    status: "launching",
    observations: [],
    quitAttempted: false,
  };
  report.launches.push(run);
  await save();
  activeRun = run;
  const options = {
    executablePath: path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    env: {
      HOME: home,
      TMPDIR: temporary,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      FAROL_NEXT_ENVIRONMENT: "dev",
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_TEST_ROOT: home,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
      FAROL_NEXT_E2E_WORKSPACE_ROOT: workspace,
      FAROL_NEXT_E2E_CHATGPT_URL: site.url,
      FAROL_NEXT_E2E_TUNNEL_CLIENT: executable,
    },
    timeout: 15000,
  };
  const preflight = await assertNativePreviewAdmission(undefined, {
    profileRoot: home,
    auxiliaryRoot: auxiliary,
    proof,
    launchOptions: options,
    fixture: site.server,
    ...(admission ? { previous: admission } : {}),
  });
  run.pending = electron.launch(options).then((application) => {
    run.application = application;
    run.child = application.process();
    run.pid = run.child.pid;
    captureLifecycle(run, run.child);
    run.ended = new Promise((resolve) =>
      run.child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    run.closed = new Promise((resolve) =>
      run.child.once("close", (code, signal) => resolve({ code, signal })),
    );
    return application;
  });
  await bounded(run.pending, "POLLING_LAUNCH_UNKNOWN", 20000);
  const { page, actual } = await bounded(
    readNativePreviewEcho(run.application),
    "POLLING_NATIVE_ECHO_UNKNOWN",
    20000,
  );
  run.page = page;
  run.actualNative = actual;
  await save();
  assert.equal(actual.pid, run.pid);
  assert.equal(actual.home, home);
  assert.equal(actual.userData, userData);
  assert.equal(actual.sessionData, userData);
  assert.equal(await fs.realpath(actual.home), home);
  assert.equal(await fs.realpath(actual.userData), userData);
  run.pathIdentityConfirmed = true;
  admission = await recheckNativePreviewIsolation(preflight, actual, run.child);
  run.isolated = true;
  assert.equal(actual.name, "Farol Dev");
  assert.equal(actual.isPackaged, false);
  assert.equal(actual.userData, userData);
  await waitForReactShell(run.page);
  await poll(
    () => run.page.evaluate(() => window.farolNext.bootstrap()),
    (value) => value.configuration?.status === "ready",
    "POLLING_SETTINGS_NOT_READY",
  );
  run.marker = await readOwnedStartupMarker(state, home, run.pid);
  const backends = children(run.pid).filter((value) =>
    value.command.includes("farol-backend"),
  );
  assert.equal(backends.length, 1);
  run.backend = backends[0];
  assert.ok(run.backend.command.includes(buildRoot));
  assert.ok(run.backend.command.includes(state));
  run.native = {
    home: actual.home,
    userData: actual.userData,
    backendPid: run.backend.pid,
    backendCommandSHA256: hash(run.backend.command),
    hidden: actual.windows,
  };
  run.status = "ready";
  await save();
  return run;
}
const bootstrap = (run) =>
  run.page.evaluate(() => window.farolNext.bootstrap());
async function configure(run, command) {
  const result = await bounded(
    run.page.evaluate((value) => window.farolNext.configure(value), command),
    `POLLING_CONFIGURE_UNKNOWN:${command.kind}`,
    20000,
  );
  assert.equal(
    result.ok,
    true,
    `POLLING_CONFIGURE_FAILED:${command.kind}:${result.error ?? "unknown"}`,
  );
  return result;
}
async function hidden(run) {
  const windows = await run.application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
    })),
  );
  assert.ok(
    windows.length &&
      windows.every((value) => !value.visible && !value.focused),
  );
}
async function diagnosticPage(run) {
  await run.page
    .getByRole("navigation", { name: "Sections", exact: true })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await run.page
    .locator(".contextual-sidebar")
    .getByRole("button", { name: "Diagnostics", exact: true })
    .click();
  await run.page
    .getByRole("button", { name: "Check local connection", exact: true })
    .waitFor();
}
async function startCheck(run) {
  const observation = await run.page.evaluateHandle(() => {
    const page = [...document.querySelectorAll(".settings-page")].find((node) =>
      node.checkVisibility(),
    );
    if (!page) throw Error("POLLING_UI_MISSING");
    const read = () =>
      [...page.querySelectorAll(':scope > p[role="status"]')]
        .map((node) => node.textContent?.slice(0, 2048))
        .slice(0, 16);
    const before = JSON.stringify(read());
    const value = {
      result: null,
      observer: null,
      latest: read(),
      changed: false,
      pendingSeen: false,
    };
    value.observer = new MutationObserver(() => {
      const texts = read();
      value.latest = texts;
      value.changed ||= JSON.stringify(texts) !== before;
      value.pendingSeen ||= texts.includes("Saving or checking…");
      if (
        value.changed &&
        texts.length &&
        !texts.includes("Saving or checking…")
      )
        value.result = texts;
    });
    value.observer.observe(page, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return value;
  });
  await run.page
    .getByRole("button", { name: "Check local connection", exact: true })
    .click();
  return async () => {
    try {
      await run.page.waitForFunction(
        (value) => value.result !== null,
        observation,
        { timeout: 25000 },
      );
      return await observation.evaluate((value) => value.result);
    } catch (error) {
      run.lastUiReadback = await observation
        .evaluate((value) => ({
          messages: value.latest,
          changed: value.changed,
          pendingSeen: value.pendingSeen,
        }))
        .catch(() => ({ unavailable: true }));
      await save();
      throw error;
    } finally {
      await observation
        .evaluate((value) => value.observer.disconnect())
        .catch(() => {});
      await observation.dispose();
    }
  };
}
async function check(run, mode, expected, fault) {
  await control(mode);
  const before = (await receiptList()).find(
    (value) => value.phase === "running",
  );
  assert.ok(before);
  const settingsHash = hash(await fs.readFile(path.join(state, "config.json")));
  const initial = await bootstrap(run);
  assert.equal(initial.configuration.status, "ready");
  const current = initial.configuration.settings.connectors.secureMcp.runtime;
  const finish = await startCheck(run);
  await poll(
    receiptList,
    (values) =>
      values.some(
        (value) =>
          value.id === before.id &&
          value.metricsRequests === before.metricsRequests + 1 &&
          value.lastMode === mode,
      ),
    "POLLING_REQUEST_NOT_OBSERVED",
  );
  if (fault) await fault();
  const messages = await finish();
  const after = await bootstrap(run);
  const projection = {
    mode,
    messages,
    settingsStatus: after.configuration?.status,
    originalHelperPid: before.pid,
    backendPid: run.backend.pid,
    receipts: await receiptList(),
  };
  run.observations.push(projection);
  await save();
  assert.ok(
    messages.some((text) => text.includes(expected)),
    `POLLING_UI_RESULT:${messages.join(" | ")}`,
  );
  assert.equal(after.configuration.status, "ready");
  assert.deepEqual(
    after.configuration.settings.connectors.secureMcp.runtime,
    current,
  );
  assert.equal(
    hash(await fs.readFile(path.join(state, "config.json"))),
    settingsHash,
  );
  assert.equal(projection.receipts.length, run.ordinal);
  assert.ok(
    projection.receipts.some(
      (value) =>
        value.id === before.id &&
        value.phase === "running" &&
        value.metricsRequests === before.metricsRequests + 1,
    ),
  );
  assert.deepEqual(
    children(run.pid).filter((value) => value.pid === run.backend.pid),
    [run.backend],
  );
  const ledger = site.driver.snapshot();
  assert.equal(ledger.attemptedSends, 0);
  assert.equal(ledger.acceptedSends, 0);
  assert.deepEqual(ledger.ledger, []);
  await hidden(run);
}
async function checkHealthStatus(run, mode, expected) {
  const before = (await receiptList()).find(
    (value) => value.phase === "running",
  );
  assert.ok(before);
  const settingsHash = hash(await fs.readFile(path.join(state, "config.json")));
  await tunnelStore.controlHealth(mode);
  // Wait for a fresh read through the original passive tracker. A suspend
  // fallback or request-start counter cannot certify the selected Go result.
  const settlement = await bounded(
    run.application.evaluate(
      () =>
        new Promise((resolve, reject) => {
          if (!process.emit("farol-e2e-observe-connection", resolve))
            reject(new Error("HEALTH_OBSERVER_SEAM_UNAVAILABLE"));
        }),
    ),
    "HEALTH_OBSERVATION_SETTLEMENT_UNKNOWN",
  );
  assert.equal(settlement.settled, true);
  assert.equal(settlement.view.state, expected);
  await poll(
    receiptList,
    (values) =>
      values.some(
        (v) =>
          v.id === before.id &&
          v.healthRequests > before.healthRequests &&
          v.lastHealthMode === mode &&
          v.lastHealthSettlement?.sequence > before.healthRequests &&
          v.lastHealthSettlement.mode === mode &&
          v.lastHealthSettlement.outcome ===
            (mode === "hold" ? "aborted" : "completed") &&
          (mode !== "hold" || v.lastHealthSettlement.durationMillis >= 900),
      ),
    "HEALTH_STATUS_READ_NOT_OBSERVED",
  );
  const current = await poll(
    () => bootstrap(run),
    (v) => v.connectionStatus?.state === expected,
    "HEALTH_STATUS_NOT_PUBLISHED",
  );
  const card = run.page.locator(".connection-live-status");
  await poll(
    () => card.getAttribute("data-state"),
    (v) => v === expected,
    "HEALTH_STATUS_UI_NOT_CURRENT",
  );
  assert.ok((await card.innerText()).includes(current.connectionStatus.label));
  assert.equal(
    hash(await fs.readFile(path.join(state, "config.json"))),
    settingsHash,
  );
  const after = await receiptList();
  assert.equal(after.length, run.ordinal);
  assert.ok(
    after.some(
      (v) =>
        v.id === before.id && v.pid === before.pid && v.phase === "running",
    ),
  );
  assert.deepEqual(
    children(run.pid).filter((v) => v.pid === run.backend.pid),
    [run.backend],
  );
  assert.equal(site.driver.snapshot().attemptedSends, 0);
  assert.equal(site.driver.snapshot().acceptedSends, 0);
  await hidden(run);
  run.observations.push({
    healthMode: mode,
    selectedObservationSettlement: settlement,
    healthStatus: current.connectionStatus,
    originalHelperPid: before.pid,
    backendPid: run.backend.pid,
    receipts: after,
    settingsUnchanged: true,
    limits:
      "Synthetic producer health with actual passive-observation settlement; hidden Electron/Go IPC/UI, no Tray or upstream/OS-sleep evidence.",
  });
  await save();
}

// Product contract this scenario measures (apps/desktop/connector-transport-watch.ts):
// the 30 s transport timer starts one observation ladder of /readyz probes at
// delays 0, 1 s, 5 s and 15 s after the previous one, then at most one recovery
// per original runtime. The same timer also samples /health for the status.
const LADDER_DELAYS_MILLIS = [0, 1000, 5000, 15000];
const TRANSPORT_TICK_MILLIS = 30000;
const settleConnection = (run) =>
  bounded(
    run.application.evaluate(
      () =>
        new Promise((resolve, reject) => {
          if (!process.emit("farol-e2e-observe-connection", resolve))
            reject(new Error("HEALTH_OBSERVER_SEAM_UNAVAILABLE"));
        }),
    ),
    "NETWORK_LOSS_OBSERVATION_UNSETTLED",
  );
const runningReceipt = async () => {
  const value = (await receiptList()).find((v) => v.phase === "running");
  if (!value) throw new Error("NETWORK_LOSS_HELPER_NOT_RUNNING");
  return value;
};
async function checkNetworkLoss(run) {
  const loss = { ladderDelaysMillis: LADDER_DELAYS_MILLIS };
  run.observations.push({ networkLoss: loss });
  const settingsHash = hash(await fs.readFile(path.join(state, "config.json")));
  const runtimeBefore = (await bootstrap(run)).configuration.settings.connectors
    .secureMcp.runtime;
  await tunnelStore.controlHealth("recent");
  await tunnelStore.controlNetwork("reachable");
  const baseline = await settleConnection(run);
  assert.equal(baseline.settled, true);
  assert.equal(baseline.view.state, "recent_transport");
  loss.baseline = { state: baseline.view.state, label: baseline.view.label };
  const helper = await runningReceipt();
  assert.ok(helper);
  assert.equal(helper.loss, undefined);
  // Align to the product's own timer: startup polls /readyz in a burst, the
  // transport tick then probes it once per 30 s. Cut the transport just after
  // a tick so the next tick lands inside the window.
  let last = (await runningReceipt()).readyRequests,
    changedAt = Date.now();
  const tick = await poll(
    async () => {
      const value = (await runningReceipt()).readyRequests;
      const now = Date.now();
      const quiet = now - changedAt;
      const moved = value !== last;
      if (moved) {
        last = value;
        changedAt = now;
      }
      return { moved, quiet, at: now };
    },
    (value) => value.moved && value.quiet >= 1500,
    "NETWORK_LOSS_TRANSPORT_TICK_NOT_OBSERVED",
    TRANSPORT_TICK_MILLIS * 2 + 10000,
  );
  loss.alignedTickAt = tick.at;
  await delay(1200);
  const readyBefore = (await runningReceipt()).readyRequests;
  loss.readyRequestsBeforeLoss = readyBefore;
  await save();
  const lostAt = Date.now();
  await tunnelStore.controlNetwork("lost");
  loss.lostAt = lostAt;
  await save();
  // Live degraded status while the transport is unreachable, before any tick.
  const duringSettlement = await settleConnection(run);
  assert.equal(duringSettlement.settled, true);
  loss.duringLoss = {
    afterMillis: Date.now() - lostAt,
    state: duringSettlement.view.state,
    label: duringSettlement.view.label,
    detail: duringSettlement.view.detail,
    attention: duringSettlement.view.attention,
  };
  await save();
  assert.notEqual(duringSettlement.view.state, "recent_transport");
  assert.notEqual(duringSettlement.view.state, "stopped");
  const card = run.page.locator(".connection-live-status");
  loss.duringLoss.uiState = await poll(
    () => card.getAttribute("data-state"),
    (value) => value !== "recent_transport",
    "NETWORK_LOSS_UI_STILL_GREEN",
  );
  // The product's own ladder: wait for its third probe (delays 0, 1 s, 5 s),
  // then restore well before the fourth (15 s later).
  const probed = await poll(
    runningReceipt,
    (value) => (value.loss?.readyz ?? 0) >= 3,
    "NETWORK_LOSS_LADDER_NOT_OBSERVED",
    TRANSPORT_TICK_MILLIS + 25000,
  );
  // Still degraded when the third probe fails, not only right after the cut.
  const degraded = (await bootstrap(run)).connectionStatus;
  assert.notEqual(degraded.state, "recent_transport");
  const restoredAt = Date.now();
  await tunnelStore.controlNetwork("reachable");
  loss.restoredAt = restoredAt;
  loss.windowMillis = restoredAt - lostAt;
  loss.atRestore = {
    state: degraded.state,
    readyz: probed.loss.readyz,
    health: probed.loss.health,
    connections: probed.loss.connections,
    requests: probed.loss.requests,
  };
  await save();
  // No click, no seam, no restart: only the product's own timers may recover.
  const recovered = await poll(
    () => bootstrap(run),
    (value) => value.connectionStatus?.state === "recent_transport",
    "NETWORK_LOSS_NOT_RECOVERED",
    TRANSPORT_TICK_MILLIS * 2 + 10000,
  );
  const recoveredAt = Date.now();
  loss.recoveredAfterMillis = recoveredAt - restoredAt;
  loss.recoveredStatus = {
    state: recovered.connectionStatus.state,
    label: recovered.connectionStatus.label,
  };
  await poll(
    () => card.getAttribute("data-state"),
    (value) => value === "recent_transport",
    "NETWORK_LOSS_UI_NOT_RECOVERED",
  );
  // The next tick's own healthy /readyz and /health stamps come right after
  // the status turned recent; wait for both before reading the ledger.
  const final = await poll(
    runningReceipt,
    (value) =>
      value.loss.log.filter(
        (v) => v.at > restoredAt && v.kind === "ok GET /readyz",
      ).length >= 2 &&
      value.loss.log.some(
        (v) => v.at > restoredAt && v.kind === "ok GET /health?details=true",
      ),
    "NETWORK_LOSS_NEXT_TICK_NOT_OBSERVED",
    5000,
  );
  const events = final.loss.log.map((value) => ({
    atMillis: value.at - lostAt,
    kind: value.kind,
  }));
  loss.final = {
    counters: {
      connections: final.loss.connections,
      requests: final.loss.requests,
      readyz: final.loss.readyz,
      health: final.loss.health,
      metrics: final.loss.metrics,
      other: final.loss.other,
    },
    readyRequestsAfter: final.readyRequests,
    events,
  };
  const failed = events.filter((value) => value.kind === "GET /readyz");
  const served = events.filter((value) => value.kind === "ok GET /readyz");
  const servedHealth = events.filter(
    (value) => value.kind === "ok GET /health?details=true",
  );
  const offsets = failed.map((value) => value.atMillis);
  // The fourth ladder probe is the first healthy /readyz after the restore.
  const fourth = served.find((value) => value.atMillis > restoredAt - lostAt);
  const nextTick = servedHealth.find(
    (value) => value.atMillis > restoredAt - lostAt,
  );
  assert.ok(fourth && nextTick, "NETWORK_LOSS_FOURTH_PROBE_MISSING");
  loss.readyzProbeOffsetsMillis = [...offsets, fourth.atMillis];
  loss.ladderIntervalsMillis = loss.readyzProbeOffsetsMillis
    .slice(1)
    .map((value, index) => value - loss.readyzProbeOffsetsMillis[index]);
  loss.nextTickStatusReadOffsetMillis = nextTick.atMillis;
  loss.recoveredOffsetMillis = recoveredAt - lostAt;
  await save();
  // Exact ladder, grounded in measured runs: intervals land 0 to 10 ms after
  // their documented delay (a timer never fires early). Allow 50 ms early and
  // 750 ms late for a loaded Mac; a skipped, early or hammering step is far
  // outside that, and the next 30 s tick is 9 s away from the fourth probe.
  const EARLY = 50,
    LATE = 750,
    TICK_SLACK = 1000;
  assert.equal(
    failed.length,
    LADDER_DELAYS_MILLIS.length - 1,
    `NETWORK_LOSS_FAILED_PROBES:${failed.length}`,
  );
  assert.equal(final.loss.readyz, failed.length);
  // First probe: the next 30 s tick after the cut, measured from the outage
  // start (the harness cut the transport this long after the aligned tick).
  const expectedFirst = TRANSPORT_TICK_MILLIS - (lostAt - tick.at);
  loss.expectedFirstProbeOffsetMillis = expectedFirst;
  assert.ok(
    Math.abs(offsets[0] - expectedFirst) <= TICK_SLACK,
    `NETWORK_LOSS_FIRST_PROBE_OFFSET:${offsets[0]}:${expectedFirst}`,
  );
  loss.ladderIntervalsMillis.forEach((interval, index) => {
    const delayMillis = LADDER_DELAYS_MILLIS[index + 1];
    assert.ok(
      interval >= delayMillis - EARLY && interval <= delayMillis + LATE,
      `NETWORK_LOSS_LADDER_INTERVAL:${index + 1}:${interval}:${delayMillis}`,
    );
  });
  assert.equal(
    loss.ladderIntervalsMillis.length,
    LADDER_DELAYS_MILLIS.length - 1,
  );
  // The fourth probe is the only healthy /readyz before the next tick.
  assert.ok(
    served.filter((value) => value.atMillis > restoredAt - lostAt).length ===
      2 &&
      served.filter((value) => value.atMillis > restoredAt - lostAt)[1]
        .atMillis -
        offsets[0] >=
        TRANSPORT_TICK_MILLIS - TICK_SLACK,
    "NETWORK_LOSS_EXTRA_PROBE",
  );
  // Status turns recent only from the next tick's status read (/health), 30 s
  // after the first probe, not from the fourth probe or any harness action.
  assert.ok(
    Math.abs(nextTick.atMillis - offsets[0] - TRANSPORT_TICK_MILLIS) <=
      TICK_SLACK,
    `NETWORK_LOSS_NEXT_TICK:${nextTick.atMillis - offsets[0]}`,
  );
  assert.ok(
    loss.recoveredOffsetMillis >= nextTick.atMillis - 50 &&
      loss.recoveredOffsetMillis - fourth.atMillis >= TICK_SLACK,
    `NETWORK_LOSS_RECOVERY_ORDER:${loss.recoveredOffsetMillis}`,
  );
  // Status reads while lost: product tick(s) plus this harness's one settle.
  const ticksInWindow = Math.ceil(loss.windowMillis / TRANSPORT_TICK_MILLIS);
  assert.ok(
    final.loss.health <= 2 + ticksInWindow,
    `NETWORK_LOSS_HEALTH_READS:${final.loss.health}`,
  );
  assert.equal(final.loss.metrics, 0);
  assert.equal(final.loss.other, 0);
  loss.attemptsPerSecond = Number(
    (final.loss.requests / (loss.windowMillis / 1000)).toFixed(3),
  );
  // No second owner/tunnel generation: the same helper, backend and runtime.
  const receipts = await receiptList();
  assert.equal(receipts.length, run.ordinal);
  assert.ok(
    receipts.some(
      (value) =>
        value.id === helper.id &&
        value.pid === helper.pid &&
        value.phase === "running",
    ),
  );
  assert.deepEqual(
    children(run.pid).filter((value) => value.pid === run.backend.pid),
    [run.backend],
  );
  const after = await bootstrap(run);
  assert.equal(after.configuration.status, "ready");
  assert.deepEqual(
    after.configuration.settings.connectors.secureMcp.runtime,
    runtimeBefore,
  );
  assert.equal(
    hash(await fs.readFile(path.join(state, "config.json"))),
    settingsHash,
  );
  assert.ok(
    !run.lifecycle.some(
      (value) =>
        value.source === "connector-tunnel" ||
        value.event === "child-close" ||
        value.event === "failure",
    ),
    "NETWORK_LOSS_TUNNEL_LIFECYCLE_EVENT",
  );
  loss.originalHelperPid = helper.pid;
  loss.backendPid = run.backend.pid;
  loss.receipts = receipts;
  loss.lifecycle = [...run.lifecycle];
  loss.limits =
    "Synthetic loopback helper closes connections (no HTTP status) for a bounded window; the Mac, its network and any real tunnel are untouched. Probes the product's /readyz ladder and /health status reads only; no live control plane, OS sleep or sustained outage (which would trigger the one-shot recovery).";
  assert.equal(site.driver.snapshot().attemptedSends, 0);
  assert.equal(site.driver.snapshot().acceptedSends, 0);
  await hidden(run);
  await save();
}

async function blockMain(run) {
  return bounded(
    run.application.evaluate(() => {
      const started = Date.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 16000);
      return { started, finished: Date.now() };
    }),
    "POLLING_MAIN_DELAY_UNKNOWN",
    25000,
  );
}
async function quit(run) {
  assert.equal(run.quitAttempted, false);
  assert.ok(
    run.isolated || run.pathIdentityConfirmed,
    "POLLING_CLEANUP_STORAGE_UNCONFIRMED",
  );
  run.quitAttempted = true;
  const requested = Date.now();
  run.quit = { requested };
  await save();
  run.quitRequest = run.application
    .evaluate(({ app }) => app.quit())
    .catch(() => undefined);
  run.quit.terminal = await bounded(
    run.ended,
    "POLLING_QUIT_TERMINAL_UNKNOWN",
    60000,
  );
  await bounded(run.closed, "POLLING_MAIN_STREAMS_UNKNOWN", 5000);
  const receipt = JSON.parse(
    await fs.readFile(path.join(state, "last-quit.json"), "utf8"),
  );
  run.quit.receipt = receipt;
  await save();
  assert.deepEqual(run.quit.terminal, { code: 0, signal: null });
  assert.ok(Date.parse(receipt.at) >= requested);
  assert.equal(receipt.drained, true);
  assert.deepEqual(receipt.unconfirmed, []);
  await assert.rejects(fs.lstat(path.join(state, "running.json")), {
    code: "ENOENT",
  });
  await poll(
    async () => absent(run.backend.pid),
    Boolean,
    "POLLING_BACKEND_RETAINED",
  );
  const records = await receiptList();
  assert.ok(
    records.every((value) => value.phase === "exited" && value.exitCode === 0),
  );
  for (const value of records) {
    assert.ok(absent(value.pid));
    assert.ok(absent(value.parentPid));
  }
  run.status = "clean-quit";
  await save();
}
try {
  await save();
  site = await startControlledChatGptSite({
    conversationId: "polling-no-send-conversation",
    selection: { model: "Startup fixture", effort: "Light", connector: null },
    turns: [
      {
        userId: "polling-user",
        replyId: "polling-reply",
        prompt: "No Send is authorized",
        segments: [
          { id: "polling-text", text: "Synthetic unrequested answer" },
        ],
      },
    ],
  });
  // The shared admission contract requires the owned origin root. Alias that
  // exact GET to the same controlled document; no guard or origin is widened.
  site.server.prependListener("request", (request) => {
    if (request.method === "GET" && request.url === "/")
      request.url = "/chatgpt";
  });
  site.url = site.origin + "/";
  const first = await launch(1);
  await configure(first, { kind: "connector.select-client" });
  await configure(first, {
    kind: "connector.configure",
    tunnelId: "polling_owned_fixture",
    runtimeKey: "synthetic-polling-owned-runtime-key",
  });
  const added = await configure(first, {
    kind: "computer.add-workspace",
    access: "read",
  });
  await configure(first, {
    kind: "computer.verify-workspace",
    workspaceId: added.evidence.workspaceId,
  });
  await configure(first, { kind: "connector.start" });
  await poll(
    receiptList,
    (values) => values.length === 1 && values[0].phase === "running",
    "POLLING_HELPER_NOT_RUNNING",
  );
  if (networkLoss) {
    await diagnosticPage(first);
    await first.page
      .locator(".contextual-sidebar")
      .getByRole("button", { name: "Connection", exact: true })
      .click();
    await first.page.locator(".connection-live-status").waitFor();
    await checkNetworkLoss(first);
    await tunnelStore.controlNetwork("reachable");
    await quit(first);
    assert.deepEqual(
      await fs.readFile(path.join(workspace, "sentinel.txt")),
      canary,
    );
    report.status =
      "passed-hidden-Go-network-loss-bounded-backoff-auto-recovery-same-generation";
    await save();
  } else {
    if (healthStatus) {
      await diagnosticPage(first);
      await first.page
        .locator(".contextual-sidebar")
        .getByRole("button", { name: "Connection", exact: true })
        .click();
      await first.page.locator(".connection-live-status").waitFor();
      for (const [mode, expected] of [
        ["http503", "unavailable"],
        ["http504", "unavailable"],
        ["auth401", "action_required"],
        ["stale", "unobserved"],
        ["first-poll", "checking"],
        ["backpressure", "checking"],
        ["future-failure", "unobserved"],
        ["malformed", "unobserved"],
        ["unsupported", "unobserved"],
        ["missing", "unobserved"],
        ["hold", "unobserved"],
      ]) {
        await checkHealthStatus(first, "recent", "recent_transport");
        await checkHealthStatus(first, mode, expected);
      }
      await tunnelStore.controlHealth("recent");
    }
    await diagnosticPage(first);
    for (const [mode, expected] of [
      ["recent", "The helper reported a recent server poll."],
      ["stale", "Server polling was delayed."],
      ["no_success", "The helper had not reported a successful server poll."],
      ["http503", "Server polling could not be confirmed."],
      ["http504", "Server polling could not be confirmed."],
      ["missing", "Server polling could not be confirmed."],
    ])
      await check(first, mode, expected);
    if (goDelay) {
      const exact = children(first.pid).find(
        (value) => value.pid === first.backend.pid,
      );
      assert.deepEqual(exact, first.backend);
      assert.equal(process.kill(first.backend.pid, "SIGSTOP"), true);
      first.goStopRequested = true;
      await save();
      await check(
        first,
        "recent",
        "The connection check expired. No polling result was published.",
        async () => {
          await delay(100);
          const blocked = blockMain(first);
          await delay(300);
          assert.deepEqual(
            children(first.pid).find(
              (value) => value.pid === first.backend.pid,
            ),
            first.backend,
          );
          assert.equal(process.kill(first.backend.pid, "SIGCONT"), true);
          first.goContinueRequested = true;
          first.mainDelay = await blocked;
          await save();
        },
      );
    } else {
      await check(
        first,
        "hold",
        "Server polling could not be confirmed.",
        async () => {
          first.mainDelay = await blockMain(first);
          assert.ok(
            first.mainDelay.finished - first.mainDelay.started >= 16000,
          );
          await save();
        },
      );
    }
    await control("recent");
    first.settingsBeforeQuit = (await bootstrap(first)).configuration.settings;
    await quit(first);
    const second = await launch(2);
    await poll(
      () => bootstrap(second),
      (value) =>
        value.configuration?.status === "ready" &&
        value.configuration.settings.connectors.secureMcp.runtime?.state ===
          "ready",
      "POLLING_RESUME_NOT_READY",
      20000,
    );
    await poll(
      receiptList,
      (values) =>
        values.length === 2 &&
        values.filter((value) => value.phase === "running").length === 1,
      "POLLING_SECOND_HELPER_MISSING",
    );
    const restored = (await bootstrap(second)).configuration.settings;
    assert.deepEqual(
      restored.computer.workspaces,
      first.settingsBeforeQuit.computer.workspaces,
    );
    assert.equal(
      restored.computer.computerId,
      first.settingsBeforeQuit.computer.computerId,
    );
    await diagnosticPage(second);
    await check(second, "recent", "The helper reported a recent server poll.");
    const helperBeforeStop = healthStatus
      ? (await receiptList()).find((value) => value.phase === "running")
      : undefined;
    await configure(second, { kind: "connector.stop" });
    if (healthStatus) {
      assert.ok(helperBeforeStop, "OWNER_STOP_ORIGINAL_HELPER_MISSING");
      const settlement = await bounded(
        second.application.evaluate(
          () =>
            new Promise((resolve, reject) => {
              if (!process.emit("farol-e2e-observe-connection", resolve))
                reject(new Error("HEALTH_OBSERVER_SEAM_UNAVAILABLE"));
            }),
        ),
        "OWNER_STOP_OBSERVATION_UNSETTLED",
      );
      assert.equal(settlement.settled, true);
      assert.equal(settlement.view.state, "stopped");
      assert.equal(settlement.view.label, "Stopped by owner");
      assert.ok(
        settlement.view.detail.includes("Polling history is not included"),
      );
      assert.ok(
        settlement.view.delivery.includes(
          "Response upload history is not included",
        ),
      );
      assert.ok(
        !settlement.view.detail.includes("No successful server poll observed"),
      );
      assert.ok(
        !settlement.view.delivery.includes(
          "No accepted response upload observed",
        ),
      );
      const current = await poll(
        () => bootstrap(second),
        (value) => value.connectionStatus?.state === "stopped",
        "OWNER_STOP_STATUS_NOT_PUBLISHED",
      );
      const card = second.page.locator(".connection-live-status");
      await poll(
        () => card.getAttribute("data-state"),
        (value) => value === "stopped",
        "OWNER_STOP_UI_NOT_CURRENT",
      );
      const cardText = await card.innerText();
      assert.ok(cardText.includes("Stopped by owner"));
      assert.ok(cardText.includes("Polling history is not included"));
      assert.ok(cardText.includes("Response upload history is not included"));
      assert.equal(
        current.configuration.settings.connectors.secureMcp.runtime,
        null,
      );
      const stoppedReceipts = await poll(
        receiptList,
        (values) =>
          values.length === 2 &&
          values.every(
            (value) => value.phase === "exited" && value.exitCode === 0,
          ),
        "OWNER_STOP_HELPER_NOT_CLOSED",
      );
      assert.ok(absent(helperBeforeStop.pid));
      assert.ok(absent(helperBeforeStop.parentPid));
      assert.deepEqual(
        children(second.pid).filter(
          (value) => value.pid === second.backend.pid,
        ),
        [second.backend],
      );
      assert.equal(site.driver.snapshot().attemptedSends, 0);
      assert.equal(site.driver.snapshot().acceptedSends, 0);
      // A second explicit Stop has no active Go binding. Retain the original
      // confirmed negative observation without starting another helper.
      await configure(second, { kind: "connector.stop" });
      const repeatSettlement = await bounded(
        second.application.evaluate(
          () =>
            new Promise((resolve, reject) => {
              if (!process.emit("farol-e2e-observe-connection", resolve))
                reject(new Error("HEALTH_OBSERVER_SEAM_UNAVAILABLE"));
            }),
        ),
        "OWNER_STOP_REPEAT_UNSETTLED",
      );
      assert.equal(repeatSettlement.settled, true);
      assert.equal(repeatSettlement.view.state, "stopped");
      assert.equal((await receiptList()).length, 2);
      await hidden(second);
      second.observations.push({
        ownerStop: {
          repeatSettlement,
          settlement,
          view: current.connectionStatus,
          helperBeforeStop,
          receipts: stoppedReceipts,
          originalBackendPid: second.backend.pid,
          limits:
            "Actual hidden Electron/Go/UI and owned helper closure; synthetic control plane, no Tray/OS-sleep/live-provider/installed acceptance.",
        },
      });
      await save();
    }
    await quit(second);
    assert.deepEqual(
      await fs.readFile(path.join(workspace, "sentinel.txt")),
      canary,
    );
    report.status = goDelay
      ? "passed-hidden-Go-polling-expired-observation-clean-reopen"
      : healthStatus
        ? "passed-hidden-Go-health-status-original-child-no-send-clean-reopen"
        : "passed-hidden-Go-polling-original-child-HTTP-delay-clean-reopen";
    await save();
  }
} catch (error) {
  report.status = "failed-or-unknown";
  report.failure = {
    message: String(error.message).slice(0, 1024),
    cause:
      typeof error.cause?.message === "string"
        ? error.cause.message.slice(0, 256)
        : null,
  };
  await save();
  if (
    activeRun?.application &&
    (activeRun.isolated || activeRun.pathIdentityConfirmed) &&
    !activeRun.quitAttempted
  ) {
    try {
      await quit(activeRun);
    } catch (cleanup) {
      report.cleanupFailure = String(cleanup.message).slice(0, 512);
      await save();
    }
  }
  throw error;
} finally {
  await site?.close();
  // No deletion of failed/unknown profiles, singleton directories or sockets.
  // Successful roots also remain for custody; retention is not acceptance.
  await save();
  process.stdout.write(
    JSON.stringify({ evidence, status: report.status }) + "\n",
  );
}
