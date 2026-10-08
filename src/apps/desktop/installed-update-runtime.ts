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
  type InstalledUpdateView,
} from "../../modules/release/contract/installed-update";
import { createGithubUpdateTransport } from "../../modules/release/infra/native/github-update-transport";
import { createUpdatePackageVerifier } from "../../modules/release/infra/native/update-package-verifier";
import {
  captureInstalledProcessStart,
  installedFarolSlot,
  startInstalledUpdateHelper,
  type InstalledUpdateOperation,
  type InstalledUpdateLaunch,
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
const AutomaticUpdatePreferences = z.strictObject({
  schema: z.literal("farol.installed-automatic-update-preference/1"),
  enabled: z.boolean(),
});
const AcceptedBuild = z.strictObject({
  digest: Digest,
  version: z.string().max(128),
  buildId: Digest,
});
const PromotionReceipt = z.strictObject({
  schema: z.literal("farol.next.promotion-plan/1"),
  operation: z.literal("applied"),
  product: z.literal("Farol Next Preview"),
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
  schema: z.literal("farol.next.closed-repair/1"),
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
  schema: z.literal("farol.next.closed-repair-journal/1"),
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
const RejectedTarget = Operation.extend({
  schema: z.literal("farol.rejected-update-target/1"),
  directoryIdentity: z.strictObject({
    device: z.string().regex(/^[0-9]{1,30}$/u),
    inode: z.string().regex(/^[0-9]{1,30}$/u),
  }),
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

async function readOperationJournal(
  root: string,
  op: z.infer<typeof Operation>,
  read: typeof readRecord = readRecord,
): Promise<z.infer<typeof Journal>> {
  const journal = Journal.parse(
    await read(path.join(root, op.operationId, "journal.json")),
  );
  if (!sameOperation(journal, op))
    throw new Error("UPDATE_OPERATION_IDENTITY_MISMATCH");
  return journal;
}

async function runInstalledTrusted(
  directory: string,
  entry: string,
  args: string[],
  timeout = 180000,
): Promise<unknown> {
  const { stdout } = await execute(
    process.execPath,
    [path.join(directory, entry), ...args],
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

/** Existing rejected-target proof: accepted operation, ended helper, exact inode/layout. */
async function confirmRejectedTarget(
  root: string,
  op: z.infer<typeof Operation>,
  helperEnded: () => Promise<boolean>,
  reads: Readonly<{
    canonicalOwnedDirectory: typeof canonicalOwnedDirectory;
    readRecord: typeof readRecord;
    openDirectory: typeof openRejectedDirectory;
    lstat: typeof readRejectedEntry;
  }> = {
    canonicalOwnedDirectory,
    readRecord,
    openDirectory: openRejectedDirectory,
    lstat: readRejectedEntry,
  },
): Promise<z.infer<typeof RejectedTarget> | null> {
  const directory = path.join(root, op.operationId);
  await reads.canonicalOwnedDirectory(directory, true);
  const raw = await reads.readRecord(
    path.join(directory, "rejected-target.json"),
  );
  if (raw === null) return null;
  const witness = RejectedTarget.parse(raw);
  if (!sameOperation(witness, op) || !(await helperEnded()))
    throw new Error("UPDATE_REJECTED_TARGET_UNCONFIRMED");
  // Only metadata is needed for rejected bytes; never execute their verifier
  // or reinterpret their corrupt contents as an accepted application.
  const rejected = path.join(directory, "failed.app");
  await reads.canonicalOwnedDirectory(rejected, false);
  const fd = await reads.openDirectory(rejected);
  try {
    const metadata = await fd.stat();
    if (
      !metadata.isDirectory() ||
      metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
      (metadata.mode & 0o022n) !== 0n ||
      String(metadata.dev) !== witness.directoryIdentity.device ||
      String(metadata.ino) !== witness.directoryIdentity.inode
    )
      throw new Error("UPDATE_REJECTED_TARGET_CHANGED");
    for (const name of ["previous.app", "staged.app"]) {
      let present = false;
      try {
        await reads.lstat(path.join(directory, name));
        present = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (present) throw new Error("UPDATE_REJECTED_TARGET_LAYOUT_UNCONFIRMED");
    }
    const current = await reads.lstat(rejected);
    if (
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      !current.isDirectory()
    )
      throw new Error("UPDATE_REJECTED_TARGET_CHANGED");
  } finally {
    await fd.close();
  }
  return witness;
}

export type InstalledUpdateRelaunchOptions = Readonly<{
  args: readonly string[];
  directory: string;
  userData: string;
  build: BuildIdentity;
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
    rejectedDirectory?: Readonly<{
      openDirectory: typeof openRejectedDirectory;
      lstat: typeof readRejectedEntry;
    }>;
  }>;
}>;

/** Observe one explicit updater relaunch before the first startup lease acquire. */
export async function waitForInstalledUpdateRelaunch(
  options: InstalledUpdateRelaunchOptions,
): Promise<Readonly<{ recheck(): Promise<void> }> | null> {
  const hints = options.args.filter(
    (arg) =>
      arg === RELAUNCH_ARGUMENT || arg.startsWith(RELAUNCH_ARGUMENT + "="),
  );
  if (hints.length === 0) return null;
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
  const slot = installedFarolSlot();
  const profile = path.join(
    os.userInfo().homedir,
    "Library/Application Support/Farol Next Preview",
  );
  const directory = path.join(slot, "Contents/Resources/app");
  const root = path.join(profile, "installed-updates");
  if (
    options.userData !== profile ||
    options.directory !== directory ||
    build.updateChannel !== "github-owner-beta" ||
    !build.buildVersion ||
    build.sourceDirty ||
    hint.buildId !== build.buildId ||
    createHash("sha256")
      .update(canonicalBuildIdentityPayload(build))
      .digest("hex") !== build.buildId
  )
    throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
  if (
    (hint.action === "apply" && hint.phase !== "completed") ||
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
  const reads: NonNullable<InstalledUpdateRelaunchOptions["observation"]> =
    options.observation ?? {
      canonicalOwnedDirectory,
      readRecord,
      readBuild: async (
        appDirectory: string,
        file: string,
        remaining: number,
      ) =>
        runInstalledTrusted(appDirectory, "update-slot.mjs", [file], remaining),
      readProcess: readInstalledProcess,
    };
  const pendingPhase = {
    completed: "launch_requested",
    cancel_completed: "cancel_launch_requested",
    rollback_completed: "rollback_launch_requested",
  }[hint.phase];
  const receiptFile = path.join(
    root,
    hint.action === "apply" ? "ready.json" : "restore-pending.json",
  );
  let pinned: z.infer<typeof Operation> | undefined;
  let completedObserved = false;
  let rejectedTargetObserved: z.infer<typeof RejectedTarget> | undefined;

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
      if ("priorPhase" in receipt) {
        const eligible =
          hint.action === "rollback"
            ? ["verified", "launch_requested", "completed"]
            : hint.phase === "completed"
              ? ["prepared", "predecessor_saved", "new_installed", "verified"]
              : hint.phase === "cancel_completed"
                ? ["prepared", "cancelled"]
                : [
                    "prepared",
                    "predecessor_saved",
                    "rollback_started",
                    "rolled_back",
                  ];
        if (!eligible.includes(receipt.priorPhase))
          throw new Error("UPDATE_RELAUNCH_RECEIPT_MISMATCH");
      }
      pinned ??= Operation.parse(op);
      await bounded(() =>
        reads.canonicalOwnedDirectory(
          path.join(root, pinned!.operationId),
          true,
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
        readOperationJournal(root, pinned!, reads.readRecord),
      );
      if (
        journal.phase !== hint.phase &&
        (journal.phase !== pendingPhase || completedObserved)
      )
        throw new Error("UPDATE_RELAUNCH_PHASE_MISMATCH");
      if (journal.phase === hint.phase) completedObserved = true;
      if (helper === "unknown" || helper === "changed")
        throw new Error("UPDATE_RELAUNCH_HELPER_UNCONFIRMED");
      if (helper === "ended" && journal.phase !== hint.phase)
        throw new Error("UPDATE_RELAUNCH_COMPLETION_UNCONFIRMED");
      return { journal, helper };
    };
    const physical = async () => {
      const expected =
        hint.phase === "completed" ? pinned!.target : pinned!.source;
      const companion =
        hint.phase === "completed"
          ? "previous.app"
          : hint.phase === "cancel_completed"
            ? "staged.app"
            : "failed.app";
      const companionPath = path.join(root, pinned!.operationId, companion);
      await bounded(() => reads.canonicalOwnedDirectory(companionPath, false));
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
      if (hint.phase === "rollback_completed") {
        const confirmed = await bounded(() =>
          confirmRejectedTarget(
            root,
            pinned!,
            async () =>
              (await bounded(() =>
                observeInstalledHelper(hint.helper, reads.readProcess),
              )) === "ended",
            {
              canonicalOwnedDirectory: reads.canonicalOwnedDirectory,
              readRecord: reads.readRecord,
              openDirectory:
                reads.rejectedDirectory?.openDirectory ?? openRejectedDirectory,
              lstat: reads.rejectedDirectory?.lstat ?? readRejectedEntry,
            },
          ),
        );
        if (confirmed) {
          if (
            rejectedTargetObserved &&
            (confirmed.directoryIdentity.device !==
              rejectedTargetObserved.directoryIdentity.device ||
              confirmed.directoryIdentity.inode !==
                rejectedTargetObserved.directoryIdentity.inode)
          )
            throw new Error("UPDATE_REJECTED_TARGET_CHANGED");
          rejectedTargetObserved = confirmed;
          return;
        }
        if (rejectedTargetObserved)
          throw new Error("UPDATE_REJECTED_TARGET_UNCONFIRMED");
      }
      if (
        !sameBuild(
          AcceptedBuild.parse(
            await bounded(() =>
              reads.readBuild(directory, companionPath, remaining()),
            ),
          ),
          hint.phase === "completed" ? pinned!.source : pinned!.target,
        )
      )
        throw new Error("UPDATE_RELAUNCH_PHYSICAL_PAIR_CHANGED");
    };
    let pairObserved = false;
    for (;;) {
      const result = await correlate();
      if (
        !wait &&
        (result.journal.phase !== hint.phase || result.helper !== "ended")
      )
        throw new Error("UPDATE_RELAUNCH_COMPLETION_UNCONFIRMED");
      if (
        (!pairObserved &&
          (hint.phase !== "rollback_completed" || result.helper === "ended")) ||
        (result.journal.phase === hint.phase && result.helper === "ended")
      ) {
        await physical();
        pairObserved = true;
      }
      if (result.journal.phase === hint.phase && result.helper === "ended") {
        // The helper may finalize while a tree is measured; never use that
        // earlier observation to admit a changed receipt or operation.
        const final = await correlate();
        if (final.journal.phase !== hint.phase || final.helper !== "ended")
          throw new Error("UPDATE_RELAUNCH_COMPLETION_UNCONFIRMED");
        return;
      }
      if (!wait) throw new Error("UPDATE_RELAUNCH_COMPLETION_UNCONFIRMED");
      await bounded(() => pause(Math.min(intervalMs, remaining())));
    }
  };
  await observe(true);
  // The caller invokes this under its existing lease before readiness/marker.
  return Object.freeze({ recheck: () => observe(false) });
}

async function canonicalOwnedDirectory(
  directory: string,
  privateMode: boolean,
): Promise<void> {
  const stat = await fs.lstat(directory);
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
): Promise<unknown | null> {
  let before;
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
    before.size > MAX_RECORD_BYTES
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
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
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
    return JSON.parse(
      buffer.subarray(0, bytesRead).toString("utf8"),
    ) as unknown;
  } finally {
    await fd.close();
  }
}
async function writeRecord(file: string, value: unknown): Promise<void> {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
    throw new Error("UPDATE_RECORD_OVERSIZED");
  const temporary = `${file}.${randomBytes(12).toString("hex")}`;
  const fd = await fs.open(temporary, "wx", 0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fs.rename(temporary, file);
  const parent = await fs.open(
    path.dirname(file),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
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
  directory: string;
  userData: string;
  build: BuildIdentity;
  // Selected by the trusted supervisory caller, never renderer request data.
  // This is a source for the existing staging/retention owner, not a Ready record.
  localArchive?: Readonly<{ path: string; manifest: unknown }>;
  // Electron must copy physical ASAR files, not its virtual archive filesystem.
  copyApp(source: string, destination: string): Promise<void>;
  // Removal has the same physical ASAR boundary as copying a package.
  removeDirectory(directory: string, force: boolean): Promise<void>;
  // Evaluate this existing durable report while admission is held, before
  // stopping clients. The runtime also rechecks it after the drain.
  acquireAdmission(
    desktopWorkSettled: () => Promise<boolean>,
  ): Promise<InstalledUpdateAdmission>;
  quit(): void;
  publish(view: InstalledUpdateView): void;
}>;

/**
 * Returns the single release owner. After initialize(), composition uses
 * scheduledCheck() for startup/periodic checks and check(true) for explicit
 * checks. Scheduling never applies an update or requests Quit; close() drains
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
    predecessor: InstalledPredecessorControl;
    lease: PromotionLeaseHandle;
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
  predecessor: ClosedInstalledPredecessor;
  transfer: PromotionLeaseTransfer;
  verifyResources(): Promise<boolean>;
  observeHelper(operation: InstalledUpdateOperation): void;
}>;

/** Explicit external control after a captured predecessor's confirmed Quit. */
export async function createSupervisedInstalledUpdateRuntime(
  options: SupervisedInstalledUpdateOptions,
): Promise<InstalledUpdater | null> {
  const slot = installedFarolSlot();
  const profile = path.join(
    os.userInfo().homedir,
    "Library/Application Support/Farol Next Preview",
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
  const transfer = await createPromotionLeaseTransfer(options.lease);
  const expectedProof = JSON.stringify(predecessor);
  let admitted = false;
  const recheck = async () => {
    try {
      if (
        (await transfer.verify()) !== true ||
        (await resources.verify()) !== true ||
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
      predecessor,
      transfer,
      verifyResources: resources.verify,
      observeHelper: options.observeHelper,
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
    options.build.updateChannel !== "github-owner-beta" ||
    !options.build.buildVersion ||
    options.build.sourceDirty
  )
    return null;
  const slot = installedFarolSlot();
  const actualApp = path.resolve(options.directory, "../../..");
  // Ordinary checkouts cannot mutate the slot. Only the separate supervisory
  // entry can supply verified controller resources and confirmed closure.
  if (
    actualApp !== (supervised?.app ?? slot) ||
    (await fs.realpath(actualApp)) !== (supervised?.app ?? slot) ||
    options.userData !==
      path.join(
        os.userInfo().homedir,
        "Library/Application Support/Farol Next Preview",
      )
  )
    return null;
  const root = path.join(options.userData, "installed-updates");
  await privateDirectory(root);
  const context = (directory: string) => {
    const verifier = createUpdatePackageVerifier({
      archivePathForHandle: async (handle) => handle,
      stagingParent: directory,
      extractorPath: path.join(options.directory, "update-archive.py"),
      verifierPath: path.join(options.directory, "update-package.mjs"),
      removeDirectory: options.removeDirectory,
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
    download: async (url: string, maximum: number) => {
      const result = await transport.download(url, maximum);
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
  const readAutomaticPreference = async () => {
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
  let automaticPreferenceUnknown = false;
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
  const acquireAdmission = async (): Promise<InstalledUpdateAdmission> => {
    if (admissionReleaseUnconfirmed)
      return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
    try {
      const admission = await options.acquireAdmission(drained);
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
  const restoreFile = path.join(root, "restore-pending.json");
  let restorable: z.infer<typeof Retained> | null = null;
  let restoreKind: "recover" | "rollback" | null = null;
  let declinedBuildId: string | null = null;
  const runTrusted = async (entry: string, args: string[]) => {
    if (supervised && (await supervised.verifyResources()) !== true)
      throw new Error("UPDATE_SUPERVISOR_RESOURCES_CHANGED");
    return runInstalledTrusted(options.directory, entry, args);
  };
  const readBuild = async (file: string) =>
    AcceptedBuild.parse(await runTrusted("update-slot.mjs", [file]));
  const known = (code: string) => ({ ok: false as const, code });
  const readAcceptedSource = async () => {
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
        const companion = await readBuild(previous);
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
          const measured = await readBuild(slot);
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
      const receipt = PromotionReceipt.parse(await readRecord(file));
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
    if (
      expected.buildId !== options.build.buildId ||
      expected.version !== options.build.version
    )
      throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    const measured = await readBuild(slot);
    if (!sameBuild(measured, expected))
      throw new Error("UPDATE_ACCEPTED_SOURCE_CHANGED");
    return measured;
  };
  const readJournal = (op: z.infer<typeof Operation>) =>
    readOperationJournal(root, op);
  const optionalBuild = async (op: z.infer<typeof Operation>, name: string) => {
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
  const confirmedRejectedTarget = async (
    op: z.infer<typeof Operation>,
    record: z.infer<typeof Retained>,
  ) =>
    (await confirmRejectedTarget(root, op, () =>
      originalHelperEnded(record),
    )) !== null;
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
  const drained = async () => {
    const report = z
      .strictObject({
        drained: z.boolean(),
        obligationCount: z.number(),
        unreadableCount: z.number(),
        changedCount: z.number(),
      })
      .parse(
        await runTrusted("update-obligations.mjs", [
          options.userData,
          String(supervised?.predecessor.pid ?? process.pid),
        ]),
      );
    return report.drained;
  };
  const discardVerifiedStage = async (handle: string) => {
    verified = null;
    try {
      await verifier.discard(handle);
      return true;
    } catch {
      stagingUncertain = true;
      await writeRecord(cleanupFile, {
        schema: "farol.update-package-cleanup/1",
        handle,
      });
      return false;
    }
  };
  const removePreparedCopy = async (op: z.infer<typeof Operation>) => {
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
    // A pre-dispatch directory can contain only its unfinished copy. Never
    // reclaim a journal, predecessor or unexpected entry as preparation debris.
    for await (const entry of await fs.opendir(directory)) {
      if (entry.name !== "staged.app")
        throw new Error("UPDATE_PREPARATION_UNRECONCILED");
    }
    await options.removeDirectory(path.join(directory, "staged.app"), true);
    await fs.rmdir(directory);
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

  const controller = new InstalledUpdater({
    cancelPending: () => {
      downloadsCancelled = true;
      transport.cancelPending();
    },
    now: Date.now,
    publish: options.publish,
    readAutomaticUpdatePreference: async () => {
      try {
        const preference = await readAutomaticPreference();
        return { status: "confirmed", enabled: preference.enabled };
      } catch {
        return {
          status: "blocked",
          enabled: false,
          code: "UPDATE_AUTOMATIC_PREFERENCE_UNREADABLE",
        };
      }
    },
    writeAutomaticUpdatePreference: async (enabled) => {
      if (automaticPreferenceUnknown)
        return {
          status: "unknown",
          code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
        };
      const record = AutomaticUpdatePreferences.safeParse({
        schema: "farol.installed-automatic-update-preference/1",
        enabled,
      });
      if (!record.success)
        return {
          status: "refused",
          code: "UPDATE_AUTOMATIC_PREFERENCE_INVALID",
        };
      try {
        await readAutomaticPreference();
      } catch {
        return {
          status: "refused",
          code: "UPDATE_AUTOMATIC_PREFERENCE_UNREADABLE",
        };
      }
      try {
        // ACK only after temporary-file fsync, rename, parent fsync and exact readback.
        await writeRecord(automaticPreferenceFile, record.data);
        const observed = await readAutomaticPreference();
        if (observed.enabled !== enabled)
          throw new Error("UPDATE_AUTOMATIC_PREFERENCE_CHANGED");
        return AutomaticUpdatePreferenceResultSchema.parse({
          status: "confirmed",
          enabled,
        });
      } catch {
        automaticPreferenceUnknown = true;
        return {
          status: "unknown",
          code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
        };
      }
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
            return { key: previous.key, seen: previous.seen, blockedBy: null };
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
      await selectDownload(retained.downloadId);
      const parsed = parseRetainedGithubReleaseManifest(retained);
      if (!parsed.ok) return known("UPDATE_RETAINED_MANIFEST_INVALID");
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
      if (
        retained.operation &&
        (await readRecord(
          path.join(root, retained.operation.operationId, "journal.json"),
        )) === null
      ) {
        const op = retained.operation;
        // No journal alone never proves non-dispatch. First reconcile the exact
        // dispatched PID, including when its start-time readback was unavailable.
        if (pending || !(await originalHelperEnded(retained)))
          return known("UPDATE_HELPER_EXIT_UNCONFIRMED");
        const current = await readBuild(slot);
        const staged = await optionalBuild(op, "staged.app");
        if (
          current.buildId !== options.build.buildId ||
          current.version !== options.build.version ||
          !sameBuild(current, op.source) ||
          !staged ||
          !sameBuild(staged, op.target) ||
          (await optionalBuild(op, "previous.app")) !== null ||
          (await optionalBuild(op, "failed.app")) !== null ||
          (await readRecord(
            path.join(root, op.operationId, "journal.json"),
          )) !== null
        )
          return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
        await writeRecord(
          path.join(root, `${op.operationId}-pre-mutation-exit.json`),
          {
            schema: "farol.update-refusal/1",
            action: "apply",
            operation: op,
            helper: retained.helper,
            code: "helper_exited_before_mutation",
          },
        );
        // Reuse the durable preparation cleanup phase. If reclamation itself
        // is interrupted, the next lifetime still identifies this exact copy.
        retained = {
          ...retained,
          operation: null,
          helper: null,
          preparation: op,
        };
        await writeRecord(readyFile, retained);
        await removePreparedCopy(op);
        retained = { ...retained, preparation: undefined };
        await writeRecord(readyFile, retained);
      }
      if (retained.operation) {
        const op = retained.operation;
        if (pending && !sameOperation(pending.operation, op))
          return known("UPDATE_OPERATION_IDENTITY_MISMATCH");
        const journal = await readJournal(op);
        const current = await readBuild(slot);
        if (
          current.buildId !== options.build.buildId ||
          current.version !== options.build.version
        )
          return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
        let restoreExitedUnchanged = false;
        if (
          pending &&
          !(pending.action === "rollback"
            ? ROLLED_BACK_PHASES.includes(journal.phase) &&
              sameBuild(current, op.source)
            : journal.phase !== pending.priorPhase &&
              [
                ...TARGET_PHASES,
                ...CANCELLED_PHASES,
                ...ROLLED_BACK_PHASES,
              ].includes(journal.phase))
        ) {
          // An unchanged journal alone cannot settle dispatch. Reconcile this
          // restore's recorded helper separately from the original apply helper.
          if (
            !pending.helper ||
            !pending.installedBefore ||
            journal.phase !== pending.priorPhase ||
            !sameBuild(current, pending.installedBefore) ||
            !(await originalHelperEnded(pending))
          )
            return known("UPDATE_RESTORE_OUTCOME_UNKNOWN");
          restoreExitedUnchanged = true;
        }
        let settled = false;
        let rollbackVersion: string | undefined;
        if (sameBuild(current, op.target)) {
          const predecessorName =
            (await optionalBuild(op, "previous.app")) !== null
              ? "previous.app"
              : "staged.app";
          const predecessor = await optionalBuild(op, predecessorName);
          if (!predecessor || !sameBuild(predecessor, op.source))
            return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
          settled =
            predecessorName === "previous.app" &&
            TARGET_PHASES.includes(journal.phase);
          if (
            settled &&
            !legacyPredecessorRequiresStateRecovery(
              op.source.version,
              op.target.version,
            )
          )
            rollbackVersion = op.source.version;
        } else if (sameBuild(current, op.source)) {
          const rolledBack = ROLLED_BACK_PHASES.includes(journal.phase);
          const rejected =
            journal.phase === "rolled_back" &&
            (await confirmedRejectedTarget(op, retained));
          if (!rejected) {
            const other = rolledBack
              ? await optionalBuild(op, "failed.app")
              : journal.phase === "rollback_started"
                ? ((await optionalBuild(op, "failed.app")) ??
                  (await optionalBuild(op, "previous.app")))
                : await optionalBuild(op, "staged.app");
            if (!other || !sameBuild(other, op.target))
              return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
          }
          settled = [...ROLLED_BACK_PHASES, ...CANCELLED_PHASES].includes(
            journal.phase,
          );
          if (settled) declinedBuildId = op.target.buildId;
        } else return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
        restorable = retained;
        restoreKind = settled
          ? rollbackVersion
            ? "rollback"
            : null
          : "recover";
        if (!settled && !(await originalHelperEnded(retained)))
          return known("UPDATE_HELPER_EXIT_UNCONFIRMED");
        if (restoreExitedUnchanged) {
          // Both accepted physical companions were checked above. Preserve the
          // original outcome before clearing only its reconciled dispatch intent.
          await writeRecord(
            path.join(root, op.operationId, "restore-exit.json"),
            {
              schema: "farol.update-refusal/1",
              action: pending!.action,
              operation: op,
              helper: pending!.helper,
              priorPhase: pending!.priorPhase,
              installedBefore: pending!.installedBefore,
              code: "helper_exited_without_journal_change",
            },
          );
          await clearRestoreIntent();
          pending = null;
        }
        if (!settled)
          return { ok: true, update: null, recoveryVersion: current.version };
        // The journal and installed/predecessor identities establish that this
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
          phase: journal.phase,
          runningBuildId: options.build.buildId,
        });
        if (fromReady) await fs.unlink(readyFile);
        if (pending) await fs.unlink(restoreFile);
        retained = null;
        return {
          ok: true,
          update: null,
          ...(rollbackVersion ? { rollbackVersion } : {}),
        };
      }
      if (pending) return known("UPDATE_RESTORE_OUTCOME_UNKNOWN");
      if (parsed.value.version === options.build.version)
        return known("UPDATE_RETAINED_VERSION_MISMATCH");
      const check = await transport.verifyPackage(
        retained.handle,
        parsed.value,
      );
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
      } catch {
        return known("UPDATE_SOURCE_IDENTITY_UNCONFIRMED");
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
        "owner-beta",
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
        found.value?.manifest.buildId === declinedBuildId ||
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
              candidate.manifest.version === preferences.deferredVersion,
            ...(candidate.notes ? { notes: candidate.notes } : {}),
          }
        : { ok: true, available: false };
    },
    download: async () => {
      if (!candidate) return known("UPDATE_CANDIDATE_MISSING");
      const selected = candidate;
      const staged = await stageSelectedUpdate(
        selected.manifest,
        (verifyPackage) =>
          downloadAndVerifyGithubUpdate(selected, {
            ...checkedTransport,
            verifyPackage,
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
            const manifest = localArchive.manifest;
            if (!manifest || manifest.channel !== "owner-beta")
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
            const order = compareReleaseVersions(
              manifest.version,
              current.version,
            );
            if (
              order === null ||
              order <= 0 ||
              BigInt(manifest.buildVersion) <=
                BigInt(options.build.buildVersion!)
            )
              return known("UPDATE_LOCAL_VERSION_MISMATCH");
            if (manifest.buildId === declinedBuildId)
              return known("UPDATE_LOCAL_TARGET_DECLINED");
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
            path.join(options.directory, "update-helper.py"),
            {
              action,
              ...op,
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
    restart: async (update) => {
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
      const admission = await acquireAdmission();
      if (!admission.ok) return { status: "blocked", code: admission.code };
      let keepAdmission = false;
      const attempt = async (): Promise<UpdateHandoff> => {
        if (!retained || retained.handle !== update.handle)
          return { status: "blocked", code: "UPDATE_PACKAGE_NOT_READY" };
        try {
          if (!(await drained()))
            return { status: "blocked", code: "UPDATE_WORK_PENDING" };
          const source = await readAcceptedSource();
          if (
            source.buildId !== options.build.buildId ||
            source.version !== options.build.version
          )
            return {
              status: "blocked",
              code: "UPDATE_SOURCE_IDENTITY_MISMATCH",
            };
          const processStart =
            supervised?.predecessor.processStart ??
            (await captureInstalledProcessStart(process.pid));
          const check = await transport.verifyPackage(
            update.handle,
            update.manifest,
          );
          if (
            !check.ok ||
            !packageMatchesRelease(check.value.identity, update.manifest)
          )
            return {
              status:
                !check.ok &&
                "certainty" in check &&
                check.certainty === "unknown"
                  ? "unknown"
                  : "blocked",
              code: "UPDATE_RETAINED_PACKAGE_INVALID",
            };
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
          const firstRecheck = await recheckAdmission(admission);
          if (!firstRecheck.ok)
            return { status: "blocked", code: firstRecheck.code };
          const operationId = randomBytes(16).toString("hex");
          const operationRoot = path.join(root, operationId);
          const preparing = { operationId, source, target };
          // Record allocation before copying. This phase proves no helper was
          // dispatched; startup may reconcile only this exact unfinished copy.
          retained = { ...retained, preparation: preparing };
          await writeRecord(readyFile, retained);
          await fs.mkdir(operationRoot, { mode: 0o700 });
          let copied = false;
          try {
            await options.copyApp(
              verified.stagedAppPath,
              path.join(operationRoot, "staged.app"),
            );
            copied = true;
          } catch {
            try {
              await removePreparedCopy(preparing);
              retained = { ...retained, preparation: undefined };
              await writeRecord(readyFile, retained);
            } catch {
              await writeRecord(cleanupFile, {
                schema: "farol.update-package-cleanup/1",
                handle: update.handle,
                operationRoot,
              });
              return {
                status: "unknown",
                code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
              };
            }
          }
          if (!(await discardVerifiedStage(update.handle)))
            return {
              status: "unknown",
              code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
            };
          if (!copied)
            return { status: "blocked", code: "UPDATE_PREPARE_FAILED" };
          retained = {
            ...retained,
            preparation: undefined,
            operation: preparing,
          };
          // Copying and physical verification can take time. Re-read fenced
          // browser state immediately before durable dispatch, not just at click.
          const finalRecheck = await recheckAdmission(admission);
          if (!finalRecheck.ok) {
            retained = { ...retained, operation: null, preparation: preparing };
            await writeRecord(readyFile, retained);
            await removePreparedCopy(preparing);
            retained = { ...retained, preparation: undefined };
            await writeRecord(readyFile, retained);
            return { status: "blocked", code: finalRecheck.code };
          }
          // Durable dispatch intent precedes launch. A failed commit may already
          // have persisted dispatch, so keep admission even when its sync fails.
          keepAdmission = true;
          await writeRecord(readyFile, retained);
          const handoff = await startInstalledUpdateHelper(
            path.join(options.directory, "update-helper.py"),
            {
              action: "apply",
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
              relaunch: !supervised,
            },
            {
              ...(supervised ? { promotionLease: supervised.transfer } : {}),
              recordSpawn: async (spawned) => {
                operation = spawned;
                // The external supervisor must retain this original child even
                // if recording or measuring its identity subsequently fails.
                supervised?.observeHelper(spawned);
                if (spawned.pid === null)
                  throw new Error("UPDATE_HELPER_IDENTITY_UNKNOWN");
                // Record before helper code or request bytes are sent, then enrich
                // with start time. A failed observation preserves the actual PID.
                retained = {
                  ...retained!,
                  helper: { pid: spawned.pid, processStart: null },
                };
                await writeRecord(readyFile, retained);
                retained = {
                  ...retained,
                  helper: {
                    pid: spawned.pid,
                    processStart: await captureInstalledProcessStart(
                      spawned.pid,
                    ),
                  },
                };
                await writeRecord(readyFile, retained);
              },
            },
          );
          operation = handoff.operation;
          if (
            (handoff.status === "not_started" ||
              handoff.status === "refused") &&
            (await confirmedNoEffect(handoff))
          ) {
            if (
              (await readRecord(path.join(operationRoot, "journal.json"))) !==
                null ||
              !sameBuild(await readBuild(slot), source)
            )
              return { status: "unknown", code: "UPDATE_HANDOFF_UNKNOWN" };
            await writeRecord(path.join(root, `${operationId}-refusal.json`), {
              schema: "farol.update-refusal/1",
              action: "apply",
              operation: preparing,
              code: handoff.reason,
            });
            // The same launch has a confirmed pre-mutation outcome. Commit that
            // proof as preparation before reclaiming its copy, including after a
            // helper refusal. Never leave a dispatch intent pointing at removed bytes.
            retained = {
              ...retained,
              operation: null,
              helper: null,
              preparation: preparing,
            };
            await writeRecord(readyFile, retained);
            await removePreparedCopy(preparing);
            retained = { ...retained, preparation: undefined };
            await writeRecord(readyFile, retained);
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
          if (!supervised) options.quit();
          return { status: "accepted" };
        } catch {
          if (verified && !(await discardVerifiedStage(verified.handle)))
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
    },
  });
  return controller;
}
