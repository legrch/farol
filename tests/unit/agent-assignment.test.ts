import { describe, expect, it } from "vitest";
import {
  completeAssignment,
  createAssignment,
  failChildAssignment,
  failPreparedAssignment,
  markChildOutcomeUnknown,
  markSpawnOutcomeUnknown,
  startAssignment,
} from "../../src/modules/agent/domain/assignment";

describe("Agent assignment policy", () => {
  it("admits one exact child and accepts only that child's result", () => {
    const assignment = createAssignment({
      assignmentId: "assignment-a",
      ownerId: "owner-preview",
      generation: 2,
    });
    const started = startAssignment(assignment, {
      assignmentId: "assignment-a",
      ownerId: "owner-preview",
      generation: 2,
      childId: "child-a",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(
      completeAssignment(started.value, {
        assignmentId: "assignment-a",
        ownerId: "owner-preview",
        generation: 2,
        childId: "child-b",
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_CORRELATION" } });
    expect(
      completeAssignment(started.value, {
        assignmentId: "assignment-a",
        ownerId: "owner-preview",
        generation: 2,
        childId: "child-a",
      }),
    ).toMatchObject({ ok: true, value: { phase: "completed" } });
  });

  it("rejects a second child and stale generation", () => {
    const assignment = createAssignment({
      assignmentId: "assignment-a",
      ownerId: "owner-preview",
      generation: 2,
    });
    const stale = startAssignment(assignment, {
      assignmentId: "assignment-a",
      ownerId: "owner-preview",
      generation: 1,
      childId: "child-a",
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION" },
    });
    const started = startAssignment(assignment, {
      assignmentId: "assignment-a",
      ownerId: "owner-preview",
      generation: 2,
      childId: "child-a",
    });
    if (!started.ok) throw new Error("start failed");
    expect(
      startAssignment(started.value, {
        assignmentId: "assignment-a",
        ownerId: "owner-preview",
        generation: 2,
        childId: "child-b",
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_ALREADY_STARTED" } });
  });

  it("keeps terminal and child finishing transitions explicit", () => {
    const prepared = createAssignment({
      assignmentId: "assignment-a",
      ownerId: "owner-preview",
      generation: 2,
    });
    expect(failPreparedAssignment(prepared)).toMatchObject({
      ok: true,
      value: { phase: "failed", terminal: true },
    });
    expect(markSpawnOutcomeUnknown(prepared)).toMatchObject({
      ok: true,
      value: { phase: "outcome_unknown", terminal: true },
    });

    const started = startAssignment(prepared, {
      assignmentId: "assignment-a",
      ownerId: "owner-preview",
      generation: 2,
      childId: "child-a",
    });
    if (!started.ok) throw new Error("start failed");
    expect(failPreparedAssignment(started.value)).toMatchObject({
      ok: false,
      error: { code: "AGENT_ALREADY_STARTED" },
    });
    expect(markSpawnOutcomeUnknown(started.value)).toMatchObject({
      ok: false,
      error: { code: "AGENT_ALREADY_STARTED" },
    });
    expect(
      failChildAssignment(started.value, {
        assignmentId: "assignment-a",
        ownerId: "foreign-owner",
        generation: 2,
        childId: "child-a",
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_CORRELATION" } });
    expect(
      failChildAssignment(started.value, {
        assignmentId: "assignment-a",
        ownerId: "owner-preview",
        generation: 2,
        childId: "child-a",
      }),
    ).toMatchObject({ ok: true, value: { phase: "failed", terminal: true } });
    expect(
      markChildOutcomeUnknown(started.value, {
        assignmentId: "assignment-a",
        ownerId: "owner-preview",
        generation: 2,
        childId: "child-a",
      }),
    ).toMatchObject({
      ok: true,
      value: { phase: "outcome_unknown", terminal: true },
    });

    const terminal = completeAssignment(started.value, {
      assignmentId: "assignment-a",
      ownerId: "owner-preview",
      generation: 2,
      childId: "child-a",
    });
    if (!terminal.ok) throw new Error("completion failed");
    expect(
      startAssignment(terminal.value, {
        assignmentId: "assignment-a",
        ownerId: "owner-preview",
        generation: 2,
        childId: "child-a",
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_TERMINAL" } });
    expect(
      completeAssignment(terminal.value, {
        assignmentId: "assignment-a",
        ownerId: "owner-preview",
        generation: 2,
        childId: "child-a",
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_TERMINAL" } });
    expect(failPreparedAssignment(terminal.value)).toMatchObject({
      ok: false,
      error: { code: "AGENT_TERMINAL" },
    });
    expect(markSpawnOutcomeUnknown(terminal.value)).toMatchObject({
      ok: false,
      error: { code: "AGENT_TERMINAL" },
    });
    expect(
      failChildAssignment(terminal.value, {
        assignmentId: "assignment-a",
        ownerId: "owner-preview",
        generation: 2,
        childId: "child-a",
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_TERMINAL" } });
  });
});
