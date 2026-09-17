import { describe, expect, it, vi } from "vitest";

import type { AgentHost } from "../../src/modules/agent/app/port/agent-host";
import { CancelAgentAssignment } from "../../src/modules/agent/app/service/cancel-agent-assignment";
import {
  createAssignment,
  startAssignment,
  type ChildCorrelation,
} from "../../src/modules/agent/domain/assignment";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";

const identity = {
  assignmentId: "assignment-cancel-a",
  ownerId: "owner-cancel-a",
  sessionId: "session-cancel-a",
  taskId: "task-cancel-a",
  taskEpoch: 3,
  generation: 1,
} as const;

const correlation: ChildCorrelation = {
  ...identity,
  authorityId: "authority-cancel-a",
  participantId: "agent-cancel-a",
  role: "agent",
  parentThreadId: "parent-cancel-a",
  childId: "child-cancel-a",
  hostRole: "default",
  delegationDigest: "a".repeat(64),
};

async function runningRepository(): Promise<InMemoryAssignments> {
  const repository = new InMemoryAssignments();
  const running = startAssignment(
    createAssignment(identity, {
      authorityId: correlation.authorityId,
      participantId: correlation.participantId,
      parentParticipantId: "main-cancel-a",
      role: correlation.role,
      mutationOwnership: "none",
    }),
    correlation,
  );
  if (!running.ok) throw new Error(running.error.code);
  await repository.admit({
    assignment: running.value,
    resultRef: null,
    parentDelivery: "not_applicable",
    workspaceEnforcement: "not_applicable",
  });
  return repository;
}

function host(
  receipt: Awaited<ReturnType<AgentHost["cancel"]>>,
): AgentHost & { cancel: ReturnType<typeof vi.fn> } {
  return {
    spawn: vi.fn(async () => {
      throw new Error("unexpected spawn");
    }),
    wait: vi.fn(async () => {
      throw new Error("unexpected wait");
    }),
    cancel: vi.fn(async () => receipt),
  };
}

describe("Agent cancellation", () => {
  it("durably tombstones an exactly acknowledged child interruption", async () => {
    const repository = await runningRepository();
    const native = host({ status: "cancelled", correlation });

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "cancelled",
          terminal: true,
          terminalReason: { code: "AGENT_CANCELLED", retry: "never" },
        },
        assignmentRetention: "durable",
      },
    });
    await expect(repository.load(identity)).resolves.toMatchObject({
      assignment: { phase: "cancelled", terminal: true },
    });
    expect(native.cancel).toHaveBeenCalledExactlyOnceWith(correlation);
  });

  it("preserves an unconfirmed interruption as outcome unknown", async () => {
    const repository = await runningRepository();
    const native = host({
      status: "outcome_unknown",
      correlation,
      code: "AGENT_WAIT_ACK_LOST",
    });

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "outcome_unknown", terminal: true },
        assignmentRetention: "durable",
      },
    });
  });

  it("retains a raced completion instead of rewriting it as cancellation", async () => {
    const repository = await runningRepository();
    const native = host({
      status: "completed",
      correlation,
      resultRef: "codex-app-server://thread/child-cancel-a/turn/turn-a",
      workspaceEnforcement: "verified",
    });

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed", terminal: true },
        resultRef: "codex-app-server://thread/child-cancel-a/turn/turn-a",
        parentDelivery: "pending",
        assignmentRetention: "durable",
      },
    });
  });
});
