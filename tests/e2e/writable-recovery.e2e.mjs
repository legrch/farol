/**
 * Explicit hidden macOS Dev lane. Build clean committed bytes first:
 * task dev -- --check
 * node tests/e2e/writable-recovery.e2e.mjs --run-native
 *   --source-sha <exact committed SHA> --build-id <qualified build ID>
 * Optional --scenario normal|crash (default both). Never automatically rerun.
 * Synthetic loopback account/provider only. No installed/live-provider, OS sleep,
 * interrupted-effect or arbitrary-descendant qualification. Profiles are retained.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    "--run-native --source-sha SHA --build-id ID [--scenario normal|crash]",
  ],
  normal:
    "Normal main.cjs/Go -> approved disposable folder -> real Chat results/ACK/settlement -> Go-owned guarded File edit/read/result ACK -> ordinary confirmed Quit -> same-profile fresh writable generation -> original saved Chat answers/workspace/result -> second File edit/read/result ACK -> confirmed Quit",
  crash:
    "Fresh normal main.cjs/Go -> same real work -> exact observed Electron host SIGKILL -> observe original direct Go child absent -> one same-profile recovery launch -> original physical history/results/workspace and actual archive UI -> report writable availability separately -> ordinary Quit",
  limits: [
    "Synthetic loopback provider/account/tasks and disposable workspace; existing admitted normal preload/UI flows, no product seam or injected journal/result",
    "Legacy Chat/history witness labels mention Home remount; this harness records actual Home -> Settings -> Diagnostics -> ChatGPT acceptance tools navigation. No renderer mounting or Home-hosted-control claim",
    "Go owns Settings edit admission/pending/result; existing typed host storage performs conditional filesystem writes, not an autonomous model tool call",
    "Hidden windows throughout; no focus, real picker, real provider, tunnel, installed profile, sleep/reboot or interrupted-effect qualification",
    "Exact observed direct child absence is not arbitrary descendant settlement or an original Go terminal/ACK receipt after host SIGKILL",
    "Read-only recovery is preservation evidence only; it never satisfies writable recovery acceptance",
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
      ["--source-sha", "--build-id", "--scenario"].includes(key) &&
        value &&
        !Object.hasOwn(pins, key),
      "INVALID_ARGUMENT",
    );
    pins[key] = value;
  }
  assert.match(pins["--source-sha"] ?? "", /^[a-f0-9]{40}$/u);
  assert.match(pins["--build-id"] ?? "", /^[a-f0-9]{64}$/u);
  assert.ok([undefined, "normal", "crash"].includes(pins["--scenario"]));
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
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
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
function processes() {
  return execFileSync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return m
        ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }]
        : [];
    });
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
async function custody(stateRoot, workspace) {
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
    await walk(path.join(stateRoot, "go-core", name), name);
  await walk(workspace, "workspace");
  return result;
}
function preserved(original, current, allowJournalAdvance = false) {
  for (const [name, value] of Object.entries(original)) {
    if (
      allowJournalAdvance &&
      (name === "chat/chat-lifecycle.json" ||
        /^chat\/chat-handoff-/u.test(name))
    )
      continue;
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
          row,
          retainedRoot,
          temp,
          source,
          build,
          save,
          active,
        });
      } catch (error) {
        row.status = "FAILED_OR_UNKNOWN";
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
  const stateRoot = path.join(appData, "Farol Dev", "farol-next-state");
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
  await fs.writeFile(path.join(profile, ".farol-next-e2e-root"), proof, {
    mode: 0o600,
    flag: "wx",
  });
  row.profile = profile;
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
  // The shared journey's pure witnesses remain useful, but its navigation
  // predates the accepted UI move. Translate only the Home click into actual
  // visible DOM navigation through the current Diagnostics disclosure. Never
  // inject a controller response, source seam, fake DOM or hidden action.
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
        click: async (options) => {
          active();
          await hidden();
          await target.click(options);
          await page
            .getByRole("button", { name: "Settings", exact: true })
            .click(options);
          await page
            .locator(".contextual-sidebar")
            .getByRole("button", { name: "Diagnostics", exact: true })
            .click(options);
          const disclosure = page.locator("details").filter({
            has: page
              .locator("summary")
              .getByText("ChatGPT acceptance tools", { exact: true }),
          });
          assert.equal(
            await disclosure.count(),
            1,
            "CHAT_ACCEPTANCE_DISCLOSURE_NOT_UNIQUE",
          );
          if (!(await disclosure.evaluate((element) => element.open)))
            await disclosure.locator(":scope > summary").click(options);
          await page
            .locator('section[aria-label="Saved Chat answers"]')
            .waitFor({ state: "visible", timeout: 5000 });
          (row.navigation ??= []).push({
            path: [
              "Home",
              "Settings",
              "Diagnostics",
              "ChatGPT acceptance tools",
            ],
            hidden: true,
          });
          await hidden();
          await save();
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
      page.evaluate((value) => window.farolNext.configure(value), command),
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
  const start = async (recovery = false) => {
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
        FAROL_NEXT_ENVIRONMENT: "dev",
        FAROL_NEXT_E2E: "1",
        FAROL_NEXT_E2E_APP_DATA: appData,
        FAROL_NEXT_E2E_TEST_ROOT: profile,
        FAROL_NEXT_E2E_TEST_PROOF: proof,
        FAROL_NEXT_E2E_CHATGPT_URL: site.url,
        FAROL_NEXT_E2E_WORKSPACE_ROOT: workspace,
        FAROL_NEXT_E2E_WORKSPACE_FILE: path.join(
          workspace,
          readCanary.relativePath,
        ),
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
    if (recovery)
      await page
        .getByRole("heading", {
          name: "Your previous session needs recovery",
          exact: true,
        })
        .waitFor();
    else {
      await page.waitForFunction(
        async () => {
          const value = await window.farolNext.bootstrap();
          return (
            value.runtimeState === "ready" &&
            value.configuration.status === "ready"
          );
        },
        undefined,
        { timeout: 20000 },
      );
      const bootstrap = await page.evaluate(() => window.farolNext.bootstrap());
      assert.equal(bootstrap.environment, "dev");
      assert.equal(bootstrap.applicationId, "local.farol.dev");
      launch.marker = await json(path.join(stateRoot, "running.json"));
      assert.equal(launch.marker.pid, child.pid);
      launch.journal = await journal();
      launch.generation = launch.journal.scope.BackendGeneration;
      assert.ok(launch.generation);
    }
    await hidden();
    assert.equal(
      await app.evaluate(({ app }) => app.getPath("userData")),
      path.join(appData, "Farol Dev"),
    );
    launch.children = processes().filter((p) => p.ppid === child.pid);
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
    row.beforeTransition = await custody(stateRoot, workspace);
    row.ledger = site.driver.snapshot();
    await save();
    assert.equal(row.ledger.acceptedSends, 2);
    if (name === "normal") {
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
        processes().find((p) => p.pid === launch.backend.pid),
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
      await start(true);
      row.recoveryApi = await page.evaluate(() => ({
        normal: typeof window.farolNext,
        recovery: typeof window.farolRecovery,
      }));
      row.writable = "BLOCKED-read-only-recovery";
      assert.deepEqual(row.recoveryApi, {
        normal: "undefined",
        recovery: "object",
      });
      await page
        .getByRole("button", { name: "Stored replies", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Load stored replies", exact: true })
        .click();
      const rows = page.getByRole("button", {
        name: /^Open stored reply \d+$/u,
      });
      await rows.nth(1).waitFor();
      assert.equal(await rows.count(), 2);
      const expected = originals.map((value) => value.ui.answer).sort();
      row.recoveredAnswers = [];
      for (let i = 0; i < 2; i++) {
        await rows.nth(i).click();
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
          await page.locator('[aria-label="Stored reply text"]').textContent(),
        );
        await save();
      }
      assert.deepEqual(
        [...row.recoveredAnswers].sort(),
        expected,
        "ORIGINAL_RESULT_TEXT_NOT_RECOVERED",
      );
      assert.deepEqual(
        await regular(path.join(stateRoot, "running.json")),
        marker,
      );
      row.afterRecovery = await custody(stateRoot, workspace);
      preserved(row.beforeTransition, row.afterRecovery);
      assert.deepEqual(
        site.driver.snapshot(),
        row.ledger,
        "RECOVERY_PROVIDER_ACTIVITY",
      );
      row.preservation = "PASS-original-nonempty-history-results-workspace";
      await quit(true);
      row.afterRecoveryQuit = await custody(stateRoot, workspace);
      preserved(row.beforeTransition, row.afterRecoveryQuit);
      row.status = "BLOCKED-writable-recovery-not-available";
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
    if (site) {
      row.terminalLedger = site.driver.snapshot();
      await bounded(stopChatGptFixture(site), "FIXTURE_CLOSE_UNKNOWN", 5000);
    }
    await logWrites;
    await save();
  }
}
