import { expect, it } from "vitest";
import vector from "../../../../tests/fixtures/owner-computer-consent.json";
import { defaultSettings } from "../../../apps/desktop/settings/rules";
import { ProductSettingsSchema } from "../../../pkg/product-settings/contract";
import { ownerComputerConsentDigest } from "../infra/repo/owner-computer-consent";
import { ownerComputerConsentProjection } from "./consent";

it("serializes the exact owner consent bytes hashed by the Go current reader", () => {
  const defaults = defaultSettings(() => vector.computer.computerId);
  const settings = ProductSettingsSchema.parse({
    ...defaults,
    computer: {
      ...defaults.computer,
      ...vector.computer,
      workspaces: vector.computer.workspaces.map((workspace) => ({
        ...workspace,
        label: "Fixture",
      })),
    },
  });
  expect(JSON.stringify(ownerComputerConsentProjection(settings))).toBe(
    vector.projection,
  );
  expect(ownerComputerConsentDigest(settings)).toBe(vector.sha256);
});
