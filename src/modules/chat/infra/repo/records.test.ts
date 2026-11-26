import { describe, expect, it } from "vitest";
import {
  MAXIMUM_PUBLICATION_RECORD_BYTES,
  admissionLeaseRecordSchema,
  completionRecordSchema,
  publicationPolicySchema,
  sessionRecordSchema,
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

describe("context store record schemas", () => {
  it("accepts a minimal session and rejects unknown fields", () => {
    const record = {
      schemaVersion: 1,
      kind: "context_session",
      session: {
        binding,
        epoch: 1,
        phase: "active",
        operation: null,
        lastCheckpointId: null,
        lastCompletedOperationId: null,
        blockedCode: null,
      },
    };
    expect(sessionRecordSchema.safeParse(record).success).toBe(true);
    expect(
      sessionRecordSchema.safeParse({ ...record, extra: true }).success,
    ).toBe(false);
  });

  it("refuses a completed request that names another operation", () => {
    const parsed = sessionRecordSchema.safeParse({
      schemaVersion: 1,
      kind: "context_session",
      session: {
        binding,
        epoch: 1,
        phase: "active",
        operation: null,
        lastCheckpointId: null,
        lastCompletedOperationId: "one",
        lastCompletedRequest: {
          operationId: "two",
          source: "retained_agent",
          sourceBoundary: "b",
        },
        blockedCode: null,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("pins the publication record ceiling in the policy schema", () => {
    const policy = {
      schemaVersion: 1,
      maximumSessionBytes: 1,
      maximumCheckpointContentBytes: 1,
      maximumCheckpointRecordBytes: 1,
      maximumSourceRecordBytes: 1,
      maximumSummaryRecordBytes: 1,
      maximumSummaryAttemptRecordBytes: 1,
      maxCheckpointsPerTask: 1,
      maximumPublicationRecordBytes: MAXIMUM_PUBLICATION_RECORD_BYTES,
    };
    expect(publicationPolicySchema.safeParse(policy).success).toBe(true);
    expect(
      publicationPolicySchema.safeParse({
        ...policy,
        maximumPublicationRecordBytes: 1,
      }).success,
    ).toBe(false);
  });

  it("requires lowercase hex identities on lease and completion records", () => {
    expect(
      admissionLeaseRecordSchema.safeParse({
        schemaVersion: 1,
        kind: "context_admission_lease",
        processId: 1,
        processInstanceId: "A".repeat(32),
        token: "t".repeat(32),
      }).success,
    ).toBe(false);
    expect(
      completionRecordSchema.safeParse({
        schemaVersion: 1,
        kind: "context_completion",
        admission: {
          binding,
          sourceEpoch: 1,
          request: {
            operationId: "o",
            source: "canonical_history",
            sourceBoundary: "b",
          },
        },
        checkpointId: "c",
        checkpointSHA256: "z".repeat(64),
      }).success,
    ).toBe(false);
  });
});
