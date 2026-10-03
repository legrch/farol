import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  type AuthorityNarrowing,
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
import { approvedRootOf, rootIdentityOf } from "../fixtures/root-identity";

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
    workspaces: [
      {
        workspaceId: "farol",
        root,
        access: "read",
        rootIdentity: rootIdentityOf(root),
      },
    ],
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

function exactParticipant(paths: readonly string[]): ParticipantAuthority {
  const grant = deriveTaskGrant(
    approval(),
    {
      ...admission(),
      workspaces: [
        {
          workspaceId: "farol",
          mode: "exact",
          root,
          paths,
          access: "read",
        },
      ],
    },
    clock.now(),
  );
  if (!grant.ok) throw new Error(grant.error.code);
  const participant = createParticipantAuthority(grant.value, {
    participantId: "agent-exact-files",
    role: "agent",
    mutationOwnership: "none",
  });
  if (!participant.ok) throw new Error(participant.error.code);
  return participant.value;
}

function request(
  operation:
    | Readonly<{ kind: "workspace.read"; relativePath: string }>
    | Readonly<{ kind: "workspace.list"; relativePath: string }>
    | Readonly<{
        kind: "workspace.search";
        relativePath: string;
        pattern: string;
      }>
    | Readonly<{
        kind: "verification.run";
        command: "git.status";
        relativePath: ".";
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
  it("propagates the caller cancellation signal to the native workspace boundary", async () => {
    const chain = participants();
    const execute = vi.fn<ReadonlyWorkspace["execute"]>(async () => ({
      ok: false,
      error: { code: "WORKSPACE_HELPER_FAILED", retry: "never" },
    }));
    const computer = contract(Object.values(chain), approval(), { execute });
    const controller = new AbortController();

    await computer.execute(
      request({ kind: "workspace.read", relativePath: "README.md" }),
      { signal: controller.signal },
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

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
    ).resolves.toMatchObject({
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
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "owner-restriction",
        retry: "never",
      },
    });
  });

  it("AUTH-10 checks the approved folder's identity even for a narrowed subtree", async () => {
    const measured = await fs.lstat(root, { bigint: true });
    const rootIdentity = {
      device: String(measured.dev),
      inode: String(measured.ino),
    };
    const bound: ComputerApproval = {
      ...approval(),
      workspaces: [
        { workspaceId: "farol", root, access: "read", rootIdentity },
      ],
    };
    const chain = participants();
    const narrowed = delegateParticipantAuthority(chain.agent, {
      participantId: "critic-subtree",
      role: "critic",
      mutationOwnership: "none",
      narrowing: {
        workspaces: [
          {
            workspaceId: "farol",
            mode: "subtree",
            root: `${root}/src`,
            access: "read",
          },
        ],
        capabilities: ["workspace.list", "workspace.read"],
        network: "none",
        commands: "none",
      },
    });
    if (!narrowed.ok) throw new Error(narrowed.error.code);
    const execute = vi.fn<ReadonlyWorkspace["execute"]>(async () => ({
      ok: true,
      value: { kind: "workspace.entries", entries: [], truncated: false },
    }));
    const computer = contract(
      [...Object.values(chain), narrowed.value],
      bound,
      {
        execute,
      },
    );

    await expect(
      computer.execute(
        request(
          { kind: "workspace.list", relativePath: "." },
          "critic-subtree",
        ),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(execute.mock.calls[0]?.[0].workspace).toEqual({
      workspaceId: "farol",
      root: `${root}/src`,
      deniedPaths: [],
      approvedRoot: { path: root, ...rootIdentity },
    });
  });

  it("AUTH-09 hands the approved linked Git metadata to the native boundary", async () => {
    const gitMetadata = {
      gitDirectory: "/repo/.git/worktrees/farol",
      commonDirectory: "/repo/.git",
    };
    const bound: ComputerApproval = {
      ...approval(),
      workspaces: [
        {
          workspaceId: "farol",
          root,
          access: "read",
          rootIdentity: rootIdentityOf(root),
          gitMetadata,
        },
      ],
    };
    const execute = vi.fn<ReadonlyWorkspace["execute"]>(async () => ({
      ok: true,
      value: { kind: "workspace.entries", entries: [], truncated: false },
    }));
    const computer = contract(Object.values(participants()), bound, {
      execute,
    });

    await computer.execute(
      request({ kind: "workspace.list", relativePath: "." }),
    );
    expect(execute.mock.calls[0]?.[0].workspace).toEqual({
      workspaceId: "farol",
      root,
      approvedRoot: approvedRootOf(root),
      deniedPaths: [],
      gitMetadata,
    });
  });

  it("AUTH-10 refuses a replaced approved folder at the real Computer boundary", async () => {
    const measured = await fs.lstat(root, { bigint: true });
    const bound: ComputerApproval = {
      ...approval(),
      workspaces: [
        {
          workspaceId: "farol",
          root,
          access: "read",
          rootIdentity: {
            device: String(measured.dev),
            inode: String(measured.ino),
          },
        },
      ],
    };
    const computer = contract(Object.values(participants()), bound);
    const read = request({ kind: "workspace.read", relativePath: "README.md" });

    await expect(computer.execute(read)).resolves.toMatchObject({ ok: true });
    const displaced = `${root}-displaced`;
    try {
      await fs.rename(root, displaced);
      await fs.mkdir(root, { mode: 0o700 });
      await fs.writeFile(path.join(root, "README.md"), "replacement\n", {
        mode: 0o600,
      });

      await expect(computer.execute(read)).resolves.toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_ROOT_CHANGED", retry: "never" },
      });
    } finally {
      await fs.rm(displaced, { recursive: true, force: true });
    }
  });

  it("AUTH-03 searches an exact regular file without promoting an exact directory", async () => {
    const participant = exactParticipant([`${root}/README.md`, `${root}/src`]);
    const computer = contract([participant], approval());

    await expect(
      computer.execute(
        request(
          {
            kind: "workspace.search",
            relativePath: "README.md",
            pattern: "Farol read target",
          },
          participant.participantId,
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        output: {
          kind: "workspace.matches",
          matches: [{ path: "README.md", line: 1 }],
        },
      },
    });
    await expect(
      computer.execute(
        request(
          {
            kind: "workspace.search",
            relativePath: "src",
            pattern: "authority-continuity",
          },
          participant.participantId,
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_NOT_A_FILE", source: "native-workspace" },
    });
    await expect(
      computer.execute(
        request(
          { kind: "workspace.list", relativePath: "src" },
          participant.participantId,
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED", source: "task-grant" },
    });
  });

  it("AUTH-03 refuses when an exact file becomes a directory before search", async () => {
    const selected = `${root}/README.md`;
    const participant = exactParticipant([selected]);
    const computer = contract([participant], approval());
    await fs.rename(selected, `${root}/README.original.md`);
    await fs.mkdir(selected, { mode: 0o700 });
    await fs.writeFile(
      path.join(selected, "nested.txt"),
      "nested-directory-secret-value\n",
      { mode: 0o600 },
    );

    const result = await computer.execute(
      request(
        {
          kind: "workspace.search",
          relativePath: "README.md",
          pattern: "secret",
        },
        participant.participantId,
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_NOT_A_FILE", source: "native-workspace" },
    });
    expect(JSON.stringify(result)).not.toContain(
      "nested-directory-secret-value",
    );
  });

  it("DAC-06 hides an explicitly excluded subtree from delegated search and read", async () => {
    await fs.mkdir(path.join(root, "private"), { mode: 0o700 });
    await fs.writeFile(
      path.join(root, "private", "secret.txt"),
      "owner-excluded-marker\n",
      { mode: 0o600 },
    );
    const chain = participants();
    const narrowing: AuthorityNarrowing = {
      workspaces: admission().workspaces,
      capabilities: admission().capabilities,
      network: "none",
      commands: "none",
      excludedPaths: [
        {
          workspaceId: "farol",
          path: `${root}/private`,
        },
      ],
    };
    const narrowed = delegateParticipantAuthority(chain.agent, {
      participantId: "critic-excluded",
      role: "critic",
      mutationOwnership: "none",
      narrowing,
    });
    if (!narrowed.ok) throw new Error(narrowed.error.code);
    const computer = contract(
      [...Object.values(chain), narrowed.value],
      approval(),
    );

    await expect(
      computer.execute(
        request(
          { kind: "workspace.list", relativePath: "." },
          "critic-excluded",
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        output: {
          kind: "workspace.entries",
          entries: ["README.md", "src/"],
        },
      },
    });
    await expect(
      computer.execute(
        request(
          {
            kind: "workspace.search",
            relativePath: ".",
            pattern: "owner-excluded-marker",
          },
          "critic-excluded",
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        output: { kind: "workspace.matches", matches: [] },
      },
    });
    await expect(
      computer.execute(
        request(
          { kind: "workspace.read", relativePath: "private/secret.txt" },
          "critic-excluded",
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "owner-restriction",
        retry: "never",
      },
    });
  });

  it("AUTH-02 refuses an excluded case alias before native execution", async () => {
    const currentApproval: ComputerApproval = {
      ...approval(),
      excludedPaths: [{ workspaceId: "farol", path: `${root}/private` }],
    };
    const grant = deriveTaskGrant(
      currentApproval,
      {
        ...admission(),
        workspaces: [
          {
            workspaceId: "farol",
            mode: "subtree",
            root: `${root}/PRIVATE`,
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
      },
      clock.now(),
    );
    if (!grant.ok) throw new Error(grant.error.code);
    const participant = createParticipantAuthority(grant.value, {
      participantId: "agent-alias",
      role: "agent",
      mutationOwnership: "none",
    });
    if (!participant.ok) throw new Error(participant.error.code);
    const execute = vi.fn<ReadonlyWorkspace["execute"]>(async () => ({
      ok: true,
      value: {
        kind: "workspace.text",
        text: "must not run",
        bytes: 12,
        sha256: createHash("sha256").update("must not run").digest("hex"),
      },
    }));
    const computer = contract([participant.value], currentApproval, {
      execute,
    });

    await expect(
      computer.execute(
        request(
          { kind: "workspace.read", relativePath: "secret.txt" },
          "agent-alias",
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "computer-approval",
        retry: "never",
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("attributes foreign identity and malformed paths without fallback execution", async () => {
    const chain = participants();
    const computer = contract(Object.values(chain), approval());

    await expect(
      computer.execute({
        ...request({ kind: "workspace.read", relativePath: "README.md" }),
        ownerId: "foreign-owner",
      }),
    ).resolves.toMatchObject({
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
    ).resolves.toMatchObject({
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

  it("preserves verification authority across Main Turn to Agent to Critic and honors later narrowing", async () => {
    const capabilities = [
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "verification.run",
    ] as const;
    const commandApproval: ComputerApproval = {
      ...approval(capabilities),
      commands: "verification",
    };
    const commandAdmission: TaskAdmission = {
      ...admission(),
      capabilities,
      commands: "verification",
    };
    const grant = deriveTaskGrant(
      commandApproval,
      commandAdmission,
      clock.now(),
    );
    if (!grant.ok) throw new Error(grant.error.code);
    const main = createParticipantAuthority(grant.value, {
      participantId: "main-command",
      role: "main",
      mutationOwnership: "none",
    });
    if (!main.ok) throw new Error(main.error.code);
    const agent = delegateParticipantAuthority(main.value, {
      participantId: "agent-command",
      role: "agent",
      mutationOwnership: "none",
    });
    if (!agent.ok) throw new Error(agent.error.code);
    const critic = delegateParticipantAuthority(agent.value, {
      participantId: "critic-command",
      role: "critic",
      mutationOwnership: "none",
    });
    if (!critic.ok) throw new Error(critic.error.code);
    const narrowed = delegateParticipantAuthority(agent.value, {
      participantId: "critic-command-narrowed",
      role: "critic",
      mutationOwnership: "none",
      narrowing: {
        workspaces: commandAdmission.workspaces,
        capabilities,
        network: "none",
        commands: "none",
      },
    });
    if (!narrowed.ok) throw new Error(narrowed.error.code);
    let calls = 0;
    const workspace: ReadonlyWorkspace = {
      async execute() {
        calls += 1;
        return {
          ok: true,
          value: {
            kind: "workspace.command",
            command: "git.status",
            relativePath: ".",
            exitCode: 0,
            stdout: "## main\n",
            stderr: "",
            outputBytes: 8,
            network: "none",
            coverage: "tracked-files-only",
            layout: "primary",
          },
        };
      },
    };
    const command = request(
      {
        kind: "verification.run",
        command: "git.status",
        relativePath: ".",
      },
      "critic-command",
    );
    const available = [main.value, agent.value, critic.value, narrowed.value];

    await expect(
      contract(available, commandApproval, workspace).execute(command),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        participantId: "critic-command",
        output: { kind: "workspace.command", command: "git.status" },
      },
    });
    expect(calls).toBe(1);

    await expect(
      contract(available, commandApproval, workspace).execute({
        ...command,
        participantId: "critic-command-narrowed",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_COMMAND_DENIED",
        source: "task-grant",
        retry: "never",
      },
    });
    await expect(
      contract(
        available,
        { ...commandApproval, commands: "none" },
        workspace,
      ).execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_COMMAND_DENIED",
        source: "computer-policy",
        retry: "never",
      },
    });
    expect(calls).toBe(1);
  });

  it.each([
    ["authority-missing", "COMPUTER_PARTICIPANT_NOT_FOUND"],
    ["authority-throw", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"],
    ["approval-missing", "COMPUTER_APPROVAL_NOT_FOUND"],
    ["approval-throw", "COMPUTER_APPROVAL_STORE_UNAVAILABLE"],
    ["root-changed", "WORKSPACE_ROOT_CHANGED"],
    ["scope-changed", "WORKSPACE_ROOT_CHANGED"],
    ["capability-revoked", "AUTHORITY_CAPABILITY_DENIED"],
    ["identity-changed", "AUTHORITY_TASK_MISMATCH"],
    ["both-generations-changed", "AUTHORITY_COMPUTER_MISMATCH"],
    ["ttl-renewed-after-expiry", "AUTHORITY_EXPIRED"],
    ["expired", "AUTHORITY_EXPIRED"],
    ["cancelled", "WORKSPACE_REQUEST_CANCELLED"],
  ])(
    "does not disclose read output after %s during native work",
    async (mode, code) => {
      const chain = participants();
      const participant = chain.critic;
      const approved = approval();
      let afterRead = false;
      const controller = new AbortController();
      const execute = vi.fn(async () => {
        afterRead = true;
        if (mode === "cancelled") controller.abort();
        return {
          ok: true as const,
          value: {
            kind: "workspace.text" as const,
            text: "must not disclose",
            bytes: 17,
            sha256: createHash("sha256")
              .update("must not disclose")
              .digest("hex"),
          },
        };
      });
      const action = new RunReadonlyComputerAction(
        {
          async get() {
            if (afterRead && mode === "authority-throw")
              throw new Error("unreadable");
            if (afterRead && mode === "authority-missing") return null;
            if (afterRead && mode === "identity-changed")
              return {
                ...participant,
                grant: { ...participant.grant, taskId: "foreign-task" },
              };
            if (afterRead && mode === "both-generations-changed")
              return {
                ...participant,
                grant: { ...participant.grant, computerGeneration: 8 },
              };
            if (afterRead && mode === "ttl-renewed-after-expiry")
              return {
                ...participant,
                grant: { ...participant.grant, expiresAt: 30_000 },
              };
            if (afterRead && mode === "scope-changed")
              return {
                ...participant,
                grant: {
                  ...participant.grant,
                  workspaces: [
                    {
                      workspaceId: "farol",
                      root,
                      mode: "exact" as const,
                      paths: [path.join(root, "README.md")],
                      access: "read" as const,
                      restrictionSource: "task-grant" as const,
                    },
                  ],
                },
              };
            return participant;
          },
          async admit() {
            throw new Error("unused");
          },
        },
        {
          async get() {
            if (afterRead && mode === "approval-throw")
              throw new Error("unreadable");
            if (afterRead && mode === "approval-missing") return null;
            if (afterRead && mode === "capability-revoked")
              return { ...approved, capabilities: [] };
            if (afterRead && mode === "root-changed")
              return {
                ...approved,
                workspaces: approved.workspaces.map((workspace) => ({
                  ...workspace,
                  rootIdentity: { ...workspace.rootIdentity, inode: "0" },
                })),
              };
            if (afterRead && mode === "both-generations-changed")
              return { ...approved, generation: 8 };
            return approved;
          },
        },
        { execute },
        {
          now: () =>
            afterRead && mode === "expired"
              ? 30000
              : afterRead && mode === "ttl-renewed-after-expiry"
                ? 10001
                : 1000,
        },
      );
      const result = await action.execute(
        request({ kind: "workspace.read", relativePath: "README.md" }),
        { signal: controller.signal },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code, retry: "never" },
      });
      expect(JSON.stringify(result)).not.toContain("must not disclose");
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("discards output when cancellation arrives during the final approval lookup", async () => {
    const chain = participants();
    const approved = approval();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let lookups = 0;
    const controller = new AbortController();
    const action = new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository(Object.values(chain)),
      {
        async get() {
          if (++lookups === 2) {
            entered();
            await gate;
          }
          return approved;
        },
      },
      {
        async execute() {
          return {
            ok: true,
            value: {
              kind: "workspace.text",
              text: "must not disclose",
              bytes: 17,
              sha256: createHash("sha256")
                .update("must not disclose")
                .digest("hex"),
            },
          };
        },
      },
      clock,
    );
    const pending = action.execute(
      request({ kind: "workspace.read", relativePath: "README.md" }),
      { signal: controller.signal },
    );
    await reached;
    controller.abort();
    release();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_REQUEST_CANCELLED" },
    });
    expect(JSON.stringify(result)).not.toContain("must not disclose");
  });

  it("classifies authority stores, missing policy, invalid targets and native refusals", async () => {
    const chain = participants();
    const available = new InMemoryAuthorityRepository(Object.values(chain));
    const approved = new InMemoryComputerApprovalRepository([approval()]);
    const successfulWorkspace: ReadonlyWorkspace = {
      async execute() {
        return {
          ok: true,
          value: {
            kind: "workspace.text",
            text: "ok",
            bytes: 2,
            sha256: createHash("sha256").update("ok").digest("hex"),
          },
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
