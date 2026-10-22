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
import { contextTaskPresentation } from "../../src/ui/context-task-presentation";

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
    expect(contextTaskPresentation(context)).toEqual({
      tone: "running",
      label: "Recovering from history",
      attention: false,
      locked: true,
    });
    expect(JSON.stringify(context)).not.toMatch(
      /canonicalHistory|checkpointContent|activeConstraints|artifactRefs|prompt|answer/iu,
    );
  });

  it("keeps context uncertainty distinct from Failed and disables destructive task actions", () => {
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

    expect(contextTaskPresentation(context)).toEqual({
      tone: "unknown",
      label: "Context outcome unknown",
      attention: true,
      locked: true,
    });
    expect(context.code).toBe("SUMMARY_SUBMISSION_UNRESOLVED");
  });

  it("shows an explicit usage-limit remedy without calling it a failed task", () => {
    expect(
      contextTaskPresentation({
        epoch: 1,
        phase: "blocked",
        source: "canonical_history",
        code: "SUMMARY_USAGE_LIMITED",
      }),
    ).toEqual({
      tone: "unavailable",
      label: "Context usage limited",
      attention: true,
      locked: true,
    });
  });

  it("names the remedy for a retirement a newer conversation superseded", () => {
    expect(
      contextTaskPresentation({
        epoch: 1,
        phase: "blocked",
        source: "retained_agent",
        code: "SOURCE_RETIREMENT_SUPERSEDED",
      }),
    ).toEqual({
      tone: "waiting",
      label: "Return to the previous conversation",
      attention: true,
      locked: true,
    });
  });

  it("does not override ordinary task presentation while context is active", () => {
    expect(
      contextTaskPresentation(
        toProductTaskContext(createContextSession(binding)),
      ),
    ).toBeNull();
  });
});
