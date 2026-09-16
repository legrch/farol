import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MutableWorkspace } from "../../src/modules/computer/app/port/mutable-workspace";
import type { AuthorityRepository } from "../../src/modules/computer/app/port/authority-repository";
import type { ComputerApprovalRepository } from "../../src/modules/computer/app/port/computer-approval-repository";
import type {
  StoredWorkspaceMutation,
  WorkspaceMutationDigester,
  WorkspaceMutationRepository,
} from "../../src/modules/computer/app/port/workspace-mutation-repository";
import { RunMutableComputerAction } from "../../src/modules/computer/app/service/run-mutable-computer-action";
import {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type ParticipantAuthority,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { Sha256WorkspaceMutationDigester } from "../../src/modules/computer/infra/native/sha256-workspace-mutation-digester";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../src/modules/computer/infra/repo/in-memory-computer-approvals";
import { InMemoryWorkspaceMutationRepository } from "../../src/modules/computer/infra/repo/in-memory-workspace-mutations";
import { PrivateWorkspaceMutationStore } from "../../src/modules/computer/infra/repo/private-workspace-mutation-store";

const clock = { now: () => 1_000 };
const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
let root = "";
let stateRoot = "";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function approval(
  access: "read" | "write" = "write",
  capabilities: ComputerApproval["capabilities"] = [
    "workspace.read",
    "workspace.write",
  ],
): ComputerApproval {
  return {
    ownerId: "owner-preview",
    computerId: "computer-preview",
    generation: 7,
    workspaces: [{ workspaceId: "farol", root, access }],
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
        access: "write",
      },
    ],
    capabilities: ["workspace.read", "workspace.write"],
    network: "none",
    commands: "none",
    expiresAt: 10_000,
  };
}

function participants(
  criticMutationOwnership: "none" | "task" = "task",
): readonly ParticipantAuthority[] {
  const grant = deriveTaskGrant(approval(), admission(), clock.now());
  if (!grant.ok) throw new Error(grant.error.code);
  const main = createParticipantAuthority(grant.value, {
    participantId: "main-a",
    role: "main",
    mutationOwnership: "task",
  });
  if (!main.ok) throw new Error(main.error.code);
  const agent = delegateParticipantAuthority(main.value, {
    participantId: "agent-a",
    role: "agent",
    mutationOwnership: "task",
  });
  if (!agent.ok) throw new Error(agent.error.code);
  const critic = delegateParticipantAuthority(agent.value, {
    participantId: "critic-a",
    role: "critic",
    mutationOwnership: criticMutationOwnership,
  });
  if (!critic.ok) throw new Error(critic.error.code);
  return [main.value, agent.value, critic.value];
}

function request(
  content = "after\n",
  operationId = "mutation-a",
  callId = "call-a",
) {
  return {
    operationId,
    ownerId: "owner-preview",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 3,
    participantId: "critic-a",
    turnId: "turn-a",
    generation: 2,
    callId,
    workspaceId: "farol",
    operation: {
      kind: "workspace.write" as const,
      relativePath: "README.md",
      content,
      expectedSha256: digest("before\n"),
    },
  };
}

function successfulWorkspace() {
  let calls = 0;
  const workspace: MutableWorkspace = {
    async mutate(candidate) {
      calls += 1;
      return {
        ok: true,
        value: {
          kind: "workspace.mutation",
          operation:
            candidate.operation.kind === "workspace.write" ? "write" : "edit",
          relativePath: candidate.operation.relativePath,
          bytes: 6,
          replacements:
            candidate.operation.kind === "workspace.write"
              ? 0
              : candidate.operation.edits.length,
          beforeSha256: candidate.operation.expectedSha256,
          afterSha256: digest("after\n"),
        },
      };
    },
  };
  return { workspace, calls: () => calls };
}

function service(
  workspace: MutableWorkspace,
  mutations: WorkspaceMutationRepository,
  currentApproval: ComputerApproval = approval(),
  availableParticipants: readonly ParticipantAuthority[] = participants(),
) {
  return new RunMutableComputerAction(
    new InMemoryAuthorityRepository(availableParticipants),
    new InMemoryComputerApprovalRepository([currentApproval]),
    mutations,
    new Sha256WorkspaceMutationDigester(),
    workspace,
    clock,
  );
}

function customService(
  workspace: MutableWorkspace,
  options: Readonly<{
    authorities?: AuthorityRepository;
    approvals?: ComputerApprovalRepository;
    mutations?: WorkspaceMutationRepository;
    digester?: WorkspaceMutationDigester;
  }> = {},
) {
  return new RunMutableComputerAction(
    options.authorities ?? new InMemoryAuthorityRepository(participants()),
    options.approvals ?? new InMemoryComputerApprovalRepository([approval()]),
    options.mutations ?? new InMemoryWorkspaceMutationRepository(),
    options.digester ?? new Sha256WorkspaceMutationDigester(),
    workspace,
    clock,
  );
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-action-mutation-")),
  );
  stateRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-mutation-state-")),
  );
  await fs.chmod(root, 0o700);
  await fs.chmod(stateRoot, 0o700);
  await fs.writeFile(path.join(root, "README.md"), "before\n", { mode: 0o600 });
});

afterEach(async () => {
  await Promise.all(
    [root, stateRoot]
      .filter(Boolean)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("authorized mutable Computer action", () => {
  it("composes authority, durable admission and the attested native mutation", async () => {
    const native = new NativeReadonlyWorkspace({
      helperPath: sourceHelper,
      helper: NEXT_SAFE_OPEN_HELPER,
      attestInterpreter: async () => "/usr/bin/python3",
    });
    await expect(
      service(
        native,
        new PrivateWorkspaceMutationStore({ root: stateRoot }),
      ).execute(request()),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        resultRetention: "durable",
        receipt: { afterSha256: digest("after\n") },
      },
    });
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(
      "after\n",
    );
  });

  it("passes task-grant exclusions to the native mutation boundary", async () => {
    const available = participants().map((participant) =>
      participant.participantId === "critic-a"
        ? {
            ...participant,
            grant: {
              ...participant.grant,
              excludedPaths: [
                {
                  workspaceId: "farol",
                  path: `${root}/private`,
                  restrictionSource: "task-grant" as const,
                },
                {
                  workspaceId: "another-workspace",
                  path: "/outside",
                  restrictionSource: "task-grant" as const,
                },
              ],
            },
          }
        : participant,
    );
    const workspace: MutableWorkspace = {
      async mutate(candidate) {
        expect(candidate.workspace.deniedPaths).toEqual(["private"]);
        return {
          ok: true,
          value: {
            kind: "workspace.mutation",
            operation: "write",
            relativePath: "README.md",
            bytes: 6,
            replacements: 0,
            beforeSha256: digest("before\n"),
            afterSha256: digest("after\n"),
          },
        };
      },
    };
    await expect(
      service(
        workspace,
        new InMemoryWorkspaceMutationRepository(),
        approval(),
        available,
      ).execute(request()),
    ).resolves.toMatchObject({ ok: true });
  });

  it("preserves write authority across Main to Agent to Critic and stores a content-free terminal receipt", async () => {
    const native = successfulWorkspace();
    const mutations = new PrivateWorkspaceMutationStore({ root: stateRoot });
    const result = await service(native.workspace, mutations).execute(
      request(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        participantId: "critic-a",
        operationId: "mutation-a",
        callId: "call-a",
        resultRetention: "durable",
        redelivered: false,
        receipt: {
          operation: "write",
          relativePath: "README.md",
          beforeSha256: digest("before\n"),
          afterSha256: digest("after\n"),
        },
      },
    });
    expect(native.calls()).toBe(1);
    const files = await fs.readdir(path.join(stateRoot, "mutations"));
    const persisted = await fs.readFile(
      path.join(stateRoot, "mutations", files[0] as string),
      "utf8",
    );
    expect(persisted).not.toContain("after\\n");
    expect(persisted).not.toContain('"content"');
  });

  it("redelivers one durable result after restart without executing the mutation again", async () => {
    const firstNative = successfulWorkspace();
    await expect(
      service(
        firstNative.workspace,
        new PrivateWorkspaceMutationStore({ root: stateRoot }),
      ).execute(request()),
    ).resolves.toMatchObject({ ok: true });
    expect(firstNative.calls()).toBe(1);

    const restartedNative = successfulWorkspace();
    await expect(
      service(
        restartedNative.workspace,
        new PrivateWorkspaceMutationStore({ root: stateRoot }),
      ).execute(request("after\n", "mutation-a", "call-after-restart")),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        callId: "call-after-restart",
        redelivered: true,
        resultRetention: "durable",
      },
    });
    expect(restartedNative.calls()).toBe(0);
  });

  it("turns an interrupted prepared record into a durable unknown tombstone without executing", async () => {
    const mutations = new PrivateWorkspaceMutationStore({ root: stateRoot });
    const command = request();
    const requestDigest = new Sha256WorkspaceMutationDigester().digest({
      workspaceId: command.workspaceId,
      operation: command.operation,
    });
    await mutations.admit({
      identity: {
        operationId: command.operationId,
        ownerId: command.ownerId,
        sessionId: command.sessionId,
        taskId: command.taskId,
        taskEpoch: command.taskEpoch,
        participantId: command.participantId,
      },
      workspaceId: command.workspaceId,
      requestDigest,
      phase: "prepared",
      outcome: null,
    });
    const native = successfulWorkspace();

    await expect(
      service(native.workspace, mutations).execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
        source: "operation-store",
        retry: "never",
      },
    });
    expect(native.calls()).toBe(0);
    await expect(
      service(native.workspace, mutations).execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
        source: "operation-store",
      },
    });
    expect(native.calls()).toBe(0);
  });

  it("rejects mutation ownership loss, current read-only policy and operation-id rebinding before native execution", async () => {
    for (const candidate of [
      {
        currentApproval: approval(),
        availableParticipants: participants("none"),
        expected: {
          code: "AUTHORITY_MUTATION_OWNERSHIP_DENIED",
          source: "role",
        },
      },
      {
        currentApproval: approval("read", [
          "workspace.read",
          "workspace.write",
        ]),
        availableParticipants: participants(),
        expected: { code: "AUTHORITY_PATH_DENIED", source: "computer-policy" },
      },
    ] as const) {
      const native = successfulWorkspace();
      await expect(
        service(
          native.workspace,
          new InMemoryWorkspaceMutationRepository(),
          candidate.currentApproval,
          candidate.availableParticipants,
        ).execute(request()),
      ).resolves.toMatchObject({ ok: false, error: candidate.expected });
      expect(native.calls()).toBe(0);
    }

    const native = successfulWorkspace();
    const mutations = new InMemoryWorkspaceMutationRepository();
    await expect(
      service(native.workspace, mutations).execute(request()),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      service(native.workspace, mutations).execute(
        request("different payload\n", "mutation-a", "call-b"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "COMPUTER_MUTATION_OPERATION_CONFLICT",
        source: "operation-store",
      },
    });
    expect(native.calls()).toBe(1);
  });

  it("coalesces the same in-flight operation and rejects concurrent rebinding", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const workspace: MutableWorkspace = {
      async mutate() {
        calls += 1;
        await gate;
        return {
          ok: true,
          value: {
            kind: "workspace.mutation",
            operation: "write",
            relativePath: "README.md",
            bytes: 6,
            replacements: 0,
            beforeSha256: digest("before\n"),
            afterSha256: digest("after\n"),
          },
        };
      },
    };
    const runner = customService(workspace);
    const first = runner.execute(request());
    const joined = runner.execute(request("after\n", "mutation-a", "call-b"));
    await expect(
      runner.execute(request("different\n", "mutation-a", "conflicting-call")),
    ).resolves.toMatchObject({
      error: { code: "COMPUTER_MUTATION_OPERATION_CONFLICT" },
    });
    release();
    await expect(first).resolves.toMatchObject({
      ok: true,
      value: { callId: "call-a", redelivered: false },
    });
    await expect(joined).resolves.toMatchObject({
      ok: true,
      value: { callId: "call-b", redelivered: true },
    });
    expect(calls).toBe(1);
  });

  it("classifies pre-admission infrastructure and authority failures without mutation", async () => {
    const native = successfulWorkspace();
    const unavailableAuthorities: AuthorityRepository = {
      async get() {
        throw new Error("unavailable");
      },
      async admit() {
        throw new Error("unused");
      },
    };
    const unavailableApprovals: ComputerApprovalRepository = {
      async get() {
        throw new Error("unavailable");
      },
    };
    const unavailableMutations: WorkspaceMutationRepository = {
      async load() {
        throw new Error("unavailable");
      },
      async admit() {
        throw new Error("unused");
      },
      async save() {
        throw new Error("unused");
      },
    };
    const cases = [
      {
        runner: customService(native.workspace, {
          digester: {
            digest() {
              throw new Error("unavailable");
            },
          },
        }),
        command: request(),
        code: "COMPUTER_MUTATION_FINGERPRINT_FAILED",
      },
      {
        runner: customService(native.workspace, {
          mutations: unavailableMutations,
        }),
        command: request(),
        code: "COMPUTER_MUTATION_STORE_UNAVAILABLE",
      },
      {
        runner: customService(native.workspace, {
          authorities: unavailableAuthorities,
        }),
        command: request(),
        code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE",
      },
      {
        runner: customService(native.workspace, {
          authorities: new InMemoryAuthorityRepository(),
        }),
        command: request(),
        code: "COMPUTER_PARTICIPANT_NOT_FOUND",
      },
      {
        runner: customService(native.workspace),
        command: { ...request(), ownerId: "foreign-owner" },
        code: "AUTHORITY_OWNER_MISMATCH",
      },
      {
        runner: customService(native.workspace),
        command: { ...request(), workspaceId: "missing-workspace" },
        code: "AUTHORITY_PATH_DENIED",
      },
      {
        runner: customService(native.workspace),
        command: {
          ...request(),
          operation: { ...request().operation, relativePath: "../README.md" },
        },
        code: "COMPUTER_PATH_INVALID",
      },
      {
        runner: customService(native.workspace, {
          approvals: unavailableApprovals,
        }),
        command: request(),
        code: "COMPUTER_APPROVAL_STORE_UNAVAILABLE",
      },
      {
        runner: customService(native.workspace, {
          approvals: new InMemoryComputerApprovalRepository(),
        }),
        command: request(),
        code: "COMPUTER_APPROVAL_NOT_FOUND",
      },
    ] as const;
    for (const candidate of cases) {
      await expect(
        candidate.runner.execute(candidate.command),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: candidate.code, retry: "never" },
      });
    }
    expect(native.calls()).toBe(0);
  });

  it("stores deterministic and unknown native failures and never repeats either", async () => {
    for (const candidate of [
      {
        operationId: "deterministic-failure",
        code: "WORKSPACE_PATH_REFUSED" as const,
        workspace: {
          async mutate() {
            return {
              ok: false as const,
              error: {
                code: "WORKSPACE_PATH_REFUSED" as const,
                retry: "never" as const,
              },
            };
          },
        },
      },
      {
        operationId: "unknown-failure",
        code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" as const,
        workspace: {
          async mutate(): Promise<never> {
            throw new Error("transport lost");
          },
        },
      },
    ]) {
      let calls = 0;
      const workspace: MutableWorkspace = {
        async mutate(command) {
          calls += 1;
          return (candidate.workspace as MutableWorkspace).mutate(command);
        },
      };
      const mutations = new InMemoryWorkspaceMutationRepository();
      const command = request("after\n", candidate.operationId);
      await expect(
        customService(workspace, { mutations }).execute(command),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: candidate.code, source: "native-workspace" },
      });
      await expect(
        customService(workspace, { mutations }).execute(command),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: candidate.code },
      });
      expect(calls).toBe(1);
    }
  });

  it("fails closed on admission loss and reports memory-only success on terminal-store loss", async () => {
    const native = successfulWorkspace();
    const admissionFailure: WorkspaceMutationRepository = {
      async load() {
        return null;
      },
      async admit() {
        throw new Error("disk unavailable");
      },
      async save() {
        throw new Error("unused");
      },
    };
    await expect(
      customService(native.workspace, { mutations: admissionFailure }).execute(
        request(),
      ),
    ).resolves.toMatchObject({
      error: { code: "COMPUTER_MUTATION_STORE_UNAVAILABLE" },
    });
    expect(native.calls()).toBe(0);

    const backing = new InMemoryWorkspaceMutationRepository();
    const terminalFailure: WorkspaceMutationRepository = {
      load: (identity) => backing.load(identity),
      admit: (record) => backing.admit(record),
      async save() {
        throw new Error("disk unavailable");
      },
    };
    await expect(
      customService(native.workspace, { mutations: terminalFailure }).execute(
        request("after\n", "memory-only"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { resultRetention: "memory_only" },
    });
    expect(native.calls()).toBe(1);
  });

  it("handles an admission race as an existing prepared operation", async () => {
    const command = request("after\n", "admission-race");
    const requestDigest = new Sha256WorkspaceMutationDigester().digest({
      workspaceId: command.workspaceId,
      operation: command.operation,
    });
    const existing: StoredWorkspaceMutation = {
      identity: {
        operationId: command.operationId,
        ownerId: command.ownerId,
        sessionId: command.sessionId,
        taskId: command.taskId,
        taskEpoch: command.taskEpoch,
        participantId: command.participantId,
      },
      workspaceId: command.workspaceId,
      requestDigest,
      phase: "prepared",
      outcome: null,
    };
    const raced: WorkspaceMutationRepository = {
      async load() {
        return null;
      },
      async admit() {
        return { status: "existing", record: existing };
      },
      async save() {},
    };
    const native = successfulWorkspace();
    await expect(
      customService(native.workspace, { mutations: raced }).execute(command),
    ).resolves.toMatchObject({
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" },
    });
    expect(native.calls()).toBe(0);
  });

  it("fingerprints edit content and edit order independently", () => {
    const digester = new Sha256WorkspaceMutationDigester();
    const first = digester.digest({
      workspaceId: "farol",
      operation: {
        kind: "workspace.edit",
        relativePath: "README.md",
        expectedSha256: digest("before\n"),
        edits: [
          { oldText: "before", newText: "after" },
          { oldText: "one", newText: "two" },
        ],
      },
    });
    const reordered = digester.digest({
      workspaceId: "farol",
      operation: {
        kind: "workspace.edit",
        relativePath: "README.md",
        expectedSha256: digest("before\n"),
        edits: [
          { oldText: "one", newText: "two" },
          { oldText: "before", newText: "after" },
        ],
      },
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(reordered).not.toBe(first);
  });
});
