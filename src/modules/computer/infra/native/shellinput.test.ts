import { describe, expect, it } from "vitest";

import {
  exactRelative,
  inside,
  startFingerprint,
  validReadOffsets,
  validStartInput,
  type ShellStart,
} from "./shellinput";

const base: ShellStart = {
  operationId: "op-1",
  workspaceId: "w",
  relativeCwd: ".",
  command: "ls",
  timeoutMs: 1000,
  write: false,
};

describe("shell input validation", () => {
  it("accepts a plain request", () => {
    expect(validStartInput(base, undefined)).toBe(true);
    expect(validStartInput(base, 5)).toBe(true);
  });

  it.each([
    { operationId: "bad id" },
    { operationId: "" },
    { relativeCwd: "../x" },
    { command: "" },
    { command: "a\0b" },
    { command: "x".repeat(16 * 1024 + 1) },
    { stdin: "x".repeat(1024 * 1024 + 1) },
    { timeoutMs: 0 },
    { timeoutMs: 600_001 },
    { timeoutMs: 1.5 },
  ])("refuses %j", (patch) => {
    expect(validStartInput({ ...base, ...patch }, undefined)).toBe(false);
  });

  it("refuses unsafe absolute deadlines", () => {
    expect(validStartInput(base, 0)).toBe(false);
    expect(validStartInput(base, 1.5)).toBe(false);
  });

  it("accepts boundary sizes", () => {
    expect(
      validStartInput(
        { ...base, command: "x".repeat(16 * 1024), timeoutMs: 600_000 },
        undefined,
      ),
    ).toBe(true);
  });

  it("checks relative paths and containment", () => {
    expect(exactRelative(".")).toBe(true);
    expect(exactRelative("a/b")).toBe(true);
    for (const bad of ["", "/a", "a//b", "a/./b", "a/../b", "a\\b"]) {
      expect(exactRelative(bad)).toBe(false);
    }
    expect(inside("/r", "/r")).toBe(true);
    expect(inside("/r", "/r/a")).toBe(true);
    expect(inside("/r", "/rx")).toBe(false);
  });

  it("binds the deadline into the fingerprint", () => {
    expect(startFingerprint(base, undefined)).toBe(
      startFingerprint(base, undefined),
    );
    expect(startFingerprint(base, 9)).not.toBe(
      startFingerprint(base, undefined),
    );
  });

  it("validates read offsets", () => {
    const read = { handle: "h", stdoutOffset: 2, stderrOffset: 0 };
    expect(validReadOffsets(read, 2, 0)).toBe(true);
    expect(validReadOffsets(read, 1, 0)).toBe(false);
    expect(validReadOffsets({ ...read, stdoutOffset: -1 }, 5, 5)).toBe(false);
    expect(validReadOffsets({ ...read, stderrOffset: 0.5 }, 5, 5)).toBe(false);
  });
});
