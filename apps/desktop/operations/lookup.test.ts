import { describe, expect, it } from "vitest";
import type { OperationsSnapshot } from "../renderer/operations-contract";
import {
  bindingOrNull,
  diagnosticMatches,
  lookupIncomplete,
  validRequestId,
} from "./lookup";

const clean: OperationsSnapshot = {
  entries: [],
  corruptLines: 0,
  writeFailures: 0,
  droppedEntries: 0,
  unrecordedUncertainEntries: 0,
  unmappedCodes: 0,
  rejectedMetadata: 0,
  recentRejections: [],
};

describe("validRequestId", () => {
  it("accepts a versioned UUID in either case and refuses other text", () => {
    expect(validRequestId("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(validRequestId("ABCDEF00-0000-4000-B000-000000000001")).toBe(true);
    expect(validRequestId("00000000-0000-9000-8000-000000000001")).toBe(false);
    expect(validRequestId("00000000-0000-4000-c000-000000000001")).toBe(false);
    expect(validRequestId("x00000000-0000-4000-8000-000000000001")).toBe(false);
  });
});

describe("bindingOrNull", () => {
  it("passes only a lowercase 64-hex digest", () => {
    const digest = "a".repeat(64);
    expect(bindingOrNull(digest)).toBe(digest);
    for (const bad of [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      null,
      7,
      undefined,
    ])
      expect(bindingOrNull(bad)).toBeNull();
  });
});

describe("lookupIncomplete", () => {
  it("trusts a clean, complete view", () => {
    expect(lookupIncomplete(clean, 10)).toBe(false);
  });
  it.each([
    { readPending: true },
    { readIncomplete: true },
    { corruptLines: 1 },
    { writeFailures: 1 },
    { droppedEntries: 1 },
  ])("refuses a view with %j", (change) => {
    expect(lookupIncomplete({ ...clean, ...change }, 10)).toBe(true);
  });
  it("refuses a view that may have been cut at the entry limit", () => {
    const entries = [{}, {}] as never;
    expect(lookupIncomplete({ ...clean, entries }, 2)).toBe(true);
    expect(lookupIncomplete({ ...clean, entries }, 3)).toBe(false);
  });
});

describe("diagnosticMatches", () => {
  const entry = (patch: object) =>
    ({
      requestId: "r",
      kind: "computer_workspace_read",
      target: { workspaceIdentity: "w", relativePath: "p" },
      readDiagnostic: {},
      ...patch,
    }) as never;
  it("keeps only entries for the same request, workspace and path with a diagnostic", () => {
    const entries = [
      entry({}),
      entry({ requestId: "other" }),
      entry({ kind: "computer_shell_start" }),
      entry({ target: { workspaceIdentity: "x", relativePath: "p" } }),
      entry({ target: { workspaceIdentity: "w", relativePath: "q" } }),
      entry({ readDiagnostic: undefined }),
    ];
    expect(diagnosticMatches(entries, "r", "w", "p")).toEqual([entries[0]]);
  });
});
