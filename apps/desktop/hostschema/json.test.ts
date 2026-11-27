import { describe, expect, it } from "vitest";
import { array, child, contractError, record } from "./json";

describe("host schema JSON helpers", () => {
  it("accepts only plain objects as records", () => {
    expect(record({})).toBe(true);
    expect(record([])).toBe(false);
    expect(record(null)).toBe(false);
    expect(record("text")).toBe(false);
  });

  it("walks a key path and answers undefined on any miss", () => {
    const value = { a: { b: { c: 1 } } };
    expect(child(value, "a", "b", "c")).toBe(1);
    expect(child(value, "a", "x", "c")).toBeUndefined();
    expect(child([], "a")).toBeUndefined();
    expect(child(value)).toBe(value);
  });

  it("treats a non-array as empty", () => {
    expect(array([1, 2])).toEqual([1, 2]);
    expect(array({})).toEqual([]);
    expect(array(undefined)).toEqual([]);
  });

  it("throws the bare code", () => {
    expect(() => contractError("CODE_ONE")).toThrow(new Error("CODE_ONE"));
  });
});
