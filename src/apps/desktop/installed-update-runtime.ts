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
const Retained = z.strictObject({
  schema: z.literal("farol.ready-update/1"),
  handle: z.string().max(4096),
  manifest: z.unknown(),
  operation: Operation.nullable(),
  helper: z
    .strictObject({
      pid: z.number().int().min(2),
      processStart: z.string().min(1).max(128),
    })
    .nullable()
    .optional(),
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

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("UPDATE_PRIVATE_STATE_INVALID");
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
async function confirmedRefusal(
  handoff: InstalledUpdateLaunch,
): Promise<boolean> {
  if (handoff.status !== "refused") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const terminal = await Promise.race([
      handoff.operation.completion,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      }),
    ]);
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
  const verifier = createUpdatePackageVerifier({
    archivePathForHandle: async (handle) => handle,
    stagingParent: root,
    extractorPath: path.join(options.directory, "update-archive.py"),
    verifierPath: path.join(options.directory, "update-package.mjs"),
  });
  const transport = createGithubUpdateTransport({
    privateStateDirectory: root,
    verifyPackage: (handle, manifest) =>
      verifier.verifyPackage(handle, manifest),
  });
  let transportOutcomeUnknown = false;
  let stagedDownloadHandle: string | null = null;
  const checkedTransport = {
    ...transport,
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
  let retained: z.infer<typeof Retained> | null = null;
  let operation: InstalledUpdateOperation | null = null;
  const readyFile = path.join(root, "ready.json");
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
  const originalHelperEnded = async (record: z.infer<typeof Retained>) => {
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
  const controller = new InstalledUpdater({
    now: Date.now,
    publish: options.publish,
    recover: async () => {
      if ((await readRecord(pendingDownloadFile)) !== null)
        return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
      const pendingRaw = await readRecord(restoreFile);
      const pending =
        pendingRaw === null ? null : RestoreIntent.parse(pendingRaw);
      const raw = await readRecord(readyFile);
      const fromReady = raw !== null;
      const previous = fromReady ? null : await readRecord(receiptFile);
      if (raw === null && previous === null)
        return pending
          ? known("UPDATE_RESTORE_OUTCOME_UNKNOWN")
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
      const parsed = parseGithubReleaseManifest(retained.manifest);
      if (!parsed.ok) return known("UPDATE_RETAINED_MANIFEST_INVALID");
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
          const other = rolledBack
            ? await optionalBuild(op, "failed.app")
            : journal.phase === "rollback_started"
              ? ((await optionalBuild(op, "failed.app")) ??
                (await optionalBuild(op, "previous.app")))
              : await optionalBuild(op, "staged.app");
          if (!other || !sameBuild(other, op.target))
            return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
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
      verified = {
        handle: retained.handle,
        manifest: parsed.value,
        ...check.value,
      };
      return {
        ok: true,
        update: { handle: retained.handle, manifest: parsed.value },
      };
    },
    discover: async () => {
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
      // Persist before writing archive bytes. A crash or lost cleanup receipt
      // leaves a visible recovery obligation; a later launch never redownloads it.
      await writeRecord(pendingDownloadFile, {
        schema: "farol.update-download-intent/1",
        buildId: candidate.manifest.buildId,
        archiveSha256: candidate.manifest.archiveSha256,
      });
      let downloaded: Awaited<ReturnType<typeof downloadAndVerifyGithubUpdate>>;
      try {
        downloaded = await downloadAndVerifyGithubUpdate(
          candidate,
          checkedTransport,
        );
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
      retained = { schema: "farol.ready-update/1", ...update, operation: null };
      await writeRecord(readyFile, retained);
      await fs.unlink(pendingDownloadFile);
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
        if (handoff.status === "refused" && (await confirmedRefusal(handoff))) {
          if (
            (await readJournal(op)).phase !== journal.phase ||
            !sameBuild(await readBuild(slot), current)
          )
            return {
              status: "unknown",
              code: "UPDATE_RESTORE_OUTCOME_UNKNOWN",
            };
          await writeRecord(path.join(root, op.operationId, "refusal.json"), {
            schema: "farol.update-refusal/1",
            action,
            operation: op,
            code: handoff.reason,
            priorPhase: journal.phase,
          });
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
          operation = null;
          keepAdmission = false;
          return { status: "blocked", code: "UPDATE_HELPER_REFUSED" };
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
      if (operation || retained?.operation)
        return { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" };
      if (!verified || verified.handle !== update.handle || !retained)
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
        const target = {
          digest: verified.identity.artifactSha256,
          version: verified.identity.version,
          buildId: verified.identity.buildId,
        };
        const operationId = randomBytes(16).toString("hex");
        const operationRoot = path.join(root, operationId);
        await fs.mkdir(operationRoot, { mode: 0o700 });
        await options.copyApp(
          verified.stagedAppPath,
          path.join(operationRoot, "staged.app"),
        );
        const processStart = await captureInstalledProcessStart(process.pid);
        retained = { ...retained, operation: { operationId, source, target } };
        // Durable dispatch intent precedes launch. Uncertain launch is never replayed.
        await writeRecord(readyFile, retained);
        keepAdmission = true;
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
        );
        operation = handoff.operation;
        if (handoff.status === "refused" && (await confirmedRefusal(handoff))) {
          if (
            (await readRecord(path.join(operationRoot, "journal.json"))) !==
              null ||
            !sameBuild(await readBuild(slot), source)
          )
            return { status: "unknown", code: "UPDATE_HANDOFF_UNKNOWN" };
          await writeRecord(path.join(operationRoot, "refusal.json"), {
            schema: "farol.update-refusal/1",
            action: "apply",
            operation: retained.operation,
            code: handoff.reason,
          });
          const cleared = { ...retained, operation: null, helper: null };
          await writeRecord(readyFile, cleared);
          retained = cleared;
          operation = null;
          keepAdmission = false;
          return { status: "blocked", code: "UPDATE_HELPER_REFUSED" };
        }
        if (operation.pid !== null) {
          retained = {
            ...retained,
            helper: {
              pid: operation.pid,
              processStart: await captureInstalledProcessStart(operation.pid),
            },
          };
          await writeRecord(readyFile, retained);
        }
        // Keep the same operation observable even on an uncertain ACK. No substitute helper.
        void operation.completion.then((result) => {
          if (handoff.status !== "ready")
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
