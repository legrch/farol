import { describe, expect, it, vi } from "vitest";
import { DesktopAdmission } from "../host/admission";
import { createConfigurationComputer } from "./computer";
import type { ConfigurationComputerPorts } from "./computer";
import type { ComputerConfigurationCommand } from "./computer";
import { ProductSettingsSchema } from "../../../src/pkg/product-settings/contract";

function pending() {
  return {
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => false,
    hostCheck: () => false,
    connectorStart: () => false,
  };
}

function makePorts(
  overrides: Partial<Record<string, unknown>> = {},
): ConfigurationComputerPorts {
  const admission = new DesktopAdmission(pending());
  const configuration = {
    snapshot: () => ({ status: "ready" as const, settings: {} }),
    renameComputer: vi.fn(async () => ({ ok: true })),
  };
  const ports = {
    configuration: () => configuration,
    codexAgentOperationActive: () => false,
    configurationFailure: vi.fn((error: string) => ({ ok: false, error })),
    getPendingWorkspacePick: () => null,
    setPendingWorkspacePick: vi.fn(),
    selectedWorkspace: vi.fn(async () => "cancelled"),
    measuredRootIdentity: vi.fn(async () => null),
    inspectOwnerWorkspace: vi.fn(async () => ({ ok: true })),
    buildIdentity: () => ({ buildId: "build" }),
    workspaceReadFailure: vi.fn((code: string) => ({ ok: false, error: code })),
    desktopAdmission: admission,
    secureMcpConnectorRuntime: () => null,
    runtime: () => ({ identity: "runtime" }),
    verifiedProductWorkspace: vi.fn(() => ({ status: "not_found" })),
    listOwnerWorkspace: vi.fn(async () => ({
      ok: false,
      code: "WORKSPACE_READ_FAILED",
    })),
    desktopGoCore: () => null,
    compiledGoCore: () => null,
    discoverWorkspaceGitMetadata: vi.fn(async () => null),
    verificationWorkspaceAction: vi.fn(() => null),
    getPendingWorkspaceEdit: () => null,
    setPendingWorkspaceEdit: vi.fn(),
    selectedWorkspaceFile: vi.fn(async () => "cancelled"),
    goWorkspaceEditResult: vi.fn(() => ({ ok: true })),
    statePaths: () => ({ workspaceMutations: "/tmp/mutations" }),
    workspaceMutationFailure: vi.fn((code: string) => ({
      ok: false,
      error: code,
    })),
    workspaceCommandFailure: vi.fn((code: string) => ({
      ok: false,
      error: code,
    })),
    ...overrides,
  };
  return ports as unknown as ConfigurationComputerPorts;
}

describe("configuration computer", () => {
  it("refuses when configuration is unavailable", async () => {
    const ports = makePorts({ configuration: () => null });
    const computer = createConfigurationComputer(ports);
    const result = await computer.configureAdmittedComputer({
      kind: "computer.rename",
      name: "Renamed",
    } as ComputerConfigurationCommand);
    expect(result).toMatchObject({ ok: false, error: "SETTINGS_UNAVAILABLE" });
  });

  it("dispatches computer.rename to configuration", async () => {
    const ports = makePorts();
    const computer = createConfigurationComputer(ports);
    await expect(
      computer.configureAdmittedComputer({
        kind: "computer.rename",
        name: "Renamed",
      } as ComputerConfigurationCommand),
    ).rejects.toBeDefined();
    expect(ports.configuration()!.renameComputer).toHaveBeenCalledWith(
      "Renamed",
    );
  });

  it("expires a stale workspace pick", async () => {
    const ports = makePorts({
      getPendingWorkspacePick: () => ({
        id: "selection-1",
        selected: {
          root: "/tmp/project",
          label: "project",
          rootIdentity: { device: "1", inode: "2" },
        },
        expiresAt: Date.now() - 1,
      }),
    });
    const computer = createConfigurationComputer(ports);
    const result = await computer.configureAdmittedComputer({
      kind: "computer.add-workspace",
      selectionId: "selection-1",
    } as ComputerConfigurationCommand);
    expect(result).toMatchObject({
      ok: false,
      error: "WORKSPACE_SELECTION_INVALID",
    });
    expect(ports.setPendingWorkspacePick).toHaveBeenCalledWith(null);
  });

  it("reports an unknown workspace mutation outcome", async () => {
    const pendingEdit = {
      operationId: "edit-1",
      workspaceId: "workspace-1",
      computerGeneration: 4,
      relativePath: "file.txt",
      bytes: 1,
      beforeSha256: "before",
      expiresAt: Date.now() + 60_000,
    };
    const cfg = {
      snapshot: () => ({
        status: "ready" as const,
        settings: {
          computer: { pendingEdit },
        },
      }),
    };
    const ports = makePorts({
      getPendingWorkspaceEdit: () => pendingEdit,
      configuration: () => cfg,
      compiledGoCore: () => ({}),
      desktopGoCore: () => ({}),
    });
    const computer = createConfigurationComputer(ports);
    const result = await computer.configureAdmittedComputer({
      kind: "computer.observe-workspace-edit",
      operationId: "edit-1",
    } as ComputerConfigurationCommand);
    expect(result).toBeDefined();
  });

  it("retains pending mutation outcome unknown without clearing", async () => {
    const pendingEdit = {
      operationId: "edit-2",
      workspaceId: "workspace-2",
      computerGeneration: 4,
      relativePath: "file.txt",
      bytes: 1,
      beforeSha256: "before",
      expiresAt: Date.now() + 60_000,
      backend: { id: "backend" },
      profileId: "profile",
      submittedAt: Date.now(),
    };
    const recordComputerMutationOutcomeUnknown = vi.fn();
    const cfg = {
      snapshot: () => ({
        status: "ready" as const,
        settings: {
          computer: { pendingEdit },
        },
      }),
      recordComputerMutationOutcomeUnknown,
    };
    const ports = makePorts({
      configuration: () =>
        cfg as unknown as ReturnType<
          ConfigurationComputerPorts["configuration"]
        >,
      compiledGoCore: () => ({}),
      desktopGoCore: () => ({
        observeSettingsMutation: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    });
    const computer = createConfigurationComputer(ports);
    const result = await computer.configureAdmittedComputer({
      kind: "computer.observe-workspace-edit",
      operationId: "edit-2",
    } as ComputerConfigurationCommand);
    expect(result).toMatchObject({
      ok: false,
      error: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
    });
  });

  it("routes run-git-status through the verification action port", async () => {
    const workspace = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      root: "/tmp/project",
      label: "project",
      access: "read" as const,
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
    };
    const settings = ProductSettingsSchema.parse({
      schema: 1,
      revision: 1,
      general: {
        openAtLaunch: "browser",
        sidebarDefault: "full",
        activityDetail: "summary",
      },
      computer: {
        computerId: "00000000-0000-4000-8000-000000000002",
        generation: 1,
        name: "This Mac",
        commands: "verification",
        workspaces: [workspace],
      },
      setup: {
        journey: { currentStep: "verify", dismissed: false },
        chatgpt: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
        computer: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
        connect: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
        hosts: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
        verify: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
      },
    });
    const action = {
      execute: vi.fn(async () => ({
        ok: true as const,
        value: {
          output: {
            kind: "workspace.command" as const,
            command: "git.status" as const,
            exitCode: 0,
            stdout: "out",
            stderr: "",
            outputBytes: 3,
            network: "none",
            coverage: "tracked-files-only",
            layout: "primary",
          } as const,
        },
      })),
    };
    const ports = makePorts({
      configuration: () => ({
        snapshot: () => ({ status: "ready" as const, settings }),
      }),
      verifiedProductWorkspace: () => ({
        status: "verified" as const,
        workspace,
      }),
      compiledGoCore: () => null,
      verificationWorkspaceAction: vi.fn(() => action),
    });
    const computer = createConfigurationComputer(ports);
    const result = await computer.configureAdmittedComputer({
      kind: "computer.run-git-status",
      workspaceId: workspace.workspaceId,
    } as ComputerConfigurationCommand);
    expect(result).toMatchObject({
      ok: true,
      evidence: { command: "git.status" },
    });
    expect(ports.verificationWorkspaceAction).toHaveBeenCalledTimes(1);
    expect(action.execute).toHaveBeenCalledTimes(1);
  });

  it("refuses run-git-status before building legacy verification action when Go is available", async () => {
    const workspace = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      root: "/tmp/project",
      label: "project",
      access: "read" as const,
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
    };
    const settings = ProductSettingsSchema.parse({
      schema: 1,
      revision: 1,
      general: {
        openAtLaunch: "browser",
        sidebarDefault: "full",
        activityDetail: "summary",
      },
      computer: {
        computerId: "00000000-0000-4000-8000-000000000002",
        generation: 1,
        name: "This Mac",
        commands: "verification",
        workspaces: [workspace],
      },
      setup: {
        journey: { currentStep: "verify", dismissed: false },
        chatgpt: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
        computer: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
        connect: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
        hosts: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
        verify: {
          visited: true,
          skipped: false,
          configured: true,
          reachable: "reachable",
          verified: null,
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
      },
    });
    const verificationWorkspaceAction = vi.fn(() => null);
    const ports = makePorts({
      configuration: () => ({
        snapshot: () => ({ status: "ready" as const, settings }),
      }),
      verifiedProductWorkspace: () => ({
        status: "verified" as const,
        workspace,
      }),
      compiledGoCore: () => ({}),
      verificationWorkspaceAction,
    });
    const computer = createConfigurationComputer(ports);
    const result = await computer.configureAdmittedComputer({
      kind: "computer.run-git-status",
      workspaceId: workspace.workspaceId,
    } as ComputerConfigurationCommand);
    expect(result).toMatchObject({
      ok: false,
      error: "WORKSPACE_COMMAND_UNAVAILABLE",
    });
    expect(verificationWorkspaceAction).not.toHaveBeenCalled();
  });
});
