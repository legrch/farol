import { describe, expect, it } from "vitest";
import {
  canonicalAbsolutePath,
  canonicalRelativePath,
  exactKeys,
  hasOwn,
  plainString,
  validApprovedRoot,
  validGitMetadataGrant,
  validRelativePaths,
  validSha256,
  validWorkspaceId,
} from "./paths";

describe("exactKeys", () => {
  it("requires the same key set in any order", () => {
    expect(exactKeys({ b: 1, a: 2 }, ["a", "b"])).toBe(true);
    expect(exactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(exactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
  });
  it("refuses non-records", () => {
    expect(exactKeys(null, [])).toBe(false);
    expect(exactKeys([], [])).toBe(false);
    expect(exactKeys("a", [])).toBe(false);
  });
});

describe("hasOwn", () => {
  it("sees only own keys of plain records", () => {
    expect(hasOwn({ a: 1 }, "a")).toBe(true);
    expect(hasOwn({}, "toString")).toBe(false);
    expect(hasOwn([1], "0")).toBe(false);
    expect(hasOwn(null, "a")).toBe(false);
  });
});

describe("plainString", () => {
  it("bounds length and refuses control characters", () => {
    expect(plainString("abc", 3)).toBe(true);
    expect(plainString("abcd", 3)).toBe(false);
    expect(plainString("", 3)).toBe(false);
    expect(plainString("a\nb", 9)).toBe(false);
    expect(plainString("a\u007fb", 9)).toBe(false);
    expect(plainString(5, 9)).toBe(false);
  });
});

describe("canonicalAbsolutePath", () => {
  it("accepts canonical absolute paths", () => {
    expect(canonicalAbsolutePath("/a/b")).toBe(true);
  });
  it("refuses relative, dotted, doubled, trailing and backslash forms", () => {
    for (const bad of [
      "a/b",
      "/",
      "/a/",
      "/a//b",
      "/a/./b",
      "/a/../b",
      "/a\\b",
      "/a/\u0000",
      `/${"x".repeat(256)}`,
      `/${"a/".repeat(2_100)}a`,
      7,
    ]) {
      expect(canonicalAbsolutePath(bad)).toBe(false);
    }
  });
});

describe("canonicalRelativePath", () => {
  it("accepts canonical relative paths and the root marker only on request", () => {
    expect(canonicalRelativePath("a/b")).toBe(true);
    expect(canonicalRelativePath(".")).toBe(false);
    expect(canonicalRelativePath(".", { root: true })).toBe(true);
  });
  it("refuses absolute, dotted, doubled, trailing and backslash forms", () => {
    for (const bad of ["", "/a", "a/", "a//b", "a/./b", "a/../b", "a\\b", 1]) {
      expect(canonicalRelativePath(bad)).toBe(false);
    }
  });
  it("counts bytes per component, not characters", () => {
    expect(canonicalRelativePath("é".repeat(127))).toBe(true);
    expect(canonicalRelativePath("é".repeat(128))).toBe(false);
  });
});

describe("workspace grants", () => {
  it("validates ids and sha256 digests", () => {
    expect(validWorkspaceId("ws-1")).toBe(true);
    expect(validWorkspaceId("x".repeat(121))).toBe(false);
    expect(validSha256("a".repeat(64))).toBe(true);
    expect(validSha256("A".repeat(64))).toBe(false);
    expect(validSha256("a".repeat(63))).toBe(false);
  });
  it("validates git metadata grants", () => {
    expect(
      validGitMetadataGrant({ gitDirectory: "/r/.git", commonDirectory: "/r" }),
    ).toBe(true);
    expect(validGitMetadataGrant({ gitDirectory: "/r/.git" })).toBe(false);
    expect(
      validGitMetadataGrant({ gitDirectory: "r", commonDirectory: "/r" }),
    ).toBe(false);
  });
  it("binds the approved root to the requested root or a descendant", () => {
    const approved = { path: "/work", device: "1", inode: "2" };
    expect(validApprovedRoot(approved, "/work")).toBe(true);
    expect(validApprovedRoot(approved, "/work/sub")).toBe(true);
    expect(validApprovedRoot(approved, "/workshop")).toBe(false);
    expect(validApprovedRoot(approved, "/other")).toBe(false);
    expect(validApprovedRoot({ ...approved, device: "x" }, "/work")).toBe(
      false,
    );
    expect(validApprovedRoot({ ...approved, inode: "" }, "/work")).toBe(false);
    expect(validApprovedRoot({ ...approved, extra: 1 }, "/work")).toBe(false);
    expect(validApprovedRoot(approved, 5)).toBe(false);
  });
  it("accepts up to 64 unique canonical relative paths", () => {
    expect(validRelativePaths([])).toBe(true);
    expect(validRelativePaths(["a", "b"])).toBe(true);
    expect(validRelativePaths(["a", "a"])).toBe(false);
    expect(validRelativePaths(["/a"])).toBe(false);
    expect(
      validRelativePaths(Array.from({ length: 65 }, (_, i) => `p${i}`)),
    ).toBe(false);
  });
});
