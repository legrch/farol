import type { ContextAdmission } from "../../app/port/context-repository";
import type { CheckpointEnvelope } from "../../domain/checkpoint";
import {
  sameCompactionRequest,
  sameContextBinding,
  type CompactionRequest,
  type ContextBinding,
  type ContextSession,
} from "../../domain/context-continuity";
import type { decodeCompletion } from "./decode";
import { digest } from "./layout";

// Completion decisions of the private context store: when a retired epoch's
// completion is written and whether a stored operation counts as completed.
// Pure predicates over values the store already read; nothing here touches the
// filesystem.

type CompletionRecord = ReturnType<typeof decodeCompletion>;

// The durable retired -> active transition that writes completion evidence.
// Returns the retired epoch and the request that completed it, else null.
export function retiredEpochCompletion(
  existing: ContextSession | null,
  session: ContextSession,
): Readonly<{ epoch: number; request: CompactionRequest }> | null {
  if (
    existing &&
    existing.phase === "old_epoch_retired" &&
    existing.operation &&
    existing.operation.summaryDispatch === "result_received" &&
    existing.operation.hostContextRef !== null &&
    existing.operation.sourceEpoch === existing.epoch &&
    session.phase === "active" &&
    !session.operation &&
    session.epoch === existing.epoch + 1 &&
    session.lastCompletedRequest &&
    sameCompactionRequest(existing.operation, session.lastCompletedRequest) &&
    session.lastCompletedOperationId === existing.operation.operationId &&
    session.lastCheckpointId === existing.operation.checkpointId
  ) {
    return { epoch: existing.epoch, request: session.lastCompletedRequest };
  }
  return null;
}

// Does the checkpoint a completing session names agree with the retired epoch?
export function completionCheckpointMismatch(
  checkpoint: CheckpointEnvelope,
  epoch: number,
  request: CompactionRequest,
): boolean {
  return (
    checkpoint.epoch !== epoch || !sameCompactionRequest(checkpoint, request)
  );
}

export function completionAdmission(
  binding: ContextBinding,
  checkpoint: CheckpointEnvelope,
  request: CompactionRequest,
): ContextAdmission {
  return {
    binding,
    sourceEpoch: checkpoint.epoch,
    request,
  };
}

export function completionRecord(
  admission: ContextAdmission,
  checkpoint: CheckpointEnvelope,
) {
  return {
    schemaVersion: 1,
    kind: "context_completion",
    admission,
    checkpointId: checkpoint.checkpointId,
    checkpointSHA256: digest(checkpoint),
  } as const;
}

export type CompletedSession = Readonly<{
  epoch: number;
  operationId: string;
  request: CompactionRequest;
  checkpointId: string;
}>;

// A session that is active with a finished compaction and a head checkpoint.
export function completedSession(
  session: ContextSession | null,
  binding: ContextBinding,
): CompletedSession | null {
  if (
    !session ||
    !sameContextBinding(session.binding, binding) ||
    session.phase !== "active" ||
    session.operation ||
    !session.lastCompletedOperationId ||
    !session.lastCompletedRequest ||
    !session.lastCheckpointId
  )
    return null;
  return {
    epoch: session.epoch,
    operationId: session.lastCompletedOperationId,
    request: session.lastCompletedRequest,
    checkpointId: session.lastCheckpointId,
  };
}

export function headCompletesSession(
  head: CheckpointEnvelope | null,
  completed: CompletedSession,
): head is CheckpointEnvelope {
  return !(
    !head ||
    head.operationId !== completed.operationId ||
    head.epoch + 1 !== completed.epoch ||
    !sameCompactionRequest(head, completed.request)
  );
}

// The operation is the head's own: absent evidence is accepted, present
// evidence must name the head exactly.
export function headOperationConfirmed(
  completion: CompletionRecord | null,
  head: CheckpointEnvelope,
): boolean {
  return (
    !completion ||
    (completion.admission.sourceEpoch === head.epoch &&
      completion.checkpointId === head.checkpointId &&
      completion.checkpointSHA256 === digest(head))
  );
}

// Earlier epochs require their original checkpoint or the exact completion
// evidence recorded before pruning, plus the same owner's later active head.
export function earlierOperationConfirmed(
  completion: CompletionRecord | null,
  head: CheckpointEnvelope,
  originals: ReadonlyArray<CheckpointEnvelope>,
): boolean {
  if (completion) {
    if (completion.admission.sourceEpoch >= head.epoch) return false;
    if (
      originals.length > 0 &&
      (originals.length !== 1 ||
        originals[0]!.checkpointId !== completion.checkpointId ||
        digest(originals[0]) !== completion.checkpointSHA256)
    )
      return false;
    return true;
  }
  // Historical stores without completion evidence still require the original.
  return originals.length === 1 && originals[0]!.epoch < head.epoch;
}
