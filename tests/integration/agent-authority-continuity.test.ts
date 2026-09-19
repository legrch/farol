import { describe, expect, it, vi } from "vitest";
import type {
  AgentAuthorityPort,
  DelegatedAgentAuthority,
} from "../../src/modules/agent/app/port/execution-authority";
import type {
  AgentHost,
  AgentSpawnRequest,
} from "../../src/modules/agent/app/port/agent-host";
import {
  RunAgentAssignment,
  type AgentAssignmentCommand,
} from "../../src/modules/agent/app/service/run-agent-assignment";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";
import { Sha256AgentCommandDigester } from "../../src/modules/agent/infra/native/sha256-agent-command-digester";
import { createAssignment } from "../../src/modules/agent/domain/assignment";

const commandDigester = new Sha256AgentCommandDigester();

const command: AgentAssignmentCommand = {
  identity: {
    assignmentId: "assignment-a",
    ownerId: "owner-preview",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 3,
    generation: 4,
  },
  delegation: {
    parentParticipantId: "main-a",
    participantId: "agent-a",
    role: "agent",
    mutationOwnership: "task",
  },
  focus: {
    initialPaths: ["/workspace/farol/vnext/README.md"],
  },
  intent: { kind: "compatibility" },
};

const authority: DelegatedAgentAuthority = {
  authorityId: "authority-task-a",
  participantId: "agent-a",
  parentParticipantId: "main-a",
  role: "agent",
  mutationOwnership: "task",
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 3,
  computerId: "computer-preview",
  computerGeneration: 7,
  workspaces: [
    {
      workspaceId: "farol",
      mode: "subtree",
      root: "/workspace/farol",
      access: "write",
    },
    {
      workspaceId: "brain",
      mode: "subtree",
      root: "/workspace/brain/Work/Farol",
      access: "read",
    },
  ],
  excludedPaths: [],
  capabilities: [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    "verification.run",
    "workspace.write",
  ],
  network: "none",
  commands: "verification",
  expiresAt: 10_000,
};

function authorityPort(
  result:
    | Readonly<{ ok: true; value: DelegatedAgentAuthority }>
    | Readonly<{
        ok: false;
        error: Readonly<{
          code: "AGENT_AUTHORITY_DENIED";
          source: "task-grant";
          retry: "never";
        }>;
      }> = { ok: true, value: authority },
): AgentAuthorityPort & { delegate: ReturnType<typeof vi.fn> } {
  return {
    delegate: vi.fn().mockResolvedValue(result),
  };
}

function host(): AgentHost & { spawn: ReturnType<typeof vi.fn> } {
  return {
    spawn: vi.fn(async (request: AgentSpawnRequest) => ({
      status: "started" as const,
      correlation: {
        ...request.identity,
        authorityId: request.authority.authorityId,
        participantId: request.authority.participantId,
        role: request.authority.role,
        parentThreadId: "parent-thread-a",
        childId: "child-a",
        parentTurnId: "parent-turn-a",
        childTurnId: "child-turn-a",
        hostRole: request.authority.role,
        delegationDigest: "a".repeat(64),
      },
    })),
    wait: vi.fn(async (correlation) => ({
      status: "completed" as const,
      correlation,
      resultRef: "result-a",
      workspaceEnforcement: "verified" as const,
    })),
    cancel: vi.fn(async () => {
      throw new Error("unexpected cancel");
    }),
  };
}

describe("Agent delegated-authority continuity", () => {
  it("DAC-02 gives the host a runtime-derived authority snapshot, not caller-supplied roots", async () => {
    const delegated = authorityPort();
    const nativeHost = host();
    const runner = new RunAgentAssignment(
      nativeHost,
      new InMemoryAssignments(),
      delegated,
      commandDigester,
    );

    await expect(runner.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "completed",
          authority: {
            authorityId: "authority-task-a",
            participantId: "agent-a",
            role: "agent",
          },
        },
      },
    });
    expect(delegated.delegate).toHaveBeenCalledWith({
      identity: command.identity,
      ...command.delegation,
    });
    const spawned = nativeHost.spawn.mock.calls[0]?.[0] as AgentSpawnRequest;
    expect(spawned.authority.workspaces).toEqual(authority.workspaces);
    expect(spawned).not.toHaveProperty("approvalPrompt");
  });

  it("DAC-03 keeps initial files as focus evidence without collapsing workspace authority", async () => {
    const nativeHost = host();
    await new RunAgentAssignment(
      nativeHost,
      new InMemoryAssignments(),
      authorityPort(),
      commandDigester,
    ).execute(command);

    const spawned = nativeHost.spawn.mock.calls[0]?.[0] as AgentSpawnRequest;
    expect(spawned.focus.initialPaths).toEqual([
      "/workspace/farol/vnext/README.md",
    ]);
    expect(spawned.authority.workspaces).toContainEqual({
      workspaceId: "farol",
      mode: "subtree",
      root: "/workspace/farol",
      access: "write",
    });
    expect(spawned.authority.workspaces).toContainEqual({
      workspaceId: "brain",
      mode: "subtree",
      root: "/workspace/brain/Work/Farol",
      access: "read",
    });
  });

  it("refuses a foreign authority snapshot before child spawn", async () => {
    const nativeHost = host();
    const delegated = authorityPort({
      ok: true,
      value: { ...authority, taskId: "foreign-task" },
    });

    await expect(
      new RunAgentAssignment(
        nativeHost,
        new InMemoryAssignments(),
        delegated,
        commandDigester,
      ).execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_AUTHORITY_CORRELATION", retry: "never" },
    });
    expect(nativeHost.spawn).not.toHaveBeenCalled();
  });

  it("DAC-05 preserves a task-grant refusal and never falls back to host spawn", async () => {
    const nativeHost = host();
    const delegated = authorityPort({
      ok: false,
      error: {
        code: "AGENT_AUTHORITY_DENIED",
        source: "task-grant",
        retry: "never",
      },
    });

    await expect(
      new RunAgentAssignment(
        nativeHost,
        new InMemoryAssignments(),
        delegated,
        commandDigester,
      ).execute(command),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_AUTHORITY_DENIED", retry: "never" },
    });
    expect(delegated.delegate).toHaveBeenCalledTimes(1);
    expect(nativeHost.spawn).not.toHaveBeenCalled();
  });

  it("DAC-06 passes explicit narrowing to the authority owner unchanged", async () => {
    const delegated = authorityPort({
      ok: true,
      value: {
        ...authority,
        mutationOwnership: "none",
        workspaces: [
          {
            workspaceId: "farol",
            mode: "exact",
            root: "/workspace/farol",
            paths: ["/workspace/farol/vnext/README.md"],
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        commands: "none",
      },
    });
    const narrowed: AgentAssignmentCommand = {
      ...command,
      delegation: {
        ...command.delegation,
        mutationOwnership: "none",
        narrowing: {
          workspaces: [
            {
              workspaceId: "farol",
              mode: "exact",
              root: "/workspace/farol",
              paths: ["/workspace/farol/vnext/README.md"],
              access: "read",
            },
          ],
          capabilities: ["workspace.read"],
          network: "none",
          commands: "none",
        },
      },
    };

    await new RunAgentAssignment(
      host(),
      new InMemoryAssignments(),
      delegated,
      commandDigester,
    ).execute(narrowed);
    expect(delegated.delegate).toHaveBeenCalledWith({
      identity: narrowed.identity,
      parentParticipantId: "main-a",
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "none",
      narrowing: narrowed.delegation.narrowing,
    });
  });

  describe("an authority broader than the owner's narrowing", () => {
    const exactFile = {
      workspaceId: "farol",
      mode: "exact" as const,
      root: "/workspace/farol",
      paths: ["/workspace/farol/vnext/README.md"],
      access: "read" as const,
    };
    const brainTree = {
      workspaceId: "brain",
      mode: "subtree" as const,
      root: "/workspace/brain/Work/Farol",
      access: "read" as const,
    };
    const narrowing = {
      workspaces: [exactFile, brainTree],
      excludedPaths: [
        { workspaceId: "brain", path: "/workspace/brain/Work/Farol/Private" },
      ],
      capabilities: ["workspace.read" as const],
      network: "none" as const,
      commands: "none" as const,
    };
    const narrowed: AgentAssignmentCommand = {
      ...command,
      focus: { initialPaths: ["/workspace/farol/vnext/README.md"] },
      delegation: {
        ...command.delegation,
        mutationOwnership: "none",
        narrowing,
      },
    };
    // Exactly what the Computer's owner returns for this narrowing.
    const exact: DelegatedAgentAuthority = {
      ...authority,
      mutationOwnership: "none",
      workspaces: narrowing.workspaces,
      excludedPaths: narrowing.excludedPaths,
      capabilities: ["workspace.read"],
      network: "none",
      commands: "none",
    };

    it("spawns under the exact narrowed authority", async () => {
      const nativeHost = host();
      await expect(
        new RunAgentAssignment(
          nativeHost,
          new InMemoryAssignments(),
          authorityPort({ ok: true, value: exact }),
          commandDigester,
        ).execute(narrowed),
      ).resolves.toMatchObject({ ok: true });
      expect(nativeHost.spawn).toHaveBeenCalledTimes(1);
    });

    it.each<[string, Partial<DelegatedAgentAuthority>]>([
      [
        "a whole-workspace subtree for an exact-file scope",
        {
          workspaces: [
            {
              workspaceId: "farol",
              mode: "subtree",
              root: "/workspace/farol",
              access: "read",
            },
            brainTree,
          ],
        },
      ],
      [
        "write access for a read scope",
        {
          workspaces: [{ ...exactFile, access: "write" }, brainTree],
        },
      ],
      [
        "a capability that was not requested",
        { capabilities: ["workspace.read", "workspace.search"] },
      ],
      ["approved network for a no-network request", { network: "approved" }],
      [
        "verification commands for a no-command request",
        { commands: "verification" },
      ],
      ["the owner's exclusion dropped", { excludedPaths: [] }],
    ])("refuses %s before native-host spawn", async (_case, broadened) => {
      const nativeHost = host();
      await expect(
        new RunAgentAssignment(
          nativeHost,
          new InMemoryAssignments(),
          authorityPort({ ok: true, value: { ...exact, ...broadened } }),
          commandDigester,
        ).execute(narrowed),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "AGENT_AUTHORITY_CORRELATION", retry: "never" },
      });
      expect(nativeHost.spawn).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["outside the delegated workspace", "/workspace/private/notes.md"],
    ["with a non-canonical segment", "/workspace/farol/../private.md"],
  ])(
    "refuses focus %s before native-host spawn",
    async (_case, initialPath) => {
      const nativeHost = host();

      await expect(
        new RunAgentAssignment(
          nativeHost,
          new InMemoryAssignments(),
          authorityPort(),
          commandDigester,
        ).execute({
          ...command,
          focus: { initialPaths: [initialPath] },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "AGENT_FOCUS_DENIED", retry: "never" },
      });
      expect(nativeHost.spawn).not.toHaveBeenCalled();
    },
  );

  it("refuses focus outside an exact delegated file scope", async () => {
    const nativeHost = host();
    const exact = authorityPort({
      ok: true,
      value: {
        ...authority,
        workspaces: [
          {
            workspaceId: "farol",
            mode: "exact",
            root: "/workspace/farol",
            paths: ["/workspace/farol/vnext/README.md"],
            access: "read",
          },
        ],
      },
    });

    await expect(
      new RunAgentAssignment(
        nativeHost,
        new InMemoryAssignments(),
        exact,
        commandDigester,
      ).execute({
        ...command,
        focus: { initialPaths: ["/workspace/farol/package.json"] },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_FOCUS_DENIED" },
    });
    expect(nativeHost.spawn).not.toHaveBeenCalled();
  });

  it("refuses focus inside an explicitly excluded delegated subtree", async () => {
    const nativeHost = host();
    const excluded = authorityPort({
      ok: true,
      value: {
        ...authority,
        excludedPaths: [
          { workspaceId: "farol", path: "/workspace/farol/private" },
        ],
      },
    });

    await expect(
      new RunAgentAssignment(
        nativeHost,
        new InMemoryAssignments(),
        excluded,
        commandDigester,
      ).execute({
        ...command,
        focus: { initialPaths: ["/workspace/farol/private/secret.txt"] },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_FOCUS_DENIED" },
    });
    expect(nativeHost.spawn).not.toHaveBeenCalled();
  });

  it("fails before spawn when authority resolution is unavailable", async () => {
    const nativeHost = host();
    const unavailable: AgentAuthorityPort = {
      delegate: async () => {
        throw new Error("authority store unavailable");
      },
    };
    await expect(
      new RunAgentAssignment(
        nativeHost,
        new InMemoryAssignments(),
        unavailable,
        commandDigester,
      ).execute(command),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_AUTHORITY_UNAVAILABLE", retry: "never" },
    });
    expect(nativeHost.spawn).not.toHaveBeenCalled();
  });

  it("refuses a stored assignment bound to another authority", async () => {
    const repository = new InMemoryAssignments();
    await repository.admit({
      assignment: createAssignment(command.identity, {
        authorityId: "foreign-authority",
        participantId: "agent-a",
        parentParticipantId: "main-a",
        role: "agent",
        mutationOwnership: "task",
      }),
      resultRef: null,
      parentDelivery: "not_applicable",
    });
    const nativeHost = host();
    await expect(
      new RunAgentAssignment(
        nativeHost,
        repository,
        authorityPort(),
        commandDigester,
      ).execute(command),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_AUTHORITY_CORRELATION", retry: "never" },
    });
    expect(nativeHost.spawn).not.toHaveBeenCalled();
  });
});
