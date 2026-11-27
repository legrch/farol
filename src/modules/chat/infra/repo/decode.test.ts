import { describe, expect, it } from "vitest";
import type { CheckpointEnvelope } from "../../domain/checkpoint";
import {
  checkPublicationRequest,
  decodeAdmission,
  decodeCheckpoint,
  decodeCompletion,
  decodeLease,
  decodePublication,
  decodeRetirement,
  decodeSession,
  decodeSource,
  decodeSummaryAttempt,
  decodeTaskBinding,
} from "./decode";
import { bindingKey, digest } from "./layout";

const binding = {
  ownerId: "owner",
  taskId: "task",
  hostThreadId: "thread",
  sessionId: "session",
  providerProfileId: "profile",
  modelId: "model",
  mode: "mode",
};
const other = { ...binding, taskId: "other" };

const session = {
  binding,
  epoch: 1,
  phase: "active",
  operation: null,
  lastCheckpointId: null,
  lastCompletedOperationId: null,
  blockedCode: null,
};

const source = {
  schemaVersion: 1,
  operationId: "op",
  binding,
  source: "retained_agent",
  sourceBoundary: "boundary",
  variant: "unary_replacement_history",
  history: [],
};

describe("decodeSession", () => {
  it("defaults a missing completed request to null", () => {
    const decoded = decodeSession(
      { schemaVersion: 1, kind: "context_session", session },
      binding,
    );
    expect(decoded.lastCompletedRequest).toBeNull();
    expect(Object.keys(decoded)).toContain("lastCompletedRequest");
  });

  it("classifies unreadable and unsupported records", () => {
    expect(() => decodeSession({ schemaVersion: 1 }, binding)).toThrow(
      "CONTEXT_STATE_CORRUPT",
    );
    expect(() => decodeSession({ schemaVersion: 2 }, binding)).toThrow(
      "CONTEXT_STATE_UNSUPPORTED",
    );
  });

  it("refuses another task's identity", () => {
    expect(() =>
      decodeSession(
        { schemaVersion: 1, kind: "context_session", session },
        other,
      ),
    ).toThrow("CONTEXT_STATE_IDENTITY_MISMATCH");
  });
});

describe("decodeSource and decodeRetirement", () => {
  it("returns a copy of the stored source", () => {
    const record = { schemaVersion: 1, kind: "context_source", source };
    const decoded = decodeSource(record, binding);
    expect(decoded).toEqual(source);
    expect(decoded).not.toBe(record.source);
  });

  it("refuses a source of another binding", () => {
    expect(() =>
      decodeSource({ schemaVersion: 1, kind: "context_source", source }, other),
    ).toThrow("CONTEXT_SOURCE_BINDING_MISMATCH");
  });

  it("checks the schema before the binding", () => {
    expect(() => decodeRetirement({ schemaVersion: 1 }, other)).toThrow(
      "CONTEXT_RETIREMENT_CORRUPT",
    );
    const retirement = {
      schemaVersion: 1,
      operationId: "op",
      binding,
      epoch: 1,
      sourceCursor: "cursor",
    };
    expect(() =>
      decodeRetirement(
        { schemaVersion: 1, kind: "context_retirement", retirement },
        other,
      ),
    ).toThrow("CONTEXT_RETIREMENT_BINDING_MISMATCH");
  });
});

describe("decodeSummaryAttempt, decodeAdmission, decodeLease", () => {
  it("refuses an attempt of another binding", () => {
    const attempt = {
      schemaVersion: 1,
      operationId: "op",
      binding,
      source: "retained_agent",
      sourceBoundary: "boundary",
      phase: "prepared",
      conversationUrl: null,
      turnUserId: null,
      turnAssistantId: null,
    };
    const record = {
      schemaVersion: 1,
      kind: "context_summary_attempt",
      attempt,
    };
    expect(decodeSummaryAttempt(record, binding)).toEqual(attempt);
    expect(() => decodeSummaryAttempt(record, other)).toThrow(
      "CONTEXT_SUMMARY_ATTEMPT_BINDING_MISMATCH",
    );
  });

  it("classifies admission and lease schema failures", () => {
    expect(() => decodeAdmission({ schemaVersion: 1 })).toThrow(
      "CONTEXT_ADMISSION_CORRUPT",
    );
    expect(() => decodeLease({ schemaVersion: 3 })).toThrow(
      "CONTEXT_LEASE_UNSUPPORTED",
    );
    expect(
      decodeLease({
        schemaVersion: 1,
        kind: "context_admission_lease",
        processId: 7,
        processInstanceId: "a".repeat(32),
        token: "b".repeat(32),
      }).processId,
    ).toBe(7);
  });
});

describe("decodeCompletion", () => {
  const request = {
    operationId: "op",
    source: "retained_agent",
    sourceBoundary: "boundary",
  };
  const record = {
    schemaVersion: 1,
    kind: "context_completion",
    admission: { binding, sourceEpoch: 1, request },
    checkpointId: "cp",
    checkpointSHA256: "c".repeat(64),
  };

  it("accepts the record for its own binding and operation", () => {
    expect(decodeCompletion(record, binding, "op").checkpointId).toBe("cp");
  });

  it("refuses another binding or operation", () => {
    expect(() => decodeCompletion(record, other, "op")).toThrow(
      "CONTEXT_COMPLETION_BINDING_MISMATCH",
    );
    expect(() => decodeCompletion(record, binding, "next")).toThrow(
      "CONTEXT_COMPLETION_BINDING_MISMATCH",
    );
  });
});

describe("publication decoding", () => {
  const checkpoint = {
    binding,
    operationId: "op",
    source: "retained_agent",
    sourceBoundary: "boundary",
    epoch: 1,
  } as unknown as CheckpointEnvelope;
  const policy = {
    schemaVersion: 1,
    maximumSessionBytes: 1,
    maximumCheckpointContentBytes: 1,
    maximumCheckpointRecordBytes: 1,
    maximumSourceRecordBytes: 1,
    maximumSummaryRecordBytes: 1,
    maximumSummaryAttemptRecordBytes: 1,
    maxCheckpointsPerTask: 1,
    maximumPublicationRecordBytes: 2 * 1_024 * 1_024,
  };
  const expected = {
    source,
    sourceSHA256: digest(source),
    sourceEpoch: 1,
    policy,
  };
  const validate = () => checkpoint;

  it("rejects a malformed request before validating the checkpoint", () => {
    let called = false;
    expect(() =>
      checkPublicationRequest({ checkpoint, expected: {} }, () => {
        called = true;
        return checkpoint;
      }),
    ).toThrow("CONTEXT_PUBLICATION_INVALID");
    expect(called).toBe(false);
  });

  it("refuses a checkpoint that disagrees with its expected source", () => {
    expect(() =>
      checkPublicationRequest(
        { checkpoint, expected: { ...expected, sourceEpoch: 2 } },
        validate,
      ),
    ).toThrow("CONTEXT_PUBLICATION_SOURCE_MISMATCH");
    expect(() =>
      checkPublicationRequest(
        { checkpoint, expected: { ...expected, sourceSHA256: "d".repeat(64) } },
        validate,
      ),
    ).toThrow("CONTEXT_PUBLICATION_SOURCE_MISMATCH");
  });

  it("decodes a publication and checks its binding and digest", () => {
    const request = checkPublicationRequest({ checkpoint, expected }, validate);
    const record = {
      schemaVersion: 1,
      kind: "context_checkpoint_publication",
      request,
      requestSHA256: digest(request),
    };
    expect(decodePublication(record, binding, validate).requestSHA256).toBe(
      digest(request),
    );
    expect(() => decodePublication(record, other, validate)).toThrow(
      "CONTEXT_PUBLICATION_BINDING_MISMATCH",
    );
    expect(() =>
      decodePublication(
        { ...record, requestSHA256: "e".repeat(64) },
        binding,
        validate,
      ),
    ).toThrow("CONTEXT_PUBLICATION_DIGEST_MISMATCH");
  });
});

describe("decodeCheckpoint", () => {
  it("refuses a checkpoint of another binding", () => {
    const checkpoint = { binding } as unknown as CheckpointEnvelope;
    const record = {
      schemaVersion: 1,
      kind: "context_checkpoint",
      checkpoint,
    };
    expect(decodeCheckpoint(record, binding, () => checkpoint)).toBe(
      checkpoint,
    );
    expect(() => decodeCheckpoint(record, other, () => checkpoint)).toThrow(
      "CHECKPOINT_BINDING_MISMATCH",
    );
    expect(() => decodeCheckpoint({}, binding, () => checkpoint)).toThrow(
      "CHECKPOINT_STATE_CORRUPT",
    );
  });
});

describe("decodeTaskBinding", () => {
  const record = { schemaVersion: 1, kind: "context_session", session };

  it("lists the binding a session names under its own key", () => {
    const entry = decodeTaskBinding(record, bindingKey(binding));
    expect(entry).toEqual({ readable: true, binding });
    expect(entry.readable && entry.binding).not.toBe(binding);
  });

  it("leaves an unreadable or misfiled session unowned", () => {
    const key = bindingKey(other);
    expect(decodeTaskBinding(record, key)).toEqual({ readable: false, key });
    expect(decodeTaskBinding({ schemaVersion: 1 }, key)).toEqual({
      readable: false,
      key,
    });
    expect(decodeTaskBinding(null, key)).toEqual({ readable: false, key });
  });
});
