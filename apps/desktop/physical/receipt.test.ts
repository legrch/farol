import { describe, expect, it } from "vitest";
import { cancelSchema, failureSchema, sendResultSchema } from "./receipt";

const binding = {
  viewId: "1",
  viewGeneration: 1,
  documentGeneration: 0,
  partition: "persist:farol-dev-chatgpt",
  phase: "home",
  url: "https://chatgpt.com/",
  conversationId: null,
};

describe("receipt", () => {
  it("accepts classified failures with upper-case codes", () => {
    expect(
      failureSchema.safeParse({ state: "unknown", code: "A_1" }).success,
    ).toBe(true);
    expect(
      failureSchema.safeParse({ state: "unknown", code: "a" }).success,
    ).toBe(false);
    expect(
      failureSchema.safeParse({ state: "prepared", code: "A" }).success,
    ).toBe(false);
  });

  it("requires a full receipt for a send result", () => {
    const ok = {
      state: "submitted",
      binding,
      operationId: "o",
      evidenceId: "e",
      code: "OK",
    };
    expect(sendResultSchema.safeParse(ok).success).toBe(true);
    expect(sendResultSchema.safeParse({ ...ok, state: "sent" }).success).toBe(
      false,
    );
  });

  it("requires proof for terminal cancel states", () => {
    expect(
      cancelSchema.safeParse({ state: "confirmed-terminal", code: "X" })
        .success,
    ).toBe(false);
    expect(
      cancelSchema.safeParse({ state: "requested", binding, code: "X" })
        .success,
    ).toBe(true);
  });
});
