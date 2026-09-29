import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createGracefulQuitSignals } from "../../src/apps/desktop/quit-signal";
import { createQuitDrain } from "../../src/apps/desktop/quit-drain";

describe("desktop graceful signals", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "leaves startup %s handling native until the drain is installed, then quits once",
    async (signal) => {
      const signals = new EventEmitter();
      let quitting = false;
      let releaseChild!: () => void;
      const childExit = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      const events: string[] = [];
      const drain = createQuitDrain({
        deadlineMs: 1_000,
        collect: () => [
          {
            name: "owned-child",
            close: async () => {
              await childExit;
              events.push("child-exited");
            },
          },
        ],
        record: async (receipt) => {
          events.push(receipt.drained ? "drained" : "unconfirmed");
        },
        quit: () => {
          events.push("final-quit");
        },
      });
      const requestQuit = vi.fn(() => {
        events.push("requested-quit");
        quitting = true;
        drain.onBeforeQuit({ preventDefault: () => undefined });
      });
      const bridge = createGracefulQuitSignals({
        signals,
        requestQuit,
        isQuitting: () => quitting,
      });

      // Startup may never finish. No listener may suppress native signal
      // termination while there is no drain to receive the request.
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(requestQuit).not.toHaveBeenCalled();
      bridge.ready();
      signals.emit(signal);
      expect(requestQuit).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["requested-quit"]);
      signals.emit(signal);
      expect(requestQuit).toHaveBeenCalledTimes(1);
      releaseChild();
      await vi.waitFor(() => expect(drain.state()).toBe("done"));
      expect(events).toEqual([
        "requested-quit",
        "child-exited",
        "drained",
        "final-quit",
      ]);
      bridge.dispose();
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("does not install listeners if startup was disposed before becoming ready", () => {
    const signals = new EventEmitter();
    const requestQuit = vi.fn();
    const bridge = createGracefulQuitSignals({
      signals,
      requestQuit,
      isQuitting: () => false,
    });
    bridge.dispose();
    bridge.ready();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(requestQuit).not.toHaveBeenCalled();
  });

  it("ignores signals after a normal quit has begun", () => {
    const signals = new EventEmitter();
    const requestQuit = vi.fn();
    const bridge = createGracefulQuitSignals({
      signals,
      requestQuit,
      isQuitting: () => true,
    });
    bridge.ready();
    signals.emit("SIGTERM");
    expect(requestQuit).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("requests quit once for signals received after startup", () => {
    const signals = new EventEmitter();
    const requestQuit = vi.fn();
    const bridge = createGracefulQuitSignals({
      signals,
      requestQuit,
      isQuitting: () => false,
    });
    bridge.ready();
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(requestQuit).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it("keeps a failed child unconfirmed and still reaches final quit", async () => {
    const signals = new EventEmitter();
    const events: string[] = [];
    const drain = createQuitDrain({
      deadlineMs: 20,
      collect: () => [
        { name: "owned-child", close: () => Promise.reject(new Error("EIO")) },
      ],
      record: async (receipt) => {
        events.push(receipt.drained ? "drained" : "unconfirmed");
      },
      quit: () => {
        events.push("final-quit");
      },
    });
    const bridge = createGracefulQuitSignals({
      signals,
      requestQuit: () => {
        drain.onBeforeQuit({ preventDefault: () => undefined });
      },
      isQuitting: () => drain.state() !== "idle",
    });
    bridge.ready();
    signals.emit("SIGINT");
    await vi.waitFor(() => expect(drain.state()).toBe("done"));
    expect(events).toEqual(["unconfirmed", "final-quit"]);
    bridge.dispose();
  });
});
