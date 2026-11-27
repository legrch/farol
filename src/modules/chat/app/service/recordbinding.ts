import type {
  HandoffAdopt,
  HandoffCreateResult,
  HandoffMessageResult,
  HandoffMessage,
  HandoffRecord,
  HandoffRequest,
  HandoffTitleRequest,
  HandoffTitleResult,
  HandoffWorkspace,
} from "../port/handoff";
import { sameWorkspace } from "./handoffvalidation";

export type ContinuationExpected = Readonly<
  Omit<HandoffRecord, "threadIntent" | "turnIntent">
>;

/** The record a continuation child must carry, bound to the parent's issued model. */
export function continuationExpected(
  parent: HandoffRecord,
  model: string,
  workspace: HandoffWorkspace,
  requestDigest: string,
  dispatchId: string,
  attempts: boolean,
): ContinuationExpected {
  return {
    requestDigest,
    ...(attempts ? { dispatchProtocol: 1 as const } : {}),
    workspaceId: parent.workspaceId,
    workspace,
    projectId: parent.projectId,
    model,
    reasoningEffort: parent.reasoningEffort,
    ...(parent.modelBinding ? { modelBinding: parent.modelBinding } : {}),
    continuedFrom: dispatchId,
  };
}

export function sameContinuation(
  record: HandoffRecord,
  expected: ContinuationExpected,
  workspace: HandoffWorkspace,
): boolean {
  return (
    record.requestDigest === expected.requestDigest &&
    record.workspaceId === expected.workspaceId &&
    record.projectId === expected.projectId &&
    record.model === expected.model &&
    record.reasoningEffort === expected.reasoningEffort &&
    record.continuedFrom === expected.continuedFrom &&
    record.modelBinding?.configSha256 === expected.modelBinding?.configSha256 &&
    record.modelBinding?.selection.harness ===
      expected.modelBinding?.selection.harness &&
    record.modelBinding?.selection.modelAlias ===
      expected.modelBinding?.selection.modelAlias &&
    sameWorkspace(record.workspace, workspace)
  );
}

/** Replay of a verified continuation child: dispatched, otherwise unknown. */
export function continuationReplay(
  child: HandoffRecord,
  parentThreadId: string,
  dispatchId: string,
): HandoffCreateResult | null {
  if (!child.turnId) return null;
  return child.continuationVerified === true &&
    child.threadId === parentThreadId
    ? {
        status: "dispatched",
        dispatchId,
        threadId: child.threadId,
        turnId: child.turnId,
      }
    : { status: "outcome_unknown", dispatchId };
}

/** A steer may not select another workspace, project, model or effort. */
export function messageBindingChanged(
  record: HandoffRecord,
  request: HandoffMessage,
): boolean {
  return (
    record.workspaceId !== request.workspaceId ||
    record.projectId !== request.projectId ||
    record.model !== request.model ||
    // Steer adds input to the issued turn; it does not select another model or
    // effort. An omitted value retains the journal's effective binding, while
    // an explicit conflicting value must still refuse before any effect.
    (request.reasoningEffort !== undefined &&
      record.reasoningEffort !== request.reasoningEffort)
  );
}

export function titleBindingChanged(
  record: HandoffRecord,
  request: HandoffTitleRequest,
): boolean {
  return (
    record.workspaceId !== request.workspaceId ||
    record.projectId !== request.projectId
  );
}

/** A recorded message claim: same digest replays as steered or unknown. */
export function messageReplay(
  prior: Readonly<{ digest?: string | undefined; turnId: string | null }>,
  digest: string,
  record: HandoffRecord,
  dispatchId: string,
): HandoffMessageResult {
  if (prior.digest !== undefined && prior.digest !== digest)
    return { status: "refused", code: "HANDOFF_KEY_CONFLICT" };
  return prior.turnId === record.turnId
    ? { status: "steered", dispatchId, turnId: prior.turnId }
    : { status: "outcome_unknown", dispatchId };
}

/** A recorded title claim: a different digest conflicts; the same thread replays. */
export function titleReplay(
  prior: Readonly<{ digest: string; threadId: string | null }>,
  digest: string,
  record: HandoffRecord,
  request: HandoffTitleRequest,
  unknown: HandoffTitleResult,
): HandoffTitleResult {
  if (prior.digest !== digest)
    return { status: "refused", code: "HANDOFF_KEY_CONFLICT" };
  return prior.threadId === record.threadId
    ? {
        status: "recorded",
        dispatchId: request.dispatchId,
        title: request.title,
        proof: "historical",
      }
    : unknown;
}

/** The journal winner must be this request in this approved workspace. */
export function reservationConflict(
  reserved: HandoffRecord,
  requestDigest: string,
  request: HandoffRequest,
  workspace: HandoffWorkspace,
): boolean {
  return (
    reserved.requestDigest !== requestDigest ||
    reserved.workspaceId !== request.workspaceId ||
    reserved.projectId !== request.projectId ||
    !sameWorkspace(reserved.workspace, workspace)
  );
}

/** Concurrent same-key requests can observe different runtime defaults. */
export function reservationRaced(
  reserved: HandoffRecord,
  request: HandoffRequest,
): boolean {
  return !!(
    reserved.modelCatalogue &&
    (reserved.model !== request.model ||
      reserved.reasoningEffort !== request.reasoningEffort)
  );
}

/** An adopted record must be exactly this owner thread and turn in this workspace. */
export function adoptConflict(
  record: HandoffRecord,
  digest: string,
  request: HandoffAdopt,
  workspace: HandoffWorkspace,
): boolean {
  return (
    record.adopted !== true ||
    record.requestDigest !== digest ||
    record.workspaceId !== request.workspaceId ||
    record.projectId !== request.projectId ||
    !sameWorkspace(record.workspace, workspace) ||
    (record.threadId !== undefined && record.threadId !== request.threadId) ||
    (record.turnId !== undefined && record.turnId !== request.turnId)
  );
}

export function adoptRecorded(
  record: HandoffRecord | null,
  request: HandoffAdopt,
): boolean {
  return (
    record?.adopted === true &&
    record.threadId === request.threadId &&
    record.turnId === request.turnId
  );
}

/** A journal record is dispatched only when both provider identifiers are durable. */
export function knownOrUnknown(
  key: string,
  record: HandoffRecord | null,
): HandoffCreateResult {
  return record?.threadId && record.turnId
    ? {
        status: "dispatched",
        dispatchId: key,
        threadId: record.threadId,
        turnId: record.turnId,
      }
    : { status: "outcome_unknown", dispatchId: key };
}

/** The request re-bound to the effort the serving catalogue actually resolved. */
export function withResolvedEffort(
  request: HandoffRequest,
  effort: string | undefined,
): HandoffRequest {
  return {
    ...request,
    reasoningEffort: effort,
    ...(request.modelBinding
      ? {
          modelBinding: {
            ...request.modelBinding,
            selection: { ...request.modelBinding.selection, effort },
          },
        }
      : {}),
  };
}

/** A same-key replay keeps the model binding the journal already issued. */
export function replayedRequest(
  request: HandoffRequest,
  issued: HandoffRecord,
): HandoffRequest {
  return {
    ...request,
    model: issued.model ?? request.model,
    reasoningEffort: issued.reasoningEffort ?? request.reasoningEffort,
    modelBinding: issued.modelBinding ?? request.modelBinding,
  };
}

/**
 * What an unsubmitted attempt owes the journal. Cancellation consumes the turn
 * (no no-effect proof exists); otherwise only the attempt's owner may attest a
 * known pre-send refusal. A possible effect never publishes either.
 */
export function unsubmittedAction(
  effectPossible: boolean,
  aborted: boolean,
  consumeCancellation: boolean,
  attempt: number | undefined,
): "consume-turn" | "record-refusal" | "none" {
  if (effectPossible) return "none";
  if (aborted && consumeCancellation) return "consume-turn";
  if (!aborted && attempt !== undefined) return "record-refusal";
  return "none";
}
