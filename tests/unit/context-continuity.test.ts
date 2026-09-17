import { describe, expect, it } from "vitest";
import {
  activateNextEpoch,
  beginCompaction,
  blockContext,
  confirmHostContext,
  createContextSession,
  markCheckpointStored,
  markContextOutcomeUnknown,
  markOldEpochRetired,
  markSummaryDispatchObserved,
  offerCheckpointHandoff,
  recordValidatedCheckpoint,
  requestCheckpoint,
  resumeSourceRetirementCleanup,
  restoreActiveBeforeSummaryDispatch,
  restoreStoredBeforeHostOffer,
  type ContextBinding,
} from "../../src/modules/chat/domain/context-continuity";
import {
  createCheckpointEnvelope,
  validateCheckpointContent,
} from "../../src/modules/chat/domain/checkpoint";

const binding: ContextBinding = {
  ownerId: "owner-preview",
  taskId: "task-atlantic",
  hostThreadId: "thread-atlantic",
  sessionId: "session-atlantic",
  providerProfileId: "profile-isolated-next",
  modelId: "chatgpt-web/high",
  mode: "high",
};

const command = {
  operationId: "compact-atlantic-1",
  source: "retained_agent" as const,
  sourceBoundary: "message-42",
};

const content = {
  goal: "Continue the exact Farol Next task.",
  activeConstraints: ["Never repeat an outcome-unknown write."],
  latestCorrections: ["Use Watch Rail, not Graphite."],
  keyDecisions: ["Context continuity belongs to the Chat module."],
  completedWork: [
    {
      description: "Committed the Watch Rail shell.",
      evidenceRefs: ["git:ec15b2e"],
    },
  ],
  unfinishedWork: ["Connect the native host compaction path."],
  unresolvedQuestions: ["Whether the retained browser source is reusable."],
  unknownOutcomes: [
    {
      operationRef: "write-17",
      description: "Provider acknowledgement was lost.",
    },
  ],
  artifactRefs: [
    {
      reference: "vnext/src/modules/chat/domain/context-continuity.ts",
      availability: "available" as const,
    },
  ],
  attachmentRefs: [
    { reference: "image-owner-1", availability: "unavailable" as const },
  ],
  nextSafeStep: "Observe write-17 before any further mutation.",
};

function expectValue<T>(result: {
  ok: boolean;
  value?: T;
  error?: { code: string };
}): T {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok || result.value === undefined) {
    throw new Error(result.error?.code ?? "EXPECTED_SUCCESS");
  }
  return result.value;
}

describe("context continuity domain", () => {
  it("moves one exact operation through the durable handoff boundary", () => {
    let state = createContextSession(binding);
    state = expectValue(
      beginCompaction(state, {
        operationId: "compact-atlantic-1",
        source: "retained_agent",
        sourceBoundary: "message-42",
      }),
    );
    expect(state).toMatchObject({ phase: "quiescing", epoch: 1 });

    state = expectValue(requestCheckpoint(state));
    state = expectValue(markSummaryDispatchObserved(state));
    const validated = validateCheckpointContent(content, 16_384);
    expect(validated).toMatchObject({ ok: true });
    if (!validated.ok) return;
    const checkpoint = createCheckpointEnvelope(state, validated.value, {
      checkpointId: "checkpoint-atlantic-1",
      providerOperationId: "provider-summary-1",
      parentCheckpointId: null,
      sourceCursor: "cursor-42",
      createdAt: 1_000,
    });
    state = expectValue(recordValidatedCheckpoint(state, checkpoint));
    state = expectValue(markCheckpointStored(state));
    state = expectValue(offerCheckpointHandoff(state));
    state = expectValue(confirmHostContext(state, "host-context-2"));
    state = expectValue(markOldEpochRetired(state));
    state = expectValue(activateNextEpoch(state));

    expect(state).toMatchObject({
      phase: "active",
      epoch: 2,
      operation: null,
      lastCheckpointId: "checkpoint-atlantic-1",
      lastCompletedOperationId: "compact-atlantic-1",
    });
  });

  it("coalesces a duplicate trigger without creating another operation", () => {
    const first = expectValue(
      beginCompaction(createContextSession(binding), {
        operationId: "compact-atlantic-1",
        source: "retained_agent",
        sourceBoundary: "message-42",
      }),
    );
    expect(
      beginCompaction(first, {
        operationId: "compact-atlantic-1",
        source: "retained_agent",
        sourceBoundary: "message-42",
      }),
    ).toEqual({ ok: true, value: first });
    expect(
      beginCompaction(first, {
        operationId: "compact-atlantic-2",
        source: "retained_agent",
        sourceBoundary: "message-42",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_OPERATION_IN_PROGRESS" },
    });
  });

  it("rejects a forged checkpoint binding and stale epoch", () => {
    let state = expectValue(
      beginCompaction(createContextSession(binding), {
        operationId: "compact-atlantic-1",
        source: "canonical_history",
        sourceBoundary: "history-42",
      }),
    );
    state = expectValue(requestCheckpoint(state));
    const parsed = validateCheckpointContent(content, 16_384);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const checkpoint = createCheckpointEnvelope(state, parsed.value, {
      checkpointId: "checkpoint-atlantic-1",
      providerOperationId: "provider-summary-1",
      parentCheckpointId: null,
      sourceCursor: "cursor-42",
      createdAt: 1_000,
    });

    expect(
      recordValidatedCheckpoint(state, {
        ...checkpoint,
        binding: { ...checkpoint.binding, taskId: "task-harbor" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_BINDING_MISMATCH" },
    });
    expect(
      recordValidatedCheckpoint(state, { ...checkpoint, epoch: 0 }),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_STALE_EPOCH" },
    });
  });

  it("rejects empty, oversized, and authority-bearing model content", () => {
    expect(validateCheckpointContent({}, 16_384)).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_CONTENT_INVALID" },
    });
    expect(
      validateCheckpointContent(
        { ...content, goal: "x".repeat(20_000) },
        1_024,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_CONTENT_OVERSIZED" },
    });
    expect(
      validateCheckpointContent(
        {
          ...content,
          taskGrant: { roots: ["/"] },
          executionTools: ["shell"],
        },
        16_384,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_CONTENT_INVALID" },
    });
  });

  it("rejects invalid transaction identities and out-of-order transitions", () => {
    const active = createContextSession(binding);
    expect(
      beginCompaction(active, {
        ...command,
        operationId: "",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_OPERATION_INVALID" },
    });
    expect(requestCheckpoint(active)).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_INVALID_TRANSITION" },
    });
    expect(markCheckpointStored(active)).toMatchObject({ ok: false });
    expect(offerCheckpointHandoff(active)).toMatchObject({ ok: false });
    expect(restoreActiveBeforeSummaryDispatch(active)).toMatchObject({
      ok: false,
    });
    expect(restoreStoredBeforeHostOffer(active)).toMatchObject({ ok: false });
    expect(confirmHostContext(active, "host-context")).toMatchObject({
      ok: false,
    });
    expect(markOldEpochRetired(active)).toMatchObject({ ok: false });
    expect(activateNextEpoch(active)).toMatchObject({ ok: false });
    expect(blockContext(active, "BLOCKED")).toMatchObject({ ok: false });
    expect(markContextOutcomeUnknown(active, "UNKNOWN")).toMatchObject({
      ok: false,
    });
  });

  it("rejects mismatched operations and accepts idempotent dispatch observation", () => {
    const started = expectValue(
      beginCompaction(createContextSession(binding), command),
    );
    expect(
      beginCompaction(started, {
        ...command,
        operationId: "another-operation",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_OPERATION_IN_PROGRESS" },
    });
    const requested = expectValue(requestCheckpoint(started));
    const observed = expectValue(markSummaryDispatchObserved(requested));
    expect(markSummaryDispatchObserved(observed)).toEqual({
      ok: true,
      value: observed,
    });
    expect(restoreActiveBeforeSummaryDispatch(observed)).toMatchObject({
      ok: false,
    });
    expect(
      markContextOutcomeUnknown(observed, "SUMMARY_UNKNOWN"),
    ).toMatchObject({
      ok: true,
      value: { phase: "outcome_unknown", blockedCode: "SUMMARY_UNKNOWN" },
    });
    expect(blockContext(observed, "SUMMARY_BLOCKED")).toMatchObject({
      ok: true,
      value: { phase: "blocked", blockedCode: "SUMMARY_BLOCKED" },
    });
  });

  it("rejects checkpoint operation and source mismatches", () => {
    const requested = expectValue(
      requestCheckpoint(
        expectValue(beginCompaction(createContextSession(binding), command)),
      ),
    );
    const parsed = validateCheckpointContent(content, 16_384);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const checkpoint = createCheckpointEnvelope(requested, parsed.value, {
      checkpointId: "checkpoint-atlantic-1",
      providerOperationId: "provider-summary-1",
      parentCheckpointId: null,
      sourceCursor: "cursor-42",
      createdAt: 1_000,
    });

    expect(
      recordValidatedCheckpoint(requested, {
        ...checkpoint,
        operationId: "foreign-operation",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_OPERATION_MISMATCH" },
    });
    expect(
      recordValidatedCheckpoint(requested, {
        ...checkpoint,
        source: "canonical_history",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_SOURCE_MISMATCH" },
    });
    expect(
      recordValidatedCheckpoint(createContextSession(binding), checkpoint),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_INVALID_TRANSITION" },
    });
  });

  it("validates size configuration and cyclic input before schema parsing", () => {
    expect(validateCheckpointContent(content, 0)).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_CONTENT_OVERSIZED" },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateCheckpointContent(cyclic, 16_384)).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_CONTENT_INVALID" },
    });
    expect(() =>
      createCheckpointEnvelope(createContextSession(binding), content, {
        checkpointId: "checkpoint-atlantic-1",
        providerOperationId: "provider-summary-1",
        parentCheckpointId: null,
        sourceCursor: "cursor-42",
        createdAt: 1_000,
      }),
    ).toThrow("CHECKPOINT_SESSION_NOT_REQUESTED");
  });

  it("restores a host offer only after the host proves it was never sent", () => {
    let state = expectValue(
      beginCompaction(createContextSession(binding), command),
    );
    state = expectValue(requestCheckpoint(state));
    state = expectValue(markSummaryDispatchObserved(state));
    const parsed = validateCheckpointContent(content, 16_384);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const checkpoint = createCheckpointEnvelope(state, parsed.value, {
      checkpointId: "checkpoint-atlantic-1",
      providerOperationId: "provider-summary-1",
      parentCheckpointId: null,
      sourceCursor: "cursor-42",
      createdAt: 1_000,
    });
    state = expectValue(recordValidatedCheckpoint(state, checkpoint));
    state = expectValue(markCheckpointStored(state));
    state = expectValue(offerCheckpointHandoff(state));
    expect(restoreStoredBeforeHostOffer(state)).toMatchObject({
      ok: true,
      value: { phase: "durably_stored" },
    });
    expect(confirmHostContext(state, "")).toMatchObject({ ok: false });
  });

  it("resumes only idempotent local cleanup after host confirmation", () => {
    let state = expectValue(
      beginCompaction(createContextSession(binding), command),
    );
    state = expectValue(requestCheckpoint(state));
    state = expectValue(markSummaryDispatchObserved(state));
    const parsed = validateCheckpointContent(content, 16_384);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const checkpoint = createCheckpointEnvelope(state, parsed.value, {
      checkpointId: "checkpoint-atlantic-cleanup",
      providerOperationId: "provider-summary-cleanup",
      parentCheckpointId: null,
      sourceCursor: "cursor-cleanup",
      createdAt: 1_000,
    });
    state = expectValue(recordValidatedCheckpoint(state, checkpoint));
    state = expectValue(markCheckpointStored(state));
    state = expectValue(offerCheckpointHandoff(state));
    state = expectValue(confirmHostContext(state, "host-context-cleanup"));
    const unknown = expectValue(
      markContextOutcomeUnknown(state, "SOURCE_RETIREMENT_UNKNOWN"),
    );

    expect(resumeSourceRetirementCleanup(unknown)).toMatchObject({
      ok: true,
      value: {
        phase: "host_context_confirmed",
        blockedCode: null,
      },
    });
    const blocked = expectValue(
      blockContext(state, "CONTEXT_SUMMARY_CLEANUP_FAILED"),
    );
    expect(resumeSourceRetirementCleanup(blocked)).toMatchObject({
      ok: true,
      value: {
        phase: "host_context_confirmed",
        blockedCode: null,
      },
    });
    expect(
      resumeSourceRetirementCleanup({
        ...unknown,
        blockedCode: "SUMMARY_SUBMISSION_UNRESOLVED",
      }),
    ).toMatchObject({ ok: false });
  });
});
