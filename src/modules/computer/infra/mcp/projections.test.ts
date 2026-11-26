import { describe, expect, it } from "vitest";
import {
  isRefusedOrUnknown,
  publicDispatch,
  publicResult,
  publicSteer,
  publicStatus,
  safeChatCreate,
  unknownOutcome,
} from "./projections";

const any = (value: object) => value as never;
const runtime = any({ a: 1 });

describe("task projections", () => {
  it("builds an unknown outcome with a stable key order", () => {
    expect(JSON.stringify(unknownOutcome("d"))).toBe(
      '{"status":"outcome_unknown","dispatchId":"d"}',
    );
  });

  it("classes refused and unknown as errors", () => {
    expect(isRefusedOrUnknown("refused")).toBe(true);
    expect(isRefusedOrUnknown("outcome_unknown")).toBe(true);
    expect(isRefusedOrUnknown("dispatched")).toBe(false);
  });

  it("drops everything but status and handle from a dispatch", () => {
    expect(
      publicDispatch(any({ status: "dispatched", dispatchId: "d", x: 1 })),
    ).toEqual({ status: "dispatched", dispatchId: "d" });
    const refused = any({ status: "refused", code: "C" });
    expect(publicDispatch(refused)).toBe(refused);
  });

  it("drops everything but status and handle from a steer", () => {
    expect(
      publicSteer(any({ status: "steered", dispatchId: "d", x: 1 })),
    ).toEqual({ status: "steered", dispatchId: "d" });
    const refused = any({ status: "refused" });
    expect(publicSteer(refused)).toBe(refused);
  });

  it("shows a known status with the runtime and nothing else", () => {
    expect(
      publicStatus(
        any({ status: "known", turnStatus: "t", x: 1 }),
        "d",
        runtime,
      ),
    ).toEqual({
      status: "known",
      dispatchId: "d",
      turnStatus: "t",
      threadRuntime: runtime,
    });
    const unknown = any({ status: "unknown" });
    expect(publicStatus(unknown, "d", null as never)).toBe(unknown);
  });

  it("projects each result status", () => {
    expect(
      publicResult(any({ status: "completed", text: "T", x: 1 }), "d", runtime),
    ).toEqual({ status: "completed", dispatchId: "d", text: "T" });
    expect(
      publicResult(any({ status: "running", x: 1 }), "d", runtime),
    ).toEqual({ status: "running", dispatchId: "d", threadRuntime: runtime });
    for (const status of ["failed", "interrupted"])
      expect(publicResult(any({ status, x: 1 }), "d", runtime)).toEqual({
        status,
        dispatchId: "d",
      });
    const unknown = any({ status: "outcome_unknown" });
    expect(publicResult(unknown, "d", runtime)).toBe(unknown);
  });

  it("answers a chat create only for its own key", () => {
    const same = any({ status: "verified", dispatchId: "k" });
    expect(safeChatCreate(same, "k")).toBe(same);
    expect(safeChatCreate(same, "j")).toEqual(unknownOutcome("j"));
    expect(safeChatCreate(any({ status: "unknown" }), "k")).toEqual(
      unknownOutcome("k"),
    );
  });
});
