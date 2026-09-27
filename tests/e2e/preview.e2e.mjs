import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { _electron as electron } from "playwright-core";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { openEvidenceAttempt } from "../../tooling/evidence-attempt.mjs";
import { processTable } from "../../tooling/evidence-observe.mjs";
import { createPhaseRecorder } from "./await-phases.mjs";
import {
  blockingObservations as blockingObservationsOf,
  laneContract,
  missingCases,
} from "../../tooling/evidence-cases.mjs";
import {
  createSelection,
  isSegmentSelected,
  shouldRunDevelopmentSegment,
} from "../../tooling/e2e-selection.mjs";
import { retentionDiagnostics } from "../../tooling/soak-retention.mjs";
import {
  assertBuildIdentity,
  createBuildIdentity,
} from "../../tooling/build-identity-contract.mjs";
import { parseOwnerLaunchResult } from "../../tooling/owner-launch-result.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";
import { predecessorPackagePaths } from "./predecessor-package-path.mjs";

const root = process.cwd();
const development = process.argv.includes("--development");
const lifecycleSoak = process.argv.includes("--lifecycle-soak");
const persistenceFault = process.argv.includes("--persistence-fault");
const twoGenerationState = process.argv.includes("--two-generation-state");
const skipNativeFocus = process.argv.includes("--skip-native-focus");
// AGENTS.md (commit 6cbe53fd): an owner-handed overnight run with no second
// display may use the built-in display, shown inactive only for the proof.
// This flag is the sole way in; its absence leaves every topology outcome
// below unchanged.
const allowPrimaryDisplay = process.argv.includes("--allow-primary-display");
const builtInDisplayOnly = process.argv.includes("--built-in-display-only");
// The soak workload is seeded. The default seed reproduces the historical
// run exactly; another seed moves the two restarts and flips the overlay
// order, so a declared series can show the bounds hold across interleavings
// rather than for one lucky sequence. An optional idle pause adds an
// idle-to-busy transition at a seeded batch.
function integerOption(name, fallback, maximum) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix));
  if (raw === undefined) return fallback;
  const value = Number(raw.slice(prefix.length));
  assert.ok(
    Number.isSafeInteger(value) && value >= 0 && value <= maximum,
    `E2E_INVALID_OPTION:${name}`,
  );
  return value;
}
const soakSeed = integerOption("soak-seed", 260_917, 2 ** 31 - 1);
const soakIdleMs = integerOption("soak-idle-ms", 0, 120_000);

// Targeted repro: `--only=<selector>[,<selector>…]` runs only the lane
// segments a selector names; tooling/e2e-selection.mjs owns the map and
// rejects a selector that matches nothing.  A selected run is reported as
// SELECTED and never PASS, so it can neither be bound as evidence nor stand
// in for a lane's required cases.
const selection = createSelection(process.argv);
const selectionActive = selection !== null;
const segmentSelected = (name) => isSegmentSelected(selection, name);
async function assertSameFixtureExecutable(actual, expected) {
  assert.equal(await fs.realpath(actual), await fs.realpath(expected));
}
// Each special lane drives one declared workload end to end, so combining it
// with a partial selection would name an attempt after more than it ran.
assert.equal(
  selectionActive && (lifecycleSoak || persistenceFault || twoGenerationState),
  false,
  "E2E_SELECTION_EXCLUSIVE_WITH_SPECIAL_LANE",
);
assert.ok(
  [lifecycleSoak, persistenceFault, twoGenerationState].filter(Boolean)
    .length <= 1,
  "E2E_EXCLUSIVE_SPECIAL_MODE",
);
// The two-generation lane compares two sealed packages: the predecessor a
// manifest names, qualified by the verifier pinned at its own commit, and the
// current candidate. A development build is not a generation.
assert.equal(
  twoGenerationState && development,
  false,
  "E2E_TWO_GENERATION_REQUIRES_SEALED_PACKAGES",
);
const predecessorArtifactOption = process.argv
  .find((value) => value.startsWith("--predecessor-artifact="))
  ?.slice("--predecessor-artifact=".length);
assert.equal(
  twoGenerationState,
  typeof predecessorArtifactOption === "string" &&
    path.isAbsolute(predecessorArtifactOption),
  "E2E_PREDECESSOR_ARTIFACT_OPTION",
);
// The soak lane is named by the bytes it drives: the development build or
// the sealed package, never one presented as the other.
const evidenceLane = lifecycleSoak
  ? development
    ? "lifecycle-soak"
    : "lifecycle-soak-packaged"
  : persistenceFault
    ? "persistence-fault"
    : twoGenerationState
      ? "two-generation-state"
      : development
        ? "development-build"
        : "sealed-package";
// The production route is default-off. Keep the positive journey in source
// for a separately qualified Agent build, but never run it as evidence for
// this build or enable the route from the harness.
const positiveProductAgentQualification = false;
const evidenceLaneRoot = path.join(
  root,
  lifecycleSoak
    ? development
      ? "_output/evidence/lifecycle-soak"
      : "_output/evidence/lifecycle-soak-packaged"
    : persistenceFault
      ? "_output/evidence/persistence-fault"
      : twoGenerationState
        ? "_output/evidence/two-generation-state"
        : development
          ? "_output/evidence/e2e-dev"
          : "_output/evidence/e2e",
);
const metadataPath = path.join(root, "_output/package/artifact.json");
const canonicalPackagePath = path.join(
  root,
  "_output/package/Farol Next Preview.app",
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

const expectedSource = sourceIdentity(root);
assert.equal(expectedSource.dirty, false, "E2E_SOURCE_NOT_HEAD_EXACT");
let artifact;
let buildIdentity;
let appPath;
let executable;
let launchPrefix = [];
if (development) {
  const buildRoot = path.join(root, "_output/build/app");
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

// The predecessor is identified by its own manifest and qualified by the
// verifier pinned at its own source commit, run where that verifier expects
// it: the checkout the manifest names. Every file of that commit's tooling
// and package manifests must be byte-identical there, so the verifier that
// runs is exactly the predecessor's, never this candidate's.
async function resolvePredecessor(artifactFile) {
  const manifest = JSON.parse(await fs.readFile(artifactFile, "utf8"));
  assert.equal(manifest.schema, 5, "E2E_PREDECESSOR_MANIFEST_SCHEMA");
  assert.equal(manifest.sourceDirty, false, "E2E_PREDECESSOR_DIRTY");
  assert.ok(
    typeof manifest.artifactPath === "string" &&
      path.isAbsolute(manifest.artifactPath),
    "E2E_PREDECESSOR_PATH_INVALID",
  );
  const { checkoutRoot: predecessorRoot } = predecessorPackagePaths(
    artifactFile,
    manifest.artifactPath,
  );
  assert.notEqual(manifest.sourceCommit, artifact.sourceCommit);
  assert.notEqual(manifest.buildId, artifact.buildId);
  assert.notEqual(manifest.artifactSha256, artifact.artifactSha256);
  const pinned = spawnSync(
    "git",
    [
      "-C",
      predecessorRoot,
      "ls-tree",
      "-r",
      manifest.sourceCommit,
      "--",
      "tooling",
      "package.json",
      "package-lock.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(pinned.status, 0, pinned.stderr);
  const entries = pinned.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [meta, name] = line.split("\t");
      const [, type, object] = meta.split(" ");
      return { type, object, name };
    });
  assert.ok(
    entries.length > 0 && entries.every((entry) => entry.type === "blob"),
    "E2E_PREDECESSOR_VERIFIER_TREE_INVALID",
  );
  for (const entry of entries) {
    const actual = spawnSync(
      "git",
      ["-C", predecessorRoot, "hash-object", "--", entry.name],
      { encoding: "utf8" },
    );
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(
      actual.stdout.trim(),
      entry.object,
      `E2E_PREDECESSOR_VERIFIER_NOT_PINNED:${entry.name}`,
    );
  }
  const verified = spawnSync(
    process.execPath,
    [path.join(predecessorRoot, "tooling/verify-package.mjs")],
    { cwd: predecessorRoot, encoding: "utf8" },
  );
  assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
  assert.ok(
    verified.stdout.includes(
      ` ${manifest.artifactSha256} (clean) at ${manifest.artifactPath}`,
    ),
    `E2E_PREDECESSOR_NOT_VERIFIED:${verified.stdout}`,
  );
  return {
    sourceCommit: manifest.sourceCommit,
    sourceTreeDigest: manifest.sourceTreeDigest,
    artifactSha256: manifest.artifactSha256,
    buildId: manifest.buildId,
    builtAt: manifest.builtAt,
    appPath: manifest.artifactPath,
    executable: path.join(
      manifest.artifactPath,
      "Contents/MacOS/Farol Next Preview",
    ),
    verifier: {
      root: predecessorRoot,
      pinnedFiles: entries.length,
      output: verified.stdout.trim(),
    },
  };
}

const predecessor = twoGenerationState
  ? await resolvePredecessor(path.resolve(predecessorArtifactOption))
  : null;
// Every run writes into its own immutable attempt directory under the lane
// root; a later or crashed run never removes an earlier run's evidence.
// Who else is watching this lane when it starts. An effect observer is a
// separate process the contour starts, so the runner cannot be told about
// it — but it can look, once, and record what it saw. An observer that
// exits 143 without a receipt is then attributable to a pid that was
// demonstrably attached at this moment, instead of to an assumption.
function attachedObservers() {
  try {
    return processTable()
      .split("\n")
      .filter((line) => /evidence-observe\.mjs/u.test(line))
      .map((line) => {
        const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
        return {
          pid: match ? Number(match[1]) : null,
          command: (match ? match[2] : line).slice(0, 240),
        };
      });
  } catch (error) {
    return [{ pid: null, command: `UNREADABLE:${error?.code ?? "error"}` }];
  }
}
const observersAtStart = attachedObservers();
const evidenceAttempt = await openEvidenceAttempt(evidenceLaneRoot, {
  lane: evidenceLane,
  input: {
    runner: { pid: process.pid, ppid: process.ppid },
    observers: observersAtStart,
    sourceCommit: artifact.sourceCommit,
    sourceTreeDigest: artifact.sourceTreeDigest,
    sourceDirty: artifact.sourceDirty,
    artifactSha256: artifact.artifactSha256,
    buildId: artifact.buildId,
    builtAt: artifact.builtAt,
    skipNativeFocus,
    // A selected run is only partial, and `report.json` — where the
    // selection is recorded in full — is written at the very end.  A run
    // that crashes first would leave receipts indistinguishable from a
    // failed full lane, which is the one reading the SELECTED status exists
    // to prevent.  The attempt's input is written when it opens, so putting
    // the selection here makes it survive any later failure.  Extra input
    // keys are inert to the rebind, which matches only on the subject's own.
    ...(selection ? { selection } : {}),
    ...(predecessor
      ? {
          predecessor: {
            sourceCommit: predecessor.sourceCommit,
            sourceTreeDigest: predecessor.sourceTreeDigest,
            artifactSha256: predecessor.artifactSha256,
            buildId: predecessor.buildId,
            builtAt: predecessor.builtAt,
          },
        }
      : {}),
  },
});
evidenceAttempt.installProcessHandlers();
const evidenceRoot = evidenceAttempt.directory;

// One budget THROUGH each awaited boundary of an instance's lifecycle, and
// one line per boundary in the lane's own stdout and in the attempt's
// phase.log. See tests/e2e/await-phases.mjs for why a deadline read after
// the await returns is not the same thing.
//
// These budgets are an outer bound, never a replacement: `electron.launch`
// and `firstWindow` keep their own 15 s timeouts, every Playwright wait
// keeps its own, and `repeatLaunch` keeps its SIGKILL deadline. Each budget
// is far above the slowest value measured on a healthy run of this machine
// (launch and restart boundaries under 2 s, the whole of completeSetup
// under 4 s), so a budget that fires means an await that was never going to
// return.
const LAUNCH_PHASE_BUDGET_MS = 60_000;
const SETUP_PHASE_BUDGET_MS = 120_000;
const CLOSE_PHASE_BUDGET_MS = 60_000;
const phaseLogPath = path.join(evidenceRoot, "phase.log");
const phases = createPhaseRecorder({
  sink: (line) => {
    process.stdout.write(`${line}\n`);
    fsSync.appendFileSync(phaseLogPath, `${line}\n`, { mode: 0o600 });
  },
});
evidenceAttempt.trackPhases(() => phases.snapshot());
phases.note(
  "attempt.observers",
  JSON.stringify({ attempt: evidenceAttempt.attemptId, observersAtStart }),
);

const cases = [];
const skippedCases = [];
const blockedCases = [];
// An application that is already gone cannot answer for its window.  That is
// a different failure from a window in the wrong place and must not be
// reported as one, nor be allowed to replace the real first failure by
// throwing out of a `finally`.  Each one is recorded with the case that owned
// the instance, so "the product exited early" stays distinguishable from "the
// harness raced its own close".
const harnessObservations = [];
// The runner accumulates its case list as it goes and only serialises it at
// the very end.  A late exception therefore used to produce a terminal
// receipt with no cases at all, losing every journey the run had actually
// driven.  The attempt reads the live lists instead, so an interrupted run
// still reports what it executed.
evidenceAttempt.trackRecords(() => ({
  cases,
  blockedCases,
  skippedCases,
}));
let nativeFocusProofCompleted = false;
// Every sample the focus-acquisition loop takes, kept whole. The loop's own
// decision is unchanged; this is what a blocked row can be read from
// afterwards instead of the one summary line the error carried.
const nativeFocusSamples = [];
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
  const nonPrimarySelected =
    displays.find((display) => !display.primary && display.internal) ??
    (builtInDisplayOnly
      ? undefined
      : displays.find((display) => !display.primary));
  let selected = nonPrimarySelected;
  let ownerAllowedPrimary = false;
  if (!selected) {
    const primary = displays.find((display) => display.primary);
    if (!allowPrimaryDisplay || !primary?.internal) {
      return {
        code: builtInDisplayOnly
          ? "BUILT_IN_DISPLAY_UNAVAILABLE"
          : "SECONDARY_DISPLAY_UNAVAILABLE",
        reason: builtInDisplayOnly
          ? "no authorized built-in display is available for visible native evidence"
          : "no non-primary display is available for visible native evidence",
        ownerAction: builtInDisplayOnly
          ? "Make the built-in display available with at least 1180x760 work area, then rerun this exact lane."
          : "Provide one non-primary display with at least 1180x760 available work area, then rerun this exact lane.",
        requested,
        selectedDisplay: null,
        allowedPrimaryDisplay: false,
      };
    }
    // Explicit owner allowance and no non-primary display: fall back to the
    // built-in primary display (AGENTS.md, commit 6cbe53fd). The window still
    // must never take focus; assertVisibleWindowPlacement enforces that.
    selected = primary;
    ownerAllowedPrimary = true;
  }
  if (
    selected.workArea.width < requested.width ||
    selected.workArea.height < requested.height
  ) {
    return {
      code: "VISIBLE_TEST_VIEWPORT_UNAVAILABLE",
      reason: ownerAllowedPrimary
        ? "the owner-allowed built-in primary display cannot preserve the exact visible test viewport"
        : "the selected non-primary display cannot preserve the exact visible test viewport",
      ownerAction: ownerAllowedPrimary
        ? "Provide a built-in display with at least 1180x760 available work area, then rerun this exact lane."
        : "Provide a non-primary display with at least 1180x760 available work area, then rerun this exact lane.",
      requested,
      selectedDisplay: selected,
      allowedPrimaryDisplay: ownerAllowedPrimary,
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
    productAgentQualification:
      laneContract(evidenceLane).productAgentQualification,
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
        allowedPrimaryDisplay: topologyBlock.allowedPrimaryDisplay,
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
    productAgentQualification: report.productAgentQualification,
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
        ["Farol · Developer Preview", "Farol Dev · Development"].includes(
          candidate.getTitle(),
        ) &&
        url.startsWith("file:") &&
        url.endsWith("/shell.html")
      );
    });
    if (!targetWindow) {
      const windows = BrowserWindow.getAllWindows().map((candidate) => ({
        title: candidate.getTitle(),
        url: candidate.webContents.getURL(),
      }));
      throw new Error("E2E_WINDOW_MISSING:" + JSON.stringify(windows));
    }
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
            : "owner-allowed-primary",
        workArea: selected.workArea,
      },
      displays,
    };
  });
}

// The proof is switched off from exactly one place — the reopen row, and
// only after a measurement showed it is not available on this host. Every other caller proves focus as before, and the contract test
// pins that. The assertion is not relaxed anywhere; one row declares itself
// unprovable, with the reading that made it so.
function assertVisibleWindowPlacement(
  presentation,
  { focusProof = true } = {},
) {
  assert.equal(presentation.mode, "secondary-visible");
  assert.equal(presentation.visible, true);
  // Native focus stays out of scope regardless of which display was used:
  // this assertion never relaxes, allowance or not.
  if (focusProof) assert.equal(presentation.focused, false);
  const preferred = presentation.displays.filter(
    (display) => !display.primary && display.internal,
  );
  const secondary = presentation.displays.filter((display) => !display.primary);
  if (builtInDisplayOnly) {
    assert.equal(presentation.display.internal, true);
    if (presentation.display.primary) {
      assert.ok(allowPrimaryDisplay, "E2E_PRIMARY_DISPLAY_NOT_ALLOWED");
      assert.equal(preferred.length, 0);
    }
  } else if (secondary.length === 0) {
    // Only the explicit owner allowance reaches this branch (AGENTS.md,
    // commit 6cbe53fd); visibleWindowTopologyBlock already refused the lane
    // otherwise, before any window was ever created.
    assert.ok(allowPrimaryDisplay, "E2E_SECONDARY_DISPLAY_UNAVAILABLE");
    assert.equal(presentation.display.primary, true);
    assert.equal(presentation.display.internal, true);
  } else if (preferred.length > 0) {
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
  { focusProof = true } = {},
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
        assertVisibleWindowPlacement(last, { focusProof });
      }
      assert.equal(last.mode, windowMode);
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const taskViews = await application.evaluate(({ BrowserWindow }) => {
    const shell = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return url.startsWith("file:") && url.endsWith("/shell.html");
    });
    return (shell?.contentView.children ?? [])
      .filter((view) => "webContents" in view)
      .map((view) => ({
        title: view.webContents.getTitle(),
        url: view.webContents.getURL(),
        visible: view.getVisible(),
        bounds: view.getBounds(),
      }));
  });
  throw new Error(
    "E2E_WINDOW_PRESENTATION_TIMEOUT:" +
      windowMode +
      ":" +
      JSON.stringify({ last, taskViews }),
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
    // Simulates an MFA-style "Next" step: a same-origin (e2e-allowed) form
    // navigation to a second page, proving the sign-in surface's policy
    // lets that ordinary step proceed rather than silently doing nothing
    // (UX34-07's fixture test).
    if (pathname === "/chatgpt-next") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(`<!doctype html>
        <html><head><meta charset="utf-8"><title>ChatGPT next-step fixture</title>
        <style>body{background:#111216;color:#f7f7f8;font:16px sans-serif;padding:32px}</style></head>
        <body><p data-testid="next-page-ready">Next step reached</p></body></html>`);
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
        <button data-testid="blocked-nav-button" type="button">Navigate off-policy</button>
        <button data-testid="next-page-button" type="button">Next</button>
        <div id="prompt-textarea" contenteditable="true" data-virtualkeyboard="true" aria-label="Message" hidden></div>
        <input data-testid="attachment-input" type="file" multiple hidden />
        <div id="attachment-chips"></div>
        <p data-testid="attachment-upload-error" hidden>Failed to upload attachment</p>
        <button data-testid="send-button" type="button" disabled hidden>Send</button>
        <button data-testid="stop-button" type="button" hidden>Stop</button>
        <section id="conversation"></section>
        <script>
          // UX34 self-deception guard fixture (test-only): ?cover=1 adds a
          // full-viewport overlay at the same maximal z-index the injected
          // "Return to Farol" banner uses, counting its own clicks. Equal
          // z-index falls back to DOM order, and the banner is injected
          // later (on did-finish-load), so the overlay re-appends itself
          // whenever a sibling is added, keeping it the topmost element.
          if (new URLSearchParams(location.search).get('cover') === '1') {
            const overlay = document.createElement('div');
            overlay.id = 'e2e-cover-overlay';
            overlay.dataset.testid = 'cover-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;';
            window.__farolCoverClicks = 0;
            overlay.addEventListener('click', () => {
              window.__farolCoverClicks += 1;
            });
            document.documentElement.appendChild(overlay);
            new MutationObserver(() => {
              if (document.documentElement.lastElementChild !== overlay) {
                document.documentElement.appendChild(overlay);
              }
            }).observe(document.documentElement, { childList: true });
          }
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
          document.querySelector('[data-testid="blocked-nav-button"]').addEventListener('click', () => {
            location.href = 'https://example.invalid/blocked';
          });
          document.querySelector('[data-testid="next-page-button"]').addEventListener('click', () => {
            location.href = '/chatgpt-next';
          });
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
  const isolatedAppData = path.join(isolatedHome, "farol-e2e-app-data");
  await fs.mkdir(isolatedAppData, { recursive: true, mode: 0o700 });
  const e2eRootProof = randomUUID();
  await fs.writeFile(
    path.join(isolatedHome, ".farol-next-e2e-root"),
    e2eRootProof,
    { mode: 0o600 },
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
  if (options.seedUnheldExecutionFence === true) {
    // The execution fence directory as a regular file: `reconcile()`'s
    // `readdir` rejects with ENOTDIR (not ENOENT, so recovery does not treat
    // it as an absent, admitting fence) and the sentinel `raise()`'s
    // `mkdir(..., { recursive: true })` cannot create a directory where a
    // file already exists. Both fail, so recovery holds no record at all.
    const launchRoot = path.join(
      userData,
      "farol-next-state",
      "secure-mcp-connector",
      "computer-authority",
    );
    await fs.mkdir(launchRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(launchRoot, "execution-fence"),
      "not-a-directory\n",
      { mode: 0o600 },
    );
  }
  const workspacePath = path.join(isolatedHome, "approved-workspace");
  await fs.mkdir(workspacePath, { mode: 0o700 });
  const workspaceRoot = await fs.realpath(workspacePath);
  const workspaceFile = path.join(workspaceRoot, "README.md");
  const supportExport = path.join(isolatedHome, "Farol-Next-Support.json");
  const codexFixture = path.join(isolatedHome, "codex-fixture.cjs");
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
  fs.appendFileSync(path.join(__dirname, "codex-app-server-starts"), "start\\n");
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
  // Set while the child's first tool call is waiting for the host to
  // finish correlating it; cleared when that call goes out.
  let agentChildReadAnswered = null;
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
    if (["thread/start", "turn/start", "thread/read", "turn/interrupt"].includes(message.method)) {
      fs.appendFileSync(
        path.join(__dirname, "codex-agent-requests"),
        message.method + "\\n",
      );
    }
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
        // The child's first tool call waits for something observable
        // instead of guessing how long correlation takes. Between the spawn
        // and operation.childTurnId the host saves the lineage and reads
        // the child thread; a call arriving inside that window is refused
        // fail-closed with CODEX_AGENT_WORKSPACE_CORRELATION, and the next
        // wait() reports AGENT_WAIT_ACK_LOST — the recurrence this lane
        // kept producing. A fixed 50 ms is wider than the host's step on an
        // idle machine and narrower than it on a loaded one; answering the
        // child thread/read is the last thing the host needs, so the call
        // goes out once that answer has been written.
        agentChildReadAnswered = () => {
          agentChildReadAnswered = null;
          send({ id: "tool-e2e-agent-workspace", method: "item/tool/call", params: {
            threadId: agentChildThreadId,
            turnId: agentChildTurnId,
            callId: "call-e2e-agent-workspace",
            tool: agentProduct ? "farol_agent_computer" : "farol_agent_workspace_probe",
            arguments: agentWorkspace
          } });
          scheduleAgentRejoin();
        };
        // The rejoin keeps its designed gap, now measured from the call it
        // is designed to follow rather than from the spawn, so a slow
        // correlation cannot reorder the two.
        const scheduleAgentRejoin = () => setTimeout(() => {
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
        // After the answer is written, and after the host has had this
        // turn of the loop to act on it.
        if (agentChildReadAnswered) setImmediate(agentChildReadAnswered);
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
    ...(allowPrimaryDisplay ? ["--allow-primary-display"] : []),
    ...(builtInDisplayOnly ? ["--built-in-display-only"] : []),
    ...extraArgs,
  ];
  const launchEnvironment = {
    ...(options.environment ?? {}),
    ...(options.environment?.FAROL_NEXT_ENVIRONMENT === "dev"
      ? {
          FAROL_NEXT_E2E_APP_DATA: isolatedAppData,
          FAROL_NEXT_E2E_TEST_ROOT: isolatedHome,
          FAROL_NEXT_E2E_TEST_PROOF: e2eRootProof,
        }
      : {}),
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
  // Each awaited boundary of this instance's start, named with the instance
  // it belongs to. A stall inside any of them now rejects with its own name
  // instead of leaving the lane silent.
  const label = `launch[${mode}/${windowMode}]`;
  // A launch that missed its budget can still hand over a live application
  // afterwards. Starting the next instance on top of one is how a lane ends
  // up with two applications against one profile, so this waits for every
  // late result to be released and refuses to start on a held one.
  const held = await phases.drainLateResults();
  assert.deepEqual(
    held.map((entry) => `${entry.name}:${entry.state}`),
    [],
    "E2E_LATE_RESOURCE_STILL_HELD",
  );
  const application = await phases.step(
    `${label}.electron.launch`,
    LAUNCH_PHASE_BUDGET_MS,
    () =>
      electron.launch({
        // Only the two-generation lane names another generation's executable.
        executablePath: options.executable ?? executable,
        args: launchArgs,
        env: launchEnvironment,
        timeout: 15_000,
      }),
    // Playwright's electron.launch takes no abort signal, so the only way to
    // release a late application is to close the one this boundary produced.
    { dispose: (late) => late.close() },
  );
  await phases.step(
    `${label}.activation.beforeFirstWindow`,
    LAUNCH_PHASE_BUDGET_MS,
    () =>
      markActivation(application, `${mode}/${windowMode} before first window`),
  );
  const window = await phases.step(
    `${label}.firstWindow`,
    LAUNCH_PHASE_BUDGET_MS,
    () => application.firstWindow({ timeout: 15_000 }),
  );
  await phases.step(
    `${label}.activation.atFirstWindow`,
    LAUNCH_PHASE_BUDGET_MS,
    () => markActivation(application, `${mode}/${windowMode} at first window`),
  );
  await phases.step(`${label}.sidebarVisible`, LAUNCH_PHASE_BUDGET_MS, () =>
    window.locator("#sidebar").waitFor({ state: "visible" }),
  );
  await phases.step(`${label}.runtimeReady`, LAUNCH_PHASE_BUDGET_MS, () =>
    window
      .locator('#runtime-pill[data-state="ready"]')
      .waitFor({ state: "visible" }),
  );
  if (mode === "demo") {
    await phases.step(`${label}.firstTaskTab`, LAUNCH_PHASE_BUDGET_MS, () =>
      window
        .locator("#task-tabs .task-tab")
        .first()
        .waitFor({ state: "visible" }),
    );
  }
  const expectedTaskViewCount =
    options.expectedTaskViewCount ?? (mode === "demo" ? 2 : 0);
  const presentation = await phases.step(
    `${label}.presentation`,
    LAUNCH_PHASE_BUDGET_MS,
    () =>
      waitForWindowPresentation(application, windowMode, expectedTaskViewCount),
  );
  return {
    application,
    ownedProcessGroup: captureOwnedProcessGroup(application.process().pid),
    window,
    isolatedHome,
    isolatedAppData,
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
  // Keep only fixed, content-free startup tokens from the primary. A missing
  // second-instance acknowledgement otherwise hides whether the primary
  // failed before ready or stayed alive without handling the event.
  let primaryOutput = "";
  application.process().stderr?.on("data", (chunk) => {
    primaryOutput = `${primaryOutput}${String(chunk)}`.slice(-8_192);
  });
  const instance = {
    application,
    ownedProcessGroup: captureOwnedProcessGroup(application.process().pid),
    window: null,
    isolatedHome,
    userData,
    windowMode,
    launchArgs,
    launchEnvironment,
  };
  try {
    const startedAt = Date.now();
    const repeated = await phases.step(
      "startup-second-launch.repeatLaunch",
      LAUNCH_PHASE_BUDGET_MS,
      () =>
        runBoundedProcess(executable, launchArgs, {
          cwd: root,
          env: launchEnvironment,
          timeoutMs: 15_000,
        }),
    );
    assert.equal(
      repeated.status,
      0,
      `E2E_STARTUP_SECOND_LAUNCH_FAILED:${repeated.stdout}${repeated.stderr}`,
    );
    const secondLaunchOutput = `${repeated.stdout}${repeated.stderr}`;
    const secondLaunchResult = parseOwnerLaunchResult(secondLaunchOutput);
    if (secondLaunchResult !== "reopened") {
      // Only the product's fixed, content-free acknowledgement code is
      // retained. Full child output may include private filesystem paths.
      const acknowledgementCode =
        /FAROL_NEXT_SECOND_INSTANCE_ACK_FAILED:([A-Za-z0-9:-]+)/u.exec(
          secondLaunchOutput,
        )?.[1] ?? "none";
      const startupFailure =
        /FAROL_NEXT_STARTUP_FAILURE:([A-Z][A-Z0-9_]{2,63})/u.exec(
          primaryOutput,
        )?.[1] ?? "none";
      const primaryResult =
        /FAROL_NEXT_SECOND_INSTANCE_RESULT:([a-z-]+)/u.exec(
          primaryOutput,
        )?.[1] ?? "none";
      const primaryAckFailure =
        /FAROL_NEXT_SECOND_INSTANCE_ACK_FAILED:([A-Za-z0-9:-]+)/u.exec(
          primaryOutput,
        )?.[1] ?? "none";
      const primaryStage =
        [...primaryOutput.matchAll(/FAROL_NEXT_STARTUP_STAGE:([a-z-]+)/gu)].at(
          -1,
        )?.[1] ?? "none";
      const secondaryStage =
        [
          ...secondLaunchOutput.matchAll(
            /FAROL_NEXT_STARTUP_STAGE:([a-z-]+)/gu,
          ),
        ].at(-1)?.[1] ?? "none";
      const runMarker = await fs
        .stat(path.join(userData, "farol-next-state", "running.json"))
        .then(() => "present")
        .catch((error) => (error?.code === "ENOENT" ? "absent" : "unreadable"));
      phases.note(
        "startup-second-launch.primary",
        `pid=${application.process().pid} exit=${application.process().exitCode ?? "running"} marker=${runMarker} result=${primaryResult} startup=${startupFailure} ack=${primaryAckFailure} stage=${primaryStage} secondaryStage=${secondaryStage}`,
      );
      throw new Error(
        `E2E_STARTUP_SECOND_LAUNCH_RESULT:${secondLaunchResult ?? "missing"}:ack=${acknowledgementCode}:primary=${primaryResult}:startup=${startupFailure}:marker=${runMarker}:stage=${primaryStage}:secondaryStage=${secondaryStage}`,
      );
    }
    assert.ok(Date.now() - startedAt >= 500, "E2E_STARTUP_REOPEN_DID_NOT_WAIT");
    instance.window = await phases.step(
      "startup-second-launch.firstWindow",
      LAUNCH_PHASE_BUDGET_MS,
      () => application.firstWindow({ timeout: 15_000 }),
    );
    await phases.step(
      "startup-second-launch.firstTaskTab",
      LAUNCH_PHASE_BUDGET_MS,
      () =>
        instance.window
          .locator("#task-tabs .task-tab")
          .first()
          .waitFor({ state: "visible" }),
    );
    await phases.step(
      "startup-second-launch.presentation",
      LAUNCH_PHASE_BUDGET_MS,
      () => waitForWindowPresentation(application, windowMode),
    );
    const bootstrap = await phases.step(
      "startup-second-launch.bootstrap",
      LAUNCH_PHASE_BUDGET_MS,
      () => instance.window.evaluate(() => window.farolNext.bootstrap()),
    );
    assert.equal(bootstrap.runtimeState, "ready");
    assert.equal(bootstrap.runtimeIdentity, "farol-next-preview-runtime");
    assert.equal(
      (
        await phases.step(
          "startup-second-launch.taskSurfaces",
          LAUNCH_PHASE_BUDGET_MS,
          () => taskSurfaces(application),
        )
      ).length,
      2,
    );
  } catch (error) {
    evidenceAttempt.recordFailure(
      "second-launch-startup",
      String(error?.message ?? error).split("\n", 1)[0],
    );
    throw error;
  } finally {
    if (instance.window) {
      await close(instance);
    } else {
      // A failed second-launch acknowledgement can leave the primary alive
      // before Playwright has a window handle. The saved, exact process group
      // includes its ordinary Electron helpers; losing the primary PID alone
      // would not prove that they stopped. This is failed-test cleanup, never
      // a graceful quit proof.
      await stopOwnedTestGroup(instance, "startup-second-launch.abort-unready");
      // Keep the disposable profile for diagnosis: a child that deliberately
      // detached from the group is not proved absent by group disappearance.
    }
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

// A second launch of the same build: the primary reopens its window and
// acknowledges the launch, which then exits.
//
// Asynchronously on purpose. `spawnSync` blocks this process's event loop,
// and this process is the Playwright client the primary needs in order to
// finish creating a window. Blocked, the primary cannot publish its
// acknowledgement until the block ends, so the second launch waits out its
// whole ten-second deadline and exits 0 having been *refused*. The exit
// status alone cannot tell the two apart, so the result line is read too.
const SECOND_LAUNCH_DEADLINE_MS = 10_000;
async function repeatLaunch(instance) {
  const spawnedAt = Date.now();
  const secondary = spawn(executable, instance.launchArgs, {
    cwd: root,
    env: instance.launchEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  secondary.stdout.on("data", (chunk) => (stdout += String(chunk)));
  secondary.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const started = performance.now();
  const deadline = setTimeout(() => {
    secondary.kill("SIGKILL");
  }, SECOND_LAUNCH_DEADLINE_MS);
  let exit;
  try {
    // The SIGKILL deadline above is unchanged and still fires first; this
    // budget only covers the case where the exit event itself never lands.
    exit = await phases.step(
      "repeatLaunch.secondaryExit",
      LAUNCH_PHASE_BUDGET_MS,
      () => once(secondary, "exit"),
    );
  } finally {
    clearTimeout(deadline);
  }
  const elapsed = performance.now() - started;
  // The secondary is a regular GUI process for up to two seconds. When it
  // exits macOS hands activation to the frontmost visible window, which is
  // the primary's freshly shown one — so when it started and when it went
  // is half of any later focus reading.
  lastSecondaryLaunch = { spawnedAt, exitedAt: Date.now(), pid: secondary.pid };
  const [status, signal] = exit;
  assert.equal(
    status,
    0,
    `E2E_SECOND_LAUNCH_FAILED:${signal ?? ""}:${stdout}${stderr}`,
  );
  const result = /FAROL_NEXT_SECOND_INSTANCE_RESULT:(\S+)/u.exec(stderr)?.[1];
  assert.equal(result, "reopened", `E2E_SECOND_LAUNCH_NOT_REOPENED:${stderr}`);
  assert.ok(
    elapsed < 2_000,
    `E2E_SECOND_LAUNCH_SLOW:${Math.round(elapsed)}ms:${stderr}`,
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
      await fs.cp(path.join(root, "_output/build/app"), copiedBuild, {
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
    const output = `${mismatched.stdout}${mismatched.stderr}`;
    // This copy is internally inconsistent before it can make a
    // single-instance claim: its manifest no longer matches the embedded
    // runtime identity. Startup must therefore fail closed and non-zero,
    // without Electron's native uncaught-exception path.
    assert.equal(mismatched.status, 1, output);
    assert.equal(mismatched.signal, null);
    assert.match(
      mismatched.stderr,
      /FAROL_NEXT_STARTUP_FAILURE:INSTANCE_BUILD_IDENTITY_INVALID/u,
    );
    assert.equal(parseOwnerLaunchResult(output), "startup-failed");
    assert.doesNotMatch(mismatched.stderr, /App threw an error during load/u);
    assert.doesNotMatch(mismatched.stderr, /Uncaught Exception/u);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

// Playwright's waitForFunction does not await a promise its predicate
// returns: an async predicate is truthy on its first evaluation, so such a
// wait ends whatever the state. A predicate that needs the page's async
// bridge is polled from here instead, and every evaluation is awaited.
async function waitForPageState(page, predicate, arg, options = {}) {
  const deadline = Date.now() + (options.timeout ?? 30_000);
  for (;;) {
    const result = await page.evaluate(predicate, arg);
    if (result) return result;
    if (Date.now() >= deadline) throw new Error("E2E_PAGE_STATE_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Where this application first becomes the active one on this host. The
// proof that `showInactive()` does not take focus only means something
// while the app is not already active without any owner action, so the
// answer decides whether that row is provable here at all — and it has to
// be an answer, not an inference from where a failure happened to land.
const activationSamples = [];
async function markActivation(application, label) {
  const active = await application
    .evaluate(({ app }) => app.isActive())
    .catch(() => null);
  activationSamples.push({ at: Date.now(), label, active });
  return active;
}

async function closeOwnedFocusFixture(fixture) {
  if (!fixture) return;
  try {
    if (fixture.application) await fixture.application.close();
  } finally {
    await fs.rm(fixture.home, { recursive: true, force: true });
  }
}

async function establishOwnedInactiveBaseline(targetApplication) {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-inactive-reopen-focus-"),
  );
  const userData = path.join(home, "user-data");
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  const fixture = { home, application: null };
  try {
    fixture.application = await electron.launch({
      executablePath: vendorElectron,
      args: [
        path.join(root, "tests/e2e/inactive-reopen-focus.fixture.cjs"),
        `--fixture-user-data=${userData}`,
      ],
      env: {
        FAROL_NEXT_E2E: "1",
        HOME: home,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: os.tmpdir(),
      },
      timeout: 15_000,
    });
    await fixture.application.firstWindow({ timeout: 10_000 });
    const deadline = Date.now() + 5_000;
    do {
      const fixtureState = await fixture.application.evaluate(
        ({ app, BrowserWindow, screen }) => {
          const windows = BrowserWindow.getAllWindows();
          const owned = windows[0];
          return {
            active: app.isActive(),
            windowCount: windows.length,
            visible: owned?.isVisible() ?? false,
            focused: owned?.isFocused() ?? false,
            builtIn: owned
              ? screen.getDisplayMatching(owned.getBounds()).internal
              : false,
          };
        },
      );
      const targetActive = await markActivation(
        targetApplication,
        "while the test-owned focus fixture is visible",
      );
      if (
        fixtureState.active &&
        fixtureState.windowCount === 1 &&
        fixtureState.visible &&
        fixtureState.focused &&
        fixtureState.builtIn &&
        targetActive === false
      ) {
        return { fixture, reason: null };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    await closeOwnedFocusFixture(fixture);
    return {
      fixture: null,
      reason:
        "test-owned fixture could not establish a measured inactive application baseline",
    };
  } catch (error) {
    await closeOwnedFocusFixture(fixture);
    return {
      fixture: null,
      reason: `test-owned fixture unavailable: ${error?.message ?? error}`,
    };
  }
}

// The last second-launch's own timestamps, read by the reopen row beside
// its focus timeline rather than inferred from the order of the log.
let lastSecondaryLaunch = null;

// Focus, sampled rather than asked once. `waitForWindowPresentation` reads a
// single instant; if activation arrives from the exiting secondary a moment
// later, one read cannot say whether it was already true or flipped.
async function sampleWindowFocus(application, untilMs) {
  const samples = [];
  while (Date.now() < untilMs) {
    const sample = await application
      .evaluate(({ app, BrowserWindow }) => {
        const focused = BrowserWindow.getFocusedWindow();
        return {
          // Whether the PRIMARY is the active application is the reading
          // that separates "was focused all along" from "was handed
          // activation when the secondary quit".
          active: app.isActive(),
          any: focused === null ? null : focused.id,
          windows: BrowserWindow.getAllWindows().map((browserWindow) => ({
            id: browserWindow.id,
            focused: browserWindow.isFocused(),
            visible: browserWindow.isVisible(),
          })),
        };
      })
      .catch(() => null);
    samples.push({ at: Date.now(), sample });
    if (sample === null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return samples;
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

// Playwright reports a vanished Electron target by message alone, while this
// runner reports a still-connected app whose owned shell already vanished as
// E2E_WINDOW_MISSING. Only these shapes mean the close inspection cannot run;
// anything else is a real harness or product error and still throws. The
// observation remains blocking, so recognizing it can never turn the lane
// green; it only keeps a finally block from masking the first failure.
const APPLICATION_ALREADY_GONE =
  /E2E_WINDOW_MISSING|has been closed|Target (page|browser|crashed)|Connection closed/u;

function recordClosedBeforeInspection(instance, stage, error) {
  const message = String(error?.message ?? error).split("\n", 1)[0];
  const owningCase = cases.at(-1) ?? null;
  harnessObservations.push({
    kind: "closed-before-inspection",
    stage,
    windowMode: instance.windowMode ?? null,
    mode: instance.mode ?? null,
    owningCase,
    caseCount: cases.length,
    message: message.slice(0, 200),
  });
  // The classification stays FAIL: an instance that died before its own close
  // could inspect it has not proved anything about quitting.
  evidenceAttempt.recordFailure(
    "close",
    `E2E_CLOSED_BEFORE_INSPECTION:${stage}:${owningCase ?? "no-case"}`,
  );
}

// Returns the value, or null once the application is gone — never a silent
// success.
async function ifApplicationLive(instance, stage, read) {
  try {
    return { value: await read() };
  } catch (error) {
    if (!APPLICATION_ALREADY_GONE.test(String(error?.message ?? error))) {
      throw error;
    }
    recordClosedBeforeInspection(instance, stage, error);
    return null;
  }
}

function captureOwnedProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const probe = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 3_000,
  });
  // Never signal an unverified group: it might contain the test runner or an
  // unrelated process. Electron is expected to be its own group leader.
  return probe.status === 0 && probe.stdout.trim() === String(pid) ? pid : null;
}

function ownedGroupAlive(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitOwnedGroupGone(groupId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!ownedGroupAlive(groupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !ownedGroupAlive(groupId);
}

async function waitOwnedPidGone(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

async function stopProfileBoundHelpers(instance, label) {
  const profile = instance.userData;
  if (
    typeof profile !== "string" ||
    !path
      .resolve(profile)
      .startsWith(`${path.resolve(os.tmpdir())}${path.sep}farol-next-e2e-home-`)
  ) {
    throw new Error(`E2E_HELPER_PROFILE_UNVERIFIED:${label}`);
  }
  const table = spawnSync("/bin/ps", ["-axo", "uid=,pid=,command="], {
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (table.status !== 0) {
    throw new Error(`E2E_HELPER_PROCESS_TABLE_UNAVAILABLE:${label}`);
  }
  const marker = `--user-data-dir=${profile}`;
  const helpers = table.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
    .filter(
      (match) =>
        match &&
        Number(match[1]) === process.getuid() &&
        match[3].includes(marker) &&
        Number(match[2]) !== process.pid,
    )
    .map((match) => Number(match[2]));
  phases.note(`${label}.profileHelpers`, `count=${helpers.length}`);
  for (const pid of helpers) {
    if (await waitOwnedPidGone(pid)) continue;
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      if (await waitOwnedPidGone(pid)) break;
    }
    assert.equal(
      await waitOwnedPidGone(pid),
      true,
      `E2E_PROFILE_HELPER_SURVIVED_ABORT:${pid}`,
    );
  }
  return helpers.length;
}

async function stopOwnedTestGroup(instance, label) {
  const pid = instance.application.process().pid;
  instance.ownedProcessGroup ??= captureOwnedProcessGroup(pid);
  const groupId = instance.ownedProcessGroup;
  if (groupId !== pid || !Number.isSafeInteger(groupId) || groupId <= 1) {
    evidenceAttempt.recordFailure(
      "cleanup",
      `E2E_OWNED_GROUP_UNVERIFIED:${label}`,
    );
    // The main PID is still ours; stop it without touching a guessed group.
    instance.application.process().kill("SIGKILL");
    if (Number.isSafeInteger(pid) && pid > 1) {
      assert.equal(
        await waitOwnedPidGone(pid),
        true,
        `E2E_OWNED_MAIN_SURVIVED_ABORT:${label}`,
      );
    }
    await stopProfileBoundHelpers(instance, label);
    throw new Error(`E2E_OWNED_GROUP_UNVERIFIED:${label}`);
  }
  phases.note(label, `group=${groupId}`);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!ownedGroupAlive(groupId)) break;
    try {
      process.kill(-groupId, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    if (await waitOwnedGroupGone(groupId)) break;
  }
  assert.equal(
    ownedGroupAlive(groupId),
    false,
    `E2E_OWNED_GROUP_SURVIVED_ABORT:${label}`,
  );
  const escapedHelpers = await stopProfileBoundHelpers(instance, label);
  // phase.log survives a failing lane; the in-memory observation below is
  // only included if the runner reaches its final report.
  phases.note(`${label}.groupGone`, "detached=unverified");
  harnessObservations.push({
    kind: "test-process-cleanup",
    stage: label,
    groupCleanup: "confirmed",
    detachedCleanup: "unverified",
  });
  if (escapedHelpers > 0) {
    evidenceAttempt.recordFailure(
      "cleanup",
      `E2E_PROFILE_HELPER_ESCAPED_GROUP:${label}:${escapedHelpers}`,
    );
    throw new Error(`E2E_PROFILE_HELPER_ESCAPED_GROUP:${label}`);
  }
}

async function close(instance, options = {}) {
  const removeHome = options.removeHome ?? true;
  const label = `close[${instance.windowMode ?? "unknown"}]`;
  let provedQuit = true;
  let inspected;
  if (instance.windowMode) {
    inspected = await phases.step(
      `${label}.windowPresentation`,
      CLOSE_PHASE_BUDGET_MS,
      () =>
        ifApplicationLive(instance, "window-presentation", () =>
          inspectWindowPresentation(instance.application),
        ),
    );
    if (inspected === null) {
      provedQuit = false;
    } else {
      // Unchanged for a live application.
      assert.equal(inspected.value.mode, instance.windowMode);
      assert.equal(
        inspected.value.visible,
        instance.windowMode === "secondary-visible",
      );
    }
  }
  const mainPid = instance.application.process().pid;
  instance.ownedProcessGroup ??= captureOwnedProcessGroup(mainPid);
  const metrics = await phases.step(
    `${label}.utilityMetrics`,
    CLOSE_PHASE_BUDGET_MS,
    () =>
      ifApplicationLive(instance, "utility-metrics", () =>
        instance.application.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .filter(
              (metric) =>
                metric.type === "Utility" &&
                ["Farol Next Runtime", "Farol Dev Runtime"].includes(
                  metric.name,
                ),
            )
            .map((metric) => metric.pid),
        ),
      ),
  );
  if (metrics === null) provedQuit = false;
  const utilityPids = metrics?.value ?? [];
  let closeReturnedAfterEarlyExit = false;
  // Playwright's application.close() can wait forever after the child has
  // already exited. Confirm the exact owned PID first; an early exit stays a
  // recorded failure and never counts as a successful quit proof.
  let alreadyExited = false;
  if (inspected === null || metrics === null) {
    try {
      process.kill(mainPid, 0);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      alreadyExited = true;
    }
  }
  if (alreadyExited) {
    phases.note(`${label}.applicationAlreadyExited`, `pid=${mainPid}`);
  } else {
    try {
      const closed = await phases.step(
        `${label}.applicationClose`,
        CLOSE_PHASE_BUDGET_MS,
        () =>
          ifApplicationLive(instance, "application-close", () =>
            instance.application.close(),
          ),
      );
      if (closed === null) {
        provedQuit = false;
        closeReturnedAfterEarlyExit = true;
      }
    } catch (error) {
      evidenceAttempt.recordFailure(
        "close",
        String(error?.message ?? error).split("\n", 1)[0],
      );
      await stopOwnedTestGroup(instance, `${label}.abort-stalled-close`);
      throw error;
    }
  }
  const groupId = instance.ownedProcessGroup;
  if (groupId !== mainPid || !Number.isSafeInteger(groupId)) {
    evidenceAttempt.recordFailure(
      "cleanup",
      `E2E_OWNED_GROUP_UNVERIFIED:${label}`,
    );
    throw new Error(`E2E_OWNED_GROUP_UNVERIFIED:${label}`);
  }
  const groupSurvivedQuit = !(await waitOwnedGroupGone(groupId));
  if (groupSurvivedQuit) {
    await stopOwnedTestGroup(instance, `${label}.abort-surviving-group`);
  }
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
    if (alive) {
      evidenceAttempt.recordFailure(
        "cleanup",
        `E2E_OWNED_PROCESS_SURVIVED_QUIT:${pid}`,
      );
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      assert.equal(
        await waitOwnedPidGone(pid),
        true,
        `E2E_OWNED_PROCESS_SURVIVED_ABORT:${pid}`,
      );
      throw new Error(`E2E_OWNED_PROCESS_SURVIVED_QUIT:${pid}`);
    }
  }
  if (groupSurvivedQuit) {
    throw new Error(`E2E_OWNED_GROUP_SURVIVED_QUIT:${groupId}`);
  }
  if (metrics === null) {
    evidenceAttempt.recordFailure(
      "cleanup",
      `E2E_UTILITY_IDENTITIES_UNAVAILABLE:${label}`,
    );
    throw new Error(`E2E_UTILITY_IDENTITIES_UNAVAILABLE:${label}`);
  }
  if (closeReturnedAfterEarlyExit) {
    phases.note(`${label}.profileRetained`, "early-exit-during-close");
  }
  // An application that had already exited leaves no processes behind either,
  // so its dead pids are not proof that quitting terminated them.
  if (provedQuit) quitProofs += 1;
  if (removeHome) {
    await stopChatGptFixture(instance.chatGptFixture);
    instance.chatGptFixture = null;
    if (provedQuit) {
      const real = path.resolve(instance.isolatedHome);
      assert.ok(
        real.startsWith(
          `${path.resolve(os.tmpdir())}${path.sep}farol-next-e2e-home-`,
        ),
      );
      await fs.rm(real, { recursive: true, force: true });
    }
  }
}

async function restart(instance) {
  const label = `restart[${instance.windowMode}]`;
  await close(instance, { removeHome: false });
  instance.application = await phases.step(
    `${label}.electron.launch`,
    LAUNCH_PHASE_BUDGET_MS,
    () =>
      electron.launch({
        executablePath: executable,
        args: instance.launchArgs,
        env: instance.launchEnvironment,
        timeout: 15_000,
      }),
    { dispose: (late) => late.close() },
  );
  instance.ownedProcessGroup = captureOwnedProcessGroup(
    instance.application.process().pid,
  );
  instance.window = await phases.step(
    `${label}.firstWindow`,
    LAUNCH_PHASE_BUDGET_MS,
    () => instance.application.firstWindow({ timeout: 15_000 }),
  );
  await phases.step(`${label}.sidebarVisible`, LAUNCH_PHASE_BUDGET_MS, () =>
    instance.window.locator("#sidebar").waitFor({ state: "visible" }),
  );
  const bootstrap = await phases.step(
    `${label}.bootstrap`,
    LAUNCH_PHASE_BUDGET_MS,
    () => instance.window.evaluate(() => window.farolNext.bootstrap()),
  );
  const expectedTaskViewCount = bootstrap.demoMode
    ? instance.expectedTaskViewCount
    : bootstrap.tasks.length;
  instance.presentation = await phases.step(
    `${label}.presentation`,
    LAUNCH_PHASE_BUDGET_MS,
    () =>
      waitForWindowPresentation(
        instance.application,
        instance.windowMode,
        expectedTaskViewCount,
      ),
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
                candidate.getTitle() === "Farol · Developer Preview" &&
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
      .getByText("failed", { exact: true })
      .waitFor({ timeout: 5_000 });
    assert.equal(startupWindow.isClosed(), false);
    assert.equal(
      await instance.application.evaluate(({ BrowserWindow }) => {
        const shell = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol · Developer Preview" &&
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
            candidate.getTitle() === "Farol · Developer Preview" &&
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
        candidate.getTitle() === "Farol · Developer Preview" &&
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
        ["Farol · Developer Preview", "Farol Dev · Development"].includes(
          candidate.getTitle(),
        ) &&
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
          candidate.getTitle() === "Farol · Developer Preview" &&
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
          candidate.getTitle() === "Farol · Developer Preview" &&
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
      app.focus({ steal: true });
      targetWindow.focus();
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
    last = await application.evaluate(
      async ({ app, BrowserWindow, screen }) => {
        const targetWindow = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol · Developer Preview" &&
            url.startsWith("file:") &&
            url.endsWith("/shell.html")
          );
        });
        if (!targetWindow) throw new Error("E2E_WINDOW_MISSING");
        // Installed once, in the main process: whether the window ever
        // receives a focus or blur event is a different fact from what
        // `isFocused()` answers a moment later, and only the events can say
        // the request reached the window manager at all.
        if (!globalThis.__farolE2EFocusEvents) {
          const events = { focus: 0, blur: 0, lastAt: null };
          globalThis.__farolE2EFocusEvents = events;
          targetWindow.on("focus", () => {
            events.focus += 1;
            events.lastAt = Date.now();
          });
          targetWindow.on("blur", () => {
            events.blur += 1;
            events.lastAt = Date.now();
          });
        }
        // Measured, attempt 20260921T100705342Z-19062918: this loop used to
        // repeat the whole activation on every sample —
        // `setActivationPolicy`, `dock.show()`, `show()`, `moveTop()`,
        // `app.focus({steal:true})`, `focus()` — and the samples show what
        // that cost. The window was focused on sample 0 and never again,
        // with the blur count running exactly one ahead of the focus count
        // for all fifty samples: every iteration took focus and lost it
        // before the next read, so three consecutive focused samples were
        // unreachable however long the loop ran. Activating is the
        // activation's job and happens once, above. This is an observation
        // loop and now only observes. The assertion and its budget are
        // unchanged: fifty attempts, 100 ms apart, three consecutive
        // focused samples of the same window.
        const bounds = targetWindow.getBounds();
        const center = {
          x: Math.round(bounds.x + bounds.width / 2),
          y: Math.round(bounds.y + bounds.height / 2),
        };
        const onDisplay = screen.getDisplayNearestPoint(center);
        const primary = screen.getPrimaryDisplay();
        const focusedWindow = BrowserWindow.getFocusedWindow();
        return {
          focused: targetWindow.isFocused(),
          visible: targetWindow.isVisible(),
          minimized: targetWindow.isMinimized(),
          fullScreen: targetWindow.isFullScreen(),
          shellFocused: targetWindow.webContents.isFocused(),
          // Everything below is measurement, added for the focus-acquisition
          // diagnosis. It changes no decision: the loop still returns only on
          // three consecutive `focused` samples of the same window.
          appActive: app.isActive(),
          focusable: targetWindow.isFocusable(),
          focusEvents: { ...globalThis.__farolE2EFocusEvents },
          bounds,
          display: {
            id: onDisplay.id,
            primary: onDisplay.id === primary.id,
            bounds: onDisplay.bounds,
          },
          displays: screen.getAllDisplays().map((candidate) => ({
            id: candidate.id,
            primary: candidate.id === primary.id,
            bounds: candidate.bounds,
          })),
          focusedWindow: focusedWindow
            ? {
                id: focusedWindow.id,
                same: focusedWindow.id === targetWindow.id,
                title: focusedWindow.getTitle(),
                url: focusedWindow.webContents.getURL().slice(-60),
              }
            : null,
          windows: BrowserWindow.getAllWindows().map((candidate) => ({
            id: candidate.id,
            title: candidate.getTitle(),
            url: candidate.webContents.getURL().slice(-40),
            visible: candidate.isVisible(),
            focused: candidate.isFocused(),
          })),
        };
      },
    );
    nativeFocusSamples.push({ attempt, at: Date.now(), ...last });
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
        candidate.getTitle() === "Farol · Developer Preview" &&
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
          candidate.getTitle() === "Farol · Developer Preview" &&
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
        candidate.getTitle() === "Farol · Developer Preview" &&
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
        candidate.getTitle() === "Farol · Developer Preview" &&
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
          candidate.getTitle() === "Farol · Developer Preview" &&
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
        candidate.getTitle() === "Farol · Developer Preview" &&
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

// The native title of the window showing `url` — what the owner sees in the
// title bar and Window menu. Playwright's page.title() is the page's own
// document.title, which Farol deliberately does not show.
async function nativeWindowTitle(application, url) {
  return application.evaluate(
    ({ BrowserWindow }, pageUrl) =>
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL().startsWith(pageUrl))
        ?.getTitle() ?? null,
    url,
  );
}

// Finishes first-run Setup with Continue only. Each step is saved before the
// journey advances, so the next click waits for the step to change: clicking
// ahead of the save repeats a step and the dialog never closes.
async function finishSetupByNext(instance) {
  const dialog = instance.window.locator("#setup-dialog");
  await dialog.waitFor({ state: "visible" });
  for (let step = 0; step < setupScreens.length; step += 1) {
    const before = await dialog.getAttribute("data-step-id");
    await instance.window.locator("#setup-next").click();
    if (step < setupScreens.length - 1) {
      await instance.window.waitForFunction(
        (previous) =>
          document
            .querySelector("#setup-dialog")
            ?.getAttribute("data-step-id") !== previous,
        before,
      );
    }
  }
  await dialog.waitFor({ state: "hidden" });
}

// Finishes first-run Setup the way a novice does: two real pointer clicks on
// Continue, as fast as the input stack delivers them, at every step.
//
// finishSetupByNext() waits for each save before the next click because a
// programmatic click that does not wait repeats a step. A person double
// -clicking is a different thing, and the product has to survive it: one
// double click must advance exactly one step, never two, and must not leave
// the dialog wedged. Returns the step ids in the order they were actually
// shown, so a skipped step is visible rather than merely not asserted.
async function finishSetupByDoubleClick(instance) {
  const dialog = instance.window.locator("#setup-dialog");
  await dialog.waitFor({ state: "visible" });
  const shown = [];
  for (let step = 0; step < setupScreens.length; step += 1) {
    const before = await dialog.getAttribute("data-step-id");
    shown.push(before);
    // Hit-test the centre before clicking it: Continue is inside a modal,
    // and a click that lands on an overlay proves nothing about the button.
    const target = await instance.window.evaluate(() => {
      const next = document.querySelector("#setup-next");
      if (!next) throw new Error("E2E_SETUP_NEXT_MISSING");
      const rect = next.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, reachable: hit === next || next.contains(hit) };
    });
    assert.equal(
      target.reachable,
      true,
      `Continue is clickable at its centre on step ${before}`,
    );
    await instance.window.mouse.click(target.x, target.y);
    await instance.window.mouse.click(target.x, target.y);
    if (step < setupScreens.length - 1) {
      await instance.window.waitForFunction(
        (previous) =>
          document
            .querySelector("#setup-dialog")
            ?.getAttribute("data-step-id") !== previous,
        before,
      );
    }
  }
  await dialog.waitFor({ state: "hidden" });
  return shown;
}

// A wait for the task menu's sentence that says which silence it hit.
//
// The note is written by one renderer path; a command can settle without
// that path ever running (an empty selection, a selection that is no longer
// a live ChatGPT task, or a command that closed the menu). A bare wait on
// the text cannot tell those apart from a slow IPC, so it expires with
// nothing to report — which is exactly how this failed twice on 19434d33.
// The renderer publishes its own phase on the note; print it.
async function waitForTaskMenuNote(instance, expected) {
  try {
    await instance.window.waitForFunction(
      (text) => document.querySelector("#task-menu-note")?.textContent === text,
      expected,
    );
  } catch (error) {
    const shown = await instance.window
      .evaluate(() => {
        const note = document.querySelector("#task-menu-note");
        return {
          text: note?.textContent ?? null,
          phase: note?.dataset.phase ?? null,
          trace: note?.dataset.trace ?? null,
          menuHidden: document.querySelector("#task-menu")?.hidden ?? null,
          livePanelHidden:
            document.querySelector("#task-menu-live")?.hidden ?? null,
        };
      })
      .catch(() => null);
    throw new Error(
      `task menu never said ${JSON.stringify(expected)} · ${JSON.stringify(shown)}`,
      { cause: error },
    );
  }
}

// A Setup wait that times out names what the dialog showed instead, so a
// failure under load is told apart from a refusal without another run.
async function waitForSetup(instance, predicate, arg) {
  try {
    await instance.window.waitForFunction(predicate, arg);
  } catch (error) {
    const shown = await instance.window
      .evaluate(() => ({
        step: document.querySelector("#setup-dialog")?.dataset.stepId ?? null,
        status: document.querySelector("#setup-status strong")?.textContent,
        primary: document.querySelector("#setup-live-primary")?.textContent,
        summary: document.querySelector("#setup-live-summary")?.textContent,
        feedback: document.querySelector("#setup-feedback")?.textContent,
      }))
      .catch(() => null);
    // What the surface says is half the answer; the other half is where the
    // state it is reporting came from. A Setup step that reports an outcome
    // nothing in this run produced would mean the profile is not the fresh
    // one this harness claims to hand every instance, so the home's own
    // identity and age are recorded beside the reading.
    const provenance = await instance.window
      .evaluate(async () => {
        const value = await window.farolNext.bootstrap();
        const settings =
          value.configuration.status === "ready"
            ? value.configuration.settings
            : null;
        return {
          agentVerification:
            settings?.nativeHosts?.codex?.agentVerification ?? null,
          liveVerification:
            settings?.nativeHosts?.codex?.liveVerification ?? null,
          computerGeneration: settings?.computer?.generation ?? null,
          taskCount: value.tasks.length,
          agentPhases: value.tasks.map((task) => task.agent?.phase ?? null),
        };
      })
      .catch(() => null);
    const home = await fs
      .stat(instance.userData)
      .then((entry) => ({
        userData: instance.userData,
        createdMs: Math.round(Date.now() - entry.birthtimeMs),
        entries: null,
      }))
      .catch(() => null);
    if (home) {
      home.entries = await fs
        .readdir(path.join(instance.userData, "farol-next-state"))
        .catch(() => null);
    }
    // The failure message is capped, and the readings that matter here are
    // whole files. Write them beside the attempt instead of truncating them
    // into a sentence: the host probe's own receipt is what says whether it
    // exceeded a budget under load or returned something the product could
    // not classify, and the assignment store is where an Agent outcome
    // lives when no task carries it.
    const readJsonLeaf = async (root) => {
      const entries = await fs.readdir(root).catch(() => null);
      if (entries === null) return null;
      const leaves = {};
      for (const entry of entries.slice(0, 16)) {
        const text = await fs
          .readFile(path.join(root, entry), "utf8")
          .catch(() => null);
        leaves[entry] = text === null ? "<not a file>" : text.slice(0, 4_096);
      }
      return leaves;
    };
    const readJsonTree = async (root) => {
      const entries = await fs.readdir(root).catch(() => null);
      if (entries === null) return null;
      const contents = {};
      for (const entry of entries.slice(0, 32)) {
        const target = path.join(root, entry);
        const info = await fs.stat(target).catch(() => null);
        if (!info?.isFile()) {
          // One level down, because the record that matters — an
          // assignment's phase and terminal reason — lives in a
          // subdirectory, and "<directory>" answers nothing.
          contents[entry] = info?.isDirectory()
            ? await readJsonLeaf(target)
            : null;
          continue;
        }
        const text = await fs.readFile(target, "utf8").catch(() => null);
        contents[entry] =
          text === null
            ? null
            : text.length > 8_192
              ? `${text.slice(0, 8_192)}…`
              : text;
      }
      return contents;
    };
    const stateRoot = path.join(instance.userData, "farol-next-state");
    const settingsText = await fs
      .readFile(path.join(stateRoot, "product-settings.json"), "utf8")
      .catch(() => null);
    let settingsSection = null;
    try {
      const parsed = JSON.parse(settingsText ?? "null");
      settingsSection = {
        nativeHosts: parsed?.nativeHosts ?? null,
        setup: parsed?.setup ?? null,
        computerGeneration: parsed?.computer?.generation ?? null,
      };
    } catch {
      settingsSection = { unparsed: (settingsText ?? "").slice(0, 2_048) };
    }
    const byproduct = {
      schema: 1,
      capturedAt: new Date().toISOString(),
      shown,
      provenance,
      home,
      capturedAtMs: Date.now(),
      activation: activationSamples,
      codexHostRuntime: await readJsonTree(
        path.join(stateRoot, "codex-host-runtime"),
      ),
      summaryFenceRecovery: await fs
        .readFile(path.join(stateRoot, "summary-fence-recovery.json"), "utf8")
        .then((text) => text.slice(0, 4_096))
        .catch(() => null),
      codexHostProbe: await readJsonTree(
        path.join(stateRoot, "codex-host-probe"),
      ),
      nativeAgentAssignments: await readJsonTree(
        path.join(stateRoot, "native-agent-assignments"),
      ),
      productSettings: settingsSection,
    };
    const byproductPath = path.join(evidenceRoot, "setup-verify-state.json");
    await fs
      .writeFile(byproductPath, `${JSON.stringify(byproduct, null, 2)}\n`, {
        mode: 0o600,
      })
      .catch(() => undefined);
    throw new Error(
      `${error.message} · setup showed ${JSON.stringify(shown)} · state ${JSON.stringify(provenance)} · home ${JSON.stringify(home)} · byproduct ${byproductPath}`,
      {
        cause: error,
      },
    );
  }
}

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
    // One marker per setup step. The step bodies below drive real windows
    // and bridge calls; without this, a stall anywhere in the journey looked
    // identical to a stall in `launch()` from outside the process.
    phases.note("completeSetup.step", stepId);
    assert.equal(await dialog.getAttribute("data-step-id"), stepId);
    // One sample per step, not only around the sign-in window. The ChatGPT
    // route window is exonerated by A's read of chatgpt-route.ts — it is
    // created hidden and revealed with showInactive() in this mode — so the
    // activation comes from something else, and the first step that reports
    // an active app names where to look.
    await markActivation(instance.application, `setup: at step ${stepId}`);
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
      await markActivation(
        instance.application,
        "setup: before the sign-in window is opened",
      );
      const chatGptWindow = instance.application.waitForEvent("window", {
        timeout: 15_000,
      });
      await instance.window.locator("#setup-live-primary").click();
      const chatGptPage = await chatGptWindow;
      await markActivation(
        instance.application,
        "setup: with the sign-in window open",
      );
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
      await waitForSetup(
        instance,
        () =>
          document.querySelector("#setup-live-primary")?.textContent ===
          "Check connection",
      );
      await instance.window.locator("#setup-live-primary").click();
      await waitForSetup(
        instance,
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
          "Verified",
      );
      await chatGptPage.locator('[data-testid="expire-button"]').click();
      await chatGptPage.locator('[data-testid="login-button"]').waitFor({
        state: "visible",
      });
      await instance.window.locator("#setup-live-primary").click();
      await waitForSetup(
        instance,
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
            "Needs action" &&
          document.querySelector("#setup-live-primary")?.textContent ===
            "Open sign-in…",
      );
      await instance.window.locator("#setup-live-primary").click();
      await waitForSetup(
        instance,
        () =>
          document.querySelector("#setup-live-primary")?.textContent ===
          "Check connection",
      );
      await chatGptPage.locator('[data-testid="login-button"]').click();
      await instance.window.locator("#setup-live-primary").click();
      await waitForSetup(
        instance,
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
          "Verified",
      );
      await chatGptPage.close();
      await markActivation(
        instance.application,
        "setup: after the sign-in window closed",
      );
      await waitForWindowCount(instance.application, 1);
      await waitForShellVisibility(
        instance.application,
        instance.windowMode === "secondary-visible",
        instance.expectedTaskViewCount,
      );
    }
    if (stepId === "computer" && configureComputer) {
      await instance.window.locator("#setup-live-primary").click();
      await waitForSetup(
        instance,
        () =>
          document.querySelector("#setup-live-primary")?.textContent ===
          "Verify folder",
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
      await waitForSetup(
        instance,
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
      // Discovery may now select a compatible signed installation before
      // this helper reaches the step. Wait for that decision (or the empty
      // discovery panel) instead of assuming the owner must use Advanced.
      // The rest of this synthetic lane still needs its deterministic App
      // Server fixture, so an automatically selected real host is replaced
      // through the existing E2E picker seam without running a model turn.
      await waitForSetup(instance, () => {
        const primary = document.querySelector("#setup-live-primary");
        return (
          (primary instanceof HTMLButtonElement && !primary.hidden) ||
          document.querySelector(
            "#setup-dialog .discovery-advanced summary",
          ) !== null
        );
      });
      const hostWasDiscovered = !(await instance.window
        .locator("#setup-live-primary")
        .isHidden());
      if (hostWasDiscovered) {
        const selectedFixture = await instance.window.evaluate(() =>
          window.farolNext.configure({ kind: "host.select-codex" }),
        );
        assert.equal(selectedFixture.ok, true, JSON.stringify(selectedFixture));
        await assertSameFixtureExecutable(
          selectedFixture.snapshot.settings.nativeHosts.codex.executablePath,
          instance.codexFixture,
        );
      } else {
        await instance.window
          .locator("#setup-dialog .discovery-advanced summary")
          .click();
        await instance.window
          .locator("#setup-dialog .discovery-advanced-actions button", {
            hasText: "Choose another…",
          })
          .click();
      }
      await waitForSetup(
        instance,
        () =>
          document.querySelector("#setup-status strong")?.textContent ===
            "Needs action" &&
          document.querySelector("#setup-live-primary")?.textContent ===
            "Run live check",
      );
      let bootstrap = await instance.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      await assertSameFixtureExecutable(
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
      await waitForSetup(
        instance,
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
      await waitForSetup(
        instance,
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
    await phases.step(
      `completeSetup.advance[${stepId}]`,
      SETUP_PHASE_BUDGET_MS,
      async () => {
        await instance.window.locator("#setup-next").click();
        if (stepId !== "verify") {
          await waitForSetup(
            instance,
            (previous) =>
              document
                .querySelector("#setup-dialog")
                ?.getAttribute("data-step-id") !== previous,
            stepId,
          );
        }
      },
    );
  }
  await phases.step("completeSetup.dialogHidden", SETUP_PHASE_BUDGET_MS, () =>
    dialog.waitFor({ state: "hidden" }),
  );
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
            candidate.getTitle() === "Farol · Developer Preview" &&
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
    await waitForPageState(
      instance.window,
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
  seed: soakSeed,
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
            candidate.getTitle() === "Farol · Developer Preview" &&
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
          candidate.getTitle() === "Farol · Developer Preview" &&
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
  // The development build and the sealed package run the same workload;
  // the lane, the report and the evidence say which bytes were measured.
  const instance = await launch([], "hidden", "ordinary");
  const samples = [];
  const timings = {
    createTotalMs: [],
    providerNavigationMs: [],
    createLocalEstimateMs: [],
    closeMs: [],
    overlayMs: [],
  };
  // Two restarts at seeded batches, one in each half of the run; the
  // default seed gives the historical batches 3 and 8.
  const recoveryBatches = new Set([
    2 + (lifecycleSoakBudget.seed % 4),
    6 + (Math.floor(lifecycleSoakBudget.seed / 8) % 4),
  ]);
  const idleBatch =
    soakIdleMs > 0
      ? 1 + (Math.floor(lifecycleSoakBudget.seed / 32) % 10)
      : null;
  const recoveryEvents = [];
  const loadBefore = {
    loadAverage: os.loadavg(),
    freeMemoryBytes: os.freemem(),
  };
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
      if (batchNumber === idleBatch) {
        await new Promise((resolve) => setTimeout(resolve, soakIdleMs));
        recoveryEvents.push({
          batch: batchNumber,
          kind: "idle-pause",
          ms: soakIdleMs,
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
    const workingSetSlopeKiBPerBatch = linearSlope(
      samples.map((sample) => sample.workingSetSizeKiB),
    );
    // Every budget is judged, and the raw measurements are written even when
    // one is exceeded: a failed run stays evidence instead of disappearing.
    const budgetVerdicts = {
      createTotalP95Ms: {
        measured: latency.createTotalMs.p95,
        budget: lifecycleSoakBudget.createTotalP95Ms,
      },
      createLocalEstimateP95Ms: {
        measured: latency.createLocalEstimateMs.p95,
        budget: lifecycleSoakBudget.createLocalEstimateP95Ms,
      },
      closeP95Ms: {
        measured: latency.closeMs.p95,
        budget: lifecycleSoakBudget.closeP95Ms,
      },
      overlayP95Ms: {
        measured: latency.overlayMs.p95,
        budget: lifecycleSoakBudget.overlayP95Ms,
      },
      workingSetSlopeKiBPerBatch: {
        measured: workingSetSlopeKiBPerBatch,
        budget: lifecycleSoakBudget.workingSetSlopeKiBPerBatch,
      },
    };
    const budgetFailures = Object.entries(budgetVerdicts)
      .filter(([, verdict]) => !(verdict.measured <= verdict.budget))
      .map(([name]) => name);

    await restart(instance);
    const restarted = await instance.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.deepEqual(restarted.tasks, []);
    const afterRestart = await lifecycleMetrics(instance);
    assertQuiescentMetrics(afterRestart, baseline);

    const report = {
      schema: 1,
      status: budgetFailures.length === 0 ? "PASS" : "FAIL",
      evidence: "FIXTURE_APP",
      lane: evidenceLane,
      build: development ? "development-electron" : "sealed-package",
      executable,
      artifactSha256: artifact.artifactSha256,
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
        recoveryBatches: [...recoveryBatches].sort(
          (left, right) => left - right,
        ),
        idlePause:
          idleBatch === null ? null : { batch: idleBatch, ms: soakIdleMs },
        overlaySequence: Array.from({ length: batches }, (_, batch) =>
          (lifecycleSoakBudget.seed + batch + 1) % 2 === 0
            ? "quick-switcher"
            : "task-menu",
        ),
        provider: "deterministic local ChatGPT fixture",
      },
      budgets: lifecycleSoakBudget,
      budgetVerdicts,
      budgetFailures,
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
      // Additional reading of the same samples, judged by nothing.  The
      // budget above and every verdict it has ever produced are unchanged;
      // this only reads those samples in ways that do not span the two
      // restarts inside the measured window.
      retentionDiagnostics: retentionDiagnostics({
        baseline,
        samples,
        recoveryEvents,
      }),
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
        load: {
          before: loadBefore,
          after: { loadAverage: os.loadavg(), freeMemoryBytes: os.freemem() },
        },
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

// Q-07/Q-08: the owner's state across two real generations. A is the
// predecessor qualified by its own pinned verifier, B is this candidate; both
// run in turn on one isolated user-data directory. A running generation owns
// that state against the other; a crash with a running provider turn and an
// interrupted activation leave an obligation that B reports instead of
// resetting or resubmitting; B reads A's state and keeps its own change
// across a restart; the rollback to A reads B's state without rewriting it.
// Context checkpoints and bundle placement are outside this lane: the first
// needs an agent-backed conversation, the second is the promotion test's.
function durableStateFiles(userData) {
  const state = path.join(userData, "farol-next-state");
  return {
    settings: path.join(state, "product-settings.json"),
    tasks: path.join(state, "live-tasks", "live-tasks.json"),
    context: path.join(state, "context-continuity"),
  };
}

// One digest over every file of a tree: relative path, size and content, in
// sorted order, so a rename, an addition or a rewrite each changes it.
async function treeFilesDigest(directory) {
  const hash = createHash("sha256");
  const walk = async (current, prefix) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\n`);
        await walk(target, relative);
      } else {
        const bytes = await fs.readFile(target);
        hash.update(`f:${relative}:${bytes.length}\n`);
        hash.update(bytes);
      }
    }
  };
  await walk(directory, "");
  return hash.digest("hex");
}

// The phase a task shows can lead the store behind it: after the handoff is
// offered the owner still records the host's receipt. A baseline is taken
// only once the tree has held still across several reads.
async function waitForQuiescentTree(directory, code) {
  let previous = null;
  let stable = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await treeFilesDigest(directory);
    stable = current === previous ? stable + 1 : 0;
    if (stable >= 3) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(code);
}

async function durableStateBytes(userData) {
  const files = durableStateFiles(userData);
  const digest = async (file) =>
    createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  return {
    settings: await digest(files.settings),
    tasks: await digest(files.tasks),
    context: await treeFilesDigest(files.context),
  };
}

async function runningGeneration(instance) {
  const appRoot = await instance.application.evaluate(({ app }) =>
    app.getAppPath(),
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(appRoot, "build-manifest.json"), "utf8"),
  );
  return manifest.sourceCommit;
}

async function generationSnapshot(instance) {
  const state = await instance.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  return {
    settings: state.configuration.settings,
    tasks: state.tasks.map(
      ({ taskId, sessionId, label, pinned, lifecycle, context }) => ({
        taskId,
        sessionId,
        label,
        pinned,
        lifecycle,
        context: context ?? null,
      }),
    ),
  };
}

function launchOtherGeneration(instance, generation) {
  const launched = spawnSync(generation.executable, instance.launchArgs, {
    cwd: root,
    env: instance.launchEnvironment,
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    status: launched.status,
    outcome: parseOwnerLaunchResult(`${launched.stdout}${launched.stderr}`),
  };
}

function userDataProcesses(userData) {
  const listed = spawnSync(
    "/usr/bin/pgrep",
    ["-f", userData.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")],
    { encoding: "utf8" },
  );
  assert.ok(listed.status === 0 || listed.status === 1, listed.stderr);
  return listed.stdout
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((pid) => pid !== process.pid);
}

function childProcesses(pid) {
  const listed = spawnSync("/usr/bin/pgrep", ["-P", String(pid)], {
    encoding: "utf8",
  });
  assert.ok(listed.status === 0 || listed.status === 1, listed.stderr);
  return listed.stdout.split("\n").filter(Boolean).map(Number);
}

async function waitForProcessExit(pids, userData, code) {
  let remaining = [];
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const alive = [...pids].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    });
    remaining = [...new Set([...alive, ...userDataProcesses(userData)])];
    if (remaining.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${code}:${remaining.join(",")}`);
}

async function killGeneration(application, pids, userData, code) {
  const mainPid = application.process().pid;
  const owned = new Set([mainPid, ...pids, ...childProcesses(mainPid)]);
  const closed = once(application, "close");
  process.kill(mainPid, "SIGKILL");
  await closed;
  await waitForProcessExit(owned, userData, code);
  return owned.size;
}

async function relaunchAs(instance, generation) {
  instance.application = await electron.launch({
    executablePath: generation.executable,
    args: instance.launchArgs,
    env: instance.launchEnvironment,
    timeout: 15_000,
  });
  instance.window = await instance.application.firstWindow({ timeout: 15_000 });
  await instance.window.locator("#sidebar").waitFor({ state: "visible" });
  await instance.window
    .locator('#runtime-pill[data-state="ready"]')
    .waitFor({ state: "visible" });
  const bootstrap = await instance.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  instance.presentation = await waitForWindowPresentation(
    instance.application,
    instance.windowMode,
    bootstrap.tasks.length > 0 ? 1 : 0,
  );
  assert.equal(
    await runningGeneration(instance),
    generation.sourceCommit,
    "E2E_GENERATION_IDENTITY",
  );
}

async function discardInstance(instance) {
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

async function runTwoGenerationStateProof() {
  const generationA = {
    executable: predecessor.executable,
    sourceCommit: predecessor.sourceCommit,
  };
  const generationB = { executable, sourceCommit: artifact.sourceCommit };
  const observations = {};
  const instance = await launch([], "hidden", "ordinary", {
    executable: generationA.executable,
  });
  try {
    assert.equal(await runningGeneration(instance), generationA.sourceCommit);
    await completeSetup(instance, false, true, true, true, "ordinary");
    for (let index = 0; index < 2; index += 1) {
      const created = await instance.window.evaluate(() =>
        window.farolNext.task({ kind: "task.create-chatgpt" }),
      );
      assert.equal(created.ok, true, JSON.stringify(created));
    }
    const created = await generationSnapshot(instance);
    assert.equal(created.tasks.length, 2);
    const [kept, turn] = created.tasks;
    const renamed = await instance.window.evaluate(
      (taskId) =>
        window.farolNext.task({
          kind: "task.rename",
          taskId,
          label: "Generation A task",
        }),
      kept.taskId,
    );
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    const pinned = await instance.window.evaluate(
      (taskId) =>
        window.farolNext.task({ kind: "task.pin", taskId, pinned: true }),
      kept.taskId,
    );
    assert.equal(pinned.ok, true, JSON.stringify(pinned));

    // A leaves a context handoff offered on the kept task: one completed
    // turn, then the compaction fixture has the provider write the
    // checkpoint. The handoff is an obligation B inherits unconfirmed.
    const keptActivated = await instance.window.evaluate(
      (taskId) => window.farolNext.task({ kind: "task.activate", taskId }),
      kept.taskId,
    );
    assert.equal(keptActivated.ok, true, JSON.stringify(keptActivated));
    await waitForLiveChatGptSurface(
      instance,
      kept.taskId,
      (surface) => surface.state.composerVisible,
      "kept task surface before the continuity turn",
    );
    assert.equal(
      await submitLiveChatGptTask(
        instance,
        kept.taskId,
        "Farol two-generation continuity canary",
      ),
      1,
    );
    await waitForLiveChatGptSurface(
      instance,
      kept.taskId,
      (surface) =>
        /\/chatgpt\/c\/[A-Za-z0-9-]{8,128}$/u.test(
          new URL(surface.url).pathname,
        ) &&
        surface.state.assistantText.includes(
          "keep the read-only boundary in place",
        ),
      "continuity turn completes in generation A",
    );
    await waitForPageState(
      instance.window,
      async (taskId) =>
        (await window.farolNext.bootstrap()).tasks.find(
          (task) => task.taskId === taskId,
        )?.lifecycle === "completed",
      kept.taskId,
    );
    await instance.window.evaluate((taskId) => {
      void window.farolNext.control(taskId, "compact-context-fixture");
    }, kept.taskId);
    await waitForPageState(
      instance.window,
      async (taskId) =>
        (await window.farolNext.bootstrap()).tasks.find(
          (task) => task.taskId === taskId,
        )?.context?.phase === "handoff_offered",
      kept.taskId,
      { timeout: 15_000 },
    );

    await waitForQuiescentTree(
      durableStateFiles(instance.userData).context,
      "E2E_CONTEXT_STORE_NOT_QUIESCENT",
    );
    const generationAState = await generationSnapshot(instance);
    assert.equal(generationAState.settings.computer.workspaces.length, 1);
    for (const step of ["computer", "chatgpt", "hosts"]) {
      assert.notEqual(
        generationAState.settings.setup[step].verified,
        null,
        `E2E_GENERATION_A_SETUP_NOT_VERIFIED:${step}`,
      );
    }
    assert.deepEqual(
      generationAState.tasks.map(
        ({ taskId, label, pinned, lifecycle, context }) => [
          taskId,
          label,
          pinned,
          lifecycle,
          context?.epoch ?? null,
          context?.phase ?? null,
        ],
      ),
      [
        [
          kept.taskId,
          "Generation A task",
          true,
          "completed",
          1,
          "handoff_offered",
        ],
        [turn.taskId, turn.label, false, "idle", null, null],
      ],
    );

    // B is refused while A owns the state, and A's state is untouched.
    const ownedByA = await durableStateBytes(instance.userData);
    observations.stateDigests = { ownedByA };
    assert.deepEqual(launchOtherGeneration(instance, generationB), {
      status: 0,
      outcome: "identity-mismatch",
    });
    assert.deepEqual(await durableStateBytes(instance.userData), ownedByA);
    assert.deepEqual(await generationSnapshot(instance), generationAState);

    // A dies with a provider turn running: the obligation is on disk.
    const activated = await instance.window.evaluate(
      (taskId) => window.farolNext.task({ kind: "task.activate", taskId }),
      turn.taskId,
    );
    assert.equal(activated.ok, true, JSON.stringify(activated));
    await waitForLiveChatGptSurface(
      instance,
      turn.taskId,
      (surface) => surface.state.composerVisible,
      "turn task surface before the crash",
    );
    assert.equal(
      await submitLiveChatGptTask(
        instance,
        turn.taskId,
        "Farol two-generation cancellation canary",
      ),
      1,
    );
    await waitForPageState(
      instance.window,
      async (taskId) =>
        (await window.farolNext.bootstrap()).tasks.find(
          (task) => task.taskId === taskId,
        )?.lifecycle === "running",
      turn.taskId,
    );
    const files = durableStateFiles(instance.userData);
    let persistedRunning = false;
    for (let attempt = 0; attempt < 100 && !persistedRunning; attempt += 1) {
      const record = JSON.parse(await fs.readFile(files.tasks, "utf8"));
      persistedRunning =
        record.tasks.find((task) => task.taskId === turn.taskId)?.lifecycle ===
        "running";
      if (!persistedRunning) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(persistedRunning, true, "E2E_RUNNING_TURN_NOT_PERSISTED");
    const beforeCrash = JSON.parse(await fs.readFile(files.tasks, "utf8"));
    observations.crash = {
      revision: beforeCrash.revision,
      turnLifecycle: "running",
    };
    const crashPids = await instance.application.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => metric.pid),
    );
    observations.crashedGenerationProcesses = await killGeneration(
      instance.application,
      crashPids,
      instance.userData,
      "E2E_CRASHED_GENERATION_PROCESS_SURVIVED",
    );

    // B's first activation dies before the harness waits for any window.
    const interrupted = await electron.launch({
      executablePath: generationB.executable,
      args: instance.launchArgs,
      env: instance.launchEnvironment,
      timeout: 15_000,
    });
    observations.interruptedActivationProcesses = await killGeneration(
      interrupted,
      [],
      instance.userData,
      "E2E_INTERRUPTED_ACTIVATION_PROCESS_SURVIVED",
    );
    const afterInterruption = JSON.parse(
      await fs.readFile(files.tasks, "utf8"),
    );
    // Where the activation died decides whether it had already reconciled
    // the running turn; either is a readable state, never a third one.
    observations.interruptedActivation = {
      revision: afterInterruption.revision,
      turnLifecycle: afterInterruption.tasks.find(
        (task) => task.taskId === turn.taskId,
      )?.lifecycle,
    };
    assert.deepEqual(
      afterInterruption.tasks.map(({ taskId }) => taskId),
      beforeCrash.tasks.map(({ taskId }) => taskId),
    );
    assert.ok(afterInterruption.revision >= beforeCrash.revision);
    assert.ok(
      ["running", "outcome_unknown"].includes(
        afterInterruption.tasks.find((task) => task.taskId === turn.taskId)
          ?.lifecycle,
      ),
    );

    // B activates on A's state: nothing is reset and nothing is resubmitted.
    await relaunchAs(instance, generationB);
    const generationBState = await generationSnapshot(instance);
    assert.deepEqual(generationBState.settings, generationAState.settings);
    assert.deepEqual(
      generationBState.tasks,
      generationAState.tasks.map((task) =>
        task.taskId === turn.taskId
          ? { ...task, lifecycle: "outcome_unknown" }
          : task,
      ),
    );
    // A's offered handoff reaches B byte for byte: B's start neither
    // confirms, drops nor rewrites the checkpoint store.
    assert.equal(
      (await durableStateBytes(instance.userData)).context,
      ownedByA.context,
    );
    const restoredRecord = JSON.parse(await fs.readFile(files.tasks, "utf8"));
    observations.restoredByB = { revision: restoredRecord.revision };
    assert.equal(
      restoredRecord.tasks.find((task) => task.taskId === turn.taskId)
        ?.lifecycle,
      "outcome_unknown",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const origin = new URL(instance.chatGptFixture.url).origin;
    const surfaces = await liveChatGptSurfaces(instance.application, origin);
    observations.generationBSurfaces = surfaces.length;
    assert.ok(
      surfaces.every((surface) => surface.state.submitCount === 0),
      `E2E_GENERATION_B_RESUBMITTED:${JSON.stringify(surfaces)}`,
    );
    assert.equal(
      (await generationSnapshot(instance)).tasks.find(
        (task) => task.taskId === turn.taskId,
      )?.lifecycle,
      "outcome_unknown",
    );

    // A is refused while B owns the state, and B's state is untouched.
    await waitForQuiescentTree(
      durableStateFiles(instance.userData).context,
      "E2E_CONTEXT_STORE_NOT_QUIESCENT",
    );
    const ownedByB = await durableStateBytes(instance.userData);
    observations.stateDigests.ownedByB = ownedByB;
    assert.deepEqual(launchOtherGeneration(instance, generationA), {
      status: 0,
      outcome: "identity-mismatch",
    });
    assert.deepEqual(await durableStateBytes(instance.userData), ownedByB);

    // B completes the handoff A offered: the checkpoint A's provider wrote is
    // installed by B's code, and the retained source is retired.
    const confirmed = await instance.window.evaluate(
      (taskId) => window.farolNext.control(taskId, "confirm-context-fixture"),
      kept.taskId,
    );
    assert.deepEqual(confirmed, { ok: true, phase: "active" });
    await waitForPageState(
      instance.window,
      async (taskId) => {
        const task = (await window.farolNext.bootstrap()).tasks.find(
          (candidate) => candidate.taskId === taskId,
        );
        return task?.context?.phase === "active" && task.context.epoch === 2;
      },
      kept.taskId,
    );
    const confirmedRecord = JSON.parse(await fs.readFile(files.tasks, "utf8"));
    const confirmedTask = confirmedRecord.tasks.find(
      (task) => task.taskId === kept.taskId,
    );
    assert.equal(confirmedTask?.context?.epoch, 2);
    assert.equal(confirmedTask?.context?.phase, "active");
    assert.equal(confirmedTask?.conversationUrl, null);
    const contextTasks = path.join(files.context, "tasks");
    const contextTaskDirectories = await fs.readdir(contextTasks);
    assert.equal(contextTaskDirectories.length, 1);
    for (const retired of ["sources", "summaries"]) {
      assert.deepEqual(
        await fs.readdir(
          path.join(contextTasks, contextTaskDirectories[0], retired),
        ),
        [],
        `E2E_CONTEXT_SOURCE_NOT_RETIRED:${retired}`,
      );
    }

    // B's own change survives B's restart, which rewrites nothing.
    const relabelled = await instance.window.evaluate(
      (taskId) =>
        window.farolNext.task({
          kind: "task.rename",
          taskId,
          label: "Generation B label",
        }),
      kept.taskId,
    );
    assert.equal(relabelled.ok, true, JSON.stringify(relabelled));
    const changedByB = await generationSnapshot(instance);
    assert.equal(
      changedByB.tasks.find((task) => task.taskId === kept.taskId)?.label,
      "Generation B label",
    );
    await close(instance, { removeHome: false });
    const closedByB = await durableStateBytes(instance.userData);
    observations.stateDigests.closedByB = closedByB;
    await relaunchAs(instance, generationB);
    assert.deepEqual(await generationSnapshot(instance), changedByB);
    assert.deepEqual(await durableStateBytes(instance.userData), closedByB);

    // Rollback: A reads B's state as B left it and rewrites nothing.
    await close(instance, { removeHome: false });
    const beforeRollback = await durableStateBytes(instance.userData);
    observations.stateDigests.beforeRollback = beforeRollback;
    await relaunchAs(instance, generationA);
    assert.deepEqual(await generationSnapshot(instance), changedByB);
    assert.deepEqual(
      await durableStateBytes(instance.userData),
      beforeRollback,
    );
    await close(instance);

    // Neither generation's bytes were changed by running either of them.
    assert.equal(
      await treeDigest(predecessor.appPath),
      predecessor.artifactSha256,
    );
    assert.equal(await treeDigest(appPath), artifact.artifactSha256);

    await fs.writeFile(
      path.join(evidenceRoot, "report.json"),
      `${JSON.stringify(
        {
          schema: 1,
          status: "PASS",
          evidence: "LOCAL_FIXTURE",
          sourceCommit: expectedSource.commit,
          sourceTreeDigest: expectedSource.treeDigest,
          buildId: artifact.buildId,
          builtAt: artifact.builtAt,
          predecessor: {
            sourceCommit: predecessor.sourceCommit,
            artifactSha256: predecessor.artifactSha256,
            buildId: predecessor.buildId,
            verifier: predecessor.verifier,
          },
          interruptions: [
            "generation A SIGKILL with a provider turn running",
            "generation B SIGKILL after process launch, before any window",
          ],
          observations,
          outside: [
            "ChatGPT dispatch-intent journal and undelivered agent results across generations (proven within one generation by the ordinary lanes)",
            "bundle placement and promotion between generations",
          ],
          cases: [
            "predecessor-qualified-by-own-pinned-verifier",
            "generation-a-establishes-owner-state",
            "second-generation-refused-while-first-owns-state",
            "context-handoff-survives-generation-switch",
            "crash-with-running-turn-leaves-no-process",
            "interrupted-activation-leaves-state-readable",
            "second-generation-reads-first-generation-state",
            "running-turn-restored-as-outcome-unknown-without-resubmit",
            "first-generation-refused-while-second-owns-state",
            "newer-generation-completes-older-handoff",
            "second-generation-change-survives-restart",
            "rollback-reads-newer-state-without-rewriting-it",
            "generation-bytes-unchanged",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    // A generation that is still running after a failure is closed, or
    // killed when it cannot be; the isolated home is always removed.
    // Playwright refuses process() on an application it already closed.
    let running = null;
    try {
      running = instance.application?.process() ?? null;
    } catch {
      running = null;
    }
    if (running && running.exitCode === null && running.signalCode === null) {
      await close(instance, { removeHome: false }).catch(() => {
        process.kill(running.pid, "SIGKILL");
      });
    }
    await discardInstance(instance);
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
  if (Array.isArray(written.budgetFailures) && written.budgetFailures.length) {
    evidenceAttempt.recordFailure(
      "budget",
      `E2E_BUDGET_EXCEEDED:${written.budgetFailures.join(",")}`,
    );
  }
  const passed = written.status === "PASS" && missing.length === 0;
  await evidenceAttempt.finish(passed ? "PASS" : "FAIL", {
    cases: written.cases,
  });
  if (missing.length > 0) process.exit(1);
  return passed;
}

if (lifecycleSoak) {
  await runLifecycleSoak();
  process.exit((await finishSpecialLane("lifecycle-soak")) ? 0 : 1);
}

if (persistenceFault) {
  await runLiveTaskPersistenceFaultProof();
  await finishSpecialLane("persistence-fault");
  process.exit(0);
}

if (twoGenerationState) {
  await runTwoGenerationStateProof();
  process.exit((await finishSpecialLane("two-generation-state")) ? 0 : 1);
}

await proveSecondLaunchDuringStartup();
cases.push("second-launch-waits-for-complete-primary-startup");
await proveSecondLaunchRejectsFailedStartup();
cases.push("second-launch-rejects-failed-primary-startup");

const ordinary = await launch([], "hidden", "ordinary");
ordinaryStartupSegment: try {
  if (!segmentSelected("ordinary-startup")) break ordinaryStartupSegment;
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
  assert.equal(
    await ordinary.window.evaluate(
      () => document.documentElement.dataset.browserChrome,
    ),
    "true",
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
liveTasksSegment: try {
  if (!segmentSelected("live-tasks")) break liveTasksSegment;
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
    /Your ChatGPT page opens in this tab/u,
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
  // UX-07/UX-11: long Russian and English content, the breakpoints around
  // 980 px, the minimum window, hit targets, contrast and motion are measured
  // in the DOM. A screenshot alone certifies none of them.
  const originalLabel = await ordinaryLiveTasks.window
    .locator("#dossier-title")
    .innerText();
  const longLabel =
    "Очень длинное русское название задачи для проверки усечения — long English title";
  assert.equal(longLabel.length, 80, "label uses the full 80-character limit");
  const renamedLong = await ordinaryLiveTasks.window.evaluate(
    ({ taskId, label }) =>
      window.farolNext.task({ kind: "task.rename", taskId, label }),
    { taskId: selectedLiveTaskId, label: longLabel },
  );
  assert.equal(renamedLong.ok, true, "long RU/EN label accepted");
  const uxMeasurements = {
    schema: "farol.next.ux-measurements/1",
    label: longLabel,
    breakpoint: "(max-width: 979px) selects the rail",
    widths: {},
    hitTargets: null,
    contrast: null,
    motion: null,
    glyphFallback: "not-measured",
  };
  const measureLayout = () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const within = (rect) =>
      rect.left >= -0.5 &&
      rect.top >= -0.5 &&
      rect.right <= viewport.width + 0.5 &&
      rect.bottom <= viewport.height + 0.5;
    const describe = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: element.offsetParent !== null && rect.width > 0,
        withinViewport: within(rect),
      };
    };
    const title = document.querySelector("#dossier-title");
    const titleStyle = title ? getComputedStyle(title) : null;
    const primary = document.querySelector("#new-task");
    const sidebar = document.querySelector("#sidebar");
    const controls = ["#new-task", "#command-button", "#build-identity"]
      .map((selector) => document.querySelector(selector))
      .filter((element) => element && element.offsetParent !== null);
    return {
      viewport,
      sidebar: document.documentElement.dataset.sidebar ?? null,
      horizontalOverflow: document.documentElement.scrollWidth > viewport.width,
      sidebarOverflow: sidebar
        ? sidebar.scrollWidth > sidebar.clientWidth + 1
        : null,
      title: title
        ? {
            ...describe(title),
            text: title.textContent,
            scrollWidth: title.scrollWidth,
            clientWidth: title.clientWidth,
            textOverflow: titleStyle.textOverflow,
            whiteSpace: titleStyle.whiteSpace,
            bounded:
              title.scrollWidth <= title.clientWidth + 1 ||
              (titleStyle.textOverflow === "ellipsis" &&
                titleStyle.overflowX !== "visible") ||
              titleStyle.whiteSpace !== "nowrap",
          }
        : null,
      primaryAction: primary ? describe(primary) : null,
      offscreen: controls
        .filter((element) => !within(element.getBoundingClientRect()))
        .map((element) => `#${element.id}`),
    };
  };
  for (const [width, height] of [
    [640, 520],
    [700, 520],
    [979, 600],
    [980, 600],
    [981, 600],
    [1_180, 760],
  ]) {
    await setWindowSize(ordinaryLiveTasks.application, width, height);
    await ordinaryLiveTasks.window.waitForFunction(
      (expected) => window.innerWidth === expected,
      width,
    );
    await ordinaryLiveTasks.window.waitForFunction(
      (expected) => document.documentElement.dataset.sidebar === expected,
      width <= 979 ? "rail" : "full",
    );
    const measured = await ordinaryLiveTasks.window.evaluate(measureLayout);
    uxMeasurements.widths[width] = measured;
    assert.equal(measured.horizontalOverflow, false, `overflow at ${width}`);
    assert.notEqual(
      measured.sidebarOverflow,
      true,
      `sidebar overflow at ${width}`,
    );
    assert.deepEqual(measured.offscreen, [], `controls offscreen at ${width}`);
    assert.ok(measured.primaryAction?.visible, `primary action at ${width}`);
    assert.ok(
      measured.primaryAction.width >= 24 && measured.primaryAction.height >= 24,
      `primary action target at ${width}`,
    );
    if (measured.title?.visible) {
      assert.equal(measured.title.bounded, true, `title bounded at ${width}`);
      assert.equal(
        measured.title.withinViewport,
        true,
        `title within ${width}`,
      );
      assert.ok(measured.title.text.includes("Очень длинное"), "RU rendered");
    }
  }
  uxMeasurements.hitTargets = await ordinaryLiveTasks.window.evaluate(() =>
    [
      ...document.querySelectorAll(
        "button, [role=button], a[href], input, select, textarea",
      ),
    ]
      .filter((element) => element.offsetParent !== null)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`,
          name: (
            element.getAttribute("aria-label") ??
            element.textContent ??
            ""
          )
            .trim()
            .slice(0, 40),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          primary:
            element.matches("#new-task, #command-button, .nav-item") === true,
        };
      }),
  );
  const smallPrimaryTargets = uxMeasurements.hitTargets.filter(
    (target) => target.primary && (target.width < 24 || target.height < 24),
  );
  assert.deepEqual(smallPrimaryTargets, [], "primary targets are 24px or more");
  // Contrast is measured with the window focused and unfocused: the lanes
  // never take focus, so the focused styling the owner sees while working
  // would otherwise go unmeasured.
  uxMeasurements.contrast = [];
  for (const windowActive of ["true", "false"]) {
    uxMeasurements.contrast.push(
      ...(await ordinaryLiveTasks.window.evaluate((state) => {
        const root = document.documentElement;
        const previous = root.dataset.windowActive;
        root.dataset.windowActive = state;
        try {
          const parse = (color) => {
            const match = /rgba?\(([^)]+)\)/u.exec(color);
            if (!match) return null;
            const [r, g, b, a = 1] = match[1].split(",").map(Number);
            return { r, g, b, a };
          };
          const channel = (value) => {
            const c = value / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          };
          const luminance = ({ r, g, b }) =>
            0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          const blend = (top, under) => ({
            r: top.r * top.a + under.r * (1 - top.a),
            g: top.g * top.a + under.g * (1 - top.a),
            b: top.b * top.a + under.b * (1 - top.a),
            a: 1,
          });
          const background = (element) => {
            let node = element;
            while (node) {
              const color = parse(getComputedStyle(node).backgroundColor);
              if (color && color.a > 0) {
                if (color.a >= 1) return color;
                return blend(color, background(node.parentElement));
              }
              node = node.parentElement;
            }
            return (
              parse(getComputedStyle(document.body).backgroundColor) ?? {
                r: 10,
                g: 10,
                b: 13,
                a: 1,
              }
            );
          };
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
          );
          const seen = new Set();
          const rows = [];
          while (walker.nextNode()) {
            const text = walker.currentNode.textContent.trim();
            const element = walker.currentNode.parentElement;
            if (!text || !element || seen.has(element)) continue;
            if (element.offsetParent === null) continue;
            seen.add(element);
            // Inactive controls are dimmed by design and exempt from the ratio;
            // they are recorded, not measured.
            if (
              element.closest(
                "button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled='true']",
              )
            ) {
              rows.push({
                element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`,
                exempt: "disabled",
                passes: true,
              });
              continue;
            }
            const style = getComputedStyle(element);
            const color = parse(style.color);
            if (!color || color.a === 0) continue;
            const size = Number.parseFloat(style.fontSize);
            const weight = Number.parseInt(style.fontWeight, 10) || 400;
            const large = size >= 24 || (size >= 18.66 && weight >= 700);
            const under = background(element);
            const foreground = color.a < 1 ? blend(color, under) : color;
            const l1 = luminance(foreground);
            const l2 = luminance(under);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const required = large ? 3 : 4.5;
            rows.push({
              element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
                typeof element.className === "string" &&
                element.className.trim()
                  ? `.${element.className.trim().split(/\s+/u).join(".")}`
                  : ""
              }`,
              fontSize: size,
              fontWeight: weight,
              large,
              ratio: Math.round(ratio * 100) / 100,
              required,
              passes: ratio >= required,
            });
          }
          return rows.map((row) => ({ ...row, windowActive: state }));
        } finally {
          root.dataset.windowActive = previous;
        }
      }, windowActive)),
    );
  }
  const contrastFailures = uxMeasurements.contrast.filter((row) => !row.passes);
  assert.deepEqual(contrastFailures, [], "every visible text meets WCAG AA");
  const animatedElements = () =>
    ordinaryLiveTasks.window.evaluate(() => {
      const animated = [];
      for (const element of document.querySelectorAll("*")) {
        const style = getComputedStyle(element);
        const transitions = style.transitionDuration
          .split(",")
          .some((value) => Number.parseFloat(value) > 0);
        const animations =
          style.animationName !== "none" &&
          style.animationDuration
            .split(",")
            .some((value) => Number.parseFloat(value) > 0);
        if (transitions || animations) {
          animated.push(
            `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`,
          );
        }
      }
      return {
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        animated,
      };
    });
  const motionDefault = await animatedElements();
  await ordinaryLiveTasks.window.emulateMedia({ reducedMotion: "reduce" });
  const motionReduced = await animatedElements();
  await ordinaryLiveTasks.window.emulateMedia({
    reducedMotion: "no-preference",
  });
  uxMeasurements.motion = { default: motionDefault, reduced: motionReduced };
  assert.equal(motionReduced.reduced, true, "reduced motion emulated");
  assert.deepEqual(
    motionReduced.animated,
    [],
    "no motion under reduced motion",
  );
  await fs.writeFile(
    path.join(evidenceRoot, "ux-measurements.json"),
    `${JSON.stringify(uxMeasurements, null, 2)}\n`,
  );
  const renamedBack = await ordinaryLiveTasks.window.evaluate(
    ({ taskId, label }) =>
      window.farolNext.task({ kind: "task.rename", taskId, label }),
    { taskId: selectedLiveTaskId, label: originalLabel },
  );
  assert.equal(renamedBack.ok, true);
  await waitForLiveChatGptSurface(
    ordinaryLiveTasks,
    selectedLiveTaskId,
    (surface) => surface.hostVisible && surface.hostBounds.x === 216,
    "wide layout restored after measurements",
  );
  cases.push(
    "layout-breakpoints-long-content",
    "hit-targets-measured",
    "accessible-contrast-measured",
    "reduced-motion-measured",
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
  await waitForTaskMenuNote(ordinaryLiveTasks, "Task renamed.");
  await ordinaryLiveTasks.window.locator("#task-menu-pin").click();
  await waitForTaskMenuNote(ordinaryLiveTasks, "Task pinned.");
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
  // Seven durable task mutations of this run, plus the two renames the
  // UX measurement block made and undid.
  assert.equal(managedState.taskRevision, 9);
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
  // The same nine durable mutations the pin above counts.
  assert.equal(idleCancel.state.revision, 9);
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
  await waitForPageState(
    ordinaryLiveTasks.window,
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
  await waitForPageState(
    ordinaryLiveTasks.window,
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
  await waitForTaskMenuNote(ordinaryLiveTasks, "Provider stop confirmed.");
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

  let productAgentTask;
  let cancelledProductAgentInput;
  let assignmentRoot;
  if (positiveProductAgentQualification) {
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
    await ordinaryLiveTasks.window
      .locator("#task-agent-paths")
      .fill("README.md");
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
    await waitForTaskMenuNote(ordinaryLiveTasks, "Agent assignment admitted.");
    assert.equal(
      await ordinaryLiveTasks.window
        .locator("#task-menu-agent span")
        .innerText(),
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
    productAgentTask = productAgentBootstrap.tasks.find(
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
      await ordinaryLiveTasks.window
        .locator("#task-menu-close-task")
        .isEnabled(),
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
    await waitForTaskMenuNote(ordinaryLiveTasks, "Agent assignment admitted.");
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
    await waitForTaskMenuNote(
      ordinaryLiveTasks,
      "Agent cancellation confirmed.",
    );
    await ordinaryLiveTasks.window.waitForFunction(
      () =>
        document.querySelector("#task-agent-state small")?.textContent ===
        "Cancelled",
    );
    const cancelledAgentBootstrap = await ordinaryLiveTasks.window.evaluate(
      () => window.farolNext.bootstrap(),
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
      await ordinaryLiveTasks.window
        .locator("#task-menu-close-task")
        .isEnabled(),
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
    cancelledProductAgentInput = productAgentInputs.find(({ text }) =>
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
    assert.deepEqual(
      deliveredProductAgentInput.envelope.input.excludedPaths,
      [],
    );
    assert.equal(cancelledProductAgentInput.envelope.schema, 2);
    assert.deepEqual(cancelledProductAgentInput.envelope.input.scope, {
      mode: "subtree",
      root: ordinaryLiveTasks.workspaceRoot,
    });
    assert.deepEqual(
      cancelledProductAgentInput.envelope.input.excludedPaths,
      [],
    );
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

    assignmentRoot = path.join(
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
    assert.equal(
      cancelledProductAssignment.record.assignment.phase,
      "cancelled",
    );
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
  } else {
    const before = await ordinaryLiveTasks.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.equal(before.nativeAgent, false);
    const hostStartsPath = path.join(
      ordinaryLiveTasks.isolatedHome,
      "codex-app-server-starts",
    );
    const readHostStarts = () =>
      fs.readFile(hostStartsPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    const hostRequestsPath = path.join(
      ordinaryLiveTasks.isolatedHome,
      "codex-agent-requests",
    );
    const readHostRequests = () =>
      fs.readFile(hostRequestsPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    const assignmentDirectory = path.join(
      ordinaryLiveTasks.userData,
      "farol-next-state",
      "native-agent-assignments",
      "assignments",
    );
    const listJson = (directory) =>
      fs
        .readdir(directory)
        .then((entries) => entries.filter((entry) => entry.endsWith(".json")))
        .catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
    const productInputDirectory = path.join(
      ordinaryLiveTasks.userData,
      "farol-next-state",
      "product-agent-inputs",
    );
    const hostStartsBefore = await readHostStarts();
    const hostRequestsBefore = await readHostRequests();
    const assignmentsBefore = await listJson(assignmentDirectory);
    assert.deepEqual(await listJson(productInputDirectory), []);
    for (const kind of ["task.start-agent", "task.rejoin-agent"]) {
      const result = await ordinaryLiveTasks.window.evaluate(
        ({ kind, taskId, workspaceId }) =>
          window.farolNext.task({
            kind,
            taskId,
            ...(kind === "task.start-agent"
              ? {
                  workspaceId,
                  objective: "Default-off admission must not contact the host.",
                  scope: { mode: "workspace", excludedPaths: [] },
                }
              : {}),
          }),
        {
          kind,
          taskId: pinnedTask.taskId,
          workspaceId:
            admittedState.configuration.settings.computer.workspaces[0]
              .workspaceId,
        },
      );
      assert.equal(result.ok, false, kind);
      assert.equal(result.error, "AGENT_NOT_READY", kind);
    }
    const after = await ordinaryLiveTasks.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.equal(after.nativeAgent, false);
    assert.equal(after.taskRevision, before.taskRevision);
    const refusedTask = after.tasks.find(
      (task) => task.taskId === pinnedTask.taskId,
    );
    assert.ok(refusedTask);
    assert.equal(Object.hasOwn(refusedTask, "agent"), false);
    assert.equal(await readHostStarts(), hostStartsBefore);
    assert.equal(await readHostRequests(), hostRequestsBefore);
    assert.deepEqual(await listJson(assignmentDirectory), assignmentsBefore);
    assert.deepEqual(await listJson(productInputDirectory), []);
    cases.push("live-task-product-agent-disabled-no-host-child-effects");
  }

  const liveTaskRoot = path.join(
    ordinaryLiveTasks.userData,
    "farol-next-state",
    "live-tasks",
  );
  const liveTaskPath = path.join(liveTaskRoot, "live-tasks.json");
  const liveTaskText = await fs.readFile(liveTaskPath, "utf8");
  const liveTaskRecord = JSON.parse(liveTaskText);
  assert.equal(liveTaskRecord.schema, 1);
  assert.ok(liveTaskRecord.revision > admittedState.taskRevision);
  assert.equal(liveTaskRecord.tasks.length, 4);
  assert.equal(liveTaskRecord.tasks[0].taskId, pinnedTask.taskId);
  assert.equal(liveTaskRecord.tasks[0].label, "Pinned continuity task");
  assert.equal(liveTaskRecord.tasks[0].pinned, true);
  assert.equal(liveTaskRecord.tasks[0].lifecycle, "completed");
  if (positiveProductAgentQualification) {
    assert.deepEqual(liveTaskRecord.tasks[0].agent, productAgentTask.agent);
  } else {
    assert.equal(Object.hasOwn(liveTaskRecord.tasks[0], "agent"), false);
  }
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
    )?.agent?.phase ?? null,
    positiveProductAgentQualification ? "cancelled" : null,
  );
  assert.deepEqual(Object.keys(liveTaskRecord.tasks[0]).sort(), [
    ...(positiveProductAgentQualification ? ["agent"] : []),
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
  await waitForPageState(
    ordinaryLiveTasks.window,
    async (taskId) => {
      const state = await window.farolNext.bootstrap();
      return (
        state.tasks.find((task) => task.taskId === taskId)?.context?.phase ===
          "checkpoint_requested" &&
        document.querySelector("#dossier-state b")?.textContent ===
          "PRESERVING CONTEXT"
      );
    },
    pinnedTask.taskId,
  );
  await waitForPageState(
    ordinaryLiveTasks.window,
    async (taskId) => {
      const state = await window.farolNext.bootstrap();
      return (
        state.tasks.find((task) => task.taskId === taskId)?.context?.phase ===
        "handoff_offered"
      );
    },
    pinnedTask.taskId,
  );
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

  if (positiveProductAgentQualification) {
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
    await waitForTaskMenuNote(ordinaryLiveTasks, "Agent assignment admitted.");
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
    await waitForPageState(
      ordinaryLiveTasks.window,
      async (taskId) => {
        const state = await window.farolNext.bootstrap();
        return (
          state.tasks.find((task) => task.taskId === taskId)?.agent?.phase ===
          "cancelled"
        );
      },
      agentCancellationTask.taskId,
    );
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
  } else {
    await restart(ordinaryLiveTasks);
    await ordinaryLiveTasks.window.waitForFunction(
      () => document.querySelectorAll("#task-tabs .task-tab").length === 4,
    );
    await waitForWindowCount(ordinaryLiveTasks.application, 1);
    const recoveredState = await ordinaryLiveTasks.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.equal(recoveredState.nativeAgent, false);
    assert.deepEqual(
      recoveredState.tasks,
      handoffLiveTaskRecord.tasks.map(
        ({ conversationUrl: _conversationUrl, ...task }) => task,
      ),
    );
  }
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
  await waitForPageState(
    ordinaryLiveTasks.window,
    async (taskId) => {
      const state = await window.farolNext.bootstrap();
      const task = state.tasks.find((candidate) => candidate.taskId === taskId);
      return task?.context?.phase === "active" && task.context.epoch === 2;
    },
    pinnedTask.taskId,
  );
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
    "live-task-context-preservation-visible",
    "live-task-context-handoff-survives-restart",
    "live-task-context-confirmation-retires-source",
  );
  if (positiveProductAgentQualification) {
    cases.push(
      "live-task-native-agent-product-objective",
      "live-task-native-agent-same-child-rejoin",
      "live-task-native-agent-result-delivery-acknowledged",
      "live-task-native-agent-private-input",
      "live-task-native-agent-content-free-recovery",
      "live-task-native-agent-owner-exact-path-narrowing",
      "live-task-native-agent-cancel-confirmed",
      "live-task-native-agent-expiry-cancelled-after-restart",
    );
  }
} finally {
  await close(ordinaryLiveTasks);
}

devNewTaskAffordanceSegment: {
  if (
    !shouldRunDevelopmentSegment(
      selection,
      development,
      "dev-new-task-affordance",
    )
  ) {
    break devNewTaskAffordanceSegment;
  }
  segmentMark("dev-new-task-affordance", "start");
  const devNewTask = await launch([], "secondary-visible", "ordinary", {
    environment: { FAROL_NEXT_ENVIRONMENT: "dev" },
  });
  try {
    const resolvedProfile = await devNewTask.application.evaluate(
      ({ app }) => ({
        userData: app.getPath("userData"),
        sessionData: app.getPath("sessionData"),
      }),
    );
    assert.deepEqual(resolvedProfile, {
      userData: path.join(devNewTask.isolatedAppData, "Farol Dev"),
      sessionData: path.join(devNewTask.isolatedAppData, "Farol Dev"),
    });
    assert.equal(devNewTask.presentation.taskViewCount, 0);

    assert.equal(
      await devNewTask.window.locator("#guided-onboarding").isVisible(),
      true,
    );
    await devNewTask.window.locator('[data-onboarding-step="chatgpt"]').click();
    await devNewTask.window
      .locator("#onboarding-open-account")
      .waitFor({ state: "visible" });

    // The DEV route points only at this run's local loopback fixture. Open
    // it through Setup's public controls and drive only its synthetic login
    // and Return buttons; no model turn, folder access, Agent, or message is sent.
    const signInFixtureOrigin = new URL(devNewTask.chatGptFixture.url).origin;
    const readSignInFixture = () =>
      devNewTask.application.evaluate(
        async ({ BrowserWindow }, expectedOrigin) => {
          const host = BrowserWindow.getAllWindows().find((candidate) => {
            const url = candidate.webContents.getURL();
            return (
              candidate.getTitle() === "Farol Dev · Development" &&
              url.startsWith("file:") &&
              url.endsWith("/shell.html")
            );
          });
          const view = (host?.contentView.children ?? []).find((candidate) => {
            if (!("webContents" in candidate)) return false;
            try {
              return (
                new URL(candidate.webContents.getURL()).origin ===
                expectedOrigin
              );
            } catch {
              return false;
            }
          });
          if (!view || !("webContents" in view)) return null;
          const state = await view.webContents.executeJavaScript(`(() => {
            const login = document.querySelector('[data-testid="login-button"]');
            const composer = document.querySelector('#prompt-textarea');
            return {
              url: location.href,
              loginVisible: login instanceof HTMLButtonElement && !login.hidden,
              composerVisible: composer instanceof HTMLElement && !composer.hidden,
              userText: [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.textContent ?? "",
              submitCount: Number(window.__farolSubmitCount ?? 0)
            };
          })()`);
          return {
            url: view.webContents.getURL(),
            visible: view.getVisible(),
            state,
          };
        },
        signInFixtureOrigin,
      );
    const waitForSignInFixture = async (predicate) => {
      let last = null;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        last = await readSignInFixture();
        if (last && predicate(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        `E2E_DEV_SIGN_IN_FIXTURE_TIMEOUT:${JSON.stringify(last)}`,
      );
    };
    const clickSignInFixtureLogin = () =>
      devNewTask.application.evaluate(
        async ({ BrowserWindow }, expectedOrigin) => {
          const host = BrowserWindow.getAllWindows().find((candidate) => {
            const url = candidate.webContents.getURL();
            return (
              candidate.getTitle() === "Farol Dev · Development" &&
              url.startsWith("file:") &&
              url.endsWith("/shell.html")
            );
          });
          const view = (host?.contentView.children ?? []).find((candidate) => {
            if (!("webContents" in candidate)) return false;
            try {
              return (
                new URL(candidate.webContents.getURL()).origin ===
                expectedOrigin
              );
            } catch {
              return false;
            }
          });
          if (!view || !("webContents" in view)) return false;
          const source = `(() => {
            const button = document.querySelector('[data-testid="login-button"]');
            if (!(button instanceof HTMLButtonElement) || button.hidden || button.disabled) return false;
            button.click();
            return true;
          })()`;
          return view.webContents.executeJavaScript(source);
        },
        signInFixtureOrigin,
      );

    await devNewTask.window.locator("#onboarding-open-account").click();
    const signInSurface = await waitForSignInFixture(
      (surface) => surface.visible && surface.state.loginVisible,
    );
    assert.equal(new URL(signInSurface.url).origin, signInFixtureOrigin);
    assert.equal(
      await clickSignInFixtureLogin(),
      true,
      "the local fixture's visible login control is enabled",
    );
    const signedInFixture = await waitForSignInFixture(
      (surface) => surface.state.composerVisible,
    );
    assert.deepEqual(
      {
        userText: signedInFixture.state.userText,
        submitCount: signedInFixture.state.submitCount,
      },
      { userText: "", submitCount: 0 },
    );
    await devNewTask.window
      .locator("#sign-in-return")
      .waitFor({ state: "visible" });
    await devNewTask.window.locator("#sign-in-return").click();
    await waitForSignInFixture((surface) => !surface.visible);
    await waitForWindowCount(devNewTask.application, 1);
    await devNewTask.window.waitForFunction(
      () =>
        document.documentElement.dataset.guidedOnboarding === "true" &&
        document.querySelector("#onboarding-recheck")?.textContent ===
          "Check sign-in" &&
        document.querySelector("#onboarding-recheck")?.hidden === false,
    );
    await devNewTask.window.locator("#onboarding-recheck").click();
    await waitForPageState(devNewTask.window, async () => {
      const state = await window.farolNext.bootstrap();
      return (
        state.configuration.settings.setup.chatgpt.verified?.profile ===
        "chatgpt.next-partition/1"
      );
    });
    await devNewTask.window.locator("#onboarding-back").click();
    await devNewTask.window.waitForFunction(
      () =>
        document.querySelector("#onboarding-title")?.textContent ===
          "ChatGPT is ready" &&
        document.querySelector("#onboarding-primary")?.textContent ===
          "Open ChatGPT",
    );
    await devNewTask.window.locator("#onboarding-primary").click();
    await devNewTask.window.waitForFunction(
      () =>
        document.documentElement.dataset.guidedOnboarding === "false" &&
        document.documentElement.dataset.section === "browser" &&
        document.documentElement.dataset.browserChrome === "true",
    );
    const newTask = devNewTask.window.locator("#new-task");
    await newTask.waitFor({ state: "visible" });

    const initial = await devNewTask.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.deepEqual(initial.tasks, []);
    assert.equal(initial.liveProvider, false);
    assert.equal(initial.nativeAgent, false);
    assert.equal(initial.configuration.settings.nativeHosts.codex, null);
    assert.equal(initial.configuration.settings.setup.hosts.verified, null);
    assert.equal(initial.configuration.settings.setup.computer.verified, null);

    const readNewTaskState = () =>
      newTask.evaluate((button) => ({
        environment: document.documentElement.dataset.environment,
        section: document.documentElement.dataset.section,
        browserChrome: document.documentElement.dataset.browserChrome,
        hasTasks: document.documentElement.dataset.hasTasks,
        display: getComputedStyle(button).display,
        appRegion:
          getComputedStyle(button).getPropertyValue("-webkit-app-region"),
      }));

    assert.equal(await newTask.isEnabled(), true);
    assert.equal(await newTask.locator("small").innerText(), "0 / 5");
    const emptyState = await readNewTaskState();
    assert.equal(emptyState.environment, "dev");
    assert.equal(emptyState.section, "browser");
    assert.equal(emptyState.browserChrome, "true");
    assert.equal(emptyState.hasTasks, "false");
    assert.notEqual(emptyState.display, "none");
    assert.equal(emptyState.appRegion, "no-drag");
    cases.push("dev-new-task-first-is-reachable");

    for (let index = 1; index <= 5; index += 1) {
      await newTask.click();
      await waitForPageState(
        devNewTask.window,
        async (count) => {
          const state = await window.farolNext.bootstrap();
          const button = document.querySelector("#new-task");
          return (
            state.taskRevision === count &&
            state.tasks.length === count &&
            button instanceof HTMLButtonElement &&
            button.disabled === (count === 5) &&
            button.querySelector("small")?.textContent === `${count} / 5`
          );
        },
        index,
      );
      const state = await devNewTask.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.equal(state.taskRevision, index);
      assert.equal(state.tasks.length, index);
      assert.equal(state.liveProvider, false);
      assert.equal(state.nativeAgent, false);
      assert.equal(state.configuration.settings.nativeHosts.codex, null);
      assert.equal(state.configuration.settings.setup.hosts.verified, null);
      assert.equal(await newTask.isVisible(), true);
      assert.equal(await newTask.isDisabled(), index === 5);
      assert.equal(await newTask.locator("small").innerText(), index + " / 5");
      const activeState = await readNewTaskState();
      assert.equal(activeState.environment, "dev");
      assert.equal(activeState.section, "browser");
      assert.equal(activeState.browserChrome, "true");
      assert.equal(activeState.hasTasks, "true");
      assert.notEqual(activeState.display, "none");
      assert.equal(activeState.appRegion, "no-drag");

      const task = state.tasks[index - 1];
      assert.equal(task.provider, "chatgpt");
      assert.equal(task.requestedModel, "Account default");
      assert.equal(task.observedModel, null);
      const providerSurface = await waitForLiveChatGptSurface(
        devNewTask,
        task.taskId,
        (surface) =>
          surface.hostVisible &&
          surface.state.composerVisible &&
          new URL(surface.url).origin ===
            new URL(devNewTask.chatGptFixture.url).origin &&
          new URL(surface.url).searchParams.get("farol-e2e-task") ===
            task.taskId,
        "dev New task " + index + " local fixture surface",
      );
      assert.equal(providerSurface.state.composerVisible, true);
      assert.equal(providerSurface.state.userText, "");
      assert.equal(providerSurface.state.submitCount, 0);
      if (index === 2) cases.push("dev-new-task-next-is-reachable");
    }
    cases.push("dev-new-task-disabled-at-capacity");
    segmentMark("dev-new-task-affordance", "pass");
  } finally {
    await close(devNewTask);
  }
}

const interruptedChatGptTask = await launch([], "hidden", "ordinary", {
  seedChatGptDispatchIntent: true,
});
chatgptRecoverySegment: try {
  if (!segmentSelected("chatgpt-recovery")) break chatgptRecoverySegment;
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
  // A fresh profile opens first-run Setup, which is modal: the recovery
  // notice must be on the Setup dialog the owner is looking at, not on the
  // Settings panel the dialog covers.
  await interruptedChatGptTask.window
    .locator("#setup-dialog")
    .waitFor({ state: "visible" });
  await interruptedChatGptTask.window.waitForFunction(
    () =>
      document
        .querySelector("#setup-feedback")
        ?.textContent?.includes("Nothing was submitted again") === true,
  );
  await waitForPageState(
    interruptedChatGptTask.window,
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
demoMainSegment: try {
  if (!segmentSelected("demo-main")) break demoMainSegment;
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
  // Activation is a property of the asking process, so the two top-level
  // second-launch probes cannot be sampled after the fact — they run before
  // this instance exists and each launch is its own process. What can be
  // bracketed is this instance's own lifetime, and that is what these three
  // samples do: after Setup, after the workspace stretch, after the support
  // export, with the mismatched-build reading already in place.
  await markActivation(normal.application, "after demo Setup completed");
  // Setup's last message is not lost with the dialog: it moves to Connections
  // (finishing Setup opens ChatGPT, so Connections is not shown yet).
  await normal.window
    .locator("#computer-feedback")
    .getByText("Setup saved. Limited mode is open.", { exact: true })
    .waitFor({ state: "attached" });
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
    // Traffic-light x 14 + cluster width 52 + clearance 12
    // (window-chrome-geometry.ts sidebarToggleLeft).
    assert.equal(initialWatchGeometry.toggle.x, 78);
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
  await normal.window.locator("#open-connections").click();
  await normal.window.locator('[data-panel="computer"].active').waitFor();
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
    .locator("#computer-feedback")
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
    .locator("#computer-feedback")
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
    .locator("#computer-feedback")
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
  await invokeApplicationMenu(normal.application, "app.settings");
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  const settingsPanel = normal.window.locator('[data-panel="settings"]');
  assert.equal(await settingsPanel.locator("#computer-name").count(), 1);
  assert.equal(await settingsPanel.locator("#add-workspace").count(), 1);
  cases.push("settings-owns-computer-workspaces");
  await normal.window.locator("#computer-name").fill("Owner Test Mac");
  await normal.window.locator("#save-computer-name").click();
  await normal.window
    .locator("#settings-feedback")
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
    .getByRole("button", { name: "Verify folder", exact: true })
    .click();
  await normal.window
    .locator("#computer-workspaces")
    .getByText(/read-only · verified/u)
    .waitFor();
  // Verify proves the folder opens by identity and lists its top level; it
  // reads no file (UX34-01), so there is no file-read evidence.
  await normal.window
    .locator("#settings-feedback")
    .getByText("Farol can open approved-workspace (1 item at the top level).", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await normal.window.locator(".workspace-read-evidence").count(),
    0,
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
    .locator("#settings-feedback")
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
    .locator("#settings-feedback")
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
    .getByLabel("Computer command authority", { exact: true })
    .selectOption("verification");
  await commandPolicy
    .getByRole("button", { name: "Apply", exact: true })
    .click();
  await normal.window
    .locator("#settings-feedback")
    .getByText(
      "Command authority changed. Verify the workspace again before use.",
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
    .getByRole("button", { name: "Verify folder", exact: true })
    .click();
  await workspaceCard.getByText(/read-only · verified/u).waitFor();
  const gitStatus = workspaceCard.getByRole("button", {
    name: "Git status",
    exact: true,
  });
  assert.equal(await gitStatus.isEnabled(), true);
  await gitStatus.click();
  // N02: Git runs over a private point-in-time clone of the approved folder,
  // never the folder itself; both fixed verifications are unconditional
  // positive cases.
  const gitHead = workspaceCard.getByRole("button", {
    name: "Git HEAD",
    exact: true,
  });
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText(/Git status · exit 0 · \d+ bytes · network none/u)
    .waitFor();
  await workspaceCard
    .locator(".workspace-query-evidence")
    .getByText(/## main/u)
    .waitFor();
  await normal.window
    .locator("#settings-feedback")
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
    .locator("#settings-feedback")
    .getByText(
      /^Fixed Git HEAD completed · exit 0 · \d+ bytes · network none\.$/u,
    )
    .waitFor();
  cases.push(
    "workspace-command-fixed-no-network",
    "workspace-command-exact-head",
  );
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
    .locator("#settings-feedback")
    .getByText("approved-workspace exclusions saved and read back.", {
      exact: true,
    })
    .waitFor();
  await normal.window
    .locator("#computer-workspaces")
    .getByRole("button", { name: "Verify folder", exact: true })
    .click();
  // The excluded README.md is not listed: the top level reads as empty.
  await normal.window
    .locator("#settings-feedback")
    .getByText(
      "Farol can open approved-workspace (0 items at the top level).",
      {
        exact: true,
      },
    )
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
    .locator("#settings-feedback")
    .getByText("approved-workspace exclusions saved and read back.", {
      exact: true,
    })
    .waitFor();
  await normal.window
    .locator("#computer-workspaces")
    .getByRole("button", { name: "Verify folder", exact: true })
    .click();
  await normal.window
    .locator("#settings-feedback")
    .getByText("Farol can open approved-workspace (1 item at the top level).", {
      exact: true,
    })
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
    .getByRole("button", { name: "Verify folder", exact: true })
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
    .locator("#settings-feedback")
    .getByText("Edited README.md once · durable.", { exact: true })
    .waitFor();
  assert.equal(
    await fs.readFile(normal.workspaceFile, "utf8"),
    "Farol Next guarded workspace mutation fixture\n",
  );
  await workspaceCard
    .getByRole("button", { name: "Git status", exact: true })
    .click();
  // N02: the guarded edit above changed README.md through the owner's own
  // path; the status rendered over the private clone must carry that exact
  // record -- a raw `--short`-style line, no quoting.
  const changedStatusEvidence = workspaceCard
    .locator(".workspace-query-evidence")
    .filter({ hasText: /Git status · exit 0/u });
  await changedStatusEvidence.getByText(/README\.md/u).waitFor();
  const changedStatusOutput =
    (await changedStatusEvidence.locator("pre").textContent()) ?? "";
  assert.match(
    changedStatusOutput,
    /(?:^|\n) M README\.md(?:\n|$)/u,
    `Git status output ${JSON.stringify(changedStatusOutput)}`,
  );
  cases.push("workspace-command-observes-real-change");
  await markActivation(normal.application, "after the workspace stretch");
  cases.push(
    "workspace-write-access-explicit",
    "workspace-guarded-edit-atomic",
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
  await markActivation(normal.application, "after the support export");
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
  await normal.window.locator("#open-connections").click();
  await normal.window.locator('[data-panel="computer"].active').waitFor();
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
    } finally {
      // Written whether focus was acquired or refused: a blocked row is the
      // case this file exists for, and one summary line in an error message
      // could not say which window held focus or which display it was on.
      await fs
        .writeFile(
          path.join(evidenceRoot, "native-focus-samples.json"),
          `${JSON.stringify(nativeFocusSamples, null, 2)}\n`,
          { mode: 0o600 },
        )
        .catch(() => undefined);
      process.stdout.write(
        `E2E_NATIVE_FOCUS samples=${nativeFocusSamples.length} first=${JSON.stringify(nativeFocusSamples[0] ?? null)} last=${JSON.stringify(nativeFocusSamples.at(-1) ?? null)}\n`,
      );
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
        assert.equal((await watchRailGeometry(normal.window)).toggle.x, 23);
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
  await markActivation(normal.application, "before mismatched-build refusal");
  await rejectMismatchedBuildLaunch(normal);
  await markActivation(normal.application, "after mismatched-build refusal");
  // Printed here rather than only beside the reopen timeline: a lane that
  // dies earlier still has to answer where activation arrived.
  process.stdout.write(`E2E_ACTIVATION ${JSON.stringify(activationSamples)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitForWindowCount(normal.application, 0);
  // Sampling starts BEFORE the second launch is spawned. Beginning after
  // it exits can only ever show the state afterwards, which cannot tell a
  // window that was focused all along from one handed activation when the
  // secondary quit — the difference that decides whether this is a harness
  // artefact or the deferring second instance entering the activation order.
  let activeBeforeReopen = await markActivation(
    normal.application,
    "before establishing the inactive reopen baseline",
  );
  let focusFixture = null;
  let fixtureReason = null;
  // The fixture deliberately takes native focus. It may run only in the
  // explicitly authorized built-in-display focus lane; a skip-focus run or
  // the ordinary secondary-display lane must retain a blocked reopen row.
  if (
    activeBeforeReopen === true &&
    !skipNativeFocus &&
    builtInDisplayOnly &&
    allowPrimaryDisplay &&
    macHostLockState !== "locked"
  ) {
    const established = await establishOwnedInactiveBaseline(
      normal.application,
    );
    focusFixture = established.fixture;
    fixtureReason = established.reason;
  }
  activeBeforeReopen = await markActivation(
    normal.application,
    "immediately before the second launch",
  );
  const reopenedWindow = normal.application.waitForEvent("window", {
    timeout: 15_000,
  });
  // This is an observation of the actual native application state. The
  // owned fixture may establish it, but neither a Boolean nor blur() can.
  const reopenFocus = sampleWindowFocus(normal.application, Date.now() + 6_000);
  let reopenPresentationError = null;
  let reopenPresentation = null;
  let reopenFocusSamples = null;
  let activeAfterPresentation = null;
  try {
    await repeatLaunch(normal);
    await markActivation(normal.application, "after the second launch exited");
    normal.window = await reopenedWindow;
    await normal.window.locator("#sidebar").waitFor({ state: "visible" });
    await normal.window.locator('[data-panel="settings"].active').waitFor();
    reopenPresentation = await waitForWindowPresentation(
      normal.application,
      normal.windowMode,
      2,
      { focusProof: activeBeforeReopen === false },
    );
    activeAfterPresentation = await markActivation(
      normal.application,
      "after the reopened window was presented with the fixture still active",
    );
    if (activeBeforeReopen === false) {
      assert.equal(
        activeAfterPresentation,
        false,
        "E2E_REOPEN_ACTIVATED_APPLICATION",
      );
    }
  } catch (error) {
    reopenPresentationError = error;
  } finally {
    try {
      reopenFocusSamples = await reopenFocus;
    } finally {
      await closeOwnedFocusFixture(focusFixture);
    }
  }
  if (activeBeforeReopen !== false) {
    blockedCases.push({
      name: "reopened-window-presented-inactive",
      reason: `no measured inactive application baseline before reopen${fixtureReason ? ` · ${fixtureReason}` : ""} · isActive before ${activeBeforeReopen}, after ${activeAfterPresentation}, observed focused ${String(reopenPresentation?.focused ?? "unknown")}`,
    });
  }
  const reopenTimeline = {
    activeBeforeReopen,
    activation: activationSamples,
    secondary: lastSecondaryLaunch,
    samples: reopenFocusSamples,
  };
  process.stdout.write(`E2E_REOPEN_FOCUS ${JSON.stringify(reopenTimeline)}\n`);
  if (reopenPresentationError) {
    throw new Error(
      `${reopenPresentationError.message} · reopen timeline ${JSON.stringify(reopenTimeline)}`,
      { cause: reopenPresentationError },
    );
  }
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
  await assertSameFixtureExecutable(
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
  await normal.window.locator("#open-connections").click();
  await normal.window.locator('[data-panel="computer"].active').waitFor();
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
    .locator("#computer-feedback")
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
  // Closing the owner-opened sign-in window deliberately returns to
  // Settings. Re-enter Connections through its canonical Settings action
  // before operating on the retained conversation binding.
  await normal.window.locator('[data-panel="settings"].active').waitFor();
  await normal.window.locator("#open-connections").click();
  await normal.window.locator('[data-panel="computer"].active').waitFor();
  await normal.window
    .locator("#connection-readiness")
    .getByRole("button", { name: "Start fresh chat", exact: true })
    .click();
  await normal.window
    .locator("#computer-feedback")
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
legacyStartOrderSegment: try {
  if (!segmentSelected("legacy-start-order")) break legacyStartOrderSegment;
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
providerFailureSegment: try {
  if (!segmentSelected("provider-failure")) break providerFailureSegment;
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
streamFailureSegment: try {
  if (!segmentSelected("stream-failure")) break streamFailureSegment;
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
processDeathSegment: try {
  if (!segmentSelected("process-death")) break processDeathSegment;
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
    .getByText("failed", { exact: true })
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
          candidate.getTitle() === "Farol · Developer Preview" &&
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

if (segmentSelected("process-death")) {
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
}

// The "held:false desktop witness": at startup, `initializeCodexContextController`,
// `reconcileContextAfterRestart` (which recovers and records the summary
// execution fence) and `initializeRouteBRuntime` all run before `installIpc()`
// installs the `connector.start` handler, so no request can reach the
// connector before recovery has already settled. A recovery that could hold
// no record at all — reconciliation failed and the sentinel could not be
// raised either — must refuse the real connector start before any connector
// effect; a healthy recovery must not be refused for that same reason.
async function readSummaryFenceRecovery(userData) {
  return JSON.parse(
    await fs.readFile(
      path.join(userData, "farol-next-state", "summary-fence-recovery.json"),
      "utf8",
    ),
  );
}

function secureMcpLaunchRootEntries(userData) {
  return fs.readdir(
    path.join(
      userData,
      "farol-next-state",
      "secure-mcp-connector",
      "computer-authority",
    ),
  );
}

function ownedProcessFingerprint(application) {
  return application.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .map((metric) => `${metric.type}:${metric.name ?? ""}:${metric.pid}`)
      .sort(),
  );
}

const heldFalseFence = await launch([], "hidden", "ordinary", {
  seedUnheldExecutionFence: true,
});
fenceUnheldSegment: try {
  if (!segmentSelected("fence-unheld")) break fenceUnheldSegment;
  const recovery = await readSummaryFenceRecovery(heldFalseFence.userData);
  assert.equal(recovery.status, "kept");
  assert.equal(recovery.code, "EXECUTION_FENCE_UNRECONCILED");
  assert.equal(recovery.held, false);

  const processesBeforeStart = await ownedProcessFingerprint(
    heldFalseFence.application,
  );
  const refusal = await heldFalseFence.window.evaluate(() =>
    window.farolNext.configure({ kind: "connector.start" }),
  );
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error, "COMPUTER_FENCE_UNHELD");
  assert.equal(refusal.snapshot.status, "ready");
  assert.equal(
    refusal.snapshot.settings.connectors.secureMcp.runtime,
    null,
    "connector.start must never record a runtime when the fence refuses it",
  );
  assert.equal(
    refusal.snapshot.settings.connectors.secureMcp.credential,
    "missing",
    "connector.start must never touch the credential store when the fence refuses it",
  );

  const processesAfterStart = await ownedProcessFingerprint(
    heldFalseFence.application,
  );
  assert.deepEqual(
    processesAfterStart,
    processesBeforeStart,
    "a refused connector.start must not start or stop any owned process",
  );

  const launchRootEntries = await secureMcpLaunchRootEntries(
    heldFalseFence.userData,
  );
  assert.deepEqual(
    launchRootEntries.sort(),
    ["execution-fence"],
    "connector.start must not write a launch contract when the fence refuses it",
  );

  cases.push("connector-refuses-unheld-summary-fence");
} finally {
  await close(heldFalseFence);
}

const reconciledFence = await launch([], "hidden", "ordinary");
fenceReconciledSegment: try {
  if (!segmentSelected("fence-reconciled")) break fenceReconciledSegment;
  const recovery = await readSummaryFenceRecovery(reconciledFence.userData);
  assert.equal(recovery.status, "reconciled");

  const result = await reconciledFence.window.evaluate(() =>
    window.farolNext.configure({ kind: "connector.start" }),
  );
  // Nothing configures a tunnel client or credential in this fixture, so the
  // connector still fails to start; only the exact refusal code matters here.
  assert.equal(result.ok, false);
  assert.notEqual(result.error, "COMPUTER_FENCE_UNHELD");
  assert.equal(result.error, "CONNECTOR_CONFIGURE_FAILED");

  cases.push("connector-start-admitted-when-fence-reconciled");
} finally {
  await close(reconciledFence);
}

// UX34-05 / UX34-06 / UX34-08 / UX34-07 — native layout and sign-in surface
// checks added for the layout-and-sign-in packet. Each block owns its own
// launch()/close() cycle so a failure here cannot perturb the sequencing or
// shared instances the flows above depend on. These blocks run before the
// case aggregation, the report is written, and evidenceAttempt.finish() is
// called, so a thrown error or a missing case here reaches the terminal
// result instead of being silently dropped after it.
// ---------------------------------------------------------------------------

// UX34-05: Settings must stay readable — no intersecting interactive
// controls, no horizontal scroll, every action reachable — at the
// supported minimum width and across the ~980px auto-rail breakpoint.
ux34SettingsWidthsSegment: {
  if (!segmentSelected("ux34-settings-widths")) break ux34SettingsWidthsSegment;
  const settingsWidths = await launch([], "secondary-visible");
  try {
    await finishSetupByNext(settingsWidths);
    // The widths below are only as honest as the content behind them. Feed
    // Settings the worst values the contract actually admits — an 80-char
    // computer name and a 160-char tunnel id, both with no space or hyphen
    // to break at — so "no horizontal overflow" is a claim about the owner's
    // own data and not about a short fixture. Both maxima are the schema's:
    // product-settings/contract.ts name .max(80), tunnelId .max(160).
    const unbreakableName = "W".repeat(80);
    const unbreakableTunnel = `tunnel_${"0".repeat(153)}`;
    assert.equal(unbreakableName.length, 80);
    assert.equal(unbreakableTunnel.length, 160);
    let renamedComputer;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      renamedComputer = await settingsWidths.window.evaluate(
        (name) => window.farolNext.configure({ kind: "computer.rename", name }),
        unbreakableName,
      );
      if (
        renamedComputer.ok ||
        renamedComputer.error !== "AUTHORITY_CHANGE_IN_PROGRESS"
      )
        break;
      // The authority reservation refused before any mutation. Only this
      // known no-effect result may be retried, with the same exact name.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      renamedComputer?.ok,
      true,
      `the contract's longest computer name is accepted: ${renamedComputer?.ok ? "ok" : renamedComputer?.error}`,
    );
    await settingsWidths.window.locator('[data-section="settings"]').click();
    await settingsWidths.window.waitForFunction(
      () => document.documentElement.dataset.section === "settings",
    );
    await settingsWidths.window.waitForFunction(
      (name) => document.body.innerText.includes(name),
      unbreakableName,
    );
    const measureSettingsLayout = () => {
      const panel = document.querySelector(".panel.active");
      if (!panel) throw new Error("SETTINGS_PANEL_MISSING");
      const rectsIntersect = (a, b) =>
        a.left < b.right &&
        a.right > b.left &&
        a.top < b.bottom &&
        a.bottom > b.top;
      const controls = [
        ...panel.querySelectorAll("button, input, select, a[href]"),
      ].filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          element.offsetParent !== null && rect.width > 0 && rect.height > 0
        );
      });
      const rects = controls.map((element, index) => ({
        label:
          element.id ||
          `${element.tagName.toLowerCase()}:${(element.textContent ?? "").trim().slice(0, 24)}:${index}`,
        rect: element.getBoundingClientRect(),
      }));
      const overlaps = [];
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          if (rectsIntersect(rects[i].rect, rects[j].rect)) {
            overlaps.push([rects[i].label, rects[j].label]);
          }
        }
      }
      // The panel's own scroll overflow starts at its padding edge, not its
      // border edge: an element that ends inside the panel's right padding
      // already widens `scrollWidth` without ever crossing the border box,
      // so the offenders are measured against the padding edge and blocks
      // whose own text overflows them are named too. Otherwise a failure
      // reads "protruding: " with nobody to blame (sealed attempt
      // 20260920T103813165Z-df14c36d).
      const panelBox = panel.getBoundingClientRect();
      const panelRight = panelBox.left + panel.clientLeft + panel.clientWidth;
      const describe = (element) =>
        element.id ||
        (typeof element.className === "string" && element.className) ||
        element.tagName.toLowerCase();
      const protruding = [...panel.querySelectorAll("*")]
        .filter(
          (element) => element.getBoundingClientRect().right > panelRight + 1,
        )
        .slice(0, 6)
        .map(
          (element) =>
            `${describe(element)}:${Math.round(element.getBoundingClientRect().right - panelRight)}px`,
        );
      const textOverflow = [...panel.querySelectorAll("*")]
        .filter(
          (element) =>
            element.clientWidth > 0 &&
            element.scrollWidth > element.clientWidth + 1 &&
            getComputedStyle(element).overflowX === "visible",
        )
        .slice(0, 6)
        .map(
          (element) =>
            `${describe(element)}:+${element.scrollWidth - element.clientWidth}px`,
        );
      return {
        protruding,
        textOverflow,
        panelHorizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
        documentHorizontalOverflow:
          document.documentElement.scrollWidth > window.innerWidth + 1,
        overlaps,
        controlCount: rects.length,
      };
    };
    for (const width of [640, 800, 979, 980, 1_100, 1_280]) {
      await setWindowSize(settingsWidths.application, width, 700);
      await settingsWidths.window.waitForFunction(
        (expected) => window.innerWidth === expected,
        width,
      );
      const measured = await settingsWidths.window.evaluate(
        measureSettingsLayout,
      );
      assert.ok(
        measured.controlCount > 0,
        `Settings has reachable controls at ${width}px`,
      );
      assert.equal(
        measured.panelHorizontalOverflow,
        false,
        `Settings panel has no horizontal scroll at ${width}px (past the padding edge: ${measured.protruding.join(", ") || "none"}; text overflow: ${measured.textOverflow.join(", ") || "none"})`,
      );
      assert.equal(
        measured.documentHorizontalOverflow,
        false,
        `Farol window has no horizontal scroll at ${width}px`,
      );
      assert.deepEqual(
        measured.overlaps,
        [],
        `Settings has no intersecting interactive controls at ${width}px`,
      );
    }
    cases.push("ux34-settings-widths-readable");

    // Setup's detail list prints values the owner supplies and the product
    // cannot shorten — the workspace root most of all, which has no space to
    // break at. Give the step a real approved folder, reopen Setup on it,
    // and measure the list at the supported minimum width.
    const added = await settingsWidths.window.evaluate(() =>
      window.farolNext.configure({ kind: "computer.add-workspace" }),
    );
    assert.equal(added.ok, true, "the fixture workspace is approved");
    await settingsWidths.window.locator("#open-connections").click();
    await settingsWidths.window
      .locator('[data-panel="computer"].active')
      .waitFor();
    await settingsWidths.window.locator("#review-setup").click();
    const reviewed = settingsWidths.window.locator("#setup-dialog");
    await reviewed.waitFor({ state: "visible" });
    // Review opens on the last persisted step; walk back to the one that
    // prints the workspace root.
    while ((await reviewed.getAttribute("data-step-id")) !== "computer") {
      const before = await reviewed.getAttribute("data-step-id");
      assert.notEqual(before, "chatgpt", "walked past the computer step");
      await settingsWidths.window.locator("#setup-back").click();
      await settingsWidths.window.waitForFunction(
        (previous) =>
          document
            .querySelector("#setup-dialog")
            ?.getAttribute("data-step-id") !== previous,
        before,
      );
    }
    await setWindowSize(settingsWidths.application, 640, 700);
    await settingsWidths.window.waitForFunction(
      () => window.innerWidth === 640,
    );
    const setupDetails = await settingsWidths.window.evaluate((root) => {
      const list = document.querySelector("#setup-details");
      if (!list) throw new Error("SETUP_DETAILS_MISSING");
      const printed = list.innerText;
      const dialog = document.querySelector("#setup-dialog");
      const dialogBox = dialog.getBoundingClientRect();
      const overflowing = [...list.querySelectorAll("li")]
        .filter(
          (item) =>
            item.getBoundingClientRect().right > dialogBox.right + 1 ||
            item.scrollWidth > item.clientWidth + 1,
        )
        .map((item) => item.textContent?.slice(0, 40));
      return {
        printsRoot: printed.includes(root),
        overflowing,
        documentHorizontalOverflow:
          document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    }, settingsWidths.workspaceRoot);
    assert.equal(
      setupDetails.printsRoot,
      true,
      "the step prints the approved workspace root it was given",
    );
    assert.deepEqual(
      setupDetails.overflowing,
      [],
      "no Setup detail line escapes the dialog at 640px",
    );
    assert.equal(
      setupDetails.documentHorizontalOverflow,
      false,
      "the window has no horizontal scroll at 640px with a real workspace root",
    );
    await settingsWidths.window.locator("#setup-close").click();
    await reviewed.waitFor({ state: "hidden" });
    cases.push("ux34-settings-setup-details-bounded");
  } finally {
    await close(settingsWidths);
  }
}

// UX34-06: the sidebar toggle must never share screen space with the
// macOS traffic lights, at every width, and a real click on it must carry
// the sidebar through a full -> rail -> full roundtrip, including after a
// resize. Native fullscreen/focus geometry is the separate
// traffic-light-and-fullscreen-geometry proof above and is repeated here
// only when that proof is authorized.
ux34SidebarToggleSegment: {
  if (!segmentSelected("ux34-sidebar-toggle")) break ux34SidebarToggleSegment;
  const sidebarRoundtrip = await launch([], "secondary-visible");
  try {
    // First run is also where a novice meets the only repeated-click hazard
    // on this path. One double click per step, five steps, and the dialog
    // must move through them one at a time and then close.
    const doubleClicked = await finishSetupByDoubleClick(sidebarRoundtrip);
    assert.deepEqual(
      doubleClicked,
      setupScreens.map(([stepId]) => stepId),
      "a double click advances exactly one step, never skipping one",
    );
    assert.equal(
      await sidebarRoundtrip.window.locator("#setup-dialog").isVisible(),
      false,
      "the last double click closes Setup rather than wedging it",
    );
    cases.push("ux34-sidebar-setup-continue-double-click");
    // Mirrors window-chrome-geometry.ts's trafficLightCluster (52x16) at
    // the app's configured trafficLightPosition {x: 14, y: 18} — Electron
    // exposes only the configured origin (getWindowButtonPosition), never
    // the rendered cluster size, so both sides of this check share the
    // same constant rather than each guessing independently.
    const TRAFFIC_LIGHT_CLUSTER = { width: 52, height: 16 };
    const measureChrome = (cluster) => {
      const toggle = document.querySelector("#sidebar-toggle");
      if (!toggle) throw new Error("SIDEBAR_TOGGLE_MISSING");
      const toggleRect = toggle.getBoundingClientRect();
      return {
        sidebar: document.documentElement.dataset.sidebar ?? null,
        toggle: {
          x: toggleRect.x,
          y: toggleRect.y,
          width: toggleRect.width,
          height: toggleRect.height,
        },
        // Hit-test the centre: the toggle is position: fixed, for which
        // offsetParent is always null, so only elementFromPoint tells
        // whether a click there reaches it rather than something on top.
        toggleReachable:
          (() => {
            const hit = document.elementFromPoint(
              toggleRect.x + toggleRect.width / 2,
              toggleRect.y + toggleRect.height / 2,
            );
            return hit === toggle || toggle.contains(hit);
          })() &&
          toggleRect.width >= 28 &&
          toggleRect.height >= 28,
      };
    };
    const trafficLightPosition = async () =>
      sidebarRoundtrip.application.evaluate(({ BrowserWindow }) => {
        const shell = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol · Developer Preview" &&
            url.startsWith("file:") &&
            url.endsWith("/shell.html")
          );
        });
        return shell?.getWindowButtonPosition() ?? null;
      });
    const assertToggleClearOfTrafficLights = async () => {
      const position = await trafficLightPosition();
      const measured = await sidebarRoundtrip.window.evaluate(measureChrome);
      if (position) {
        const lightsRect = {
          x: position.x,
          y: Math.max(0, position.y - TRAFFIC_LIGHT_CLUSTER.height / 2),
          width: TRAFFIC_LIGHT_CLUSTER.width,
          height: TRAFFIC_LIGHT_CLUSTER.height,
        };
        const intersects =
          measured.toggle.x < lightsRect.x + lightsRect.width &&
          measured.toggle.x + measured.toggle.width > lightsRect.x &&
          measured.toggle.y < lightsRect.y + lightsRect.height &&
          measured.toggle.y + measured.toggle.height > lightsRect.y;
        assert.equal(
          intersects,
          false,
          `sidebar toggle intersects traffic lights: toggle=${JSON.stringify(measured.toggle)} lights=${JSON.stringify(lightsRect)}`,
        );
      }
      assert.equal(measured.toggleReachable, true, "toggle is reachable");
      return measured;
    };
    await setWindowSize(sidebarRoundtrip.application, 1_180, 760);
    await sidebarRoundtrip.window.waitForFunction(
      (expected) => window.innerWidth === expected,
      1_180,
    );
    let state = await assertToggleClearOfTrafficLights();
    assert.equal(state.sidebar, "full", "starts full at wide width");
    // A real click at the toggle's center, dispatched by Playwright through
    // the same CDP Input.dispatchMouseEvent channel a real pointer uses.
    await sidebarRoundtrip.window.locator("#sidebar-toggle").click();
    await sidebarRoundtrip.window.waitForFunction(
      () => document.documentElement.dataset.sidebar === "rail",
    );
    state = await assertToggleClearOfTrafficLights();
    assert.equal(state.sidebar, "rail", "collapses to rail");
    await sidebarRoundtrip.window.locator("#sidebar-toggle").click();
    await sidebarRoundtrip.window.waitForFunction(
      () => document.documentElement.dataset.sidebar === "full",
    );
    state = await assertToggleClearOfTrafficLights();
    assert.equal(state.sidebar, "full", "expands back to full");
    // Collapse again, then resize, then confirm the toggle still works and
    // stays clear of the traffic lights after the resize.
    await sidebarRoundtrip.window.locator("#sidebar-toggle").click();
    await sidebarRoundtrip.window.waitForFunction(
      () => document.documentElement.dataset.sidebar === "rail",
    );
    await setWindowSize(sidebarRoundtrip.application, 1_280, 800);
    await sidebarRoundtrip.window.waitForFunction(
      (expected) => window.innerWidth === expected,
      1_280,
    );
    await assertToggleClearOfTrafficLights();
    await sidebarRoundtrip.window.locator("#sidebar-toggle").click();
    await sidebarRoundtrip.window.waitForFunction(
      () => document.documentElement.dataset.sidebar === "full",
    );
    state = await assertToggleClearOfTrafficLights();
    assert.equal(state.sidebar, "full", "roundtrip survives a resize");
    if (nativeWindowProofAvailable) {
      // Fullscreen enter/exit: the traffic lights move out of the way
      // entirely, and the toggle must still be present and reachable both
      // during and after.
      await sidebarRoundtrip.application.evaluate(({ BrowserWindow }) => {
        const shell = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol · Developer Preview" &&
            url.startsWith("file:") &&
            url.endsWith("/shell.html")
          );
        });
        shell?.setFullScreen(true);
      });
      await sidebarRoundtrip.window.waitForFunction(
        () => document.documentElement.dataset.fullScreen === "true",
      );
      state = await sidebarRoundtrip.window.evaluate(measureChrome);
      assert.equal(state.toggleReachable, true, "toggle usable in fullscreen");
      await sidebarRoundtrip.application.evaluate(({ BrowserWindow }) => {
        const shell = BrowserWindow.getAllWindows().find((candidate) => {
          const url = candidate.webContents.getURL();
          return (
            candidate.getTitle() === "Farol · Developer Preview" &&
            url.startsWith("file:") &&
            url.endsWith("/shell.html")
          );
        });
        shell?.setFullScreen(false);
      });
      await sidebarRoundtrip.window.waitForFunction(
        () => document.documentElement.dataset.fullScreen === "false",
      );
      await assertToggleClearOfTrafficLights();
    }
    cases.push("ux34-sidebar-toggle-roundtrip");
  } finally {
    await close(sidebarRoundtrip);
  }
}

// UX34-08 / UX34-07: the sign-in surface is a clearly Farol-owned window
// (its own title, a "Return to Farol" control), a same-origin/allowed
// "Next"-style navigation proceeds, a blocked navigation is reported (not
// silent), and closing the window returns cleanly with a truthful status.
// The Return control is proved twice: once as a DOM-handler check (a
// programmatic click, only ever a proof that the click listener itself is
// wired), and once as a real human-input proof (pointer and keyboard,
// dispatched the same way Playwright drives any other real interaction,
// with a self-deception guard showing the input proof can actually fail).

// Reopening a second, third, … sign-in window from the same launched
// instance goes through #setup-live-primary exactly as the first one did.
// After a return, the renderer's local "already opened" flag leaves that
// control showing "Check connection" rather than "Open sign-in…" until it
// is clicked once (that click resolves to chatgpt.verify, not a new
// window); only the control's own next label says whether a click will
// open a window, so this waits on that label instead of assuming a fixed
// number of clicks.
async function reopenSignInFixtureWindow(instance) {
  const primary = instance.window.locator("#setup-live-primary");
  const label = (await primary.innerText()).trim();
  if (label !== "Open sign-in…") {
    await primary.click();
    await instance.window.waitForFunction(
      () =>
        document.querySelector("#setup-live-primary")?.textContent ===
        "Open sign-in…",
    );
  }
  const chatGptWindow = instance.application.waitForEvent("window", {
    timeout: 15_000,
  });
  await primary.click();
  const chatGptPage = await chatGptWindow;
  await chatGptPage.waitForURL(instance.chatGptFixture.url);
  await waitForWindowCount(instance.application, 2);
  // A window event and a loaded URL precede the main process's route gate
  // and the renderer's open-sign-in acknowledgement. The covered-page test
  // navigates immediately after this helper; doing so before that gate
  // settles can make the opening attempt report no-window while a page is
  // visibly present. Wait for the actual command acknowledgement first.
  await instance.window.waitForFunction(
    () =>
      document.querySelector("#setup-live-primary")?.textContent?.trim() ===
      "Check connection",
  );
  const admitted = await instance.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(
    admitted.chatgptSignInOutcome,
    null,
    "the new sign-in route was admitted before fixture navigation",
  );
  return chatGptPage;
}

// Diagnostics for the sign-in window's own webContents (loading state, main
// frame URL) — content-free, used only to explain a stalled proof after a
// cancelled navigation, never to assert on directly.
async function signInWindowDiagnostics(application, url) {
  return application.evaluate(({ BrowserWindow }, pageUrl) => {
    const candidate = BrowserWindow.getAllWindows().find((entry) =>
      entry.webContents.getURL().startsWith(pageUrl),
    );
    if (!candidate) return null;
    return {
      isLoading: candidate.webContents.isLoading(),
      mainFrameUrl: candidate.webContents.mainFrame.url,
    };
  }, url);
}

// Whether a real pointer event at the Return control's own centre would
// reach it at all: visible, enabled, and not covered by anything else at
// that point. document.elementFromPoint is the same hit-test a real click
// resolves against, so this is the browser's own answer, not a guess from
// the element's presence in the DOM.
async function signInReturnHitTest(chatGptPage) {
  return chatGptPage.evaluate(() => {
    const button = document.querySelector("#farol-sign-in-banner button");
    if (!button) throw new Error("SIGN_IN_RETURN_BUTTON_MISSING");
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const style = getComputedStyle(button);
    return {
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden",
      enabled: !button.disabled,
      x,
      y,
      reachable: hit === button || button.contains(hit),
    };
  });
}

// The explicit, truthful outcome a Return must produce: the sign-in window
// is gone and bootstrap reports a ready configuration with chatgpt still
// unverified (the fixture's login button was never clicked) — never a
// silent close and never "any navigation happened".
// After Return the sign-in window is gone and Setup is not stale: its next
// action follows the outcome recorded at close. On a page that was read
// normally that outcome is "signed out" (the fixture never signs in), so the
// step offers "Open sign-in…" at once — also after a blocked navigation,
// which must not leave the route believing the still-visible page failed.
// A caller may pass readOnClose: false only where an unknown outcome is
// the honest expectation; the step must then match what was recorded.
async function waitForSignInReturnOutcome(
  instance,
  { readOnClose = true } = {},
) {
  await waitForWindowCount(instance.application, 1);
  const observed = await waitForPageState(instance.window, async () => {
    const value = await window.farolNext.bootstrap();
    return value.configuration.status === "ready";
  }).then(() =>
    instance.window.evaluate(async () => {
      const value = await window.farolNext.bootstrap();
      return {
        recorded: value.configuration.settings.setup.chatgpt,
        outcome: value.chatgptSignInOutcome ?? null,
      };
    }),
  );
  const recorded = observed.recorded;
  // S35-R7: an outcome recorded as "unknown" writes nothing, so the record
  // alone cannot say whether the page read answered, timed out under load,
  // or never had a window. The content-free diagnostic and this machine's
  // load average travel with the receipt so a FAIL explains itself.
  const outcome = observed.outcome;
  const loadAverage = os.loadavg();
  process.stdout.write(
    `UX34_RETURN_RECORDED:${JSON.stringify({
      readOnClose,
      recorded,
      outcome,
      loadAverage,
    })}\n`,
  );
  if (readOnClose) {
    assert.equal(
      recorded.reachable,
      "reachable",
      `Return read the page (outcome=${JSON.stringify(outcome)} loadavg=${JSON.stringify(loadAverage)})`,
    );
    assert.equal(recorded.configured, false);
    assert.notEqual(recorded.needsAction, null);
  }
  if (await instance.window.locator("#setup-dialog").isVisible()) {
    const expected = (() => {
      if (
        !recorded.visited ||
        recorded.reachable === "unreachable" ||
        (recorded.reachable === "reachable" &&
          !recorded.configured &&
          recorded.needsAction !== null)
      ) {
        return "Open sign-in…";
      }
      return recorded.verified ? "Recheck connection" : "Check connection";
    })();
    if (readOnClose) assert.equal(expected, "Open sign-in…");
    try {
      await instance.window.waitForFunction(
        (label) =>
          document.querySelector("#setup-live-primary")?.textContent === label,
        expected,
      );
    } catch (error) {
      const shown = await instance.window.evaluate(() => ({
        primary: document.querySelector("#setup-live-primary")?.textContent,
        step: document.querySelector("#setup-dialog")?.dataset.stepId,
        shellActions: window.__farolShellActions ?? null,
      }));
      throw new Error(
        `${error.message} · expected ${expected} after Return; Setup showed ${JSON.stringify(shown)}`,
        { cause: error },
      );
    }
  }
  const afterReturn = await instance.window.evaluate(() =>
    window.farolNext.bootstrap(),
  );
  assert.equal(afterReturn.configuration.status, "ready");
  if (afterReturn.configuration.status === "ready") {
    assert.equal(
      afterReturn.configuration.settings.setup.chatgpt.verified,
      null,
      "closing without signing in reports not-signed-in, not silence",
    );
  }
  return afterReturn;
}

// A real Return click/press closes the sign-in window as a synchronous
// consequence of the input event's own handler (click -> console.log ->
// main-process console-message listener -> BrowserWindow.close()), which
// can race Playwright's own CDP round-trip for "the input was dispatched"
// and surface as "Target page, context or browser has been closed" even
// though the input reached the control and did its job. The window closing
// is the real, separately verified outcome (waitForSignInReturnOutcome
// asserts window count and the truthful not-signed-in bootstrap state), so
// this narrowly tolerates only that exact race rather than papering over an
// unrelated failure.
async function dispatchTolerantOfWindowClose(action) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/has been closed/u.test(message)) throw error;
  }
}

// Real dispatched pointer input at the Return control's centre — the CDP
// Input.dispatchMouseEvent channel a real pointer uses, not a synthetic DOM
// method call.
async function assertSignInReturnByPointer(
  instance,
  chatGptPage,
  outcome = {},
) {
  // A locator-based wait (banner.waitFor) is a Playwright action, and after
  // a blocked navigation on this page Playwright's own action machinery
  // waits "for navigation to finish…" on the cancelled navigation forever
  // (see the blocked-navigation proof above). page.evaluate has no such
  // wait, so readiness is polled through it instead — this proof is reused
  // both on a fresh window and right after a blocked navigation.
  await waitForPageState(
    chatGptPage,
    () => document.querySelector("#farol-sign-in-banner button") !== null,
  );
  const hit = await signInReturnHitTest(chatGptPage);
  assert.equal(hit.visible, true, "the Return control is visible");
  assert.equal(hit.enabled, true, "the Return control is enabled");
  assert.equal(
    hit.reachable,
    true,
    "a hit-test at the Return control's centre reaches the control",
  );
  await dispatchTolerantOfWindowClose(() =>
    chatGptPage.mouse.click(hit.x, hit.y),
  );
  await waitForSignInReturnOutcome(instance, outcome);
}

// Real dispatched keyboard input: Tab to the Return control (bounded, so a
// broken tab order fails loudly instead of hanging), then Enter.
async function assertSignInReturnByKeyboard(instance, chatGptPage) {
  const banner = chatGptPage.locator("#farol-sign-in-banner");
  await banner.waitFor({ state: "visible" });
  await chatGptPage.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  const maxTabs = 25;
  let reachedByTab = false;
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    await chatGptPage.keyboard.press("Tab");
    reachedByTab = await chatGptPage.evaluate(
      () =>
        document.activeElement ===
        document.querySelector("#farol-sign-in-banner button"),
    );
    if (reachedByTab) break;
  }
  assert.equal(
    reachedByTab,
    true,
    `Tab reaches the Return control within ${maxTabs} presses`,
  );
  await dispatchTolerantOfWindowClose(() =>
    chatGptPage.keyboard.press("Enter"),
  );
  await waitForSignInReturnOutcome(instance);
}

ux34SignInReturnSegment: {
  if (!segmentSelected("ux34-sign-in-return")) break ux34SignInReturnSegment;
  const signIn = await launch([], "secondary-visible");
  try {
    // Instrument: record every shell action the main process sends, so a
    // missing Return notification is told apart from an ignored one.
    await signIn.window.evaluate(() => {
      window.__farolShellActions = [];
      window.farolNext.onShellAction((value) =>
        window.__farolShellActions.push(value),
      );
    });
    const dialog = signIn.window.locator("#setup-dialog");
    await dialog.waitFor({ state: "visible" });
    assert.equal(await dialog.getAttribute("data-step-id"), "chatgpt");
    assert.equal(
      await signIn.window.locator("#setup-live-primary").innerText(),
      "Open sign-in…",
    );
    let chatGptPage = await reopenSignInFixtureWindow(signIn);
    assert.equal(
      await nativeWindowTitle(signIn.application, signIn.chatGptFixture.url),
      "Sign in to ChatGPT — Farol",
    );
    const banner = chatGptPage.locator("#farol-sign-in-banner");
    await banner.waitFor({ state: "visible" });
    assert.match(await banner.innerText(), /Return to Farol/u);
    cases.push("ux34-sign-in-window-owned");

    // The fixture's own "Next" step: same origin (e2e-allowed), so the
    // sign-in surface's policy must let it proceed rather than doing
    // nothing.
    await chatGptPage.locator('[data-testid="next-page-button"]').click();
    await chatGptPage
      .locator('[data-testid="next-page-ready"]')
      .waitFor({ state: "visible" });

    // A navigation the policy does not allow: reported through
    // bootstrap().chatgptSignInBlocked (content-free: host only), not
    // silently swallowed.
    // The Next step left the page that carries the off-policy button.
    await chatGptPage.goto(signIn.chatGptFixture.url);
    // Clicked in the page: Playwright's click would wait for the navigation
    // it scheduled, which the sign-in policy blocks and so never finishes.
    await chatGptPage
      .locator('[data-testid="blocked-nav-button"]')
      .waitFor({ state: "visible" });
    await chatGptPage.evaluate(() =>
      document.querySelector('[data-testid="blocked-nav-button"]').click(),
    );
    await waitForPageState(
      signIn.window,
      async () =>
        (await window.farolNext.bootstrap())?.chatgptSignInBlocked?.kind !==
        undefined,
    );
    const blockedBootstrap = await signIn.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.deepEqual(blockedBootstrap.chatgptSignInBlocked, {
      kind: "navigation-blocked",
      host: "example.invalid",
    });
    assert.equal(
      await nativeWindowTitle(signIn.application, signIn.chatGptFixture.url),
      "Sign in to ChatGPT — Farol",
      "the blocked navigation never left the sign-in page",
    );
    cases.push("ux34-sign-in-blocked-navigation-reported");

    // "Return to Farol" — handler proof: a programmatic DOM click in the
    // page, which is only ever a proof the click listener itself is wired.
    // Playwright still counts the cancelled navigation above as pending and
    // would wait for it before a locator click, so the control is clicked
    // via evaluate here; its handler and the main-frame check are the same
    // one the real-input proofs below exercise.
    await chatGptPage.evaluate(() =>
      document.querySelector("#farol-sign-in-banner button").click(),
    );
    await waitForSignInReturnOutcome(signIn);
    cases.push("ux34-sign-in-return-handler");

    // Pointer proof: a fresh sign-in window, real dispatched mouse input.
    chatGptPage = await reopenSignInFixtureWindow(signIn);
    await assertSignInReturnByPointer(signIn, chatGptPage);
    cases.push("ux34-sign-in-return-pointer");

    // Keyboard proof: a fresh sign-in window, Tab then Enter.
    chatGptPage = await reopenSignInFixtureWindow(signIn);
    await assertSignInReturnByKeyboard(signIn, chatGptPage);
    cases.push("ux34-sign-in-return-keyboard");

    // Pointer proof after a blocked navigation: the exact path the base
    // harness could only close through evaluate() because Playwright's own
    // locator click waits on the cancelled navigation. Diagnostics are
    // captured first and written to the log so a stall here explains
    // itself instead of just timing out.
    chatGptPage = await reopenSignInFixtureWindow(signIn);
    await chatGptPage
      .locator('[data-testid="blocked-nav-button"]')
      .waitFor({ state: "visible" });
    await chatGptPage.evaluate(() =>
      document.querySelector('[data-testid="blocked-nav-button"]').click(),
    );
    await waitForPageState(
      signIn.window,
      async () =>
        (await window.farolNext.bootstrap())?.chatgptSignInBlocked?.kind !==
        undefined,
    );
    const postBlockedNavDiagnostics = {
      pageUrl: chatGptPage.url(),
      window: await signInWindowDiagnostics(
        signIn.application,
        signIn.chatGptFixture.url,
      ),
    };
    process.stdout.write(
      `UX34_POST_BLOCKED_NAV_DIAGNOSTICS:${JSON.stringify(postBlockedNavDiagnostics)}\n`,
    );
    await assertSignInReturnByPointer(signIn, chatGptPage);
    cases.push("ux34-sign-in-return-pointer-after-blocked-navigation");

    // Self-deception guard: a fixture variant adds a full-viewport overlay
    // above everything, at the same maximal z-index the banner itself uses,
    // that counts its own clicks. This proves the pointer proof above is
    // not secretly a no-op — a real click that cannot reach the Return
    // control must be reported as such, while a programmatic DOM click
    // (which never hit-tests) still closes the window.
    chatGptPage = await reopenSignInFixtureWindow(signIn);
    await chatGptPage.goto(`${signIn.chatGptFixture.url}?cover=1`);
    const coveredBanner = chatGptPage.locator("#farol-sign-in-banner");
    await coveredBanner.waitFor({ state: "visible" });
    await chatGptPage
      .locator('[data-testid="cover-overlay"]')
      .waitFor({ state: "visible" });
    // The overlay re-asserts itself as the topmost element whenever the
    // banner script (re-)injects the banner, since both sit at the same
    // z-index and equal z-index falls back to DOM order.
    await waitForPageState(
      chatGptPage,
      () =>
        document.querySelector('[data-testid="cover-overlay"]') ===
        document.documentElement.lastElementChild,
    );
    const coveredHit = await signInReturnHitTest(chatGptPage);
    assert.equal(
      coveredHit.reachable,
      false,
      "the covering overlay defeats the hit-test at the Return control",
    );
    await chatGptPage.mouse.click(coveredHit.x, coveredHit.y);
    await waitForPageState(chatGptPage, () => window.__farolCoverClicks > 0);
    await waitForWindowCount(signIn.application, 2);
    assert.equal(
      await nativeWindowTitle(signIn.application, signIn.chatGptFixture.url),
      "Sign in to ChatGPT — Farol",
      "the covered pointer click never reached the Return control",
    );
    await chatGptPage.evaluate(() =>
      document.querySelector("#farol-sign-in-banner button").click(),
    );
    await waitForSignInReturnOutcome(signIn);
    cases.push("ux34-covered-return-fails-input-proof");
  } finally {
    await close(signIn);
  }
}

// N04b — unqualified model and Farol-backed Product Agent routes stay off
// at normal startup and after a restart with an existing Farol config. The
// public IPC is tested directly; the app window remains hidden. Rollback is
// still admitted and must remove only Farol's managed config regions.
n04bModelSegment: {
  if (!segmentSelected("n04b-model")) break n04bModelSegment;
  const instance = await launch([], "hidden", "normal", {
    environment: { FAROL_MODEL_E2E_SYNTHETIC_REPLY: "must not be served" },
  });
  try {
    const modelEndpointState = path.join(
      instance.userData,
      "farol-next-private",
      "model-endpoint",
    );
    const configPath = path.join(
      instance.isolatedHome,
      ".codex",
      "config.toml",
    );
    const assertEndpointOff = async () => {
      for (const name of ["model-endpoint-token", "model-endpoint-port"]) {
        assert.equal(
          await fs.stat(path.join(modelEndpointState, name)).then(
            () => true,
            () => false,
          ),
          false,
          `disabled startup does not create ${name}`,
        );
      }
    };
    const assertAdmissionClosed = async () => {
      const modelActions = [
        { kind: "model.status" },
        { kind: "model.preview", selectAsDefault: false },
        { kind: "model.apply", selectAsDefault: false },
        { kind: "model.rotate-token" },
      ];
      for (const command of modelActions) {
        const result = await instance.window.evaluate(
          (value) => window.farolNext.configure(value),
          command,
        );
        assert.equal(result.ok, false, `${command.kind} is closed over IPC`);
        assert.equal(result.error, "MODEL_ENDPOINT_UNAVAILABLE");
      }
      const start = await instance.window.evaluate(() =>
        window.farolNext.task({
          kind: "task.start-agent",
          taskId: "unqualified-agent-task",
          workspaceId: "unqualified-agent-workspace",
          objective: "This command must be refused before any host launches.",
          scope: { mode: "workspace", excludedPaths: [] },
        }),
      );
      assert.equal(start.ok, false);
      assert.equal(start.error, "AGENT_NOT_READY");
      const rejoin = await instance.window.evaluate(() =>
        window.farolNext.task({
          kind: "task.rejoin-agent",
          taskId: "unqualified-agent-task",
        }),
      );
      assert.equal(rejoin.ok, false);
      assert.equal(rejoin.error, "AGENT_NOT_READY");
    };

    await assertEndpointOff();
    await assertAdmissionClosed();
    assert.equal(
      await fs.stat(configPath).then(
        () => true,
        () => false,
      ),
      false,
      "the first normal launch does not create a provider config",
    );
    cases.push("n04b-model-agent-default-off-at-normal-startup");

    const ownerConfig = [
      "# Owner-written settings stay byte-identical.",
      'model = "gpt-6-astra"',
      "",
      "[model_providers.owner_written]",
      'name = "Owner written"',
      'base_url = "http://127.0.0.1:1/v1"',
      'wire_api = "responses"',
    ].join("\n");
    const savedSelection = [
      "# BEGIN FAROL MANAGED MODEL_PROVIDER SELECTION — do not edit by hand",
      'model_provider = "farol"',
      'model = "chatgpt"',
      "# END FAROL MANAGED MODEL_PROVIDER SELECTION",
    ].join("\n");
    const savedProvider = [
      "# BEGIN FAROL MANAGED BLOCK — do not edit by hand",
      "[model_providers.farol]",
      'name = "Farol"',
      'base_url = "http://127.0.0.1:17999"',
      'experimental_bearer_token = "synthetic-disabled-state"',
      'wire_api = "responses"',
      "# END FAROL MANAGED BLOCK",
    ].join("\n");
    const savedConfig = `${savedSelection}\n${ownerConfig}\n${savedProvider}\n`;
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(configPath), 0o700);
    await fs.writeFile(configPath, savedConfig, { mode: 0o600 });

    await restart(instance);
    await assertEndpointOff();
    await assertAdmissionClosed();
    assert.equal(await fs.readFile(configPath, "utf8"), savedConfig);
    cases.push("n04b-model-agent-stays-off-after-restart-with-saved-provider");

    const rollback = await instance.window.evaluate(() =>
      window.farolNext.configure({ kind: "model.rollback" }),
    );
    assert.equal(rollback.ok, true);
    assert.equal(rollback.evidence?.kind, "model.config-rollback");
    assert.equal(rollback.evidence?.providerBlockRestored, true);
    assert.equal(rollback.evidence?.providerSelectionRestored, true);
    assert.equal(await fs.readFile(configPath, "utf8"), ownerConfig);
    cases.push("n04b-model-default-off-preserves-explicit-managed-rollback");
  } finally {
    await close(instance);
  }
}

// Materialises the synthetic tunnel client as an executable outside the
// repository, so Farol probes, runs and supervises a real file exactly as it
// would the owner's own `tunnel-client`. The fixture speaks only loopback;
// what it stands in for, and what it therefore cannot prove, is stated at the
// top of `tunnel-client.fixture.cjs`.
async function startTunnelClientFixture() {
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-e2e-tunnel-"),
  );
  const source = await fs.readFile(
    path.join(root, "tests/e2e/tunnel-client.fixture.cjs"),
    "utf8",
  );
  // The mandated writer-local TMPDIR is inside this package's `type: module`
  // scope. Keep the reviewed CommonJS fixture explicit: an extensionless
  // Node script would be reinterpreted as ESM there and fail before the real
  // production probe reaches `--version`.
  const executable = path.join(fixtureRoot, "tunnel-client.cjs");
  // The probe refuses a group- or world-writable executable, so 0700 is not
  // tidiness: a looser mode is a refusal, not a warning.
  await fs.writeFile(executable, `#!${process.execPath}\n${source}`, {
    mode: 0o700,
  });
  return { root: fixtureRoot, executable };
}

// Where the fixture leaves its record of the `init` Farol ran. The runtime
// hands every tunnel-client invocation a fixed environment, so a harness
// variable cannot reach the child; `TUNNEL_CLIENT_STATE_DIR` can, and it
// points here.
function tunnelInitRecordPath(userData) {
  return path.join(
    userData,
    "farol-next-state",
    "secure-mcp-connector",
    "state",
    "farol-e2e-tunnel-init.json",
  );
}

// N09 — the Connection row in Connections, end to end through its own controls.
// Until now the suite reached `connector.start` only by calling the IPC
// bridge directly, with nothing configured, so the refusal codes were all it
// could see. This drives the row the way the owner does: detect a client,
// save a route, meet each unmet prerequisite by name, start a real supervised
// child, then stop it.
//
// What is proven here is the local half and only the local half. Farol
// decides readiness by polling a loopback health URL the tunnel client
// writes, and this fixture is a synthetic tunnel client that answers on
// 127.0.0.1 and reaches nothing else. A real tunnel registered with the
// provider, and the route from a real ChatGPT session through it, are
// outside every code path this test touches and are not claimed by it.
n09ConnectorSegment: {
  if (!segmentSelected("n09-connector")) break n09ConnectorSegment;
  const tunnelFixture = await startTunnelClientFixture();
  const connector = await launch([], "hidden", "demo", {
    environment: { FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelFixture.executable },
  });
  try {
    // Setup is finished WITHOUT approving a folder, because the prerequisite
    // this journey exists for is the one an owner cannot see from here: the
    // connector serves an approved workspace, and until wave 3 the primary
    // action was dead while every requirement it named was satisfied.
    await finishSetupByNext(connector);
    await connector.window.locator('[data-section="computer"]').click();
    await connector.window.waitForFunction(
      () => document.documentElement.dataset.section === "computer",
    );
    const connectionRow = connector.window
      .locator("#connection-readiness .connection-row.connector-row")
      .first();
    // One evaluated read of the whole row, rather than a locator per
    // assertion. Locators in this harness carry no action timeout, so a
    // control that never appears hangs the run instead of naming itself.
    // This read cannot hang, and every assertion below prints what the row
    // actually showed.
    const connectionState = () =>
      connector.window.evaluate(() => {
        const row = document.querySelector(
          "#connection-readiness .connection-row.connector-row",
        );
        if (!row) {
          return {
            present: false,
            rows: [
              ...document.querySelectorAll(
                "#connection-readiness .connection-row",
              ),
            ].map((candidate) => candidate.textContent?.slice(0, 80) ?? ""),
          };
        }
        return {
          present: true,
          title: row.querySelector("strong")?.textContent ?? null,
          detail: row.querySelector("small")?.textContent ?? null,
          challenge: row.querySelector(".connector-challenge") !== null,
          buttons: [...row.querySelectorAll("button")].map((button) => ({
            label: button.textContent,
            disabled: button.disabled,
            title: button.getAttribute("title"),
          })),
        };
      });
    const clickRowButton = async (label) => {
      const before = await connectionState();
      assert.ok(
        before.present && before.buttons.some((b) => b.label === label),
        `the Connection row must offer ${label} · ${JSON.stringify(before)}`,
      );
      await connectionRow
        .getByRole("button", { name: label, exact: true })
        .click({ timeout: 20_000 });
    };
    const startState = async () => {
      const state = await connectionState();
      const start = state.buttons?.find((button) =>
        [
          "Start & check",
          "Check attachment",
          "Running",
          "Repair explicitly",
        ].includes(button.label),
      );
      assert.ok(
        start,
        `the Connection row must offer a primary action · ${JSON.stringify(state)}`,
      );
      return { start, state };
    };
    // Connector commands rewrite the shared panel feedback from their own
    // evidence, so matching the sentence is also an assertion about which
    // evidence came back.
    const connectorFeedback = async (pattern) => {
      try {
        await connector.window.waitForFunction(
          (source) =>
            new RegExp(source, "u").test(
              document.querySelector("#computer-feedback")?.textContent ?? "",
            ),
          pattern.source,
        );
      } catch (error) {
        const actual = await connector.window
          .locator("#computer-feedback")
          .textContent();
        assert.match(
          actual ?? "",
          pattern,
          `unexpected connector feedback after UI action: ${error}`,
        );
      }
    };

    // Each prerequisite in turn, named by the control that is refusing.
    const noClient = await startState();
    assert.equal(noClient.start.disabled, true, JSON.stringify(noClient.state));
    assert.equal(
      noClient.start.title,
      "Choose the tunnel client first.",
      JSON.stringify(noClient.state),
    );
    assert.equal(
      noClient.state.buttons.some(
        (button) => button.label === "Choose client…",
      ),
      false,
      JSON.stringify(noClient.state),
    );
    await clickRowButton("Detect client");
    await connectorFeedback(
      /^tunnel-client \S+ verified · \S+ · executable [0-9a-f]{12}\.$/u,
    );
    const noTunnel = await startState();
    assert.equal(noTunnel.start.disabled, true, JSON.stringify(noTunnel.state));
    assert.equal(
      noTunnel.start.title,
      "Enter the tunnel ID and save the route first.",
      JSON.stringify(noTunnel.state),
    );

    await connector.window
      .locator("#settings-connector-tunnel")
      .fill("tunnel_farol_next_e2e");
    await connector.window
      .locator("#settings-connector-key")
      .fill("farol-next-e2e-runtime-key-0001");
    await clickRowButton("Save route");
    await connectorFeedback(/^Connector route saved\.$/u);
    // The one an owner could not discover from this surface.
    const noWorkspace = await startState();
    assert.equal(
      noWorkspace.start.disabled,
      true,
      JSON.stringify(noWorkspace.state),
    );
    assert.equal(
      noWorkspace.start.title,
      "Approve at least one workspace in Computer first. The connector serves that workspace, so it cannot start without one.",
      JSON.stringify(noWorkspace.state),
    );
    cases.push("n09-connector-start-names-earliest-unmet-prerequisite");

    // Satisfy it where the sentence says to, then come back.
    await connector.window.locator('[data-section="settings"]').click();
    await connector.window.locator('[data-panel="settings"].active').waitFor();
    await connector.window.locator("#add-workspace").click();
    await connector.window
      .locator("#settings-feedback")
      .getByText("Read-only workspace saved and read back.", { exact: true })
      .waitFor();
    await connector.window.locator('[data-section="computer"]').click();
    await connector.window.waitForFunction(
      () => document.documentElement.dataset.section === "computer",
    );
    await connector.window.waitForFunction(() => {
      const button = [
        ...document.querySelectorAll("#connection-readiness button"),
      ].find((candidate) => candidate.textContent === "Start & check");
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    const readyToStart = await startState();
    assert.equal(
      readyToStart.start.title,
      null,
      JSON.stringify(readyToStart.state),
    );

    await clickRowButton("Start & check");
    await connectorFeedback(
      /^Connector ready · runtime [0-9a-z-]{12} · Computer generation \d+\.$/u,
    );
    // Farol ran the client's own `init` before starting it, and the record
    // the fixture kept is what proves the product asked for the profile and
    // tunnel it says it did — not a Farol-authored binary, and not a route
    // this test invented.
    const initArgv = JSON.parse(
      await fs.readFile(tunnelInitRecordPath(connector.userData), "utf8"),
    );
    assert.equal(initArgv.includes("--tunnel-id"), true);
    assert.equal(
      initArgv[initArgv.indexOf("--tunnel-id") + 1],
      "tunnel_farol_next_e2e",
    );
    const runtimeSnapshot = await connector.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    const runtime =
      runtimeSnapshot.configuration.settings.connectors.secureMcp.runtime;
    assert.equal(runtime.state, "ready");
    assert.equal(
      runtimeSnapshot.configuration.settings.connectors.secureMcp.credential,
      "stored",
    );
    // A started connector asks for exactly one thing next, and shows the
    // challenge it wants answered.
    await connector.window.waitForFunction(
      () =>
        document.querySelector("#connection-readiness .connector-challenge") !==
        null,
    );
    const challenged = await connectionState();
    assert.equal(challenged.challenge, true, JSON.stringify(challenged));
    cases.push("n09-connector-started-with-synthetic-client");

    // While it runs, its own configuration is frozen, and each control that
    // refuses says why rather than being merely grey.
    assert.equal(
      await connector.window.locator("#settings-connector-tunnel").isDisabled(),
      true,
    );
    assert.equal(
      await connector.window.locator("#settings-connector-key").isDisabled(),
      true,
    );
    const runningState = await connectionState();
    const redetectClient = runningState.buttons?.find(
      (button) => button.label === "Re-detect client",
    );
    assert.ok(redetectClient, JSON.stringify(runningState));
    assert.equal(redetectClient.disabled, true, JSON.stringify(runningState));
    assert.equal(
      redetectClient.title,
      "Stop the connector before replacing its client.",
      JSON.stringify(runningState),
    );
    cases.push("n09-connector-running-freezes-its-own-configuration");

    // Stop clears the runtime proof rather than only the button state.
    await clickRowButton("Stop");
    await connectorFeedback(/^Connector stopped and runtime proof cleared\.$/u);
    const stopped = await connector.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.equal(
      stopped.configuration.settings.connectors.secureMcp.runtime,
      null,
    );
    assert.equal(
      stopped.configuration.settings.connectors.secureMcp.challenge,
      null,
    );
    const afterStop = await connectionState();
    assert.equal(
      afterStop.buttons?.find((button) => button.label === "Stop")?.title,
      "The connector is not running.",
      JSON.stringify(afterStop),
    );
    assert.equal(afterStop.challenge, false, JSON.stringify(afterStop));
    cases.push("n09-connector-stop-clears-runtime-and-challenge");
  } finally {
    await close(connector);
    await fs.rm(tunnelFixture.root, { recursive: true, force: true });
  }
}

// N09b — the attachment challenge, answered by the smallest honest local
// peer, and checked by the product's own verdict.
//
// Read this before reading the case. Farol's attachment proof is a local
// challenge and a local receipt: the connector is asked to call
// `farol_next_connector_verify` once with the challenge Farol minted, the
// production MCP server records a write-once receipt, and
// `connector.check-attachment` decides the verdict from that receipt. This
// segment plays the connector's part by speaking MCP over stdio to the same
// `computer-mcp` entry, under the same launch contract Farol itself wrote,
// with the challenge read off the card the owner would read it from.
//
// So what this proves is exact and bounded: Farol mints a challenge, shows
// it, accepts exactly one answer to it, records a content-free receipt, and
// turns that receipt into a verified attachment through its own button.
// What it does NOT prove, and what no local test can: that a real tunnel
// registered with the provider routes anything to this machine, that the
// real third-party tunnel client behaves as the product assumes, or that a
// real ChatGPT session can reach this tool at all. Those three remain
// unproven and are named as such in the acceptance pack. "Verified" here is
// the product's verdict over a real receipt, not a claim about the remote
// half.
n09ConnectorAttachmentSegment: {
  if (!segmentSelected("n09-connector-attachment")) {
    break n09ConnectorAttachmentSegment;
  }
  const attachFixture = await startTunnelClientFixture();
  const attaching = await launch([], "hidden", "demo", {
    environment: { FAROL_NEXT_E2E_TUNNEL_CLIENT: attachFixture.executable },
  });
  let peer = null;
  try {
    await completeSetup(attaching, false, true);
    await attaching.window.locator('[data-section="computer"]').click();
    await attaching.window.waitForFunction(
      () => document.documentElement.dataset.section === "computer",
    );
    const row = attaching.window
      .locator("#connection-readiness .connection-row")
      .filter({ hasText: "Connection · " });
    const feedback = (pattern) =>
      attaching.window.waitForFunction(
        (source) =>
          new RegExp(source, "u").test(
            document.querySelector("#computer-feedback")?.textContent ?? "",
          ),
        pattern.source,
      );
    await row
      .getByRole("button", { name: "Detect client", exact: true })
      .click();
    await feedback(/^tunnel-client \S+ verified/u);
    await attaching.window
      .locator("#settings-connector-tunnel")
      .fill("tunnel_farol_next_attach");
    await attaching.window
      .locator("#settings-connector-key")
      .fill("farol-next-e2e-runtime-key-0002");
    await row.getByRole("button", { name: "Save route", exact: true }).click();
    await feedback(/^Connector route saved\.$/u);
    await row
      .getByRole("button", { name: "Start & check", exact: true })
      .click();
    await feedback(/^Connector ready · runtime/u);

    // The challenge and the workspace id are taken from the card the owner
    // is told to copy them from, not from a snapshot the UI never showed.
    const challengeCard = row.locator(".connector-challenge");
    await challengeCard.waitFor();
    const challengeRows = await challengeCard.locator("code").allInnerTexts();
    assert.equal(
      challengeRows.length,
      2,
      "the card shows exactly the challenge and the workspace it names",
    );
    const [challengeValue, challengeWorkspaceId] = challengeRows.map((value) =>
      value.trim(),
    );
    assert.match(challengeValue, /^[a-z0-9][a-z0-9-]*$/u);

    // The peer. It runs the production MCP entry under the launch contract
    // Farol wrote for this connector generation — no stub, no fake receipt.
    // `loadReadonlyComputerLaunchContract` refuses a path that is not
    // canonical, and the harness's isolated home sits under the symlinked
    // `/var/folders` form of the temporary directory — so the peer must be
    // handed the resolved path, exactly as the tunnel client would be.
    const launchContract = await fs.realpath(
      path.join(
        attaching.userData,
        "farol-next-state",
        "secure-mcp-connector",
        "computer-authority",
        "computer-launch.json",
      ),
    );
    assert.equal(
      JSON.parse(await fs.readFile(launchContract, "utf8"))
        .connectorVerification.challengeSha256,
      createHash("sha256").update(challengeValue).digest("hex"),
      "the challenge on the card is the one the launch contract pinned",
    );
    const { Client } = await import("@modelcontextprotocol/client");
    const { StdioClientTransport } =
      await import("@modelcontextprotocol/client/stdio");
    const peerCommand = development
      ? {
          command: process.execPath,
          args: [path.join(root, "_output/build/app/computer-mcp.cjs")],
          env: undefined,
        }
      : {
          command: path.join(
            appPath,
            "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
          ),
          args: [path.join(appPath, "Contents/Resources/app/computer-mcp.cjs")],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            ...Object.fromEntries(
              ["HOME", "PATH", "TMPDIR"]
                .map((name) => [name, process.env[name]])
                .filter(([, value]) => value !== undefined),
            ),
          },
        };
    const transport = new StdioClientTransport({
      command: peerCommand.command,
      args: [...peerCommand.args, "--launch-contract", launchContract],
      cwd: root,
      stderr: "pipe",
      ...(peerCommand.env ? { env: peerCommand.env } : {}),
    });
    // The peer's own child refuses an untrusted launch on stderr and then
    // exits, which reaches the client only as "Connection closed". Keep its
    // reason, so a refusal names itself instead of looking like a transport
    // fault.
    let peerStderr = "";
    transport.stderr?.on("data", (chunk) => {
      peerStderr += String(chunk);
    });
    peer = new Client({
      name: "farol-next-e2e-connector-peer",
      version: "1.0.0",
    });
    try {
      await peer.connect(transport);
    } catch (error) {
      throw new Error(
        `${error.message} · the MCP peer refused this launch contract · stderr ${JSON.stringify(peerStderr.slice(0, 400))} · contract ${launchContract}`,
        { cause: error },
      );
    }
    assert.equal(
      (await peer.listTools()).tools.some(
        (tool) => tool.name === "farol_next_connector_verify",
      ),
      true,
      "the verify tool exists only because this launch contract pinned a challenge",
    );
    const verified = await peer.callTool({
      name: "farol_next_connector_verify",
      arguments: {
        challenge: challengeValue,
        workspaceId: challengeWorkspaceId,
      },
    });
    assert.equal(verified.isError ?? false, false);
    const receiptPath = path.join(
      path.dirname(launchContract),
      "connector-verification-receipt.json",
    );
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    assert.equal((await fs.stat(receiptPath)).mode & 0o777, 0o600);
    assert.equal(
      receipt.challengeSha256,
      createHash("sha256").update(challengeValue).digest("hex"),
    );
    // The receipt is evidence, not a transcript: it carries no path, no
    // file name and no content from the workspace it read.
    const receiptText = JSON.stringify(receipt);
    assert.doesNotMatch(receiptText, /README|approved-workspace|fixture/u);
    assert.doesNotMatch(
      receiptText,
      new RegExp(
        attaching.workspaceRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        "u",
      ),
    );
    cases.push("n09-attach-challenge-answered-by-local-peer");

    // One answer, ever. A second call cannot overwrite the receipt.
    // The refusal may arrive as a tool error or as a rejected call; either
    // is a refusal, and neither may leave a second receipt.
    const replayed = await peer
      .callTool({
        name: "farol_next_connector_verify",
        arguments: {
          challenge: challengeValue,
          workspaceId: challengeWorkspaceId,
        },
      })
      .then(
        (value) => ({ refused: value.isError === true, detail: value }),
        (error) => ({ refused: true, detail: { message: String(error) } }),
      );
    assert.equal(replayed.refused, true, "a replayed answer is refused");
    assert.match(
      JSON.stringify(replayed.detail),
      /CONNECTOR_VERIFICATION_ALREADY_RECORDED/u,
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(receiptPath, "utf8")),
      receipt,
      "a second answer leaves the one recorded receipt untouched",
    );
    cases.push("n09-attach-challenge-answered-exactly-once");

    // The product's own verdict, through its own button.
    await row
      .getByRole("button", { name: "Check attachment", exact: true })
      .click();
    await feedback(/^ChatGPT attachment verified · workspace /u);
    await attaching.window.waitForFunction(
      () =>
        document.querySelectorAll("#connection-readiness .connector-challenge")
          .length === 0,
    );
    const attached = await attaching.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    const secureMcp = attached.configuration.settings.connectors.secureMcp;
    assert.equal(secureMcp.challenge, null);
    assert.equal(secureMcp.attachment.workspaceId, challengeWorkspaceId);
    assert.equal(secureMcp.runtime.state, "ready");
    cases.push("n09-attach-verified-from-its-own-receipt");
  } finally {
    await peer?.close().catch(() => undefined);
    await close(attaching);
    await fs.rm(attachFixture.root, { recursive: true, force: true });
  }
}

// One line per segment boundary. A lane that runs every segment in one
// process and stops answering says nothing about where it stopped; this
// makes that readable from the log alone, at the cost of two lines.
function segmentMark(name, phase) {
  process.stdout.write(
    `E2E_SEGMENT ${name} ${phase} ${new Date().toISOString()}\n`,
  );
}

// N12 — the Agent editor under a background return, an owner's own close,
// and an authority change. U1's acceptance, and deliberately the opposite
// shape to N11's: every value here is typed ONCE with real keys, nothing is
// re-typed, no menu is reopened until something succeeds, and a missed
// assertion fails the case instead of becoming an observation.
//
// The background event is the product's own. `recordChatGptSignInOutcome`
// publishes an `open-settings` shell action when a managed sign-in window
// reports its outcome (main.ts), and the renderer's handler navigates the
// shell for it — which is what used to take the task menu away from under
// an owner mid-draft. The Settings button deliberately hides task chrome
// while sign-in is open, so this case opens the same managed window through
// the product's configure API. Separate UI cases cover that button. Closing
// the real window publishes the production action; no shell event is faked.
//
// LIMIT, stated because it is the part this case cannot yet prove: until
// `ShellActionSchema` carries `source` and `authWindowGeneration`, the run
// can show that a background return arrived and that the editor survived
// it, but not which of the publishers emitted it. The recorder below keeps
// whatever provenance the payload carries, so the assertion tightens the
// day those fields exist; it does not pretend to have them now.
n12AgentDraftSegment: {
  if (!segmentSelected("n12-agent-draft")) break n12AgentDraftSegment;
  segmentMark("n12-agent-draft", "start");
  const draft = await launch([], "secondary-visible", "ordinary");
  try {
    // B's diagnostic prints one line per shell action; capture it here so
    // its decision lands in the same report, in arrival order, on the same
    // clock as the events it explains.
    const consoleLines = [];
    // The report buffer above is bounded and re-indexed when it fills, so
    // neither a stored index into it nor a scan of it can answer "did this
    // event happen". These two records can: they are parsed from the full
    // line before it is truncated, never trimmed, and grow by one entry per
    // shell action — a handful in a run.
    const shellActionGenerations = new Map();
    const decisionEventIds = new Set();
    const record = (text, marker, keep) => {
      const match = new RegExp(`${marker}\\s+(\\{.*\\})`, "u").exec(text);
      if (!match) return;
      try {
        keep(JSON.parse(match[1]));
      } catch {
        // An unparsable payload stays in the report and out of the record.
      }
    };
    draft.window.on("console", (message) => {
      const text = message.text();
      // Every `farol.` diagnostic, not one of them: filtering to a single
      // prefix turns "the others did not appear" into a statement about
      // this filter rather than about the product.
      if (text.includes("farol.")) {
        // Bounded. `render` and `applyTasksState` log on every run while the
        // menu is open, and an unbounded capture of that stream stalled a
        // run outright — a diagnostic that stops the thing it is watching
        // measures nothing.
        record(text, "farol\\.shell-action", (payload) => {
          if (typeof payload.eventId === "string") {
            shellActionGenerations.set(
              payload.eventId,
              typeof payload.gen === "number" ? payload.gen : null,
            );
          }
        });
        record(text, "farol\\.shell-decision", (payload) => {
          if (typeof payload.eventId === "string") {
            decisionEventIds.add(payload.eventId);
          }
        });
        consoleLines.push({ at: Date.now(), text: text.slice(0, 600) });
        if (consoleLines.length > 240) consoleLines.splice(0, 40);
      }
    });
    await draft.window.evaluate(() => {
      // One monotonic counter for both recorders. An array's length can be
      // reset by a re-render or a reassignment; a sequence that only ever
      // increases cannot, which is what a wait should be gated on.
      globalThis.__farolE2ESeq = 0;
      const observed = [];
      globalThis.__farolE2EMenuEvents = observed;
      // `applyHostLayout` obeys a main-side `publishLayout()` push, and that
      // push is invisible to the shell-action list — it is the only writer
      // that can take the overlay to "none" while leaving the section on
      // "browser", which is exactly the shape this case keeps failing in.
      const layouts = [];
      globalThis.__farolE2ELayouts = layouts;
      window.farolNext.onLayout((value) => {
        layouts.push({
          seq: ++globalThis.__farolE2ESeq,
          at: Date.now(),
          section: value?.section ?? null,
          taskId: value?.taskId ?? null,
          overlay: value?.overlay ?? null,
          setupOpen: value?.setupOpen ?? null,
          sidebar: value?.sidebar ?? null,
        });
        if (layouts.length > 32) layouts.shift();
      });
      window.farolNext.onShellAction((value) => {
        observed.push({
          seq: ++globalThis.__farolE2ESeq,
          at: Date.now(),
          action: value?.action ?? null,
          // Provenance, if this build's contract carries any. Absent today.
          source: value?.source ?? null,
          authWindowGeneration: value?.authWindowGeneration ?? null,
          eventId: value?.eventId ?? null,
        });
      });
    });
    const shellActions = () =>
      draft.window.evaluate(() => globalThis.__farolE2EMenuEvents ?? []);

    const subfolder = path.join(draft.workspaceRoot, "notes");
    await fs.mkdir(subfolder, { mode: 0o700 });
    for (const [name, body] of [
      ["keep.md", "Farol Next agent subfolder fixture\n"],
      ["scope.md", "Farol Next agent exclusion fixture\n"],
    ]) {
      await fs.writeFile(path.join(subfolder, name), body, { mode: 0o600 });
    }

    await completeSetup(draft, false, true, true, false);
    const toConnections = async () => {
      await draft.window.locator('[data-section="computer"]').click();
      await draft.window.waitForFunction(
        () => document.documentElement.dataset.section === "computer",
      );
    };
    const toBrowser = async () => {
      await draft.window
        .locator('.nav-item[data-section="browser"]')
        .click({ timeout: 20_000 });
      await draft.window.waitForFunction(
        () => document.documentElement.dataset.section === "browser",
      );
    };
    const settingsFeedback = (pattern) =>
      draft.window.waitForFunction(
        (source) =>
          new RegExp(source, "u").test(
            document.querySelector("#computer-feedback")?.textContent ?? "",
          ),
        pattern.source,
      );
    const hostRow = draft.window
      .locator("#connection-readiness .connection-row")
      .filter({ hasText: "Native hosts · " });

    await toConnections();
    await draft.window.waitForFunction(() =>
      [...document.querySelectorAll("#connection-readiness button")].some(
        (button) => button.textContent === "Re-detect host",
      ),
    );
    const selectedHost = await draft.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    await assertSameFixtureExecutable(
      selectedHost.configuration.settings.nativeHosts.codex.executablePath,
      draft.codexFixture,
    );
    await hostRow
      .getByRole("button", {
        name: /^(?:Run Agent prerequisite|Run live check)$/u,
      })
      .click({ timeout: 20_000 });
    await settingsFeedback(
      /^gpt-6-astra host turn completed with 1 correlated Farol Next tool call/u,
    );
    await hostRow
      .getByRole("button", { name: "Verify Agent", exact: true })
      .click({ timeout: 20_000 });
    await draft.window.waitForFunction(() =>
      [...document.querySelectorAll("#connection-readiness button")].some(
        (button) => button.textContent === "Agent verified",
      ),
    );

    // Every click in this case explains itself when it fails. A control that
    // is gone is the defect under test, so "timed out" alone is never a
    // usable answer here.
    let menuNodeAtOpen = null;
    const draftDump = async (label, error) => {
      // Replaced, closed, or merely hidden are three different defects and
      // one symptom. The node captured when the menu opened answers which:
      // a different node in the document means it was replaced, the same
      // node still open but disconnected means it was detached, and an open
      // connected node with no layout box means it was hidden.
      const menuIdentity = menuNodeAtOpen
        ? await menuNodeAtOpen
            .evaluate((element) => ({
              sameNode: element === document.querySelector("#task-menu"),
              capturedIsConnected: element.isConnected,
              capturedOpen: element.open ?? null,
            }))
            .catch(() => null)
        : null;
      // `offsetParent` is null for any position: fixed element, which a
      // <dialog> normally is, so it cannot say whether this one is visible.
      // Measure the box and the engine's own visibility answer instead, and
      // record the dialog stack: a later showModal() makes everything
      // outside the topmost modal inert, which looks exactly like an open,
      // connected, same-node menu whose controls refuse every click.
      const visibleMenu = await draft.window
        .evaluate(() => {
          const read = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              open: element.open ?? null,
              isConnected: element.isConnected,
              rect: {
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                x: Math.round(rect.x),
                y: Math.round(rect.y),
              },
              checkVisibility:
                typeof element.checkVisibility === "function"
                  ? element.checkVisibility()
                  : null,
              isModal: element.matches(":modal"),
            };
          };
          const openDialogs = [...document.querySelectorAll("dialog[open]")];
          return {
            taskMenu: read("#task-menu"),
            subtree: read("#task-agent-subtree"),
            exclusions: read("#task-agent-exclusions"),
            objective: read("#task-agent-objective"),
            openDialogs: openDialogs.map((dialog) => ({
              id: dialog.id || null,
              isModal: dialog.matches(":modal"),
            })),
            topmostModal:
              openDialogs.filter((dialog) => dialog.matches(":modal")).at(-1)
                ?.id ?? null,
            setupDialogOpen:
              document.querySelector("#setup-dialog")?.open ?? null,
            setupDialogModal:
              document.querySelector("#setup-dialog")?.matches(":modal") ??
              null,
            activeElementId: document.activeElement?.id ?? null,
          };
        })
        .catch(() => null);
      const windows = await draft.application
        .evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((browserWindow) => ({
            id: browserWindow.id,
            visible: browserWindow.isVisible(),
            destroyed: browserWindow.isDestroyed(),
            url: browserWindow.webContents.getURL(),
          })),
        )
        .catch(() => null);
      const surface = await draft.window
        .evaluate(() => ({
          menuVisible:
            document.querySelector("#task-menu") instanceof HTMLElement &&
            document.querySelector("#task-menu").offsetParent !== null,
          liveHidden:
            document.querySelector("#task-menu-live")?.hasAttribute("hidden") ??
            null,
          selectedTaskId:
            document
              .querySelector("#task-tabs .task-tab.active")
              ?.getAttribute("data-task-id") ?? null,
          taskTabs: document.querySelectorAll("#task-tabs .task-tab").length,
          section: document.documentElement.dataset.section ?? null,
          scope: document.querySelector("#task-agent-scope")?.value ?? null,
          subtree: document.querySelector("#task-agent-subtree")?.value ?? null,
          exclusions:
            document.querySelector("#task-agent-exclusions")?.value ?? null,
          objective:
            document.querySelector("#task-agent-objective")?.value ?? null,
          shellActions: globalThis.__farolE2EMenuEvents ?? [],
          layouts: globalThis.__farolE2ELayouts ?? [],
        }))
        .catch(() => null);
      return new Error(
        `${error.message} · at ${label} · menu ${JSON.stringify({ menuIdentity, visibleMenu })} · surface ${JSON.stringify(surface)} · windows ${JSON.stringify(windows)} · console ${JSON.stringify(consoleLines)}`,
        { cause: error },
      );
    };
    // Waits over readings the harness holds, not the page: the console
    // lines live here. Same thirty-second bound as every other wait.
    const waitInHarness = async (label, predicate) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (await predicate()) return;
        if (Date.now() >= deadline) {
          throw await draftDump(label, new Error("E2E_HARNESS_WAIT_TIMEOUT"));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    // A window is identified by the generation stamped on its action, so
    // the two directions of one predicate separate this case's own window
    // from every older one. Neither depends on when a line arrived.
    const decisionForGeneration = (accept) =>
      [...decisionEventIds].some((id) => {
        const generation = shellActionGenerations.get(id);
        return typeof generation === "number" && accept(generation);
      });
    const layoutSeenSince = async (seq) =>
      draft.window
        .evaluate(
          (seen) =>
            (globalThis.__farolE2ELayouts ?? []).some(
              (entry) => entry.seq > seen,
            ),
          seq,
        )
        .catch(() => false);
    const clickInDraft = async (selector) => {
      try {
        await draft.window.locator(selector).click({ timeout: 20_000 });
      } catch (error) {
        throw await draftDump(`click ${selector}`, error);
      }
    };
    const waitInDraft = async (label, predicate, arg) => {
      try {
        await draft.window.waitForFunction(predicate, arg);
      } catch (error) {
        throw await draftDump(label, error);
      }
    };

    // The three values, typed once, with real keys rather than a value
    // assignment — this case is about what survives an owner's typing.
    const typeAgentDraft = async (values) => {
      await draft.window
        .locator("#task-agent-scope")
        .selectOption("subtree", { timeout: 20_000 });
      await draft.window.waitForFunction(() => {
        const field = document.querySelector("#task-agent-subtree");
        return field instanceof HTMLElement && field.offsetParent !== null;
      });
      for (const [selector, text] of [
        ["#task-agent-subtree", values.subtree],
        ["#task-agent-exclusions", values.exclusions],
        ["#task-agent-objective", values.objective],
      ]) {
        try {
          await draft.window.locator(selector).click({ timeout: 20_000 });
          await draft.window.keyboard.type(text);
        } catch (error) {
          // The editor went away between two of the owner's fields. Which
          // windows are alive at this instant decides what that means: if
          // the sign-in surface has already completed and closed itself,
          // this is the background return arriving earlier than the case's
          // own step, not a wider defect. Read it before saying either.
          const windows = await draft.application
            .evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().map((browserWindow) => ({
                id: browserWindow.id,
                visible: browserWindow.isVisible(),
                destroyed: browserWindow.isDestroyed(),
                url: browserWindow.webContents.getURL(),
              })),
            )
            .catch(() => null);
          const surface = await draft.window
            .evaluate(() => ({
              menuVisible:
                document.querySelector("#task-menu") instanceof HTMLElement &&
                document.querySelector("#task-menu").offsetParent !== null,
              // A menu that is present but whose live panel is hidden means
              // the selection moved to a task the Agent editor does not
              // belong to, which is a different loss from the menu closing.
              liveHidden:
                document
                  .querySelector("#task-menu-live")
                  ?.hasAttribute("hidden") ?? null,
              // The selection itself, read off the tab the shell marks
              // active, since the renderer's own variable is private.
              selectedTaskId:
                document
                  .querySelector("#task-tabs .task-tab.active")
                  ?.getAttribute("data-task-id") ?? null,
              taskTabs: document.querySelectorAll("#task-tabs .task-tab")
                .length,
              section: document.documentElement.dataset.section ?? null,
              scope: document.querySelector("#task-agent-scope")?.value ?? null,
              subtree:
                document.querySelector("#task-agent-subtree")?.value ?? null,
              exclusions:
                document.querySelector("#task-agent-exclusions")?.value ?? null,
              objective:
                document.querySelector("#task-agent-objective")?.value ?? null,
              shellActions: globalThis.__farolE2EMenuEvents ?? [],
              // Same clock, so the reader can place a layout push between
              // the outcome and the click that found nothing to click.
              layouts: globalThis.__farolE2ELayouts ?? [],
            }))
            .catch(() => null);
          throw new Error(
            `${error.message} · typing ${selector} · surface ${JSON.stringify(surface)} · windows ${JSON.stringify(windows)}`,
            { cause: error },
          );
        }
      }
    };
    const shownAgentDraft = () =>
      draft.window.evaluate(() => ({
        scope: document.querySelector("#task-agent-scope")?.value ?? null,
        subtree: document.querySelector("#task-agent-subtree")?.value ?? null,
        exclusions:
          document.querySelector("#task-agent-exclusions")?.value ?? null,
        objective:
          document.querySelector("#task-agent-objective")?.value ?? null,
      }));
    const newDraftTask = async (expected) => {
      await draft.window.locator("#new-task").click({ timeout: 20_000 });
      await draft.window.waitForFunction(
        (count) =>
          document.querySelectorAll("#task-tabs .task-tab").length === count,
        expected,
      );
      const state = await draft.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      return state.tasks.at(-1).taskId;
    };
    const openDraftMenu = async () => {
      await draft.window
        .locator("#task-menu-button")
        .click({ timeout: 20_000 });
      await draft.window
        .locator("#task-menu")
        .waitFor({ state: "visible", timeout: 20_000 });
      menuNodeAtOpen = await draft.window.locator("#task-menu").elementHandle();
    };
    const agentInputRoot = path.join(
      draft.userData,
      "farol-next-state",
      "product-agent-inputs",
    );
    const deliveredEnvelopes = async () =>
      fs
        .readdir(agentInputRoot)
        .then((entries) => entries.filter((entry) => entry.endsWith(".json")))
        .catch(() => []);

    // --- A background return must not take the editor away -----------------
    // Open the real managed sign-in window without entering the Settings
    // button's foreground mode, so a task draft can remain on screen.
    const signInWindow = draft.application.waitForEvent("window", {
      timeout: 20_000,
    });
    const signInRequest = await draft.window.evaluate(() =>
      window.farolNext.configure({ kind: "chatgpt.open-sign-in" }),
    );
    assert.equal(signInRequest.ok, true);
    const signInPage = await signInWindow;
    await signInPage.waitForURL(draft.chatGptFixture.url);
    // A sequence baseline only. There is deliberately no console baseline:
    // the delayed outcome of an older window can land before this case
    // starts — measured, it lands before the menu is even open — so any
    // index taken here could never see it, which is what made the previous
    // version of this wait unsatisfiable.
    const sequenceAtSignInOpen = await draft.window.evaluate(
      () => globalThis.__farolE2ESeq ?? 0,
    );

    await toBrowser();
    await newDraftTask(1);
    await openDraftMenu();
    const typed = {
      subtree: "notes",
      exclusions: "notes/scope.md",
      objective:
        "Read the approved subfolder and report what its scope allows.",
    };
    // The proof only the real DOM can give: the same input node, still
    // holding the whole word, across an outcome that arrived mid-word. A
    // field that was destroyed and rebuilt with the right text would pass a
    // value check and fail this one.
    await draft.window
      .locator("#task-agent-scope")
      .selectOption("subtree", { timeout: 20_000 });
    // `offsetParent` is null for anything inside a fixed-position element,
    // so it cannot see a field inside this dialog at all. The engine's own
    // visibility answer and a real box can.
    await draft.window.waitForFunction(() => {
      const field = document.querySelector("#task-agent-subtree");
      if (!(field instanceof HTMLElement)) return false;
      const box = field.getBoundingClientRect();
      return field.checkVisibility() && box.width > 0 && box.height > 0;
    });
    const subtreeNode = await draft.window
      .locator("#task-agent-subtree")
      .elementHandle();
    assert.ok(subtreeNode, "the relative-root field exists before typing");
    // The case's own window is the most recently opened, so its outcome
    // carries a higher generation than any older window's. A delayed gen-2
    // outcome from Setup's window can and did arrive first; waiting for
    // "any new action" would accept it and assert against the wrong event.
    const generationBeforeClose = [...shellActionGenerations.values()].reduce(
      (highest, generation) =>
        typeof generation === "number" && generation > highest
          ? generation
          : highest,
      -1,
    );
    // Asserted, not waited for. Setup opens and closes its own sign-in
    // window in every run of this case, so its outcome is due in every run
    // and a run without it exercised less than this case claims. Its
    // arrival time is not this case's to schedule, which is why the record
    // is read once here instead of being blocked on. Reading it here also
    // makes the generation above a sound discriminator: this case's own
    // window is the newest, so its generation is higher than one already
    // stamped on the record.
    assert.equal(
      decisionForGeneration((generation) => generation >= 0),
      true,
      `an older window's outcome was decided before this case closed its own · ${JSON.stringify(consoleLines)}`,
    );
    const sequenceBeforeClose = await draft.window.evaluate(
      () => globalThis.__farolE2ESeq ?? 0,
    );
    await clickInDraft("#task-agent-subtree");
    await draft.window.keyboard.type("no");
    // A layout is recorded as evidence rather than required: whether one is
    // due depends on what the product does, and gating on it would be
    // another assumption of mine.
    const layoutBeforeClose = await layoutSeenSince(sequenceAtSignInOpen);
    // The background event, caused here rather than waited for. Closing the
    // sign-in window is what makes production record its outcome, so firing
    // it in the middle of a word puts the event exactly where the owner's
    // hands are — instead of hoping one arrives while they type, which is
    // what the previous version of this wait depended on.
    await signInPage.close();
    // This case's own window is the newest, so its decision is the one for
    // a generation above every earlier window's.
    await waitInHarness(
      "the decision for this case's own sign-in window",
      async () => decisionForGeneration((gen) => gen > generationBeforeClose),
    );
    // The layout push the owner's keystrokes have to survive, CAUSED here
    // rather than hoped for.
    //
    // Measured on this build, attempt 20260921T072522310Z-bab0da60: closing
    // the sign-in window publishes a shell action and NO layout at all. The
    // only layout in the recorder at this point is seq 2, the push the New
    // task admission made before the field was even captured, so a
    // requirement for "a layout newer than the capture" would have waited
    // 30 s and failed for want of an event nobody caused.
    //
    // "Show/Hide Sidebar" in the View menu is a production path that does
    // cause one: it reaches `requestSidebarToggle`, and on a window wider
    // than 979px that writes section "browser", overlay "none" and a new
    // sidebar preference. Section unchanged, overlay "none" — the exact
    // shape the layout recorder above was installed for, and the one shape
    // that can take the editor away without any shell action in the trace.
    const toggledSidebar = await draft.application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "view.toggle-sidebar",
      );
      if (!item) return "missing";
      item.click();
      return "clicked";
    });
    assert.equal(
      toggledSidebar,
      "clicked",
      "the View menu still offers the sidebar toggle this case causes",
    );
    await waitInHarness(
      "a host layout published after the field was captured",
      () => layoutSeenSince(sequenceBeforeClose),
    );
    const arrivedLayout = await draft.window.evaluate(
      (since) =>
        (globalThis.__farolE2ELayouts ?? []).findLast(
          (entry) => entry.seq > since,
        ) ?? null,
      sequenceBeforeClose,
    );
    assert.ok(
      arrivedLayout && arrivedLayout.seq > sequenceBeforeClose,
      `a layout arrived after the capture · ${JSON.stringify(arrivedLayout)}`,
    );
    assert.equal(
      arrivedLayout.section,
      "browser",
      `the caused push leaves the section alone · ${JSON.stringify(arrivedLayout)}`,
    );
    assert.equal(
      arrivedLayout.overlay,
      "none",
      `the caused push carries main's overlay mirror · ${JSON.stringify(arrivedLayout)}`,
    );
    assert.equal(
      arrivedLayout.sidebar,
      "rail",
      `the push is the toggle's own, by the preference only it changed · ${JSON.stringify(arrivedLayout)}`,
    );
    // The tested ordering, on the one monotonic sequence both recorders
    // share: the field was captured first, the background return arrived
    // after it, and the layout push after that. A run where the push landed
    // before the return would be a different interleaving from the one this
    // case claims to test.
    const backgroundReturnEvent = (await shellActions()).findLast(
      (event) =>
        event.action === "open-settings" && event.seq > sequenceBeforeClose,
    );
    assert.ok(
      backgroundReturnEvent,
      `the background return arrived after the field was captured · ${JSON.stringify(await shellActions())}`,
    );
    assert.equal(
      arrivedLayout.seq > backgroundReturnEvent.seq,
      true,
      `the caused layout push lands after the background return · ${JSON.stringify({ arrivedLayout, backgroundReturnEvent })}`,
    );
    // Where the owner's hands were, before the rest of the word is typed.
    assert.deepEqual(
      await draft.window.evaluate(() => ({
        active: document.activeElement?.id ?? null,
        caret:
          document.querySelector("#task-agent-subtree")?.selectionStart ?? null,
      })),
      { active: "task-agent-subtree", caret: 2 },
      `the push left focus and the caret where the owner's hands were · ${JSON.stringify(arrivedLayout)}`,
    );
    await draft.window.keyboard.type("tes");
    assert.equal(
      await subtreeNode.evaluate(
        (element) => element === document.querySelector("#task-agent-subtree"),
      ),
      true,
      `the field the owner is typing in is the same node after the layout push · ${JSON.stringify(arrivedLayout)}`,
    );
    assert.equal(
      await subtreeNode.evaluate((element) => element.value),
      typed.subtree,
      `the word survives a layout push that arrived in the middle of it · ${JSON.stringify(arrivedLayout)}`,
    );
    // `offsetParent` is null inside this fixed-position dialog, so the
    // engine's own visibility answer and a real box are what can say the
    // surviving node is still the one on screen.
    assert.equal(
      await subtreeNode.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.checkVisibility() && box.width > 0 && box.height > 0;
      }),
      true,
      `the surviving node is still visible and laid out · ${JSON.stringify(arrivedLayout)}`,
    );
    process.stdout.write(
      `E2E_AGENT_DRAFT layoutBeforeClose=${String(layoutBeforeClose)} layout=${JSON.stringify(arrivedLayout)} console=${JSON.stringify(consoleLines)}\n`,
    );
    for (const [selector, text] of [
      ["#task-agent-exclusions", typed.exclusions],
      ["#task-agent-objective", typed.objective],
    ]) {
      await clickInDraft(selector);
      await draft.window.keyboard.type(text);
    }
    assert.deepEqual(
      await shownAgentDraft(),
      { scope: "subtree", ...typed },
      "the three values are in the editor before the background event",
    );

    // The window was closed mid-word above; this reads the action it
    // produced rather than closing anything a second time.
    const backgroundReturn = (await shellActions()).at(-1);
    assert.equal(
      backgroundReturn.action,
      "open-settings",
      `the closed sign-in window published a background return · ${JSON.stringify(backgroundReturn)}`,
    );

    // The editor is still there, still usable, and still the owner's text.
    assert.equal(
      await draft.window.locator("#task-menu").isVisible(),
      true,
      "a background return does not take the editor away",
    );
    assert.deepEqual(
      await shownAgentDraft(),
      { scope: "subtree", ...typed },
      "a background return does not discard what the owner typed",
    );
    assert.equal(
      await draft.window.locator("#task-menu-agent").isDisabled(),
      false,
      "the editor is usable, not merely present",
    );
    process.stdout.write(
      `E2E_AGENT_DRAFT background=${JSON.stringify(backgroundReturn)}\n`,
    );
    cases.push("n12-agent-draft-survives-background-auth-window-return");

    // Submitted once, and the wire shape is the one N11 pinned.
    if (positiveProductAgentQualification) {
      await draft.window.locator("#task-menu-agent").click({ timeout: 20_000 });
      await draft.window.waitForFunction(
        () =>
          document.querySelector("#task-menu-note")?.textContent ===
          "Agent assignment admitted.",
      );
      const delivered = await deliveredEnvelopes();
      assert.equal(delivered.length, 1, "one submission, one envelope");
      const envelope = JSON.parse(
        await fs.readFile(path.join(agentInputRoot, delivered[0]), "utf8"),
      );
      assert.equal(envelope.schema, 2);
      assert.deepEqual(envelope.input.scope, {
        mode: "subtree",
        root: subfolder,
      });
      assert.deepEqual(envelope.input.excludedPaths, [
        path.join(subfolder, "scope.md"),
      ]);
      cases.push("n12-agent-draft-survives-to-a-single-submission");
    } else {
      const beforeRefusal = await draft.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      await draft.window.locator("#task-menu-agent").click({ timeout: 20_000 });
      await waitForTaskMenuNote(
        draft,
        "Product Agent is unavailable in this build. No Agent operation was started.",
      );
      assert.deepEqual(
        await shownAgentDraft(),
        { scope: "subtree", ...typed },
        "a default-off Agent refusal preserves the owner's draft",
      );
      const afterRefusal = await draft.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      assert.equal(afterRefusal.taskRevision, beforeRefusal.taskRevision);
      assert.deepEqual(await deliveredEnvelopes(), []);
      cases.push("n12-agent-draft-survives-default-off-refusal");
    }

    // --- The owner's own close still clears --------------------------------
    await draft.window.keyboard.press("Escape");
    await draft.window
      .locator("#task-menu")
      .waitFor({ state: "hidden", timeout: 20_000 });
    await newDraftTask(2);
    await openDraftMenu();
    await typeAgentDraft({
      subtree: "notes",
      exclusions: "notes/scope.md",
      objective: "This draft is dismissed by its owner, not by anything else.",
    });
    await draft.window.keyboard.press("Escape");
    await draft.window
      .locator("#task-menu")
      .waitFor({ state: "hidden", timeout: 20_000 });
    await openDraftMenu();
    assert.deepEqual(
      await shownAgentDraft(),
      { scope: "workspace", subtree: "", exclusions: "", objective: "" },
      "the owner dismissing the menu drops the draft, as documented",
    );
    cases.push("n12-agent-draft-cleared-by-owner-close");
  } finally {
    await close(draft);
    segmentMark("n12-agent-draft", "end");
  }
}

// N11 — the Agent's scope controls, and what the native host was actually
// handed. The suite proves an `exact` assignment and the untouched default,
// whose wire form is `{mode: "subtree", root: workspaceRoot}` — the default,
// not a selection. Nothing had ever selected "One subfolder", typed a
// relative path, or typed an exclusion.
//
// This segment reaches an Agent-ready state through the Settings "Native
// hosts" row rather than Setup's verify step, deliberately: extending the
// existing agent journey would change an assertion it already owns
// (`productAgentInputFiles.length === 2`), and taking Setup's verify step
// would push the five lineage cases that journey already proves. Nothing
// here re-proves lineage; it asserts only what the scope controls deliver.
n11AgentScopeSegment: {
  if (
    !positiveProductAgentQualification ||
    !segmentSelected("n11-agent-scope")
  ) {
    break n11AgentScopeSegment;
  }
  segmentMark("n11-agent-scope", "start");
  const agentScope = await launch([], "hidden", "ordinary");
  try {
    // The instrument this case asked for. `renderTaskMenu()` rebuilds on
    // task and runtime events, so when a typed value disappears the only
    // thing worth knowing is which event moved the menu. These listeners
    // are additive observation — the product's own listeners still run and
    // nothing is replaced — and they record only an event's name and time,
    // never its content.
    await agentScope.window.evaluate(() => {
      const observed = [];
      globalThis.__farolE2EMenuEvents = observed;
      const record = (name) => (value) => {
        // `publishShellAction` sends `{ action }`; the sender's name is the
        // whole point of this trace, so it is kept. No other payload is.
        const action =
          name === "shellAction" &&
          value !== null &&
          typeof value === "object" &&
          "action" in value
            ? String(value.action)
            : undefined;
        observed.push({ name, at: Date.now(), ...(action ? { action } : {}) });
        if (observed.length > 64) observed.shift();
      };
      window.farolNext.onRuntimeState(record("runtimeState"));
      window.farolNext.onTaskSurfaceState(record("taskSurfaceState"));
      window.farolNext.onTasksState(record("tasksState"));
      window.farolNext.onRuntimeEvent(record("runtimeEvent"));
      window.farolNext.onLayout(record("layout"));
      window.farolNext.onWindowState(record("windowState"));
      window.farolNext.onShellAction(record("shellAction"));
    });
    // A real subfolder with its own file, and an excludable sibling, so the
    // narrowing below is a claim about real paths rather than strings.
    const subfolder = path.join(agentScope.workspaceRoot, "notes");
    await fs.mkdir(subfolder, { mode: 0o700 });
    await fs.writeFile(
      path.join(subfolder, "keep.md"),
      "Farol Next agent subfolder fixture\n",
      { mode: 0o600 },
    );
    // A second file in the same subfolder, so excluding one does not empty
    // the scope and turn this into a test of the empty case instead.
    await fs.writeFile(
      path.join(subfolder, "scope.md"),
      "Farol Next agent exclusion fixture\n",
      { mode: 0o600 },
    );

    await completeSetup(agentScope, false, true, true, false);
    await agentScope.window.locator('[data-section="computer"]').click();
    await agentScope.window.waitForFunction(
      () => document.documentElement.dataset.section === "computer",
    );
    const hostRow = agentScope.window
      .locator("#connection-readiness .connection-row")
      .filter({ hasText: "Native hosts · " });
    // A wait that times out names what Connections actually said and which
    // controls the host row was offering, so the next run is a fix rather
    // than a guess.
    const hostRowState = () =>
      agentScope.window.evaluate(() => {
        const rows = [
          ...document.querySelectorAll("#connection-readiness .connection-row"),
        ].map((row) => ({
          title: row.querySelector("strong")?.textContent ?? null,
          buttons: [...row.querySelectorAll("button")].map((button) => ({
            label: button.textContent,
            disabled: button.disabled,
          })),
        }));
        return {
          section: document.documentElement.dataset.section ?? null,
          feedback: document.querySelector("#computer-feedback")?.textContent,
          rows,
        };
      });
    const settingsFeedback = async (pattern) => {
      try {
        await agentScope.window.waitForFunction(
          (source) =>
            new RegExp(source, "u").test(
              document.querySelector("#computer-feedback")?.textContent ?? "",
            ),
          pattern.source,
        );
      } catch (error) {
        throw new Error(
          `${error.message} · expected ${pattern.source} · ${JSON.stringify(await hostRowState().catch(() => null))}`,
          { cause: error },
        );
      }
    };
    const clickHostButton = async (label) => {
      const before = await hostRowState();
      const row = before.rows.find((candidate) =>
        candidate.title?.startsWith("Native hosts"),
      );
      assert.ok(
        row?.buttons.some((button) => button.label === label),
        `the Native hosts row must offer ${label} · ${JSON.stringify(before)}`,
      );
      await hostRow
        .getByRole("button", { name: label, exact: true })
        .click({ timeout: 20_000 });
    };
    await agentScope.window.waitForFunction(() =>
      [...document.querySelectorAll("#connection-readiness button")].some(
        (button) => button.textContent === "Re-detect host",
      ),
    );
    const selectedHost = await agentScope.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    await assertSameFixtureExecutable(
      selectedHost.configuration.settings.nativeHosts.codex.executablePath,
      agentScope.codexFixture,
    );
    const selectedHostRow = (await hostRowState()).rows.find((candidate) =>
      candidate.title?.startsWith("Native hosts"),
    );
    const liveAction = selectedHostRow?.buttons.find((button) =>
      ["Run Agent prerequisite", "Run live check"].includes(button.label),
    );
    assert.ok(liveAction, JSON.stringify(await hostRowState()));
    await clickHostButton(liveAction.label);
    // The live check reports the turn it ran, not the command's name.
    await settingsFeedback(
      /^gpt-6-astra host turn completed with 1 correlated Farol Next tool call/u,
    );
    await clickHostButton("Verify Agent");
    await agentScope.window.waitForFunction(() => {
      const button = [
        ...document.querySelectorAll("#connection-readiness button"),
      ].find((candidate) => candidate.textContent === "Agent verified");
      return button instanceof HTMLButtonElement;
    });

    // New task lives on the browser section; Settings does not show it.
    await agentScope.window
      .locator('.nav-item[data-section="browser"]')
      .click({ timeout: 20_000 });
    await agentScope.window.waitForFunction(
      () => document.documentElement.dataset.section === "browser",
    );
    // One task per assignment. A refused scope can leave the Agent on that
    // task outcome-unknown, and this product will not submit another
    // assignment for a task whose outcome it does not know — correctly. So
    // the second journey gets its own task rather than inheriting whatever
    // the first left behind.
    const newScopeTask = async (expected) => {
      await agentScope.window.locator("#new-task").click({ timeout: 20_000 });
      await agentScope.window.waitForFunction(
        (count) =>
          document.querySelectorAll("#task-tabs .task-tab").length === count,
        expected,
      );
      const state = await agentScope.window.evaluate(() =>
        window.farolNext.bootstrap(),
      );
      return state.tasks.at(-1).taskId;
    };
    let scopeTaskId = await newScopeTask(1);
    // Whether the reopen believed it worked is half the question when the
    // menu is later found closed, so it is remembered rather than inferred.
    let lastMenuOpen = null;
    const openScopeMenu = async () => {
      lastMenuOpen = { at: new Date().toISOString(), opened: false };
      await agentScope.window
        .locator("#task-menu-button")
        .click({ timeout: 20_000 });
      await agentScope.window
        .locator("#task-menu")
        .waitFor({ state: "visible", timeout: 20_000 });
      lastMenuOpen = { at: new Date().toISOString(), opened: true };
    };
    // The Run Agent button is disabled until the menu has re-rendered with
    // a valid objective and scope; its title names whichever prerequisite
    // is still missing, so a wait that fails says which one.
    const runAgentWhenReady = async () => {
      try {
        await agentScope.window.waitForFunction(() => {
          const button = document.querySelector("#task-menu-agent");
          return button instanceof HTMLButtonElement && !button.disabled;
        });
      } catch (error) {
        const shown = await agentScope.window
          .evaluate(() => ({
            title: document
              .querySelector("#task-menu-agent")
              ?.getAttribute("title"),
            note: document.querySelector("#task-menu-note")?.textContent,
            scope: document.querySelector("#task-agent-scope")?.value,
            subtree: document.querySelector("#task-agent-subtree")?.value,
            exclusions: document.querySelector("#task-agent-exclusions")?.value,
            objective: document.querySelector("#task-agent-objective")?.value,
          }))
          .catch(() => null);
        throw new Error(
          `${error.message} · Run Agent stayed disabled · ${JSON.stringify(shown)}`,
          { cause: error },
        );
      }
      await agentScope.window
        .locator("#task-menu-agent")
        .click({ timeout: 20_000 });
      // The menu refuses a submission while a previous task operation is
      // still finishing, and says so. That is a correct answer, not an
      // admission, so it is surfaced here as a retryable attempt rather
      // than left to look like a lost admission thirty seconds later.
      await agentScope.window.waitForFunction(() => {
        const note =
          document.querySelector("#task-menu-note")?.textContent ?? "";
        return (
          note.length > 0 &&
          note !== "Another task operation is still finishing."
        );
      });
    };
    // The menu closes on a refusal, and the relative-root field is hidden
    // until the menu has re-rendered for the chosen mode. Reopen what is
    // closed and wait for the control the owner would type into, rather
    // than racing either.
    const selectSubtreeScope = async () => {
      if (!(await agentScope.window.locator("#task-menu").isVisible())) {
        await openScopeMenu();
      }
      await agentScope.window
        .locator("#task-agent-scope")
        .selectOption("subtree");
      await agentScope.window.waitForFunction(() => {
        const field = document.querySelector("#task-agent-subtree");
        const exclusions = document.querySelector("#task-agent-exclusions");
        return (
          document.querySelector("#task-agent-scope")?.value === "subtree" &&
          field instanceof HTMLElement &&
          field.offsetParent !== null &&
          exclusions instanceof HTMLElement &&
          exclusions.offsetParent !== null
        );
      });
    };
    // `renderTaskMenu()` rebuilds its controls on every task and runtime
    // event, so a value typed into one field can be gone by the time the
    // next is typed — the surface this suite already tracks as an open
    // intermittent. Stage all three values, re-read them, and only then
    // press Run Agent; a rebuild that lost one is retried rather than
    // asserted around. This retries the INTERACTION only: every assertion
    // about what was delivered stays exactly as strict.
    //
    // OPEN QUESTION, deliberately not answered here. Some of the rebuilds
    // measured while writing this case were caused by the test's own
    // preceding action — a refused assignment closes the menu, which may
    // well be by design — but not all of them: on two runs a control went
    // invisible with nothing but a `fill` before it. Whether that second
    // kind is an unsolicited runtime event arriving under a typing owner
    // was NOT measured, because these dumps record the menu only on the
    // path that timed out, never the event that moved it. Settling it needs
    // the renderer's event source recorded at each retry, and it matters:
    // a menu that rebuilds under a typing owner and drops their subfolder
    // path is an owner-visible defect, not a harness problem. Until that
    // instrument exists this retry is an accommodation of a surface whose
    // behaviour is only partly explained, and it should not be read as
    // evidence that the surface is sound.
    const menuObservation = () =>
      agentScope.window
        .evaluate(() => {
          const menu = document.querySelector("#task-menu");
          const field = document.querySelector("#task-agent-subtree");
          const events = globalThis.__farolE2EMenuEvents ?? [];
          return {
            menuVisible:
              menu instanceof HTMLElement && menu.offsetParent !== null,
            subtreeVisible:
              field instanceof HTMLElement && field.offsetParent !== null,
            scope: document.querySelector("#task-agent-scope")?.value ?? null,
            lastEvents: events.slice(-6),
          };
        })
        .catch(() => null);
    const submitAgentAssignment = async (staged, options = {}) => {
      const owningCase = options.owningCase ?? null;
      // A close that follows this case's own action — a refused assignment
      // closing the menu, which may well be by design — is expected, and
      // reopening after it is a fair thing for an owner to do. A close with
      // no action of this case since the last fill is not: it discards a
      // scope the owner has just typed, and re-filling it would hide
      // exactly the defect worth reporting. Only the first kind is retried
      // silently; the second is recorded against the run before the case
      // goes on to prove the wire shape.
      const closeExpectedOnFirstAttempt =
        options.closeExpectedOnFirstAttempt === true;
      let lastFailure = null;
      const attemptLog = [];
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          await selectSubtreeScope();
          await agentScope.window
            .locator("#task-agent-subtree")
            .fill(staged.subtree, { timeout: 10_000 });
          await agentScope.window
            .locator("#task-agent-exclusions")
            .fill(staged.exclusions, { timeout: 10_000 });
          await agentScope.window
            .locator("#task-agent-objective")
            .fill(staged.objective, { timeout: 10_000 });
          const observed = await agentScope.window.evaluate(() => ({
            scope: document.querySelector("#task-agent-scope")?.value,
            subtree: document.querySelector("#task-agent-subtree")?.value,
            exclusions: document.querySelector("#task-agent-exclusions")?.value,
            objective: document.querySelector("#task-agent-objective")?.value,
          }));
          assert.deepEqual(
            observed,
            { scope: "subtree", ...staged },
            "the task menu kept the owner's typed scope up to the click",
          );
          await runAgentWhenReady();
          process.stdout.write(
            `E2E_TASK_MENU attempts=${attempt} ${JSON.stringify(attemptLog)}\n`,
          );
          return;
        } catch (error) {
          lastFailure = error;
          // A click that timed out waiting for a control is not proof that
          // nothing was dispatched. Re-typing over an assignment that did
          // land would submit it twice, which is the one thing this product
          // refuses to do and the last thing a test should force. Ask the
          // product whether this task already carries an assignment, and if
          // it does, stop: the submission happened.
          const alreadySubmitted = await agentScope.window
            .evaluate(async (taskId) => {
              const value = await window.farolNext.bootstrap();
              const task = value.tasks.find(
                (candidate) => candidate.taskId === taskId,
              );
              return task?.agent != null;
            }, scopeTaskId)
            .catch(() => false);
          if (alreadySubmitted) {
            process.stdout.write(
              `E2E_TASK_MENU attempts=${attempt} already-submitted\n`,
            );
            return;
          }
          const observed = await menuObservation();
          const expected = attempt === 1 && closeExpectedOnFirstAttempt;
          attemptLog.push({
            attempt,
            expected,
            reason: error.message.slice(0, 160),
            observed,
          });
          if (!expected) {
            const shellActions = (observed?.lastEvents ?? [])
              .filter((event) => event.name === "shellAction")
              .map((event) => event.action ?? "unrecorded");
            harnessObservations.push({
              kind: "task-menu-closed-without-own-action",
              severity: "informational",
              observedAt: new Date().toISOString(),
              owningCase,
              lastMenuOpen,
              attempt,
              menuVisible: observed?.menuVisible ?? null,
              subtreeVisible: observed?.subtreeVisible ?? null,
              scopeMode: observed?.scope ?? null,
              lostValues: staged,
              shellActions,
              events: observed?.lastEvents ?? [],
              message: error.message.split("\n", 1)[0].slice(0, 200),
            });
          }
        }
      }
      throw new Error(
        `E2E_TASK_MENU_REBUILD_LOST_INPUT after 4 attempts · ${JSON.stringify(attemptLog)}`,
        { cause: lastFailure },
      );
    };
    const agentInputRoot = path.join(
      agentScope.userData,
      "farol-next-state",
      "product-agent-inputs",
    );
    const deliveredAgentInput = async () => {
      const entries = (await fs.readdir(agentInputRoot)).filter((entry) =>
        entry.endsWith(".json"),
      );
      assert.equal(
        entries.length,
        1,
        "one assignment was delivered, so one envelope exists",
      );
      return JSON.parse(
        await fs.readFile(path.join(agentInputRoot, entries[0]), "utf8"),
      );
    };

    // `.git` is a denied path, so naming it as the subfolder must be
    // refused before anything is delivered. This runs first: a refusal that
    // wrote an envelope would be invisible after a successful assignment.
    await openScopeMenu();
    // The menu was opened by this case a moment ago and nothing of its own
    // has run since, so any close here is unsolicited.
    await submitAgentAssignment(
      {
        subtree: ".git",
        exclusions: "",
        objective:
          "Read the excluded repository metadata, which must be refused.",
      },
      {
        closeExpectedOnFirstAttempt: false,
        owningCase: "n11-agent-denied-subfolder-refused",
      },
    );
    await agentScope.window.waitForFunction(() => {
      const note = document.querySelector("#task-menu-note")?.textContent ?? "";
      return note.length > 0 && note !== "Agent assignment admitted.";
    });
    const refusedNote = await agentScope.window
      .locator("#task-menu-note")
      .innerText();
    assert.notEqual(
      refusedNote,
      "Agent assignment admitted.",
      "a denied subfolder is refused rather than admitted",
    );
    const envelopesAfterRefusal = await fs
      .readdir(agentInputRoot)
      .then(
        (entries) => entries.filter((entry) => entry.endsWith(".json")).length,
      )
      .catch(() => 0);
    assert.equal(
      envelopesAfterRefusal,
      0,
      `a refused assignment delivers no envelope · note ${JSON.stringify(refusedNote)}`,
    );
    cases.push("n11-agent-denied-subfolder-refused");

    // A fresh task, for the reason stated above. Opening its menu is left
    // to `selectSubtreeScope()` inside the retry: an unguarded click here
    // would be the one interaction in this journey with nothing to catch
    // it, which is exactly how the previous run died.
    // The task menu is an overlay and it covers New task. Close it the way
    // an owner would before reaching for the control behind it, rather than
    // clicking at something that is not actionable.
    await agentScope.window.keyboard.press("Escape");
    await agentScope.window
      .locator("#task-menu")
      .waitFor({ state: "hidden", timeout: 20_000 });
    scopeTaskId = await newScopeTask(2);

    // One subfolder, and one exclusion, both typed into their own controls.
    // This one follows the refusal above, which closes the menu, so a close
    // on its first attempt is this case's own doing and is reopened
    // quietly. Every later attempt is not.
    await submitAgentAssignment(
      {
        subtree: "notes",
        // Exclusions resolve against the workspace root, not the chosen
        // subfolder, so this is written the way the product reads it.
        exclusions: "notes/scope.md",
        objective:
          "Read the approved subfolder and report what its scope allows.",
      },
      {
        closeExpectedOnFirstAttempt: true,
        owningCase: "n11-agent-subfolder-narrows-delivered-root",
      },
    );
    // A refusal here is a real product answer, so the wait reports the
    // sentence the menu gave rather than a bare timeout.
    try {
      await agentScope.window.waitForFunction(
        () =>
          document.querySelector("#task-menu-note")?.textContent ===
          "Agent assignment admitted.",
      );
    } catch (error) {
      const shown = await agentScope.window
        .evaluate(() => ({
          note: document.querySelector("#task-menu-note")?.textContent,
          agentTitle: document
            .querySelector("#task-menu-agent")
            ?.getAttribute("title"),
          scope: document.querySelector("#task-agent-scope")?.value,
          subtree: document.querySelector("#task-agent-subtree")?.value,
          exclusions: document.querySelector("#task-agent-exclusions")?.value,
        }))
        .catch(() => null);
      throw new Error(
        `${error.message} · task menu showed ${JSON.stringify(shown)}`,
        { cause: error },
      );
    }
    const delivered = await deliveredAgentInput();
    assert.equal(delivered.schema, 2);
    assert.equal(delivered.kind, "product_agent_input");
    // The resolved scope carries an absolute root, never the relative text
    // the owner typed: there is no `relativeRoot` on the wire, and a root
    // equal to the workspace root would mean the narrowing did not happen.
    assert.deepEqual(delivered.input.scope, {
      mode: "subtree",
      root: subfolder,
    });
    assert.notEqual(
      delivered.input.scope.root,
      agentScope.workspaceRoot,
      "selecting one subfolder narrows the root the Agent is given",
    );
    cases.push("n11-agent-subfolder-narrows-delivered-root");

    // `excludedPaths` is a sibling of `scope`, not a member of it, and the
    // control splits on newlines only.
    assert.deepEqual(delivered.input.excludedPaths, [
      path.join(subfolder, "scope.md"),
    ]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        delivered.input.scope,
        "excludedPaths",
      ),
      false,
      "exclusions travel beside the scope, never inside it",
    );
    cases.push("n11-agent-exclusion-reaches-the-delivered-assignment");
  } finally {
    await close(agentScope);
    segmentMark("n11-agent-scope", "end");
  }
}

// N10 — the Computer panel's own controls. Every approved folder the suite
// has ever added arrived through Setup's `#setup-live-primary`, so the
// panel's own `Add folder…`, a workspace `Remove`, and the guarded edit's
// `Cancel` had no covering case at all. Each is a real click on the real
// control in the real panel: the folder picker is answered through the same
// `FAROL_NEXT_E2E_WORKSPACE_ROOT` seam `launch()` already uses for the first
// folder, and nothing else is substituted — the click, the
// `computer.add-workspace` / `computer.remove-workspace` /
// `computer.cancel-workspace-edit` handlers, their validation and the
// settings write are the production ones.
//
// The segment owns its own instance so a failure here cannot perturb the
// shared ones, and it runs hidden: every assertion below is DOM state, file
// bytes and the settings read-back, none of which needs a visible window.
n10ComputerPanelSegment: {
  if (!segmentSelected("n10-computer-panel")) break n10ComputerPanelSegment;
  segmentMark("n10-computer-panel", "start");
  const panel = await launch([], "hidden", "demo");
  try {
    // One approved, verified folder, added the only way the suite could add
    // one until now. Everything after this point is the panel's own work.
    await completeSetup(panel, false, true);
    await panel.window.locator('[data-section="settings"]').click();
    await panel.window.locator('[data-panel="settings"].active').waitFor();
    const workspaceList = panel.window.locator("#computer-workspaces");
    assert.equal(await workspaceList.locator(".workspace-card").count(), 1);

    // A second, genuinely different folder with its own content. Only the
    // picker's answer is seeded, in the running main process, exactly as the
    // launch environment seeds the first one.
    const secondRoot = await fs.realpath(
      await fs.mkdtemp(path.join(panel.isolatedHome, "second-workspace-")),
    );
    const secondLabel = path.basename(secondRoot);
    await fs.writeFile(
      path.join(secondRoot, "NOTES.md"),
      "Farol Next second workspace fixture\n",
      { mode: 0o600 },
    );
    await panel.application.evaluate(({ app }, root) => {
      process.env.FAROL_NEXT_E2E_WORKSPACE_ROOT = root;
      return app.isReady();
    }, secondRoot);

    await panel.window.locator("#add-workspace").click();
    await panel.window
      .locator("#settings-feedback")
      .getByText("Read-only workspace saved and read back.", { exact: true })
      .waitFor();
    await workspaceList
      .locator(".workspace-card")
      .filter({ hasText: secondLabel })
      .waitFor();
    assert.equal(await workspaceList.locator(".workspace-card").count(), 2);
    const twoWorkspaces = await panel.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.deepEqual(
      twoWorkspaces.configuration.settings.computer.workspaces
        .map((workspace) => workspace.root)
        .sort(),
      [panel.workspaceRoot, secondRoot].sort(),
      "the second folder is a distinct approved root, not a re-approval of the first",
    );
    assert.equal(
      twoWorkspaces.configuration.settings.computer.workspaces.every(
        (workspace) => workspace.access === "read",
      ),
      true,
      "a folder added from the panel is read-only until write authority is granted explicitly",
    );
    cases.push("n10-computer-second-workspace-added-from-panel");

    // Remove takes it out of the list and out of the settings the next
    // window would read back — not merely out of this render.
    const secondCard = workspaceList
      .locator(".workspace-card")
      .filter({ hasText: secondLabel });
    await secondCard
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await panel.window
      .locator("#settings-feedback")
      .getByText(`${secondLabel} approval removed.`, { exact: true })
      .waitFor();
    await panel.window.waitForFunction(
      (expected) =>
        document.querySelectorAll("#computer-workspaces .workspace-card")
          .length === expected,
      1,
    );
    const afterRemoval = await panel.window.evaluate(() =>
      window.farolNext.bootstrap(),
    );
    assert.deepEqual(
      afterRemoval.configuration.settings.computer.workspaces.map(
        (workspace) => workspace.root,
      ),
      [panel.workspaceRoot],
      "the removed root is gone from the settings read-back, not only from the list",
    );
    assert.equal(
      afterRemoval.configuration.settings.computer.generation >
        twoWorkspaces.configuration.settings.computer.generation,
      true,
      "removing an approved root advances the Computer generation",
    );
    cases.push("n10-computer-workspace-removed-from-panel-and-settings");

    // Cancel on a prepared guarded edit: the evidence panel closes, the
    // feedback says so, and the file on disk still has its original bytes.
    const firstCard = workspaceList
      .locator(".workspace-card")
      .filter({ hasText: "approved-workspace" });
    const beforeCancel = await fs.readFile(panel.workspaceFile, "utf8");
    await firstCard
      .getByRole("button", { name: "Enable edits", exact: true })
      .click();
    await firstCard.getByText(/guarded edits · not verified/u).waitFor();
    await firstCard
      .getByRole("button", { name: "Verify folder", exact: true })
      .click();
    await firstCard.getByText(/guarded edits · verified/u).waitFor();
    await firstCard
      .getByRole("button", { name: "Edit file…", exact: true })
      .click();
    const cancelReview = firstCard.locator(".workspace-mutation-evidence");
    await cancelReview.getByText(/README\.md · \d+ bytes · source/u).waitFor();
    await cancelReview
      .getByLabel("Find exact text in approved-workspace", { exact: true })
      .fill("workspace verification");
    await cancelReview
      .getByLabel("Replacement text for approved-workspace", { exact: true })
      .fill("a replacement that must never be written");
    await cancelReview
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await panel.window
      .locator("#settings-feedback")
      .getByText("Guarded edit cancelled.", { exact: true })
      .waitFor();
    await panel.window.waitForFunction(
      () =>
        document.querySelectorAll(".workspace-mutation-evidence").length === 0,
    );
    assert.equal(
      await fs.readFile(panel.workspaceFile, "utf8"),
      beforeCancel,
      "a cancelled guarded edit leaves the file byte-identical",
    );
    assert.equal(
      (await panel.window.evaluate(() => window.farolNext.bootstrap()))
        .configuration.settings.computer.pendingEdit,
      null,
      "a cancelled preview never becomes a durable pending operation",
    );
    cases.push("n10-computer-guarded-edit-cancelled-file-unchanged");

    // Recovery from a restored undelivered-result record.
    //
    // What this row exercises, named for what it is. The loss itself is NOT
    // here: it belongs to the row below, which drops a real reply through
    // the reply-fault seam. Here the record is the product's OWN — the one
    // main.ts writes before anything executes, precisely "so a lost response
    // or a restart leaves this exact operation to observe" — captured from
    // the product's own file and restored byte for byte after this window's
    // acknowledgement cleared it. That makes this the restart-recovery half
    // on its own: the real edit, its real durable receipt, the restart, the
    // pending notice, "Edit file…" refusing a second edit while the outcome
    // is unknown, `computer.observe-workspace-edit` redelivering the real
    // receipt, the record clearing exactly once, and the file never being
    // written a second time — all of it reached from a record on disk
    // rather than from a live window's state.
    await firstCard
      .getByRole("button", { name: "Edit file…", exact: true })
      .click();
    const lostReview = firstCard.locator(".workspace-mutation-evidence");
    await lostReview.getByText(/README\.md · \d+ bytes · source/u).waitFor();
    const settingsPath = path.join(
      panel.userData,
      "farol-next-state",
      "product-settings.json",
    );
    // Filling and submitting is ONE attempt, retried as a unit, for the same
    // reason the two rows below are: a card re-render can land between the
    // two fills, or between the button reporting itself enabled and the
    // click reaching it, and it empties the form. Measured on the packaged
    // app, sealed attempt 20260921T112424595Z-38ae0dff, where a single 30 s
    // click waited out a button the render had just disabled. Each attempt
    // has its own bounded click and the loop is allowed more time than the
    // one attempt it replaces: a narrower window, not a shorter wait.
    const lostApply = lostReview.getByRole("button", {
      name: "Apply guarded edit",
      exact: true,
    });
    let lostSubmitted = false;
    let lostSubmitError = null;
    for (let attempt = 0; attempt < 8 && !lostSubmitted; attempt += 1) {
      await lostReview
        .getByLabel("Find exact text in approved-workspace", { exact: true })
        .fill("workspace verification");
      await lostReview
        .getByLabel("Replacement text for approved-workspace", { exact: true })
        .fill("workspace lost-reply mutation");
      try {
        await lostApply.click({ timeout: 5_000 });
        lostSubmitted = true;
      } catch (error) {
        lostSubmitError = error;
      }
    }
    assert.equal(
      lostSubmitted,
      true,
      `the approval form kept both values long enough to submit them · ${lostSubmitError?.message ?? ""}`,
    );
    // The record exists before the edit runs and is cleared by this
    // window's acknowledgement afterwards. Watch the product's own file for
    // both transitions rather than composing a record: what is captured
    // here is exactly what a lost reply would have left behind.
    let productPendingEdit = null;
    let acknowledged = false;
    for (let attempt = 0; attempt < 120 && !acknowledged; attempt += 1) {
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      const pending = settings.computer.pendingEdit;
      if (pending !== null) productPendingEdit = pending;
      acknowledged = productPendingEdit !== null && pending === null;
      if (!acknowledged) await panel.window.waitForTimeout(50);
    }
    assert.ok(
      productPendingEdit,
      "the product records an undelivered result before the edit executes",
    );
    assert.equal(
      acknowledged,
      true,
      "a delivered result is acknowledged, which clears that record",
    );
    assert.equal(productPendingEdit.relativePath, "README.md");
    const editedBytes = await fs.readFile(panel.workspaceFile, "utf8");
    assert.equal(
      editedBytes,
      "Farol Next workspace lost-reply mutation fixture\n",
    );
    const editedStat = await fs.stat(panel.workspaceFile);

    // Restore exactly what the product wrote, and nothing else.
    const storedSettings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    storedSettings.computer.pendingEdit = productPendingEdit;
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify(storedSettings, null, 2)}\n`,
      { mode: 0o600 },
    );
    cases.push("n10-computer-lost-edit-record-is-the-products-own");

    await restart(panel);
    await panel.window.locator('[data-section="settings"]').click();
    await panel.window.locator('[data-panel="settings"].active').waitFor();
    const restartedCard = panel.window
      .locator("#computer-workspaces .workspace-card")
      .filter({ hasText: "approved-workspace" });
    const pendingNotice = restartedCard.locator(".workspace-pending-edit");
    await pendingNotice
      .getByText("The last guarded edit of README.md has no delivered result.")
      .waitFor();
    assert.equal(
      await restartedCard
        .getByRole("button", { name: "Edit file…", exact: true })
        .isDisabled(),
      true,
      "an unknown outcome refuses a second edit until it is known",
    );
    await pendingNotice
      .getByRole("button", { name: "Check result", exact: true })
      .click();
    // The observed outcome, not the optimistic sentence the click sent: the
    // real receipt, reported as redelivered rather than produced again.
    await panel.window
      .locator("#settings-feedback")
      .getByText("Edited README.md once · durable · result redelivered.", {
        exact: true,
      })
      .waitFor();
    await restartedCard
      .locator(".workspace-mutation-evidence")
      .getByText(/Edited README\.md · \d+ bytes/u)
      .waitFor();
    await panel.window.waitForFunction(
      () => document.querySelectorAll(".workspace-pending-edit").length === 0,
    );
    // The panel drops the notice when its reply arrives; the settings write
    // that clears the record is the product's own and lands on its own
    // clock. Waiting for the file is not a softer claim than reading it once
    // — the assertion below is still that the record is gone.
    let observed = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      observed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      if (observed.computer.pendingEdit === null) break;
      await panel.window.waitForTimeout(50);
    }
    assert.equal(
      observed.computer.pendingEdit,
      null,
      "an observed outcome clears the undelivered-result record exactly once",
    );
    const finalStat = await fs.stat(panel.workspaceFile);
    assert.equal(
      await fs.readFile(panel.workspaceFile, "utf8"),
      editedBytes,
      "redelivering an outcome reads the durable record, never repeating the edit",
    );
    assert.equal(
      finalStat.mtimeMs,
      editedStat.mtimeMs,
      "the file is not written a second time, by bytes and by modification time",
    );
    cases.push(
      "n10-computer-restored-pending-record-redelivered-after-restart",
    );
    // The same recovery, with the reply genuinely lost.
    //
    // The row above restores a record the product had already written and
    // cleared, so everything it proves happens AFTER a lost reply; the loss
    // itself was not exercised, because nothing in the product could lose
    // one. `configuration-reply-fault.ts` is that seam, and it is the only
    // thing this instance does differently: a budget of zero delivered
    // guarded-edit replies, armed at launch exactly as the live-task save
    // fault is. The production handler is untouched — it records the pending
    // operation, applies the edit, writes the receipt and releases its
    // admission — and the reply it returns is dropped on the way to the
    // renderer, so `ipcRenderer.invoke` never settles. Nothing here writes
    // `product-settings.json`: every pending-edit byte below is the
    // product's own.
    //
    // NOT exercised, stated rather than implied: a reply that IS delivered
    // and whose acknowledgement never reaches disk. Clearing the record is a
    // single settings write inside `clearPendingWorkspaceEdit`, and no
    // production path fails it on demand, so that variant would need a
    // second seam. The delivered control is the row above, and the segment's
    // earlier guarded edits.
    const droppedReply = await launch([], "hidden", "demo", {
      environment: { FAROL_NEXT_E2E_WORKSPACE_EDIT_REPLY_DELIVERIES: "0" },
    });
    try {
      // The marker the seam writes, read from the main process's own stderr.
      // An unavailable stream fails the case rather than reading as zero
      // drops: the whole proof that the reply was lost rather than merely
      // slow rests on this line arriving.
      const markers = [];
      const watchMainStderr = (instance) => {
        const stream = instance.application.process().stderr;
        assert.ok(stream, "E2E_MAIN_STDERR_UNAVAILABLE");
        let carry = "";
        stream.on("data", (chunk) => {
          carry += String(chunk);
          const lines = carry.split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) {
            if (line.includes("farol-next-e2e:reply-dropped")) {
              markers.push(line.trim());
            }
          }
        });
      };
      watchMainStderr(droppedReply);
      await completeSetup(droppedReply, false, true);
      await droppedReply.window.locator('[data-section="settings"]').click();
      await droppedReply.window
        .locator('[data-panel="settings"].active')
        .waitFor();
      const droppedCard = droppedReply.window
        .locator("#computer-workspaces .workspace-card")
        .filter({ hasText: "approved-workspace" });
      await droppedCard
        .getByRole("button", { name: "Enable edits", exact: true })
        .click();
      await droppedCard.getByText(/guarded edits · not verified/u).waitFor();
      await droppedCard
        .getByRole("button", { name: "Verify folder", exact: true })
        .click();
      await droppedCard.getByText(/guarded edits · verified/u).waitFor();

      const droppedSettingsPath = path.join(
        droppedReply.userData,
        "farol-next-state",
        "product-settings.json",
      );
      // The product's own operation records, at the root
      // `observeWorkspaceEdit` reads. Counting them before and after is what
      // separates "the edit ran once" from "the edit ran and something ran
      // it again".
      const mutationRecordRoot = path.join(
        droppedReply.userData,
        "farol-next-state",
        "workspace-mutations",
        "mutations",
      );
      const countMutationRecords = async () => {
        try {
          const entries = await fs.readdir(mutationRecordRoot);
          return entries.filter((entry) => entry.endsWith(".json")).length;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          return 0;
        }
      };
      const contentDigest = (text) =>
        createHash("sha256").update(text).digest("hex");
      const beforeBytes = await fs.readFile(droppedReply.workspaceFile, "utf8");
      const beforeRecords = await countMutationRecords();

      // Every settings write re-renders the card, and a render that lands
      // between the two fills replaces the approval form with an empty one
      // — measured on this instance, where verification is the most recent
      // write. Wait for the product's own revision to stop moving, then fill
      // until the form it is actually showing agrees both values are
      // complete. The scenario under test begins at the click.
      let settledRevision = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const revision = (
          await droppedReply.window.evaluate(() => window.farolNext.bootstrap())
        ).configuration.settings.revision;
        if (revision === settledRevision) break;
        settledRevision = revision;
        await droppedReply.window.waitForTimeout(100);
      }
      await droppedCard
        .getByRole("button", { name: "Edit file…", exact: true })
        .click();
      const droppedApproval = droppedCard.locator(
        ".workspace-mutation-evidence",
      );
      await droppedApproval
        .getByText(/README\.md · \d+ bytes · source/u)
        .waitFor();
      const applyGuardedEdit = droppedApproval.getByRole("button", {
        name: "Apply guarded edit",
        exact: true,
      });
      // Filling and submitting is ONE attempt, retried as a unit. A render
      // can land between the two fills, and — measured, attempt
      // 20260921T094622320Z-d0e030e4 — between the button reporting itself
      // enabled and the click reaching it, which left a 30 s click waiting
      // on a button the render had just emptied and disabled. Each attempt
      // here gets its own bounded click and the whole loop is allowed more
      // time than the single attempt it replaces, so this is a narrower
      // window, not a shorter wait. The scenario under test starts once the
      // click lands.
      let submitted = false;
      let lastSubmitError = null;
      for (let attempt = 0; attempt < 8 && !submitted; attempt += 1) {
        await droppedApproval
          .getByLabel("Find exact text in approved-workspace", { exact: true })
          .fill("workspace verification");
        await droppedApproval
          .getByLabel("Replacement text for approved-workspace", {
            exact: true,
          })
          .fill("workspace dropped-reply mutation");
        try {
          await applyGuardedEdit.click({ timeout: 5_000 });
          submitted = true;
        } catch (error) {
          lastSubmitError = error;
        }
      }
      assert.equal(
        submitted,
        true,
        `the approval form kept both values long enough to submit them · ${lastSubmitError?.message ?? ""}`,
      );

      // (1) The real edit at the real boundary: the product's own record
      // names the operation, the file carries the new bytes, and exactly one
      // operation record exists that did not before.
      const droppedBytes =
        "Farol Next workspace dropped-reply mutation fixture\n";
      assert.notEqual(droppedBytes, beforeBytes);
      let submittedEdit = null;
      for (let attempt = 0; attempt < 200 && submittedEdit === null;) {
        const settings = JSON.parse(
          await fs.readFile(droppedSettingsPath, "utf8"),
        );
        submittedEdit = settings.computer.pendingEdit;
        if (submittedEdit === null) {
          attempt += 1;
          await droppedReply.window.waitForTimeout(50);
        }
      }
      assert.ok(
        submittedEdit,
        "the product records the undelivered result before the edit executes",
      );
      assert.equal(submittedEdit.relativePath, "README.md");
      let editedOnDisk = null;
      for (let attempt = 0; attempt < 200 && editedOnDisk === null;) {
        const current = await fs.readFile(droppedReply.workspaceFile, "utf8");
        if (current === droppedBytes) editedOnDisk = current;
        else {
          attempt += 1;
          await droppedReply.window.waitForTimeout(50);
        }
      }
      assert.equal(
        editedOnDisk,
        droppedBytes,
        "the guarded edit really executed, whatever became of its reply",
      );
      const droppedStat = await fs.stat(droppedReply.workspaceFile);
      assert.equal(
        await countMutationRecords(),
        beforeRecords + 1,
        "the guarded edit left exactly one new operation record",
      );

      // (2) The reply was dropped, once, and for this operation.
      for (let attempt = 0; attempt < 200 && markers.length === 0;) {
        attempt += 1;
        await droppedReply.window.waitForTimeout(50);
      }
      assert.deepEqual(
        markers,
        [
          `farol-next-e2e:reply-dropped computer.apply-workspace-edit ${submittedEdit.operationId}`,
        ],
        "exactly one reply was dropped, and it was this operation's",
      );

      // (3) The record is the product's own, and it survives the loss: the
      // window received nothing, so nothing acknowledged it.
      await droppedReply.window.waitForTimeout(500);
      assert.equal(
        await droppedReply.window
          .locator("#settings-feedback")
          .getByText("Edited README.md once · durable.", { exact: true })
          .count(),
        0,
        "a dropped reply never reaches the window, so nothing reports success",
      );
      const survived = JSON.parse(
        await fs.readFile(droppedSettingsPath, "utf8"),
      );
      assert.deepEqual(
        survived.computer.pendingEdit,
        submittedEdit,
        "a lost reply leaves the product's own undelivered-result record intact",
      );
      assert.equal(
        survived.computer.pendingEdit.operationId,
        submittedEdit.operationId,
      );
      cases.push("n10-computer-dropped-reply-leaves-the-products-own-record");

      // (4) A restart on the same disposable profile finds the unknown
      // outcome and refuses a second edit until it is known.
      await restart(droppedReply);
      watchMainStderr(droppedReply);
      await droppedReply.window.locator('[data-section="settings"]').click();
      await droppedReply.window
        .locator('[data-panel="settings"].active')
        .waitFor();
      const recoveredCard = droppedReply.window
        .locator("#computer-workspaces .workspace-card")
        .filter({ hasText: "approved-workspace" });
      const recoveredNotice = recoveredCard.locator(".workspace-pending-edit");
      await recoveredNotice
        .getByText(
          "The last guarded edit of README.md has no delivered result.",
        )
        .waitFor();
      assert.equal(
        await recoveredCard
          .getByRole("button", { name: "Edit file…", exact: true })
          .isDisabled(),
        true,
        "an unknown outcome refuses a second edit until it is known",
      );

      // (5) Observation redelivers the SAME operation and the SAME receipt.
      // The command is the one the notice's own button sends, and reading the
      // durable record is idempotent, so asking directly first is what lets
      // this case name the operation and its digests rather than the byte
      // count the panel renders.
      const observed = await droppedReply.window.evaluate(
        (operationId) =>
          window.farolNext.configure({
            kind: "computer.observe-workspace-edit",
            operationId,
          }),
        submittedEdit.operationId,
      );
      assert.equal(observed.ok, true, JSON.stringify(observed));
      assert.equal(observed.evidence.kind, "computer.workspace-mutation");
      assert.equal(observed.evidence.operationId, submittedEdit.operationId);
      assert.equal(observed.evidence.relativePath, "README.md");
      assert.equal(observed.evidence.redelivered, true);
      assert.equal(observed.evidence.resultRetention, "durable");
      assert.equal(observed.evidence.beforeSha256, contentDigest(beforeBytes));
      assert.equal(observed.evidence.afterSha256, contentDigest(droppedBytes));

      // (6) The notice's own button reports the redelivery, and the record
      // clears exactly once — only after the outcome was observed.
      await recoveredNotice
        .getByRole("button", { name: "Check result", exact: true })
        .click();
      await droppedReply.window
        .locator("#settings-feedback")
        .getByText("Edited README.md once · durable · result redelivered.", {
          exact: true,
        })
        .waitFor();
      await recoveredCard
        .locator(".workspace-mutation-evidence")
        .getByText(/Edited README\.md · \d+ bytes/u)
        .waitFor();
      await droppedReply.window.waitForFunction(
        () => document.querySelectorAll(".workspace-pending-edit").length === 0,
      );
      // The panel drops the notice when its reply arrives; the settings
      // write that clears the record is the product's own and lands on its
      // own clock. Waiting for the file is not a softer claim than reading
      // it once — the assertion below is still that the record is gone.
      let acknowledged = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        acknowledged = JSON.parse(
          await fs.readFile(droppedSettingsPath, "utf8"),
        );
        if (acknowledged.computer.pendingEdit === null) break;
        await droppedReply.window.waitForTimeout(50);
      }
      assert.equal(
        acknowledged.computer.pendingEdit,
        null,
        "an observed outcome clears the undelivered-result record exactly once",
      );
      // Disk is not yet the service's answer. `product-configuration.ts`
      // commits by `save(candidate)` then `load()` then assigning the
      // read-back, so there is a real window in which the FILE already shows
      // `pendingEdit: null` while the in-memory snapshot still holds the
      // record. Measured: a packaged app is slow enough that an IPC observe
      // can land inside it, and the service then redelivers the known
      // receipt (ok, no second mutation) instead of refusing — which is
      // correct, and which the refusal below must not race. Disk-before-
      // memory is the designed read-back, not a lost or double clear, so
      // this waits for the service's own truth before asking it to refuse.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const snapshot = await droppedReply.window.evaluate(() =>
          window.farolNext.bootstrap(),
        );
        if (snapshot.configuration.settings.computer.pendingEdit === null) {
          break;
        }
        await droppedReply.window.waitForTimeout(50);
      }
      const afterAcknowledgement = await droppedReply.window.evaluate(
        (operationId) =>
          window.farolNext.configure({
            kind: "computer.observe-workspace-edit",
            operationId,
          }),
        submittedEdit.operationId,
      );
      assert.equal(afterAcknowledgement.ok, false);
      assert.equal(
        afterAcknowledgement.error,
        "WORKSPACE_MUTATION_NOT_PENDING",
        "a cleared record leaves nothing to redeliver a second time",
      );

      // (7) No second mutation, by bytes, by modification time, and by the
      // product's own operation records. Redelivering a known result is not
      // resubmitting an unknown effect.
      const finalStat = await fs.stat(droppedReply.workspaceFile);
      assert.equal(
        await fs.readFile(droppedReply.workspaceFile, "utf8"),
        droppedBytes,
      );
      assert.equal(finalStat.mtimeMs, droppedStat.mtimeMs);
      assert.equal(
        await countMutationRecords(),
        beforeRecords + 1,
        "recovery read the record it already had and wrote no new one",
      );
      // Redelivery and acknowledgement are ordinary replies: the seam counts
      // and drops apply replies only, so the restarted process dropped none.
      assert.deepEqual(markers, [
        `farol-next-e2e:reply-dropped computer.apply-workspace-edit ${submittedEdit.operationId}`,
      ]);
      cases.push("n10-computer-dropped-reply-recovered-after-restart");
    } finally {
      await close(droppedReply);
    }

    // The third shape of the same failure: the result ARRIVED, and the
    // acknowledgement did not.
    //
    // M1's row above loses the result itself. This one loses nothing on the
    // way in: the edit runs, its reply reaches this window, the evidence
    // card and the success sentence are rendered — and then the
    // acknowledgement the renderer queues for it never leaves. Only the
    // renderer can fail to send it, because the renderer is what sends it
    // (shell.ts `configureProduct` queues `acknowledgeWorkspaceEdit` as a
    // microtask beside the render, and nothing awaits it), so the seam is a
    // renderer-side hold gated on the one bootstrap field main publishes for
    // it. That field joins the FAROL_NEXT_E2E family under the P3 residual:
    // null in every production build, armed only by this lane, and carrying
    // no authority of its own.
    //
    // The control is the segment's own normal path: the rows above apply a
    // guarded edit whose reply IS delivered, whose acknowledgement IS sent,
    // and whose record is therefore cleared with no notice after a restart.
    const heldAck = await launch([], "hidden", "demo", {
      environment: { FAROL_NEXT_E2E_HOLD_WORKSPACE_EDIT_ACK: "0" },
    });
    try {
      const ackDiagnostics = [];
      const watchAckDiagnostics = (instance) => {
        instance.window.on("console", (message) => {
          const text = message.text();
          if (text.startsWith("farol-next-e2e:ack-held")) {
            ackDiagnostics.push(text.trim());
          }
        });
      };
      watchAckDiagnostics(heldAck);
      await completeSetup(heldAck, false, true);
      await heldAck.window.locator('[data-section="settings"]').click();
      await heldAck.window.locator('[data-panel="settings"].active').waitFor();
      const heldCard = heldAck.window
        .locator("#computer-workspaces .workspace-card")
        .filter({ hasText: "approved-workspace" });
      await heldCard
        .getByRole("button", { name: "Enable edits", exact: true })
        .click();
      await heldCard.getByText(/guarded edits · not verified/u).waitFor();
      await heldCard
        .getByRole("button", { name: "Verify folder", exact: true })
        .click();
      await heldCard.getByText(/guarded edits · verified/u).waitFor();

      const heldSettingsPath = path.join(
        heldAck.userData,
        "farol-next-state",
        "product-settings.json",
      );
      const heldRecordRoot = path.join(
        heldAck.userData,
        "farol-next-state",
        "workspace-mutations",
        "mutations",
      );
      const countHeldRecords = async () => {
        try {
          const entries = await fs.readdir(heldRecordRoot);
          return entries.filter((entry) => entry.endsWith(".json")).length;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          return 0;
        }
      };
      const heldDigest = (text) =>
        createHash("sha256").update(text).digest("hex");
      const heldBefore = await fs.readFile(heldAck.workspaceFile, "utf8");
      const heldRecordsBefore = await countHeldRecords();

      let heldRevision = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const revision = (
          await heldAck.window.evaluate(() => window.farolNext.bootstrap())
        ).configuration.settings.revision;
        if (revision === heldRevision) break;
        heldRevision = revision;
        await heldAck.window.waitForTimeout(100);
      }
      await heldCard
        .getByRole("button", { name: "Edit file…", exact: true })
        .click();
      const heldApproval = heldCard.locator(".workspace-mutation-evidence");
      await heldApproval
        .getByText(/README\.md · \d+ bytes · source/u)
        .waitFor();
      const heldApply = heldApproval.getByRole("button", {
        name: "Apply guarded edit",
        exact: true,
      });
      let heldSubmitted = false;
      let heldSubmitError = null;
      for (let attempt = 0; attempt < 8 && !heldSubmitted; attempt += 1) {
        await heldApproval
          .getByLabel("Find exact text in approved-workspace", { exact: true })
          .fill("workspace verification");
        await heldApproval
          .getByLabel("Replacement text for approved-workspace", {
            exact: true,
          })
          .fill("workspace held-ack mutation");
        try {
          await heldApply.click({ timeout: 5_000 });
          heldSubmitted = true;
        } catch (error) {
          heldSubmitError = error;
        }
      }
      assert.equal(
        heldSubmitted,
        true,
        `the approval form kept both values long enough to submit them · ${heldSubmitError?.message ?? ""}`,
      );

      // (1) The result reached this window and was rendered. This is the
      // whole difference from a lost reply: the owner saw the outcome.
      await heldAck.window
        .locator("#settings-feedback")
        .getByText("Edited README.md once · durable.", { exact: true })
        .waitFor();
      await heldCard
        .locator(".workspace-mutation-evidence")
        .getByText(/Edited README\.md · \d+ bytes/u)
        .waitFor();

      // (2) The edit really happened, once.
      const heldBytes = "Farol Next workspace held-ack mutation fixture\n";
      assert.notEqual(heldBytes, heldBefore);
      let heldOnDisk = null;
      for (let attempt = 0; attempt < 200 && heldOnDisk === null;) {
        const current = await fs.readFile(heldAck.workspaceFile, "utf8");
        if (current === heldBytes) heldOnDisk = current;
        else {
          attempt += 1;
          await heldAck.window.waitForTimeout(50);
        }
      }
      assert.equal(heldOnDisk, heldBytes, "the guarded edit executed");
      const heldStat = await fs.stat(heldAck.workspaceFile);
      assert.equal(
        await countHeldRecords(),
        heldRecordsBefore + 1,
        "the guarded edit left exactly one new operation record",
      );

      // (3) The acknowledgement was held, once, and the product's own
      // pending record is still there because nothing cleared it. Nothing
      // here writes product-settings.json.
      for (let attempt = 0; attempt < 200 && ackDiagnostics.length === 0;) {
        attempt += 1;
        await heldAck.window.waitForTimeout(50);
      }
      const heldSettings = JSON.parse(
        await fs.readFile(heldSettingsPath, "utf8"),
      );
      const heldEdit = heldSettings.computer.pendingEdit;
      assert.ok(
        heldEdit,
        "the undelivered-result record survives an acknowledgement that was never sent",
      );
      assert.equal(heldEdit.relativePath, "README.md");
      assert.deepEqual(
        ackDiagnostics,
        [`farol-next-e2e:ack-held ${heldEdit.operationId}`],
        "exactly one acknowledgement was held, and it was this operation's",
      );
      await heldAck.window.waitForTimeout(500);
      assert.deepEqual(
        JSON.parse(await fs.readFile(heldSettingsPath, "utf8")).computer
          .pendingEdit,
        heldEdit,
        "an unsent acknowledgement leaves the record exactly as the product wrote it",
      );
      cases.push("n10-computer-held-ack-leaves-the-products-own-record");

      // (4) The restart is an ordinary process: the loss happened once, and
      // recovery must not depend on the seam that caused it. Disarming the
      // hold here is what makes the rest of this row the production path.
      delete heldAck.launchEnvironment.FAROL_NEXT_E2E_HOLD_WORKSPACE_EDIT_ACK;
      await restart(heldAck);
      watchAckDiagnostics(heldAck);
      await heldAck.window.locator('[data-section="settings"]').click();
      await heldAck.window.locator('[data-panel="settings"].active').waitFor();
      const recoveredHeldCard = heldAck.window
        .locator("#computer-workspaces .workspace-card")
        .filter({ hasText: "approved-workspace" });
      const heldNotice = recoveredHeldCard.locator(".workspace-pending-edit");
      await heldNotice
        .getByText(
          "The last guarded edit of README.md has no delivered result.",
        )
        .waitFor();
      assert.equal(
        await recoveredHeldCard
          .getByRole("button", { name: "Edit file…", exact: true })
          .isDisabled(),
        true,
        "an unacknowledged outcome refuses a second edit until it is known",
      );

      // (5) The same operation and the same receipt, redelivered.
      const heldObserved = await heldAck.window.evaluate(
        (operationId) =>
          window.farolNext.configure({
            kind: "computer.observe-workspace-edit",
            operationId,
          }),
        heldEdit.operationId,
      );
      assert.equal(heldObserved.ok, true, JSON.stringify(heldObserved));
      assert.equal(heldObserved.evidence.operationId, heldEdit.operationId);
      assert.equal(heldObserved.evidence.redelivered, true);
      assert.equal(heldObserved.evidence.beforeSha256, heldDigest(heldBefore));
      assert.equal(heldObserved.evidence.afterSha256, heldDigest(heldBytes));

      // (6) The acknowledgement now lands, and clears the record once.
      await heldNotice
        .getByRole("button", { name: "Check result", exact: true })
        .click();
      await heldAck.window
        .locator("#settings-feedback")
        .getByText("Edited README.md once · durable · result redelivered.", {
          exact: true,
        })
        .waitFor();
      await heldAck.window.waitForFunction(
        () => document.querySelectorAll(".workspace-pending-edit").length === 0,
      );
      let heldCleared = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        heldCleared = JSON.parse(await fs.readFile(heldSettingsPath, "utf8"));
        if (heldCleared.computer.pendingEdit === null) break;
        await heldAck.window.waitForTimeout(50);
      }
      assert.equal(
        heldCleared.computer.pendingEdit,
        null,
        "the acknowledgement that finally landed clears the record exactly once",
      );
      // Disk is not yet the service's answer. `product-configuration.ts`
      // commits by `save(candidate)` then `load()` then assigning the
      // read-back, so there is a real window in which the FILE already shows
      // `pendingEdit: null` while the in-memory snapshot still holds the
      // record. Measured: a packaged app is slow enough that an IPC observe
      // can land inside it, and the service then redelivers the known
      // receipt (ok, no second mutation) instead of refusing — which is
      // correct, and which the refusal below must not race. Disk-before-
      // memory is the designed read-back, not a lost or double clear, so
      // this waits for the service's own truth before asking it to refuse.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const snapshot = await heldAck.window.evaluate(() =>
          window.farolNext.bootstrap(),
        );
        if (snapshot.configuration.settings.computer.pendingEdit === null) {
          break;
        }
        await heldAck.window.waitForTimeout(50);
      }
      const heldAgain = await heldAck.window.evaluate(
        (operationId) =>
          window.farolNext.configure({
            kind: "computer.observe-workspace-edit",
            operationId,
          }),
        heldEdit.operationId,
      );
      assert.equal(heldAgain.ok, false);
      assert.equal(heldAgain.error, "WORKSPACE_MUTATION_NOT_PENDING");

      // (7) No second mutation, and no second hold: the restarted process
      // ran the production path.
      const heldFinalStat = await fs.stat(heldAck.workspaceFile);
      assert.equal(await fs.readFile(heldAck.workspaceFile, "utf8"), heldBytes);
      assert.equal(heldFinalStat.mtimeMs, heldStat.mtimeMs);
      assert.equal(
        await countHeldRecords(),
        heldRecordsBefore + 1,
        "recovery read the record it already had and wrote no new one",
      );
      assert.deepEqual(ackDiagnostics, [
        `farol-next-e2e:ack-held ${heldEdit.operationId}`,
      ]);
      cases.push("n10-computer-held-ack-recovered-after-restart");
    } finally {
      await close(heldAck);
    }
  } finally {
    await close(panel);
    segmentMark("n10-computer-panel", "end");
  }
}
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
// A selected run reproduces part of the lane on purpose, so the lane's
// required cases are not its contract.  It is reported as SELECTED, never
// PASS, which is what keeps it out of every binding and out of any claim
// that the lane's required cases were satisfied.
const missingRequiredCases = selectionActive
  ? []
  : missingCases(
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
const blockingObservations = blockingObservationsOf(harnessObservations);
const productAgentQualification =
  laneContract(evidenceLane).productAgentQualification;
const report = {
  schema: 1,
  status: selectionActive
    ? "SELECTED"
    : missingRequiredCases.length > 0 || blockingObservations.length > 0
      ? "FAIL"
      : blockedCases.length > 0
        ? "BLOCKED"
        : "PASS",
  selection,
  productAgentQualification,
  harnessObservations,
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
      allowedPrimaryDisplay: allowPrimaryDisplay,
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
// A selected run only produces the captures of the segments it ran, so the
// completeness check belongs to a full lane.  A capture that does exist must
// still be non-empty in either case.
const expectedScreenshots = report.screenshots;
const capturedScreenshots = [];
for (const filename of expectedScreenshots) {
  const capture = await fs
    .stat(path.join(evidenceRoot, filename))
    .catch(() => null);
  if (capture === null) {
    assert.ok(selectionActive, `E2E_SCREENSHOT_MISSING:${filename}`);
    continue;
  }
  assert.ok(capture.size > 1_000, `E2E_SCREENSHOT_EMPTY:${filename}`);
  capturedScreenshots.push(filename);
}
// Partial selected runs report only files actually captured. Keep the full
// expectation visible separately so a missing screenshot cannot be mistaken
// for an observed one or used as full-lane evidence.
if (selectionActive) {
  report.expectedScreenshots = expectedScreenshots;
  report.screenshots = capturedScreenshots;
}
await fs.writeFile(
  path.join(evidenceRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
await evidenceAttempt.finish(report.status, {
  cases,
  productAgentQualification,
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
// The informational kinds are still said out loud, on their own line, so a
// reader of the log sees them without the exit code claiming a failure.
const informationalObservations = harnessObservations.filter(
  (entry) => entry.severity === "informational",
);
if (informationalObservations.length > 0) {
  process.stderr.write(
    `E2E_HARNESS_OBSERVED:${JSON.stringify(informationalObservations)}\n`,
  );
}
if (blockingObservations.length > 0) {
  process.stderr.write(
    `E2E_CLOSED_BEFORE_INSPECTION:${JSON.stringify(blockingObservations)}\n`,
  );
  process.exitCode = 1;
}
