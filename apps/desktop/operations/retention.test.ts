import { describe, expect, it } from "vitest";
import {
  dayMs,
  diagnosticsExpired,
  diagnosticsName,
  orderSegments,
  segmentName,
  segmentsToDelete,
  trustedFile,
  type RetainedSegment,
} from "./retention";

const uuid = "00000000-0000-4000-8000-000000000001";
const seg = (
  name: string,
  size: number,
  last: number | null,
  count = 1,
): RetainedSegment => ({
  name,
  file: `/d/${name}`,
  size,
  index: { first: last, last, count },
});
const limits = { days: 30, bytes: 1e9, entries: 1e9 };

describe("file names", () => {
  it("recognise only the segment and diagnostics shapes", () => {
    expect(segmentName.test(`1234567890123-${uuid}.jsonl`)).toBe(true);
    expect(segmentName.test(`1234567890123-${uuid}.jsonl.index.json`)).toBe(
      false,
    );
    expect(segmentName.test(`123-${uuid}.jsonl`)).toBe(false);
    expect(diagnosticsName.test(`1234567890123-${uuid}.diagnostics.json`)).toBe(
      true,
    );
    expect(diagnosticsName.test(`1234567890123-${uuid}.jsonl`)).toBe(false);
  });
});

describe("trustedFile", () => {
  const stat = (over: object = {}) => ({
    isFile: () => true,
    nlink: 1,
    uid: 5,
    ...over,
  });
  it("accepts a regular, singly linked file owned by the uid", () => {
    expect(trustedFile(stat(), 5)).toBe(true);
  });
  it.each([
    ["missing", undefined],
    ["not a file", stat({ isFile: () => false })],
    ["hard linked", stat({ nlink: 2 })],
    ["another owner", stat({ uid: 6 })],
  ])("refuses a file that is %s", (_name, value) => {
    expect(trustedFile(value, 5)).toBe(false);
  });
});

describe("segment retention", () => {
  const now = 100 * dayMs;
  it("orders newest first, unknown last-times first, then by name descending", () => {
    const ordered = orderSegments([
      seg("a", 1, 10),
      seg("b", 1, 20),
      seg("c", 1, null),
      seg("d", 1, 20),
    ]);
    expect(ordered.map((s) => s.name)).toEqual(["c", "d", "b", "a"]);
  });
  it("deletes segments older than the window and keeps the rest", () => {
    const ordered = orderSegments([
      seg("new", 1, now - dayMs),
      seg("old", 1, now - 31 * dayMs),
    ]);
    expect(segmentsToDelete(ordered, now, limits).map((s) => s.name)).toEqual([
      "old",
    ]);
  });
  it("keeps a segment whose last time is unknown", () => {
    expect(segmentsToDelete([seg("x", 1, null)], now, limits)).toEqual([]);
  });
  it("counts bytes and entries from the newest and deletes everything past the budget", () => {
    const ordered = orderSegments([
      seg("c", 10, now - 1, 5),
      seg("b", 10, now - 2, 5),
      seg("a", 10, now - 3, 5),
    ]);
    const cost = (segment: RetainedSegment) =>
      segment.size + JSON.stringify(segment.index).length;
    const budget = cost(ordered[0]!) + cost(ordered[1]!);
    expect(
      segmentsToDelete(ordered, now, { ...limits, bytes: budget }).map(
        (s) => s.name,
      ),
    ).toEqual(["a"]);
    expect(
      segmentsToDelete(ordered, now, { ...limits, entries: 10 }).map(
        (s) => s.name,
      ),
    ).toEqual(["a"]);
  });
});

describe("diagnosticsExpired", () => {
  const now = 100 * dayMs;
  const name = (at: number) =>
    `${String(at).padStart(13, "0")}-${uuid}.diagnostics.json`;
  it("keeps a recent file within budget", () => {
    expect(diagnosticsExpired(name(now - dayMs), 65536, now, 30)).toBe(false);
  });
  it("drops one past the budget or the window", () => {
    expect(diagnosticsExpired(name(now - dayMs), 65537, now, 30)).toBe(true);
    expect(diagnosticsExpired(name(now - 31 * dayMs), 1, now, 30)).toBe(true);
  });
});
