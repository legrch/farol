import { describe, expect, it } from "vitest";
import {
  authorizeComputerAction,
  authorizeNativeHostAction,
  authorizeTaskAction,
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
  type AuthorityAction,
  type AuthorityNarrowing,
  type ComputerApproval,
  type NativeHostAuthority,
  type ParticipantAuthority,
  type TaskAdmission,
  type TaskGrant,
} from "../../src/modules/computer/domain/execution-authority";

const approval: ComputerApproval = {
  ownerId: "owner-preview",
  computerId: "computer-preview",
  generation: 7,
  workspaces: [
    {
      workspaceId: "farol",
      root: "/workspace/farol",
      access: "write",
    },
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
  network: "approved",
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

function taskGrant(): TaskGrant {
  const result = deriveTaskGrant(approval, admission, 1_000);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function mainParticipant(): ParticipantAuthority {
  const result = createParticipantAuthority(taskGrant(), {
    participantId: "main-a",
    role: "main",
    mutationOwnership: "task",
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function action(operation: AuthorityAction["operation"]): AuthorityAction {
  return {
    ownerId: "owner-preview",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 3,
    operation,
  };
}

describe("delegated execution authority", () => {
  it("DAC-01 derives a task grant only from the admitted subset of Computer approval", () => {
    const grant = taskGrant();

    expect(grant).toMatchObject({
      authorityId: "authority-task-a",
      ownerId: "owner-preview",
      taskId: "task-a",
      computerId: "computer-preview",
      computerGeneration: 7,
      network: "none",
    });
    expect(
      authorizeTaskAction(
        mainParticipant(),
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/vnext/src/index.ts",
        }),
        1_000,
      ),
    ).toMatchObject({ ok: true });
  });

  it("DAC-02 preserves the same applicable grant when main delegates to Agent", () => {
    const main = mainParticipant();
    const delegated = delegateParticipantAuthority(main, {
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "task",
    });

    expect(delegated).toMatchObject({
      ok: true,
      value: {
        role: "agent",
        parentParticipantId: "main-a",
        grant: main.grant,
      },
    });
  });

  it("DAC-03 lets a delegate discover an unnamed related file in a granted subtree", () => {
    const delegated = delegateParticipantAuthority(mainParticipant(), {
      participantId: "critic-a",
      role: "critic",
      mutationOwnership: "none",
    });
    if (!delegated.ok) throw new Error(delegated.error.code);

    expect(
      authorizeTaskAction(
        delegated.value,
        action({
          kind: "workspace.search",
          workspaceId: "brain",
          path: "/workspace/brain/Work/Farol/new-note-not-in-packet.md",
        }),
        1_000,
      ),
    ).toMatchObject({ ok: true });
  });

  it("DAC-04 lets a non-mutating Critic verify but not rewrite implementation", () => {
    const delegated = delegateParticipantAuthority(mainParticipant(), {
      participantId: "critic-a",
      role: "critic",
      mutationOwnership: "none",
    });
    if (!delegated.ok) throw new Error(delegated.error.code);

    expect(
      authorizeTaskAction(
        delegated.value,
        action({
          kind: "verification.run",
          workspaceId: "farol",
          path: "/workspace/farol",
        }),
        1_000,
      ),
    ).toMatchObject({ ok: true });
    expect(
      authorizeTaskAction(
        delegated.value,
        action({
          kind: "workspace.write",
          workspaceId: "farol",
          path: "/workspace/farol/vnext/src/index.ts",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_MUTATION_OWNERSHIP_DENIED",
        source: "role",
      },
    });
  });

  it("DAC-05 refuses paths and capabilities outside the TaskGrant without escalation", () => {
    const participant = mainParticipant();
    expect(
      authorizeTaskAction(
        participant,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/other/private.txt",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED", source: "task-grant" },
    });
    expect(
      authorizeTaskAction(participant, action({ kind: "network.use" }), 1_000),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_NETWORK_DENIED", source: "task-grant" },
    });
  });

  it("DAC-06 preserves explicit exact-file, read-only and no-network narrowing", () => {
    const narrowed = delegateParticipantAuthority(mainParticipant(), {
      participantId: "agent-narrow",
      role: "agent",
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
    });
    if (!narrowed.ok) throw new Error(narrowed.error.code);

    expect(
      authorizeTaskAction(
        narrowed.value,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/vnext/README.md",
        }),
        1_000,
      ),
    ).toMatchObject({ ok: true });
    expect(
      authorizeTaskAction(
        narrowed.value,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/vnext/package.json",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED", source: "owner-restriction" },
    });
    expect(
      authorizeTaskAction(
        narrowed.value,
        action({
          kind: "workspace.write",
          workspaceId: "farol",
          path: "/workspace/farol/vnext/README.md",
        }),
        1_000,
      ),
    ).toMatchObject({ ok: false });
  });

  it("DAC-06 preserves an explicit do-not-inspect exclusion through later delegation", () => {
    const narrowing: AuthorityNarrowing = {
      workspaces: admission.workspaces,
      capabilities: admission.capabilities,
      network: "none",
      commands: "verification",
      excludedPaths: [
        {
          workspaceId: "farol",
          path: "/workspace/farol/private",
        },
      ],
    };
    const agent = delegateParticipantAuthority(mainParticipant(), {
      participantId: "agent-excluded",
      role: "agent",
      mutationOwnership: "task",
      narrowing,
    });
    if (!agent.ok) throw new Error(agent.error.code);
    const critic = delegateParticipantAuthority(agent.value, {
      participantId: "critic-excluded",
      role: "critic",
      mutationOwnership: "none",
      narrowing: {
        workspaces: admission.workspaces,
        capabilities: admission.capabilities,
        network: "none",
        commands: "verification",
      },
    });
    if (!critic.ok) throw new Error(critic.error.code);

    expect(critic.value.grant).toMatchObject({
      excludedPaths: [
        {
          workspaceId: "farol",
          path: "/workspace/farol/private",
          restrictionSource: "owner-restriction",
        },
      ],
    });
    expect(
      authorizeTaskAction(
        critic.value,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/private/secret.txt",
        }),
        1_000,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "owner-restriction",
        retry: "never",
      },
    });
    expect(
      authorizeTaskAction(
        critic.value,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/public.txt",
        }),
        1_000,
      ),
    ).toMatchObject({ ok: true });

    expect(
      delegateParticipantAuthority(mainParticipant(), {
        participantId: "agent-invalid-exclusion",
        role: "agent",
        mutationOwnership: "task",
        narrowing: {
          ...narrowing,
          excludedPaths: [{ workspaceId: "farol", path: "/workspace/outside" }],
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED" },
    });
  });

  it("DAC-06 keeps an ancestor exclusion when delegation narrows to an exact descendant", () => {
    const agent = delegateParticipantAuthority(mainParticipant(), {
      participantId: "agent-excluded-parent",
      role: "agent",
      mutationOwnership: "task",
      narrowing: {
        workspaces: admission.workspaces,
        capabilities: admission.capabilities,
        network: "none",
        commands: "verification",
        excludedPaths: [
          {
            workspaceId: "farol",
            path: "/workspace/farol/private",
          },
        ],
      },
    });
    if (!agent.ok) throw new Error(agent.error.code);

    const critic = delegateParticipantAuthority(agent.value, {
      participantId: "critic-excluded-descendant",
      role: "critic",
      mutationOwnership: "none",
      narrowing: {
        workspaces: [
          {
            workspaceId: "farol",
            mode: "exact",
            root: "/workspace/farol",
            paths: ["/workspace/farol/private/secret.txt"],
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        network: "none",
        commands: "none",
      },
    });
    if (!critic.ok) throw new Error(critic.error.code);

    expect(critic.value.grant.excludedPaths).toEqual([
      {
        workspaceId: "farol",
        path: "/workspace/farol/private",
        restrictionSource: "owner-restriction",
      },
    ]);
    expect(
      authorizeTaskAction(
        critic.value,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/private/secret.txt",
        }),
        1_000,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "owner-restriction",
        retry: "never",
      },
    });
  });

  it("AUTH-02 preserves case and Unicode aliases of exclusions through narrowing", () => {
    const approvalWithExclusions: ComputerApproval = {
      ...approval,
      excludedPaths: [
        { workspaceId: "farol", path: "/workspace/farol/private" },
        { workspaceId: "farol", path: "/workspace/farol/Caf\u00e9" },
      ],
    };
    const grant = deriveTaskGrant(
      approvalWithExclusions,
      {
        ...admission,
        workspaces: [
          {
            workspaceId: "farol",
            mode: "subtree",
            root: "/workspace/farol/PRIVATE",
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        commands: "none",
      },
      1_000,
    );
    if (!grant.ok) throw new Error(grant.error.code);
    expect(grant.value.excludedPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/workspace/farol/private",
          restrictionSource: "computer-approval",
        }),
      ]),
    );
    const participant = createParticipantAuthority(grant.value, {
      participantId: "alias-main",
      role: "main",
      mutationOwnership: "none",
    });
    if (!participant.ok) throw new Error(participant.error.code);
    expect(
      authorizeTaskAction(
        participant.value,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/PRIVATE/secret.txt",
        }),
        1_000,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "computer-approval",
        retry: "never",
      },
    });

    const fullGrant = deriveTaskGrant(approvalWithExclusions, admission, 1_000);
    if (!fullGrant.ok) throw new Error(fullGrant.error.code);
    const fullParticipant = createParticipantAuthority(fullGrant.value, {
      participantId: "unicode-main",
      role: "main",
      mutationOwnership: "task",
    });
    if (!fullParticipant.ok) throw new Error(fullParticipant.error.code);
    const narrowed = delegateParticipantAuthority(fullParticipant.value, {
      participantId: "unicode-agent",
      role: "agent",
      mutationOwnership: "none",
      narrowing: {
        workspaces: [
          {
            workspaceId: "farol",
            mode: "subtree",
            root: "/workspace/farol/Cafe\u0301",
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        network: "none",
        commands: "none",
      },
    });
    if (!narrowed.ok) throw new Error(narrowed.error.code);
    expect(narrowed.value.grant.excludedPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/workspace/farol/Caf\u00e9" }),
      ]),
    );
    expect(
      authorizeTaskAction(
        narrowed.value,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/Cafe\u0301/secret.md",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED" },
    });

    const sibling = delegateParticipantAuthority(fullParticipant.value, {
      participantId: "case-sensitive-sibling",
      role: "agent",
      mutationOwnership: "none",
      narrowing: {
        workspaces: [
          {
            workspaceId: "farol",
            mode: "subtree",
            root: "/workspace/farol/PRIVATE-docs",
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        network: "none",
        commands: "none",
      },
    });
    if (!sibling.ok) throw new Error(sibling.error.code);
    expect(
      authorizeTaskAction(
        sibling.value,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/PRIVATE-docs/readme.md",
        }),
        1_000,
      ),
    ).toMatchObject({ ok: true });

    expect(
      deriveTaskGrant(
        approvalWithExclusions,
        {
          ...admission,
          workspaces: [
            {
              workspaceId: "farol",
              mode: "subtree",
              root: "/workspace/FAROL",
              access: "read",
            },
          ],
          capabilities: ["workspace.read"],
          commands: "none",
        },
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED" },
    });
  });

  it("DAC-07 intersects native host authority instead of upgrading it to Computer authority", () => {
    const nativeHost: NativeHostAuthority = {
      hostTaskId: "host-task-a",
      ownerId: "owner-preview",
      taskId: "task-a",
      taskEpoch: 3,
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
      expiresAt: 10_000,
    };

    expect(
      authorizeNativeHostAction(
        mainParticipant(),
        nativeHost,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/vnext/package.json",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED", source: "native-host" },
    });
  });

  it("DAC-08 enforces both TaskGrant and current Computer policy", () => {
    const currentApproval: ComputerApproval = {
      ...approval,
      workspaces: approval.workspaces.map((workspace) =>
        workspace.workspaceId === "farol"
          ? { ...workspace, access: "read" as const }
          : workspace,
      ),
      capabilities: approval.capabilities.filter(
        (capability) => capability !== "workspace.write",
      ),
    };

    expect(
      authorizeComputerAction(
        mainParticipant(),
        currentApproval,
        action({
          kind: "workspace.write",
          workspaceId: "farol",
          path: "/workspace/farol/vnext/src/index.ts",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_CAPABILITY_DENIED",
        source: "computer-policy",
      },
    });
  });

  it("DAC-09 changes main to Agent to Critic without widening or erasing workspace authority", () => {
    const agent = delegateParticipantAuthority(mainParticipant(), {
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "task",
    });
    if (!agent.ok) throw new Error(agent.error.code);
    const critic = delegateParticipantAuthority(agent.value, {
      participantId: "critic-a",
      role: "critic",
      mutationOwnership: "none",
    });
    if (!critic.ok) throw new Error(critic.error.code);

    expect(agent.value.grant).toEqual(mainParticipant().grant);
    expect(critic.value.grant).toEqual(mainParticipant().grant);
    expect(critic.value.role).toBe("critic");
  });

  it("DAC-10 records the rejecting boundary and never suggests an automatic retry", () => {
    const nativeHost: NativeHostAuthority = {
      hostTaskId: "host-task-a",
      ownerId: "owner-preview",
      taskId: "task-a",
      taskEpoch: 3,
      workspaces: [],
      capabilities: [],
      network: "none",
      commands: "none",
      expiresAt: 10_000,
    };

    expect(
      authorizeNativeHostAction(
        mainParticipant(),
        nativeHost,
        action({
          kind: "verification.run",
          workspaceId: "farol",
          path: "/workspace/farol",
        }),
        1_000,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_CAPABILITY_DENIED",
        source: "native-host",
        retry: "never",
      },
    });
  });

  it("rejects attempted delegation widening before a participant can be created", () => {
    expect(
      delegateParticipantAuthority(mainParticipant(), {
        participantId: "agent-wide",
        role: "agent",
        mutationOwnership: "task",
        narrowing: {
          workspaces: [
            {
              workspaceId: "foreign",
              mode: "subtree",
              root: "/workspace/foreign",
              access: "write",
            },
          ],
          capabilities: ["workspace.write"],
          network: "approved",
          commands: "verification",
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED", retry: "never" },
    });
  });

  it("rejects stale, foreign and expired admissions before issuing a TaskGrant", () => {
    expect(
      deriveTaskGrant(approval, { ...admission, computerGeneration: 6 }, 1_000),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_COMPUTER_MISMATCH" },
    });
    expect(
      deriveTaskGrant(
        approval,
        { ...admission, ownerId: "foreign-owner" },
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_OWNER_MISMATCH" },
    });
    expect(deriveTaskGrant(approval, admission, 10_001)).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_EXPIRED" },
    });
  });

  it("refuses malformed, duplicate and inflated task workspace scopes", () => {
    for (const root of [
      "/workspace/farol/",
      "/workspace/../farol",
      "/workspace//farol",
      "workspace/farol",
      "/workspace/farol\0escape",
    ]) {
      expect(
        deriveTaskGrant(
          approval,
          {
            ...admission,
            workspaces: [
              {
                workspaceId: "farol",
                mode: "subtree",
                root,
                access: "read",
              },
            ],
          },
          1_000,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_INFLATION_DENIED" },
      });
    }
    expect(
      deriveTaskGrant(
        approval,
        {
          ...admission,
          workspaces: [admission.workspaces[0]!, admission.workspaces[0]!],
        },
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED" },
    });
    expect(
      deriveTaskGrant(
        { ...approval, network: "none" },
        { ...admission, network: "approved" },
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED" },
    });
  });

  it("supports root-scoped approval while keeping exact scopes monotonic", () => {
    const rootApproval: ComputerApproval = {
      ...approval,
      workspaces: [{ workspaceId: "root", root: "/", access: "read" }],
      capabilities: ["workspace.read"],
      commands: "none",
    };
    const rootGrant = deriveTaskGrant(
      rootApproval,
      {
        ...admission,
        workspaces: [
          {
            workspaceId: "root",
            mode: "exact",
            root: "/",
            paths: ["/workspace/farol/README.md"],
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        commands: "none",
      },
      1_000,
    );
    if (!rootGrant.ok) throw new Error(rootGrant.error.code);
    const rootParticipant = createParticipantAuthority(rootGrant.value, {
      participantId: "root-main",
      role: "main",
      mutationOwnership: "none",
    });
    if (!rootParticipant.ok) throw new Error(rootParticipant.error.code);

    expect(
      delegateParticipantAuthority(rootParticipant.value, {
        participantId: "root-agent",
        role: "agent",
        mutationOwnership: "none",
        narrowing: {
          workspaces: [
            {
              workspaceId: "root",
              mode: "exact",
              root: "/",
              paths: ["/workspace/farol/README.md"],
              access: "read",
            },
          ],
          capabilities: ["workspace.read"],
          network: "none",
          commands: "none",
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      delegateParticipantAuthority(rootParticipant.value, {
        participantId: "root-wide",
        role: "agent",
        mutationOwnership: "none",
        narrowing: {
          workspaces: [
            {
              workspaceId: "root",
              mode: "subtree",
              root: "/workspace/farol",
              access: "read",
            },
          ],
          capabilities: ["workspace.read"],
          network: "none",
          commands: "none",
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED" },
    });
  });

  it("refuses role inflation and missing command authority", () => {
    const readonlyGrant: TaskGrant = {
      ...taskGrant(),
      capabilities: ["workspace.read"],
    };
    expect(
      createParticipantAuthority(readonlyGrant, {
        participantId: "main-write",
        role: "main",
        mutationOwnership: "task",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED", source: "role" },
    });
    const observer = createParticipantAuthority(taskGrant(), {
      participantId: "main-observer",
      role: "main",
      mutationOwnership: "none",
    });
    if (!observer.ok) throw new Error(observer.error.code);
    expect(
      delegateParticipantAuthority(observer.value, {
        participantId: "agent-builder",
        role: "agent",
        mutationOwnership: "task",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_INFLATION_DENIED", source: "role" },
    });
    const noCommands = {
      ...observer.value,
      grant: { ...observer.value.grant, commands: "none" as const },
    };
    expect(
      authorizeTaskAction(
        noCommands,
        action({
          kind: "verification.run",
          workspaceId: "farol",
          path: "/workspace/farol",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_COMMAND_DENIED" },
    });
  });

  it("classifies stale task, Computer and native-host boundaries independently", () => {
    const participant = mainParticipant();
    expect(
      authorizeTaskAction(
        participant,
        { ...action({ kind: "network.use" }), ownerId: "foreign" },
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_OWNER_MISMATCH", source: "task-grant" },
    });
    expect(
      authorizeTaskAction(
        participant,
        { ...action({ kind: "network.use" }), taskEpoch: 4 },
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_TASK_MISMATCH", source: "task-grant" },
    });
    expect(
      authorizeTaskAction(
        participant,
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/README.md",
        }),
        10_001,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_EXPIRED", source: "task-grant" },
    });
    expect(
      authorizeComputerAction(
        participant,
        { ...approval, ownerId: "foreign" },
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/README.md",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_OWNER_MISMATCH", source: "computer-policy" },
    });
    expect(
      authorizeComputerAction(
        participant,
        { ...approval, generation: 8 },
        action({
          kind: "workspace.read",
          workspaceId: "farol",
          path: "/workspace/farol/README.md",
        }),
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_COMPUTER_MISMATCH",
        source: "computer-policy",
      },
    });

    const host: NativeHostAuthority = {
      hostTaskId: "host-task-a",
      ownerId: "foreign",
      taskId: "task-a",
      taskEpoch: 3,
      workspaces: admission.workspaces,
      capabilities: admission.capabilities,
      network: "none",
      commands: "verification",
      expiresAt: 10_000,
    };
    const read = action({
      kind: "workspace.read",
      workspaceId: "farol",
      path: "/workspace/farol/README.md",
    });
    expect(
      authorizeNativeHostAction(participant, host, read, 1_000),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_OWNER_MISMATCH", source: "native-host" },
    });
    expect(
      authorizeNativeHostAction(
        participant,
        { ...host, ownerId: "owner-preview", taskEpoch: 4 },
        read,
        1_000,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_TASK_MISMATCH", source: "native-host" },
    });
  });
});
