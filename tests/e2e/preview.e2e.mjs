import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { _electron as electron } from "playwright-core";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { openEvidenceAttempt } from "../../tooling/evidence-attempt.mjs";
import { missingCases } from "../../tooling/evidence-cases.mjs";
import {
  assertBuildIdentity,
  createBuildIdentity,
} from "../../tooling/build-identity-contract.mjs";
import { parseOwnerLaunchResult } from "../../tooling/owner-launch-result.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";

const root = process.cwd();
const development = process.argv.includes("--development");
const lifecycleSoak = process.argv.includes("--lifecycle-soak");
const persistenceFault = process.argv.includes("--persistence-fault");
const skipNativeFocus = process.argv.includes("--skip-native-focus");
assert.equal(
  lifecycleSoak && persistenceFault,
  false,
  "E2E_EXCLUSIVE_SPECIAL_MODE",
);
const evidenceLaneRoot = path.join(
  root,
  lifecycleSoak
    ? "artifacts/lifecycle-soak"
    : persistenceFault
      ? "artifacts/persistence-fault"
      : development
        ? "artifacts/e2e-dev"
        : "artifacts/e2e",
);
const metadataPath = path.join(root, "dist/package/artifact.json");
const canonicalPackagePath = path.join(
  root,
  "dist/package/Farol Next Preview.app",
);
const vendorElectron = path.join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

function verifyArtifact(candidateMetadataPath, candidateAppPath = null) {
  const arguments_ = [
    path.join(root, "tooling/verify-package.mjs"),
    "--artifact",
    candidateMetadataPath,
  ];
  if (candidateAppPath) arguments_.push("--app", candidateAppPath);
  return spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: "utf8",
  });
}

const expectedSource = sourceIdentity(path.resolve(root, ".."), "vnext");
assert.equal(expectedSource.dirty, false, "E2E_SOURCE_NOT_HEAD_EXACT");
let artifact;
let buildIdentity;
let appPath;
let executable;
let launchPrefix = [];
if (development) {
  const buildRoot = path.join(root, "dist/app");
  const build = JSON.parse(
    await fs.readFile(path.join(buildRoot, "build-manifest.json"), "utf8"),
  );
  buildIdentity = assertBuildIdentity(
    JSON.parse(
      await fs.readFile(path.join(buildRoot, "build-identity.json"), "utf8"),
    ),
  );
  assert.equal(build.schema, 3);
  assert.equal(build.dirty, false, "E2E_DIRTY_DEVELOPMENT_BUILD");
  assert.equal(build.inputExact, true, "E2E_DEVELOPMENT_INPUTS_NOT_EXACT");
  assert.equal(build.sourceCommit, expectedSource.commit);
  assert.equal(build.sourceTreeDigest, expectedSource.treeDigest);
  artifact = {
    artifactSha256: await treeDigest(buildRoot),
    sourceCommit: build.sourceCommit,
    sourceTreeDigest: build.sourceTreeDigest,
    sourceDirty: build.dirty,
    buildId: buildIdentity.buildId,
    builtAt: buildIdentity.builtAt,
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
  assert.equal(artifact.artifactPath, canonicalPackagePath);
  appPath = canonicalPackagePath;
  buildIdentity = assertBuildIdentity(
    JSON.parse(
      await fs.readFile(
        path.join(appPath, "Contents/Resources/app/build-identity.json"),
        "utf8",
      ),
    ),
  );
  assert.equal(artifact.buildId, buildIdentity.buildId);
  assert.equal(artifact.builtAt, buildIdentity.builtAt);
  executable = path.join(appPath, "Contents/MacOS/Farol Next Preview");
}
// Every run writes into its own immutable attempt directory under the lane
// root; a later or crashed run never removes an earlier run's evidence.
const evidenceAttempt = await openEvidenceAttempt(evidenceLaneRoot, {
  lane: lifecycleSoak
    ? "lifecycle-soak"
    : persistenceFault
      ? "persistence-fault"
      : development
        ? "development-build"
        : "sealed-package",
  input: {
    sourceCommit: artifact.sourceCommit,
    sourceTreeDigest: artifact.sourceTreeDigest,
    sourceDirty: artifact.sourceDirty,
    artifactSha256: artifact.artifactSha256,
    buildId: artifact.buildId,
    builtAt: artifact.builtAt,
    skipNativeFocus,
  },
});
evidenceAttempt.installProcessHandlers();
const evidenceRoot = evidenceAttempt.directory;

const cases = [];
const skippedCases = [];
const blockedCases = [];
let nativeFocusProofCompleted = false;
let quitProofs = 0;

function detectMacHostLockState() {
  if (process.platform !== "darwin") return "not-applicable";
  const probe = spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], {
    encoding: "utf8",
  });
  assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`);
  if (/"IOConsoleLocked" = Yes/u.test(probe.stdout)) return "locked";
  if (/"IOConsoleLocked" = No/u.test(probe.stdout)) return "unlocked";
  throw new Error("E2E_MAC_HOST_LOCK_STATE_UNKNOWN");
}

const macHostLockState = detectMacHostLockState();
const nativeWindowProofAvailable =
  !skipNativeFocus && macHostLockState !== "locked";

function visibleWindowTopologyBlock(presentation) {
  const requested = { width: 1180, height: 760 };
  const displays = [...presentation.displays].sort(
    (left, right) => left.id - right.id,
  );
  const selected =
    displays.find((display) => !display.primary && display.internal) ??
    displays.find((display) => !display.primary);
  if (!selected) {
    return {
      code: "SECONDARY_DISPLAY_UNAVAILABLE",
      reason: "no non-primary display is available for visible native evidence",
      ownerAction:
        "Provide one non-primary display with at least 1180x760 available work area, then rerun this exact lane.",
      requested,
      selectedDisplay: null,
    };
  }
  if (
    selected.workArea.width < requested.width ||
    selected.workArea.height < requested.height
  ) {
    return {
      code: "VISIBLE_TEST_VIEWPORT_UNAVAILABLE",
      reason:
        "the selected non-primary display cannot preserve the exact visible test viewport",
      ownerAction:
        "Provide a non-primary display with at least 1180x760 available work area, then rerun this exact lane.",
      requested,
      selectedDisplay: selected,
    };
  }
  return null;
}

async function writeWindowTopologyBlockedReport(presentation) {
  const topologyBlock = visibleWindowTopologyBlock(presentation);
  if (!topologyBlock) return false;
  blockedCases.push({
    name: "visible-window-secondary-display",
    reason: topologyBlock.reason,
    code: topologyBlock.code,
    ownerAction: topologyBlock.ownerAction,
  });
  const report = {
    schema: 1,
    status: "BLOCKED",
    lane: development ? "development-build" : "sealed-package",
    artifactSha256: artifact.artifactSha256,
    sourceCommit: artifact.sourceCommit,
    sourceTreeDigest: artifact.sourceTreeDigest,
    sourceDirty: artifact.sourceDirty,
    windowPolicy: {
      visibleRun: {
        mode: "secondary-visible",
        status: "blocked-topology-preflight",
        code: topologyBlock.code,
        requiredViewport: topologyBlock.requested,
        selectedDisplay: topologyBlock.selectedDisplay,
        displayCount: presentation.displays.length,
        displays: presentation.displays,
        nativeFocusProof: "not-attempted-topology-unavailable",
        nativeFocusRequested: !skipNativeFocus,
        macHostLockState,
      },
      hiddenRuns: ["ordinary-product-preflight"],
    },
    caseCount: cases.length,
    uniqueCaseCount: new Set(cases).size,
    cases,
    blockedCases,
    skippedCases,
    screenshots: [],
  };
  await fs.writeFile(
    path.join(evidenceRoot, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await evidenceAttempt.finish("BLOCKED", {
    cases,
    blockedCases,
    skippedCases,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    `E2E_REQUIRED_CASES_BLOCKED:${JSON.stringify(blockedCases)}\n`,
  );
  return true;
}

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
      `${JSON.stringify({ ...artifact, schema: 999 })}\n`,
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
    const copied = verifyArtifact(metadataPath, tamperedApp);
    assert.equal(copied.status, 0, `${copied.stdout}${copied.stderr}`);
    cases.push("copied-destination-verified");

    const rewrittenIdentityRoot = path.join(
      corruptRoot,
      "rewritten-build-identity",
    );
    await fs.mkdir(rewrittenIdentityRoot);
    const rewrittenIdentityApp = path.join(
      rewrittenIdentityRoot,
      "Farol Next Preview.app",
    );
    const identityClone = spawnSync(
      "/bin/cp",
      ["-cR", appPath, rewrittenIdentityApp],
      { encoding: "utf8" },
    );
    assert.equal(
      identityClone.status,
      0,
      `${identityClone.stdout}${identityClone.stderr}`,
    );
    const rewrittenResources = path.join(
      rewrittenIdentityApp,
      "Contents/Resources/app",
    );
    const rewrittenIdentity = createBuildIdentity({
      ...buildIdentity,
      builtAt: new Date(
        Date.parse(buildIdentity.builtAt) + 60_000,
      ).toISOString(),
    });
    const rewrittenIdentityBytes = Buffer.from(
      `${JSON.stringify(rewrittenIdentity, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(rewrittenResources, "build-identity.json"),
      rewrittenIdentityBytes,
    );
    const rewrittenManifestPath = path.join(
      rewrittenResources,
      "build-manifest.json",
    );
    const rewrittenManifest = JSON.parse(
      await fs.readFile(rewrittenManifestPath, "utf8"),
    );
    rewrittenManifest.buildId = rewrittenIdentity.buildId;
    rewrittenManifest.builtAt = rewrittenIdentity.builtAt;
    rewrittenManifest.entrySha256["build-identity.json"] = createHash("sha256")
      .update(rewrittenIdentityBytes)
      .digest("hex");
    await fs.writeFile(
      rewrittenManifestPath,
      `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
    );
    const rewrittenIdentityMetadata = path.join(
      corruptRoot,
      "rewritten-build-identity-artifact.json",
    );
    await fs.writeFile(
      rewrittenIdentityMetadata,
      `${JSON.stringify({
        ...artifact,
        artifactSha256: await treeDigest(rewrittenIdentityApp),
      })}\n`,
    );
    const rewrittenIdentityResult = verifyArtifact(
      rewrittenIdentityMetadata,
      rewrittenIdentityApp,
    );
    assert.notEqual(rewrittenIdentityResult.status, 0);
    assert.match(
      `${rewrittenIdentityResult.stdout}${rewrittenIdentityResult.stderr}`,
      /PACKAGE_BUILD_IDENTITY_MISMATCH/u,
    );
    cases.push("rewritten-build-identity-rejected");

    const redirectedMetadata = path.join(
      corruptRoot,
      "redirected-artifact.json",
    );
    await fs.writeFile(
      redirectedMetadata,
      `${JSON.stringify({ ...artifact, artifactPath: tamperedApp })}\n`,
    );
    const redirected = verifyArtifact(redirectedMetadata);
    assert.notEqual(redirected.status, 0);
    assert.match(
      `${redirected.stdout}${redirected.stderr}`,
      /PACKAGE_ARTIFACT_PATH_INVALID/u,
    );
    cases.push("manifest-redirected-artifact-rejected");
    await fs.appendFile(
      path.join(tamperedApp, "Contents/Resources/app/shell.html"),
      "\n<!-- deterministic tamper probe -->\n",
    );
    const tampered = verifyArtifact(metadataPath, tamperedApp);
    assert.notEqual(tampered.status, 0);
    assert.match(
      `${tampered.stdout}${tampered.stderr}`,
      /PACKAGE_DIGEST_MISMATCH/u,
    );
    cases.push("tampered-artifact-rejected");

    const extraResourceRoot = path.join(corruptRoot, "extra-resource");
    await fs.mkdir(extraResourceRoot);
    const extraResourceApp = path.join(
      extraResourceRoot,
      "Farol Next Preview.app",
    );
    const resourceClone = spawnSync(
      "/bin/cp",
      ["-cR", appPath, extraResourceApp],
      { encoding: "utf8" },
    );
    assert.equal(
      resourceClone.status,
      0,
      `${resourceClone.stdout}${resourceClone.stderr}`,
    );
    await fs.writeFile(
      path.join(
        extraResourceApp,
        "Contents/Resources/app/legacy-private-state.json",
      ),
      "{}\n",
    );
    const extraResourceMetadata = path.join(
      corruptRoot,
      "extra-resource-artifact.json",
    );
    await fs.writeFile(
      extraResourceMetadata,
      `${JSON.stringify({
        ...artifact,
        artifactSha256: await treeDigest(extraResourceApp),
      })}\n`,
    );
    const extraResource = verifyArtifact(
      extraResourceMetadata,
      extraResourceApp,
    );
    assert.notEqual(extraResource.status, 0);
    assert.match(
      `${extraResource.stdout}${extraResource.stderr}`,
      /PACKAGE_RESOURCE_SET_INVALID/u,
    );
    cases.push("legacy-private-resource-rejected");

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
        artifactSha256: await treeDigest(wrongHelperApp),
      })}\n`,
    );
    const wrongHelper = verifyArtifact(wrongHelperMetadata, wrongHelperApp);
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
        artifactSha256: await treeDigest(wrongLauncherApp),
      })}\n`,
    );
    const wrongLauncher = verifyArtifact(
      wrongLauncherMetadata,
      wrongLauncherApp,
    );
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
        artifactSha256: await treeDigest(wrongRuntimeApp),
      })}\n`,
    );
    const wrongRuntime = verifyArtifact(wrongRuntimeMetadata, wrongRuntimeApp);
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
    const targetWindow = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return (
        candidate.getTitle() === "Farol Next Preview" &&
        url.startsWith("file:") &&
        url.endsWith("/shell.html")
      );
    });
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
  assert.ok(secondary.length > 0, "E2E_SECONDARY_DISPLAY_UNAVAILABLE");
  if (preferred.length > 0) {
    assert.equal(presentation.display.internal, true);
    assert.equal(presentation.display.primary, false);
  } else {
    assert.equal(presentation.display.primary, false);
  }
  const { bounds, display } = presentation;
  assert.equal(bounds.width, 1180);
  assert.equal(bounds.height, 760);
  assert.ok(bounds.x >= display.workArea.x);
  assert.ok(bounds.y >= display.workArea.y);
  assert.ok(
    bounds.x + bounds.width <= display.workArea.x + display.workArea.width,
  );
  assert.ok(
    bounds.y + bounds.height <= display.workArea.y + display.workArea.height,
  );
}

async function waitForWindowPresentation(
  application,
  windowMode,
  expectedTaskViewCount = 2,
) {
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await inspectWindowPresentation(application);
    if (last.taskViewCount === expectedTaskViewCount) {
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

async function waitForShellVisibility(
  application,
  expectedVisible,
  expectedTaskViewCount,
) {
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await inspectWindowPresentation(application);
    if (
      last.visible === expectedVisible &&
      last.taskViewCount === expectedTaskViewCount
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `E2E_SHELL_VISIBILITY_TIMEOUT:${expectedVisible}:${JSON.stringify(last)}`,
  );
}

async function startChatGptFixture() {
  const fixture = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/chatgpt-popup") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(`<!doctype html>
        <html><head><meta charset="utf-8"><title>ChatGPT popup fixture</title>
        <style>body{background:#111216;color:#f7f7f8;font:16px sans-serif;padding:32px}</style></head>
        <body><p data-testid="popup-ready">Secure popup ready</p></body></html>`);
      return;
    }
    if (
      pathname !== "/chatgpt" &&
      !/^\/chatgpt\/c\/[A-Za-z0-9-]{8,128}\/?$/u.test(pathname)
    ) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    });
    response.end(`<!doctype html>
      <html><head><meta charset="utf-8"><title>ChatGPT readiness fixture</title>
      <style>body{background:#111216;color:#f7f7f8;font:16px sans-serif;padding:32px}button,#prompt-textarea{min-width:280px;min-height:44px}.message{white-space:pre-wrap;margin:18px 0}.attachment-chip{display:inline-block;margin:8px;padding:6px 10px;border:1px solid #555;border-radius:8px}</style></head>
      <body>
        <button data-testid="login-button" type="button">Log in</button>
        <button data-testid="popup-button" type="button">Open login popup</button>
        <button data-testid="expire-button" type="button" hidden>Expire session</button>
        <div id="prompt-textarea" contenteditable="true" data-virtualkeyboard="true" aria-label="Message" hidden></div>
        <input data-testid="attachment-input" type="file" multiple hidden />
        <div id="attachment-chips"></div>
        <p data-testid="attachment-upload-error" hidden>Failed to upload attachment</p>
        <button data-testid="send-button" type="button" disabled hidden>Send</button>
        <button data-testid="stop-button" type="button" hidden>Stop</button>
        <section id="conversation"></section>
        <script>
          const login = document.querySelector('[data-testid="login-button"]');
          const popup = document.querySelector('[data-testid="popup-button"]');
          const expire = document.querySelector('[data-testid="expire-button"]');
          const composer = document.querySelector('#prompt-textarea');
          const attachmentInput = document.querySelector('[data-testid="attachment-input"]');
          const attachmentChips = document.querySelector('#attachment-chips');
          const attachmentError = document.querySelector('[data-testid="attachment-upload-error"]');
          const send = document.querySelector('[data-testid="send-button"]');
          const stop = document.querySelector('[data-testid="stop-button"]');
          const conversation = document.querySelector('#conversation');
          const requestedTask = new URLSearchParams(location.search).get('farol-e2e-task');
          const pathParts = location.pathname.split('/').filter(Boolean);
          const existingConversationId = pathParts.length === 3 && pathParts[0] === 'chatgpt' && pathParts[1] === 'c'
            ? pathParts[2]
            : null;
          const conversationId = existingConversationId || requestedTask || 'farol-next-e2e';
          const conversationPath = '/chatgpt/c/' + conversationId;
          const conversationStorageKey = 'farol-next-e2e-conversation:' + conversationPath;
          const messageSequenceStorageKey = 'farol-next-e2e-message-sequence:' + conversationPath;
          window.__farolTaskProgress = [];
          window.__farolSubmitCount = 0;
          window.__farolAttachmentProof = [];
          let attachmentLoading = false;
          let responseGeneration = 0;
          const updateSend = () => {
            send.disabled = composer.textContent.trim().length === 0 || attachmentLoading;
          };
          const render = () => {
            const authenticated = localStorage.getItem('farol-next-e2e-authenticated') === '1';
            login.hidden = authenticated;
            expire.hidden = !authenticated;
            composer.hidden = !authenticated;
            send.hidden = !authenticated;
          };
          const restoreConversation = () => {
            if (location.pathname !== conversationPath) return;
            try {
              const saved = JSON.parse(localStorage.getItem(conversationStorageKey) || 'null');
              if (!saved || typeof saved.user !== 'string' || typeof saved.assistant !== 'string') return;
              const user = document.createElement('article');
              user.className = 'message';
              user.dataset.messageAuthorRole = 'user';
              user.dataset.messageId = saved.userMessageId || 'user-' + conversationId + '-restored';
              user.textContent = saved.user;
              const assistant = document.createElement('article');
              assistant.className = 'message';
              assistant.dataset.messageAuthorRole = 'assistant';
              assistant.dataset.messageId = saved.assistantMessageId || 'assistant-' + conversationId + '-restored';
              assistant.dataset.parentMessageId = user.dataset.messageId;
              assistant.textContent = saved.assistant;
              conversation.append(user, assistant);
            } catch {
              localStorage.removeItem(conversationStorageKey);
            }
          };
          popup.addEventListener('click', () => window.open('/chatgpt-popup', 'chatgpt-auth'));
          composer.addEventListener('input', () => {
            updateSend();
          });
          attachmentInput.addEventListener('change', async () => {
            attachmentLoading = true;
            attachmentError.hidden = true;
            attachmentChips.replaceChildren();
            window.__farolAttachmentProof = [];
            updateSend();
            const files = [...(attachmentInput.files || [])];
            for (const file of files) {
              const bytes = new Uint8Array(await file.arrayBuffer());
              let binary = '';
              for (const byte of bytes) binary += String.fromCharCode(byte);
              window.__farolAttachmentProof.push({
                name: file.name,
                type: file.type,
                size: file.size,
                base64: btoa(binary)
              });
              const chip = document.createElement('span');
              chip.className = 'attachment-chip';
              chip.dataset.testid = 'attachment-chip';
              chip.textContent = file.name;
              attachmentChips.append(chip);
            }
            attachmentLoading = false;
            updateSend();
          });
          login.addEventListener('click', () => {
            localStorage.setItem('farol-next-e2e-authenticated', '1');
            render();
          });
          expire.addEventListener('click', () => {
            localStorage.removeItem('farol-next-e2e-authenticated');
            render();
          });
          stop.addEventListener('click', () => {
            responseGeneration += 1;
            stop.hidden = true;
            send.hidden = false;
            send.disabled = true;
          });
          send.addEventListener('click', () => {
            if (send.disabled) return;
            const activeGeneration = ++responseGeneration;
            window.__farolSubmitCount += 1;
            const storedMessageSequence = Number(localStorage.getItem(messageSequenceStorageKey) || '0');
            const messageSequence = Number.isSafeInteger(storedMessageSequence) && storedMessageSequence >= 0
              ? storedMessageSequence + 1
              : 1;
            localStorage.setItem(messageSequenceStorageKey, String(messageSequence));
            if (location.pathname === '/chatgpt') {
              history.replaceState(null, '', conversationPath);
            }
            send.disabled = true;
            send.hidden = true;
            const userText = composer.textContent;
            const user = document.createElement('article');
            user.className = 'message';
            user.dataset.messageAuthorRole = 'user';
            user.dataset.messageId = 'user-' + conversationId + '-' + messageSequence;
            user.textContent = userText;
            const assistant = document.createElement('article');
            assistant.className = 'message';
            assistant.dataset.messageAuthorRole = 'assistant';
            assistant.dataset.messageId = 'assistant-' + conversationId + '-' + messageSequence;
            assistant.dataset.parentMessageId = user.dataset.messageId;
            conversation.append(user, assistant);
            composer.textContent = '';
            attachmentInput.value = '';
            attachmentChips.replaceChildren();
            stop.hidden = false;
            const contextSummary = userText.startsWith('Preserve the current task context for a safe continuation.');
            const checkpoint = {
              goal: 'Complete the context continuity acceptance safely.',
              activeConstraints: [
                'Keep every change local until owner review.',
                'Never publish, push, sign, or release.'
              ],
              latestCorrections: ['Use report-v2.md; report-v1.md is obsolete.'],
              keyDecisions: ['Observe unknown external effects before another mutation.'],
              completedWork: [{
                description: 'Retained the completed local checkpoint receipt.',
                evidenceRefs: ['receipt-context-epoch-1']
              }],
              unfinishedWork: ['Confirm the host handoff and continue safely.'],
              unresolvedQuestions: ['Did the unknown external operation complete?'],
              unknownOutcomes: [{
                operationRef: 'context-unknown-1',
                description: 'The external effect remains unknown and must not be repeated.'
              }],
              artifactRefs: [{
                reference: 'artifact:report-v2.md',
                availability: 'available'
              }],
              attachmentRefs: [{
                reference: 'attachment:context-evidence-1',
                availability: 'unavailable'
              }],
              nextSafeStep: 'Confirm the exact host context, then observe the unknown operation.'
            };
            const chunks = contextSummary
              ? [JSON.stringify(checkpoint)]
              : [
                  'The selected file reports a bounded workspace verification. ',
                  'It contains one concrete status line. ',
                  'Action: keep the read-only boundary in place.'
                ];
            localStorage.setItem(conversationStorageKey, JSON.stringify({
              user: userText,
              assistant: chunks.join(''),
              userMessageId: user.dataset.messageId,
              assistantMessageId: assistant.dataset.messageId
            }));
            const chunkDelay = userText.includes('cancellation canary') ? 1000 : 150;
            chunks.forEach((chunk, index) => {
              setTimeout(() => {
                if (activeGeneration !== responseGeneration) return;
                assistant.textContent += chunk;
                window.__farolTaskProgress.push(assistant.textContent.length);
                if (index === chunks.length - 1) {
                  stop.hidden = true;
                  send.hidden = false;
                  send.disabled = false;
                }
              }, chunkDelay * (index + 1));
            });
          });
          restoreConversation();
          render();
        </script>
      </body></html>`);
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  return {
    server: fixture,
    url: `http://127.0.0.1:${address.port}/chatgpt`,
  };
}

async function stopChatGptFixture(fixture) {
  if (!fixture) return;
  await new Promise((resolve, reject) => {
    fixture.server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function launch(
  extraArgs = [],
  windowMode = "hidden",
  mode = "demo",
  options = {},
) {
  const isolatedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-e2e-home-"),
  );
  const userData = path.join(isolatedHome, "Farol Next Preview user-data");
  let seededChatGptOperationId = null;
  if (options.seedChatGptDispatchIntent === true) {
    seededChatGptOperationId = randomUUID();
    const stateRoot = path.join(userData, "farol-next-state");
    const journalRoot = path.join(stateRoot, "chatgpt-task-journal");
    await fs.mkdir(journalRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(stateRoot, 0o700);
    await fs.chmod(journalRoot, 0o700);
    const timestamp = new Date().toISOString();
    await fs.writeFile(
      path.join(journalRoot, "chatgpt-task-journal.json"),
      `${JSON.stringify(
        {
          schema: 1,
          operationId: seededChatGptOperationId,
          kind: "readonly",
          phase: "dispatch_intent",
          createdAt: timestamp,
          updatedAt: timestamp,
          result: null,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  const workspacePath = path.join(isolatedHome, "approved-workspace");
  await fs.mkdir(workspacePath, { mode: 0o700 });
  const workspaceRoot = await fs.realpath(workspacePath);
  const workspaceFile = path.join(workspaceRoot, "README.md");
  const supportExport = path.join(isolatedHome, "Farol-Next-Support.json");
  const codexFixture = path.join(isolatedHome, "codex-fixture");
  const attachmentImage = path.join(isolatedHome, "evidence.png");
  const attachmentDocument = path.join(isolatedHome, "notes.md");
  await fs.writeFile(
    workspaceFile,
    "Farol Next workspace verification fixture\n",
    { mode: 0o600 },
  );
  const gitLookup = spawnSync("/usr/bin/xcrun", ["--find", "git"], {
    encoding: "utf8",
  });
  assert.equal(gitLookup.status, 0, gitLookup.stderr);
  const gitFixture = gitLookup.stdout.trim();
  const gitInit = spawnSync(
    gitFixture,
    ["init", "--quiet", "--initial-branch=main", workspaceRoot],
    { encoding: "utf8" },
  );
  assert.equal(gitInit.status, 0, gitInit.stderr);
  const gitAdd = spawnSync(
    gitFixture,
    ["-C", workspaceRoot, "add", "README.md"],
    { encoding: "utf8" },
  );
  assert.equal(gitAdd.status, 0, gitAdd.stderr);
  const gitCommit = spawnSync(
    gitFixture,
    [
      "-C",
      workspaceRoot,
      "-c",
      "user.name=Farol E2E",
      "-c",
      "user.email=farol-e2e@invalid.example",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { encoding: "utf8" },
  );
  assert.equal(gitCommit.status, 0, gitCommit.stderr);
  await fs.writeFile(
    attachmentImage,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
    { mode: 0o600 },
  );
  await fs.writeFile(
    attachmentDocument,
    "Farol attachment document fixture\n",
    {
      mode: 0o600,
    },
  );
  await fs.writeFile(
    codexFixture,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 9.8.7-e2e\\n");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--stdio") {
  const readline = require("node:readline");
  const lines = readline.createInterface({ input: process.stdin });
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  const disabledFeatures = new Set(args.flatMap((value, index) =>
    value === "--disable" ? [args[index + 1]] : []
  ));
  const enabledFeatures = new Set(args.flatMap((value, index) =>
    value === "--enable" ? [args[index + 1]] : []
  ));
  const boundedToolProfile =
    args.includes('web_search="disabled"') &&
    disabledFeatures.has("shell_tool") &&
    disabledFeatures.has("apps") &&
    disabledFeatures.has("browser_use") &&
    disabledFeatures.has("computer_use") &&
    disabledFeatures.has("plugins") &&
    enabledFeatures.has("skip_host_skill_discovery");
  let agentChildPrompt = null;
  let agentAuthority = null;
  let agentWorkspace = null;
  let agentProduct = false;
  let agentWorkspaceComplete = false;
  let agentChildComplete = false;
  let agentComplete = false;
  let agentChildInterrupted = false;
  let agentParentInterrupted = false;
  const agentParentThreadId = "thread-e2e-agent-parent";
  const agentParentTurnId = "turn-e2e-agent-parent";
  const agentChildThreadId = "thread-e2e-agent-child";
  const agentChildTurnId = "turn-e2e-agent-child";
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "codex-e2e/9.8.7" } });
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "config/read") {
      send({ id: message.id, result: { config: {
        web_search: args.includes('web_search="disabled"') ? "disabled" : null,
        features: Object.fromEntries([
          ...[...disabledFeatures].map((name) => [name, false]),
          ...[...enabledFeatures].map((name) => [name, true])
        ]),
        mcp_servers: {}
      } } });
      return;
    }
    if (message.method === "model/list") {
      send({ id: message.id, result: { data: [{ id: "gpt-6-astra" }], nextCursor: null } });
      return;
    }
    if (message.method === "thread/start") {
      const dynamicTools = Array.isArray(message.params?.dynamicTools)
        ? message.params.dynamicTools.map((tool) => tool?.name)
        : [];
      const agentThread = dynamicTools.includes("farol_agent_authority");
      const productAgentThread = dynamicTools.includes("farol_agent_computer");
      const validDynamicTools = agentThread
        ? dynamicTools.length === 2 &&
          dynamicTools[0] === "farol_agent_authority" &&
          dynamicTools[1] === (productAgentThread
            ? "farol_agent_computer"
            : "farol_agent_workspace_probe")
        : dynamicTools.length === 1 && dynamicTools[0] === "farol_next_ping";
      const valid = message.params?.model === "gpt-6-astra" &&
        message.params?.allowProviderModelFallback === false &&
        message.params?.sandbox === "read-only" &&
        message.params?.approvalPolicy === "never" &&
        Array.isArray(message.params?.runtimeWorkspaceRoots) &&
        message.params.runtimeWorkspaceRoots.length === 0 &&
        boundedToolProfile &&
        enabledFeatures.has("multi_agent") === agentThread &&
        validDynamicTools;
      if (!valid) {
        send({ id: message.id, error: { code: -32000, message: "unsafe thread" } });
        return;
      }
      agentProduct = productAgentThread;
      const threadId = agentThread
        ? agentParentThreadId
        : "thread-e2e-parent";
      send({ id: message.id, result: { model: "gpt-6-astra", thread: { id: threadId, parentThreadId: null } } });
      return;
    }
    if (message.method === "turn/start") {
      const text = message.params?.input?.[0]?.text ?? "";
      if (message.params?.threadId === agentParentThreadId) {
        const begin = "FAROL_CHILD_PROMPT_BEGIN\\n";
        const end = "\\nFAROL_CHILD_PROMPT_END";
        const start = text.indexOf(begin);
        const finish = text.indexOf(end, start + begin.length);
        const assignmentId = /assignmentId ([^,]+),/u.exec(text)?.[1];
        const authorityId = /authorityId ([^,]+),/u.exec(text)?.[1];
        const participantId = /participantId ([^,]+),/u.exec(text)?.[1];
        const role = /role (agent|critic),/u.exec(text)?.[1];
        const proof = [...text.matchAll(/proof ([a-z0-9-]+)/gu)].at(-1)?.[1];
        const workspaceProof = /workspace proof ([a-f0-9]{64})/u.exec(text)?.[1];
        const computerProof = /computer proof ([a-f0-9]{64})/u.exec(text)?.[1];
        const workspaceId = /"workspaceId":"([^"]+)"/u.exec(text)?.[1];
        const validChildEvidence = agentProduct
          ? computerProof && workspaceId
          : workspaceProof;
        if (start < 0 || finish < 0 || !assignmentId || !authorityId || !participantId || !role || !proof || !validChildEvidence) {
          send({ id: message.id, error: { code: -32001, message: "invalid agent prompt" } });
          return;
        }
        agentChildPrompt = text.slice(start + begin.length, finish);
        agentAuthority = { assignmentId, authorityId, participantId, role, proof };
        agentWorkspace = agentProduct
          ? {
              assignmentId,
              authorityId,
              participantId,
              proof: computerProof,
              workspaceId,
              operation: { kind: "workspace.read", relativePath: "README.md" }
            }
          : { assignmentId, authorityId, participantId, proof: workspaceProof };
        send({ id: message.id, result: { turn: { id: agentParentTurnId, status: "inProgress", items: [] } } });
        setTimeout(() => {
          send({ method: "item/completed", params: { threadId: agentParentThreadId, turnId: agentParentTurnId, item: {
            id: "item-e2e-agent-spawn",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: agentParentThreadId,
            receiverThreadIds: [agentChildThreadId],
            agentsStates: {},
            model: "gpt-6-astra",
            prompt: agentChildPrompt
          } } });
        }, 10);
        setTimeout(() => {
          send({ id: "tool-e2e-agent-workspace", method: "item/tool/call", params: {
            threadId: agentChildThreadId,
            turnId: agentChildTurnId,
            callId: "call-e2e-agent-workspace",
            tool: agentProduct ? "farol_agent_computer" : "farol_agent_workspace_probe",
            arguments: agentWorkspace
          } });
        }, 50);
        setTimeout(() => {
          send({ method: "item/completed", params: { threadId: agentParentThreadId, turnId: agentParentTurnId, item: {
            id: "item-e2e-agent-wait",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: agentParentThreadId,
            receiverThreadIds: [agentChildThreadId],
            agentsStates: {},
            model: null,
            prompt: null
          } } });
          send({ id: "tool-e2e-agent-authority", method: "item/tool/call", params: {
            threadId: agentParentThreadId,
            turnId: agentParentTurnId,
            callId: "call-e2e-agent-authority",
            tool: "farol_agent_authority",
            arguments: agentAuthority
          } });
        }, 400);
        return;
      }
      const nonce = /nonce ([a-z0-9-]+)/u.exec(text)?.[1];
      send({ id: message.id, result: { turn: { id: "turn-e2e-parent", status: "inProgress", items: [] } } });
      send({ id: "tool-e2e", method: "item/tool/call", params: { threadId: "thread-e2e-parent", turnId: "turn-e2e-parent", callId: "call-e2e-ping", tool: "farol_next_ping", arguments: { nonce } } });
      return;
    }
    if (message.method === "turn/interrupt") {
      if (
        message.params?.threadId === agentChildThreadId &&
        message.params?.turnId === agentChildTurnId
      ) {
        agentChildInterrupted = true;
        send({ id: message.id, result: {} });
        return;
      }
      if (
        message.params?.threadId === agentParentThreadId &&
        message.params?.turnId === agentParentTurnId
      ) {
        agentParentInterrupted = true;
        send({ id: message.id, result: {} });
        return;
      }
      send({ id: message.id, error: { code: -32003, message: "turn missing" } });
      return;
    }
    if (message.method === "thread/read") {
      if (message.params?.threadId === agentChildThreadId) {
        const items = agentWorkspaceComplete ? [{
          id: "item-e2e-agent-workspace",
          type: "dynamicToolCall",
          tool: agentProduct ? "farol_agent_computer" : "farol_agent_workspace_probe",
          status: "completed",
          success: true,
          arguments: agentWorkspace
        }] : [];
        send({ id: message.id, result: { thread: {
          id: agentChildThreadId,
          parentThreadId: agentParentThreadId,
          agentRole: "default",
          source: { subAgent: { thread_spawn: { parent_thread_id: agentParentThreadId, depth: 1, agent_role: "default" } } },
          status: { type: agentChildComplete || agentChildInterrupted ? "idle" : "active" },
          turns: [{ id: agentChildTurnId, status: agentChildInterrupted ? "interrupted" : agentChildComplete ? "completed" : "inProgress", items }]
        } } });
        return;
      }
      if (message.params?.threadId === agentParentThreadId) {
        const items = agentChildPrompt === null ? [] : [{
          id: "item-e2e-agent-spawn",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: agentParentThreadId,
          receiverThreadIds: [agentChildThreadId],
          agentsStates: {},
          model: "gpt-6-astra",
          prompt: agentChildPrompt
        }];
        if (agentComplete) {
          items.push({
            id: "item-e2e-agent-wait",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: agentParentThreadId,
            receiverThreadIds: [agentChildThreadId],
            agentsStates: {},
            model: null,
            prompt: null
          });
          items.push({
            id: "item-e2e-agent-authority",
            type: "dynamicToolCall",
            tool: "farol_agent_authority",
            status: "completed",
            success: true,
            arguments: agentAuthority
          });
        }
        send({ id: message.id, result: { thread: {
          id: agentParentThreadId,
          parentThreadId: null,
          agentRole: null,
          source: { appServer: true },
          status: { type: agentComplete || agentParentInterrupted ? "idle" : "active" },
          turns: [{ id: agentParentTurnId, status: agentParentInterrupted ? "interrupted" : agentComplete ? "completed" : "inProgress", items }]
        } } });
        return;
      }
      send({ id: message.id, error: { code: -32002, message: "thread missing" } });
      return;
    }
    if (message.id === "tool-e2e" && message.result?.success === true) {
      send({ method: "turn/completed", params: { threadId: "thread-e2e-parent", turn: { id: "turn-e2e-parent", status: "completed", items: [] } } });
      return;
    }
    if (message.id === "tool-e2e-agent-workspace" && message.result?.success === true) {
      agentWorkspaceComplete = true;
      agentChildComplete = true;
      return;
    }
    if (message.id === "tool-e2e-agent-authority" && message.result?.success === true && agentWorkspaceComplete) {
      agentComplete = true;
      send({ method: "turn/completed", params: { threadId: agentParentThreadId, turn: { id: agentParentTurnId, status: "completed", items: [] } } });
    }
  });
} else if (args.slice(0, 4).join(" ") !== "app-server generate-json-schema --experimental --out" || !args[4]) {
  process.exit(64);
} else {
  const root = args[4];
  fs.mkdirSync(path.join(root, "v2"), { recursive: true });
  const files = {
    "v2/ThreadStartParams.json": { properties: { dynamicTools: { items: { $ref: "#/definitions/DynamicToolSpec" } } } },
    "DynamicToolCallParams.json": { required: ["threadId", "turnId", "callId", "tool", "arguments"] },
    "ServerRequest.json": { oneOf: [{ properties: { method: { enum: ["item/tool/call"] } } }] },
    "ClientRequest.json": { oneOf: [{ properties: { method: { enum: ["thread/compact/start"] } } }] },
    "v2/ThreadListParams.json": { properties: { parentThreadId: {}, ancestorThreadId: {} } },
    "v2/ThreadReadResponse.json": { definitions: { Thread: { properties: { parentThreadId: {} } }, ThreadItem: { oneOf: [{ properties: { type: { enum: ["collabAgentToolCall"] } } }] } } }
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), JSON.stringify(value) + "\\n", { mode: 0o600 });
  }
}
`,
    { mode: 0o700 },
  );
  const chatGptFixture = await startChatGptFixture();
  const launchArgs = [
    ...launchPrefix,
    ...(mode === "demo" ? ["--demo"] : []),
    `--user-data-dir=${userData}`,
    `--preview-window-mode=${windowMode}`,
    ...extraArgs,
  ];
  const launchEnvironment = {
    ...(options.environment ?? {}),
    FAROL_NEXT_E2E: "1",
    FAROL_NEXT_E2E_WORKSPACE_FILE: workspaceFile,
    FAROL_NEXT_E2E_WORKSPACE_ROOT: workspaceRoot,
    FAROL_NEXT_E2E_SUPPORT_EXPORT: supportExport,
    FAROL_NEXT_E2E_ATTACHMENTS: JSON.stringify([
      attachmentImage,
      attachmentDocument,
    ]),
    FAROL_NEXT_E2E_CHATGPT_URL: chatGptFixture.url,
    FAROL_NEXT_E2E_CODEX_EXECUTABLE: codexFixture,
    HOME: isolatedHome,
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: os.tmpdir(),
  };
  const application = await electron.launch({
    executablePath: executable,
    args: launchArgs,
    env: launchEnvironment,
    timeout: 15_000,
  });
  const window = await application.firstWindow({ timeout: 15_000 });
  await window.locator("#sidebar").waitFor({ state: "visible" });
  await window
    .locator('#runtime-pill[data-state="ready"]')
    .waitFor({ state: "visible" });
  if (mode === "demo") {
    await window
      .locator("#task-tabs .task-tab")
      .first()
      .waitFor({ state: "visible" });
  }
  const expectedTaskViewCount = mode === "demo" ? 2 : 0;
  const presentation = await waitForWindowPresentation(
    application,
    windowMode,
    expectedTaskViewCount,
  );
  return {
    application,
    window,
    isolatedHome,
    userData,
    workspaceFile,
    workspaceRoot,
    supportExport,
    codexFixture,
    attachmentImage,
    attachmentDocument,
    expectedTaskViewCount,
    windowMode,
    presentation,
    launchArgs,
    launchEnvironment,
    chatGptFixture,
    seededChatGptOperationId,
  };
}

async function waitForChatGptJournalPhase(userData, phase) {
  const journalPath = path.join(
    userData,
    "farol-next-state",
    "chatgpt-task-journal",
    "chatgpt-task-journal.json",
  );
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const serialized = await fs.readFile(journalPath, "utf8");
      last = { serialized, record: JSON.parse(serialized) };
      if (last.record.phase === phase) return { journalPath, ...last };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `E2E_CHATGPT_JOURNAL_TIMEOUT:${phase}:${JSON.stringify(last?.record ?? null)}`,
  );
}

async function proveSecondLaunchDuringStartup() {
  const isolatedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-e2e-home-"),
  );
  const userData = path.join(isolatedHome, "Farol Next Preview user-data");
  const windowMode = "hidden";
  const launchArgs = [
    ...launchPrefix,
    "--demo",
    `--user-data-dir=${userData}`,
    `--preview-window-mode=${windowMode}`,
    "--preview-startup-delay-ms=1500",
  ];
  const launchEnvironment = {
    FAROL_NEXT_E2E: "1",
    HOME: isolatedHome,
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: os.tmpdir(),
  };
  const application = await electron.launch({
    executablePath: executable,
    args: launchArgs,
    env: launchEnvironment,
    timeout: 15_000,
  });
  const instance = {
    application,
    window: null,
    isolatedHome,
    userData,
    windowMode,
    launchArgs,
    launchEnvironment,
  };
  try {
    const startedAt = Date.now();
    const repeated = await runBoundedProcess(executable, launchArgs, {
      cwd: root,
      env: launchEnvironment,
      timeoutMs: 15_000,
    });
    assert.equal(
      repeated.status,
      0,
      `E2E_STARTUP_SECOND_LAUNCH_FAILED:${repeated.stdout}${repeated.stderr}`,
    );
    assert.equal(
      parseOwnerLaunchResult(`${repeated.stdout}${repeated.stderr}`),
      "reopened",
    );
    assert.ok(Date.now() - startedAt >= 500, "E2E_STARTUP_REOPEN_DID_NOT_WAIT");
    instance.window = await application.firstWindow({ timeout: 15_000 });
    await instance.window
      .locator("#task-tabs .task-tab")
      .first()
      .waitFor({ state: "visible" });
    await waitForWindowPresentation(application, windowMode);
    const bootstrap = await instance.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.equal(bootstrap.runtimeState, "ready");
    assert.equal(bootstrap.runtimeIdentity, "farol-next-preview-runtime");
    assert.equal((await taskSurfaces(application)).length, 2);
  } finally {
    await close(instance);
  }
}

async function proveSecondLaunchRejectsFailedStartup() {
  const isolatedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-e2e-home-"),
  );
  const userData = path.join(isolatedHome, "Farol Next Preview user-data");
  const launchArgs = [
    ...launchPrefix,
    "--demo",
    `--user-data-dir=${userData}`,
    "--preview-window-mode=hidden",
    "--preview-startup-delay-ms=500",
    "--preview-runtime-start-failure",
  ];
  const launchEnvironment = {
    FAROL_NEXT_E2E: "1",
    HOME: isolatedHome,
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: os.tmpdir(),
  };
  const application = await electron.launch({
    executablePath: executable,
    args: launchArgs,
    env: launchEnvironment,
    timeout: 15_000,
  });
  const instance = { application, isolatedHome, userData };
  try {
    const repeated = await runBoundedProcess(executable, launchArgs, {
      cwd: root,
      env: launchEnvironment,
      timeoutMs: 15_000,
    });
    assert.equal(
      parseOwnerLaunchResult(`${repeated.stdout}${repeated.stderr}`),
      "reopen-failed",
    );
    const window = await application.firstWindow({ timeout: 15_000 });
    const bootstrap = await window.evaluate(() => window.farolNext.bootstrap());
    assert.equal(bootstrap.runtimeState, "failed");
    assert.equal((await taskSurfaces(application)).length, 0);
  } finally {
    await close(instance);
  }
}

function repeatLaunch(instance) {
  const repeated = spawnSync(executable, instance.launchArgs, {
    cwd: root,
    env: instance.launchEnvironment,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    repeated.status,
    0,
    `E2E_SECOND_LAUNCH_FAILED:${repeated.stdout}${repeated.stderr}`,
  );
}

async function rejectMismatchedBuildLaunch(instance) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-mismatched-build-"),
  );
  try {
    let mismatchedExecutable;
    let mismatchedArguments;
    let manifestPath;
    if (development) {
      const copiedBuild = path.join(temporary, "app");
      await fs.cp(path.join(root, "dist/app"), copiedBuild, {
        recursive: true,
        verbatimSymlinks: true,
      });
      mismatchedExecutable = executable;
      mismatchedArguments = [
        path.join(copiedBuild, "main.cjs"),
        ...instance.launchArgs.slice(launchPrefix.length),
      ];
      manifestPath = path.join(copiedBuild, "build-manifest.json");
    } else {
      const copiedApp = path.join(temporary, "Farol Next Preview.app");
      const copied = spawnSync("/bin/cp", ["-cR", appPath, copiedApp], {
        encoding: "utf8",
      });
      assert.equal(copied.status, 0, `${copied.stdout}${copied.stderr}`);
      mismatchedExecutable = path.join(
        copiedApp,
        "Contents/MacOS/Farol Next Preview",
      );
      mismatchedArguments = instance.launchArgs;
      manifestPath = path.join(
        copiedApp,
        "Contents/Resources/app/build-manifest.json",
      );
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.sourceCommit = "f".repeat(40);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const mismatched = spawnSync(mismatchedExecutable, mismatchedArguments, {
      cwd: root,
      env: instance.launchEnvironment,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(mismatched.status, 0);
    assert.match(
      `${mismatched.stdout}${mismatched.stderr}`,
      /running build could not be verified as this exact candidate/u,
    );
    assert.equal(
      parseOwnerLaunchResult(`${mismatched.stdout}${mismatched.stderr}`),
      "identity-mismatch",
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function waitForWindowCount(application, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const actual = await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    if (actual === count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`E2E_WINDOW_COUNT_TIMEOUT:${count}`);
}

async function runtimeProcessId(application) {
  return application.evaluate(({ app }) => {
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
}

async function startLegacyAppFixture() {
  const isolatedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-legacy-lifecycle-fixture-"),
  );
  const child = spawn(
    vendorElectron,
    [
      path.join(root, "tests/e2e/legacy-app.fixture.cjs"),
      `--user-data-dir=${path.join(isolatedHome, "user-data")}`,
    ],
    {
      env: {
        HOME: isolatedHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: os.tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(`LEGACY_FIXTURE_EXITED:${code}:${signal}`);
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("LEGACY_FIXTURE_START_TIMEOUT")),
        10_000,
      ),
    ),
  ]);
  assert.deepEqual(
    { kind: ready.kind, pid: ready.pid },
    { kind: "legacy-fixture.ready", pid: child.pid },
  );
  assert.ok(Number.isSafeInteger(ready.port) && ready.port > 0);
  return { child, isolatedHome, port: ready.port };
}

async function probeLegacyAppFixture(fixture) {
  const response = await fetch(
    `http://127.0.0.1:${fixture.port}/synthetic/read`,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "legacy-fixture-read-ok\n");
}

async function closeLegacyAppFixture(fixture) {
  fixture.child.send("shutdown");
  const [code, signal] = await once(fixture.child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 0);
  const real = path.resolve(fixture.isolatedHome);
  assert.ok(
    real.startsWith(
      `${path.resolve(os.tmpdir())}${path.sep}farol-legacy-lifecycle-fixture-`,
    ),
  );
  await fs.rm(real, { recursive: true, force: true });
}

async function close(instance, options = {}) {
  const removeHome = options.removeHome ?? true;
  if (instance.windowMode) {
    const presentation = await inspectWindowPresentation(instance.application);
    assert.equal(presentation.mode, instance.windowMode);
    assert.equal(
      presentation.visible,
      instance.windowMode === "secondary-visible",
    );
  }
  const mainPid = instance.application.process().pid;
  const utilityPids = await instance.application.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter(
        (metric) =>
          metric.type === "Utility" && metric.name === "Farol Next Runtime",
      )
      .map((metric) => metric.pid),
  );
  await instance.application.close();
  const exactPids = [mainPid, ...utilityPids].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0,
  );
  for (const pid of exactPids) {
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") {
          alive = false;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, `E2E_OWNED_PROCESS_SURVIVED_QUIT:${pid}`);
  }
  quitProofs += 1;
  if (removeHome) {
    await stopChatGptFixture(instance.chatGptFixture);
    instance.chatGptFixture = null;
    const real = path.resolve(instance.isolatedHome);
    assert.ok(
      real.startsWith(
        `${path.resolve(os.tmpdir())}${path.sep}farol-next-e2e-home-`,
      ),
    );
    await fs.rm(real, { recursive: true, force: true });
  }
}

async function restart(instance) {
  await close(instance, { removeHome: false });
  instance.application = await electron.launch({
    executablePath: executable,
    args: instance.launchArgs,
    env: instance.launchEnvironment,
    timeout: 15_000,
  });
  instance.window = await instance.application.firstWindow({ timeout: 15_000 });
  await instance.window.locator("#sidebar").waitFor({ state: "visible" });
  const bootstrap = await instance.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  const expectedTaskViewCount = bootstrap.demoMode
    ? instance.expectedTaskViewCount
    : bootstrap.tasks.length > 0
      ? 1
      : 0;
  instance.presentation = await waitForWindowPresentation(
    instance.application,
    instance.windowMode,
    expectedTaskViewCount,
  );
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
      "--demo",
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
          const targetWindow = BrowserWindow.getAllWindows().find(
            (candidate) => {
              const url = candidate.webContents.getURL();
              return (
                candidate.getTitle() === "Farol Next Preview" &&
                url.startsWith("file:") &&
                url.endsWith("/shell.html")
              );
            },
          );
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
      await instance.application.evaluate(({ BrowserWindow }) => {
        const shell = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol Next Preview" &&
            url.startsWith("file:") &&
            url.endsWith("/shell.html")
          );
        });
        return shell?.isVisible() ?? null;
      }),
      false,
    );
    const remainingTaskViews = await instance.application.evaluate(
      ({ BrowserWindow }) => {
        const shell = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol Next Preview" &&
            url.startsWith("file:") &&
            url.endsWith("/shell.html")
          );
        });
        return (shell?.contentView.children ?? []).filter(
          (view) => "webContents" in view,
        ).length;
      },
    );
    assert.equal(remainingTaskViews, 0);
  } finally {
    await close(instance);
  }
}

async function taskSurfaces(application) {
  return application.evaluate(async ({ BrowserWindow, webContents }) => {
    const shell = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return (
        candidate.getTitle() === "Farol Next Preview" &&
        url.startsWith("file:") &&
        url.endsWith("/shell.html")
      );
    });
    const viewByContentsId = new Map(
      (shell?.contentView.children ?? [])
        .filter((view) => "webContents" in view)
        .map((view) => [view.webContents.id, view]),
    );
    return Promise.all(
      webContents
        .getAllWebContents()
        .filter((contents) => contents.getURL().includes("/task/"))
        .map(async (contents) => {
          const hostView = viewByContentsId.get(contents.id);
          return {
            url: contents.getURL(),
            hostVisible: hostView?.getVisible() ?? null,
            hostBounds: hostView?.getBounds() ?? null,
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
          };
        }),
    );
  });
}

async function liveChatGptSurfaces(application, expectedOrigin) {
  return application.evaluate(async ({ BrowserWindow }, origin) => {
    const host = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return (
        candidate.getTitle() === "Farol Next Preview" &&
        url.startsWith("file:") &&
        url.endsWith("/shell.html")
      );
    });
    const views = (host?.contentView.children ?? []).filter(
      (view) => "webContents" in view,
    );
    const surfaces = [];
    for (const view of views) {
      const url = view.webContents.getURL();
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      if (parsed.origin !== origin) continue;
      const parts = parsed.pathname.split("/").filter(Boolean);
      const taskId =
        parsed.searchParams.get("farol-e2e-task") ??
        (parts.length === 3 && parts[0] === "chatgpt" && parts[1] === "c"
          ? parts[2]
          : null);
      if (!taskId) continue;
      const state = await view.webContents.executeJavaScript(`(() => ({
          composerVisible: document.querySelector('#prompt-textarea')?.hidden === false,
          sendDisabled: document.querySelector('[data-testid="send-button"]')?.disabled ?? null,
          stopVisible: document.querySelector('[data-testid="stop-button"]')?.hidden === false,
          userText: [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.textContent ?? "",
          assistantText: [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)?.textContent ?? "",
          submitCount: Number(window.__farolSubmitCount ?? 0)
        }))()`);
      surfaces.push({
        taskId,
        contentsId: view.webContents.id,
        url,
        hostVisible: view.getVisible(),
        hostBounds: view.getBounds(),
        focused: view.webContents.isFocused(),
        state,
      });
    }
    return surfaces;
  }, expectedOrigin);
}

async function waitForLiveChatGptSurface(instance, taskId, predicate, message) {
  const origin = new URL(instance.chatGptFixture.url).origin;
  let last = [];
  for (let attempt = 0; attempt < 150; attempt += 1) {
    last = await liveChatGptSurfaces(instance.application, origin);
    const surface = last.find((candidate) => candidate.taskId === taskId);
    if (surface && predicate(surface)) return surface;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `E2E_LIVE_CHATGPT_SURFACE_TIMEOUT:${message}:${JSON.stringify(last)}`,
  );
}

async function submitLiveChatGptTask(instance, taskId, prompt) {
  return instance.application.evaluate(
    async ({ BrowserWindow }, input) => {
      const host = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return (
          candidate.getTitle() === "Farol Next Preview" &&
          url.startsWith("file:") &&
          url.endsWith("/shell.html")
        );
      });
      const view = (host?.contentView.children ?? [])
        .filter((candidate) => "webContents" in candidate)
        .find((candidate) => {
          const candidateUrl = new URL(candidate.webContents.getURL());
          const parts = candidateUrl.pathname.split("/").filter(Boolean);
          return (
            candidateUrl.searchParams.get("farol-e2e-task") === input.taskId ||
            (parts.length === 3 &&
              parts[0] === "chatgpt" &&
              parts[1] === "c" &&
              parts[2] === input.taskId)
          );
        });
      if (!view) throw new Error("LIVE_CHATGPT_TASK_SURFACE_MISSING");
      return view.webContents.executeJavaScript(`(() => {
        const composer = document.querySelector('#prompt-textarea');
        const send = document.querySelector('[data-testid="send-button"]');
        if (!(composer instanceof HTMLElement) || !(send instanceof HTMLButtonElement)) {
          throw new Error('LIVE_CHATGPT_TASK_CONTROLS_MISSING');
        }
        composer.focus();
        composer.replaceChildren(document.createTextNode(${JSON.stringify(input.prompt)}));
        composer.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          data: ${JSON.stringify(input.prompt)},
          inputType: 'insertText'
        }));
        if (send.disabled) throw new Error('LIVE_CHATGPT_TASK_SEND_DISABLED');
        send.click();
        return Number(window.__farolSubmitCount ?? 0);
      })()`);
    },
    { taskId, prompt },
  );
}

async function waitForTaskSurface(application, taskId, predicate, message) {
  let last = [];
  for (let attempt = 0; attempt < 150; attempt += 1) {
    last = await taskSurfaces(application);
    const surface = last.find((candidate) => candidate.state.taskId === taskId);
    if (surface && predicate(surface)) return surface;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`E2E_SURFACE_TIMEOUT:${message}:${JSON.stringify(last)}`);
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
      const control = await fetch("/control/task-harbor/finish-demo", {
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

async function sendKeyFromTask(application, taskId, keyCode, modifiers) {
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
        keyCode: input.keyCode,
        modifiers: input.modifiers,
      });
      contents.sendInputEvent({
        type: "keyUp",
        keyCode: input.keyCode,
        modifiers: input.modifiers,
      });
    },
    { taskId, keyCode, modifiers },
  );
}

async function sendShortcutFromTask(application, taskId, reverse = false) {
  await sendKeyFromTask(
    application,
    taskId,
    "Tab",
    reverse ? ["control", "shift"] : ["control"],
  );
}

async function activateForNativeFocusProof(application) {
  if (process.platform === "darwin") {
    await application.evaluate(async ({ app, BrowserWindow }) => {
      const targetWindow = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return (
          candidate.getTitle() === "Farol Next Preview" &&
          url.startsWith("file:") &&
          url.endsWith("/shell.html")
        );
      });
      if (!targetWindow) throw new Error("E2E_WINDOW_MISSING");
      app.setActivationPolicy("regular");
      await app.dock.show();
      targetWindow.setFocusable(true);
      targetWindow.show();
      targetWindow.moveTop();
    });
    const applicationPid = application.process().pid;
    assert.ok(applicationPid, "E2E_APPLICATION_PID_MISSING");
    const activation = spawnSync(
      "/usr/bin/osascript",
      [
        "-e",
        `tell application "System Events" to set frontmost of first process whose unix id is ${applicationPid} to true`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      activation.status,
      0,
      `${activation.stdout}${activation.stderr}`,
    );
  }
  let last = null;
  let consecutiveFocusedSamples = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await application.evaluate(async ({ app, BrowserWindow }) => {
      const targetWindow = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return (
          candidate.getTitle() === "Farol Next Preview" &&
          url.startsWith("file:") &&
          url.endsWith("/shell.html")
        );
      });
      if (!targetWindow) throw new Error("E2E_WINDOW_MISSING");
      if (process.platform === "darwin") {
        app.setActivationPolicy("regular");
        await app.dock.show();
      }
      targetWindow.setFocusable(true);
      targetWindow.show();
      targetWindow.moveTop();
      app.focus({ steal: true });
      targetWindow.focus();
      return {
        focused: targetWindow.isFocused(),
        visible: targetWindow.isVisible(),
        minimized: targetWindow.isMinimized(),
        fullScreen: targetWindow.isFullScreen(),
        shellFocused: targetWindow.webContents.isFocused(),
      };
    });
    consecutiveFocusedSamples = last.focused
      ? consecutiveFocusedSamples + 1
      : 0;
    if (consecutiveFocusedSamples >= 3) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`E2E_NATIVE_WINDOW_FOCUS_TIMEOUT:${JSON.stringify(last)}`);
}

async function deactivateForInactiveAppearanceProof(application) {
  await application.evaluate(({ BrowserWindow }) => {
    const targetWindow = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return (
        candidate.getTitle() === "Farol Next Preview" &&
        url.startsWith("file:") &&
        url.endsWith("/shell.html")
      );
    });
    if (!targetWindow) throw new Error("E2E_WINDOW_MISSING");
    targetWindow.blur();
  });
  let last = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await nativeWindowChrome(application);
    if (!last.focused) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`E2E_NATIVE_WINDOW_BLUR_TIMEOUT:${JSON.stringify(last)}`);
}

async function setWindowSize(application, width, height) {
  await application.evaluate(
    ({ BrowserWindow }, size) => {
      const shell = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return (
          candidate.getTitle() === "Farol Next Preview" &&
          url.startsWith("file:") &&
          url.endsWith("/shell.html")
        );
      });
      shell?.setSize(size.width, size.height);
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

async function watchRailGeometry(window) {
  return window.evaluate(() => {
    const bounds = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`GEOMETRY_ELEMENT_MISSING:${selector}`);
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return {
      sidebarMode: document.documentElement.dataset.sidebar,
      windowActive: document.documentElement.dataset.windowActive,
      fullScreen: document.documentElement.dataset.fullScreen,
      sidebar: bounds("#sidebar"),
      toggle: bounds("#sidebar-toggle"),
      windowIdentity: bounds(".window-identity"),
      taskBar: bounds(".task-bar"),
      dossier: bounds(".dossier"),
      surface: bounds(".surface"),
      navTargetHeights: [...document.querySelectorAll(".nav-item")].map(
        (element) => Math.round(element.getBoundingClientRect().height),
      ),
    };
  });
}

async function applicationMenuState(application) {
  return application.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const sidebar = menu?.getMenuItemById("view.toggle-sidebar");
    const switcher = menu?.getMenuItemById("view.quick-switcher");
    const settings = menu?.getMenuItemById("app.settings");
    return {
      sidebar: sidebar
        ? { label: sidebar.label, accelerator: sidebar.accelerator }
        : null,
      switcher: switcher
        ? { label: switcher.label, accelerator: switcher.accelerator }
        : null,
      settings: settings
        ? { label: settings.label, accelerator: settings.accelerator }
        : null,
    };
  });
}

async function invokeApplicationMenu(application, id) {
  await application.evaluate(({ BrowserWindow, Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    const targetWindow = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return (
        candidate.getTitle() === "Farol Next Preview" &&
        url.startsWith("file:") &&
        url.endsWith("/shell.html")
      );
    });
    if (!item?.click || !targetWindow)
      throw new Error(`E2E_MENU_MISSING:${itemId}`);
    item.click(item, targetWindow, { triggeredByAccelerator: false });
  }, id);
}

async function nativeWindowChrome(application) {
  return application.evaluate(({ BrowserWindow }) => {
    const targetWindow = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return (
        candidate.getTitle() === "Farol Next Preview" &&
        url.startsWith("file:") &&
        url.endsWith("/shell.html")
      );
    });
    if (!targetWindow) throw new Error("E2E_WINDOW_MISSING");
    return {
      focused: targetWindow.isFocused(),
      fullScreen: targetWindow.isFullScreen(),
      trafficLightPosition:
        process.platform === "darwin"
          ? targetWindow.getWindowButtonPosition()
          : null,
    };
  });
}

async function waitForShellFocus(application, reason) {
  let focused = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    focused = await application.evaluate(({ BrowserWindow }) => {
      const shell = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return (
          candidate.getTitle() === "Farol Next Preview" &&
          url.startsWith("file:") &&
          url.endsWith("/shell.html")
        );
      });
      return shell?.webContents.isFocused() ?? false;
    });
    if (focused) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`E2E_SHELL_FOCUS_TIMEOUT:${reason}:${focused}`);
}

async function setFullScreen(application, value) {
  await application.evaluate(async ({ BrowserWindow }, nextValue) => {
    const targetWindow = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return (
        candidate.getTitle() === "Farol Next Preview" &&
        url.startsWith("file:") &&
        url.endsWith("/shell.html")
      );
    });
    if (!targetWindow) throw new Error("E2E_WINDOW_MISSING");
    if (targetWindow.isFullScreen() === nextValue) return;
    const event = nextValue ? "enter-full-screen" : "leave-full-screen";
    const transitioned = new Promise((resolve) =>
      targetWindow.once(event, resolve),
    );
    targetWindow.setFullScreen(nextValue);
    await transitioned;
  }, value);
}

const setupScreens = [
  ["chatgpt", "setup-1-chatgpt-wide.png"],
  ["computer", "setup-2-computer-wide.png"],
  ["connect", "setup-3-connect-wide.png"],
  ["hosts", "setup-4-hosts-wide.png"],
  ["verify", "setup-5-verify-wide.png"],
];

async function completeSetup(
  instance,
  capture = false,
  configureComputer = false,
  configureChatGpt = false,
  configureHost = false,
  agentEvidenceScope = null,
) {
  const dialog = instance.window.locator("#setup-dialog");
  await dialog.waitFor({ state: "visible" });
  assert.equal(
    (await taskSurfaces(instance.application)).some(
      (surface) => surface.hostVisible,
    ),
    false,
  );
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
      /Needs action|Configured · verify|Verified|Unavailable|Outcome unknown|Reachable · verify/u,
    );
    if (stepId === "chatgpt" && configureChatGpt) {
      assert.equal(
        await instance.window.locator("#setup-live-primary").innerText(),
        "Open sign-in…",
      );
      const chatGptWindow = instance.application.waitForEvent("window", {
        timeout: 15_000,
      });
      await instance.window.locator("#setup-live-primary").click();
      const chatGptPage = await chatGptWindow;
      await chatGptPage.waitForURL(instance.chatGptFixture.url);
      await waitForWindowCount(instance.application, 2);
      const security = await instance.application.evaluate(
        ({ session, webContents }, expectedUrl) => {
          const contents = webContents
            .getAllWebContents()
            .find((candidate) => candidate.getURL() === expectedUrl);
          if (!contents) throw new Error("CHATGPT_WEB_CONTENTS_MISSING");
          const preferences = contents.getLastWebPreferences();
          return {
            sandbox: preferences.sandbox,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
            isolatedSession:
              contents.session ===
              session.fromPartition("persist:farol-next-chatgpt"),
          };
        },
        instance.chatGptFixture.url,
      );
      assert.deepEqual(security, {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        isolatedSession: true,
      });
      const popupWindow = instance.application.waitForEvent("window", {
        timeout: 15_000,
      });
      await chatGptPage.locator('[data-testid="popup-button"]').click();
      const popupPage = await popupWindow;
      await popupPage.waitForURL(/\/chatgpt-popup$/u);
      await waitForWindowCount(instance.application, 3);
      await popupPage.locator('[data-testid="popup-ready"]').waitFor();
      const popupSecurity = await instance.application.evaluate(
        ({ session, webContents }, popupUrl) => {
          const contents = webContents
            .getAllWebContents()
            .find((candidate) => candidate.getURL() === popupUrl);
          if (!contents) throw new Error("CHATGPT_POPUP_WEB_CONTENTS_MISSING");
          const preferences = contents.getLastWebPreferences();
          return {
            sandbox: preferences.sandbox,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
            isolatedSession:
              contents.session ===
              session.fromPartition("persist:farol-next-chatgpt"),
          };
        },
        `${new URL(instance.chatGptFixture.url).origin}/chatgpt-popup`,
      );
      assert.deepEqual(popupSecurity, security);
      await popupPage.close();
      await waitForWindowCount(instance.application, 2);
      assert.equal(
        await chatGptPage.evaluate(
          () => window.open("file:///tmp/forbidden", "_blank") === null,
        ),
        true,
      );
      await waitForWindowCount(instance.application, 2);
      await chatGptPage.locator('[data-testid="login-button"]').click();
      await chatGptPage.locator("#prompt-textarea").waitFor({
        state: "visible",
      });
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-live-primary")?.textContent ===
          "Check connection",
      );
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
          "Verified",
      );
      await chatGptPage.locator('[data-testid="expire-button"]').click();
      await chatGptPage.locator('[data-testid="login-button"]').waitFor({
        state: "visible",
      });
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
            "Needs action" &&
          document.querySelector("#setup-live-primary")?.textContent ===
            "Open sign-in…",
      );
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-live-primary")?.textContent ===
          "Check connection",
      );
      await chatGptPage.locator('[data-testid="login-button"]').click();
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
          "Verified",
      );
      await chatGptPage.close();
      await waitForWindowCount(instance.application, 1);
      await waitForShellVisibility(
        instance.application,
        instance.windowMode === "secondary-visible",
        instance.expectedTaskViewCount,
      );
    }
    if (stepId === "computer" && configureComputer) {
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-live-primary")?.textContent ===
          "Verify access",
      );
      let bootstrap = await instance.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.equal(
        bootstrap.configuration.settings.computer.workspaces.length,
        1,
      );
      assert.equal(
        bootstrap.configuration.settings.setup.computer.verified,
        null,
      );
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
          "Verified",
      );
      bootstrap = await instance.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.equal(
        bootstrap.configuration.settings.setup.computer.verified.workspaceId,
        bootstrap.configuration.settings.computer.workspaces[0].workspaceId,
      );
    }
    if (stepId === "hosts" && configureHost) {
      assert.equal(
        await instance.window.locator("#setup-live-primary").innerText(),
        "Choose executable…",
      );
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
            "Needs action" &&
          document.querySelector("#setup-live-primary")?.textContent ===
            "Run live check",
      );
      let bootstrap = await instance.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.equal(
        bootstrap.configuration.settings.nativeHosts.codex.executablePath,
        instance.codexFixture,
      );
      assert.equal(
        bootstrap.configuration.settings.nativeHosts.codex.version,
        "9.8.7-e2e",
      );
      assert.equal(bootstrap.configuration.settings.setup.hosts.verified, null);
      assert.equal(
        bootstrap.configuration.settings.nativeHosts.codex.liveVerification,
        null,
      );
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
            "Verified" &&
          document.querySelector("#setup-live-primary")?.textContent ===
            "Run live check again",
      );
      bootstrap = await instance.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.equal(
        bootstrap.configuration.settings.setup.hosts.verified.configRevision,
        bootstrap.configuration.settings.nativeHosts.generation,
      );
      assert.equal(
        bootstrap.configuration.settings.nativeHosts.codex.liveVerification
          .model,
        "gpt-6-astra",
      );
    }
    if (stepId === "verify" && configureComputer && configureHost) {
      assert.match(agentEvidenceScope ?? "", /^[a-z][a-z0-9-]{0,39}$/u);
      assert.equal(
        await instance.window.locator("#setup-live-primary").innerText(),
        "Verify Agent",
      );
      await instance.window.locator("#setup-live-primary").click();
      await instance.window.waitForFunction(
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
            "Verified" &&
          document.querySelector("#setup-live-primary")?.textContent ===
            "Agent verified",
      );
      const bootstrap = await instance.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      const settings = bootstrap.configuration.settings;
      const proof = settings.nativeHosts.codex.agentVerification;
      assert.equal(proof.model, "gpt-6-astra");
      assert.equal(
        proof.workspaceId,
        settings.setup.computer.verified.workspaceId,
      );
      assert.equal(proof.computerGeneration, settings.computer.generation);
      assert.equal(proof.authorityRole, "critic");
      assert.equal(proof.hostRole, "default");
      assert.equal(proof.boundedRunning, true);
      assert.equal(proof.modelTurnsSubmitted, 1);
      assert.equal(proof.fallbackAllowed, false);
      assert.equal(proof.descendantCount, 0);
      assert.equal(proof.resultRefProtocol, "codex-app-server");
      assert.equal(proof.resultRetention, "durable");
      assert.equal(proof.parentDelivery, "acknowledged");
      assert.equal(proof.workspaceEnforcement, "verified");
      assert.equal(
        settings.setup.verify.verified.profile,
        "codex.native-agent.lineage/1",
      );
      assert.match(
        await instance.window.locator("#setup-live-summary").innerText(),
        /verified native workspace enforcement/iu,
      );
      const serializedProof = JSON.stringify(proof);
      assert.doesNotMatch(
        serializedProof,
        /thread-e2e|assignment-|owner-desktop|native-agent-session/iu,
      );
      cases.push(
        `${agentEvidenceScope}-native-codex-agent-lineage-verified`,
        `${agentEvidenceScope}-native-agent-workspace-enforcement-verified`,
        `${agentEvidenceScope}-native-agent-bounded-rejoin`,
        `${agentEvidenceScope}-native-agent-result-delivery-acknowledged`,
        `${agentEvidenceScope}-native-agent-evidence-content-free`,
      );
    }
    if (capture) {
      await instance.window.screenshot({
        path: path.join(evidenceRoot, screenshot),
      });
    }
    if (stepId === "verify" && configureComputer) {
      assert.equal(
        await instance.window
          .locator('[data-setup-progress="computer"].complete')
          .count(),
        1,
      );
      assert.equal(
        await instance.window
          .locator('[data-setup-progress="chatgpt"].complete')
          .count(),
        configureChatGpt ? 1 : 0,
      );
      assert.equal(
        await instance.window
          .locator('[data-setup-progress="hosts"].complete')
          .count(),
        configureHost ? 1 : 0,
      );
      assert.equal(
        await instance.window
          .locator('[data-setup-progress="verify"].complete')
          .count(),
        configureHost ? 1 : 0,
      );
    }
    await instance.window.locator("#setup-next").click();
    if (stepId !== "verify") {
      await instance.window.waitForFunction(
        (previous) =>
          document
            .querySelector("#setup-dialog")
            ?.getAttribute("data-step-id") !== previous,
        stepId,
      );
    }
  }
  await dialog.waitFor({ state: "hidden" });
}

async function runLiveTaskPersistenceFaultProof() {
  assert.equal(
    development,
    true,
    "E2E_PERSISTENCE_FAULT_REQUIRES_DEVELOPMENT_BUILD",
  );
  const instance = await launch([], "hidden", "ordinary", {
    environment: { FAROL_NEXT_E2E_LIVE_TASK_SAVE_SUCCESSES: "1" },
  });
  try {
    await completeSetup(instance, false, false, true, false);
    const created = await instance.window.evaluate(() =>
      window.farolNext.task({ kind: "task.create-chatgpt" }),
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(created.selectedTaskId);
    const taskId = created.selectedTaskId;
    await instance.application.evaluate(
      async ({ BrowserWindow }, selectedTaskId) => {
        const host = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol Next Preview" &&
            url.startsWith("file:") &&
            url.endsWith("/shell.html")
          );
        });
        const view = (host?.contentView.children ?? [])
          .filter((candidate) => "webContents" in candidate)
          .find((candidate) =>
            candidate.webContents
              .getURL()
              .includes(`farol-e2e-task=${selectedTaskId}`),
          );
        if (!view) throw new Error("LIVE_TASK_PERSISTENCE_SURFACE_MISSING");
        await view.webContents.executeJavaScript(
          `history.replaceState(null, "", ${JSON.stringify(`/chatgpt/c/${selectedTaskId}`)})`,
          true,
        );
      },
      taskId,
    );
    await waitForLiveChatGptSurface(
      instance,
      taskId,
      (surface) => new URL(surface.url).pathname === `/chatgpt/c/${taskId}`,
      "idle conversation URL changes before persistence fails",
    );
    await instance.window.waitForFunction(
      async (selectedTaskId) =>
        (await window.farolNext.bootstrap()).tasks.find(
          (task) => task.taskId === selectedTaskId,
        )?.lifecycle === "outcome_unknown",
      taskId,
      { timeout: 5_000 },
    );
    await instance.window.waitForFunction(
      () =>
        document.querySelector("#dossier-state b")?.textContent ===
        "OUTCOME UNKNOWN",
    );
    assert.equal(
      await submitLiveChatGptTask(
        instance,
        taskId,
        "Farol live persistence failure canary",
      ),
      1,
    );
    await waitForLiveChatGptSurface(
      instance,
      taskId,
      (surface) =>
        surface.state.submitCount === 1 &&
        surface.state.stopVisible === false &&
        surface.state.assistantText.length > 0,
      "provider completion after live task persistence failure",
    );
    assert.equal(
      await instance.window.locator("#dossier-state b").innerText(),
      "OUTCOME UNKNOWN",
    );
    assert.match(
      await instance.window
        .locator('.nav-item[data-section="activity"] .nav-signal small')
        .innerText(),
      /1 task needs attention/u,
    );

    const rename = await instance.window.evaluate(
      ({ selectedTaskId }) =>
        window.farolNext.task({
          kind: "task.rename",
          taskId: selectedTaskId,
          label: "Must not look durable",
        }),
      { selectedTaskId: taskId },
    );
    assert.equal(rename.ok, false);
    assert.equal(rename.error, "TASK_STATE_UNAVAILABLE");
    assert.equal(rename.state.tasks[0]?.label, "ChatGPT task 1");
    assert.equal(rename.state.tasks[0]?.lifecycle, "outcome_unknown");

    const persistedPath = path.join(
      instance.userData,
      "farol-next-state",
      "live-tasks",
      "live-tasks.json",
    );
    const persisted = JSON.parse(await fs.readFile(persistedPath, "utf8"));
    assert.equal(persisted.revision, 1);
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].label, "ChatGPT task 1");
    assert.equal(persisted.tasks[0].lifecycle, "idle");
    assert.equal(persisted.tasks[0].conversationUrl, null);

    await fs.writeFile(
      path.join(evidenceRoot, "report.json"),
      `${JSON.stringify(
        {
          schema: 1,
          status: "PASS",
          evidence: "SIMULATED_FAULT",
          sourceCommit: expectedSource.commit,
          sourceTreeDigest: expectedSource.treeDigest,
          buildId: artifact.buildId,
          builtAt: artifact.builtAt,
          fault: "live task store rejects every commit after initial admission",
          cases: [
            "conversation-url-save-failure-is-visible",
            "lifecycle-save-failure-is-outcome-unknown",
            "later-mutation-fails-closed",
            "last-durable-snapshot-is-not-advanced",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await close(instance);
  }
}

const lifecycleSoakBudget = Object.freeze({
  seed: 260_917,
  warmupCycles: 5,
  measuredCycles: 50,
  batchSize: 5,
  createTotalP95Ms: 2_500,
  createLocalEstimateP95Ms: 1_000,
  closeP95Ms: 750,
  overlayP95Ms: 500,
  finalWorkingSetDeltaKiB: 128 * 1_024,
  workingSetSlopeKiBPerBatch: 8 * 1_024,
  finalFdDelta: 32,
  finalProcessDelta: 2,
  finalActiveResourceDelta: 10,
});

function percentile(values, quantile) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)
  ];
}

function linearSlope(values) {
  if (values.length < 2) return 0;
  const meanX = (values.length - 1) / 2;
  const meanY =
    values.reduce((total, value) => total + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
}

function fileDescriptorCount(pid) {
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-n", "-P", "-a", "-p", String(pid), "-Ff"],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `E2E_SOAK_LSOF_FAILED:${pid}:${result.stdout}${result.stderr}`,
  );
  return result.stdout
    .split("\n")
    .filter((line) => /^f(?:cwd|err|mem|rtd|txt|[0-9]+)$/u.test(line)).length;
}

async function lifecycleMetrics(instance) {
  const providerOrigin = new URL(instance.chatGptFixture.url).origin;
  const measured = await instance.application.evaluate(
    ({ app, BrowserWindow, session, webContents }, expectedOrigin) => {
      const windows = BrowserWindow.getAllWindows();
      const primary = windows[0] ?? null;
      const contents = webContents
        .getAllWebContents()
        .filter((candidate) => !candidate.isDestroyed());
      const processMetrics = app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        name: metric.name,
        workingSetSizeKiB: metric.memory?.workingSetSize ?? 0,
        privateBytesKiB: metric.memory?.privateBytes ?? 0,
      }));
      const activeResources =
        typeof process.getActiveResourcesInfo === "function"
          ? process.getActiveResourcesInfo()
          : [];
      const activeResourceTypes = {};
      for (const resource of activeResources) {
        activeResourceTypes[resource] =
          (activeResourceTypes[resource] ?? 0) + 1;
      }
      return {
        windowCount: windows.length,
        visibleWindowCount: windows.filter((candidate) => candidate.isVisible())
          .length,
        taskViewCount:
          primary?.contentView.children.filter(
            (candidate) =>
              candidate &&
              typeof candidate === "object" &&
              "webContents" in candidate,
          ).length ?? 0,
        webContentsCount: contents.length,
        providerSurfaceCount: contents.filter((candidate) => {
          try {
            return new URL(candidate.getURL()).origin === expectedOrigin;
          } catch {
            return false;
          }
        }).length,
        downloadListenerCount: session
          .fromPartition("persist:farol-next-chatgpt")
          .listenerCount("will-download"),
        processMetrics,
        processCount: processMetrics.length,
        runtimePids: processMetrics
          .filter(
            (metric) =>
              metric.type === "Utility" && metric.name === "Farol Next Runtime",
          )
          .map((metric) => metric.pid),
        workingSetSizeKiB: processMetrics.reduce(
          (total, metric) => total + metric.workingSetSizeKiB,
          0,
        ),
        privateBytesKiB: processMetrics.reduce(
          (total, metric) => total + metric.privateBytesKiB,
          0,
        ),
        activeResourceCount: activeResources.length,
        activeResourceTypes,
      };
    },
    providerOrigin,
  );
  const measuredPids = [
    instance.application.process().pid,
    ...measured.runtimePids,
  ];
  assert.equal(measured.runtimePids.length, 1, "E2E_SOAK_RUNTIME_COUNT");
  return {
    ...measured,
    measuredFdPids: measuredPids.length,
    fileDescriptorCount: measuredPids.reduce(
      (total, pid) => total + fileDescriptorCount(pid),
      0,
    ),
  };
}

async function providerNavigationDuration(instance, taskId) {
  const expectedOrigin = new URL(instance.chatGptFixture.url).origin;
  return instance.application.evaluate(
    async ({ webContents }, input) => {
      const target = webContents.getAllWebContents().find((candidate) => {
        try {
          const url = new URL(candidate.getURL());
          return (
            url.origin === input.origin &&
            url.searchParams.get("farol-e2e-task") === input.taskId
          );
        } catch {
          return false;
        }
      });
      if (!target)
        throw new Error(`E2E_SOAK_PROVIDER_SURFACE_MISSING:${input.taskId}`);
      return target.executeJavaScript(
        "performance.getEntriesByType('navigation')[0]?.duration ?? 0",
        true,
      );
    },
    { origin: expectedOrigin, taskId },
  );
}

async function waitForLifecycleQuiescence(instance) {
  const origin = new URL(instance.chatGptFixture.url).origin;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await instance.application.evaluate(
      ({ BrowserWindow, webContents }, expectedOrigin) => {
        const shell = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol Next Preview" &&
            url.startsWith("file:") &&
            url.endsWith("/shell.html")
          );
        });
        return {
          taskViewCount:
            shell?.contentView.children.filter(
              (candidate) =>
                candidate &&
                typeof candidate === "object" &&
                "webContents" in candidate,
            ).length ?? 0,
          providerSurfaceCount: webContents
            .getAllWebContents()
            .filter((candidate) => {
              try {
                return new URL(candidate.getURL()).origin === expectedOrigin;
              } catch {
                return false;
              }
            }).length,
        };
      },
      origin,
    );
    if (state.taskViewCount === 0 && state.providerSurfaceCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("E2E_SOAK_QUIESCENCE_TIMEOUT");
}

async function lifecycleBatch(instance, count, timings, overlayKind = null) {
  const taskIds = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    const created = await instance.window.evaluate(() =>
      window.farolNext.task({ kind: "task.create-chatgpt" }),
    );
    const createTotalMs = performance.now() - startedAt;
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(created.selectedTaskId);
    taskIds.push(created.selectedTaskId);
    const providerMs = await providerNavigationDuration(
      instance,
      created.selectedTaskId,
    );
    if (timings) {
      timings.createTotalMs.push(createTotalMs);
      timings.providerNavigationMs.push(providerMs);
      timings.createLocalEstimateMs.push(
        Math.max(0, createTotalMs - providerMs),
      );
    }
  }
  const admitted = await instance.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(admitted.tasks.length, count);
  assert.equal(
    await instance.application.evaluate(({ BrowserWindow }) => {
      const shell = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return (
          candidate.getTitle() === "Farol Next Preview" &&
          url.startsWith("file:") &&
          url.endsWith("/shell.html")
        );
      });
      return shell?.contentView.children.filter(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          "webContents" in candidate,
      ).length;
    }),
    count,
  );
  assert.equal(
    await instance.application.evaluate(({ session }) =>
      session
        .fromPartition("persist:farol-next-chatgpt")
        .listenerCount("will-download"),
    ),
    1,
    "E2E_SOAK_LIVE_DOWNLOAD_GUARD",
  );
  if (overlayKind) {
    const startedAt = performance.now();
    if (overlayKind === "quick-switcher") {
      await instance.window.locator("#command-button").click();
      await instance.window
        .locator("#command-dialog")
        .waitFor({ state: "visible" });
      await instance.window.keyboard.press("Escape");
      await instance.window
        .locator("#command-dialog")
        .waitFor({ state: "hidden" });
    } else {
      assert.equal(overlayKind, "task-menu");
      await instance.window.locator("#task-menu-button").click();
      await instance.window.locator("#task-menu").waitFor({ state: "visible" });
      await instance.window.keyboard.press("Escape");
      await instance.window.locator("#task-menu").waitFor({ state: "hidden" });
    }
    if (timings) timings.overlayMs.push(performance.now() - startedAt);
  }
  for (const taskId of taskIds.reverse()) {
    const startedAt = performance.now();
    const closed = await instance.window.evaluate(
      (selectedTaskId) =>
        window.farolNext.task({ kind: "task.close", taskId: selectedTaskId }),
      taskId,
    );
    if (timings) timings.closeMs.push(performance.now() - startedAt);
    assert.equal(closed.ok, true, JSON.stringify(closed));
  }
  await waitForLifecycleQuiescence(instance);
  const quiescent = await instance.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.deepEqual(quiescent.tasks, []);
}

function assertQuiescentMetrics(metrics, baseline) {
  assert.equal(metrics.windowCount, 1);
  assert.equal(metrics.visibleWindowCount, 0);
  assert.equal(metrics.taskViewCount, 0);
  assert.equal(metrics.providerSurfaceCount, 0);
  assert.equal(metrics.webContentsCount, baseline.webContentsCount);
  assert.ok(metrics.downloadListenerCount <= 1);
  assert.equal(metrics.runtimePids.length, 1);
  assert.ok(
    metrics.processCount <=
      baseline.processCount + lifecycleSoakBudget.finalProcessDelta,
  );
  assert.ok(
    metrics.fileDescriptorCount <=
      baseline.fileDescriptorCount + lifecycleSoakBudget.finalFdDelta,
  );
  assert.ok(
    metrics.workingSetSizeKiB <=
      baseline.workingSetSizeKiB + lifecycleSoakBudget.finalWorkingSetDeltaKiB,
  );
  assert.ok(
    metrics.activeResourceCount <=
      baseline.activeResourceCount +
        lifecycleSoakBudget.finalActiveResourceDelta,
  );
}

async function runLifecycleSoak() {
  assert.equal(development, true, "E2E_SOAK_REQUIRES_DEVELOPMENT_BUILD");
  const instance = await launch([], "hidden", "ordinary");
  const samples = [];
  const timings = {
    createTotalMs: [],
    providerNavigationMs: [],
    createLocalEstimateMs: [],
    closeMs: [],
    overlayMs: [],
  };
  const recoveryBatches = new Set([3, 8]);
  const recoveryEvents = [];
  try {
    await completeSetup(instance, false, false, true, false);
    await lifecycleBatch(instance, lifecycleSoakBudget.warmupCycles, null);
    const baseline = await lifecycleMetrics(instance);
    assert.equal(baseline.downloadListenerCount, 1);
    assert.equal(baseline.taskViewCount, 0);
    assert.equal(baseline.providerSurfaceCount, 0);

    const batches =
      lifecycleSoakBudget.measuredCycles / lifecycleSoakBudget.batchSize;
    for (let batch = 0; batch < batches; batch += 1) {
      const batchNumber = batch + 1;
      const overlayKind =
        (lifecycleSoakBudget.seed + batchNumber) % 2 === 0
          ? "quick-switcher"
          : "task-menu";
      await lifecycleBatch(
        instance,
        lifecycleSoakBudget.batchSize,
        timings,
        overlayKind,
      );
      if (recoveryBatches.has(batchNumber)) {
        await restart(instance);
        recoveryEvents.push({
          batch: batchNumber,
          kind: "application-restart",
        });
      }
      const metrics = await lifecycleMetrics(instance);
      assertQuiescentMetrics(metrics, baseline);
      samples.push({
        batch: batch + 1,
        cycles: (batch + 1) * lifecycleSoakBudget.batchSize,
        ...metrics,
      });
    }

    const latency = {
      createTotalMs: {
        p50: percentile(timings.createTotalMs, 0.5),
        p95: percentile(timings.createTotalMs, 0.95),
      },
      providerNavigationMs: {
        p50: percentile(timings.providerNavigationMs, 0.5),
        p95: percentile(timings.providerNavigationMs, 0.95),
      },
      createLocalEstimateMs: {
        p50: percentile(timings.createLocalEstimateMs, 0.5),
        p95: percentile(timings.createLocalEstimateMs, 0.95),
      },
      closeMs: {
        p50: percentile(timings.closeMs, 0.5),
        p95: percentile(timings.closeMs, 0.95),
      },
      overlayMs: {
        p50: percentile(timings.overlayMs, 0.5),
        p95: percentile(timings.overlayMs, 0.95),
      },
    };
    assert.ok(
      latency.createTotalMs.p95 <= lifecycleSoakBudget.createTotalP95Ms,
    );
    assert.ok(
      latency.createLocalEstimateMs.p95 <=
        lifecycleSoakBudget.createLocalEstimateP95Ms,
    );
    assert.ok(latency.closeMs.p95 <= lifecycleSoakBudget.closeP95Ms);
    assert.ok(latency.overlayMs.p95 <= lifecycleSoakBudget.overlayP95Ms);
    const workingSetSlopeKiBPerBatch = linearSlope(
      samples.map((sample) => sample.workingSetSizeKiB),
    );
    assert.ok(
      workingSetSlopeKiBPerBatch <=
        lifecycleSoakBudget.workingSetSlopeKiBPerBatch,
    );

    await restart(instance);
    const restarted = await instance.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.deepEqual(restarted.tasks, []);
    const afterRestart = await lifecycleMetrics(instance);
    assertQuiescentMetrics(afterRestart, baseline);

    const report = {
      schema: 1,
      status: "PASS",
      evidence: "FIXTURE_APP",
      sourceCommit: expectedSource.commit,
      sourceTreeDigest: expectedSource.treeDigest,
      buildId: artifact.buildId,
      builtAt: artifact.builtAt,
      workload: {
        seed: lifecycleSoakBudget.seed,
        warmupCycles: lifecycleSoakBudget.warmupCycles,
        measuredCycles: lifecycleSoakBudget.measuredCycles,
        batchSize: lifecycleSoakBudget.batchSize,
        maxConcurrentTasks: lifecycleSoakBudget.batchSize,
        recoveryBatches: [...recoveryBatches],
        overlaySequence: Array.from({ length: batches }, (_, batch) =>
          (lifecycleSoakBudget.seed + batch + 1) % 2 === 0
            ? "quick-switcher"
            : "task-menu",
        ),
        provider: "deterministic local ChatGPT fixture",
      },
      budgets: lifecycleSoakBudget,
      latency,
      resources: {
        baseline,
        samples,
        afterRestart,
        recoveryEvents,
        workingSetSlopeKiBPerBatch,
        finalDelta: {
          processCount: afterRestart.processCount - baseline.processCount,
          workingSetSizeKiB:
            afterRestart.workingSetSizeKiB - baseline.workingSetSizeKiB,
          fileDescriptorCount:
            afterRestart.fileDescriptorCount - baseline.fileDescriptorCount,
          activeResourceCount:
            afterRestart.activeResourceCount - baseline.activeResourceCount,
        },
      },
      cases: [
        "fifty-task-create-close-cycles",
        "five-concurrent-task-surfaces",
        "alternating-task-menu-and-quick-switcher-overlays",
        "two-same-state-application-recoveries",
        "zero-provider-surfaces-after-each-batch",
        "single-shared-download-guard",
        "single-runtime-process",
        "bounded-process-fd-resource-and-memory-trend",
        "zero-task-restart",
      ],
      host: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
    };
    await fs.writeFile(
      path.join(evidenceRoot, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  } finally {
    await close(instance);
  }
}

async function finishSpecialLane(lane) {
  const written = JSON.parse(
    await fs.readFile(path.join(evidenceRoot, "report.json"), "utf8"),
  );
  const missing = missingCases(lane, written.cases);
  if (missing.length > 0) {
    evidenceAttempt.recordFailure(
      "contract",
      `E2E_REQUIRED_CASE_MISSING:${missing.join(",")}`,
    );
  }
  await evidenceAttempt.finish(
    written.status === "PASS" && missing.length === 0 ? "PASS" : "FAIL",
    { cases: written.cases },
  );
  if (missing.length > 0) process.exit(1);
}

if (lifecycleSoak) {
  await runLifecycleSoak();
  await finishSpecialLane("lifecycle-soak");
  process.exit(0);
}

if (persistenceFault) {
  await runLiveTaskPersistenceFaultProof();
  await finishSpecialLane("persistence-fault");
  process.exit(0);
}

await proveSecondLaunchDuringStartup();
cases.push("second-launch-waits-for-complete-primary-startup");
await proveSecondLaunchRejectsFailedStartup();
cases.push("second-launch-rejects-failed-primary-startup");

const ordinary = await launch([], "hidden", "ordinary");
try {
  const ordinaryBootstrap = await ordinary.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(ordinaryBootstrap.demoMode, false);
  assert.deepEqual(ordinaryBootstrap.tasks, []);
  assert.equal((await taskSurfaces(ordinary.application)).length, 0);
  const ordinarySnapshot = await ordinary.window.evaluate(() =>
    window.farolNext.snapshot(),
  );
  assert.deepEqual(ordinarySnapshot.tasks, []);
  assert.equal(
    await ordinary.window.evaluate(
      () => document.documentElement.dataset.hasTasks,
    ),
    "false",
  );
  assert.equal(
    await ordinary.window.locator("#browser-state-title").innerText(),
    "No tasks yet",
  );
  const emptyGeometry = await ordinary.window.evaluate(() =>
    [".task-bar", ".dossier", ".surface"].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`EMPTY_GEOMETRY_MISSING:${selector}`);
      const bounds = element.getBoundingClientRect();
      return {
        selector,
        y: Math.round(bounds.y),
        height: Math.round(bounds.height),
      };
    }),
  );
  assert.deepEqual(emptyGeometry, [
    { selector: ".task-bar", y: 52, height: 54 },
    { selector: ".dossier", y: 0, height: 0 },
    { selector: ".surface", y: 106, height: 654 },
  ]);
  cases.push("ordinary-launch-has-no-synthetic-tasks");
} finally {
  await close(ordinary);
}

if (await writeWindowTopologyBlockedReport(ordinary.presentation)) {
  process.exit(1);
}

const ordinaryLiveTasks = await launch([], "secondary-visible", "ordinary");
try {
  await completeSetup(ordinaryLiveTasks, false, true, true, true, "ordinary");
  const newTask = ordinaryLiveTasks.window.locator("#new-task");
  await newTask.waitFor({ state: "visible" });
  assert.equal(await newTask.isEnabled(), true);
  assert.equal(await newTask.locator("small").innerText(), "0 / 5");

  const taskSurfaceIds = new Map();
  for (let index = 1; index <= 5; index += 1) {
    await newTask.click();
    await ordinaryLiveTasks.window.waitForFunction(
      (count) =>
        document.querySelectorAll("#task-tabs .task-tab").length === count,
      index,
    );
    const state = await ordinaryLiveTasks.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.equal(state.taskRevision, index);
    assert.equal(state.tasks.length, index);
    const task = state.tasks[index - 1];
    assert.match(task.taskId, /^[0-9a-f-]{36}$/u);
    assert.match(task.sessionId, /^[0-9a-f-]{36}$/u);
    assert.match(task.turnId, /^[0-9a-f-]{36}$/u);
    assert.equal(task.label, `ChatGPT task ${index}`);
    assert.equal(task.provider, "chatgpt");
    assert.equal(task.requestedModel, "Account default");
    assert.equal(task.observedModel, null);
    assert.equal(task.requestedMode, "Account default");
    assert.equal(task.observedMode, null);
    assert.equal(task.lifecycle, "idle");
    const providerSurface = await waitForLiveChatGptSurface(
      ordinaryLiveTasks,
      task.taskId,
      (surface) =>
        surface.state.composerVisible &&
        new URL(surface.url).searchParams.get("farol-e2e-task") === task.taskId,
      `embedded task ${index}`,
    );
    taskSurfaceIds.set(task.taskId, providerSurface.contentsId);
    assert.equal(
      new URL(providerSurface.url).searchParams.get("farol-e2e-task"),
      task.taskId,
    );
    assert.equal(
      await ordinaryLiveTasks.application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
    assert.equal(await newTask.locator("small").innerText(), `${index} / 5`);
  }

  assert.equal(taskSurfaceIds.size, 5);
  assert.equal(await newTask.isDisabled(), true);
  const capacity = await ordinaryLiveTasks.window.evaluate(() =>
    window.farolNext.task({ kind: "task.create-chatgpt" }),
  );
  assert.deepEqual(capacity, {
    ok: false,
    error: "TASK_CAPACITY_REACHED",
    state: capacity.state,
  });
  assert.equal(capacity.state.tasks.length, 5);
  assert.equal(capacity.state.revision, 5);
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-tabs .task-tab").count(),
    5,
  );
  assert.match(
    (await ordinaryLiveTasks.window
      .locator("#dossier-model")
      .getAttribute("title")) ?? "",
    /Requested: Account default · Observed: Not observed/u,
  );
  assert.match(
    await ordinaryLiveTasks.window.locator("#browser-state-detail").innerText(),
    /actual provider page is embedded/u,
  );
  const embeddedSurfaces = await liveChatGptSurfaces(
    ordinaryLiveTasks.application,
    new URL(ordinaryLiveTasks.chatGptFixture.url).origin,
  );
  assert.equal(embeddedSurfaces.length, 5);
  assert.equal(
    new Set(embeddedSurfaces.map((surface) => surface.contentsId)).size,
    5,
  );
  assert.equal(
    embeddedSurfaces.filter((surface) => surface.hostVisible).length,
    1,
  );
  const selectedLiveTaskId = capacity.state.tasks.at(-1)?.taskId;
  assert.ok(selectedLiveTaskId);
  const expectedSurfaceIds = [...taskSurfaceIds.values()].sort(
    (left, right) => left - right,
  );
  for (const globalSection of ["computer", "activity", "settings"]) {
    await ordinaryLiveTasks.window
      .locator(`.nav-item[data-section="${globalSection}"]`)
      .click();
    await ordinaryLiveTasks.window
      .locator(`[data-panel="${globalSection}"].active`)
      .waitFor();
    await waitForLiveChatGptSurface(
      ordinaryLiveTasks,
      selectedLiveTaskId,
      (surface) => !surface.hostVisible,
      `${globalSection} hides live provider pages`,
    );
    const hiddenSurfaces = await liveChatGptSurfaces(
      ordinaryLiveTasks.application,
      new URL(ordinaryLiveTasks.chatGptFixture.url).origin,
    );
    assert.ok(hiddenSurfaces.every((surface) => !surface.hostVisible));
    assert.deepEqual(
      hiddenSurfaces
        .map((surface) => surface.contentsId)
        .sort((left, right) => left - right),
      expectedSurfaceIds,
    );
  }
  await ordinaryLiveTasks.window
    .locator('.nav-item[data-section="browser"]')
    .click();
  await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    selectedLiveTaskId,
    (surface) =>
      surface.hostVisible &&
      surface.hostBounds.x === 216 &&
      surface.hostBounds.y === 178,
    "Browser restores the selected embedded provider page",
  );
  await ordinaryLiveTasks.window.screenshot({
    path: path.join(evidenceRoot, "live-task-watch-rail-wide.png"),
  });
  await setWindowSize(ordinaryLiveTasks.application, 640, 520);
  await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    selectedLiveTaskId,
    (surface) =>
      surface.hostVisible &&
      surface.hostBounds.x === 72 &&
      surface.hostBounds.y === 178 &&
      surface.hostBounds.width === 568 &&
      surface.hostBounds.height === 342,
    "minimum window keeps the embedded provider page bounded",
  );
  await ordinaryLiveTasks.window.screenshot({
    path: path.join(evidenceRoot, "live-task-watch-rail-compact.png"),
  });
  await ordinaryLiveTasks.window.locator("#command-button").click();
  await ordinaryLiveTasks.window
    .locator("#command-dialog")
    .waitFor({ state: "visible" });
  await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    selectedLiveTaskId,
    (surface) => !surface.hostVisible,
    "quick switcher hides the embedded provider page",
  );
  await ordinaryLiveTasks.window.keyboard.press("Escape");
  await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    selectedLiveTaskId,
    (surface) => surface.hostVisible && surface.hostBounds.x === 72,
    "Escape restores the embedded provider page",
  );
  await setWindowSize(ordinaryLiveTasks.application, 1_180, 760);
  await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    selectedLiveTaskId,
    (surface) => surface.hostVisible && surface.hostBounds.x === 216,
    "wide layout restores the embedded provider page",
  );
  const providerSecurity = await ordinaryLiveTasks.application.evaluate(
    ({ session, webContents }, origin) =>
      webContents
        .getAllWebContents()
        .filter((contents) => contents.getURL().startsWith(origin))
        .map((contents) => {
          const preferences = contents.getLastWebPreferences();
          return {
            sandbox: preferences.sandbox,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
            isolatedSession:
              contents.session ===
              session.fromPartition("persist:farol-next-chatgpt"),
          };
        }),
    new URL(ordinaryLiveTasks.chatGptFixture.url).origin,
  );
  assert.equal(providerSecurity.length, 5);
  assert.ok(
    providerSecurity.every(
      (proof) =>
        proof.sandbox === true &&
        proof.contextIsolation === true &&
        proof.nodeIntegration === false &&
        proof.isolatedSession === true,
    ),
  );
  assert.equal(
    await ordinaryLiveTasks.application.evaluate(({ session }) =>
      session
        .fromPartition("persist:farol-next-chatgpt")
        .listenerCount("will-download"),
    ),
    1,
  );

  const admittedState = await ordinaryLiveTasks.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  const pinnedTask = admittedState.tasks[4];
  const agentCancellationTask = admittedState.tasks[1];
  const cancellableTask = admittedState.tasks[2];
  const closingTask = admittedState.tasks[3];
  assert.ok(
    pinnedTask && agentCancellationTask && cancellableTask && closingTask,
  );
  await ordinaryLiveTasks.window.locator("#task-menu-button").click();
  await ordinaryLiveTasks.window
    .locator("#task-menu")
    .waitFor({ state: "visible" });
  await ordinaryLiveTasks.window
    .locator("#task-menu-name")
    .fill("Pinned continuity task");
  await ordinaryLiveTasks.window.locator("#task-menu-rename").click();
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-menu-note")?.textContent ===
      "Task renamed.",
  );
  await ordinaryLiveTasks.window.locator("#task-menu-pin").click();
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-menu-note")?.textContent === "Task pinned.",
  );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-menu-cancel").isDisabled(),
    true,
  );
  const managedState = await ordinaryLiveTasks.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(managedState.tasks[0].taskId, pinnedTask.taskId);
  assert.equal(managedState.tasks[0].label, "Pinned continuity task");
  assert.equal(managedState.tasks[0].pinned, true);
  assert.equal(managedState.taskRevision, 7);
  assert.equal(
    (
      await waitForLiveChatGptSurface(
        ordinaryLiveTasks,
        pinnedTask.taskId,
        (surface) =>
          !surface.hostVisible &&
          surface.contentsId === taskSurfaceIds.get(pinnedTask.taskId),
        "renamed pinned task remains retained under the task menu",
      )
    ).contentsId,
    taskSurfaceIds.get(pinnedTask.taskId),
  );
  const idleCancel = await ordinaryLiveTasks.window.evaluate(
    (taskId) => window.farolNext.task({ kind: "task.cancel", taskId }),
    pinnedTask.taskId,
  );
  assert.deepEqual(idleCancel, {
    ok: false,
    error: "TASK_NOT_RUNNING",
    state: idleCancel.state,
  });
  assert.equal(idleCancel.state.revision, 7);
  await ordinaryLiveTasks.window.locator("#task-menu-close").click();
  await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    pinnedTask.taskId,
    (surface) => surface.hostVisible,
    "closing the task menu restores the selected provider page",
  );

  const continuityPrompt = "Farol live task continuity canary";
  assert.equal(
    await submitLiveChatGptTask(
      ordinaryLiveTasks,
      pinnedTask.taskId,
      continuityPrompt,
    ),
    1,
  );
  const completedContinuitySurface = await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    pinnedTask.taskId,
    (surface) =>
      /\/chatgpt\/c\/[A-Za-z0-9-]{8,128}$/u.test(
        new URL(surface.url).pathname,
      ) &&
      surface.state.assistantText.includes(
        "keep the read-only boundary in place",
      ),
    "embedded task completes without leaving Watch Rail",
  );
  const retainedLiveConversationUrl = completedContinuitySurface.url;
  await ordinaryLiveTasks.window.waitForFunction(
    async (taskId) =>
      (await window.farolNext.bootstrap()).tasks.find(
        (task) => task.taskId === taskId,
      )?.lifecycle === "completed",
    pinnedTask.taskId,
  );
  assert.equal(
    completedContinuitySurface.contentsId,
    taskSurfaceIds.get(pinnedTask.taskId),
  );
  await waitForWindowCount(ordinaryLiveTasks.application, 1);

  await ordinaryLiveTasks.window
    .locator(`#task-tabs .task-tab[data-task-id="${cancellableTask.taskId}"]`)
    .click();
  assert.equal(
    await submitLiveChatGptTask(
      ordinaryLiveTasks,
      cancellableTask.taskId,
      "Farol live cancellation canary",
    ),
    1,
  );
  await ordinaryLiveTasks.window.waitForFunction(
    async (taskId) =>
      (await window.farolNext.bootstrap()).tasks.find(
        (task) => task.taskId === taskId,
      )?.lifecycle === "running",
    cancellableTask.taskId,
  );
  await ordinaryLiveTasks.window.locator("#task-menu-button").click();
  await ordinaryLiveTasks.window
    .locator("#task-menu")
    .waitFor({ state: "visible" });
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-menu-cancel")?.hasAttribute("disabled") ===
      false,
  );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-menu-cancel").isEnabled(),
    true,
  );
  await ordinaryLiveTasks.window.locator("#task-menu-cancel").click();
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-menu-note")?.textContent ===
      "Provider stop confirmed.",
  );
  const cancelledState = await ordinaryLiveTasks.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(
    cancelledState.tasks.find((task) => task.taskId === cancellableTask.taskId)
      ?.lifecycle,
    "cancelled",
  );
  assert.equal(
    (
      await waitForLiveChatGptSurface(
        ordinaryLiveTasks,
        cancellableTask.taskId,
        (surface) => !surface.state.stopVisible,
        "cancel hides provider stop control",
      )
    ).contentsId,
    taskSurfaceIds.get(cancellableTask.taskId),
  );
  await ordinaryLiveTasks.window.locator("#task-menu-close").click();

  await ordinaryLiveTasks.window
    .locator(`#task-tabs .task-tab[data-task-id="${closingTask.taskId}"]`)
    .click();
  await ordinaryLiveTasks.window.locator("#task-menu-button").click();
  await ordinaryLiveTasks.window
    .locator("#task-menu")
    .waitFor({ state: "visible" });
  await ordinaryLiveTasks.window.locator("#task-menu-close-task").click();
  await ordinaryLiveTasks.window.waitForFunction(
    (taskId) =>
      !document.querySelector(`#task-tabs .task-tab[data-task-id="${taskId}"]`),
    closingTask.taskId,
  );
  await ordinaryLiveTasks.window
    .locator("#task-menu")
    .waitFor({ state: "hidden" });
  await waitForWindowCount(ordinaryLiveTasks.application, 1);
  assert.equal(await newTask.isEnabled(), true);
  assert.equal(await newTask.locator("small").innerText(), "4 / 5");
  const retainedSurfacesAfterClose = await liveChatGptSurfaces(
    ordinaryLiveTasks.application,
    new URL(ordinaryLiveTasks.chatGptFixture.url).origin,
  );
  assert.equal(retainedSurfacesAfterClose.length, 4);
  assert.equal(
    retainedSurfacesAfterClose.some(
      (surface) => surface.taskId === closingTask.taskId,
    ),
    false,
  );
  assert.equal(
    await ordinaryLiveTasks.application.evaluate(({ session }) =>
      session
        .fromPartition("persist:farol-next-chatgpt")
        .listenerCount("will-download"),
    ),
    1,
  );

  await ordinaryLiveTasks.window
    .locator(`#task-tabs .task-tab[data-task-id="${pinnedTask.taskId}"]`)
    .click();
  await ordinaryLiveTasks.window.locator("#task-menu-button").click();
  await ordinaryLiveTasks.window
    .locator("#task-menu")
    .waitFor({ state: "visible" });
  const productWorkspaceId =
    admittedState.configuration.settings.computer.workspaces[0].workspaceId;
  assert.equal(
    await ordinaryLiveTasks.window
      .locator("#task-agent-workspace")
      .inputValue(),
    productWorkspaceId,
  );
  await ordinaryLiveTasks.window
    .locator("#task-agent-scope")
    .selectOption("exact");
  await ordinaryLiveTasks.window.locator("#task-agent-paths").fill("README.md");
  await ordinaryLiveTasks.window
    .locator("#task-agent-objective")
    .fill(
      "Read README.md through the approved exact-path scope and report its boundary marker.",
    );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-menu-agent").isEnabled(),
    true,
  );
  await ordinaryLiveTasks.window.locator("#task-menu-agent").click();
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-menu-note")?.textContent ===
      "Agent assignment admitted.",
  );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-menu-agent span").innerText(),
    "Rejoin Agent",
  );
  assert.equal(
    await ordinaryLiveTasks.window
      .locator("#task-menu-close-task")
      .isDisabled(),
    true,
  );
  await ordinaryLiveTasks.window.waitForTimeout(350);
  await ordinaryLiveTasks.window.locator("#task-menu-agent").click();
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-agent-state small")?.textContent ===
      "Delivered",
  );
  const productAgentBootstrap = await ordinaryLiveTasks.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  const productAgentTask = productAgentBootstrap.tasks.find(
    (task) => task.taskId === pinnedTask.taskId,
  );
  assert.ok(productAgentTask);
  assert.match(
    productAgentTask.agent.assignmentBindingSha256,
    /^[a-f0-9]{64}$/u,
  );
  assert.deepEqual(productAgentTask.agent, {
    assignmentBindingSha256: productAgentTask.agent.assignmentBindingSha256,
    phase: "completed",
    workspaceId: productWorkspaceId,
    parentDelivery: "acknowledged",
    workspaceEnforcement: "verified",
    resultAvailable: true,
  });
  assert.equal(productAgentBootstrap.nativeAgent, true);
  assert.equal(
    await ordinaryLiveTasks.window
      .locator("#task-agent-state small")
      .innerText(),
    "Delivered",
  );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-menu-close-task").isEnabled(),
    true,
  );
  await ordinaryLiveTasks.window.screenshot({
    path: path.join(evidenceRoot, "live-task-native-agent-delivered.png"),
  });
  await ordinaryLiveTasks.window.locator("#task-menu-close").click();

  await ordinaryLiveTasks.window
    .locator(
      `#task-tabs .task-tab[data-task-id="${agentCancellationTask.taskId}"]`,
    )
    .click();
  await ordinaryLiveTasks.window.locator("#task-menu-button").click();
  await ordinaryLiveTasks.window
    .locator("#task-menu")
    .waitFor({ state: "visible" });
  await ordinaryLiveTasks.window
    .locator("#task-agent-objective")
    .fill(
      "Hold the approved read-only workspace while Farol proves exact native cancellation.",
    );
  await ordinaryLiveTasks.window.locator("#task-menu-agent").click();
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-menu-note")?.textContent ===
      "Agent assignment admitted.",
  );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-menu-cancel").isEnabled(),
    true,
  );
  assert.equal(
    await ordinaryLiveTasks.window
      .locator("#task-menu-close-task")
      .isDisabled(),
    true,
  );
  await ordinaryLiveTasks.window.locator("#task-menu-cancel").click();
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-menu-note")?.textContent ===
      "Agent cancellation confirmed.",
  );
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-agent-state small")?.textContent ===
      "Cancelled",
  );
  const cancelledAgentBootstrap = await ordinaryLiveTasks.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.deepEqual(
    cancelledAgentBootstrap.tasks.find(
      (task) => task.taskId === agentCancellationTask.taskId,
    )?.agent,
    {
      assignmentBindingSha256: cancelledAgentBootstrap.tasks.find(
        (task) => task.taskId === agentCancellationTask.taskId,
      )?.agent?.assignmentBindingSha256,
      phase: "cancelled",
      workspaceId: productWorkspaceId,
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
    },
  );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-menu-close-task").isEnabled(),
    true,
  );
  await ordinaryLiveTasks.window.screenshot({
    path: path.join(evidenceRoot, "live-task-native-agent-cancelled.png"),
  });
  await ordinaryLiveTasks.window.locator("#task-menu-close").click();
  await ordinaryLiveTasks.window
    .locator(`#task-tabs .task-tab[data-task-id="${pinnedTask.taskId}"]`)
    .click();

  const productAgentInputRoot = path.join(
    ordinaryLiveTasks.userData,
    "farol-next-state",
    "product-agent-inputs",
  );
  const productAgentInputFiles = (
    await fs.readdir(productAgentInputRoot)
  ).filter((entry) => entry.endsWith(".json"));
  assert.equal(productAgentInputFiles.length, 2);
  const productAgentInputs = await Promise.all(
    productAgentInputFiles.map(async (entry) => {
      const target = path.join(productAgentInputRoot, entry);
      const text = await fs.readFile(target, "utf8");
      return { target, text, envelope: JSON.parse(text) };
    }),
  );
  const deliveredProductAgentInput = productAgentInputs.find(({ text }) =>
    /Read README\.md through the approved exact-path scope/u.test(text),
  );
  const cancelledProductAgentInput = productAgentInputs.find(({ text }) =>
    /proves exact native cancellation/u.test(text),
  );
  assert.ok(deliveredProductAgentInput);
  assert.ok(cancelledProductAgentInput);
  assert.equal(
    createHash("sha256")
      .update(
        JSON.stringify([
          "farol-product-agent-binding-v1",
          deliveredProductAgentInput.envelope.input.taskId,
          deliveredProductAgentInput.envelope.input.sessionId,
          deliveredProductAgentInput.envelope.input.assignmentId,
        ]),
      )
      .digest("hex"),
    productAgentTask.agent.assignmentBindingSha256,
  );
  assert.equal(
    createHash("sha256")
      .update(
        JSON.stringify([
          "farol-product-agent-binding-v1",
          cancelledProductAgentInput.envelope.input.taskId,
          cancelledProductAgentInput.envelope.input.sessionId,
          cancelledProductAgentInput.envelope.input.assignmentId,
        ]),
      )
      .digest("hex"),
    cancelledAgentBootstrap.tasks.find(
      (task) => task.taskId === agentCancellationTask.taskId,
    )?.agent?.assignmentBindingSha256,
  );
  assert.match(
    deliveredProductAgentInput.text,
    /Read README\.md through the approved exact-path scope/u,
  );
  assert.equal(deliveredProductAgentInput.envelope.schema, 2);
  assert.deepEqual(deliveredProductAgentInput.envelope.input.scope, {
    mode: "exact",
    root: ordinaryLiveTasks.workspaceRoot,
    paths: [path.join(ordinaryLiveTasks.workspaceRoot, "README.md")],
  });
  assert.deepEqual(deliveredProductAgentInput.envelope.input.excludedPaths, []);
  assert.equal(cancelledProductAgentInput.envelope.schema, 2);
  assert.deepEqual(cancelledProductAgentInput.envelope.input.scope, {
    mode: "subtree",
    root: ordinaryLiveTasks.workspaceRoot,
  });
  assert.deepEqual(cancelledProductAgentInput.envelope.input.excludedPaths, []);
  assert.equal((await fs.stat(productAgentInputRoot)).mode & 0o777, 0o700);
  assert.ok(
    (
      await Promise.all(
        productAgentInputs.map(async ({ target }) =>
          fs.stat(target).then((entry) => entry.mode & 0o777),
        ),
      )
    ).every((mode) => mode === 0o600),
  );

  const assignmentRoot = path.join(
    ordinaryLiveTasks.userData,
    "farol-next-state",
    "native-agent-assignments",
    "assignments",
  );
  const assignmentFiles = (await fs.readdir(assignmentRoot)).filter((entry) =>
    entry.endsWith(".json"),
  );
  const productAssignmentRecords = await Promise.all(
    assignmentFiles.map(async (entry) => {
      const target = path.join(assignmentRoot, entry);
      return {
        target,
        record: JSON.parse(await fs.readFile(target, "utf8")).record,
      };
    }),
  );
  const productAssignment = productAssignmentRecords.find(
    ({ record }) => record.assignment.identity.taskId === pinnedTask.taskId,
  );
  assert.ok(productAssignment);
  assert.equal(productAssignment.record.assignment.phase, "completed");
  assert.equal(productAssignment.record.parentDelivery, "acknowledged");
  assert.equal(productAssignment.record.workspaceEnforcement, "verified");
  assert.match(productAssignment.record.resultRef, /^codex-app-server:\/\//u);
  assert.equal((await fs.stat(productAssignment.target)).mode & 0o777, 0o600);
  const cancelledProductAssignment = productAssignmentRecords.find(
    ({ record }) =>
      record.assignment.identity.taskId === agentCancellationTask.taskId,
  );
  assert.ok(cancelledProductAssignment);
  assert.equal(cancelledProductAssignment.record.assignment.phase, "cancelled");
  assert.equal(cancelledProductAssignment.record.assignment.terminal, true);
  assert.equal(
    cancelledProductAssignment.record.assignment.terminalReason.code,
    "AGENT_CANCELLED",
  );
  assert.equal(cancelledProductAssignment.record.resultRef, null);
  assert.equal(
    (await fs.stat(cancelledProductAssignment.target)).mode & 0o777,
    0o600,
  );

  const liveTaskRoot = path.join(
    ordinaryLiveTasks.userData,
    "farol-next-state",
    "live-tasks",
  );
  const liveTaskPath = path.join(liveTaskRoot, "live-tasks.json");
  const liveTaskText = await fs.readFile(liveTaskPath, "utf8");
  const liveTaskRecord = JSON.parse(liveTaskText);
  assert.equal(liveTaskRecord.schema, 1);
  assert.ok(liveTaskRecord.revision >= 12);
  assert.equal(liveTaskRecord.tasks.length, 4);
  assert.equal(liveTaskRecord.tasks[0].taskId, pinnedTask.taskId);
  assert.equal(liveTaskRecord.tasks[0].label, "Pinned continuity task");
  assert.equal(liveTaskRecord.tasks[0].pinned, true);
  assert.equal(liveTaskRecord.tasks[0].lifecycle, "completed");
  assert.deepEqual(liveTaskRecord.tasks[0].agent, productAgentTask.agent);
  assert.equal(
    liveTaskRecord.tasks[0].conversationUrl,
    retainedLiveConversationUrl,
  );
  assert.equal(
    liveTaskRecord.tasks.some((task) => task.taskId === closingTask.taskId),
    false,
  );
  assert.equal(
    liveTaskRecord.tasks.find((task) => task.taskId === cancellableTask.taskId)
      ?.lifecycle,
    "cancelled",
  );
  assert.equal(
    liveTaskRecord.tasks.find(
      (task) => task.taskId === agentCancellationTask.taskId,
    )?.agent?.phase,
    "cancelled",
  );
  assert.deepEqual(Object.keys(liveTaskRecord.tasks[0]).sort(), [
    "agent",
    "conversationUrl",
    "hasComputer",
    "label",
    "lifecycle",
    "observedMode",
    "observedModel",
    "pinned",
    "provider",
    "requestedMode",
    "requestedModel",
    "sessionId",
    "taskId",
    "turnId",
  ]);
  assert.doesNotMatch(
    liveTaskText,
    /continuity canary|cancellation canary|bounded workspace verification|Read README\.md through the approved exact-path scope|proves exact native cancellation/iu,
  );
  assert.equal((await fs.stat(liveTaskRoot)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(liveTaskPath)).mode & 0o777, 0o600);

  await ordinaryLiveTasks.window.evaluate((taskId) => {
    void window.farolNext.control(taskId, "compact-context-fixture");
  }, pinnedTask.taskId);
  await ordinaryLiveTasks.window.waitForFunction(async (taskId) => {
    const state = await window.farolNext.bootstrap();
    return (
      state.tasks.find((task) => task.taskId === taskId)?.context?.phase ===
        "checkpoint_requested" &&
      document.querySelector("#dossier-state b")?.textContent ===
        "PRESERVING CONTEXT"
    );
  }, pinnedTask.taskId);
  await ordinaryLiveTasks.window.waitForFunction(async (taskId) => {
    const state = await window.farolNext.bootstrap();
    return (
      state.tasks.find((task) => task.taskId === taskId)?.context?.phase ===
      "handoff_offered"
    );
  }, pinnedTask.taskId);
  const repeatedCompaction = await ordinaryLiveTasks.window.evaluate(
    (taskId) => window.farolNext.control(taskId, "compact-context-fixture"),
    pinnedTask.taskId,
  );
  assert.deepEqual(repeatedCompaction, { ok: true, phase: "handoff_offered" });
  const handoffSurface = await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    pinnedTask.taskId,
    (surface) =>
      surface.state.submitCount === 2 &&
      surface.state.assistantText.includes('"nextSafeStep"'),
    "duplicate compaction observes the one submitted summary",
  );
  assert.equal(handoffSurface.state.submitCount, 2);
  assert.equal(
    await ordinaryLiveTasks.window.locator("#dossier-state b").innerText(),
    "INSTALLING CONTEXT",
  );
  await ordinaryLiveTasks.window.locator("#task-menu-button").click();
  await ordinaryLiveTasks.window
    .locator("#task-menu")
    .waitFor({ state: "visible" });
  assert.equal(
    await ordinaryLiveTasks.window
      .locator("#task-menu-close-task")
      .isDisabled(),
    true,
  );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#task-menu-agent").isDisabled(),
    true,
  );
  assert.match(
    await ordinaryLiveTasks.window.locator("#task-menu-note").innerText(),
    /Installing context is still active/u,
  );
  await ordinaryLiveTasks.window.screenshot({
    path: path.join(evidenceRoot, "live-task-context-handoff.png"),
  });
  await ordinaryLiveTasks.window.locator("#task-menu-close").click();

  const handoffLiveTaskText = await fs.readFile(liveTaskPath, "utf8");
  const handoffLiveTaskRecord = JSON.parse(handoffLiveTaskText);
  const handoffTask = handoffLiveTaskRecord.tasks.find(
    (task) => task.taskId === pinnedTask.taskId,
  );
  assert.ok(handoffTask);
  assert.deepEqual(handoffTask.context, {
    epoch: 1,
    phase: "handoff_offered",
    source: "retained_agent",
    code: null,
  });
  assert.equal(handoffTask.conversationUrl, retainedLiveConversationUrl);
  assert.doesNotMatch(
    handoffLiveTaskText,
    /Keep every change local|report-v2\.md|unknown external operation/iu,
  );
  const contextRoot = path.join(
    ordinaryLiveTasks.userData,
    "farol-next-state",
    "context-continuity",
  );
  const contextTaskRoot = path.join(contextRoot, "tasks");
  const contextTaskDirectories = await fs.readdir(contextTaskRoot);
  assert.equal(contextTaskDirectories.length, 1);
  const contextTaskDirectory = path.join(
    contextTaskRoot,
    contextTaskDirectories[0],
  );
  assert.equal((await fs.stat(contextRoot)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(contextTaskDirectory)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(contextTaskDirectory, "session.json"))).mode &
      0o777,
    0o600,
  );

  await ordinaryLiveTasks.window
    .locator(
      `#task-tabs .task-tab[data-task-id="${agentCancellationTask.taskId}"]`,
    )
    .click();
  await ordinaryLiveTasks.window.locator("#task-menu-button").click();
  await ordinaryLiveTasks.window
    .locator("#task-menu")
    .waitFor({ state: "visible" });
  await ordinaryLiveTasks.window
    .locator("#task-agent-objective")
    .fill(
      "Remain active until the persisted authority expires across an application restart.",
    );
  await ordinaryLiveTasks.window.locator("#task-menu-agent").click();
  await ordinaryLiveTasks.window.waitForFunction(
    () =>
      document.querySelector("#task-menu-note")?.textContent ===
      "Agent assignment admitted.",
  );
  const expiringAgentState = await ordinaryLiveTasks.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  const expiringAgentTask = expiringAgentState.tasks.find(
    (task) => task.taskId === agentCancellationTask.taskId,
  );
  assert.equal(expiringAgentTask?.agent?.phase, "running");
  assert.match(
    expiringAgentTask.agent.assignmentBindingSha256,
    /^[a-f0-9]{64}$/u,
  );
  await ordinaryLiveTasks.window.locator("#task-menu-close").click();
  const expiringInputEnvelope = JSON.parse(
    await fs.readFile(cancelledProductAgentInput.target, "utf8"),
  );
  assert.equal(
    expiringInputEnvelope.input.taskId,
    agentCancellationTask.taskId,
  );
  assert.match(
    expiringInputEnvelope.input.objective,
    /persisted authority expires/u,
  );
  assert.equal(
    createHash("sha256")
      .update(
        JSON.stringify([
          "farol-product-agent-binding-v1",
          expiringInputEnvelope.input.taskId,
          expiringInputEnvelope.input.sessionId,
          expiringInputEnvelope.input.assignmentId,
        ]),
      )
      .digest("hex"),
    expiringAgentTask.agent.assignmentBindingSha256,
  );
  expiringInputEnvelope.input.expiresAt = Date.now() - 1_000;
  await fs.writeFile(
    cancelledProductAgentInput.target,
    `${JSON.stringify(expiringInputEnvelope, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.equal(
    (await fs.stat(cancelledProductAgentInput.target)).mode & 0o777,
    0o600,
  );

  await restart(ordinaryLiveTasks);
  await ordinaryLiveTasks.window.waitForFunction(
    () => document.querySelectorAll("#task-tabs .task-tab").length === 4,
  );
  await ordinaryLiveTasks.window.waitForFunction(async (taskId) => {
    const state = await window.farolNext.bootstrap();
    return (
      state.tasks.find((task) => task.taskId === taskId)?.agent?.phase ===
      "cancelled"
    );
  }, agentCancellationTask.taskId);
  await waitForWindowCount(ordinaryLiveTasks.application, 1);
  const recoveredState = await ordinaryLiveTasks.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.ok(recoveredState.taskRevision > handoffLiveTaskRecord.revision);
  assert.deepEqual(
    recoveredState.tasks,
    handoffLiveTaskRecord.tasks.map(
      ({ conversationUrl: _conversationUrl, ...task }) =>
        task.taskId === agentCancellationTask.taskId
          ? {
              ...task,
              agent: {
                ...task.agent,
                assignmentBindingSha256:
                  expiringAgentTask.agent.assignmentBindingSha256,
              },
            }
          : task,
    ),
  );
  const expiredAssignmentFiles = (await fs.readdir(assignmentRoot)).filter(
    (entry) => entry.endsWith(".json"),
  );
  const expiredAssignmentRecords = await Promise.all(
    expiredAssignmentFiles.map(async (entry) =>
      JSON.parse(await fs.readFile(path.join(assignmentRoot, entry), "utf8")),
    ),
  );
  const expiredAssignment = expiredAssignmentRecords.find(
    ({ record }) =>
      record.assignment.identity.assignmentId ===
      expiringInputEnvelope.input.assignmentId,
  );
  assert.ok(expiredAssignment);
  assert.equal(expiredAssignment.record.assignment.phase, "cancelled");
  assert.equal(expiredAssignment.record.assignment.terminal, true);
  assert.equal(
    expiredAssignment.record.assignment.terminalReason.code,
    "AGENT_CANCELLED",
  );
  const recoveredNewTask = ordinaryLiveTasks.window.locator("#new-task");
  assert.equal(await recoveredNewTask.isEnabled(), true);
  assert.equal(await recoveredNewTask.locator("small").innerText(), "4 / 5");
  await ordinaryLiveTasks.window.locator("#dossier-route").click();
  const reopenedContinuitySurface = await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    pinnedTask.taskId,
    (surface) =>
      surface.url === retainedLiveConversationUrl &&
      surface.hostVisible &&
      surface.state.userText.startsWith(
        "Preserve the current task context for a safe continuation.",
      ) &&
      surface.state.assistantText.includes('"nextSafeStep"'),
    "retained context handoff after process restart",
  );
  assert.match(
    reopenedContinuitySurface.state.userText,
    /^Preserve the current task context for a safe continuation\./u,
  );
  assert.match(
    reopenedContinuitySurface.state.assistantText,
    /"unknownOutcomes"/u,
  );
  assert.equal(
    await ordinaryLiveTasks.application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  assert.equal(
    await ordinaryLiveTasks.window.locator("#dossier-state b").innerText(),
    "INSTALLING CONTEXT",
  );
  const confirmedContext = await ordinaryLiveTasks.window.evaluate(
    (taskId) => window.farolNext.control(taskId, "confirm-context-fixture"),
    pinnedTask.taskId,
  );
  assert.deepEqual(confirmedContext, { ok: true, phase: "active" });
  await ordinaryLiveTasks.window.waitForFunction(async (taskId) => {
    const state = await window.farolNext.bootstrap();
    const task = state.tasks.find((candidate) => candidate.taskId === taskId);
    return task?.context?.phase === "active" && task.context.epoch === 2;
  }, pinnedTask.taskId);
  assert.equal(
    await ordinaryLiveTasks.window.locator("#dossier-state b").innerText(),
    "COMPLETE",
  );
  const activeLiveTaskRecord = JSON.parse(
    await fs.readFile(liveTaskPath, "utf8"),
  );
  const activeContextTask = activeLiveTaskRecord.tasks.find(
    (task) => task.taskId === pinnedTask.taskId,
  );
  assert.ok(activeContextTask);
  assert.deepEqual(activeContextTask.context, {
    epoch: 2,
    phase: "active",
    source: "retained_agent",
    code: null,
  });
  assert.equal(activeContextTask.conversationUrl, null);
  assert.equal(
    (await fs.readdir(path.join(contextTaskDirectory, "sources"))).length,
    0,
  );
  assert.equal(
    (await fs.readdir(path.join(contextTaskDirectory, "summaries"))).length,
    0,
  );
  const freshContextSurface = await ordinaryLiveTasks.window.evaluate(
    (taskId) => window.farolNext.task({ kind: "task.activate", taskId }),
    pinnedTask.taskId,
  );
  assert.equal(freshContextSurface.ok, true);
  assert.equal(freshContextSurface.selectedTaskId, pinnedTask.taskId);
  await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    pinnedTask.taskId,
    (surface) =>
      surface.hostVisible &&
      new URL(surface.url).pathname === "/chatgpt" &&
      !surface.state.userText.includes("Preserve the current task context"),
    "retired context source opens a fresh provider page",
  );
  cases.push(
    "ordinary-new-task-opens-actual-chatgpt-surface",
    "ordinary-live-task-embedded-in-watch-rail",
    "five-live-chatgpt-task-capacity",
    "sixth-live-task-refused-without-replacement",
    "live-task-global-sections-preserve-native-surfaces",
    "live-task-compact-overlay-bounds",
    "live-task-requested-observed-state-truthful",
    "live-task-rename-pin-close-and-capacity-recovery",
    "live-task-close-disposes-exact-surface",
    "live-task-registry-private-content-free-persistence",
    "live-task-same-conversation-after-process-restart",
    "shared-chatgpt-session-single-download-guard",
    "idle-live-task-cancel-refused-truthfully",
    "running-live-task-cancel-confirmed-once",
    "live-task-native-agent-product-objective",
    "live-task-native-agent-same-child-rejoin",
    "live-task-native-agent-result-delivery-acknowledged",
    "live-task-native-agent-private-input",
    "live-task-native-agent-content-free-recovery",
    "live-task-native-agent-owner-exact-path-narrowing",
    "live-task-native-agent-cancel-confirmed",
    "live-task-native-agent-expiry-cancelled-after-restart",
    "live-task-context-preservation-visible",
    "live-task-context-handoff-survives-restart",
    "live-task-context-confirmation-retires-source",
  );
} finally {
  await close(ordinaryLiveTasks);
}

const interruptedChatGptTask = await launch([], "hidden", "ordinary", {
  seedChatGptDispatchIntent: true,
});
try {
  const recoveredJournal = await waitForChatGptJournalPhase(
    interruptedChatGptTask.userData,
    "delivery_acknowledged",
  );
  assert.equal(
    recoveredJournal.record.operationId,
    interruptedChatGptTask.seededChatGptOperationId,
  );
  assert.deepEqual(recoveredJournal.record.result, {
    state: "outcome_unknown",
    code: "CHATGPT_TASK_INTERRUPTED_AFTER_INTENT",
    deltaCount: 0,
    observedCharacters: 0,
    attachmentCount: 0,
    totalBytes: 0,
    stagingCleanup: null,
  });
  await interruptedChatGptTask.window.waitForFunction(
    () =>
      document
        .querySelector("#settings-feedback")
        ?.textContent?.includes("Nothing was submitted again") === true,
  );
  await interruptedChatGptTask.window.waitForFunction(
    async () =>
      (await window.farolNext.bootstrap()).chatgptRecoveryPending === false,
  );
  const recoveredBootstrap = await interruptedChatGptTask.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(recoveredBootstrap.chatgptRecoveryPending, false);
  assert.equal(
    recoveredBootstrap.configuration.settings.setup.chatgpt.outcomeUnknown,
    true,
  );
  assert.equal(
    recoveredBootstrap.configuration.settings.setup.chatgpt.verified,
    null,
  );
  await waitForWindowCount(interruptedChatGptTask.application, 1);
  cases.push(
    "chatgpt-dispatch-intent-restart-no-resubmit",
    "chatgpt-recovered-result-delivery-acknowledged",
  );
} finally {
  await close(interruptedChatGptTask);
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
  const runningBootstrap = await normal.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(runningBootstrap.demoMode, true);
  assert.deepEqual(runningBootstrap.build, buildIdentity);
  assert.match(
    await normal.window.locator("#build-identity > span").innerText(),
    new RegExp(
      `${buildIdentity.version}.*${buildIdentity.sourceCommit.slice(0, 8)}`,
      "u",
    ),
  );
  assert.match(
    await normal.window.locator("#build-identity > small").innerText(),
    /^Built /u,
  );
  assert.match(
    (await normal.window.locator("#build-identity").getAttribute("title")) ??
      "",
    new RegExp(`^${buildIdentity.buildId}`, "u"),
  );
  cases.push("running-build-version-and-time");
  cases.push("explicit-demo-retains-synthetic-fixtures");
  const runtimeLabel = await normal.window.locator("#runtime-pill").innerText();
  if (!runtimeLabel.includes("Local runtime")) {
    await normal.window.locator('[data-section="settings"]').click();
    throw new Error(
      `E2E_RUNTIME_NOT_READY:${runtimeLabel}:${await normal.window.locator("#settings-list").innerText()}`,
    );
  }
  await completeSetup(normal, true, true, true, true, "demo");
  cases.push("native-codex-host-live-tool-verified");
  await deactivateForInactiveAppearanceProof(normal.application);
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.windowActive === "false",
  );
  const initialWatchGeometry = await watchRailGeometry(normal.window);
  assert.equal(initialWatchGeometry.sidebarMode, "full");
  assert.equal(initialWatchGeometry.windowActive, "false");
  assert.deepEqual(initialWatchGeometry.sidebar, {
    x: 0,
    y: 0,
    width: 216,
    height: 760,
  });
  assert.deepEqual(initialWatchGeometry.taskBar, {
    x: 216,
    y: 52,
    width: 964,
    height: 54,
  });
  assert.deepEqual(initialWatchGeometry.dossier, {
    x: 216,
    y: 106,
    width: 964,
    height: 72,
  });
  assert.deepEqual(initialWatchGeometry.surface, {
    x: 216,
    y: 178,
    width: 964,
    height: 582,
  });
  const initialNativeSurface = await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) => surface.hostVisible === true,
    "selected Browser surface becomes visible after Setup",
  );
  assert.deepEqual(initialNativeSurface.hostBounds, {
    x: 216,
    y: 178,
    width: 964,
    height: 582,
  });
  const fontState = await normal.window.evaluate(async () => {
    await document.fonts.ready;
    return {
      geist: document.fonts.check('12px "Farol Geist"'),
      geistMono: document.fonts.check('12px "Farol Geist Mono"'),
      bodyFamily: getComputedStyle(document.body).fontFamily,
    };
  });
  assert.equal(fontState.geist, true);
  assert.equal(fontState.geistMono, true);
  assert.match(fontState.bodyFamily, /Farol Geist/u);
  assert.deepEqual(await applicationMenuState(normal.application), {
    sidebar: {
      label: "Show/Hide Sidebar",
      accelerator: "Control+Command+S",
    },
    switcher: {
      label: "Quick Switcher",
      accelerator: "CommandOrControl+K",
    },
    settings: {
      label: "Settings…",
      accelerator: "CommandOrControl+,",
    },
  });
  const initialChrome = await nativeWindowChrome(normal.application);
  assert.equal(initialChrome.focused, false);
  assert.equal(initialChrome.fullScreen, false);
  if (process.platform === "darwin") {
    assert.deepEqual(initialChrome.trafficLightPosition, { x: 14, y: 18 });
    assert.equal(initialWatchGeometry.toggle.x, 75);
  }

  await invokeApplicationMenu(normal.application, "view.toggle-sidebar");
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "rail",
  );
  const railGeometry = await watchRailGeometry(normal.window);
  assert.ok(
    railGeometry.toggle.x + railGeometry.toggle.width <=
      railGeometry.windowIdentity.x,
    `sidebar toggle overlaps window identity: ${JSON.stringify(railGeometry)}`,
  );
  assert.deepEqual([...new Set(railGeometry.navTargetHeights)], [44]);
  const menuRailSurface = await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) => surface.hostBounds?.x === 72 && surface.hostVisible === true,
    "View menu collapses native surface to rail",
  );
  assert.equal(menuRailSurface.hostBounds.width, 1_108);
  await invokeApplicationMenu(normal.application, "view.toggle-sidebar");
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "full",
  );

  await sendKeyFromTask(normal.application, "task-atlantic", "S", [
    "control",
    "meta",
  ]);
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "rail",
  );
  await sendKeyFromTask(normal.application, "task-atlantic", "S", [
    "control",
    "meta",
  ]);
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "full",
  );
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
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "rail",
  );
  const compactSurface = await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) =>
      surface.hostVisible === true &&
      surface.hostBounds?.x === 72 &&
      surface.hostBounds?.y === 178,
    "compact Browser surface uses auto rail",
  );
  assert.deepEqual(compactSurface.hostBounds, {
    x: 72,
    y: 178,
    width: 628,
    height: 422,
  });
  await captureTask(
    normal.application,
    "task-atlantic",
    "running-browser-compact.png",
  );
  await normal.window.locator("#sidebar-toggle").click();
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "overlay",
  );
  await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) => surface.hostVisible === false,
    "compact sidebar overlay hides native Browser surface",
  );
  assert.equal(
    await normal.window
      .locator("#sidebar")
      .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    216,
  );
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "watch-sidebar-overlay-compact.png"),
  });
  await normal.window.keyboard.press("Escape");
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "rail",
  );
  await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) => surface.hostVisible === true,
    "Escape restores Browser surface after sidebar overlay",
  );
  await setWindowSize(normal.application, 1180, 760);
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "full",
  );
  assert.deepEqual(await shellGeometry(normal.window), wideBrowserGeometry);

  await normal.window.locator("#task-menu-button").click();
  await normal.window.locator("#task-menu").waitFor({ state: "visible" });
  await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) => surface.hostVisible === false,
    "task menu hides native Browser surface",
  );
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "watch-task-menu-wide.png"),
  });
  await normal.window.keyboard.press("Escape");
  await normal.window.locator("#task-menu").waitFor({ state: "hidden" });
  await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) => surface.hostVisible === true,
    "Escape restores Browser surface after task menu",
  );

  await sendKeyFromTask(normal.application, "task-atlantic", "K", ["meta"]);
  await normal.window.locator("#command-dialog").waitFor({ state: "visible" });
  assert.equal(
    await normal.window.evaluate(() => document.activeElement?.id),
    "command-search",
  );
  const commandSearch = normal.window.locator("#command-search");
  await commandSearch.press("ArrowDown");
  assert.equal(
    await normal.window
      .locator("#command-results button.is-selected")
      .getAttribute("data-command-id"),
    "section:computer",
  );
  await commandSearch.fill("no command can match this phrase");
  assert.equal(
    await normal.window.locator("#command-results button").count(),
    0,
  );
  await commandSearch.press("Enter");
  await normal.window.locator("#command-dialog").waitFor({ state: "visible" });
  await commandSearch.fill("");
  assert.equal(
    await normal.window
      .locator("#command-results button.is-selected")
      .getAttribute("data-command-id"),
    "section:browser",
  );
  await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) => surface.hostVisible === false,
    "quick switcher from native page hides Browser surface",
  );
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "watch-quick-switcher-wide.png"),
  });
  await normal.window.keyboard.press("Escape");
  await normal.window.locator("#command-dialog").waitFor({ state: "hidden" });
  await waitForTaskSurface(
    normal.application,
    "task-atlantic",
    (surface) => surface.hostVisible === true,
    "Escape restores Browser surface after quick switcher",
  );

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
        "Fixture read returned 28 bytes bound to turn-atlantic-1-computer-1",
      ) &&
      !state.terminal,
    "tool result resumed exact turn",
  );
  assert.match(
    resumed.answer,
    /Fixture read returned 28 bytes bound to turn-atlantic-1-computer-1/u,
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

  await normal.window.locator("#finish-demo").click();
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
    /Fixture read returned 28 bytes bound to turn-atlantic-1-computer-1/u,
  );
  await normal.window.locator("#finish-demo").click();
  await waitForTask(
    normal.application,
    "task-atlantic",
    (state) => state.terminal && state.status === "Completed",
    "atlantic completion",
  );

  await normal.window.keyboard.press("Meta+3");
  await normal.window.locator('[data-panel="activity"].active').waitFor();
  const activityGeometry = await watchRailGeometry(normal.window);
  assert.equal(activityGeometry.taskBar.height, 0);
  assert.equal(activityGeometry.dossier.height, 0);
  assert.equal(activityGeometry.surface.y, 52);
  const activityText = await normal.window
    .locator('[data-panel="activity"]')
    .innerText();
  assert.doesNotMatch(activityText, /Synthetic local preview fixture/u);
  assert.doesNotMatch(activityText, /Checking the isolated fixture/u);
  assert.doesNotMatch(activityText, /Fixture result|Fixture read|computer-1/u);
  assert.doesNotMatch(activityText, /Bearer|token|\/private\//u);
  assert.doesNotMatch(activityText, /task-atlantic|turn-atlantic/u);
  assert.equal(
    await normal.window
      .locator("#activity-list")
      .getByText("Client delivery acknowledged", { exact: true })
      .count(),
    0,
  );
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "complete-wide.png"),
  });

  await setWindowSize(normal.application, 700, 600);
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "complete-compact.png"),
  });
  await invokeApplicationMenu(normal.application, "app.settings");
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  assert.equal(
    await normal.window.evaluate(
      () => document.documentElement.dataset.section,
    ),
    "settings",
  );
  await normal.window.locator("#diagnostics-group").evaluate((element) => {
    element.open = true;
  });
  assert.match(
    await normal.window.locator("#settings-list").innerText(),
    /local\.farol\.next\.preview/u,
  );
  const reviewReadOnlyTask = normal.window
    .locator("#connection-readiness")
    .getByRole("button", { name: "Review read-only task…", exact: true });
  const retainedConversationUrl = `${normal.chatGptFixture.url}/c/farol-next-e2e`;
  await reviewReadOnlyTask.click();
  const contextPreview = normal.window.locator("#context-preview");
  await contextPreview.waitFor({ state: "visible" });
  const previewText = await contextPreview.innerText();
  assert.match(previewText, /approved-workspace \/ README\.md/u);
  assert.match(previewText, /Read-only · one file · 42 bytes/u);
  assert.match(previewText, /42 of 24,000 characters/u);
  assert.match(
    previewText,
    /No custom exclusions · credential defaults remain denied/u,
  );
  assert.doesNotMatch(previewText, /workspace verification fixture/u);
  await contextPreview.getByRole("button", { name: "Cancel" }).click();
  await contextPreview.waitFor({ state: "hidden" });
  await waitForWindowCount(normal.application, 1);
  await normal.window
    .locator("#settings-feedback")
    .getByText("Context preview cancelled. Nothing was submitted.", {
      exact: true,
    })
    .waitFor();
  cases.push("chatgpt-context-preview-cancel");

  await reviewReadOnlyTask.click();
  await contextPreview.waitFor({ state: "visible" });
  const readOnlyTaskWindow = normal.application.waitForEvent("window", {
    timeout: 15_000,
  });
  await contextPreview
    .getByRole("button", { name: "Send once", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  const readOnlyTaskPage = await readOnlyTaskWindow;
  await readOnlyTaskPage.waitForURL(normal.chatGptFixture.url);
  await normal.window
    .locator("#settings-feedback")
    .getByText(
      /Read-only task completed from README\.md after \d+ incremental updates/u,
    )
    .waitFor({ timeout: 10_000 });
  await readOnlyTaskPage.waitForURL(retainedConversationUrl);
  const taskProgress = await readOnlyTaskPage.evaluate(
    () => window.__farolTaskProgress,
  );
  assert.ok(Array.isArray(taskProgress) && taskProgress.length >= 2);
  assert.ok(
    taskProgress.every(
      (value, index) => index === 0 || value > taskProgress[index - 1],
    ),
  );
  assert.equal(
    await readOnlyTaskPage.evaluate(() => window.__farolSubmitCount),
    1,
  );
  await readOnlyTaskPage.close();
  await waitForWindowCount(normal.application, 1);
  await waitForShellVisibility(
    normal.application,
    normal.windowMode === "secondary-visible",
    normal.expectedTaskViewCount,
  );
  cases.push("chatgpt-readonly-task-incremental-result");
  const reviewAttachments = normal.window
    .locator("#connection-readiness")
    .getByRole("button", { name: "Review attachments…", exact: true });
  await reviewAttachments.click();
  await contextPreview.waitFor({ state: "visible" });
  const attachmentPreview = await contextPreview.innerText();
  assert.match(attachmentPreview, /evidence\.png, notes\.md/u);
  assert.match(attachmentPreview, /Owner-selected · 2 attachments/u);
  assert.match(attachmentPreview, /image\/png/u);
  assert.match(attachmentPreview, /text\/markdown/u);
  assert.match(attachmentPreview, /Only exact private staged copies/u);
  assert.doesNotMatch(attachmentPreview, /attachment document fixture/u);
  const attachmentTaskWindow = normal.application.waitForEvent("window", {
    timeout: 15_000,
  });
  await contextPreview
    .getByRole("button", { name: "Send once", exact: true })
    .click();
  const attachmentTaskPage = await attachmentTaskWindow;
  await attachmentTaskPage.waitForURL(retainedConversationUrl);
  await normal.window
    .locator("#settings-feedback")
    .getByText(/2 attachments delivered intact · \d+ incremental updates/u)
    .waitFor({ timeout: 10_000 });
  const attachmentProof = await attachmentTaskPage.evaluate(
    () => window.__farolAttachmentProof,
  );
  assert.deepEqual(
    attachmentProof,
    await Promise.all(
      [normal.attachmentImage, normal.attachmentDocument].map(
        async (attachmentPath) => {
          const bytes = await fs.readFile(attachmentPath);
          return {
            name: path.basename(attachmentPath),
            type: attachmentPath.endsWith(".png")
              ? "image/png"
              : "text/markdown",
            size: bytes.byteLength,
            base64: bytes.toString("base64"),
          };
        },
      ),
    ),
  );
  assert.equal(
    await attachmentTaskPage.evaluate(() => window.__farolSubmitCount),
    1,
  );
  assert.deepEqual(
    await fs.readdir(
      path.join(normal.userData, "farol-next-state", "attachment-staging"),
    ),
    [],
  );
  const acknowledgedTaskJournal = await waitForChatGptJournalPhase(
    normal.userData,
    "delivery_acknowledged",
  );
  assert.deepEqual(acknowledgedTaskJournal.record.result, {
    state: "completed",
    code: null,
    deltaCount: acknowledgedTaskJournal.record.result.deltaCount,
    observedCharacters:
      acknowledgedTaskJournal.record.result.observedCharacters,
    attachmentCount: 2,
    totalBytes:
      (await fs.stat(normal.attachmentImage)).size +
      (await fs.stat(normal.attachmentDocument)).size,
    stagingCleanup: "removed",
  });
  assert.ok(acknowledgedTaskJournal.record.result.deltaCount >= 1);
  assert.ok(acknowledgedTaskJournal.record.result.observedCharacters > 0);
  assert.doesNotMatch(
    acknowledgedTaskJournal.serialized,
    /evidence\.png|notes\.md|README\.md|approved-workspace|attachment document fixture|workspace verification fixture|Bearer|cookie|secret|token/iu,
  );
  assert.equal(
    (await fs.stat(path.dirname(acknowledgedTaskJournal.journalPath))).mode &
      0o777,
    0o700,
  );
  assert.equal(
    (await fs.stat(acknowledgedTaskJournal.journalPath)).mode & 0o777,
    0o600,
  );
  const conversationPath = path.join(
    normal.userData,
    "farol-next-state",
    "chatgpt-conversation",
    "chatgpt-conversation.json",
  );
  const savedConversationText = await fs.readFile(conversationPath, "utf8");
  const savedConversation = JSON.parse(savedConversationText);
  assert.equal(savedConversation.state, "retained");
  assert.equal(savedConversation.conversationUrl, retainedConversationUrl);
  assert.doesNotMatch(
    savedConversationText,
    /evidence\.png|notes\.md|README\.md|approved-workspace|attachment document fixture|workspace verification fixture|Bearer|cookie|secret|token/iu,
  );
  assert.equal(
    (await fs.stat(path.dirname(conversationPath))).mode & 0o777,
    0o700,
  );
  assert.equal((await fs.stat(conversationPath)).mode & 0o777, 0o600);
  await attachmentTaskPage.close();
  await waitForWindowCount(normal.application, 1);
  await waitForShellVisibility(
    normal.application,
    normal.windowMode === "secondary-visible",
    normal.expectedTaskViewCount,
  );
  cases.push(
    "chatgpt-attachment-image-and-document",
    "chatgpt-attachment-staging-cleanup",
    "chatgpt-task-result-delivery-acknowledged",
    "chatgpt-task-journal-content-free",
    "chatgpt-same-conversation-after-window-close",
    "chatgpt-conversation-binding-content-free",
  );
  const settingsPanel = normal.window.locator('[data-panel="settings"]');
  assert.equal(await settingsPanel.locator("#computer-name").count(), 0);
  assert.equal(await settingsPanel.locator("#add-workspace").count(), 0);
  await settingsPanel
    .getByRole("button", { name: "Open Computer", exact: true })
    .click();
  await normal.window.locator('[data-panel="computer"].active').waitFor();
  cases.push("settings-links-to-computer-workspaces");
  await normal.window.locator("#computer-name").fill("Owner Test Mac");
  await normal.window.locator("#save-computer-name").click();
  await normal.window
    .locator("#computer-feedback")
    .getByText("Computer name saved.", { exact: true })
    .waitFor();
  const renamedConfiguration = await normal.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(
    renamedConfiguration.configuration.settings.nativeHosts.codex
      .agentVerification,
    null,
  );
  assert.equal(
    renamedConfiguration.configuration.settings.setup.verify.verified,
    null,
  );
  cases.push("native-agent-proof-invalidated-by-computer-generation");
  await normal.window
    .locator("#computer-workspaces")
    .getByText(/not verified/u)
    .waitFor();
  assert.equal(
    await normal.window
      .locator("#computer-workspaces")
      .getByRole("button", { name: "List root", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await normal.window
      .getByLabel("Search approved-workspace", { exact: true })
      .isDisabled(),
    true,
  );
  await normal.window
    .locator("#computer-workspaces")
    .getByRole("button", { name: "Verify", exact: true })
    .click();
  await normal.window
    .locator("#computer-workspaces")
    .getByText(/read-only · verified/u)
    .waitFor();
  await normal.window
    .locator(".workspace-read-evidence")
    .getByText("Farol Next workspace verification fixture", { exact: true })
    .waitFor();
  assert.match(
    await normal.window.locator("#computer-feedback").innerText(),
    /Read 42 bytes from README\.md\. Nothing from the file was persisted\./u,
  );

  const workspaceCard = normal.window
    .locator("#computer-workspaces .workspace-card")
    .filter({ hasText: "approved-workspace" });
  const listRoot = workspaceCard.getByRole("button", {
    name: "List root",
    exact: true,
  });
  assert.equal(await listRoot.count(), 1);
  await listRoot.click();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText("README.md", { exact: true })
    .waitFor();
  await normal.window
    .locator("#computer-feedback")
    .getByText("Listed 1 entry from the workspace root.", { exact: true })
    .waitFor();

  await workspaceCard
    .getByLabel("Search approved-workspace", { exact: true })
    .fill("verification");
  await workspaceCard
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText("README.md:1", { exact: true })
    .waitFor();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText("Farol Next workspace verification fixture", { exact: true })
    .waitFor();
  await normal.window
    .locator("#computer-feedback")
    .getByText('Found 1 match for "verification".', { exact: true })
    .waitFor();
  cases.push("workspace-app-list-search");

  const workspaceId =
    renamedConfiguration.configuration.settings.computer.workspaces[0]
      .workspaceId;
  const deniedCommand = await normal.window.evaluate(
    async ({ selectedWorkspaceId }) =>
      window.farolNext.configure({
        kind: "computer.run-git-status",
        workspaceId: selectedWorkspaceId,
      }),
    { selectedWorkspaceId: workspaceId },
  );
  assert.equal(deniedCommand.ok, false);
  assert.equal(deniedCommand.error, "WORKSPACE_COMMAND_APPROVAL_REQUIRED");
  const commandPolicy = normal.window.locator("#computer-command-policy");
  await commandPolicy
    .getByText("Off · no command authority is granted", { exact: true })
    .waitFor();
  assert.equal(
    await workspaceCard
      .getByRole("button", { name: "Git status", exact: true })
      .isDisabled(),
    true,
  );
  await commandPolicy
    .getByRole("button", { name: "Enable", exact: true })
    .click();
  await normal.window
    .locator("#computer-feedback")
    .getByText(
      "Fixed no-network Git status and HEAD enabled. Verify the workspace again before use.",
      { exact: true },
    )
    .waitFor();
  await workspaceCard.getByText(/read-only · not verified/u).waitFor();
  assert.equal(
    await workspaceCard
      .getByRole("button", { name: "Git status", exact: true })
      .isDisabled(),
    true,
  );
  await workspaceCard
    .getByRole("button", { name: "Verify", exact: true })
    .click();
  await workspaceCard.getByText(/read-only · verified/u).waitFor();
  const gitStatus = workspaceCard.getByRole("button", {
    name: "Git status",
    exact: true,
  });
  assert.equal(await gitStatus.isEnabled(), true);
  await gitStatus.click();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText(/Git status · exit 0 · \d+ bytes · network none/u)
    .waitFor();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText(/## main/u)
    .waitFor();
  await normal.window
    .locator("#computer-feedback")
    .getByText(
      /^Fixed Git status completed · exit 0 · \d+ bytes · network none\.$/u,
    )
    .waitFor();
  const expectedHeadResult = spawnSync(
    "/usr/bin/xcrun",
    ["git", "-C", normal.workspaceRoot, "rev-parse", "--verify", "HEAD"],
    { encoding: "utf8" },
  );
  assert.equal(expectedHeadResult.status, 0, expectedHeadResult.stderr);
  const gitHead = workspaceCard.getByRole("button", {
    name: "Git HEAD",
    exact: true,
  });
  assert.equal(await gitHead.isEnabled(), true);
  await gitHead.click();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText(/Git HEAD · exit 0 · \d+ bytes · network none/u)
    .waitFor();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText(expectedHeadResult.stdout.trim(), { exact: true })
    .waitFor();
  await normal.window
    .locator("#computer-feedback")
    .getByText(
      /^Fixed Git HEAD completed · exit 0 · \d+ bytes · network none\.$/u,
    )
    .waitFor();
  const commandConfiguration = await normal.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(
    commandConfiguration.configuration.settings.computer.commands,
    "verification",
  );
  cases.push(
    "workspace-command-disabled-by-default",
    "workspace-command-authority-explicit",
    "workspace-command-fixed-no-network",
    "workspace-command-exact-head",
  );

  const exclusionInput = normal.window.getByLabel(
    "Excluded paths for approved-workspace",
    { exact: true },
  );
  await exclusionInput.fill("README.md");
  await normal.window
    .locator("#computer-workspaces")
    .getByRole("button", { name: "Save exclusions", exact: true })
    .click();
  await normal.window
    .locator("#computer-feedback")
    .getByText("approved-workspace exclusions saved and read back.", {
      exact: true,
    })
    .waitFor();
  await normal.window
    .locator("#computer-workspaces")
    .getByRole("button", { name: "Verify", exact: true })
    .click();
  await normal.window
    .locator("#computer-feedback")
    .getByText("Not applied · WORKSPACE_PATH_REFUSED", { exact: true })
    .waitFor();
  assert.equal(
    await normal.window.locator(".workspace-read-evidence").count(),
    0,
  );
  await normal.window
    .getByLabel("Excluded paths for approved-workspace", { exact: true })
    .fill("");
  await normal.window
    .locator("#computer-workspaces")
    .getByRole("button", { name: "Save exclusions", exact: true })
    .click();
  await normal.window
    .locator("#computer-feedback")
    .getByText("approved-workspace exclusions saved and read back.", {
      exact: true,
    })
    .waitFor();
  await normal.window
    .locator("#computer-workspaces")
    .getByRole("button", { name: "Verify", exact: true })
    .click();
  await normal.window
    .locator(".workspace-read-evidence")
    .getByText("Farol Next workspace verification fixture", { exact: true })
    .waitFor();

  await workspaceCard
    .getByRole("button", { name: "Enable edits", exact: true })
    .click();
  await workspaceCard.getByText(/guarded edits · not verified/u).waitFor();
  assert.equal(
    await workspaceCard
      .getByRole("button", { name: "Edit file…", exact: true })
      .isDisabled(),
    true,
  );
  await workspaceCard
    .getByRole("button", { name: "Verify", exact: true })
    .click();
  await workspaceCard.getByText(/guarded edits · verified/u).waitFor();
  await workspaceCard
    .getByRole("button", { name: "Edit file…", exact: true })
    .click();
  const mutationReview = workspaceCard.locator(".workspace-mutation-evidence");
  await mutationReview.getByText(/README\.md · 42 bytes · source/u).waitFor();
  await mutationReview
    .getByLabel("Find exact text in approved-workspace", { exact: true })
    .fill("workspace verification");
  await mutationReview
    .getByLabel("Replacement text for approved-workspace", { exact: true })
    .fill("guarded workspace mutation");
  await mutationReview
    .getByRole("button", { name: "Apply guarded edit", exact: true })
    .click();
  await workspaceCard
    .locator(".workspace-mutation-evidence")
    .getByText(/Edited README\.md · 46 bytes/u)
    .waitFor();
  await normal.window
    .locator("#computer-feedback")
    .getByText("Edited README.md once · durable.", { exact: true })
    .waitFor();
  assert.equal(
    await fs.readFile(normal.workspaceFile, "utf8"),
    "Farol Next guarded workspace mutation fixture\n",
  );
  await workspaceCard
    .getByRole("button", { name: "Git status", exact: true })
    .click();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText(/README\.md/u)
    .waitFor();
  cases.push(
    "workspace-write-access-explicit",
    "workspace-guarded-edit-atomic",
    "workspace-command-observes-real-change",
  );

  await invokeApplicationMenu(normal.application, "app.settings");
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  await normal.window
    .locator("#setting-open-at-launch")
    .selectOption("settings");
  await normal.window.locator("#setting-sidebar-default").selectOption("rail");
  await normal.window
    .locator("#setting-activity-detail")
    .selectOption("technical");
  await normal.window.locator("#apply-general-settings").click();
  await normal.window
    .locator("#settings-feedback")
    .getByText("General settings applied.", { exact: true })
    .waitFor();
  const configuredBootstrap = await normal.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(configuredBootstrap.configuration.status, "ready");
  assert.equal(
    configuredBootstrap.configuration.settings.computer.name,
    "Owner Test Mac",
  );
  assert.deepEqual(configuredBootstrap.configuration.settings.general, {
    openAtLaunch: "settings",
    sidebarDefault: "rail",
    activityDetail: "technical",
  });
  assert.equal(
    configuredBootstrap.configuration.settings.computer.workspaces[0].root,
    normal.workspaceRoot,
  );
  assert.ok(configuredBootstrap.configuration.settings.setup.computer.verified);
  await normal.window.locator("#diagnostics-group").evaluate((element) => {
    element.open = true;
  });
  await normal.window
    .getByRole("button", { name: "Export support…", exact: true })
    .click();
  await normal.window
    .locator("#settings-feedback")
    .getByText(/^Saved Farol-Next-Support\.json · \d+ bytes · [a-f0-9]{12}\.$/u)
    .waitFor();
  const supportExportText = await fs.readFile(normal.supportExport, "utf8");
  const supportExport = JSON.parse(supportExportText);
  assert.equal(supportExport.schema, 2);
  assert.equal(supportExport.kind, "farol_next_support");
  assert.equal(supportExport.build.buildId, buildIdentity.buildId);
  assert.equal(supportExport.build.sourceCommit, buildIdentity.sourceCommit);
  assert.equal(supportExport.configuration.status, "ready");
  assert.equal(supportExport.configuration.computer.workspaceCount, 1);
  assert.equal(supportExport.configuration.computer.writeWorkspaceCount, 1);
  assert.equal(supportExport.nativeAgentVerification.status, "needs_action");
  assert.equal(supportExport.nativeAgentVerification.evidence, null);
  assert.equal(supportExport.tasks.total, 2);
  assert.equal((await fs.stat(normal.supportExport)).mode & 0o777, 0o600);
  assert.doesNotMatch(
    supportExportText,
    /Owner Test Mac|approved-workspace|guarded workspace mutation|workspace verification fixture/u,
  );
  assert.doesNotMatch(
    supportExportText,
    /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|Bearer|token|cookie|prompt|answer/u,
  );
  assert.doesNotMatch(supportExportText, new RegExp(normal.workspaceRoot, "u"));
  assert.doesNotMatch(supportExportText, new RegExp(normal.codexFixture, "u"));
  cases.push(
    "support-export-content-free",
    "support-export-native-agent-state-current",
  );
  await normal.window.keyboard.press("Meta+3");
  await normal.window.locator('[data-panel="activity"].active').waitFor();
  await normal.window
    .locator("#activity-list")
    .getByText("Client delivery acknowledged", { exact: true })
    .first()
    .waitFor();
  await invokeApplicationMenu(normal.application, "app.settings");
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "settings-compact.png"),
  });
  await normal.window.locator("#review-setup").click();
  const reviewedSetup = normal.window.locator("#setup-dialog");
  await reviewedSetup.waitFor({ state: "visible" });
  assert.equal(await reviewedSetup.getAttribute("data-mode"), "review");
  assert.equal(await reviewedSetup.getAttribute("data-step-id"), "verify");
  await normal.window.screenshot({
    path: path.join(evidenceRoot, "setup-review-compact.png"),
  });
  await normal.window.locator("#setup-close").click();
  await reviewedSetup.waitFor({ state: "hidden" });

  await normal.window.keyboard.press("Meta+1");
  let nativeFocusBlockReason = null;
  if (nativeWindowProofAvailable) {
    await setWindowSize(normal.application, 1180, 760);
    await normal.window.waitForFunction(
      () => document.documentElement.dataset.sidebar === "rail",
    );
    await invokeApplicationMenu(normal.application, "view.toggle-sidebar");
    await normal.window.waitForFunction(
      () => document.documentElement.dataset.sidebar === "full",
    );
    let activatedWindow = null;
    try {
      activatedWindow = await activateForNativeFocusProof(normal.application);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("E2E_NATIVE_WINDOW_FOCUS_TIMEOUT:")
      ) {
        throw error;
      }
      nativeFocusBlockReason = error.message;
    }

    if (activatedWindow) {
      await normal.window.waitForFunction(
        () => document.documentElement.dataset.windowActive === "true",
      );
      assert.equal(activatedWindow.focused, true);

      await sendKeyFromTask(normal.application, "task-atlantic", "K", ["meta"]);
      await normal.window
        .locator("#command-dialog")
        .waitFor({ state: "visible" });
      await waitForShellFocus(
        normal.application,
        "quick switcher receives native focus",
      );
      let focusTransfer = await taskSurfaces(normal.application);
      assert.equal(
        focusTransfer.find(
          (surface) => surface.state.taskId === "task-atlantic",
        )?.hostVisible,
        false,
      );
      await normal.window.keyboard.press("Escape");
      await normal.window
        .locator("#command-dialog")
        .waitFor({ state: "hidden" });
      await waitForTaskSurface(
        normal.application,
        "task-atlantic",
        (surface) => surface.hostVisible === true && surface.focused === true,
        "Escape transfers focus from quick switcher to native Browser",
      );

      await invokeApplicationMenu(normal.application, "view.toggle-sidebar");
      await normal.window.waitForFunction(
        () => document.documentElement.dataset.sidebar === "rail",
      );
      await setFullScreen(normal.application, true);
      await normal.window.waitForFunction(
        () => document.documentElement.dataset.fullScreen === "true",
      );
      const fullScreenGeometry = await watchRailGeometry(normal.window);
      assert.equal(fullScreenGeometry.sidebar.width, 72);
      if (process.platform === "darwin")
        assert.equal(fullScreenGeometry.toggle.x, 14);
      const fullScreenSurface = await waitForTaskSurface(
        normal.application,
        "task-atlantic",
        (surface) =>
          surface.hostVisible === true && surface.hostBounds?.x === 72,
        "fullscreen rail keeps native Browser aligned",
      );
      assert.equal(fullScreenSurface.hostBounds.y, 178);
      await normal.window.screenshot({
        path: path.join(evidenceRoot, "watch-fullscreen-rail.png"),
      });
      await setFullScreen(normal.application, false);
      await normal.window.waitForFunction(
        () => document.documentElement.dataset.fullScreen === "false",
      );
      if (process.platform === "darwin") {
        assert.equal((await watchRailGeometry(normal.window)).toggle.x, 75);
        assert.deepEqual(
          (await nativeWindowChrome(normal.application)).trafficLightPosition,
          { x: 14, y: 18 },
        );
      }
      await invokeApplicationMenu(normal.application, "view.toggle-sidebar");
      await normal.window.waitForFunction(
        () => document.documentElement.dataset.sidebar === "full",
      );
      const restoredWindow = await activateForNativeFocusProof(
        normal.application,
      );
      assert.equal(restoredWindow.focused, true);

      await sendShortcutFromTask(normal.application, "task-atlantic");
      await normal.window
        .locator('[data-task-id="task-harbor"][aria-selected="true"]')
        .waitFor();
      await waitForTaskSurface(
        normal.application,
        "task-harbor",
        (surface) => surface.hostVisible === true && surface.focused === true,
        "Control+Tab transfers focus to the next native Browser",
      );
      let focused = await taskSurfaces(normal.application);
      assert.equal(
        focused.find((surface) => surface.state.taskId === "task-harbor")
          ?.focused,
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
      await waitForTaskSurface(
        normal.application,
        "task-atlantic",
        (surface) => surface.hostVisible === true && surface.focused === true,
        "reverse Control+Tab transfers focus to the previous native Browser",
      );
      focused = await taskSurfaces(normal.application);
      assert.equal(
        focused.find((surface) => surface.state.taskId === "task-atlantic")
          ?.focused,
        true,
      );
      assert.equal(
        focused.find((surface) => surface.state.taskId === "task-harbor")
          ?.focused,
        false,
      );

      focusTransfer = await taskSurfaces(normal.application);
      assert.equal(
        focusTransfer.find(
          (surface) => surface.state.taskId === "task-atlantic",
        )?.hostVisible,
        true,
      );
      cases.push(
        "keyboard-focus",
        "quick-switcher-native-focus-transfer",
        "traffic-light-and-fullscreen-geometry",
      );
      nativeFocusProofCompleted = true;
    }
  }

  if (!nativeFocusProofCompleted) {
    if (skipNativeFocus) {
      nativeFocusBlockReason = "native focus was not authorized for this run";
    } else if (!nativeWindowProofAvailable) {
      assert.equal(process.platform, "darwin");
      assert.equal(
        (await nativeWindowChrome(normal.application)).focused,
        false,
      );
      nativeFocusBlockReason = "macOS host is locked";
    }
    assert.ok(nativeFocusBlockReason, "E2E_NATIVE_FOCUS_BLOCK_REASON_MISSING");
    blockedCases.push(
      {
        name: "keyboard-focus",
        reason: nativeFocusBlockReason,
      },
      {
        name: "quick-switcher-native-focus-transfer",
        reason: nativeFocusBlockReason,
      },
      {
        name: "traffic-light-and-fullscreen-geometry",
        reason: nativeFocusBlockReason,
      },
    );
  }

  const runtimeBeforeWindowClose = await runtimeProcessId(normal.application);
  await normal.window.close();
  await waitForWindowCount(normal.application, 0);
  assert.equal(
    await runtimeProcessId(normal.application),
    runtimeBeforeWindowClose,
  );
  await rejectMismatchedBuildLaunch(normal);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitForWindowCount(normal.application, 0);
  const reopenedWindow = normal.application.waitForEvent("window", {
    timeout: 15_000,
  });
  repeatLaunch(normal);
  normal.window = await reopenedWindow;
  await normal.window.locator("#sidebar").waitFor({ state: "visible" });
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  await waitForWindowPresentation(normal.application, normal.windowMode);
  const reopenedBootstrap = await normal.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(reopenedBootstrap.runtimeState, "ready");
  assert.equal(reopenedBootstrap.runtimeIdentity, "farol-next-preview-runtime");
  assert.equal((await taskSurfaces(normal.application)).length, 2);
  assert.equal(
    await runtimeProcessId(normal.application),
    runtimeBeforeWindowClose,
  );
  assert.equal(
    await normal.application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  await restart(normal);
  await normal.window.locator("#setup-dialog").waitFor({ state: "hidden" });
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  await normal.window.waitForFunction(
    () => document.documentElement.dataset.sidebar === "rail",
  );
  const restartedBootstrap = await normal.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(restartedBootstrap.configuration.status, "ready");
  assert.equal(restartedBootstrap.chatgptConversationState, "retained");
  const restartedSettings = restartedBootstrap.configuration.settings;
  assert.equal(restartedSettings.computer.name, "Owner Test Mac");
  assert.deepEqual(restartedSettings.general, {
    openAtLaunch: "settings",
    sidebarDefault: "rail",
    activityDetail: "technical",
  });
  assert.equal(restartedSettings.computer.workspaces.length, 1);
  assert.equal(
    restartedSettings.computer.workspaces[0].root,
    normal.workspaceRoot,
  );
  assert.equal(restartedSettings.computer.workspaces[0].access, "write");
  assert.equal(
    restartedSettings.setup.computer.verified.workspaceId,
    restartedSettings.computer.workspaces[0].workspaceId,
  );
  assert.equal(
    restartedSettings.setup.computer.verified.configRevision,
    restartedSettings.computer.generation,
  );
  assert.equal(
    restartedSettings.setup.computer.verified.profile,
    "computer.local.write/1",
  );
  assert.equal(
    restartedSettings.setup.chatgpt.verified.profile,
    "chatgpt.next-partition/1",
  );
  assert.equal(
    restartedSettings.nativeHosts.codex.executablePath,
    normal.codexFixture,
  );
  assert.equal(restartedSettings.nativeHosts.codex.version, "9.8.7-e2e");
  assert.equal(
    restartedSettings.nativeHosts.codex.liveVerification.model,
    "gpt-6-astra",
  );
  assert.equal(
    restartedSettings.setup.hosts.verified.configRevision,
    restartedSettings.nativeHosts.generation,
  );
  assert.equal(restartedSettings.computer.commands, "verification");
  await normal.window
    .locator('[data-panel="settings"]')
    .getByRole("button", { name: "Open Computer", exact: true })
    .click();
  await normal.window.locator('[data-panel="computer"].active').waitFor();
  const restartedWorkspaceCard = normal.window
    .locator("#computer-workspaces .workspace-card")
    .filter({ hasText: "approved-workspace" });
  const restartedGitStatus = restartedWorkspaceCard.getByRole("button", {
    name: "Git status",
    exact: true,
  });
  assert.equal(await restartedGitStatus.isEnabled(), true);
  await restartedGitStatus.click();
  await restartedWorkspaceCard
    .locator(".workspace-query-evidence")
    .getByText(/README\.md/u)
    .waitFor();
  await invokeApplicationMenu(normal.application, "app.settings");
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  cases.push("workspace-command-persists-and-runs-after-restart");
  await normal.window
    .locator("#connection-readiness")
    .getByRole("button", { name: "Open sign-in…", exact: true })
    .waitFor();
  const restartedChatGptWindow = normal.application.waitForEvent("window", {
    timeout: 15_000,
  });
  await normal.window
    .locator("#connection-readiness")
    .getByRole("button", { name: "Open sign-in…", exact: true })
    .click();
  const restartedChatGptPage = await restartedChatGptWindow;
  await restartedChatGptPage.waitForURL(retainedConversationUrl);
  await waitForWindowCount(normal.application, 2);
  await restartedChatGptPage.locator("#prompt-textarea").waitFor({
    state: "visible",
  });
  assert.equal(
    await restartedChatGptPage.locator('[data-testid="login-button"]').count(),
    1,
  );
  assert.equal(
    await restartedChatGptPage
      .locator('[data-testid="login-button"]')
      .isHidden(),
    true,
  );
  await normal.window
    .locator("#connection-readiness")
    .getByRole("button", { name: "Recheck", exact: true })
    .click();
  await normal.window
    .locator("#settings-feedback")
    .getByText("ChatGPT composer verified in the isolated Next partition.", {
      exact: true,
    })
    .waitFor();
  await restartedChatGptPage.close();
  await waitForWindowCount(normal.application, 1);
  await waitForShellVisibility(
    normal.application,
    normal.windowMode === "secondary-visible",
    normal.expectedTaskViewCount,
  );
  await normal.window
    .locator("#connection-readiness")
    .getByRole("button", { name: "Start fresh chat", exact: true })
    .click();
  await normal.window
    .locator("#settings-feedback")
    .getByText(
      "Retained conversation binding cleared. The next task starts a fresh isolated ChatGPT conversation.",
      { exact: true },
    )
    .waitFor();
  await assert.rejects(fs.stat(conversationPath), { code: "ENOENT" });
  const resetChatGptWindow = normal.application.waitForEvent("window", {
    timeout: 15_000,
  });
  await normal.window
    .locator("#connection-readiness")
    .getByRole("button", { name: "Open sign-in…", exact: true })
    .click();
  const resetChatGptPage = await resetChatGptWindow;
  await resetChatGptPage.waitForURL(normal.chatGptFixture.url);
  await resetChatGptPage.close();
  await waitForWindowCount(normal.application, 1);
  cases.push(
    "chatgpt-same-conversation-after-process-restart",
    "chatgpt-explicit-conversation-reset",
  );
  assert.deepEqual(restartedSettings.setup.journey, {
    currentStep: "verify",
    dismissed: true,
  });
  const settingsRoot = path.join(normal.userData, "farol-next-state");
  const settingsPath = path.join(settingsRoot, "product-settings.json");
  assert.equal((await fs.stat(settingsRoot)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(settingsPath)).mode & 0o777, 0o600);
  const savedSettings = await fs.readFile(settingsPath, "utf8");
  assert.match(savedSettings, /"commands": "verification"/u);
  assert.doesNotMatch(savedSettings, /workspace verification fixture/u);
  assert.doesNotMatch(savedSettings, /Bearer|token|cookie|secret/u);
  const mutationRoot = path.join(settingsRoot, "workspace-mutations");
  const mutationFiles = await fs.readdir(path.join(mutationRoot, "mutations"));
  assert.equal(mutationFiles.length, 1);
  const savedMutation = await fs.readFile(
    path.join(mutationRoot, "mutations", mutationFiles[0]),
    "utf8",
  );
  assert.doesNotMatch(
    savedMutation,
    /workspace verification|guarded workspace mutation/u,
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
    "watch-rail-native-geometry",
    "sidebar-native-menu-and-shortcut",
    "settings-native-menu-and-global-chrome",
    "rail-hit-targets-and-titlebar-clearance",
    "compact-sidebar-overlay-hides-native-page",
    "task-menu-hides-native-page",
    "quick-switcher-keyboard-navigation",
    "inactive-window-appearance",
    "geist-resource-loaded",
    "setup-hides-native-page",
    "activity-redaction",
    "activity-detail-preference",
    "compact-layout",
    "stable-layout-geometry",
    "client-delivery-acknowledged",
    "first-run-setup-journey",
    "settings-setup-reentry",
    "native-workspace-picker-save-readback",
    "workspace-native-verification",
    "workspace-read-preview-not-persisted",
    "workspace-exclusion-effective",
    "settings-controls-persist-after-restart",
    "setup-position-and-dismissal-persist",
    "chatgpt-next-partition-readiness",
    "chatgpt-popup-and-expiry-recovery",
    "chatgpt-session-persists-after-restart",
    "mismatched-build-second-launch-rejected",
    "second-launch-reuses-single-instance",
    "window-close-reopen-keeps-runtime",
    "window-reopen-restores-runtime-connection",
  );
} finally {
  await close(normal);
}

const legacyFirst = await startLegacyAppFixture();
try {
  await probeLegacyAppFixture(legacyFirst);
  const nextAfterLegacy = await launch();
  try {
    await probeLegacyAppFixture(legacyFirst);
    assert.ok((await runtimeProcessId(nextAfterLegacy.application)) > 0);
  } finally {
    await close(nextAfterLegacy);
  }
  await probeLegacyAppFixture(legacyFirst);
  cases.push("isolated-start-order-legacy-then-next");
} finally {
  await closeLegacyAppFixture(legacyFirst);
}

const failed = await launch(["--preview-failure"]);
try {
  await completeSetup(failed);
  await failed.window
    .locator('[data-task-id="task-atlantic"] small')
    .getByText("Needs attention")
    .waitFor();
  assert.equal(await failed.window.locator("#finish-demo").isDisabled(), true);
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
  await streamFailure.window.locator("#finish-demo").click();
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
let nextFirstLegacy = null;
try {
  await completeSetup(processDeath);
  nextFirstLegacy = await startLegacyAppFixture();
  await probeLegacyAppFixture(nextFirstLegacy);
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
    ({ BrowserWindow }) => {
      const shell = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return (
          candidate.getTitle() === "Farol Next Preview" &&
          url.startsWith("file:") &&
          url.endsWith("/shell.html")
        );
      });
      return (shell?.contentView.children ?? []).filter(
        (view) => "webContents" in view,
      ).length;
    },
  );
  assert.equal(remainingTaskViews, 0);
  await processDeath.window.screenshot({
    path: path.join(evidenceRoot, "process-death-wide.png"),
  });
  await setWindowSize(processDeath.application, 700, 600);
  assert.equal(processDeath.window.isClosed(), false);
  await probeLegacyAppFixture(nextFirstLegacy);
  await processDeath.window.screenshot({
    path: path.join(evidenceRoot, "process-death-compact.png"),
  });
  cases.push(
    "utility-process-sigkill-state",
    "isolated-start-order-next-then-legacy",
    "next-only-failure-preserves-legacy-fixture",
  );
} finally {
  if (nextFirstLegacy) await closeLegacyAppFixture(nextFirstLegacy);
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
assert.ok(quitProofs >= 8, `E2E_QUIT_PROOF_INCOMPLETE:${quitProofs}`);
cases.push("quit-terminates-exact-owned-processes");

const repeatedCaseIds = cases.filter(
  (caseId, index) => cases.indexOf(caseId) !== index,
);
assert.deepEqual(
  repeatedCaseIds,
  [],
  `E2E_CASE_IDS_NOT_UNIQUE:${[...new Set(repeatedCaseIds)].join(",")}`,
);

// The declared cases, not the ones this run happened to record, decide
// whether the run is complete: a case neither executed nor explicitly blocked
// makes the run FAIL whatever else passed.
const missingRequiredCases = missingCases(
  development ? "development-build" : "sealed-package",
  cases,
  blockedCases,
);
if (missingRequiredCases.length > 0) {
  evidenceAttempt.recordFailure(
    "contract",
    `E2E_REQUIRED_CASE_MISSING:${missingRequiredCases.join(",")}`,
  );
}
const report = {
  schema: 1,
  status:
    missingRequiredCases.length > 0
      ? "FAIL"
      : blockedCases.length > 0
        ? "BLOCKED"
        : "PASS",
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
      nativeFocusProof: nativeFocusProofCompleted
        ? "bounded-final-active-phase"
        : skipNativeFocus
          ? "blocked-owner-authorization"
          : macHostLockState === "locked"
            ? "blocked-host-locked"
            : "blocked-focus-acquisition",
      nativeFocusRequested: !skipNativeFocus,
      macHostLockState,
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
  caseCount: cases.length,
  uniqueCaseCount: new Set(cases).size,
  cases,
  blockedCases,
  skippedCases,
  screenshots: [
    "live-task-watch-rail-wide.png",
    "live-task-watch-rail-compact.png",
    "running-browser-view.png",
    "running-browser-compact.png",
    "watch-sidebar-overlay-compact.png",
    "watch-task-menu-wide.png",
    "watch-quick-switcher-wide.png",
    ...(nativeFocusProofCompleted ? ["watch-fullscreen-rail.png"] : []),
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
await evidenceAttempt.finish(report.status, {
  cases,
  blockedCases,
  skippedCases,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (missingRequiredCases.length > 0) {
  process.stderr.write(
    `E2E_REQUIRED_CASE_MISSING:${JSON.stringify(missingRequiredCases)}\n`,
  );
  process.exitCode = 1;
}
if (blockedCases.length > 0) {
  process.stderr.write(
    `E2E_REQUIRED_CASES_BLOCKED:${JSON.stringify(blockedCases)}\n`,
  );
  process.exitCode = 1;
}
