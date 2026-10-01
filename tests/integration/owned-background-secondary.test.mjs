import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForOwnedSecondary } from "../e2e/owned-background-secondary.mjs";

function ownedChild() {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 2468,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdout: { destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
    unref: vi.fn(),
    kill: vi.fn(),
  });
  return child;
}
function closed(child, exit = 0, signal = null) {
  child.exitCode = exit;
  child.signalCode = signal;
  child.emit("close", exit, signal);
}
afterEach(() => vi.useRealTimers());

describe("owned background secondary terminal supervision", () => {
  it("observes an ordinary terminal event without requesting a stop", async () => {
    const child = ownedChild();
    const waiting = waitForOwnedSecondary(child);
    closed(child);
    expect(await waiting).toMatchObject({
      terminal: true,
      exit: 0,
      signal: null,
      timedOut: false,
      stopRequested: false,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("requests one SIGTERM on timeout and observes that same child's terminal event", async () => {
    vi.useFakeTimers();
    const child = ownedChild();
    child.kill.mockImplementation(() => {
      setTimeout(() => closed(child, null, "SIGTERM"), 2);
      return true;
    });
    const waiting = waitForOwnedSecondary(child, {
      timeoutMs: 10,
      cleanupTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toMatchObject({
      terminal: true,
      timedOut: true,
      stopRequested: true,
      exit: null,
      signal: "SIGTERM",
    });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  it("does not signal a child that has already exited while waiting for close", async () => {
    vi.useFakeTimers();
    const child = ownedChild();
    const waiting = waitForOwnedSecondary(child, {
      timeoutMs: 10,
      cleanupTimeoutMs: 10,
    });
    setTimeout(() => {
      child.exitCode = 0;
    }, 5);
    setTimeout(() => closed(child), 15);
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toMatchObject({
      terminal: true,
      timedOut: true,
      exit: 0,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["throw", "false", "no-exit"])(
    "retains unknown cleanup after %s without another stop or replacement",
    async (fault) => {
      vi.useFakeTimers();
      const child = ownedChild();
      child.kill.mockImplementation(() => {
        if (fault === "throw")
          throw Object.assign(new Error("private diagnostic"), {
            code: "EPERM",
          });
        return fault !== "false";
      });
      const waiting = waitForOwnedSecondary(child, {
        timeoutMs: 10,
        cleanupTimeoutMs: 10,
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await waiting;
      expect(result).toMatchObject({
        terminal: false,
        timedOut: true,
        stopRequested: true,
      });
      expect(result.stopError).toBe(
        fault === "throw"
          ? "EPERM"
          : fault === "false"
            ? "STOP_NOT_DELIVERED"
            : null,
      );
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
      expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
      expect(child.unref).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("private diagnostic");
    },
  );

  it("never repeats a previously requested stop", async () => {
    vi.useFakeTimers();
    const child = ownedChild();
    child.killed = true;
    const waiting = waitForOwnedSecondary(child, {
      timeoutMs: 10,
      cleanupTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toMatchObject({
      terminal: false,
      stopRequested: false,
      stopError: "STOP_ALREADY_REQUESTED",
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("observes actual terminal cleanup of its own disposable Node child after timeout", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.resume();
    child.stderr.resume();
    const result = await waitForOwnedSecondary(child, {
      timeoutMs: 250,
      cleanupTimeoutMs: 3000,
    });
    expect(result).toMatchObject({
      terminal: true,
      timedOut: true,
      stopRequested: true,
      exit: null,
      signal: "SIGTERM",
    });
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("observes spawn failure and close without signalling an unassigned PID", async () => {
    const child = ownedChild();
    child.pid = undefined;
    const waiting = waitForOwnedSecondary(child);
    child.emit(
      "error",
      Object.assign(new Error("fixture path"), { code: "ENOENT" }),
    );
    closed(child, -2);
    expect(await waiting).toMatchObject({
      terminal: true,
      exit: -2,
      timedOut: false,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
