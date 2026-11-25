import type { PendingWorkspaceEdit } from "../../../src/apps/desktop/workspace-edit";
import { describe, expect, it, vi } from "vitest";
import { DesktopAdmission } from "../host/admission";
import { createConfigurationComputer } from "./computer";
import type { ConfigurationComputerPorts } from "./computer";
import type { ComputerConfigurationCommand } from "./computer";
import { ProductSettingsSchema } from "../../../src/pkg/product-settings/contract";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";

function settingsWithWorkspace(workspace: unknown) {
  return ProductSettingsSchema.parse({
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
}

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

  it("verifies a folder whose device number moved without rebinding it", async () => {
    const workspace = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      root: "/tmp/project",
      label: "project",
      access: "read" as const,
      excludedPaths: [],
      rootIdentity: { device: "16777231", inode: "335036" },
    };
    const settings = settingsWithWorkspace(workspace);
    const configuration = {
      snapshot: () => ({ status: "ready" as const, settings }),
      rebindWorkspaceRootIdentity: vi.fn(),
      bindWorkspaceRootIdentity: vi.fn(),
      recordComputerVerification: vi.fn(async () => ({
        ok: true,
        snapshot: { status: "ready" as const, settings },
      })),
      withdrawDriftedWorkspaceChecks: vi.fn(async () => ({ ok: true })),
    };
    const ports = makePorts({
      configuration: () => configuration,
      measuredRootIdentity: vi.fn(async () => ({
        device: "16777233",
        inode: "335036",
      })),
      inspectOwnerWorkspace: vi.fn(async () => ({ ok: true })),
      secureMcpConnectorRuntime: () => ({ isRunning: () => false }),
    });
    await createConfigurationComputer(ports).configureAdmittedComputer({
      kind: "computer.verify-workspace",
      workspaceId: workspace.workspaceId,
    } as ComputerConfigurationCommand);
    // Path-bound approval (owner decision 2026-11-22): a reboot that
    // renumbered the volume is diagnostic only. Verification proceeds
    // against the folder at the path; nothing is withdrawn and the saved
    // pair is never rebound.
    expect(ports.inspectOwnerWorkspace).toHaveBeenCalledOnce();
    expect(configuration.withdrawDriftedWorkspaceChecks).not.toHaveBeenCalled();
    expect(configuration.rebindWorkspaceRootIdentity).not.toHaveBeenCalled();
    expect(configuration.bindWorkspaceRootIdentity).not.toHaveBeenCalled();
    expect(configuration.recordComputerVerification).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "publishes writableByOthers=%s on the inspection evidence only when true",
    async (writable) => {
      const workspace = {
        workspaceId: "00000000-0000-4000-8000-000000000001",
        root: "/tmp/project",
        label: "project",
        access: "read" as const,
        excludedPaths: [],
        rootIdentity: { device: "1", inode: "2" },
      };
      const settings = settingsWithWorkspace(workspace);
      const configuration = {
        snapshot: () => ({ status: "ready" as const, settings }),
        rebindWorkspaceRootIdentity: vi.fn(),
        bindWorkspaceRootIdentity: vi.fn(),
        recordComputerVerification: vi.fn(async () => ({
          ok: true,
          snapshot: { status: "ready" as const, settings },
        })),
        withdrawDriftedWorkspaceChecks: vi.fn(async () => ({ ok: true })),
      };
      const ports = makePorts({
        configuration: () => configuration,
        measuredRootIdentity: vi.fn(async () => ({ device: "1", inode: "2" })),
        inspectOwnerWorkspace: vi.fn(async () =>
          writable
            ? { ok: true as const, writableByOthers: true as const }
            : { ok: true as const },
        ),
        secureMcpConnectorRuntime: () => ({ isRunning: () => false }),
      });
      const result = await createConfigurationComputer(
        ports,
      ).configureAdmittedComputer({
        kind: "computer.verify-workspace",
        workspaceId: workspace.workspaceId,
      } as ComputerConfigurationCommand);
      expect(result).toMatchObject({ ok: true });
      const evidence = (result as { evidence: Record<string, unknown> })
        .evidence;
      expect(evidence.kind).toBe("computer.workspace-inspection");
      expect("writableByOthers" in evidence).toBe(writable);
    },
  );

  it("refuses evidence when the folder is replaced during Git discovery", async () => {
    const workspace = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      root: "/tmp/project",
      label: "project",
      access: "read" as const,
      excludedPaths: [],
      rootIdentity: { device: "16777231", inode: "335036" },
    };
    const settings = settingsWithWorkspace(workspace);
    const configuration = {
      snapshot: () => ({ status: "ready" as const, settings }),
      rebindWorkspaceRootIdentity: vi.fn(),
      bindWorkspaceRootIdentity: vi.fn(),
      recordComputerVerification: vi.fn(async () => ({
        ok: true,
        snapshot: { status: "ready" as const, settings },
      })),
      withdrawDriftedWorkspaceChecks: vi.fn(async () => ({ ok: true })),
    };
    const measured = vi
      .fn()
      .mockResolvedValue({ device: "16777233", inode: "999" })
      .mockResolvedValueOnce({ device: "16777233", inode: "335036" });
    const ports = makePorts({
      configuration: () => configuration,
      measuredRootIdentity: measured,
      inspectOwnerWorkspace: vi.fn(async () => ({ ok: true })),
      secureMcpConnectorRuntime: () => ({ isRunning: () => false }),
    });
    const result = await createConfigurationComputer(
      ports,
    ).configureAdmittedComputer({
      kind: "computer.verify-workspace",
      workspaceId: workspace.workspaceId,
    } as ComputerConfigurationCommand);
    expect(result).toMatchObject({ ok: false });
    expect(configuration.recordComputerVerification).not.toHaveBeenCalled();
  });

  it.each(["WORKSPACE_ROOT_CHANGED", "WORKSPACE_NOT_FOUND"])(
    "withdraws the stale check when Go inspection refuses with %s",
    async (code) => {
      const workspace = {
        workspaceId: "00000000-0000-4000-8000-000000000001",
        root: "/tmp/project",
        label: "project",
        access: "read" as const,
        excludedPaths: [],
        rootIdentity: { device: "1", inode: "2" },
      };
      const settings = settingsWithWorkspace(workspace);
      const configuration = {
        snapshot: () => ({ status: "ready" as const, settings }),
        recordComputerVerification: vi.fn(),
        withdrawDriftedWorkspaceChecks: vi.fn(async () => ({ ok: true })),
      };
      const ports = makePorts({
        configuration: () => configuration,
        // The folder matched when measured, then changed before Go opened it.
        measuredRootIdentity: vi.fn(async () => ({ device: "1", inode: "2" })),
        inspectOwnerWorkspace: vi.fn(async () => ({ ok: false, code })),
      });
      await expect(
        createConfigurationComputer(ports).configureAdmittedComputer({
          kind: "computer.verify-workspace",
          workspaceId: workspace.workspaceId,
        } as ComputerConfigurationCommand),
      ).resolves.toMatchObject({ ok: false, error: code });
      expect(
        configuration.withdrawDriftedWorkspaceChecks,
      ).toHaveBeenCalledOnce();
      expect(configuration.recordComputerVerification).not.toHaveBeenCalled();
    },
  );

  it("routes run-git-status through the verification action port", async () => {
    const workspace = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      root: "/tmp/project",
      label: "project",
      access: "read" as const,
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
    };
    const settings = settingsWithWorkspace(workspace);
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
    const settings = settingsWithWorkspace(workspace);
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

// Scripted Go receipt and picker only: no native filesystem or provider witness.
it.each([false, true])(
  "publishes the newly prepared preview after expired=%s",
  async (expired) => {
    const workspace = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      root: "/tmp/project",
      label: "project",
      access: "write" as const,
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
    };
    const settings = settingsWithWorkspace(workspace);
    let preview: PendingWorkspaceEdit | null = expired
      ? {
          operationId: "00000000-0000-4000-8000-000000000099",
          workspaceId: workspace.workspaceId,
          computerGeneration: settings.computer.generation,
          relativePath: "old.txt",
          bytes: 999,
          beforeSha256: "b".repeat(64),
          expiresAt: Date.now() - 1,
        }
      : null;
    const previousId = preview?.operationId;
    const snapshotSettingsWorkspace = vi.fn(async () => ({
      workspaceId: workspace.workspaceId,
      relativePath: "new.txt",
      root: { path: workspace.root, ...workspace.rootIdentity },
      bytes: 3,
      sha256: "a".repeat(64),
    }));
    const core = { snapshotSettingsWorkspace };
    const configuration = {
      snapshot: () => ({ status: "ready" as const, settings }),
    };
    const ports = makePorts({
      configuration: () => configuration,
      desktopGoCore: () => core,
      compiledGoCore: () => ({}),
      verifiedProductWorkspace: () => ({ status: "verified", workspace }),
      selectedWorkspaceFile: vi.fn(async () => "new.txt"),
      getPendingWorkspaceEdit: () => preview,
      setPendingWorkspaceEdit: (value: PendingWorkspaceEdit | null) => {
        preview = value;
      },
    });
    const result = await createConfigurationComputer(
      ports,
    ).configureAdmittedComputer({
      kind: "computer.prepare-workspace-edit",
      workspaceId: workspace.workspaceId,
    });
    const prepared = ports.getPendingWorkspaceEdit();
    expect(prepared).not.toBeNull();
    expect(prepared?.operationId).not.toBe(previousId);
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "computer.workspace-edit-preview",
        operationId: prepared?.operationId,
        relativePath: "new.txt",
        bytes: 3,
        beforeSha256: "a".repeat(64),
      },
    });
    expect(snapshotSettingsWorkspace).toHaveBeenCalledTimes(1);
  },
);

type FakeLease = { release: () => Promise<void> };
interface FakeService {
  pendingEditLeases: Map<string, FakeLease>;
  released: string[];
  leaseRelease: ReturnType<typeof vi.fn>;
  snapshot: () => { status: "ready"; settings: ProductSettings };
  releaseWorkspaceEditLease?: (this: unknown, id: string) => Promise<void>;
}

// Scripted Go receipt and picker only: no native filesystem or provider witness.
describe("apply-workspace-edit lease cleanup", () => {
  const workspace = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    root: "/tmp/project",
    label: "project",
    access: "write" as const,
    excludedPaths: [],
    rootIdentity: { device: "1", inode: "2" },
  };
  const generation = 1;
  const operationId = "lease-op-1";

  function makeService() {
    const released: string[] = [];
    const leaseRelease = vi.fn(async () => {});
    const pendingEditLeases = new Map<
      string,
      { release: () => Promise<void> }
    >();
    pendingEditLeases.set(operationId, { release: leaseRelease });
    const baseSettings = settingsWithWorkspace(workspace);
    const settings = {
      ...baseSettings,
      setup: {
        ...baseSettings.setup,
        computer: {
          ...baseSettings.setup.computer,
          verified: {
            profile: "computer.local.write/1",
            configRevision: generation,
            workspaceId: workspace.workspaceId,
            runtimeGeneration: "runtime:build",
            buildId: "0".repeat(64),
            protocol: "mutable-workspace/1",
            verifiedAt: new Date().toISOString(),
          },
        },
      },
    };
    const service: FakeService = {
      pendingEditLeases,
      released,
      leaseRelease,
      snapshot: () => ({ status: "ready" as const, settings }),
    };
    service.releaseWorkspaceEditLease = async function (
      this: unknown,
      id: string,
    ) {
      const self = this as {
        pendingEditLeases: Map<string, { release: () => Promise<void> }>;
      };
      const lease = self.pendingEditLeases.get(id);
      if (!lease) return;
      self.pendingEditLeases.delete(id);
      await lease.release();
      released.push(id);
    };
    return service;
  }

  function makePendingEdit() {
    return {
      operationId,
      workspaceId: workspace.workspaceId,
      computerGeneration: generation,
      relativePath: "file.txt",
      bytes: 1,
      beforeSha256: "before",
      expiresAt: Date.now() + 60_000,
    };
  }

  it("releases the lease exactly once on success", async () => {
    const service = makeService();
    const pendingEdit = makePendingEdit();
    const editSettingsWorkspace = vi.fn(async () => ({ ok: true }));
    const goCore = {
      settingsMutationProfile: vi.fn(),
      editSettingsWorkspace,
    };
    const admission = new DesktopAdmission(pending());
    const ports = makePorts({
      configuration: () => service,
      desktopAdmission: admission,
      compiledGoCore: () => ({}),
      desktopGoCore: () => goCore,
      getPendingWorkspaceEdit: () => pendingEdit,
      setPendingWorkspaceEdit: vi.fn(),
      verifiedProductWorkspace: () => ({ status: "verified", workspace }),
      goWorkspaceEditResult: vi.fn(() => ({ ok: true })),
    });
    const computer = createConfigurationComputer(ports);
    const result = await computer.configureAdmittedComputer({
      kind: "computer.apply-workspace-edit",
      operationId,
      oldText: "a",
      newText: "b",
    });
    expect(result).toMatchObject({ ok: true });
    expect(editSettingsWorkspace).toHaveBeenCalledTimes(1);
    expect(admission.occupied("workspace-mutation")).toBe(false);
    expect(service.released).toEqual([operationId]);
    expect(service.pendingEditLeases.has(operationId)).toBe(false);
    expect(service.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("releases the lease exactly once when the mutation outcome is unknown", async () => {
    const service = makeService();
    const pendingEdit = makePendingEdit();
    const editSettingsWorkspace = vi.fn(async () => {
      throw new Error("boom");
    });
    const goCore = {
      settingsMutationProfile: vi.fn(),
      editSettingsWorkspace,
    };
    const admission = new DesktopAdmission(pending());
    const ports = makePorts({
      configuration: () => service,
      desktopAdmission: admission,
      compiledGoCore: () => ({}),
      desktopGoCore: () => goCore,
      getPendingWorkspaceEdit: () => pendingEdit,
      setPendingWorkspaceEdit: vi.fn(),
      verifiedProductWorkspace: () => ({ status: "verified", workspace }),
      goWorkspaceEditResult: vi.fn(() => ({ ok: true })),
    });
    const computer = createConfigurationComputer(ports);
    const result = await computer.configureAdmittedComputer({
      kind: "computer.apply-workspace-edit",
      operationId,
      oldText: "a",
      newText: "b",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(editSettingsWorkspace).toHaveBeenCalledTimes(1);
    expect(admission.occupied("workspace-mutation")).toBe(false);
    expect(service.released).toEqual([operationId]);
    expect(service.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("releases on the original owner when the configuration owner is replaced mid-flight", async () => {
    const originalService = makeService();
    const replacementService = makeService();
    let currentService: unknown = originalService;
    const pendingEdit = makePendingEdit();
    let resolveMutation!: (value: unknown) => void;
    const editSettingsWorkspace = vi.fn(
      () =>
        new Promise((resolve) => {
          currentService = replacementService;
          resolveMutation = resolve;
        }),
    );
    const goCore = {
      settingsMutationProfile: vi.fn(),
      editSettingsWorkspace,
    };
    const admission = new DesktopAdmission(pending());
    const ports = makePorts({
      configuration: () => currentService,
      desktopAdmission: admission,
      compiledGoCore: () => ({}),
      desktopGoCore: () => goCore,
      getPendingWorkspaceEdit: () => pendingEdit,
      setPendingWorkspaceEdit: vi.fn(),
      verifiedProductWorkspace: () => ({ status: "verified", workspace }),
      goWorkspaceEditResult: vi.fn(() => ({ ok: true })),
    });
    const computer = createConfigurationComputer(ports);
    const promise = computer.configureAdmittedComputer({
      kind: "computer.apply-workspace-edit",
      operationId,
      oldText: "a",
      newText: "b",
    });
    await vi.waitFor(() => expect(editSettingsWorkspace).toHaveBeenCalled());
    resolveMutation({ ok: true });
    const result = await promise;
    expect(result).toMatchObject({ ok: true });
    expect(editSettingsWorkspace).toHaveBeenCalledTimes(1);
    expect(admission.occupied("workspace-mutation")).toBe(false);
    expect(originalService.released).toEqual([operationId]);
    expect(originalService.leaseRelease).toHaveBeenCalledTimes(1);
    expect(replacementService.released).toEqual([]);
    expect(replacementService.leaseRelease).not.toHaveBeenCalled();
  });
});
