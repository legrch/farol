import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import type {
  AssignmentRepository,
  StoredAssignment,
} from "../port/assignment-repository";
import type {
  AssignmentErrorCode,
  ChildCorrelation,
} from "../../domain/assignment";

export type AgentResultDeliveryAcknowledgement = Readonly<{
  correlation: ChildCorrelation;
  parentParticipantId: string;
  resultRef: string;
}>;

function matchesIdentity(
  record: StoredAssignment,
  command: AgentResultDeliveryAcknowledgement,
): boolean {
  const assignment = record.assignment;
  const identity = assignment.identity;
  const correlation = command.correlation;
  return (
    identity.assignmentId === correlation.assignmentId &&
    identity.ownerId === correlation.ownerId &&
    identity.sessionId === correlation.sessionId &&
    identity.taskId === correlation.taskId &&
    identity.taskEpoch === correlation.taskEpoch &&
    identity.generation === correlation.generation &&
    assignment.authority.authorityId === correlation.authorityId &&
    assignment.authority.participantId === correlation.participantId &&
    assignment.authority.role === correlation.role &&
    assignment.authority.parentParticipantId === command.parentParticipantId &&
    assignment.parentThreadId === correlation.parentThreadId &&
    assignment.childId === correlation.childId &&
    assignment.hostRole === correlation.hostRole
  );
}

function isExactRetainedResult(
  record: StoredAssignment,
  command: AgentResultDeliveryAcknowledgement,
): boolean {
  return (
    matchesIdentity(record, command) &&
    record.assignment.phase === "completed" &&
    record.assignment.terminal &&
    record.resultRef === command.resultRef &&
    (record.parentDelivery === "pending" ||
      record.parentDelivery === "acknowledged")
  );
}

export class AcknowledgeAgentResult {
  constructor(private readonly assignments: AssignmentRepository) {}

  async execute(
    command: AgentResultDeliveryAcknowledgement,
  ): Promise<Result<StoredAssignment, AssignmentErrorCode>> {
    let record: StoredAssignment | null;
    try {
      record = await this.assignments.load(command.correlation);
    } catch {
      return failure("AGENT_DELIVERY_UNAVAILABLE");
    }
    if (!record || !isExactRetainedResult(record, command)) {
      return failure("AGENT_DELIVERY_CORRELATION");
    }
    if (record.parentDelivery === "acknowledged") return success(record);

    const acknowledged: StoredAssignment = {
      ...record,
      parentDelivery: "acknowledged",
    };
    try {
      await this.assignments.save(acknowledged);
    } catch {
      return failure("AGENT_DELIVERY_UNAVAILABLE");
    }
    return success(acknowledged);
  }
}
