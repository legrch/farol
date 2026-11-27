import { describe, expect, it } from "vitest";
import {
  continuationFollows,
  foldFinalAnswer,
  itemsNextCursor,
  knownTurnStatus,
  latestTurnIs,
  observedTurns,
  statusNextCursor,
  statusPage,
} from "./turnpage";

describe("knownTurnStatus", () => {
  it("accepts only the four provider statuses", () => {
    for (const status of ["inProgress", "completed", "failed", "interrupted"])
      expect(knownTurnStatus(status)).toBe(true);
    expect(knownTurnStatus("queued")).toBe(false);
    expect(knownTurnStatus(undefined)).toBe(false);
  });
});

describe("observedTurns", () => {
  const page = (data: unknown, nextCursor: unknown = null) => ({
    data,
    nextCursor,
  });

  it("maps a valid page and reports more turns", () => {
    expect(
      observedTurns(page([{ id: "u1", status: "completed", extra: 1 }], "c")),
    ).toEqual({
      turns: [{ id: "u1", status: "completed" }],
      hasMoreTurns: true,
    });
    expect(observedTurns(page([]))?.hasMoreTurns).toBe(false);
  });

  it("is unverified for a malformed page", () => {
    expect(observedTurns(null)).toBeNull();
    expect(observedTurns(page("x"))).toBeNull();
    expect(observedTurns(page(Array(101).fill({})))).toBeNull();
    expect(observedTurns(page([], ""))).toBeNull();
    expect(observedTurns(page([], 3))).toBeNull();
    expect(observedTurns({ data: [] })).toBeNull();
    expect(
      observedTurns(page([{ id: "bad id", status: "failed" }])),
    ).toBeNull();
    expect(observedTurns(page([{ id: "u1", status: "queued" }]))).toBeNull();
    expect(observedTurns(page([null]))).toBeNull();
  });
});

describe("latestTurnIs and continuationFollows", () => {
  it("matches the newest turn id and status exactly", () => {
    const latest = { data: [{ id: "u1", status: "completed" }] };
    expect(latestTurnIs(latest, "u1", "completed")).toBe(true);
    expect(latestTurnIs(latest, "u2", "completed")).toBe(false);
    expect(latestTurnIs(latest, "u1", "inProgress")).toBe(false);
    expect(latestTurnIs({ data: [] }, "u1", "completed")).toBe(false);
    expect(latestTurnIs(null, "u1", "completed")).toBe(false);
  });

  it("requires the child immediately before the parent", () => {
    const response = { data: [{ id: "child" }, { id: "parent" }] };
    expect(continuationFollows(response, "child", "parent")).toBe(true);
    expect(continuationFollows(response, "parent", "child")).toBe(false);
    expect(continuationFollows({ data: [{ id: "child" }] }, "child", "p")).toBe(
      false,
    );
    expect(continuationFollows(null, "child", "parent")).toBe(false);
  });
});

describe("statusPage", () => {
  it("finds one turn with a known status", () => {
    expect(
      statusPage({ data: [{ id: "u1", status: "failed" }] }, "u1"),
    ).toEqual({ kind: "found", status: "failed" });
  });

  it("is invalid for duplicates, unknown status or a bad page", () => {
    expect(
      statusPage(
        {
          data: [
            { id: "u1", status: "failed" },
            { id: "u1", status: "failed" },
          ],
        },
        "u1",
      ).kind,
    ).toBe("invalid");
    expect(
      statusPage({ data: [{ id: "u1", status: "queued" }] }, "u1").kind,
    ).toBe("invalid");
    expect(statusPage(null, "u1").kind).toBe("invalid");
    expect(statusPage({ data: Array(101).fill({}) }, "u1").kind).toBe(
      "invalid",
    );
  });

  it("reports the cursor when the turn is absent", () => {
    expect(statusPage({ data: [], nextCursor: "c2" }, "u1")).toEqual({
      kind: "absent",
      nextCursor: "c2",
    });
  });
});

describe("cursors", () => {
  it("stops status paging on null, non-string or a repeated cursor", () => {
    expect(statusNextCursor("c", new Set())).toBe("c");
    expect(statusNextCursor("", new Set())).toBe("");
    expect(statusNextCursor(null, new Set())).toBeNull();
    expect(statusNextCursor(4, new Set())).toBeNull();
    expect(statusNextCursor("c", new Set(["c"]))).toBeNull();
  });

  it("stops items paging on an empty, non-string or repeated cursor", () => {
    expect(itemsNextCursor("c", new Set())).toBe("c");
    expect(itemsNextCursor("", new Set())).toBeNull();
    expect(itemsNextCursor(null, new Set())).toBeNull();
    expect(itemsNextCursor("c", new Set(["c"]))).toBeNull();
  });
});

describe("foldFinalAnswer", () => {
  const final = (id: string, text: unknown) => ({
    turnId: "u1",
    item: { id, type: "agentMessage", phase: "final_answer", text },
  });
  const other = { turnId: "u1", item: { id: "i0", type: "reasoning" } };

  it("takes the single explicit final answer", () => {
    expect(foldFinalAnswer([other, final("i1", "done")], "u1", null)).toEqual({
      final: { id: "i1", text: "done" },
    });
    expect(foldFinalAnswer([other], "u1", null)).toEqual({ final: null });
  });

  it("is unverified for a second answer, even across pages", () => {
    expect(
      foldFinalAnswer([final("i1", "a"), final("i2", "b")], "u1", null),
    ).toBeNull();
    expect(
      foldFinalAnswer([final("i2", "b")], "u1", { id: "i1", text: "a" }),
    ).toBeNull();
  });

  it("is unverified for an empty, oversized or foreign entry", () => {
    expect(foldFinalAnswer([final("i1", "")], "u1", null)).toBeNull();
    expect(
      foldFinalAnswer([final("i1", "x".repeat(256 * 1024 + 1))], "u1", null),
    ).toBeNull();
    expect(foldFinalAnswer([final("i1", 5)], "u1", null)).toBeNull();
    expect(
      foldFinalAnswer([{ turnId: "u2", item: { id: "i1" } }], "u1", null),
    ).toBeNull();
    expect(foldFinalAnswer([{ turnId: "u1" }], "u1", null)).toBeNull();
    expect(
      foldFinalAnswer([{ turnId: "u1", item: { id: "bad id" } }], "u1", null),
    ).toBeNull();
  });
});
