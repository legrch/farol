import { describe, expect, it, vi } from "vitest";
import { DesktopAdmission } from "../host/admission";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { createConfigurationDrain } from "./drain";
import type { ConfigurationDrainPorts } from "./drain";

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

describe("configuration drain", () => {
  it("refuses when configuration is unavailable", async () => {
    const admission = new DesktopAdmission(pending());
    const authorityTransitions = new AuthorityTransitionReservation();
    const ports: ConfigurationDrainPorts = {
      configuration: () => null,
      secureMcpConnectorRuntime: () => null,
      desktopGoCore: () => null,
      desktopAdmission: admission,
      connectorStartInFlight: () => null,
      transitionRefusal: vi.fn(
        () => ({ ok: false, error: "REFUSED" }) as never,
      ),
      configurationFailure: vi.fn((error) => ({ ok: false, error }) as never),
      authorityTransitions,
      activeAuthorityChangeKind: () => null,
      setActiveAuthorityChangeKind: vi.fn(),
      codexAgentOperationActive: () => false,
      computerMcpLifecycle: () =>
        ({
          hasUnconfirmedStop: vi.fn(async () => false),
          confirmedOriginalStop: () => null,
        }) as never,
      stopAndConfirmComputerMcp: vi.fn(async () => undefined),
      savedChatBridgeRuntime: () => null,
      statePaths: () => ({ secureMcpLaunch: "/tmp/launch" }),
      configureAdmittedProduct: vi.fn(async () => ({ ok: true }) as never),
      ownerComputerConsentDigest: vi.fn(() => "consent"),
      connectorRuntimeUncertain: vi.fn(() => false),
      clearAndConfirmOriginalConnectorVerificationReceipt: vi.fn(
        async () =>
          ({
            parentOperationId: "x",
            effectId: "y",
            readback: "verified-absent",
            digest: "z",
          }) as never,
      ),
    };
    const drain = createConfigurationDrain(ports);
    const result = await drain.configureDrainedWorkspaceChange({
      kind: "computer.update-access",
      workspaceId: "workspace-one",
      access: "write",
    } as never);
    expect(result).toBeDefined();
  });
});
