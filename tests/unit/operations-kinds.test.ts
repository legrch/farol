import { describe, expect, it } from "vitest";
import { OperationMetadataSchema } from "../../apps/desktop/renderer/operations-contract";
import { ProductConfigurationCommandSchema } from "../../src/pkg/product-settings/contract";

describe("configuration command kinds as operation metadata", () => {
  const kinds = ProductConfigurationCommandSchema.options.map(
    (option) => option.shape.kind.value,
  );

  it("reads a non-empty command list from the real schema", () => {
    expect(kinds.length).toBeGreaterThan(50);
  });

  it.each(kinds)("records %s", (kind) => {
    expect(
      OperationMetadataSchema.safeParse({ source: "Setup", kind, target: {} })
        .success,
    ).toBe(true);
  });
});
