import { describe, expect, it, vi } from "vitest";
import { ProductConfigurationResultSchema } from "../../../src/pkg/product-settings/contract";
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
