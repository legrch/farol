import { describe, expect, it } from "vitest";
import { DelegateExecutionAuthority } from "../../src/modules/computer/app/service/delegate-execution-authority";
import {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { ExecutionAuthorityContractHandler } from "../../src/modules/computer/infra/authority-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { ComputerExecutionAuthorityPeer } from "../../src/modules/agent/infra/peer/computer-execution-authority-peer";
import type { AuthorityRepository } from "../../src/modules/computer/app/port/authority-repository";
import type { ParticipantAuthority } from "../../src/modules/computer/domain/execution-authority";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

const approval: ComputerApproval = {
  ownerId: "owner-preview",
  computerId: "computer-preview",
  generation: 7,
  workspaces: [
    {
      workspaceId: "farol",
      root: "/workspace/farol",
      access: "write",
      rootIdentity: SYNTHETIC_ROOT_IDENTITY,
    },
    {
      workspaceId: "brain",
      root: "/workspace/brain/Work/Farol",
      access: "read",
      rootIdentity: SYNTHETIC_ROOT_IDENTITY,
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

// A `ParticipantAuthority` shaped exactly like a record produced before
// provenance existed: both a workspace scope and an exclusion carry
// "unknown" `restrictionSource`. `deriveTaskGrant` and `narrowTaskGrant`
// never produce "unknown" themselves (see their own comments in
// `execution-authority.ts`), so this has to be built by hand, the same way
// `codex-agent-workspace-probe.ts`'s `participant()` reconstructs a record
// whose `authorityShapeVersion` was never 1.
function unverifiableProvenanceParent(): ParticipantAuthority {
  return {
    participantId: "legacy-main-a",
    parentParticipantId: null,
    role: "main",
    mutationOwnership: "task",
    grant: {
      authorityId: "authority-legacy-a",
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
          restrictionSource: "unknown",
        },
      ],
      excludedPaths: [
        {
          workspaceId: "farol",
          path: "/workspace/farol/.env",
          restrictionSource: "unknown",
        },
      ],
      capabilities: approval.capabilities,
      network: "none",
      commands: "verification",
      expiresAt: 10_000,
    },
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

  it("carries an unverified-provenance refusal through the Agent port instead of collapsing it into a store failure", async () => {
    const peer = new ComputerExecutionAuthorityPeer({
      delegate: async () => ({
        ok: false,
        error: {
          code: "AUTHORITY_PATH_DENIED",
          source: "unverified-provenance",
          retry: "never",
        },
      }),
    });

    await expect(
      peer.delegate({
        identity,
        parentParticipantId: "main-a",
        participantId: "agent-a",
        role: "agent",
        mutationOwnership: "none",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AGENT_AUTHORITY_DENIED",
        source: "unverified-provenance",
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

  // PINS TODAY'S BEHAVIOUR. THIS IS NOT AN ENDORSEMENT OF IT.
  //
  // `ExecutionAuthorityContractHandler.delegate` deliberately THROWS
  // `AUTHORITY_GRANT_PROVENANCE_INVALID` from `grantedWorkspaceSource` /
  // `grantedExclusionSource` (see that file's own comment) rather than
  // wire-encode a scope or exclusion whose provenance nobody can verify as
  // an ordinary "task-grant" — a loud failure over a silent mislabel, and we
  // agree with that choice. `ComputerExecutionAuthorityPeer.delegate` has no
  // try/catch around the contract call, so when a parent's grant still
  // carries "unknown" and survives untouched to the encode step, the Agent
  // port's returned promise REJECTS instead of resolving to an
  // `AgentAuthorityDecision`. That rejection is fail-closed in the sense
  // that matters to the caller: whoever calls `peer.delegate` never receives
  // a decision it could act on, so nothing is granted to it. Whether the
  // port should instead resolve to `{ok: false, source:
  // "unverified-provenance"}` — the same failure source `authorizeTaskAction`
  // already reports for an action an unknown-sourced restriction denies — is
  // a PRODUCT DECISION recorded in the acceptance pack, and is deliberately
  // NOT taken here. A future reader must not mistake a passing test here for
  // an endorsement that throwing is the desired design; it only pins what
  // the code does today.
  //
  // Arrangement: no narrowing. The parent's grant (workspace scope and
  // exclusion both "unknown") is passed straight through
  // `delegateParticipantAuthority` unchanged, so the first workspace scope
  // the handler tries to encode is the one that throws.
  //
  // The delegate participant ("agent-legacy") is pre-admitted into the
  // repository with content byte-identical to what this exact delegation
  // recomputes (via the real `delegateParticipantAuthority`), so
  // `InMemoryAuthorityRepository.admit` takes its non-mutating "existing"
  // branch. That is what makes "nothing observable changed in the
  // repository" a claim this test can actually prove for both sides of the
  // delegation, parent and delegate alike — see the next test for a related
  // arrangement where a fresh, never-before-seen delegate id is not left
  // untouched.
  it("rejects a parent grant with unverifiable provenance instead of mislabeling it, and leaves the authority store unchanged", async () => {
    const legacy = unverifiableProvenanceParent();
    const admission = {
      participantId: "agent-legacy",
      role: "agent" as const,
      mutationOwnership: "task" as const,
    };
    const preAdmitted = delegateParticipantAuthority(legacy, admission);
    if (!preAdmitted.ok) throw new Error(preAdmitted.error.code);

    const repository = new InMemoryAuthorityRepository([
      legacy,
      preAdmitted.value,
    ]);
    const peer = new ComputerExecutionAuthorityPeer(
      new ExecutionAuthorityContractHandler(
        new DelegateExecutionAuthority(repository, { now: () => 1_000 }),
      ),
    );

    const beforeChild = await repository.get("agent-legacy");
    const beforeParent = await repository.get("legacy-main-a");

    await expect(
      peer.delegate({
        identity,
        parentParticipantId: "legacy-main-a",
        participantId: "agent-legacy",
        role: "agent",
        mutationOwnership: "task",
      }),
    ).rejects.toThrow("AUTHORITY_GRANT_PROVENANCE_INVALID");

    // Nothing was granted: the repository holds exactly what it held before
    // this call, for both the delegate and its parent. A failing delegation
    // here admitted nothing new and rewrote nothing existing.
    await expect(repository.get("agent-legacy")).resolves.toEqual(beforeChild);
    await expect(repository.get("legacy-main-a")).resolves.toEqual(
      beforeParent,
    );
  });

  // A related fact the test above deliberately does not claim, so it is
  // pinned separately instead of being silently out of scope:
  // `DelegateExecutionAuthority.execute` awaits
  // `this.authorities.admit(...)` — which DOES durably store a brand-new
  // delegate — and only returns to the handler afterward. The handler's
  // provenance throw happens strictly after that store call already
  // completed. So a delegation for a participant id that was never admitted
  // before leaves an authority record behind (one this same handler would
  // refuse to encode a second time, for the same reason), even though the
  // caller's promise rejects and it never receives a decision. This does
  // not contradict "nothing was granted" from the caller's point of view —
  // no usable `AgentAuthorityDecision` ever reaches it — but it means that
  // claim does not extend to "the store is untouched in every case", and a
  // reader must not generalize the previous test that far. Whether leaving
  // this unusable record behind is acceptable is the same product decision
  // noted above, and is equally not taken here.
  it("still admits a brand-new delegate before the same unverifiable-provenance throw, leaving an unusable record stored", async () => {
    const legacy = unverifiableProvenanceParent();
    const repository = new InMemoryAuthorityRepository([legacy]);
    const peer = new ComputerExecutionAuthorityPeer(
      new ExecutionAuthorityContractHandler(
        new DelegateExecutionAuthority(repository, { now: () => 1_000 }),
      ),
    );

    await expect(repository.get("agent-fresh")).resolves.toBeNull();

    await expect(
      peer.delegate({
        identity,
        parentParticipantId: "legacy-main-a",
        participantId: "agent-fresh",
        role: "agent",
        mutationOwnership: "task",
      }),
    ).rejects.toThrow("AUTHORITY_GRANT_PROVENANCE_INVALID");

    await expect(repository.get("agent-fresh")).resolves.toMatchObject({
      participantId: "agent-fresh",
      grant: expect.objectContaining({
        workspaces: [expect.objectContaining({ restrictionSource: "unknown" })],
      }),
    });
  });
});
