// Explicit native lane: exact Go build, synthetic unconfirmed predecessor,
// hidden recovery UI -> ordinary UI Quit -> same-profile reopen. No live
// provider, installed profile, operation replay or arbitrary descendant claim.
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

const savedSettings = process.argv.includes("--saved-settings");
assert.deepEqual(
  process.argv.slice(2),
  savedSettings ? ["--run-native", "--saved-settings"] : ["--run-native"],
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
  profile,
  status: "running",
  launches: [],
  fixture: {
    kind: savedSettings
      ? "saved-settings-and-real-unretired-Go-owner"
      : "corrupt-settings-no-backend",
    stage: "preparing",
  },
  limits:
    "Synthetic predecessor only. No automatic unknown-operation retirement, crashed-descendant settlement, installed acceptance or provider evidence.",
};
const save = () =>
  fs.writeFile(evidence, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });

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
    const { seedRecoveryProfile } = createRequire(import.meta.url)(fixture);
    seeded = await seedRecoveryProfile({
      stateRoot,
      home,
      workspace: path.join(profile, "workspace"),
      artifactRoot: buildRoot,
      core: build.manifest.core,
    });
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
  ["running.json", Buffer.from('{"synthetic":"unconfirmed predecessor"}\n')],
  ["last-quit.json", Buffer.from('{"synthetic":"undrained Quit"}\n')],
  [
    "config.json",
    savedSettings
      ? await fs.readFile(path.join(stateRoot, "config.json"))
      : Buffer.from('{"synthetic":"retained corrupt configuration"}\n'),
  ],
]);
for (const [name, bytes] of retained)
  if (!(savedSettings && name === "config.json"))
    await fs.writeFile(path.join(stateRoot, name), bytes, {
      mode: 0o600,
      flag: "wx",
    });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const preserved = async () => {
  const result = {};
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
let app, exit, launch;
try {
  report.preservedBaseline = await preserved();
  await save();
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    launch = { ordinal, closeRequested: false, cleanupConfirmed: false };
    report.launches.push(launch);
    await save();
    app = await electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
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
      },
      timeout: 15000,
    });
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
    const lease = JSON.parse(
      await fs.readFile(path.join(stateRoot, "promotion.lease"), "utf8"),
    );
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
        const pixels = await app.evaluate(async ({ BrowserWindow }) =>
          (await BrowserWindow.getAllWindows()[0].capturePage())
            .toPNG()
            .toString("base64"),
        );
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
        report.screenshots.push({ screenshot, name, layout });
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
    await page.getByRole("button", { name: "Quit", exact: true }).click();
    const [code, signal] = await bounded(exit, "RECOVERY_QUIT_UNKNOWN");
    assert.equal(code, 0);
    assert.equal(signal, null);
    launch.exitCode = code;
    launch.signal = signal;
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
    assert.equal(
      (await fs.readFile(path.join(stateRoot, "promotion.lease"))).length,
      0,
      "RECOVERY_LEASE_RECORD_RETAINED",
    );
    assert.equal(children(child.pid).length, 0, "RECOVERY_CHILDREN_RETAINED");
    launch.cleanupConfirmed = true;
    app = null;
    await save();
  }
  await fs.rm(profile, { recursive: true });
  report.profileRemoved = true;
  report.status = savedSettings
    ? "passed-hidden-saved-settings-Go-recovery-reads-quit-reopen-old-journals-preserved"
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
