import { describe, expect, it, vi } from "vitest";
import { RunReadonlyComputerAction } from "../../../src/modules/computer/app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
} from "../../../src/modules/computer/domain/execution-authority";
import { InMemoryAuthorityRepository } from "../../../src/modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../../src/modules/computer/infra/repo/in-memory-computer-approvals";
import { ProductSettingsSchema } from "../../../src/pkg/product-settings/contract";
import type { ApprovedProductWorkspace } from "../../../src/pkg/product-settings/contract";
import type { ChatComputerAdmissionResponse } from "../bridge/wire";
import type {
  PendingChatGptAttachmentTask,
  PendingChatGptReadonlyTask,
} from "../configuration/chatgpt";
import { createReadonlyHost } from "./readonly";

// The read-only and attachment pending-task helpers over scripted owners. The
// pending task is a field the getter reads afresh and the setter clears, the
// confirmations are one real WeakMap shared by reference, the Go core and the
// legacy journal are fakes, and every effect appends to one ordered log. The
// authority constructors are the real ones; only the native workspace is fake.
// No window, provider, helper process or installed profile runs.

const admission: ChatComputerAdmissionResponse = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "1",
  participantId: "participant",
  turnId: "turn",
  generation: "1",
  admissionOperationId: "admission",
  storeRevision: "1",
};

const expiresAt = Date.parse("2026-11-24T10:00:00.000Z");

function readonlyTask(
  extra: Partial<PendingChatGptReadonlyTask> = {},
): PendingChatGptReadonlyTask {
  return {
    operationId: "7d9a9a52-5d7c-4d6b-9d1e-0c9c5a0f4a11",
    workspaceId: "workspace-1",
    workspaceLabel: "Project",
    computerGeneration: 3,
    relativePath: "README.md",
    bytes: 120,
    contextCharacters: 100,
    contextTruncated: false,
    excludedPaths: ["/work/project/.env"],
    prompt: "prompt text",
    chatGptVerification: {} as never,
    expiresAt,
    ...extra,
  };
}

function attachmentTask(): PendingChatGptAttachmentTask {
  return {
    operationId: "7d9a9a52-5d7c-4d6b-9d1e-0c9c5a0f4a12",
    attachments: {
      operationId: "7d9a9a52-5d7c-4d6b-9d1e-0c9c5a0f4a12",
      attachments: [
        {
          name: "a.png",
          mimeType: "image/png",
          bytes: 10,
          sha256: "a".repeat(64),
          stagedPath: "/staging/a.png",
        },
        {
          name: "b.png",
          mimeType: "image/png",
          bytes: 32,
          sha256: "b".repeat(64),
          stagedPath: "/staging/b.png",
        },
      ],
    },
    prompt: "prompt text",
    chatGptVerification: {} as never,
    expiresAt,
  };
}

type Confirmation = Readonly<{
  projection: () => {
    confirmationId: string;
    state: "observed" | "approved";
  } | null;
}>;

function build(
  options: Readonly<{
    pending?: PendingChatGptReadonlyTask | null;
    profile?: object | null;
    core?: {
      withdrawReadIntent: (
        value: ChatComputerAdmissionResponse,
      ) => Promise<void>;
    } | null;
    discard?: (operationId: string) => Promise<boolean>;
    confirmations?: WeakMap<PendingChatGptReadonlyTask, Confirmation>;
  }> = {},
) {
  const events: string[] = [];
  const state = {
    pending: options.pending === undefined ? null : options.pending,
  };
  const confirmations =
    options.confirmations ??
    new WeakMap<PendingChatGptReadonlyTask, Confirmation>();
  const workspaceRequests: unknown[] = [];
  const ports = {
    goChatStartupProfile: () =>
      options.profile === undefined ? {} : options.profile,
    desktopGoCore: () => (options.core === undefined ? null : options.core),
    readonlyAccountConfirmations: confirmations,
    pendingChatGptReadonlyTask: () => state.pending,
    setPendingChatGptReadonlyTask: vi.fn(
      (value: PendingChatGptReadonlyTask | null) => {
        events.push(`set ${value === null ? "null" : "task"}`);
        state.pending = value;
      },
    ),
    discardPreparedChatGptTask: vi.fn(
      options.discard ??
        ((operationId: string) => {
          events.push(`journal.discard ${operationId}`);
          return Promise.resolve(true);
        }),
    ),
    nativeWorkspace: {
      execute: vi.fn((request: unknown) => {
        workspaceRequests.push(request);
        return Promise.resolve({
          ok: false as const,
          error: {
            code: "WORKSPACE_HELPER_FAILED" as const,
            retry: "never" as const,
          },
        });
      }),
    },
    deriveTaskGrant: vi.fn(deriveTaskGrant),
    createParticipantAuthority: vi.fn(createParticipantAuthority),
    InMemoryAuthorityRepository,
    InMemoryComputerApprovalRepository,
    RunReadonlyComputerAction,
  };
  // The port types are the real classes', so a mismatch fails to compile.
  const host = createReadonlyHost(ports);
  return { host, ports, state, events, confirmations, workspaceRequests };
}

function core(events: string[], failure?: Error) {
  return {
    withdrawReadIntent: vi.fn((value: ChatComputerAdmissionResponse) => {
      events.push(`core.withdraw ${value.admissionOperationId}`);
      return failure ? Promise.reject(failure) : Promise.resolve();
    }),
  };
}

describe("chatGptReadonlyTaskPreview", () => {
  it("shows the pending task without an account while no confirmation exists", () => {
    const { host } = build();
    const pending = readonlyTask();
    expect(host.chatGptReadonlyTaskPreview(pending)).toEqual({
      kind: "chatgpt.readonly-task-preview",
      sendAvailable: false,
      operationId: pending.operationId,
      workspaceId: "workspace-1",
      workspaceLabel: "Project",
      relativePath: "README.md",
      bytes: 120,
      contextCharacters: 100,
      contextLimit: 24_000,
      contextTruncated: false,
      excludedPaths: ["/work/project/.env"],
      expiresAt: "2026-11-24T10:00:00.000Z",
    });
  });

  it("offers send only when the task holds a Go admission and the startup profile exists", () => {
    const withAdmission = readonlyTask({ goAdmission: admission });
    expect(
      build({ profile: {} }).host.chatGptReadonlyTaskPreview(withAdmission)
        .sendAvailable,
    ).toBe(true);
    expect(
      build({ profile: null }).host.chatGptReadonlyTaskPreview(withAdmission)
        .sendAvailable,
    ).toBe(false);
    expect(
      build({ profile: {} }).host.chatGptReadonlyTaskPreview(readonlyTask())
        .sendAvailable,
    ).toBe(false);
  });

  it("projects a pending then a confirmed account for the task that owns the confirmation", () => {
    const { host, confirmations } = build();
    const pending = readonlyTask({ goAdmission: admission });
    let state: "observed" | "approved" = "observed";
    confirmations.set(pending, {
      projection: () => ({ confirmationId: "confirmation-1", state }),
    });
    expect(host.chatGptReadonlyTaskPreview(pending).account).toEqual({
      confirmationId: "confirmation-1",
      state: "observed",
    });
    state = "approved";
    expect(host.chatGptReadonlyTaskPreview(pending).account).toEqual({
      confirmationId: "confirmation-1",
      state: "approved",
    });
  });

  it("omits the account when the confirmation has nothing to project", () => {
    const { host, confirmations } = build();
    const pending = readonlyTask();
    confirmations.set(pending, { projection: () => null });
    expect(host.chatGptReadonlyTaskPreview(pending)).not.toHaveProperty(
      "account",
    );
  });

  it("finds the confirmation by the task's identity, never by its content", () => {
    const { host, confirmations } = build();
    const pending = readonlyTask({ goAdmission: admission });
    confirmations.set(pending, {
      projection: () => ({
        confirmationId: "confirmation-1",
        state: "observed",
      }),
    });
    const twin = { ...pending };
    expect(twin).toEqual(pending);
    expect(host.chatGptReadonlyTaskPreview(twin)).not.toHaveProperty("account");
    expect(host.chatGptReadonlyTaskPreview(pending)).toHaveProperty("account");
  });

  it("reads main's own WeakMap by reference, so an entry added after creation is seen", () => {
    const confirmations = new WeakMap<
      PendingChatGptReadonlyTask,
      Confirmation
    >();
    const { host } = build({ confirmations });
    const pending = readonlyTask();
    expect(host.chatGptReadonlyTaskPreview(pending)).not.toHaveProperty(
      "account",
    );
    confirmations.set(pending, {
      projection: () => ({ confirmationId: "late", state: "observed" }),
    });
    expect(host.chatGptReadonlyTaskPreview(pending).account).toEqual({
      confirmationId: "late",
      state: "observed",
    });
  });

  it("reads the startup profile afresh at every call", () => {
    let profile: object | null = null;
    const live = createReadonlyHost({
      ...build().ports,
      goChatStartupProfile: () => profile,
    });
    const pending = readonlyTask({ goAdmission: admission });
    expect(live.chatGptReadonlyTaskPreview(pending).sendAvailable).toBe(false);
    profile = {};
    expect(live.chatGptReadonlyTaskPreview(pending).sendAvailable).toBe(true);
  });
});

describe("chatGptAttachmentTaskPreview", () => {
  it("lists each attachment without its staged path and totals the bytes", () => {
    const { host } = build();
    const pending = attachmentTask();
    const preview = host.chatGptAttachmentTaskPreview(pending);
    expect(preview).toEqual({
      kind: "chatgpt.attachment-task-preview",
      operationId: pending.operationId,
      attachments: [
        {
          name: "a.png",
          mimeType: "image/png",
          bytes: 10,
          sha256: "a".repeat(64),
        },
        {
          name: "b.png",
          mimeType: "image/png",
          bytes: 32,
          sha256: "b".repeat(64),
        },
      ],
      totalBytes: 42,
      expiresAt: "2026-11-24T10:00:00.000Z",
    });
    expect(JSON.stringify(preview)).not.toContain("/staging/");
  });

  it("totals nothing for an empty attachment list", () => {
    const { host } = build();
    const pending = attachmentTask();
    const preview = host.chatGptAttachmentTaskPreview({
      ...pending,
      attachments: { ...pending.attachments, attachments: [] },
    });
    expect(preview).toMatchObject({ attachments: [], totalBytes: 0 });
  });
});

describe("withdrawGoReadonlyAdmission", () => {
  it("has nothing to withdraw without an admission, and does not touch the core", async () => {
    const events: string[] = [];
    const fake = core(events);
    const { host } = build({ core: fake });
    await expect(host.withdrawGoReadonlyAdmission(undefined)).resolves.toBe(
      true,
    );
    expect(fake.withdrawReadIntent).not.toHaveBeenCalled();
  });

  it("is not withdrawn while no Go core runs", async () => {
    const { host } = build({ core: null });
    await expect(host.withdrawGoReadonlyAdmission(admission)).resolves.toBe(
      false,
    );
  });

  it("withdraws the exact admission through the core", async () => {
    const events: string[] = [];
    const fake = core(events);
    const { host } = build({ core: fake });
    await expect(host.withdrawGoReadonlyAdmission(admission)).resolves.toBe(
      true,
    );
    expect(fake.withdrawReadIntent).toHaveBeenCalledExactlyOnceWith(admission);
  });

  it("answers false when the core refuses, and does not repeat", async () => {
    const events: string[] = [];
    const fake = core(events, new Error("refused"));
    const { host } = build({ core: fake });
    await expect(host.withdrawGoReadonlyAdmission(admission)).resolves.toBe(
      false,
    );
    expect(fake.withdrawReadIntent).toHaveBeenCalledTimes(1);
  });
});

describe("discardPreparedReadonlyTask", () => {
  it("withdraws a Go task and clears it without touching the legacy journal", async () => {
    const pending = readonlyTask({ goAdmission: admission });
    const s = build({ pending });
    const fake = core(s.events);
    const live = createReadonlyHost({ ...s.ports, desktopGoCore: () => fake });
    await expect(live.discardPreparedReadonlyTask(pending)).resolves.toBe(true);
    expect(s.events).toEqual([`core.withdraw admission`, "set null"]);
    expect(s.ports.discardPreparedChatGptTask).not.toHaveBeenCalled();
    expect(s.state.pending).toBeNull();
  });

  it("discards a legacy task from the journal and clears it", async () => {
    const pending = readonlyTask();
    const s = build({ pending });
    await expect(s.host.discardPreparedReadonlyTask(pending)).resolves.toBe(
      true,
    );
    expect(s.events).toEqual([
      `journal.discard ${pending.operationId}`,
      "set null",
    ]);
    expect(s.state.pending).toBeNull();
  });

  it("keeps the task when the Go withdrawal fails, and never reaches the journal", async () => {
    const pending = readonlyTask({ goAdmission: admission });
    const s = build({ pending });
    const fake = core(s.events, new Error("refused"));
    const live = createReadonlyHost({ ...s.ports, desktopGoCore: () => fake });
    await expect(live.discardPreparedReadonlyTask(pending)).resolves.toBe(
      false,
    );
    expect(s.state.pending).toBe(pending);
    expect(s.ports.discardPreparedChatGptTask).not.toHaveBeenCalled();
    expect(s.events).toEqual(["core.withdraw admission"]);
  });

  it("keeps the task when the journal refuses the discard", async () => {
    const pending = readonlyTask();
    const s = build({ pending, discard: () => Promise.resolve(false) });
    await expect(s.host.discardPreparedReadonlyTask(pending)).resolves.toBe(
      false,
    );
    expect(s.state.pending).toBe(pending);
    expect(s.ports.setPendingChatGptReadonlyTask).not.toHaveBeenCalled();
  });

  it("is already gone when no task is pending, and clears nothing", async () => {
    const pending = readonlyTask();
    const s = build({ pending: null });
    await expect(s.host.discardPreparedReadonlyTask(pending)).resolves.toBe(
      true,
    );
    expect(s.ports.setPendingChatGptReadonlyTask).not.toHaveBeenCalled();
    expect(s.state.pending).toBeNull();
  });

  it("does not clear a different task that took the place while the journal waited", async () => {
    const pending = readonlyTask();
    const replacement = readonlyTask({ operationId: "replacement" });
    let release: (value: boolean) => void = () => undefined;
    const s = build({
      pending,
      discard: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    const result = s.host.discardPreparedReadonlyTask(pending);
    await vi.waitFor(() =>
      expect(s.ports.discardPreparedChatGptTask).toHaveBeenCalledTimes(1),
    );
    s.state.pending = replacement;
    release(true);
    await expect(result).resolves.toBe(true);
    expect(s.state.pending).toBe(replacement);
    expect(s.ports.setPendingChatGptReadonlyTask).not.toHaveBeenCalled();
  });

  it("answers a repeated request with the first attempt, never a second try", async () => {
    const pending = readonlyTask();
    let calls = 0;
    const s = build({
      pending,
      discard: () => {
        calls += 1;
        return Promise.resolve(false);
      },
    });
    const first = s.host.discardPreparedReadonlyTask(pending);
    const second = s.host.discardPreparedReadonlyTask(pending);
    expect(second).toBe(first);
    await expect(first).resolves.toBe(false);
    // A retained failure stays retained: the owner's repetition is not a retry.
    await expect(s.host.discardPreparedReadonlyTask(pending)).resolves.toBe(
      false,
    );
    expect(calls).toBe(1);
  });

  it("keeps each task's attempt apart", async () => {
    const one = readonlyTask({ operationId: "one" });
    const two = readonlyTask({ operationId: "two" });
    const s = build({ pending: one });
    await s.host.discardPreparedReadonlyTask(one);
    await s.host.discardPreparedReadonlyTask(two);
    expect(s.ports.discardPreparedChatGptTask).toHaveBeenCalledTimes(2);
  });
});

describe("verificationWorkspaceAction", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const writable = "33333333-3333-4333-8333-333333333333";
  const unknown = "44444444-4444-4444-8444-444444444444";
  const computerId = "00000000-0000-4000-8000-000000000002";
  const root = "/work/project";
  const identity = { device: "16777233", inode: "335036" };

  function workspace(
    extra: Record<string, unknown> = {},
  ): ApprovedProductWorkspace {
    return {
      workspaceId,
      root,
      label: "Project",
      access: "read",
      excludedPaths: [`${root}/.env`],
      rootIdentity: identity,
      ...extra,
    } as ApprovedProductWorkspace;
  }

  function settings(
    commands: "none" | "verification" | "workspace",
    workspaces: readonly ApprovedProductWorkspace[],
  ) {
    const step = {
      visited: true,
      skipped: false,
      configured: true,
      reachable: "reachable",
      verified: null,
      needsAction: null,
      unavailable: null,
      outcomeUnknown: false,
    };
    return ProductSettingsSchema.parse({
      schema: 1,
      revision: 1,
      general: {
        openAtLaunch: "browser",
        sidebarDefault: "full",
        activityDetail: "summary",
      },
      computer: {
        computerId,
        generation: 4,
        name: "This Mac",
        commands,
        workspaces,
      },
      setup: {
        journey: { currentStep: "verify", dismissed: false },
        chatgpt: step,
        computer: step,
        connect: step,
        hosts: step,
        verify: step,
      },
    });
  }

  const future = () => Date.now() + 60_000;

  it("has no action when commands are off, and derives nothing", () => {
    const s = build();
    const value = settings("none", [workspace()]);
    expect(
      s.host.verificationWorkspaceAction(
        value,
        value.computer.workspaces[0]!,
        future(),
      ),
    ).toBeNull();
    expect(s.ports.deriveTaskGrant).not.toHaveBeenCalled();
  });

  it("approves read capabilities only, over the identity-bound folders", () => {
    const s = build();
    const value = settings("verification", [
      workspace(),
      workspace({ workspaceId: other, rootIdentity: undefined }),
    ]);
    const until = future();
    const action = s.host.verificationWorkspaceAction(
      value,
      value.computer.workspaces[0]!,
      until,
    );
    expect(action).not.toBeNull();
    const [approval, admission] = s.ports.deriveTaskGrant.mock.calls[0]!;
    expect(approval).toEqual({
      ownerId: "owner-desktop",
      computerId,
      generation: 4,
      workspaces: [
        {
          workspaceId,
          root,
          access: "read",
          rootIdentity: identity,
        },
      ],
      excludedPaths: [{ workspaceId, path: `${root}/.env` }],
      capabilities: [
        "workspace.list",
        "workspace.read",
        "workspace.search",
        "verification.run",
      ],
      network: "none",
      commands: "verification",
      expiresAt: until,
    });
    expect(admission).toEqual({
      authorityId: "desktop-command-authority-4",
      ownerId: "owner-desktop",
      sessionId: "desktop-command-session",
      taskId: "desktop-command-task",
      taskEpoch: 4,
      computerId,
      computerGeneration: 4,
      workspaces: [{ workspaceId, mode: "subtree", root, access: "read" }],
      excludedPaths: [{ workspaceId, path: `${root}/.env` }],
      capabilities: ["verification.run"],
      network: "none",
      commands: "verification",
      expiresAt: until,
    });
    expect(s.ports.createParticipantAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ authorityId: "desktop-command-authority-4" }),
      {
        participantId: "desktop-command-main",
        role: "main",
        mutationOwnership: "none",
      },
    );
  });

  it("adds the write capability to the approval when any approved folder is writable", () => {
    const s = build();
    const value = settings("workspace", [
      workspace(),
      workspace({ workspaceId: writable, access: "write" }),
    ]);
    s.host.verificationWorkspaceAction(
      value,
      value.computer.workspaces[0]!,
      future(),
    );
    const [approval, admission] = s.ports.deriveTaskGrant.mock.calls[0]!;
    expect(approval.capabilities).toEqual([
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "verification.run",
      "workspace.write",
    ]);
    expect(approval.commands).toBe("workspace");
    // The task itself is never wider than reading and verifying.
    expect(admission.capabilities).toEqual(["verification.run"]);
  });

  it("carries a linked worktree's Git metadata into the approval", () => {
    const s = build();
    const gitMetadata = {
      gitDirectory: "/work/project.git/worktrees/a",
      commonDirectory: "/work/project.git",
    };
    const value = settings("verification", [workspace({ gitMetadata })]);
    s.host.verificationWorkspaceAction(
      value,
      value.computer.workspaces[0]!,
      future(),
    );
    expect(
      s.ports.deriveTaskGrant.mock.calls[0]![0].workspaces[0],
    ).toMatchObject({ gitMetadata });
  });

  it("has no action when the grant cannot be derived", () => {
    const s = build();
    const value = settings("verification", [workspace()]);
    expect(
      s.host.verificationWorkspaceAction(
        value,
        value.computer.workspaces[0]!,
        Date.now() - 1,
      ),
    ).toBeNull();
    expect(s.ports.createParticipantAuthority).not.toHaveBeenCalled();
  });

  it("has no action when the participant cannot be created", () => {
    const s = build();
    const failing = createReadonlyHost({
      ...s.ports,
      createParticipantAuthority: vi.fn(() => ({ ok: false as const })),
    });
    const value = settings("verification", [workspace()]);
    expect(
      failing.verificationWorkspaceAction(
        value,
        value.computer.workspaces[0]!,
        future(),
      ),
    ).toBeNull();
  });

  it("runs the verification through the one native workspace, for the folder approved", async () => {
    const s = build();
    const value = settings("verification", [workspace()]);
    const action = s.host.verificationWorkspaceAction(
      value,
      value.computer.workspaces[0]!,
      future(),
    );
    const result = await action!.execute({
      ownerId: "owner-desktop",
      sessionId: "desktop-command-session",
      taskId: "desktop-command-task",
      taskEpoch: 4,
      participantId: "desktop-command-main",
      turnId: "turn",
      generation: 4,
      callId: "call",
      workspaceId,
      operation: {
        kind: "verification.run",
        command: "git.status",
        relativePath: ".",
      },
    });
    expect(s.workspaceRequests).toHaveLength(1);
    expect(s.workspaceRequests[0]).toMatchObject({
      workspace: {
        workspaceId,
        root,
        deniedPaths: [".env"],
        approvedRoot: { path: root, ...identity },
      },
      operation: { kind: "verification.run", command: "git.status" },
    });
    // The fake helper failed, and that failure is the action's own answer.
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a folder the task was not admitted for", async () => {
    const s = build();
    const value = settings("verification", [workspace()]);
    const action = s.host.verificationWorkspaceAction(
      value,
      value.computer.workspaces[0]!,
      future(),
    );
    const result = await action!.execute({
      ownerId: "owner-desktop",
      sessionId: "desktop-command-session",
      taskId: "desktop-command-task",
      taskEpoch: 4,
      participantId: "desktop-command-main",
      turnId: "turn",
      generation: 4,
      callId: "call",
      workspaceId: unknown,
      operation: {
        kind: "verification.run",
        command: "git.head",
        relativePath: ".",
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED" },
    });
    expect(s.workspaceRequests).toHaveLength(0);
  });
});
