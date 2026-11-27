import { describe, expect, it } from "vitest";
import type { CheckpointEnvelope } from "../../domain/checkpoint";
import type { ContextSession } from "../../domain/context-continuity";
import { digest } from "./layout";
import {
  leaseOwnedBy,
  sessionHoldsPublication,
  sourceHoldsPublication,
} from "./publication";
import type { ContextPublicationRequest, StoredContextSource } from "./records";

const binding = {
  ownerId: "owner",
  taskId: "task",
  hostThreadId: "thread",
  sessionId: "session",
  providerProfileId: "profile",
  modelId: "model",
  mode: "mode",
};
const source: StoredContextSource = {
  schemaVersion: 1,
  operationId: "op",
  binding,
  source: "retained_agent",
  sourceBoundary: "boundary",
  variant: "unary_replacement_history",
  history: [],
};
const checkpoint = {
  checkpointId: "cp",
  operationId: "op",
  binding,
} as unknown as CheckpointEnvelope;
const expected = {
  source,
  sourceSHA256: digest(source),
  sourceEpoch: 1,
} as unknown as ContextPublicationRequest["expected"];

function validated(): ContextSession {
  return {
    binding,
    epoch: 1,
    phase: "validated",
    operation: {
      operationId: "op",
      source: "retained_agent",
      sourceBoundary: "boundary",
      sourceEpoch: 1,
      summaryDispatch: "result_received",
      checkpointId: "cp",
      hostContextRef: null,
    },
    lastCheckpointId: null,
    lastCompletedOperationId: null,
    lastCompletedRequest: null,
    blockedCode: null,
  };
}

describe("leaseOwnedBy", () => {
  const instance = "a".repeat(32);
  const record = {
    schemaVersion: 1,
    kind: "context_admission_lease",
    processId: 9,
    processInstanceId: instance,
    token: "t".repeat(32),
  };

  it("holds only for the same process and instance", () => {
    expect(leaseOwnedBy(record, 9, instance)).toBe(true);
    expect(leaseOwnedBy(record, 8, instance)).toBe(false);
    expect(leaseOwnedBy(record, 9, "b".repeat(32))).toBe(false);
  });

  it("does not hold for an unreadable record", () => {
    expect(leaseOwnedBy({ schemaVersion: 1 }, 9, instance)).toBe(false);
    expect(leaseOwnedBy(null, 9, instance)).toBe(false);
  });
});

describe("sessionHoldsPublication", () => {
  it("holds for the validated session that issued the checkpoint", () => {
    expect(sessionHoldsPublication(validated(), checkpoint, expected)).toBe(
      true,
    );
  });

  it("fails when the session moved on", () => {
    expect(sessionHoldsPublication(null, checkpoint, expected)).toBe(false);
    expect(
      sessionHoldsPublication(
        { ...validated(), phase: "active" },
        checkpoint,
        expected,
      ),
    ).toBe(false);
    expect(
      sessionHoldsPublication(
        { ...validated(), epoch: 2 },
        checkpoint,
        expected,
      ),
    ).toBe(false);
  });

  it("fails when the operation names another checkpoint or dispatch", () => {
    const session = validated();
    expect(
      sessionHoldsPublication(
        {
          ...session,
          operation: { ...session.operation!, checkpointId: "other" },
        },
        checkpoint,
        expected,
      ),
    ).toBe(false);
    expect(
      sessionHoldsPublication(
        {
          ...session,
          operation: { ...session.operation!, summaryDispatch: "observed" },
        },
        checkpoint,
        expected,
      ),
    ).toBe(false);
  });
});

describe("sourceHoldsPublication", () => {
  it("holds for the exact expected source", () => {
    expect(sourceHoldsPublication({ ...source }, expected)).toBe(true);
  });

  it("fails for a missing or changed source", () => {
    expect(sourceHoldsPublication(null, expected)).toBe(false);
    expect(
      sourceHoldsPublication({ ...source, sourceBoundary: "other" }, expected),
    ).toBe(false);
  });
});
