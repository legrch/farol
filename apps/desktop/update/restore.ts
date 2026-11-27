import type { z } from "zod";
import { sameBuild } from "./record";
import type { AcceptedBuild, Operation } from "./record";
import type { HandoffRefusal } from "./stage";

// The pure gates of a restore or rollback request. Each answers from values the
// caller already observed; none takes admission, reads a record or starts the
// helper. An unknown outcome stays unknown and no refusal here is a retry.

type OperationRecord = z.infer<typeof Operation>;
type Build = z.infer<typeof AcceptedBuild>;

/**
 * The first refusal that applies before a restore takes admission, or null.
 * The order is the contract: a supervised owner, a build without the compiled
 * Go core, an unconfirmed browser release, a held admission, then a rollback
 * to a predecessor whose state cannot be recovered.
 */
export function restoreEntryRefusal(input: {
  supervised: boolean;
  goCoreMissing: boolean;
  releaseUnconfirmed: boolean;
  admissionHeld: boolean;
  action: "recover" | "rollback";
  operation: OperationRecord | null | undefined;
  requiresStateRecovery(source: string, target: string): boolean;
}): HandoffRefusal | null {
  if (input.supervised)
    return {
      status: "blocked",
      code: "UPDATE_SUPERVISED_RESTORE_UNQUALIFIED",
    };
  if (input.goCoreMissing)
    return { status: "blocked", code: "UPDATE_HELPER_GO_CORE_REQUIRED" };
  if (input.releaseUnconfirmed)
    return { status: "blocked", code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
  if (input.admissionHeld)
    return { status: "unknown", code: "UPDATE_RESTORE_OUTCOME_UNKNOWN" };
  const op = input.operation;
  if (
    input.action === "rollback" &&
    op &&
    input.requiresStateRecovery(op.source.version, op.target.version)
  )
    return { status: "blocked", code: "UPDATE_PREDECESSOR_STATE_UNQUALIFIED" };
  return null;
}

/** True when the installed build is neither the running one nor either side of the pair. */
export function restoreSourceMismatch(
  current: Build,
  operation: OperationRecord,
  running: Readonly<{ buildId: string }>,
): boolean {
  return (
    current.buildId !== running.buildId ||
    (!sameBuild(current, operation.source) &&
      !sameBuild(current, operation.target))
  );
}
