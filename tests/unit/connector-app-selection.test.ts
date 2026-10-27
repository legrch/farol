import { describe, expect, it } from "vitest";
import {
  ProductSettingsSchema,
  SecureMcpAppSelectionSchema,
} from "../../src/pkg/product-settings/contract";
import {
  selectedConnectorApp,
  restartedConnectorAppSelection,
} from "../../src/pkg/product-settings/connector-app-selection";
import { guidedSettingsFixture } from "../fixtures/guided-onboarding";

describe("explicit NEW connector app selection", () => {
  it("carries an explicit label across a known same-tunnel restart without borrowing proof", () => {
    const settings = guidedSettingsFixture();
    const connector = settings.connectors.secureMcp;
    connector.generation = 3;
    connector.runtime!.connectorGeneration = 3;
    connector.attachment = null;
    connector.chatgptApp = {
      name: "Farol Dev",
      tunnelId: connector.tunnelId!,
      connectorGeneration: 1,
    };
    expect(selectedConnectorApp(connector)).toBeNull();
    expect(restartedConnectorAppSelection(settings)).toEqual({
      ...connector.chatgptApp,
      connectorGeneration: 3,
    });
    expect(connector.attachment).toBeNull();
    expect(connector.chatgptApp.connectorGeneration).toBe(1);
    connector.chatgptApp.tunnelId = "different";
    expect(restartedConnectorAppSelection(settings)).toBeNull();
  });
  it("does not carry a label out of an unknown or pending check", () => {
    const settings = guidedSettingsFixture();
    const connector = settings.connectors.secureMcp;
    connector.chatgptApp = {
      name: "Farol Dev",
      tunnelId: connector.tunnelId!,
      connectorGeneration: 1,
    };
    settings.setup.connect.outcomeUnknown = true;
    expect(restartedConnectorAppSelection(settings)).toBeNull();
    settings.setup.connect.outcomeUnknown = false;
    connector.appVerificationPending = true;
    expect(restartedConnectorAppSelection(settings)).toBeNull();
  });
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
