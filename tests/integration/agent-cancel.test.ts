import { describe, expect, it, vi } from "vitest";

import type { AgentHost } from "../../src/modules/agent/app/port/agent-host";
import type { AssignmentRepository } from "../../src/modules/agent/app/port/assignment-repository";
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
  parentTurnId: "parent-turn-cancel-a",
  childTurnId: "child-turn-cancel-a",
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

function preparedRecord() {
  return {
    assignment: createAssignment(identity, {
      authorityId: correlation.authorityId,
      participantId: correlation.participantId,
      parentParticipantId: "main-cancel-a",
      role: correlation.role,
      mutationOwnership: "none" as const,
    }),
    resultRef: null,
    parentDelivery: "not_applicable" as const,
    workspaceEnforcement: "not_applicable" as const,
  };
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
    const service = new CancelAgentAssignment(native, repository);

    await expect(service.execute(identity)).resolves.toMatchObject({
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
    await expect(service.execute(identity)).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "cancelled", terminal: true },
        assignmentRetention: "durable",
      },
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

  it("fails closed when durable state is missing or unreadable", async () => {
    const native = host({ status: "cancelled", correlation });
    const missing = new InMemoryAssignments();
    const unreadable: AssignmentRepository = {
      admit: vi.fn(async (record) => ({ status: "admitted" as const, record })),
      load: vi.fn(async () => {
        throw new Error("SYNTHETIC_LOAD_FAILURE");
      }),
      save: vi.fn(async () => undefined),
    };

    await expect(
      new CancelAgentAssignment(native, missing).execute(identity),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_CANCELLATION_UNAVAILABLE", retry: "never" },
    });
    await expect(
      new CancelAgentAssignment(native, unreadable).execute(identity),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_CANCELLATION_UNAVAILABLE", retry: "never" },
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("tombstones a prepared assignment as outcome unknown without guessing a child", async () => {
    const repository = new InMemoryAssignments();
    await repository.admit(preparedRecord());
    const native = host({ status: "cancelled", correlation });

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "outcome_unknown",
          terminal: true,
          terminalReason: {
            code: "AGENT_CANCEL_WITHOUT_CHILD_CORRELATION",
            source: "native-host-transport",
            retry: "never",
          },
        },
      },
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("fails closed on an impossible nonterminal durable phase", async () => {
    const repository = new InMemoryAssignments();
    await repository.admit({
      ...preparedRecord(),
      assignment: {
        ...preparedRecord().assignment,
        phase: "completed",
      },
    });

    await expect(
      new CancelAgentAssignment(
        host({ status: "cancelled", correlation }),
        repository,
      ).execute(identity),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_ALREADY_STARTED", retry: "never" },
    });
  });

  it("maps a lost cancel acknowledgement to outcome unknown", async () => {
    const repository = await runningRepository();
    const native: AgentHost = {
      ...host({ status: "cancelled", correlation }),
      cancel: vi.fn(async () => {
        throw new Error("SYNTHETIC_CANCEL_TRANSPORT_FAILURE");
      }),
    };

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "outcome_unknown",
          terminalReason: {
            code: "AGENT_WAIT_ACK_LOST",
            source: "native-host-transport",
          },
        },
      },
    });
  });

  it("refuses a cancellation receipt for a different child", async () => {
    const repository = await runningRepository();

    await expect(
      new CancelAgentAssignment(
        host({
          status: "cancelled",
          correlation: { ...correlation, childId: "foreign-child" },
        }),
        repository,
      ).execute(identity),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_CORRELATION", retry: "never" },
    });
    await expect(repository.load(identity)).resolves.toMatchObject({
      assignment: { phase: "running", terminal: false },
    });
  });

  it("retains an acknowledged child failure with native-host provenance", async () => {
    const repository = await runningRepository();

    await expect(
      new CancelAgentAssignment(
        host({ status: "failed", correlation, code: "AGENT_CHILD_FAILED" }),
        repository,
      ).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "failed",
          terminal: true,
          terminalReason: {
            code: "AGENT_CHILD_FAILED",
            source: "native-host",
            retry: "never",
          },
        },
      },
    });
  });

  it("reports memory-only retention when the terminal tombstone cannot persist", async () => {
    const stable = await runningRepository();
    const unavailable: AssignmentRepository = {
      admit: stable.admit.bind(stable),
      load: stable.load.bind(stable),
      save: vi.fn(async () => {
        throw new Error("SYNTHETIC_SAVE_FAILURE");
      }),
    };

    await expect(
      new CancelAgentAssignment(
        host({ status: "cancelled", correlation }),
        unavailable,
      ).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "cancelled", terminal: true },
        assignmentRetention: "memory_only",
      },
    });
    await expect(stable.load(identity)).resolves.toMatchObject({
      assignment: { phase: "running", terminal: false },
    });
  });
});
