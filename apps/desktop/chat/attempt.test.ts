import { describe, expect, it } from "vitest";
import { summaryAttemptRecord } from "./attempt";

const scope = {
  binding: { ownerId: "owner-1", taskId: "task-1" },
  operationId: "op-1",
  source: { source: "canonical_history", sourceBoundary: "boundary-1" },
};

describe("summary attempt record", () => {
  it("shapes a prepared record with no correlation", () => {
    expect(summaryAttemptRecord(scope, "prepared", null)).toEqual({
      schemaVersion: 1,
      operationId: "op-1",
      binding: { ownerId: "owner-1", taskId: "task-1" },
      source: "canonical_history",
      sourceBoundary: "boundary-1",
      phase: "prepared",
      conversationUrl: null,
      turnUserId: null,
      turnAssistantId: null,
    });
  });

  it("copies the binding instead of sharing it", () => {
    const record = summaryAttemptRecord(scope, "prepared", null);
    expect(record.binding).not.toBe(scope.binding);
  });

  it("carries the conversation and the correlated turn ids", () => {
    const record = summaryAttemptRecord(
      scope,
      "possible_send",
      "https://chat.example/c/one",
      { turnUserId: "user-1", turnAssistantId: "assistant-1" },
    );
    expect(record.phase).toBe("possible_send");
    expect(record.conversationUrl).toBe("https://chat.example/c/one");
    expect(record.turnUserId).toBe("user-1");
    expect(record.turnAssistantId).toBe("assistant-1");
  });

  it("turns a missing or null turn id into null", () => {
    const record = summaryAttemptRecord(scope, "outcome_unknown", null, {
      turnAssistantId: null,
    });
    expect(record.turnUserId).toBeNull();
    expect(record.turnAssistantId).toBeNull();
  });
});
