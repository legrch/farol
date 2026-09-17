import { describe, expect, it } from "vitest";
import {
  completeAssignment,
  createAssignment,
  failChildAssignment,
  failPreparedAssignment,
  markChildOutcomeUnknown,
  markSpawnOutcomeUnknown,
  startAssignment,
  type AssignmentAuthority,
  type AssignmentIdentity,
  type ChildCorrelation,
} from "../../src/modules/agent/domain/assignment";

const identity: AssignmentIdentity = {
  assignmentId: "assignment-a",
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 3,
  generation: 2,
};

const authority: AssignmentAuthority = {
  authorityId: "authority-task-a",
  participantId: "agent-a",
  parentParticipantId: "main-a",
  role: "agent",
  mutationOwnership: "task",
};

const child: ChildCorrelation = {
  ...identity,
  authorityId: authority.authorityId,
  participantId: authority.participantId,
  role: authority.role,
  parentThreadId: "parent-thread-a",
  childId: "child-a",
  parentTurnId: "parent-turn-a",
  childTurnId: "child-turn-a",
  hostRole: "agent",
  delegationDigest: "a".repeat(64),
};

function prepared() {
  return createAssignment(identity, authority);
}

describe("Agent assignment policy", () => {
  it("admits one exact child and accepts only that child's result", () => {
    const started = startAssignment(prepared(), child);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(
      completeAssignment(started.value, { ...child, childId: "child-b" }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_CORRELATION" } });
    expect(
      completeAssignment(started.value, {
        ...child,
        parentThreadId: "foreign-parent-thread",
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_CORRELATION" } });
    expect(
      completeAssignment(started.value, { ...child, role: "critic" }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_CORRELATION" } });
    expect(
      completeAssignment(started.value, {
        ...child,
        delegationDigest: "b".repeat(64),
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_CORRELATION" } });
    expect(completeAssignment(started.value, child)).toMatchObject({
      ok: true,
      value: { phase: "completed" },
    });
  });

  it("rejects a second child and stale task or authority correlation", () => {
    expect(
      startAssignment(prepared(), { ...child, generation: 1 }),
    ).toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION" },
    });
    expect(
      startAssignment(prepared(), {
        ...child,
        authorityId: "foreign-authority",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION" },
    });
    expect(
      startAssignment(prepared(), {
        ...child,
        participantId: "critic-a",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION" },
    });
    expect(
      startAssignment(prepared(), { ...child, role: "critic" }),
    ).toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION" },
    });
    expect(
      startAssignment(prepared(), { ...child, taskEpoch: 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION" },
    });

    const started = startAssignment(prepared(), child);
    if (!started.ok) throw new Error("start failed");
    expect(
      startAssignment(started.value, { ...child, childId: "child-b" }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_ALREADY_STARTED" } });
  });

  it("keeps terminal causes and child finishing transitions explicit", () => {
    expect(failPreparedAssignment(prepared())).toMatchObject({
      ok: true,
      value: {
        phase: "failed",
        terminal: true,
        terminalReason: {
          code: "AGENT_SPAWN_REJECTED",
          source: "native-host",
        },
      },
    });
    expect(markSpawnOutcomeUnknown(prepared())).toMatchObject({
      ok: true,
      value: {
        phase: "outcome_unknown",
        terminal: true,
        terminalReason: {
          code: "AGENT_SPAWN_ACK_LOST",
          source: "native-host-transport",
        },
      },
    });

    const started = startAssignment(prepared(), child);
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
        ...child,
        ownerId: "foreign-owner",
      }),
    ).toMatchObject({ ok: false, error: { code: "AGENT_CORRELATION" } });
    expect(failChildAssignment(started.value, child)).toMatchObject({
      ok: true,
      value: { phase: "failed", terminal: true },
    });
    expect(markChildOutcomeUnknown(started.value, child)).toMatchObject({
      ok: true,
      value: { phase: "outcome_unknown", terminal: true },
    });
  });

  it("keeps every terminal assignment immutable", () => {
    const started = startAssignment(prepared(), child);
    if (!started.ok) throw new Error("start failed");
    const terminal = completeAssignment(started.value, child);
    if (!terminal.ok) throw new Error("completion failed");

    expect(startAssignment(terminal.value, child)).toMatchObject({
      ok: false,
      error: { code: "AGENT_TERMINAL" },
    });
    expect(completeAssignment(terminal.value, child)).toMatchObject({
      ok: false,
      error: { code: "AGENT_TERMINAL" },
    });
    expect(failPreparedAssignment(terminal.value)).toMatchObject({
      ok: false,
      error: { code: "AGENT_TERMINAL" },
    });
    expect(markSpawnOutcomeUnknown(terminal.value)).toMatchObject({
      ok: false,
      error: { code: "AGENT_TERMINAL" },
    });
    expect(failChildAssignment(terminal.value, child)).toMatchObject({
      ok: false,
      error: { code: "AGENT_TERMINAL" },
    });
  });
});
