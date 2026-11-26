import { recordedUpdaterPorts } from "../../../apps/desktop/operations/updater";
import type { OperationsRecorder } from "../../../apps/desktop/renderer/operations-contract";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import {
  InstalledUpdater,
  type InstalledUpdaterPorts,
  type ConfirmedUpdateRestart,
  type ReadyUpdate,
  type UpdateHandoff,
} from "../../modules/release/app/installed-updater";
import {
  discoverGithubUpdate,
  downloadAndVerifyGithubUpdate,
  packageMatchesRelease,
  parseGithubReleaseManifest,
  parseRetainedGithubReleaseManifest,
} from "../../modules/release/app/github-release";
import type {
  UpdateCandidate,
  VerifiedGithubUpdate,
  ReleaseManifest,
} from "../../modules/release/domain/github-release-contract";
import { compareReleaseVersions } from "../../modules/release/domain/github-version";
import { legacyPredecessorRequiresStateRecovery } from "../../modules/release/domain/predecessor-state";
import {
  AutomaticUpdatePreferenceResultSchema,
  InstallOnQuitPreferenceResultSchema,
  type NormalQuitApplyContext,
  type InstalledUpdateView,
} from "../../modules/release/contract/installed-update";
import { createGithubUpdateTransport } from "../../modules/release/infra/native/github-update-transport";
import { createUpdatePackageVerifier } from "../../modules/release/infra/native/update-package-verifier";
import {
  captureInstalledProcessStart,
  installedFarolSlot,
  installedSlotBindingBytes,
  INSTALLED_SLOT_BINDING_FILE,
  publishInstalledOperationBinding,
  type InstalledAppLocation,
  startInstalledUpdateHelper,
  type InstalledUpdateOperation,
  type InstalledUpdateLaunch,
  type InstalledUpdateHelperSelection,
  type InstalledHelperLifetime,
} from "../../modules/release/infra/native/installed-update-helper";
import {
  BuildIdentitySchema,
  canonicalBuildIdentityPayload,
  type BuildIdentity,
} from "../../pkg/build-info/identity";
import {
  createPromotionLeaseTransfer,
  promotionLeasePath,
  type PromotionLeaseHandle,
  type PromotionLeaseTransfer,
} from "./promotion-lease";
import type {
  ClosedInstalledPredecessor,
  InstalledPredecessorControl,
} from "./installed-predecessor";
import { originalPredecessorSettingsReadable } from "./beta3-state-readability";
import {
  ADOPTED_BASELINE_FILE,
  adoptedRecordFor,
  adoptionBuildEligible,
  adoptionChannel,
  publishAdoptedRecord,
  readAdoptedRecord,
  recordAbsent,
  resolveAdoptionManifest,
} from "./installed-adoption";
import { installedGoSlotBindingHelper } from "../../../apps/desktop/installed-slot-binding-helper";

import {
  captureInstalledExecutionSnapshot,
  type InstalledExecutionSnapshot,
} from "./installed-execution-snapshot";

import {
  Digest,
  UpdatePreferences,
  NoticePreferences,
  AutomaticUpdatePreferences,
  InstallOnQuitPreferences,
  AcceptedBuild,
  PromotionReceipt,
  ClosedRepairReceipt,
  ClosedRepairJournal,
  Operation,
  Retained,
  DownloadStage,
  DownloadIntent,
  SavedReceipt,
  RestoreIntent,
  ROLLED_BACK_PHASES,
  CANCELLED_PHASES,
  TARGET_PHASES,
  MAX_RECORD_BYTES,
  RelaunchHint,
  RELAUNCH_ARGUMENT,
  sameBuild,
  sameOperation,
} from "../../../apps/desktop/update/record";
import {
  canonicalOwnedDirectory,
  privateDirectory,
  readRecord,
  readRestoreIntent,
  repairDirectoryIdentity,
  writeRecord,
} from "../../../apps/desktop/update/records";
import { settleCleanupMarker } from "../../../apps/desktop/update/cleanup";
import {
  installedUpdateStartupDecision,
  startupHelperState,
} from "../../../apps/desktop/update/decision";
import { createPreferences } from "../../../apps/desktop/update/preference";
import { observeHelper } from "../../../apps/desktop/update/process";
import { createRelaunchWait } from "../../../apps/desktop/update/wait";
import {
  createStartup,
  type InstalledUpdateRelaunchGuard,
  type InstalledUpdateRelaunchOptions,
  type InstalledUpdateResourcesOrigin,
} from "../../../apps/desktop/update/startup";
import {
  createAdmissionGate,
  recheckAdmission,
  type Admission,
} from "../../../apps/desktop/update/admission";
import {
  applyEntryRefusal,
  applyRolledBack,
  applyUnsettledCode,
  candidateDeferred,
  candidateSkipped,
  claimableInterruptedDownload,
  classifyPackageVerification,
  confirmationStale,
  downloadFailureCode,
  downloadIntentConflicts,
  downloadRecoveryAtStartup,
  downloadStageIdentityChanged,
  emptyRecoveryOutcome,
  handoffAdmitted,
  helperNoEffectCode,
  historicalReceiptSuperseded,
  increasingRelease,
  prepareFailureHandoff,
  preparationUnreconciled,
  quitDeadlineExpired,
  quitFailureHandoff,
  quitTimerDelayMs,
  readinessTimeoutMs,
  restoreExitWitnessApplies,
  restoreFailureHandoff,
  restoreNotStartedMismatch,
  retainedBuildRelation,
  retainedReadyReclaimable,
  rollbackVersionFor,
  settledReceiptUnchanged,
  startupSettlement,
  unadmittedHandoff,
  verificationHandoff,
  verificationRefusalCode,
} from "../../../apps/desktop/update/stage";

export { installedUpdateStartupDecision };
export type {
  InstalledUpdateRelaunchGuard,
  InstalledUpdateRelaunchOptions,
  InstalledUpdateResourcesOrigin,
};

const execute = promisify(execFile);

function isIncreasingUpdate(
  manifest: Pick<ReleaseManifest, "version" | "buildVersion">,
  currentVersion: string,
  currentBuildVersion: string,
): boolean {
  return increasingRelease(
    compareReleaseVersions(manifest.version, currentVersion),
    manifest.buildVersion,
    currentBuildVersion,
  );
}

async function runInstalledTrusted(
  directory: string,
  entry: string,
  args: string[],
  timeout = 180000,
  execution?: InstalledExecutionSnapshot,
  beforeEffect: () => void = () => undefined,
): Promise<unknown> {
  await execution?.recheck();
  beforeEffect();
  const { stdout } = await execute(
    execution?.executable ?? process.execPath,
    [path.join(execution?.directory ?? directory, entry), ...args],
    {
      env: {
        PATH: "/usr/bin:/bin",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ASAR: "1",
      },
      encoding: "utf8",
      maxBuffer: 65536,
      timeout,
    },
  );
  return JSON.parse(stdout) as unknown;
}

export async function readInstalledProcess(
  pid: number,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    timeout: 3000,
    maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
}

const observeInstalledHelper = (
  helper: z.infer<typeof Retained>["helper"],
  read: typeof readInstalledProcess = readInstalledProcess,
): Promise<"live" | "ended" | "unknown"> => observeHelper(helper, read);

// The startup observation lives in `apps/desktop/update/startup.ts`. These are
// the ports it needs from the release module and the one pinned `ps` read.
const {
  readOperationBinding,
  readOperationJournal,
  readStartupOperationJournal,
  recheckSharedUpdateSource,
  readInstallerManifestForStartup,
  observeSharedSlotStartup,
  observeCompletedPrivateLaunch,
} = createStartup({
  slotBinding: {
    file: INSTALLED_SLOT_BINDING_FILE,
    bytes: (operation, location) =>
      installedSlotBindingBytes(operation, location),
  },
  retained: (record) => parseRetainedGithubReleaseManifest(record),
  compareVersions: (left, right) => compareReleaseVersions(left, right),
  adoptionManifest: ({ build, root }) => {
    const transport = createGithubUpdateTransport({
      privateStateDirectory: root,
      verifyPackage: async () => {
        throw new Error("UPDATE_ADOPTION_PACKAGE_UNUSED");
      },
    });
    return resolveAdoptionManifest({
      build,
      fetchJson: (url, maximum) => transport.fetchJson(url, maximum),
    });
  },
  readProcess: (pid) => readInstalledProcess(pid),
});

/** Observe one explicit updater relaunch before the first startup lease acquire. */
export async function waitForInstalledUpdateRelaunch(
  options: InstalledUpdateRelaunchOptions,
): Promise<InstalledUpdateRelaunchGuard | null> {
  const hints = options.args.filter(
    (arg) =>
      arg === RELAUNCH_ARGUMENT || arg.startsWith(RELAUNCH_ARGUMENT + "="),
  );
  if (hints.length === 0)
    return (
      (await observeSharedSlotStartup(options)) ??
      observeCompletedPrivateLaunch(options)
    );
  const argument = hints[0]!;
  if (hints.length !== 1 || !argument.startsWith(RELAUNCH_ARGUMENT + "="))
    throw new Error("UPDATE_RELAUNCH_HINT_INVALID");
  const json = argument.slice(RELAUNCH_ARGUMENT.length + 1);
  if (Buffer.byteLength(json, "utf8") > 2048)
    throw new Error("UPDATE_RELAUNCH_HINT_INVALID");
  let hint: z.infer<typeof RelaunchHint>;
  try {
    hint = RelaunchHint.parse(JSON.parse(json) as unknown);
  } catch {
    throw new Error("UPDATE_RELAUNCH_HINT_INVALID");
  }
  const build = BuildIdentitySchema.parse(options.build);
  const profile = path.join(
    os.userInfo().homedir,
    "Library/Application Support/io.github.legrch.farol",
  );
  const root = path.join(profile, "installed-updates");
  const actualApp = path.resolve(options.directory, "../../..");
  const privateApp = path.join(root, hint.operationId, "launch-Farol.app");
  const privateLaunch = actualApp === privateApp;
  if (privateLaunch && hint.phase !== "completed")
    throw new Error("UPDATE_RELAUNCH_HINT_INVALID");
  const slot = privateLaunch
    ? "/Applications/Farol.app"
    : installedFarolSlot(options.directory);
  const directory = path.join(
    privateLaunch ? privateApp : slot,
    "Contents/Resources/app",
  );
  if (
    options.userData !== profile ||
    options.directory !== directory ||
    !["github-owner-beta", "github-stable"].includes(build.updateChannel) ||
    !build.buildVersion ||
    build.sourceDirty ||
    hint.buildId !== build.buildId ||
    createHash("sha256")
      .update(canonicalBuildIdentityPayload(build))
      .digest("hex") !== build.buildId
  )
    throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
  if (
    (hint.action === "apply" &&
      !["completed", "rollback_completed"].includes(hint.phase)) ||
    (hint.action === "rollback" && hint.phase !== "rollback_completed")
  )
    throw new Error("UPDATE_RELAUNCH_HINT_INVALID");
  const budgets = createRelaunchWait(options, {
    now: options.now ?? (() => performance.now()),
    pause:
      options.pause ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  });
  let execution: Promise<InstalledExecutionSnapshot> | undefined;
  const reads: NonNullable<InstalledUpdateRelaunchOptions["observation"]> =
    options.observation ?? {
      canonicalOwnedDirectory,
      readRecord,
      readBuild: async (
        appDirectory: string,
        file: string,
        remaining: number,
      ) => {
        if (slot === "/Applications/Farol.app") {
          if (!pinned || !options.copyApp || !options.physicalFiles)
            throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
          const expected =
            hint.phase === "completed" ? pinned.target : pinned.source;
          execution ??= captureInstalledExecutionSnapshot({
            sourceApp: actualApp,
            sourceExecutable: process.execPath,
            privateParent: root,
            expectedDigest: expected.digest,
            copyApp: options.copyApp,
            physicalFiles: options.physicalFiles,
          });
        }
        return runInstalledTrusted(
          appDirectory,
          "update-slot.mjs",
          [file],
          remaining,
          execution ? await execution : undefined,
        );
      },
      readProcess: readInstalledProcess,
    };
  const receiptFile = path.join(
    root,
    hint.action === "apply" ? "ready.json" : "restore-pending.json",
  );
  let pinned: z.infer<typeof Operation> | undefined;

  const observe = async (wait: boolean): Promise<void> => {
    const { remaining, bounded, sleep } = budgets.begin();
    if (slot === "/Applications/Farol.app")
      await bounded(() =>
        readInstallerManifestForStartup(options, profile, build),
      );
    const routes = async () => {
      for (const [route, privateMode] of [
        [path.dirname(slot), false],
        [slot, false],
        [directory, false],
        [path.dirname(profile), false],
        [profile, true],
        [root, true],
      ] as const)
        await bounded(() => reads.canonicalOwnedDirectory(route, privateMode));
      const operation = pinned;
      if (operation)
        await bounded(() =>
          reads.canonicalOwnedDirectory(
            path.join(root, operation.operationId),
            true,
          ),
        );
    };
    const correlate = async () => {
      await routes();
      const restoreAbsent = reads.recordAbsent ?? recordAbsent;
      const restoreRecord = (file: string) =>
        bounded(() => readRestoreIntent(file, reads.readRecord, restoreAbsent));
      let receipt: z.infer<typeof Retained> | z.infer<typeof RestoreIntent>;
      if (hint.action === "apply") {
        const raw = await bounded(() => reads.readRecord(receiptFile));
        // A restore record supersedes an apply hint; a null or malformed one is
        // invalid evidence and is classified as such, not as a mismatch.
        if (await restoreRecord(path.join(root, "restore-pending.json")))
          throw new Error("UPDATE_RELAUNCH_RECEIPT_MISMATCH");
        receipt = Retained.parse(raw);
      } else {
        const intent = await restoreRecord(receiptFile);
        if (!intent) throw new Error("UPDATE_RELAUNCH_RECEIPT_MISMATCH");
        receipt = intent;
      }
      const op = receipt.operation;
      if (
        !op ||
        op.operationId !== hint.operationId ||
        !receipt.helper ||
        receipt.helper.pid !== hint.helper.pid ||
        receipt.helper.processStart !== hint.helper.processStart ||
        (hint.action !== "apply" &&
          (!("action" in receipt) ||
            receipt.action !== hint.action ||
            "notStartedAt" in receipt)) ||
        (pinned && !sameOperation(pinned, op))
      )
        throw new Error("UPDATE_RELAUNCH_RECEIPT_MISMATCH");
      if ("preparation" in receipt && receipt.preparation)
        throw new Error("UPDATE_RELAUNCH_RECEIPT_MISMATCH");
      pinned ??= Operation.parse(op);
      await bounded(() =>
        reads.canonicalOwnedDirectory(
          path.join(root, pinned!.operationId),
          true,
        ),
      );
      await bounded(() =>
        readOperationBinding(
          root,
          pinned!,
          slot === "/Applications/Farol.app" ? "shared" : "legacy",
          reads.readRecord,
        ),
      );
      const expected =
        hint.phase === "completed" ? pinned.target : pinned.source;
      if (
        expected.buildId !== build.buildId ||
        expected.version !== build.version ||
        pinned.source.buildId === pinned.target.buildId ||
        pinned.source.digest === pinned.target.digest
      )
        throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
      // Read the journal after process observation: a confirmed exit must see
      // the completion written before that exit, not an earlier launch intent.
      const helper = await bounded(() =>
        observeInstalledHelper(hint.helper, reads.readProcess),
      );
      const journal = await bounded(() =>
        readStartupOperationJournal(
          root,
          pinned!,
          slot === "/Applications/Farol.app" ? "shared" : "legacy",
          reads.readRecord,
          "update",
          reads.recordAbsent ?? recordAbsent,
        ),
      );
      if (helper === "unknown")
        throw new Error("UPDATE_RELAUNCH_HELPER_UNCONFIRMED");
      return { journal, helper };
    };
    const physical = async () => {
      const expected =
        hint.phase === "completed" ? pinned!.target : pinned!.source;
      const stored = BuildIdentitySchema.parse(
        await bounded(() =>
          reads.readRecord(path.join(directory, "build-identity.json"), false),
        ),
      );
      if (
        stored.buildId !== build.buildId ||
        canonicalBuildIdentityPayload(stored) !==
          canonicalBuildIdentityPayload(build) ||
        !sameBuild(
          AcceptedBuild.parse(
            await bounded(() => reads.readBuild(directory, slot, remaining())),
          ),
          expected,
        )
      )
        throw new Error("UPDATE_RELAUNCH_PHYSICAL_PAIR_CHANGED");
    };
    for (;;) {
      const result = await correlate();
      if (result.helper === "live") {
        if (!wait) throw new Error("UPDATE_RELAUNCH_COMPLETION_UNCONFIRMED");
        await sleep();
        continue;
      }
      // Never replay an uncertain open. Once the helper has ended, the same
      // content decision admits both interrupted and already settled journals.
      await physical();
      const expected =
        hint.phase === "completed" ? pinned!.target : pinned!.source;
      const installed = AcceptedBuild.parse(
        await bounded(() => reads.readBuild(directory, slot, remaining())),
      );
      const decision = installedUpdateStartupDecision({
        phase: result.journal?.phase ?? null,
        helper: startupHelperState(result.helper),
        installed,
        running: build,
        operation: pinned!,
      });
      if (!decision.mayStart || !sameBuild(installed, expected))
        throw new Error("UPDATE_RELAUNCH_PHYSICAL_PAIR_CHANGED");
      const final = await correlate();
      if (
        final.helper === "live" ||
        final.journal?.phase !== result.journal?.phase
      )
        throw new Error("UPDATE_RELAUNCH_COMPLETION_UNCONFIRMED");
      return;
    }
  };
  await observe(true);
  // The caller invokes this under its existing lease before readiness/marker.
  if (slot === "/Applications/Farol.app") {
    if (!pinned || !options.copyApp || !options.physicalFiles)
      throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    const operation = pinned;
    const expected =
      hint.phase === "completed" ? operation.target : operation.source;
    execution ??= captureInstalledExecutionSnapshot({
      sourceApp: actualApp,
      sourceExecutable: process.execPath,
      privateParent: root,
      expectedDigest: expected.digest,
      copyApp: options.copyApp,
      physicalFiles: options.physicalFiles,
    });
    const captured = await execution;
    if (captured.digest !== expected.digest)
      throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    const resourcesOrigin: InstalledUpdateResourcesOrigin = Object.freeze({
      ...(privateLaunch
        ? {
            kind: "private-launch" as const,
            operationId: operation.operationId,
          }
        : { kind: "shared-slot" as const }),
      slot: "/Applications/Farol.app",
      app: actualApp,
      execution: captured,
      recheckUpdateSource: () => recheckSharedUpdateSource(options, expected),
      recheck: async () => {
        // The Ready receipt is consumed by initialization. Executable authority
        // subsequently binds the immutable original operation and private bytes,
        // not that mutable receipt or another public-slot pathname.
        await readOperationBinding(root, operation, "shared", reads.readRecord);
        await captured.recheck();
      },
    });
    return Object.freeze({ recheck: () => observe(false), resourcesOrigin });
  }
  return Object.freeze({ recheck: () => observe(false) });
}

// Preserve the exact prior receipt before a different OTA replaces its active
// name. Publication is exclusive; a previous identical archive is re-synced
// before use so an interrupted sync may be safely checked on the next launch.
async function archivePreviousReceipt(
  root: string,
  receiptFile: string,
  nextOperation: z.infer<typeof Operation>,
): Promise<void> {
  let digest: string | undefined;
  let original: Buffer | undefined;
  const raw = await readRecord(
    receiptFile,
    true,
    (value) => {
      digest = value;
    },
    MAX_RECORD_BYTES,
    (value) => {
      original = value;
    },
  );
  if (raw === null) {
    if (!(await recordAbsent(receiptFile)))
      throw new Error("invalid history archive");
    return;
  }
  const previous = SavedReceipt.parse(raw);
  if (!previous.operation || !original || !digest)
    throw new Error("invalid history archive");
  if (sameOperation(previous.operation, nextOperation)) return;
  const settledBuild =
    previous.phase === "completed"
      ? previous.operation.target
      : previous.phase === "rolled_back"
        ? previous.operation.source
        : null;
  const directPredecessor =
    previous.runningBuildId === nextOperation.source.buildId &&
    [previous.operation.source, previous.operation.target].some((value) =>
      sameBuild(value, nextOperation.source),
    );
  // A verified manual replacement may sit between two OTA operations. Its
  // source identity is anchored by the adopted baseline and the next OTA's
  // admission; the older terminal receipt remains history, not its source.
  const manualPredecessor =
    settledBuild !== null &&
    previous.runningBuildId === settledBuild.buildId &&
    compareReleaseVersions(
      nextOperation.source.version,
      previous.operation.target.version,
    ) === 1;
  if (
    previous.operation.operationId === nextOperation.operationId ||
    (!directPredecessor && !manualPredecessor)
  )
    throw new Error("invalid history archive");
  const directory = path.join(root, previous.operation.operationId);
  await canonicalOwnedDirectory(root, true);
  await canonicalOwnedDirectory(directory, true);
  const archive = path.join(directory, "settled-receipt.json");
  let exists = true;
  try {
    await fs.lstat(archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (!exists) {
    const temporary = path.join(
      directory,
      `.settled-receipt-${randomBytes(12).toString("hex")}`,
    );
    let created = false;
    try {
      const fd = await fs.open(temporary, "wx", 0o600);
      created = true;
      try {
        await fd.writeFile(original);
        await fd.sync();
      } finally {
        await fd.close();
      }
      try {
        await fs.link(temporary, archive);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      if (created) await fs.unlink(temporary);
    }
  }
  const before = await fs.lstat(archive);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o077) !== 0 ||
    before.size !== original.length
  )
    throw new Error("invalid history archive");
  const fd = await fs.open(
    archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await fd.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("history archive changed");
    const copied = await fd.readFile();
    if (!copied.equals(original)) throw new Error("history archive conflict");
    await fd.sync();
  } finally {
    await fd.close();
  }
  const after = await fs.lstat(archive);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    after.mode !== before.mode ||
    after.uid !== before.uid
  )
    throw new Error("history archive changed");
  const parent = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  let currentDigest: string | undefined;
  await readRecord(receiptFile, true, (value) => {
    currentDigest = value;
  });
  if (currentDigest !== digest) throw new Error("history archive changed");
}

// A refusal acknowledgment alone is not a terminal process observation. Keep
// every uncertain child bound; only its exact pre-mutation exit permits retry.
async function confirmedNoEffect(
  handoff: InstalledUpdateLaunch,
): Promise<boolean> {
  if (handoff.status !== "refused" && handoff.status !== "not_started")
    return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const terminal = await Promise.race([
      handoff.operation.completion,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      }),
    ]);
    if (handoff.status === "not_started")
      return (
        handoff.operation.pid === null &&
        terminal !== null &&
        (handoff.reason === "helper_spawn_failed"
          ? terminal.code !== null && terminal.code < 0
          : terminal.code === null) &&
        terminal.signal === null &&
        terminal.terminal === null &&
        terminal.protocolError === handoff.reason
      );
    return (
      terminal?.code === 70 &&
      terminal.signal === null &&
      terminal.protocolError === null &&
      terminal.terminal?.phase === "refused" &&
      terminal.terminal.error === handoff.reason
    );
  } finally {
    clearTimeout(timer);
  }
}

export type InstalledUpdateAdmission = Admission;
export type InstalledUpdateRuntimeOptions = Readonly<{
  /** Explicit test presentation from trusted process argv only. */
  relaunchPresentation?: "sidecar-only";
  helperLifetime?: InstalledHelperLifetime;
  operations?: OperationsRecorder;
  directory: string;
  userData: string;
  build: BuildIdentity;
  // Independent builder declaration from the trusted host. Absent only for a
  // legacy build, which no longer updates: the Go release helpers are the only
  // update path and a selected Go failure never falls back to Python.
  goCoreArtifact?: unknown;
  // The build that declaration belongs to when it is not the running build:
  // the supervised controller executes the accepted target package's helper.
  goCoreBuild?: BuildIdentity;
  // Selected by the trusted supervisory caller, never renderer request data.
  // This is a source for the existing staging/retention owner, not a Ready record.
  localArchive?: Readonly<{ path: string; manifest: unknown }>;
  // Electron must copy physical ASAR files, not its virtual archive filesystem.
  copyApp(source: string, destination: string): Promise<void>;
  physicalFiles?: typeof fs;
  // Only the host's fully correlated private relaunch can supply this origin.
  resourcesOrigin?: InstalledUpdateResourcesOrigin;
  // Removal has the same physical ASAR boundary as copying a package.
  removeDirectory(directory: string, force: boolean): Promise<void>;
  // Evaluate this existing durable report while admission is held, before
  // stopping clients. The runtime also rechecks it after the drain.
  acquireAdmission(
    desktopWorkSettled: () => Promise<boolean>,
    quit?: NormalQuitApplyContext,
    confirmation?: ConfirmedUpdateRestart,
  ): Promise<InstalledUpdateAdmission>;
  // Bound to the current normal-Quit hook lifetime, never wire/request data.
  // The host closes this fence before destructive collection or hook settlement.
  canStartNormalQuitEffect?(): boolean;
  quit(): void;
  publish(view: InstalledUpdateView): void;
}>;

/**
 * Returns the single release owner. After initialize(), composition uses
 * scheduledCheck() for startup/periodic checks and check(true) for explicit
 * checks. Only explicit download-and-install consent permits scheduled idle
 * installation; legacy automatic-download consent never does. close() drains
 * any download/retention already dispatched by that owner.
 */
export async function createInstalledUpdateRuntime(
  options: InstalledUpdateRuntimeOptions,
): Promise<InstalledUpdater | null> {
  return createRuntime(options);
}

export type SupervisedInstalledUpdateOptions = Omit<
  InstalledUpdateRuntimeOptions,
  "build" | "acquireAdmission" | "quit"
> &
  Readonly<{
    // Trusted controller selection of the captured installed slot; no discovery.
    installedResourcesDirectory?: string;
    predecessor: InstalledPredecessorControl;
    lease: PromotionLeaseHandle;
    // Exact original bytes copied by the existing closed-pair preservation owner.
    preservedSettingsSha256?: string | null;
    replaceReady?: Readonly<{ recordSha256: string; buildId: string }>;
    observeHelper(operation: InstalledUpdateOperation): void;
    resources: Readonly<{
      app: string;
      // The standalone controller verifies this exact accepted package using the
      // existing package verifier. A checkout directory is never sufficient.
      verify(): Promise<boolean>;
    }>;
  }>;

type SupervisedExecution = Readonly<{
  app: string;
  slot: string;
  predecessor: ClosedInstalledPredecessor;
  transfer: PromotionLeaseTransfer;
  verifyResources(): Promise<boolean>;
  observeHelper(operation: InstalledUpdateOperation): void;
  replaceReady?: Readonly<{ recordSha256: string; buildId: string }>;
}>;

/** Read-only existing Release record inspection; this grants no update authority. */
export async function observeSupervisedReadyUpdate(
  userData: string,
  expected: Readonly<{ recordSha256: string; buildId: string }>,
): Promise<boolean> {
  try {
    Digest.parse(expected.recordSha256);
    Digest.parse(expected.buildId);
    const root = path.join(userData, "installed-updates");
    await canonicalOwnedDirectory(userData, false);
    await canonicalOwnedDirectory(root, true);
    let digest: string | null = null;
    const raw = await readRecord(
      path.join(root, "ready.json"),
      true,
      (value) => {
        digest = value;
      },
    );
    const ready = Retained.parse(raw);
    const manifest = parseRetainedGithubReleaseManifest(ready);
    return (
      digest === expected.recordSha256 &&
      manifest.ok &&
      manifest.value.buildId === expected.buildId &&
      ready.operation === null &&
      ready.preparation === undefined &&
      (ready.helper === undefined || ready.helper === null) &&
      ready.archiveReleased !== true &&
      ready.downloadId !== undefined &&
      ready.handle.startsWith(
        path.join(root, `download-${ready.downloadId}`) + path.sep,
      )
    );
  } catch {
    return false;
  }
}

/** Explicit external control after a captured predecessor's confirmed Quit. */
export async function createSupervisedInstalledUpdateRuntime(
  options: SupervisedInstalledUpdateOptions,
): Promise<InstalledUpdater | null> {
  const slot =
    options.installedResourcesDirectory === undefined
      ? installedFarolSlot()
      : installedFarolSlot(options.installedResourcesDirectory);
  const profile = path.join(
    os.userInfo().homedir,
    "Library/Application Support/io.github.legrch.farol",
  );
  const resources = {
    app: options.resources.app,
    verify: options.resources.verify.bind(options.resources),
  };
  if (
    options.userData !== profile ||
    options.lease.file !== promotionLeasePath(profile) ||
    resources.app === slot ||
    resources.app.startsWith(profile + path.sep) ||
    options.directory !== path.join(resources.app, "Contents/Resources/app")
  )
    return null;
  if (
    options.replaceReady &&
    !(await observeSupervisedReadyUpdate(profile, options.replaceReady))
  )
    return null;
  await canonicalOwnedDirectory(slot, false);
  await canonicalOwnedDirectory(resources.app, false);
  await canonicalOwnedDirectory(options.directory, false);
  if ((await resources.verify()) !== true) return null;
  const predecessor = await options.predecessor.observeClosed();
  const build = BuildIdentitySchema.parse(
    await readRecord(
      path.join(slot, "Contents/Resources/app/build-identity.json"),
      false,
    ),
  );
  if (
    createHash("sha256")
      .update(canonicalBuildIdentityPayload(build))
      .digest("hex") !== build.buildId
  )
    return null;
  // The accepted target package's own build supplies the Go helper. It must be
  // a canonical identity; the declaration is measured against it at launch.
  let goCoreBuild: BuildIdentity | undefined;
  if (options.goCoreBuild !== undefined) {
    const parsed = BuildIdentitySchema.safeParse(options.goCoreBuild);
    if (
      !parsed.success ||
      createHash("sha256")
        .update(canonicalBuildIdentityPayload(parsed.data))
        .digest("hex") !== parsed.data.buildId
    )
      return null;
    goCoreBuild = parsed.data;
  }
  const verifyOriginalState = async () => {
    if (build.version !== "0.2.0-owner.beta.3") return true;
    if (!Digest.safeParse(options.preservedSettingsSha256).success)
      return false;
    await canonicalOwnedDirectory(path.join(profile, "farol-state"), true);
    let digest: string | null = null;
    const config = await readRecord(
      path.join(profile, "farol-state/config.json"),
      true,
      (value) => {
        digest = value;
      },
      256 * 1024, // Existing ProductSettingsStore byte bound, not updater-record size.
    );
    if (
      digest !== options.preservedSettingsSha256 ||
      !originalPredecessorSettingsReadable(
        { version: build.version, sourceCommit: build.sourceCommit },
        config,
      )
    )
      return false;
    // Beta3's strict Retained/SavedReceipt readers do not accept notes. Local
    // preparation adds none; inspect actual records again before dispatch.
    for (const name of ["ready.json", "last-update.json"]) {
      const raw = await readRecord(
        path.join(profile, "installed-updates", name),
      );
      if (raw === null) continue;
      const record =
        name === "ready.json" ? Retained.parse(raw) : SavedReceipt.parse(raw);
      if (record.notes !== undefined) return false;
    }
    await canonicalOwnedDirectory(path.join(profile, "farol-state"), true);
    return true;
  };
  if (!(await verifyOriginalState())) return null;
  const transfer = await createPromotionLeaseTransfer(options.lease);
  const expectedProof = JSON.stringify(predecessor);
  let admitted = false;
  const recheck = async () => {
    try {
      if (
        (await transfer.verify()) !== true ||
        (await resources.verify()) !== true ||
        !(await verifyOriginalState()) ||
        JSON.stringify(await options.predecessor.observeClosed()) !==
          expectedProof
      ) {
        return { ok: false as const, code: "UPDATE_SUPERVISOR_UNCONFIRMED" };
      }
      return { ok: true as const };
    } catch {
      return { ok: false as const, code: "UPDATE_SUPERVISOR_UNCONFIRMED" };
    }
  };
  return createRuntime(
    {
      ...options,
      build,
      ...(goCoreBuild ? { goCoreBuild } : {}),
      acquireAdmission: async (settled) => {
        if (admitted)
          return { ok: false, code: "UPDATE_SUPERVISOR_ALREADY_USED" };
        admitted = true;
        const checked = await recheck();
        if (!checked.ok) return checked;
        if (!(await settled()))
          return { ok: false, code: "UPDATE_WORK_PENDING" };
        return { ok: true, release: () => transfer.release(), recheck };
      },
      quit: () => {
        throw new Error("UPDATE_SUPERVISOR_PREDECESSOR_ALREADY_CLOSED");
      },
    },
    {
      app: resources.app,
      slot,
      predecessor,
      transfer,
      verifyResources: resources.verify,
      observeHelper: options.observeHelper,
      ...(options.replaceReady ? { replaceReady: options.replaceReady } : {}),
    },
  );
}

async function createRuntime(
  options: InstalledUpdateRuntimeOptions,
  supervised?: SupervisedExecution,
): Promise<InstalledUpdater | null> {
  const selectedLocal = options.localArchive;
  const parsedLocal = selectedLocal
    ? parseGithubReleaseManifest(selectedLocal.manifest)
    : null;
  const localArchive = selectedLocal
    ? {
        path: selectedLocal.path,
        manifest: parsedLocal?.ok
          ? Object.freeze({ ...parsedLocal.value })
          : null,
      }
    : null;
  if (
    !["github-owner-beta", "github-stable"].includes(
      options.build.updateChannel,
    ) ||
    !options.build.buildVersion ||
    options.build.sourceDirty
  )
    return null;
  let slot: string;
  try {
    slot =
      supervised?.slot ??
      options.resourcesOrigin?.slot ??
      installedFarolSlot(options.directory);
  } catch {
    return null;
  }
  const actualApp = path.resolve(options.directory, "../../..");
  const origin = options.resourcesOrigin;
  if (origin) {
    if (
      supervised ||
      origin.slot !== "/Applications/Farol.app" ||
      !["private-launch", "shared-slot"].includes(origin.kind) ||
      origin.app !== actualApp ||
      (origin.kind === "private-launch"
        ? !/^[a-f0-9]{32}$/u.test(origin.operationId) ||
          origin.app !==
            path.join(
              options.userData,
              "installed-updates",
              origin.operationId,
              "launch-Farol.app",
            )
        : origin.app !== "/Applications/Farol.app")
    )
      return null;
    await origin.recheck();
  }
  // Ordinary checkouts cannot mutate the slot. Only the separate supervisory
  // entry can supply verified controller resources and confirmed closure.
  if (
    actualApp !== (supervised?.app ?? origin?.app ?? slot) ||
    (await fs.realpath(actualApp)) !==
      (supervised?.app ?? origin?.app ?? slot) ||
    options.userData !==
      path.join(
        os.userInfo().homedir,
        "Library/Application Support/io.github.legrch.farol",
      )
  )
    return null;
  const root = path.join(options.userData, "installed-updates");
  const installLocation: InstalledAppLocation =
    slot === "/Applications/Farol.app" ? "shared" : "legacy";
  const verifyBinding = (op: z.infer<typeof Operation>) =>
    readOperationBinding(root, op, installLocation);
  await privateDirectory(root);
  let execution: Promise<InstalledExecutionSnapshot> | undefined;
  const captureExecution = async (
    expected: z.infer<typeof AcceptedBuild>,
    beforeEffect: () => void,
  ) => {
    if (installLocation !== "shared" || supervised) return;
    if (
      expected.buildId !== options.build.buildId ||
      expected.version !== options.build.version ||
      !options.physicalFiles
    )
      throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    beforeEffect();
    // A rejected/unknown capture remains rejected. Never fall back to the slot.
    if (origin) {
      await origin.recheck();
      await origin.recheckUpdateSource();
      beforeEffect();
    }
    execution ??= origin
      ? Promise.resolve(origin.execution)
      : captureInstalledExecutionSnapshot({
          sourceApp: actualApp,
          sourceExecutable: process.execPath,
          privateParent: root,
          expectedDigest: expected.digest,
          copyApp: options.copyApp,
          physicalFiles: options.physicalFiles,
        });
    const captured = await execution;
    if (captured.digest !== expected.digest)
      throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    beforeEffect();
  };
  const requireExecution = async () => {
    if (installLocation !== "shared" || supervised) return undefined;
    if (!execution) await readAcceptedSource();
    if (!execution) throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    return execution;
  };
  let bindingExecution: Promise<InstalledExecutionSnapshot> | undefined;
  const selectGoHelper = async (
    expected: z.infer<typeof AcceptedBuild>,
    beforeEffect: () => void,
  ) => {
    beforeEffect();
    let captured = await requireExecution();
    if (!captured && !supervised) {
      if (!options.physicalFiles)
        throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
      // Legacy owned slots also need an immutable image for this Go capability.
      // Reuse the existing image custody owner; never execute a mutable slot.
      bindingExecution ??= captureInstalledExecutionSnapshot({
        sourceApp: actualApp,
        sourceExecutable: process.execPath,
        privateParent: root,
        expectedDigest: expected.digest,
        copyApp: options.copyApp,
        physicalFiles: options.physicalFiles,
      });
      captured = await bindingExecution;
    }
    if (captured && captured.digest !== expected.digest)
      throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    const image = captured;
    return installedGoSlotBindingHelper({
      compiledArtifact: options.goCoreArtifact,
      build: options.goCoreBuild ?? options.build,
      directory: image?.directory ?? options.directory,
      // Resource custody only; the adapter brackets it with `beforeEffect`
      // for qualification and omits the fence for the post-close measurement.
      recheck: async () => {
        if (image) await image.recheck();
        else if (!supervised || (await supervised.verifyResources()) !== true)
          throw new Error("UPDATE_SUPERVISOR_RESOURCES_CHANGED");
      },
      beforeEffect,
    });
  };
  // Only the attested Go publisher writes the slot binding. A build without the
  // compiled Go core refuses before admission, so this guard is never reached.
  const selectBindingHelper = async (
    expected: z.infer<typeof AcceptedBuild>,
    beforeEffect: () => void,
  ) => {
    if (options.goCoreArtifact === undefined)
      throw new Error("UPDATE_HELPER_GO_CORE_REQUIRED");
    return selectGoHelper(expected, beforeEffect);
  };
  // The only update helper is the attested Go one. A legacy build refuses with a
  // closed reason and a failed qualification refuses too; neither starts Python.
  const selectUpdateHelper = async (
    expected: z.infer<typeof AcceptedBuild>,
    beforeEffect: () => void,
  ): Promise<InstalledUpdateHelperSelection> => {
    if (options.goCoreArtifact === undefined)
      return { kind: "refused", reason: "helper_go_core_required" };
    try {
      return {
        kind: "go",
        helper: await selectGoHelper(expected, beforeEffect),
      };
    } catch {
      // An expired Quit deadline is the caller's refusal, not a helper fault.
      beforeEffect();
      return { kind: "refused", reason: "helper_preflight_failed" };
    }
  };
  const context = (directory: string) => {
    const verifier = createUpdatePackageVerifier({
      archivePathForHandle: async (handle) => handle,
      stagingParent: directory,
      extractorPath: path.join(options.directory, "update-archive.py"),
      verifierPath: path.join(options.directory, "update-package.mjs"),
      removeDirectory: options.removeDirectory,
      executionResources: async () => {
        const captured = await requireExecution();
        if (!captured) return null;
        await captured.recheck();
        return {
          extractorPath: path.join(captured.directory, "update-archive.py"),
          verifierPath: path.join(captured.directory, "update-package.mjs"),
          nodeExecutable: captured.executable,
          recheck: captured.recheck,
        };
      },
    });
    const transport = createGithubUpdateTransport({
      privateStateDirectory: directory,
      verifyPackage: async (handle, manifest) => {
        if (supervised && (await supervised.verifyResources()) !== true)
          throw new Error("UPDATE_SUPERVISOR_RESOURCES_CHANGED");
        return verifier.verifyPackage(handle, manifest);
      },
    });
    return { verifier, transport };
  };
  let { verifier, transport } = context(root);
  let downloadId: string | undefined;
  let downloadsCancelled = false;
  const downloadDirectory = (id: string) => path.join(root, `download-${id}`);
  const selectDownload = async (id?: string) => {
    const directory = id === undefined ? root : downloadDirectory(id);
    await canonicalOwnedDirectory(directory, true);
    ({ verifier, transport } = context(directory));
    if (downloadsCancelled) transport.cancelPending();
    downloadId = id;
  };
  let transportOutcomeUnknown = false;
  let stagedDownloadHandle: string | null = null;
  const checkedTransport = {
    fetchJson: (url: string, maximum: number) =>
      transport.fetchJson(url, maximum),
    download: async (
      url: string,
      maximum: number,
      onProgress?: (receivedBytes: number) => void,
    ) => {
      const result = await transport.download(url, maximum, onProgress);
      if (result.ok) stagedDownloadHandle = result.value.handle;
      if (!result.ok && "certainty" in result && result.certainty === "unknown")
        transportOutcomeUnknown = true;
      return result;
    },
    verifyPackage: async (
      handle: string,
      manifest: Parameters<typeof transport.verifyPackage>[1],
    ) => {
      const result = await transport.verifyPackage(handle, manifest);
      if (!result.ok && "certainty" in result && result.certainty === "unknown")
        transportOutcomeUnknown = true;
      return result;
    },
  };
  const pendingDownloadFile = path.join(root, "download-pending.json");
  const preferencesFile = path.join(root, "preferences.json");
  const automaticPreferenceFile = path.join(
    root,
    "automatic-update-preference.json",
  );
  const automaticUnconfirmedFile = path.join(
    root,
    "automatic-update-unconfirmed.json",
  );
  const quitPreferenceFile = path.join(root, "install-on-quit-preference.json");
  const quitUnconfirmedFile = path.join(
    root,
    "install-on-quit-unconfirmed.json",
  );
  const noticesFile = path.join(root, "notice-preferences.json");
  const preferenceReaders = createPreferences({
    files: {
      preferences: preferencesFile,
      notices: noticesFile,
      automatic: automaticPreferenceFile,
      automaticUnconfirmed: automaticUnconfirmedFile,
      quit: quitPreferenceFile,
      quitUnconfirmed: quitUnconfirmedFile,
    },
    readRecord: (file) => readRecord(file),
    probe: (file) => fs.lstat(file),
    ensureRoot: () => canonicalOwnedDirectory(root, true),
  });
  const readPreferences = preferenceReaders.readPreferences;
  const readAutomaticPreference = preferenceReaders.readAutomatic;
  const readQuitPreference = preferenceReaders.readQuit;
  const readNoticePreferences = preferenceReaders.readNotices;
  // One notice persistence lane inside the existing release owner. It serializes
  // this sibling record only; update staging/handoff authority stays independent.
  let noticeQueue: Promise<void> = Promise.resolve();
  let noticeWriteUnknown = false;
  const serializeNotice = <T>(
    run: () => Promise<T>,
    blocked: T,
  ): Promise<T> => {
    const result = noticeQueue.then(async () => {
      if (noticeWriteUnknown) return blocked;
      try {
        return await run();
      } catch (error) {
        noticeWriteUnknown = true;
        throw error;
      }
    });
    noticeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let candidate: UpdateCandidate | null = null;
  let verified: VerifiedGithubUpdate | null = null;
  let stagingUncertain = false;
  let retained: z.infer<typeof Retained> | null = null;
  let operation: InstalledUpdateOperation | null = null;
  // The gate owns the kernel lease. close() only drains updater work; process
  // exit releases this final fence.
  const admissions = createAdmissionGate<
    NormalQuitApplyContext,
    ConfirmedUpdateRestart
  >({
    acquire: (...args) => options.acquireAdmission(...args),
    drained: (beforeEffect) => drained(beforeEffect),
  });
  const readyFile = path.join(root, "ready.json");
  const cleanupFile = path.join(root, "package-cleanup-pending.json");
  const receiptFile = path.join(root, "last-update.json");
  const adoptedFile = path.join(root, ADOPTED_BASELINE_FILE);
  const restoreFile = path.join(root, "restore-pending.json");
  let restorable: z.infer<typeof Retained> | null = null;
  let restoreKind: "recover" | "rollback" | null = null;
  let declinedBuildId: string | null = null;

  const runTrusted = async (
    entry: string,
    args: string[],
    beforeEffect: () => void = () => undefined,
  ) => {
    beforeEffect();
    if (supervised && (await supervised.verifyResources()) !== true)
      throw new Error("UPDATE_SUPERVISOR_RESOURCES_CHANGED");
    beforeEffect();
    const captured = await requireExecution();
    beforeEffect();
    const value = await runInstalledTrusted(
      options.directory,
      entry,
      args,
      180000,
      captured,
      beforeEffect,
    );
    beforeEffect();
    return value;
  };
  const readBuild = async (
    file: string,
    beforeEffect: () => void = () => undefined,
  ) =>
    AcceptedBuild.parse(
      await runTrusted("update-slot.mjs", [file], beforeEffect),
    );
  const known = (code: string) => ({ ok: false as const, code });
  // The two boundaries of first-launch adoption. Reading a valid record is
  // allowed to the ordinary desktop runtime in either slot, never to a
  // supervised owner runtime. Writing at the first update check is allowed only
  // in the user slot: the shared slot adopts once, at startup, before its
  // immutable backend resources are captured, and never from here.
  const adoptionReadApplies = !supervised;
  const adoptionWriteAppliesAtDiscovery =
    installLocation !== "shared" && !supervised;
  // Digest of the adopted record last found to describe another published
  // build. Only an unchanged record with this digest may be replaced.
  let supersededDigest: string | null = null;
  const readAdoptedExpectation = async (): Promise<
    z.infer<typeof AcceptedBuild>
  > => {
    const state = await readAdoptedRecord({
      file: adoptedFile,
      slot,
      userData: options.userData,
      build: options.build,
      read: readRecord,
      absent: recordAbsent,
    });
    if (state.kind === "absent")
      throw new Error("UPDATE_BASELINE_ADOPTION_REQUIRED");
    if (state.kind === "superseded") {
      supersededDigest = state.digest;
      throw new Error("UPDATE_BASELINE_ADOPTION_SUPERSEDED");
    }
    return { ...state.expected };
  };
  const readAcceptedSource = async (
    beforeEffect: () => void = () => undefined,
  ) => {
    await canonicalOwnedDirectory(path.dirname(slot), false);
    const repairRaw = await readRecord(slot + ".repair.json");
    const repair =
      repairRaw === null ? null : ClosedRepairReceipt.parse(repairRaw);
    const journalRaw = await readRecord(
      path.join(path.dirname(slot), ".farol-closed-repair.json"),
    );
    const journal = ClosedRepairJournal.safeParse(journalRaw);
    // The journal precedes receipt publication. Even a still-valid ordinary
    // baseline cannot admit updates while this repair outcome is unresolved.
    if (
      (repairRaw !== null || journalRaw !== null) &&
      (!repair ||
        !journal.success ||
        journal.data.phase !== repair.phase ||
        JSON.stringify(journal.data.receipt) !== JSON.stringify(repair))
    )
      throw new Error("UPDATE_REPAIR_RECOVERY_REQUIRED");
    let expected: z.infer<typeof AcceptedBuild>;
    const saved = await readRecord(receiptFile);
    if (saved !== null) {
      const receipt = SavedReceipt.parse(saved);
      const op = receipt.operation;
      const parsed = parseRetainedGithubReleaseManifest(receipt);
      if (
        !op ||
        !parsed.ok ||
        !sameBuild(op.target, {
          digest: parsed.value.artifactSha256,
          version: parsed.value.version,
          buildId: parsed.value.buildId,
        })
      )
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      await verifyBinding(op);
      const settledBuild =
        receipt.phase === "completed"
          ? op.target
          : receipt.phase === "rolled_back"
            ? op.source
            : null;
      const manualReplacement =
        !supervised &&
        installLocation === "shared" &&
        settledBuild !== null &&
        receipt.runningBuildId === settledBuild.buildId &&
        options.build.buildId !== op.target.buildId &&
        compareReleaseVersions(options.build.version, op.target.version) === 1;
      if (manualReplacement) {
        const oldJournal = await readOperationJournal(
          root,
          op,
          installLocation,
        );
        const oldHelper = await observeInstalledHelper(receipt.helper);
        if (
          oldJournal.phase !== receipt.phase ||
          startupHelperState(oldHelper) !== "exited" ||
          !(await recordAbsent(restoreFile))
        )
          throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
        expected = await readAdoptedExpectation();
      } else if (TARGET_PHASES.includes(receipt.phase)) expected = op.target;
      else if (
        [...ROLLED_BACK_PHASES, ...CANCELLED_PHASES].includes(receipt.phase)
      )
        expected = op.source;
      else throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      if (!manualReplacement && receipt.runningBuildId !== expected.buildId)
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    } else {
      // The first installed generation is anchored by the normal installer's
      // private receipt. Never adopt a freshly measured tree as accepted bytes.
      if (repair) {
        if (!journal.success)
          throw new Error("UPDATE_REPAIR_RECOVERY_REQUIRED");
        const previous = path.join(
          path.dirname(slot),
          `.farol-repair-${repair.operationId}`,
          "previous.app",
        );
        if (
          repair.destination !== slot ||
          repair.userData !== options.userData ||
          repair.previous !== previous ||
          repair.quarantine !==
            path.join(
              options.userData,
              `installed-updates-quarantine-${repair.operationId}`,
            )
        )
          throw new Error("UPDATE_REPAIR_IDENTITY_UNCONFIRMED");
        await canonicalOwnedDirectory(path.dirname(previous), true);
        const checkRepairPair = async () => {
          await repairDirectoryIdentity(
            slot,
            repair.phase === "installed"
              ? journal.data.targetInode
              : journal.data.sourceInode,
            false,
          );
          await repairDirectoryIdentity(
            previous,
            repair.phase === "installed"
              ? journal.data.sourceInode
              : journal.data.targetInode,
            false,
          );
          if (repair.quarantined !== (journal.data.updatesInode !== null))
            throw new Error("UPDATE_REPAIR_QUARANTINE_CHANGED");
          if (journal.data.updatesInode !== null) {
            await repairDirectoryIdentity(
              repair.quarantine,
              journal.data.updatesInode,
              true,
            );
          } else {
            let absent = false;
            try {
              await fs.lstat(repair.quarantine);
            } catch (error) {
              absent = (error as NodeJS.ErrnoException).code === "ENOENT";
            }
            if (!absent) throw new Error("UPDATE_REPAIR_QUARANTINE_CHANGED");
          }
        };
        await checkRepairPair();
        // Select the current accepted image before invoking even a companion
        // measurement helper from the shared application slot.
        await captureExecution(
          repair.phase === "installed" ? repair.target : repair.source,
          beforeEffect,
        );
        const companion = await readBuild(previous, beforeEffect);
        if (
          !sameBuild(
            companion,
            repair.phase === "installed" ? repair.source : repair.target,
          )
        )
          throw new Error("UPDATE_REPAIR_PREDECESSOR_CHANGED");
        if (repair.phase === "installed") {
          if (
            repair.sourceCommit !== options.build.sourceCommit ||
            repair.sourceTreeDigest !== options.build.sourceTreeDigest ||
            repair.target.buildId !== options.build.buildId ||
            repair.target.version !== options.build.version
          )
            throw new Error("UPDATE_REPAIR_IDENTITY_UNCONFIRMED");
          const measured = await readBuild(slot, beforeEffect);
          if (!sameBuild(measured, repair.target))
            throw new Error("UPDATE_ACCEPTED_SOURCE_CHANGED");
          await checkRepairPair();
          return measured;
        }
        // A cold rollback still needs the predecessor's genuine initial install anchor.
        if (
          repair.source.buildId !== options.build.buildId ||
          repair.source.version !== options.build.version
        )
          throw new Error("UPDATE_REPAIR_IDENTITY_UNCONFIRMED");
      }
      const file = slot + ".receipt.json";
      const receiptRaw = await readRecord(file);
      if (
        receiptRaw === null &&
        !repair &&
        adoptionReadApplies &&
        // Every other piece of baseline evidence must be truly absent. A file
        // that exists with JSON null keeps main's behaviour and never adopts.
        (
          await Promise.all(
            [
              receiptFile,
              file,
              slot + ".repair.json",
              path.join(path.dirname(slot), ".farol-closed-repair.json"),
            ].map(recordAbsent),
          )
        ).every(Boolean)
      ) {
        // No owner-tool receipt: only a previously adopted baseline can anchor
        // this copy. Its absence is the one condition that permits adoption.
        expected = await readAdoptedExpectation();
      } else {
        const receipt = PromotionReceipt.parse(receiptRaw);
        if (
          receipt.destination !== slot ||
          receipt.receipt !== file ||
          receipt.activation.userData !== options.userData ||
          receipt.sourceCommit !== options.build.sourceCommit ||
          receipt.sourceTreeDigest !== options.build.sourceTreeDigest ||
          receipt.version !== options.build.version ||
          receipt.artifactSha256 !== receipt.verifiedDestinationSha256
        )
          throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
        expected = {
          digest: receipt.verifiedDestinationSha256,
          version: receipt.version,
          buildId: options.build.buildId,
        };
      }
    }
    if (
      expected.buildId !== options.build.buildId ||
      expected.version !== options.build.version
    )
      throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    await captureExecution(expected, beforeEffect);
    const measured = await readBuild(slot, beforeEffect);
    if (!sameBuild(measured, expected))
      throw new Error("UPDATE_ACCEPTED_SOURCE_CHANGED");
    return measured;
  };
  // First-launch adoption from discovery, for the user slot only. It runs when
  // neither an owner-tool receipt nor an update receipt anchors this copy, and
  // it never overwrites a record. A failure writes nothing.
  const adoptBaseline = async (
    replacing: string | null,
  ): Promise<
    Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>
  > => {
    if (
      !adoptionWriteAppliesAtDiscovery ||
      !adoptionBuildEligible(options.build)
    )
      return known("UPDATE_ADOPTION_BUILD_INELIGIBLE");
    const resolved = await resolveAdoptionManifest({
      build: options.build,
      fetchJson: (url, maximum) => transport.fetchJson(url, maximum),
    });
    if (!resolved.ok) return known(resolved.code);
    const manifest = resolved.value;
    let measured: z.infer<typeof AcceptedBuild>;
    try {
      measured = await readBuild(slot);
    } catch {
      return known("UPDATE_ADOPTION_TREE_UNREADABLE");
    }
    if (
      measured.digest !== manifest.artifactSha256 ||
      !sameBuild(measured, {
        digest: manifest.artifactSha256,
        version: manifest.version,
        buildId: manifest.buildId,
      })
    )
      return known("UPDATE_ADOPTION_TREE_MISMATCH");
    try {
      // A skipped replacement means another writer owns the file now: leave it
      // and let the caller validate it.
      await publishAdoptedRecord({
        file: adoptedFile,
        record: adoptedRecordFor({
          slot,
          userData: options.userData,
          manifest,
        }),
        replacing,
        read: readRecord,
        write: (file, value) => writeRecord(file, value),
      });
    } catch {
      return known("UPDATE_ADOPTION_RECORD_UNWRITTEN");
    }
    return { ok: true };
  };
  const readJournal = (op: z.infer<typeof Operation>) =>
    readOperationJournal(root, op, installLocation);
  const optionalBuild = async (op: z.infer<typeof Operation>, name: string) => {
    await verifyBinding(op);
    const file = path.join(root, op.operationId, name);
    try {
      await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return readBuild(file);
  };
  const originalHelperEnded = async (
    record: Pick<z.infer<typeof Retained>, "helper">,
  ) => {
    const status = await observeInstalledHelper(record.helper);
    return status === "ended";
  };
  const removeDownloadStage = async (
    download: z.infer<typeof DownloadStage>,
  ) => {
    const directory = downloadDirectory(download.id);
    let metadata;
    try {
      metadata = await fs.lstat(directory, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (metadata) {
      await canonicalOwnedDirectory(directory, true);
      if (download.identity) {
        if (downloadStageIdentityChanged(metadata, download.identity))
          throw new Error("UPDATE_DOWNLOAD_STAGE_CHANGED");
        // The caller has reconciled the producer and every operation in this
        // exclusive directory. Older retained packages and rollback stay outside.
        await options.removeDirectory(directory, false);
      } else {
        // Interrupted allocation cannot have received bytes. rmdir refuses any
        // contents rather than claiming an unrecorded directory is disposable.
        await fs.rmdir(directory);
      }
    }
  };
  const reconcileInterruptedDownload = async (
    intent: z.infer<typeof DownloadIntent>,
  ) => {
    const download = intent.download;
    // Legacy intents have no producer/stage witness. Never guess their ownership.
    if (
      !claimableInterruptedDownload(download) ||
      !(await originalHelperEnded({ helper: download.producer }))
    )
      throw new Error("UPDATE_DOWNLOAD_PRODUCER_UNCONFIRMED");
    await removeDownloadStage(download);
    await writeRecord(path.join(root, "last-interrupted-download.json"), {
      schema: "farol.interrupted-download/1",
      intent,
      outcome: "producer-ended-stage-removed",
      observedAt: new Date().toISOString(),
    });
    await fs.unlink(pendingDownloadFile);
    const parent = await fs.open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  };
  const drained = async (beforeEffect: () => void = () => undefined) => {
    const report = z
      .strictObject({
        drained: z.boolean(),
        obligationCount: z.number(),
        unreadableCount: z.number(),
        changedCount: z.number(),
      })
      .parse(
        await runTrusted(
          "update-obligations.mjs",
          [
            options.userData,
            String(supervised?.predecessor.pid ?? process.pid),
          ],
          beforeEffect,
        ),
      );
    return report.drained;
  };
  const discardVerifiedStage = async (
    handle: string,
    beforeEffect: () => void = () => undefined,
  ) => {
    verified = null;
    try {
      beforeEffect();
      await verifier.discard(handle);
      beforeEffect();
      return true;
    } catch {
      stagingUncertain = true;
      beforeEffect();
      await writeRecord(cleanupFile, {
        schema: "farol.update-package-cleanup/1",
        handle,
      });
      return false;
    }
  };
  const removePreparedCopy = async (
    op: z.infer<typeof Operation>,
    beforeEffect: () => void = () => undefined,
  ) => {
    const directory = path.join(root, op.operationId);
    let metadata;
    try {
      metadata = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0
    )
      throw new Error("UPDATE_PREPARATION_UNRECONCILED");
    await verifyBinding(op);
    // A pre-dispatch directory can contain only its unfinished copy and binding. Never
    // reclaim a journal, predecessor or unexpected entry as preparation debris.
    for await (const entry of await fs.opendir(directory)) {
      if (
        entry.name !== "staged.app" &&
        entry.name !== INSTALLED_SLOT_BINDING_FILE &&
        entry.name !== "helper.log.jsonl"
      )
        throw new Error("UPDATE_PREPARATION_UNRECONCILED");
    }
    beforeEffect();
    await options.removeDirectory(path.join(directory, "staged.app"), true);
    beforeEffect();
    // Retain the immutable binding even after pre-dispatch cleanup. A lost
    // final Ready write can then recheck this same slot without adopting an
    // unbound operation or recreating authority from missing files.
    await verifyBinding(op);
    beforeEffect();
  };
  const clearRestoreIntent = async (): Promise<void> => {
    await fs.unlink(restoreFile);
    const parent = await fs.open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  };
  const stageSelectedUpdate = async (
    manifest: ReleaseManifest,
    produce: (
      verify: typeof checkedTransport.verifyPackage,
    ) => ReturnType<typeof downloadAndVerifyGithubUpdate>,
  ): ReturnType<InstalledUpdaterPorts["download"]> => {
    let processStart: string;
    try {
      processStart = await captureInstalledProcessStart(process.pid);
    } catch {
      return known("UPDATE_PRODUCER_IDENTITY_UNCONFIRMED");
    }
    const download: z.infer<typeof DownloadStage> = {
      phase: "downloading",
      id: randomBytes(16).toString("hex"),
      producer: { pid: process.pid, processStart },
    };
    const intent = {
      schema: "farol.update-download-intent/1" as const,
      buildId: manifest.buildId,
      archiveSha256: manifest.archiveSha256,
      download,
    };
    // Bind allocation and the original process before any request or extraction.
    // A crash can reconcile this exact directory without touching older rollback.
    await writeRecord(pendingDownloadFile, intent);
    const directory = downloadDirectory(download.id);
    await fs.mkdir(directory, { mode: 0o700 });
    await canonicalOwnedDirectory(directory, true);
    const metadata = await fs.lstat(directory, { bigint: true });
    download.identity = {
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      birthtimeNs: String(metadata.birthtimeNs),
    };
    await writeRecord(pendingDownloadFile, intent);
    await selectDownload(download.id);
    if (downloadsCancelled) {
      // No request or extraction has begun. Do not revive a cancelled lifetime
      // by replacing its transport after Quit raced durable allocation.
      await fs.rmdir(directory);
      await fs.unlink(pendingDownloadFile);
      return known("UPDATE_DOWNLOAD_CANCELLED");
    }
    let downloaded: Awaited<ReturnType<typeof downloadAndVerifyGithubUpdate>>;
    try {
      downloaded = await produce(async (handle, expectedManifest) => {
        // Native verification may have its own child lifetime. A lost
        // result must not be treated as an interrupted HTTP-only stage.
        download.phase = "verifying";
        await writeRecord(pendingDownloadFile, intent);
        return checkedTransport.verifyPackage(handle, expectedManifest);
      });
    } catch {
      return {
        ok: false,
        code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
        recoveryRequired: true,
      };
    }
    if (transportOutcomeUnknown)
      return {
        ok: false,
        code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
        recoveryRequired: true,
      };
    if (!downloaded.ok) {
      if (stagedDownloadHandle !== null) {
        try {
          await verifier.discard(stagedDownloadHandle);
          const cleanup = await transport.discard(stagedDownloadHandle);
          if (!cleanup.ok) throw new Error("UPDATE_STAGE_CLEANUP_UNKNOWN");
          stagedDownloadHandle = null;
        } catch {
          return {
            ok: false,
            code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
            recoveryRequired: true,
          };
        }
      }
      // A known failed request has drained all its native work. Reclaim this
      // attempt before clearing its intent; uncertainty keeps recovery fenced.
      await removeDownloadStage(download);
      await fs.unlink(pendingDownloadFile);
      return known(downloadFailureCode(downloaded.code));
    }
    verified = downloaded.value;
    return {
      ok: true,
      update: { handle: verified.handle, manifest: verified.manifest },
    };
  };

  // Recovery from the durable records. `stopAfterPreparation` runs only as far
  // as the unfinished-copy reconciliation, which a standing cleanup fence must
  // not keep from running.
  const recoverFromRecords = async (
    stopAfterPreparation: boolean,
  ): ReturnType<InstalledUpdaterPorts["recover"]> => {
    const downloadRaw = await readRecord(pendingDownloadFile);
    let downloadIntent =
      downloadRaw === null ? null : DownloadIntent.parse(downloadRaw);
    let pending: z.infer<typeof RestoreIntent> | null;
    try {
      pending = await readRestoreIntent(restoreFile, readRecord, recordAbsent);
    } catch (error) {
      // Keep the classified code: the updater would otherwise collapse it
      // into the generic recovery-unavailable outcome.
      if (error instanceof Error && error.message === "UPDATE_RECORD_INVALID")
        return known("UPDATE_RECORD_INVALID");
      throw error;
    }
    const raw = await readRecord(readyFile);
    const fromReady = raw !== null;
    let interruptedDownload = false;
    const downloadRecovery = downloadRecoveryAtStartup({
      hasIntent: downloadIntent !== null,
      fromReady,
      restorePending: pending !== null,
    });
    if (downloadRecovery === "restore_unknown")
      return known("UPDATE_RESTORE_OUTCOME_UNKNOWN");
    if (downloadRecovery === "reconcile") {
      try {
        await reconcileInterruptedDownload(downloadIntent!);
      } catch {
        return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
      }
      downloadIntent = null;
      interruptedDownload = true;
    }
    const previous = fromReady ? null : await readRecord(receiptFile);
    if (
      !fromReady &&
      previous !== null &&
      !pending &&
      !downloadIntent &&
      !supervised &&
      installLocation === "shared"
    ) {
      const historical = SavedReceipt.parse(previous);
      if (
        historicalReceiptSuperseded({
          historical,
          running: options.build,
          compareVersions: compareReleaseVersions,
        })
      ) {
        try {
          await readAcceptedSource();
          return { ok: true, update: null };
        } catch {
          return known("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
        }
      }
    }
    if (raw === null && previous === null) {
      const empty = emptyRecoveryOutcome({
        restorePending: pending !== null,
        interruptedDownload,
      });
      return empty === "restore_unknown"
        ? known("UPDATE_RESTORE_OUTCOME_UNKNOWN")
        : empty === "download_interrupted"
          ? {
              ok: false,
              code: "UPDATE_DOWNLOAD_INTERRUPTED",
              recoveryRequired: false,
            }
          : { ok: true, update: null };
    }
    retained = fromReady
      ? Retained.parse(raw)
      : Retained.parse(
          (({
            observedAt: _at,
            phase: _phase,
            runningBuildId: _id,
            ...record
          }) => record)(SavedReceipt.parse(previous)),
        );
    try {
      for (const op of [
        retained.operation,
        retained.preparation,
        pending?.operation,
      ])
        if (op) await verifyBinding(op);
    } catch {
      return known("UPDATE_SLOT_BINDING_UNCONFIRMED");
    }
    await selectDownload(retained.downloadId);
    const parsed = parseRetainedGithubReleaseManifest(retained);
    if (!parsed.ok) return known("UPDATE_RETAINED_MANIFEST_INVALID");
    // A newly installed generation has not settled last-update.json yet.
    // Authenticate observer code from this independently correlated operation,
    // then leave all physical-pair and terminal checks to recovery below.
    const executionOperation =
      retained.operation ?? retained.preparation ?? pending?.operation;
    if (executionOperation) {
      if (
        !sameBuild(executionOperation.target, {
          digest: parsed.value.artifactSha256,
          version: parsed.value.version,
          buildId: parsed.value.buildId,
        })
      )
        return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
      const expected = [
        executionOperation.source,
        executionOperation.target,
      ].find(
        (value) =>
          value.buildId === options.build.buildId &&
          value.version === options.build.version,
      );
      if (!expected) return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
      await captureExecution(expected, () => undefined);
    }

    if (
      downloadIntent &&
      downloadIntentConflicts(downloadIntent, retained, parsed.value)
    )
      return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
    if (pending?.notStartedAt) {
      const current = await readBuild(slot);
      if (
        restoreNotStartedMismatch({
          pendingOperation: pending.operation,
          retainedOperation: retained.operation,
          notStartedAt: pending.notStartedAt,
          current,
          running: options.build,
        }) ||
        (await readJournal(pending.operation)).phase !== pending.priorPhase
      )
        return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
      await clearRestoreIntent();
      pending = null;
    }
    if (retained.preparation) {
      const op = retained.preparation;
      const current = await readBuild(slot);
      if (
        preparationUnreconciled({
          fromReady,
          restorePending: pending !== null,
          retained,
          current,
          running: options.build,
          preparation: op,
          manifestTarget: {
            digest: parsed.value.artifactSha256,
            version: parsed.value.version,
            buildId: parsed.value.buildId,
          },
        }) ||
        (await readRecord(path.join(root, op.operationId, "journal.json"))) !==
          null
      )
        return known("UPDATE_PREPARATION_UNRECONCILED");
      await removePreparedCopy(op);
      retained = { ...retained, preparation: undefined };
      await writeRecord(readyFile, retained);
    }
    // The startup fence settles after this point has run, not before it.
    if (stopAfterPreparation) return { ok: true as const, update: null };
    if (retained.operation) {
      const op = retained.operation;
      if (pending && !sameOperation(pending.operation, op))
        return known("UPDATE_OPERATION_IDENTITY_MISMATCH");
      const journalFile = path.join(root, op.operationId, "journal.json");
      const readStartupJournal = () =>
        readStartupOperationJournal(root, op, installLocation);
      const journal = await readStartupJournal();
      // A restore owns a distinct helper. Its exit is required even when the
      // original apply helper has long since ended. No phase-based shortcut.
      const helper = await observeInstalledHelper(
        pending ? pending.helper : retained.helper,
      );
      const current = await readBuild(slot);
      const decision = installedUpdateStartupDecision({
        phase: journal?.phase ?? null,
        helper: startupHelperState(helper),
        installed: current,
        running: options.build,
        operation: op,
      });
      const settlement = startupSettlement({ decision, helper });
      if (!settlement.ok) return known(settlement.code);
      if (
        pending &&
        restoreExitWitnessApplies({
          pending,
          journalPhase: journal?.phase,
          current,
        })
      )
        await writeRecord(
          path.join(root, op.operationId, "restore-exit.json"),
          {
            schema: "farol.update-refusal/1",
            action: pending.action,
            operation: op,
            helper: pending.helper,
            priorPhase: pending.priorPhase,
            installedBefore: pending.installedBefore,
            code: "helper_exited_without_journal_change",
          },
        );
      // The sole settlement writer. Recheck exact content, phase and helper
      // before publishing. Subsequent lifetimes make the identical decision;
      // they never re-open an operation because a companion is damaged.
      if (
        !sameBuild(await readBuild(slot), current) ||
        (await readStartupJournal())?.phase !== journal?.phase ||
        !(await originalHelperEnded(pending ?? retained))
      )
        return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
      try {
        await archivePreviousReceipt(root, receiptFile, op);
      } catch {
        // History retention is best-effort. Settlement still depends on the
        // actual operation, helper and installed-build checks above.
        console.warn("Previous update receipt could not be archived.");
      }
      const settledPhase = settlement.phase;
      if (journal?.phase !== settledPhase)
        await writeRecord(journalFile, {
          ...(journal ?? {
            schema: "farol.installed-update-journal/1",
            ...op,
          }),
          phase: settledPhase,
        });
      let predecessor: z.infer<typeof AcceptedBuild> | null = null;
      if (settledPhase === "completed") {
        try {
          predecessor = await optionalBuild(op, "previous.app");
        } catch {
          /* Preserved evidence is not installed content, on any restart. */
        }
      } else {
        declinedBuildId = op.target.buildId;
      }
      const rollbackVersion = rollbackVersionFor({
        phase: settledPhase,
        predecessor,
        operation: op,
        requiresStateRecovery: legacyPredecessorRequiresStateRecovery,
      });
      restorable = retained;
      restoreKind = rollbackVersion ? "rollback" : null;
      // The settled journal and installed content establish that this
      // operation no longer needs its archive. Reconcile a prior truncation
      // through the same private handle before acknowledging reclamation.
      if (!retained.archiveReleased) {
        const reclaimed = await transport.reclaimRetained(
          retained.handle,
          parsed.value,
        );
        if (!reclaimed.ok) return known("UPDATE_ARCHIVE_CLEANUP_UNCONFIRMED");
        retained = { ...retained, archiveReleased: true };
        restorable = retained;
      }
      // A settled receipt is historical evidence. Re-observing the same
      // operation must not replace its timestamp or bytes on every launch.
      // Write only when settling new evidence or when archive reclamation
      // changed the retained record; pending work keeps its existing path.
      const saved = previous === null ? null : SavedReceipt.parse(previous);
      const unchangedReceipt = settledReceiptUnchanged({
        fromReady,
        restorePending: pending !== null,
        saved,
        retained,
        phase: settledPhase,
        runningBuildId: options.build.buildId,
      });
      if (unchangedReceipt) {
        // A concurrent replacement is not the historical record we just
        // verified; do not silently accept it as an unchanged settlement.
        if (
          JSON.stringify(await readRecord(receiptFile)) !==
          JSON.stringify(previous)
        )
          return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
      } else
        await writeRecord(receiptFile, {
          ...retained,
          observedAt: new Date().toISOString(),
          phase: settledPhase,
          runningBuildId: options.build.buildId,
        });
      if (fromReady) await fs.unlink(readyFile);
      if (pending) await fs.unlink(restoreFile);
      const failedApply = applyRolledBack({
        fromReady,
        restorePending: pending !== null,
        current,
        source: op.source,
      });
      retained = null;
      if (failedApply)
        return {
          ok: false,
          code: "UPDATE_ROLLED_BACK",
          recoveryRequired: false,
        };
      return {
        ok: true,
        update: null,
        ...(rollbackVersion ? { rollbackVersion } : {}),
      };
    }
    if (pending) return known("UPDATE_RESTORE_OUTCOME_UNKNOWN");
    let current: z.infer<typeof AcceptedBuild>;
    try {
      current = await readAcceptedSource();
    } catch {
      return known("UPDATE_SOURCE_IDENTITY_UNCONFIRMED");
    }
    if (
      current.buildId !== options.build.buildId ||
      current.version !== options.build.version
    )
      return known("UPDATE_SOURCE_IDENTITY_MISMATCH");
    // A ready-only download can have been installed manually, or superseded
    // by a later authenticated build. Pending download, helper, preparation
    // and operation records remain subject to their existing recovery paths.
    const retainedOrder = compareReleaseVersions(
      parsed.value.version,
      options.build.version,
    );
    const relation = retainedBuildRelation({
      order: retainedOrder,
      manifest: parsed.value,
      running: {
        buildVersion: options.build.buildVersion!,
        buildId: options.build.buildId,
        sourceCommit: options.build.sourceCommit,
        sourceTreeDigest: options.build.sourceTreeDigest,
      },
      installedDigest: current.digest,
    });
    if (
      retainedReadyReclaimable({
        fromReady,
        retained,
        hasDownloadIntent: downloadIntent !== null,
        repository: parsed.value.repository,
        channel: parsed.value.channel,
        expectedChannel: adoptionChannel(options.build),
        relation,
      })
    ) {
      const reclaimed = await transport.reclaimRetained(
        retained.handle,
        parsed.value,
      );
      if (!reclaimed.ok) return known("UPDATE_ARCHIVE_CLEANUP_UNCONFIRMED");
      await fs.unlink(readyFile);
      retained = null;
      return { ok: true, update: null };
    }
    if (
      !isIncreasingUpdate(
        parsed.value,
        current.version,
        options.build.buildVersion!,
      )
    )
      return known("UPDATE_RETAINED_VERSION_MISMATCH");
    const check = await transport.verifyPackage(retained.handle, parsed.value);
    const verification = classifyPackageVerification(
      check,
      check.ok && packageMatchesRelease(check.value.identity, parsed.value),
    );
    if (verification !== "verified")
      return known(verificationRefusalCode(verification));
    if (!(await discardVerifiedStage(retained.handle)))
      return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
    // A matching durable ready record plus fresh physical verification proves
    // retain completed even if its final intent unlink was interrupted.
    if (downloadIntent) await fs.unlink(pendingDownloadFile);
    return {
      ok: true,
      update: {
        handle: retained.handle,
        manifest: parsed.value,
        ...(retained.notes ? { notes: retained.notes } : {}),
      },
    };
  };

  // Verifier extractions whose owner died are reclaimed at every launch, by
  // their lease. Only the single-instance primary runs this (the lock is taken
  // before the host builds this runtime); a supervised controller never does.
  const reclaimStagedExtractions = async () => {
    if (supervised) return null;
    try {
      return await verifier.reclaimAbandoned({
        root,
        uid: process.getuid?.(),
        read: readInstalledProcess,
        removeDirectory: options.removeDirectory,
        now: () => Date.now(),
        log: (message) => console.warn(message),
      });
    } catch {
      return null;
    }
  };
  // Startup order: the unfinished-copy reconciliation, the extraction reclaim,
  // the cleanup fence's settlement, and only then the fence itself.
  const recoverAtStartup = async (): ReturnType<
    InstalledUpdaterPorts["recover"]
  > => {
    let marker: unknown = null;
    let unreadable: unknown = null;
    try {
      marker = await readRecord(cleanupFile);
    } catch (error) {
      unreadable = error;
    }
    const fenced = marker !== null || unreadable !== null;
    if (fenced) {
      try {
        await recoverFromRecords(true);
      } catch {
        // The fence below still applies; nothing here settles it.
      }
    }
    const report = await reclaimStagedExtractions();
    if (fenced) {
      let cleared = false;
      if (unreadable === null) {
        try {
          cleared = await settleCleanupMarker({
            root,
            file: cleanupFile,
            marker,
            // This pass's outcome only, for the root this pass scanned.
            extractionsGone: report?.complete === true,
            rootIdentity: report?.root ?? null,
            read: () => readRecord(cleanupFile),
          });
        } catch {
          cleared = false;
        }
      }
      if (!cleared) {
        retained = null;
        if (unreadable !== null) throw unreadable;
        return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
      }
    }
    return recoverFromRecords(false);
  };

  const updaterPorts: InstalledUpdaterPorts = {
    cancelPending: () => {
      downloadsCancelled = true;
      transport.cancelPending();
    },
    now: Date.now,
    publish: options.publish,
    readAutomaticUpdatePreference: async () => {
      try {
        const preference = await readAutomaticPreference();
        // The stable UI has one choice. A legacy download-only record cannot
        // leave hidden download/Quit effects enabled while that choice is OFF.
        if (
          options.build.updateChannel === "github-stable" &&
          preference.schema === "farol.installed-automatic-update-preference/1"
        )
          return {
            status: "confirmed",
            enabled: false,
            scope: "download-and-install",
          };
        return {
          status: "confirmed",
          enabled: preference.enabled,
          ...(preference.schema ===
          "farol.installed-automatic-update-preference/2"
            ? { scope: preference.scope }
            : {}),
        };
      } catch {
        return {
          status: preferenceReaders.automaticUnknown() ? "unknown" : "blocked",
          enabled: false,
          code: preferenceReaders.automaticUnknown()
            ? "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN"
            : "UPDATE_AUTOMATIC_PREFERENCE_UNREADABLE",
        };
      }
    },
    writeAutomaticUpdatePreference: async (enabled, scope) => {
      if (preferenceReaders.automaticUnknown())
        return {
          status: "unknown",
          code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
        };
      const record = AutomaticUpdatePreferences.safeParse({
        schema:
          scope === "download-and-install"
            ? "farol.installed-automatic-update-preference/2"
            : "farol.installed-automatic-update-preference/1",
        enabled,
        ...(scope === undefined ? {} : { scope }),
      });
      if (!record.success)
        return {
          status: "refused",
          code: "UPDATE_AUTOMATIC_PREFERENCE_INVALID",
        };
      try {
        const prior = await readAutomaticPreference();
        if (
          (options.build.updateChannel === "github-stable" ||
            prior.schema === "farol.installed-automatic-update-preference/2") &&
          scope === undefined
        )
          return {
            status: "refused",
            code: "UPDATE_AUTOMATIC_PREFERENCE_SCOPE_REQUIRED",
          };
      } catch {
        return {
          status: "refused",
          code: "UPDATE_AUTOMATIC_PREFERENCE_UNREADABLE",
        };
      }
      if (scope === "download-and-install")
        try {
          await writeRecord(automaticUnconfirmedFile, {
            schema: "farol.installed-automatic-update-unconfirmed/1",
            enabled,
            ...(scope === undefined ? {} : { scope }),
          });
        } catch {
          return {
            status: "refused",
            code: "UPDATE_AUTOMATIC_PREFERENCE_FENCE_UNCONFIRMED",
          };
        }
      try {
        await writeRecord(automaticPreferenceFile, record.data);
        const observed = AutomaticUpdatePreferences.parse(
          await readRecord(automaticPreferenceFile),
        );
        if (JSON.stringify(observed) !== JSON.stringify(record.data))
          throw new Error("UPDATE_AUTOMATIC_PREFERENCE_CHANGED");
      } catch {
        preferenceReaders.markAutomaticUnknown();
        return {
          status: "unknown",
          code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
        };
      }
      if (scope === "download-and-install")
        try {
          await fs.unlink(automaticUnconfirmedFile);
          const parent = await fs.open(
            root,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } catch {
          /* Exact durable preference ACK survives conservative fence cleanup. */
        }
      return AutomaticUpdatePreferenceResultSchema.parse({
        status: "confirmed",
        enabled,
        ...(scope === undefined ? {} : { scope }),
      });
    },
    readInstallOnQuitPreference: async () => {
      try {
        return await readQuitPreference();
      } catch {
        return {
          status: "blocked",
          enabled: false,
          code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
        };
      }
    },
    writeInstallOnQuitPreference: async (enabled) => {
      const record = InstallOnQuitPreferences.safeParse({
        schema: "farol.installed-install-on-quit-preference/1",
        scope: "install-on-normal-quit",
        enabled,
      });
      if (!record.success)
        return { status: "refused", code: "UPDATE_QUIT_PREFERENCE_INVALID" };
      try {
        const prior = await readQuitPreference();
        if (prior.status === "unknown")
          return { status: "unknown", code: prior.code };
      } catch {
        return {
          status: "refused",
          code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
        };
      }
      const fence = {
        schema: "farol.installed-install-on-quit-unconfirmed/1",
        enabled,
      };
      try {
        await writeRecord(quitUnconfirmedFile, fence);
      } catch {
        // The choice write has not been dispatched. An unconfirmed fence may
        // conservatively block reload, but cannot be mistaken for a new choice.
        return {
          status: "refused",
          code: "UPDATE_QUIT_PREFERENCE_FENCE_UNCONFIRMED",
        };
      }
      try {
        await writeRecord(quitPreferenceFile, record.data);
        const observed = InstallOnQuitPreferences.parse(
          await readRecord(quitPreferenceFile),
        );
        if (observed.enabled !== enabled)
          throw new Error("UPDATE_QUIT_PREFERENCE_CHANGED");
      } catch {
        preferenceReaders.markQuitUnknown();
        // Never clear the prewritten witness or retry an unacknowledged choice.
        return {
          status: "unknown",
          code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
        };
      }
      // The choice already has a durable exact ACK. Fence housekeeping cannot
      // rewrite that original result as unknown. A remaining/reappearing fence
      // only makes the next owner conservative; lost unlink ACK cannot enable
      // an unacknowledged choice because the choice write is already confirmed.
      try {
        await fs.unlink(quitUnconfirmedFile);
        const parent = await fs.open(
          root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } catch {
        /* Keep the known preference ACK; do not retry fence removal. */
      }
      return InstallOnQuitPreferenceResultSchema.parse({
        status: "confirmed",
        scope: "install-on-normal-quit",
        enabled,
      });
    },
    notice: (view, version, reusePreviousFailure) =>
      serializeNotice(
        async () => {
          if (view.phase === "failed" && view.code.includes("UNKNOWN"))
            return { key: "unconfirmed", seen: false, blockedBy: view.code };
          let preferences: z.infer<typeof NoticePreferences>;
          try {
            preferences = await readNoticePreferences();
          } catch {
            return {
              key: "unconfirmed",
              seen: false,
              blockedBy: "UPDATE_PREFERENCES_UNREADABLE",
            };
          }
          if (view.phase === "available" || view.phase === "ready")
            return {
              key: `version:${view.version}`,
              seen: preferences.seenVersion === view.version,
              blockedBy: null,
            };
          if (view.phase !== "failed")
            throw new Error("UPDATE_NOTICE_NOT_AVAILABLE");
          // Reuse only within one unresolved failure streak or on restoration.
          // A successful check starts a new streak, even for the same code.
          const previous = preferences.failureNotice;
          if (
            reusePreviousFailure &&
            previous?.code === view.code &&
            (version === null || previous.version === version)
          )
            return {
              key: previous.key,
              seen: previous.seen,
              blockedBy: null,
            };
          const failureNotice = {
            version,
            code: view.code,
            key: `failure:${randomBytes(12).toString("hex")}`,
            seen: false,
          };
          await writeRecord(noticesFile, { ...preferences, failureNotice });
          return { key: failureNotice.key, seen: false, blockedBy: null };
        },
        {
          key: "unconfirmed",
          seen: false,
          blockedBy: "UPDATE_NOTICE_OUTCOME_UNKNOWN",
        },
      ),
    noticeFailureResolved: () =>
      serializeNotice(async () => {
        let preferences: z.infer<typeof NoticePreferences>;
        try {
          preferences = await readNoticePreferences();
        } catch {
          return known("UPDATE_PREFERENCES_UNREADABLE");
        }
        if (preferences.failureNotice)
          await writeRecord(noticesFile, {
            ...preferences,
            failureNotice: null,
          });
        return { ok: true as const };
      }, known("UPDATE_NOTICE_OUTCOME_UNKNOWN")),
    noticeSeen: (key) =>
      serializeNotice(async () => {
        let preferences: z.infer<typeof NoticePreferences>;
        try {
          preferences = await readNoticePreferences();
        } catch {
          return known("UPDATE_PREFERENCES_UNREADABLE");
        }
        if (key.startsWith("version:")) {
          const version = key.slice("version:".length);
          if (version.length === 0 || version.length > 128)
            return known("UPDATE_NOTICE_CHANGED");
          await writeRecord(noticesFile, {
            ...preferences,
            seenVersion: version,
          });
        } else if (preferences.failureNotice?.key === key) {
          await writeRecord(noticesFile, {
            ...preferences,
            failureNotice: { ...preferences.failureNotice, seen: true },
          });
        } else return known("UPDATE_NOTICE_CHANGED");
        return { ok: true as const };
      }, known("UPDATE_NOTICE_OUTCOME_UNKNOWN")),
    recover: recoverAtStartup,
    discover: async () => {
      let current: z.infer<typeof AcceptedBuild>;
      try {
        // update-slot measures CFBundleVersion and binds it to this identity.
        // Do not query GitHub using an unconfirmed installed baseline.
        current = await readAcceptedSource();
      } catch (error) {
        const superseded =
          error instanceof Error &&
          error.message === "UPDATE_BASELINE_ADOPTION_SUPERSEDED";
        if (
          !adoptionWriteAppliesAtDiscovery ||
          !(error instanceof Error) ||
          (error.message !== "UPDATE_BASELINE_ADOPTION_REQUIRED" && !superseded)
        )
          return known("UPDATE_SOURCE_IDENTITY_UNCONFIRMED");
        const adopted = await adoptBaseline(
          superseded ? supersededDigest : null,
        );
        if (!adopted.ok) return known(adopted.code);
        try {
          current = await readAcceptedSource();
        } catch {
          return known("UPDATE_SOURCE_IDENTITY_UNCONFIRMED");
        }
      }
      if (
        current.buildId !== options.build.buildId ||
        current.version !== options.build.version
      )
        return known("UPDATE_SOURCE_IDENTITY_MISMATCH");
      const found = await discoverGithubUpdate(
        {
          version: options.build.version,
          buildVersion: options.build.buildVersion!,
        },
        options.build.updateChannel === "github-stable"
          ? "stable"
          : "owner-beta",
        transport,
      );
      if (!found.ok) return known(`UPDATE_${found.code.toUpperCase()}`);
      let preferences: z.infer<typeof UpdatePreferences>;
      try {
        preferences = await readPreferences();
      } catch {
        return {
          ok: false as const,
          code: "UPDATE_PREFERENCES_UNREADABLE",
          recoveryRequired: true,
        };
      }
      candidate = candidateSkipped(
        found.value?.manifest.version,
        preferences.skipped?.version,
      )
        ? null
        : found.value;
      return candidate
        ? {
            ok: true,
            available: true,
            version: candidate.manifest.version,
            buildId: candidate.manifest.buildId,
            deferred: candidateDeferred({
              buildId: candidate.manifest.buildId,
              version: candidate.manifest.version,
              declinedBuildId,
              deferredVersion: preferences.deferredVersion,
            }),
            ...(candidate.notes ? { notes: candidate.notes } : {}),
          }
        : { ok: true, available: false };
    },
    download: async (onProgress) => {
      if (!candidate) return known("UPDATE_CANDIDATE_MISSING");
      const selected = candidate;
      const staged = await stageSelectedUpdate(
        selected.manifest,
        (verifyPackage) =>
          downloadAndVerifyGithubUpdate(selected, {
            ...checkedTransport,
            download: (url, maximum) =>
              checkedTransport.download(url, maximum, (receivedBytes) =>
                onProgress?.({
                  stage: "transferring",
                  receivedBytes,
                  totalBytes: selected.manifest.archiveSize,
                }),
              ),
            verifyPackage: (handle, manifest) => {
              onProgress?.({ stage: "verifying" });
              return verifyPackage(handle, manifest);
            },
          }),
      );
      return staged.ok && selected.notes
        ? {
            ok: true as const,
            update: { ...staged.update, notes: selected.notes },
          }
        : staged;
    },
    skip: async (buildId) => {
      if (!candidate || candidate.manifest.buildId !== buildId)
        return known("UPDATE_CANDIDATE_CHANGED");
      try {
        await readPreferences();
      } catch {
        return {
          ok: false as const,
          code: "UPDATE_PREFERENCES_UNREADABLE",
          recoveryRequired: true,
        };
      }
      await writeRecord(preferencesFile, {
        schema: "farol.installed-update-preferences/1",
        skipped: { version: candidate.manifest.version, buildId },
        deferredVersion: null,
      });
      candidate = null;
      return { ok: true as const };
    },
    defer: async (buildId) => {
      if (!candidate || candidate.manifest.buildId !== buildId)
        return known("UPDATE_CANDIDATE_CHANGED");
      let preferences: z.infer<typeof UpdatePreferences>;
      try {
        preferences = await readPreferences();
      } catch {
        return {
          ok: false as const,
          code: "UPDATE_PREFERENCES_UNREADABLE",
          recoveryRequired: true,
        };
      }
      await writeRecord(preferencesFile, {
        ...preferences,
        deferredVersion: candidate.manifest.version,
      });
      return { ok: true as const };
    },
    ...(localArchive
      ? {
          prepareLocal: async () => {
            if (
              supervised?.replaceReady &&
              !(await observeSupervisedReadyUpdate(
                options.userData,
                supervised.replaceReady,
              ))
            )
              return known("UPDATE_ORIGINAL_READY_CHANGED");
            const manifest = localArchive.manifest;
            if (
              !manifest ||
              manifest.channel !==
                (options.build.updateChannel === "github-stable"
                  ? "stable"
                  : "owner-beta")
            )
              return known("UPDATE_LOCAL_MANIFEST_INVALID");
            let current: z.infer<typeof AcceptedBuild>;
            try {
              current = await readAcceptedSource();
            } catch {
              return known("UPDATE_SOURCE_IDENTITY_UNCONFIRMED");
            }
            if (
              current.buildId !== options.build.buildId ||
              current.version !== options.build.version
            )
              return known("UPDATE_SOURCE_IDENTITY_MISMATCH");
            if (
              !isIncreasingUpdate(
                manifest,
                current.version,
                options.build.buildVersion!,
              )
            )
              return known("UPDATE_LOCAL_VERSION_MISMATCH");
            return stageSelectedUpdate(manifest, async (verifyPackage) => {
              const imported = await transport.importLocal(
                localArchive.path,
                manifest,
              );
              if (!imported.ok) {
                if (imported.certainty === "unknown")
                  transportOutcomeUnknown = true;
                return { ok: false, code: imported.kind };
              }
              const archive = imported.value;
              stagedDownloadHandle = archive.handle;
              if (
                archive.size !== manifest.archiveSize ||
                archive.sha256 !== manifest.archiveSha256
              )
                return { ok: false, code: "checksum_mismatch" };
              const checked = await verifyPackage(archive.handle, manifest);
              if (!checked.ok) return { ok: false, code: checked.kind };
              if (!packageMatchesRelease(checked.value.identity, manifest))
                return { ok: false, code: "package_mismatch" };
              return {
                ok: true,
                value: { handle: archive.handle, manifest, ...checked.value },
              };
            });
          },
        }
      : {}),
    retain: async (update: ReadyUpdate) => {
      if (
        supervised?.replaceReady &&
        !(await observeSupervisedReadyUpdate(
          options.userData,
          supervised.replaceReady,
        ))
      )
        throw new Error("UPDATE_ORIGINAL_READY_CHANGED");
      // Later retains the archive, not an extra expanded application. Restart
      // re-verifies the same archive before copying it to the helper's stage.
      retained = {
        schema: "farol.ready-update/1",
        ...update,
        operation: null,
        ...(downloadId === undefined ? {} : { downloadId }),
      };
      try {
        await writeRecord(readyFile, retained);
      } catch {
        // A lost acknowledgment may have committed ready.json. Keep that archive
        // for startup reconciliation; do not reclaim it as a failed write.
        if ((await readRecord(readyFile)) !== null)
          throw new Error("UPDATE_READY_COMMIT_UNKNOWN");
        const pending = DownloadIntent.parse(
          await readRecord(pendingDownloadFile),
        );
        if (
          pending.buildId !== update.manifest.buildId ||
          pending.archiveSha256 !== update.manifest.archiveSha256
        )
          throw new Error("UPDATE_STAGING_OUTCOME_UNKNOWN");
        if (!(await discardVerifiedStage(update.handle)))
          throw new Error("UPDATE_STAGING_OUTCOME_UNKNOWN");
        const cleanup = await transport.discard(update.handle);
        if (!cleanup.ok) throw new Error("UPDATE_STAGING_OUTCOME_UNKNOWN");
        if (pending.download) await removeDownloadStage(pending.download);
        await fs.unlink(pendingDownloadFile);
        stagedDownloadHandle = null;
        retained = null;
        return known("UPDATE_READY_PERSIST_FAILED");
      }
      if (!(await discardVerifiedStage(update.handle)))
        throw new Error("UPDATE_STAGING_OUTCOME_UNKNOWN");
      await fs.unlink(pendingDownloadFile);
      return undefined;
    },
    restore: async (action) => {
      if (supervised)
        return {
          status: "blocked",
          code: "UPDATE_SUPERVISED_RESTORE_UNQUALIFIED",
        };
      if (options.goCoreArtifact === undefined)
        return { status: "blocked", code: "UPDATE_HELPER_GO_CORE_REQUIRED" };
      if (admissions.releaseUnconfirmed())
        return {
          status: "blocked",
          code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
        };
      if (admissions.held())
        return { status: "unknown", code: "UPDATE_RESTORE_OUTCOME_UNKNOWN" };
      const op = restorable?.operation;
      if (
        action === "rollback" &&
        op &&
        legacyPredecessorRequiresStateRecovery(
          op.source.version,
          op.target.version,
        )
      )
        return {
          status: "blocked",
          code: "UPDATE_PREDECESSOR_STATE_UNQUALIFIED",
        };
      if (
        !op ||
        restoreKind !== action ||
        operation ||
        !(await recordAbsent(restoreFile))
      )
        return { status: "blocked", code: "UPDATE_RESTORE_NOT_READY" };
      if (action === "recover" && !(await originalHelperEnded(restorable!)))
        return { status: "blocked", code: "UPDATE_HELPER_EXIT_UNCONFIRMED" };
      const helperLifetime = options.helperLifetime;
      if (!helperLifetime?.available())
        return {
          status: "blocked",
          code: "UPDATE_HELPER_LIFETIME_UNAVAILABLE",
        };
      const admission = await admissions.acquire();
      if (!admission.ok) return { status: "blocked", code: admission.code };
      let keepAdmission = false;
      const attempt = async (): Promise<UpdateHandoff> => {
        try {
          if (!(await drained()))
            return { status: "blocked", code: "UPDATE_WORK_PENDING" };
          const journal = await readJournal(op);
          const current = await readBuild(slot);
          if (
            current.buildId !== options.build.buildId ||
            (!sameBuild(current, op.source) && !sameBuild(current, op.target))
          )
            return {
              status: "blocked",
              code: "UPDATE_SOURCE_IDENTITY_MISMATCH",
            };
          const processStart = await captureInstalledProcessStart(process.pid);
          let restoreIntent: z.infer<typeof RestoreIntent> = {
            schema: "farol.update-restore-intent/1",
            action,
            operation: op,
            priorPhase: journal.phase,
            installedBefore: current,
            helper: null,
          };
          const currentAdmission = await recheckAdmission(admission);
          if (!currentAdmission.ok)
            return { status: "blocked", code: currentAdmission.code };
          await writeRecord(restoreFile, restoreIntent);
          keepAdmission = true;
          const handoff = await startInstalledUpdateHelper(
            await selectUpdateHelper(current, () => undefined),
            {
              action,
              ...op,
              installLocation:
                slot === "/Applications/Farol.app" ? "shared" : "legacy",
              drain: {
                status: "reconciled",
                acceptedSource: op.source.buildId,
                acceptedTarget: op.target.buildId,
              },
              pid: process.pid,
              processStart,
              waitSeconds: 120,
              relaunch: true,
              ...(options.relaunchPresentation
                ? { relaunchPresentation: options.relaunchPresentation }
                : {}),
            },
            {
              lifetime: helperLifetime,
              recordSpawn: async (spawned) => {
                operation = spawned;
                if (spawned.pid === null)
                  throw new Error("UPDATE_HELPER_IDENTITY_UNKNOWN");
                restoreIntent = {
                  ...restoreIntent,
                  helper: { pid: spawned.pid, processStart: null },
                };
                await writeRecord(restoreFile, restoreIntent);
                restoreIntent = {
                  ...restoreIntent,
                  helper: {
                    pid: spawned.pid,
                    processStart: await captureInstalledProcessStart(
                      spawned.pid,
                    ),
                  },
                };
                await writeRecord(restoreFile, restoreIntent);
              },
            },
          );
          operation = handoff.operation;
          if (
            (handoff.status === "refused" ||
              handoff.status === "not_started") &&
            (await confirmedNoEffect(handoff))
          ) {
            if (
              (await readJournal(op)).phase !== journal.phase ||
              !sameBuild(await readBuild(slot), current)
            )
              return {
                status: "unknown",
                code: "UPDATE_RESTORE_OUTCOME_UNKNOWN",
              };
            if (handoff.status === "not_started")
              await writeRecord(restoreFile, {
                schema: "farol.update-restore-intent/1",
                action,
                operation: op,
                priorPhase: journal.phase,
                notStartedAt: current,
              });
            await writeRecord(path.join(root, op.operationId, "refusal.json"), {
              schema: "farol.update-refusal/1",
              action,
              operation: op,
              code: handoff.reason,
              priorPhase: journal.phase,
            });
            await clearRestoreIntent();
            operation = null;
            keepAdmission = false;
            return {
              status: "blocked",
              code: helperNoEffectCode(handoff.status),
            };
          }
          if (handoff.status !== "ready")
            return {
              status: "unknown",
              code: "UPDATE_RESTORE_OUTCOME_UNKNOWN",
            };
          options.quit();
          return { status: "accepted" };
        } catch {
          return restoreFailureHandoff(keepAdmission);
        }
      };
      return admissions.settle(
        admission,
        () => keepAdmission,
        attempt,
        () => "UPDATE_RESTORE_OUTCOME_UNKNOWN",
      );
    },
    restart: (update, confirmation) => apply(update, undefined, confirmation),
    canInstallOnNormalQuit: () => origin?.kind !== "private-launch",
    applyOnQuit: (update, context) => apply(update, context),
  };
  const controller = new InstalledUpdater(
    recordedUpdaterPorts(options.operations, updaterPorts),
  );
  const apply = async (
    update: ReadyUpdate,
    quitContext?: NormalQuitApplyContext,
    confirmation?: ConfirmedUpdateRestart,
  ): Promise<UpdateHandoff> => {
    // The Python helper is retired. A build without its compiled Go core can
    // run no update helper, so refuse before any admission, copy or binding.
    const entryRefusal = applyEntryRefusal({
      releaseUnconfirmed: admissions.releaseUnconfirmed(),
      admissionHeld: admissions.held(),
      operationActive: !!operation,
      retainedOperation: !!retained?.operation,
      retainedPreparation: !!retained?.preparation,
      packageReady: !!retained && retained.handle === update.handle,
      goCoreRequired: options.goCoreArtifact === undefined,
      supervised: !!supervised,
      lifetimeAvailable: () => !!options.helperLifetime?.available(),
    });
    if (entryRefusal) return entryRefusal;
    const confirmedManifest = confirmation
      ? parseRetainedGithubReleaseManifest(retained!)
      : null;
    if (
      confirmation &&
      confirmationStale({
        confirmation,
        quitApply: !!quitContext,
        updateVersion: update.manifest.version,
        retainedVersion: confirmedManifest?.ok
          ? confirmedManifest.value.version
          : null,
      })
    )
      return { status: "blocked", code: "UPDATE_CONFIRMATION_STALE" };
    let keepAdmission = false;
    let bindingPublicationUnknown = false;
    const expired = () =>
      quitContext !== undefined &&
      (quitDeadlineExpired(Date.now(), quitContext.deadlineAt) ||
        options.canStartNormalQuitEffect?.() === false);
    const ensureActive = () => {
      if (expired()) throw new Error("UPDATE_QUIT_DEADLINE_EXPIRED");
    };
    const wait = async <T>(run: () => Promise<T>): Promise<T> => {
      if (!quitContext) return run();
      ensureActive();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          run(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("UPDATE_QUIT_DEADLINE_EXPIRED")),
              quitTimerDelayMs(Date.now(), quitContext.deadlineAt),
            );
          }),
        ]);
        ensureActive();
        return value;
      } finally {
        clearTimeout(timer);
      }
    };
    // Any restore record, valid or not, fences an apply. Admission is destructive
    // (it releases the ChatGPT window and connector), so refuse before acquiring
    // it, and before the dispatch record or a helper.
    try {
      if (!(await wait(() => recordAbsent(restoreFile))))
        return { status: "blocked", code: "UPDATE_RESTORE_NOT_READY" };
    } catch {
      return { status: "blocked", code: "UPDATE_RESTORE_NOT_READY" };
    }
    let admission: InstalledUpdateAdmission;
    try {
      admission = await wait(async () => {
        const acquired = await admissions.acquire(
          ensureActive,
          quitContext,
          confirmation,
        );
        // If the host timed out while acquiring, retain the original lease
        // until its actual result can be settled. Timeout is not cancellation.
        if (acquired.ok && quitContext) admissions.hold(acquired);
        return acquired;
      });
    } catch {
      return { status: "unknown", code: "UPDATE_QUIT_ADMISSION_UNKNOWN" };
    }
    if (!admission.ok) return { status: "blocked", code: admission.code };
    if (quitContext) admissions.hold(null);
    const admitted = admission;
    const attempt = async (): Promise<UpdateHandoff> => {
      if (!retained || retained.handle !== update.handle)
        return { status: "blocked", code: "UPDATE_PACKAGE_NOT_READY" };
      try {
        if (!(await wait(() => drained(ensureActive))))
          return { status: "blocked", code: "UPDATE_WORK_PENDING" };
        const source = await wait(() => readAcceptedSource(ensureActive));
        if (
          source.buildId !== options.build.buildId ||
          source.version !== options.build.version
        )
          return {
            status: "blocked",
            code: "UPDATE_SOURCE_IDENTITY_MISMATCH",
          };
        if (
          !isIncreasingUpdate(
            update.manifest,
            source.version,
            options.build.buildVersion!,
          )
        )
          return {
            status: "blocked",
            code: "UPDATE_RETAINED_VERSION_MISMATCH",
          };
        const processStart =
          supervised?.predecessor.processStart ??
          (await wait(() => captureInstalledProcessStart(process.pid)));
        if (quitContext) {
          keepAdmission = true;
          await wait(() =>
            writeRecord(
              cleanupFile,
              {
                schema: "farol.update-package-cleanup/1",
                handle: update.handle,
              },
              ensureActive,
            ),
          );
        }
        const check = await wait(() =>
          transport.verifyPackage(update.handle, update.manifest),
        );
        const verification = classifyPackageVerification(
          check,
          check.ok &&
            packageMatchesRelease(check.value.identity, update.manifest),
        );
        if (verification !== "verified" || !check.ok) {
          if (quitContext) keepAdmission = verification === "outcome_unknown";
          if (quitContext && !keepAdmission)
            await wait(() => fs.unlink(cleanupFile));
          return verificationHandoff(verification);
        }
        if (quitContext) {
          await wait(() => fs.unlink(cleanupFile));
          keepAdmission = false;
        }
        verified = {
          handle: update.handle,
          manifest: update.manifest,
          ...check.value,
        };
        const target = {
          digest: verified.identity.artifactSha256,
          version: verified.identity.version,
          buildId: verified.identity.buildId,
        };
        const firstRecheck = await wait(() => recheckAdmission(admitted));
        if (!firstRecheck.ok)
          return { status: "blocked", code: firstRecheck.code };
        const operationId = randomBytes(16).toString("hex");
        const operationRoot = path.join(root, operationId);
        const preparing = { operationId, source, target };
        // Immutable slot identity precedes durable dispatch/preparation. A lost
        // publication reply stays fenced; never repair an authoritative old op.
        ensureActive();
        await wait(() => fs.mkdir(operationRoot, { mode: 0o700 }));
        const priorAdmission = keepAdmission;
        keepAdmission = true;
        bindingPublicationUnknown = true;
        await wait(async () =>
          publishInstalledOperationBinding(
            await selectBindingHelper(source, ensureActive),
            preparing,
            installLocation,
            ensureActive,
          ),
        );
        bindingPublicationUnknown = false;
        keepAdmission = priorAdmission;
        // Record allocation before copying. This phase proves no helper was
        // dispatched; startup may reconcile only this exact unfinished copy.
        ensureActive();
        if (quitContext) keepAdmission = true;
        retained = { ...retained, preparation: preparing };
        await wait(() => writeRecord(readyFile, retained, ensureActive));
        if (quitContext)
          await wait(() =>
            writeRecord(
              cleanupFile,
              {
                schema: "farol.update-package-cleanup/1",
                handle: update.handle,
                operationRoot,
              },
              ensureActive,
            ),
          );
        let copied = false;
        try {
          await wait(() =>
            options.copyApp(
              verified!.stagedAppPath,
              path.join(operationRoot, "staged.app"),
            ),
          );
          copied = true;
        } catch (error) {
          if (quitContext && expired()) throw error;
          try {
            await wait(() => removePreparedCopy(preparing, ensureActive));
            retained = { ...retained, preparation: undefined };
            await wait(() => writeRecord(readyFile, retained, ensureActive));
          } catch {
            ensureActive();
            await wait(() =>
              writeRecord(
                cleanupFile,
                {
                  schema: "farol.update-package-cleanup/1",
                  handle: update.handle,
                  operationRoot,
                },
                ensureActive,
              ),
            );
            return {
              status: "unknown",
              code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
            };
          }
        }
        if (
          !(await wait(() => discardVerifiedStage(update.handle, ensureActive)))
        )
          return {
            status: "unknown",
            code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
          };
        // The existing cleanup fence keeps fresh owners from reclaiming a
        // still-running copy after this owner times out. Clear only after its
        // actual completion and staging cleanup are known.
        if (quitContext) await wait(() => fs.unlink(cleanupFile));
        if (!copied) {
          keepAdmission = false;
          return { status: "blocked", code: "UPDATE_PREPARE_FAILED" };
        }
        retained = {
          ...retained,
          preparation: undefined,
          operation: preparing,
        };
        // Copying and physical verification can take time. Re-read fenced
        // browser state immediately before durable dispatch, not just at click.
        const finalRecheck = await wait(() => recheckAdmission(admitted));
        if (!finalRecheck.ok) {
          retained = { ...retained, operation: null, preparation: preparing };
          await wait(() => writeRecord(readyFile, retained, ensureActive));
          await wait(() => removePreparedCopy(preparing, ensureActive));
          retained = { ...retained, preparation: undefined };
          await wait(() => writeRecord(readyFile, retained, ensureActive));
          keepAdmission = false;
          return { status: "blocked", code: finalRecheck.code };
        }
        try {
          await wait(() => verifyBinding(preparing));
        } catch {
          keepAdmission = true;
          return { status: "unknown", code: "UPDATE_SLOT_BINDING_UNCONFIRMED" };
        }
        // Durable dispatch intent precedes launch. A failed commit may already
        // have persisted dispatch, so keep admission even when its sync fails.
        keepAdmission = true;
        await wait(() => writeRecord(readyFile, retained, ensureActive));
        const helper = await wait(() =>
          selectUpdateHelper(source, ensureActive),
        );
        const handoff = await wait(() =>
          startInstalledUpdateHelper(
            helper,
            {
              action: "apply",
              installLocation:
                slot === "/Applications/Farol.app" ? "shared" : "legacy",
              operationId,
              source,
              target,
              drain: {
                status: "reconciled",
                acceptedSource: source.buildId,
                acceptedTarget: target.buildId,
              },
              ...(supervised
                ? {
                    predecessor: {
                      kind: "confirmed_closed" as const,
                      startedAt: supervised.predecessor.startedAt,
                      lastQuitSha256: supervised.predecessor.quitDigest,
                      stateIdentity: supervised.predecessor.stateIdentity,
                    },
                  }
                : {}),
              pid: supervised?.predecessor.pid ?? process.pid,
              processStart,
              waitSeconds: 120,
              // First-transition recovery must be qualified before the target
              // can write its state. Ordinary installed updates still relaunch.
              relaunch: !supervised && !quitContext,
              ...(!supervised && !quitContext && options.relaunchPresentation
                ? { relaunchPresentation: options.relaunchPresentation }
                : {}),
            },
            {
              ...(!supervised && options.helperLifetime
                ? { lifetime: options.helperLifetime }
                : {}),
              ...(supervised ? { promotionLease: supervised.transfer } : {}),
              ...(quitContext
                ? {
                    // Native launcher preflight must consume the same absolute
                    // fence; a relative readiness timer starts too late.
                    deadlineAt: quitContext.deadlineAt,
                    canStartEffect: () => {
                      try {
                        ensureActive();
                        return true;
                      } catch {
                        return false;
                      }
                    },
                    readinessTimeoutMs: readinessTimeoutMs(
                      Date.now(),
                      quitContext.deadlineAt,
                    ),
                  }
                : {}),
              recordSpawn: async (spawned) => {
                operation = spawned;
                // The external supervisor must retain this original child even
                // if recording or measuring its identity subsequently fails.
                supervised?.observeHelper(spawned);
                ensureActive();
                if (spawned.pid === null)
                  throw new Error("UPDATE_HELPER_IDENTITY_UNKNOWN");
                // Record before helper code or request bytes are sent, then enrich
                // with start time. A failed observation preserves the actual PID.
                retained = {
                  ...retained!,
                  helper: { pid: spawned.pid, processStart: null },
                };
                await wait(() =>
                  writeRecord(readyFile, retained, ensureActive),
                );
                retained = {
                  ...retained,
                  helper: {
                    pid: spawned.pid,
                    processStart: await wait(() =>
                      captureInstalledProcessStart(spawned.pid!),
                    ),
                  },
                };
                await wait(() =>
                  writeRecord(readyFile, retained, ensureActive),
                );
              },
            },
          ).then((handoff) => {
            operation = handoff.operation;
            return handoff;
          }),
        );
        operation = handoff.operation;
        if (
          (handoff.status === "not_started" || handoff.status === "refused") &&
          (await wait(() => confirmedNoEffect(handoff)))
        ) {
          if (
            (await wait(() =>
              readRecord(path.join(operationRoot, "journal.json")),
            )) !== null ||
            !sameBuild(await wait(() => readBuild(slot, ensureActive)), source)
          )
            return { status: "unknown", code: "UPDATE_HANDOFF_UNKNOWN" };
          await wait(() =>
            writeRecord(
              path.join(root, `${operationId}-refusal.json`),
              {
                schema: "farol.update-refusal/1",
                action: "apply",
                operation: preparing,
                code: handoff.reason,
              },
              ensureActive,
            ),
          );
          // The same launch has a confirmed pre-mutation outcome. Commit that
          // proof as preparation before reclaiming its copy, including after a
          // helper refusal. Never leave a dispatch intent pointing at removed bytes.
          retained = {
            ...retained,
            operation: null,
            helper: null,
            preparation: preparing,
          };
          await wait(() => writeRecord(readyFile, retained, ensureActive));
          await wait(() => removePreparedCopy(preparing, ensureActive));
          retained = { ...retained, preparation: undefined };
          await wait(() => writeRecord(readyFile, retained, ensureActive));
          operation = null;
          keepAdmission = false;
          return {
            status: "blocked",
            code: helperNoEffectCode(handoff.status),
          };
        }
        // Keep the same operation observable even on an uncertain ACK. No substitute helper.
        void operation.completion.then((result) => {
          process.stderr.write(
            `farol-update-helper ${JSON.stringify({ operationId, code: result.code, phase: result.terminal?.phase ?? "unknown" })}\n`,
          );
        });
        if (!handoffAdmitted(handoff, !!supervised))
          return unadmittedHandoff(handoff.status);
        ensureActive();
        if (!supervised && !quitContext) options.quit();
        return { status: "accepted" };
      } catch {
        if (bindingPublicationUnknown)
          return { status: "unknown", code: "UPDATE_SLOT_BINDING_UNCONFIRMED" };
        if (quitContext && expired()) return quitFailureHandoff(keepAdmission);
        if (
          verified &&
          !(await wait(() =>
            discardVerifiedStage(verified!.handle, ensureActive),
          ))
        )
          return {
            status: "unknown",
            code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
          };
        if (stagingUncertain || retained?.preparation)
          return {
            status: "unknown",
            code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
          };
        return prepareFailureHandoff(keepAdmission);
      }
    };
    return admissions.settle(
      admission,
      () => keepAdmission,
      attempt,
      () => applyUnsettledCode(keepAdmission),
    );
  };

  return controller;
}
