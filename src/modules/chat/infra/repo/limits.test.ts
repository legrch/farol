import { describe, expect, it } from "vitest";
import {
  resolveLimits,
  resolveProcessIdentity,
  publicationPolicy,
} from "./limits";
import {
  DEFAULT_RETENTION,
  DEFAULT_SESSION_BYTES,
  MAXIMUM_PUBLICATION_RECORD_BYTES,
} from "./records";

describe("resolveLimits", () => {
  it("fills every budget from its default", () => {
    const limits = resolveLimits({});
    expect(limits.maximumSessionBytes).toBe(DEFAULT_SESSION_BYTES);
    expect(limits.maxCheckpointsPerTask).toBe(DEFAULT_RETENTION);
    expect(Object.keys(limits)).toEqual([
      "maximumSessionBytes",
      "maximumCheckpointContentBytes",
      "maximumCheckpointRecordBytes",
      "maximumSourceRecordBytes",
      "maximumSummaryRecordBytes",
      "maximumSummaryAttemptRecordBytes",
      "maxCheckpointsPerTask",
    ]);
  });

  it("keeps an explicit budget", () => {
    expect(
      resolveLimits({ maxCheckpointsPerTask: 3 }).maxCheckpointsPerTask,
    ).toBe(3);
  });

  it("names the first invalid budget in validation order", () => {
    expect(() =>
      resolveLimits({ maximumSessionBytes: 0, maxCheckpointsPerTask: 0 }),
    ).toThrow("CONTEXT_SESSION_BUDGET_INVALID");
    expect(() => resolveLimits({ maximumSourceRecordBytes: 1.5 })).toThrow(
      "CONTEXT_SOURCE_BUDGET_INVALID",
    );
    expect(() => resolveLimits({ maxCheckpointsPerTask: -1 })).toThrow(
      "CHECKPOINT_RETENTION_INVALID",
    );
  });
});

describe("resolveProcessIdentity", () => {
  const instance = "a".repeat(32);

  it("falls back to the current process and default instance", () => {
    expect(resolveProcessIdentity({}, 12, instance)).toEqual({
      processId: 12,
      processInstanceId: instance,
    });
  });

  it("prefers the hook values", () => {
    expect(
      resolveProcessIdentity(
        { processId: 4, processInstanceId: "b".repeat(32) },
        12,
        instance,
      ),
    ).toEqual({ processId: 4, processInstanceId: "b".repeat(32) });
  });

  it("refuses an invalid process id before an invalid instance id", () => {
    expect(() =>
      resolveProcessIdentity(
        { processId: 0, processInstanceId: "x" },
        12,
        instance,
      ),
    ).toThrow("CONTEXT_PROCESS_ID_INVALID");
    expect(() =>
      resolveProcessIdentity({ processInstanceId: "x" }, 12, instance),
    ).toThrow("CONTEXT_PROCESS_INSTANCE_ID_INVALID");
  });
});

describe("publicationPolicy", () => {
  it("freezes the budgets in the stored key order", () => {
    const policy = publicationPolicy(resolveLimits({}));
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.keys(policy)).toEqual([
      "schemaVersion",
      "maximumSessionBytes",
      "maximumCheckpointContentBytes",
      "maximumCheckpointRecordBytes",
      "maximumSourceRecordBytes",
      "maximumSummaryRecordBytes",
      "maximumSummaryAttemptRecordBytes",
      "maxCheckpointsPerTask",
      "maximumPublicationRecordBytes",
    ]);
    expect(policy.maximumPublicationRecordBytes).toBe(
      MAXIMUM_PUBLICATION_RECORD_BYTES,
    );
  });
});
