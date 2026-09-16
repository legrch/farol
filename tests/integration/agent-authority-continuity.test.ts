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
import { createAssignment } from "../../src/modules/agent/domain/assignment";

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
        childId: "child-a",
      },
    })),
    wait: vi.fn(async (correlation) => ({
      status: "completed" as const,
      correlation,
      resultRef: "result-a",
    })),
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
      new RunAgentAssignment(nativeHost, repository, authorityPort()).execute(
        command,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_AUTHORITY_CORRELATION", retry: "never" },
    });
    expect(nativeHost.spawn).not.toHaveBeenCalled();
  });
});
