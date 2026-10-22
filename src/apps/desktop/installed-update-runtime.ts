import { recordedUpdaterPorts } from "../../../apps/desktop/operations/updater";
import type { OperationsRecorder } from "../../../apps/desktop/renderer/operations-contract";
import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
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
import { treeDigest } from "../../pkg/artifact-tree-digest/digest";
import {
  ADOPTED_BASELINE_FILE,
  SHARED_SLOT,
  adoptedRecordFor,
  adoptionBuildEligible,
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

const execute = promisify(execFile);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const UpdatePreferences = z.strictObject({
  schema: z.literal("farol.installed-update-preferences/1"),
  skipped: z
    .strictObject({ version: z.string().max(128), buildId: Digest })
    .nullable(),
  deferredVersion: z.string().max(128).nullable().optional(),
});
// Keep the strict legacy Skip/Later record readable by prior installed builds.
// Notice preferences share this release owner, root and guarded record I/O.
const NoticePreferences = z.strictObject({
  schema: z.literal("farol.installed-update-notices/1"),
  seenVersion: z.string().max(128).nullable().optional(),
  failureNotice: z
    .strictObject({
      version: z.string().max(128).nullable(),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/u),
      key: z.string().regex(/^failure:[a-f0-9]{24}$/u),
      seen: z.boolean(),
    })
    .nullable()
    .optional(),
});
// Separate file/schema: older strict Skip/Later and notice readers stay compatible.
const AutomaticUpdatePreferences = z.discriminatedUnion("schema", [
  z.strictObject({
    schema: z.literal("farol.installed-automatic-update-preference/1"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    schema: z.literal("farol.installed-automatic-update-preference/2"),
    scope: z.literal("download-and-install"),
    enabled: z.boolean(),
  }),
]);
const InstallOnQuitPreferences = z.strictObject({
  schema: z.literal("farol.installed-install-on-quit-preference/1"),
  scope: z.literal("install-on-normal-quit"),
  enabled: z.boolean(),
});
// A separately scoped write fence survives a lost preference-write ACK. A fresh
// owner must not infer consent from possibly committed, valid-looking bytes.
const InstallOnQuitUnconfirmed = z.strictObject({
  schema: z.literal("farol.installed-install-on-quit-unconfirmed/1"),
  enabled: z.boolean(),
});
const AcceptedBuild = z.strictObject({
  digest: Digest,
  version: z.string().max(128),
  buildId: Digest,
});
const PromotionReceipt = z.strictObject({
  schema: z.literal("farol.promotion-plan/1"),
  operation: z.literal("applied"),
  product: z.literal("Farol"),
  version: z.string().max(128),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceTreeDigest: Digest,
  sourceDirty: z.literal(false),
  artifactSha256: Digest,
  source: z.string().max(4096),
  destination: z.string().max(4096),
  receipt: z.string().max(4096),
  overwrite: z.literal(false),
  legacyMutation: z.literal(false),
  activation: z.strictObject({
    userData: z.string().max(4096),
    drained: z.literal(true),
    obligations: z.array(z.never()).length(0),
  }),
  verifiedDestinationSha256: Digest,
});
// A cold repair is a distinct installer result, never a synthetic live-update receipt.
const ClosedRepairReceipt = z.strictObject({
  schema: z.literal("farol.closed-repair/1"),
  operationId: z.string().regex(/^[a-f0-9]{32}$/u),
  phase: z.enum(["installed", "rolled_back"]),
  destination: z.string().max(4096),
  userData: z.string().max(4096),
  source: AcceptedBuild,
  target: AcceptedBuild,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceTreeDigest: Digest,
  sourceDirty: z.literal(false),
  previous: z.string().max(4096),
  quarantine: z.string().max(4096),
  quarantined: z.boolean(),
  quitDigest: Digest,
});
const RepairInode = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const ClosedRepairJournal = z.strictObject({
  schema: z.literal("farol.closed-repair-journal/1"),
  phase: z.enum(["installed", "rolled_back"]),
  receipt: ClosedRepairReceipt,
  sourceInode: RepairInode,
  targetInode: RepairInode,
  updatesInode: RepairInode.nullable(),
});
const Operation = z.strictObject({
  operationId: z.string().regex(/^[a-f0-9]{32}$/u),
  source: AcceptedBuild,
  target: AcceptedBuild,
});
const Retained = z.strictObject({
  schema: z.literal("farol.ready-update/1"),
  handle: z.string().max(4096),
  manifest: z.unknown(),
  notes: z.string().max(4096).optional(),
  operation: Operation.nullable(),
  downloadId: z
    .string()
    .regex(/^[a-f0-9]{32}$/u)
    .optional(),
  preparation: Operation.optional(),
  archiveReleased: z.boolean().optional(),
  helper: z
    .strictObject({
      pid: z.number().int().min(2),
      processStart: z.string().min(1).max(128).nullable(),
    })
    .nullable()
    .optional(),
});
const DownloadStage = z.strictObject({
  phase: z.enum(["downloading", "verifying"]).optional(),
  id: z.string().regex(/^[a-f0-9]{32}$/u),
  producer: z.strictObject({
    pid: z.number().int().min(2),
    processStart: z.string().min(1).max(128),
  }),
  identity: z
    .strictObject({
      dev: z.string().regex(/^[0-9]{1,30}$/u),
      ino: z.string().regex(/^[0-9]{1,30}$/u),
      birthtimeNs: z.string().regex(/^[0-9]{1,30}$/u),
    })
    .optional(),
});
const DownloadIntent = z.strictObject({
  schema: z.literal("farol.update-download-intent/1"),
  download: DownloadStage.optional(),
  buildId: Digest,
  archiveSha256: Digest,
});
const Journal = Operation.extend({
  schema: z.literal("farol.installed-update-journal/1"),
  phase: z.enum([
    "prepared",
    "predecessor_saved",
    "new_installed",
    "verified",
    "rollback_started",
    "rolled_back",
    "launch_requested",
    "completed",
    "cancelled",
    "cancel_launch_requested",
    "cancel_completed",
    "rollback_launch_requested",
    "rollback_completed",
  ]),
});
const SavedReceipt = Retained.extend({
  observedAt: z.string().max(64),
  phase: Journal.shape.phase,
  runningBuildId: Digest,
});
const RestoreIntent = z.strictObject({
  schema: z.literal("farol.update-restore-intent/1"),
  action: z.enum(["recover", "rollback"]),
  operation: Operation,
  priorPhase: Journal.shape.phase,
  notStartedAt: AcceptedBuild.optional(),
  installedBefore: AcceptedBuild.optional(),
  helper: Retained.shape.helper,
});
const ROLLED_BACK_PHASES = [
  "rolled_back",
  "rollback_launch_requested",
  "rollback_completed",
];
const CANCELLED_PHASES = [
  "cancelled",
  "cancel_launch_requested",
  "cancel_completed",
];
const TARGET_PHASES = ["verified", "launch_requested", "completed"];
const MAX_RECORD_BYTES = 65536;
const ProcessStart = z
  .string()
  .max(128)
  .regex(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u,
  );
const RelaunchHint = z.strictObject({
  operationId: Operation.shape.operationId,
  action: z.enum(["apply", "recover", "rollback"]),
  phase: z.enum(["completed", "cancel_completed", "rollback_completed"]),
  helper: z.strictObject({
    pid: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
    processStart: ProcessStart,
  }),
  buildId: Digest,
});
const RELAUNCH_ARGUMENT = "--farol-installed-update-relaunch";

function sameBuild(
  a: z.infer<typeof AcceptedBuild>,
  b: z.infer<typeof AcceptedBuild>,
): boolean {
  return (
    a.digest === b.digest && a.version === b.version && a.buildId === b.buildId
  );
}

function isIncreasingUpdate(
  manifest: Pick<ReleaseManifest, "version" | "buildVersion">,
  currentVersion: string,
  currentBuildVersion: string,
): boolean {
  const order = compareReleaseVersions(manifest.version, currentVersion);
  return (
    order !== null &&
    order > 0 &&
    BigInt(manifest.buildVersion) > BigInt(currentBuildVersion)
  );
}

function sameOperation(
  a: z.infer<typeof Operation>,
  b: z.infer<typeof Operation>,
): boolean {
  return (
    a.operationId === b.operationId &&
    sameBuild(a.source, b.source) &&
    sameBuild(a.target, b.target)
  );
}

async function readOperationBinding(
  root: string,
  op: z.infer<typeof Operation>,
  location: InstalledAppLocation,
  read: typeof readRecord = readRecord,
  purpose: "update" | "ordinary-shared-execution" = "update",
): Promise<void> {
  if (purpose === "ordinary-shared-execution" && location !== "shared")
    throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
  const directory = path.join(root, op.operationId);
  const physical = read === readRecord;
  if (physical) {
    await canonicalOwnedDirectory(root, true);
    await canonicalOwnedDirectory(directory, true);
  }
  const before = physical ? await fs.lstat(directory) : null;
  const parent = physical ? await fs.lstat(root) : null;
  let digest: string | null = null;
  const expected = installedSlotBindingBytes(op, location);
  const raw = await read(
    path.join(root, op.operationId, INSTALLED_SLOT_BINDING_FILE),
    true,
    (value) => {
      digest = value;
    },
    8192,
  );
  if (before) {
    await canonicalOwnedDirectory(directory, true);
    const after = await fs.lstat(directory);
    await canonicalOwnedDirectory(root, true);
    const liveParent = await fs.lstat(root);
    if (
      !parent ||
      liveParent.dev !== parent.dev ||
      liveParent.ino !== parent.ino ||
      liveParent.mode !== parent.mode ||
      liveParent.uid !== parent.uid
    )
      throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.uid !== before.uid
    )
      throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
  }
  // A historical record can authenticate the exact current executable image
  // without gaining authority to continue or mutate its unbound update. Keep
  // private-file/parent checks and every present binding strict. All helper,
  // recovery and correlated relaunch callers retain the default update purpose.
  if (
    raw === null &&
    digest === null &&
    purpose === "ordinary-shared-execution"
  )
    return;
  if (
    raw === null ||
    digest !== createHash("sha256").update(expected).digest("hex")
  )
    throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
}

async function readOperationJournal(
  root: string,
  op: z.infer<typeof Operation>,
  location: InstalledAppLocation,
  read: typeof readRecord = readRecord,
): Promise<z.infer<typeof Journal>> {
  return Journal.parse(
    await readStartupOperationJournal(root, op, location, read),
  );
}

async function readStartupOperationJournal(
  root: string,
  op: z.infer<typeof Operation>,
  location: InstalledAppLocation,
  read: typeof readRecord = readRecord,
  purpose: "update" | "ordinary-shared-execution" = "update",
  absent: typeof recordAbsent = recordAbsent,
): Promise<z.infer<typeof Journal> | null> {
  await readOperationBinding(root, op, location, read, purpose);
  const file = path.join(root, op.operationId, "journal.json");
  const raw = await read(file);
  if (raw === null) {
    // JSON null is malformed journal evidence, not the pre-journal crash window.
    // Preserve it; only a separate ENOENT observation permits the none row.
    if (!(await absent(file)))
      throw new Error("UPDATE_OPERATION_JOURNAL_INVALID");
    return null;
  }
  const journal = Journal.parse(raw);
  if (!sameOperation(journal, op))
    throw new Error("UPDATE_OPERATION_IDENTITY_MISMATCH");
  return journal;
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

async function readInstalledProcess(
  pid: number,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    timeout: 3000,
    maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
}

async function observeInstalledHelper(
  helper: z.infer<typeof Retained>["helper"],
  read: typeof readInstalledProcess = readInstalledProcess,
): Promise<"live" | "ended" | "changed" | "unknown"> {
  if (!helper) return "unknown";
  try {
    const { stdout, stderr } = await read(helper.pid);
    if (
      helper.processStart === null ||
      stderr ||
      !ProcessStart.safeParse(stdout.trim()).success
    )
      return "unknown";
    return stdout.trim() === helper.processStart ? "live" : "changed";
  } catch (error) {
    // Only the existing clean ps absence classification establishes termination.
    const result = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    } | null;
    return result?.code === 1 && result.stdout === "" && result.stderr === ""
      ? "ended"
      : "unknown";
  }
}

type RejectedDirectoryStat = Pick<
  BigIntStats,
  "dev" | "ino" | "uid" | "mode" | "isDirectory"
>;

async function openRejectedDirectory(directory: string): Promise<
  Readonly<{
    stat(): Promise<RejectedDirectoryStat>;
    close(): Promise<void>;
  }>
> {
  const fd = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  return { stat: () => fd.stat({ bigint: true }), close: () => fd.close() };
}

const readRejectedEntry = (file: string): Promise<RejectedDirectoryStat> =>
  fs.lstat(file, { bigint: true });

export type InstalledUpdateResourcesOrigin = Readonly<{
  slot: "/Applications/Farol.app";
  app: string;
  execution: InstalledExecutionSnapshot;
  recheck(): Promise<void>;
  recheckUpdateSource(): Promise<void>;
}> &
  (
    | Readonly<{ kind: "shared-slot" }>
    | Readonly<{ kind: "private-launch"; operationId: string }>
  );
export type InstalledUpdateRelaunchGuard = Readonly<{
  recheck(): Promise<void>;
  resourcesOrigin?: InstalledUpdateResourcesOrigin;
}>;

export type InstalledUpdateRelaunchOptions = Readonly<{
  args: readonly string[];
  directory: string;
  userData: string;
  build: BuildIdentity;
  // Production Electron supplies its physical, non-ASAR filesystem and copier.
  physicalFiles?: typeof fs;
  copyApp?(source: string, destination: string): Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  // Read-only seams for pure fixtures; production uses the existing native owners.
  observation?: Readonly<{
    canonicalOwnedDirectory: typeof canonicalOwnedDirectory;
    readRecord: typeof readRecord;
    readBuild(
      directory: string,
      file: string,
      timeoutMs: number,
    ): Promise<unknown>;
    readProcess: typeof readInstalledProcess;
    // Startup adoption only: real-absence probe and atomic record publisher.
    recordAbsent?: typeof recordAbsent;
    writeRecord?: (file: string, value: unknown) => Promise<void>;
    rejectedDirectory?: Readonly<{
      openDirectory: typeof openRejectedDirectory;
      lstat: typeof readRejectedEntry;
    }>;
  }>;
}>;

// Runtime resources keep their own immutable private authority. Only an
// updater admission checks that the mutable public source still matches it.
async function recheckSharedUpdateSource(
  options: InstalledUpdateRelaunchOptions,
  expected: z.infer<typeof AcceptedBuild>,
): Promise<void> {
  const slot = "/Applications/Farol.app";
  const canonical =
    options.observation?.canonicalOwnedDirectory ?? canonicalOwnedDirectory;
  await canonical(slot, false);
  const measured = options.observation
    ? AcceptedBuild.parse(
        await options.observation.readBuild(options.directory, slot, 30000),
      )
    : { ...expected, digest: await treeDigest(slot, options.physicalFiles) };
  if (!sameBuild(measured, expected))
    throw new Error("UPDATE_ACCEPTED_SOURCE_CHANGED");
  await canonical(slot, false);
}

// Ordinary public-slot startup must satisfy AttestedCore's immutable-tree
// contract before any backend binary is spawned. Baselines authenticate code;
// runtime lifetime and updater recovery still keep their independent gates.
async function observeSharedSlotStartup(
  options: InstalledUpdateRelaunchOptions,
): Promise<InstalledUpdateRelaunchGuard | null> {
  if (options.directory !== "/Applications/Farol.app/Contents/Resources/app")
    return null;
  const app = "/Applications/Farol.app";
  const profile = path.join(
    os.userInfo().homedir,
    "Library/Application Support/io.github.legrch.farol",
  );
  const root = path.join(profile, "installed-updates");
  const build = BuildIdentitySchema.parse(options.build);
  if (
    options.userData !== profile ||
    !options.copyApp ||
    !options.physicalFiles ||
    build.sourceDirty ||
    !build.buildVersion ||
    !["github-owner-beta", "github-stable"].includes(build.updateChannel) ||
    createHash("sha256")
      .update(canonicalBuildIdentityPayload(build))
      .digest("hex") !== build.buildId
  )
    throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
  const read = options.observation?.readRecord ?? readRecord;
  if (!options.observation) {
    await canonicalOwnedDirectory(profile, true);
    await privateDirectory(root);
  }
  const operationImage = async (record: z.infer<typeof Retained>) => {
    const op = record.operation ?? record.preparation;
    const parsed = parseRetainedGithubReleaseManifest(record);
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
    await readOperationBinding(
      root,
      op,
      "shared",
      read,
      "ordinary-shared-execution",
    );
    const expected = [op.source, op.target].find(
      (value) =>
        value.buildId === build.buildId && value.version === build.version,
    );
    if (!expected) throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    return expected;
  };
  let expected: z.infer<typeof AcceptedBuild>;
  // Set only by first-launch adoption; published after a successful capture.
  let adoption: {
    file: string;
    record: ReturnType<typeof adoptedRecordFor>;
    replacing: string | null;
  } | null = null;
  const ready = await read(path.join(root, "ready.json"));
  const saved = await read(path.join(root, "last-update.json"));
  const repair = await read(app + ".repair.json");
  const repairJournal = await read("/Applications/.farol-closed-repair.json");
  const readyRecord = ready === null ? null : Retained.parse(ready);
  const active =
    readyRecord?.operation || readyRecord?.preparation
      ? readyRecord
      : saved !== null
        ? SavedReceipt.parse(saved)
        : null;
  if (active?.operation) {
    const record = active;
    expected = await operationImage(record);
    const op = record.operation!;
    const pendingRaw = await read(path.join(root, "restore-pending.json"));
    const pending =
      pendingRaw === null ? null : RestoreIntent.parse(pendingRaw);
    if (pending && !sameOperation(pending.operation, op))
      throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    const helper = await observeInstalledHelper(
      pending && !pending.notStartedAt ? pending.helper : record.helper,
      options.observation?.readProcess ?? readInstalledProcess,
    );
    const journal = await readStartupOperationJournal(
      root,
      op,
      "shared",
      read,
      "ordinary-shared-execution",
      options.observation?.recordAbsent ?? recordAbsent,
    );
    const installed = options.observation
      ? AcceptedBuild.parse(
          await options.observation.readBuild(options.directory, app, 30000),
        )
      : { ...expected, digest: await treeDigest(app, options.physicalFiles) };
    const decision = installedUpdateStartupDecision({
      phase: journal?.phase ?? null,
      helper: startupHelperState(helper),
      installed,
      running: build,
      operation: op,
    });
    if (!decision.mayStart)
      throw new Error(
        helper === "live" || helper === "unknown"
          ? "UPDATE_HELPER_EXIT_UNCONFIRMED"
          : "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED",
      );
  } else if (active?.preparation) {
    expected = await operationImage(active);
  } else if (repair !== null || repairJournal !== null) {
    const receipt = ClosedRepairReceipt.parse(repair);
    const journal = ClosedRepairJournal.parse(repairJournal);
    if (
      receipt.destination !== app ||
      receipt.userData !== profile ||
      journal.phase !== receipt.phase ||
      JSON.stringify(journal.receipt) !== JSON.stringify(receipt)
    )
      throw new Error("UPDATE_REPAIR_RECOVERY_REQUIRED");
    expected = receipt.phase === "installed" ? receipt.target : receipt.source;
  } else {
    const file = app + ".receipt.json";
    const receiptRaw = await read(file);
    // Adoption needs every other piece of baseline evidence to be truly absent
    // (ENOENT). A file that exists, even holding JSON null, keeps the refusal
    // below. A ready record is allowed only when it is a plain retained
    // download with no operation: the user may quit between downloading an
    // update and installing it, and that must not strand an adopted copy.
    const absent = options.observation?.recordAbsent ?? recordAbsent;
    if (
      receiptRaw === null &&
      saved === null &&
      repair === null &&
      repairJournal === null &&
      // Absent, or the very retained-download record the updater itself
      // accepts (valid manifest, non-empty handle). Anything malformed refuses.
      (ready === null
        ? await absent(path.join(root, "ready.json"))
        : parseRetainedGithubReleaseManifest(Retained.parse(ready)).ok) &&
      (
        await Promise.all(
          [
            file,
            path.join(root, "last-update.json"),
            app + ".repair.json",
            "/Applications/.farol-closed-repair.json",
          ].map(absent),
        )
      ).every(Boolean)
    ) {
      const adoptedFile = path.join(root, ADOPTED_BASELINE_FILE);
      const state = await readAdoptedRecord({
        file: adoptedFile,
        slot: SHARED_SLOT,
        userData: profile,
        build,
        read,
        absent,
      });
      if (state.kind === "expected") {
        // A recorded baseline never touches the network.
        expected = { ...state.expected };
      } else {
        // The expectation comes from the published manifest, never from the
        // slot being measured. Plain Node https works before Electron is ready.
        const transport = createGithubUpdateTransport({
          privateStateDirectory: root,
          verifyPackage: async () => {
            throw new Error("UPDATE_ADOPTION_PACKAGE_UNUSED");
          },
        });
        const resolved = await resolveAdoptionManifest({
          build,
          fetchJson: (url, maximum) => transport.fetchJson(url, maximum),
        });
        if (!resolved.ok) throw new Error(resolved.code);
        const manifest = resolved.value;
        let measured: string;
        try {
          measured = options.observation
            ? AcceptedBuild.parse(
                await options.observation.readBuild(
                  options.directory,
                  app,
                  30000,
                ),
              ).digest
            : await treeDigest(app, options.physicalFiles);
        } catch {
          throw new Error("UPDATE_ADOPTION_TREE_UNREADABLE");
        }
        if (measured !== manifest.artifactSha256)
          throw new Error("UPDATE_ADOPTION_TREE_MISMATCH");
        expected = {
          digest: manifest.artifactSha256,
          version: manifest.version,
          buildId: manifest.buildId,
        };
        adoption = {
          file: adoptedFile,
          record: adoptedRecordFor({
            slot: SHARED_SLOT,
            userData: profile,
            manifest,
          }),
          replacing: state.kind === "superseded" ? state.digest : null,
        };
      }
    } else {
      const receipt = PromotionReceipt.parse(receiptRaw);
      if (
        receipt.destination !== app ||
        receipt.receipt !== file ||
        receipt.activation.userData !== profile ||
        receipt.sourceCommit !== build.sourceCommit ||
        receipt.sourceTreeDigest !== build.sourceTreeDigest ||
        receipt.version !== build.version ||
        receipt.artifactSha256 !== receipt.verifiedDestinationSha256
      )
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      expected = {
        digest: receipt.verifiedDestinationSha256,
        version: receipt.version,
        buildId: build.buildId,
      };
    }
  }
  if (expected.buildId !== build.buildId || expected.version !== build.version)
    throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
  const execution = await captureInstalledExecutionSnapshot({
    sourceApp: app,
    sourceExecutable: process.execPath,
    privateParent: root,
    expectedDigest: expected.digest,
    copyApp: options.copyApp,
    physicalFiles: options.physicalFiles,
  });
  if (adoption) {
    // Only the verified, captured image may anchor the record, and nothing is
    // written under /Applications. A failed write is a closed failure.
    let published: boolean;
    try {
      published = await publishAdoptedRecord({
        ...adoption,
        read,
        write: options.observation?.writeRecord ?? writeRecord,
      });
    } catch {
      throw new Error("UPDATE_ADOPTION_RECORD_UNWRITTEN");
    }
    if (!published) {
      // Another writer replaced the superseded record: it must validate for
      // this exact build and manifest digest, else startup stays refused.
      const current = await readAdoptedRecord({
        file: adoption.file,
        slot: SHARED_SLOT,
        userData: profile,
        build,
        read,
        absent: options.observation?.recordAbsent ?? recordAbsent,
      });
      if (
        current.kind !== "expected" ||
        current.expected.digest !== expected.digest
      )
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    }
  }
  const resourcesOrigin: InstalledUpdateResourcesOrigin = Object.freeze({
    kind: "shared-slot",
    slot: "/Applications/Farol.app",
    app,
    execution,
    recheck: execution.recheck,
    recheckUpdateSource: () => recheckSharedUpdateSource(options, expected),
  });
  return Object.freeze({ resourcesOrigin, recheck: execution.recheck });
}

// LaunchServices can reopen the last private image without its one-shot hint.
// Such a reopen still requires the genuine settled generation and slot binding.
async function observeCompletedPrivateLaunch(
  options: InstalledUpdateRelaunchOptions,
): Promise<InstalledUpdateRelaunchGuard | null> {
  const profile = path.join(
    os.userInfo().homedir,
    "Library/Application Support/io.github.legrch.farol",
  );
  const root = path.join(profile, "installed-updates");
  const app = path.resolve(options.directory, "../../..");
  const relative = path.relative(root, app).split(path.sep);
  if (
    relative.length !== 2 ||
    !/^[a-f0-9]{32}$/u.test(relative[0]!) ||
    relative[1] !== "launch-Farol.app"
  )
    return null;
  if (
    options.userData !== profile ||
    !options.copyApp ||
    !options.physicalFiles ||
    options.directory !== path.join(app, "Contents/Resources/app")
  )
    throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
  const build = BuildIdentitySchema.parse(options.build);
  if (
    build.sourceDirty ||
    !build.buildVersion ||
    !["github-owner-beta", "github-stable"].includes(build.updateChannel) ||
    createHash("sha256")
      .update(canonicalBuildIdentityPayload(build))
      .digest("hex") !== build.buildId
  )
    throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
  const read = options.observation?.readRecord ?? readRecord;
  const canonical =
    options.observation?.canonicalOwnedDirectory ?? canonicalOwnedDirectory;
  const binding = Operation.extend({
    schema: z.literal("farol.installed-operation-slot/1"),
    installLocation: z.literal("shared"),
  }).parse(
    await read(path.join(root, relative[0]!, INSTALLED_SLOT_BINDING_FILE)),
  );
  const operation = Operation.parse({
    operationId: binding.operationId,
    source: binding.source,
    target: binding.target,
  });
  if (
    operation.operationId !== relative[0] ||
    operation.target.buildId !== build.buildId ||
    operation.target.version !== build.version
  )
    throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
  await readOperationBinding(root, operation, "shared", read);
  const settled = async () => {
    for (const [directory, privateMode] of [
      [profile, true],
      [root, true],
      [path.join(root, operation.operationId), true],
      [app, true],
      ["/Applications/Farol.app", false],
    ] as const)
      await canonical(directory, privateMode);
    const receipt = SavedReceipt.parse(
      await read(path.join(root, "last-update.json")),
    );
    const parsed = parseRetainedGithubReleaseManifest(receipt);
    if (
      !receipt.operation ||
      !parsed.ok ||
      !sameBuild(receipt.operation.target, {
        digest: parsed.value.artifactSha256,
        version: parsed.value.version,
        buildId: parsed.value.buildId,
      })
    )
      throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    await readOperationBinding(root, receipt.operation, "shared", read);
    const expected = operation.target;
    if (!sameOperation(receipt.operation, operation))
      throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    const pendingRaw = await read(path.join(root, "restore-pending.json"));
    const pending =
      pendingRaw === null ? null : RestoreIntent.parse(pendingRaw);
    if (pending && !sameOperation(pending.operation, operation))
      throw new Error("UPDATE_OPERATION_IDENTITY_MISMATCH");
    const helper = await observeInstalledHelper(
      pending && !pending.notStartedAt ? pending.helper : receipt.helper,
      options.observation?.readProcess ?? readInstalledProcess,
    );
    const journal = await readStartupOperationJournal(
      root,
      operation,
      "shared",
      read,
      "update",
      options.observation?.recordAbsent ?? recordAbsent,
    );
    const measured = options.observation
      ? AcceptedBuild.parse(
          await options.observation.readBuild(
            options.directory,
            "/Applications/Farol.app",
            30000,
          ),
        )
      : {
          ...expected,
          digest: await treeDigest(
            "/Applications/Farol.app",
            options.physicalFiles,
          ),
        };
    if (
      !installedUpdateStartupDecision({
        phase: journal?.phase ?? null,
        helper: startupHelperState(helper),
        installed: measured,
        running: build,
        operation,
      }).mayStart
    )
      throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    await canonical("/Applications/Farol.app", false);
  };
  await settled();
  const execution = await captureInstalledExecutionSnapshot({
    sourceApp: app,
    sourceExecutable: process.execPath,
    privateParent: root,
    expectedDigest: operation.target.digest,
    copyApp: options.copyApp,
    physicalFiles: options.physicalFiles,
  });
  const resourcesOrigin: InstalledUpdateResourcesOrigin = Object.freeze({
    kind: "private-launch",
    slot: "/Applications/Farol.app",
    app,
    operationId: operation.operationId,
    execution,
    recheckUpdateSource: () =>
      recheckSharedUpdateSource(options, operation.target),
    recheck: async () => {
      await readOperationBinding(root, operation, "shared", read);
      await execution.recheck();
    },
  });
  return Object.freeze({
    resourcesOrigin,
    recheck: async () => {
      await settled();
      await resourcesOrigin.recheck();
    },
  });
}

function startupHelperState(
  status: Awaited<ReturnType<typeof observeInstalledHelper>>,
): "running" | "exited" | "unknown" {
  return status === "live"
    ? "running"
    : status === "unknown"
      ? "unknown"
      : "exited";
}

/**
 * Startup decision table (after operation/binding/manifest authentication):
 * phase = none, prepared, predecessor_saved, new_installed, verified,
 * launch_requested, completed, rollback_started, rolled_back, cancelled,
 * cancel_launch_requested, cancel_completed, rollback_launch_requested,
 * rollback_completed. Every phase has exactly the same rows:
 * helper       installed       running       action          mayStart
 * running      any             any           wait            false
 * unknown      any             any           refuse          false
 * exited       neither         any           refuse          false
 * exited       target          target        completed       true
 * exited       target          source/other  completed       false
 * exited       source          source        rolled_back     true
 * exited       source          target/other  rolled_back     false
 * A missing journal means none only inside an authenticated operation; no
 * operation uses the ordinary install/adoption baseline. Historical phases are
 * evidence, never a reason to replay an effect or reopen a settled operation.
 * Companions only determine rollback availability, identically on every restart.
 * This pure decision grants no write, launch, or retry authority.
 */
export function installedUpdateStartupDecision(input: {
  phase: z.infer<typeof Journal>["phase"] | null;
  helper: "running" | "exited" | "unknown";
  installed: z.infer<typeof AcceptedBuild>;
  running: Pick<z.infer<typeof AcceptedBuild>, "version" | "buildId">;
  operation: z.infer<typeof Operation>;
}): {
  action: "completed" | "rolled_back" | "wait" | "refuse";
  mayStart: boolean;
} {
  if (input.helper === "running") return { action: "wait", mayStart: false };
  if (input.helper === "unknown") return { action: "refuse", mayStart: false };
  const accepted = [input.operation.target, input.operation.source].find(
    (build) => sameBuild(input.installed, build),
  );
  if (!accepted) return { action: "refuse", mayStart: false };
  return {
    action: sameBuild(accepted, input.operation.target)
      ? "completed"
      : "rolled_back",
    mayStart:
      input.running.buildId === accepted.buildId &&
      input.running.version === accepted.version,
  };
}

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
  const timeoutMs = options.timeoutMs ?? 30000;
  const intervalMs = options.intervalMs ?? 50;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 1000
  )
    throw new Error("UPDATE_RELAUNCH_DEADLINE_INVALID");
  const now = options.now ?? (() => performance.now());
  const pause =
    options.pause ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
    const deadline = now() + timeoutMs;
    const remaining = () => {
      const ms = Math.ceil(deadline - now());
      if (ms <= 0) throw new Error("UPDATE_RELAUNCH_TIMEOUT");
      return ms;
    };
    const bounded = async <T>(read: () => Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const budget = remaining();
        const value = await Promise.race([
          read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("UPDATE_RELAUNCH_TIMEOUT")),
              budget,
            );
          }),
        ]);
        remaining();
        return value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
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
      const raw = await bounded(() => reads.readRecord(receiptFile));
      if (
        hint.action === "apply" &&
        (await bounded(() =>
          reads.readRecord(path.join(root, "restore-pending.json")),
        )) !== null
      )
        throw new Error("UPDATE_RELAUNCH_RECEIPT_MISMATCH");
      const receipt =
        hint.action === "apply"
          ? Retained.parse(raw)
          : RestoreIntent.parse(raw);
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
        await bounded(() => pause(Math.min(intervalMs, remaining())));
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

async function canonicalOwnedDirectory(
  directory: string,
  privateMode: boolean,
): Promise<void> {
  const stat = await fs.lstat(directory);
  if (directory === "/Applications" && !privateMode) {
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o002) !== 0 ||
      ((stat.mode & 0o020) !== 0 && stat.gid !== 80) ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("UPDATE_PRIVATE_STATE_INVALID");
    const current = await fs.lstat(directory);
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.mode !== stat.mode ||
      current.uid !== stat.uid ||
      current.gid !== stat.gid
    )
      throw new Error("UPDATE_PRIVATE_STATE_INVALID");
    return;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    throw new Error("UPDATE_PRIVATE_STATE_INVALID");
}
async function repairDirectoryIdentity(
  directory: string,
  expected: z.infer<typeof RepairInode>,
  privateMode: boolean,
): Promise<void> {
  await canonicalOwnedDirectory(directory, privateMode);
  const fd = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = await fd.stat({ bigint: true });
    const named = await fs.lstat(directory, { bigint: true });
    if (
      !actual.isDirectory() ||
      !named.isDirectory() ||
      actual.dev !== BigInt(expected[0]) ||
      actual.ino !== BigInt(expected[1]) ||
      actual.dev !== named.dev ||
      actual.ino !== named.ino ||
      actual.uid !== BigInt(process.getuid!()) ||
      (actual.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n
    )
      throw new Error("UPDATE_REPAIR_PHYSICAL_PAIR_CHANGED");
  } finally {
    await fd.close();
  }
}
async function privateDirectory(directory: string): Promise<void> {
  // Electron has already created its profile. Refuse redirected parents before
  // creating any updater state, rather than recursively traversing an alias.
  await canonicalOwnedDirectory(path.dirname(directory), false);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await canonicalOwnedDirectory(directory, true);
}
async function readRecord(
  file: string,
  privateMode = true,
  observeDigest?: (digest: string) => void,
  maximumBytes = MAX_RECORD_BYTES,
): Promise<unknown | null> {
  let before;
  let value: unknown;
  let digest: string;
  try {
    before = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    before.size > maximumBytes
  )
    throw new Error("UPDATE_RECORD_INVALID");
  const fd = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await fd.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("UPDATE_RECORD_CHANGED");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await fd.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await fd.stat();
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("UPDATE_RECORD_CHANGED");
    const bytes = buffer.subarray(0, bytesRead);
    value = JSON.parse(bytes.toString("utf8")) as unknown;
    digest = createHash("sha256").update(bytes).digest("hex");
  } finally {
    await fd.close();
  }
  const named = await fs.lstat(file);
  if (
    named.dev !== before.dev ||
    named.ino !== before.ino ||
    named.size !== before.size ||
    named.mtimeMs !== before.mtimeMs ||
    named.ctimeMs !== before.ctimeMs ||
    named.mode !== before.mode ||
    named.uid !== before.uid ||
    named.nlink !== 1
  )
    throw new Error("UPDATE_RECORD_CHANGED");
  observeDigest?.(digest!);
  return value;
}
async function writeRecord(
  file: string,
  value: unknown,
  beforeEffect: () => void = () => undefined,
): Promise<void> {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
    throw new Error("UPDATE_RECORD_OVERSIZED");
  const temporary = `${file}.${randomBytes(12).toString("hex")}`;
  beforeEffect();
  const fd = await fs.open(temporary, "wx", 0o600);
  try {
    beforeEffect();
    await fd.writeFile(bytes);
    beforeEffect();
    await fd.sync();
  } finally {
    await fd.close();
  }
  beforeEffect();
  await fs.rename(temporary, file);
  beforeEffect();
  const parent = await fs.open(
    path.dirname(file),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    beforeEffect();
    await parent.sync();
    beforeEffect();
  } finally {
    await parent.close();
  }
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

export type InstalledUpdateAdmission =
  | Readonly<{ ok: false; code: string }>
  | Readonly<{
      ok: true;
      release(): Promise<void>;
      recheck?(): Promise<
        Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>
      >;
    }>;

async function recheckAdmission(
  admission: Extract<InstalledUpdateAdmission, { ok: true }>,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>> {
  try {
    return (await admission.recheck?.()) ?? { ok: true };
  } catch {
    // An observation failure proves no idle state. No helper has been dispatched
    // at these boundaries; preparation cleanup still owns its existing proof.
    return { ok: false, code: "UPDATE_BROWSER_STATE_UNKNOWN" };
  }
}
export type InstalledUpdateRuntimeOptions = Readonly<{
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
  const readPreferences = async () => {
    const raw = await readRecord(preferencesFile);
    return raw === null
      ? {
          schema: "farol.installed-update-preferences/1" as const,
          skipped: null,
          deferredVersion: null,
        }
      : UpdatePreferences.parse(raw);
  };
  const automaticPreferenceFile = path.join(
    root,
    "automatic-update-preference.json",
  );
  const automaticUnconfirmedFile = path.join(
    root,
    "automatic-update-unconfirmed.json",
  );
  let automaticPreferenceUnknown = false;
  const readAutomaticPreference = async () => {
    try {
      await fs.lstat(automaticUnconfirmedFile);
      automaticPreferenceUnknown = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (automaticPreferenceUnknown)
      throw new Error("UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN");
    await canonicalOwnedDirectory(root, true);
    const raw = await readRecord(automaticPreferenceFile);
    if (raw === null) {
      // readRecord also returns JSON null. Only actual absence is default OFF.
      try {
        await fs.lstat(automaticPreferenceFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return {
            schema: "farol.installed-automatic-update-preference/1" as const,
            enabled: false,
          };
        throw error;
      }
      throw new Error("UPDATE_AUTOMATIC_PREFERENCE_INVALID");
    }
    return AutomaticUpdatePreferences.parse(raw);
  };
  const quitPreferenceFile = path.join(root, "install-on-quit-preference.json");
  const quitUnconfirmedFile = path.join(
    root,
    "install-on-quit-unconfirmed.json",
  );
  let quitPreferenceUnknown = false;
  const readQuitPreference = async () => {
    await canonicalOwnedDirectory(root, true);
    const unconfirmed = await readRecord(quitUnconfirmedFile);
    if (unconfirmed !== null) {
      InstallOnQuitUnconfirmed.parse(unconfirmed);
      quitPreferenceUnknown = true;
    } else {
      try {
        await fs.lstat(quitUnconfirmedFile);
        throw new Error("UPDATE_QUIT_PREFERENCE_INVALID");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (quitPreferenceUnknown)
      return {
        status: "unknown" as const,
        enabled: false as const,
        code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
      };
    const raw = await readRecord(quitPreferenceFile);
    if (raw === null) {
      try {
        await fs.lstat(quitPreferenceFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return {
            status: "confirmed" as const,
            scope: "install-on-normal-quit" as const,
            enabled: false,
          };
        throw error;
      }
      throw new Error("UPDATE_QUIT_PREFERENCE_INVALID");
    }
    return {
      status: "confirmed" as const,
      scope: "install-on-normal-quit" as const,
      enabled: InstallOnQuitPreferences.parse(raw).enabled,
    };
  };
  const noticesFile = path.join(root, "notice-preferences.json");
  const readNoticePreferences = async () => {
    const raw = await readRecord(noticesFile);
    return raw === null
      ? {
          schema: "farol.installed-update-notices/1" as const,
          seenVersion: null,
          failureNotice: null,
        }
      : NoticePreferences.parse(raw);
  };
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
  // The admission closure owns the kernel lease. Keep it reachable after the
  // request returns, including unknown outcomes and the normal Quit drain.
  // close() only drains updater work; process exit releases this final fence.
  let heldAdmission: Extract<InstalledUpdateAdmission, { ok: true }> | null =
    null;
  let admissionReleaseUnconfirmed = false;
  const acquireAdmission = async (
    beforeEffect: () => void = () => undefined,
    quit?: NormalQuitApplyContext,
    confirmation?: ConfirmedUpdateRestart,
  ): Promise<InstalledUpdateAdmission> => {
    if (admissionReleaseUnconfirmed)
      return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
    try {
      beforeEffect();
      const settled = () => drained(beforeEffect);
      const admission = confirmation
        ? await options.acquireAdmission(settled, quit, confirmation)
        : quit
          ? await options.acquireAdmission(settled, quit)
          : await options.acquireAdmission(settled);
      if (
        !admission.ok &&
        admission.code === "UPDATE_BROWSER_RELEASE_UNCONFIRMED"
      )
        admissionReleaseUnconfirmed = true;
      return admission;
    } catch {
      // Admission precedes every dispatch. An exception here cannot prove a
      // released desktop, but it is not an unknown helper launch.
      admissionReleaseUnconfirmed = true;
      return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
    }
  };
  const settleAdmission = async (
    admission: Extract<InstalledUpdateAdmission, { ok: true }>,
    keep: () => boolean,
    attempt: () => Promise<UpdateHandoff>,
    unexpectedCode: () => string,
  ): Promise<UpdateHandoff> => {
    let outcome: UpdateHandoff;
    try {
      outcome = await attempt();
    } catch {
      // Cleanup's own durable error must still settle the original admission.
      outcome = { status: "unknown", code: unexpectedCode() };
    }
    if (keep()) {
      heldAdmission = admission;
      return outcome;
    }
    try {
      await admission.release();
    } catch {
      heldAdmission = admission;
      admissionReleaseUnconfirmed = true;
      // A throwing finally must not replace a classified unknown copy/cleanup
      // outcome, or invent helper uncertainty on a confirmed blocked attempt.
      if (outcome.status !== "unknown")
        return {
          status: "blocked",
          code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
        };
    }
    return outcome;
  };
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
      if (TARGET_PHASES.includes(receipt.phase)) expected = op.target;
      else if (
        [...ROLLED_BACK_PHASES, ...CANCELLED_PHASES].includes(receipt.phase)
      )
        expected = op.source;
      else throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      if (receipt.runningBuildId !== expected.buildId)
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
    return status === "ended" || status === "changed";
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
        if (
          String(metadata.dev) !== download.identity.dev ||
          String(metadata.ino) !== download.identity.ino ||
          String(metadata.birthtimeNs) !== download.identity.birthtimeNs
        )
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
      !download ||
      download.phase !== "downloading" ||
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
      return known(`UPDATE_${downloaded.code.toUpperCase()}`);
    }
    verified = downloaded.value;
    return {
      ok: true,
      update: { handle: verified.handle, manifest: verified.manifest },
    };
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
          status: automaticPreferenceUnknown ? "unknown" : "blocked",
          enabled: false,
          code: automaticPreferenceUnknown
            ? "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN"
            : "UPDATE_AUTOMATIC_PREFERENCE_UNREADABLE",
        };
      }
    },
    writeAutomaticUpdatePreference: async (enabled, scope) => {
      if (automaticPreferenceUnknown)
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
        automaticPreferenceUnknown = true;
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
        quitPreferenceUnknown = true;
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
    notice: (view, version, restored) =>
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
          // A restored failure reuses its mark. Every new failure occurrence gets
          // a durable identity, including a repeated code for the same version.
          const previous = preferences.failureNotice;
          if (
            restored &&
            previous?.code === view.code &&
            previous.version === version
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
    recover: async () => {
      if ((await readRecord(cleanupFile)) !== null)
        return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
      const downloadRaw = await readRecord(pendingDownloadFile);
      let downloadIntent =
        downloadRaw === null ? null : DownloadIntent.parse(downloadRaw);
      const pendingRaw = await readRecord(restoreFile);
      let pending =
        pendingRaw === null ? null : RestoreIntent.parse(pendingRaw);
      const raw = await readRecord(readyFile);
      const fromReady = raw !== null;
      let interruptedDownload = false;
      if (downloadIntent && !fromReady) {
        if (pending) return known("UPDATE_RESTORE_OUTCOME_UNKNOWN");
        try {
          await reconcileInterruptedDownload(downloadIntent);
        } catch {
          return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
        }
        downloadIntent = null;
        interruptedDownload = true;
      }
      const previous = fromReady ? null : await readRecord(receiptFile);
      if (raw === null && previous === null)
        return pending
          ? known("UPDATE_RESTORE_OUTCOME_UNKNOWN")
          : interruptedDownload
            ? {
                ok: false,
                code: "UPDATE_DOWNLOAD_INTERRUPTED",
                recoveryRequired: false,
              }
            : { ok: true, update: null };
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
        (retained.operation !== null ||
          downloadIntent.buildId !== parsed.value.buildId ||
          downloadIntent.archiveSha256 !== parsed.value.archiveSha256 ||
          downloadIntent.download?.id !== retained.downloadId)
      )
        return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
      if (pending?.notStartedAt) {
        const current = await readBuild(slot);
        if (
          !retained.operation ||
          !sameOperation(pending.operation, retained.operation) ||
          current.buildId !== options.build.buildId ||
          current.version !== options.build.version ||
          !sameBuild(current, pending.notStartedAt) ||
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
          !fromReady ||
          pending ||
          retained.operation ||
          retained.helper ||
          current.buildId !== options.build.buildId ||
          current.version !== options.build.version ||
          !sameBuild(current, op.source) ||
          !sameBuild(op.target, {
            digest: parsed.value.artifactSha256,
            version: parsed.value.version,
            buildId: parsed.value.buildId,
          }) ||
          (await readRecord(
            path.join(root, op.operationId, "journal.json"),
          )) !== null
        )
          return known("UPDATE_PREPARATION_UNRECONCILED");
        await removePreparedCopy(op);
        retained = { ...retained, preparation: undefined };
        await writeRecord(readyFile, retained);
      }
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
        if (decision.action === "wait" || helper === "unknown")
          return known("UPDATE_HELPER_EXIT_UNCONFIRMED");
        if (decision.action === "refuse" || !decision.mayStart)
          return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
        if (
          pending &&
          journal?.phase === pending.priorPhase &&
          pending.installedBefore &&
          sameBuild(current, pending.installedBefore)
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
        if (journal?.phase !== decision.action)
          await writeRecord(journalFile, {
            ...(journal ?? {
              schema: "farol.installed-update-journal/1",
              ...op,
            }),
            phase: decision.action,
          });
        const settledPhase = decision.action;
        let rollbackVersion: string | undefined;
        if (settledPhase === "completed") {
          let predecessor: z.infer<typeof AcceptedBuild> | null = null;
          try {
            predecessor = await optionalBuild(op, "previous.app");
          } catch {
            /* Preserved evidence is not installed content, on any restart. */
          }
          if (
            predecessor &&
            sameBuild(predecessor, op.source) &&
            !legacyPredecessorRequiresStateRecovery(
              op.source.version,
              op.target.version,
            )
          )
            rollbackVersion = op.source.version;
        } else {
          declinedBuildId = op.target.buildId;
        }
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
        await writeRecord(receiptFile, {
          ...retained,
          observedAt: new Date().toISOString(),
          phase: settledPhase,
          runningBuildId: options.build.buildId,
        });
        if (fromReady) await fs.unlink(readyFile);
        if (pending) await fs.unlink(restoreFile);
        const failedApply =
          fromReady && !pending && sameBuild(current, op.source);
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
      if (
        !isIncreasingUpdate(
          parsed.value,
          current.version,
          options.build.buildVersion!,
        )
      )
        return known("UPDATE_RETAINED_VERSION_MISMATCH");
      const check = await transport.verifyPackage(
        retained.handle,
        parsed.value,
      );
      if (!check.ok && "certainty" in check && check.certainty === "unknown")
        return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
      if (!check.ok && "reason" in check && check.reason === "stage_capacity")
        return known("UPDATE_VERIFICATION_RECOVERY_REQUIRED");
      if (
        !check.ok ||
        !packageMatchesRelease(check.value.identity, parsed.value)
      )
        return known("UPDATE_RETAINED_PACKAGE_INVALID");
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
    },
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
      candidate =
        found.value?.manifest.version === preferences.skipped?.version
          ? null
          : found.value;
      return candidate
        ? {
            ok: true,
            available: true,
            version: candidate.manifest.version,
            buildId: candidate.manifest.buildId,
            deferred:
              candidate.manifest.buildId === declinedBuildId ||
              candidate.manifest.version === preferences.deferredVersion,
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
      if (admissionReleaseUnconfirmed)
        return {
          status: "blocked",
          code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
        };
      if (heldAdmission)
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
        (await readRecord(restoreFile)) !== null
      )
        return { status: "blocked", code: "UPDATE_RESTORE_NOT_READY" };
      if (action === "recover" && !(await originalHelperEnded(restorable!)))
        return { status: "blocked", code: "UPDATE_HELPER_EXIT_UNCONFIRMED" };
      const admission = await acquireAdmission();
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
            },
            {
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
              code:
                handoff.status === "not_started"
                  ? "UPDATE_HELPER_NOT_STARTED"
                  : "UPDATE_HELPER_REFUSED",
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
          return {
            status: keepAdmission ? "unknown" : "blocked",
            code: keepAdmission
              ? "UPDATE_RESTORE_OUTCOME_UNKNOWN"
              : "UPDATE_RESTORE_PREPARE_FAILED",
          };
        }
      };
      return settleAdmission(
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
    if (admissionReleaseUnconfirmed)
      return {
        status: "blocked",
        code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
      };
    if (
      heldAdmission ||
      operation ||
      retained?.operation ||
      retained?.preparation
    )
      return { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" };
    if (!retained || retained.handle !== update.handle)
      return { status: "blocked", code: "UPDATE_PACKAGE_NOT_READY" };
    // The Python helper is retired. A build without its compiled Go core can
    // run no update helper, so refuse before any admission, copy or binding.
    if (options.goCoreArtifact === undefined)
      return { status: "blocked", code: "UPDATE_HELPER_GO_CORE_REQUIRED" };
    const confirmedManifest = confirmation
      ? parseRetainedGithubReleaseManifest(retained)
      : null;
    if (
      confirmation &&
      (quitContext ||
        confirmation.kind !== "interrupt-browser" ||
        confirmation.version !== update.manifest.version ||
        !confirmedManifest?.ok ||
        confirmedManifest.value.version !== confirmation.version)
    )
      return { status: "blocked", code: "UPDATE_CONFIRMATION_STALE" };
    let keepAdmission = false;
    let bindingPublicationUnknown = false;
    const expired = () =>
      quitContext !== undefined &&
      (!Number.isFinite(Date.now()) ||
        Date.now() >= quitContext.deadlineAt ||
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
              Math.max(
                1,
                Math.min(2_147_483_647, quitContext.deadlineAt - Date.now()),
              ),
            );
          }),
        ]);
        ensureActive();
        return value;
      } finally {
        clearTimeout(timer);
      }
    };
    let admission: InstalledUpdateAdmission;
    try {
      admission = await wait(async () => {
        const acquired = await acquireAdmission(
          ensureActive,
          quitContext,
          confirmation,
        );
        // If the host timed out while acquiring, retain the original lease
        // until its actual result can be settled. Timeout is not cancellation.
        if (acquired.ok && quitContext) heldAdmission = acquired;
        return acquired;
      });
    } catch {
      return { status: "unknown", code: "UPDATE_QUIT_ADMISSION_UNKNOWN" };
    }
    if (!admission.ok) return { status: "blocked", code: admission.code };
    if (quitContext) heldAdmission = null;
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
        if (
          !check.ok ||
          !packageMatchesRelease(check.value.identity, update.manifest)
        ) {
          if (quitContext)
            keepAdmission =
              !check.ok &&
              "certainty" in check &&
              check.certainty === "unknown";
          if (quitContext && !keepAdmission)
            await wait(() => fs.unlink(cleanupFile));
          return {
            status:
              !check.ok && "certainty" in check && check.certainty === "unknown"
                ? "unknown"
                : "blocked",
            code:
              !check.ok && "certainty" in check && check.certainty === "unknown"
                ? "UPDATE_STAGING_OUTCOME_UNKNOWN"
                : !check.ok &&
                    "reason" in check &&
                    check.reason === "stage_capacity"
                  ? "UPDATE_VERIFICATION_RECOVERY_REQUIRED"
                  : "UPDATE_RETAINED_PACKAGE_INVALID",
          };
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
            },
            {
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
                    readinessTimeoutMs: Math.max(
                      1,
                      Math.min(300_000, quitContext.deadlineAt - Date.now()),
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
            code:
              handoff.status === "refused"
                ? "UPDATE_HELPER_REFUSED"
                : "UPDATE_HELPER_NOT_STARTED",
          };
        }
        // Keep the same operation observable even on an uncertain ACK. No substitute helper.
        void operation.completion.then((result) => {
          process.stderr.write(
            `farol-update-helper ${JSON.stringify({ operationId, code: result.code, phase: result.terminal?.phase ?? "unknown" })}\n`,
          );
        });
        const admittedHandoff = supervised
          ? handoff.status === "continued" ||
            (handoff.status === "terminal" &&
              handoff.result.code === 0 &&
              handoff.result.signal === null &&
              handoff.result.protocolError === null &&
              handoff.result.terminal?.phase === "verified" &&
              handoff.result.terminal.error === null)
          : handoff.status === "ready";
        if (!admittedHandoff)
          return {
            status: "unknown",
            code:
              handoff.status === "refused"
                ? "UPDATE_HELPER_REFUSED"
                : "UPDATE_HANDOFF_UNKNOWN",
          };
        ensureActive();
        if (!supervised && !quitContext) options.quit();
        return { status: "accepted" };
      } catch {
        if (bindingPublicationUnknown)
          return { status: "unknown", code: "UPDATE_SLOT_BINDING_UNCONFIRMED" };
        if (quitContext && expired())
          return {
            status: keepAdmission ? "unknown" : "blocked",
            code: keepAdmission
              ? "UPDATE_QUIT_OUTCOME_UNKNOWN"
              : "UPDATE_QUIT_DEADLINE_EXPIRED",
          };
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
        return {
          status: keepAdmission ? "unknown" : "blocked",
          code: keepAdmission
            ? "UPDATE_HANDOFF_UNKNOWN"
            : "UPDATE_PREPARE_FAILED",
        };
      }
    };
    return settleAdmission(
      admission,
      () => keepAdmission,
      attempt,
      () =>
        keepAdmission
          ? "UPDATE_HANDOFF_UNKNOWN"
          : "UPDATE_STAGING_OUTCOME_UNKNOWN",
    );
  };

  return controller;
}
