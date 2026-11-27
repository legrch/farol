import { describe, expect, it } from "vitest";
import { ProductConfigurationCommandSchema } from "./command.ts";

const id = "11111111-1111-4111-8111-111111111111";

describe("configuration command schema", () => {
  it("accepts bare and parameterised commands", () => {
    for (const command of [
      { kind: "connector.start" },
      { kind: "computer.remove-workspace", workspaceId: id },
      { kind: "onboarding.open-help", destination: "chatgpt" },
    ])
      expect(ProductConfigurationCommandSchema.safeParse(command).success).toBe(
        true,
      );
  });

  it("refuses unknown kinds, unknown keys and bad parameters", () => {
    for (const command of [
      { kind: "unknown" },
      { kind: "connector.start", extra: 1 },
      { kind: "computer.remove-workspace", workspaceId: "x" },
      { kind: "onboarding.open-help", destination: "elsewhere" },
      {
        kind: "computer.update-exclusions",
        workspaceId: id,
        excludedPaths: ["a", "a"],
      },
    ])
      expect(ProductConfigurationCommandSchema.safeParse(command).success).toBe(
        false,
      );
  });
});
