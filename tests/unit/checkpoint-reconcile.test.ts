import { describe, expect, it } from "vitest";

import {
  reconcileCheckpointContent,
  type CheckpointContent,
} from "../../src/modules/chat/domain/checkpoint";

const MAXIMUM_BYTES = 256 * 1_024;

function summary(
  completedWork: CheckpointContent["completedWork"],
  overrides: Partial<CheckpointContent> = {},
): CheckpointContent {
  return {
    goal: "Keep a long task going.",
    activeConstraints: [],
    latestCorrections: [],
    keyDecisions: [],
    completedWork,
    unfinishedWork: [],
    unresolvedQuestions: [],
    unknownOutcomes: [],
    artifactRefs: [],
    attachmentRefs: [],
    nextSafeStep: "Continue.",
    ...overrides,
  };
}

describe("checkpoint reconciliation over many compactions", () => {
  it("folds carried work the summary no longer cites instead of outgrowing the schema", () => {
    // Earlier checkpoints proved 90 pieces of work; this summary condenses
    // them and cites only its own ten receipts.
    const carriedWork = Array.from({ length: 90 }, (_, index) => ({
      description: `Earlier step ${index}.`,
      evidenceRefs: [`call-old-${index}`],
    }));
    const fresh = Array.from({ length: 10 }, (_, index) => ({
      description: `New step ${index}.`,
      evidenceRefs: [`call-new-${index}`],
    }));
    const result = reconcileCheckpointContent(
      summary(fresh),
      {
        receipts: [
          ...carriedWork.flatMap((item) => item.evidenceRefs),
          ...fresh.flatMap((item) => item.evidenceRefs),
        ],
        carriedWork,
        unresolved: [],
      },
      MAXIMUM_BYTES,
    );

    if (!result.ok) throw new Error(result.error.code);
    const work = result.value.completedWork;
    expect(work.length).toBeLessThanOrEqual(64);
    expect(work.slice(0, 10)).toEqual(fresh);
    // Every earlier receipt is still cited, now by folded entries.
    expect(new Set(work.flatMap((item) => item.evidenceRefs))).toEqual(
      new Set([
        ...fresh.flatMap((item) => item.evidenceRefs),
        ...carriedWork.flatMap((item) => item.evidenceRefs),
      ]),
    );
  });

  it("keeps the newest carried receipts when not all of them fit", () => {
    const carriedWork = Array.from({ length: 3_000 }, (_, index) => ({
      description: `Earlier step ${index}.`,
      evidenceRefs: [`call-old-${String(index).padStart(4, "0")}`],
    }));
    const result = reconcileCheckpointContent(
      summary([]),
      {
        receipts: carriedWork.flatMap((item) => item.evidenceRefs),
        carriedWork,
        unresolved: [],
      },
      MAXIMUM_BYTES,
    );

    if (!result.ok) throw new Error(result.error.code);
    const cited = result.value.completedWork.flatMap(
      (item) => item.evidenceRefs,
    );
    expect(result.value.completedWork.length).toBeLessThanOrEqual(64);
    // Carried work arrives newest first, so what is dropped is the oldest.
    expect(cited).toContain("call-old-0000");
    expect(cited).not.toContain("call-old-2999");
  });

  it("keeps an unknown outcome the summary lists even when a receipt shares its name", () => {
    // A tool's output may name the operation it started; that proves the call
    // returned, not that the operation it names finished.
    const result = reconcileCheckpointContent(
      summary([], {
        unknownOutcomes: [
          { operationRef: "write-17", description: "Write may have run." },
        ],
      }),
      { receipts: ["write-17"], carriedWork: [], unresolved: [] },
      MAXIMUM_BYTES,
    );

    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.unknownOutcomes).toEqual([
      { operationRef: "write-17", description: "Write may have run." },
    ]);
  });

  it("folds unverified claims beyond the question limit into one entry", () => {
    // The summary asks ten questions and claims sixty steps whose receipts
    // do not exist; each claim becomes a question, which would be seventy.
    const claims = Array.from({ length: 60 }, (_, index) => ({
      description: `Claimed step ${index}.`,
      evidenceRefs: [`call-missing-${index}`],
    }));
    const questions = Array.from(
      { length: 10 },
      (_, index) => `Question ${index}?`,
    );
    const result = reconcileCheckpointContent(
      summary(claims, { unresolvedQuestions: questions }),
      { receipts: [], carriedWork: [], unresolved: [] },
      MAXIMUM_BYTES,
    );

    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.completedWork).toEqual([]);
    expect(result.value.unresolvedQuestions).toHaveLength(64);
    expect(result.value.unresolvedQuestions.slice(0, 10)).toEqual(questions);
    expect(result.value.unresolvedQuestions.join("\n")).toContain(
      "Claimed step 59.",
    );
  });

  it("still refuses when unknown outcomes alone exceed the limit", () => {
    const unresolved = Array.from({ length: 65 }, (_, index) => ({
      operationRef: `call-unknown-${index}`,
      description: "Called; no result arrived.",
    }));
    expect(
      reconcileCheckpointContent(
        summary([]),
        { receipts: [], carriedWork: [], unresolved },
        MAXIMUM_BYTES,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_CONTENT_INVALID" },
    });
  });
  it("fails closed instead of cutting an unproven claim out of a full question list", () => {
    // Sixty-four questions, the last one at the text bound: there is no
    // room for the marker of the claim whose receipt never arrived.
    const questions = [
      ...Array.from({ length: 63 }, (_, index) => `Question ${index}?`),
      "q".repeat(4_096),
    ];
    const claims = [
      {
        description: "Claimed step without receipt.",
        evidenceRefs: ["call-missing"],
      },
    ];
    expect(
      reconcileCheckpointContent(
        summary(claims, { unresolvedQuestions: questions }),
        { receipts: [], carriedWork: [], unresolved: [] },
        MAXIMUM_BYTES,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_QUESTIONS_OVERFLOW" },
    });
  });

  it("fails closed when the claims that must share the last free entry do not fit it", () => {
    const questions = Array.from(
      { length: 60 },
      (_, index) => `Question ${index}?`,
    );
    // Four free entries: three claims verbatim, five joined into the last,
    // which would run past the text bound.
    const claims = Array.from({ length: 8 }, (_, index) => ({
      description: `${"c".repeat(1_000)} ${index}`,
      evidenceRefs: [`call-missing-${index}`],
    }));
    expect(
      reconcileCheckpointContent(
        summary(claims, { unresolvedQuestions: questions }),
        { receipts: [], carriedWork: [], unresolved: [] },
        MAXIMUM_BYTES,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_QUESTIONS_OVERFLOW" },
    });
  });

  it("keeps every unproven claim readable when the shared entry has room", () => {
    const questions = Array.from(
      { length: 64 },
      (_, index) => `Question ${index}?`,
    );
    const claims = [
      { description: "Claimed step A.", evidenceRefs: ["call-missing-a"] },
      { description: "Claimed step B.", evidenceRefs: ["call-missing-b"] },
    ];
    const result = reconcileCheckpointContent(
      summary(claims, { unresolvedQuestions: questions }),
      { receipts: [], carriedWork: [], unresolved: [] },
      MAXIMUM_BYTES,
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.completedWork).toEqual([]);
    expect(result.value.unresolvedQuestions).toHaveLength(64);
    expect(result.value.unresolvedQuestions[63]).toContain("Question 63?");
    expect(result.value.unresolvedQuestions[63]).toContain(
      "Unverified, no receipt exists: Claimed step A.; Claimed step B.",
    );
  });
});
