import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  acceptSubmission,
  activateSubmission,
  appendDelta,
  cancelTurn,
  completeTurn,
  createTurn,
  markOutcomeUnknown,
  requestComputer,
  resolveComputer,
} from "../../src/modules/chat/domain/turn";

const identity = {
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  turnId: "turn-a",
  generation: 7,
} as const;

function runningTurn() {
  const activated = activateSubmission(createTurn(identity));
  expect(activated.ok).toBe(true);
  if (!activated.ok) throw new Error("activation failed");
  const accepted = acceptSubmission(activated.value);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error("acceptance failed");
  return accepted.value;
}

describe("Turn state", () => {
  it("keeps submit activation distinct from provider acceptance", () => {
    const prepared = createTurn(identity);
    const activated = activateSubmission(prepared);
    expect(activated).toMatchObject({
      ok: true,
      value: { phase: "submit_activated" },
    });
    if (!activated.ok) return;
    expect(acceptSubmission(activated.value)).toMatchObject({
      ok: true,
      value: { phase: "running" },
    });
  });

  it("turns cancellation after activation into an outcome-unknown tombstone", () => {
    const activated = activateSubmission(createTurn(identity));
    if (!activated.ok) throw new Error("activation failed");
    expect(cancelTurn(activated.value)).toMatchObject({
      ok: true,
      value: { phase: "outcome_unknown", terminal: true },
    });
  });

  it("rejects a late completion after outcome became unknown", () => {
    const unknown = markOutcomeUnknown(runningTurn(), "provider_ack_lost");
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(completeTurn(unknown.value)).toMatchObject({
      ok: false,
      error: { code: "TURN_TERMINAL" },
    });
  });

  it("requires an incremental delta before completion", () => {
    expect(completeTurn(runningTurn())).toMatchObject({
      ok: false,
      error: { code: "TURN_NO_DELTA" },
    });
  });

  it("binds a Computer result to owner, task, turn, generation and call", () => {
    const waiting = requestComputer(runningTurn(), "call-a");
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;

    expect(
      resolveComputer(waiting.value, {
        ...identity,
        ownerId: "foreign",
        callId: "call-a",
      }),
    ).toMatchObject({ ok: false, error: { code: "TURN_CORRELATION" } });
    expect(
      resolveComputer(waiting.value, {
        ...identity,
        generation: 6,
        callId: "call-a",
      }),
    ).toMatchObject({ ok: false, error: { code: "TURN_CORRELATION" } });
    expect(
      resolveComputer(waiting.value, { ...identity, callId: "call-a" }),
    ).toMatchObject({
      ok: true,
      value: { phase: "running", outstandingCallId: null },
    });
  });

  it("accepts only strictly increasing delta sequences", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (sequence) => {
        const first = appendDelta(runningTurn(), sequence);
        if (!first.ok) return false;
        return (
          !appendDelta(first.value, sequence).ok &&
          !appendDelta(first.value, sequence - 1).ok &&
          appendDelta(first.value, sequence + 1).ok
        );
      }),
    );
  });
});
