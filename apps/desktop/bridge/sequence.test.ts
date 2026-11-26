import { describe, expect, it } from "vitest";
import { createSequencer } from "./sequence.ts";
import type { EventData } from "./wire.ts";

const context = { profileId: "profile", backendGeneration: "backend" };

function event(
  stream: string,
  sequence: string,
  kind: EventData["kind"] = "changed",
  eventContext = context,
): EventData {
  return { context: eventContext, stream, sequence, kind, data: null };
}

describe("createSequencer", () => {
  it("admits contiguous events as fresh", () => {
    const sequencer = createSequencer();
    expect(sequencer.admit(event("a", "1"), context)).toEqual({
      admitted: true,
      stale: false,
    });
    expect(sequencer.admit(event("a", "2"), context)).toEqual({
      admitted: true,
      stale: false,
    });
  });

  it("marks a stream stale after a skipped sequence and keeps it stale", () => {
    const sequencer = createSequencer();
    sequencer.admit(event("a", "1"), context);
    expect(sequencer.admit(event("a", "3"), context)).toEqual({
      admitted: true,
      stale: true,
    });
    expect(sequencer.admit(event("a", "4"), context)).toEqual({
      admitted: true,
      stale: true,
    });
    expect(sequencer.admit(event("b", "1"), context)).toEqual({
      admitted: true,
      stale: false,
    });
  });

  it("marks a stream stale on an explicit gap event", () => {
    const sequencer = createSequencer();
    expect(sequencer.admit(event("a", "1", "gap"), context)).toEqual({
      admitted: true,
      stale: true,
    });
  });

  it("treats a first event past sequence one as a gap", () => {
    const sequencer = createSequencer();
    expect(sequencer.admit(event("a", "5"), context)).toEqual({
      admitted: true,
      stale: true,
    });
  });

  it("refuses a replay or regression and records nothing", () => {
    const sequencer = createSequencer();
    sequencer.admit(event("a", "2"), context);
    for (const sequence of ["2", "1"])
      expect(sequencer.admit(event("a", sequence), context)).toEqual({
        admitted: false,
        code: "event_sequence_regression",
      });
    expect(sequencer.admit(event("a", "3"), context)).toEqual({
      admitted: true,
      stale: true,
    });
  });

  it("refuses an event before a handshake or from another context", () => {
    const sequencer = createSequencer();
    expect(sequencer.admit(event("a", "1"), undefined)).toEqual({
      admitted: false,
      code: "stale_event_context",
    });
    for (const crossed of [
      { ...context, profileId: "other" },
      { ...context, backendGeneration: "other" },
    ])
      expect(
        sequencer.admit(event("a", "1", "changed", crossed), context),
      ).toEqual({ admitted: false, code: "stale_event_context" });
  });

  it("bounds the number of streams but keeps admitting known ones", () => {
    const sequencer = createSequencer(2);
    sequencer.admit(event("a", "1"), context);
    sequencer.admit(event("b", "1"), context);
    expect(sequencer.admit(event("c", "1"), context)).toEqual({
      admitted: false,
      code: "event_stream_budget",
    });
    expect(sequencer.admit(event("a", "2"), context)).toEqual({
      admitted: true,
      stale: false,
    });
  });

  it("defaults to sixty-four streams", () => {
    const sequencer = createSequencer();
    for (let index = 0; index < 64; index += 1)
      expect(sequencer.admit(event(`s${index}`, "1"), context).admitted).toBe(
        true,
      );
    expect(sequencer.admit(event("overflow", "1"), context)).toEqual({
      admitted: false,
      code: "event_stream_budget",
    });
  });
});
