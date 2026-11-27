import { describe, expect, it } from "vitest";
import {
  ConnectorRuntimeKeySchema,
  ConnectorSetupReceiptSchema,
  ConnectorTunnelIdSchema,
  DefaultSecureMcpConnector,
  SecureMcpAppSelectionSchema,
  SecureMcpConnectorSchema,
} from "./connector.ts";

describe("connector schemas", () => {
  it("accepts the default connector and applies nullable defaults", () => {
    expect(SecureMcpConnectorSchema.parse(DefaultSecureMcpConnector)).toEqual(
      DefaultSecureMcpConnector,
    );
    expect(
      SecureMcpConnectorSchema.safeParse({
        ...DefaultSecureMcpConnector,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("validates app selection, tunnel id and runtime key", () => {
    expect(
      SecureMcpAppSelectionSchema.safeParse({
        name: "App",
        tunnelId: "t-1",
        connectorGeneration: 1,
      }).success,
    ).toBe(true);
    expect(
      SecureMcpAppSelectionSchema.safeParse({
        name: " bad",
        tunnelId: "t-1",
        connectorGeneration: 1,
      }).success,
    ).toBe(false);
    expect(ConnectorTunnelIdSchema.safeParse("a b").success).toBe(false);
    expect(ConnectorRuntimeKeySchema.safeParse("x".repeat(20)).success).toBe(
      true,
    );
    expect(ConnectorRuntimeKeySchema.safeParse("x".repeat(19)).success).toBe(
      false,
    );
  });

  it("refuses a setup receipt that is not a valid receipt", () => {
    expect(ConnectorSetupReceiptSchema.safeParse({}).success).toBe(false);
    expect(ConnectorSetupReceiptSchema.safeParse(null).success).toBe(false);
  });
});
