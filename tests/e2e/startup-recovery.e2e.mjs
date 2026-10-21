// Explicit native lane: exact Go build and synthetic data, with either a
// synthetic predecessor or an actual idle normal-host crash. Hidden recovery
// UI -> Quit or exact-host SIGKILL -> same-profile reopen. No live provider,
// installed profile, operation replay or arbitrary descendant claim. The optional
// Computer store refusal is a future post-fix journey, not baseline qualification.
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

const {
  savedSettings,
  forceQuit,
  normalHostCrash,
  storedReplies,
  backendCrash,
  computerStoreRefusal,
} = parseRecoveryArguments(process.argv.slice(2));
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
const userData = path.join(appData, "Farol Dev"),
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
      ? "first-recovery-host-SIGKILL"
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
    "Synthetic data only. Stored-reply mode seeds real Go result records with an explicit UNKNOWN after the old backend exits, without original terminal/ACK or Browser Send; it is native archive/IPC/UI custody evidence only. Normal-host crash uses its actual marker, original Go owner and loopback Browser fixture. Optional recovery-host/backend crash retains a synthetic predecessor marker. Backend-loss mode suspends only the exact observed Go child, starts one explicit UI read and then kills that same child; pending UI is not proof the backend received/processed the request. Computer-store refusal retains the original fixed access snapshot in the same fresh private namespace, replaces only that snapshot with malformed JSON, and selects no folder read. This expected post-fix journey requires separate qualification against actual built bytes. Observed direct-child absence is not arbitrary descendant settlement, interrupted workspace-effect, machine restart, installed or live provider evidence.",
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
      await crashNormalHost();
    } else seeded = await seedRecoveryProfile(input);
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
      : Buffer.from('{"synthetic":"unconfirmed predecessor"}\n'),
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
// Capture before either recovery lifetime; never derive expected bytes from
// the filesystem after the operation being checked. Access time is excluded
// because ordinary reads may update it.
const expectedNote = savedSettings
  ? await fs.readFile(path.join(profile, "workspace", "note.md"))
  : null;
const preserved = async () => {
  const result = {};
  if (normalHostCrash)
    await assert.rejects(fs.lstat(path.join(stateRoot, "last-quit.json")), {
      code: "ENOENT",
    });
  for (const [name, bytes] of retained) {
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
  if (report.preservedBaseline)
    assert.deepEqual(
      result,
      report.preservedBaseline,
      "OLD_SETTINGS_NATIVE_JOURNALS_OR_WORKSPACE_CHANGED",
    );
  return result;
};
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
async function captureRecoveryPage(application, page) {
  const throttled = await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const before = contents.getBackgroundThrottling();
    contents.setBackgroundThrottling(false);
    return before;
  });
  try {
    await bounded(
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      ),
      "RECOVERY_CAPTURE_PAINT_TIMEOUT",
    );
    return await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.invalidate();
      return (await contents.capturePage(undefined, { stayHidden: true }))
        .toPNG()
        .toString("base64");
    });
  } finally {
    await application.evaluate(
      ({ BrowserWindow }, before) =>
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
          before,
        ),
      throttled,
    );
  }
}

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

let app, exit, launch;
try {
  report.preservedBaseline = await preserved();
  await save();
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    launch = { ordinal, closeRequested: false, cleanupConfirmed: false };
    report.launches.push(launch);
    await save();
    app = await electron.launch(launchOptions());
    const child = app.process();
    launch.pid = child.pid;
    // Keep only the original producer's bounded content-free observations.
    // No stderr transcript or diagnostic text is archived.
    const originalLaunch = launch;
    originalLaunch.backendLifecycle = [];
    let diagnostics = "";
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
    const page = await app.firstWindow({ timeout: 15000 });
    await page
      .getByRole("heading", { name: "Your previous session needs recovery" })
      .waitFor();
    launch.windows = await app.evaluate(({ app, BrowserWindow }) => ({
      userData: app.getPath("userData"),
      windows: BrowserWindow.getAllWindows().map((win) => ({
        visible: win.isVisible(),
        focused: win.isFocused(),
        url: win.webContents.getURL(),
        bounds: win.getBounds(),
      })),
    }));
    assert.equal(launch.windows.userData, userData);
    assert.equal(launch.windows.windows.length, 1);
    assert.equal(launch.windows.windows[0].visible, false);
    assert.equal(launch.windows.windows[0].focused, false);
    assert.ok(
      launch.windows.windows[0].url.endsWith(
        "/shell.html#farol-startup-recovery",
      ),
    );
    launch.api = await page.evaluate(() => ({
      recovery: Object.keys(window.farolRecovery ?? {}).sort(),
      normal: typeof window.farol,
    }));
    assert.deepEqual(launch.api, {
      recovery: ["quit", "read", "state"],
      normal: "undefined",
    });
    if (savedSettings) {
      await page
        .getByRole("heading", { name: "Saved settings", exact: true })
        .waitFor();
      await page.getByLabel("Saved folder").selectOption(seeded.workspaceId);
      if (computerStoreRefusal) {
        await page
          .getByText(
            "Folder reads are unavailable. Your saved folder selection is still shown below.",
            { exact: true },
          )
          .waitFor();
        launch.availability = await page.evaluate(() =>
          window.farolRecovery.state(),
        );
        assert.equal(launch.availability.status, "ready");
        assert.equal(launch.availability.revision, seeded.settingsRevision);
        assert.equal(launch.availability.computer, "unavailable");
        assert.equal(launch.availability.archive, "available");
        assert.deepEqual(launch.availability.folders, [
          {
            workspaceId: seeded.workspaceId,
            label: "Recovery fixture",
            root: path.join(profile, "workspace"),
          },
        ]);
        assert.equal(
          await page
            .getByRole("button", { name: "Open folder", exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(
          await page.getByLabel("Folder contents", { exact: true }).count(),
          0,
        );
        assert.equal(await page.locator(".recovery-metadata").count(), 0);
        launch.reads = {
          folder: false,
          nested: false,
          folderReadSelected: false,
        };
      } else {
        await page
          .getByRole("button", { name: "Open folder", exact: true })
          .click();
        await page
          .getByRole("button", { name: "note.md", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "folder/", exact: true })
          .click();
        await page
          .getByRole("button", { name: "nested.txt", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Up", exact: true }).click();
        await page
          .getByRole("button", { name: "note.md", exact: true })
          .click();
        assert.ok(expectedNote);
        const bytes = expectedNote;
        await page
          .getByText(`SHA-256 ${hash(bytes)}`, { exact: true })
          .waitFor();
        launch.reads = {
          folder: true,
          nested: true,
          metadata: { bytes: bytes.length, sha256: hash(bytes) },
        };
      }
      if (storedReplies) {
        await page
          .getByRole("button", { name: "Stored replies", exact: true })
          .click();
        assert.equal(await page.getByLabel("Stored reply copies").count(), 0);
        await page
          .getByRole("button", { name: "Load stored replies", exact: true })
          .click();
        const rows = page.getByRole("button", {
          name: /^Open stored reply \d+$/u,
        });
        await rows.nth(31).waitFor();
        assert.equal(await rows.count(), 32);
        await page
          .getByText("Some records remain unresolved or cannot be displayed.", {
            exact: true,
          })
          .waitFor();
        await page
          .getByRole("button", { name: "Load more replies", exact: true })
          .click();
        await rows.nth(32).waitFor();
        assert.equal(await rows.count(), 33);
        assert.equal(
          await page
            .getByRole("button", { name: "Load more replies", exact: true })
            .count(),
          0,
        );
        launch.archivePaging = { pages: [32, 1], totalRows: 33 };
        await save();
        const expected = [...seeded.stored.entries].sort((a, b) =>
          a.key.localeCompare(b.key),
        );
        const readIndexes = computerStoreRefusal
          ? expected.map((_, index) => index)
          : [0, 32];
        for (const index of readIndexes) {
          await page
            .getByRole("button", {
              name: `Open stored reply ${index + 1}`,
              exact: true,
            })
            .click();
          // Compare literal retained bytes, without text-selector whitespace
          // normalization. Observe a refusal as a failure, never issue a read
          // again; retain the actual UI projection even if waiting fails.
          try {
            await page.waitForFunction(
              (text) =>
                document.querySelector('[aria-label="Stored reply text"]')
                  ?.textContent === text ||
                document.querySelector('.recovery-archive [role="alert"]') !==
                  null,
              expected[index].text,
              { timeout: 15000 },
            );
          } finally {
            const observation = await page.evaluate(() => ({
              text:
                document.querySelector('[aria-label="Stored reply text"]')
                  ?.textContent ?? null,
              alert:
                document.querySelector('.recovery-archive [role="alert"]')
                  ?.textContent ?? null,
              selected:
                document
                  .querySelector('.recovery-reply-list [aria-pressed="true"]')
                  ?.getAttribute("aria-label") ?? null,
            }));
            (launch.archiveViews ??= []).push({
              key: expected[index].key,
              ...observation,
            });
            await save();
          }
          const observed = launch.archiveViews.at(-1);
          assert.equal(observed.alert, null, "STORED_REPLY_UI_REFUSED");
          assert.equal(
            observed.text,
            expected[index].text,
            "STORED_REPLY_TEXT_CHANGED",
          );
          if (computerStoreRefusal) {
            assert.equal(observed.selected, `Open stored reply ${index + 1}`);
            const entry = expected[index];
            assert.match(entry.key, /^[a-f0-9]{64}$/u);
            assert.match(entry.digest, /^[a-f0-9]{64}$/u);
            // Publication digests cover the complete original .attempt record,
            // not just its payload. Bind the UI text to that seed receipt and
            // the preserved original commit without issuing a second API read.
            const record = path.join(
              "go-core",
              "chat",
              "chat-results",
              entry.key,
            );
            assert.equal(
              JSON.parse(report.preservedBaseline[record + ".attempt"]).bytes,
              entry.digest,
              "STORED_REPLY_ORIGINAL_DIGEST_CHANGED",
            );
            assert.equal(
              JSON.parse(report.preservedBaseline[record + ".commit"]).bytes,
              hash(Buffer.from(entry.digest)),
              "STORED_REPLY_ORIGINAL_COMMIT_CHANGED",
            );
            observed.originalRecordSha256 = entry.digest;
            observed.textSha256 = hash(Buffer.from(observed.text));
            assert.equal(observed.textSha256, hash(Buffer.from(entry.text)));
            assert.equal(
              await page
                .locator(
                  ".recovery-copy-text script, .recovery-copy-text a, .recovery-copy-text iframe",
                )
                .count(),
              0,
            );
          }
        }
        await page.getByText("Outcome unconfirmed", { exact: true }).waitFor();
        assert.equal(
          await page
            .locator(
              ".recovery-copy-text script, .recovery-copy-text a, .recovery-copy-text iframe",
            )
            .count(),
          0,
        );
        launch.reads.archive = {
          observation: "stored_unconfirmed",
          pages: [32, 1],
          readKeys: readIndexes.map((index) => expected[index].key),
          originalFencePreserved: true,
        };
      }
    } else
      await page
        .getByRole("alert")
        .filter({ hasText: "Saved settings are unavailable" })
        .waitFor();
    if (computerStoreRefusal) {
      launch.afterArchiveAvailability = await page.evaluate(() =>
        window.farolRecovery.state(),
      );
      assert.deepEqual(launch.afterArchiveAvailability, launch.availability);
      assert.equal(
        await page
          .getByRole("heading", { name: "Saved settings", exact: true })
          .isVisible(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", {
            name: "Open folder",
            exact: true,
            includeHidden: true,
          })
          .isDisabled(),
        true,
      );
    }
    launch.beforeQuit = await preserved();
    const leasePath = path.join(stateRoot, "promotion.lease");
    const leaseBytes = await fs.readFile(leasePath);
    const lease = JSON.parse(leaseBytes.toString("utf8"));
    const leaseIdentity = await fs.lstat(leasePath, { bigint: true });
    assert.equal(lease.pid, child.pid);
    assert.equal(lease.role, "admission");
    assert.equal(
      await isPromotionLeaseHeld(userData),
      true,
      "RECOVERY_LEASE_NOT_HELD",
    );
    launch.children = children(child.pid);
    const backends = launch.children.filter(({ command }) =>
      /farol-backend/u.test(command),
    );
    assert.equal(
      backends.length,
      savedSettings ? 1 : 0,
      "UNEXPECTED_BACKEND_COMPOSITION",
    );
    if (savedSettings) {
      launch.backend = backends[0];
      assert.match(launch.backend.command, /--startup-mode recovery/u);
      assert.doesNotMatch(
        launch.backend.command,
        /--settings-mutations|--previous-host-drain-confirmed|--shell-support-fd|--codex-read-host/u,
      );
    }
    assert.equal(
      launch.children.some(({ command }) =>
        /(?:^|\/)runtime\.cjs(?:\s|$)/u.test(command),
      ),
      false,
      "EFFECT_RUNTIME_STARTED",
    );
    if (ordinal === 1) {
      report.screenshots = [];
      for (const [name, width, height, colorScheme] of savedSettings
        ? [
            ["compact", 640, 520, "light"],
            ["wide-dark", 840, 760, "dark"],
          ]
        : [["unavailable", 640, 520, "light"]]) {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await app.evaluate(
          ({ BrowserWindow }, { width, height }) =>
            BrowserWindow.getAllWindows()[0].setSize(width, height),
          { width, height },
        );
        // Chromium-only keyboard modality in the owned hidden document; no
        // BrowserWindow activation or native focus acceptance is claimed.
        await page.keyboard.press("Tab");
        await page.getByRole("button", { name: "Quit", exact: true }).focus();
        const screenshot = evidence.replace(/\.json$/u, `-${name}.png`);
        const pixels = await captureRecoveryPage(app, page);
        await fs.writeFile(screenshot, Buffer.from(pixels, "base64"), {
          mode: 0o600,
        });
        const layout = await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          focus: document.activeElement?.textContent,
          outline: getComputedStyle(document.activeElement).outlineWidth,
        }));
        assert.ok(
          layout.scrollWidth <= layout.width,
          "RECOVERY_HORIZONTAL_OVERFLOW",
        );
        assert.equal(layout.focus, "Quit");
        assert.equal(layout.outline, "3px");
        report.screenshots.push({
          screenshot,
          name,
          layout,
          presentation:
            "two-paint-frames-then-stay-hidden-capture; native-window-hidden-unfocused",
        });
      }
      const windows = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((win) => ({
          visible: win.isVisible(),
          focused: win.isFocused(),
        })),
      );
      assert.deepEqual(windows, [{ visible: false, focused: false }]);
    }
    if (backendCrash && ordinal === 1) {
      // This is the one observed child of the current test-owned Electron host.
      // Revalidate exact PID, parent and command before each deliberate signal.
      // No PID/name scan is used to select a replacement or signal a group.
      const original = launch.backend;
      const signalBackend = async (signal) => {
        assert.ok(
          original &&
            original.command.startsWith(
              path.join(buildRoot, "farol-backend") + " serve ",
            ),
        );
        assert.ok(original.command.includes(` --profile ${seeded.profileId} `));
        assert.ok(
          original.command.includes(
            ` --profile-root ${path.join(stateRoot, "go-core")} --profile-device `,
          ),
        );
        const current = children(child.pid).find(
          (item) => item.pid === original.pid,
        );
        assert.deepEqual(
          current,
          original,
          "ORIGINAL_BACKEND_CHANGED_BEFORE_FAULT",
        );
        const intent = {
          pid: original.pid,
          signal,
          commandSHA256: hash(Buffer.from(original.command)),
          delivered: false,
        };
        (launch.backendSignals ??= []).push(intent);
        await save();
        assert.deepEqual(
          children(child.pid).find((item) => item.pid === original.pid),
          original,
          "ORIGINAL_BACKEND_CHANGED_AT_SIGNAL",
        );
        process.kill(original.pid, signal);
        intent.delivered = true;
        await save();
      };
      const retainedText = launch.archiveViews.at(-1).text;
      await signalBackend("SIGSTOP");
      await page
        .getByRole("button", { name: "Open stored reply 2", exact: true })
        .click();
      await page
        .getByText("Reading the stored copy…", { exact: true })
        .waitFor({ timeout: 5000 });
      launch.pendingArchiveUI = {
        ordinal: 2,
        backendSuspended: true,
        previousText: retainedText,
        limits: "UI call pending; backend receipt/processing not observed",
      };
      await save();
      await signalBackend("SIGKILL");
      await waitForObservedChildrenExit([original]);
      launch.observedKilledBackendAbsent = original.pid;
      const hostLifetimeId = / --host-lifetime ([a-f0-9-]{36}) /u.exec(
        original.command,
      )?.[1];
      const childLaunchId = / --child-launch ([a-f0-9-]{36}) /u.exec(
        original.command,
      )?.[1];
      assert.ok(hostLifetimeId && childLaunchId);
      const deadline = performance.now() + 5000;
      let terminal;
      do {
        terminal = launch.backendLifecycle.find(
          (value) =>
            value.event === "child-close" &&
            value.hostLifetimeId === hostLifetimeId &&
            value.childLaunchId === childLaunchId,
        );
        if (terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (performance.now() < deadline);
      assert.ok(terminal, "ORIGINAL_BACKEND_TERMINAL_UNOBSERVED");
      assert.equal(terminal.state, "observed");
      assert.equal(terminal.exitCode, null);
      assert.equal(terminal.signal, "SIGKILL");
      assert.equal(terminal.forced, false);
      launch.originalBackendTerminal = terminal;
      assert.ok(
        !launch.diagnosticsInvalid && !launch.diagnosticsOverflow,
        "BACKEND_LIFECYCLE_UNQUALIFIED",
      );
      await page
        .getByText(
          "Stored replies are unavailable for this recovery session. Original records remain in place.",
          { exact: true },
        )
        .waitFor({ timeout: 5000 });
      await page
        .locator('.recovery-archive [role="alert"]')
        .waitFor({ timeout: 5000 });
      const paused = await page.evaluate(async () => ({
        state: await window.farolRecovery.state(),
        text:
          document.querySelector('[aria-label="Stored reply text"]')
            ?.textContent ?? null,
        enabledStoredReads: [
          ...document.querySelectorAll(".recovery-reply-list button"),
        ].filter((button) => !button.disabled).length,
      }));
      assert.equal(paused.state.status, "ready");
      assert.equal(paused.state.computer, "unavailable");
      assert.equal(paused.state.archive, "unavailable");
      assert.equal(
        paused.text,
        retainedText,
        "PENDING_READ_REPLACED_RETAINED_COPY",
      );
      assert.equal(paused.enabledStoredReads, 0);
      launch.pausedAfterBackendLoss = paused;
      launch.afterBackendFault = await preserved();
      launch.backendAbsenceSamples = [];
      for (let sample = 0; sample < 3; sample++) {
        const current = children(child.pid).filter((item) =>
          /farol-backend/u.test(item.command),
        );
        assert.equal(
          current.length,
          0,
          "RECOVERY_BACKEND_RESTARTED_AFTER_LOSS",
        );
        launch.backendAbsenceSamples.push({
          elapsedSample: sample,
          backends: current,
        });
        if (sample < 2)
          await new Promise((resolve) => setTimeout(resolve, 750));
      }
      const screenshot = evidence.replace(/\.json$/u, "-backend-paused.png");
      const pixels = await captureRecoveryPage(app, page);
      await fs.writeFile(screenshot, Buffer.from(pixels, "base64"), {
        mode: 0o600,
      });
      report.screenshots.push({
        screenshot,
        name: "backend-paused",
        presentation:
          "hidden original window after original child loss; retained copy remains unconfirmed",
      });
      await save();
    }
    launch.closeRequested = true;
    await save();
    const crash = forceQuit && ordinal === 1;
    if (crash) {
      // The live ChildProcess handle selects only this test's original host.
      // Do not call renderer Quit, kill a group, clear a marker or repair state.
      launch.faultRequested = "SIGKILL";
      await save();
      assert.equal(child.kill("SIGKILL"), true, "RECOVERY_FAULT_NOT_DELIVERED");
    } else
      await page.getByRole("button", { name: "Quit", exact: true }).click();
    const [code, signal] = await bounded(exit, "RECOVERY_QUIT_UNKNOWN");
    launch.exitCode = code;
    launch.signal = signal;
    await save();
    assert.equal(code, crash ? null : 0);
    assert.equal(signal, crash ? "SIGKILL" : null);
    if (crash) {
      await waitForObservedChildrenExit(launch.children);
      launch.observedDirectChildrenAbsent = launch.children.map(
        ({ pid }) => pid,
      );
    }
    launch.afterQuit = await preserved();
    if (launch.backend) {
      assert.throws(
        () => process.kill(launch.backend.pid, 0),
        (error) => error?.code === "ESRCH",
        "ORIGINAL_RECOVERY_BACKEND_STILL_EXISTS",
      );
    }
    // The existing lease protocol retains its inode and clears its record.
    // Kernel lock release, not pathname absence, permits the next generation.
    assert.equal(
      await isPromotionLeaseHeld(userData),
      false,
      "RECOVERY_LEASE_RETAINED",
    );
    const afterLease = await fs.readFile(leasePath);
    if (crash) {
      assert.deepEqual(
        afterLease,
        leaseBytes,
        "CRASH_LEASE_DIAGNOSTIC_REWRITTEN",
      );
      const afterIdentity = await fs.lstat(leasePath, { bigint: true });
      assert.equal(afterIdentity.dev, leaseIdentity.dev);
      assert.equal(afterIdentity.ino, leaseIdentity.ino);
      launch.retainedLeaseDiagnostic = hash(afterLease);
    } else assert.equal(afterLease.length, 0, "RECOVERY_LEASE_RECORD_RETAINED");
    assert.equal(children(child.pid).length, 0, "RECOVERY_CHILDREN_RETAINED");
    launch.cleanupConfirmed = true;
    app = null;
    await save();
  }
  if (computerStoreRefusal) {
    // Keep the original inode and malformed snapshot available for inspection.
    report.profileRetained = "computer-store-refusal-original-and-replacement";
  } else {
    await fs.rm(profile, { recursive: true });
    report.profileRemoved = true;
  }
  report.status = savedSettings
    ? storedReplies
      ? backendCrash
        ? "passed-hidden-stored-unconfirmed-backend-loss-pending-UI-read-reopen-originals-preserved"
        : forceQuit
          ? "passed-hidden-stored-unconfirmed-host-SIGKILL-reopen-originals-preserved"
          : computerStoreRefusal
            ? "passed-hidden-computer-store-refusal-33-stored-unconfirmed-replies-two-recovery-lifetimes-originals-retained"
            : "passed-hidden-stored-unconfirmed-33-replies-UNKNOWN-preserved-two-recovery-lifetimes"
      : normalHostCrash
        ? "passed-normal-host-SIGKILL-real-marker-two-recovery-lifetimes-reads-originals-preserved"
        : forceQuit
          ? "passed-hidden-recovery-host-SIGKILL-observed-children-exit-reopen-reads-originals-preserved"
          : "passed-hidden-saved-settings-Go-recovery-reads-quit-reopen-old-journals-preserved"
    : "passed-hidden-recovery-quit-reopen-predecessor-preserved-zero-runtime";
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
  await save();
  process.stdout.write(
    `Startup recovery evidence: ${evidence} (${report.status})\n`,
  );
}
