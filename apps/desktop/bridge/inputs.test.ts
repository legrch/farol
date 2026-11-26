import { describe, expect, it } from "vitest";
import {
  EditInputSchema,
  ListInputSchema,
  ProcessStartSchema,
  ReadInputSchema,
  RemoveInputSchema,
  SearchInputSchema,
  WriteInputSchema,
  relativePath,
} from "./inputs.ts";

const digest = "a".repeat(64);
const id = "operation-1";

describe("relativePath", () => {
  it("accepts the root dot only when the scope allows it", () => {
    expect(relativePath(".", true)).toBe(true);
    expect(relativePath(".", false)).toBe(false);
  });
  it("refuses escapes, absolute paths and control characters", () => {
    for (const value of [
      "",
      "/a",
      "a/",
      "a\\b",
      "a//b",
      "./a",
      "a/../b",
      "a\u0000b",
      "a\u007fb",
    ])
      expect(relativePath(value, true)).toBe(false);
    expect(relativePath("a/b.txt", false)).toBe(true);
  });
});

describe("input schemas", () => {
  it("is strict about unknown keys", () => {
    expect(
      ListInputSchema.safeParse({
        workspaceId: "w",
        relativePath: ".",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      ListInputSchema.safeParse({ workspaceId: "w", relativePath: "." })
        .success,
    ).toBe(true);
  });
  it("bounds read length and offset", () => {
    const base = { workspaceId: "w", relativePath: "a.txt" };
    expect(ReadInputSchema.safeParse({ ...base, length: 3 }).success).toBe(
      false,
    );
    expect(
      ReadInputSchema.safeParse({ ...base, length: 4, offset: 0 }).success,
    ).toBe(true);
    expect(ReadInputSchema.safeParse({ ...base, length: 262145 }).success).toBe(
      false,
    );
  });
  it("refuses control characters in search patterns", () => {
    const base = { workspaceId: "w", relativePath: "." };
    expect(
      SearchInputSchema.safeParse({ ...base, pattern: "ok" }).success,
    ).toBe(true);
    expect(
      SearchInputSchema.safeParse({ ...base, pattern: "a\nb" }).success,
    ).toBe(false);
  });
  it("requires a lowercase sha256 for removal and replacement", () => {
    const base = { operationId: id, workspaceId: "w", relativePath: "a.txt" };
    expect(
      RemoveInputSchema.safeParse({ ...base, expectedSha256: digest }).success,
    ).toBe(true);
    expect(
      RemoveInputSchema.safeParse({ ...base, expectedSha256: "A".repeat(64) })
        .success,
    ).toBe(false);
    expect(
      WriteInputSchema.safeParse({
        ...base,
        content: "x",
        expectedSha256: null,
      }).success,
    ).toBe(true);
  });
  it("rejects no-op edits and empty edit lists", () => {
    const base = {
      operationId: id,
      workspaceId: "w",
      relativePath: "a.txt",
      expectedSha256: digest,
    };
    expect(EditInputSchema.safeParse({ ...base, edits: [] }).success).toBe(
      false,
    );
    expect(
      EditInputSchema.safeParse({
        ...base,
        edits: [{ oldText: "a", newText: "a" }],
      }).success,
    ).toBe(false);
    expect(
      EditInputSchema.safeParse({
        ...base,
        edits: [{ oldText: "a", newText: "b" }],
      }).success,
    ).toBe(true);
  });
  it("requires a boolean write flag for processes", () => {
    const base = {
      operationId: id,
      workspaceId: "w",
      relativeCwd: ".",
      command: "ls",
    };
    expect(ProcessStartSchema.safeParse(base).success).toBe(false);
    expect(
      ProcessStartSchema.safeParse({ ...base, write: false }).success,
    ).toBe(true);
  });
});
