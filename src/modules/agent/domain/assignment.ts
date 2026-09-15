import {
  failure,
  success,
  type Result,
} from "../../../pkg/kernel/domain/result";

export type AssignmentErrorCode =
  | "AGENT_CORRELATION"
  | "AGENT_ALREADY_STARTED"
  | "AGENT_TERMINAL"
  | "AGENT_ADMISSION_FAILED";

export type AssignmentIdentity = Readonly<{
  assignmentId: string;
  ownerId: string;
  generation: number;
}>;

export type ChildCorrelation = Readonly<{
  assignmentId: string;
  ownerId: string;
  generation: number;
  childId: string;
}>;

export type Assignment = Readonly<{
  identity: AssignmentIdentity;
  phase: "prepared" | "running" | "completed" | "failed" | "outcome_unknown";
  childId: string | null;
  terminal: boolean;
}>;

export function createAssignment(identity: AssignmentIdentity): Assignment {
  return {
    identity: { ...identity },
    phase: "prepared",
    childId: null,
    terminal: false,
  };
}

function matches(
  assignment: Assignment,
  correlation: ChildCorrelation,
): boolean {
  return (
    assignment.identity.assignmentId === correlation.assignmentId &&
    assignment.identity.ownerId === correlation.ownerId &&
    assignment.identity.generation === correlation.generation
  );
}

export function startAssignment(
  assignment: Assignment,
  correlation: ChildCorrelation,
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (!matches(assignment, correlation)) return failure("AGENT_CORRELATION");
  if (assignment.phase !== "prepared" || assignment.childId !== null) {
    return failure("AGENT_ALREADY_STARTED");
  }
  return success({
    ...assignment,
    phase: "running",
    childId: correlation.childId,
  });
}

export function completeAssignment(
  assignment: Assignment,
  correlation: ChildCorrelation,
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (
    assignment.phase !== "running" ||
    !matches(assignment, correlation) ||
    assignment.childId !== correlation.childId
  ) {
    return failure("AGENT_CORRELATION");
  }
  return success({ ...assignment, phase: "completed", terminal: true });
}

export function failPreparedAssignment(
  assignment: Assignment,
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (assignment.phase !== "prepared" || assignment.childId !== null) {
    return failure("AGENT_ALREADY_STARTED");
  }
  return success({ ...assignment, phase: "failed", terminal: true });
}

export function markSpawnOutcomeUnknown(
  assignment: Assignment,
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (assignment.phase !== "prepared" || assignment.childId !== null) {
    return failure("AGENT_ALREADY_STARTED");
  }
  return success({ ...assignment, phase: "outcome_unknown", terminal: true });
}

function finishChild(
  assignment: Assignment,
  correlation: ChildCorrelation,
  phase: "failed" | "outcome_unknown",
): Result<Assignment, AssignmentErrorCode> {
  if (assignment.terminal) return failure("AGENT_TERMINAL");
  if (
    assignment.phase !== "running" ||
    !matches(assignment, correlation) ||
    assignment.childId !== correlation.childId
  ) {
    return failure("AGENT_CORRELATION");
  }
  return success({ ...assignment, phase, terminal: true });
}

export function failChildAssignment(
  assignment: Assignment,
  correlation: ChildCorrelation,
): Result<Assignment, AssignmentErrorCode> {
  return finishChild(assignment, correlation, "failed");
}

export function markChildOutcomeUnknown(
  assignment: Assignment,
  correlation: ChildCorrelation,
): Result<Assignment, AssignmentErrorCode> {
  return finishChild(assignment, correlation, "outcome_unknown");
}
