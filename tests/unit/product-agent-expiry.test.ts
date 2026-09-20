import { describe, expect, it } from "vitest";

import {
  ProductAgentInputSchema,
  type ProductAgentInput,
} from "../../src/apps/desktop/product-agent-store";
import {
  productAgentSessionExpiryVerdict,
  persistedProductAgentExpiryVerdict,
  productAgentExpiryRecoveryVerdict,
} from "../../src/apps/desktop/product-agent-expiry";

// S35-TA-7. What happens when a Product Agent's reservation
// (`ProductAgentInput.expiresAt`) elapses: `main.ts` used to decide this
// inline, where no test could reach it. Every case below drives the
// production decision functions the three real timers/recovery path call,
// with the states enumerated rather than sampled.
//
// Two fixtures are the reason this file exists: a mutation already in
// flight when the timer fires (rows tagged DECISIVE-1) must reschedule
// rather than cancel or silently drop the reservation, and a recovered
// input whose assignment binding no longer matches the running task (rows
// tagged DECISIVE-2) must be marked `unknown` and never reach a fresh
// `reschedule`.

const NOW = 1_000_000;
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const EXECUTABLE_SHA = "1".repeat(64);
const SCHEMA_SHA = "3".repeat(64);
const BUILD_ID = "5".repeat(64);
const TIMESTAMP = "2026-09-20T12:00:00.000Z";

/** A real, schema-validated Product Agent input. */
function productAgentInputOf(
  overrides: Partial<ProductAgentInput> = {},
): ProductAgentInput {
  return ProductAgentInputSchema.parse({
    taskId: "task-1",
    sessionId: "session-1",
    assignmentId: "assignment-1",
    authorityId: "authority-1",
    parentParticipantId: "main-1",
    agentParticipantId: "agent-1",
    taskEpoch: 0,
    generation: 1,
    workspaceId: WORKSPACE_ID,
    scope: { mode: "subtree", root: "/workspace/approved" },
    excludedPaths: [],
    objective: "Find the delegated continuity marker and report its path.",
    computerGeneration: 7,
    executableSha256: EXECUTABLE_SHA,
    schemaSha256: SCHEMA_SHA,
    buildId: BUILD_ID,
    expiresAt: NOW + 10_000,
    createdAt: TIMESTAMP,
    ...overrides,
  });
}

describe("productAgentSessionExpiryVerdict", () => {
  it('DECISIVE-1: a mutation is already in flight -> reschedule at now + 100ms, not just "reschedule"', () => {
    expect(
      productAgentSessionExpiryVerdict({
        sessionIsActive: true,
        taskPhase: "running",
        mutationInFlight: true,
        now: NOW,
      }),
    ).toEqual({ action: "reschedule", atMs: NOW + 100 });
  });

  it("nothing is busy -> expire (proceed to cancel the live session)", () => {
    expect(
      productAgentSessionExpiryVerdict({
        sessionIsActive: true,
        taskPhase: "running",
        mutationInFlight: false,
        now: NOW,
      }),
    ).toEqual({ action: "expire" });
  });

  it("control: a session superseded by a newer one must noop even though the task is running and nothing is busy — proves the table notices a dropped guard", () => {
    // If `sessionIsActive` were ignored (the guard a naive merge of the two
    // fire-time decisions would drop first, since neither headline
    // behaviour depends on it), this row would wrongly become "expire" and
    // cancel a session that is no longer the active one.
    expect(
      productAgentSessionExpiryVerdict({
        sessionIsActive: false,
        taskPhase: "running",
        mutationInFlight: false,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "session_superseded" });
  });

  it("the task is no longer running -> noop, even though the session is still active", () => {
    expect(
      productAgentSessionExpiryVerdict({
        sessionIsActive: true,
        taskPhase: "completed",
        mutationInFlight: false,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "task_not_running" });
  });

  it("the task has disappeared from the registry entirely -> noop", () => {
    expect(
      productAgentSessionExpiryVerdict({
        sessionIsActive: true,
        taskPhase: undefined,
        mutationInFlight: false,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "task_not_running" });
  });

  it("a superseded session takes priority over a busy mutation -> noop, not reschedule", () => {
    // Order matters: the original code short-circuits on the session check
    // before ever looking at `taskMutationInFlight`.
    expect(
      productAgentSessionExpiryVerdict({
        sessionIsActive: false,
        taskPhase: "running",
        mutationInFlight: true,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "session_superseded" });
  });
});

describe("persistedProductAgentExpiryVerdict", () => {
  it("DECISIVE-1: a mutation is already in flight -> reschedule at now + 100ms", () => {
    expect(
      persistedProductAgentExpiryVerdict({
        taskPhase: "running",
        mutationInFlight: true,
        now: NOW,
      }),
    ).toEqual({ action: "reschedule", atMs: NOW + 100 });
  });

  it("nothing is busy -> expire (proceed to cancel the persisted task)", () => {
    expect(
      persistedProductAgentExpiryVerdict({
        taskPhase: "running",
        mutationInFlight: false,
        now: NOW,
      }),
    ).toEqual({ action: "expire" });
  });

  it("the task is no longer running -> noop", () => {
    expect(
      persistedProductAgentExpiryVerdict({
        taskPhase: "outcome_unknown",
        mutationInFlight: false,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "task_not_running" });
  });

  it("the task has disappeared from the registry entirely -> noop", () => {
    expect(
      persistedProductAgentExpiryVerdict({
        taskPhase: undefined,
        mutationInFlight: true,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "task_not_running" });
  });
});

describe("productAgentExpiryRecoveryVerdict", () => {
  const input = productAgentInputOf();

  it("matches: a running task, a loaded input whose binding matches -> reschedule at max(now, expiresAt)", () => {
    expect(
      productAgentExpiryRecoveryVerdict({
        hasRunningTask: true,
        storeAvailable: true,
        input,
        assignmentMatches: true,
        now: NOW,
      }),
    ).toEqual({ action: "reschedule", atMs: input.expiresAt });
  });

  it("an already-past expiry still reschedules, clamped to now (never a negative delay)", () => {
    const pastInput = productAgentInputOf({ expiresAt: NOW - 5_000 });
    expect(
      productAgentExpiryRecoveryVerdict({
        hasRunningTask: true,
        storeAvailable: true,
        input: pastInput,
        assignmentMatches: true,
        now: NOW,
      }),
    ).toEqual({ action: "reschedule", atMs: NOW });
  });

  it("DECISIVE-2: the stored input's assignment binding no longer matches the running task -> unknown, and is NOT re-armed", () => {
    const verdict = productAgentExpiryRecoveryVerdict({
      hasRunningTask: true,
      storeAvailable: true,
      input,
      assignmentMatches: false,
      now: NOW,
    });
    expect(verdict).toEqual({
      action: "unknown",
      reason: "assignment_mismatch",
    });
    // Explicitly: an "unknown" verdict never carries a reschedule time, so
    // there is no `atMs` a careless caller could use to re-arm the timer.
    expect(verdict.action).not.toBe("reschedule");
    expect("atMs" in verdict).toBe(false);
  });

  it("no stored input could be loaded (missing file or a load that threw) -> unknown, and is NOT re-armed", () => {
    const verdict = productAgentExpiryRecoveryVerdict({
      hasRunningTask: true,
      storeAvailable: true,
      input: null,
      assignmentMatches: false,
      now: NOW,
    });
    expect(verdict).toEqual({ action: "unknown", reason: "input_unavailable" });
    expect("atMs" in verdict).toBe(false);
  });

  it("missing input takes priority over a mismatch flag left set by a caller bug -> input_unavailable, not assignment_mismatch", () => {
    // Order matters: the original code checks `!input` before consulting
    // the match flag at all (`!input || !productAgentAssignmentMatches(...)`).
    expect(
      productAgentExpiryRecoveryVerdict({
        hasRunningTask: true,
        storeAvailable: true,
        input: null,
        assignmentMatches: true,
        now: NOW,
      }),
    ).toEqual({ action: "unknown", reason: "input_unavailable" });
  });

  it("no task is running -> noop, and never touches the input/store checks", () => {
    expect(
      productAgentExpiryRecoveryVerdict({
        hasRunningTask: false,
        storeAvailable: false,
        input: null,
        assignmentMatches: false,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "no_running_task" });
  });

  it('control: a running task with no store configured must noop, not "no_running_task" -- proves the two noop reasons are not merged', () => {
    expect(
      productAgentExpiryRecoveryVerdict({
        hasRunningTask: true,
        storeAvailable: false,
        input: null,
        assignmentMatches: false,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "store_unavailable" });
  });

  it("a running task takes priority over a missing store -> no_running_task only when the task itself is absent", () => {
    // Order matters: the original code checks `!task` before `!productAgentStore`.
    expect(
      productAgentExpiryRecoveryVerdict({
        hasRunningTask: false,
        storeAvailable: true,
        input,
        assignmentMatches: true,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "no_running_task" });
  });
});
