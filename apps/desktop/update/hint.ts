import type { z } from "zod";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";
import { buildIdentityCanonical } from "./identity";
import { RELAUNCH_ARGUMENT, RelaunchHint, sameOperation } from "./record";
import type {
  AcceptedBuild,
  Operation,
  RestoreIntent,
  Retained,
} from "./record";

// The pure checks on an explicit updater relaunch: the one argument that names
// it, and whether the receipt and installed pair agree with it. None reads a
// record or a process; the caller keeps the order of its reads and its codes.

type Hint = z.infer<typeof RelaunchHint>;
type Build = z.infer<typeof AcceptedBuild>;
type OperationRecord = z.infer<typeof Operation>;

/**
 * The hint a launch carries, or null when it carries none. A repeated, bare,
 * oversized or malformed hint is refused under one code.
 */
export function parseRelaunchHint(args: readonly string[]): Hint | null {
  const hints = args.filter(
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
  try {
    return RelaunchHint.parse(JSON.parse(json) as unknown);
  } catch {
    throw new Error("UPDATE_RELAUNCH_HINT_INVALID");
  }
}

/** True for a build that can never take part in an update. */
export function updateIneligible(
  build: Pick<BuildIdentity, "updateChannel" | "buildVersion" | "sourceDirty">,
): boolean {
  return (
    !["github-owner-beta", "github-stable"].includes(build.updateChannel) ||
    !build.buildVersion ||
    build.sourceDirty
  );
}

/** True when the running process is not the one the hint was issued for. */
export function relaunchIdentityMismatch(input: {
  hint: Hint;
  build: BuildIdentity;
  userData: string;
  profile: string;
  directory: string;
  expectedDirectory: string;
}): boolean {
  const { hint, build } = input;
  return (
    input.userData !== input.profile ||
    input.directory !== input.expectedDirectory ||
    updateIneligible(build) ||
    hint.buildId !== build.buildId ||
    !buildIdentityCanonical(build)
  );
}

/** True when the hint's action and phase do not belong together. */
export function relaunchPhaseInvalid(hint: Hint): boolean {
  return (
    (hint.action === "apply" &&
      !["completed", "rollback_completed"].includes(hint.phase)) ||
    (hint.action === "rollback" && hint.phase !== "rollback_completed")
  );
}

/** The build the hint says is installed once its helper has ended. */
export function relaunchExpected(
  phase: Hint["phase"],
  operation: OperationRecord,
): Build {
  return phase === "completed" ? operation.target : operation.source;
}

/** True when the receipt is not the one this hint's helper was dispatched with. */
export function relaunchReceiptMismatch(input: {
  receipt: z.infer<typeof Retained> | z.infer<typeof RestoreIntent>;
  hint: Hint;
  pinned: OperationRecord | undefined;
}): boolean {
  const { receipt, hint, pinned } = input;
  const op = receipt.operation;
  return (
    !op ||
    op.operationId !== hint.operationId ||
    !receipt.helper ||
    receipt.helper.pid !== hint.helper.pid ||
    receipt.helper.processStart !== hint.helper.processStart ||
    (hint.action !== "apply" &&
      (!("action" in receipt) ||
        receipt.action !== hint.action ||
        "notStartedAt" in receipt)) ||
    (!!pinned && !sameOperation(pinned, op))
  );
}

/** True when the expected build is not the running one or the pair is degenerate. */
export function relaunchPairMismatch(
  expected: Build,
  running: Readonly<{ buildId: string; version: string }>,
  pinned: OperationRecord,
): boolean {
  return (
    expected.buildId !== running.buildId ||
    expected.version !== running.version ||
    pinned.source.buildId === pinned.target.buildId ||
    pinned.source.digest === pinned.target.digest
  );
}
