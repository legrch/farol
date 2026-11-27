import { describe, expect, it } from "vitest";
import {
  retirementConflicts,
  summaryAttemptConflicts,
  summaryAttemptShapeInvalid,
} from "./attempt";
import type {
  StoredContextRetirement,
  StoredContextSummaryAttempt,
} from "./records";

const binding = {
  ownerId: "owner",
  taskId: "task",
  hostThreadId: "thread",
  sessionId: "session",
  providerProfileId: "profile",
  modelId: "model",
  mode: "mode",
};

function attempt(
  overrides: Partial<StoredContextSummaryAttempt> = {},
): StoredContextSummaryAttempt {
  return {
    schemaVersion: 1,
    operationId: "op",
    binding,
    source: "retained_agent",
    sourceBoundary: "boundary",
    phase: "prepared",
    conversationUrl: null,
    turnUserId: null,
    turnAssistantId: null,
    ...overrides,
  };
}

describe("summaryAttemptConflicts", () => {
  it("allows the same attempt and a forward step", () => {
    expect(summaryAttemptConflicts(attempt(), attempt())).toBe(false);
    expect(
      summaryAttemptConflicts(attempt(), attempt({ phase: "possible_send" })),
    ).toBe(false);
  });

  it("refuses to move a phase backwards", () => {
    expect(
      summaryAttemptConflicts(
        attempt({ phase: "outcome_unknown" }),
        attempt({ phase: "possible_send" }),
      ),
    ).toBe(true);
  });

  it("refuses another identity", () => {
    expect(
      summaryAttemptConflicts(attempt(), attempt({ operationId: "next" })),
    ).toBe(true);
    expect(
      summaryAttemptConflicts(attempt(), attempt({ sourceBoundary: "other" })),
    ).toBe(true);
    expect(
      summaryAttemptConflicts(
        attempt(),
        attempt({ binding: { ...binding, taskId: "other" } }),
      ),
    ).toBe(true);
  });

  it("lets an unset field fill in once and then holds it", () => {
    const set = attempt({
      conversationUrl: "https://example.test/c/1",
      turnUserId: "u",
      turnAssistantId: "a",
    });
    expect(summaryAttemptConflicts(attempt(), set)).toBe(false);
    expect(summaryAttemptConflicts(set, set)).toBe(false);
    expect(
      summaryAttemptConflicts(
        set,
        attempt({ ...set, conversationUrl: "https://example.test/c/2" }),
      ),
    ).toBe(true);
    expect(
      summaryAttemptConflicts(set, attempt({ ...set, turnUserId: "x" })),
    ).toBe(true);
    expect(
      summaryAttemptConflicts(set, attempt({ ...set, turnAssistantId: null })),
    ).toBe(true);
  });
});

describe("summaryAttemptShapeInvalid", () => {
  it("refuses an assistant turn without a user turn", () => {
    expect(
      summaryAttemptShapeInvalid({ turnAssistantId: "a", turnUserId: null }),
    ).toBe(true);
    expect(
      summaryAttemptShapeInvalid({ turnAssistantId: "a", turnUserId: "u" }),
    ).toBe(false);
    expect(
      summaryAttemptShapeInvalid({ turnAssistantId: null, turnUserId: null }),
    ).toBe(false);
  });
});

describe("retirementConflicts", () => {
  const retirement = (epoch: number): StoredContextRetirement => ({
    schemaVersion: 1,
    operationId: "op",
    binding,
    epoch,
    sourceCursor: "cursor",
  });

  it("accepts only a later epoch", () => {
    expect(retirementConflicts(retirement(1), retirement(2))).toBe(false);
    expect(retirementConflicts(retirement(2), retirement(2))).toBe(true);
    expect(retirementConflicts(retirement(3), retirement(2))).toBe(true);
  });
});
