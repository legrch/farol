import { describe, expect, it } from "vitest";
import {
  isUnderAnyPrefix,
  plainPath,
  validDeniedPath,
  validTrackedPath,
} from "./paths";

describe("plainPath", () => {
  it("admits only normalised absolute paths without quoting hazards", () => {
    expect(plainPath("/Users/a/b")).toBe(true);
    for (const bad of [
      "/",
      "relative/x",
      "/a/../b",
      "/a//b",
      "/a\nb",
      '/a"b',
      "/a\\b",
      "/a\0b",
      `/${"x".repeat(4_096)}`,
    ]) {
      expect(plainPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("validDeniedPath", () => {
  it("admits only clean relative paths", () => {
    expect(validDeniedPath("a/b")).toBe(true);
    for (const bad of [
      "",
      "/a",
      "a/",
      "a\\b",
      "a//b",
      "a/./b",
      "a/../b",
      "..",
    ]) {
      expect(validDeniedPath(bad), bad).toBe(false);
    }
  });
});

describe("validTrackedPath", () => {
  it("admits clean repository-relative paths", () => {
    expect(validTrackedPath("src/a b.ts")).toBe(true);
    expect(validTrackedPath("é/ü")).toBe(true);
  });

  it("refuses unsafe shapes", () => {
    for (const bad of [
      "",
      "/a",
      "a\nb",
      "a\rb",
      "a\0b",
      "a\\b",
      "a//b",
      "./a",
      "a/../b",
      "a/",
      "x".repeat(4_097),
    ]) {
      expect(validTrackedPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("isUnderAnyPrefix", () => {
  it("matches whole segments only", () => {
    expect(isUnderAnyPrefix("private/x", ["private"])).toBe(true);
    expect(isUnderAnyPrefix("private", ["private"])).toBe(true);
    expect(isUnderAnyPrefix("privateer/x", ["private"])).toBe(false);
    expect(isUnderAnyPrefix("a", ["a/b"])).toBe(false);
    expect(isUnderAnyPrefix("a/b/c", ["x", "a/b"])).toBe(true);
    expect(isUnderAnyPrefix("a", [])).toBe(false);
  });

  it("folds case and Unicode normalisation", () => {
    expect(isUnderAnyPrefix("Private/x", ["private"])).toBe(true);
    expect(isUnderAnyPrefix("privé/x", ["privé"])).toBe(true);
    expect(isUnderAnyPrefix("STRASSE/x", ["straße"])).toBe(true);
  });
});
