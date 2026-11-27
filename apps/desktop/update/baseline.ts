import path from "node:path";
import type { z } from "zod";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";
import { sameBuild } from "./record";
import type {
  AcceptedBuild,
  ClosedRepairJournal,
  ClosedRepairReceipt,
  Operation,
  PromotionReceipt,
} from "./record";
import { manifestTarget } from "./identity";

// The pure judgments behind the accepted-source reader: which repair, promotion
// and receipt evidence may anchor the running copy. Each takes values the caller
// already read and answers one question. None reads a file, runs a process or
// writes; every refusal code and the evaluation order stay with the caller.

type Build = z.infer<typeof AcceptedBuild>;
type OperationRecord = z.infer<typeof Operation>;
type Repair = z.infer<typeof ClosedRepairReceipt>;
type RepairJournal = ReturnType<typeof ClosedRepairJournal.safeParse>;
type Promotion = z.infer<typeof PromotionReceipt>;

/**
 * True while a cold repair outcome is unresolved: some repair evidence is
 * present and the receipt and journal do not describe the same settled phase.
 */
export function repairUnresolved(input: {
  receiptRaw: unknown;
  journalRaw: unknown;
  repair: Repair | null;
  journal: RepairJournal;
}): boolean {
  const { receiptRaw, journalRaw, repair, journal } = input;
  return (
    (receiptRaw !== null || journalRaw !== null) &&
    (!repair ||
      !journal.success ||
      journal.data.phase !== repair.phase ||
      JSON.stringify(journal.data.receipt) !== JSON.stringify(repair))
  );
}

/** True when the receipt's target is not the release its manifest names. */
export function receiptTargetMismatch(
  operation: OperationRecord,
  release: Readonly<{
    artifactSha256: string;
    version: string;
    buildId: string;
  }>,
): boolean {
  return !sameBuild(operation.target, manifestTarget(release));
}

/**
 * True when a settled receipt describes an older copy than the running one: a
 * verified manual replacement sits between the last update and this launch.
 */
export function manualReplacementApplies(input: {
  supervised: boolean;
  installLocation: string;
  settled: Build | null;
  receiptRunningBuildId: string;
  running: Readonly<{ buildId: string; version: string }>;
  target: Build;
  compareVersions(left: string, right: string): number | null;
}): boolean {
  return (
    !input.supervised &&
    input.installLocation === "shared" &&
    input.settled !== null &&
    input.receiptRunningBuildId === input.settled.buildId &&
    input.running.buildId !== input.target.buildId &&
    input.compareVersions(input.running.version, input.target.version) === 1
  );
}

/** Where a cold repair keeps the predecessor it displaced. */
export function repairPrevious(slot: string, operationId: string): string {
  return path.join(
    path.dirname(slot),
    `.farol-repair-${operationId}`,
    "previous.app",
  );
}

/** True when a repair receipt names a different slot, profile or locations. */
export function repairIdentityMismatch(input: {
  repair: Repair;
  slot: string;
  userData: string;
  previous: string;
}): boolean {
  const { repair, slot, userData, previous } = input;
  return (
    repair.destination !== slot ||
    repair.userData !== userData ||
    repair.previous !== previous ||
    repair.quarantine !==
      path.join(userData, `installed-updates-quarantine-${repair.operationId}`)
  );
}

/** True when an installed repair does not describe the running source and target. */
export function repairInstalledMismatch(
  repair: Repair,
  running: Pick<
    BuildIdentity,
    "sourceCommit" | "sourceTreeDigest" | "buildId" | "version"
  >,
): boolean {
  return (
    repair.sourceCommit !== running.sourceCommit ||
    repair.sourceTreeDigest !== running.sourceTreeDigest ||
    repair.target.buildId !== running.buildId ||
    repair.target.version !== running.version
  );
}

/** True when a cold rollback's source is not the running build. */
export function repairRollbackMismatch(
  repair: Repair,
  running: Readonly<{ buildId: string; version: string }>,
): boolean {
  return (
    repair.source.buildId !== running.buildId ||
    repair.source.version !== running.version
  );
}

/** True when the installer's promotion receipt does not anchor this copy. */
export function promotionUnconfirmed(input: {
  receipt: Promotion;
  slot: string;
  file: string;
  userData: string;
  running: Pick<BuildIdentity, "sourceCommit" | "sourceTreeDigest" | "version">;
}): boolean {
  const { receipt, slot, file, userData, running } = input;
  return (
    receipt.destination !== slot ||
    receipt.receipt !== file ||
    receipt.activation.userData !== userData ||
    receipt.sourceCommit !== running.sourceCommit ||
    receipt.sourceTreeDigest !== running.sourceTreeDigest ||
    receipt.version !== running.version ||
    receipt.artifactSha256 !== receipt.verifiedDestinationSha256
  );
}
