import { describe, expect, it } from "vitest";

import { deriveTaskGrant, createParticipantAuthority } from "./derive";
import type {
  AuthorityAction,
  ComputerApproval,
  NativeHostAuthority,
  ParticipantAuthority,
  TaskAdmission,
} from "./model";
import {
  authorizeComputerAction,
  authorizeNativeHostAction,
  authorizeTaskAction,
  authorizeTaskIdentity,
} from "./policy";

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
  capabilities: ["workspace.read", "workspace.write", "verification.run"],
  network: "approved",
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
  excludedPaths: [{ workspaceId: "ws", path: "/work/secret" }],
  capabilities: ["workspace.read", "workspace.write", "verification.run"],
  network: "none",
  commands: "verification",
  expiresAt: 500,
};

function participant(
  mutationOwnership: "none" | "task" = "task",
): ParticipantAuthority {
  const grant = deriveTaskGrant(approval, admission, 10);
  if (!grant.ok) throw new Error("grant");
  const made = createParticipantAuthority(grant.value, {
    participantId: "p",
    role: "main",
    mutationOwnership,
  });
  if (!made.ok) throw new Error("participant");
  return made.value;
}

function action(
  operation: AuthorityAction["operation"],
  overrides: Partial<AuthorityAction> = {},
): AuthorityAction {
  return {
    ownerId: "owner-a",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 1,
    operation,
    ...overrides,
  };
}

const read = {
  kind: "workspace.read",
  workspaceId: "ws",
  path: "/work/a",
} as const;

describe("authorizeTaskAction", () => {
  it("admits an in-scope read and a task-owned write", () => {
    expect(authorizeTaskAction(participant(), action(read), 10).ok).toBe(true);
    expect(
      authorizeTaskAction(
        participant(),
        action({ ...read, kind: "workspace.write" }),
        10,
      ).ok,
    ).toBe(true);
  });

  it("checks identity first, then mutation ownership", () => {
    expect(
      authorizeTaskAction(participant(), action(read, { taskEpoch: 9 }), 10),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_TASK_MISMATCH", source: "task-grant" },
    });
    expect(
      authorizeTaskAction(
        participant("none"),
        action({ ...read, kind: "workspace.write" }),
        10,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_MUTATION_OWNERSHIP_DENIED", source: "role" },
    });
  });

  it("denies excluded paths with their provenance and outside paths", () => {
    expect(
      authorizeTaskAction(
        participant(),
        action({ ...read, path: "/work/secret/x" }),
        10,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED", source: "task-grant" },
    });
    expect(
      authorizeTaskAction(
        participant(),
        action({ ...read, path: "/etc/passwd" }),
        10,
      ),
    ).toMatchObject({ ok: false, error: { code: "AUTHORITY_PATH_DENIED" } });
  });

  it("denies an excluded path under a scope rooted at the filesystem root", () => {
    const rootGrant = deriveTaskGrant(
      {
        ...approval,
        workspaces: [{ ...approval.workspaces[0]!, root: "/" }],
        excludedPaths: [{ workspaceId: "ws", path: "/work/secret" }],
      },
      {
        ...admission,
        workspaces: [
          { workspaceId: "ws", mode: "subtree", root: "/", access: "write" },
        ],
        excludedPaths: [],
      },
      10,
    );
    if (!rootGrant.ok) throw new Error("grant");
    const made = createParticipantAuthority(rootGrant.value, {
      participantId: "p",
      role: "main",
      mutationOwnership: "task",
    });
    if (!made.ok) throw new Error("participant");
    expect(rootGrant.value.excludedPaths).toEqual([
      {
        workspaceId: "ws",
        path: "/work/secret",
        restrictionSource: "computer-approval",
      },
    ]);
    expect(
      authorizeTaskAction(
        made.value,
        action({ ...read, path: "/work/secret/x" }),
        10,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED", source: "computer-approval" },
    });
    expect(
      authorizeTaskAction(
        made.value,
        action({ ...read, path: "/work/open" }),
        10,
      ).ok,
    ).toBe(true);
  });

  it("denies capability, command, network and expiry", () => {
    expect(
      authorizeTaskAction(
        participant(),
        action({ ...read, kind: "workspace.shell" }),
        10,
      ),
    ).toMatchObject({ error: { code: "AUTHORITY_CAPABILITY_DENIED" } });
    expect(
      authorizeTaskAction(participant(), action({ kind: "network.use" }), 10),
    ).toMatchObject({ error: { code: "AUTHORITY_NETWORK_DENIED" } });
    expect(authorizeTaskAction(participant(), action(read), 500).ok).toBe(true);
    expect(authorizeTaskAction(participant(), action(read), 501)).toMatchObject(
      {
        error: { code: "AUTHORITY_EXPIRED", source: "task-grant" },
      },
    );
  });
});

describe("authorizeTaskIdentity", () => {
  it("reports owner before task mismatches", () => {
    const identity = {
      ownerId: "owner-a",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 1,
    };
    expect(authorizeTaskIdentity(participant(), identity).ok).toBe(true);
    expect(
      authorizeTaskIdentity(participant(), {
        ...identity,
        ownerId: "x",
        taskId: "y",
      }),
    ).toMatchObject({ error: { code: "AUTHORITY_OWNER_MISMATCH" } });
    expect(
      authorizeTaskIdentity(participant(), { ...identity, sessionId: "x" }),
    ).toMatchObject({ error: { code: "AUTHORITY_TASK_MISMATCH" } });
  });
});

describe("authorizeComputerAction", () => {
  it("admits under both policies and refuses a changed computer", () => {
    expect(
      authorizeComputerAction(participant(), approval, action(read), 10).ok,
    ).toBe(true);
    expect(
      authorizeComputerAction(
        participant(),
        { ...approval, generation: 3 },
        action(read),
        10,
      ),
    ).toMatchObject({
      error: { code: "AUTHORITY_COMPUTER_MISMATCH", source: "computer-policy" },
    });
  });

  it("refuses when the approval has expired though the grant has not", () => {
    expect(
      authorizeComputerAction(
        participant(),
        { ...approval, expiresAt: 5 },
        action(read),
        10,
      ),
    ).toMatchObject({
      error: { code: "AUTHORITY_EXPIRED", source: "computer-policy" },
    });
  });
});

describe("authorizeNativeHostAction", () => {
  const host: NativeHostAuthority = {
    hostTaskId: "host-a",
    ownerId: "owner-a",
    taskId: "task-a",
    taskEpoch: 1,
    workspaces: admission.workspaces,
    capabilities: ["workspace.read"],
    network: "none",
    commands: "none",
    expiresAt: 500,
  };

  it("admits within host policy and refuses mismatches", () => {
    expect(
      authorizeNativeHostAction(participant(), host, action(read), 10).ok,
    ).toBe(true);
    expect(
      authorizeNativeHostAction(
        participant(),
        { ...host, ownerId: "x" },
        action(read),
        10,
      ),
    ).toMatchObject({
      error: { code: "AUTHORITY_OWNER_MISMATCH", source: "native-host" },
    });
    expect(
      authorizeNativeHostAction(
        participant(),
        { ...host, taskEpoch: 2 },
        action(read),
        10,
      ),
    ).toMatchObject({ error: { code: "AUTHORITY_TASK_MISMATCH" } });
    expect(
      authorizeNativeHostAction(
        participant(),
        host,
        action({ ...read, kind: "workspace.write" }),
        10,
      ),
    ).toMatchObject({
      error: { code: "AUTHORITY_CAPABILITY_DENIED", source: "native-host" },
    });
  });
});
