import {
  failure,
  success,
  type Result,
} from "../../../pkg/kernel/domain/result";

export type AssignmentErrorCode =
  | "AGENT_CORRELATION"
  | "AGENT_FOCUS_DENIED"
  | "AGENT_AUTHORITY_CORRELATION"
  | "AGENT_AUTHORITY_DENIED"
  | "AGENT_AUTHORITY_UNAVAILABLE"
  | "AGENT_ALREADY_STARTED"
  | "AGENT_TERMINAL"
  | "AGENT_ADMISSION_FAILED"
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
  hostRole: string | null;
}>;

export type AssignmentTerminalReason = Readonly<{
  code: string;
  source: "native-host" | "native-host-transport" | "recovery";
  retry: "never";
}>;

export type Assignment = Readonly<{
  identity: AssignmentIdentity;
  authority: AssignmentAuthority;
  phase: "prepared" | "running" | "completed" | "failed" | "outcome_unknown";
  parentThreadId: string | null;
  childId: string | null;
  hostRole: string | null;
  terminal: boolean;
  terminalReason: AssignmentTerminalReason | null;
}>;

export function createAssignment(
  identity: AssignmentIdentity,
  authority: AssignmentAuthority,
): Assignment {
  return {
    identity: { ...identity },
    authority: { ...authority },
    phase: "prepared",
    parentThreadId: null,
    childId: null,
    hostRole: null,
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
    assignment.hostRole === correlation.hostRole
  );
}

export function startAssignment(
  assignment: Assignment,
  correlation: ChildCorrelation,
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
    assignment.parentThreadId !== null ||
    assignment.childId !== null ||
    assignment.hostRole !== null
  ) {
    return failure("AGENT_ALREADY_STARTED");
  }
  return success({
    ...assignment,
    phase: "running",
    parentThreadId: correlation.parentThreadId,
    childId: correlation.childId,
    hostRole: correlation.hostRole,
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
  if (assignment.phase !== "prepared" || assignment.childId !== null) {
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
  phase: "failed" | "outcome_unknown",
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
