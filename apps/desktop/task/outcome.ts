import type { Assignment, CancelReceipt, RunReceipt } from "./summary";

// Pure classification of what a cancellation or a run settled on into the
// error a caller sees, and the acknowledgement command for a delivered result.
// A phase that is not settled maps to outcome-unknown, never to a retry.

export type ProductAgentError =
  | "AGENT_ALREADY_RUNNING"
  | "AGENT_NOT_READY"
  | "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"
  | "AGENT_ASSIGNMENT_FAILED"
  | "AGENT_CANCEL_RACED_COMPLETION"
  | "AGENT_DELIVERY_FAILED"
  | "AGENT_REJOIN_UNAVAILABLE"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_RUNNING"
  | "TASK_STATE_UNAVAILABLE";

// The error for a cancellation whose summary has been persisted; null means
// the assignment was cancelled.
export function cancelReceiptFailure(
  receipt: CancelReceipt,
): ProductAgentError | null {
  if (receipt.assignmentRetention !== "durable") {
    return "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN";
  }
  if (receipt.assignment.phase === "cancelled") return null;
  if (receipt.assignment.phase === "completed") {
    return "AGENT_CANCEL_RACED_COMPLETION";
  }
  if (receipt.assignment.phase === "failed") {
    return "AGENT_ASSIGNMENT_FAILED";
  }
  return "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN";
}

// The error for a run that returned a receipt which is no longer running;
// null means the result may be acknowledged.
export function settledReceiptFailure(
  receipt: Pick<RunReceipt, "assignment" | "resultRef">,
): ProductAgentError | null {
  if (receipt.assignment.phase === "outcome_unknown") {
    return "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN";
  }
  if (receipt.assignment.phase === "failed" || !receipt.resultRef) {
    return "AGENT_ASSIGNMENT_FAILED";
  }
  return null;
}

export function runRefusalFailure(
  admission: "new" | "rejoin",
): ProductAgentError {
  return admission === "rejoin"
    ? "AGENT_REJOIN_UNAVAILABLE"
    : "AGENT_ASSIGNMENT_FAILED";
}

export function acknowledgementCommand(
  assignment: Assignment,
  resultRef: string,
) {
  return {
    correlation: {
      ...assignment.identity,
      authorityId: assignment.authority.authorityId,
      participantId: assignment.authority.participantId,
      role: assignment.authority.role,
      parentThreadId: assignment.parentThreadId!,
      childId: assignment.childId!,
      parentTurnId: assignment.parentTurnId!,
      childTurnId: assignment.childTurnId!,
      hostRole: assignment.hostRole,
      delegationDigest: assignment.delegationDigest!,
    },
    parentParticipantId: assignment.authority.parentParticipantId,
    resultRef,
  };
}
