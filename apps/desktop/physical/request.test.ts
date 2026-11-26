import { describe, expect, it } from "vitest";
import { bindingSchema, boundSchema, prepareSchema } from "./request";

const view = {
  viewId: "1",
  viewGeneration: 1,
  documentGeneration: 0,
  partition: "persist:farol-dev-chatgpt",
};
const home = {
  ...view,
  phase: "home",
  url: "https://chatgpt.com/",
  conversationId: null,
};

describe("request", () => {
  it("accepts home and conversation bindings only with matching ids", () => {
    expect(bindingSchema.safeParse(home).success).toBe(true);
    expect(
      bindingSchema.safeParse({ ...home, conversationId: "c" }).success,
    ).toBe(false);
    expect(
      bindingSchema.safeParse({ ...home, phase: "conversation" }).success,
    ).toBe(false);
  });

  it("rejects unknown partitions and extra keys", () => {
    expect(
      bindingSchema.safeParse({ ...home, partition: "persist:other" }).success,
    ).toBe(false);
    expect(
      boundSchema.safeParse({
        operationId: "o",
        binding: home,
        deadlineMillis: 1,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("validates prepare targets", () => {
    const ok = { operationId: "o", deadlineMillis: 1 };
    expect(
      prepareSchema.safeParse({ ...ok, target: { kind: "new-saved" } }).success,
    ).toBe(true);
    expect(
      prepareSchema.safeParse({ ...ok, target: { kind: "owned-saved" } })
        .success,
    ).toBe(false);
  });
});
