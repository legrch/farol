import { describe, expect, it } from "vitest";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import {
  computerExecutionLease,
  reissueTaskGrant,
} from "../../src/modules/computer/domain/task-grant-lifetime";

const approval: ComputerApproval = {
  ownerId: "owner",
  computerId: "computer",
  generation: 3,
  workspaces: [
    {
      workspaceId: "brain",
      root: "/Users/example/brain",
      access: "read",
      rootIdentity: { device: "1", inode: "2" },
    },
  ],
  excludedPaths: [
    { workspaceId: "brain", path: "/Users/example/brain/private" },
  ],
  capabilities: ["workspace.read"],
  network: "none",
  commands: "none",
  expiresAt: 10_000,
};
const ceiling: TaskAdmission = {
  authorityId: "task-authority",
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: 2,
  computerId: "computer",
  computerGeneration: 3,
  workspaces: [
    {
      workspaceId: "brain",
      mode: "subtree",
      root: "/Users/example/brain",
      access: "read",
    },
  ],
  capabilities: ["workspace.read"],
  network: "none",
  commands: "none",
  expiresAt: 1_100,
};

describe("TaskGrant lifetime and admitted execution leases", () => {
  it("uses current owner policy to reissue an expired template without widening scope", () => {
    expect(deriveTaskGrant(approval, ceiling, 1_101)).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_EXPIRED" },
    });
    const issued = reissueTaskGrant(approval, ceiling, 1_101, 1_000);
    expect(issued).toMatchObject({
      ok: true,
      value: {
        expiresAt: 2_101,
        taskId: ceiling.taskId,
        taskEpoch: ceiling.taskEpoch,
        capabilities: ceiling.capabilities,
        network: "none",
        commands: "none",
      },
    });
    if (!issued.ok) throw new Error("not issued");
    expect(issued.value.workspaces).toEqual([
      { ...ceiling.workspaces[0], restrictionSource: "task-grant" },
    ]);
    expect(issued.value.excludedPaths).toContainEqual({
      ...approval.excludedPaths![0],
      restrictionSource: "computer-approval",
    });
  });
  it.each([NaN, -1, 0, 0.5, Infinity, Number.MAX_SAFE_INTEGER])(
    "refuses invalid lifetime %s",
    (lifetime) => {
      expect(
        reissueTaskGrant(approval, ceiling, 1_101, lifetime),
      ).toMatchObject({ ok: false, error: { retry: "never" } });
    },
  );
  it.each([NaN, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER])(
    "refuses invalid clock %s",
    (now) => {
      expect(reissueTaskGrant(approval, ceiling, now, 1_000)).toMatchObject({
        ok: false,
        error: { retry: "never" },
      });
    },
  );
  it("lets generation revocation and temporary owner expiry defeat reissue", () => {
    expect(
      reissueTaskGrant({ ...approval, generation: 4 }, ceiling, 1_101, 1_000),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_COMPUTER_MISMATCH" },
    });
    expect(reissueTaskGrant(approval, ceiling, 10_001, 1_000)).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_EXPIRED" },
    });
    expect(
      reissueTaskGrant(
        { ...approval, expiresAt: 1_150 },
        ceiling,
        1_101,
        1_000,
      ),
    ).toMatchObject({ ok: true, value: { expiresAt: 1_150 } });
  });
  it("does not import newly approved capabilities or roots", () => {
    const issued = reissueTaskGrant(
      {
        ...approval,
        capabilities: ["workspace.read", "workspace.write"],
        workspaces: [
          ...approval.workspaces,
          {
            ...approval.workspaces[0]!,
            workspaceId: "code",
            root: "/Users/example/code",
            access: "write",
          },
        ],
      },
      ceiling,
      1_101,
      1_000,
    );
    expect(issued).toMatchObject({
      ok: true,
      value: {
        capabilities: ["workspace.read"],
        workspaces: [{ workspaceId: "brain" }],
      },
    });
    if (!issued.ok) throw new Error("not issued");
    expect(issued.value.workspaces).toHaveLength(1);
  });
  it("freezes an operation deadline independently of outer TTL and later renewal", () => {
    const grant = deriveTaskGrant(approval, ceiling, 1_000);
    if (!grant.ok) throw new Error("not issued");
    const participant = createParticipantAuthority(grant.value, {
      participantId: "main",
      role: "main",
      mutationOwnership: "none",
    });
    if (!participant.ok) throw new Error("not admitted");
    const lease = computerExecutionLease(
      participant.value,
      approval,
      1_000,
      5_000,
    );
    expect(lease.deadlineAt).toBe(6_000);
    expect(lease.participant.grant.expiresAt).toBe(6_000);
    expect(participant.value.grant.expiresAt).toBe(1_100);
    reissueTaskGrant(approval, ceiling, 1_200, 7_000);
    expect(lease.deadlineAt).toBe(6_000);
    expect(
      computerExecutionLease(participant.value, approval, 1_000, 20_000)
        .deadlineAt,
    ).toBe(10_000);
  });
});
