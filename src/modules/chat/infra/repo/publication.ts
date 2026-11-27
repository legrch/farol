import type { CheckpointEnvelope } from "../../domain/checkpoint";
import {
  sameCompactionRequest,
  sameContextBinding,
  type ContextSession,
} from "../../domain/context-continuity";
import { digest } from "./layout";
import {
  admissionLeaseRecordSchema,
  type ContextPublicationRequest,
  type StoredContextSource,
} from "./records";

// Publication owner checks of the private context store: whether the lease,
// session and source a checkpoint publication was admitted under still hold.
// Pure predicates over values the store already read; nothing here touches the
// filesystem.

// True while the stored lease record still names this process and instance.
export function leaseOwnedBy(
  value: unknown,
  processId: number,
  processInstanceId: string,
): boolean {
  const owner = admissionLeaseRecordSchema.safeParse(value);
  return !(
    !owner.success ||
    owner.data.processId !== processId ||
    owner.data.processInstanceId !== processInstanceId
  );
}

// True while the session is still validated for exactly this publication.
export function sessionHoldsPublication(
  session: ContextSession | null,
  checkpoint: CheckpointEnvelope,
  expected: ContextPublicationRequest["expected"],
): boolean {
  return !(
    !session ||
    !sameContextBinding(session.binding, checkpoint.binding) ||
    session.epoch !== expected.sourceEpoch ||
    session.phase !== "validated" ||
    !session.operation ||
    !sameCompactionRequest(session.operation, expected.source) ||
    session.operation.sourceEpoch !== expected.sourceEpoch ||
    session.operation.checkpointId !== checkpoint.checkpointId ||
    session.operation.summaryDispatch !== "result_received"
  );
}

// True while the stored source is byte-for-byte the one the request expected.
export function sourceHoldsPublication(
  stored: StoredContextSource | null,
  expected: ContextPublicationRequest["expected"],
): boolean {
  return !(
    !stored ||
    digest(stored) !== expected.sourceSHA256 ||
    JSON.stringify(stored) !== JSON.stringify(expected.source)
  );
}
