import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { parseOwnerLaunchResult } from "../../tooling/owner-launch-result.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";

const root = process.cwd();
const useInstalledTunnelClient = process.argv.includes(
  "--installed-tunnel-client",
);
const buildRoot = path.join(root, "dist/app");
const executable = path.join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-dev-onboarding-startup-"),
);
const isolatedHome = path.join(temporaryRoot, "home");
const isolatedAppData = path.join(temporaryRoot, "app-data");
await fs.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
await fs.mkdir(isolatedAppData, { recursive: true, mode: 0o700 });
const tunnelFixture = path.join(temporaryRoot, "tunnel-client.cjs");
const tunnelFixtureSource = await fs.readFile(
  new URL("./tunnel-client.fixture.cjs", import.meta.url),
  "utf8",
);
await fs.writeFile(
  tunnelFixture,
  `#!${process.execPath}\n${tunnelFixtureSource}`,
  { mode: 0o700 },
);

const environment = {
  FAROL_NEXT_E2E: "1",
  FAROL_NEXT_E2E_APP_DATA: isolatedAppData,
  ...(useInstalledTunnelClient
    ? {}
    : { FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelFixture }),
  FAROL_NEXT_ENVIRONMENT: "dev",
  HOME: isolatedHome,
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: temporaryRoot,
};

async function closeApplication(application) {
  const mainProcess = application.process();
  const closed = once(application, "close");
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("DEV_STARTUP_SMOKE_CLOSE_TIMEOUT")),
      10_000,
    );
    timer.unref();
  });
  try {
    await Promise.race([application.close(), timeout]);
    await Promise.race([closed, timeout]);
  } catch (error) {
    if (Number.isSafeInteger(mainProcess.pid) && mainProcess.pid > 1) {
      try {
        process.kill(mainProcess.pid, "SIGKILL");
      } catch (killError) {
        if (killError?.code !== "ESRCH") throw killError;
      }
    }
    throw error;
  }
}

async function stopApplicationWithOwnerSignal(application) {
  const mainProcess = application.process();
  const closed = once(application, "close");
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("DEV_STARTUP_SMOKE_SIGNAL_CLOSE_TIMEOUT")),
      10_000,
    );
    timer.unref();
  });
  mainProcess.kill("SIGINT");
  await Promise.race([closed, timeout]);
  assert.equal(mainProcess.signalCode, null, "DEV_STARTUP_SMOKE_SIGNAL_DEATH");
  assert.equal(mainProcess.exitCode, 0, "DEV_STARTUP_SMOKE_SIGNAL_EXIT");
}

let application;
try {
  application = await electron.launch({
    executablePath: executable,
    args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    env: environment,
    timeout: 15_000,
  });
  let stderr = "";
  application.process().stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const window = await application.firstWindow({ timeout: 15_000 });
  await window.locator("#sidebar").waitFor({ state: "visible" });
  await window
    .locator('#runtime-pill[data-state="ready"]')
    .waitFor({ state: "visible" });
  const bootstrap = await window.evaluate(() => window.farolNext.bootstrap());
  assert.equal(bootstrap.environment, "dev");
  assert.equal(bootstrap.displayName, "Farol DEV");
  assert.equal(bootstrap.applicationId, "local.farol.dev");
  assert.equal(bootstrap.partition, "persist:farol-dev-runtime");
  assert.equal(bootstrap.chatgptPartition, "persist:farol-dev-chatgpt");
  const paths = await application.evaluate(({ app }) => ({
    name: app.getName(),
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
  }));
  const expectedUserData = path.join(isolatedAppData, "Farol DEV");
  assert.deepEqual(paths, {
    name: "Farol DEV",
    userData: expectedUserData,
    sessionData: expectedUserData,
  });
  assert.equal(
    paths.userData.startsWith(`${temporaryRoot}${path.sep}`),
    true,
    "DEV_STARTUP_SMOKE_ESCAPED_TEMP_HOME",
  );

  const setupDialog = window.locator("#setup-dialog");
  await setupDialog.waitFor({ state: "hidden" });
  await window.locator('[data-panel="computer"].active').waitFor();
  assert.equal(
    await window.evaluate(() => document.documentElement.dataset.section),
    "computer",
  );
  const registry = JSON.parse(
    await fs.readFile(path.join(root, "../integrations/registry.json"), "utf8"),
  );
  const expectedTunnelVersion = useInstalledTunnelClient
    ? registry.dependencies.tunnelClient.version.split(" ", 1)[0]
    : "1.0.0";
  await window.waitForFunction(
    (version) =>
      document
        .querySelector("#connection-readiness .connector-row")
        ?.textContent?.includes(`tunnel-client ${version}`),
    expectedTunnelVersion,
  );

  const connectionsNav = window.locator('.nav-item[data-section="computer"]');
  const settingsNav = window.locator('.nav-item[data-section="settings"]');
  const connectionsBox = await connectionsNav.boundingBox();
  const settingsBox = await settingsNav.boundingBox();
  assert.ok(connectionsBox && settingsBox);
  assert.ok(
    settingsBox.y > connectionsBox.y,
    "DEV_CONNECTIONS_SETTINGS_NOT_AT_BOTTOM",
  );

  const connectionsLayout = await window
    .locator('[data-panel="computer"].active')
    .evaluate((panel) => ({
      clientHeight: panel.clientHeight,
      scrollHeight: panel.scrollHeight,
      overflowY: getComputedStyle(panel).overflowY,
    }));
  assert.ok(connectionsLayout.clientHeight > 0);
  assert.ok(connectionsLayout.scrollHeight >= connectionsLayout.clientHeight);
  assert.match(connectionsLayout.overflowY, /^(?:auto|scroll)$/u);
  const connectionRows = await window
    .locator("#connection-readiness .connection-row")
    .count();
  assert.equal(connectionRows, 5, "DEV_CONNECTIONS_READINESS_INCOMPLETE");

  await settingsNav.click();
  await window.locator('[data-panel="settings"].active').waitFor();
  assert.match(
    await window.locator("#settings-connections-summary").innerText(),
    new RegExp(
      `^\\d+ of ${connectionRows} independent readiness checks currently have valid evidence\\.`,
      "u",
    ),
  );
  await window.locator("#open-connections").click();
  await window.locator('[data-panel="computer"].active').waitFor();

  const returnToChatGpt = window.locator("#connections-open-chatgpt");
  await returnToChatGpt.scrollIntoViewIfNeeded();
  await returnToChatGpt.click();
  await window.locator('[data-panel="browser"].active').waitFor();

  await window.keyboard.press("Meta+2");
  await window.locator('[data-panel="computer"].active').waitFor();
  await window.keyboard.press("Meta+1");
  await window.locator('[data-panel="browser"].active').waitFor();

  await stopApplicationWithOwnerSignal(application);
  application = undefined;
  assert.doesNotMatch(stderr, /INSTANCE_BUILD_IDENTITY_INVALID/u);
  assert.doesNotMatch(stderr, /App threw an error during load/u);

  const brokenRoot = path.join(temporaryRoot, "broken-app");
  await fs.cp(buildRoot, brokenRoot, { recursive: true });
  await fs.writeFile(path.join(brokenRoot, "build-manifest.json"), "{}\n", {
    mode: 0o600,
  });
  const broken = await runBoundedProcess(
    executable,
    [path.join(brokenRoot, "main.cjs"), "--preview-window-mode=hidden"],
    {
      cwd: root,
      env: environment,
      timeoutMs: 5_000,
    },
  );
  assert.equal(broken.status, 1, `${broken.stdout}${broken.stderr}`);
  assert.equal(broken.signal, null);
  assert.equal(
    parseOwnerLaunchResult(`${broken.stdout}${broken.stderr}`),
    "startup-failed",
  );
  assert.match(
    broken.stderr,
    /FAROL_NEXT_STARTUP_FAILURE:INSTANCE_BUILD_IDENTITY_INVALID/u,
  );
  assert.doesNotMatch(broken.stderr, /App threw an error during load/u);
  assert.doesNotMatch(broken.stderr, /Uncaught Exception/u);

  process.stdout.write("Farol DEV hidden startup smoke: PASS\n");
} finally {
  if (application) await closeApplication(application).catch(() => undefined);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
