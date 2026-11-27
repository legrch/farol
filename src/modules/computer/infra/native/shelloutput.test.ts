import { describe, expect, it } from "vitest";

import {
  MAX_OUTPUT_BYTES,
  OUTPUT_WINDOW_BYTES,
  buildOutcome,
  exceedsOutputLimit,
  statusOnly,
  window,
  type OutcomeSource,
} from "./shelloutput";

const record: OutcomeSource = {
  handle: "h",
  state: "running",
  groupCleanup: "pending",
  exitCode: 3,
  exitSignal: "SIGTERM",
  stdout: [Buffer.from("ab"), Buffer.from("cd")],
  stderr: [Buffer.from("e")],
  stdoutBytes: 4,
  stderrBytes: 1,
  outputLimitReached: false,
  cancelRequested: false,
  timedOut: false,
  authorityExpired: false,
  errorCode: null,
};

describe("shell output", () => {
  it("windows from an offset and caps the window", () => {
    expect(window([Buffer.from("abcd")], 1).toString()).toBe("bcd");
    expect(window([Buffer.alloc(OUTPUT_WINDOW_BYTES + 10)], 0).length).toBe(
      OUTPUT_WINDOW_BYTES,
    );
  });

  it("limits total output across both streams", () => {
    expect(exceedsOutputLimit(MAX_OUTPUT_BYTES - 2, 1, 1)).toBe(false);
    expect(exceedsOutputLimit(MAX_OUTPUT_BYTES - 2, 1, 2)).toBe(true);
  });

  it("hides exit status while running", () => {
    const outcome = buildOutcome(record, {
      handle: "h",
      stdoutOffset: 1,
      stderrOffset: 0,
    });
    expect(outcome).toMatchObject({
      exitCode: null,
      exitSignal: null,
      stdout: "bcd",
      stdoutBase64: Buffer.from("bcd").toString("base64"),
      stdoutNextOffset: 4,
      stderrNextOffset: 1,
      detachedCleanup: "unverified",
    });
  });

  it("reports exit status once exited, and statusOnly drops output", () => {
    const outcome = buildOutcome(
      { ...record, state: "exited" },
      { handle: "h", stdoutOffset: 0, stderrOffset: 0 },
    );
    expect(outcome.exitCode).toBe(3);
    expect(outcome.exitSignal).toBe("SIGTERM");
    expect(statusOnly(outcome)).toMatchObject({
      stdout: "",
      stderr: "",
      stdoutBase64: "",
      stderrBase64: "",
      stdoutNextOffset: 0,
      stderrNextOffset: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      exitCode: 3,
    });
  });
});
