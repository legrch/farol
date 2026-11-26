import { describe, expect, it } from "vitest";
import { SetupReadinessSchema, SetupStepIdSchema } from "./setup.ts";

describe("setup schemas", () => {
  it("keeps the ordered step ids", () => {
    expect(SetupStepIdSchema.options).toEqual([
      "chatgpt",
      "computer",
      "connect",
      "hosts",
      "verify",
    ]);
    expect(SetupStepIdSchema.safeParse("other").success).toBe(false);
  });

  it("is strict about readiness", () => {
    const ready = {
      visited: false,
      skipped: false,
      configured: false,
      reachable: "unknown",
      verified: null,
      needsAction: null,
      unavailable: null,
      outcomeUnknown: false,
    };
    expect(SetupReadinessSchema.safeParse(ready).success).toBe(true);
    expect(SetupReadinessSchema.safeParse({ ...ready, extra: 1 }).success).toBe(
      false,
    );
    expect(
      SetupReadinessSchema.safeParse({ ...ready, reachable: "maybe" }).success,
    ).toBe(false);
  });
});
