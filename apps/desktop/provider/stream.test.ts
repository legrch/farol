import { describe, expect, it } from "vitest";
import { textDeltaSchema, visibleItemSchema } from "./stream";

describe("provider stream shapes", () => {
  it("accepts a bounded visible item and refuses extra fields", () => {
    const item = { sequence: 1, id: "a", channel: "answer", text: "x" };
    expect(visibleItemSchema.safeParse(item).success).toBe(true);
    expect(visibleItemSchema.safeParse({ ...item, extra: 1 }).success).toBe(
      false,
    );
    expect(
      visibleItemSchema.safeParse({ ...item, channel: "other" }).success,
    ).toBe(false);
    expect(visibleItemSchema.safeParse({ ...item, text: "" }).success).toBe(
      false,
    );
  });

  it("accepts a bounded text delta and refuses an empty one", () => {
    const delta = { sequence: 1, delta: "x", text: "x", observedCharacters: 1 };
    expect(textDeltaSchema.safeParse(delta).success).toBe(true);
    expect(textDeltaSchema.safeParse({ ...delta, delta: "" }).success).toBe(
      false,
    );
    expect(textDeltaSchema.safeParse({ ...delta, sequence: 0 }).success).toBe(
      false,
    );
  });
});
