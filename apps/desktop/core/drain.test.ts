import { describe, expect, it } from "vitest";
import { BridgeError } from "../bridge/client.ts";
import {
  confirmFreshDrained,
  confirmFreshTerminal,
  interruptedCommandOf,
} from "./drain";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof BridgeError ? error.code : "other";
  }
  return undefined;
}

describe("fresh drain checks", () => {
  it("reads the interrupted flag and refuses a bad status", () => {
    expect(
      interruptedCommandOf({
        status: "ok",
        data: { interruptedCommand: true },
      }),
    ).toBe(true);
    expect(codeOf(() => interruptedCommandOf({ status: "error" }))).toBe(
      "invalid_fresh_status",
    );
  });
  it("refuses an unconfirmed drain", () => {
    expect(codeOf(() => confirmFreshDrained({ status: "error" }))).toBe(
      "fresh_session_drain_unconfirmed",
    );
    expect(
      codeOf(() =>
        confirmFreshDrained({ status: "ok", data: { drained: false } }),
      ),
    ).toBe("fresh_session_drain_unconfirmed");
    expect(
      codeOf(() =>
        confirmFreshDrained({ status: "ok", data: { drained: true } }),
      ),
    ).toBeUndefined();
  });
  it("accepts only a clean unforced terminal", () => {
    expect(
      codeOf(() =>
        confirmFreshTerminal({ exitCode: 0, signal: null, forced: false }),
      ),
    ).toBeUndefined();
    for (const bad of [
      { exitCode: 1, signal: null, forced: false },
      { exitCode: 0, signal: "SIGTERM", forced: false },
      { exitCode: 0, signal: null, forced: true },
    ])
      expect(codeOf(() => confirmFreshTerminal(bad))).toBe(
        "fresh_session_terminal_unconfirmed",
      );
  });
});
