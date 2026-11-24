import { describe, expect, it, vi } from "vitest";
import { createCell } from "../host/cell";
import {
  createConnectorStop,
  type ConnectorStopPorts,
  type StopLifecycle,
} from "./stop";

// The stop over a fixture that stands in for main-process state. Every owner
// is read through a getter the test can change after the factory is built, so a
// test proves a default is taken at the call, not at construction. No process,
// tunnel, provider or timer runs.

type Calls = string[];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}

function fixture(calls: Calls = []) {
  const lifecycle = {
    beginStop: vi.fn(async () => {
      calls.push("begin");
    }),
    waitForStop: vi.fn(async () => {
      calls.push("wait");
    }),
    confirmStop: vi.fn(async () => {
      calls.push("confirm");
    }),
  };
  const makeConnector = (running = true) => ({
    isRunning: vi.fn(() => running),
    stop: vi.fn(async () => {
      calls.push("stop-connector");
    }),
    observeStopAttempt: vi.fn(<T>(work: () => Promise<T>) => {
      calls.push("observe");
      return work();
    }),
  });
  const makeCore = (independentSession = false) => ({
    independentSession,
    observeOriginalStop: vi.fn(async () => ({ restricted: false })),
    closeComputerConnector: vi.fn(
      async (_reason?: string, _parent?: string) => {
        calls.push("close-core");
      },
    ),
  });
  const makeSaved = (name = "chat") => ({
    name,
    close: vi.fn(async () => {
      calls.push(`close-saved:${name}`);
    }),
  });
  const state = {
    connector: makeConnector() as ReturnType<typeof makeConnector> | null,
    core: makeCore() as ReturnType<typeof makeCore> | null,
  };
  const saved = createCell<ReturnType<typeof makeSaved> | null>(makeSaved());
  const record = vi.fn();
  const store = { record };
  const launchPaths: string[] = [];
  const paths = { secureMcpLaunch: "/launch/a" };
  const created: unknown[] = [];
  const ports = {
    secureMcpConnectorRuntime: () => state.connector,
    desktopGoCore: () => state.core,
    saved,
    operationsStore: () => store,
    statePaths: () => paths,
    createLifecycle: (launch: string) => {
      launchPaths.push(launch);
      created.push(lifecycle);
      return lifecycle;
    },
  };
  const stop = createConnectorStop(
    ports as unknown as ConnectorStopPorts<StopLifecycle>,
  );
  return {
    stop,
    state,
    saved,
    lifecycle,
    calls,
    record,
    paths,
    launchPaths,
    created,
    makeConnector,
    makeCore,
    makeSaved,
  };
}

describe("connector stop", () => {
  it("reads every default at the call, not when the stop is built", async () => {
    const f = fixture();
    const connector = f.state.connector!;
    const core = f.state.core!;
    const first = f.saved.get()!;
    // Replace each owner after the factory was built; the call must see these.
    const lateConnector = f.makeConnector();
    const lateCore = f.makeCore();
    const lateSaved = f.makeSaved("late");
    f.state.connector = lateConnector;
    f.state.core = lateCore;
    f.saved.set(lateSaved);
    await f.stop.stopAndConfirmComputerMcp();
    expect(lateConnector.stop).toHaveBeenCalledOnce();
    expect(lateCore.closeComputerConnector).toHaveBeenCalledOnce();
    expect(lateSaved.close).toHaveBeenCalledOnce();
    expect(connector.stop).not.toHaveBeenCalled();
    expect(core.closeComputerConnector).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
  });

  it("defaults the in-flight start to none and never to a live owner", async () => {
    const f = fixture();
    await f.stop.stopAndConfirmComputerMcp();
    // With no start in flight the connector is stopped straight away.
    expect(f.calls).toEqual([
      "observe",
      "begin",
      "wait",
      "stop-connector",
      "close-saved:chat",
      "close-core",
      "confirm",
    ]);
  });

  it("stops and confirms in order, then clears the saved chat it closed", async () => {
    const f = fixture();
    await f.stop.stopAndConfirmComputerMcp(
      undefined,
      undefined,
      undefined,
      undefined,
      "owner_stop",
    );
    expect(f.calls).toEqual([
      "observe",
      "begin",
      "wait",
      "stop-connector",
      "close-saved:chat",
      "close-core",
      "confirm",
    ]);
    expect(f.saved.get()).toBeNull();
    expect(f.state.core!.closeComputerConnector).toHaveBeenCalledWith(
      "owner_stop",
      undefined,
    );
    // The stop is one observed Operations entry of its own kind.
    expect(f.record).toHaveBeenCalled();
    expect(JSON.stringify(f.record.mock.calls)).toContain("connection.stop");
  });

  it("does not confirm when the connector stop fails, and rethrows it", async () => {
    const f = fixture();
    const connector = f.makeConnector();
    connector.stop.mockRejectedValueOnce(new Error("connector stop failed"));
    await expect(
      f.stop.stopAndConfirmComputerMcp(connector as never),
    ).rejects.toThrow("connector stop failed");
    expect(f.lifecycle.confirmStop).not.toHaveBeenCalled();
  });

  it("does not confirm when the lifecycle wait fails and still closes the owners", async () => {
    const f = fixture();
    f.lifecycle.waitForStop.mockRejectedValueOnce(
      new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED"),
    );
    await expect(f.stop.stopAndConfirmComputerMcp()).rejects.toMatchObject({
      code: "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
      state: "outcome_unknown",
    });
    expect(f.lifecycle.confirmStop).not.toHaveBeenCalled();
    // The connector is still stopped and the Go owner still closed.
    expect(f.calls).toEqual([
      "observe",
      "begin",
      "stop-connector",
      "close-saved:chat",
      "close-core",
    ]);
  });

  it("throws unconfirmed without a connector and touches nothing", async () => {
    const f = fixture();
    f.state.connector = null;
    await expect(f.stop.stopAndConfirmComputerMcp()).rejects.toThrow(
      "CONNECTOR_STOP_UNCONFIRMED",
    );
    expect(f.calls).toEqual([]);
    expect(f.created).toEqual([]);
  });

  it("refuses an ordinary Stop while an original Stop is restricted", async () => {
    const f = fixture();
    f.state.core!.observeOriginalStop.mockResolvedValueOnce({
      restricted: true,
    });
    await expect(f.stop.stopAndConfirmComputerMcp()).rejects.toThrow(
      "CONNECTOR_STOP_UNCONFIRMED",
    );
    expect(f.calls).toEqual([]);
  });

  it("lets the admitted original parent skip the custody observation", async () => {
    const f = fixture();
    await f.stop.stopAndConfirmComputerMcp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "parent-1",
    );
    expect(f.state.core!.observeOriginalStop).not.toHaveBeenCalled();
    expect(f.state.core!.closeComputerConnector).toHaveBeenCalledWith(
      undefined,
      "parent-1",
    );
  });

  it("closes only the native ports of an independent session that never owned the tunnel", async () => {
    const f = fixture();
    f.state.core = f.makeCore(true);
    f.state.connector = f.makeConnector(false);
    await f.stop.stopAndConfirmComputerMcp(
      undefined,
      undefined,
      undefined,
      undefined,
      "owner_stop",
    );
    expect(f.calls).toEqual(["close-saved:chat", "close-core"]);
    // Neither the lifecycle nor an observed Operations entry is involved, and
    // the saved chat is closed without being cleared, as before.
    expect(f.created).toEqual([]);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.saved.get()).not.toBeNull();
  });

  it("refuses an independent session's original parent without closing anything", async () => {
    const f = fixture();
    f.state.core = f.makeCore(true);
    f.state.connector = f.makeConnector(false);
    await expect(
      f.stop.stopAndConfirmComputerMcp(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "parent-1",
      ),
    ).rejects.toThrow("CONNECTOR_STOP_UNCONFIRMED");
    expect(f.calls).toEqual([]);
  });

  it("runs the full drain when a start is in flight, even for an independent session", async () => {
    const f = fixture();
    f.state.core = f.makeCore(true);
    f.state.connector = f.makeConnector(false);
    await f.stop.stopAndConfirmComputerMcp(undefined, Promise.resolve());
    expect(f.calls).toContain("begin");
    expect(f.calls.at(-1)).toBe("confirm");
  });

  it("waits for the in-flight start before it stops the connector", async () => {
    const f = fixture();
    const start = deferred();
    const done = f.stop.stopAndConfirmComputerMcp(undefined, start.promise);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls).toEqual(["observe", "begin"]);
    start.resolve();
    await done;
    expect(f.calls.indexOf("stop-connector")).toBeGreaterThan(
      f.calls.indexOf("begin"),
    );
  });

  it("keeps an absent saved chat absent instead of reading the live one", async () => {
    const f = fixture();
    const live = f.saved.get()!;
    await f.stop.stopAndConfirmComputerMcp(
      undefined,
      undefined,
      undefined,
      null,
    );
    expect(live.close).not.toHaveBeenCalled();
    expect(f.saved.get()).toBe(live);
  });

  it("clears the saved chat only when it is still the one it closed", async () => {
    const f = fixture();
    const original = f.saved.get()!;
    const replacement = f.makeSaved("replacement");
    // A new bridge is published while the original is being closed.
    original.close.mockImplementationOnce(async () => {
      f.calls.push("close-saved:chat");
      f.saved.set(replacement);
    });
    await f.stop.stopAndConfirmComputerMcp();
    expect(f.saved.get()).toBe(replacement);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("clears the saved chat when it was not replaced in between", async () => {
    const f = fixture();
    await f.stop.stopAndConfirmComputerMcp();
    expect(f.saved.get()).toBeNull();
  });

  it("closes the Go owner even when closing the saved chat fails", async () => {
    const f = fixture();
    f.saved.get()!.close.mockRejectedValueOnce(new Error("chat close failed"));
    await expect(f.stop.stopAndConfirmComputerMcp()).rejects.toThrow(
      "chat close failed",
    );
    expect(f.state.core!.closeComputerConnector).toHaveBeenCalledOnce();
    expect(f.lifecycle.confirmStop).not.toHaveBeenCalled();
    // A failed close leaves the saved chat where it was.
    expect(f.saved.get()).not.toBeNull();
  });

  it("names the stop unconfirmed and skips the Go owner once the quit deadline passed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const f = fixture();
      const deadline = 2_000;
      f.saved.get()!.close.mockImplementationOnce(async () => {
        vi.setSystemTime(2_500);
      });
      await expect(
        f.stop.stopAndConfirmComputerMcp(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          deadline,
        ),
      ).rejects.toThrow("CONNECTOR_STOP_UNCONFIRMED");
      expect(f.state.core!.closeComputerConnector).not.toHaveBeenCalled();
      expect(f.lifecycle.confirmStop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("works without a Go core, closing only the saved chat and the connector", async () => {
    const f = fixture();
    f.state.core = null;
    await f.stop.stopAndConfirmComputerMcp();
    expect(f.calls).toEqual([
      "observe",
      "begin",
      "wait",
      "stop-connector",
      "close-saved:chat",
      "confirm",
    ]);
  });

  describe("lifecycle accessor", () => {
    it("builds one lifecycle, from the launch root read at first use", () => {
      const f = fixture();
      expect(f.launchPaths).toEqual([]);
      const first = f.stop.computerMcpLifecycle();
      f.paths.secureMcpLaunch = "/launch/b";
      const second = f.stop.computerMcpLifecycle();
      expect(second).toBe(first);
      expect(f.launchPaths).toEqual(["/launch/a"]);
    });

    it("shares that one lifecycle with the stop path", async () => {
      const f = fixture();
      const lifecycle = f.stop.computerMcpLifecycle();
      await f.stop.stopAndConfirmComputerMcp();
      expect(lifecycle).toBe(f.lifecycle);
      expect(f.launchPaths).toEqual(["/launch/a"]);
      expect(f.lifecycle.confirmStop).toHaveBeenCalledOnce();
    });
  });
});
