import { describe, expect, it, vi } from "vitest";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { admissionFixture } from "../../../tests/support/desktop-admission";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../../../tests/fixtures/guided-onboarding";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import {
  createConfigurationConnector,
  type ConfigurationConnectorPorts,
} from "./connector";

// These scripted ports cover command routing only. They do not qualify native
// startup, credentials, filesystem Stop, a live provider or a production profile.
function fixture() {
  const snapshot = { status: "error", error: "SETTINGS_READ_FAILED" } as const;
  const result = ProductConfigurationResultSchema.parse({ ok: true, snapshot });
  const start = vi.fn(async () => result);
  const verifyClient = vi.fn(async () => result);
  const selected = vi.fn(async () => "cancelled");
  const boundary = {
    configuration: () => ({ snapshot: () => snapshot }),
    configurationFailure: (error: string) =>
      ProductConfigurationResultSchema.parse({ ok: false, error, snapshot }),
    startSecureMcpConnector: start,
    selectedTunnelClientExecutable: selected,
    verifyTunnelClientExecutable: verifyClient,
  };
  // One test-only cast admits partial owners. Each test may call only the
  // explicitly scripted ports; a missing port fails rather than hiding effects.
  const handler = createConfigurationConnector(
    boundary as unknown as ConfigurationConnectorPorts,
  );
  return { handler, result, start, verifyClient, selected };
}

describe("connector configuration command routing", () => {
  it.each([
    ["connector.start", false],
    ["connector.repair", true],
  ] as const)(
    "keeps %s on its existing single start path",
    async (kind, repair) => {
      const f = fixture();
      expect(await f.handler.configureAdmittedConnector({ kind })).toBe(
        f.result,
      );
      expect(f.start).toHaveBeenCalledExactlyOnceWith(repair);
      expect(f.verifyClient).not.toHaveBeenCalled();
    },
  );

  it("refuses retained save-and-connect without entering the ordinary start path", async () => {
    const f = fixture();
    expect(
      await f.handler.configureAdmittedConnector({
        kind: "connector.save-and-connect",
        operationId: "11111111-1111-4111-8111-111111111111",
        buildId: "a".repeat(64),
        tunnelId: "fixture",
        runtimeKey: "fixture-runtime-key-000000000000",
      }),
    ).toMatchObject({ ok: false, error: "AUTHORITY_CHANGE_IN_PROGRESS" });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.selected).not.toHaveBeenCalled();
  });

  it("stops cancelled selection before any verification effect", async () => {
    const f = fixture();
    expect(
      await f.handler.configureAdmittedConnector({
        kind: "connector.select-client",
      }),
    ).toMatchObject({ ok: false, error: "TUNNEL_CLIENT_PICKER_CANCELLED" });
    expect(f.selected).toHaveBeenCalledOnce();
    expect(f.verifyClient).not.toHaveBeenCalled();
  });
});

function setupFixture() {
  const settings = guidedSettingsFixture();
  const snapshot = { status: "ready", settings } as const;
  const command = {
    kind: "connector.save-and-connect",
    operationId: "11111111-1111-4111-8111-111111111111",
    buildId: fixtureBuildId,
    tunnelId: settings.connectors.secureMcp.tunnelId!,
    runtimeKey: "fixture-runtime-key-000000000000",
  } as const;
  const desktopAdmission = admissionFixture({}).desktopAdmission;
  const authorityTransitions = new AuthorityTransitionReservation();
  const active: (string | null)[] = [];
  const events: string[] = [];
  const result = ProductConfigurationResultSchema.parse({ ok: true, snapshot });
  const custody = vi.fn(async () => {
    events.push("custody");
    return { restricted: false };
  });
  const save = vi.fn(async () => {
    expect(desktopAdmission.occupied("connector-task")).toBe(true);
    expect(authorityTransitions.current()).toBe("authority-change");
    events.push("save");
    return result;
  });
  const start = vi.fn(async () => {
    expect(desktopAdmission.occupied("connector-task")).toBe(true);
    expect(authorityTransitions.current()).toBe("authority-change");
    events.push("start");
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot,
      evidence: {
        kind: "connector.runtime",
        state: "ready",
        runtimeGeneration:
          settings.connectors.secureMcp.runtime!.runtimeGeneration,
        computerGeneration: settings.computer.generation,
        buildId: fixtureBuildId,
      },
    });
  });
  const boundary = {
    desktopAdmission,
    authorityTransitions,
    setActiveAuthorityChangeKind: (kind: string | null) => active.push(kind),
    desktopGoCore: () => ({ observeOriginalStop: custody }),
    configuration: () => ({ snapshot: () => snapshot }),
    connectorCredentialStore: () => ({}),
    secureMcpConnectorRuntime: () => ({
      hasUnresolvedEffect: () => false,
      isRunning: () => false,
    }),
    buildIdentity: () => ({ buildId: fixtureBuildId }),
    configurationFailure: (error: string) =>
      ProductConfigurationResultSchema.parse({ ok: false, error, snapshot }),
    observeConnectorStart: async (
      work: () => Promise<ProductConfigurationResult>,
    ) => {
      events.push("observed-start");
      return work();
    },
    configureAdmittedProduct: save,
    startAdmittedSecureMcpConnector: start,
    deliverConfigurationReply: (
      _kind: string,
      value: ProductConfigurationResult,
    ) => value,
  };
  // Identity-bearing owner objects are partial scripted doubles at this one
  // test-only boundary. The real coordinator, result parser and admissions run.
  const handler = createConfigurationConnector(
    boundary as unknown as ConfigurationConnectorPorts,
  );
  return {
    command,
    handler,
    desktopAdmission,
    authorityTransitions,
    active,
    events,
    custody,
    save,
    start,
    snapshot,
  };
}

describe("connector Setup composition", () => {
  it("holds both reservations from original Stop custody through Save and Start", async () => {
    const f = setupFixture();
    const result = await f.handler.configureSaveAndConnect(f.command);
    expect(result).toMatchObject({
      ok: true,
      connectorSetup: {
        state: "completed",
        credentials: "saved",
        connection: "connected",
        externalVerification: "not-proven",
      },
    });
    expect(f.events).toEqual(["custody", "observed-start", "save", "start"]);
    expect(f.save).toHaveBeenCalledExactlyOnceWith({
      kind: "connector.configure",
      tunnelId: f.command.tunnelId,
      runtimeKey: f.command.runtimeKey,
    });
    expect(f.start).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.active).toEqual(["connector.save-and-connect", null]);
    expect(f.desktopAdmission.occupied("connector-task")).toBe(false);
    expect(f.desktopAdmission.configurationRequests).toBe(0);
    expect(f.authorityTransitions.current()).toBeNull();
  });

  it("keeps unresolved original Stop custody ahead of both effects", async () => {
    const f = setupFixture();
    f.custody.mockResolvedValue({ restricted: true });
    expect(await f.handler.configureSaveAndConnect(f.command)).toMatchObject({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
      connectorSetup: {
        state: "refused",
        credentials: "not-started",
        connection: "not-started",
      },
    });
    expect(f.events).toEqual([]);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.active).toEqual(["connector.save-and-connect", null]);
    expect(f.desktopAdmission.configurationRequests).toBe(0);
    expect(f.desktopAdmission.occupied("connector-task")).toBe(false);
    expect(f.authorityTransitions.current()).toBeNull();
  });

  it("retains credential UNKNOWN without issuing Start or retrying Save", async () => {
    const f = setupFixture();
    f.save.mockResolvedValue(
      ProductConfigurationResultSchema.parse({
        ok: false,
        error: "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
        snapshot: f.snapshot,
      }),
    );
    expect(await f.handler.configureSaveAndConnect(f.command)).toMatchObject({
      ok: false,
      error: "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
      connectorSetup: { state: "unknown", connection: "not-started" },
    });
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.desktopAdmission.configurationRequests).toBe(0);
    expect(f.desktopAdmission.occupied("connector-task")).toBe(false);
    expect(f.authorityTransitions.current()).toBeNull();
  });
});
