import { describe, expect, it } from "vitest";
import {
  archiveMoved,
  archivePredecessorAdmitted,
  archiveUntrusted,
  type ArchiveStat,
} from "./history";

const d = (c: string) => c.repeat(64);
const build = (c: string, version: string) => ({
  digest: d(c),
  version,
  buildId: d(c === "a" ? "b" : c === "c" ? "d" : "f"),
});
const one = build("a", "1.0.0");
const two = build("c", "2.0.0");
const three = build("e", "3.0.0");
const first = { operationId: "1".repeat(32), source: one, target: two };
const second = { operationId: "2".repeat(32), source: two, target: three };
const order = (left: string, right: string) =>
  left === right ? 0 : left > right ? 1 : -1;

describe("archivePredecessorAdmitted", () => {
  const settled = {
    phase: "completed" as const,
    runningBuildId: two.buildId,
    operation: first,
  };
  it("admits the direct predecessor of the next operation", () => {
    expect(
      archivePredecessorAdmitted({
        previous: settled,
        next: second,
        compareVersions: order,
      }),
    ).toBe(true);
  });
  it("admits a manual replacement between two updates", () => {
    expect(
      archivePredecessorAdmitted({
        previous: settled,
        next: { ...second, source: build("9", "2.5.0") },
        compareVersions: order,
      }),
    ).toBe(true);
  });
  it("refuses the same operation and an unrelated older copy", () => {
    expect(
      archivePredecessorAdmitted({
        previous: { ...settled, operation: second },
        next: second,
        compareVersions: order,
      }),
    ).toBe(false);
    expect(
      archivePredecessorAdmitted({
        previous: settled,
        next: { ...second, source: build("9", "1.5.0") },
        compareVersions: order,
      }),
    ).toBe(false);
    expect(
      archivePredecessorAdmitted({
        previous: { ...settled, phase: "verified" },
        next: { ...second, source: build("9", "2.5.0") },
        compareVersions: order,
      }),
    ).toBe(false);
  });
  it("refuses when the versions cannot be compared", () => {
    expect(
      archivePredecessorAdmitted({
        previous: settled,
        next: { ...second, source: build("9", "2.5.0") },
        compareVersions: () => null,
      }),
    ).toBe(false);
  });
});

const stat = (over: Partial<ArchiveStat> = {}): ArchiveStat => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  uid: 501,
  mode: 0o100600,
  size: 10,
  dev: 1,
  ino: 2,
  mtimeMs: 3,
  ctimeMs: 4,
  ...over,
});

describe("archiveUntrusted", () => {
  it("accepts a private regular file of the original size", () => {
    expect(archiveUntrusted(stat(), 501, 10)).toBe(false);
  });
  it("refuses another kind, owner, mode or size", () => {
    expect(archiveUntrusted(stat({ isFile: () => false }), 501, 10)).toBe(true);
    expect(
      archiveUntrusted(stat({ isSymbolicLink: () => true }), 501, 10),
    ).toBe(true);
    expect(archiveUntrusted(stat(), 502, 10)).toBe(true);
    expect(archiveUntrusted(stat(), undefined, 10)).toBe(true);
    expect(archiveUntrusted(stat({ mode: 0o100644 }), 501, 10)).toBe(true);
    expect(archiveUntrusted(stat(), 501, 11)).toBe(true);
  });
});

describe("archiveMoved", () => {
  it("is quiet for identical metadata and sees every moved field", () => {
    expect(archiveMoved(stat(), stat())).toBe(false);
    for (const over of [
      { dev: 9 },
      { ino: 9 },
      { size: 9 },
      { mtimeMs: 9 },
      { ctimeMs: 9 },
      { mode: 0o100644 },
      { uid: 9 },
    ])
      expect(archiveMoved(stat(), stat(over))).toBe(true);
  });
});
