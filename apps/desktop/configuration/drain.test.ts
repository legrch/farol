import { describe, expect, it, vi } from "vitest";
import { DesktopAdmission } from "../host/admission";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { createConfigurationDrain } from "./drain";
import type { ConfigurationDrainPorts } from "./drain";
import type { WorkspaceConfigurationCommand } from "../../../src/apps/desktop/workspace-configuration-drain";

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

function makeSettings() {
  return {
    revision: 9,
    computer: {
      computerId: "computer-one",
      generation: 4,
      commands: "verification",
      filePolicy: "approved-roots-v1",
      workspaces: [
        {
          workspaceId: "workspace-one",
          root: "/tmp/project",
          access: "read",
          excludedPaths: [],
        },
      ],
    },
    connectors: { secureMcp: { generation: 3, runtime: { state: "ready" } } },
  };
}

function makePorts(overrides: Partial<Record<string, unknown>> = {}): {
  ports: ConfigurationDrainPorts;
  admission: DesktopAdmission;
} {
  const admission = new DesktopAdmission(pending());
  const authorityTransitions = new AuthorityTransitionReservation();
  // Authority reservation is held for the drain path.
  authorityTransitions.tryReserve("authority-change");
  const owner = {
    snapshot: () => ({ status: "ready" as const, settings: makeSettings() }),
  };
  const connector = { isRunning: () => true, hasUnresolvedEffect: () => false };
  const core = {
    observeComputerContinuity: vi.fn(async () => ({
      restricted: false,
      pendingOperationId: undefined,
    })),
    currentComputerConnectorBinding: () => ({
      runtimeId: "runtime-one",
      backendGeneration: "generation-one",
      buildId: "a".repeat(64),
    }),
  };
  const lifecycle = {
    hasUnconfirmedStop: vi.fn(async () => false),
    confirmedOriginalStop: () => null,
  };
  const ports = {
    configuration: () => owner,
    secureMcpConnectorRuntime: () => connector,
    desktopGoCore: () => core,
    desktopAdmission: admission,
    connectorStartInFlight: () => null,
    transitionRefusal: vi.fn(() => ({ ok: false, error: "REFUSED" })),
    configurationFailure: vi.fn((error: string) => ({ ok: false, error })),
    authorityTransitions,
    activeAuthorityChangeKind: () => "computer.update-access",
    setActiveAuthorityChangeKind: vi.fn(),
    codexAgentOperationActive: () => false,
    computerMcpLifecycle: () => lifecycle,
    stopAndConfirmComputerMcp: vi.fn(async () => undefined),
    savedChatBridgeRuntime: () => null,
    statePaths: () => ({ secureMcpLaunch: "/tmp/launch" }),
    configureAdmittedProduct: vi.fn(async () => ({ ok: true })),
    ownerComputerConsentDigest: vi.fn(() => "consent"),
    connectorRuntimeUncertain: vi.fn(() => false),
    clearAndConfirmOriginalConnectorVerificationReceipt: vi.fn(async () => ({
      parentOperationId: "x",
      effectId: "y",
      readback: "verified-absent",
      digest: "z",
    })),
    ...overrides,
  };
  return {
    ports: ports as unknown as ConfigurationDrainPorts,
    admission,
  };
}

describe("configuration drain", () => {
  it("refuses when configuration is unavailable", async () => {
    const { ports } = makePorts({ configuration: () => null });
    const drain = createConfigurationDrain(ports);
    const result = await drain.configureDrainedWorkspaceChange({
      kind: "computer.update-access",
      workspaceId: "workspace-one",
      access: "write",
    } as unknown as WorkspaceConfigurationCommand);
    expect(result).toEqual({ ok: false, error: "REFUSED" });
  });

  it("refuses when the connector runtime is unavailable", async () => {
    const { ports } = makePorts({ secureMcpConnectorRuntime: () => null });
    const drain = createConfigurationDrain(ports);
    const result = await drain.configureDrainedWorkspaceChange({
      kind: "computer.update-access",
      workspaceId: "workspace-one",
      access: "write",
    } as unknown as WorkspaceConfigurationCommand);
    expect(result).toEqual({ ok: false, error: "REFUSED" });
  });

  it("refuses when the Go core is unavailable", async () => {
    const { ports } = makePorts({ desktopGoCore: () => null });
    const drain = createConfigurationDrain(ports);
    const result = await drain.configureDrainedWorkspaceChange({
      kind: "computer.update-access",
      workspaceId: "workspace-one",
      access: "write",
    } as unknown as WorkspaceConfigurationCommand);
    expect(result).toEqual({ ok: false, error: "REFUSED" });
  });

  it("refuses when connector admission is already occupied", async () => {
    const { ports, admission } = makePorts();
    admission.reserveAdmitted("connector-task");
    const drain = createConfigurationDrain(ports);
    const result = await drain.configureDrainedWorkspaceChange({
      kind: "computer.update-access",
      workspaceId: "workspace-one",
      access: "write",
    } as unknown as WorkspaceConfigurationCommand);
    expect(result).toEqual({ ok: false, error: "REFUSED" });
  });

  it("refuses when a connector start is in flight", async () => {
    const { ports } = makePorts({
      connectorStartInFlight: () => Promise.resolve(),
    });
    const drain = createConfigurationDrain(ports);
    const result = await drain.configureDrainedWorkspaceChange({
      kind: "computer.update-access",
      workspaceId: "workspace-one",
      access: "write",
    } as unknown as WorkspaceConfigurationCommand);
    expect(result).toEqual({ ok: false, error: "REFUSED" });
  });

  it("returns authority refusal when original Stop custody is restricted", async () => {
    const core = {
      observeComputerContinuity: vi.fn(async () => ({
        restricted: true,
        pendingOperationId: "old-parent",
      })),
      currentComputerConnectorBinding: () => ({
        runtimeId: "runtime-one",
        backendGeneration: "generation-one",
        buildId: "a".repeat(64),
      }),
    };
    const { ports, admission } = makePorts({ desktopGoCore: () => core });
    const drain = createConfigurationDrain(ports);
    const result = await drain.configureDrainedWorkspaceChange({
      kind: "computer.update-access",
      workspaceId: "workspace-one",
      access: "write",
    } as unknown as WorkspaceConfigurationCommand);
    expect(result).toMatchObject({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(admission.occupied("connector-task")).toBe(false);
  });

  it("returns authority refusal and releases admission when continuity observation throws", async () => {
    const core = {
      observeComputerContinuity: vi.fn(async () => {
        throw new Error("boom");
      }),
      currentComputerConnectorBinding: () => ({
        runtimeId: "runtime-one",
        backendGeneration: "generation-one",
        buildId: "a".repeat(64),
      }),
    };
    const { ports, admission } = makePorts({ desktopGoCore: () => core });
    const drain = createConfigurationDrain(ports);
    const result = await drain.configureDrainedWorkspaceChange({
      kind: "computer.update-access",
      workspaceId: "workspace-one",
      access: "write",
    } as unknown as WorkspaceConfigurationCommand);
    expect(result).toMatchObject({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(admission.occupied("connector-task")).toBe(false);
  });
});
