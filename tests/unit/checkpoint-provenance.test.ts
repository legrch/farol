import { describe, expect, it } from "vitest";
import {
  createCheckpointEnvelope,
  validateCheckpointEnvelope,
  type CheckpointContent,
} from "../../src/modules/chat/domain/checkpoint";
import {
  beginCompaction,
  createContextSession,
  requestCheckpoint,
} from "../../src/modules/chat/domain/context-continuity";

function value<T>(result: { ok: boolean; value?: T }): T {
  if (!result.ok || result.value === undefined)
    throw new Error("EXPECTED_SUCCESS");
  return result.value;
}
const binding = {
  ownerId: "owner",
  taskId: "task",
  hostThreadId: "thread",
  sessionId: "session",
  providerProfileId: "farol",
  modelId: "farol-next/chatgpt",
  mode: "chatgpt",
};
const session = value(
  requestCheckpoint(
    value(
      beginCompaction(createContextSession(binding), {
        operationId: "compact-1",
        source: "canonical_history",
        sourceBoundary: "boundary-1",
      }),
    ),
  ),
);
const content: CheckpointContent = {
  goal: "Continue",
  activeConstraints: ["Never retry unknown write"],
  latestCorrections: [],
  keyDecisions: [],
  completedWork: [],
  unfinishedWork: [],
  unresolvedQuestions: [],
  unknownOutcomes: [{ operationRef: "write-1", description: "Unknown" }],
  artifactRefs: [],
  attachmentRefs: [],
  nextSafeStep: "Observe the same write",
};
const metadata = {
  checkpointId: "checkpoint-1",
  providerOperationId: "summary-1",
  parentCheckpointId: null,
  sourceCursor: "cursor-1",
  createdAt: 1,
};
const provenance = {
  engine: "codex_luna",
  provider: "codex",
  observedModel: "fixture-luna",
  observedEffort: "fixture-effort",
  providerOperationId: "summary-1",
  sourceBoundary: "boundary-1",
  sourceCursor: "cursor-1",
} as const;
const v1 = () => createCheckpointEnvelope(session, content, metadata);
const v2 = () => ({ ...v1(), schemaVersion: 2, summarizer: provenance });

describe("versioned checkpoint summarizer provenance", () => {
  it("reads v1 without rewriting evidence or fabricating observed model", () => {
    const old = v1();
    expect(validateCheckpointEnvelope(old, 65536)).toEqual({
      ok: true,
      value: old,
    });
    expect(old).not.toHaveProperty("summarizer");
  });
  it("keeps continuation provider bound while a separate summarizer has a distinct observed model", () => {
    expect(validateCheckpointEnvelope(v2(), 65536)).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 2,
        binding,
        provider: { modelId: binding.modelId },
        summarizer: provenance,
      },
    });
  });
  it("does not replace the provider binding check with summarizer equality", () => {
    const envelope = v2();
    expect(
      validateCheckpointEnvelope(
        {
          ...envelope,
          provider: { ...envelope.provider, modelId: provenance.observedModel },
        },
        65536,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_PROVIDER_BINDING_MISMATCH" },
    });
  });
  it.each(["providerOperationId", "sourceBoundary", "sourceCursor"] as const)(
    "rejects detached summarizer %s",
    (field) => {
      expect(
        validateCheckpointEnvelope(
          { ...v2(), summarizer: { ...provenance, [field]: "other" } },
          65536,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "CHECKPOINT_SUMMARIZER_BINDING_MISMATCH" },
      });
    },
  );
  it("records unavailable current-ChatGPT model evidence explicitly without copying the route alias", () => {
    expect(
      validateCheckpointEnvelope(
        {
          ...v2(),
          summarizer: {
            ...provenance,
            engine: "current_chatgpt",
            provider: "chatgpt-web",
            observedModel: null,
            observedEffort: null,
          },
        },
        65536,
      ),
    ).toMatchObject({
      ok: true,
      value: { summarizer: { observedModel: null } },
    });
  });
  it("refuses unknown versions, opaque/extra provenance, provider/engine conflicts and unobserved Luna", () => {
    for (const extra of [
      { schemaVersion: 3 },
      { summarizer: { ...provenance, encrypted_content: "opaque" } },
      { summarizer: { ...provenance, provider: "chatgpt-web" } },
      { summarizer: { ...provenance, observedModel: null } },
      { summarizer: { ...provenance, observedEffort: null } },
    ])
      expect(validateCheckpointEnvelope({ ...v2(), ...extra }, 65536).ok).toBe(
        false,
      );
  });
});
