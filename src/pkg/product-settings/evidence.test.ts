import { describe, expect, it } from "vitest";
import { ProductConfigurationEvidenceSchema } from "./evidence.ts";

describe("configuration evidence schema", () => {
  it("accepts a reset and refuses extra keys", () => {
    const reset = { kind: "chatgpt.conversation-reset", state: "new" };
    expect(ProductConfigurationEvidenceSchema.safeParse(reset).success).toBe(
      true,
    );
    expect(
      ProductConfigurationEvidenceSchema.safeParse({ ...reset, extra: 1 })
        .success,
    ).toBe(false);
  });

  it("requires a binding unless the sign-in state is unknown", () => {
    const base = {
      kind: "chatgpt.sign-in-status",
      observationId: "11111111-1111-4111-8111-111111111111",
      buildId: "a".repeat(64),
    };
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        ...base,
        state: "unknown",
        binding: null,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        ...base,
        state: "authenticated",
        binding: null,
      }).success,
    ).toBe(false);
  });
});
