import { describe, expect, it, vi } from "vitest";

import { CodexAgentWorkspaceProbe } from "../../src/apps/desktop/codex-agent-workspace-probe";
import type { DelegatedAgentAuthority } from "../../src/modules/agent/app/port/execution-authority";
import { ComputerExecutionAuthorityPeer } from "../../src/modules/agent/infra/peer/computer-execution-authority-peer";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";
import { DelegateExecutionAuthority } from "../../src/modules/computer/app/service/delegate-execution-authority";
import {
  ExecutionAuthorityDelegationResponseSchema,
  type ExecutionAuthorityContract,
} from "../../src/modules/computer/contract/execution-authority-contract";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type ParticipantAuthority,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { ExecutionAuthorityContractHandler } from "../../src/modules/computer/infra/authority-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

// The complete provenance chain, end to end, with nothing hand-built: a
// real Computer delegation (`DelegateExecutionAuthority` over an in-memory
// authority repository), wire-encoded by the real contract handler, put
// through a real JSON round trip, parsed back by the contract schema, and
// only then handed to the desktop probe as the Agent port's authority. What
// this proves is that an owner narrowing's exclusion is still reported as
// an owner restriction after crossing every boundary, and that a record
// with no verifiable provenance is reported as exactly that.
//
// Note on scope: no product store persists a `DelegatedAgentAuthority`
// today (`private-assignment-store.ts` keeps only the authority's identity:
// authorityId, participantId, parentParticipantId, role and
// mutationOwnership). The "versionless record" case below therefore models
// a record produced before provenance existed arriving over the wire, not
// a restart that deserialized one from disk — there is no such product
// path to exercise.

const workspaceId = "00000000-0000-4000-8000-000000000001";
const referenceId = "00000000-0000-4000-8000-000000000002";
const computerId = "00000000-0000-4000-8000-000000000010";

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

const settings = ProductSettingsSchema.parse({
  schema: 1,
  revision: 1,
  general: {
    openAtLaunch: "browser",
    sidebarDefault: "full",
    activityDetail: "summary",
  },
  computer: {
    computerId,
    generation: 7,
    name: "This Mac",
    workspaces: [
      {
        workspaceId,
        root: "/workspace/primary",
        label: "Primary",
        access: "read",
        excludedPaths: [],
        rootIdentity: SYNTHETIC_ROOT_IDENTITY,
      },
      {
        workspaceId: referenceId,
        root: "/workspace/reference",
        label: "Reference",
        access: "read",
        excludedPaths: [],
        rootIdentity: SYNTHETIC_ROOT_IDENTITY,
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

// The Computer module's own approval and task admission: the same computer
// and generation the product settings describe, so the probe's re-derivation
// against current policy accepts the delegated authority.
const approval: ComputerApproval = {
  ownerId: "owner-desktop",
  computerId,
  generation: 7,
  workspaces: [
    {
      workspaceId,
      root: "/workspace/primary",
      access: "read",
      rootIdentity: SYNTHETIC_ROOT_IDENTITY,
    },
    {
      workspaceId: referenceId,
      root: "/workspace/reference",
      access: "read",
      rootIdentity: SYNTHETIC_ROOT_IDENTITY,
    },
  ],
  capabilities: ["workspace.list", "workspace.read", "workspace.search"],
  network: "none",
  commands: "none",
  expiresAt: 20_000,
};

const admission: TaskAdmission = {
  authorityId: "authority-task-a",
  ownerId: "owner-desktop",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 7,
  computerId,
  computerGeneration: 7,
  workspaces: [
    {
      workspaceId,
      mode: "subtree",
      root: "/workspace/primary",
      access: "read",
    },
    {
      workspaceId: referenceId,
      mode: "subtree",
      root: "/workspace/reference",
      access: "read",
    },
  ],
  capabilities: approval.capabilities,
  network: "none",
  commands: "none",
  expiresAt: 10_000,
};

const identity = {
  assignmentId: "assignment-a",
  ownerId: "owner-desktop",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 7,
  generation: 1,
} as const;

// The owner narrows the Agent to the primary workspace and excludes its
// private folder. On the wire that exclusion must read "owner-restriction".
const narrowingRequest = {
  ownerId: "owner-desktop",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 7,
  parentParticipantId: "main-a",
  participantId: "agent-a",
  role: "agent",
  mutationOwnership: "none",
  narrowing: {
    workspaces: [
      {
        workspaceId,
        mode: "subtree",
        root: "/workspace/primary",
        access: "read",
      },
    ],
    excludedPaths: [{ workspaceId, path: "/workspace/primary/private" }],
    capabilities: ["workspace.list", "workspace.read", "workspace.search"],
    network: "none",
    commands: "none",
  },
} as const;

function mainParticipant(): ParticipantAuthority {
  const grant = deriveTaskGrant(approval, admission, 1_000);
  if (!grant.ok) throw new Error(grant.error.code);
  const main = createParticipantAuthority(grant.value, {
    participantId: "main-a",
    role: "main",
    mutationOwnership: "none",
  });
  if (!main.ok) throw new Error(main.error.code);
  return main.value;
}

function contractHandler(): ExecutionAuthorityContractHandler {
  return new ExecutionAuthorityContractHandler(
    new DelegateExecutionAuthority(
      new InMemoryAuthorityRepository([mainParticipant()]),
      { now: () => 1_000 },
    ),
  );
}

// Delegate through the real handler, serialize the response exactly as a
// wire would, and parse it back through the contract schema. The result is
// the authority the Agent port hands to the desktop probe.
async function delegatedOverTheWire(): Promise<DelegatedAgentAuthority> {
  const response = await contractHandler().delegate(narrowingRequest);
  const serialized: unknown = JSON.parse(JSON.stringify(response));
  const parsed = ExecutionAuthorityDelegationResponseSchema.parse(serialized);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

// The same record with every trace of provenance removed: what a record
// produced before `authorityShapeVersion` and `restrictionSource` existed
// still looks like on the wire. It still parses, because both fields are
// optional for exactly that reason.
function withoutProvenance(
  authority: DelegatedAgentAuthority,
): DelegatedAgentAuthority {
  const { authorityShapeVersion: _version, ...rest } = authority;
  const stripped = {
    ...rest,
    workspaces: rest.workspaces.map(
      ({ restrictionSource: _source, ...workspace }) => workspace,
    ),
    excludedPaths: rest.excludedPaths.map(
      ({ restrictionSource: _source, ...exclusion }) => exclusion,
    ),
  };
  const parsed = ExecutionAuthorityDelegationResponseSchema.parse(
    JSON.parse(JSON.stringify({ ok: true, value: stripped })),
  );
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function probeWith(execute: ReadonlyWorkspace["execute"]) {
  return new CodexAgentWorkspaceProbe(settings, { execute }, () => 1_000);
}

describe("Agent authority provenance chain: delegation -> wire -> schema -> probe", () => {
  it("reports an owner narrowing's exclusion as owner-restriction after a real wire round trip, and never reaches the executor", async () => {
    const authority = await delegatedOverTheWire();
    expect(authority.authorityShapeVersion).toBe(1);
    expect(authority.excludedPaths).toEqual([
      {
        workspaceId,
        path: "/workspace/primary/private",
        restrictionSource: "owner-restriction",
      },
    ]);

    // The Agent's own peer, over the same JSON-round-tripped contract,
    // yields byte-for-byte the same authority the probe is about to use.
    const wire: ExecutionAuthorityContract = {
      delegate: async (request) =>
        JSON.parse(JSON.stringify(await contractHandler().delegate(request))),
    };
    const { narrowing, ...delegation } = narrowingRequest;
    await expect(
      new ComputerExecutionAuthorityPeer(wire).delegate({
        identity,
        parentParticipantId: delegation.parentParticipantId,
        participantId: delegation.participantId,
        role: delegation.role,
        mutationOwnership: delegation.mutationOwnership,
        narrowing,
      }),
    ).resolves.toEqual({ ok: true, value: authority });

    const execute = vi.fn<ReadonlyWorkspace["execute"]>();
    await expect(
      probeWith(execute).execute({
        identity,
        authority,
        workspaceId,
        operation: { kind: "workspace.read", relativePath: "private" },
        threadId: "child-a",
        turnId: "turn-a",
        callId: "call-a",
      }),
    ).resolves.toEqual({
      status: "failed",
      code: "AUTHORITY_PATH_DENIED",
      source: "owner-restriction",
      retry: "never",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a record with no verifiable provenance as unverified-provenance, never as an ordinary task grant", async () => {
    const legacy = withoutProvenance(await delegatedOverTheWire());
    expect(legacy.authorityShapeVersion).toBeUndefined();
    for (const workspace of legacy.workspaces) {
      expect(workspace).not.toHaveProperty("restrictionSource");
    }
    for (const exclusion of legacy.excludedPaths) {
      expect(exclusion).not.toHaveProperty("restrictionSource");
    }

    const execute = vi.fn<ReadonlyWorkspace["execute"]>();
    await expect(
      probeWith(execute).execute({
        identity,
        authority: legacy,
        workspaceId,
        operation: { kind: "workspace.read", relativePath: "private" },
        threadId: "child-a",
        turnId: "turn-a",
        callId: "call-a",
      }),
    ).resolves.toEqual({
      status: "failed",
      code: "AUTHORITY_PATH_DENIED",
      source: "unverified-provenance",
      retry: "never",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("still verifies workspace enforcement when the exclusion it probes is an owner restriction", async () => {
    const authority = await delegatedOverTheWire();
    const execute = vi.fn<ReadonlyWorkspace["execute"]>(async () => ({
      ok: true,
      value: {
        kind: "workspace.entries",
        entries: ["README.md"],
        truncated: false,
      },
    }));

    await expect(
      probeWith(execute).verify({
        identity,
        authority,
        focusPath: "/workspace/primary",
        threadId: "child-a",
        turnId: "turn-a",
        callId: "call-a",
      }),
    ).resolves.toEqual({ status: "verified" });
    // Exactly the one allowed list reached the workspace; the foreign
    // workspace and the owner-excluded folder were both refused before it.
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
