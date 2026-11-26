import { describe, expect, it } from "vitest";
import type { CheckpointEnvelope } from "../../domain/checkpoint";
import { selectExpiredCheckpoints } from "./selection";

function file(id: string, createdAt: number) {
  return {
    name: `${id}.json`,
    checkpoint: { checkpointId: id, createdAt } as CheckpointEnvelope,
  };
}

describe("selectExpiredCheckpoints", () => {
  it("expires the oldest checkpoints beyond the budget", () => {
    const records = [file("a", 1), file("b", 2), file("c", 3), file("d", 4)];
    expect(
      selectExpiredCheckpoints(records, new Set(), 2).map((r) => r.name),
    ).toEqual(["b.json", "a.json"]);
  });

  it("keeps protected checkpoints and charges them to the budget", () => {
    const records = [file("a", 1), file("b", 2), file("c", 3), file("d", 4)];
    expect(
      selectExpiredCheckpoints(records, new Set(["a"]), 2).map((r) => r.name),
    ).toEqual(["c.json", "b.json"]);
  });

  it("never expires protected checkpoints even over budget", () => {
    const records = [file("a", 1), file("b", 2), file("c", 3)];
    expect(
      selectExpiredCheckpoints(records, new Set(["a", "b"]), 1).map(
        (r) => r.name,
      ),
    ).toEqual(["c.json"]);
    expect(
      selectExpiredCheckpoints(records, new Set(["a", "b", "c"]), 1),
    ).toEqual([]);
  });

  it("breaks creation-time ties on the larger checkpoint id", () => {
    const records = [file("a", 5), file("c", 5), file("b", 5)];
    expect(
      selectExpiredCheckpoints(records, new Set(), 1).map((r) => r.name),
    ).toEqual(["b.json", "a.json"]);
  });

  it("expires nothing within budget and leaves the input untouched", () => {
    const records = [file("b", 2), file("a", 1)];
    expect(selectExpiredCheckpoints(records, new Set(), 8)).toEqual([]);
    expect(records.map((r) => r.name)).toEqual(["b.json", "a.json"]);
  });
});
