import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { observeOwnedLineChild } from "../fixtures/owned-line-child.mjs";

function fixture(options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return { child, observation: observeOwnedLineChild(child, options) };
}

describe("original line-child observation", () => {
  it("retains an actual early close before fixture work awaits it", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const observed = observeOwnedLineChild(child);
    const originalClose = observed.closed;
    await expect(originalClose).resolves.toEqual({
      code: 7,
      signal: null,
      spawnErrorCode: null,
    });
    await expect(observed.waitForLine("ACQUIRED")).rejects.toMatchObject({
      message: "FIXTURE_CHILD_CLOSED_BEFORE_LINE",
      cause: { code: 7, signal: null },
    });
    expect(observed.closed).toBe(originalClose);
    await expect(observed.closed).resolves.toMatchObject({ code: 7 });
  });

  it("rejects a pending line on the original terminal without a second wait", async () => {
    const { child, observation } = fixture();
    const line = observation.waitForLine("ACQUIRED");
    child.emit("close", 1, null);
    await expect(line).rejects.toThrow("FIXTURE_CHILD_CLOSED_BEFORE_LINE");
    await expect(observation.closed).resolves.toMatchObject({ code: 1 });
  });

  it("retains a line already read before unrelated asynchronous fixture work", async () => {
    const { child, observation } = fixture();
    child.stdout.write("ACQ");
    child.stdout.write("UIRED\n");
    await expect(observation.waitForLine("ACQUIRED")).resolves.toBeUndefined();
    child.emit("close", 0, null);
    await observation.closed;
  });

  it("settles concurrent line observers and removes their deadlines", async () => {
    vi.useFakeTimers();
    try {
      const { child, observation } = fixture();
      const first = observation.waitForLine("ACQUIRED");
      const second = observation.waitForLine("ACQUIRED");
      child.stdout.write("ACQUIRED\n");
      await Promise.all([first, second]);
      child.emit("close", 0, null);
      await observation.closed;
      expect(vi.getTimerCount()).toBe(0);
      expect(child.stdout.listenerCount("data")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error is not original close proof", async () => {
    const { child, observation } = fixture();
    const line = observation.waitForLine("ACQUIRED");
    let closed = false;
    void observation.closed.then(() => (closed = true));
    child.emit(
      "error",
      Object.assign(new Error("private path"), { code: "ENOENT" }),
    );
    await expect(line).rejects.toMatchObject({
      message: "FIXTURE_CHILD_START_FAILED",
      cause: { code: "ENOENT" },
    });
    expect(closed).toBe(false);
    child.emit("close", -2, null);
    await expect(observation.closed).resolves.toMatchObject({
      code: -2,
      spawnErrorCode: "ENOENT",
    });
  });

  it("bounds a line wait without inventing terminal closure", async () => {
    vi.useFakeTimers();
    try {
      const { child, observation } = fixture({
        lineTimeoutMs: 20,
        closeTimeoutMs: 100,
      });
      const line = observation.waitForLine("ACQUIRED");
      const refused = expect(line).rejects.toThrow(
        "FIXTURE_CHILD_LINE_TIMEOUT",
      );
      await vi.advanceTimersByTimeAsync(20);
      await refused;
      child.emit("close", 0, null);
      await observation.closed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a bounded unknown close even after a late terminal", async () => {
    vi.useFakeTimers();
    try {
      const { child, observation } = fixture({ closeTimeoutMs: 20 });
      const refused = expect(observation.closed).rejects.toThrow(
        "FIXTURE_CHILD_CLOSE_UNCONFIRMED",
      );
      await vi.advanceTimersByTimeAsync(20);
      await refused;
      child.emit("close", 0, null);
      await expect(observation.closed).rejects.toThrow(
        "FIXTURE_CHILD_CLOSE_UNCONFIRMED",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds output while still awaiting the original close", async () => {
    const { child, observation } = fixture({ outputLimit: 4 });
    const line = observation.waitForLine("ACQUIRED");
    child.stdout.write("oversized");
    await expect(line).rejects.toThrow("FIXTURE_CHILD_OUTPUT_LIMIT");
    child.emit("close", 1, null);
    await observation.closed;
  });

  it("drains diagnostics without admitting a stdout marker from stderr", async () => {
    const { child, observation } = fixture();
    const line = observation.waitForLine("ACQUIRED");
    child.stderr.write("ACQUIRED\n");
    child.emit("close", 1, null);
    await expect(line).rejects.toThrow("FIXTURE_CHILD_CLOSED_BEFORE_LINE");
    await observation.closed;
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  it("a prior output refusal does not hide an unconfirmed terminal", async () => {
    vi.useFakeTimers();
    try {
      const { child, observation } = fixture({
        outputLimit: 4,
        closeTimeoutMs: 20,
      });
      const line = observation.waitForLine("ACQUIRED");
      child.stderr.write("too much");
      await expect(line).rejects.toThrow("FIXTURE_CHILD_OUTPUT_LIMIT");
      const refused = expect(observation.closed).rejects.toMatchObject({
        message: "FIXTURE_CHILD_CLOSE_UNCONFIRMED",
        cause: { message: "FIXTURE_CHILD_OUTPUT_LIMIT" },
      });
      await vi.advanceTimersByTimeAsync(20);
      await refused;
      child.emit("close", 0, null);
    } finally {
      vi.useRealTimers();
    }
  });
});
