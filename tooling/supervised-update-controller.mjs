import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { captureInstalledPredecessor } from "../src/apps/desktop/installed-predecessor.ts";
import { createSupervisedInstalledUpdateRuntime } from "../src/apps/desktop/installed-update-runtime.ts";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "../src/apps/desktop/promotion-lease.ts";
import { parseGithubReleaseManifest } from "../src/modules/release/app/github-release.ts";
import { compareReleaseVersions } from "../src/modules/release/domain/github-version.ts";
import { installedFarolSlot } from "../src/modules/release/infra/native/installed-update-helper.ts";
import {
  activationObligations,
  assertActivationDrained,
  promotionUserData,
} from "./promotion-obligations.mjs";
import { captureSupervisedUpdateResources } from "./supervised-update-resources.mjs";
import { preserveClosedInstalledPair } from "./supervised-update-backup.mjs";
import { observeUpdateSlot } from "./update-slot-observer.mjs";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Absolute = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      path.isAbsolute(value) &&
      path.resolve(value) === value,
  );
const Source = z.strictObject({
  digest: Digest,
  version: z.string().min(1).max(128),
  buildId: Digest,
});
const Input = z.strictObject({
  artifactFile: Absolute,
  appPath: Absolute,
  expected: z.strictObject({
    version: z.string().min(1).max(128),
    buildVersion: z.string().regex(/^[1-9][0-9]{0,8}$/u),
    buildId: Digest,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceTreeDigest: Digest,
    artifactSha256: Digest,
  }),
  expectedSource: Source,
  archivePath: Absolute,
  manifest: z.unknown(),
  recoveryParent: Absolute,
});

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function sameBuild(left, right) {
  return ["digest", "version", "buildId"].every(
    (key) => left[key] === right[key],
  );
}

function below(file, directory) {
  return file === directory || file.startsWith(directory + path.sep);
}

// Preflight reads no archive contents into the report and performs no extraction.
// The existing updater later imports and verifies this archive under its own intent.
async function verifyArchive(file, manifest) {
  requireValue(
    (await fs.realpath(file)) === file,
    "UPDATE_ARCHIVE_PATH_INVALID",
  );
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    requireValue(
      before.isFile() &&
        before.nlink === 1n &&
        before.uid === BigInt(process.geteuid()) &&
        (before.mode & 0o022n) === 0n &&
        before.size === BigInt(manifest.archiveSize),
      "UPDATE_ARCHIVE_UNSAFE",
    );
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const part of handle.createReadStream({ autoClose: false })) {
      bytes += part.length;
      requireValue(bytes <= manifest.archiveSize, "UPDATE_ARCHIVE_CHANGED");
      hash.update(part);
    }
    const same = (info) =>
      [
        "dev",
        "ino",
        "mode",
        "uid",
        "gid",
        "nlink",
        "size",
        "mtimeNs",
        "ctimeNs",
      ].every((key) => info[key] === before[key]);
    requireValue(
      bytes === manifest.archiveSize &&
        hash.digest("hex") === manifest.archiveSha256 &&
        same(await handle.stat({ bigint: true })) &&
        same(await fs.lstat(file, { bigint: true })),
      "UPDATE_ARCHIVE_CHANGED",
    );
  } finally {
    await handle.close();
  }
}

async function assertNoPendingUpdate(userData, slot) {
  const root = path.join(userData, "installed-updates");
  try {
    const info = await fs.lstat(root);
    requireValue(
      info.isDirectory() &&
        info.uid === process.geteuid() &&
        (info.mode & 0o077) === 0 &&
        (await fs.realpath(root)) === root,
      "UPDATE_EXISTING_STATE_UNSAFE",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  // These are the existing owners' intent paths. Presence requires their own
  // reconciliation; a first supervised transition never cleans or retries them.
  for (const file of [
    ...[
      "ready.json",
      "restore-pending.json",
      "download-pending.json",
      "package-cleanup-pending.json",
    ].map((name) => path.join(root, name)),
    slot + ".repair.json",
    path.join(path.dirname(slot), ".farol-closed-repair.json"),
  ]) {
    try {
      await fs.lstat(file);
      throw new Error("UPDATE_EXISTING_OPERATION_REQUIRES_REVIEW");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function waitForClosure(predecessor) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await predecessor.observeClosed();
    } catch (error) {
      if (error?.message !== "UPDATE_PREDECESSOR_STILL_PRESENT") throw error;
      requireValue(
        Date.now() < deadline,
        "UPDATE_PREDECESSOR_EXIT_UNCONFIRMED",
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function waitForHelper(operation) {
  let timer;
  try {
    // The detached helper unrefs its pipes. This referenced timer keeps the
    // external controller alive to observe that ORIGINAL child's completion.
    return await Promise.race([
      operation.completion,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 300_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One explicitly selected, local owner transition. No discovery, retry, force
 * stop, restoration or alternative updater state is created here. The existing
 * updater owns admission, archive retention, dispatch intent and reconciliation.
 */
export async function runSupervisedUpdate(raw, publish = () => {}) {
  const input = Input.parse(raw);
  const parsed = parseGithubReleaseManifest(input.manifest);
  requireValue(parsed.ok, "UPDATE_MANIFEST_INVALID");
  const manifest = Object.freeze({ ...parsed.value });
  const target = Object.freeze({
    version: input.expected.version,
    buildId: input.expected.buildId,
    digest: input.expected.artifactSha256,
  });
  requireValue(
    manifest.channel === "owner-beta" &&
      Object.entries(input.expected).every(
        ([key, value]) => manifest[key] === value,
      ) &&
      compareReleaseVersions(target.version, input.expectedSource.version) ===
        1 &&
      target.buildId !== input.expectedSource.buildId &&
      target.digest !== input.expectedSource.digest,
    "UPDATE_SELECTED_IDENTITIES_INVALID",
  );
  const userData = promotionUserData(os.userInfo().homedir);
  const slot = installedFarolSlot();
  let stage = "preflight";
  let lease = null;
  let runtime = null;
  let predecessor = null;
  let backup = null;
  let partialBackupRoot = null;
  let helper = null;
  let quitAttempted = false;
  let quitConfirmed = false;
  let restartAttempted = false;
  let completion = null;
  let outcome = null;
  let reportingFailure = null;
  // The updater's synchronous observer is outside some drain guards. A failed
  // output sink must never interrupt that owner or turn reporting into an effect.
  const publishSafely = (value) => {
    if (reportingFailure !== null) return;
    try {
      const pending = publish(value);
      if (pending && typeof pending.then === "function") {
        // Asynchronous sinks cannot acknowledge this synchronous boundary.
        // Consume a rejection, retain the failure and stop at the next safe step.
        reportingFailure = "UPDATE_PROGRESS_REPORT_FAILED";
        Promise.resolve(pending).catch(() => {});
      }
    } catch {
      reportingFailure = "UPDATE_PROGRESS_REPORT_FAILED";
    }
  };
  const requireReporting = () =>
    requireValue(reportingFailure === null, "UPDATE_PROGRESS_REPORT_FAILED");
  const report = (status, code = null) =>
    Object.freeze({
      schema: "farol.supervised-update-observation/1",
      status,
      stage,
      code,
      reportingFailure,
      source: input.expectedSource,
      target,
      predecessor: predecessor?.original ?? null,
      predecessorClosed: quitConfirmed,
      backup: backup
        ? {
            root: backup.root,
            app: backup.app,
            profile: backup.profile,
            profileDigest: backup.profileDigest,
          }
        : null,
      partialBackupRoot,
      helper: helper
        ? { operationId: helper.operationId, pid: helper.pid, completion }
        : null,
    });
  try {
    const resources = await captureSupervisedUpdateResources(input);
    requireValue(
      !below(resources.app, userData) &&
        resources.app !== slot &&
        ![userData, slot, resources.app].some((root) =>
          below(input.recoveryParent, root),
        ),
      "UPDATE_RESOURCE_OVERLAP",
    );
    const parent = await fs.lstat(input.recoveryParent);
    requireValue(
      parent.isDirectory() &&
        parent.uid === process.geteuid() &&
        (parent.mode & 0o077) === 0 &&
        (await fs.realpath(input.recoveryParent)) === input.recoveryParent,
      "UPDATE_RECOVERY_PARENT_UNSAFE",
    );
    await verifyArchive(input.archivePath, manifest);
    requireValue(
      sameBuild(await observeUpdateSlot(slot), input.expectedSource),
      "UPDATE_SOURCE_CHANGED",
    );
    predecessor = await captureInstalledPredecessor();
    lease = await acquirePromotionLease(
      userData,
      `supervised-${randomUUID()}`,
      "promotion",
    );
    requireValue(lease !== null, "UPDATE_PROMOTION_BUSY");
    await assertNoPendingUpdate(userData, slot);
    const obligations = await activationObligations(userData);
    assertActivationDrained({
      ...obligations,
      obligations: obligations.obligations.filter(
        (item) => item !== `APP_RUNNING:${predecessor.original.pid}`,
      ),
    });
    requireValue(await verifyPromotionLease(lease), "UPDATE_LEASE_CHANGED");
    requireValue(await resources.verify(), "UPDATE_RESOURCES_CHANGED");
    publishSafely(report("prepared"));
    requireReporting();
    stage = "quit";
    quitAttempted = true;
    await predecessor.requestQuit();
    await waitForClosure(predecessor);
    quitConfirmed = true;
    stage = "preserve";
    assertActivationDrained(await activationObligations(userData));
    backup = await preserveClosedInstalledPair({
      destinationParent: input.recoveryParent,
      predecessor,
      lease,
      expectedSource: input.expectedSource,
    });
    requireValue(await backup.verify(), "UPDATE_BACKUP_UNCONFIRMED");
    stage = "stage";
    runtime = await createSupervisedInstalledUpdateRuntime({
      directory: path.join(resources.app, "Contents/Resources/app"),
      userData,
      predecessor,
      lease,
      resources,
      localArchive: { path: input.archivePath, manifest },
      copyApp: (source, destination) =>
        fs.cp(source, destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        }),
      removeDirectory: (directory, force) =>
        fs.rm(directory, { recursive: true, force }),
      publish: (view) => publishSafely({ ...report("progress"), view }),
      observeHelper: (original) => {
        requireValue(
          helper === null || helper === original,
          "UPDATE_HELPER_REPLACEMENT_REFUSED",
        );
        helper = original;
      },
    });
    requireValue(runtime !== null, "UPDATE_RUNTIME_NOT_ADMITTED");
    await runtime.initialize();
    requireValue(
      runtime.snapshot().phase === "idle",
      "UPDATE_BASELINE_NOT_ADMITTED",
    );
    requireReporting();
    await runtime.prepareLocal();
    requireValue(
      runtime.snapshot().phase === "ready" &&
        runtime.snapshot().version === target.version,
      "UPDATE_LOCAL_PACKAGE_NOT_READY",
    );
    requireReporting();
    requireValue(await backup.verify(), "UPDATE_BACKUP_UNCONFIRMED");
    stage = "apply";
    restartAttempted = true;
    await runtime.restart();
    const view = runtime.snapshot();
    if (helper) completion = await waitForHelper(helper);
    if (view.phase === "ready" && view.blockedBy !== null) {
      outcome = report("blocked", view.blockedBy);
    } else {
      requireValue(
        view.phase === "applying" &&
          completion?.code === 0 &&
          completion.signal === null &&
          completion.protocolError === null &&
          completion.terminal?.phase === "verified" &&
          completion.terminal.error === null,
        "UPDATE_HELPER_COMPLETION_UNCONFIRMED",
      );
      stage = "verify-slot";
      requireValue(
        sameBuild(await observeUpdateSlot(slot), target),
        "UPDATE_TARGET_UNCONFIRMED",
      );
      stage = "verify-closed";
      // Do not poll or reinterpret a newly present marker/changed Quit receipt
      // after replacement. Target startup would invalidate pre-launch recovery.
      await predecessor.observeClosed();
      stage = "verified-closed";
      // The original helper has ended without requesting target startup. Keep
      // first launch behind independent recovery and state qualification.
      outcome = report("verified_closed");
    }
  } catch (error) {
    if (
      typeof error?.partialRoot === "string" &&
      path.dirname(error.partialRoot) === input.recoveryParent &&
      path.basename(error.partialRoot).startsWith("farol-closed-pair-")
    )
      partialBackupRoot = error.partialRoot;
    const code = /^[A-Z][A-Z0-9_:.-]{0,200}$/u.test(error?.message ?? "")
      ? error.message
      : "UPDATE_SUPERVISOR_FAILED";
    const view = runtime?.snapshot();
    const uncertain =
      (quitAttempted && !quitConfirmed) ||
      restartAttempted ||
      (view?.phase === "failed" && view.recoveryRequired);
    outcome = report(uncertain ? "unknown" : "blocked", code);
  } finally {
    try {
      await runtime?.close();
    } catch {
      // Preserve any observed helper terminal; cleanup cannot rewrite it.
      outcome = { ...outcome, controllerClose: "unconfirmed" };
    }
    // Once restart begins, the existing runtime owns durable dispatch and its
    // inherited lease. Never release that fence based on a caught exception.
    if (lease && !restartAttempted) {
      try {
        await releasePromotionLease(lease);
      } catch {
        outcome = { ...outcome, leaseRelease: "unconfirmed" };
      }
    }
  }
  return Object.freeze(outcome);
}
