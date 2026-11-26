import { describe, expect, it } from "vitest";

import {
  comparableContainsLexically,
  comparableWithin,
  containsLexically,
  isCanonicalAbsolutePath,
  isWithin,
  relativeBelow,
} from "./within";

// Rows are [root, candidate, exact, comparable]: `exact` is what a grant may
// rely on, `comparable` what a denial must catch (case-insensitive).
const rows: readonly (readonly [string, string, boolean, boolean])[] = [
  ["/", "/", true, true],
  ["/", "/a", true, true],
  ["/", "/A/b", true, true],
  ["/a", "/", false, false],
  ["/a", "/a", true, true],
  ["/a", "/a/b", true, true],
  ["/a", "/ab", false, false],
  ["/a", "/A", false, true],
  ["/a", "/A/b", false, true],
  ["/a/b", "/a", false, false],
  ["/a/b", "/A/B", false, true],
  ["/a", "/b", false, false],
];

describe("containment", () => {
  it.each(rows)(
    "%s contains %s: exact %s, comparable %s",
    (root, path, exact, comparable) => {
      expect(isWithin(root, path)).toBe(exact);
      expect(containsLexically(root, path)).toBe(exact);
      expect(comparableWithin(root, path)).toBe(comparable);
      expect(comparableContainsLexically(root, path)).toBe(comparable);
    },
  );

  it("refuses non-canonical input in the checked forms", () => {
    for (const bad of ["", "a", "/a/", "/a//b", "/a/./b", "/a/../b", "/a\0b"]) {
      expect(isCanonicalAbsolutePath(bad)).toBe(false);
      expect(isWithin("/", bad)).toBe(false);
      expect(isWithin(bad, "/a")).toBe(false);
      expect(comparableWithin("/", bad)).toBe(false);
      expect(comparableWithin(bad, "/a")).toBe(false);
    }
    expect(isCanonicalAbsolutePath("/")).toBe(true);
    expect(isCanonicalAbsolutePath("/a/b")).toBe(true);
  });

  it("slices the part below a root, including the filesystem root", () => {
    expect(relativeBelow("/", "/")).toBe(".");
    expect(relativeBelow("/", "/a/b")).toBe("a/b");
    expect(relativeBelow("/a", "/a")).toBe(".");
    expect(relativeBelow("/a", "/a/b/c")).toBe("b/c");
    expect(relativeBelow("/a", "/ab")).toBeNull();
    expect(relativeBelow("/a/b", "/a")).toBeNull();
  });
});
