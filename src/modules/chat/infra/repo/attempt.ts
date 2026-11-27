import { sameContextBinding } from "../../domain/context-continuity";
import type {
  StoredContextRetirement,
  StoredContextSummaryAttempt,
} from "./records";

// Write rules for summary attempts and retirements in the private context
// store: what a stored record allows its successor to be. Pure comparisons;
// nothing here touches the filesystem.

const ATTEMPT_PHASES = {
  prepared: 0,
  possible_send: 1,
  outcome_unknown: 2,
} as const;

// A summary attempt may only move forward and may not rewrite what an earlier
// write fixed (conversation, user turn, assistant turn).
export function summaryAttemptConflicts(
  existing: StoredContextSummaryAttempt,
  attempt: StoredContextSummaryAttempt,
): boolean {
  const sameIdentity =
    existing.operationId === attempt.operationId &&
    existing.source === attempt.source &&
    existing.sourceBoundary === attempt.sourceBoundary &&
    sameContextBinding(existing.binding, attempt.binding);
  const stableConversation =
    existing.conversationUrl === null ||
    existing.conversationUrl === attempt.conversationUrl;
  const stableUser =
    existing.turnUserId === null || existing.turnUserId === attempt.turnUserId;
  const stableAssistant =
    existing.turnAssistantId === null ||
    existing.turnAssistantId === attempt.turnAssistantId;
  return (
    !sameIdentity ||
    ATTEMPT_PHASES[attempt.phase] < ATTEMPT_PHASES[existing.phase] ||
    !stableConversation ||
    !stableUser ||
    !stableAssistant
  );
}

// An assistant turn without its user turn is not a recordable attempt.
export function summaryAttemptShapeInvalid(
  attempt: Pick<StoredContextSummaryAttempt, "turnAssistantId" | "turnUserId">,
): boolean {
  return attempt.turnAssistantId !== null && attempt.turnUserId === null;
}

// A retirement only moves forward to a later epoch.
export function retirementConflicts(
  existing: StoredContextRetirement,
  retirement: StoredContextRetirement,
): boolean {
  return existing.epoch >= retirement.epoch;
}
