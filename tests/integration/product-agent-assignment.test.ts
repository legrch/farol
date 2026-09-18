import { describe, expect, it, vi } from "vitest";

import type {
  AgentHost,
  AgentSpawnRequest,
} from "../../src/modules/agent/app/port/agent-host";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcknowledgeAgentResult } from "../../src/modules/agent/app/service/acknowledge-agent-result";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";
import { PrivateAssignmentStore } from "../../src/modules/agent/infra/repo/private-assignment-store";
import {
  runProductAgentAssignment,
  type ProductAgentAssignmentDependencies,
} from "../../src/apps/desktop/product-agent-assignment";
import { productAgentApproval } from "../../src/apps/desktop/product-agent-approval";
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

function settings(
  generation = 7,
  commands: "none" | "verification" = "none",
  access: "read" | "write" = "read",
) {
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
      commands,
      workspaces: [
        {
          workspaceId,
          root: "/workspace/approved",
          label: "Approved",
          access,
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
    scope: { mode: "subtree", root: "/workspace/approved" },
    excludedPaths: [],
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
      parentTurnId: "parent-turn-a",
      childTurnId: "child-turn-a",
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
    cancel: vi.fn(async () => {
      throw new Error("unexpected cancel");
    }),
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

  it("C05-09 delegates a write-approved workspace to the read-only Agent as an enforced read projection", async () => {
    const fixture = dependencies();

    await expect(
      runProductAgentAssignment(
        settings(7, "verification", "write"),
        task,
        input(),
        fixture.value,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { assignment: { phase: "completed", childId: "child-a" } },
    });
    const request = fixture.spawn.mock.calls[0]?.[0] as AgentSpawnRequest;
    // The whole approved subtree stays delegated: the grant is not narrowed
    // to the files the Agent happens to open first.
    expect(request.focus.initialPaths).toEqual(["/workspace/approved"]);
    expect(request.authority).toEqual(
      expect.objectContaining({
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
        capabilities: [
          "workspace.list",
          "workspace.read",
          "workspace.search",
          "verification.run",
        ],
        network: "none",
        commands: "verification",
      }),
    );
  });

  it("C05-09 projects every approved workspace as read and never carries write or network", () => {
    const configured = settings(7, "verification", "write");

    expect(
      productAgentApproval(configured.computer, {
        ownerId: "owner-desktop",
        capabilities: ["workspace.read", "workspace.write"],
        commands: "verification",
        expiresAt: 10_000,
      }),
    ).toEqual({
      ownerId: "owner-desktop",
      computerId: configured.computer.computerId,
      generation: 7,
      workspaces: [
        { workspaceId, root: "/workspace/approved", access: "read" },
      ],
      excludedPaths: [{ workspaceId, path: "/workspace/approved/private" }],
      capabilities: ["workspace.read"],
      network: "none",
      commands: "verification",
      expiresAt: 10_000,
    });
  });

  it("AUTH-10 keeps each approved folder's identity in the Agent projection", () => {
    const configured = ProductSettingsSchema.parse({
      ...settings(),
      computer: {
        ...settings().computer,
        workspaces: settings().computer.workspaces.map((workspace) => ({
          ...workspace,
          rootIdentity: { device: "7", inode: "11" },
        })),
      },
    });

    expect(
      productAgentApproval(configured.computer, {
        ownerId: "owner-desktop",
        capabilities: ["workspace.read"],
        commands: "none",
        expiresAt: 10_000,
      }).workspaces,
    ).toEqual([
      {
        workspaceId,
        root: "/workspace/approved",
        access: "read",
        rootIdentity: { device: "7", inode: "11" },
      },
    ]);
  });

  it("preserves owner-approved fixed verification authority for the product Agent", async () => {
    const fixture = dependencies();

    await expect(
      runProductAgentAssignment(
        settings(7, "verification"),
        task,
        input(),
        fixture.value,
      ),
    ).resolves.toMatchObject({ ok: true });
    const request = fixture.spawn.mock.calls[0]?.[0] as AgentSpawnRequest;
    expect(request.authority).toMatchObject({
      capabilities: [
        "workspace.list",
        "workspace.read",
        "workspace.search",
        "verification.run",
      ],
      commands: "verification",
    });
  });

  it("limits exact-file narrowing to non-recursive file reads and searches", async () => {
    const fixture = dependencies();
    const narrowed = input({
      scope: {
        mode: "exact",
        root: "/workspace/approved",
        paths: [
          "/workspace/approved/README.md",
          "/workspace/approved/docs/plan.md",
        ],
      },
    });

    await expect(
      runProductAgentAssignment(
        settings(7, "verification"),
        task,
        narrowed,
        fixture.value,
      ),
    ).resolves.toMatchObject({ ok: true });
    if (narrowed.scope.mode !== "exact") throw new Error("TEST_SCOPE_INVALID");
    const request = fixture.spawn.mock.calls[0]?.[0] as AgentSpawnRequest;
    expect(request.focus.initialPaths).toEqual(narrowed.scope.paths);
    expect(request.authority).toMatchObject({
      workspaces: [
        {
          workspaceId,
          mode: "exact",
          root: "/workspace/approved",
          paths: narrowed.scope.paths,
          access: "read",
        },
      ],
      capabilities: ["workspace.read", "workspace.search"],
      network: "none",
      commands: "none",
    });
  });

  it("preserves an explicit owner exclusion while narrowing to one subtree", async () => {
    const fixture = dependencies();

    await expect(
      runProductAgentAssignment(
        settings(),
        task,
        input({
          scope: { mode: "subtree", root: "/workspace/approved/docs" },
          excludedPaths: ["/workspace/approved/docs/private"],
        }),
        fixture.value,
      ),
    ).resolves.toMatchObject({ ok: true });
    const request = fixture.spawn.mock.calls[0]?.[0] as AgentSpawnRequest;
    expect(request.focus.initialPaths).toEqual(["/workspace/approved/docs"]);
    expect(request.authority).toMatchObject({
      workspaces: [
        {
          workspaceId,
          mode: "subtree",
          root: "/workspace/approved/docs",
          access: "read",
        },
      ],
      excludedPaths: [
        { workspaceId, path: "/workspace/approved/docs/private" },
      ],
    });
  });

  it("refuses removed, changed-generation, or foreign task input before spawn", async () => {
    for (const [configured, journal] of [
      [settings(8), input()],
      [settings(), input({ taskId: "foreign-task" })],
      [
        settings(),
        input({ scope: { mode: "subtree", root: "/workspace/foreign" } }),
      ],
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

describe("LIF-02 start then immediate rejoin", () => {
  it("joins the in-flight execution instead of admitting a second child", async () => {
    const fixture = dependencies();
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const wait = vi.fn(async (correlation) => {
      await waitGate;
      return {
        status: "completed" as const,
        correlation,
        resultRef: "codex-app-server://thread/child-a/turn/turn-a",
        workspaceEnforcement: "verified" as const,
      };
    });
    const host: AgentHost = { ...fixture.value.host, wait };
    const deps = { ...fixture.value, host };

    const started = runProductAgentAssignment(settings(), task, input(), deps);
    // The start has not settled when the owner asks to rejoin.
    await new Promise((resolve) => setImmediate(resolve));
    const rejoined = runProductAgentAssignment(
      settings(),
      task,
      input(),
      deps,
      "rejoin",
    );
    // Let the rejoin reach its admission decision while the child is still
    // being waited for.
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    releaseWait();

    const [first, second] = await Promise.all([started, rejoined]);
    expect(first).toMatchObject({
      ok: true,
      value: { assignment: { phase: "completed", childId: "child-a" } },
    });
    expect(second).toEqual(first);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});

describe("LIF-10 a retained result reaches the parent after restart", () => {
  it("redelivers the stored result once through rejoin without a new assignment", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-agent-restart-"),
    );
    try {
      const fixture = dependencies();
      const first = await runProductAgentAssignment(settings(), task, input(), {
        ...fixture.value,
        assignments: new PrivateAssignmentStore({ root }),
      });
      expect(first).toMatchObject({
        ok: true,
        value: {
          assignment: { phase: "completed" },
          parentDelivery: "pending",
          resultRetention: "durable",
        },
      });
      if (!first.ok || !first.value.resultRef)
        throw new Error("RESULT_MISSING");

      // A new process: nothing may be spawned or waited for again.
      const restartedHost: AgentHost = {
        spawn: vi.fn(async () => {
          throw new Error("must not spawn");
        }),
        wait: vi.fn(async () => {
          throw new Error("must not wait");
        }),
        cancel: vi.fn(async () => {
          throw new Error("must not cancel");
        }),
      };
      const restarted = {
        host: restartedHost,
        assignments: new PrivateAssignmentStore({ root }),
        now: () => 1_000,
      };
      const redelivered = await runProductAgentAssignment(
        settings(),
        task,
        input(),
        restarted,
        "rejoin",
      );
      expect(redelivered).toMatchObject({
        ok: true,
        value: {
          assignment: { phase: "completed", childId: "child-a" },
          resultRef: first.value.resultRef,
          parentDelivery: "pending",
        },
      });
      if (!redelivered.ok) throw new Error("REDELIVERY_FAILED");

      const assignment = redelivered.value.assignment;
      await expect(
        new AcknowledgeAgentResult(restarted.assignments).execute({
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
          resultRef: first.value.resultRef,
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: { parentDelivery: "acknowledged" },
      });
      await expect(
        runProductAgentAssignment(
          settings(),
          task,
          input(),
          restarted,
          "rejoin",
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { parentDelivery: "acknowledged" },
      });
      expect(fixture.spawn).toHaveBeenCalledTimes(1);
      expect(restartedHost.spawn).not.toHaveBeenCalled();
      expect(restartedHost.wait).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
