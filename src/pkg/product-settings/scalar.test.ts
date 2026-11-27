import { describe, expect, it } from "vitest";
import {
  CanonicalAbsolutePathSchema,
  CanonicalTimestampSchema,
  IdentifierSchema,
  ProductRelativePathSchema,
  ProductScopeRelativePathSchema,
  ProductSearchPatternSchema,
  ProductWorkspaceEntrySchema,
  Sha256Schema,
} from "./scalar.ts";

describe("product settings scalars", () => {
  it("accepts only canonical timestamps", () => {
    expect(
      CanonicalTimestampSchema.safeParse("2026-01-02T03:04:05.000Z").success,
    ).toBe(true);
    expect(CanonicalTimestampSchema.safeParse("2026-01-02").success).toBe(
      false,
    );
  });

  it("accepts only canonical absolute paths", () => {
    for (const ok of ["/", "/a/b"])
      expect(CanonicalAbsolutePathSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["a", "/a/", "/a/../b", "/a//b", "/a/./b"])
      expect(CanonicalAbsolutePathSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts v4 identifiers and lowercase sha256 only", () => {
    expect(
      IdentifierSchema.safeParse("11111111-1111-4111-8111-111111111111")
        .success,
    ).toBe(true);
    expect(
      IdentifierSchema.safeParse("11111111-1111-1111-8111-111111111111")
        .success,
    ).toBe(false);
    expect(Sha256Schema.safeParse("a".repeat(64)).success).toBe(true);
    expect(Sha256Schema.safeParse("A".repeat(64)).success).toBe(false);
  });

  it("refuses unsafe relative paths and patterns", () => {
    expect(ProductRelativePathSchema.safeParse("a/b").success).toBe(true);
    for (const bad of ["", "/a", "a/", "a/../b", "a\\b", "a\u0000b"])
      expect(ProductRelativePathSchema.safeParse(bad).success).toBe(false);
    expect(ProductScopeRelativePathSchema.safeParse(".").success).toBe(true);
    expect(ProductSearchPatternSchema.safeParse("").success).toBe(false);
    expect(ProductSearchPatternSchema.safeParse("a\u0007").success).toBe(false);
    expect(ProductWorkspaceEntrySchema.safeParse("dir/").success).toBe(true);
    expect(ProductWorkspaceEntrySchema.safeParse("a/b").success).toBe(false);
  });
});
