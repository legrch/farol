import { describe, expect, it } from "vitest";

import {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
} from "./derive";
import type { ComputerApproval, TaskAdmission } from "./model";

const approval: ComputerApproval = {
  ownerId: "owner-a",
  computerId: "computer-a",
  generation: 2,
  workspaces: [
    {
      workspaceId: "ws",
      root: "/work",
      access: "write",
      rootIdentity: { device: "1", inode: "2" },
    },
  ],
  excludedPaths: [{ workspaceId: "ws", path: "/work/private" }],
  capabilities: ["workspace.read", "workspace.write"],
  network: "none",
  commands: "verification",
  expiresAt: 1000,
};

const admission: TaskAdmission = {
  authorityId: "authority-a",
  ownerId: "owner-a",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 1,
  computerId: "computer-a",
  computerGeneration: 2,
  workspaces: [
    { workspaceId: "ws", mode: "subtree", root: "/work", access: "write" },
  ],
  capabilities: ["workspace.read", "workspace.write"],
  network: "none",
  commands: "verification",
  expiresAt: 1000,
};

function grantOf(value: TaskAdmission = admission) {
  const result = deriveTaskGrant(approval, value, 10);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("deriveTaskGrant", () => {
  it("admits a subset and stamps provenance", () => {
    const grant = grantOf();
    expect(grant.workspaces[0]?.restrictionSource).toBe("task-grant");
    expect(grant.excludedPaths).toEqual([
      {
        workspaceId: "ws",
        path: "/work/private",
        restrictionSource: "computer-approval",
      },
    ]);
  });

  it("refuses owner and computer mismatches before expiry", () => {
    expect(
      deriveTaskGrant(approval, { ...admission, ownerId: "x" }, 5000),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_OWNER_MISMATCH", source: "computer-approval" },
    });
    expect(
      deriveTaskGrant(approval, { ...admission, computerGeneration: 3 }, 5000),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_COMPUTER_MISMATCH" },
    });
  });

  it("expires strictly after the deadline", () => {
    expect(deriveTaskGrant(approval, admission, 1000).ok).toBe(true);
    expect(deriveTaskGrant(approval, admission, 1001)).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_EXPIRED", source: "task-admission" },
    });
  });

  it("refuses inflation of lifetime, capability, network, commands, scope", () => {
    const widened: Partial<TaskAdmission>[] = [
      { expiresAt: 2000 },
      { capabilities: ["workspace.read", "workspace.shell"] },
      { network: "approved" },
      { commands: "workspace" },
      {
        workspaces: [
          { workspaceId: "ws", mode: "subtree", root: "/", access: "write" },
        ],
      },
    ];
    for (const change of widened) {
      expect(
        deriveTaskGrant(approval, { ...admission, ...change }, 10),
      ).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_INFLATION_DENIED", source: "task-admission" },
      });
    }
  });
});

describe("participants", () => {
  it("refuses task mutation ownership without the write capability", () => {
    const grant = grantOf({ ...admission, capabilities: ["workspace.read"] });
    expect(
      createParticipantAuthority(grant, {
        participantId: "p",
        role: "main",
        mutationOwnership: "task",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED", source: "role" },
    });
  });

  it("delegates by narrowing and refuses widening", () => {
    const parent = createParticipantAuthority(grantOf(), {
      participantId: "p",
      role: "main",
      mutationOwnership: "task",
    });
    if (!parent.ok) throw new Error("parent");
    const child = delegateParticipantAuthority(parent.value, {
      participantId: "c",
      role: "agent",
      mutationOwnership: "none",
      narrowing: {
        workspaces: [
          {
            workspaceId: "ws",
            mode: "subtree",
            root: "/work/sub",
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        network: "none",
        commands: "none",
      },
    });
    expect(child.ok && child.value.parentParticipantId).toBe("p");
    expect(child.ok && child.value.grant.workspaces[0]?.restrictionSource).toBe(
      "owner-restriction",
    );

    expect(
      delegateParticipantAuthority(parent.value, {
        participantId: "c",
        role: "agent",
        mutationOwnership: "none",
        narrowing: {
          workspaces: [
            { workspaceId: "ws", mode: "subtree", root: "/", access: "read" },
          ],
          capabilities: ["workspace.read"],
          network: "none",
          commands: "none",
        },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_INFLATION_DENIED",
        source: "owner-restriction",
      },
    });
  });

  it("refuses a child that owns mutation its parent does not", () => {
    const parent = createParticipantAuthority(grantOf(), {
      participantId: "p",
      role: "critic",
      mutationOwnership: "none",
    });
    if (!parent.ok) throw new Error("parent");
    expect(
      delegateParticipantAuthority(parent.value, {
        participantId: "c",
        role: "agent",
        mutationOwnership: "task",
      }),
    ).toMatchObject({ ok: false, error: { source: "role" } });
  });
});
