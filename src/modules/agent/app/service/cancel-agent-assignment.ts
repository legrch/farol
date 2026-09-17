import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import type { AgentHost } from "../port/agent-host";
import type {
  AssignmentRepository,
  StoredAssignment,
} from "../port/assignment-repository";
import {
  cancelChildAssignment,
  completeAssignment,
  failChildAssignment,
  markChildOutcomeUnknown,
  markSpawnOutcomeUnknown,
  type Assignment,
  type AssignmentErrorCode,
  type AssignmentIdentity,
  type ChildCorrelation,
} from "../../domain/assignment";

export type AgentCancellationReceipt = StoredAssignment &
  Readonly<{ assignmentRetention: "durable" | "memory_only" }>;

export type AgentCancellationResult = Result<
  AgentCancellationReceipt,
  AssignmentErrorCode
>;

function correlation(assignment: Assignment): ChildCorrelation | null {
  if (
    assignment.phase !== "running" ||
    assignment.terminal ||
    !assignment.parentThreadId ||
    !assignment.childId ||
    !assignment.delegationDigest
  ) {
    return null;
  }
  return {
    ...assignment.identity,
    authorityId: assignment.authority.authorityId,
    participantId: assignment.authority.participantId,
    role: assignment.authority.role,
    parentThreadId: assignment.parentThreadId,
    childId: assignment.childId,
    hostRole: assignment.hostRole,
    delegationDigest: assignment.delegationDigest,
  };
}

function record(
  assignment: Assignment,
  result: Readonly<{
    resultRef?: string;
    workspaceEnforcement?: "verified";
  }> = {},
): StoredAssignment {
  return {
    assignment,
    resultRef: result.resultRef ?? null,
    parentDelivery:
      assignment.phase === "completed" ? "pending" : "not_applicable",
    workspaceEnforcement: result.workspaceEnforcement ?? "not_applicable",
  };
}

export class CancelAgentAssignment {
  constructor(
    private readonly host: AgentHost,
    private readonly assignments: AssignmentRepository,
  ) {}

  async execute(
    identity: AssignmentIdentity,
  ): Promise<AgentCancellationResult> {
    let stored: StoredAssignment | null;
    try {
      stored = await this.assignments.load(identity);
    } catch {
      return failure("AGENT_CANCELLATION_UNAVAILABLE");
    }
    if (!stored) return failure("AGENT_CANCELLATION_UNAVAILABLE");
    if (stored.assignment.terminal) {
      return success({ ...stored, assignmentRetention: "durable" });
    }

    const exactCorrelation = correlation(stored.assignment);
    if (!exactCorrelation) {
      const uncertain = markSpawnOutcomeUnknown(stored.assignment, {
        code: "AGENT_CANCEL_WITHOUT_CHILD_CORRELATION",
        source: "native-host-transport",
        retry: "never",
      });
      if (!uncertain.ok) return failure(uncertain.error.code);
      return this.persist(record(uncertain.value));
    }

    let cancelled: Awaited<ReturnType<AgentHost["cancel"]>>;
    try {
      cancelled = await this.host.cancel(exactCorrelation);
    } catch {
      cancelled = {
        status: "outcome_unknown",
        correlation: exactCorrelation,
        code: "AGENT_WAIT_ACK_LOST",
      };
    }
    if (
      JSON.stringify(cancelled.correlation) !== JSON.stringify(exactCorrelation)
    ) {
      return failure("AGENT_CORRELATION");
    }

    if (cancelled.status === "completed") {
      const completed = completeAssignment(
        stored.assignment,
        cancelled.correlation,
      );
      if (!completed.ok) return failure(completed.error.code);
      return this.persist(
        record(completed.value, {
          resultRef: cancelled.resultRef,
          workspaceEnforcement: cancelled.workspaceEnforcement,
        }),
      );
    }
    if (cancelled.status === "cancelled") {
      const terminal = cancelChildAssignment(
        stored.assignment,
        cancelled.correlation,
      );
      if (!terminal.ok) return failure(terminal.error.code);
      return this.persist(record(terminal.value));
    }
    if (cancelled.status === "failed") {
      const terminal = failChildAssignment(
        stored.assignment,
        cancelled.correlation,
        {
          code: cancelled.code,
          source: "native-host",
          retry: "never",
        },
      );
      if (!terminal.ok) return failure(terminal.error.code);
      return this.persist(record(terminal.value));
    }
    const uncertain = markChildOutcomeUnknown(
      stored.assignment,
      cancelled.correlation,
      {
        code: cancelled.code,
        source: "native-host-transport",
        retry: "never",
      },
    );
    if (!uncertain.ok) return failure(uncertain.error.code);
    return this.persist(record(uncertain.value));
  }

  private async persist(
    value: StoredAssignment,
  ): Promise<AgentCancellationResult> {
    try {
      await this.assignments.save(value);
      return success({ ...value, assignmentRetention: "durable" });
    } catch {
      return success({ ...value, assignmentRetention: "memory_only" });
    }
  }
}
