import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import {
  InstalledUpdater,
  type ReadyUpdate,
} from "../../modules/release/app/installed-updater";
import {
  discoverGithubUpdate,
  downloadAndVerifyGithubUpdate,
  packageMatchesRelease,
  parseGithubReleaseManifest,
} from "../../modules/release/app/github-release";
import type {
  UpdateCandidate,
  VerifiedGithubUpdate,
} from "../../modules/release/domain/github-release-contract";
import type { InstalledUpdateView } from "../../modules/release/contract/installed-update";
import { createGithubUpdateTransport } from "../../modules/release/infra/native/github-update-transport";
import { createUpdatePackageVerifier } from "../../modules/release/infra/native/update-package-verifier";
import {
  captureInstalledProcessStart,
  installedFarolSlot,
  startInstalledUpdateHelper,
  type InstalledUpdateOperation,
  type InstalledUpdateLaunch,
} from "../../modules/release/infra/native/installed-update-helper";
import type { BuildIdentity } from "../../pkg/build-info/identity";

const execute = promisify(execFile);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const AcceptedBuild = z.strictObject({
  digest: Digest,
  version: z.string().max(128),
  buildId: Digest,
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
async function readRecord(file: string): Promise<unknown | null> {
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
    (before.mode & 0o077) !== 0 ||
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
  | Readonly<{ ok: true; release(): Promise<void> }>;
export type InstalledUpdateRuntimeOptions = Readonly<{
  directory: string;
  userData: string;
  build: BuildIdentity;
  // Electron must copy physical ASAR files, not its virtual archive filesystem.
  copyApp(source: string, destination: string): Promise<void>;
  acquireAdmission(): Promise<InstalledUpdateAdmission>;
  quit(): void;
  publish(view: InstalledUpdateView): void;
}>;

export async function createInstalledUpdateRuntime(
  options: InstalledUpdateRuntimeOptions,
): Promise<InstalledUpdater | null> {
  if (
    options.build.updateChannel !== "github-owner-beta" ||
    !options.build.buildVersion ||
    options.build.sourceDirty
  )
    return null;
  const slot = installedFarolSlot();
  const actualApp = path.resolve(options.directory, "../../..");
  // Checkouts and temporary task-run copies can never mutate the installed slot.
  if (
    actualApp !== slot ||
    (await fs.realpath(actualApp)) !== slot ||
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
    });
    const transport = createGithubUpdateTransport({
      privateStateDirectory: directory,
      verifyPackage: (handle, manifest) =>
        verifier.verifyPackage(handle, manifest),
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
  let candidate: UpdateCandidate | null = null;
  let verified: VerifiedGithubUpdate | null = null;
  let stagingUncertain = false;
  let retained: z.infer<typeof Retained> | null = null;
  let operation: InstalledUpdateOperation | null = null;
  const readyFile = path.join(root, "ready.json");
  const cleanupFile = path.join(root, "package-cleanup-pending.json");
  const receiptFile = path.join(root, "last-update.json");
  const restoreFile = path.join(root, "restore-pending.json");
  let restorable: z.infer<typeof Retained> | null = null;
  let restoreKind: "recover" | "rollback" | null = null;
  let declinedBuildId: string | null = null;
  const runTrusted = async (entry: string, args: string[]) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(options.directory, entry), ...args],
      {
        env: {
          PATH: "/usr/bin:/bin",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_NO_ASAR: "1",
        },
        encoding: "utf8",
        maxBuffer: 65536,
        timeout: 180000,
      },
    );
    return JSON.parse(stdout) as unknown;
  };
  const readBuild = async (file: string) =>
    AcceptedBuild.parse(await runTrusted("update-slot.mjs", [file]));
  const known = (code: string) => ({ ok: false as const, code });
  const sameBuild = (
    a: z.infer<typeof AcceptedBuild>,
    b: z.infer<typeof AcceptedBuild>,
  ) =>
    a.digest === b.digest && a.version === b.version && a.buildId === b.buildId;
  const sameOperation = (
    a: z.infer<typeof Operation>,
    b: z.infer<typeof Operation>,
  ) =>
    a.operationId === b.operationId &&
    sameBuild(a.source, b.source) &&
    sameBuild(a.target, b.target);
  const readJournal = async (op: z.infer<typeof Operation>) => {
    const journal = Journal.parse(
      await readRecord(path.join(root, op.operationId, "journal.json")),
    );
    if (!sameOperation(journal, op))
      throw new Error("UPDATE_OPERATION_IDENTITY_MISMATCH");
    return journal;
  };
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
    if (!record.helper) return false;
    try {
      const { stdout, stderr } = await execute(
        "/bin/ps",
        ["-p", String(record.helper.pid), "-o", "lstart="],
        {
          timeout: 3000,
          maxBuffer: 4096,
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
        },
      );
      return (
        record.helper.processStart !== null &&
        !stderr &&
        /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(
          stdout.trim(),
        ) &&
        stdout.trim() !== record.helper.processStart
      );
    } catch (error) {
      // ps exit 1 with no output is an absent PID. EPERM, timeout, or malformed
      // observation cannot establish termination or permit a replacement helper.
      const result = error as {
        code?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
      return result.code === 1 && result.stdout === "" && result.stderr === "";
    }
  };
  const confirmedRejectedTarget = async (
    op: z.infer<typeof Operation>,
    record: z.infer<typeof Retained>,
  ) => {
    const directory = path.join(root, op.operationId);
    await canonicalOwnedDirectory(directory, true);
    const raw = await readRecord(path.join(directory, "rejected-target.json"));
    if (raw === null) return false;
    const witness = RejectedTarget.parse(raw);
    if (!sameOperation(witness, op) || !(await originalHelperEnded(record)))
      throw new Error("UPDATE_REJECTED_TARGET_UNCONFIRMED");
    // Only metadata is needed for rejected bytes; never execute their verifier
    // or reinterpret their corrupt contents as an accepted application.
    const rejected = path.join(directory, "failed.app");
    await canonicalOwnedDirectory(rejected, false);
    const fd = await fs.open(
      rejected,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await fd.stat({ bigint: true });
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
          await fs.lstat(path.join(directory, name));
          present = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (present)
          throw new Error("UPDATE_REJECTED_TARGET_LAYOUT_UNCONFIRMED");
      }
      const current = await fs.lstat(rejected, { bigint: true });
      if (
        current.dev !== metadata.dev ||
        current.ino !== metadata.ino ||
        !current.isDirectory()
      )
        throw new Error("UPDATE_REJECTED_TARGET_CHANGED");
    } finally {
      await fd.close();
    }
    return true;
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
        await fs.rm(directory, { recursive: true, force: false });
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
          String(process.pid),
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
    await fs.rm(path.join(directory, "staged.app"), {
      recursive: true,
      force: true,
    });
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
  const controller = new InstalledUpdater({
    cancelPending: () => {
      downloadsCancelled = true;
      transport.cancelPending();
    },
    now: Date.now,
    publish: options.publish,
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
      const parsed = parseGithubReleaseManifest(retained.manifest);
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
        )
          return known("UPDATE_RESTORE_OUTCOME_UNKNOWN");
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
          if (settled) rollbackVersion = op.source.version;
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
        if (!settled) {
          if (!(await originalHelperEnded(retained)))
            return known("UPDATE_HELPER_EXIT_UNCONFIRMED");
          return { ok: true, update: null, recoveryVersion: current.version };
        }
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
        update: { handle: retained.handle, manifest: parsed.value },
      };
    },
    discover: async () => {
      let current: z.infer<typeof AcceptedBuild>;
      try {
        // update-slot measures CFBundleVersion and binds it to this identity.
        // Do not query GitHub using an unconfirmed installed baseline.
        current = await readBuild(slot);
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
      candidate =
        found.value?.manifest.buildId === declinedBuildId ? null : found.value;
      return { ok: true, available: candidate !== null };
    },
    download: async () => {
      if (!candidate) return known("UPDATE_CANDIDATE_MISSING");
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
        buildId: candidate.manifest.buildId,
        archiveSha256: candidate.manifest.archiveSha256,
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
        downloaded = await downloadAndVerifyGithubUpdate(candidate, {
          ...checkedTransport,
          verifyPackage: async (handle, manifest) => {
            // Native verification may have its own child lifetime. A lost
            // result must not be treated as an interrupted HTTP-only stage.
            download.phase = "verifying";
            await writeRecord(pendingDownloadFile, intent);
            return checkedTransport.verifyPackage(handle, manifest);
          },
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
    },
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
      const op = restorable?.operation;
      if (
        !op ||
        restoreKind !== action ||
        operation ||
        (await readRecord(restoreFile)) !== null
      )
        return { status: "blocked", code: "UPDATE_RESTORE_NOT_READY" };
      if (action === "recover" && !(await originalHelperEnded(restorable!)))
        return { status: "blocked", code: "UPDATE_HELPER_EXIT_UNCONFIRMED" };
      const admission = await options.acquireAdmission();
      if (!admission.ok) return { status: "blocked", code: admission.code };
      let keepAdmission = false;
      try {
        if (!(await drained()))
          return { status: "blocked", code: "UPDATE_WORK_PENDING" };
        const journal = await readJournal(op);
        const current = await readBuild(slot);
        if (
          current.buildId !== options.build.buildId ||
          (!sameBuild(current, op.source) && !sameBuild(current, op.target))
        )
          return { status: "blocked", code: "UPDATE_SOURCE_IDENTITY_MISMATCH" };
        const processStart = await captureInstalledProcessStart(process.pid);
        await writeRecord(restoreFile, {
          schema: "farol.update-restore-intent/1",
          action,
          operation: op,
          priorPhase: journal.phase,
        });
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
        );
        operation = handoff.operation;
        if (
          (handoff.status === "refused" || handoff.status === "not_started") &&
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
          return { status: "unknown", code: "UPDATE_RESTORE_OUTCOME_UNKNOWN" };
        options.quit();
        return { status: "accepted" };
      } catch {
        return {
          status: keepAdmission ? "unknown" : "blocked",
          code: keepAdmission
            ? "UPDATE_RESTORE_OUTCOME_UNKNOWN"
            : "UPDATE_RESTORE_PREPARE_FAILED",
        };
      } finally {
        if (!keepAdmission) await admission.release();
      }
    },
    restart: async (update) => {
      if (operation || retained?.operation || retained?.preparation)
        return { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" };
      if (!retained || retained.handle !== update.handle)
        return { status: "blocked", code: "UPDATE_PACKAGE_NOT_READY" };
      const admission = await options.acquireAdmission();
      if (!admission.ok) return { status: "blocked", code: admission.code };
      let keepAdmission = false;
      try {
        if (!(await drained()))
          return { status: "blocked", code: "UPDATE_WORK_PENDING" };
        const source = await readBuild(slot);
        if (
          source.buildId !== options.build.buildId ||
          source.version !== options.build.version
        )
          return { status: "blocked", code: "UPDATE_SOURCE_IDENTITY_MISMATCH" };
        const processStart = await captureInstalledProcessStart(process.pid);
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
              !check.ok && "certainty" in check && check.certainty === "unknown"
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
          return { status: "unknown", code: "UPDATE_STAGING_OUTCOME_UNKNOWN" };
        if (!copied)
          return { status: "blocked", code: "UPDATE_PREPARE_FAILED" };
        retained = {
          ...retained,
          preparation: undefined,
          operation: preparing,
        };
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
                  processStart: await captureInstalledProcessStart(spawned.pid),
                },
              };
              await writeRecord(readyFile, retained);
            },
          },
        );
        operation = handoff.operation;
        if (
          (handoff.status === "not_started" || handoff.status === "refused") &&
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
        if (handoff.status !== "ready")
          return {
            status: "unknown",
            code:
              handoff.status === "refused"
                ? "UPDATE_HELPER_REFUSED"
                : "UPDATE_HANDOFF_UNKNOWN",
          };
        options.quit();
        return { status: "accepted" };
      } catch {
        if (verified && !(await discardVerifiedStage(verified.handle)))
          return { status: "unknown", code: "UPDATE_STAGING_OUTCOME_UNKNOWN" };
        if (stagingUncertain || retained?.preparation)
          return { status: "unknown", code: "UPDATE_STAGING_OUTCOME_UNKNOWN" };
        return {
          status: keepAdmission ? "unknown" : "blocked",
          code: keepAdmission
            ? "UPDATE_HANDOFF_UNKNOWN"
            : "UPDATE_PREPARE_FAILED",
        };
      } finally {
        if (!keepAdmission) await admission.release();
      }
    },
  });
  return controller;
}
