import { describe, expect, it } from "vitest";
import type { OperationsSnapshot } from "../renderer/operations-contract";
import {
  addDiagnostics,
  completedTail,
  growingTail,
  mergeDiagnostics,
  settleEntries,
  trustedActiveLifecycles,
  type DiagnosticCounts,
} from "./snapshot";

const counts = (n: number, rejections: string[] = []): DiagnosticCounts => ({
  unmappedCodes: n,
  rejectedMetadata: n,
  recentRejections: rejections as never,
  writeFailures: n,
  droppedEntries: n,
  unrecordedUncertainEntries: n,
});
const snapshot = (
  over: Partial<OperationsSnapshot> = {},
): OperationsSnapshot => ({
  entries: [],
  corruptLines: 0,
  ...counts(0),
  ...over,
});

describe("diagnostics", () => {
  it("merges counters and keeps the five newest rejections", () => {
    const merged = mergeDiagnostics(
      snapshot({ ...counts(1, ["a", "b", "c"]) }),
      counts(2, ["d", "e", "f"]),
    );
    expect(merged.writeFailures).toBe(3);
    expect(merged.unrecordedUncertainEntries).toBe(3);
    expect(merged.recentRejections).toEqual(["b", "c", "d", "e", "f"]);
  });
  it("folds a file into the running totals in place", () => {
    const totals = counts(1, ["a"]);
    addDiagnostics(totals, counts(4, ["b"]));
    expect(totals).toEqual(counts(5, ["a", "b"]));
  });
});

describe("settleEntries", () => {
  const e = (
    id: string,
    at: number,
    phase?: "started" | "observed",
    life = id,
  ) =>
    ({ id, at, ...(phase ? { lifecycle: { id: life, phase } } : {}) }) as never;
  it("drops a start that has an observation, sorts oldest first and keeps the newest", () => {
    const settled = settleEntries(
      [
        e("c", 3),
        e("s", 1, "started", "x"),
        e("o", 4, "observed", "x"),
        e("lone", 2, "started", "y"),
      ],
      3,
    ) as { id: string }[];
    expect(settled.map((x) => x.id)).toEqual(["lone", "c", "o"]);
    expect(
      (
        settleEntries([e("a", 1), e("b", 2), e("c", 3)], 2) as { id: string }[]
      ).map((x) => x.id),
    ).toEqual(["b", "c"]);
  });
});

describe("trustedActiveLifecycles", () => {
  const ids = ["a", "b"];
  it("reports active ids from a trustworthy read", () => {
    expect(trustedActiveLifecycles(false, snapshot(), counts(0), ids)).toEqual(
      ids,
    );
  });
  it.each([
    ["closed", true, snapshot(), counts(0)],
    ["pending", false, snapshot({ readPending: true }), counts(0)],
    ["corrupt", false, snapshot({ corruptLines: 1 }), counts(0)],
    ["write failure", false, snapshot(), { ...counts(0), writeFailures: 1 }],
    ["dropped", false, snapshot(), { ...counts(0), droppedEntries: 1 }],
  ])("reports none when %s", (_name, closed, snap, diag) => {
    expect(trustedActiveLifecycles(closed, snap, diag, ids)).toEqual([]);
  });
});

describe("tail growth", () => {
  const text = Buffer.from('{"a":1}\n{"b"');
  it("finds the unterminated fragment when the file grew within bounds", () => {
    const grown = growingTail(text, text.length, text.length + 5, 64 * 1024);
    expect(grown?.offset).toBe(8);
    expect(grown?.fragment.toString()).toBe('{"b"');
    expect(grown?.size).toBe(text.length + 5 - 8);
  });
  it.each([
    ["no growth", text, text.length, text.length],
    ["too large", text, text.length, 64 * 1024 + 16385],
    ["empty", Buffer.alloc(0), 0, 5],
    ["terminated", Buffer.from("x\n"), 2, 9],
  ])("ignores %s", (_name, buffer, stat, after) => {
    expect(growingTail(buffer, stat, after, 64 * 1024)).toBeUndefined();
  });
  it("completes a tail only from a full re-read that starts with the fragment", () => {
    const fragment = Buffer.from('{"b"');
    const full = Buffer.from('{"b":2}\n');
    expect(completedTail(full, full.length, full.length, fragment)).toBe(
      '{"b":2}',
    );
    expect(
      completedTail(full, full.length - 1, full.length, fragment),
    ).toBeUndefined();
    expect(
      completedTail(Buffer.from('{"c":2}\n'), 8, 8, fragment),
    ).toBeUndefined();
    expect(completedTail(Buffer.from('{"b"'), 4, 4, fragment)).toBeUndefined();
  });
});
