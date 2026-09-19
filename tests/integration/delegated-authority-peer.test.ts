import { describe, expect, it } from "vitest";
import { DelegateExecutionAuthority } from "../../src/modules/computer/app/service/delegate-execution-authority";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { ExecutionAuthorityContractHandler } from "../../src/modules/computer/infra/authority-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { ComputerExecutionAuthorityPeer } from "../../src/modules/agent/infra/peer/computer-execution-authority-peer";
import type { AuthorityRepository } from "../../src/modules/computer/app/port/authority-repository";
import type { ParticipantAuthority } from "../../src/modules/computer/domain/execution-authority";

const approval: ComputerApproval = {
  ownerId: "owner-preview",
  computerId: "computer-preview",
  generation: 7,
  workspaces: [
    { workspaceId: "farol", root: "/workspace/farol", access: "write" },
    {
      workspaceId: "brain",
      root: "/workspace/brain/Work/Farol",
      access: "read",
    },
  ],
  capabilities: [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    "verification.run",
    "workspace.write",
  ],
  network: "none",
  commands: "verification",
  expiresAt: 20_000,
};

const admission: TaskAdmission = {
  authorityId: "authority-task-a",
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
  capabilities: approval.capabilities,
  network: "none",
  commands: "verification",
  expiresAt: 10_000,
};

function rootParticipant(): ParticipantAuthority {
  const grant = deriveTaskGrant(approval, admission, 1_000);
  if (!grant.ok) throw new Error(grant.error.code);
  const main = createParticipantAuthority(grant.value, {
    participantId: "main-a",
    role: "main",
    mutationOwnership: "task",
  });
  if (!main.ok) throw new Error(main.error.code);
  return main.value;
}

function createPeer() {
  const repository = new InMemoryAuthorityRepository([rootParticipant()]);
  const contract = new ExecutionAuthorityContractHandler(
    new DelegateExecutionAuthority(repository, { now: () => 1_000 }),
  );
  return {
    contract,
    peer: new ComputerExecutionAuthorityPeer(contract),
    repository,
  };
}

const identity = {
  assignmentId: "assignment-a",
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 3,
  generation: 1,
} as const;

describe("Agent -> Computer delegated-authority peer", () => {
  it("DAC-02 resolves an Agent grant from Computer-owned runtime state", async () => {
    const { peer } = createPeer();

    await expect(
      peer.delegate({
        identity,
        parentParticipantId: "main-a",
        participantId: "agent-a",
        role: "agent",
        mutationOwnership: "task",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        authorityId: "authority-task-a",
        participantId: "agent-a",
        parentParticipantId: "main-a",
        role: "agent",
        taskId: "task-a",
        workspaces: admission.workspaces,
        capabilities: admission.capabilities,
      },
    });
  });

  it("DAC-09 preserves one task grant across main to Agent to Critic", async () => {
    const { peer } = createPeer();
    const agent = await peer.delegate({
      identity,
      parentParticipantId: "main-a",
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "task",
    });
    expect(agent.ok).toBe(true);

    const critic = await peer.delegate({
      identity: { ...identity, assignmentId: "review-a", generation: 2 },
      parentParticipantId: "agent-a",
      participantId: "critic-a",
      role: "critic",
      mutationOwnership: "none",
    });
    expect(critic).toMatchObject({
      ok: true,
      value: {
        authorityId: "authority-task-a",
        participantId: "critic-a",
        role: "critic",
        mutationOwnership: "none",
        workspaces: admission.workspaces,
      },
    });
  });

  it("DAC-05 rejects a foreign task binding before storing a delegate", async () => {
    const { peer, repository } = createPeer();

    await expect(
      peer.delegate({
        identity: { ...identity, taskId: "foreign-task" },
        parentParticipantId: "main-a",
        participantId: "agent-foreign",
        role: "agent",
        mutationOwnership: "task",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AGENT_AUTHORITY_DENIED",
        source: "task-grant",
        retry: "never",
      },
    });
    await expect(repository.get("agent-foreign")).resolves.toBeNull();
  });

  it("DAC-06 persists explicit narrowing and refuses a conflicting duplicate participant", async () => {
    const { peer } = createPeer();
    const request = {
      identity,
      parentParticipantId: "main-a",
      participantId: "critic-a",
      role: "critic" as const,
      mutationOwnership: "none" as const,
      narrowing: {
        workspaces: [
          {
            workspaceId: "farol",
            mode: "exact" as const,
            root: "/workspace/farol",
            paths: ["/workspace/farol/vnext/README.md"],
            access: "read" as const,
          },
        ],
        capabilities: ["workspace.read" as const],
        network: "none" as const,
        commands: "none" as const,
      },
    };

    const first = await peer.delegate(request);
    expect(first).toMatchObject({
      ok: true,
      value: {
        workspaces: request.narrowing.workspaces,
        capabilities: ["workspace.read"],
        commands: "none",
      },
    });
    await expect(peer.delegate(request)).resolves.toEqual(first);
    await expect(
      peer.delegate({
        ...request,
        mutationOwnership: "task",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_AUTHORITY_DENIED", retry: "never" },
    });
  });

  it("does not trust an authority response the contract schema refuses", async () => {
    const granted = await createPeer().peer.delegate({
      identity,
      parentParticipantId: "main-a",
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "task",
    });
    if (!granted.ok) throw new Error(granted.error.code);
    const peer = new ComputerExecutionAuthorityPeer({
      delegate: async () => ({
        ok: true,
        value: { ...granted.value, workspaces: [{ workspaceId: "farol" }] },
      }),
    } as unknown as ConstructorParameters<
      typeof ComputerExecutionAuthorityPeer
    >[0]);

    await expect(
      peer.delegate({
        identity,
        parentParticipantId: "main-a",
        participantId: "agent-a",
        role: "agent",
        mutationOwnership: "task",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AGENT_AUTHORITY_UNAVAILABLE",
        source: "authority-store",
        retry: "never",
      },
    });
  });

  it("rejects malformed contract input before authority lookup", async () => {
    const { contract } = createPeer();
    await expect(
      contract.delegate({ ownerId: "owner-preview", unexpected: true }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_INVALID_REQUEST",
        source: "contract",
        retry: "never",
      },
    });
  });

  it("keeps missing, expired and foreign parent authority refusals distinct", async () => {
    const { peer } = createPeer();
    const base = {
      identity,
      participantId: "agent-a",
      role: "agent" as const,
      mutationOwnership: "task" as const,
    };
    await expect(
      peer.delegate({ ...base, parentParticipantId: "missing-main" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AGENT_AUTHORITY_DENIED",
        source: "authority-store",
        retry: "never",
      },
    });
    await expect(
      peer.delegate({
        ...base,
        identity: { ...identity, ownerId: "foreign-owner" },
        parentParticipantId: "main-a",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_AUTHORITY_DENIED", source: "task-grant" },
    });

    const expired = rootParticipant();
    const expiredRepository = new InMemoryAuthorityRepository([
      { ...expired, grant: { ...expired.grant, expiresAt: 999 } },
    ]);
    const expiredPeer = new ComputerExecutionAuthorityPeer(
      new ExecutionAuthorityContractHandler(
        new DelegateExecutionAuthority(expiredRepository, { now: () => 1_000 }),
      ),
    );
    await expect(
      expiredPeer.delegate({ ...base, parentParticipantId: "main-a" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_AUTHORITY_DENIED", source: "task-grant" },
    });
  });

  it("fails closed when the Computer authority store cannot read or admit", async () => {
    const unavailableRead: AuthorityRepository = {
      get: async () => {
        throw new Error("store unavailable");
      },
      admit: async () => {
        throw new Error("unexpected admit");
      },
    };
    const unavailableAdmit: AuthorityRepository = {
      get: async () => rootParticipant(),
      admit: async () => {
        throw new Error("store unavailable");
      },
    };
    const request = {
      identity,
      parentParticipantId: "main-a",
      participantId: "agent-a",
      role: "agent" as const,
      mutationOwnership: "task" as const,
    };
    for (const repository of [unavailableRead, unavailableAdmit]) {
      const peer = new ComputerExecutionAuthorityPeer(
        new ExecutionAuthorityContractHandler(
          new DelegateExecutionAuthority(repository, { now: () => 1_000 }),
        ),
      );
      await expect(peer.delegate(request)).resolves.toEqual({
        ok: false,
        error: {
          code: "AGENT_AUTHORITY_UNAVAILABLE",
          source: "authority-store",
          retry: "never",
        },
      });
    }
  });

  it("refuses participant-id reuse with a different admitted authority", async () => {
    const root = rootParticipant();
    const conflicting: ParticipantAuthority = {
      participantId: "agent-a",
      parentParticipantId: "main-a",
      role: "critic",
      mutationOwnership: "none",
      grant: root.grant,
    };
    const repository = new InMemoryAuthorityRepository([root, conflicting]);
    const peer = new ComputerExecutionAuthorityPeer(
      new ExecutionAuthorityContractHandler(
        new DelegateExecutionAuthority(repository, { now: () => 1_000 }),
      ),
    );
    await expect(
      peer.delegate({
        identity,
        parentParticipantId: "main-a",
        participantId: "agent-a",
        role: "agent",
        mutationOwnership: "task",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AGENT_AUTHORITY_DENIED",
        source: "authority-store",
        retry: "never",
      },
    });
  });
});
