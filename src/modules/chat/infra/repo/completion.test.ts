import { describe, expect, it } from "vitest";
import type { CheckpointEnvelope } from "../../domain/checkpoint";
import type {
  CompactionRequest,
  ContextSession,
} from "../../domain/context-continuity";
import {
  completedSession,
  completionAdmission,
  completionCheckpointMismatch,
  completionRecord,
  earlierOperationConfirmed,
  headCompletesSession,
  headOperationConfirmed,
  retiredEpochCompletion,
} from "./completion";
import { digest } from "./layout";

const binding = {
  ownerId: "owner",
  taskId: "task",
  hostThreadId: "thread",
  sessionId: "session",
  providerProfileId: "profile",
  modelId: "model",
  mode: "mode",
};
const request: CompactionRequest = {
  operationId: "op",
  source: "retained_agent",
  sourceBoundary: "boundary",
};

function retired(): ContextSession {
  return {
    binding,
    epoch: 1,
    phase: "old_epoch_retired",
    operation: {
      ...request,
      sourceEpoch: 1,
      summaryDispatch: "result_received",
      checkpointId: "cp",
      hostContextRef: "ref",
    },
    lastCheckpointId: null,
    lastCompletedOperationId: null,
    lastCompletedRequest: null,
    blockedCode: null,
  };
}

function active(): ContextSession {
  return {
    binding,
    epoch: 2,
    phase: "active",
    operation: null,
    lastCheckpointId: "cp",
    lastCompletedOperationId: "op",
    lastCompletedRequest: request,
    blockedCode: null,
  };
}

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    checkpointId: "cp",
    operationId: "op",
    source: "retained_agent",
    sourceBoundary: "boundary",
    epoch: 1,
    binding,
    ...overrides,
  } as unknown as CheckpointEnvelope;
}

describe("retiredEpochCompletion", () => {
  it("names the retired epoch and its completing request", () => {
    expect(retiredEpochCompletion(retired(), active())).toEqual({
      epoch: 1,
      request,
    });
  });

  it("is absent without a retired predecessor", () => {
    expect(retiredEpochCompletion(null, active())).toBeNull();
    expect(
      retiredEpochCompletion({ ...retired(), phase: "active" }, active()),
    ).toBeNull();
  });

  it("is absent unless the epoch advances by exactly one", () => {
    expect(
      retiredEpochCompletion(retired(), { ...active(), epoch: 3 }),
    ).toBeNull();
  });

  it("is absent when the host context was never confirmed", () => {
    const existing = retired();
    expect(
      retiredEpochCompletion(
        {
          ...existing,
          operation: { ...existing.operation!, hostContextRef: null },
        },
        active(),
      ),
    ).toBeNull();
  });

  it("is absent when the successor names another checkpoint", () => {
    expect(
      retiredEpochCompletion(retired(), {
        ...active(),
        lastCheckpointId: "other",
      }),
    ).toBeNull();
  });
});

describe("completion record", () => {
  it("keeps the stored key order", () => {
    const head = checkpoint();
    const admission = completionAdmission(binding, head, request);
    expect(Object.keys(admission)).toEqual([
      "binding",
      "sourceEpoch",
      "request",
    ]);
    const record = completionRecord(admission, head);
    expect(Object.keys(record)).toEqual([
      "schemaVersion",
      "kind",
      "admission",
      "checkpointId",
      "checkpointSHA256",
    ]);
    expect(record.checkpointSHA256).toBe(digest(head));
  });

  it("detects a checkpoint of another epoch or request", () => {
    expect(completionCheckpointMismatch(checkpoint(), 1, request)).toBe(false);
    expect(completionCheckpointMismatch(checkpoint(), 2, request)).toBe(true);
    expect(
      completionCheckpointMismatch(checkpoint(), 1, {
        ...request,
        sourceBoundary: "other",
      }),
    ).toBe(true);
  });
});

describe("completedSession", () => {
  it("summarises an active session with a finished compaction", () => {
    expect(completedSession(active(), binding)).toEqual({
      epoch: 2,
      operationId: "op",
      request,
      checkpointId: "cp",
    });
  });

  it("refuses sessions that are not settled", () => {
    expect(completedSession(null, binding)).toBeNull();
    expect(
      completedSession({ ...active(), phase: "blocked" }, binding),
    ).toBeNull();
    expect(
      completedSession({ ...active(), lastCheckpointId: null }, binding),
    ).toBeNull();
    expect(
      completedSession({ ...active(), lastCompletedRequest: null }, binding),
    ).toBeNull();
    expect(
      completedSession(active(), { ...binding, taskId: "other" }),
    ).toBeNull();
  });
});

describe("head and earlier operations", () => {
  const completed = completedSession(active(), binding)!;

  it("requires the head to be the one epoch behind the session", () => {
    expect(headCompletesSession(checkpoint(), completed)).toBe(true);
    expect(headCompletesSession(null, completed)).toBe(false);
    expect(headCompletesSession(checkpoint({ epoch: 2 }), completed)).toBe(
      false,
    );
    expect(
      headCompletesSession(checkpoint({ operationId: "x" }), completed),
    ).toBe(false);
  });

  const evidence = (overrides: Record<string, unknown> = {}) =>
    ({
      admission: { sourceEpoch: 1 },
      checkpointId: "cp",
      checkpointSHA256: digest(checkpoint()),
      ...overrides,
    }) as unknown as Parameters<typeof headOperationConfirmed>[0];

  it("accepts the head's own operation with absent or exact evidence", () => {
    const head = checkpoint();
    expect(headOperationConfirmed(null, head)).toBe(true);
    expect(headOperationConfirmed(evidence(), head)).toBe(true);
    expect(
      headOperationConfirmed(
        evidence({ checkpointSHA256: "f".repeat(64) }),
        head,
      ),
    ).toBe(false);
  });

  it("confirms an earlier operation by evidence recorded before pruning", () => {
    const head = checkpoint({ epoch: 2, checkpointId: "head" });
    expect(
      earlierOperationConfirmed(
        evidence({ admission: { sourceEpoch: 1 } }),
        head,
        [],
      ),
    ).toBe(true);
    expect(
      earlierOperationConfirmed(
        evidence({ admission: { sourceEpoch: 2 } }),
        head,
        [],
      ),
    ).toBe(false);
  });

  it("refuses evidence that disagrees with the surviving original", () => {
    const head = checkpoint({ epoch: 2, checkpointId: "head" });
    expect(earlierOperationConfirmed(evidence(), head, [checkpoint()])).toBe(
      true,
    );
    expect(
      earlierOperationConfirmed(evidence(), head, [
        checkpoint(),
        checkpoint({ checkpointId: "cp2" }),
      ]),
    ).toBe(false);
    expect(
      earlierOperationConfirmed(evidence(), head, [
        checkpoint({ checkpointId: "cp2" }),
      ]),
    ).toBe(false);
  });

  it("needs exactly one older original without evidence", () => {
    const head = checkpoint({ epoch: 2 });
    expect(earlierOperationConfirmed(null, head, [checkpoint()])).toBe(true);
    expect(earlierOperationConfirmed(null, head, [])).toBe(false);
    expect(
      earlierOperationConfirmed(null, head, [checkpoint({ epoch: 2 })]),
    ).toBe(false);
  });
});
