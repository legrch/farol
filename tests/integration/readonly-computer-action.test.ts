import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RunReadonlyComputerAction } from "../../src/modules/computer/app/service/run-readonly-computer-action";
import type { AuthorityRepository } from "../../src/modules/computer/app/port/authority-repository";
import type { ComputerApprovalRepository } from "../../src/modules/computer/app/port/computer-approval-repository";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";
import {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type ParticipantAuthority,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { ReadonlyComputerContractHandler } from "../../src/modules/computer/infra/readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../src/modules/computer/infra/repo/in-memory-computer-approvals";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
const clock = { now: () => 1_000 };
let root = "";

function approval(
  capabilities: ComputerApproval["capabilities"] = [
    "workspace.list",
    "workspace.read",
    "workspace.search",
  ],
): ComputerApproval {
  return {
    ownerId: "owner-preview",
    computerId: "computer-preview",
    generation: 7,
    workspaces: [{ workspaceId: "farol", root, access: "read" }],
    capabilities,
    network: "none",
    commands: "none",
    expiresAt: 20_000,
  };
}

function admission(): TaskAdmission {
  return {
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
        root,
        access: "read",
      },
    ],
    capabilities: ["workspace.list", "workspace.read", "workspace.search"],
    network: "none",
    commands: "none",
    expiresAt: 10_000,
  };
}

function participants(): Readonly<{
  main: ParticipantAuthority;
  agent: ParticipantAuthority;
  critic: ParticipantAuthority;
}> {
  const grant = deriveTaskGrant(approval(), admission(), clock.now());
  if (!grant.ok) throw new Error(grant.error.code);
  const main = createParticipantAuthority(grant.value, {
    participantId: "main-a",
    role: "main",
    mutationOwnership: "none",
  });
  if (!main.ok) throw new Error(main.error.code);
  const agent = delegateParticipantAuthority(main.value, {
    participantId: "agent-a",
    role: "agent",
    mutationOwnership: "none",
  });
  if (!agent.ok) throw new Error(agent.error.code);
  const critic = delegateParticipantAuthority(agent.value, {
    participantId: "critic-a",
    role: "critic",
    mutationOwnership: "none",
  });
  if (!critic.ok) throw new Error(critic.error.code);
  return { main: main.value, agent: agent.value, critic: critic.value };
}

function request(
  operation:
    | Readonly<{ kind: "workspace.read"; relativePath: string }>
    | Readonly<{ kind: "workspace.list"; relativePath: string }>
    | Readonly<{
        kind: "workspace.search";
        relativePath: string;
        pattern: string;
      }>,
  participantId = "critic-a",
) {
  return {
    ownerId: "owner-preview",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 3,
    participantId,
    turnId: "turn-a",
    generation: 2,
    callId: "call-a",
    workspaceId: "farol",
    operation,
  };
}

function contract(
  availableParticipants: readonly ParticipantAuthority[],
  currentApproval: ComputerApproval,
  workspace: ReadonlyWorkspace = new NativeReadonlyWorkspace({
    helperPath: sourceHelper,
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
  }),
) {
  return new ReadonlyComputerContractHandler(
    new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository(availableParticipants),
      new InMemoryComputerApprovalRepository([currentApproval]),
      workspace,
      clock,
    ),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-computer-"));
  root = await fs.realpath(root);
  await fs.chmod(root, 0o700);
  await fs.writeFile(path.join(root, "README.md"), "Farol read target\n", {
    mode: 0o600,
  });
  await fs.mkdir(path.join(root, "src"), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, "src", "unknown-beforehand.ts"),
    "export const delegated = 'authority-continuity';\n",
    { mode: 0o600 },
  );
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("real read-only Computer action", () => {
  it("DAC-03/08/09 lets a delegated Critic discover and read an unknown file through both policies", async () => {
    const chain = participants();
    const computer = contract(Object.values(chain), approval());

    await expect(
      computer.execute(
        request({
          kind: "workspace.search",
          relativePath: ".",
          pattern: "authority-continuity",
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        participantId: "critic-a",
        taskId: "task-a",
        taskEpoch: 3,
        callId: "call-a",
        workspaceId: "farol",
        output: {
          kind: "workspace.matches",
          matches: [{ path: "src/unknown-beforehand.ts", line: 1 }],
        },
      },
    });
    await expect(
      computer.execute(
        request({
          kind: "workspace.read",
          relativePath: "src/unknown-beforehand.ts",
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        output: {
          kind: "workspace.text",
          text: "export const delegated = 'authority-continuity';\n",
        },
      },
    });
  });

  it("DAC-08 rechecks current Computer policy and never reaches native execution after revocation", async () => {
    const chain = participants();
    let calls = 0;
    const workspace: ReadonlyWorkspace = {
      async execute() {
        calls += 1;
        throw new Error("native workspace must not run");
      },
    };
    const computer = contract(
      Object.values(chain),
      approval(["workspace.read"]),
      workspace,
    );

    await expect(
      computer.execute(
        request({
          kind: "workspace.search",
          relativePath: ".",
          pattern: "delegated",
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_CAPABILITY_DENIED",
        source: "computer-policy",
        retry: "never",
      },
    });
    expect(calls).toBe(0);
  });

  it("DAC-06 preserves explicit one-file narrowing at the real Computer boundary", async () => {
    const chain = participants();
    const narrowed = delegateParticipantAuthority(chain.agent, {
      participantId: "critic-narrow",
      role: "critic",
      mutationOwnership: "none",
      narrowing: {
        workspaces: [
          {
            workspaceId: "farol",
            mode: "exact",
            root,
            paths: [`${root}/README.md`],
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        network: "none",
        commands: "none",
      },
    });
    if (!narrowed.ok) throw new Error(narrowed.error.code);
    const computer = contract(
      [...Object.values(chain), narrowed.value],
      approval(),
    );

    await expect(
      computer.execute(
        request(
          { kind: "workspace.read", relativePath: "README.md" },
          "critic-narrow",
        ),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      computer.execute(
        request(
          {
            kind: "workspace.read",
            relativePath: "src/unknown-beforehand.ts",
          },
          "critic-narrow",
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "owner-restriction",
        retry: "never",
      },
    });
  });

  it("attributes foreign identity and malformed paths without fallback execution", async () => {
    const chain = participants();
    const computer = contract(Object.values(chain), approval());

    await expect(
      computer.execute({
        ...request({ kind: "workspace.read", relativePath: "README.md" }),
        ownerId: "foreign-owner",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_OWNER_MISMATCH",
        source: "task-grant",
        retry: "never",
      },
    });
    await expect(
      computer.execute(
        request({ kind: "workspace.read", relativePath: "../README.md" }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "COMPUTER_INVALID_REQUEST",
        source: "contract",
        retry: "never",
      },
    });
    await expect(
      computer.execute({
        ...request({ kind: "workspace.read", relativePath: "README.md" }),
        operation: {
          kind: "workspace.write",
          relativePath: "README.md",
          content: "forbidden",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "COMPUTER_INVALID_REQUEST", source: "contract" },
    });
  });

  it("classifies authority stores, missing policy, invalid targets and native refusals", async () => {
    const chain = participants();
    const available = new InMemoryAuthorityRepository(Object.values(chain));
    const approved = new InMemoryComputerApprovalRepository([approval()]);
    const successfulWorkspace: ReadonlyWorkspace = {
      async execute() {
        return {
          ok: true,
          value: { kind: "workspace.text", text: "ok", bytes: 2 },
        };
      },
    };
    const service = (
      authorities: AuthorityRepository,
      approvals: ComputerApprovalRepository,
      workspace: ReadonlyWorkspace = successfulWorkspace,
    ) =>
      new RunReadonlyComputerAction(authorities, approvals, workspace, clock);
    const read = request({
      kind: "workspace.read",
      relativePath: "README.md",
    });

    await expect(
      service(
        {
          async get() {
            throw new Error("unavailable");
          },
          async admit() {
            throw new Error("unused");
          },
        },
        approved,
      ).execute(read),
    ).resolves.toMatchObject({
      error: { code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" },
    });
    await expect(
      service(new InMemoryAuthorityRepository(), approved).execute(read),
    ).resolves.toMatchObject({
      error: { code: "COMPUTER_PARTICIPANT_NOT_FOUND" },
    });
    await expect(
      service(available, approved).execute({
        ...read,
        workspaceId: "missing-workspace",
      }),
    ).resolves.toMatchObject({
      error: { code: "AUTHORITY_PATH_DENIED", source: "task-grant" },
    });
    for (const relativePath of ["/README.md", "src/../README.md"]) {
      await expect(
        service(available, approved).execute({
          ...read,
          operation: { kind: "workspace.read", relativePath },
        }),
      ).resolves.toMatchObject({
        error: { code: "COMPUTER_PATH_INVALID", source: "task-grant" },
      });
    }
    await expect(
      service(available, {
        async get() {
          throw new Error("unavailable");
        },
      }).execute(read),
    ).resolves.toMatchObject({
      error: { code: "COMPUTER_APPROVAL_STORE_UNAVAILABLE" },
    });
    await expect(
      service(available, new InMemoryComputerApprovalRepository()).execute(
        read,
      ),
    ).resolves.toMatchObject({
      error: { code: "COMPUTER_APPROVAL_NOT_FOUND" },
    });
    await expect(
      service(available, approved, {
        async execute() {
          return {
            ok: false,
            error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
          };
        },
      }).execute(read),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "WORKSPACE_PATH_REFUSED",
        source: "native-workspace",
        retry: "never",
      },
    });
    await expect(
      service(available, approved, {
        async execute() {
          throw new Error("unexpected adapter failure");
        },
      }).execute(read),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "WORKSPACE_HELPER_FAILED",
        source: "native-workspace",
        retry: "never",
      },
    });
  });
});
