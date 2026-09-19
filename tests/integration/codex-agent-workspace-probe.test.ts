import { describe, expect, it, vi } from "vitest";

import type { DelegatedAgentAuthority } from "../../src/modules/agent/app/port/execution-authority";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";
import {
  CodexAgentWorkspaceProbe,
  participant,
} from "../../src/apps/desktop/codex-agent-workspace-probe";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const referenceId = "00000000-0000-4000-8000-000000000002";

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
    computerId: "00000000-0000-4000-8000-000000000010",
    generation: 7,
    name: "This Mac",
    workspaces: [
      {
        workspaceId,
        root: "/workspace/primary",
        label: "Primary",
        access: "read",
        excludedPaths: ["/workspace/primary/private"],
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

const authority: DelegatedAgentAuthority = {
  authorityId: "authority-a",
  participantId: "critic-a",
  parentParticipantId: "agent-a",
  role: "critic",
  mutationOwnership: "none",
  ownerId: "owner-desktop",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 7,
  computerId: settings.computer.computerId,
  computerGeneration: 7,
  workspaces: settings.computer.workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    mode: "subtree" as const,
    root: workspace.root,
    access: "read" as const,
  })),
  excludedPaths: [{ workspaceId, path: "/workspace/primary/private" }],
  capabilities: ["workspace.list", "workspace.read", "workspace.search"],
  network: "none",
  commands: "none",
  expiresAt: 10_000,
};

function request(overrides: Partial<DelegatedAgentAuthority> = {}) {
  return {
    identity: {
      assignmentId: "assignment-a",
      ownerId: "owner-desktop",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 7,
      generation: 1,
    },
    authority: { ...authority, ...overrides },
    focusPath: "/workspace/primary",
    threadId: "child-a",
    turnId: "turn-a",
    callId: "call-a",
  } as const;
}

describe("Codex child workspace enforcement probe", () => {
  it("executes one allowed list and denies both foreign scope and exclusion before native access", async () => {
    const execute = vi.fn<ReadonlyWorkspace["execute"]>(async (input) => {
      expect(input).toEqual({
        workspace: {
          workspaceId,
          root: "/workspace/primary",
          deniedPaths: ["private"],
          approvedRoot: {
            path: "/workspace/primary",
            ...SYNTHETIC_ROOT_IDENTITY,
          },
        },
        operation: { kind: "workspace.list", relativePath: "." },
      });
      return {
        ok: true,
        value: {
          kind: "workspace.entries",
          entries: ["README.md"],
          truncated: false,
        },
      };
    });
    const probe = new CodexAgentWorkspaceProbe(
      settings,
      { execute },
      () => 1_000,
    );

    await expect(probe.verify(request())).resolves.toEqual({
      status: "verified",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("C05-09 verifies the read projection of a write-approved workspace and never its write authority", async () => {
    const editable = ProductSettingsSchema.parse({
      ...settings,
      computer: {
        ...settings.computer,
        workspaces: settings.computer.workspaces.map((workspace) =>
          workspace.workspaceId === workspaceId
            ? { ...workspace, access: "write" }
            : workspace,
        ),
      },
    });
    const execute = vi.fn<ReadonlyWorkspace["execute"]>(async () => ({
      ok: true,
      value: {
        kind: "workspace.entries",
        entries: ["README.md"],
        truncated: false,
      },
    }));
    const probe = new CodexAgentWorkspaceProbe(
      editable,
      { execute },
      () => 1_000,
    );

    await expect(probe.verify(request())).resolves.toEqual({
      status: "verified",
    });
    expect(execute).toHaveBeenCalledTimes(1);

    for (const inflated of [
      {
        workspaces: authority.workspaces.map((workspace) => ({
          ...workspace,
          access: "write" as const,
        })),
      },
      {
        capabilities: [...authority.capabilities, "workspace.write" as const],
      },
    ]) {
      await expect(probe.verify(request(inflated))).resolves.toEqual({
        status: "failed",
        code: "AGENT_WORKSPACE_BINDING_INVALID",
      });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses an inflated delegated workspace before native access", async () => {
    const execute = vi.fn<ReadonlyWorkspace["execute"]>();
    const probe = new CodexAgentWorkspaceProbe(
      settings,
      { execute },
      () => 1_000,
    );

    await expect(
      probe.verify(
        request({
          workspaces: [
            ...authority.workspaces,
            {
              workspaceId: "00000000-0000-4000-8000-000000000099",
              mode: "subtree",
              root: "/workspace/unapproved",
              access: "read",
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "AGENT_WORKSPACE_BINDING_INVALID",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Codex child workspace authority provenance", () => {
  it("reports an owner-restriction denial through the public contract and the Agent port, not as an ordinary task grant", async () => {
    const execute = vi.fn<ReadonlyWorkspace["execute"]>();
    const probe = new CodexAgentWorkspaceProbe(
      settings,
      { execute },
      () => 1_000,
    );
    const narrowed = request({
      authorityShapeVersion: 1,
      workspaces: authority.workspaces.map((workspace) => ({
        ...workspace,
        restrictionSource: "owner-restriction" as const,
      })),
      excludedPaths: authority.excludedPaths.map((exclusion) => ({
        ...exclusion,
        restrictionSource: "owner-restriction" as const,
      })),
    });

    const denied = await probe.execute({
      identity: narrowed.identity,
      authority: narrowed.authority,
      workspaceId,
      operation: { kind: "workspace.read", relativePath: "private" },
      threadId: narrowed.threadId,
      turnId: narrowed.turnId,
      callId: narrowed.callId,
    });

    expect(denied).toEqual({
      status: "failed",
      code: "AUTHORITY_PATH_DENIED",
      source: "owner-restriction",
      retry: "never",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads a record from before provenance existed back as unknown, never as a task grant", () => {
    // `authority` carries neither `authorityShapeVersion` nor any
    // `restrictionSource` — exactly the shape a record produced before this
    // field existed would still have.
    const reconstructed = participant({
      identity: request().identity,
      authority,
    });

    for (const workspace of reconstructed.grant.workspaces) {
      expect(workspace.restrictionSource).toBe("unknown");
    }
    for (const exclusion of reconstructed.grant.excludedPaths) {
      expect(exclusion.restrictionSource).toBe("unknown");
    }
  });
});
