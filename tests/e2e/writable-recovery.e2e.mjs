/**
 * Explicit hidden macOS Dev lane. Build clean committed bytes first:
 * task dev -- --check
 * node tests/e2e/writable-recovery.e2e.mjs --run-native
 *   --source-sha <exact committed SHA> --build-id <qualified build ID>
 * Optional --scenario normal|crash (default both), or explicit connector-failed-quit.
 * Never automatically rerun a scenario.
 * Synthetic loopback account/provider only. No installed/live-provider, OS sleep,
 * interrupted-effect or arbitrary-descendant qualification. Profiles are retained.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
import {
  ELECTRON_RUNTIME,
  assertRuntimeObservation,
  observeElectronRuntime,
} from "../../tooling/runtime-contract.mjs";
import {
  startChatGptFixture,
  stopChatGptFixture,
} from "./fixtures/chatgpt-site.mjs";
import { readCanary } from "./fixtures/go-read-discard-witness.mjs";
import {
  conversationId,
  conversationSeed,
  conversationScript,
  conversationJournalWitness,
  conversationQuitWitness,
  runConversationJourney,
} from "./lib/read-conversation-witness.mjs";
import {
  historyOriginals,
  runHistoryReadJourney,
} from "./lib/chat-history-witness.mjs";
import { reportRetiredJourney } from "../../tooling/setup-journey-retirement.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const buildRoot = path.join(root, "_output/build/app");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contract = {
  schema: "farol-writable-recovery-native/1",
  owned: "tests/e2e/writable-recovery.e2e.mjs",
  modes: [
    "--contract",
    "--run-native --source-sha SHA --build-id ID [--scenario normal|crash|connector-failed-quit] [--expect-restart normal-writable]",
  ],
  normal:
    "Normal main.cjs/Go -> approved disposable folder -> real Chat results/ACK/settlement -> Go-owned guarded File edit/read/result ACK -> ordinary confirmed Quit -> same-profile fresh writable generation -> original saved Chat answers/workspace/result -> second File edit/read/result ACK -> confirmed Quit",
  crash:
    "Fresh normal main.cjs/Go -> same real work -> exact observed Electron host SIGKILL -> observe original direct Go child absent -> one same-profile automatic preserving startup -> exact archived history/results and actual normal-session stored-copy UI -> new writable File ACK -> ordinary confirmed Quit",
  connectorFailedQuit:
    "Explicit only: normal main.cjs/attested Go + saved Chat/File work -> prove original Electron/anchor/synthetic tunnel ancestry -> one exact anchor SIGKILL with original tunnel still running -> ordinary app Quit -> require drained=false/unconfirmed=[connector], real original Go absence and unchanged run marker -> settle the nonce-bound owned tunnel -> one same-profile ordinary restart -> record actual normal/read-only/UI outcome and preservation; no forced recovery or success",
  limits: [
    "Synthetic loopback provider/account/tasks and disposable workspace; existing admitted normal preload/UI flows, no product seam or injected journal/result",
    "E2E_JOURNEY_RETIRED:writable-recovery-diagnostics-navigation: Its Home navigation adapter depended on the removed Settings Diagnostics ChatGPT acceptance-tools disclosure",
    "Go owns Settings edit admission/pending/result; existing typed host storage performs conditional filesystem writes, not an autonomous model tool call",
    "Hidden windows throughout; no focus, real picker, real provider/control plane, installed profile, sleep/reboot or interrupted-effect qualification; connector-failed-quit uses a synthetic loopback tunnel only",
    "Connector-only failure is a hypothesis until native qualification. Any other failed-drain shape is NONMATCHING_FIXTURE, never R04 PASS. A read-only restart records that limit and performs no write or recovery action",
    "--expect-restart normal-writable requires an actual normal-ready restart, retained history and a new File result/read/ACK; it rejects read-only recovery after ordinary cleanup",
    "Exact observed direct child absence is not arbitrary descendant settlement or an original Go terminal/ACK receipt after host SIGKILL",
    "Historical Desktop prepared/readonly/null metadata is deliberately seeded on the fresh disposable crash fixture only after the original host/direct Go child are absent; this is not original historical or production state",
    "Owned parent/child queries only; no machine-wide process inventory, arbitrary descendants or old Go ACK/terminal are established",
  ],
};
const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && args[0] === "--contract")) {
  process.stdout.write(JSON.stringify(contract, null, 2) + "\n");
} else {
  assert.equal(args.shift(), "--run-native", "EXPLICIT_NATIVE_MODE_REQUIRED");
  const pins = {};
  while (args.length) {
    const key = args.shift(),
      value = args.shift();
    assert.ok(
      ["--source-sha", "--build-id", "--scenario", "--expect-restart"].includes(
        key,
      ) &&
        value &&
        !Object.hasOwn(pins, key),
      "INVALID_ARGUMENT",
    );
    pins[key] = value;
  }
  assert.match(pins["--source-sha"] ?? "", /^[a-f0-9]{40}$/u);
  assert.match(pins["--build-id"] ?? "", /^[a-f0-9]{64}$/u);
  assert.ok(
    [undefined, "normal", "crash", "connector-failed-quit"].includes(
      pins["--scenario"],
    ),
  );
  assert.ok(
    pins["--expect-restart"] === undefined ||
      (pins["--expect-restart"] === "normal-writable" &&
        pins["--scenario"] === "connector-failed-quit"),
    "INVALID_RESTART_EXPECTATION",
  );
  reportRetiredJourney(
    "writable-recovery-native-history",
    "The native history scenarios require the removed Diagnostics navigation adapter.",
  );
  process.exit(0);
  await main(pins);
}

async function bounded(promise, code, ms = 20000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function pause() {
  return new Promise((resolve) => setTimeout(resolve, 100));
}
async function regular(file) {
  const fd = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat({ bigint: true });
    assert.ok(
      before.isFile() &&
        before.nlink === 1n &&
        before.size <= 8n * 1024n * 1024n,
      "UNSAFE_WITNESS",
    );
    const bytes = await fd.readFile();
    const after = await fd.stat({ bigint: true });
    for (const key of [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ])
      assert.equal(after[key], before[key], "WITNESS_CHANGED_DURING_READ");
    return {
      bytes,
      physical: Object.fromEntries(
        [
          "dev",
          "ino",
          "mode",
          "uid",
          "gid",
          "nlink",
          "size",
          "mtimeNs",
          "ctimeNs",
        ].map((key) => [key, String(before[key])]),
      ),
      sha256: hash(bytes),
    };
  } finally {
    await fd.close();
  }
}
async function json(file) {
  return JSON.parse((await regular(file)).bytes.toString("utf8"));
}
async function directory(file) {
  assert.equal(await fs.realpath(file), file, "DIRECTORY_REDIRECTED");
  const stat = await fs.lstat(file, { bigint: true });
  assert.ok(
    stat.isDirectory() &&
      stat.uid === BigInt(process.getuid()) &&
      (stat.mode & 0o777n) === 0o700n,
    "DIRECTORY_NOT_PRIVATE",
  );
  return {
    path: file,
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: String(stat.uid),
  };
}
// Query only the exact observed owned parent or its already captured child
// PIDs. Never collect a machine-wide command/process inventory.
function processes(pids) {
  assert.ok(
    Array.isArray(pids) &&
      pids.length > 0 &&
      pids.length <= 64 &&
      pids.every((pid) => Number.isSafeInteger(pid) && pid > 1),
    "OWNED_PROCESS_QUERY_INVALID",
  );
  const result = spawnSync(
    "/bin/ps",
    ["-ww", "-p", pids.join(","), "-o", "pid=,ppid=,command="],
    { encoding: "utf8", maxBuffer: 256 * 1024, timeout: 3000 },
  );
  assert.equal(result.error, undefined, "OWNED_PROCESS_QUERY_UNKNOWN");
  assert.ok(
    result.status === 0 || (result.status === 1 && result.stdout.trim() === ""),
    "OWNED_PROCESS_QUERY_REFUSED",
  );
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) return [];
    const row = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    };
    assert.ok(pids.includes(row.pid), "PROCESS_QUERY_ESCAPED_OWNED_PIDS");
    return [row];
  });
}
function children(parent) {
  assert.ok(Number.isSafeInteger(parent) && parent > 1, "OWNED_PARENT_INVALID");
  const result = spawnSync("/usr/bin/pgrep", ["-P", String(parent)], {
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 3000,
  });
  assert.equal(result.error, undefined, "OWNED_CHILD_LOOKUP_UNKNOWN");
  if (result.status === 1 && result.stdout.trim() === "") return [];
  assert.equal(result.status, 0, "OWNED_CHILD_LOOKUP_REFUSED");
  const pids = result.stdout
    .trim()
    .split(/\s+/u)
    .map((value) => {
      assert.match(value, /^[1-9]\d*$/u);
      return Number(value);
    });
  return processes(pids).filter((row) => row.ppid === parent);
}
async function absent(observed) {
  const deadline = performance.now() + 15000;
  do {
    const remaining = observed.filter(({ pid }) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    });
    if (!remaining.length) return;
    await pause();
  } while (performance.now() < deadline);
  throw new Error("ORIGINAL_OBSERVED_CHILD_EXIT_UNKNOWN_NO_RELAUNCH");
}
// Snapshot originals before the transition. Read-only comparisons never derive
// expected contents from a post-transition filesystem or manufacture records.
async function custody(stateRoot, workspace, retiredChat) {
  const result = {};
  async function walk(file, label) {
    const stat = await fs.lstat(file, { bigint: true });
    assert.equal(stat.isSymbolicLink(), false, "CUSTODY_SYMLINK");
    if (stat.isDirectory()) {
      result[label] = await directory(file);
      for (const name of (await fs.readdir(file)).sort())
        await walk(path.join(file, name), `${label}/${name}`);
    } else {
      const { sha256, physical } = await regular(file);
      result[label] = { sha256, physical };
    }
  }
  for (const name of ["profile.json", "chat", "computer/mutations"])
    await walk(
      path.join(
        stateRoot,
        "go-core",
        name === "chat" && retiredChat ? retiredChat : name,
      ),
      name,
    );
  await walk(workspace, "workspace");
  return result;
}
function preserved(original, current, allowJournalAdvance = false) {
  for (const [name, value] of Object.entries(original)) {
    if (allowJournalAdvance && name === "chat/chat-lifecycle.json") continue;
    assert.deepEqual(current[name], value, `ORIGINAL_CHANGED:${name}`);
  }
}

async function main(pins) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  const source = sourceIdentity(root);
  assert.equal(source.commit, pins["--source-sha"], "SOURCE_PIN_MISMATCH");
  const build = await qualifyGoBuild(buildRoot, source);
  assert.equal(
    build.identity.buildId,
    pins["--build-id"],
    "BUILD_PIN_MISMATCH",
  );
  assertRuntimeObservation(
    await observeElectronRuntime(path.join(root, "node_modules/electron")),
    ELECTRON_RUNTIME,
  );
  const temp = await fs.realpath(os.tmpdir());
  assert.match(temp, /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u);
  const retainedRoot = await fs.realpath(
    await fs.mkdtemp(path.join(temp, "farol-dev-onboarding-writable-")),
  );
  await fs.chmod(retainedRoot, 0o700);
  const evidence = path.join(
    root,
    "_output/evidence",
    `writable-recovery-${randomUUID()}.json`,
  );
  await fs.mkdir(path.dirname(evidence), { recursive: true, mode: 0o700 });
  const report = {
    contract,
    source,
    build: {
      identity: build.identity,
      core: build.manifest.core,
      manifestSha256: build.manifestSha256,
    },
    retainedRoot,
    evidence,
    startedAt: new Date().toISOString(),
    status: "running",
    scenarios: [],
  };
  const save = () =>
    fs.writeFile(evidence, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const active = () => {
    assert.equal(cancelled, false, "CANCELLED_NO_RETRY");
  };
  await save();
  try {
    for (const name of pins["--scenario"]
      ? [pins["--scenario"]]
      : ["normal", "crash"]) {
      active();
      const row = {
        name,
        status: "running",
        launches: [],
        commands: [],
        writes: [],
      };
      report.scenarios.push(row);
      await save();
      try {
        await scenario({
          name,
          expectedRestart: pins["--expect-restart"],
          row,
          retainedRoot,
          temp,
          source,
          build,
          save,
          active,
        });
      } catch (error) {
        row.status = row.nonmatchingFixture
          ? "NONMATCHING_FIXTURE"
          : "FAILED_OR_UNKNOWN";
        row.error = String(error?.stack ?? error);
        await save();
      }
      // Independent fresh scenarios are not retries. An unknown owned lifetime
      // prevents spending the next launch, even with a different profile.
      if (
        row.launches.some(
          (launch) => !launch.terminal || !launch.originalGoChildAbsent,
        )
      )
        break;
    }
    assert.deepEqual(sourceIdentity(root), source, "SOURCE_CHANGED_DURING_RUN");
    await qualifyGoBuild(buildRoot, source);
    report.status = report.scenarios.every((row) => row.status === "PASS")
      ? "PASS"
      : "FAILED_OR_BLOCKED";
  } catch (error) {
    report.status = "FAILED_OR_UNKNOWN";
    report.error = String(error?.stack ?? error);
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    process.stdout.write(
      `${report.status}: ${evidence}\nretained: ${retainedRoot}\n`,
    );
    process.exitCode = report.status === "PASS" ? 0 : 1;
  }
}

async function scenario({
  name,
  expectedRestart,
  row,
  retainedRoot,
  temp,
  source,
  build,
  save,
  active,
}) {
  const profile = await fs.realpath(
    await fs.mkdtemp(path.join(temp, "farol-dev-onboarding-startup-")),
  );
  await fs.chmod(profile, 0o700);
  await fs.writeFile(
    path.join(retainedRoot, `${name}-profile.json`),
    JSON.stringify({ profile }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const home = path.join(profile, "home"),
    appData = path.join(profile, "app-data"),
    workspace = path.join(profile, "workspace");
  const stateRoot = path.join(appData, "Farol Dev", "farol-state");
  for (const dir of [home, stateRoot, workspace])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(workspace, readCanary.relativePath),
    readCanary.text,
    { mode: 0o600, flag: "wx" },
  );
  await fs.writeFile(
    path.join(stateRoot, "config.json"),
    JSON.stringify(conversationSeed(randomUUID())) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const proof = randomUUID();
  await fs.writeFile(path.join(profile, ".farol-e2e-root"), proof, {
    mode: 0o600,
    flag: "wx",
  });
  row.profile = profile;
  const connectorFailure = name === "connector-failed-quit";
  const tunnelRoot = path.join(stateRoot, "secure-mcp-connector", "state");
  let tunnelExecutable,
    ownedTunnel,
    stopIssued = false;
  if (connectorFailure) {
    const fixtureRoot = path.join(profile, "connector-fixture");
    await fs.mkdir(fixtureRoot, { mode: 0o700 });
    tunnelExecutable = path.join(fixtureRoot, "connector-only-tunnel.cjs");
    await fs.writeFile(
      tunnelExecutable,
      `#!${process.execPath}\n${await fs.readFile(new URL("./connector-only-tunnel.fixture.cjs", import.meta.url), "utf8")}`,
      { flag: "wx", mode: 0o700 },
    );
    await fs.copyFile(
      new URL("./tunnel-client.fixture.cjs", import.meta.url),
      path.join(fixtureRoot, "tunnel-client.fixture.cjs"),
      fs.constants.COPYFILE_EXCL,
    );
    row.fixture = { executable: tunnelExecutable, status: "not-started" };
  }
  const tunnelRecord = async () => {
    let names;
    try {
      names = await fs.readdir(tunnelRoot);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const files = names.filter((value) =>
      /^connector-only-[a-f0-9-]{36}\.json$/u.test(value),
    );
    assert.ok(files.length <= 1, "AMBIGUOUS_FIXTURE_TUNNEL_NO_SIGNAL");
    if (!files.length) return null;
    const value = await json(path.join(tunnelRoot, files[0]));
    assert.equal(files[0], `connector-only-${value.id}.json`);
    assert.match(
      value.id,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    assert.equal(value.executable, tunnelExecutable);
    for (const pid of [value.pid, value.parentPid])
      assert.ok(
        Number.isSafeInteger(pid) && pid > 1,
        "INVALID_FIXTURE_PID_NO_SIGNAL",
      );
    if (ownedTunnel)
      for (const key of ["id", "pid", "parentPid", "executable"])
        assert.equal(
          value[key],
          ownedTunnel[key],
          "FIXTURE_IDENTITY_CHANGED_NO_SIGNAL",
        );
    return value;
  };
  const exactCommand = (pid) => {
    // Anchor argv contains newlines; the ordinary row parser cannot retain its
    // full inline script. This query is restricted to one already owned PID.
    const result = spawnSync(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      { encoding: "utf8", maxBuffer: 32768, timeout: 3000 },
    );
    assert.equal(result.error, undefined, "FIXTURE_COMMAND_QUERY_UNKNOWN");
    assert.equal(result.status, 0, "FIXTURE_COMMAND_QUERY_REFUSED");
    return result.stdout.trim();
  };
  const poll = async (read, accept, label) => {
    const deadline = performance.now() + 15000;
    do {
      const value = await read();
      if (accept(value)) return value;
      await pause();
    } while (performance.now() < deadline);
    throw new Error(label);
  };
  const settleTunnel = async () => {
    assert.ok(ownedTunnel, "FIXTURE_ANCESTRY_NOT_PROVEN_NO_CLEANUP_SIGNAL");
    assert.equal(stopIssued, false, "DUPLICATE_FIXTURE_STOP_FORBIDDEN");
    const before = await tunnelRecord();
    assert.equal(before.phase, "running", "FIXTURE_TERMINAL_NONMATCHING");
    const current = processes([ownedTunnel.pid]);
    assert.equal(current.length, 1, "ORIGINAL_FIXTURE_TUNNEL_MISSING");
    assert.equal(
      current[0].command,
      row.fixture.tunnel.command,
      "FIXTURE_PROCESS_CHANGED",
    );
    stopIssued = true;
    row.fixture.stop = { status: "request-issued", id: ownedTunnel.id };
    await save();
    // The fixture consumes only its own nonce-bound request and signals itself.
    // Never signal a reparented/reused numeric tunnel PID from this harness.
    const requestFile = path.join(
      tunnelRoot,
      `connector-only-stop-${ownedTunnel.id}.json`,
    );
    await fs.writeFile(
      requestFile + ".tmp",
      JSON.stringify({
        id: ownedTunnel.id,
        pid: ownedTunnel.pid,
        action: "stop",
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(requestFile + ".tmp", requestFile);
    row.fixture.terminal = await poll(
      tunnelRecord,
      (value) => value?.phase === "exited",
      "FIXTURE_TERMINAL_UNKNOWN_NO_REOPEN",
    );
    await save();
    assert.equal(row.fixture.terminal.exitCode, 0);
    assert.equal(row.fixture.terminal.stopConsumed, true);
    await absent([{ pid: ownedTunnel.pid }, { pid: ownedTunnel.parentPid }]);
    row.fixture.stop.status = "terminal-and-exact-original-absence-observed";
    await save();
  };
  const session = {
    user: { id: "startup-synthetic-user" },
    account: { id: "startup-synthetic-account" },
    expires: new Date(Date.now() + 3600000).toISOString(),
  };
  const script = conversationScript(path.basename(workspace));
  let site, app, child, ended, launch, page;
  let logWrites = Promise.resolve();
  const hidden = async () => {
    const state = await bounded(
      app.evaluate(({ BrowserWindow, webContents }) => ({
        windows: BrowserWindow.getAllWindows().map((win) => ({
          visible: win.isVisible(),
          focused: win.isFocused(),
        })),
        urls: webContents
          .getAllWebContents()
          .map((contents) => contents.getURL()),
      })),
      "HIDDEN_STATE_UNKNOWN",
      5000,
    );
    assert.ok(
      state.windows.length > 0 &&
        state.windows.every((win) => !win.visible && !win.focused),
      "VISIBLE_OR_FOCUSED_WINDOW",
    );
    for (const url of state.urls)
      assert.ok(
        url === "" ||
          url === "about:blank" ||
          url.startsWith("file://") ||
          url.startsWith(site.origin + "/"),
        "EXTERNAL_BROWSER_ROUTE",
      );
    launch.windows = state;
    await save();
  };
  // This adapter's former Home route depended on a removed Diagnostics
  // disclosure. Its narrow click entry reports that journey retirement before
  // any visible navigation or other UI effect.
  const journeyPage = {
    evaluate: (...args) => page.evaluate(...args),
    locator: (...args) => page.locator(...args),
    getByRole(role, options) {
      const target = page.getByRole(role, options);
      if (
        role !== "button" ||
        options?.name !== "Home" ||
        options?.exact !== true
      )
        return target;
      return {
        click: async () => {
          throw new Error(
            "E2E_JOURNEY_RETIRED:writable-recovery-diagnostics-navigation: Home-to-history navigation relied on the removed Settings Diagnostics ChatGPT acceptance-tools disclosure",
          );
        },
      };
    },
  };
  const configure = async (command) => {
    active();
    await hidden();
    const observation = { command, status: "issued" };
    row.commands.push(observation);
    await save();
    const reply = await bounded(
      page.evaluate((value) => window.farol.configure(value), command),
      "CONFIGURATION_OUTCOME_UNKNOWN_NO_RETRY",
    );
    observation.reply = reply;
    observation.status = "returned";
    await save();
    assert.equal(
      reply.ok,
      true,
      `CONFIGURATION_REFUSED:${command.kind}:${reply.error}`,
    );
    return reply;
  };
  const journal = () =>
    json(path.join(stateRoot, "go-core/chat/chat-lifecycle.json"));
  const start = async (recovery = false, observeStartup = false) => {
    active();
    assert.deepEqual(sourceIdentity(root), source);
    await qualifyGoBuild(buildRoot, source);
    launch = {
      ordinal: row.launches.length + 1,
      recovery,
      status: "launch-attempted",
      closeRequested: false,
    };
    row.launches.push(launch);
    await save();
    app = child = ended = page = undefined;
    app = await electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
      timeout: 15000,
      env: {
        HOME: home,
        TMPDIR: temp,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        FAROL_ENVIRONMENT: "dev",
        FAROL_E2E: "1",
        FAROL_E2E_APP_DATA: appData,
        FAROL_E2E_TEST_ROOT: profile,
        FAROL_E2E_TEST_PROOF: proof,
        FAROL_E2E_CHATGPT_URL: site.url,
        ...(tunnelExecutable
          ? { FAROL_E2E_TUNNEL_CLIENT: tunnelExecutable }
          : {}),
        FAROL_E2E_WORKSPACE_ROOT: workspace,
        FAROL_E2E_WORKSPACE_FILE: path.join(workspace, readCanary.relativePath),
      },
    });
    child = app.process();
    launch.pid = child.pid;
    const original = launch;
    ended = once(child, "exit");
    ended.catch(() => undefined);
    child.once("exit", (code, signal) => {
      original.terminal = { code, signal };
    });
    if (connectorFailure) {
      original.lifecycle = [];
      let buffered = "",
        bytes = 0;
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024 || original.lifecycle.length >= 64) {
          original.lifecycleOverflow = true;
          return;
        }
        buffered += chunk.toString("utf8");
        if (Buffer.byteLength(buffered) > 65536) {
          original.lifecycleOverflow = true;
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
              !["go-backend", "connector-anchor", "connector-tunnel"].includes(
                value.source,
              )
            )
              continue;
            original.lifecycle.push(
              Object.fromEntries(
                [
                  "source",
                  "phase",
                  "event",
                  "code",
                  "state",
                  "exitCode",
                  "signal",
                  "forced",
                  "hostLifetimeId",
                  "childLaunchId",
                  "runtimeGeneration",
                ]
                  .filter(
                    (key) =>
                      ["string", "number", "boolean"].includes(
                        typeof value[key],
                      ) || value[key] === null,
                  )
                  .map((key) => [key, value[key]]),
              ),
            );
          } catch {
            original.lifecycleParseError = true;
          }
        }
      });
    }
    for (const stream of ["stdout", "stderr"])
      child[stream].on("data", (chunk) => {
        // Only the disposable synthetic profile can contribute to these logs.
        logWrites = logWrites
          .then(() =>
            fs.appendFile(
              path.join(profile, `launch-${original.ordinal}.${stream}.log`),
              chunk,
              { mode: 0o600 },
            ),
          )
          .catch((error) => {
            original.logError = String(error);
          });
      });
    page = await app.firstWindow({ timeout: 15000 });
    page.setDefaultTimeout(15000);
    if (observeStartup) {
      // Read actual DOM/API state only; no recovery/reset/migration command.
      launch.startupObservation = await poll(
        () =>
          page
            .evaluate(() => ({
              normalAPI: typeof window.farol,
              recoveryAPI: typeof window.farolRecovery,
              normalShell: !!document.querySelector(".desktop"),
              recoveryHeading: [...document.querySelectorAll("h1,h2")].some(
                (node) =>
                  node.textContent === "Your previous session needs recovery",
              ),
              text: document.body.innerText.slice(0, 16000),
              buttons: [...document.querySelectorAll("button")].map((node) => ({
                text: node.textContent,
                disabled: node.disabled,
              })),
            }))
            .then(async (value) => {
              launch.startupObservation = value;
              await save();
              return value;
            }),
        (value) => value.normalShell || value.recoveryHeading,
        "REOPEN_UI_UNKNOWN_NO_RETRY",
      );
      recovery = launch.startupObservation.recoveryHeading;
      launch.recovery = recovery;
      row.restartOutcome = recovery
        ? "read-only-recovery-shell"
        : "normal-shell-awaiting-readiness";
      await save();
    }
    // Capture the original current Go child before any UI-mode assertion so a
    // refused automatic-start path still has exact cleanup ownership.
    const childBy = performance.now() + 15000;
    for (;;) {
      launch.children = children(child.pid);
      const observed = launch.children.filter((p) =>
        p.command.startsWith(path.join(buildRoot, "farol-backend") + " serve "),
      );
      assert.ok(observed.length <= 1, "AMBIGUOUS_CURRENT_GO_CHILD");
      if (observed.length === 1) {
        launch.backend = observed[0];
        break;
      }
      assert.ok(performance.now() < childBy, "CURRENT_GO_CHILD_NOT_OBSERVED");
      await pause();
    }
    await save();

    if (recovery)
      await page
        .getByRole("heading", {
          name: "Your previous session needs recovery",
          exact: true,
        })
        .waitFor();
    else {
      // Await native IPC in the host, under one original readiness deadline.
      // A page predicate is not the owner of an asynchronous bootstrap read.
      const readyBy = performance.now() + 20000;
      await page.locator(".desktop").waitFor({
        state: "visible",
        timeout: Math.max(1, readyBy - performance.now()),
      });
      let bootstrap;
      for (;;) {
        active();
        const remaining = readyBy - performance.now();
        assert.ok(remaining > 0, "NORMAL_BOOTSTRAP_DEADLINE");
        bootstrap = await bounded(
          page.evaluate(() => window.farol.bootstrap()),
          "BOOTSTRAP_READ_UNKNOWN_NO_RETRY",
          Math.min(3000, remaining),
        );
        assert.ok(performance.now() < readyBy, "NORMAL_BOOTSTRAP_DEADLINE");
        if (
          bootstrap.runtimeState === "ready" &&
          bootstrap.configuration.status === "ready"
        )
          break;
        await pause();
      }
      assert.equal(bootstrap.environment, "dev");
      assert.equal(bootstrap.applicationId, "local.farol.dev");
      launch.marker = await json(path.join(stateRoot, "running.json"));
      assert.equal(launch.marker.pid, child.pid);
      if (observeStartup) row.restartOutcome = "normal-ready";
      launch.journal = await journal();
      launch.generation = launch.journal.scope.BackendGeneration;
      assert.ok(launch.generation);
    }
    await hidden();
    assert.equal(
      await app.evaluate(({ app }) => app.getPath("userData")),
      path.join(appData, "Farol Dev"),
    );
    launch.children = children(child.pid);
    const backends = launch.children.filter((p) =>
      p.command.startsWith(path.join(buildRoot, "farol-backend") + " serve "),
    );
    assert.equal(backends.length, 1, "EXACT_GO_CHILD_NOT_OBSERVED");
    launch.backend = backends[0];
    assert.equal(
      /--startup-mode recovery/u.test(launch.backend.command),
      recovery,
      "WRONG_BACKEND_MODE",
    );
    launch.status = recovery ? "recovery-read-only" : "normal-ready";
    await save();
  };
  const quit = async (recovery = false) => {
    assert.equal(launch.closeRequested, false, "DUPLICATE_QUIT_FORBIDDEN");
    await hidden();
    launch.closeRequested = true;
    launch.status = "quit-issued";
    await save();
    if (recovery)
      await page.getByRole("button", { name: "Quit", exact: true }).click();
    else assert.equal(child.kill("SIGINT"), true, "QUIT_SIGNAL_NOT_DELIVERED");
    await bounded(ended, "QUIT_TERMINAL_UNKNOWN_NO_RETRY", 15000);
    await save();
    assert.deepEqual(launch.terminal, { code: 0, signal: null });
    await absent([launch.backend]);
    launch.originalGoChildAbsent = true;
    if (!recovery) {
      launch.quitReceipt = await json(path.join(stateRoot, "last-quit.json"));
      const cleanup = {
        exitObserved: true,
        exitCode: 0,
        signal: null,
        closeRequested: true,
      };
      launch.quitClassification = conversationQuitWitness(
        launch.quitReceipt,
        launch.marker,
        cleanup,
      );
      assert.equal(
        launch.quitClassification,
        "confirmed-clean-quit",
        "QUIT_DRAIN_UNCONFIRMED_NO_REOPEN",
      );
      await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
        code: "ENOENT",
      });
      launch.retiredJournal = await journal();
      assert.ok(launch.retiredJournal.retirement, "GO_RETIREMENT_MISSING");
    }
    launch.status = "confirmed-quit";
    await save();
  };
  const edit = async (oldText, newText) => {
    const original = (
      await regular(path.join(workspace, readCanary.relativePath))
    ).bytes;
    const prepared = (
      await configure({
        kind: "computer.prepare-workspace-edit",
        workspaceId: row.workspaceId,
      })
    ).evidence;
    assert.equal(
      prepared.beforeSha256,
      hash(original),
      "GO_READ_HASH_MISMATCH",
    );
    const observation = {
      prepared,
      beforeSha256: hash(original),
      status: "apply-not-issued",
    };
    row.writes.push(observation);
    await save();
    observation.status = "apply-issued";
    await save();
    const applied = await configure({
      kind: "computer.apply-workspace-edit",
      operationId: prepared.operationId,
      oldText,
      newText,
    });
    const pending = applied.snapshot.settings.computer.pendingEdit;
    assert.equal(pending.backend, "go-owner-v2");
    assert.equal(pending.operationId, prepared.operationId);
    const expected = Buffer.from(
      original.toString("utf8").replace(oldText, newText),
    );
    assert.notDeepEqual(expected, original);
    const changed = await regular(
      path.join(workspace, readCanary.relativePath),
    );
    assert.deepEqual(changed.bytes, expected);
    const records = path.join(stateRoot, "go-core/computer/mutations");
    const names = (await fs.readdir(records)).sort();
    assert.equal(names.length, row.writes.length, "UNEXPECTED_GO_EFFECT_COUNT");
    observation.journals = [];
    for (const file of names)
      observation.journals.push({
        file,
        value: await json(path.join(records, file)),
      });
    assert.ok(
      observation.journals.some(
        ({ value }) =>
          value.record?.identity?.operationId === pending.operationId,
      ),
      "GO_MUTATION_ID_NOT_RETAINED",
    );
    const retained = observation.journals.find(
      ({ value }) => value.record.identity.operationId === pending.operationId,
    ).value;
    assert.equal(retained.schemaVersion, 2);
    assert.equal(retained.kind, "workspace_owner_mutation");
    assert.equal(retained.record.phase, "completed");
    assert.equal(
      retained.record.computerGeneration,
      pending.computerGeneration,
    );
    assert.equal(retained.record.outcome.receipt.beforeSha256, hash(original));
    assert.equal(retained.record.outcome.receipt.afterSha256, changed.sha256);
    observation.pending = pending;
    observation.result = await configure({
      kind: "computer.observe-workspace-edit",
      operationId: pending.operationId,
    });
    assert.equal(observation.result.evidence.resultRetention, "durable");
    assert.equal(observation.result.evidence.afterSha256, changed.sha256);
    const acknowledged = await configure({
      kind: "computer.ack-workspace-edit",
      operationId: pending.operationId,
    });
    assert.equal(acknowledged.snapshot.settings.computer.pendingEdit, null);
    // Fresh app-owned Go snapshot after the effect; never acknowledge or replay
    // an unknown effect. Cancel only this new read/preview, without Apply.
    const read = await configure({
      kind: "computer.prepare-workspace-edit",
      workspaceId: row.workspaceId,
    });
    assert.equal(read.evidence.beforeSha256, changed.sha256);
    await configure({
      kind: "computer.cancel-workspace-edit",
      operationId: read.evidence.operationId,
    });
    observation.read = read.evidence;
    observation.afterSha256 = changed.sha256;
    observation.status = "confirmed-applied-read-acknowledged";
    await save();
  };
  try {
    site = await startChatGptFixture({
      controlledScenario: {
        account: session,
        conversationId,
        selection: { model: "Test model", effort: "Light", connector: null },
        turns: script,
      },
    });
    await start();
    const added = await configure({ kind: "computer.add-workspace" });
    const workspaceSettings = added.snapshot.settings.computer.workspaces[0];
    row.workspaceId = workspaceSettings.workspaceId;
    for (const kind of ["computer.verify-workspace", "computer.check-folder"])
      await configure({ kind, workspaceId: row.workspaceId });
    await configure({ kind: "chatgpt.open-browser" });
    const readiness = await configure({ kind: "chatgpt.verify" });
    assert.equal(readiness.evidence.state, "authenticated");
    row.chat = {};
    await runConversationJourney({
      window: journeyPage,
      workspace: readiness.snapshot.settings.computer.workspaces[0],
      configured: readiness.snapshot.settings,
      driver: site.driver,
      script,
      session,
      active,
      hidden,
      save,
      report: row.chat,
      journal: async (ui, acknowledged) =>
        conversationJournalWitness(
          await journal(),
          row.launches[0].journal,
          ui,
          acknowledged,
        ),
    });
    const originals = historyOriginals(row.chat);
    row.originalResultIds = originals.map((value) => value.go.resultId);
    await configure({
      kind: "computer.update-access",
      workspaceId: row.workspaceId,
      access: "write",
    });
    await configure({
      kind: "computer.verify-workspace",
      workspaceId: row.workspaceId,
    });
    await edit(
      "Farol disposable read canary",
      "Farol disposable first edited canary",
    );
    await assert.rejects(
      fs.lstat(
        path.join(
          stateRoot,
          "chatgpt-task-journal",
          "chatgpt-task-journal.json",
        ),
      ),
      { code: "ENOENT" },
    );
    row.legacyGoMirror = "PASS-no-active-legacy-journal-after-real-Go-Chat-ACK";
    row.beforeTransition = await custody(stateRoot, workspace);
    row.ledger = site.driver.snapshot();
    await save();
    assert.equal(row.ledger.acceptedSends, 2);
    if (connectorFailure) {
      // Compare every persisted owner choice, including filePolicy and the
      // selected tunnel/client/credential binding. Only documented runtime
      // observations and revision counters may change across shutdown/startup.
      const retainedSettings = (value) => {
        const retained = structuredClone(value);
        delete retained.revision;
        delete retained.computer.generation;
        for (const key of ["generation", "runtime", "challenge", "attachment"])
          delete retained.connectors.secureMcp[key];
        for (const key of ["chatgpt", "computer", "connect", "hosts", "verify"])
          delete retained.setup[key];
        return retained;
      };
      await configure({ kind: "connector.select-client" });
      await configure({
        kind: "connector.configure",
        tunnelId: "connector_only_owned_fixture",
        runtimeKey: "synthetic-connector-only-runtime-key",
      });
      await configure({ kind: "connector.start" });
      const record = await poll(
        tunnelRecord,
        (value) => value?.phase === "running",
        "FIXTURE_TUNNEL_NOT_OBSERVED_NO_SIGNAL",
      );
      const exact = processes([child.pid, record.parentPid, record.pid]);
      const anchor = exact.find((value) => value.pid === record.parentPid);
      const tunnel = exact.find((value) => value.pid === record.pid);
      assert.equal(exact.length, 3, "FIXTURE_ANCESTRY_INCOMPLETE_NO_SIGNAL");
      assert.equal(
        anchor.ppid,
        child.pid,
        "FIXTURE_ANCHOR_NOT_OWNED_NO_SIGNAL",
      );
      const anchorCommand = exactCommand(anchor.pid);
      assert.ok(
        anchorCommand.includes("farol-tunnel-terminal-v1") &&
          anchorCommand.includes(tunnelExecutable),
        "FIXTURE_ANCHOR_COMMAND_NOT_MATCHED_NO_SIGNAL",
      );
      assert.equal(
        tunnel.ppid,
        anchor.pid,
        "FIXTURE_TUNNEL_NOT_OWNED_NO_SIGNAL",
      );
      assert.equal(
        tunnel.command,
        `${process.execPath} ${tunnelExecutable} ${record.argv.join(" ")}`,
        "FIXTURE_TUNNEL_COMMAND_NOT_MATCHED_NO_SIGNAL",
      );
      assert.deepEqual(
        processes([launch.backend.pid]),
        [launch.backend],
        "ORIGINAL_GO_CHILD_CHANGED",
      );
      ownedTunnel = record;
      row.fixture = {
        ...row.fixture,
        record,
        anchor,
        tunnel,
        anchorCommand,
        status: "exact-original-ancestry-proven",
      };
      const settings = await json(path.join(stateRoot, "config.json"));
      row.settingsBeforeFailure = settings;
      const marker = await regular(path.join(stateRoot, "running.json"));
      assert.deepEqual(
        JSON.parse(marker.bytes.toString("utf8")),
        launch.marker,
        "ORIGINAL_NORMAL_RUN_MARKER_CHANGED",
      );
      row.fixture.originalRunMarker = {
        sha256: marker.sha256,
        physical: marker.physical,
      };
      // Chat and File effects have already settled. This signal targets only
      // the current owned connector anchor, never Go, a process group or a scan.
      const rechecked = processes([anchor.pid, tunnel.pid]);
      assert.deepEqual(
        rechecked.find((value) => value.pid === anchor.pid),
        anchor,
      );
      assert.deepEqual(
        rechecked.find((value) => value.pid === tunnel.pid),
        tunnel,
      );
      assert.equal(exactCommand(anchor.pid), anchorCommand);
      row.fixture.status = "anchor-SIGKILL-issued";
      await save();
      assert.equal(process.kill(anchor.pid, "SIGKILL"), true);
      await absent([anchor]);
      row.fixture.anchorTerminal = await poll(
        async () =>
          launch.lifecycle.find(
            (value) =>
              value.source === "connector-anchor" &&
              value.event === "exit" &&
              value.state === "observed" &&
              value.signal === "SIGKILL" &&
              value.exitCode === null,
          ),
        Boolean,
        "ORIGINAL_ANCHOR_TERMINAL_UNKNOWN_NO_QUIT_RETRY",
      );
      await save();
      assert.equal((await tunnelRecord()).phase, "running");
      assert.equal(
        processes([tunnel.pid])[0]?.command,
        tunnel.command,
        "ORIGINAL_TUNNEL_NOT_RETAINED_NONMATCHING_FIXTURE",
      );
      await hidden();
      launch.closeRequested = true;
      launch.status = "ordinary-app-quit-issued";
      const requestedAt = Date.now();
      await save();
      // A disconnected evaluate reply is not terminal evidence. The original
      // child exit and exact Go absence below remain independent prerequisites.
      const quittingLaunch = launch;
      void app
        .evaluate(({ app }) => app.quit())
        .catch((error) => {
          quittingLaunch.quitCallError = String(error);
        });
      await bounded(ended, "FAILED_QUIT_TERMINAL_UNKNOWN_NO_RETRY", 15000);
      await logWrites;
      await save();
      assert.deepEqual(launch.terminal, { code: 0, signal: null });
      await absent([launch.backend]);
      launch.originalGoChildAbsent = true;
      launch.quitReceipt = await json(path.join(stateRoot, "last-quit.json"));
      await save();
      const receipt = launch.quitReceipt;
      if (
        receipt.schema !== 1 ||
        receipt.drained !== false ||
        JSON.stringify(receipt.unconfirmed) !== '["connector"]'
      ) {
        row.nonmatchingFixture = true;
        throw new Error("NONMATCHING_FIXTURE_NOT_R04_PASS");
      }
      assert.equal(new Date(receipt.at).toISOString(), receipt.at);
      assert.ok(Date.parse(receipt.at) >= requestedAt);
      assert.deepEqual(
        await regular(path.join(stateRoot, "running.json")),
        marker,
        "FAILED_QUIT_ORIGINAL_RUN_MARKER_CHANGED",
      );
      assert.equal(
        launch.lifecycleOverflow,
        undefined,
        "LIFECYCLE_EVIDENCE_OVERFLOW",
      );
      assert.equal(
        launch.lifecycleParseError,
        undefined,
        "LIFECYCLE_EVIDENCE_MALFORMED",
      );
      launch.goClosureEvidence =
        "Exact original direct Go PID absence independently observed; lifecycle observations retained separately, no inferred terminal ACK";
      launch.status = "connector-only-failed-drain-observed";
      row.afterFailedQuit = await custody(stateRoot, workspace);
      preserved(row.beforeTransition, row.afterFailedQuit, true);
      await settleTunnel();
      const afterQuitSettings = await json(path.join(stateRoot, "config.json"));
      assert.deepEqual(
        retainedSettings(afterQuitSettings),
        retainedSettings(settings),
        "RETAINED_SETTINGS_CHANGED_AFTER_FAILED_QUIT",
      );
      row.settingsAfterFailedQuit = afterQuitSettings;
      await save();
      await start(false, true); // Exactly one retained-profile ordinary reopen.
      const archives = (
        await fs.readdir(path.join(stateRoot, "go-core"))
      ).filter((value) => /^chat-retired-[a-f0-9-]{36}$/u.test(value));
      assert.ok(archives.length <= 1, "AMBIGUOUS_REOPEN_CHAT_CUSTODY");
      const relocated = structuredClone(row.afterFailedQuit);
      if (archives.length)
        for (const [key, value] of Object.entries(relocated))
          if ((key === "chat" || key.startsWith("chat/")) && value.path)
            value.path = value.path.replace(
              path.join(stateRoot, "go-core/chat"),
              path.join(stateRoot, "go-core", archives[0]),
            );
      row.afterReopen = await custody(stateRoot, workspace, archives[0]);
      preserved(relocated, row.afterReopen, true);
      const reopenedSettings = await json(path.join(stateRoot, "config.json"));
      row.settingsAfterReopen = reopenedSettings;
      assert.deepEqual(
        retainedSettings(reopenedSettings),
        retainedSettings(settings),
        "RETAINED_SETTINGS_CHANGED_AFTER_REOPEN",
      );
      assert.deepEqual(
        site.driver.snapshot(),
        row.ledger,
        "REOPEN_PROVIDER_ACTIVITY",
      );
      if (launch.recovery) {
        assert.deepEqual(
          await regular(path.join(stateRoot, "running.json")),
          marker,
          "READ_ONLY_RESTART_CHANGED_ORIGINAL_RUN_MARKER",
        );
        assert.deepEqual(
          await json(path.join(stateRoot, "last-quit.json")),
          receipt,
          "READ_ONLY_RESTART_CHANGED_FAILED_QUIT",
        );
        assert.deepEqual(launch.startupObservation.normalAPI, "undefined");
        assert.deepEqual(launch.startupObservation.recoveryAPI, "object");
        row.writable =
          "NOT_RUN-read-only-recovery-shell-no-write-or-recovery-action";
        await quit(true);
      } else {
        assert.notEqual(
          launch.generation,
          row.launches[0].generation,
          "GENERATION_REUSED",
        );
        if (!archives.length) {
          const originalLedger = site.driver.snapshot(),
            originalJournal = await journal();
          row.history = {};
          await runHistoryReadJourney({
            window: journeyPage,
            originals,
            hidden,
            active,
            report: row.history,
            save,
            unchanged: async () => {
              assert.deepEqual(site.driver.snapshot(), originalLedger);
              assert.deepEqual(await journal(), originalJournal);
            },
          });
        } else {
          await journeyPage
            .getByRole("button", { name: "Home", exact: true })
            .click();
          const stored = page.locator("section.recovery-archive");
          assert.equal(
            await stored.count(),
            1,
            "REOPEN_STORED_READER_NOT_UNIQUE",
          );
          await stored
            .getByRole("button", { name: "Load stored replies", exact: true })
            .click();
          const replies = stored.getByRole("button", {
            name: /^Open stored reply \d+$/u,
          });
          await replies.nth(1).waitFor();
          assert.equal(await replies.count(), 2, "REOPEN_STORED_REPLY_COUNT");
          const expected = originals.map((value) => value.ui.answer).sort();
          row.recoveredAnswers = [];
          for (let i = 0; i < 2; i++) {
            await replies.nth(i).click();
            await page.waitForFunction(
              ({ expected, previous }) => {
                const text = document.querySelector(
                  '[aria-label="Stored reply text"]',
                )?.textContent;
                return expected.includes(text) && text !== previous;
              },
              { expected, previous: row.recoveredAnswers.at(-1) ?? null },
            );
            row.recoveredAnswers.push(
              await stored
                .locator('[aria-label="Stored reply text"]')
                .textContent(),
            );
            assert.equal(
              await stored
                .getByText("Outcome unconfirmed", { exact: true })
                .count(),
              1,
            );
            assert.equal(
              await stored
                .getByRole("button", { name: /^(Send|Resume|Acknowledge)/u })
                .count(),
              0,
            );
            await hidden();
          }
          assert.deepEqual([...row.recoveredAnswers].sort(), expected);
          assert.deepEqual(
            site.driver.snapshot(),
            row.ledger,
            "STORED_READER_PROVIDER_ACTIVITY",
          );
        }
        await edit(
          "Farol disposable first edited canary",
          "Farol disposable second edited canary",
        );
        row.writable =
          "PASS-new-File-result-read-and-ACK-after-connector-only-failed-Quit";
        await quit();
      }
      const afterRestartQuit = await custody(stateRoot, workspace, archives[0]);
      for (const [key, value] of Object.entries(relocated))
        if (
          (key === "chat" || key.startsWith("chat/")) &&
          key !== "chat/chat-lifecycle.json"
        )
          assert.deepEqual(
            afterRestartQuit[key],
            value,
            `REOPEN_CHAT_CHANGED:${key}`,
          );
      row.afterRestartQuit = afterRestartQuit;
      assert.equal(row.launches.length, 2, "UNEXPECTED_REOPEN_COUNT");
      if (expectedRestart === "normal-writable") {
        assert.equal(
          row.restartOutcome,
          "normal-ready",
          "CONNECTOR_ONLY_WRITABLE_RESTART_REQUIRED",
        );
        assert.equal(
          row.writable,
          "PASS-new-File-result-read-and-ACK-after-connector-only-failed-Quit",
        );
      }
      row.expectedRestart = expectedRestart ?? "observe";
      row.status = "PASS";
      row.qualification =
        "Fixture journey only; actual restartOutcome/writable recorded separately, not source acceptance or R04 acceptance";
    } else if (name === "normal") {
      await quit();
      row.afterQuit = await custody(stateRoot, workspace);
      preserved(row.beforeTransition, row.afterQuit, true);
      await start();
      assert.notEqual(
        launch.generation,
        row.launches[0].generation,
        "GENERATION_REUSED",
      );
      row.afterReopen = await custody(stateRoot, workspace);
      preserved(row.afterQuit, row.afterReopen, true);
      const originalLedger = site.driver.snapshot(),
        originalJournal = await journal();
      row.history = {};
      await runHistoryReadJourney({
        window: journeyPage,
        originals,
        hidden,
        active,
        report: row.history,
        save,
        unchanged: async () => {
          assert.deepEqual(site.driver.snapshot(), originalLedger);
          assert.deepEqual(await journal(), originalJournal);
        },
      });
      await edit(
        "Farol disposable first edited canary",
        "Farol disposable second edited canary",
      );
      row.writable = "PASS-two-normal-generations";
      await quit();
      row.status = "PASS";
    } else {
      const marker = await regular(path.join(stateRoot, "running.json"));
      assert.deepEqual(
        processes([launch.backend.pid]).find(
          (p) => p.pid === launch.backend.pid,
        ),
        launch.backend,
        "ORIGINAL_GO_CHILD_CHANGED",
      );
      launch.closeRequested = true;
      launch.status = "SIGKILL-issued";
      await save();
      assert.equal(
        child.kill("SIGKILL"),
        true,
        "EXACT_HOST_SIGKILL_NOT_DELIVERED",
      );
      await bounded(ended, "ORIGINAL_HOST_TERMINAL_UNKNOWN", 15000);
      await save();
      assert.deepEqual(launch.terminal, { code: null, signal: "SIGKILL" });
      await absent(launch.children);
      launch.originalGoChildAbsent = true;
      launch.goTerminalReceipt =
        "NOT_AVAILABLE-host-killed; observed-exact-original-child-absence-only";
      assert.deepEqual(
        await regular(path.join(stateRoot, "running.json")),
        marker,
      );
      row.afterCrash = await custody(stateRoot, workspace);
      preserved(row.beforeTransition, row.afterCrash);
      // A distinct NEW retained profile: seed only the historical Desktop
      // duplicate that older builds produced. This fixture is explicit; the
      // original quarantined c52 profile is never reopened, fixed or replayed.
      const prepared = row.chat.observations.find(
        (o) => o.label === "react-prepared-zero-send",
      );
      const operationId = prepared?.ui?.operationId;
      assert.match(
        operationId,
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
      );
      const legacyRoot = path.join(stateRoot, "chatgpt-task-journal");
      const legacyFile = path.join(legacyRoot, "chatgpt-task-journal.json");
      await assert.rejects(fs.lstat(legacyFile), { code: "ENOENT" });
      await fs.mkdir(legacyRoot, { mode: 0o700, recursive: true });
      const timestamp = new Date().toISOString();
      const legacyBytes = Buffer.from(
        JSON.stringify({
          schema: 1,
          operationId,
          kind: "readonly",
          phase: "prepared",
          createdAt: timestamp,
          updatedAt: timestamp,
          result: null,
        }) + "\n",
      );
      await fs.writeFile(legacyFile, legacyBytes, { flag: "wx", mode: 0o600 });
      const legacyOriginal = await regular(legacyFile);
      row.historicalLegacyFixture = {
        operationId,
        sha256: legacyOriginal.sha256,
        physical: legacyOriginal.physical,
        limit:
          "Explicit old-format metadata fixture on a NEW disposable profile; Chat/File/Go operations and startup are actual. No production/historical profile was edited.",
      };
      await save();
      await start();
      row.normalAPI = await page.evaluate(() => ({
        normal: typeof window.farol,
        recovery: typeof window.farolRecovery,
      }));
      assert.deepEqual(row.normalAPI, {
        normal: "object",
        recovery: "undefined",
      });
      assert.notEqual(
        launch.generation,
        row.launches[0].generation,
        "OLD_GENERATION_REUSED",
      );
      const coreRoot = path.join(stateRoot, "go-core");
      const names = (await fs.readdir(coreRoot)).filter((name) =>
        /^chat-retired-[a-f0-9-]{36}$/u.test(name),
      );
      assert.equal(names.length, 1, "EXACT_RETIRED_CHAT_NOT_OBSERVED");
      const retiredChat = names[0],
        archive = path.join(coreRoot, retiredChat);
      const completion = await json(
        path.join(archive, "maintenance-completed.json"),
      );
      assert.deepEqual(completion.selectedLegacyPreparation, {
        operationId,
        sha256: legacyOriginal.sha256,
        originalPhase: "prepared",
        legacyDisposition: "selected_for_retirement",
        correspondingGoOutcome: "unobserved",
      });
      assert.equal(
        Object.hasOwn(completion, "retainedLegacyPreparation"),
        false,
      );
      const legacyRetired = await regular(
        path.join(archive, "legacy-chatgpt-prepared.json"),
      );
      assert.deepEqual(legacyRetired.bytes, legacyBytes);
      for (const key of Object.keys(legacyOriginal.physical).filter(
        (k) => k !== "ctimeNs",
      ))
        assert.equal(
          legacyRetired.physical[key],
          legacyOriginal.physical[key],
          `LEGACY_PREPARATION_CHANGED:${key}`,
        );
      await assert.rejects(fs.lstat(legacyFile), { code: "ENOENT" });
      row.legacyRetirement =
        "PASS-original-bytes-inode-and-phase-retained-without-Go-outcome-claim";

      assert.equal(completion.schema, "farol.closed-preserved-chat-recovery/1");
      assert.equal(completion.buildId, build.identity.buildId);
      assert.equal(completion.failedRunSha256, marker.sha256);
      assert.equal(completion.preservedHistory.originalACK, "unobserved");
      assert.equal(completion.preservedHistory.originalTerminal, "unobserved");
      assert.equal(
        completion.preservedHistory.scope.Scope.BackendGeneration,
        row.launches[0].generation,
      );
      const retainedMarker = await regular(
        path.join(archive, "failed-running.json"),
      );
      assert.deepEqual(retainedMarker.bytes, marker.bytes);
      for (const key of Object.keys(marker.physical).filter(
        (key) => key !== "ctimeNs",
      ))
        assert.equal(
          retainedMarker.physical[key],
          marker.physical[key],
          `FAILED_RUN_CHANGED:${key}`,
        );
      row.failedRunRename = {
        before: marker.physical,
        after: retainedMarker.physical,
        ctimeLimit:
          "Rename may change ctime; original byte digest/inode/device/other metadata remain exact.",
      };
      await fs.lstat(path.join(archive, "maintenance-intent.json"));
      await assert.rejects(
        fs.lstat(path.join(stateRoot, "go-core.empty-recovery.pending")),
        { code: "ENOENT" },
      );
      const oldChat = path.join(coreRoot, "chat");
      const relocated = structuredClone(row.beforeTransition);
      for (const [key, value] of Object.entries(relocated))
        if ((key === "chat" || key.startsWith("chat/")) && value.path)
          value.path = value.path.replace(oldChat, archive);
      row.afterRecovery = await custody(stateRoot, workspace, retiredChat);
      preserved(relocated, row.afterRecovery);
      assert.deepEqual(
        site.driver.snapshot(),
        row.ledger,
        "RECOVERY_PROVIDER_ACTIVITY",
      );
      row.preservation =
        "PASS-original-chat-and-workspace-at-exact-archive-inodes";
      row.archive = {
        name: retiredChat,
        operationId: completion.operationId,
        originalACK: "unobserved",
        originalTerminal: "unobserved",
      };
      await save();
      await edit(
        "Farol disposable first edited canary",
        "Farol disposable second edited canary",
      );
      row.writable = "PASS-fresh-writable-generation-after-exact-host-crash";
      await assert.rejects(fs.lstat(legacyFile), { code: "ENOENT" });
      assert.deepEqual(
        await regular(path.join(archive, "legacy-chatgpt-prepared.json")),
        legacyRetired,
      );

      await journeyPage
        .getByRole("button", { name: "Home", exact: true })
        .click();
      const stored = page.locator("section.recovery-archive");
      assert.equal(await stored.count(), 1, "NORMAL_STORED_READER_NOT_UNIQUE");
      await stored
        .getByRole("button", { name: "Load stored replies", exact: true })
        .click();
      const replies = stored.getByRole("button", {
        name: /^Open stored reply \d+$/u,
      });
      await replies.nth(1).waitFor();
      assert.equal(await replies.count(), 2, "NORMAL_RETIRED_REPLY_COUNT");
      const expected = originals.map((value) => value.ui.answer).sort();
      row.recoveredAnswers = [];
      for (let i = 0; i < 2; i++) {
        await replies.nth(i).click();
        await page.waitForFunction(
          ({ expected, previous }) => {
            const text = document.querySelector(
              '[aria-label="Stored reply text"]',
            )?.textContent;
            return expected.includes(text) && text !== previous;
          },
          { expected, previous: row.recoveredAnswers.at(-1) ?? null },
        );
        row.recoveredAnswers.push(
          await stored
            .locator('[aria-label="Stored reply text"]')
            .textContent(),
        );
        assert.equal(
          await stored
            .getByText("Outcome unconfirmed", { exact: true })
            .count(),
          1,
        );
        assert.equal(await stored.locator("textarea,script").count(), 0);
        assert.equal(
          await stored
            .getByRole("button", { name: /^(Send|Resume|Acknowledge)/u })
            .count(),
          0,
        );
        await hidden();
        await save();
      }
      assert.deepEqual(
        [...row.recoveredAnswers].sort(),
        expected,
        "ORIGINAL_STORED_REPLY_TEXT_CHANGED",
      );
      assert.deepEqual(
        site.driver.snapshot(),
        row.ledger,
        "STORED_READER_PROVIDER_ACTIVITY",
      );
      row.retainedHistoryUI = "PASS-normal-unconfirmed-stored-copies";
      await quit();
      row.afterRecoveryQuit = await custody(stateRoot, workspace, retiredChat);
      for (const [key, value] of Object.entries(row.beforeTransition))
        if (key === "chat" || key.startsWith("chat/"))
          assert.deepEqual(
            row.afterRecoveryQuit[key],
            relocated[key],
            `ARCHIVED_CHAT_CHANGED_AFTER_NEW_WRITE:${key}`,
          );
      row.status = "PASS";
    }
  } finally {
    // One ordinary cleanup attempt only if neither Quit nor fault was issued.
    // No replacement process, marker repair, profile deletion or automatic retry.
    if (app && launch && !launch.closeRequested && !launch.terminal) {
      launch.closeRequested = true;
      launch.status = "failure-cleanup-quit-issued";
      await save();
      try {
        await bounded(
          app.evaluate(({ app }) => app.quit()),
          "CLEANUP_QUIT_CALL_UNKNOWN",
          5000,
        );
        await bounded(ended, "CLEANUP_TERMINAL_UNKNOWN", 15000);
        assert.ok(launch.backend, "CLEANUP_ORIGINAL_GO_CHILD_NOT_OBSERVED");
        await absent([launch.backend]);
        launch.originalGoChildAbsent = true;
      } catch (error) {
        launch.cleanupError = String(error);
      }
    }
    if (connectorFailure && ownedTunnel && !stopIssued) {
      try {
        await settleTunnel();
      } catch (error) {
        row.fixture.cleanupError = String(error);
        await save();
      }
    }
    if (site) {
      row.terminalLedger = site.driver.snapshot();
      await bounded(stopChatGptFixture(site), "FIXTURE_CLOSE_UNKNOWN", 5000);
    }
    await logWrites;
    await save();
  }
}
