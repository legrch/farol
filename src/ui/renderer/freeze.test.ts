import { describe, expect, it } from "vitest";
import { immutable } from "./freeze";

describe("immutable", () => {
  it("freezes nested plain data and returns the same value", () => {
    const value = { a: { b: [1, { c: 2 }] } };
    expect(immutable(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });

  it("passes primitives and null through", () => {
    expect(immutable(null)).toBeNull();
    expect(immutable(3)).toBe(3);
    expect(immutable("x")).toBe("x");
  });
});
