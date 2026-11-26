import { describe, expect, it } from "vitest";
import { planEviction, queuedEntry, type QueuedEntry } from "./queue";

const row = (
  bytes: number,
  droppable: boolean,
  lifecycle?: QueuedEntry["lifecycle"],
): QueuedEntry => ({
  encoded: Buffer.alloc(bytes),
  at: 0,
  lifecycle,
  droppable,
});

describe("queuedEntry", () => {
  it.each([
    ["pending", false],
    ["unknown", false],
    ["done", true],
    ["failed", true],
    ["refused", true],
  ] as const)("marks %s droppable=%s", (outcome, droppable) => {
    const item = queuedEntry({ id: "e", at: 4, outcome } as never);
    expect(item.droppable).toBe(droppable);
    expect(item.at).toBe(4);
    expect(item.encoded.toString().endsWith("\n")).toBe(true);
  });
});

describe("planEviction", () => {
  it("evicts nothing while the item fits", () => {
    expect(planEviction([row(10, true)], row(10, true), 10, 4, 100)).toEqual({
      victims: [],
      fits: true,
    });
  });
  it("evicts droppable rows oldest first and never an uncertain one", () => {
    const queue = [row(10, false), row(10, true), row(10, true)];
    expect(planEviction(queue, row(10, true), 30, 3, 100)).toEqual({
      victims: [1],
      fits: true,
    });
  });
  it("evicts by bytes until it fits", () => {
    const queue = [row(40, true), row(40, true), row(20, true)];
    expect(planEviction(queue, row(50, true), 100, 10, 100)).toEqual({
      victims: [0, 1],
      fits: true,
    });
  });
  it("does not fit when only uncertain rows remain", () => {
    const queue = [row(10, false), row(10, false)];
    expect(planEviction(queue, row(10, true), 20, 2, 100)).toEqual({
      victims: [],
      fits: false,
    });
  });
  it("lets an observation replace its own start even though the start is not droppable", () => {
    const start = row(10, false, { id: "a", phase: "started" });
    const other = row(10, false, { id: "b", phase: "started" });
    const observed = row(10, true, { id: "a", phase: "observed" });
    expect(planEviction([other, start], observed, 20, 2, 100)).toEqual({
      victims: [1],
      fits: true,
    });
    const uncertain = row(10, false, { id: "a", phase: "observed" });
    expect(planEviction([start], uncertain, 10, 1, 100).fits).toBe(false);
  });
});
