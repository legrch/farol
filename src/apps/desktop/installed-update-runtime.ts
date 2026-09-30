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
  ]),
});
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
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
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

export type InstalledUpdateAdmission =
  | Readonly<{ ok: false; code: string }>
  | Readonly<{ ok: true; release(): Promise<void> }>;
export type InstalledUpdateRuntimeOptions = Readonly<{
  directory: string;
  userData: string;
  build: BuildIdentity;
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
  const checkedTransport = {
    ...transport,
    download: async (url: string, maximum: number) => {
      const result = await transport.download(url, maximum);
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
  const runTrusted = async (entry: string, args: string[]) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(options.directory, entry), ...args],
      {
        env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
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
  const controller = new InstalledUpdater({
    now: Date.now,
    publish: options.publish,
    recover: async () => {
      if ((await readRecord(pendingDownloadFile)) !== null)
        return known("UPDATE_STAGING_OUTCOME_UNKNOWN");
      const raw = await readRecord(readyFile);
      if (raw === null) return { ok: true, update: null };
      retained = Retained.parse(raw);
      const parsed = parseGithubReleaseManifest(retained.manifest);
      if (!parsed.ok) return known("UPDATE_RETAINED_MANIFEST_INVALID");
      if (retained.operation) {
        const op = retained.operation;
        const journal = Journal.parse(
          await readRecord(path.join(root, op.operationId, "journal.json")),
        );
        if (
          journal.operationId !== op.operationId ||
          JSON.stringify(journal.source) !== JSON.stringify(op.source) ||
          JSON.stringify(journal.target) !== JSON.stringify(op.target)
        )
          return known("UPDATE_OPERATION_IDENTITY_MISMATCH");
        if (
          !["verified", "launch_requested", "completed"].includes(journal.phase)
        )
          return known("UPDATE_RECOVERY_REQUIRED");
        const current = await readBuild(slot);
        const predecessor = await readBuild(
          path.join(root, op.operationId, "previous.app"),
        );
        if (
          JSON.stringify(current) !== JSON.stringify(op.target) ||
          JSON.stringify(predecessor) !== JSON.stringify(op.source) ||
          current.buildId !== options.build.buildId
        )
          return known("UPDATE_RECOVERY_IDENTITY_MISMATCH");
        await writeRecord(path.join(root, "last-update.json"), {
          ...retained,
          observedAt: new Date().toISOString(),
          phase: journal.phase,
          runningBuildId: options.build.buildId,
        });
        await fs.unlink(readyFile);
        retained = null;
        return { ok: true, update: null };
      }
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
      candidate = found.value;
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
    restart: async (update) => {
      if (operation || retained?.operation)
        return { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" };
      if (!verified || verified.handle !== update.handle || !retained)
        return { status: "blocked", code: "UPDATE_PACKAGE_NOT_READY" };
      const admission = await options.acquireAdmission();
      if (!admission.ok) return { status: "blocked", code: admission.code };
      let keepAdmission = false;
      try {
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
        if (!report.drained)
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
        await fs.cp(
          verified.stagedAppPath,
          path.join(operationRoot, "staged.app"),
          {
            recursive: true,
            force: false,
            errorOnExist: true,
            verbatimSymlinks: true,
            preserveTimestamps: true,
          },
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
