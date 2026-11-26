import { describe, expect, it } from "vitest";
import {
  ConnectorVerificationInputSchema,
  DEFAULT_READ_WINDOW_BYTES,
  EditInputSchema,
  ListInputSchema,
  ReadInputSchema,
  SearchInputSchema,
  ShellStartInputSchema,
  WriteInputSchema,
} from "./fileinput";

const hash = "a".repeat(64);

describe("file input schemas", () => {
  it("accepts a root scope only where a scope is allowed", () => {
    expect(
      ListInputSchema.safeParse({ workspaceId: "w", relativePath: "." })
        .success,
    ).toBe(true);
    expect(
      ReadInputSchema.safeParse({ workspaceId: "w", relativePath: "." })
        .success,
    ).toBe(false);
  });

  it.each(["/abs", "a/", "a\\b", "a/../b", "a//b", "a/./b", "a\u0000b", ""])(
    "refuses the path %j",
    (relativePath) => {
      expect(
        ReadInputSchema.safeParse({ workspaceId: "w", relativePath }).success,
      ).toBe(false);
    },
  );

  it("bounds a ranged read and rejects unknown keys", () => {
    const base = { workspaceId: "w", relativePath: "a.txt" };
    expect(ReadInputSchema.safeParse({ ...base, length: 3 }).success).toBe(
      false,
    );
    expect(
      ReadInputSchema.safeParse({ ...base, length: 4, offset: 0 }),
    ).toMatchObject({ success: true });
    expect(ReadInputSchema.safeParse({ ...base, extra: 1 }).success).toBe(
      false,
    );
    expect(DEFAULT_READ_WINDOW_BYTES).toBe(65_536);
  });

  it("refuses control characters in a search pattern", () => {
    const base = { workspaceId: "w", relativePath: "." };
    expect(
      SearchInputSchema.safeParse({ ...base, pattern: "ok" }).success,
    ).toBe(true);
    expect(
      SearchInputSchema.safeParse({ ...base, pattern: "a\nb" }).success,
    ).toBe(false);
  });

  it("limits connector challenges to printable ASCII without spaces", () => {
    expect(
      ConnectorVerificationInputSchema.safeParse({
        challenge: "abc-123",
        workspaceId: "w",
      }).success,
    ).toBe(true);
    expect(
      ConnectorVerificationInputSchema.safeParse({
        challenge: "a b",
        workspaceId: "w",
      }).success,
    ).toBe(false);
  });

  it("validates write and edit mutations", () => {
    const base = { operationId: "o", workspaceId: "w", relativePath: "a" };
    expect(
      WriteInputSchema.safeParse({
        ...base,
        content: "x",
        expectedSha256: null,
      }).success,
    ).toBe(true);
    expect(
      WriteInputSchema.safeParse({
        ...base,
        content: "x\0",
        expectedSha256: null,
      }).success,
    ).toBe(false);
    expect(
      EditInputSchema.safeParse({
        ...base,
        edits: [{ oldText: "a", newText: "b" }],
        expectedSha256: hash,
      }).success,
    ).toBe(true);
    expect(
      EditInputSchema.safeParse({
        ...base,
        edits: [{ oldText: "a", newText: "a" }],
        expectedSha256: hash,
      }).success,
    ).toBe(false);
    expect(
      EditInputSchema.safeParse({ ...base, edits: [], expectedSha256: hash })
        .success,
    ).toBe(false);
  });

  it("bounds shell timeouts", () => {
    const base = {
      operationId: "o",
      workspaceId: "w",
      relativeCwd: ".",
      command: "ls",
      write: false,
    };
    expect(
      ShellStartInputSchema.safeParse({ ...base, timeoutMs: 1 }).success,
    ).toBe(true);
    expect(
      ShellStartInputSchema.safeParse({ ...base, timeoutMs: 0 }).success,
    ).toBe(false);
    expect(
      ShellStartInputSchema.safeParse({ ...base, timeoutMs: 600_001 }).success,
    ).toBe(false);
  });
});
