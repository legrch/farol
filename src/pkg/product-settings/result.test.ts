import { describe, expect, it } from "vitest";
import { ProductConfigurationResultSchema } from "./result.ts";

const failure = {
  ok: false,
  error: "SETTINGS_UNAVAILABLE",
  snapshot: { status: "error", error: "SETTINGS_CORRUPT" },
};

describe("configuration result schema", () => {
  it("accepts a failure and refuses an unknown error code", () => {
    expect(ProductConfigurationResultSchema.safeParse(failure).success).toBe(
      true,
    );
    expect(
      ProductConfigurationResultSchema.safeParse({ ...failure, error: "NOPE" })
        .success,
    ).toBe(false);
  });

  it("is strict and discriminated on ok", () => {
    expect(
      ProductConfigurationResultSchema.safeParse({ ...failure, extra: 1 })
        .success,
    ).toBe(false);
    expect(
      ProductConfigurationResultSchema.safeParse({ ok: true, error: "X" })
        .success,
    ).toBe(false);
  });
});
