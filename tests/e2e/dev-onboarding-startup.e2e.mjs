import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { parseOwnerLaunchResult } from "../../tooling/owner-launch-result.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { verifyInputManifest } from "../../tooling/build-contract.mjs";

const root = process.cwd();
const useInstalledTunnelClient = process.argv.includes(
  "--installed-tunnel-client",
);
const buildRoot = path.join(root, "_output/build/app");
const executable = path.join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
// Drive exact built React bytes. This hidden lane proves DOM/application
// integration, not native focus, the OS folder dialog, or a live provider.
const source = sourceIdentity(root, ".");
const build = JSON.parse(
  await fs.readFile(path.join(buildRoot, "build-manifest.json"), "utf8"),
);
assert.equal(source.dirty, false, "DEV_REACT_SOURCE_NOT_EXACT");
assert.equal(
  build.sourceCommit,
  source.commit,
  "DEV_REACT_BUILD_COMMIT_MISMATCH",
);
assert.equal(
  build.sourceTreeDigest,
  source.treeDigest,
  "DEV_REACT_BUILD_TREE_MISMATCH",
);
assert.equal(build.dirty, false, "DEV_REACT_BUILD_DIRTY");
assert.equal(build.inputExact, true, "DEV_REACT_INPUTS_NOT_EXACT");
await verifyInputManifest(buildRoot, build);
const temporaryRoot = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-onboarding-startup-")),
);
const isolatedHome = path.join(temporaryRoot, "home");
const isolatedAppData = path.join(temporaryRoot, "app-data");
await fs.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
await fs.mkdir(isolatedAppData, { recursive: true, mode: 0o700 });
const e2eRootProof = randomUUID();
await fs.writeFile(
  path.join(temporaryRoot, ".farol-next-e2e-root"),
  e2eRootProof,
  { mode: 0o600 },
);
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
  FAROL_NEXT_E2E_TEST_ROOT: temporaryRoot,
  FAROL_NEXT_E2E_TEST_PROOF: e2eRootProof,
  ...(useInstalledTunnelClient
    ? {}
    : { FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelFixture }),
  FAROL_NEXT_ENVIRONMENT: "dev",
  HOME: isolatedHome,
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: os.tmpdir(),
};

const stopRequested = new WeakSet();
let cleanupConfirmed = true;
let launchUnresolved = false;
async function launchApplication(env) {
  launchUnresolved = true;
  const result = await electron.launch({
    executablePath: executable,
    args: [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    env,
    timeout: 15_000,
  });
  launchUnresolved = false;
  return result;
}
async function stopApplication(application, ownerSignal) {
  assert.equal(
    stopRequested.has(application),
    false,
    "DEV_REACT_STOP_ALREADY_REQUESTED",
  );
  stopRequested.add(application);
  const child = application.process();
  const closed = once(application, "close");
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("DEV_REACT_CLOSE_UNCONFIRMED")),
      10_000,
    );
    timer.unref();
  });
  try {
    if (ownerSignal) child.kill("SIGINT");
    else await Promise.race([application.close(), deadline]);
    await Promise.race([closed, deadline]);
    assert.equal(child.signalCode, null, "DEV_REACT_SIGNAL_DEATH");
    assert.equal(child.exitCode, 0, "DEV_REACT_NONZERO_EXIT");
  } catch (error) {
    cleanupConfirmed = false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const closeApplication = (application) => stopApplication(application, false);
const stopApplicationWithOwnerSignal = (application) =>
  stopApplication(application, true);
async function ready(window) {
  await window.locator(".desktop").waitFor({ state: "visible" });
  // Native bootstrap is asynchronous; Playwright predicates do not establish
  // awaited IPC completion. Poll only this bounded read-only projection.
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await window.evaluate(() => window.farolNext.bootstrap());
    if (
      value.runtimeState === "ready" &&
      value.configuration.status === "ready"
    )
      return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("DEV_REACT_BOOTSTRAP_NOT_READY");
}
async function settingsPage(window, name) {
  await window.getByRole("button", { name: "Settings", exact: true }).click();
  await window
    .locator(".contextual-sidebar")
    .getByRole("button", {
      name: name === "Shortcuts" ? "Keyboard shortcuts" : name,
      exact: true,
    })
    .click();
  await window.getByRole("heading", { name, exact: true, level: 2 }).waitFor();
}

let application;
try {
  // A missing override must fail before the first app-ready boundary and
  // leave even a synthetic ordinary-Dev startup marker untouched.
  const ordinaryMarker = path.join(
    isolatedHome,
    "Library/Application Support/Farol Dev/farol-next-state/running.json",
  );
  await fs.mkdir(path.dirname(ordinaryMarker), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(ordinaryMarker, "synthetic owner marker\n", {
    mode: 0o600,
  });
  const missingOverrideEnv = { ...environment };
  delete missingOverrideEnv.FAROL_NEXT_E2E_APP_DATA;
  launchUnresolved = true;
  const refusedProfile = await runBoundedProcess(
    executable,
    [path.join(buildRoot, "main.cjs"), "--preview-window-mode=hidden"],
    { cwd: root, env: missingOverrideEnv, timeoutMs: 5_000 },
  );
  launchUnresolved = false;
  assert.equal(
    refusedProfile.status,
    1,
    `${refusedProfile.stdout}${refusedProfile.stderr}`,
  );
  assert.equal(refusedProfile.signal, null);
  assert.equal(
    parseOwnerLaunchResult(`${refusedProfile.stdout}${refusedProfile.stderr}`),
    "startup-failed",
  );
  assert.match(refusedProfile.stderr, /DESKTOP_E2E_APP_DATA_INVALID/u);
  assert.equal(
    await fs.readFile(ordinaryMarker, "utf8"),
    "synthetic owner marker\n",
  );

  application = await launchApplication(environment);
  let stderr = "";
  application.process().stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const window = await application.firstWindow({ timeout: 15_000 });
  const bootstrap = await ready(window);
  await window
    .locator(".toolbar-title strong")
    .getByText("Home", { exact: true })
    .waitFor();
  assert.equal(bootstrap.environment, "dev");
  assert.equal(bootstrap.displayName, "Farol Dev");
  assert.equal(bootstrap.applicationId, "local.farol.dev");
  assert.equal(bootstrap.partition, "persist:farol-dev-runtime");
  assert.equal(bootstrap.chatgptPartition, "persist:farol-dev-chatgpt");
  const paths = await application.evaluate(({ app }) => ({
    name: app.getName(),
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
  }));
  const expectedUserData = path.join(isolatedAppData, "Farol Dev");
  assert.deepEqual(paths, {
    name: "Farol Dev",
    userData: expectedUserData,
    sessionData: expectedUserData,
  });
  assert.equal(
    paths.userData.startsWith(`${temporaryRoot}${path.sep}`),
    true,
    "DEV_STARTUP_SMOKE_ESCAPED_TEMP_HOME",
  );

  assert.equal(
    await window.locator("#setup-dialog, #guided-onboarding").count(),
    0,
  );
  for (const name of [
    "General",
    "Appearance",
    "Folders",
    "This Mac",
    "Connection",
    "Model",
    "Shortcuts",
    "Updates",
    "Diagnostics",
  ]) {
    await settingsPage(window, name);
  }
  await settingsPage(window, "Appearance");
  await window.getByRole("button", { name: "Graphite", exact: true }).click();
  await window
    .getByRole("combobox", { name: /^Accent\b/u })
    .selectOption("cobalt");
  await window
    .getByRole("combobox", { name: /^Font\b/u })
    .selectOption("system");
  await window.waitForFunction(() => {
    const element = document.querySelector(".desktop");
    return (
      element?.dataset.theme === "graphite" &&
      element.dataset.accent === "cobalt" &&
      element.dataset.font === "system"
    );
  });
  assert.deepEqual(
    await window
      .locator(".desktop")
      .evaluate((element) => [
        element.dataset.theme,
        element.dataset.accent,
        element.dataset.font,
      ]),
    ["graphite", "cobalt", "system"],
  );
  await window.getByRole("button", { name: "Home", exact: true }).click();
  await window
    .getByRole("button", { name: "Find a page", exact: true })
    .click();
  await window
    .getByRole("dialog")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  assert.equal(await window.getByRole("dialog").count(), 0);
  assert.equal(await window.locator("main").getAttribute("inert"), null);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    ),
    false,
    "DEV_REACT_HIDDEN_WINDOW_SHOWN",
  );

  await stopApplicationWithOwnerSignal(application);
  application = undefined;
  assert.doesNotMatch(stderr, /INSTANCE_BUILD_IDENTITY_INVALID/u);
  assert.doesNotMatch(stderr, /App threw an error during load/u);

  // Reopen the exact same disposable ordinary-Dev profile after a confirmed
  // quit, rather than claiming persistence from the previous DOM projection.
  application = await launchApplication(environment);
  const reopenedWindow = await application.firstWindow({ timeout: 15_000 });
  await ready(reopenedWindow);
  await settingsPage(reopenedWindow, "Appearance");
  assert.deepEqual(
    await reopenedWindow
      .locator(".desktop")
      .evaluate((element) => [
        element.dataset.theme,
        element.dataset.accent,
        element.dataset.font,
      ]),
    ["graphite", "cobalt", "system"],
    "DEV_REACT_APPEARANCE_NOT_RETAINED",
  );
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    ),
    false,
    "DEV_REACT_REOPEN_SHOWN",
  );
  await closeApplication(application);
  application = undefined;

  // A legacy-spelled DEV directory is synthetic owner data, not a migration
  // input. Reopening must keep the same storage object and saved folder grant.
  const legacyAppData = path.join(temporaryRoot, "legacy-app-data");
  const legacyDirectory = path.join(legacyAppData, "Farol DEV");
  const workspaceRoot = path.join(temporaryRoot, "approved-folder");
  await fs.mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const marker = path.join(legacyDirectory, "retained-marker.txt");
  await fs.writeFile(marker, "synthetic pre-existing DEV profile\n", {
    mode: 0o600,
  });
  const legacyIdentity = await fs.stat(legacyDirectory);
  const expectedLegacyPath = await fs.realpath(legacyDirectory);
  const legacyEnvironment = {
    ...environment,
    FAROL_NEXT_E2E_APP_DATA: legacyAppData,
    FAROL_NEXT_E2E_WORKSPACE_ROOT: workspaceRoot,
  };
  let savedWorkspace;
  for (let launch = 0; launch < 2; launch += 1) {
    application = await launchApplication(legacyEnvironment);
    const legacyWindow = await application.firstWindow({ timeout: 15_000 });
    await ready(legacyWindow);
    assert.equal(
      await legacyWindow.locator("#setup-dialog, #guided-onboarding").count(),
      0,
    );
    const actualPath = await application.evaluate(({ app }) =>
      app.getPath("userData"),
    );
    assert.equal(actualPath, expectedLegacyPath);
    const actualIdentity = await fs.stat(actualPath);
    assert.equal(actualIdentity.dev, legacyIdentity.dev);
    assert.equal(actualIdentity.ino, legacyIdentity.ino);
    assert.equal(
      await fs.readFile(marker, "utf8"),
      "synthetic pre-existing DEV profile\n",
    );
    if (launch === 0) {
      await settingsPage(legacyWindow, "Folders");
      await legacyWindow
        .getByRole("button", { name: "Add folder…", exact: true })
        .click();
      await legacyWindow
        .getByRole("button", {
          name: "Add selected folder read-only",
          exact: true,
        })
        .click();
      await legacyWindow.locator(".folder-row").waitFor();
      await legacyWindow
        .getByRole("button", { name: "Check access", exact: true })
        .click();
      await legacyWindow.waitForFunction(() =>
        document
          .querySelector(".folder-row .badges")
          ?.textContent?.includes("Access checked"),
      );
      await legacyWindow
        .getByRole("button", { name: "Verify workspace", exact: true })
        .click();
      let value;
      for (let attempt = 0; attempt < 100; attempt++) {
        value = await legacyWindow.evaluate(() => window.farolNext.bootstrap());
        const settings =
          value.configuration.status === "ready"
            ? value.configuration.settings
            : null;
        if (
          settings?.setup.computer.verified?.workspaceId ===
            settings?.computer.workspaces[0]?.workspaceId &&
          settings?.computer.workspaces.length === 1
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      savedWorkspace = {
        workspaces: value.configuration.settings.computer.workspaces,
        verified: value.configuration.settings.setup.computer.verified,
      };
      assert.equal(
        savedWorkspace.workspaces.length,
        1,
        JSON.stringify({
          status: value.configuration.status,
          workspaces: value.configuration.settings.computer.workspaces,
        }),
      );
      assert.equal(
        savedWorkspace.verified?.workspaceId,
        savedWorkspace.workspaces[0].workspaceId,
        "DEV_STARTUP_SMOKE_WORKSPACE_VERIFICATION_MISSING",
      );
    } else {
      const value = await legacyWindow.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.deepEqual(
        value.configuration.settings.computer.workspaces,
        savedWorkspace.workspaces,
      );
      assert.deepEqual(
        value.configuration.settings.setup.computer.verified,
        savedWorkspace.verified,
      );
    }
    await closeApplication(application);
    application = undefined;
  }

  const brokenRoot = path.join(temporaryRoot, "broken-app");
  await fs.cp(buildRoot, brokenRoot, { recursive: true });
  await fs.writeFile(path.join(brokenRoot, "build-manifest.json"), "{}\n", {
    mode: 0o600,
  });
  launchUnresolved = true;
  const broken = await runBoundedProcess(
    executable,
    [path.join(brokenRoot, "main.cjs"), "--preview-window-mode=hidden"],
    {
      cwd: root,
      env: environment,
      timeoutMs: 5_000,
    },
  );
  launchUnresolved = false;
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

  process.stdout.write(
    "Farol Dev React hidden startup smoke: PASS (TS adapters; isolated native state; no live-provider or native-dialog/focus acceptance)\n",
  );
} finally {
  if (application && !stopRequested.has(application)) {
    await closeApplication(application).catch(() => {
      cleanupConfirmed = false;
    });
  }
  if (cleanupConfirmed && !launchUnresolved)
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  else process.stderr.write(`DEV_REACT_RESOURCES_RETAINED:${temporaryRoot}\n`);
}
