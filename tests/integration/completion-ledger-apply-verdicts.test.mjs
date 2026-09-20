import { describe, expect, it } from "vitest";
import {
  APPLY_VERDICTS_SCHEMA,
  applyVerdicts,
} from "../../tooling/completion-ledger-apply-verdicts.mjs";

const CANDIDATE = "a".repeat(40);

// applyVerdicts() is pure: it never touches disk or spawns evidence-bindings
// itself, so every case here hands it a synthetic evaluateBindings()-shaped
// `bindingsResult` directly -- no attempt directories, no candidate files.

function baseLedger(overrides = {}) {
  return {
    candidate: { sourceCommit: CANDIDATE },
    requirements: [
      { id: "R1", u2: "DONE", bindings: [{ lane: "hunt", attemptId: "x", cases: [] }] },
      { id: "R2", u2: "LIVE_OPEN", bindings: [], next: "G-LIVE: scenario 1 pending" },
    ],
    ...overrides,
  };
}

function bindingsResultFor(entries) {
  return {
    schema: "farol.next.evidence-bindings/v1",
    candidate: { sourceCommit: CANDIDATE },
    header: { reasons: [] },
    lanes: [],
    requirements: entries,
    summary: {
      counts: {},
      doneUnproven: entries
        .filter((entry) => entry.u2 === "DONE" && entry.verdict !== "PROVEN")
        .map((entry) => entry.id),
    },
  };
}

describe("applyVerdicts: currentProof always reflects the fresh evaluation", () => {
  it("keeps a DONE row DONE and records PROVEN when the fresh evaluation proves it", () => {
    const ledger = baseLedger();
    const bindingsResult = bindingsResultFor([
      { id: "R1", u2: "DONE", verdict: "PROVEN", bindings: [{ reasons: [] }] },
      { id: "R2", u2: "LIVE_OPEN", verdict: "NO_BINDINGS", bindings: [] },
    ]);

    const { ledger: merged, downgraded, unresolved } = applyVerdicts({
      ledger,
      bindingsResult,
    });

    const r1 = merged.requirements.find((row) => row.id === "R1");
    expect(r1.u2).toBe("DONE");
    expect(r1.currentProof).toEqual({
      candidate: CANDIDATE,
      verdict: "PROVEN",
      reasons: [],
    });
    expect(downgraded).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it("downgrades a DONE row with no current proof to NOT_RUN and names why, never keeping the stale PASS", () => {
    const ledger = baseLedger();
    const bindingsResult = bindingsResultFor([
      {
        id: "R1",
        u2: "DONE",
        verdict: "UNPROVEN",
        bindings: [{ reasons: ["CASE_NOT_EXECUTED:foo"] }],
      },
      { id: "R2", u2: "LIVE_OPEN", verdict: "NO_BINDINGS", bindings: [] },
    ]);

    const { ledger: merged, downgraded } = applyVerdicts({ ledger, bindingsResult });

    const r1 = merged.requirements.find((row) => row.id === "R1");
    expect(r1.u2).toBe("NOT_RUN");
    expect(r1.currentProof.verdict).toBe("UNPROVEN");
    expect(r1.currentProof.reasons).toEqual(["CASE_NOT_EXECUTED:foo"]);
    expect(r1.next).toContain("downgraded from DONE");
    expect(r1.next).toContain("CASE_NOT_EXECUTED:foo");
    expect(downgraded).toEqual([
      {
        id: "R1",
        from: "DONE",
        to: "NOT_RUN",
        verdict: "UNPROVEN",
        reasons: ["CASE_NOT_EXECUTED:foo"],
      },
    ]);
  });

  it("downgrades a DONE row with NO_BINDINGS the same way, naming the verdict when there are no per-binding reasons", () => {
    const ledger = baseLedger();
    const bindingsResult = bindingsResultFor([
      { id: "R1", u2: "DONE", verdict: "NO_BINDINGS", bindings: [] },
      { id: "R2", u2: "LIVE_OPEN", verdict: "NO_BINDINGS", bindings: [] },
    ]);

    const { ledger: merged } = applyVerdicts({ ledger, bindingsResult });

    const r1 = merged.requirements.find((row) => row.id === "R1");
    expect(r1.u2).toBe("NOT_RUN");
    expect(r1.next).toContain("NO_BINDINGS");
  });

  it("prepends the downgrade note to any existing `next` text instead of discarding it", () => {
    const ledger = baseLedger();
    ledger.requirements[0].next = "existing owner note";
    const bindingsResult = bindingsResultFor([
      { id: "R1", u2: "DONE", verdict: "UNPROVEN", bindings: [{ reasons: [] }] },
      { id: "R2", u2: "LIVE_OPEN", verdict: "NO_BINDINGS", bindings: [] },
    ]);

    const { ledger: merged } = applyVerdicts({ ledger, bindingsResult });
    const r1 = merged.requirements.find((row) => row.id === "R1");
    expect(r1.next.endsWith("existing owner note")).toBe(true);
    expect(r1.next).toContain("downgraded from DONE");
  });

  it("never changes a non-DONE row's u2, whichever way the fresh evaluation reads", () => {
    const ledger = baseLedger();
    const bindingsResult = bindingsResultFor([
      { id: "R1", u2: "DONE", verdict: "PROVEN", bindings: [{ reasons: [] }] },
      { id: "R2", u2: "LIVE_OPEN", verdict: "PROVEN", bindings: [{ reasons: [] }] },
    ]);

    const { ledger: merged } = applyVerdicts({ ledger, bindingsResult });
    const r2 = merged.requirements.find((row) => row.id === "R2");
    expect(r2.u2).toBe("LIVE_OPEN");
    expect(r2.next).toBe("G-LIVE: scenario 1 pending");
    expect(r2.currentProof).toEqual({
      candidate: CANDIDATE,
      verdict: "PROVEN",
      reasons: [],
    });
  });
});

describe("applyVerdicts: summary is a mechanical tally of u2, never hand-typed", () => {
  it("recomputes summary from the rows after downgrades, not from any prior summary block", () => {
    const ledger = baseLedger({
      summary: { DONE: 99, LIVE_OPEN: 1 }, // deliberately wrong before the merge
    });
    const bindingsResult = bindingsResultFor([
      { id: "R1", u2: "DONE", verdict: "UNPROVEN", bindings: [{ reasons: [] }] },
      { id: "R2", u2: "LIVE_OPEN", verdict: "NO_BINDINGS", bindings: [] },
    ]);

    const { ledger: merged } = applyVerdicts({ ledger, bindingsResult });
    expect(merged.summary).toEqual({ NOT_RUN: 1, LIVE_OPEN: 1 });
  });
});

describe("applyVerdicts: currentProofSummary is rebuilt from this same run", () => {
  it("uses only verdict labels evaluateBindings() can produce and reports an unreproducible one instead of preserving it", () => {
    const ledger = baseLedger({
      currentProofSummary: {
        candidate: "b".repeat(40),
        byVerdict: { PROVEN: 1, COMMAND_ONLY: 1 },
      },
    });
    const bindingsResult = bindingsResultFor([
      { id: "R1", u2: "DONE", verdict: "PROVEN", bindings: [{ reasons: [] }] },
      { id: "R2", u2: "LIVE_OPEN", verdict: "UNPROVEN", bindings: [{ reasons: [] }] },
    ]);

    const { ledger: merged, unresolved } = applyVerdicts({ ledger, bindingsResult });

    expect(merged.currentProofSummary.candidate).toBe(CANDIDATE);
    expect(merged.currentProofSummary.byVerdict).toEqual({
      PROVEN: 1,
      UNPROVEN: 1,
    });
    expect(merged.currentProofSummary.recordedDoneByVerdict).toEqual({
      PROVEN: 1,
    });
    expect(merged.currentProofSummary.validator.exit).toBe(0);
    expect(
      unresolved.some((entry) => entry.includes("COMMAND_ONLY")),
    ).toBe(true);
  });

  it("recomputes doneUnproven from the merged rows, not the pre-downgrade evaluation: it is always empty by this tool's own invariant", () => {
    const ledger = baseLedger();
    const bindingsResult = {
      ...bindingsResultFor([
        { id: "R1", u2: "DONE", verdict: "UNPROVEN", bindings: [{ reasons: [] }] },
        { id: "R2", u2: "LIVE_OPEN", verdict: "NO_BINDINGS", bindings: [] },
      ]),
    };
    // evaluateBindings() reported R1 as doneUnproven against the ledger AS
    // HANDED IN (still u2="DONE"). This same applyVerdicts() call downgrades
    // R1 to NOT_RUN, so caching that stale doneUnproven verbatim would leave
    // a fact in the ledger that this very merge just made false. The merge
    // recomputes it from its own output instead.
    bindingsResult.summary.doneUnproven = ["R1"];

    const { ledger: merged } = applyVerdicts({ ledger, bindingsResult });
    expect(merged.requirements.find((row) => row.id === "R1").u2).toBe("NOT_RUN");
    expect(merged.currentProofSummary.validator.doneUnproven).toEqual([]);
    expect(merged.currentProofSummary.validator.exit).toBe(0);
  });

  it("still reports validator.exit=1 from a header disagreement, independent of doneUnproven", () => {
    const ledger = baseLedger();
    const bindingsResult = bindingsResultFor([
      { id: "R1", u2: "DONE", verdict: "PROVEN", bindings: [{ reasons: [] }] },
      { id: "R2", u2: "LIVE_OPEN", verdict: "NO_BINDINGS", bindings: [] },
    ]);
    bindingsResult.header = { reasons: ["HEADER_MISMATCH:sourceCommit"] };

    const { ledger: merged } = applyVerdicts({ ledger, bindingsResult });
    expect(merged.currentProofSummary.validator.exit).toBe(1);
    expect(merged.currentProofSummary.validator.header).toEqual([
      "HEADER_MISMATCH:sourceCommit",
    ]);
    expect(merged.currentProofSummary.validator.doneUnproven).toEqual([]);
  });
});

describe("completion-ledger-apply-verdicts: schema export", () => {
  it("exports a stable schema identifier", () => {
    expect(APPLY_VERDICTS_SCHEMA).toBe(
      "farol.next.completion-ledger-apply-verdicts/v1",
    );
  });
});
