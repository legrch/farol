// Explicit native lane: exact Go build and synthetic data, with either a
// synthetic predecessor or an actual idle normal-host crash. Hidden recovery
// UI -> Quit or exact-host SIGKILL -> same-profile reopen. No live provider,
// installed profile, operation replay or arbitrary descendant claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";
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

const savedSettings = process.argv.includes("--saved-settings");
const forceQuit = process.argv.includes("--force-quit");
const normalHostCrash = process.argv.includes("--normal-host-crash");
assert.ok(!(forceQuit && normalHostCrash), "SELECT_ONE_CRASH_JOURNEY");
assert.deepEqual(
  process.argv.slice(2),
  savedSettings
    ? [
        "--run-native",
        "--saved-settings",
        ...(forceQuit
          ? ["--force-quit"]
          : normalHostCrash
            ? ["--normal-host-crash"]
            : []),
      ]
    : ["--run-native"],
  "EXPLICIT_NATIVE_RECOVERY_LANE_REQUIRED",
);
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
  stateRoot = path.join(userData, "farol-next-state");
for (const dir of [home, stateRoot])
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const proof = randomUUID();
await fs.writeFile(path.join(profile, ".farol-next-e2e-root"), proof, {
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
    "Synthetic data only. Normal-host crash uses its actual marker, original Go owner and loopback Browser fixture. Optional recovery-host crash retains a synthetic predecessor marker. Observed direct-child absence is not arbitrary descendant settlement, interrupted workspace-effect, machine restart, installed or live provider evidence.",
};
const save = () =>
  fs.writeFile(evidence, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });

const children = (pid) =>
  execFileSync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return match && Number(match[2]) === pid
        ? [{ pid: Number(match[1]), command: match[3] }]
        : [];
    });
const bounded = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
};

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
  report.fixture = { ...report.fixture, stage: "prepared", ...seeded };
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
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
      physical: [
        info.dev,
        info.ino,
        info.mode,
        info.uid,
        info.nlink,
        info.size,
        info.mtimeNs,
        info.ctimeNs,
      ].map(String),
    });
  }
  if (!savedSettings)
    await assert.rejects(fs.lstat(path.join(stateRoot, "go-core")), {
      code: "ENOENT",
    });
  else {
    for (const name of ["profile.json", "chat", "task", "computer/mutations"]) {
      const directory = path.join(stateRoot, "go-core", name);
      const inspect = async (target) => {
        const info = await fs.lstat(target, { bigint: true });
        if (info.isDirectory()) {
          for (const child of (await fs.readdir(target)).sort())
            await inspect(path.join(target, child));
          return;
        }
        const key = path.relative(stateRoot, target);
        result[key] = JSON.stringify({
          bytes: hash(await fs.readFile(target)),
          physical: [
            info.dev,
            info.ino,
            info.mode,
            info.uid,
            info.nlink,
            info.size,
            info.mtimeNs,
            info.ctimeNs,
          ].map(String),
        });
      };
      await inspect(directory);
    }
  }
  if (report.preservedBaseline)
    assert.deepEqual(
      result,
      report.preservedBaseline,
      "OLD_SETTINGS_OR_NATIVE_JOURNALS_CHANGED",
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
      FAROL_NEXT_ENVIRONMENT: "dev",
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_TEST_ROOT: profile,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
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
      launchOptions({ FAROL_NEXT_E2E_CHATGPT_URL: fixture.url }),
    );
    const child = application.process();
    original.pid = child.pid;
    ended = once(child, "exit");
    void ended.catch(() => undefined);
    const page = await application.firstWindow({ timeout: 15000 });
    await page.locator(".desktop").waitFor({ state: "visible" });
    let ready = false;
    for (let n = 0; n < 100; n++) {
      const snapshot = await page.evaluate(() => window.farolNext.bootstrap());
      if (
        snapshot.runtimeState === "ready" &&
        snapshot.configuration.status === "ready"
      ) {
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
    assert.equal(
      original.children.some(({ command }) =>
        /(?:^|\/)runtime\.cjs(?:\s|$)/u.test(command),
      ),
      false,
      "ORIGINAL_CONNECTOR_STARTED",
    );
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
    await stopChatGptFixture(fixture);
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
      normal: typeof window.farolNext,
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
      await page
        .getByRole("button", { name: "Open folder", exact: true })
        .click();
      await page
        .getByRole("button", { name: "note.md", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "folder/", exact: true }).click();
      await page
        .getByRole("button", { name: "nested.txt", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Up", exact: true }).click();
      await page.getByRole("button", { name: "note.md", exact: true }).click();
      const bytes = await fs.readFile(
        path.join(profile, "workspace", "note.md"),
      );
      await page.getByText(`SHA-256 ${hash(bytes)}`, { exact: true }).waitFor();
      launch.reads = {
        folder: true,
        nested: true,
        metadata: { bytes: bytes.length, sha256: hash(bytes) },
      };
    } else
      await page
        .getByRole("alert")
        .filter({ hasText: "Saved settings are unavailable" })
        .waitFor();
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
  await fs.rm(profile, { recursive: true });
  report.profileRemoved = true;
  report.status = savedSettings
    ? normalHostCrash
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
