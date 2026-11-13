import { describe, expect, it } from "vitest";

import { toProductTaskContext } from "../../src/apps/desktop/context-task-state";
import {
  beginCompaction,
  createContextSession,
  markContextOutcomeUnknown,
  markSummaryDispatchObserved,
  requestCheckpoint,
  type ContextBinding,
} from "../../src/modules/chat/domain/context-continuity";
import type { Result } from "../../src/pkg/kernel/domain/result";

const binding: ContextBinding = {
  ownerId: "owner-preview",
  taskId: "task-context-1",
  hostThreadId: "task-context-1",
  sessionId: "task-context-1",
  providerProfileId: "profile-isolated-farol",
  modelId: "legacy-route/mind",
  mode: "mind",
};

function value<T, E extends string>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("EXPECTED_CONTEXT_STATE");
  return result.value;
}

describe("context task state", () => {
  it("maps a canonical-history checkpoint to a content-free recovery signal", () => {
    const started = value(
      beginCompaction(createContextSession(binding), {
        operationId: "compact-context-1",
        source: "canonical_history",
        sourceBoundary: "sha256:context-1",
      }),
    );
    const requested = value(requestCheckpoint(started));
    const context = toProductTaskContext(requested);

    expect(context).toEqual({
      epoch: 1,
      phase: "checkpoint_requested",
      source: "canonical_history",
      code: null,
    });
    expect(JSON.stringify(context)).not.toMatch(
      /canonicalHistory|checkpointContent|activeConstraints|artifactRefs|prompt|answer/iu,
    );
  });

  it("keeps context uncertainty distinct from Failed", () => {
    const started = value(
      beginCompaction(createContextSession(binding), {
        operationId: "compact-context-2",
        source: "retained_agent",
        sourceBoundary: "sha256:context-2",
      }),
    );
    const requested = value(requestCheckpoint(started));
    const observed = value(markSummaryDispatchObserved(requested));
    const unknown = value(
      markContextOutcomeUnknown(observed, "SUMMARY_SUBMISSION_UNRESOLVED"),
    );
    const context = toProductTaskContext(unknown);

    expect(context.code).toBe("SUMMARY_SUBMISSION_UNRESOLVED");
  });
});
