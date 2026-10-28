import { desktopIdentity as harnessDesktopIdentity } from "../../tooling/harness-identity.ts";
// Explicit native lane: qualified Go build, completed-Setup fixture and hidden
// fresh Home -> Quit/reopen, or one exact idle host SIGKILL. Invalid settings or
// Computer storage stay BLOCKED. Historical UI reads are reported NOT RUN.
// No live provider, installed profile, replay or descendant claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
import { parseRecoveryArguments } from "./fixtures/startup-recovery-arguments.ts";
import { readOwnedChildProcesses } from "./runtime-process.mjs";
import {
  ELECTRON_RUNTIME,
  observeElectronRuntime,
  assertRuntimeObservation,
} from "../../tooling/runtime-contract.mjs";
import { _electron as electron } from "playwright-core";
import { isPromotionLeaseHeld } from "../../tooling/promotion-lease.mjs";
import {
  startChatGptFixture,
  stopChatGptFixture,
} from "./fixtures/chatgpt-site.mjs";

import {
  freshChatNamespaces,
  selectFreshChatJournal,
  assertFreshReady,
  assertPreservedEntries,
} from "./fixtures/fresh-startup-witness.ts";
import { reportRetiredJourney } from "../../tooling/setup-journey-retirement.mjs";
import { assertArchivedMarker } from "./fixtures/startup-marker-evidence.mjs";

const {
  savedSettings,
  forceQuit,
  normalHostCrash,
  storedReplies,
  backendCrash,
  computerStoreRefusal,
} = parseRecoveryArguments(process.argv.slice(2));
if (backendCrash) {
  reportRetiredJourney(
    "startup-recovery-pending-stored-read",
    "The explicit recovery-only stored-read UI is not the ordinary fresh startup route. No backend fault was launched.",
  );
  process.exit(2);
}
assert.equal(process.platform, "darwin");
const root = process.cwd(),
  source = sourceIdentity(root),
  buildRoot = path.join(root, "_output/build/app");
const build = await qualifyGoBuild(buildRoot, source);
assertRuntimeObservation(
  await observeElectronRuntime(path.join(root, "node_modules/electron")),
  ELECTRON_RUNTIME,
);
const temp = await fs.realpath(os.tmpdir());
assert.match(temp, /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u);
const profile = await fs.realpath(
  await fs.mkdtemp(path.join(temp, "farol-dev-onboarding-startup-")),
);
await fs.chmod(profile, 0o700);
const home = path.join(profile, "home"),
  appData = path.join(profile, "app-data");
const userData = harnessDesktopIdentity("dev", appData).userData,
  stateRoot = path.join(userData, "farol-state");
for (const dir of [home, stateRoot])
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const proof = randomUUID();
await fs.writeFile(path.join(profile, ".farol-e2e-root"), proof, {
  mode: 0o600,
  flag: "wx",
});
const evidence = path.join(
  root,
  "_output/evidence",
  `startup-recovery-${randomUUID()}.json`,
);
await fs.mkdir(path.dirname(evidence), { recursive: true, mode: 0o700 });
const report = {
  source,
  buildId: build.identity.buildId,
  fault: normalHostCrash
    ? "original-normal-host-SIGKILL"
    : forceQuit
      ? "first-fresh-host-SIGKILL"
      : backendCrash
        ? "original-recovery-backend-SIGSTOP-pending-UI-read-SIGKILL"
        : computerStoreRefusal
          ? "disposable-fixed-computer-access-snapshot-malformed"
          : "none",
  profile,
  status: "running",
  launches: [],
  fixture: {
    kind: savedSettings
      ? normalHostCrash
        ? "original-normal-Electron-host-SIGKILL"
        : "saved-settings-and-real-unretired-Go-owner"
      : "corrupt-settings-no-backend",
    stage: "preparing",
  },
  limits:
    "Disposable completed-Setup data only: dismissed=true is a synthetic historical Finish, not current attachment or owner Finish evidence. Ordinary fresh Home, current writable launch claims, exact observed child closure and clean Quit are checked against qualified built bytes. Original journals/UNKNOWN stay in place and failed run bytes are copied into run-history. Stored-reply mode seeds native Go records without original terminal/ACK or Send; only disk custody is checked, while stored-answer UI is NOT RUN. Backend-loss/stored-read UI mode is retired before launch. Invalid settings or Computer storage must stop with the actual startup code, without retry. No Shell execution, arbitrary descendant settlement, interrupted workspace-effect, reboot, installed or live-provider proof.",
};
const save = () =>
  fs.writeFile(evidence, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });

const children = (pid) =>
  readOwnedChildProcesses(pid).map(({ pid, command }) => ({ pid, command }));
const bounded = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
};

const physical = (info) =>
  [
    info.dev,
    info.ino,
    info.mode,
    info.uid,
    info.gid,
    info.nlink,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].map(String);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Fixed paths from seedRecoveryProfile -> openNativeProfileStorage and the
// Computer access disk's stateName. No caller-supplied path or old namespace.
const computerSnapshot = path.join(
  stateRoot,
  "go-core",
  "computer",
  "computer-access.json",
);
const computerCustody = path.join(profile, "computer-store-refusal-original");
const retainedComputerSnapshot = path.join(
  computerCustody,
  "computer-access.json",
);
let computerFault;
async function faultDirectories(withCustody = false) {
  const identities = {};
  for (const directory of [
    profile,
    appData,
    userData,
    stateRoot,
    path.join(stateRoot, "go-core"),
    path.dirname(computerSnapshot),
    ...(withCustody ? [computerCustody] : []),
  ]) {
    const info = await fs.lstat(directory, { bigint: true });
    assert.ok(info.isDirectory(), "COMPUTER_FAULT_PARENT_NOT_DIRECTORY");
    assert.equal(info.uid, BigInt(process.getuid()));
    assert.equal(info.mode & 0o7777n, 0o700n);
    assert.equal(await fs.realpath(directory), directory);
    identities[path.relative(profile, directory)] = [
      info.dev,
      info.ino,
      info.mode,
      info.uid,
      info.gid,
    ].map(String);
  }
  return identities;
}
async function faultFile(target) {
  const named = await fs.lstat(target, { bigint: true });
  assert.ok(named.isFile(), "COMPUTER_FAULT_INPUT_NOT_REGULAR");
  assert.equal(named.uid, BigInt(process.getuid()));
  assert.equal(named.mode & 0o7777n, 0o600n);
  assert.equal(named.nlink, 1n);
  assert.ok(named.size > 0n && named.size <= 1024n * 1024n);
  const file = await fs.open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    assert.deepEqual(physical(before), physical(named));
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    assert.equal(BigInt(bytesRead), before.size);
    const bytes = buffer.subarray(0, bytesRead);
    assert.deepEqual(
      physical(await file.stat({ bigint: true })),
      physical(before),
    );
    assert.deepEqual(
      physical(await fs.lstat(target, { bigint: true })),
      physical(before),
    );
    return { bytes, physical: physical(before), sha256: hash(bytes) };
  } finally {
    await file.close();
  }
}
async function injectComputerStoreRefusal() {
  assert.equal(seeded.originalChildCleanup, "confirmed");
  assert.equal(seeded.stored.entries.length, 33);
  assert.equal(path.dirname(profile), temp);
  assert.ok(path.basename(profile).startsWith("farol-dev-onboarding-startup-"));
  const directories = await faultDirectories();
  const marker = await faultFile(path.join(profile, ".farol-e2e-root"));
  assert.equal(marker.bytes.toString("utf8"), proof);
  const identity = await faultFile(
    path.join(stateRoot, "go-core", "profile.json"),
  );
  const nativeProfile = JSON.parse(identity.bytes.toString("utf8"));
  assert.equal(nativeProfile.schema, "farol-native-profile/2");
  assert.equal(nativeProfile.profileId, seeded.profileId);
  assert.equal(typeof nativeProfile.computerId, "string");
  assert.ok(nativeProfile.computerId.length > 0);
  const original = await faultFile(computerSnapshot);
  const access = JSON.parse(original.bytes.toString("utf8"));
  assert.equal(access.schema, 1);
  assert.equal(access.profileId, seeded.profileId);
  assert.equal(access.ownerId, "owner-desktop");
  assert.equal(access.computerId, nativeProfile.computerId);
  await fs.mkdir(computerCustody, { mode: 0o700 });
  await assert.rejects(fs.lstat(retainedComputerSnapshot), { code: "ENOENT" });
  assert.deepEqual(await faultDirectories(), directories);
  const custodyDirectories = await faultDirectories(true);
  report.computerStoreFault = {
    stage: "selected-original-unchanged",
    snapshot: path.relative(profile, computerSnapshot),
    custody: path.relative(profile, retainedComputerSnapshot),
    profileId: seeded.profileId,
    originalChildCleanup: seeded.originalChildCleanup,
    original: { sha256: original.sha256, physical: original.physical },
  };
  await save();
  assert.deepEqual(await faultFile(computerSnapshot), original);
  assert.deepEqual(await faultDirectories(true), custodyDirectories);
  await fs.rename(computerSnapshot, retainedComputerSnapshot);
  const retained = await faultFile(retainedComputerSnapshot);
  assert.deepEqual(retained.bytes, original.bytes);
  // Rename can change ctime, but retains the original inode and other metadata.
  assert.deepEqual(
    retained.physical.slice(0, -1),
    original.physical.slice(0, -1),
  );
  report.computerStoreFault.stage = "original-retained";
  report.computerStoreFault.retained = {
    sha256: retained.sha256,
    physical: retained.physical,
  };
  await save();
  const malformed = Buffer.from('{"syntheticComputerStoreRefusal":\n');
  assert.throws(() => JSON.parse(malformed.toString("utf8")));
  assert.deepEqual(await faultDirectories(true), custodyDirectories);
  const file = await fs.open(
    computerSnapshot,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    Number(BigInt(original.physical[2]) & 0o7777n),
  );
  try {
    await file.writeFile(malformed);
    await file.sync();
  } finally {
    await file.close();
  }
  for (const directory of [path.dirname(computerSnapshot), computerCustody]) {
    const handle = await fs.open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const replacement = await faultFile(computerSnapshot);
  assert.deepEqual(replacement.bytes, malformed);
  assert.notDeepEqual(
    replacement.physical.slice(0, 2),
    retained.physical.slice(0, 2),
  );
  assert.deepEqual(await faultFile(retainedComputerSnapshot), retained);
  assert.deepEqual(await faultDirectories(true), custodyDirectories);
  computerFault = {
    directories: custodyDirectories,
    files: new Map([
      [computerSnapshot, replacement],
      [retainedComputerSnapshot, retained],
      [path.join(profile, ".farol-e2e-root"), marker],
    ]),
  };
  report.computerStoreFault.stage = "malformed-replacement-original-retained";
  report.computerStoreFault.replacement = {
    sha256: replacement.sha256,
    physical: replacement.physical,
  };
}

async function seedHistoricalCompletion() {
  const file = path.join(stateRoot, "config.json");
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  value.setup.journey.dismissed = true;
  value.general.openAtLaunch = "home";
  await fs.writeFile(file, JSON.stringify(value) + "\n", { mode: 0o600 });
  report.fixture.setupCompletion =
    "synthetic historical Finish; no current attachment or Finish proof";
}
await save();
let seeded;
try {
  if (savedSettings) {
    const fixture = path.join(root, "_output/tests/recovery-profile.cjs");
    await fs.mkdir(path.dirname(fixture), { recursive: true });
    buildSync({
      entryPoints: [path.join(root, "tests/fixtures/recovery-profile.ts")],
      outfile: fixture,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
    });
    const { seedRecoveryProfile, prepareRecoverySettings } = createRequire(
      import.meta.url,
    )(fixture);
    const input = {
      stateRoot,
      home,
      workspace: path.join(profile, "workspace"),
      artifactRoot: buildRoot,
      core: build.manifest.core,
    };
    if (normalHostCrash) {
      const prepared = await prepareRecoverySettings(input);
      assert.equal(prepared.settings.connectors.secureMcp.tunnelId, null);
      assert.equal(prepared.settings.connectors.secureMcp.tunnelClient, null);
      seeded = {
        workspaceId: prepared.workspaceId,
        settingsRevision: prepared.settings.revision,
      };
      await assert.rejects(fs.lstat(path.join(stateRoot, "go-core")), {
        code: "ENOENT",
      });
      await seedHistoricalCompletion();
      await crashNormalHost();
    } else {
      seeded = await seedRecoveryProfile(input);
      await seedHistoricalCompletion();
    }
  }
  if (storedReplies) {
    // Independent test setup after exact original child cleanup. The tested
    // recovery backend remains the qualified package binary, never this tool.
    assert.equal(seeded.originalChildCleanup, "confirmed");
    const output = execFileSync(
      "go",
      [
        "run",
        "./tests/fixtures/recovery-archive-native",
        profile,
        proof,
        seeded.profileId,
        seeded.oldGeneration,
        userData,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off" },
      },
    );
    seeded.stored = JSON.parse(output);
    assert.equal(
      seeded.stored.kind,
      "synthetic-native-retain-then-UNKNOWN-without-terminal-or-ACK",
    );
    assert.equal(seeded.stored.entries.length, 33);
    seeded.fixtureGo = execFileSync("go", ["version"], {
      encoding: "utf8",
    }).trim();
  }
  report.fixture = { ...report.fixture, stage: "prepared", ...seeded };
  if (computerStoreRefusal) {
    // Keep the original seed lifecycle and receipts even if fault setup fails.
    await save();
    await injectComputerStoreRefusal();
  }
  await save();
} catch (error) {
  report.status = "fixture-failed-or-unknown";
  report.error = String(error?.stack ?? error);
  await save();
  throw error;
}

const retained = new Map([
  [
    "running.json",
    normalHostCrash
      ? await fs.readFile(path.join(stateRoot, "running.json"))
      : Buffer.from(
          JSON.stringify({
            schema: 1,
            pid: 2147483647,
            startedAt: new Date().toISOString(),
            bootTime: null,
            processStart: null,
          }) + "\n",
        ),
  ],
  ...(normalHostCrash
    ? []
    : [["last-quit.json", Buffer.from('{"synthetic":"undrained Quit"}\n')]]),
  [
    "config.json",
    savedSettings
      ? await fs.readFile(path.join(stateRoot, "config.json"))
      : Buffer.from('{"synthetic":"retained corrupt configuration"}\n'),
  ],
]);
for (const [name, bytes] of retained)
  if (!normalHostCrash && !(savedSettings && name === "config.json"))
    await fs.writeFile(path.join(stateRoot, name), bytes, {
      mode: 0o600,
      flag: "wx",
    });
// Capture before either fresh lifetime; never derive expected bytes from
// the filesystem after the operation being checked. Access time is excluded
// because ordinary reads may update it.
const expectedNote = savedSettings
  ? await fs.readFile(path.join(profile, "workspace", "note.md"))
  : null;
const preserved = async (includeStateFiles = true) => {
  const result = {};
  if (normalHostCrash && includeStateFiles)
    await assert.rejects(fs.lstat(path.join(stateRoot, "last-quit.json")), {
      code: "ENOENT",
    });
  for (const [name, bytes] of retained) {
    if (!includeStateFiles) continue;
    const actual = await fs.readFile(path.join(stateRoot, name));
    assert.deepEqual(actual, bytes, `PREDECESSOR_CHANGED:${name}`);
    const info = await fs.lstat(path.join(stateRoot, name), { bigint: true });
    result[name] = JSON.stringify({
      bytes: hash(actual),
      physical: physical(info),
    });
  }
  if (!savedSettings)
    await assert.rejects(fs.lstat(path.join(stateRoot, "go-core")), {
      code: "ENOENT",
    });
  else {
    for (const [name, directory] of [
      ...["profile.json", "chat", "task", "computer/mutations"].map((name) => [
        name,
        path.join(stateRoot, "go-core", name),
      ]),
      ["workspace", path.join(profile, "workspace")],
    ]) {
      const inspect = async (target) => {
        const info = await fs.lstat(target, { bigint: true });
        const key =
          name === "workspace"
            ? `workspace/${path.relative(directory, target)}`
            : path.relative(stateRoot, target);
        if (info.isDirectory()) {
          if (name === "workspace")
            result[key] = JSON.stringify({ physical: physical(info) });
          for (const child of (await fs.readdir(target)).sort())
            await inspect(path.join(target, child));
          return;
        }
        assert.ok(info.isFile(), `UNEXPECTED_RECOVERY_FIXTURE_ENTRY:${key}`);
        result[key] = JSON.stringify({
          bytes: hash(await fs.readFile(target)),
          physical: physical(info),
        });
      };
      await inspect(directory);
    }
  }
  if (computerStoreRefusal) {
    assert.ok(computerFault, "COMPUTER_STORE_FAULT_NOT_PREPARED");
    assert.deepEqual(await faultDirectories(true), computerFault.directories);
    assert.deepEqual(await fs.readdir(computerCustody), [
      "computer-access.json",
    ]);
    for (const [target, expected] of computerFault.files) {
      const actual = await faultFile(target);
      assert.deepEqual(
        actual,
        expected,
        "COMPUTER_STORE_FAULT_OR_CUSTODY_CHANGED",
      );
      result[path.relative(profile, target)] = JSON.stringify({
        bytes: actual.sha256,
        physical: actual.physical,
      });
    }
    assert.deepEqual(await faultDirectories(true), computerFault.directories);
  }
  if (report.preservedBaseline) {
    const baseline = Object.fromEntries(
      Object.entries(report.preservedBaseline).filter(
        ([key]) => includeStateFiles || !retained.has(key),
      ),
    );
    assertPreservedEntries(baseline, result);
  }
  return result;
};
// Fresh admission archives the predecessor before publishing this host's run
// marker. A later Go refusal does not put the predecessor back at that path.
async function assertOriginalMarkerArchive(launch) {
  launch.originalMarkerArchive = await assertArchivedMarker(
    stateRoot,
    retained.get("running.json"),
    retained.get("last-quit.json"),
  );
}
// Wait for these exact observed PIDs only; never kill a child to make the
// assertion pass. Timeout retains the disposable profile and original evidence.
async function waitForObservedChildrenExit(observed) {
  const deadline = performance.now() + 15000;
  let remaining;
  do {
    remaining = observed.filter(({ pid }) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    });
    if (remaining.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (performance.now() < deadline);
  throw new Error(
    `OBSERVED_RECOVERY_CHILDREN_RETAINED:${remaining.map(({ pid }) => pid).join(",")}`,
  );
}

// The renderer can otherwise hand capturePage its preceding compositor frame
// after focus/media/size changes. Unthrottle only this test-owned document for
// two paint frames, capture without making it visible, then restore its setting.

function launchOptions(extra = {}) {
  return {
    executablePath: path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    env: {
      ...extra,
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
    },
    timeout: 15000,
  };
}

async function crashNormalHost() {
  const fixture = await startChatGptFixture();
  const original = { phase: "selected", faultRequested: false };
  report.originalHost = original;
  let application, ended;
  try {
    await save();
    application = await electron.launch(
      launchOptions({ FAROL_E2E_CHATGPT_URL: fixture.url }),
    );
    const child = application.process();
    original.pid = child.pid;
    ended = once(child, "exit");
    void ended.catch(() => undefined);
    const page = await application.firstWindow({ timeout: 15000 });
    await page.locator(".desktop").waitFor({ state: "visible" });
    let ready = false;
    for (let n = 0; n < 100; n++) {
      const snapshot = await page.evaluate(() => window.farol.bootstrap());
      if (
        snapshot.runtimeState === "ready" &&
        snapshot.configuration.status === "ready"
      ) {
        assert.equal(
          snapshot.configuration.settings.connectors.secureMcp.tunnelId,
          null,
        );
        assert.equal(
          snapshot.configuration.settings.connectors.secureMcp.runtime,
          null,
        );
        assert.equal(
          snapshot.configuration.settings.connectors.secureMcp.credential,
          "missing",
        );
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "ORIGINAL_NORMAL_HOST_NOT_READY");
    original.windows = await application.evaluate(
      ({ BrowserWindow, webContents }) => ({
        windows: BrowserWindow.getAllWindows().map((win) => ({
          visible: win.isVisible(),
          focused: win.isFocused(),
        })),
        urls: webContents
          .getAllWebContents()
          .map((contents) => contents.getURL()),
      }),
    );
    assert.ok(original.windows.windows.length > 0);
    for (const window of original.windows.windows)
      assert.deepEqual(window, { visible: false, focused: false });
    for (const url of original.windows.urls)
      assert.ok(
        url === "" ||
          url === "about:blank" ||
          url.startsWith("file://") ||
          url.startsWith(new URL(fixture.url).origin + "/"),
        "ORIGINAL_HOST_EXTERNAL_BROWSER_ROUTE",
      );
    const marker = await fs.readFile(path.join(stateRoot, "running.json"));
    assert.equal(JSON.parse(marker).pid, child.pid);
    original.runningMarkerSha256 = createHash("sha256")
      .update(marker)
      .digest("hex");
    await assert.rejects(fs.lstat(path.join(stateRoot, "last-quit.json")), {
      code: "ENOENT",
    });
    original.children = children(child.pid);
    const backends = original.children.filter(({ command }) =>
      /farol-backend/u.test(command),
    );
    assert.equal(backends.length, 1, "ORIGINAL_HOST_BACKEND_COUNT");
    assert.doesNotMatch(backends[0].command, /--startup-mode recovery/u);
    original.backend = backends[0];
    // Ordinary startup owns its in-memory preview service independently of
    // Go and any connector. Identify that exact child instead of mistaking
    // runtime.cjs for a configured tunnel or an external effect.
    const previews = original.children.filter(({ command }) =>
      /(?:^|\/)runtime\.cjs(?:\s|$)/u.test(command),
    );
    assert.equal(previews.length, 1, "ORIGINAL_PREVIEW_RUNTIME_COUNT");
    assert.equal(
      previews[0].command,
      `${path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")} ${path.join(buildRoot, "runtime.cjs")}`,
      "ORIGINAL_PREVIEW_RUNTIME_IDENTITY",
    );
    original.previewRuntime = previews[0];
    assert.equal(
      await isPromotionLeaseHeld(userData),
      false,
      "NORMAL_HOST_STARTUP_EXCLUSION_NOT_RELEASED",
    );
    original.phase = "ready-idle-no-effect-dispatched";
    original.faultRequested = true;
    await save();
    assert.equal(
      child.kill("SIGKILL"),
      true,
      "ORIGINAL_HOST_FAULT_NOT_DELIVERED",
    );
    const [code, signal] = await bounded(ended, "ORIGINAL_HOST_EXIT_UNKNOWN");
    original.exitCode = code;
    original.signal = signal;
    await save();
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    await waitForObservedChildrenExit(original.children);
    assert.deepEqual(
      await fs.readFile(path.join(stateRoot, "running.json")),
      marker,
      "ORIGINAL_RUN_MARKER_CHANGED_AFTER_CRASH",
    );
    original.observedDirectChildrenAbsent = original.children.map(
      ({ pid }) => pid,
    );
    original.phase = "crashed-original-marker-and-profile-retained";
    await save();
  } catch (error) {
    if (application && !original.faultRequested) {
      original.cleanupRequested = true;
      try {
        await application.evaluate(({ app }) => app.quit());
        original.cleanupExit = await bounded(
          ended,
          "ORIGINAL_HOST_CLEANUP_UNKNOWN",
        );
      } catch (cleanup) {
        original.cleanupError = String(cleanup);
      }
    }
    throw error;
  } finally {
    await bounded(
      stopChatGptFixture(fixture),
      "ORIGINAL_LOOPBACK_FIXTURE_CLOSE_UNKNOWN",
    );
  }
}

function ownerChoices(settings) {
  return {
    general: settings.general,
    tasks: settings.tasks,
    computer: {
      computerId: settings.computer.computerId,
      commands: settings.computer.commands,
      pendingEdit: settings.computer.pendingEdit,
      workspaces: settings.computer.workspaces.map(
        ({
          workspaceId,
          root,
          label,
          access,
          rootIdentity,
          excludedPaths,
          gitHistoryApproved,
        }) => ({
          workspaceId,
          root,
          label,
          access,
          rootIdentity,
          excludedPaths,
          gitHistoryApproved,
        }),
      ),
    },
    dismissed: settings.setup.journey.dismissed,
  };
}
const expectedChoices = savedSettings
  ? ownerChoices(JSON.parse(retained.get("config.json").toString("utf8")))
  : null;
async function runFreshLaunch(application, page, child, launch, before) {
  await page.locator(".desktop").waitFor();
  const deadline = performance.now() + 20000;
  let bootstrap;
  do {
    bootstrap = await page.evaluate(() => window.farol.bootstrap());
    if (
      bootstrap.runtimeState === "ready" &&
      bootstrap.configuration.status === "ready"
    )
      break;
    assert.ok(performance.now() < deadline, "FRESH_BOOTSTRAP_NOT_READY");
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (true);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  launch.children = children(child.pid);
  const backends = launch.children.filter(({ command }) =>
    /farol-backend/u.test(command),
  );
  assert.equal(backends.length, 1, "CURRENT_FRESH_BACKEND_AMBIGUOUS");
  launch.backend = backends[0];
  assertFreshReady(bootstrap, launch.backend.command);
  const current = await selectFreshChatJournal(stateRoot, before);
  launch.generation = current.generation;
  launch.currentJournal = current.file;
  launch.normalAPI = await page.evaluate(() => ({
    normal: typeof window.farol,
    recovery: typeof window.farolRecovery,
  }));
  assert.deepEqual(launch.normalAPI, {
    normal: "object",
    recovery: "undefined",
  });
  const windows = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      visible: win.isVisible(),
      focused: win.isFocused(),
    })),
  );
  for (const win of windows)
    assert.deepEqual(win, { visible: false, focused: false });
  assert.deepEqual(
    ownerChoices(bootstrap.configuration.settings),
    expectedChoices,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(stateRoot, "running.json"))).pid,
    child.pid,
  );
  // Original journals stay in place. New fresh namespaces are append-only extras.
  await preserved(false);
  await assertOriginalMarkerArchive(launch);
  launch.coverage = {
    home: "PASS",
    globallyLimited: false,
    storedReplyUI: "NOT_RUN-normal-history-UI-unavailable",
  };
  launch.beforeQuit = await preserved(false);
  launch.closeRequested = true;
  await save();
  const crash = forceQuit && launch.ordinal === 1;
  if (crash) assert.equal(child.kill("SIGKILL"), true);
  else await application.evaluate(({ app }) => app.quit());
  const [code, signal] = await bounded(exit, "CURRENT_FRESH_TERMINAL_UNKNOWN");
  launch.exitCode = code;
  launch.signal = signal;
  assert.equal(code, crash ? null : 0);
  assert.equal(signal, crash ? "SIGKILL" : null);
  await waitForObservedChildrenExit(launch.children);
  if (!crash) {
    const quit = JSON.parse(
      await fs.readFile(path.join(stateRoot, "last-quit.json")),
    );
    assert.equal(quit.drained, true);
    assert.deepEqual(quit.unconfirmed, []);
    await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
      code: "ENOENT",
    });
  }
  await preserved(false);
  assert.equal(await isPromotionLeaseHeld(userData), false);
  launch.cleanupConfirmed = true;
  app = null;
  await save();
}
let freshSite;
let app, exit, launch;
try {
  report.preservedBaseline = await preserved();
  freshSite =
    savedSettings && !computerStoreRefusal
      ? await startChatGptFixture({
          controlledScenario: {
            conversationId: "fresh-startup-observation",
            selection: {
              model: "Test model",
              effort: "Light",
              connector: null,
            },
            turns: [
              {
                userId: "startup-user",
                replyId: "startup-reply",
                prompt: "This startup fixture must never receive a message.",
                segments: [{ id: "startup-segment", text: "Unexpected Send." }],
              },
            ],
          },
        })
      : null;
  await save();
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    launch = { ordinal, closeRequested: false, cleanupConfirmed: false };
    report.launches.push(launch);
    await save();
    const namespacesBefore = await freshChatNamespaces(stateRoot);
    app = await electron.launch(
      launchOptions(freshSite ? { FAROL_E2E_CHATGPT_URL: freshSite.url } : {}),
    );
    const child = app.process();
    launch.pid = child.pid;
    // Keep only the original producer's bounded content-free observations.
    // No stderr transcript or diagnostic text is archived.
    const originalLaunch = launch;
    originalLaunch.backendLifecycle = [];
    let diagnostics = "";
    launch.startupCodes = [];
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk.toString("utf8");
      if (diagnostics.length > 65536) {
        originalLaunch.diagnosticsOverflow = true;
        diagnostics = "";
        return;
      }
      const lines = diagnostics.split("\n");
      diagnostics = lines.pop();
      for (const line of lines) {
        const failure = /^FAROL_STARTUP_FAILURE:([A-Z][A-Z0-9_]{2,63})$/u.exec(
          line,
        );
        if (failure) originalLaunch.startupCodes.push(failure[1]);
        const prefix = "FAROL_BACKEND_LIFECYCLE:";
        if (!line.startsWith(prefix)) continue;
        try {
          const value = JSON.parse(line.slice(prefix.length));
          assert.equal(value.source, "go-backend");
          assert.ok(["startup", "active", "closing"].includes(value.phase));
          assert.ok(
            ["failure", "child-close", "cleanup-unknown"].includes(value.event),
          );
          assert.ok(
            ["observed", "outcome_unknown", "unavailable"].includes(
              value.state,
            ),
          );
          assert.match(value.code, /^[a-z_]{1,80}$/u);
          assert.ok(
            value.exitCode === null || Number.isInteger(value.exitCode),
          );
          assert.ok(
            value.signal === null || /^SIG[A-Z0-9]{1,12}$/u.test(value.signal),
          );
          assert.equal(typeof value.forced, "boolean");
          for (const key of ["hostLifetimeId", "childLaunchId"])
            assert.ok(
              value[key] === null || /^[a-f0-9-]{36}$/u.test(value[key]),
            );
          assert.ok(originalLaunch.backendLifecycle.length < 64);
          originalLaunch.backendLifecycle.push({
            source: value.source,
            phase: value.phase,
            event: value.event,
            code: value.code,
            state: value.state,
            exitCode: value.exitCode,
            signal: value.signal,
            forced: value.forced,
            hostLifetimeId: value.hostLifetimeId,
            childLaunchId: value.childLaunchId,
          });
        } catch {
          originalLaunch.diagnosticsInvalid = true;
        }
      }
    });
    exit = once(child, "exit");
    void exit.catch(() => undefined);
    if (!savedSettings || computerStoreRefusal) {
      const [code, signal] = await bounded(
        exit,
        "BLOCKED_STARTUP_TERMINAL_UNKNOWN",
      );
      launch.exitCode = code;
      launch.signal = signal;
      launch.closeRequested = true;
      assert.equal(code, 1);
      assert.equal(signal, null);
      assert.equal(
        launch.startupCodes.length,
        1,
        "EXACT_STARTUP_BLOCKER_MISSING",
      );
      if (!savedSettings)
        assert.equal(launch.startupCodes[0], "SETTINGS_CORRUPT");
      launch.blocker = launch.startupCodes[0];
      if (computerStoreRefusal) {
        assert.equal(
          JSON.parse(await fs.readFile(path.join(stateRoot, "running.json")))
            .pid,
          child.pid,
          "CURRENT_FAILED_MARKER_OWNER_MISMATCH",
        );
        for (const name of ["config.json", "last-quit.json"])
          assert.deepEqual(
            await fs.readFile(path.join(stateRoot, name)),
            retained.get(name),
            `PREDECESSOR_CHANGED:${name}`,
          );
        await assertOriginalMarkerArchive(launch);
        await preserved(false);
        // A startup rejection does not prove settlement of its Go child.
        launch.cleanupConfirmed = false;
      } else {
        await preserved();
        launch.cleanupConfirmed = true;
      }
      report.status = "BLOCKED";
      report.profileRetained = true;
      process.exitCode = 2;
      app = null;
      break; // No retry/reopen after this blocked attempt.
    }
    const page = await app.firstWindow({ timeout: 15000 });
    await runFreshLaunch(app, page, child, launch, namespacesBefore);
  }

  if (report.status !== "BLOCKED") {
    assert.equal(freshSite.driver.snapshot().acceptedSends, 0);
    report.status = storedReplies
      ? "PARTIAL-original-custody-PASS-history-UI-NOT_RUN"
      : "PASS-fresh-Home-current-claims-clean-Quit-originals-preserved";
    report.profileRetained = true;
    if (storedReplies) process.exitCode = 2;
  }
} catch (error) {
  report.status = "failed-or-unknown";
  report.error = String(error?.stack ?? error);
  if (app && launch && !launch.closeRequested) {
    // One cleanup request only for the original known test host. Never replay
    // an uncertain renderer Quit or launch another process after failure.
    launch.closeRequested = true;
    try {
      await app.evaluate(({ app }) => app.quit());
      launch.cleanupExit = await bounded(exit, "RECOVERY_CLEANUP_UNKNOWN");
    } catch (cleanupError) {
      launch.cleanupError = String(cleanupError);
    }
  }
  process.exitCode = 1;
} finally {
  if (freshSite) await stopChatGptFixture(freshSite);
  await save();
  process.stdout.write(
    `Startup recovery evidence: ${evidence} (${report.status})\n`,
  );
}
