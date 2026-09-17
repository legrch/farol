import { describe, expect, it, vi } from "vitest";

import type { AgentComputerRequest } from "../../src/modules/agent/app/port/computer";
import type { DelegatedAgentAuthority } from "../../src/modules/agent/app/port/execution-authority";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";
import { CodexAgentWorkspaceProbe } from "../../src/apps/desktop/codex-agent-workspace-probe";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";

const workspaceId = "00000000-0000-4000-8000-000000000001";

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

function settings(generation = 7) {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000010",
      generation,
      name: "This Mac",
      workspaces: [
        {
          workspaceId,
          root: "/workspace/primary",
          label: "Primary",
          access: "read",
          excludedPaths: ["/workspace/primary/private"],
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
}

function authority(
  overrides: Partial<DelegatedAgentAuthority> = {},
): DelegatedAgentAuthority {
  return {
    authorityId: "authority-a",
    participantId: "agent-a",
    parentParticipantId: "main-a",
    role: "agent",
    mutationOwnership: "none",
    ownerId: "owner-desktop",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 7,
    computerId: settings().computer.computerId,
    computerGeneration: 7,
    workspaces: [
      {
        workspaceId,
        mode: "subtree",
        root: "/workspace/primary",
        access: "read",
      },
    ],
    excludedPaths: [{ workspaceId, path: "/workspace/primary/private" }],
    capabilities: ["workspace.list", "workspace.read", "workspace.search"],
    network: "none",
    commands: "none",
    expiresAt: 10_000,
    ...overrides,
  };
}

function request(
  operation: AgentComputerRequest["operation"],
  delegated = authority(),
  callId = "call-a",
): AgentComputerRequest {
  return {
    identity: {
      assignmentId: "assignment-a",
      ownerId: "owner-desktop",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 7,
      generation: 1,
    },
    authority: delegated,
    workspaceId,
    operation,
    threadId: "child-a",
    turnId: "turn-a",
    callId,
  };
}

describe("Codex Agent Computer authority", () => {
  it("DAC-03 discovers and reads a relevant file that was not in initial focus", async () => {
    const execute = vi.fn<ReadonlyWorkspace["execute"]>(async (input) => {
      if (input.operation.kind === "workspace.search") {
        return {
          ok: true,
          value: {
            kind: "workspace.matches",
            matches: [
              {
                path: "notes/continuity.md",
                line: 4,
                text: "delegated continuity marker",
                truncated: false,
              },
            ],
            resultLimited: false,
            scanLimited: false,
          },
        };
      }
      return {
        ok: true,
        value: {
          kind: "workspace.text",
          text: "delegated continuity marker",
          bytes: 27,
        },
      };
    });
    const computer = new CodexAgentWorkspaceProbe(
      settings(),
      { execute },
      () => 1_000,
    );

    const discovered = await computer.execute(
      request({
        kind: "workspace.search",
        relativePath: ".",
        pattern: "continuity marker",
      }),
    );
    expect(discovered).toMatchObject({
      status: "completed",
      output: {
        kind: "workspace.matches",
        matches: [{ path: "notes/continuity.md" }],
      },
    });

    await expect(
      computer.execute(
        request(
          { kind: "workspace.read", relativePath: "notes/continuity.md" },
          authority(),
          "call-b",
        ),
      ),
    ).resolves.toEqual({
      status: "completed",
      output: {
        kind: "workspace.text",
        text: "delegated continuity marker",
        bytes: 27,
      },
    });
    expect(execute).toHaveBeenNthCalledWith(1, {
      workspace: {
        workspaceId,
        root: "/workspace/primary",
        deniedPaths: ["private"],
      },
      operation: {
        kind: "workspace.search",
        relativePath: ".",
        pattern: "continuity marker",
      },
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      workspace: {
        workspaceId,
        root: "/workspace/primary",
        deniedPaths: ["private"],
      },
      operation: {
        kind: "workspace.read",
        relativePath: "notes/continuity.md",
      },
    });
  });

  it("DAC-06 preserves exact-file narrowing and exclusion before native access", async () => {
    const execute = vi.fn<ReadonlyWorkspace["execute"]>();
    const computer = new CodexAgentWorkspaceProbe(
      settings(),
      { execute },
      () => 1_000,
    );
    const narrowed = authority({
      workspaces: [
        {
          workspaceId,
          mode: "exact",
          root: "/workspace/primary",
          paths: ["/workspace/primary/README.md"],
          access: "read",
        },
      ],
      excludedPaths: [],
    });

    await expect(
      computer.execute(
        request(
          { kind: "workspace.read", relativePath: "notes/continuity.md" },
          narrowed,
        ),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      code: "AUTHORITY_PATH_DENIED",
      source: "task-grant",
    });
    await expect(
      computer.execute(
        request(
          { kind: "workspace.read", relativePath: "private/secret.txt" },
          authority(),
          "call-b",
        ),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      code: "AUTHORITY_PATH_DENIED",
      source: "task-grant",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("DAC-10 refuses a stale authority after owner policy generation changes", async () => {
    const execute = vi.fn<ReadonlyWorkspace["execute"]>();
    const computer = new CodexAgentWorkspaceProbe(
      settings(8),
      { execute },
      () => 1_000,
    );

    await expect(
      computer.execute(request({ kind: "workspace.list", relativePath: "." })),
    ).resolves.toEqual({
      status: "failed",
      code: "AGENT_COMPUTER_BINDING_INVALID",
      source: "owner-restriction",
      retry: "never",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
