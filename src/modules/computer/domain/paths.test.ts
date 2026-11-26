import { describe, expect, it } from "vitest";

import { comparableWithin, isCanonicalAbsolutePath, isWithin } from "./paths";

describe("isCanonicalAbsolutePath", () => {
  it("accepts the root and clean absolute paths", () => {
    expect(isCanonicalAbsolutePath("/")).toBe(true);
    expect(isCanonicalAbsolutePath("/work/space")).toBe(true);
  });

  it("refuses relative, dotted, doubled, trailing and NUL paths", () => {
    for (const value of [
      "work",
      "",
      "/work/./space",
      "/work/../space",
      "/work//space",
      "/work/",
      "/work\0space",
    ]) {
      expect(isCanonicalAbsolutePath(value)).toBe(false);
    }
  });
});

describe("isWithin", () => {
  it("contains the root itself and its descendants", () => {
    expect(isWithin("/work", "/work")).toBe(true);
    expect(isWithin("/work", "/work/a/b")).toBe(true);
    expect(isWithin("/", "/anything")).toBe(true);
  });

  it("refuses siblings that share a name prefix and non-canonical input", () => {
    expect(isWithin("/work", "/workshop")).toBe(false);
    expect(isWithin("/work/a", "/work")).toBe(false);
    expect(isWithin("/work", "/work/../etc")).toBe(false);
    expect(isWithin("work", "/work")).toBe(false);
  });
});

describe("comparableWithin", () => {
  it("matches components ignoring case", () => {
    expect(comparableWithin("/Work/Docs", "/work/docs/a")).toBe(true);
    expect(comparableWithin("/work", "/work")).toBe(true);
  });

  it("refuses a longer root, other components and non-canonical input", () => {
    expect(comparableWithin("/work/docs/a", "/work/docs")).toBe(false);
    expect(comparableWithin("/work", "/workshop")).toBe(false);
    expect(comparableWithin("/work/", "/work/a")).toBe(false);
  });
});
