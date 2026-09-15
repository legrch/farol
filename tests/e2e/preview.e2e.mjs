import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";

const root = process.cwd();
const development = process.argv.includes("--development");
const evidenceRoot = path.join(
  root,
  development ? "artifacts/e2e-dev" : "artifacts/e2e",
);
const metadataPath = path.join(root, "dist/package/artifact.json");

function verifyArtifact(candidateMetadataPath) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "tooling/verify-package.mjs"),
      "--artifact",
      candidateMetadataPath,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

const expectedSource = sourceIdentity(path.resolve(root, ".."), "vnext");
assert.equal(expectedSource.dirty, false, "E2E_SOURCE_NOT_HEAD_EXACT");
let artifact;
let appPath;
let executable;
let launchPrefix = [];
if (development) {
  const buildRoot = path.join(root, "dist/app");
  const build = JSON.parse(
    await fs.readFile(path.join(buildRoot, "build-manifest.json"), "utf8"),
  );
  assert.equal(build.dirty, false, "E2E_DIRTY_DEVELOPMENT_BUILD");
  assert.equal(build.inputExact, true, "E2E_DEVELOPMENT_INPUTS_NOT_EXACT");
  assert.equal(build.sourceCommit, expectedSource.commit);
  assert.equal(build.sourceTreeDigest, expectedSource.treeDigest);
  artifact = {
    artifactSha256: await treeDigest(buildRoot),
    sourceCommit: build.sourceCommit,
    sourceTreeDigest: build.sourceTreeDigest,
    sourceDirty: build.dirty,
  };
  appPath = path.join(root, "node_modules/electron/dist/Electron.app");
  executable = path.join(appPath, "Contents/MacOS/Electron");
  launchPrefix = [path.join(buildRoot, "main.cjs")];
} else {
  artifact = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  const verifiedArtifact = verifyArtifact(metadataPath);
  assert.equal(
    verifiedArtifact.status,
    0,
    `${verifiedArtifact.stdout}${verifiedArtifact.stderr}`,
  );
  assert.equal(artifact.sourceDirty, false, "E2E_DIRTY_ARTIFACT");
  assert.equal(artifact.sourceCommit, expectedSource.commit);
  assert.equal(artifact.sourceTreeDigest, expectedSource.treeDigest);
  appPath = path.resolve(artifact.artifactPath);
  executable = path.join(appPath, "Contents/MacOS/Farol Next Preview");
}
await fs.rm(evidenceRoot, { recursive: true, force: true });
await fs.mkdir(evidenceRoot, { recursive: true });

const cases = [];

if (development) {
  cases.push("development-build-identity");
} else {
  const corruptRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-corruption-"),
  );
  try {
    const malformedMetadata = path.join(corruptRoot, "malformed-artifact.json");
    await fs.writeFile(
      malformedMetadata,
      `${JSON.stringify({ ...artifact, schema: 3 })}\n`,
    );
    const malformed = verifyArtifact(malformedMetadata);
    assert.notEqual(malformed.status, 0);
    assert.match(
      `${malformed.stdout}${malformed.stderr}`,
      /PACKAGE_MANIFEST_SCHEMA_INVALID/u,
    );
    cases.push("malformed-artifact-rejected");

    const tamperedApp = path.join(corruptRoot, "Farol Next Preview.app");
    const cloned = spawnSync("/bin/cp", ["-cR", appPath, tamperedApp], {
      encoding: "utf8",
    });
    assert.equal(cloned.status, 0, `${cloned.stdout}${cloned.stderr}`);
    await fs.appendFile(
      path.join(tamperedApp, "Contents/Resources/app/shell.html"),
      "\n<!-- deterministic tamper probe -->\n",
    );
    const tamperedMetadata = path.join(corruptRoot, "tampered-artifact.json");
    await fs.writeFile(
      tamperedMetadata,
      `${JSON.stringify({ ...artifact, artifactPath: tamperedApp })}\n`,
    );
    const tampered = verifyArtifact(tamperedMetadata);
    assert.notEqual(tampered.status, 0);
    assert.match(
      `${tampered.stdout}${tampered.stderr}`,
      /PACKAGE_DIGEST_MISMATCH/u,
    );
    cases.push("tampered-artifact-rejected");

    const wrongHelperRoot = path.join(corruptRoot, "wrong-helper");
    await fs.mkdir(wrongHelperRoot);
    const wrongHelperApp = path.join(wrongHelperRoot, "Farol Next Preview.app");
    const helperClone = spawnSync("/bin/cp", ["-cR", appPath, wrongHelperApp], {
      encoding: "utf8",
    });
    assert.equal(
      helperClone.status,
      0,
      `${helperClone.stdout}${helperClone.stderr}`,
    );
    const helperPlist = path.join(
      wrongHelperApp,
      "Contents/Frameworks/Electron Runtime.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/Info.plist",
    );
    const changedHelper = spawnSync(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Set :CFBundleIdentifier local.farol.next.preview.foreign",
        helperPlist,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      changedHelper.status,
      0,
      `${changedHelper.stdout}${changedHelper.stderr}`,
    );
    const wrongHelperMetadata = path.join(
      corruptRoot,
      "wrong-helper-artifact.json",
    );
    await fs.writeFile(
      wrongHelperMetadata,
      `${JSON.stringify({
        ...artifact,
        artifactPath: wrongHelperApp,
        artifactSha256: await treeDigest(wrongHelperApp),
      })}\n`,
    );
    const wrongHelper = verifyArtifact(wrongHelperMetadata);
    assert.notEqual(wrongHelper.status, 0);
    assert.match(
      `${wrongHelper.stdout}${wrongHelper.stderr}`,
      /PACKAGE_RUNTIME_HELPER_BUNDLE_MISMATCH/u,
    );
    cases.push("wrong-helper-bundle-rejected");

    const wrongLauncherRoot = path.join(corruptRoot, "wrong-launcher");
    await fs.mkdir(wrongLauncherRoot);
    const wrongLauncherApp = path.join(
      wrongLauncherRoot,
      "Farol Next Preview.app",
    );
    const launcherClone = spawnSync(
      "/bin/cp",
      ["-cR", appPath, wrongLauncherApp],
      { encoding: "utf8" },
    );
    assert.equal(
      launcherClone.status,
      0,
      `${launcherClone.stdout}${launcherClone.stderr}`,
    );
    await fs.appendFile(
      path.join(wrongLauncherApp, "Contents/MacOS/Farol Next Preview"),
      "\n# deterministic tamper probe\n",
    );
    const wrongLauncherMetadata = path.join(
      corruptRoot,
      "wrong-launcher-artifact.json",
    );
    await fs.writeFile(
      wrongLauncherMetadata,
      `${JSON.stringify({
        ...artifact,
        artifactPath: wrongLauncherApp,
        artifactSha256: await treeDigest(wrongLauncherApp),
      })}\n`,
    );
    const wrongLauncher = verifyArtifact(wrongLauncherMetadata);
    assert.notEqual(wrongLauncher.status, 0);
    assert.match(
      `${wrongLauncher.stdout}${wrongLauncher.stderr}`,
      /PACKAGE_LAUNCHER_INVALID/u,
    );
    cases.push("tampered-launcher-rejected");

    const wrongRuntimeRoot = path.join(corruptRoot, "wrong-runtime");
    await fs.mkdir(wrongRuntimeRoot);
    const wrongRuntimeApp = path.join(
      wrongRuntimeRoot,
      "Farol Next Preview.app",
    );
    const runtimeClone = spawnSync(
      "/bin/cp",
      ["-cR", appPath, wrongRuntimeApp],
      { encoding: "utf8" },
    );
    assert.equal(
      runtimeClone.status,
      0,
      `${runtimeClone.stdout}${runtimeClone.stderr}`,
    );
    await fs.appendFile(
      path.join(
        wrongRuntimeApp,
        "Contents/Frameworks/Electron Runtime.app/Contents/Resources/default_app.asar",
      ),
      "\ndeterministic tamper probe\n",
    );
    const wrongRuntimeMetadata = path.join(
      corruptRoot,
      "wrong-runtime-artifact.json",
    );
    await fs.writeFile(
      wrongRuntimeMetadata,
      `${JSON.stringify({
        ...artifact,
        artifactPath: wrongRuntimeApp,
        artifactSha256: await treeDigest(wrongRuntimeApp),
      })}\n`,
    );
    const wrongRuntime = verifyArtifact(wrongRuntimeMetadata);
    assert.notEqual(wrongRuntime.status, 0);
    assert.match(
      `${wrongRuntime.stdout}${wrongRuntime.stderr}`,
      /PACKAGE_RUNTIME_DIGEST_MISMATCH/u,
    );
    cases.push("tampered-runtime-rejected");
  } finally {
    const real = path.resolve(corruptRoot);
    assert.ok(
      real.startsWith(
        `${path.resolve(os.tmpdir())}${path.sep}farol-next-corruption-`,
      ),
    );
    await fs.rm(real, { recursive: true, force: true });
  }
}

async function inspectWindowPresentation(application) {
  return application.evaluate(({ BrowserWindow, screen }) => {
    const targetWindow = BrowserWindow.getAllWindows()[0];
    if (!targetWindow) throw new Error("E2E_WINDOW_MISSING");
    const bounds = targetWindow.getBounds();
    const primary = screen.getPrimaryDisplay();
    const selected = screen.getDisplayMatching(bounds);
    const displays = screen.getAllDisplays().map((display) => ({
      id: display.id,
      internal: display.internal,
      primary: display.id === primary.id,
      workArea: display.workArea,
    }));
    return {
      mode:
        process.argv
          .find((argument) => argument.startsWith("--preview-window-mode="))
          ?.slice("--preview-window-mode=".length) ?? "default",
      visible: targetWindow.isVisible(),
      focused: targetWindow.isFocused(),
      taskViewCount: targetWindow.contentView.children.filter(
        (view) => "webContents" in view,
      ).length,
      bounds,
      display: {
        id: selected.id,
        internal: selected.internal,
        primary: selected.id === primary.id,
        selection:
          selected.id !== primary.id
            ? selected.internal
              ? "non-primary-internal"
              : "non-primary"
            : selected.internal
              ? "internal-primary-fallback"
              : "primary-fallback",
        workArea: selected.workArea,
      },
      displays,
    };
  });
}

function assertVisibleWindowPlacement(presentation) {
  assert.equal(presentation.mode, "secondary-visible");
  assert.equal(presentation.visible, true);
  assert.equal(presentation.focused, false);
  const preferred = presentation.displays.filter(
    (display) => !display.primary && display.internal,
  );
  const secondary = presentation.displays.filter((display) => !display.primary);
  if (preferred.length > 0) {
    assert.equal(presentation.display.internal, true);
    assert.equal(presentation.display.primary, false);
  } else if (secondary.length > 0) {
    assert.equal(presentation.display.primary, false);
  } else {
    assert.equal(presentation.display.primary, true);
  }
  const { bounds, display } = presentation;
  assert.ok(bounds.x >= display.workArea.x);
  assert.ok(bounds.y >= display.workArea.y);
  assert.ok(
    bounds.x + bounds.width <= display.workArea.x + display.workArea.width,
  );
  assert.ok(
    bounds.y + bounds.height <= display.workArea.y + display.workArea.height,
  );
}

async function waitForWindowPresentation(application, windowMode) {
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await inspectWindowPresentation(application);
    if (last.taskViewCount === 2) {
      if (windowMode === "hidden") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        last = await inspectWindowPresentation(application);
        assert.equal(last.visible, false);
      } else {
        if (!last.visible) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        assertVisibleWindowPlacement(last);
      }
      assert.equal(last.mode, windowMode);
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `E2E_WINDOW_PRESENTATION_TIMEOUT:${windowMode}:${JSON.stringify(last)}`,
  );
}

async function launch(extraArgs = [], windowMode = "hidden") {
  const isolatedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-e2e-home-"),
  );
  const userData = path.join(isolatedHome, "Farol Next Preview user-data");
  const application = await electron.launch({
    executablePath: executable,
    args: [
      ...launchPrefix,
      `--user-data-dir=${userData}`,
      `--preview-window-mode=${windowMode}`,
      ...extraArgs,
    ],
    env: {
      HOME: isolatedHome,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: os.tmpdir(),
    },
    timeout: 15_000,
  });
  const window = await application.firstWindow({ timeout: 15_000 });
  await window
    .locator("#task-tabs .task-tab")
    .first()
    .waitFor({ state: "visible" });
  const presentation = await waitForWindowPresentation(application, windowMode);
  return {
    application,
    window,
    isolatedHome,
    userData,
    windowMode,
    presentation,
  };
}

async function close(instance) {
  if (instance.windowMode) {
    const presentation = await inspectWindowPresentation(instance.application);
    assert.equal(presentation.mode, instance.windowMode);
    assert.equal(
      presentation.visible,
      instance.windowMode === "secondary-visible",
    );
  }
  await instance.application.close();
  const real = path.resolve(instance.isolatedHome);
  assert.ok(
    real.startsWith(
      `${path.resolve(os.tmpdir())}${path.sep}farol-next-e2e-home-`,
    ),
  );
  await fs.rm(real, { recursive: true, force: true });
}

async function proveStartupRuntimeDeath(stage) {
  const isolatedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-e2e-home-"),
  );
  const userData = path.join(isolatedHome, "Farol Next Preview user-data");
  const application = await electron.launch({
    executablePath: executable,
    args: [
      ...launchPrefix,
      `--user-data-dir=${userData}`,
      "--preview-window-mode=hidden",
    ],
    env: {
      HOME: isolatedHome,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: os.tmpdir(),
    },
    timeout: 15_000,
  });
  const instance = { application, isolatedHome, userData };
  try {
    const killed = await instance.application.evaluate(
      async ({ app, BrowserWindow }, targetStage) => {
        for (let attempt = 0; attempt < 5_000; attempt += 1) {
          const targetWindow = BrowserWindow.getAllWindows()[0];
          const viewCount =
            targetWindow?.contentView.children.filter(
              (view) => "webContents" in view,
            ).length ?? 0;
          const utility = app
            .getAppMetrics()
            .find(
              (metric) =>
                metric.type === "Utility" &&
                metric.name === "Farol Next Runtime" &&
                metric.serviceName === "node.mojom.NodeService",
            );
          const reached =
            targetStage === "after-runtime-ready"
              ? targetWindow !== undefined && viewCount === 0
              : targetStage === "during-first-view-load"
                ? viewCount === 1
                : viewCount >= 2;
          if (utility && reached) {
            process.kill(utility.pid, "SIGKILL");
            return { pid: utility.pid, viewCount };
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        throw new Error(`STARTUP_FAULT_POINT_TIMEOUT:${targetStage}`);
      },
      stage,
    );
    assert.ok(killed.pid > 0);
    const startupWindow = await application.firstWindow({ timeout: 15_000 });
    await startupWindow
      .locator("#runtime-pill")
      .getByText("failed")
      .waitFor({ timeout: 5_000 });
    assert.equal(startupWindow.isClosed(), false);
    assert.equal(
      await instance.application.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isVisible() ?? null,
      ),
      false,
    );
    const remainingTaskViews = await instance.application.evaluate(
      ({ BrowserWindow }) =>
        (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).filter(
          (view) => "webContents" in view,
        ).length,
    );
    assert.equal(remainingTaskViews, 0);
  } finally {
    await close(instance);
  }
}

async function taskSurfaces(application) {
  return application.evaluate(async ({ BrowserWindow, webContents }) => {
    const viewByContentsId = new Map(
      (BrowserWindow.getAllWindows()[0]?.contentView.children ?? [])
        .filter((view) => "webContents" in view)
        .map((view) => [view.webContents.id, view]),
    );
    return Promise.all(
      webContents
        .getAllWebContents()
        .filter((contents) => contents.getURL().includes("/task/"))
        .map(async (contents) => ({
          url: contents.getURL(),
          hostVisible: viewByContentsId.get(contents.id)?.getVisible() ?? null,
          focused: contents.isFocused(),
          state: await contents.executeJavaScript(
            `({
              taskId: document.body.dataset.taskId,
              deltaCount: Number(document.body.dataset.deltaCount),
              terminal: document.body.dataset.terminal === "true",
              failed: document.body.dataset.failed === "true",
              visibility: document.visibilityState,
              answer: document.getElementById("answer")?.textContent ?? "",
              status: document.getElementById("status")?.textContent ?? "",
              recovery: document.getElementById("recovery")?.textContent ?? "",
              offline: document.body.dataset.offline === "true"
            })`,
          ),
        })),
    );
  });
}

async function waitForTask(application, taskId, predicate, message) {
  let last = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const surfaces = await taskSurfaces(application);
    last = surfaces;
    const state = surfaces.find(
      (surface) => surface.state.taskId === taskId,
    )?.state;
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`E2E_TASK_TIMEOUT:${message}:${JSON.stringify(last)}`);
}

async function captureTask(application, taskId, filename) {
  const base64 = await application.evaluate(
    async ({ webContents }, targetTask) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) =>
          candidate.getURL().endsWith(`/task/${targetTask}`),
        );
      if (!contents) throw new Error("TASK_SURFACE_MISSING");
      contents.invalidate();
      const nativeCapture = (
        await contents.capturePage(undefined, { stayHidden: true })
      )
        .toPNG()
        .toString("base64");
      if (nativeCapture.length > 0) return nativeCapture;

      const attached = contents.debugger.isAttached();
      if (!attached) contents.debugger.attach("1.3");
      try {
        const capture = await contents.debugger.sendCommand(
          "Page.captureScreenshot",
          {
            format: "png",
            fromSurface: true,
          },
        );
        return capture.data;
      } finally {
        if (!attached) contents.debugger.detach();
      }
    },
    taskId,
  );
  assert.ok(base64.length > 1_000, "TASK_SCREENSHOT_EMPTY");
  await fs.writeFile(
    path.join(evidenceRoot, filename),
    Buffer.from(base64, "base64"),
  );
}

async function proveTaskEgressDenied(application) {
  let requests = 0;
  const probe = createServer((_request, response) => {
    requests += 1;
    response.end("unexpected");
  });
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  try {
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const target = `http://127.0.0.1:${address.port}/unexpected-egress`;
    const outcome = await application.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().includes("/task/"));
      if (!contents) throw new Error("TASK_SURFACE_MISSING");
      return contents.executeJavaScript(
        `fetch(${JSON.stringify(url)}).then(() => "reached", () => "blocked")`,
      );
    }, target);
    assert.equal(outcome, "blocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function proveTaskCapabilityIsolation(application) {
  const result = await application.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().endsWith("/task/task-atlantic"));
    if (!contents) throw new Error("TASK_SURFACE_MISSING");
    return contents.executeJavaScript(`(async () => {
      const source = [...document.scripts].map((script) => script.textContent || "").join("\\n");
      const encoded = /const token = ("[^"]+");/.exec(source)?.[1];
      if (!encoded) throw new Error("TASK_READ_TOKEN_MISSING");
      const taskToken = JSON.parse(encoded);
      const read = await fetch("/events/task-harbor", {
        headers: { authorization: "Bearer " + taskToken }
      });
      const control = await fetch("/control/task-harbor/release-completion", {
        method: "POST",
        headers: { authorization: "Bearer " + taskToken }
      });
      return {
        readStatus: read.status,
        controlStatus: control.status,
        privilegedBridge: typeof window.farolNext
      };
    })()`);
  });
  assert.deepEqual(result, {
    readStatus: 401,
    controlStatus: 401,
    privilegedBridge: "undefined",
  });
}

async function sendShortcutFromTask(application, taskId, reverse = false) {
  await application.evaluate(
    ({ webContents }, input) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) =>
          candidate.getURL().endsWith(`/task/${input.taskId}`),
        );
      if (!contents) throw new Error("TASK_SURFACE_MISSING");
      contents.focus();
      contents.sendInputEvent({
        type: "keyDown",
        keyCode: "Tab",
        modifiers: input.reverse ? ["control", "shift"] : ["control"],
      });
      contents.sendInputEvent({
        type: "keyUp",
        keyCode: "Tab",
        modifiers: input.reverse ? ["control", "shift"] : ["control"],
      });
    },
    { taskId, reverse },
  );
}

async function setWindowSize(application, width, height) {
  await application.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
}

async function shellGeometry(window) {
  return window.evaluate(() =>
    [".task-bar", ".surface", "#task-tabs"].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`GEOMETRY_ELEMENT_MISSING:${selector}`);
      const bounds = element.getBoundingClientRect();
      return {
        selector,
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      };
    }),
  );
}

const setupScreens = [
  ["chatgpt", "setup-1-chatgpt-wide.png"],
  ["computer", "setup-2-computer-wide.png"],
  ["connect", "setup-3-connect-wide.png"],
  ["hosts", "setup-4-hosts-wide.png"],
  ["verify", "setup-5-verify-wide.png"],
];

async function completeSetup(instance, capture = false) {
  const dialog = instance.window.locator("#setup-dialog");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.getAttribute("data-mode"), "first-run");
  assert.equal(
    await instance.window.evaluate(() => document.activeElement?.id),
    "setup-next",
  );
  for (const [stepId, screenshot] of setupScreens) {
    assert.equal(await dialog.getAttribute("data-step-id"), stepId);
    assert.match(await dialog.innerText(), /Step [1-5] of 5/u);
    assert.match(
      await dialog.innerText(),
      /Not connected|Preview only|Local only|Not configured|Verified locally/u,
    );
    if (capture) {
      await instance.window.screenshot({
        path: path.join(evidenceRoot, screenshot),
      });
    }
    await instance.window.locator("#setup-next").click();
  }
  await dialog.waitFor({ state: "hidden" });
}

const normal = await launch([], "secondary-visible");
try {
  if (!development) {
    const launchIdentity = await normal.application.evaluate(({ app }) => ({
      name: app.getName(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      executable: process.execPath,
    }));
    assert.deepEqual(launchIdentity, {
      name: "Farol Next Preview",
      version: "0.1.0-preview.0",
      isPackaged: true,
      appPath: path.join(appPath, "Contents/Resources/app"),
      executable: path.join(
        appPath,
        "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
      ),
    });
    cases.push("packaged-launcher-identity");
  }
  assert.equal(await normal.window.locator("#task-tabs .task-tab").count(), 2);
  const runtimeLabel = await normal.window.locator("#runtime-pill").innerText();
  if (!runtimeLabel.includes("Local runtime")) {
    await normal.window.locator('[data-section="settings"]').click();
    throw new Error(
      `E2E_RUNTIME_NOT_READY:${runtimeLabel}:${await normal.window.locator("#settings-list").innerText()}`,
    );
  }
  await completeSetup(normal, true);
  const resourceIdentity = await normal.application.evaluate(
    ({ app, session }) => ({
      userData: app.getPath("userData"),
      taskStorage: session.fromPartition("persist:farol-next-preview")
        .storagePath,
    }),
  );
  const isolatedRoot = await fs.realpath(normal.isolatedHome);
  assert.equal(
    await fs.realpath(resourceIdentity.userData),
    await fs.realpath(normal.userData),
  );
  assert.ok(resourceIdentity.taskStorage);
  assert.ok(
    (await fs.realpath(resourceIdentity.taskStorage)).startsWith(
      `${isolatedRoot}${path.sep}`,
    ),
  );
  assert.equal(
    path.basename(resourceIdentity.userData),
    "Farol Next Preview user-data",
  );
  await waitForTask(
    normal.application,
    "task-atlantic",
    (state) =>
      state.deltaCount >= 1 &&
      state.status.includes("approval") &&
      !state.terminal,
    "first delta before tool approval",
  );
  await proveTaskEgressDenied(normal.application);
  await proveTaskCapabilityIsolation(normal.application);
  await captureTask(
    normal.application,
    "task-atlantic",
    "running-browser-view.png",
  );
  const wideBrowserGeometry = await shellGeometry(normal.window);
  await setWindowSize(normal.application, 700, 600);
  await captureTask(
    normal.application,
    "task-atlantic",
    "running-browser-compact.png",
  );
  await setWindowSize(normal.application, 1180, 760);
  assert.deepEqual(await shellGeometry(normal.window), wideBrowserGeometry);

  await normal.window.locator('[data-section="computer"]').click();
  const approve = normal.window.locator("#approve-tool");
  await approve.waitFor({ state: "visible" });
  await normal.window.waitForFunction(
    () => !document.querySelector("#approve-tool")?.hasAttribute("disabled"),
    undefined,
    { timeout: 5_000 },
  );
  assert.equal(await approve.isEnabled(), true);
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "tool-wait-wide.png"),
  });
  await setWindowSize(normal.application, 700, 600);
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "tool-wait-compact.png"),
  });
  await setWindowSize(normal.application, 1180, 760);
  await approve.click();
  const resumed = await waitForTask(
    normal.application,
    "task-atlantic",
    (state) =>
      state.deltaCount === 2 &&
      state.answer.includes(
        "Fixture result Fixture workspace is bound to turn-atlantic-1-computer-1",
      ) &&
      !state.terminal,
    "tool result resumed exact turn",
  );
  assert.match(
    resumed.answer,
    /Fixture result Fixture workspace is bound to turn-atlantic-1-computer-1/u,
  );

  await normal.window.locator('[data-section="browser"]').click();
  const beforeTabSwitch = await shellGeometry(normal.window);
  await normal.window.locator('[data-task-id="task-harbor"]').click();
  assert.deepEqual(await shellGeometry(normal.window), beforeTabSwitch);
  const switched = await taskSurfaces(normal.application);
  const atlantic = switched.find(
    (surface) => surface.state.taskId === "task-atlantic",
  )?.state;
  const harbor = switched.find(
    (surface) => surface.state.taskId === "task-harbor",
  )?.state;
  assert.equal(atlantic?.terminal, false);
  assert.equal(harbor?.terminal, false);
  assert.equal(
    switched.find((surface) => surface.state.taskId === "task-harbor")
      ?.hostVisible,
    true,
  );
  assert.equal(
    switched.find((surface) => surface.state.taskId === "task-atlantic")
      ?.hostVisible,
    false,
  );

  await normal.window.locator("#release-completion").click();
  await waitForTask(
    normal.application,
    "task-harbor",
    (state) => state.terminal && state.status === "Completed",
    "hidden-independent task completion",
  );
  await normal.window.locator('[data-task-id="task-atlantic"]').click();
  const retained = await waitForTask(
    normal.application,
    "task-atlantic",
    (state) => state.deltaCount === 2 && !state.terminal,
    "atlantic retained while harbor completed",
  );
  assert.match(
    retained.answer,
    /Fixture result Fixture workspace is bound to turn-atlantic-1-computer-1/u,
  );
  await normal.window.locator("#release-completion").click();
  await waitForTask(
    normal.application,
    "task-atlantic",
    (state) => state.terminal && state.status === "Completed",
    "atlantic completion",
  );

  await normal.window.keyboard.press("Meta+3");
  await normal.window.locator('[data-panel="activity"].active').waitFor();
  const activityText = await normal.window
    .locator('[data-panel="activity"]')
    .innerText();
  assert.doesNotMatch(activityText, /Synthetic local preview fixture/u);
  assert.doesNotMatch(activityText, /Checking the isolated fixture/u);
  assert.doesNotMatch(activityText, /Fixture result|computer-1/u);
  assert.doesNotMatch(activityText, /Bearer|token|\/private\//u);
  assert.doesNotMatch(activityText, /task-atlantic|turn-atlantic/u);
  await normal.window
    .locator("#activity-list")
    .getByText("Client delivery acknowledged", { exact: true })
    .first()
    .waitFor();
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "complete-wide.png"),
  });

  await setWindowSize(normal.application, 700, 600);
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "complete-compact.png"),
  });
  await normal.window.keyboard.press("Meta+4");
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  assert.match(
    await normal.window.locator("#settings-list").innerText(),
    /local\.farol\.next\.preview/u,
  );
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "settings-compact.png"),
  });
  await normal.window.locator("#review-setup").click();
  const reviewedSetup = normal.window.locator("#setup-dialog");
  await reviewedSetup.waitFor({ state: "visible" });
  assert.equal(await reviewedSetup.getAttribute("data-mode"), "review");
  assert.equal(await reviewedSetup.getAttribute("data-step-id"), "chatgpt");
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "setup-review-compact.png"),
  });
  await normal.window.locator("#setup-close").click();
  await reviewedSetup.waitFor({ state: "hidden" });

  await normal.window.keyboard.press("Meta+1");
  await sendShortcutFromTask(normal.application, "task-atlantic");
  await normal.window
    .locator('[data-task-id="task-harbor"][aria-selected="true"]')
    .waitFor();
  let focused = await taskSurfaces(normal.application);
  assert.equal(
    focused.find((surface) => surface.state.taskId === "task-harbor")?.focused,
    true,
  );
  assert.equal(
    focused.find((surface) => surface.state.taskId === "task-atlantic")
      ?.focused,
    false,
  );
  await sendShortcutFromTask(normal.application, "task-harbor", true);
  await normal.window
    .locator('[data-task-id="task-atlantic"][aria-selected="true"]')
    .waitFor();
  focused = await taskSurfaces(normal.application);
  assert.equal(
    focused.find((surface) => surface.state.taskId === "task-atlantic")
      ?.focused,
    true,
  );
  assert.equal(
    focused.find((surface) => surface.state.taskId === "task-harbor")?.focused,
    false,
  );
  cases.push(
    "visible-window-secondary-display",
    "visible-window-show-inactive",
    "isolated-state-root",
    "task-network-default-deny",
    "task-capability-isolation",
    "two-tabs-independent",
    "incremental-before-terminal",
    "computer-exact-correlation",
    "keyboard-focus",
    "activity-redaction",
    "compact-layout",
    "stable-layout-geometry",
    "client-delivery-acknowledged",
    "first-run-setup-journey",
    "settings-setup-reentry",
  );
} finally {
  await close(normal);
}

const failed = await launch(["--preview-failure"]);
try {
  await completeSetup(failed);
  await failed.window
    .locator('[data-task-id="task-atlantic"] small')
    .getByText("Needs attention")
    .waitFor();
  assert.equal(
    await failed.window.locator("#release-completion").isDisabled(),
    true,
  );
  await failed.window.locator('[data-section="activity"]').click();
  assert.match(
    await failed.window.locator("#activity-list").innerText(),
    /Turn finished/u,
  );
  await failed.window.screenshot({
    path: path.join(evidenceRoot, "failure-wide.png"),
  });
  await setWindowSize(failed.application, 700, 600);
  await failed.window.screenshot({
    path: path.join(evidenceRoot, "failure-compact.png"),
  });
  cases.push("provider-failure-state");
} finally {
  await close(failed);
}

const streamFailure = await launch(["--preview-stream-failure"]);
try {
  await completeSetup(streamFailure);
  await streamFailure.window
    .locator('[data-task-id="task-atlantic"] small')
    .getByText("Surface failed")
    .waitFor({ timeout: 5_000 });
  assert.match(
    await streamFailure.window.locator("#runtime-pill").innerText(),
    /Local runtime/u,
  );
  await waitForTask(
    streamFailure.application,
    "task-atlantic",
    (state) => state.offline && !state.terminal,
    "task-local stream failure",
  );
  await waitForTask(
    streamFailure.application,
    "task-harbor",
    (state) => state.deltaCount === 2 && !state.terminal && !state.offline,
    "independent task survives stream failure",
  );
  await streamFailure.window.locator('[data-task-id="task-harbor"]').click();
  await streamFailure.window.locator("#release-completion").click();
  await waitForTask(
    streamFailure.application,
    "task-harbor",
    (state) => state.terminal && state.status === "Completed",
    "surviving task completion",
  );
  const isolated = await taskSurfaces(streamFailure.application);
  assert.equal(
    isolated.find((surface) => surface.state.taskId === "task-atlantic")?.state
      .offline,
    true,
  );
  assert.equal(
    isolated.find((surface) => surface.state.taskId === "task-atlantic")
      ?.hostVisible,
    false,
  );
  assert.equal(
    isolated.find((surface) => surface.state.taskId === "task-harbor")?.state
      .terminal,
    true,
  );
  assert.equal(
    isolated.find((surface) => surface.state.taskId === "task-harbor")
      ?.hostVisible,
    true,
  );
  await captureTask(
    streamFailure.application,
    "task-atlantic",
    "stream-failure-offline-task.png",
  );
  await captureTask(
    streamFailure.application,
    "task-harbor",
    "stream-failure-survivor-task.png",
  );
  await streamFailure.window.screenshot({
    path: path.join(evidenceRoot, "stream-failure-wide.png"),
  });
  await setWindowSize(streamFailure.application, 700, 600);
  await streamFailure.window.screenshot({
    path: path.join(evidenceRoot, "stream-failure-compact.png"),
  });
  cases.push("task-stream-failure-isolation");
} finally {
  await close(streamFailure);
}

const processDeath = await launch();
try {
  await completeSetup(processDeath);
  const utilityPid = await processDeath.application.evaluate(({ app }) => {
    const matches = app
      .getAppMetrics()
      .filter(
        (metric) =>
          metric.type === "Utility" &&
          metric.name === "Farol Next Runtime" &&
          metric.serviceName === "node.mojom.NodeService",
      );
    if (matches.length !== 1) {
      throw new Error(`UTILITY_PROCESS_IDENTITY_INVALID:${matches.length}`);
    }
    return matches[0].pid;
  });
  process.kill(utilityPid, "SIGKILL");
  await processDeath.window
    .locator("#runtime-pill")
    .getByText("failed")
    .waitFor({ timeout: 5_000 });
  await processDeath.window
    .locator("#browser-loading")
    .getByText("local runtime stopped", { exact: false })
    .waitFor();
  const remainingTaskViews = await processDeath.application.evaluate(
    ({ BrowserWindow }) =>
      (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).filter(
        (view) => "webContents" in view,
      ).length,
  );
  assert.equal(remainingTaskViews, 0);
  await processDeath.window.screenshot({
    path: path.join(evidenceRoot, "process-death-wide.png"),
  });
  await setWindowSize(processDeath.application, 700, 600);
  assert.equal(processDeath.window.isClosed(), false);
  await processDeath.window.screenshot({
    path: path.join(evidenceRoot, "process-death-compact.png"),
  });
  cases.push("utility-process-sigkill-state");
} finally {
  await close(processDeath);
}

for (const stage of [
  "after-runtime-ready",
  "during-first-view-load",
  "during-second-view-load",
]) {
  await proveStartupRuntimeDeath(stage);
  cases.push(`utility-process-sigkill-${stage}`);
}
cases.push("fault-scenarios-remain-hidden");

const report = {
  schema: 1,
  lane: development ? "development-build" : "sealed-package",
  artifactSha256: artifact.artifactSha256,
  sourceCommit: artifact.sourceCommit,
  sourceTreeDigest: artifact.sourceTreeDigest,
  sourceDirty: artifact.sourceDirty,
  windowPolicy: {
    visibleRun: {
      mode: normal.presentation.mode,
      focusedAtFirstPaint: normal.presentation.focused,
      displayId: normal.presentation.display.id,
      displayInternal: normal.presentation.display.internal,
      displayPrimary: normal.presentation.display.primary,
      selection: normal.presentation.display.selection,
      displayCount: normal.presentation.displays.length,
      bounds: normal.presentation.bounds,
      workArea: normal.presentation.display.workArea,
    },
    hiddenRuns: [
      "provider-failure",
      "stream-failure",
      "runtime-process-death",
      "startup-runtime-death-after-ready",
      "startup-runtime-death-during-first-view",
      "startup-runtime-death-during-second-view",
    ],
  },
  cases,
  screenshots: [
    "running-browser-view.png",
    "running-browser-compact.png",
    "tool-wait-wide.png",
    "tool-wait-compact.png",
    "complete-wide.png",
    "complete-compact.png",
    "settings-compact.png",
    "setup-1-chatgpt-wide.png",
    "setup-2-computer-wide.png",
    "setup-3-connect-wide.png",
    "setup-4-hosts-wide.png",
    "setup-5-verify-wide.png",
    "setup-review-compact.png",
    "failure-wide.png",
    "failure-compact.png",
    "stream-failure-wide.png",
    "stream-failure-compact.png",
    "stream-failure-offline-task.png",
    "stream-failure-survivor-task.png",
    "process-death-wide.png",
    "process-death-compact.png",
  ],
};
for (const filename of report.screenshots) {
  const evidence = await fs.stat(path.join(evidenceRoot, filename));
  assert.ok(evidence.size > 1_000, `E2E_SCREENSHOT_EMPTY:${filename}`);
}
await fs.writeFile(
  path.join(evidenceRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
