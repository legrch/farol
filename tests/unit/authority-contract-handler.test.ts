import { describe, expect, it } from "vitest";

import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type ParticipantAuthority,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { ExecutionAuthorityDelegationResponseSchema } from "../../src/modules/computer/contract/execution-authority-contract";
import { ExecutionAuthorityContractHandler } from "../../src/modules/computer/infra/authority-contract-handler";
import { DelegateExecutionAuthority } from "../../src/modules/computer/app/service/delegate-execution-authority";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
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
  ],
  capabilities: ["workspace.list", "workspace.read", "workspace.search"],
  network: "none",
  commands: "none",
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
  ],
  capabilities: approval.capabilities,
  network: "none",
  commands: "none",
  expiresAt: 10_000,
};

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

function handler(): ExecutionAuthorityContractHandler {
  const authorities = new InMemoryAuthorityRepository([mainParticipant()]);
  return new ExecutionAuthorityContractHandler(
    new DelegateExecutionAuthority(authorities, { now: () => 1_000 }),
  );
}

describe("ExecutionAuthorityContractHandler — provenance on the wire", () => {
  it("carries an owner narrowing's restriction source through the public contract, tagged with the shape version", async () => {
    const response = await handler().delegate({
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      parentParticipantId: "main-a",
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "none",
      narrowing: {
        workspaces: [
          {
            workspaceId: "farol",
            mode: "subtree",
            root: "/workspace/farol/sub",
            access: "read",
          },
        ],
        excludedPaths: [
          { workspaceId: "farol", path: "/workspace/farol/sub/private" },
        ],
        capabilities: ["workspace.list", "workspace.read"],
        network: "none",
        commands: "none",
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value.authorityShapeVersion).toBe(1);
    expect(response.value.workspaces).toEqual([
      expect.objectContaining({
        workspaceId: "farol",
        restrictionSource: "owner-restriction",
      }),
    ]);
    expect(response.value.excludedPaths).toEqual([
      expect.objectContaining({
        workspaceId: "farol",
        path: "/workspace/farol/sub/private",
        restrictionSource: "owner-restriction",
      }),
    ]);
    // The exact wire shape a consumer (the Agent port) will parse.
    expect(
      ExecutionAuthorityDelegationResponseSchema.safeParse(response).success,
    ).toBe(true);
  });

  it("tags an unnarrowed task-level grant's restriction source as task-grant, not owner-restriction", async () => {
    const response = await handler().delegate({
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      parentParticipantId: "main-a",
      participantId: "agent-b",
      role: "agent",
      mutationOwnership: "none",
    });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value.authorityShapeVersion).toBe(1);
    expect(response.value.workspaces).toEqual([
      expect.objectContaining({
        workspaceId: "farol",
        restrictionSource: "task-grant",
      }),
    ]);
  });
});
