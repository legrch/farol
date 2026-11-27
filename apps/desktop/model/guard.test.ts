import { describe, expect, it } from "vitest";
import { bearerMatches, isLoopbackAddress } from "./guard";

describe("bearerMatches", () => {
  it("accepts only the exact bearer line", () => {
    expect(bearerMatches("Bearer fixture-token", "fixture-token")).toBe(true);
    expect(bearerMatches("Bearer fixture-token ", "fixture-token")).toBe(false);
    expect(bearerMatches("bearer fixture-token", "fixture-token")).toBe(false);
    expect(bearerMatches("fixture-token", "fixture-token")).toBe(false);
    expect(bearerMatches("Bearer other", "fixture-token")).toBe(false);
  });
});

describe("isLoopbackAddress", () => {
  it("accepts the three loopback spellings and nothing else", () => {
    for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
      expect(isLoopbackAddress(ok)).toBe(true);
    for (const bad of [undefined, "", "10.0.0.1", "127.0.0.2", "localhost"])
      expect(isLoopbackAddress(bad)).toBe(false);
  });
});
