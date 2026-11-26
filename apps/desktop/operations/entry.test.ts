import { describe, expect, it } from "vitest";
import type { OperationMetadata } from "../renderer/operations-contract";
import { buildEntry, observedReferences } from "./entry";

const metadata: OperationMetadata = {
  source: "ChatGPT",
  kind: "computer_shell_start",
  target: {},
};
const references = {
  operationRef: {
    owner: "computer.process" as const,
    operationId: "op",
    buildId: "build",
    runtimeId: "runtime",
    binding: "requested" as const,
  },
  subjectRef: null,
};
const id = "00000000-0000-4000-8000-000000000001";

describe("observedReferences", () => {
  it("accepts the binding only for a finished shell start", () => {
    expect(
      observedReferences(metadata, "done", references)?.operationRef?.binding,
    ).toBe("accepted");
    for (const outcome of ["refused", "failed", "unknown", "pending"] as const)
      expect(observedReferences(metadata, outcome, references)).toBe(
        references,
      );
    expect(
      observedReferences({ ...metadata, kind: "other" }, "done", references),
    ).toBe(references);
    expect(observedReferences(metadata, "done", undefined)).toBeUndefined();
  });
  it("does not mutate the original references", () => {
    observedReferences(metadata, "done", references);
    expect(references.operationRef.binding).toBe("requested");
  });
});

describe("buildEntry", () => {
  it("rounds and floors the duration and omits execution fields without references", () => {
    const entry = buildEntry({
      metadata,
      id,
      at: 7,
      outcome: "done",
      code: null,
      durationMs: -3.6,
    }) as Record<string, unknown>;
    expect(entry.durationMs).toBe(0);
    expect("schema" in entry).toBe(false);
    expect("timing" in entry).toBe(false);
    expect(
      buildEntry({
        metadata,
        id,
        at: 7,
        outcome: "done",
        code: null,
        durationMs: 2.5,
      }).durationMs,
    ).toBe(3);
  });
  it("makes an execution entry schema 2 with only the request time", () => {
    const entry = buildEntry({
      metadata,
      id,
      at: 7,
      outcome: "pending",
      code: null,
      durationMs: 0,
      lifecycle: { id, phase: "started" },
      references,
      requestedAt: 5,
    }) as Record<string, unknown>;
    expect(entry).toMatchObject({
      schema: "farol.operation/2",
      timing: { requestedAt: 5, startedAt: null, endedAt: null },
      exit: null,
      executionFacts: null,
      lifecycle: { id, phase: "started" },
    });
    expect("nativeRefusalReason" in entry).toBe(false);
  });
  it("records a native reason only for a native refusal", () => {
    const base = {
      metadata,
      id,
      at: 7,
      durationMs: 0,
      references,
      requestedAt: 5,
      reason: "admission_policy" as const,
    };
    expect(
      buildEntry({
        ...base,
        outcome: "refused",
        code: "PROCESS_NATIVE_REFUSED",
      }),
    ).toHaveProperty("nativeRefusalReason");
    expect(
      buildEntry({
        ...base,
        outcome: "failed",
        code: "PROCESS_NATIVE_REFUSED",
      }),
    ).not.toHaveProperty("nativeRefusalReason");
  });
});
