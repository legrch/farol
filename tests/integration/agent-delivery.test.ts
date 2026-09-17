import { describe, expect, it } from "vitest";
import type { AssignmentRepository } from "../../src/modules/agent/app/port/assignment-repository";
import {
  AcknowledgeAgentResult,
  type AgentResultDeliveryAcknowledgement,
} from "../../src/modules/agent/app/service/acknowledge-agent-result";
import {
  completeAssignment,
  createAssignment,
  startAssignment,
  type AssignmentAuthority,
  type AssignmentIdentity,
  type ChildCorrelation,
} from "../../src/modules/agent/domain/assignment";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";

const identity: AssignmentIdentity = {
  assignmentId: "assignment-delivery-a",
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 3,
  generation: 2,
};

const authority: AssignmentAuthority = {
  authorityId: "authority-task-a",
  participantId: "agent-a",
  parentParticipantId: "main-a",
  role: "agent",
  mutationOwnership: "task",
};

const child: ChildCorrelation = {
  ...identity,
  authorityId: authority.authorityId,
  participantId: authority.participantId,
  role: authority.role,
  parentThreadId: "parent-thread-a",
  childId: "child-a",
  parentTurnId: "parent-turn-a",
  childTurnId: "child-turn-a",
  hostRole: "agent",
  delegationDigest: "a".repeat(64),
};

const acknowledgement: AgentResultDeliveryAcknowledgement = {
  correlation: child,
  parentParticipantId: authority.parentParticipantId,
  resultRef: "result-a",
};

function retainedResult() {
  const started = startAssignment(createAssignment(identity, authority), child);
  if (!started.ok) throw new Error(started.error.code);
  const completed = completeAssignment(started.value, child);
  if (!completed.ok) throw new Error(completed.error.code);
  return {
    assignment: completed.value,
    resultRef: acknowledgement.resultRef,
    parentDelivery: "pending" as const,
  };
}

describe("Agent result delivery acknowledgement", () => {
  it("acknowledges one exact retained result and stays idempotent", async () => {
    const repository = new InMemoryAssignments();
    await repository.admit(retainedResult());
    const service = new AcknowledgeAgentResult(repository);

    await expect(service.execute(acknowledgement)).resolves.toMatchObject({
      ok: true,
      value: { resultRef: "result-a", parentDelivery: "acknowledged" },
    });
    await expect(service.execute(acknowledgement)).resolves.toMatchObject({
      ok: true,
      value: { resultRef: "result-a", parentDelivery: "acknowledged" },
    });
  });

  it("rejects foreign parent, child and result correlations without acknowledgement", async () => {
    for (const foreign of [
      { ...acknowledgement, parentParticipantId: "foreign-parent" },
      {
        ...acknowledgement,
        correlation: { ...child, childId: "foreign-child" },
      },
      {
        ...acknowledgement,
        correlation: { ...child, delegationDigest: "b".repeat(64) },
      },
      { ...acknowledgement, resultRef: "foreign-result" },
    ]) {
      const repository = new InMemoryAssignments();
      await repository.admit(retainedResult());
      await expect(
        new AcknowledgeAgentResult(repository).execute(foreign),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "AGENT_DELIVERY_CORRELATION", retry: "never" },
      });
      await expect(repository.load(identity)).resolves.toMatchObject({
        parentDelivery: "pending",
      });
    }
  });

  it("reports unavailable persistence without claiming acknowledgement", async () => {
    const retained = retainedResult();
    const saveUnavailable: AssignmentRepository = {
      admit: async () => ({ status: "existing", record: retained }),
      load: async () => retained,
      save: async () => {
        throw new Error("PERSISTENCE_UNAVAILABLE");
      },
    };

    await expect(
      new AcknowledgeAgentResult(saveUnavailable).execute(acknowledgement),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_DELIVERY_UNAVAILABLE", retry: "never" },
    });

    const loadUnavailable: AssignmentRepository = {
      admit: async () => ({ status: "existing", record: retained }),
      load: async () => {
        throw new Error("PERSISTENCE_UNAVAILABLE");
      },
      save: async () => undefined,
    };
    await expect(
      new AcknowledgeAgentResult(loadUnavailable).execute(acknowledgement),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_DELIVERY_UNAVAILABLE", retry: "never" },
    });
  });
});
