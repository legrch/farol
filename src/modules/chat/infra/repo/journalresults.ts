import type { HandoffRecord } from "../../app/service/persistent-codex-handoff";
import { stringRecord, type ReservationRecord } from "./journalrecords";

/** The raw progress records read beside a reservation. `null` means absent. */
export type JournalProgress = Readonly<{
  threadIntent: unknown;
  thread: unknown;
  turnIntent: unknown;
  turn: unknown;
  continuation: unknown;
}>;

/** Assemble the public record from a validated reservation and its progress. */
export function buildHandoffRecord(
  record: ReservationRecord,
  progress: JournalProgress,
): HandoffRecord {
  const { threadIntent, thread, turnIntent, turn, continuation } = progress;
  return {
    requestDigest: record.requestDigest,
    ...(record.dispatchProtocol === undefined
      ? {}
      : { dispatchProtocol: record.dispatchProtocol }),
    ...(record.adopted ? { adopted: true as const } : {}),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: record.reasoningEffort }),
    workspaceId: stringRecord(record.workspaceId),
    workspace: record.workspace,
    projectId: stringRecord(record.projectId),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: record.reasoningEffort }),
    ...(record.modelBinding === undefined
      ? {}
      : { modelBinding: record.modelBinding }),
    ...(record.modelCatalogue === undefined
      ? {}
      : { modelCatalogue: record.modelCatalogue }),
    ...(record.continuedFrom === undefined
      ? {}
      : {
          continuedFrom: record.continuedFrom,
          continuationVerified: continuation !== null,
        }),
    threadIntent: threadIntent !== null,
    turnIntent: turnIntent !== null,
    ...(thread === null ? {} : { threadId: stringRecord(thread) }),
    ...(turn === null ? {} : { turnId: stringRecord(turn) }),
  };
}

/** A message receipt carries the turn it confirmed, or null while pending. */
export function messageState(
  digest: string,
  receipt: unknown,
): Readonly<{ digest: string; turnId: string | null }> {
  return receipt === null
    ? { digest, turnId: null }
    : { digest, turnId: stringRecord(receipt) };
}
