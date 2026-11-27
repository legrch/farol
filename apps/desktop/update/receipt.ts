import type { z } from "zod";
import {
  sameBuild,
  type AcceptedBuild,
  type ClosedRepairJournal,
  type ClosedRepairReceipt,
  type Operation,
  type PromotionReceipt,
  type Retained,
  type SavedReceipt,
} from "./record";

// Pure judgements and shapes over the startup records: which build a receipt
// anchors, and whether a record may stand for the running build. Reading the
// records and the order of the reads stay with the startup observation.

type Accepted = z.infer<typeof AcceptedBuild>;
type Running = Readonly<{ buildId: string; version: string }>;

export type RetainedRead = Readonly<
  | {
      ok: true;
      value: {
        artifactSha256: string;
        version: string;
        buildId: string;
        buildVersion: string;
      };
    }
  | { ok: false }
>;

// The retained download's identity, in the shape an operation target has.
export function retainedBuild(
  value: Extract<RetainedRead, { ok: true }>["value"],
): Accepted {
  return {
    digest: value.artifactSha256,
    version: value.version,
    buildId: value.buildId,
  };
}

// The side of an operation the running build is, or undefined.
export function operationSide(
  op: z.infer<typeof Operation>,
  running: Running,
): Accepted | undefined {
  return [op.source, op.target].find(
    (value) =>
      value.buildId === running.buildId && value.version === running.version,
  );
}

export function repairAccepted(
  receipt: z.infer<typeof ClosedRepairReceipt>,
  journal: z.infer<typeof ClosedRepairJournal>,
  app: string,
  profile: string,
): boolean {
  return !(
    receipt.destination !== app ||
    receipt.userData !== profile ||
    journal.phase !== receipt.phase ||
    JSON.stringify(journal.receipt) !== JSON.stringify(receipt)
  );
}

export function repairExpected(
  receipt: z.infer<typeof ClosedRepairReceipt>,
): Accepted {
  return receipt.phase === "installed" ? receipt.target : receipt.source;
}

export function promotionAccepted(
  receipt: z.infer<typeof PromotionReceipt>,
  context: Readonly<{
    app: string;
    file: string;
    profile: string;
    build: Readonly<{
      sourceCommit: string;
      sourceTreeDigest: string;
      version: string;
    }>;
  }>,
): boolean {
  return !(
    receipt.destination !== context.app ||
    receipt.receipt !== context.file ||
    receipt.activation.userData !== context.profile ||
    receipt.sourceCommit !== context.build.sourceCommit ||
    receipt.sourceTreeDigest !== context.build.sourceTreeDigest ||
    receipt.version !== context.build.version ||
    receipt.artifactSha256 !== receipt.verifiedDestinationSha256
  );
}

export function promotionExpected(
  receipt: z.infer<typeof PromotionReceipt>,
  buildId: string,
): Accepted {
  return {
    digest: receipt.verifiedDestinationSha256,
    version: receipt.version,
    buildId,
  };
}

export function manifestExpected(
  manifest: Readonly<{
    artifactSha256: string;
    version: string;
    buildId: string;
  }>,
): Accepted {
  return {
    digest: manifest.artifactSha256,
    version: manifest.version,
    buildId: manifest.buildId,
  };
}

// The build a settled saved receipt left in the slot: the target after a
// completed update, the source after a rollback, nothing otherwise.
export function settledBuild(
  previous: z.infer<typeof SavedReceipt>,
): Accepted | null {
  const op = previous.operation;
  return previous.phase === "completed"
    ? (op?.target ?? null)
    : previous.phase === "rolled_back"
      ? (op?.source ?? null)
      : null;
}

// True when a saved receipt of an older update must NOT be treated as a manual
// replacement. Only the checks that need no disk read; the absence probes of
// the other pending records run after it, in the caller. The checks keep their
// stored order, so the injected version order and retained reader are consulted
// exactly as before.
export function replacementRefused(
  input: Readonly<{
    previous: z.infer<typeof SavedReceipt>;
    parsed: RetainedRead;
    build: Readonly<{ version: string; buildVersion?: string | undefined }>;
    repair: unknown;
    repairJournal: unknown;
    ready: z.infer<typeof Retained> | null;
    compareVersions(left: string, right: string): number | null;
    retained(record: z.infer<typeof Retained>): RetainedRead;
  }>,
): boolean {
  const { previous, parsed, build, ready } = input;
  const op = previous.operation;
  const settled = settledBuild(previous);
  return (
    !op ||
    !settled ||
    previous.runningBuildId !== settled.buildId ||
    !parsed.ok ||
    !sameBuild(op.target, retainedBuild(parsed.value)) ||
    input.compareVersions(build.version, op.target.version) !== 1 ||
    BigInt(build.buildVersion!) <= BigInt(parsed.value.buildVersion) ||
    input.repair !== null ||
    input.repairJournal !== null ||
    Boolean(ready?.helper) ||
    (ready !== null && !input.retained(ready).ok)
  );
}
