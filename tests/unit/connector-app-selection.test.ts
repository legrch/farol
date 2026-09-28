import { describe, expect, it } from "vitest";
import {
  ProductSettingsSchema,
  SecureMcpAppSelectionSchema,
} from "../../src/pkg/product-settings/contract";
import { selectedConnectorApp } from "../../src/pkg/product-settings/connector-app-selection";
import { guidedSettingsFixture } from "../fixtures/guided-onboarding";

describe("explicit NEW connector app selection", () => {
  it("has no legacy or environment-derived target in existing settings", () => {
    const connector = ProductSettingsSchema.parse(guidedSettingsFixture())
      .connectors.secureMcp;
    expect(selectedConnectorApp(connector)).toBeNull();
  });
  it("binds one owner-selected label to the exact current tunnel and generation", () => {
    const connector = guidedSettingsFixture().connectors.secureMcp;
    const selected = {
      ...connector,
      chatgptApp: {
        name: "NEW fixture",
        tunnelId: connector.tunnelId!,
        connectorGeneration: connector.generation,
      },
    };
    expect(selectedConnectorApp(selected)).toBe("NEW fixture");
    expect(
      selectedConnectorApp({
        ...selected,
        generation: selected.generation + 1,
      }),
    ).toBeNull();
    expect(
      selectedConnectorApp({ ...selected, tunnelId: "different" }),
    ).toBeNull();
  });
  it.each(["", "@Farol", "Farol\nOther", "a".repeat(65)])(
    "refuses invalid label %s",
    (name) => {
      expect(
        SecureMcpAppSelectionSchema.safeParse({
          name,
          tunnelId: "fixture",
          connectorGeneration: 1,
        }).success,
      ).toBe(false);
    },
  );
});
