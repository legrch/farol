import {
  failure,
  success,
  type Result,
} from "../../../pkg/kernel/domain/result";

export type AssignmentErrorCode =
  | "AGENT_CORRELATION"
  | "AGENT_ASSIGNMENT_CONFLICT"
  | "AGENT_ASSIGNMENT_INVALID"
  | "AGENT_FOCUS_DENIED"
  | "AGENT_AUTHORITY_CORRELATION"
  | "AGENT_AUTHORITY_DENIED"
  | "AGENT_AUTHORITY_UNAVAILABLE"
  | "AGENT_ALREADY_STARTED"
  | "AGENT_TERMINAL"
  | "AGENT_ADMISSION_FAILED"
  | "AGENT_CANCELLATION_UNAVAILABLE"
  | "AGENT_REJOIN_UNAVAILABLE"
  | "AGENT_DELIVERY_CORRELATION"
  | "AGENT_DELIVERY_UNAVAILABLE";

export type AssignmentIdentity = Readonly<{
  assignmentId: string;
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  generation: number;
}>;

export type AssignmentAuthority = Readonly<{
  authorityId: string;
  participantId: string;
  parentParticipantId: string;
  role: "agent" | "critic";
  mutationOwnership: "none" | "task";
}>;

export type ChildCorrelation = Readonly<{
  assignmentId: string;
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  generation: number;
  authorityId: string;
  participantId: string;
  role: "agent" | "critic";
  parentThreadId: string;
  childId: string;
  parentTurnId: string;
  childTurnId: string;
  hostRole: string | null;
  delegationDigest: string;
}>;

export type AssignmentTerminalReason = Readonly<{
  code: string;
  source: "native-host" | "native-host-transport" | "recovery";
  retry: "never";
}>;

export type Assignment = Readonly<{
  identity: AssignmentIdentity;
  authority: AssignmentAuthority;
  commandFingerprint: string | null;
  phase:
    | "prepared"
    | "running"
    | "completed"
    | "cancelled"
    | "failed"
    | "outcome_unknown";
  parentThreadId: string | null;
  childId: string | null;
  parentTurnId: string | null;
  childTurnId: string | null;
  hostRole: string | null;
  delegationDigest: string | null;
  authorityProof: string | null;
  terminal: boolean;
  terminalReason: AssignmentTerminalReason | null;
}>;

export function createAssignment(
  identity: AssignmentIdentity,
  authority: AssignmentAuthority,
  commandFingerprint: string | null = null,
): Assignment {
  return {
    identity: { ...identity },
    authority: { ...authority },
    commandFingerprint,
    phase: "prepared",
    parentThreadId: null,
    childId: null,
    parentTurnId: null,
    childTurnId: null,
    hostRole: null,
    delegationDigest: null,
    authorityProof: null,
    terminal: false,
    terminalReason: null,
  };
}

export function matchesChildCorrelation(
  assignment: Assignment,
  correlation: ChildCorrelation,
): boolean {
  return (
    assignment.identity.assignmentId === correlation.assignmentId &&
    assignment.identity.ownerId === correlation.ownerId &&
    assignment.identity.sessionId === correlation.sessionId &&
    assignment.identity.taskId === correlation.taskId &&
    assignment.identity.taskEpoch === correlation.taskEpoch &&
    assignment.identity.generation === correlation.generation &&
    assignment.authority.authorityId === correlation.authorityId &&
    assignment.authority.participantId === correlation.participantId &&
    assignment.authority.role === correlation.role &&
    assignment.parentThreadId === correlation.parentThreadId &&
    assignment.childId === correlation.childId &&
    assignment.parentTurnId === correlation.parentTurnId &&
    assignment.childTurnId === correlation.childTurnId &&
    assignment.hostRole === correlation.hostRole &&
    assignment.delegationDigest === correlation.delegationDigest
  );
}

// How far a spawn got before it could confirm its child: the parent thread,
// then the parent turn, then the child. Recorded as it happens, so a crash
// mid-spawn leaves an observable lineage instead of only an unknown.
export type SpawnLineage = Readonly<{
  parentThreadId: string;
  parentTurnId: string | null;
  childId: string | null;
}>;

function sameOrUnset(recorded: string | null, observed: string | null) {
  return recorded === null || recorded === observed;
}

export function recordSpawnLineage(
  assignment: Assignment,
  lineage: SpawnLineage,
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (assignment.phase !== "prepared") return failure("AGENT_ALREADY_STARTED");
  if (
    !sameOrUnset(assignment.parentThreadId, lineage.parentThreadId) ||
    (lineage.parentTurnId !== null &&
      !sameOrUnset(assignment.parentTurnId, lineage.parentTurnId)) ||
    (lineage.childId !== null &&
      !sameOrUnset(assignment.childId, lineage.childId)) ||
    (lineage.childId !== null &&
      (lineage.parentTurnId ?? assignment.parentTurnId) === null)
  ) {
    return failure("AGENT_CORRELATION");
  }
  return success({
    ...assignment,
    parentThreadId: lineage.parentThreadId,
    parentTurnId: lineage.parentTurnId ?? assignment.parentTurnId,
    childId: lineage.childId ?? assignment.childId,
  });
}

export function startAssignment(
  assignment: Assignment,
  correlation: ChildCorrelation,
  authorityProof: string | null = null,
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (
    assignment.identity.assignmentId !== correlation.assignmentId ||
    assignment.identity.ownerId !== correlation.ownerId ||
    assignment.identity.sessionId !== correlation.sessionId ||
    assignment.identity.taskId !== correlation.taskId ||
    assignment.identity.taskEpoch !== correlation.taskEpoch ||
    assignment.identity.generation !== correlation.generation ||
    assignment.authority.authorityId !== correlation.authorityId ||
    assignment.authority.participantId !== correlation.participantId ||
    assignment.authority.role !== correlation.role
  ) {
    return failure("AGENT_CORRELATION");
  }
  if (
    assignment.phase !== "prepared" ||
    !sameOrUnset(assignment.parentThreadId, correlation.parentThreadId) ||
    !sameOrUnset(assignment.childId, correlation.childId) ||
    !sameOrUnset(assignment.parentTurnId, correlation.parentTurnId) ||
    assignment.childTurnId !== null ||
    assignment.hostRole !== null ||
    assignment.delegationDigest !== null
  ) {
    return failure("AGENT_ALREADY_STARTED");
  }
  return success({
    ...assignment,
    phase: "running",
    parentThreadId: correlation.parentThreadId,
    childId: correlation.childId,
    parentTurnId: correlation.parentTurnId,
    childTurnId: correlation.childTurnId,
    hostRole: correlation.hostRole,
    delegationDigest: correlation.delegationDigest,
    authorityProof,
  });
}

export function completeAssignment(
  assignment: Assignment,
  correlation: ChildCorrelation,
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (
    assignment.phase !== "running" ||
    !matchesChildCorrelation(assignment, correlation)
  ) {
    return failure("AGENT_CORRELATION");
  }
  return success({ ...assignment, phase: "completed", terminal: true });
}

export function failPreparedAssignment(
  assignment: Assignment,
  terminalReason: AssignmentTerminalReason = {
    code: "AGENT_SPAWN_REJECTED",
    source: "native-host",
    retry: "never",
  },
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (assignment.phase !== "prepared" || assignment.childId !== null) {
    return failure("AGENT_ALREADY_STARTED");
  }
  return success({
    ...assignment,
    phase: "failed",
    terminal: true,
    terminalReason,
  });
}

export function markSpawnOutcomeUnknown(
  assignment: Assignment,
  terminalReason: AssignmentTerminalReason = {
    code: "AGENT_SPAWN_ACK_LOST",
    source: "native-host-transport",
    retry: "never",
  },
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  // A prepared assignment may already carry the lineage its spawn recorded;
  // it stays with the unknown outcome so the child can still be observed.
  if (assignment.phase !== "prepared") {
    return failure("AGENT_ALREADY_STARTED");
  }
  return success({
    ...assignment,
    phase: "outcome_unknown",
    terminal: true,
    terminalReason,
  });
}

function finishChild(
  assignment: Assignment,
  correlation: ChildCorrelation,
  phase: "cancelled" | "failed" | "outcome_unknown",
  terminalReason: AssignmentTerminalReason,
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (
    assignment.phase !== "running" ||
    !matchesChildCorrelation(assignment, correlation)
  ) {
    return failure("AGENT_CORRELATION");
  }
  return success({ ...assignment, phase, terminal: true, terminalReason });
}

export function failChildAssignment(
  assignment: Assignment,
  correlation: ChildCorrelation,
  terminalReason: AssignmentTerminalReason = {
    code: "AGENT_CHILD_FAILED",
    source: "native-host",
    retry: "never",
  },
): Result<Assignment, AssignmentErrorCode> {
  return finishChild(assignment, correlation, "failed", terminalReason);
}

export function cancelChildAssignment(
  assignment: Assignment,
  correlation: ChildCorrelation,
  terminalReason: AssignmentTerminalReason = {
    code: "AGENT_CANCELLED",
    source: "native-host",
    retry: "never",
  },
): Result<Assignment, AssignmentErrorCode> {
  return finishChild(assignment, correlation, "cancelled", terminalReason);
}

export function markChildOutcomeUnknown(
  assignment: Assignment,
  correlation: ChildCorrelation,
  terminalReason: AssignmentTerminalReason = {
    code: "AGENT_WAIT_ACK_LOST",
    source: "native-host-transport",
    retry: "never",
  },
): Result<Assignment, AssignmentErrorCode> {
  return finishChild(
    assignment,
    correlation,
    "outcome_unknown",
    terminalReason,
  );
}
