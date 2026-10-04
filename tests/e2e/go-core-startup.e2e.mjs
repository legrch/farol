/**
 * SOURCE-ONLY preparation: this file never builds or packages an application.
 * Native execution is opt-in and belongs to the caller's exclusive native lane.
 *
 * node tests/e2e/go-core-startup.e2e.mjs --self-test
 * node tests/e2e/go-core-startup.e2e.mjs [--check|--run-native]
 *   --candidate-root /absolute/_output/build/app --source-sha <SHA>
 *   --build-id <buildId> [--dependency-root /absolute/node_modules] [--reopen] [--read-discard] [--read-account] [--edit-snapshot]
 * Or replace --candidate-root with:
 *   --packaged /absolute/Farol.app --artifact-metadata /absolute/artifact.json
 *   --artifact-sha <independently selected artifactSha256>
 *
 * Fresh-only by default. Packaged --reopen opts into one same-build successor
 * after confirmed clean retirement, at the same disposable E2E profile. No
 * Send, auth or app-under-test entry compilation. Never retry an unknown launch.
 * --read-discard requires packaged --reopen and selects a separate grant-bearing
 * read-preview -> explicit Discard -> Quit -> retained-settings reopen journey.
 * Read-discard alone verifies fixture readiness; model/account scope and Send
 * are excluded. The read-account extension is synthetic account evidence only.
 * --read-account additionally requires --read-discard and drives actual React
 * prepare/inspect/confirm/Discard controls against a synthetic account session.
 * Missing denied/revoked witnesses are reported, never counted as passes.
 * --edit-snapshot requires packaged --reopen --read-discard. Before the original
 * journey: normal write grant -> Verify -> Prepare metadata -> exact Cancel ->
 * restore read grant -> Verify. No Apply/observe/ACK. React has no edit controls;
 * this bounded witness uses existing preload configure, not UI acceptance.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  BUILD_ENTRIES,
  verifyBuildEntries,
  verifyInputManifest,
} from "../../tooling/build-contract.mjs";
import {
  GO_CORE_ENTRIES,
  verifyGoCoreArtifact,
} from "../../tooling/go-core-artifact.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import {
  TREE_DIGEST_VERSION,
  treeDigest,
} from "../../tooling/artifact-digest.mjs";
import {
  ELECTRON_RUNTIME,
  assertRuntimeObservation,
  observeElectronRuntime,
} from "../../tooling/runtime-contract.mjs";

import {
  readCanary,
  previewWitness,
  readJournalWitness,
  approvedSettingsWitness,
  readAccessWitness,
  legacyPreviewWitness,
  retainedApprovedSettings,
  readWitnessSelfTest,
  consumedReadHandoffWitness,
} from "./fixtures/go-read-discard-witness.mjs";
import {
  settingsExcludedCanaries,
  settingsAuthorityWitness,
  settingsListWitness,
  settingsWitnessSelfTest,
} from "./lib/computer-settings-witness.mjs";

import {
  readAccountLimits,
  accountLedgerWitness,
  readAccountUi,
  accountUiWitness,
  accountReplyWitness,
  accountUiAction,
  refreshAccountUi,
  readAccountSelfTest,
} from "./lib/read-account-ui-witness.mjs";
import {
  snapshotLimits,
  snapshotAuthorityWitness,
  settingsSnapshotWitness,
  snapshotUnchangedWitness,
  snapshotCancelWitness,
  snapshotWitnessSelfTest,
} from "./lib/settings-snapshot-witness.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex40 = /^[a-f0-9]{40}$/u;
const hex64 = /^[a-f0-9]{64}$/u;
const contract = Object.freeze({
  schema: "farol-go-core-startup-harness/1",
  applicationUnderTest:
    "Actual production-built src/apps/desktop/main.ts (main.cjs)",
  scenario:
    "Fresh unconfigured normal startup -> ready -> configuration rename with no grant -> Settings/Appearance -> Quit",
  backendWitness:
    "Production-created go-core/profile.json and computer/computer-access.json, read independently; unchanged zero authority through closure",
  providerWitness:
    "Existing controlled loopback fixture's independent attempted/accepted Send ledger must remain zero, including at child terminal",
  modes: ["--contract", "--self-test", "--check", "--run-native"],
  nativeAuthority:
    "Explicit --run-native; caller owns the exclusive native lane",
  reopen:
    "Packaged --reopen only: confirmed first Quit -> same sealed artifact/profile -> retained computerId/Graphite -> new journal backend generation -> second confirmed Quit; no retry after refused/unknown outcomes",
  readDiscard:
    "Explicit packaged --reopen --read-discard: normal configure add-workspace -> Verify -> check-folder -> list-workspace with independent Computer/Chat journal observations and exact canary listing, fixture chatgpt.verify readiness, Go read-preview metadata, duplicate prepare, exact Discard/cancel/ACK, duplicate discard without writes, known Quit, original handoff consumed by one same-profile/package successor; requires production handoff support for acknowledged never-reserved NOT_DISPATCHED history",
  readAccount:
    "Explicit packaged --reopen --read-discard --read-account: React verified folder/Choose file -> explicit Inspect current account -> ChatGPT/Home remount and same-revision Diagnostics refresh -> explicit Use this account -> known original duplicate account commands -> React exact Discard -> known Quit/reopen; exactly one inspect GET and one fresh confirmation GET, zero attempted/accepted Sends",
  readAccountLimits,
  editSnapshot:
    "Explicit packaged --reopen --read-discard --edit-snapshot: existing disposable UTF-8 canary, normal configuration write grant/Verify, preload Prepare, independently read raw bytes/count/SHA-256, retained root/profile/current generation and unchanged Chat/participants, exact Cancel, restore read grant/Verify, then original read-discard/account journey",
  editSnapshotLimits: snapshotLimits,
  readDiscardLimits: [
    "Settings replies do not instrument executor origin. Source-only self-tests and a package built from ff2d84d4d2fb85bfc2fe9696696c0a90ddb1162e can still exercise TypeScript listings; Go acceptance requires Lead's new integrated package and exact production-source mapping of all three Settings commands to the Go owner executor",
    "Settings approval revision/expiry may advance while generation and approval semantics stay fixed. Retained participant map and Chat journal prove no retained admission/ChatTurn change; no independent transient execution/admission counter exists",
    "Synthetic .ssh directory and .env file exercise built-in listing exclusions only; custom owner exclusions and direct denied reads are not exercised",
    "Root identity measurement, Git metadata discovery and configuration remain explicitly temporary TypeScript boundaries",
    "Preview exposes path/byte count/UTF-16 context character count, not text or body SHA; no body integrity hash claim",
    "Fixture page readiness is not production model/account-scope qualification, provider Send, or a live authenticated account",
    "Disposable private roots and hidden window observations are not hermetic containment of every native/OS path",
    "Denied/revoked read, result persistence, install and full migration acceptance remain unwitnessed",
  ],
  isolation:
    "Existing E2E root/proof/app-data guard; new HOME/AppData, private per-user TMPDIR, hidden windows and fixture tunnel client. Read-discard mode verifies a synthetic workspace and fixture readiness only; no real provider/account verification",
  missingWitnesses: [
    "Normal Go read bytes/hash and classified Go denial: prepare-readonly-task requires ChatGPT readiness and Computer verification; Settings executor origin requires exact integrated package production-source review",
    "Revoked old Go admission/no TS fallback: removing workspace is guarded before Go admission in normal preview; the normal configuration API does not expose the old admission or classified Go outcome",
    "No source-only claim of native execution, live provider/model, installed app, OS dialog/focus, or full migration acceptance",
  ],
});

function selection(args) {
  const result = {
    mode: "--check",
    reopen: false,
    readDiscard: false,
    readAccount: false,
    editSnapshot: false,
    dependencyRoot: path.join(root, "node_modules"),
  };
  const options = new Map([
    ["--candidate-root", "candidateRoot"],
    ["--packaged", "packaged"],
    ["--artifact-metadata", "artifactMetadata"],
    ["--artifact-sha", "artifactSHA"],
    ["--source-sha", "sourceSHA"],
    ["--build-id", "buildId"],
    ["--dependency-root", "dependencyRoot"],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--edit-snapshot") {
      assert.equal(seen.has("editSnapshot"), false, "EDIT_SNAPSHOT_REPEATED");
      seen.add("editSnapshot");
      result.editSnapshot = true;
      continue;
    }
    if (argument === "--read-account") {
      assert.equal(seen.has("readAccount"), false, "READ_ACCOUNT_REPEATED");
      seen.add("readAccount");
      result.readAccount = true;
      continue;
    }
    if (argument === "--read-discard") {
      assert.equal(seen.has("readDiscard"), false, "READ_DISCARD_REPEATED");
      seen.add("readDiscard");
      result.readDiscard = true;
      continue;
    }
    if (argument === "--reopen") {
      assert.equal(seen.has("reopen"), false, "REOPEN_REPEATED");
      seen.add("reopen");
      result.reopen = true;
      continue;
    }
    if (["--check", "--run-native"].includes(argument)) {
      assert.equal(seen.has("mode"), false, "MODE_REPEATED");
      seen.add("mode");
      result.mode = argument;
      continue;
    }
    const key = options.get(argument);
    assert.ok(key && !seen.has(key), "OPTION_UNKNOWN_OR_REPEATED");
    seen.add(key);
    const value = args[++index];
    assert.ok(value && !value.startsWith("--"), "OPTION_VALUE_MISSING");
    result[key] = value;
  }
  assert.ok(hex40.test(result.sourceSHA ?? ""), "SOURCE_PIN_REQUIRED");
  assert.ok(hex64.test(result.buildId ?? ""), "BUILD_PIN_REQUIRED");
  assert.equal(
    Boolean(result.candidateRoot) !== Boolean(result.packaged),
    true,
    "SELECT_ONE_ARTIFACT",
  );
  if (result.packaged) {
    assert.ok(
      result.artifactMetadata && hex64.test(result.artifactSHA ?? ""),
      "PACKAGE_PINS_REQUIRED",
    );
  } else {
    assert.equal(result.reopen, false, "REOPEN_REQUIRES_PACKAGE");
    assert.equal(result.artifactMetadata, undefined, "PACKAGE_OPTION_WITH_DEV");
    assert.equal(result.artifactSHA, undefined, "PACKAGE_OPTION_WITH_DEV");
  }
  if (result.readAccount) {
    assert.equal(
      Boolean(result.packaged),
      true,
      "READ_ACCOUNT_REQUIRES_PACKAGE",
    );
    assert.equal(result.reopen, true, "READ_ACCOUNT_REQUIRES_REOPEN");
    assert.equal(
      result.readDiscard,
      true,
      "READ_ACCOUNT_REQUIRES_READ_DISCARD",
    );
  }
  if (result.editSnapshot) {
    assert.equal(
      Boolean(result.packaged),
      true,
      "EDIT_SNAPSHOT_REQUIRES_PACKAGE",
    );
    assert.equal(result.reopen, true, "EDIT_SNAPSHOT_REQUIRES_REOPEN");
    assert.equal(
      result.readDiscard,
      true,
      "EDIT_SNAPSHOT_REQUIRES_READ_DISCARD",
    );
  }
  if (result.readDiscard) {
    assert.equal(
      Boolean(result.packaged),
      true,
      "READ_DISCARD_REQUIRES_PACKAGE",
    );
    assert.equal(result.reopen, true, "READ_DISCARD_REQUIRES_REOPEN");
  }
  for (const key of [
    "candidateRoot",
    "packaged",
    "artifactMetadata",
    "dependencyRoot",
  ]) {
    if (result[key] !== undefined)
      assert.ok(
        path.isAbsolute(result[key]) &&
          path.resolve(result[key]) === result[key],
        "ABSOLUTE_CANONICAL_PATH_REQUIRED",
      );
  }
  return result;
}

async function regular(file, maximum = 32 * 1024 * 1024) {
  const fd = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum),
      "WITNESS_NOT_BOUNDED_REGULAR",
    );
    const bytes = await fd.readFile();
    const after = await fd.stat({ bigint: true });
    for (const key of [
      "dev",
      "ino",
      "size",
      "mode",
      "mtimeNs",
      "ctimeNs",
      "nlink",
    ])
      assert.equal(after[key], before[key], "WITNESS_CHANGED_DURING_READ");
    assert.equal(BigInt(bytes.length), before.size);
    return bytes;
  } finally {
    await fd.close();
  }
}
async function document(file, maximum) {
  const bytes = await regular(file, maximum);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
}
function pins(identity, selected) {
  assert.equal(identity.sourceDirty, false, "DIRTY_ARTIFACT");
  assert.equal(
    identity.sourceCommit,
    selected.sourceSHA,
    "SOURCE_PIN_MISMATCH",
  );
  assert.equal(identity.buildId, selected.buildId, "BUILD_PIN_MISMATCH");
}
async function attest(selected) {
  const appRoot = selected.packaged
    ? path.join(selected.packaged, "Contents/Resources/app")
    : selected.candidateRoot;
  assert.equal(await fs.realpath(appRoot), appRoot, "ARTIFACT_REDIRECTED");
  const identity = assertBuildIdentity(
    (await document(path.join(appRoot, "build-identity.json"), 8192)).value,
  );
  pins(identity, selected);
  const manifest = await document(path.join(appRoot, "build-manifest.json"));
  const build = manifest.value;
  assert.equal(build.schema, 4, "COMPILED_GO_CORE_REQUIRED");
  assert.equal(build.dirty, false);
  assert.equal(build.inputExact, true);
  assert.equal(build.sourceMode, "head-exact");
  assert.equal(build.sourceCommit, identity.sourceCommit);
  assert.equal(build.sourceTreeDigest, identity.sourceTreeDigest);
  assert.equal(build.buildId, identity.buildId);
  assert.deepEqual(
    build.entries,
    [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
  );
  await verifyBuildEntries(appRoot, build.entrySha256, build.entries);
  const ledger = await verifyInputManifest(appRoot, build);
  assert.ok(
    ledger.some(
      (entry) =>
        entry.kind === "source" &&
        entry.path === "src/apps/desktop/main.ts" &&
        entry.exact === true,
    ),
    "NORMAL_MAIN_INPUT_MISSING",
  );
  await verifyGoCoreArtifact(appRoot, build.core, identity);
  // The independent manifest declaration is compiled into normal main. This
  // check is supporting evidence; the Go-created snapshot below proves use.
  const main = (await regular(path.join(appRoot, "main.cjs"))).toString("utf8");
  assert.ok(
    main.includes(build.core.binary.sha256),
    "COMPILED_CORE_DECLARATION_MISSING",
  );
  let artifact = null;
  if (selected.packaged) {
    assert.equal(await fs.realpath(selected.packaged), selected.packaged);
    artifact = await document(selected.artifactMetadata, 8192);
    assert.equal(artifact.value.schema, 7);
    assert.equal(artifact.value.treeDigestVersion, TREE_DIGEST_VERSION);
    pins(artifact.value, selected);
    assert.equal(artifact.value.sourceTreeDigest, identity.sourceTreeDigest);
    assert.equal(artifact.value.artifactPath, selected.packaged);
    assert.equal(artifact.value.artifactSha256, selected.artifactSHA);
    assert.equal(
      await treeDigest(selected.packaged),
      selected.artifactSHA,
      "PACKAGE_HASH_MISMATCH",
    );
    // This authenticates the selected sealed package, not a new package gate.
    // It does not spawn verify-package's native helper or signing probes.
  } else {
    const source = sourceIdentity(root);
    assert.equal(source.dirty, false, "DEV_SOURCE_NOT_EXACT");
    assert.equal(source.commit, selected.sourceSHA, "DEV_SOURCE_PIN_MISMATCH");
    assert.equal(source.treeDigest, identity.sourceTreeDigest);
  }
  // Keep the fixed manifest/startup checks intact. The new mode also records
  // exact packaged source inputs for Lead's production-composition audit; an
  // older package lacking an account/UI contract cannot qualify this journey.
  let readAccountInputs;
  if (selected.readAccount) {
    readAccountInputs = [
      "src/apps/desktop/main.ts",
      "src/apps/desktop/chatgpt-route.ts",
      "src/ui/renderer/chat-readonly.tsx",
      "src/ui/renderer/controller.ts",
      "apps/desktop/read-account-confirmation.ts",
      "apps/desktop/bridge/read-intent.ts",
    ].map((inputPath) => {
      const input = ledger.find(
        (entry) => entry.kind === "source" && entry.path === inputPath,
      );
      assert.ok(
        input?.exact === true,
        `READ_ACCOUNT_SOURCE_CONTRACT_MISSING:${inputPath}`,
      );
      return input;
    });
  }
  let editSnapshotInputs;
  if (selected.editSnapshot) {
    editSnapshotInputs = [
      "src/apps/desktop/main.ts",
      "src/apps/desktop/workspace-edit.ts",
      "apps/desktop/go-workspace-snapshot.ts",
      "apps/desktop/go-core-host.ts",
      "apps/desktop/go-computer-authority.ts",
      "src/modules/computer/infra/repo/owner-settings-computer-approval.ts",
    ].map((inputPath) => {
      const input = ledger.find(
        (entry) => entry.kind === "source" && entry.path === inputPath,
      );
      assert.ok(
        input?.exact === true,
        `EDIT_SNAPSHOT_SOURCE_CONTRACT_MISSING:${inputPath}`,
      );
      return input;
    });
  }
  return {
    ...(selected.readAccount ? { readAccountInputs } : {}),
    ...(selected.editSnapshot ? { editSnapshotInputs } : {}),
    appRoot,
    identity,
    core: build.core,
    manifestSHA: manifest.sha256,
    mainSHA: build.entrySha256["main.cjs"],
    inputLedgerSHA: build.inputLedgerSha256,
    artifactMetadataSHA: artifact?.sha256 ?? null,
    artifactSHA: selected.artifactSHA ?? null,
  };
}

function zeroAuthority(profile, access, computerId) {
  assert.deepEqual(Object.keys(profile).sort(), [
    "computerId",
    "profileId",
    "schema",
  ]);
  assert.equal(profile.schema, "farol-native-profile/1");
  assert.match(profile.profileId, /^[a-f0-9-]{36}$/u);
  assert.equal(profile.computerId, computerId);
  assert.deepEqual(Object.keys(access).sort(), [
    "approval",
    "computerId",
    "generation",
    "ownerId",
    "participants",
    "profileId",
    "revision",
    "schema",
    "seenApproval",
  ]);
  assert.equal(access.schema, 1);
  assert.equal(access.profileId, profile.profileId);
  assert.equal(access.ownerId, "owner-desktop");
  assert.equal(access.computerId, computerId);
  assert.equal(access.revision, "0", "UNEXPECTED_AUTHORITY_PUBLICATION");
  assert.equal(access.generation, "0");
  assert.equal(access.seenApproval, false);
  assert.equal(access.approval, null, "EMPTY_OR_NONEMPTY_APPROVAL_FORBIDDEN");
  assert.deepEqual(access.participants, {}, "FRESH_PROFILE_HAS_ADMISSION");
}
function zeroSends(ledger) {
  assert.equal(ledger.attemptedSends, 0, "STARTUP_ATTEMPTED_SEND");
  assert.equal(ledger.acceptedSends, 0, "STARTUP_ACCEPTED_SEND");
  assert.deepEqual(ledger.ledger, []);
  assert.deepEqual(ledger.turns, []);
}
function cleanLaunchClosure(cleanup) {
  assert.equal(cleanup.launchResolved, true, "LAUNCH_OUTCOME_UNKNOWN");
  assert.equal(cleanup.closeRequested, true, "CLOSE_NOT_REQUESTED");
  assert.equal(cleanup.exitObserved, true, "CHILD_TERMINAL_UNKNOWN");
  assert.equal(cleanup.exitCode, 0, "CHILD_EXIT_FAILED");
  assert.equal(cleanup.signal, null, "CHILD_SIGNAL_DEATH");
  assert.equal(cleanup.drained, true, "GO_OR_OTHER_CHILD_DRAIN_UNCONFIRMED");
  assert.equal(cleanup.runMarkerRemoved, true, "RUN_MARKER_RETAINED");
}
function cleanClosure(cleanup) {
  cleanLaunchClosure(cleanup);
  assert.equal(cleanup.siteClosed, true, "FIXTURE_CLOSE_UNKNOWN");
}

function retainedSettings(current, previous) {
  for (const key of ["computerId", "name", "generation"])
    assert.equal(
      current.computer[key],
      previous.computer[key],
      "REOPEN_COMPUTER_CHANGED",
    );
  assert.deepEqual(current.computer.workspaces, []);
  assert.equal(current.setup.computer.verified, null);
  assert.equal(current.setup.chatgpt.verified, null);
}

async function physicalDirectory(directory) {
  assert.equal(await fs.realpath(directory), directory, "GO_ROOT_REDIRECTED");
  const stat = await fs.lstat(directory, { bigint: true });
  assert.ok(stat.isDirectory(), "GO_ROOT_NOT_DIRECTORY");
  assert.equal(stat.mode & 0o777n, 0o700n, "GO_ROOT_NOT_PRIVATE");
  assert.equal(stat.uid, BigInt(process.getuid()), "GO_ROOT_NOT_OWNED");
  return {
    path: directory,
    Device: stat.dev.toString(),
    Inode: stat.ino.toString(),
    OwnerUID: stat.uid.toString(),
  };
}

function journalWitness(journal, profileId, physical, previous, retired) {
  assert.equal(journal.version, 2, "JOURNAL_VERSION_UNKNOWN");
  assert.equal(journal.scope?.ProfileID, profileId, "JOURNAL_PROFILE_CHANGED");
  const generation = journal.scope?.BackendGeneration;
  assert.ok(
    typeof generation === "string" && generation.length > 0,
    "BACKEND_GENERATION_UNKNOWN",
  );
  for (const key of ["Device", "Inode", "OwnerUID"]) {
    assert.ok(
      Number.isSafeInteger(journal.root?.[key]),
      "JOURNAL_ROOT_PRECISION_UNKNOWN",
    );
    assert.equal(
      String(journal.root[key]),
      physical[key],
      "JOURNAL_PHYSICAL_ROOT_CHANGED",
    );
  }
  assert.deepEqual(journal.writes, [], "UNEXPECTED_CHAT_JOURNAL_WRITES");
  assert.deepEqual(
    journal.incarnations,
    previous ? [...previous.incarnations, generation] : [generation],
    "BACKEND_HISTORY_CHANGED",
  );
  if (previous)
    assert.notEqual(
      generation,
      previous.scope.BackendGeneration,
      "BACKEND_GENERATION_REUSED",
    );
  if (retired) {
    assert.deepEqual(
      journal.retirement?.Scope,
      journal.scope,
      "RETIREMENT_SCOPE_UNKNOWN",
    );
    assert.deepEqual(
      journal.retirement?.Root,
      journal.root,
      "RETIREMENT_ROOT_UNKNOWN",
    );
    assert.equal(journal.retirement?.PreviousRevision, 0);
    assert.equal(journal.retirement?.Revision, 1);
    assert.deepEqual(journal.retirement?.Turns, [], "RETIREMENT_NOT_EMPTY");
  } else
    assert.equal(journal.retirement, null, "READY_JOURNAL_ALREADY_RETIRED");
}

function handoffWitness(record, scope, buildId, previous) {
  assert.equal(record.Version, 1, "HANDOFF_VERSION_UNKNOWN");
  assert.equal(record.Origin, "LIVE_OWNER_CALLBACK", "HANDOFF_ORIGIN_UNKNOWN");
  assert.equal(
    record.Stage,
    previous ? "SUCCESSOR_CONSUMED" : "CHILD_TERMINATED",
    "HANDOFF_STAGE_UNCONFIRMED",
  );
  const binding = record.Publication?.Binding;
  assert.equal(binding?.ProfileID, scope.ProfileID, "HANDOFF_PROFILE_CHANGED");
  assert.equal(binding?.BuildID, buildId, "HANDOFF_BUILD_CHANGED");
  assert.deepEqual(
    record.ACK?.Publication,
    record.Publication,
    "HANDOFF_ACK_UNKNOWN",
  );
  assert.deepEqual(
    record.Terminal?.Publication,
    record.Publication,
    "HANDOFF_TERMINAL_UNKNOWN",
  );
  assert.equal(record.Terminal?.Kind, "NORMAL_EXIT");
  assert.equal(record.Terminal?.StopMode, "GRACEFUL_STOP");
  assert.equal(record.Terminal?.ExitCode, 0);
  assert.equal(record.Terminal?.Signal, "");
  if (previous) {
    assert.deepEqual(
      record.Publication,
      previous.Publication,
      "HANDOFF_PREDECESSOR_CHANGED",
    );
    assert.equal(
      record.Consumption?.PreviousHostDrainConfirmed,
      true,
      "HANDOFF_HOST_DRAIN_UNKNOWN",
    );
    assert.deepEqual(
      record.Consumption?.Next,
      scope,
      "HANDOFF_SUCCESSOR_CHANGED",
    );
    const next = record.Consumption?.NextBinding;
    assert.equal(next?.BackendGeneration, scope.BackendGeneration);
    for (const key of ["ProfileID", "BuildID", "ParentRoot", "ChatRoot"])
      assert.deepEqual(
        next?.[key],
        binding[key],
        "HANDOFF_SUCCESSOR_BINDING_CHANGED",
      );
    for (const key of ["HostLifetimeID", "ChildLaunchID"]) {
      assert.ok(
        typeof next?.[key] === "string" && next[key].length > 0,
        "HANDOFF_LIFETIME_UNKNOWN",
      );
      assert.notEqual(next[key], binding[key], "HANDOFF_LIFETIME_REUSED");
    }
  } else {
    assert.equal(
      binding.BackendGeneration,
      scope.BackendGeneration,
      "HANDOFF_BACKEND_CHANGED",
    );
    assert.equal(record.Consumption, null, "TERMINAL_HANDOFF_ALREADY_CONSUMED");
  }
}

function permitReopen(launch) {
  assert.equal(
    launch.status,
    "confirmed-clean-quit",
    "FIRST_JOURNEY_NOT_CONFIRMED",
  );
  cleanLaunchClosure(launch.cleanup);
  assert.ok(
    launch.quitReceipt && launch.retiredJournal && launch.terminalHandoff,
    "FIRST_TERMINAL_EVIDENCE_MISSING",
  );
  zeroSends(launch.terminalLedger);
}

function quitWitness(quit, marker, previous) {
  assert.equal(quit.schema, 1);
  assert.equal(quit.drained, true);
  assert.deepEqual(quit.unconfirmed, []);
  assert.ok(Number.isFinite(Date.parse(quit.at)), "QUIT_TIMESTAMP_UNKNOWN");
  assert.equal(
    new Date(quit.at).toISOString(),
    quit.at,
    "QUIT_TIMESTAMP_NOT_CANONICAL",
  );
  assert.ok(
    Date.parse(quit.at) >= Date.parse(marker.startedAt),
    "STALE_QUIT_RECEIPT",
  );
  if (previous)
    assert.ok(
      Date.parse(quit.at) > Date.parse(previous.at),
      "REOPEN_QUIT_RECEIPT_NOT_NEW",
    );
}
async function bounded(promise, ms, code) {
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
async function ready(window, active) {
  await window
    .locator(".desktop")
    .waitFor({ state: "visible", timeout: 15000 });
  for (let attempt = 0; attempt < 100; attempt++) {
    active();
    const value = await bounded(
      window.evaluate(() => window.farolNext.bootstrap()),
      3000,
      "BOOTSTRAP_READ_UNKNOWN",
    );
    if (
      value.runtimeState === "ready" &&
      value.configuration.status === "ready"
    )
      return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("NORMAL_GO_STARTUP_NOT_READY");
}
function unconfigured(bootstrap) {
  assert.equal(bootstrap.runtimeState, "ready");
  assert.equal(bootstrap.configuration.status, "ready");
  const settings = bootstrap.configuration.settings;
  assert.deepEqual(settings.computer.workspaces, []);
  assert.equal(settings.setup.computer.verified, null);
  assert.equal(settings.setup.chatgpt.verified, null);
  return settings;
}

async function native(selected, inputs, report, save) {
  assert.equal(process.platform, "darwin", "DARWIN_NATIVE_LANE_REQUIRED");
  // Explicit dependency location uses installed bytes; never install or link.
  assert.equal(
    await fs.realpath(selected.dependencyRoot),
    selected.dependencyRoot,
  );
  const playwrightDirectory = path.join(
    selected.dependencyRoot,
    "playwright-core",
  );
  const playwright = await document(
    path.join(playwrightDirectory, "package.json"),
  );
  assert.equal(
    playwright.value.version,
    "1.63.0",
    "PLAYWRIGHT_VERSION_MISMATCH",
  );
  const require = createRequire(import.meta.url);
  const { _electron: electron } = require(playwrightDirectory);
  const executable = selected.packaged
    ? path.join(selected.packaged, "Contents/MacOS/Farol Next Preview")
    : path.join(
        selected.dependencyRoot,
        "electron/dist/Electron.app/Contents/MacOS/Electron",
      );
  if (!selected.packaged)
    assertRuntimeObservation(
      await observeElectronRuntime(
        path.join(selected.dependencyRoot, "electron"),
      ),
      ELECTRON_RUNTIME,
    );
  // Reuse an existing guard-owned root name; new prefixes require a production
  // isolation change and are deliberately outside this harness's scope.
  const temp = await fs.realpath(os.tmpdir());
  assert.match(
    temp,
    /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u,
    "PRIVATE_MACOS_TEMP_REQUIRED_NO_FALLBACK",
  );
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(temp, "farol-dev-onboarding-startup-")),
  );
  await fs.chmod(temporary, 0o700);
  report.temporary = temporary;
  report.cleanup = {
    launchAttempted: false,
    launchResolved: false,
    closeRequested: false,
    siteClosed: false,
    temporaryRemoved: false,
  };
  const home = path.join(temporary, "home");
  const appData = path.join(temporary, "app-data");
  // Match the existing Dev harness: keep native socket roots in the private
  // per-user macOS temp directory. A nested TMPDIR exceeds AF_UNIX limits;
  // /private/tmp is refused by Go's writable-ancestor policy.
  for (const directory of [home, appData])
    await fs.mkdir(directory, { mode: 0o700 });
  let workspaceRoot, workspacePhysical;
  if (selected.readDiscard) {
    workspaceRoot = path.join(temporary, "read-workspace");
    await fs.mkdir(workspaceRoot, { mode: 0o700 });
    workspacePhysical = await physicalDirectory(workspaceRoot);
    await fs.writeFile(
      path.join(workspaceRoot, readCanary.relativePath),
      readCanary.text,
      { mode: 0o600, flag: "wx" },
    );
    // Synthetic names only, inside this scenario's already guarded disposable
    // workspace. Built-in exclusions preserve the existing empty owner
    // exclusion list and the unchanged read-preview selection/journey.
    await fs.mkdir(
      path.join(workspaceRoot, settingsExcludedCanaries.directory),
      { mode: 0o700 },
    );
    for (const relative of [
      settingsExcludedCanaries.file,
      path.join(
        settingsExcludedCanaries.directory,
        settingsExcludedCanaries.child,
      ),
    ])
      await fs.writeFile(
        path.join(workspaceRoot, relative),
        settingsExcludedCanaries.text,
        {
          mode: 0o600,
          flag: "wx",
        },
      );
    assert.equal(
      (
        await regular(path.join(workspaceRoot, readCanary.relativePath))
      ).toString("utf8"),
      readCanary.text,
    );
    report.readDiscard = {
      workspaceRoot,
      workspacePhysical,
      limits: contract.readDiscardLimits,
    };
  }
  const proof = randomUUID();
  await fs.writeFile(path.join(temporary, ".farol-next-e2e-root"), proof, {
    mode: 0o600,
    flag: "wx",
  });
  const tunnelClient = path.join(temporary, "tunnel-client.cjs");
  await fs.writeFile(
    tunnelClient,
    `#!${process.execPath}\n${await fs.readFile(new URL("./tunnel-client.fixture.cjs", import.meta.url), "utf8")}`,
    { mode: 0o700, flag: "wx" },
  );
  let site;
  const accountSession = selected.readAccount
    ? {
        user: { id: "startup-synthetic-user" },
        account: { id: "startup-synthetic-account" },
        expires: new Date(Date.now() + 60 * 60_000).toISOString(),
      }
    : undefined;
  let accountGets = 0;
  const ledgerWitness = (ledger) => {
    zeroSends(ledger);
    if (selected.readAccount)
      accountLedgerWitness(ledger, accountGets, accountSession);
  };
  let application;
  let child;
  let exited;
  let stateRoot;
  let abort;
  let launch;
  const cancel = () => {
    abort = "HARNESS_CANCELLED";
  };
  const active = () => {
    if (abort) throw new Error(abort);
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const capture = async (label, computerId) => {
    const profile = await document(
      path.join(stateRoot, "go-core/profile.json"),
      4096,
    );
    const access = await document(
      path.join(stateRoot, "go-core/computer/computer-access.json"),
      1024 * 1024,
    );
    if (selected.readDiscard && report.readDiscard.binding) {
      assert.equal(computerId, report.readDiscard.settings.computer.computerId);
      readAccessWitness(
        profile.value,
        access.value,
        report.readDiscard.settings,
        report.readDiscard.binding,
      );
      if (launch.ordinal === 1 && report.readDiscard.access)
        assert.deepEqual(
          access,
          report.readDiscard.access,
          "READ_ACCESS_CHANGED_AFTER_PREVIEW",
        );
      if (!report.readDiscard.access) report.readDiscard.access = access;
      if (launch.ordinal === 2)
        assert.deepEqual(
          access.value.participants,
          report.readDiscard.access.value.participants,
          "READ_REOPEN_PARTICIPANTS_CHANGED",
        );
    } else zeroAuthority(profile.value, access.value, computerId);
    report.snapshots.push({ launch: launch.ordinal, label, profile, access });
    ledgerWitness(site.driver.snapshot());
    await save();
  };
  const captureJournal = async (label, previous, retired = false) => {
    const coreRoot = await physicalDirectory(path.join(stateRoot, "go-core"));
    const chatRoot = await physicalDirectory(path.join(coreRoot.path, "chat"));
    if (report.launches[0].physical) {
      assert.deepEqual(
        { coreRoot, chatRoot },
        report.launches[0].physical,
        "REOPEN_PHYSICAL_ROOT_CHANGED",
      );
    }
    launch.physical = { coreRoot, chatRoot };
    const profile = await document(
      path.join(coreRoot.path, "profile.json"),
      4096,
    );
    if (report.launches[0].goProfile)
      assert.deepEqual(
        profile,
        report.launches[0].goProfile,
        "REOPEN_GO_PROFILE_CHANGED",
      );
    launch.goProfile = profile;
    const journal = await document(
      path.join(chatRoot.path, "chat-lifecycle.json"),
      1024 * 1024,
    );
    report.journals.push({ launch: launch.ordinal, label, journal });
    await save();
    // These are independently read observations, never an origin authority or
    // permission to consume a claim. The production owner performs retirement.
    if (selected.readDiscard && launch.ordinal === 1 && launch.readPreview) {
      const binding = readJournalWitness(
        journal.value,
        launch.readyJournal.value,
        launch.readPreview,
        retired ? "retired" : launch.readDiscarded ? "discarded" : "preview",
        report.readDiscard.binding,
      );
      if (!report.readDiscard.binding) report.readDiscard.binding = binding;
    } else
      journalWitness(
        journal.value,
        profile.value.profileId,
        chatRoot,
        previous,
        retired,
      );
    if (retired) {
      assert.deepEqual(
        journal.value.scope,
        launch.readyJournal.value.scope,
        "QUIT_BACKEND_CHANGED",
      );
      launch.retiredJournal = journal;
    } else if (!launch.readPreview) launch.readyJournal = journal;
    await save();
    return journal;
  };
  const captureHandoff = async (previous) => {
    const directory = launch.physical.chatRoot.path;
    const names = await fs.readdir(directory);
    assert.equal(
      names.includes("chat-handoff.unknown"),
      false,
      "HANDOFF_UNKNOWN_FENCE",
    );
    const attempts = names
      .filter((name) => /^chat-handoff-\d{4}\.attempt$/u.test(name))
      .sort();
    assert.ok(
      attempts.length > 0 && attempts.length <= 1024,
      "HANDOFF_HISTORY_UNKNOWN",
    );
    const commits = names
      .filter((name) => /^chat-handoff-\d{4}\.commit$/u.test(name))
      .sort();
    assert.deepEqual(
      commits,
      attempts.map((name) => name.replace(".attempt", ".commit")),
      "HANDOFF_COMMIT_UNKNOWN",
    );
    attempts.forEach((name, index) =>
      assert.equal(
        name,
        `chat-handoff-${String(index + 1).padStart(4, "0")}.attempt`,
        "HANDOFF_HISTORY_GAP",
      ),
    );
    const name = attempts.at(-1);
    const evidence = await document(
      path.join(directory, name),
      1024 * 1024 + 32 * 1024,
    );
    evidence.file = name;
    report.handoffs.push({ launch: launch.ordinal, evidence });
    await save();
    const digest = (
      await regular(
        path.join(directory, name.replace(".attempt", ".commit")),
        64,
      )
    ).toString("utf8");
    assert.equal(digest, evidence.sha256, "HANDOFF_COMMIT_DIGEST_MISMATCH");
    // Persisted records are observations, never a live-owner retirement proof.
    handoffWitness(
      evidence.value,
      launch.readyJournal.value.scope,
      selected.buildId,
      previous?.value,
    );
    if (previous && selected.readDiscard)
      consumedReadHandoffWitness(evidence.value, previous.value);
    const binding = previous
      ? evidence.value.Consumption.NextBinding
      : evidence.value.Publication.Binding;
    for (const [key, physical] of [
      ["ParentRoot", launch.physical.coreRoot],
      ["ChatRoot", launch.physical.chatRoot],
    ])
      for (const field of ["Device", "Inode", "OwnerUID"])
        assert.equal(
          String(binding[key]?.[field]),
          physical[field],
          "HANDOFF_PHYSICAL_ROOT_CHANGED",
        );
    if (previous) launch.successorHandoff = evidence;
    else {
      assert.deepEqual(
        evidence.value.Receipt?.Write,
        launch.retiredJournal.value.retirement,
        "HANDOFF_RETIREMENT_CHANGED",
      );
      if (launch.successorHandoff)
        assert.deepEqual(
          binding,
          launch.successorHandoff.value.Consumption.NextBinding,
          "SECOND_TERMINAL_BINDING_CHANGED",
        );
      launch.terminalHandoff = evidence;
    }
    await save();
  };
  const close = async () => {
    assert.equal(
      launch.cleanup.closeRequested,
      false,
      "DUPLICATE_CLOSE_FORBIDDEN",
    );
    launch.cleanup.closeRequested = true;
    launch.status = "quit-requested";
    await save();
    try {
      assert.ok(child.kill("SIGINT"), "OWNED_QUIT_SIGNAL_FAILED");
      await bounded(exited, 15000, "ELECTRON_CLOSE_UNKNOWN");
      // The event listener stores the exact child's terminal before receipt IO.
      assert.equal(launch.cleanup.exitCode, 0, "CHILD_EXIT_FAILED");
      assert.equal(launch.cleanup.signal, null, "CHILD_SIGNAL_DEATH");
      const quit = await document(path.join(stateRoot, "last-quit.json"), 8192);
      launch.quitReceipt = quit;
      if (launch.ordinal === 1) report.quitReceipt = quit;
      quitWitness(
        quit.value,
        launch.runMarker.value,
        report.launches[launch.ordinal - 2]?.quitReceipt?.value,
      );
      launch.cleanup.drained = true;
      await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
        code: "ENOENT",
      });
      launch.cleanup.runMarkerRemoved = true;
      launch.terminalLedger = site.driver.snapshot();
      ledgerWitness(launch.terminalLedger);
      if (selected.reopen) {
        await captureJournal(
          "confirmed-quit",
          launch.ordinal === 2
            ? report.launches[0].readyJournal.value
            : undefined,
          true,
        );
        await captureHandoff();
      }
      cleanLaunchClosure(launch.cleanup);
      launch.status = "confirmed-clean-quit";
    } catch (error) {
      launch.status = "failed-or-unknown";
      launch.error = String(error);
      throw error;
    } finally {
      await save();
    }
  };
  try {
    const { startControlledChatGptSite } =
      await import("./fixtures/chatgpt-controlled-site.mjs");
    site = await startControlledChatGptSite({
      ...(selected.readAccount ? { account: accountSession } : {}),
      conversationId: "startup-no-send-conversation",
      selection: { model: "Startup fixture", effort: "Light", connector: null },
      turns: [
        {
          userId: "startup-user",
          replyId: "startup-reply",
          prompt: "No startup Send is authorized",
          segments: [
            { id: "startup-segment", text: "Unreleased startup canary" },
          ],
        },
      ],
    });
    report.fixture = {
      origin: site.origin,
      playwrightVersion: playwright.value.version,
    };
    const environment = {
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: appData,
      FAROL_NEXT_E2E_TEST_ROOT: temporary,
      FAROL_NEXT_E2E_TEST_PROOF: proof,
      FAROL_NEXT_E2E_TUNNEL_CLIENT: tunnelClient,
      FAROL_NEXT_E2E_CHATGPT_URL: site.url,
      ...(selected.readDiscard
        ? {
            FAROL_NEXT_E2E_WORKSPACE_ROOT: workspaceRoot,
            FAROL_NEXT_E2E_WORKSPACE_FILE: path.join(
              workspaceRoot,
              readCanary.relativePath,
            ),
          }
        : {}),
      ...(selected.packaged ? {} : { FAROL_NEXT_ENVIRONMENT: "dev" }),
      HOME: home,
      TMPDIR: temp,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    };
    const start = async (ordinal) => {
      launch = {
        ordinal,
        status: "launch-attempted",
        artifact: inputs,
        windows: [],
        cleanup: {
          launchAttempted: false,
          launchResolved: false,
          closeRequested: false,
        },
      };
      report.launches.push(launch);
      // Retain the original fresh-only cleanup projection for existing readers.
      report.cleanup = launch.cleanup;
      launch.cleanup.launchAttempted = true;
      await save();
      active();
      application = await electron.launch({
        executablePath: executable,
        args: [
          ...(selected.packaged ? [] : [path.join(inputs.appRoot, "main.cjs")]),
          "--preview-window-mode=hidden",
        ],
        env: environment,
        timeout: 15000,
      });
      launch.cleanup.launchResolved = true;
      child = application.process();
      launch.pid = child.pid;
      const launched = launch;
      exited = once(child, "exit");
      child.once("exit", (code, signal) => {
        launched.cleanup.exitObserved = true;
        launched.cleanup.exitCode = code;
        launched.cleanup.signal = signal;
      });
      // Observe terminal immediately; a rejection must not become unhandled.
      exited.catch(() => undefined);
      const window = await application.firstWindow({ timeout: 15000 });
      const bootstrap = await ready(window, active);
      const settings =
        selected.readDiscard && ordinal === 2
          ? bootstrap.configuration.settings
          : unconfigured(bootstrap);
      const paths = await bounded(
        application.evaluate(({ app }) => ({
          name: app.getName(),
          userData: app.getPath("userData"),
          sessionData: app.getPath("sessionData"),
        })),
        3000,
        "PROFILE_PROJECTION_UNKNOWN",
      );
      assert.equal(
        path.dirname(paths.userData),
        appData,
        "PROFILE_ESCAPED_DISPOSABLE_APP_DATA",
      );
      assert.equal(paths.sessionData, paths.userData);
      assert.equal(paths.name, selected.packaged ? "Farol" : "Farol Dev");
      assert.equal(
        bootstrap.environment,
        selected.packaged ? "preview" : "dev",
      );
      assert.equal(
        bootstrap.applicationId,
        selected.packaged ? "local.farol.next.preview" : "local.farol.dev",
      );
      stateRoot = path.join(paths.userData, "farol-next-state");
      launch.profile = paths;
      if (launch.ordinal === 2)
        assert.deepEqual(
          paths,
          report.launches[0].profile,
          "REOPEN_PROFILE_CHANGED",
        );
      else report.profile = paths;
      launch.runMarker = await document(
        path.join(stateRoot, "running.json"),
        4096,
      );
      assert.equal(launch.runMarker.value.schema, 1);
      assert.equal(
        launch.runMarker.value.pid,
        child.pid,
        "RUN_MARKER_CHILD_MISMATCH",
      );
      assert.ok(
        Number.isFinite(Date.parse(launch.runMarker.value.startedAt)),
        "RUN_MARKER_TIME_UNKNOWN",
      );
      const hidden = async () => {
        const windows = await bounded(
          application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((value) => ({
              visible: value.isVisible(),
              focused: value.isFocused(),
            })),
          ),
          3000,
          "WINDOW_PROJECTION_UNKNOWN",
        );
        assert.ok(windows.length > 0);
        assert.ok(
          windows.every((value) => !value.visible && !value.focused),
          "TEST_WINDOW_VISIBLE_OR_FOCUSED",
        );
        report.windows.push(windows);
        launch.windows.push(windows);
      };
      launch.status = "ready";
      await hidden();
      await save();
      return { window, settings, hidden };
    };
    const { window, settings, hidden } = await start(1);
    await hidden();
    await capture("fresh-ready", settings.computer.computerId);
    if (selected.reopen) await captureJournal("fresh-ready");
    // Ordinary preload/configuration IPC, one bounded mutation of disposable
    // settings. A Computer-generation change exercises withdrawal/publication
    // without granting a folder or manufacturing a Go admission.
    const renamed = await bounded(
      window.evaluate(() =>
        window.farolNext.configure({
          kind: "computer.rename",
          name: "Startup regression computer",
        }),
      ),
      5000,
      "SETTINGS_MUTATION_OUTCOME_UNKNOWN",
    );
    assert.equal(renamed.ok, true, "ZERO_AUTHORITY_SETTINGS_CHANGE_FAILED");
    assert.equal(
      renamed.snapshot.settings.computer.name,
      "Startup regression computer",
    );
    assert.equal(
      renamed.snapshot.settings.computer.generation,
      settings.computer.generation + 1,
    );
    assert.deepEqual(renamed.snapshot.settings.computer.workspaces, []);
    await window
      .getByRole("button", { name: "Settings", exact: true })
      .click({ timeout: 5000 });
    await window
      .locator(".contextual-sidebar")
      .getByRole("button", { name: "Appearance", exact: true })
      .click({ timeout: 5000 });
    await window
      .getByRole("heading", { name: "Appearance", exact: true, level: 2 })
      .waitFor({ timeout: 5000 });
    await window
      .getByRole("button", { name: "Graphite", exact: true })
      .click({ timeout: 5000 });
    await window.waitForFunction(
      () => document.querySelector(".desktop")?.dataset.theme === "graphite",
      undefined,
      { timeout: 5000 },
    );
    unconfigured(await ready(window, active));
    let savedSettings = await document(
      path.join(stateRoot, "config.json"),
      256 * 1024,
    );
    assert.deepEqual(savedSettings.value.computer.workspaces, []);
    assert.equal(
      savedSettings.value.computer.name,
      "Startup regression computer",
    );
    assert.equal(
      savedSettings.value.computer.generation,
      settings.computer.generation + 1,
    );
    report.settingsSHA = savedSettings.sha256;
    launch.settings = savedSettings;
    await capture("settings-ui-zero-authority", settings.computer.computerId);
    if (selected.readDiscard) {
      // Only normal preload commands. No expected witness data is injected into
      // the production adapter, and no Send, sign-in or auth command is issued.
      const configure = async (command) => {
        active();
        await hidden();
        const reply = await bounded(
          window.evaluate(
            (command) => window.farolNext.configure(command),
            command,
          ),
          20000,
          "READ_CONFIGURATION_OUTCOME_UNKNOWN",
        );
        ledgerWitness(site.driver.snapshot());
        await hidden();
        report.readDiscard.commands ??= [];
        report.readDiscard.commands.push({ command, reply });
        await save();
        return reply;
      };
      const added = await configure({ kind: "computer.add-workspace" });
      assert.equal(added.ok, true, "READ_WORKSPACE_ADD_FAILED");
      assert.equal(added.snapshot.settings.computer.workspaces.length, 1);
      const workspaceId =
        added.snapshot.settings.computer.workspaces[0].workspaceId;
      const settingsReport = (report.readDiscard.settingsCommands = {
        observations: [],
        commands: [],
        syntheticNames: {
          included: readCanary.relativePath,
          excludedDirectory: settingsExcludedCanaries.directory,
          excludedDirectoryChild: settingsExcludedCanaries.child,
          excludedFile: settingsExcludedCanaries.file,
        },
        sourceBinding: {
          packageSourceCommit: inputs.identity.sourceCommit,
          productionMainSHA: inputs.mainSHA,
          settingsWitnessSourceSHA: report.settingsWitnessSourceSHA,
        },
        executorOrigin:
          "Not instrumented by Settings replies; exact packaged production source must tie commands to the Go owner executor",
      });
      const observeSettings = async (
        label,
        currentSettings,
        observations = settingsReport.observations,
        witness = settingsAuthorityWitness,
      ) => {
        const physical = {
          coreRoot: await physicalDirectory(path.join(stateRoot, "go-core")),
          computerRoot: await physicalDirectory(
            path.join(stateRoot, "go-core/computer"),
          ),
          chatRoot: await physicalDirectory(
            path.join(stateRoot, "go-core/chat"),
          ),
          workspaceRoot: await physicalDirectory(workspaceRoot),
        };
        assert.deepEqual(physical.coreRoot, launch.physical.coreRoot);
        assert.deepEqual(physical.chatRoot, launch.physical.chatRoot);
        assert.deepEqual(physical.workspaceRoot, workspacePhysical);
        const profile = await document(
          path.join(physical.coreRoot.path, "profile.json"),
          4096,
        );
        assert.deepEqual(
          profile,
          launch.goProfile,
          "SETTINGS_GO_PROFILE_CHANGED",
        );
        const access = await document(
          path.join(physical.computerRoot.path, "computer-access.json"),
          1024 * 1024,
        );
        const chat = await document(
          path.join(physical.chatRoot.path, "chat-lifecycle.json"),
          1024 * 1024,
        );
        const configuration = await document(
          path.join(stateRoot, "config.json"),
          256 * 1024,
        );
        const observed = {
          label,
          profile,
          access,
          chat,
          configuration,
          settings: currentSettings,
          physical,
        };
        const previous = observations.at(-1);
        observations.push(observed);
        await save();
        assert.deepEqual(
          configuration.value,
          currentSettings,
          "SETTINGS_SNAPSHOT_NOT_RETAINED",
        );
        // Separate read of the same known roots; captureJournal and its
        // ready/read/Discard/retirement protections remain unchanged.
        journalWitness(chat.value, profile.value.profileId, physical.chatRoot);
        observed.counters = witness(observed, previous);
        ledgerWitness(site.driver.snapshot());
        await save();
        return observed;
      };
      let settingsCurrent = added.snapshot.settings;
      for (const command of [
        { kind: "computer.verify-workspace", workspaceId },
        { kind: "computer.check-folder", workspaceId },
        { kind: "computer.list-workspace", workspaceId, relativePath: "." },
      ]) {
        const before = await observeSettings(
          `before-${command.kind}`,
          settingsCurrent,
        );
        const reply = await configure(command);
        const commandReport = { command, reply, before: before.label };
        settingsReport.commands.push(commandReport);
        await save();
        if (reply.snapshot.status === "ready")
          settingsCurrent = reply.snapshot.settings;
        const after = await observeSettings(
          `after-${command.kind}`,
          settingsCurrent,
        );
        commandReport.after = after.label;
        assert.equal(reply.ok, true, "SETTINGS_COMMAND_FAILED");
        if (command.kind === "computer.check-folder") {
          const checked = settingsCurrent.computer.workspaces[0].accessCheck;
          assert.equal(checked?.buildId, selected.buildId);
          assert.equal(
            checked?.computerGeneration,
            settingsCurrent.computer.generation,
          );
          assert.deepEqual(
            checked?.rootIdentity,
            settingsCurrent.computer.workspaces[0].rootIdentity,
          );
        } else
          commandReport.list = settingsListWitness(
            reply.evidence,
            workspaceId,
            ".",
            readCanary.relativePath,
          );
        await save();
      }
      settingsReport.passed = true;
      await save();
      if (selected.editSnapshot) {
        const editReport = (report.editSnapshot = {
          limits: snapshotLimits,
          controlPath:
            "Existing normal window.farolNext.configure; React Settings has no Prepare/edit/Cancel controls. Real edit UI acceptance remains open.",
          executorOrigin:
            "Source-bound normal packaged main -> readGoWorkspaceSnapshot -> GoCoreHost.snapshotSettingsWorkspace -> GoComputerAuthority.snapshotSettings -> computer.settings.snapshot; no independent Go RPC counter",
          sourceBinding: {
            packageSourceCommit: inputs.identity.sourceCommit,
            productionMainSHA: inputs.mainSHA,
            core: inputs.core,
            inputs: inputs.editSnapshotInputs,
            witnessSourceSHA: report.snapshotWitnessSourceSHA,
          },
          observations: [settingsReport.observations.at(-1)],
          commands: [],
        });
        const observeEdit = (label, access) =>
          observeSettings(
            label,
            settingsCurrent,
            editReport.observations,
            (observed, previous) =>
              snapshotAuthorityWitness(observed, previous, access),
          );
        const editCommand = async (command, access) => {
          const reply = await configure(command);
          editReport.commands.push({ command, reply });
          await save();
          assert.equal(reply.ok, true, "EDIT_SNAPSHOT_COMMAND_FAILED");
          assert.equal(reply.snapshot.status, "ready");
          settingsCurrent = reply.snapshot.settings;
          return {
            reply,
            observed: await observeEdit(`after-${command.kind}`, access),
          };
        };
        await editCommand(
          { kind: "computer.update-access", workspaceId, access: "write" },
          "write",
        );
        const verified = await editCommand(
          { kind: "computer.verify-workspace", workspaceId },
          "write",
        );
        assert.equal(
          settingsCurrent.setup.computer.verified?.buildId,
          selected.buildId,
        );
        assert.equal(
          settingsCurrent.setup.computer.verified?.protocol,
          "mutable-workspace/1",
        );
        const canaryPath = path.join(workspaceRoot, readCanary.relativePath);
        const originalBytes = await regular(canaryPath, 256 * 1024);
        assert.deepEqual(originalBytes, Buffer.from(readCanary.text, "utf8"));
        const prepared = await editCommand(
          { kind: "computer.prepare-workspace-edit", workspaceId },
          "write",
        );
        const preview = prepared.reply.evidence;
        editReport.rawFile = settingsSnapshotWitness(
          preview,
          verified.observed,
          prepared.observed,
          originalBytes,
          await regular(canaryPath, 256 * 1024),
          readCanary.relativePath,
        );
        assert.ok(
          Date.parse(preview.expiresAt) > Date.now(),
          "EDIT_SNAPSHOT_ALREADY_EXPIRED",
        );
        editReport.preview = preview;
        await save();
        const cancelCommand = {
          kind: "computer.cancel-workspace-edit",
          operationId: preview.operationId,
        };
        const cancelled = await editCommand(cancelCommand, "write");
        snapshotCancelWitness(
          cancelCommand,
          cancelled.reply,
          preview,
          verified.observed.settings,
        );
        snapshotUnchangedWitness(
          verified.observed,
          cancelled.observed,
          originalBytes,
          await regular(canaryPath, 256 * 1024),
        );
        await editCommand(
          { kind: "computer.update-access", workspaceId, access: "read" },
          "read",
        );
        const restored = await editCommand(
          { kind: "computer.verify-workspace", workspaceId },
          "read",
        );
        settingsAuthorityWitness(restored.observed);
        assert.equal(
          settingsCurrent.setup.computer.verified?.workspaceId,
          workspaceId,
        );
        assert.equal(
          settingsCurrent.setup.computer.verified?.configRevision,
          settingsCurrent.computer.generation,
        );
        assert.equal(
          settingsCurrent.setup.computer.verified?.buildId,
          selected.buildId,
        );
        assert.equal(
          settingsCurrent.setup.computer.verified?.protocol,
          "readonly-workspace/1",
        );
        assert.deepEqual(await regular(canaryPath, 256 * 1024), originalBytes);
        editReport.readAccessRestoredAndVerified = true;
        editReport.passed = true;
        await save();
      }
      // Normal Home/Settings startup keeps Browser lazy. Open its exact fixture
      // page before the observation-only Check connection command.
      const opened = await configure({ kind: "chatgpt.open-browser" });
      assert.equal(opened.ok, true, "READ_FIXTURE_BROWSER_OPEN_FAILED");
      const readiness = await configure({ kind: "chatgpt.verify" });
      assert.equal(readiness.ok, true, "READ_FIXTURE_READINESS_FAILED");
      assert.equal(readiness.evidence?.kind, "chatgpt.readiness");
      assert.equal(readiness.evidence.state, "authenticated");
      const configured = readiness.snapshot.settings;
      const workspace = approvedSettingsWitness(
        configured,
        workspaceRoot,
        workspacePhysical,
        selected.buildId,
      );
      report.readDiscard.settings = configured;
      let originalUi;
      const forbiddenUi = selected.readAccount
        ? [accountSession.user.id, accountSession.account.id]
        : [];
      if (selected.readAccount) {
        report.readAccount = {
          limits: readAccountLimits,
          observations: [],
          commands: [],
          sourceBinding: {
            packageSourceCommit: inputs.identity.sourceCommit,
            inputs: inputs.readAccountInputs,
          },
        };
        report.readAccount.initialDiagnostics = await refreshAccountUi(
          window,
          configured.revision,
        );
        await window
          .getByRole("button", { name: "Home", exact: true })
          .click({ timeout: 5000 });
        await window
          .locator(".home-page")
          .waitFor({ state: "visible", timeout: 5000 });
        await hidden();
        const section = window.locator(
          'section[aria-label="Read-only file preview"]',
        );
        report.readAccount.beforeSelection = await readAccountUi(window);
        // The wrapping label includes the select's option text. Match the
        // unique combobox inside the exact preview section, not that full text.
        await section
          .getByRole("combobox")
          .selectOption(workspaceId, { timeout: 5000 });
        await accountUiAction(window, "Choose file…", "Discard preview");
        await hidden();
        originalUi = accountUiWitness(
          await readAccountUi(window),
          workspace,
          "prepared",
          undefined,
          forbiddenUi,
        );
        assert.equal(
          originalUi.revision,
          configured.revision,
          "ACCOUNT_UI_CONFIGURATION_CROSSED",
        );
        launch.readPreview = originalUi.preview;
        report.readAccount.originalUi = originalUi;
        ledgerWitness(site.driver.snapshot());
      } else {
        const prepared = await configure({
          kind: "chatgpt.prepare-readonly-task",
          workspaceId,
        });
        assert.equal(prepared.ok, true, "READ_PREVIEW_FAILED");
        retainedApprovedSettings(prepared.snapshot.settings, configured);
        previewWitness(prepared.evidence, workspace);
        launch.readPreview = prepared.evidence;
      }
      const previewJournal = await captureJournal("read-preview");
      await capture("read-preview-approved", settings.computer.computerId);
      const legacyPath = path.join(
        stateRoot,
        "chatgpt-task-journal/chatgpt-task-journal.json",
      );
      const legacyPrepared = await document(legacyPath, 65536);
      legacyPreviewWitness(
        legacyPrepared.value,
        launch.readPreview.operationId,
        "prepared",
      );
      report.readDiscard.legacyPrepared = legacyPrepared;
      if (selected.readAccount) {
        const observeAccount = async (label, phase) => {
          active();
          await hidden();
          const ui = await readAccountUi(window);
          accountUiWitness(ui, workspace, phase, originalUi, forbiddenUi);
          const journal = await captureJournal(label);
          assert.deepEqual(
            journal,
            previewJournal,
            "ACCOUNT_CHAT_TURN_MUTATED",
          );
          assert.deepEqual(
            await document(legacyPath, 65536),
            legacyPrepared,
            "ACCOUNT_LEGACY_TURN_MUTATED",
          );
          const configuration = await document(
            path.join(stateRoot, "config.json"),
            256 * 1024,
          );
          retainedApprovedSettings(configuration.value, configured);
          await capture(label, settings.computer.computerId);
          const ledger = site.driver.snapshot();
          ledgerWitness(ledger);
          report.readAccount.observations.push({
            label,
            phase,
            ui,
            journal,
            configuration,
            ledger,
          });
          await save();
        };
        const gets = (expected) => {
          accountLedgerWitness(
            site.driver.snapshot(),
            expected,
            accountSession,
          );
          accountGets = expected;
        };
        const remount = async (label, phase) => {
          await window
            .locator('section[aria-label="Selected file metadata"]')
            .getByRole("button", { name: "Open ChatGPT", exact: true })
            .click({ timeout: 5000 });
          await window
            .locator('section[aria-label="Read-only file preview"]')
            .waitFor({ state: "detached", timeout: 5000 });
          await hidden();
          ledgerWitness(site.driver.snapshot());
          await window
            .getByRole("button", { name: "Home", exact: true })
            .click({ timeout: 5000 });
          await window
            .locator(".home-page")
            .waitFor({ state: "visible", timeout: 5000 });
          await window
            .locator('section[aria-label="Read-only file preview"]')
            .getByRole("button", { name: "Discard preview", exact: true })
            .waitFor({ state: "visible", timeout: 5000 });
          await observeAccount(label, phase);
        };
        await observeAccount(
          "react-preview-before-inspect-zero-get",
          "prepared",
        );
        await accountUiAction(
          window,
          "Inspect current account",
          "Use this account",
        );
        gets(1);
        await observeAccount("react-explicit-inspect-one-get", "observed");
        // Exact UI success and independent zero-Send/one-GET/journal observations
        // above are prerequisites. Unknown/refused first results never get here.
        const inspected = await configure({
          kind: "chatgpt.inspect-readonly-account",
          operationId: originalUi.preview.operationId,
        });
        const confirmationId = accountReplyWitness(
          inspected,
          configured,
          originalUi,
          "observed",
        );
        report.readAccount.commands.push({
          kind: "known-original-duplicate-inspect",
          reply: inspected,
        });
        await observeAccount(
          "duplicate-inspect-no-get-no-turn-change",
          "observed",
        );
        await remount(
          "observed-chatgpt-home-remount-no-implicit-effects",
          "observed",
        );
        const diagnostics = await refreshAccountUi(window, originalUi.revision);
        const refreshed = await ready(window, active);
        retainedApprovedSettings(refreshed.configuration.settings, configured);
        assert.ok(
          diagnostics.includes(
            `Configuration revision: ${originalUi.revision}.`,
          ),
        );
        await window
          .getByRole("button", { name: "Home", exact: true })
          .click({ timeout: 5000 });
        await window
          .locator(".home-page")
          .waitFor({ state: "visible", timeout: 5000 });
        await observeAccount(
          "observed-same-revision-refresh-retained",
          "observed",
        );
        await accountUiAction(window, "Use this account", "approved");
        gets(2);
        await observeAccount(
          "react-explicit-account-confirmed-two-gets",
          "approved",
        );
        // Reuse the exact original operation + confirmation. No replacement key,
        // reinspection or reapproval is authorized after unknown/refused work.
        const approved = await configure({
          kind: "chatgpt.approve-readonly-account",
          operationId: originalUi.preview.operationId,
          confirmationId,
        });
        accountReplyWitness(
          approved,
          configured,
          originalUi,
          "approved",
          confirmationId,
        );
        report.readAccount.commands.push({
          kind: "known-original-duplicate-confirm",
          reply: approved,
        });
        await observeAccount(
          "duplicate-confirm-no-get-no-turn-change",
          "approved",
        );
        await remount(
          "approved-chatgpt-home-remount-no-implicit-effects",
          "approved",
        );
        report.readAccount.confirmationId = confirmationId;
      } else {
        const repeated = await configure({
          kind: "chatgpt.prepare-readonly-task",
          workspaceId,
        });
        assert.equal(repeated.ok, true, "READ_DUPLICATE_PREPARE_FAILED");
        assert.deepEqual(
          repeated.evidence,
          launch.readPreview,
          "READ_DUPLICATE_PREVIEW_CHANGED",
        );
        retainedApprovedSettings(repeated.snapshot.settings, configured);
        assert.deepEqual(
          await captureJournal("duplicate-read-preview"),
          previewJournal,
          "READ_DUPLICATE_ADMISSION_WRITES",
        );
        assert.deepEqual(
          await document(legacyPath, 65536),
          legacyPrepared,
          "READ_DUPLICATE_LEGACY_PREPARE_WRITES",
        );
        await capture(
          "duplicate-read-preview-approved",
          settings.computer.computerId,
        );
      }
      const operationId = launch.readPreview.operationId;
      if (selected.readAccount) {
        await accountUiAction(window, "Discard preview", "discarded");
        const ui = await readAccountUi(window);
        assert.equal(ui.operationId, null, "ACCOUNT_DISCARD_PREVIEW_RETAINED");
        assert.equal(
          ui.buttons.some((button) =>
            [
              "Discard preview",
              "Use this account",
              "Inspect current account",
            ].includes(button.name),
          ),
          false,
          "ACCOUNT_DISCARD_CONTROLS_RETAINED",
        );
        assert.ok(
          ui.text.includes("The exact preview was discarded."),
          "ACCOUNT_DISCARD_UI_UNCONFIRMED",
        );
        await hidden();
        ledgerWitness(site.driver.snapshot());
        report.readAccount.discardUi = ui;
      } else {
        const discarded = await configure({
          kind: "chatgpt.cancel-readonly-task",
          operationId,
        });
        assert.equal(discarded.ok, true, "READ_DISCARD_NOT_CONFIRMED");
        retainedApprovedSettings(discarded.snapshot.settings, configured);
      }
      launch.readDiscarded = true;
      const discardedJournal = await captureJournal(
        "explicit-discard-cancel-ack",
      );
      await capture("explicit-discard-approved", settings.computer.computerId);
      const legacyDiscarded = await document(legacyPath, 65536);
      legacyPreviewWitness(
        legacyDiscarded.value,
        operationId,
        "delivery_acknowledged",
      );
      assert.equal(
        legacyDiscarded.value.createdAt,
        legacyPrepared.value.createdAt,
      );
      report.readDiscard.legacyDiscarded = legacyDiscarded;
      // A known successful discard permits this explicit idempotence probe.
      // Refused/unknown first discard throws above and can never reach it.
      const duplicateDiscard = await configure({
        kind: "chatgpt.cancel-readonly-task",
        operationId,
      });
      assert.equal(duplicateDiscard.ok, false);
      assert.equal(duplicateDiscard.error, "CHATGPT_TASK_PREVIEW_NOT_FOUND");
      retainedApprovedSettings(duplicateDiscard.snapshot.settings, configured);
      assert.deepEqual(
        await captureJournal("duplicate-discard-no-writes"),
        discardedJournal,
        "READ_DUPLICATE_DISCARD_WRITES",
      );
      assert.deepEqual(
        await document(legacyPath, 65536),
        legacyDiscarded,
        "READ_DUPLICATE_LEGACY_DISCARD_WRITES",
      );
      await capture("duplicate-discard-approved", settings.computer.computerId);
      savedSettings = await document(
        path.join(stateRoot, "config.json"),
        256 * 1024,
      );
      retainedApprovedSettings(savedSettings.value, configured);
      report.settingsSHA = savedSettings.sha256;
      launch.settings = savedSettings;
    }
    await hidden();
    active();
    await close();
    await capture(
      selected.readDiscard
        ? "confirmed-quit-read-discard"
        : "confirmed-quit-zero-authority",
      settings.computer.computerId,
    );
    if (selected.reopen) {
      // Only this straight-line success path can launch the one successor.
      // No relaunch is reachable from catch/finally or an unknown receipt.
      permitReopen(report.launches[0]);
      active();
      const reattested = await attest(selected);
      assert.deepEqual(reattested, inputs, "ARTIFACT_CHANGED_BEFORE_REOPEN");
      await assert.rejects(fs.lstat(path.join(stateRoot, "running.json")), {
        code: "ENOENT",
      });
      const beforeReopen = await document(
        path.join(stateRoot, "config.json"),
        256 * 1024,
      );
      assert.deepEqual(
        beforeReopen,
        savedSettings,
        "SETTINGS_CHANGED_BEFORE_REOPEN",
      );
      const first = report.launches[0];
      assert.deepEqual(
        await physicalDirectory(first.physical.coreRoot.path),
        first.physical.coreRoot,
        "REOPEN_PHYSICAL_ROOT_CHANGED",
      );
      assert.deepEqual(
        await physicalDirectory(first.physical.chatRoot.path),
        first.physical.chatRoot,
        "REOPEN_PHYSICAL_ROOT_CHANGED",
      );
      assert.deepEqual(
        await document(
          path.join(first.physical.coreRoot.path, "profile.json"),
          4096,
        ),
        first.goProfile,
        "REOPEN_GO_PROFILE_CHANGED",
      );
      assert.deepEqual(
        await document(
          path.join(first.physical.chatRoot.path, "chat-lifecycle.json"),
          1024 * 1024,
        ),
        first.retiredJournal,
        "REOPEN_RETIRED_JOURNAL_CHANGED",
      );
      const reopened = await start(2);
      // Capture the new owner before optional UI assertions. Failure of an
      // unrelated navigation check must not erase its cleanup correlation.
      await captureJournal(
        "reopen-ready",
        report.launches[0].readyJournal.value,
      );
      await captureHandoff(report.launches[0].terminalHandoff);
      if (selected.readDiscard) {
        retainedApprovedSettings(reopened.settings, savedSettings.value);
        approvedSettingsWitness(
          reopened.settings,
          workspaceRoot,
          workspacePhysical,
          selected.buildId,
        );
        assert.deepEqual(
          await physicalDirectory(workspaceRoot),
          workspacePhysical,
          "READ_REOPEN_WORKSPACE_PHYSICAL_CHANGED",
        );
        assert.equal(
          (
            await regular(path.join(workspaceRoot, readCanary.relativePath))
          ).toString("utf8"),
          readCanary.text,
        );
        assert.deepEqual(
          await document(
            path.join(
              stateRoot,
              "chatgpt-task-journal/chatgpt-task-journal.json",
            ),
            65536,
          ),
          report.readDiscard.legacyDiscarded,
          "READ_REOPEN_LEGACY_JOURNAL_CHANGED",
        );
        // This journey opened Browser in a configured profile. Use ordinary
        // navigation instead of assuming its retained surface is fresh Home.
        await reopened.window
          .getByRole("button", { name: "Home", exact: true })
          .click({ timeout: 5000 });
      } else retainedSettings(reopened.settings, savedSettings.value);
      await reopened.window
        .locator(".home-page")
        .waitFor({ state: "visible", timeout: 5000 });
      await reopened.window
        .getByRole("button", { name: "Home", exact: true })
        .waitFor({ state: "visible", timeout: 5000 });
      await reopened.window.waitForFunction(
        () => document.querySelector(".desktop")?.dataset.theme === "graphite",
        undefined,
        { timeout: 5000 },
      );
      launch.appearance = await bounded(
        reopened.window.evaluate(() => {
          const saved = JSON.parse(
            localStorage.getItem("farol.appearance.v1") ?? "null",
          );
          return {
            persistedTheme: saved?.theme,
            renderedTheme: document.querySelector(".desktop")?.dataset.theme,
          };
        }),
        3000,
        "REOPEN_APPEARANCE_UNKNOWN",
      );
      assert.deepEqual(launch.appearance, {
        persistedTheme: "graphite",
        renderedTheme: "graphite",
      });
      if (selected.readAccount) {
        const ui = await readAccountUi(reopened.window);
        assert.equal(
          ui.operationId,
          null,
          "ACCOUNT_REOPEN_PREVIEW_RESURRECTED",
        );
        assert.equal(
          ui.text.includes(report.readAccount.originalUi.preview.operationId),
          false,
          "ACCOUNT_REOPEN_ORIGINAL_RECEIPT_RESURRECTED",
        );
        assert.equal(
          ui.buttons.some((button) =>
            [
              "Inspect current account",
              "Use this account",
              "Discard preview",
            ].includes(button.name),
          ),
          false,
          "ACCOUNT_REOPEN_CONTROLS_RESURRECTED",
        );
        ledgerWitness(site.driver.snapshot());
        report.readAccount.reopenUi = ui;
      }
      const reopenedSettings = await document(
        path.join(stateRoot, "config.json"),
        256 * 1024,
      );
      if (selected.readDiscard)
        retainedApprovedSettings(reopenedSettings, savedSettings);
      else retainedSettings(reopenedSettings.value, savedSettings.value);
      launch.settings = reopenedSettings;
      await capture(
        selected.readDiscard
          ? "reopen-ready-retained-approval"
          : "reopen-ready-zero-authority",
        settings.computer.computerId,
      );
      await reopened.hidden();
      active();
      await close();
      await capture(
        selected.readDiscard
          ? "reopen-confirmed-quit-retained-approval"
          : "reopen-confirmed-quit-zero-authority",
        settings.computer.computerId,
      );
    }
    report.scenarioPassed = true;
  } catch (error) {
    if (launch) {
      launch.journeyError = String(error);
      if (launch.status !== "confirmed-clean-quit")
        launch.status = "failed-or-unknown";
    }
    throw error;
  } finally {
    // A failed/unknown launch is never relaunched. A requested but unknown quit
    // is never retried or reinterpreted as clean; preserve the profile for Lead.
    if (
      application &&
      launch.cleanup.launchResolved &&
      !launch.cleanup.closeRequested
    ) {
      try {
        await close();
      } catch (error) {
        launch.cleanup.closeError = String(error);
      }
    }
    if (site) {
      report.ledger = site.driver.snapshot();
      try {
        ledgerWitness(report.ledger);
      } catch (error) {
        report.cleanup.ledgerError = String(error);
      }
      try {
        await bounded(site.close(), 3000, "FIXTURE_CLOSE_UNKNOWN");
        report.cleanup.siteClosed = true;
      } catch (error) {
        report.cleanup.siteError = String(error);
      }
    }
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    try {
      for (const receipt of report.launches) {
        cleanLaunchClosure(receipt.cleanup);
        assert.equal(
          receipt.status,
          "confirmed-clean-quit",
          "LIFECYCLE_EVIDENCE_UNCONFIRMED",
        );
      }
      assert.equal(
        report.launches.length,
        selected.reopen ? 2 : 1,
        "LAUNCH_SEQUENCE_INCOMPLETE",
      );
      cleanClosure(report.cleanup);
      assert.equal(report.cleanup.ledgerError, undefined);
      if (selected.reopen)
        assert.equal(
          report.scenarioPassed,
          true,
          "REOPEN_EVIDENCE_RETAINED_AFTER_FAILURE",
        );
      await fs.rm(temporary, { recursive: true });
      report.cleanup.temporaryRemoved = true;
    } catch (error) {
      report.cleanup.retainedReason = String(error);
    }
    await save();
  }
  cleanClosure(report.cleanup);
  assert.equal(report.cleanup.temporaryRemoved, true, "RESOURCES_RETAINED");
  assert.equal(report.scenarioPassed, true);
}

function selfTest() {
  let checks = 0;
  const pass = (call) => {
    call();
    checks++;
  };
  const reject = (call) => {
    assert.throws(call);
    checks++;
  };
  const profile = {
    schema: "farol-native-profile/1",
    profileId: "12345678-1234-1234-1234-123456789abc",
    computerId: "computer-test",
  };
  const access = {
    schema: 1,
    profileId: profile.profileId,
    ownerId: "owner-desktop",
    computerId: profile.computerId,
    revision: "0",
    generation: "0",
    seenApproval: false,
    approval: null,
    participants: {},
  };
  pass(() => zeroAuthority(profile, access, profile.computerId));
  for (const [key, value] of [
    ["approval", { workspaces: [] }],
    ["participants", { fabricated: {} }],
    ["revision", "1"],
    ["generation", "1"],
    ["seenApproval", true],
    ["profileId", "wrong-profile"],
    ["computerId", "wrong-computer"],
    ["ownerId", "wrong-owner"],
    ["schema", 2],
  ])
    reject(() =>
      zeroAuthority(profile, { ...access, [key]: value }, profile.computerId),
    );
  const ledger = { attemptedSends: 0, acceptedSends: 0, ledger: [], turns: [] };
  pass(() => zeroSends(ledger));
  for (const mutation of [
    { attemptedSends: 1 },
    { acceptedSends: 1 },
    { ledger: [{}] },
    { turns: [{}] },
  ])
    reject(() => zeroSends({ ...ledger, ...mutation }));
  const cleanup = {
    launchResolved: true,
    closeRequested: true,
    exitObserved: true,
    exitCode: 0,
    signal: null,
    drained: true,
    runMarkerRemoved: true,
    siteClosed: true,
  };
  pass(() => cleanClosure(cleanup));
  for (const [key, value] of Object.entries(cleanup))
    reject(() =>
      cleanClosure({
        ...cleanup,
        [key]:
          typeof value === "boolean" ? false : key === "signal" ? "SIGKILL" : 1,
      }),
    );
  const args = [
    "--candidate-root",
    "/tmp/candidate",
    "--source-sha",
    "a".repeat(40),
    "--build-id",
    "b".repeat(64),
  ];
  pass(() => assert.equal(selection(args).mode, "--check"));
  pass(() =>
    assert.equal(selection(["--run-native", ...args]).mode, "--run-native"),
  );
  for (const extra of [
    ["--build-only"],
    ["--run-native", "--check"],
    ["--source-sha", "a".repeat(40)],
    ["--artifact-sha", "c".repeat(64)],
    ["--packaged", "/tmp/Farol.app"],
  ])
    reject(() => selection([...args, ...extra]));
  reject(() => selection([]));
  reject(() =>
    selection(
      args.map((value) => (value === "/tmp/candidate" ? "relative" : value)),
    ),
  );
  const selected = selection(args);
  const packageArgs = [
    "--packaged",
    "/tmp/Farol.app",
    "--artifact-metadata",
    "/tmp/artifact.json",
    "--artifact-sha",
    "c".repeat(64),
    "--source-sha",
    "a".repeat(40),
    "--build-id",
    "b".repeat(64),
  ];
  pass(() => assert.equal(selection(packageArgs).mode, "--check"));
  pass(() => assert.equal(selection(packageArgs).reopen, false));
  pass(() =>
    assert.equal(selection(["--reopen", ...packageArgs]).reopen, true),
  );
  pass(() =>
    assert.equal(
      selection(["--run-native", "--reopen", ...packageArgs]).mode,
      "--run-native",
    ),
  );
  reject(() => selection(["--reopen", ...args]));
  reject(() => selection(["--reopen", "--reopen", ...packageArgs]));
  reject(() => selection(packageArgs.slice(0, 4)));
  reject(() =>
    selection(packageArgs.filter((value, index) => index !== 4 && index !== 5)),
  );
  const identity = {
    sourceDirty: false,
    sourceCommit: selected.sourceSHA,
    buildId: selected.buildId,
  };
  pass(() => pins(identity, selected));
  reject(() => pins({ ...identity, sourceDirty: true }, selected));
  reject(() => pins({ ...identity, sourceCommit: "d".repeat(40) }, selected));
  reject(() => pins({ ...identity, buildId: "d".repeat(64) }, selected));
  const settings = {
    computer: {
      computerId: "computer-test",
      name: "Startup regression computer",
      generation: 2,
      workspaces: [],
    },
    setup: { computer: { verified: null }, chatgpt: { verified: null } },
  };
  pass(() => retainedSettings(structuredClone(settings), settings));
  for (const mutation of [
    { computerId: "replacement" },
    { name: "reset" },
    { generation: 1 },
    { workspaces: [{}] },
  ])
    reject(() =>
      retainedSettings(
        { ...settings, computer: { ...settings.computer, ...mutation } },
        settings,
      ),
    );
  for (const key of ["computer", "chatgpt"])
    reject(() =>
      retainedSettings(
        {
          ...settings,
          setup: { ...settings.setup, [key]: { verified: true } },
        },
        settings,
      ),
    );
  const physical = { Device: "1", Inode: "2", OwnerUID: "501" };
  const journal = {
    version: 2,
    root: { Device: 1, Inode: 2, OwnerUID: 501 },
    scope: { ProfileID: profile.profileId, BackendGeneration: "first" },
    incarnations: ["first"],
    writes: [],
    retirement: null,
  };
  const successor = {
    ...journal,
    scope: { ...journal.scope, BackendGeneration: "second" },
    incarnations: ["first", "second"],
  };
  const retired = (value) => ({
    ...value,
    retirement: {
      Scope: value.scope,
      Root: value.root,
      PreviousRevision: 0,
      Revision: 1,
      Turns: [],
    },
  });
  pass(() => journalWitness(journal, profile.profileId, physical));
  pass(() =>
    journalWitness(
      retired(journal),
      profile.profileId,
      physical,
      undefined,
      true,
    ),
  );
  pass(() => journalWitness(successor, profile.profileId, physical, journal));
  pass(() =>
    journalWitness(
      retired(successor),
      profile.profileId,
      physical,
      journal,
      true,
    ),
  );
  for (const mutation of [
    { version: 1 },
    { scope: { ...journal.scope, ProfileID: "other" } },
    { scope: { ...journal.scope, BackendGeneration: "" } },
    { root: { ...journal.root, Inode: 3 } },
    { root: { ...journal.root, Device: Number.MAX_SAFE_INTEGER + 1 } },
    { writes: [{}] },
    { incarnations: [] },
    { retirement: retired(journal).retirement },
  ])
    reject(() =>
      journalWitness({ ...journal, ...mutation }, profile.profileId, physical),
    );
  reject(() =>
    journalWitness(
      { ...successor, scope: journal.scope, incarnations: ["first", "first"] },
      profile.profileId,
      physical,
      journal,
    ),
  );
  reject(() =>
    journalWitness(
      { ...successor, incarnations: ["second"] },
      profile.profileId,
      physical,
      journal,
    ),
  );
  reject(() =>
    journalWitness(successor, profile.profileId, physical, journal, true),
  );
  for (const mutation of [
    { Scope: successor.scope },
    { Root: { ...journal.root, Inode: 3 } },
    { PreviousRevision: 1 },
    { Revision: 2 },
    { Turns: [{}] },
  ])
    reject(() =>
      journalWitness(
        {
          ...retired(journal),
          retirement: { ...retired(journal).retirement, ...mutation },
        },
        profile.profileId,
        physical,
        undefined,
        true,
      ),
    );
  const quit = {
    schema: 1,
    at: "2026-10-04T12:00:01.000Z",
    drained: true,
    unconfirmed: [],
  };
  const marker = { startedAt: "2026-10-04T12:00:00.000Z" };
  pass(() => quitWitness(quit, marker));
  pass(() =>
    quitWitness(
      { ...quit, at: "2026-10-04T12:00:03.000Z" },
      { startedAt: "2026-10-04T12:00:02.000Z" },
      quit,
    ),
  );
  for (const mutation of [
    { schema: 2 },
    { drained: false },
    { unconfirmed: ["go-core"] },
    { at: "invalid" },
    { at: "2026-10-04T11:59:59.000Z" },
  ])
    reject(() => quitWitness({ ...quit, ...mutation }, marker));
  reject(() => quitWitness(quit, marker, quit));
  const publication = {
    Binding: {
      ...journal.scope,
      BuildID: "b".repeat(64),
      ParentRoot: journal.root,
      ChatRoot: journal.root,
      HostLifetimeID: "first-host",
      ChildLaunchID: "first-child",
    },
  };
  const handoff = {
    Version: 1,
    Origin: "LIVE_OWNER_CALLBACK",
    Stage: "CHILD_TERMINATED",
    Publication: publication,
    ACK: { Publication: publication },
    Terminal: {
      Publication: publication,
      Kind: "NORMAL_EXIT",
      StopMode: "GRACEFUL_STOP",
      ExitCode: 0,
      Signal: "",
    },
    Consumption: null,
  };
  const consumed = {
    ...handoff,
    Stage: "SUCCESSOR_CONSUMED",
    Consumption: {
      PreviousHostDrainConfirmed: true,
      Next: successor.scope,
      NextBinding: {
        ...publication.Binding,
        BackendGeneration: "second",
        HostLifetimeID: "second-host",
        ChildLaunchID: "second-child",
      },
    },
  };
  pass(() =>
    handoffWitness(handoff, journal.scope, publication.Binding.BuildID),
  );
  pass(() =>
    handoffWitness(
      consumed,
      successor.scope,
      publication.Binding.BuildID,
      handoff,
    ),
  );
  for (const mutation of [
    { Version: 2 },
    { Origin: "JOURNAL_REPLAY" },
    { Stage: "HOST_ACKNOWLEDGED" },
    { Stage: "child_terminated" },
    { ACK: null },
    { Consumption: {} },
    { Terminal: { ...handoff.Terminal, StopMode: "FORCED_STOP" } },
    { Terminal: { ...handoff.Terminal, ExitCode: 1 } },
    { Terminal: { ...handoff.Terminal, Signal: "SIGKILL" } },
  ])
    reject(() =>
      handoffWitness(
        { ...handoff, ...mutation },
        journal.scope,
        publication.Binding.BuildID,
      ),
    );
  reject(() => handoffWitness(handoff, journal.scope, "wrong-build"));
  for (const mutation of [
    { PreviousHostDrainConfirmed: false },
    { Next: journal.scope },
    {
      NextBinding: {
        ...consumed.Consumption.NextBinding,
        HostLifetimeID: "first-host",
      },
    },
    {
      NextBinding: {
        ...consumed.Consumption.NextBinding,
        ChildLaunchID: "first-child",
      },
    },
    {
      NextBinding: {
        ...consumed.Consumption.NextBinding,
        BuildID: "wrong-build",
      },
    },
  ])
    reject(() =>
      handoffWitness(
        { ...consumed, Consumption: { ...consumed.Consumption, ...mutation } },
        successor.scope,
        publication.Binding.BuildID,
        handoff,
      ),
    );
  const launch = {
    status: "confirmed-clean-quit",
    cleanup,
    quitReceipt: { value: quit },
    retiredJournal: { value: retired(journal) },
    terminalHandoff: { value: { Stage: "CHILD_TERMINATED" } },
    terminalLedger: ledger,
  };
  pass(() => permitReopen(launch));
  for (const status of [
    "launch-attempted",
    "ready",
    "quit-requested",
    "failed-or-unknown",
    "refused",
  ])
    reject(() => permitReopen({ ...launch, status }));
  for (const key of Object.keys(cleanup).filter((key) => key !== "siteClosed"))
    reject(() =>
      permitReopen({
        ...launch,
        cleanup: { ...cleanup, [key]: key === "signal" ? "SIGKILL" : null },
      }),
    );
  for (const key of ["quitReceipt", "retiredJournal", "terminalHandoff"])
    reject(() => permitReopen({ ...launch, [key]: undefined }));
  reject(() =>
    permitReopen({
      ...launch,
      terminalLedger: { ...ledger, attemptedSends: 1 },
    }),
  );
  readWitnessSelfTest(pass, reject);
  settingsWitnessSelfTest(pass, reject, readCanary.relativePath);
  readAccountSelfTest(pass, reject);
  const accountArgs = [
    "--read-account",
    "--read-discard",
    "--reopen",
    ...packageArgs,
  ];
  pass(() => assert.equal(selection(accountArgs).readAccount, true));
  pass(() => assert.equal(selection(args).readAccount, false));
  pass(() =>
    assert.equal(
      selection(["--run-native", ...accountArgs]).mode,
      "--run-native",
    ),
  );
  for (const invalid of [
    ["--read-account", ...packageArgs],
    ["--read-account", "--reopen", ...packageArgs],
    ["--read-account", "--read-discard", ...packageArgs],
    ["--read-account", "--read-discard", "--reopen", ...args],
    ["--read-account", ...accountArgs],
  ])
    reject(() => selection(invalid));
  pass(() =>
    assert.equal(
      selection(["--read-discard", "--reopen", ...packageArgs]).readDiscard,
      true,
    ),
  );
  pass(() => assert.equal(selection(args).readDiscard, false));
  reject(() => selection(["--read-discard", ...packageArgs]));
  reject(() => selection(["--read-discard", "--reopen", ...args]));
  reject(() =>
    selection(["--read-discard", "--read-discard", "--reopen", ...packageArgs]),
  );
  const snapshotChecksStart = checks;
  snapshotWitnessSelfTest(pass, reject);
  const snapshotArgs = [
    "--edit-snapshot",
    "--read-discard",
    "--reopen",
    ...packageArgs,
  ];
  pass(() => assert.equal(selection(snapshotArgs).editSnapshot, true));
  pass(() =>
    assert.equal(
      selection(["--edit-snapshot", ...accountArgs]).readAccount,
      true,
    ),
  );
  pass(() => assert.equal(selection(args).editSnapshot, false));
  pass(() =>
    assert.equal(
      selection(["--run-native", ...snapshotArgs]).mode,
      "--run-native",
    ),
  );
  for (const invalid of [
    ["--edit-snapshot", ...packageArgs],
    ["--edit-snapshot", "--reopen", ...packageArgs],
    ["--edit-snapshot", "--read-discard", ...packageArgs],
    ["--edit-snapshot", "--read-discard", "--reopen", ...args],
    ["--edit-snapshot", ...snapshotArgs],
  ])
    reject(() => selection(invalid));
  process.stdout.write(
    `Go startup harness browser-free contract checks: ${checks} passed (${checks - snapshotChecksStart} edit-snapshot); native NOT RUN\n`,
  );
}

async function main(args) {
  const selected = selection(args);
  const report = {
    contract,
    scenario: selected.editSnapshot
      ? `${contract.editSnapshot}; ${selected.readAccount ? contract.readAccount : contract.readDiscard}`
      : selected.readAccount
        ? contract.readAccount
        : selected.readDiscard
          ? contract.readDiscard
          : contract.scenario,
    missingWitnesses: selected.readAccount
      ? [...contract.readDiscardLimits, ...readAccountLimits]
      : selected.readDiscard
        ? contract.readDiscardLimits
        : contract.missingWitnesses,
    isolation: selected.readDiscard
      ? "Private disposable workspace/HOME/AppData with existing E2E dialog seams and all windows hidden/unfocused; Settings executor origin requires exact production-source review; no hermetic all-paths claim"
      : contract.isolation,
    selection: selected,
    status: "checking",
    nativeRun: false,
    snapshots: [],
    windows: [],
    cleanup: null,
    launches: [],
    journals: [],
    handoffs: [],
  };
  const output = path.join(root, "_output/evidence");
  await fs.mkdir(output, { recursive: true });
  const reportPath = path.join(output, `go-core-startup-${randomUUID()}.json`);
  const save = async () => {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  };
  try {
    report.harnessSource = sourceIdentity(root);
    assert.equal(
      report.harnessSource.dirty,
      false,
      "HARNESS_SOURCE_NOT_COMMITTED_EXACT",
    );
    report.harnessSHA = hash(await regular(fileURLToPath(import.meta.url)));
    report.readWitnessSourceSHA = hash(
      await regular(
        new URL("./fixtures/go-read-discard-witness.mjs", import.meta.url),
      ),
    );
    report.settingsWitnessSourceSHA = hash(
      await regular(
        new URL("./lib/computer-settings-witness.mjs", import.meta.url),
      ),
    );
    if (selected.editSnapshot) {
      report.snapshotWitnessSourceSHA = hash(
        await regular(
          new URL("./lib/settings-snapshot-witness.mjs", import.meta.url),
        ),
      );
      report.missingWitnesses = [
        ...report.missingWitnesses,
        ...snapshotLimits,
        "React guarded-edit Prepare/Cancel controls absent; actual edit UI remains a higher acceptance gate",
      ];
    }
    if (selected.readAccount)
      report.readAccountWitnessSourceSHA = hash(
        await regular(
          new URL("./lib/read-account-ui-witness.mjs", import.meta.url),
        ),
      );
    report.attestation = await attest(selected);
    if (selected.mode === "--check") report.status = "checked-native-not-run";
    else {
      report.nativeRun = true;
      await native(selected, report.attestation, report, save);
      const after = await attest(selected);
      assert.deepEqual(
        after,
        report.attestation,
        "ARTIFACT_CHANGED_DURING_NATIVE_RUN",
      );
      assert.deepEqual(
        sourceIdentity(root),
        report.harnessSource,
        "HARNESS_CHANGED_DURING_NATIVE_RUN",
      );
      report.status = selected.editSnapshot
        ? selected.readAccount
          ? "passed-settings-edit-snapshot-and-react-read-account-discard-reopen-synthetic-only"
          : "passed-settings-edit-snapshot-and-read-discard-reopen-fixture-only"
        : selected.readAccount
          ? "passed-react-read-account-discard-reopen-synthetic-account-only"
          : selected.readDiscard
            ? "passed-read-preview-discard-reopen-fixture-readiness-only"
            : selected.reopen
              ? "passed-reopen-startup-zero-authority-only"
              : "passed-fresh-startup-zero-authority-only";
    }
  } catch (error) {
    report.status = "failed-or-unknown";
    report.error = String(error?.stack ?? error);
    throw error;
  } finally {
    await save();
    process.stdout.write(
      `Go startup evidence: ${reportPath} (${report.status})\n`,
    );
  }
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--contract")
  process.stdout.write(JSON.stringify(contract, null, 2) + "\n");
else if (args.length === 1 && args[0] === "--self-test") selfTest();
else await main(args);
