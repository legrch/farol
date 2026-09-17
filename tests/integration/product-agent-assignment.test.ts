import { describe, expect, it, vi } from "vitest";

import type {
  AgentHost,
  AgentSpawnRequest,
} from "../../src/modules/agent/app/port/agent-host";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";
import {
  runProductAgentAssignment,
  type ProductAgentAssignmentDependencies,
} from "../../src/apps/desktop/product-agent-assignment";
import type { ProductAgentInput } from "../../src/apps/desktop/product-agent-store";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { ProductTaskSchema } from "../../src/modules/chat/contract/product-task";

const workspaceId = "00000000-0000-4000-8000-000000000001";

function readiness() {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown" as const,
    verified: null,
    needsAction: "Complete this step.",
    unavailable: null,
    outcomeUnknown: false,
  };
}

function settings(generation = 7) {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000010",
      generation,
      name: "This Mac",
      workspaces: [
        {
          workspaceId,
          root: "/workspace/approved",
          label: "Approved",
          access: "read",
          excludedPaths: ["/workspace/approved/private"],
        },
      ],
    },
    nativeHosts: { generation: 1, codex: null },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: readiness(),
      computer: readiness(),
      connect: readiness(),
      hosts: readiness(),
      verify: readiness(),
    },
  });
}

const task = ProductTaskSchema.parse({
  taskId: "task-a",
  sessionId: "session-a",
  turnId: "turn-a",
  label: "Owner task",
  provider: "chatgpt",
  requestedModel: "Account default",
  observedModel: null,
  requestedMode: "Account default",
  observedMode: null,
  hasComputer: false,
  pinned: false,
  lifecycle: "idle",
});

function input(overrides: Partial<ProductAgentInput> = {}): ProductAgentInput {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    assignmentId: "assignment-a",
    authorityId: "authority-a",
    parentParticipantId: "main-a",
    agentParticipantId: "agent-a",
    taskEpoch: 7,
    generation: 1,
    workspaceId,
    focusPath: "/workspace/approved",
    objective: "Find and summarize the continuity marker.",
    computerGeneration: 7,
    executableSha256: "a".repeat(64),
    schemaSha256: "b".repeat(64),
    buildId: "build-a",
    expiresAt: 10_000,
    createdAt: "1970-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function dependencies() {
  const spawn = vi.fn(async (request: AgentSpawnRequest) => ({
    status: "started" as const,
    correlation: {
      ...request.identity,
      authorityId: request.authority.authorityId,
      participantId: request.authority.participantId,
      role: request.authority.role,
      parentThreadId: "parent-a",
      childId: "child-a",
      hostRole: "default",
      delegationDigest: "a".repeat(64),
    },
  }));
  const host: AgentHost = {
    spawn,
    wait: vi.fn(async (correlation) => ({
      status: "completed" as const,
      correlation,
      resultRef: "codex-app-server://thread/child-a/turn/turn-a",
      workspaceEnforcement: "verified" as const,
    })),
  };
  return {
    value: {
      host,
      assignments: new InMemoryAssignments(),
      now: () => 1_000,
    } satisfies ProductAgentAssignmentDependencies,
    spawn,
  };
}

describe("product Agent assignment composition", () => {
  it("admits the live task with full selected subtree authority and product objective", async () => {
    const fixture = dependencies();

    await expect(
      runProductAgentAssignment(settings(), task, input(), fixture.value),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed", childId: "child-a" },
        parentDelivery: "pending",
        workspaceEnforcement: "verified",
        resultRetention: "durable",
      },
    });
    const request = fixture.spawn.mock.calls[0]?.[0] as AgentSpawnRequest;
    expect(request.intent).toEqual({
      kind: "product",
      objective: input().objective,
    });
    expect(request.focus.initialPaths).toEqual(["/workspace/approved"]);
    expect(request.authority).toMatchObject({
      ownerId: "owner-desktop",
      sessionId: task.sessionId,
      taskId: task.taskId,
      taskEpoch: 7,
      role: "agent",
      mutationOwnership: "none",
      workspaces: [
        {
          workspaceId,
          mode: "subtree",
          root: "/workspace/approved",
          access: "read",
        },
      ],
      excludedPaths: [{ workspaceId, path: "/workspace/approved/private" }],
      capabilities: ["workspace.list", "workspace.read", "workspace.search"],
      network: "none",
      commands: "none",
    });
  });

  it("refuses removed, changed-generation, or foreign task input before spawn", async () => {
    for (const [configured, journal] of [
      [settings(8), input()],
      [settings(), input({ taskId: "foreign-task" })],
      [settings(), input({ focusPath: "/workspace/foreign" })],
    ] as const) {
      const fixture = dependencies();
      await expect(
        runProductAgentAssignment(configured, task, journal, fixture.value),
      ).resolves.toEqual({
        ok: false,
        error: { code: "AGENT_AUTHORITY_DENIED", retry: "never" },
      });
      expect(fixture.spawn).not.toHaveBeenCalled();
    }
  });
});
