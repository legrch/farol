import type { z } from "zod";
import { sameBuild, sameOperation } from "./record";
import type {
  AcceptedBuild,
  DownloadIntent,
  DownloadStage,
  Operation,
  Retained,
  SavedReceipt,
} from "./record";
import type {
  HelperObservation,
  installedUpdateStartupDecision,
} from "./decision";

// The pure decisions inside update staging, recovery and the helper handoff.
// Each function answers one question from values its caller already observed:
// it reads no file, runs no process, holds no clock and writes nothing. The
// runtime keeps every await, journal write and the handoff itself in place and
// calls these where the inline condition stood. An outcome that is unknown
// stays unknown here: no function turns it into a retryable refusal.

type Build = z.infer<typeof AcceptedBuild>;
type OperationRecord = z.infer<typeof Operation>;
type RetainedRecord = z.infer<typeof Retained>;
type DownloadRecord = z.infer<typeof DownloadStage>;

/** The refusal a handoff reports before or instead of an effect. */
export type HandoffRefusal = Readonly<{
  status: "blocked" | "unknown";
  code: string;
}>;

// ---------------------------------------------------------------------------
// Release ordering and package verification

/** An update strictly increases both the release order and the build number. */
export function increasingRelease(
  order: number | null,
  manifestBuildVersion: string,
  currentBuildVersion: string,
): boolean {
  return (
    order !== null &&
    order > 0 &&
    BigInt(manifestBuildVersion) > BigInt(currentBuildVersion)
  );
}

export type PackageVerification =
  "verified" | "outcome_unknown" | "capacity" | "invalid";

/**
 * Classify a physical package verification. `matchesRelease` is whether the
 * verified identity equals the manifest, and only matters for a clean check.
 * An unknown certainty outranks every other reason and is never "invalid".
 */
export function classifyPackageVerification(
  check: Readonly<{ ok: boolean; certainty?: string; reason?: string }>,
  matchesRelease: boolean,
): PackageVerification {
  if (!check.ok && check.certainty === "unknown") return "outcome_unknown";
  if (!check.ok && check.reason === "stage_capacity") return "capacity";
  if (!check.ok || !matchesRelease) return "invalid";
  return "verified";
}

/**
 * The code a refused verification reports. A caller never asks for a verified
 * package; if it did, the answer fails closed as an invalid package.
 */
export function verificationRefusalCode(
  verification: PackageVerification,
): string {
  return verification === "outcome_unknown"
    ? "UPDATE_STAGING_OUTCOME_UNKNOWN"
    : verification === "capacity"
      ? "UPDATE_VERIFICATION_RECOVERY_REQUIRED"
      : "UPDATE_RETAINED_PACKAGE_INVALID";
}

/** The handoff outcome of a refused verification. Only unknown stays unknown. */
export function verificationHandoff(
  verification: PackageVerification,
): HandoffRefusal {
  return {
    status: verification === "outcome_unknown" ? "unknown" : "blocked",
    code: verificationRefusalCode(verification),
  };
}

// ---------------------------------------------------------------------------
// Download staging and its recovery

/** A known failed download keeps its transport's code under one prefix. */
export function downloadFailureCode(code: string): string {
  return `UPDATE_${code.toUpperCase()}`;
}

/** What startup does with a pending download intent. */
export type DownloadRecovery = "none" | "reconcile" | "restore_unknown";

/** An intent is reconciled only without a ready record, and never over a restore. */
export function downloadRecoveryAtStartup(
  input: Readonly<{
    hasIntent: boolean;
    fromReady: boolean;
    restorePending: boolean;
  }>,
): DownloadRecovery {
  if (!input.hasIntent || input.fromReady) return "none";
  return input.restorePending ? "restore_unknown" : "reconcile";
}

/**
 * Only an intent whose producer witness says it was downloading or verifying
 * may have its stage reclaimed, and only once that producer is known to have
 * ended. A verifying stage may also hold verifier extractions, which
 * `downloadStageExtractionsGone` must clear first. A legacy intent has no
 * witness: its ownership is never guessed.
 */
export function claimableInterruptedDownload(
  download: DownloadRecord | undefined,
): download is DownloadRecord & { phase: "downloading" | "verifying" } {
  return (
    download !== undefined &&
    (download.phase === "downloading" || download.phase === "verifying")
  );
}

/**
 * Whether an extraction reclaim pass leaves nothing the interrupted download's
 * stage directory must still protect. The pass reports the extractions it
 * kept (live, unknown or untrusted) by path and the staging parents it could
 * not scan. The stage is clear only if the pass captured the update root, did
 * not skip the root or this stage, and kept no entry directly inside it. What
 * it kept in another parent says nothing about this directory. No pass at all
 * is unknown.
 */
export function downloadStageExtractionsGone(
  scan: Readonly<{
    kept: readonly Readonly<{ entry: string }>[];
    unscanned: readonly string[];
    root: unknown;
  }> | null,
  root: string,
  directory: string,
): boolean {
  if (scan === null || scan.root === null) return false;
  if (scan.unscanned.some((parent) => parent === root || parent === directory))
    return false;
  return !scan.kept.some(
    (item) => item.entry.slice(0, item.entry.lastIndexOf("/")) === directory,
  );
}

/** An allocated stage must still be the exact directory the intent recorded. */
export function downloadStageIdentityChanged(
  observed: Readonly<{ dev: bigint; ino: bigint; birthtimeNs: bigint }>,
  recorded: Readonly<{ dev: string; ino: string; birthtimeNs: string }>,
): boolean {
  return (
    String(observed.dev) !== recorded.dev ||
    String(observed.ino) !== recorded.ino ||
    String(observed.birthtimeNs) !== recorded.birthtimeNs
  );
}

/** A leftover intent must describe exactly the retained, un-operated archive. */
export function downloadIntentConflicts(
  intent: z.infer<typeof DownloadIntent>,
  retained: Pick<RetainedRecord, "operation" | "downloadId">,
  manifest: Readonly<{ buildId: string; archiveSha256: string }>,
): boolean {
  return (
    retained.operation !== null ||
    intent.buildId !== manifest.buildId ||
    intent.archiveSha256 !== manifest.archiveSha256 ||
    intent.download?.id !== retained.downloadId
  );
}

/** What startup reports when neither a ready record nor a receipt exists. */
export function emptyRecoveryOutcome(
  input: Readonly<{ restorePending: boolean; interruptedDownload: boolean }>,
): "restore_unknown" | "download_interrupted" | "none" {
  return input.restorePending
    ? "restore_unknown"
    : input.interruptedDownload
      ? "download_interrupted"
      : "none";
}

// ---------------------------------------------------------------------------
// Startup recovery of retained work

/**
 * A settled receipt from an older run, observed by a strictly newer build, no
 * longer needs recovery: only the accepted source must still be confirmed.
 */
export function historicalReceiptSuperseded(
  input: Readonly<{
    historical: Pick<
      z.infer<typeof SavedReceipt>,
      "phase" | "operation" | "runningBuildId"
    >;
    running: Readonly<{ buildId: string; version: string }>;
    compareVersions(left: string, right: string): number | null;
  }>,
): boolean {
  const { historical, running } = input;
  const settledBuild =
    historical.phase === "completed"
      ? historical.operation?.target
      : historical.phase === "rolled_back"
        ? historical.operation?.source
        : null;
  return (
    !!historical.operation &&
    !!settledBuild &&
    historical.runningBuildId === settledBuild.buildId &&
    running.buildId !== historical.operation.target.buildId &&
    input.compareVersions(
      running.version,
      historical.operation.target.version,
    ) === 1
  );
}

/** A restore that never started must still match everything it recorded. */
export function restoreNotStartedMismatch(
  input: Readonly<{
    pendingOperation: OperationRecord;
    retainedOperation: OperationRecord | null;
    notStartedAt: Build;
    current: Build;
    running: Readonly<{ buildId: string; version: string }>;
  }>,
): boolean {
  return (
    !input.retainedOperation ||
    !sameOperation(input.pendingOperation, input.retainedOperation) ||
    input.current.buildId !== input.running.buildId ||
    input.current.version !== input.running.version ||
    !sameBuild(input.current, input.notStartedAt)
  );
}

/**
 * An unfinished preparation may be reclaimed only from a ready record that
 * holds no operation or helper, for the unchanged source, before any journal.
 * The journal read is the caller's last, lazy term.
 */
export function preparationUnreconciled(
  input: Readonly<{
    fromReady: boolean;
    restorePending: boolean;
    retained: Pick<RetainedRecord, "operation" | "helper">;
    current: Build;
    running: Readonly<{ buildId: string; version: string }>;
    preparation: OperationRecord;
    manifestTarget: Build;
  }>,
): boolean {
  return (
    !input.fromReady ||
    input.restorePending ||
    !!input.retained.operation ||
    !!input.retained.helper ||
    input.current.buildId !== input.running.buildId ||
    input.current.version !== input.running.version ||
    !sameBuild(input.current, input.preparation.source) ||
    !sameBuild(input.preparation.target, input.manifestTarget)
  );
}

export type Settlement =
  | Readonly<{ ok: true; phase: "completed" | "rolled_back" }>
  | Readonly<{ ok: false; code: string }>;

/**
 * Settle an operation from its startup decision. A running helper and an
 * unknown helper outcome are the same refusal and settle nothing; an identity
 * the decision cannot accept never settles. No refusal here is retryable.
 */
export function startupSettlement(
  input: Readonly<{
    decision: ReturnType<typeof installedUpdateStartupDecision>;
    helper: HelperObservation;
  }>,
): Settlement {
  const { decision } = input;
  if (decision.action === "wait" || input.helper === "unknown")
    return { ok: false, code: "UPDATE_HELPER_EXIT_UNCONFIRMED" };
  if (decision.action === "refuse" || !decision.mayStart)
    return { ok: false, code: "UPDATE_RECOVERY_IDENTITY_MISMATCH" };
  return { ok: true, phase: decision.action };
}

/** A restore whose helper left the journal unchanged records that refusal. */
export function restoreExitWitnessApplies(
  input: Readonly<{
    pending: Readonly<{
      priorPhase: string;
      installedBefore?: Build | undefined;
    }> | null;
    journalPhase: string | undefined;
    current: Build;
  }>,
): boolean {
  const { pending } = input;
  return (
    !!pending &&
    input.journalPhase === pending.priorPhase &&
    !!pending.installedBefore &&
    sameBuild(input.current, pending.installedBefore)
  );
}

/** Rollback is offered only for a completed operation with a preserved source. */
export function rollbackVersionFor(
  input: Readonly<{
    phase: "completed" | "rolled_back";
    predecessor: Build | null;
    operation: Pick<OperationRecord, "source" | "target">;
    requiresStateRecovery(source: string, target: string): boolean;
  }>,
): string | undefined {
  if (input.phase !== "completed") return undefined;
  const { predecessor, operation } = input;
  return predecessor &&
    sameBuild(predecessor, operation.source) &&
    !input.requiresStateRecovery(
      operation.source.version,
      operation.target.version,
    )
    ? operation.source.version
    : undefined;
}

/** A settled receipt that re-observation would only rewrite byte for byte. */
export function settledReceiptUnchanged(
  input: Readonly<{
    fromReady: boolean;
    restorePending: boolean;
    saved: z.infer<typeof SavedReceipt> | null;
    retained: RetainedRecord;
    phase: "completed" | "rolled_back";
    runningBuildId: string;
  }>,
): boolean {
  const { saved } = input;
  return (
    !input.fromReady &&
    !input.restorePending &&
    saved !== null &&
    JSON.stringify({
      ...input.retained,
      observedAt: saved.observedAt,
      phase: input.phase,
      runningBuildId: input.runningBuildId,
    }) === JSON.stringify(saved)
  );
}

/** An apply that the helper rolled back under a ready record reports it. */
export function applyRolledBack(
  input: Readonly<{
    fromReady: boolean;
    restorePending: boolean;
    current: Build;
    source: Build;
  }>,
): boolean {
  return (
    input.fromReady &&
    !input.restorePending &&
    sameBuild(input.current, input.source)
  );
}

export type RetainedBuildRelation = "exact" | "older" | "other";

/** How a retained manifest relates to the build that is running right now. */
export function retainedBuildRelation(
  input: Readonly<{
    order: number | null;
    manifest: Readonly<{
      buildVersion: string;
      buildId: string;
      sourceCommit: string;
      sourceTreeDigest: string;
      artifactSha256: string;
    }>;
    running: Readonly<{
      buildVersion: string;
      buildId: string;
      sourceCommit: string;
      sourceTreeDigest: string;
    }>;
    installedDigest: string;
  }>,
): RetainedBuildRelation {
  const { order, manifest, running } = input;
  const exact =
    order === 0 &&
    manifest.buildVersion === running.buildVersion &&
    manifest.buildId === running.buildId &&
    manifest.sourceCommit === running.sourceCommit &&
    manifest.sourceTreeDigest === running.sourceTreeDigest &&
    manifest.artifactSha256 === input.installedDigest;
  const older =
    order !== null &&
    order < 0 &&
    BigInt(manifest.buildVersion) < BigInt(running.buildVersion);
  return exact ? "exact" : older ? "older" : "other";
}

/**
 * A ready-only archive that was installed manually, or superseded by a later
 * authenticated build, may be reclaimed. Any pending download, helper,
 * preparation, operation or reclaimed archive keeps its own recovery path.
 */
export function retainedReadyReclaimable(
  input: Readonly<{
    fromReady: boolean;
    retained: Pick<
      RetainedRecord,
      "operation" | "preparation" | "helper" | "archiveReleased"
    >;
    hasDownloadIntent: boolean;
    repository: string;
    channel: string;
    expectedChannel: string;
    relation: RetainedBuildRelation;
  }>,
): boolean {
  return (
    input.fromReady &&
    input.retained.operation === null &&
    !input.retained.preparation &&
    !input.retained.helper &&
    !input.retained.archiveReleased &&
    !input.hasDownloadIntent &&
    input.repository === "legrch/farol" &&
    input.channel === input.expectedChannel &&
    input.relation !== "other"
  );
}

// ---------------------------------------------------------------------------
// Candidate selection

/** The discovered release is the one the owner chose to skip. */
export function candidateSkipped(
  foundVersion: string | undefined,
  skippedVersion: string | undefined,
): boolean {
  return foundVersion === skippedVersion;
}

/** A candidate is deferred when it was declined or the owner deferred it. */
export function candidateDeferred(
  input: Readonly<{
    buildId: string;
    version: string;
    declinedBuildId: string | null;
    deferredVersion: string | null | undefined;
  }>,
): boolean {
  return (
    input.buildId === input.declinedBuildId ||
    input.version === input.deferredVersion
  );
}

// ---------------------------------------------------------------------------
// Restore and apply gates

/**
 * The first refusal that applies before an apply takes admission, in the
 * order the checks have always run. `lifetimeAvailable` is read lazily.
 */
export function applyEntryRefusal(
  input: Readonly<{
    releaseUnconfirmed: boolean;
    admissionHeld: boolean;
    operationActive: boolean;
    retainedOperation: boolean;
    retainedPreparation: boolean;
    packageReady: boolean;
    goCoreRequired: boolean;
    supervised: boolean;
    lifetimeAvailable(): boolean;
  }>,
): HandoffRefusal | null {
  if (input.releaseUnconfirmed)
    return { status: "blocked", code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
  if (
    input.admissionHeld ||
    input.operationActive ||
    input.retainedOperation ||
    input.retainedPreparation
  )
    return { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" };
  if (!input.packageReady)
    return { status: "blocked", code: "UPDATE_PACKAGE_NOT_READY" };
  if (input.goCoreRequired)
    return { status: "blocked", code: "UPDATE_HELPER_GO_CORE_REQUIRED" };
  if (!input.supervised && !input.lifetimeAvailable())
    return { status: "blocked", code: "UPDATE_HELPER_LIFETIME_UNAVAILABLE" };
  return null;
}

/** A confirmation is stale unless it is the browser-interrupt for this ready update. */
export function confirmationStale(
  input: Readonly<{
    confirmation: Readonly<{ kind: string; version: string }>;
    quitApply: boolean;
    updateVersion: string;
    retainedVersion: string | null;
  }>,
): boolean {
  const { confirmation } = input;
  return (
    input.quitApply ||
    confirmation.kind !== "interrupt-browser" ||
    confirmation.version !== input.updateVersion ||
    input.retainedVersion === null ||
    input.retainedVersion !== confirmation.version
  );
}

// ---------------------------------------------------------------------------
// Quit deadline arithmetic (milliseconds since the epoch, `now` observed once)

/** A deadline or clock that is not finite and ahead has expired. */
export function quitDeadlineExpired(now: number, deadlineAt: number): boolean {
  return !Number.isFinite(now) || now >= deadlineAt;
}

/** The longest delay a timer may take, never below one millisecond. */
export function quitTimerDelayMs(now: number, deadlineAt: number): number {
  return Math.max(1, Math.min(2_147_483_647, deadlineAt - now));
}

/** The native launcher's readiness budget, capped at five minutes. */
export function readinessTimeoutMs(now: number, deadlineAt: number): number {
  return Math.max(1, Math.min(300_000, deadlineAt - now));
}

// ---------------------------------------------------------------------------
// Helper launch outcomes

/** A refused or never-started launch with confirmed no effect has one code. */
export function helperNoEffectCode(
  status: "refused" | "not_started",
): "UPDATE_HELPER_REFUSED" | "UPDATE_HELPER_NOT_STARTED" {
  return status === "refused"
    ? "UPDATE_HELPER_REFUSED"
    : "UPDATE_HELPER_NOT_STARTED";
}

export type HelperLaunchFacts =
  | Readonly<{
      status: "terminal";
      result: Readonly<{
        code: number | null;
        signal: unknown;
        protocolError: unknown;
        terminal: Readonly<{ phase: string; error: unknown }> | null;
      }>;
    }>
  | Readonly<{ status: string }>;

/**
 * Whether a launched helper counts as handed off. A supervised owner needs a
 * continued launch or a clean terminal `verified` exit; any other owner needs
 * a ready launch. Everything else, including an unknown outcome, is not.
 */
export function handoffAdmitted(
  handoff: HelperLaunchFacts,
  supervised: boolean,
): boolean {
  if (!supervised) return handoff.status === "ready";
  if (handoff.status === "continued") return true;
  if (handoff.status !== "terminal" || !("result" in handoff)) return false;
  const { result } = handoff;
  return (
    result.code === 0 &&
    result.signal === null &&
    result.protocolError === null &&
    result.terminal?.phase === "verified" &&
    result.terminal.error === null
  );
}

/** An unconfirmed handoff stays unknown; only a refusal names itself. */
export function unadmittedHandoff(status: string): HandoffRefusal {
  return {
    status: "unknown",
    code:
      status === "refused" ? "UPDATE_HELPER_REFUSED" : "UPDATE_HANDOFF_UNKNOWN",
  };
}

/** A thrown quit apply: unknown once any effect may have started. */
export function quitFailureHandoff(keepAdmission: boolean): HandoffRefusal {
  return keepAdmission
    ? { status: "unknown", code: "UPDATE_QUIT_OUTCOME_UNKNOWN" }
    : { status: "blocked", code: "UPDATE_QUIT_DEADLINE_EXPIRED" };
}

/** A thrown apply that reached no known state: unknown while admission is kept. */
export function prepareFailureHandoff(keepAdmission: boolean): HandoffRefusal {
  return keepAdmission
    ? { status: "unknown", code: "UPDATE_HANDOFF_UNKNOWN" }
    : { status: "blocked", code: "UPDATE_PREPARE_FAILED" };
}

/** The code the admission gate reports when its attempt never settled. */
export function applyUnsettledCode(keepAdmission: boolean): string {
  return keepAdmission
    ? "UPDATE_HANDOFF_UNKNOWN"
    : "UPDATE_STAGING_OUTCOME_UNKNOWN";
}

/** A thrown restore: unknown once the restore intent has been kept. */
export function restoreFailureHandoff(keepAdmission: boolean): HandoffRefusal {
  return keepAdmission
    ? { status: "unknown", code: "UPDATE_RESTORE_OUTCOME_UNKNOWN" }
    : { status: "blocked", code: "UPDATE_RESTORE_PREPARE_FAILED" };
}
