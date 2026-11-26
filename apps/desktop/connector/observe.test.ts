import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { observedConnectorChild } from "./observe";
import {
  TUNNEL_EXITED,
  TUNNEL_TERMINAL,
  TUNNEL_UNKNOWN,
  type ConnectorChildLifecycleObservation,
} from "./receipt";

// The child wrapper over an event emitter that stands in for the spawned
// anchor. No process starts; the group probe is a spy on process.kill.

function fake(pid = 5001) {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
  return { child, events, process: child as unknown as ChildProcess };
}

function collect(
  observed: ReturnType<typeof observedConnectorChild>,
): ConnectorChildLifecycleObservation[] {
  const seen: ConnectorChildLifecycleObservation[] = [];
  observed.observeLifecycle?.((observation) => seen.push(observation));
  return seen;
}

const terminal = {
  kind: TUNNEL_TERMINAL,
  source: "connector-tunnel",
  event: "exit",
  exitCode: 7,
  signal: null,
};

describe("observedConnectorChild tunnel observation", () => {
  it("reports no tunnel state while nothing was observed", () => {
    const { process: child } = fake();
    expect(observedConnectorChild(child, false, true).tunnelObservation).toBe(
      null,
    );
  });

  it("keeps a terminal receipt with its exit code and freezes it", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen = collect(observed);
    events.emit("message", terminal);
    expect(observed.tunnelObservation).toEqual({
      state: "exited",
      terminal: expect.objectContaining({
        source: "connector-tunnel",
        event: "exit",
        state: "observed",
        exitCode: 7,
      }),
    });
    expect(Object.isFrozen(observed.tunnelObservation)).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("treats the legacy exit token as an exit with no detail", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen = collect(observed);
    events.emit("message", TUNNEL_EXITED);
    expect(observed.tunnelObservation).toEqual({ state: "exited" });
    expect(seen[0]).toMatchObject({
      state: "outcome_unknown",
      exitCode: null,
      signal: null,
    });
  });

  it("treats the unknown token as an unknown outcome", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    events.emit("message", TUNNEL_UNKNOWN);
    expect(observed.tunnelObservation).toEqual({ state: "outcome_unknown" });
  });

  it("refuses a malformed receipt as an unknown outcome and keeps no payload", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen = collect(observed);
    events.emit("message", { ...terminal, secret: "token" });
    expect(observed.tunnelObservation).toEqual({ state: "outcome_unknown" });
    expect(seen).toEqual([
      expect.objectContaining({
        event: "invalid-receipt",
        code: "CONNECTOR_TUNNEL_RECEIPT_INVALID",
      }),
    ]);
    expect(JSON.stringify(seen)).not.toContain("token");
  });

  it("keeps the first observation and ignores a later message", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    events.emit("message", TUNNEL_UNKNOWN);
    events.emit("message", terminal);
    expect(observed.tunnelObservation).toEqual({ state: "outcome_unknown" });
  });

  it("does not listen to messages unless asked to observe the tunnel", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child);
    events.emit("message", terminal);
    expect(observed.tunnelObservation).toBe(null);
  });

  it("records an anchor exit and close without claiming the tunnel exited", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen = collect(observed);
    events.emit("exit", 1, null);
    events.emit("close", 1, null);
    expect(observed.tunnelObservation).toEqual({ state: "outcome_unknown" });
    expect(seen.map((item) => item.code)).toEqual([
      "CONNECTOR_ANCHOR_EXIT",
      "CONNECTOR_ANCHOR_CLOSE",
    ]);
  });

  it("records a lost IPC channel as unknown", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen = collect(observed);
    events.emit("disconnect");
    expect(observed.tunnelObservation).toEqual({ state: "outcome_unknown" });
    expect(seen[0]).toMatchObject({ code: "CONNECTOR_IPC_DISCONNECTED" });
  });

  it("records an error as unknown and never as an exit", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen = collect(observed);
    events.emit("error", new Error("failed"));
    expect(seen[0]).toMatchObject({
      code: "CONNECTOR_ANCHOR_ERROR",
      state: "outcome_unknown",
    });
    expect(observed.exitCode).toBeNull();
  });
});

describe("observedConnectorChild lifecycle observers", () => {
  it("retains each source and event once and replays it to a late observer", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    events.emit("error", new Error("one"));
    events.emit("error", new Error("two"));
    const late = collect(observed);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ code: "CONNECTOR_ANCHOR_ERROR" });
  });

  it("stops notifying an observer that unsubscribed", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen: unknown[] = [];
    const off = observed.observeLifecycle!((item) => seen.push(item));
    off();
    events.emit("disconnect");
    expect(seen).toEqual([]);
  });

  it("admits at most four observers", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen = Array.from({ length: 5 }, () => collect(observed));
    events.emit("disconnect");
    expect(seen.map((items) => items.length)).toEqual([1, 1, 1, 1, 0]);
  });

  it("survives an observer that throws or rejects", async () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    observed.observeLifecycle!(() => {
      throw new Error("diagnostic failed");
    });
    observed.observeLifecycle!(async () => {
      throw new Error("diagnostic rejected");
    });
    const seen = collect(observed);
    expect(() => events.emit("disconnect")).not.toThrow();
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it("marks only an escalated kill as forced", () => {
    const { process: child, events } = fake();
    const observed = observedConnectorChild(child, false, true);
    const seen = collect(observed);
    events.emit("disconnect");
    observed.kill("SIGTERM");
    events.emit("error", new Error("late"));
    observed.kill("SIGKILL");
    events.emit("exit", null, "SIGKILL");
    expect(seen.map((item) => item.forced)).toEqual([false, false, true]);
  });
});

describe("observedConnectorChild process control", () => {
  it("delegates a direct kill when it owns no group", () => {
    const { process: child, child: raw } = fake();
    const observed = observedConnectorChild(child);
    expect(observed.kill("SIGTERM")).toBe(true);
    expect(raw.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports the direct exit code and a signal as -1", () => {
    const { process: child, child: raw } = fake();
    const observed = observedConnectorChild(child);
    expect(observed.exitCode).toBeNull();
    raw.exitCode = 2;
    expect(observed.exitCode).toBe(2);
    raw.exitCode = null;
    raw.signalCode = "SIGTERM";
    expect(observed.exitCode).toBe(-1);
  });

  it("resolves a direct wait on exit and on error", async () => {
    const exited = fake();
    const waiting = observedConnectorChild(exited.process).waitForExit(1_000);
    exited.events.emit("exit");
    expect(await waiting).toBe(true);
    const failed = fake();
    const failing = observedConnectorChild(failed.process).waitForExit(1_000);
    failed.events.emit("error", new Error("failed"));
    expect(await failing).toBe(false);
  });

  it("times out a direct wait", async () => {
    vi.useFakeTimers();
    try {
      const { process: child } = fake();
      const waiting = observedConnectorChild(child).waitForExit(100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await waiting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signals the owned group, not the leader, and confirms absence before an exit", async () => {
    const { process: child, child: raw } = fake(6001);
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const observed = observedConnectorChild(child, true);
      expect(observed.kill("SIGTERM")).toBe(true);
      expect(signal).toHaveBeenCalledWith(-6001, "SIGTERM");
      expect(raw.kill).not.toHaveBeenCalled();
      raw.exitCode = 0;
      expect(observed.exitCode).toBeNull();
      signal.mockImplementation(() => {
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      });
      expect(observed.exitCode).toBe(0);
      expect(await observed.waitForExit(0)).toBe(true);
    } finally {
      signal.mockRestore();
    }
  });
});
