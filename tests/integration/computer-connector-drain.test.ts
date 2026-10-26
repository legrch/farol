import { describe, expect, it, vi } from "vitest";
import { observeOperation } from "../../apps/desktop/operations/observe";
import type { OperationsRecorder } from "../../apps/desktop/renderer/operations-contract";
import { drainOwnedChildren } from "../../src/apps/desktop/quit-drain";
import {
  drainComputerConnector,
  type ComputerConnectorDrainPorts,
} from "../../src/apps/desktop/computer-connector-drain";

type DrainOperation = () => Promise<void>;

type FixtureOptions = Partial<
  Record<
    | "beginStop"
    | "waitForMcpStop"
    | "stopConnector"
    | "closeSavedChat"
    | "confirmStop",
    DrainOperation
  >
> & {
  startInFlight?: Promise<void> | null;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const operation = (name: string, action: DrainOperation) =>
    vi.fn(async () => {
      events.push(name);
      await action();
    });

  const ports = {
    beginStop: operation("beginStop", options.beginStop ?? (async () => {})),
    startInFlight: options.startInFlight ?? null,
    waitForMcpStop: operation(
      "waitForMcpStop",
      options.waitForMcpStop ?? (async () => {}),
    ),
    stopConnector: operation(
      "stopConnector",
      options.stopConnector ?? (async () => {}),
    ),
    closeSavedChat: operation(
      "closeSavedChat",
      options.closeSavedChat ?? (async () => {}),
    ),
    confirmStop: operation(
      "confirmStop",
      options.confirmStop ?? (async () => {}),
    ),
  } satisfies ComputerConnectorDrainPorts;

  return { ports, events };
}

describe("Computer connector drain", () => {
  // Controlled ports only: no live connector, process, lease or cleanup proof.
  it("keeps a classified connector failure unconfirmed in the Quit receipt", async () => {
    const f = fixture({
      waitForMcpStop: async () => {
        throw Error("COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED");
      },
    });
    await expect(
      drainOwnedChildren(
        [{ name: "connector", close: () => drainComputerConnector(f.ports) }],
        1000,
      ),
    ).resolves.toEqual({ drained: false, unconfirmed: ["connector"] });
    expect(f.ports.stopConnector).toHaveBeenCalledOnce();
    expect(f.ports.closeSavedChat).toHaveBeenCalledOnce();
    expect(f.ports.confirmStop).not.toHaveBeenCalled();
  });

  it.each([
    "COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED",
    "COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED",
    "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
    "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
    "CONNECTOR_STOP_UNCONFIRMED",
  ])(
    "records the exact local %s without confirming or retrying Stop",
    async (code) => {
      const error = new Error(code, { cause: Error("PRIVATE_CAUSE") });
      const f = fixture({
        waitForMcpStop: async () => {
          throw error;
        },
      });
      const recorder = { record: vi.fn() } satisfies OperationsRecorder;
      const metadata = {
        source: "You",
        kind: "connection.stop",
        target: {},
      } as const;
      await expect(
        observeOperation(recorder, metadata, () =>
          drainComputerConnector(f.ports),
        ),
      ).rejects.toMatchObject({ code, state: "outcome_unknown", cause: error });
      expect(recorder.record).toHaveBeenCalledExactlyOnceWith(
        metadata,
        "unknown",
        code,
        expect.any(Number),
      );
      expect(JSON.stringify(recorder.record.mock.calls)).not.toContain(
        "PRIVATE_CAUSE",
      );
      expect(f.events).toEqual([
        "beginStop",
        "waitForMcpStop",
        "stopConnector",
        "closeSavedChat",
      ]);
      expect(f.ports.confirmStop).not.toHaveBeenCalled();
    },
  );

  it.each([
    "beginStop",
    "stopConnector",
    "closeSavedChat",
    "confirmStop",
  ] as const)(
    "retains an unconfirmed reason from %s without making it a successful Quit",
    async (stage) => {
      const error = Error("CONNECTOR_STOP_UNCONFIRMED");
      const f = fixture({
        [stage]: async () => {
          throw error;
        },
      });
      const recorder = { record: vi.fn() } satisfies OperationsRecorder;
      await expect(
        observeOperation(
          recorder,
          { source: "You", kind: "connection.stop", target: {} },
          () => drainComputerConnector(f.ports),
        ),
      ).rejects.toMatchObject({
        code: "CONNECTOR_STOP_UNCONFIRMED",
        cause: error,
      });
      expect(recorder.record.mock.calls[0]?.slice(1, 3)).toEqual([
        "unknown",
        "CONNECTOR_STOP_UNCONFIRMED",
      ]);
      expect(f.ports[stage]).toHaveBeenCalledOnce();
      expect(f.ports.closeSavedChat).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "PRIVATE_ERROR /Users/private/file",
    "CONNECTOR_STOP_UNCONFIRMED extra",
    "PHYSICAL_TERMINAL_CONFIRMED",
  ])(
    "keeps an opaque error unchanged and out of Operations: %s",
    async (message) => {
      const error = Error(message);
      const f = fixture({
        waitForMcpStop: async () => {
          throw error;
        },
      });
      const recorder = { record: vi.fn() } satisfies OperationsRecorder;
      await expect(
        observeOperation(
          recorder,
          { source: "You", kind: "connection.stop", target: {} },
          () => drainComputerConnector(f.ports),
        ),
      ).rejects.toBe(error);
      expect(recorder.record.mock.calls[0]?.slice(1, 3)).toEqual([
        "unknown",
        "OPERATION_OUTCOME_UNKNOWN",
      ]);
      expect(JSON.stringify(recorder.record.mock.calls)).not.toContain(message);
      expect(f.ports.confirmStop).not.toHaveBeenCalled();
    },
  );

  it("does not invoke an exception message getter", async () => {
    const error = Error();
    const message = vi.fn(() => "COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED");
    Object.defineProperty(error, "message", { get: message });
    const f = fixture({
      waitForMcpStop: async () => {
        throw error;
      },
    });
    let caught: unknown;
    try {
      await drainComputerConnector(f.ports);
    } catch (failure) {
      caught = failure;
    }
    expect(caught === error).toBe(true);
    expect(message).not.toHaveBeenCalled();
  });

  it("admits stop before awaiting the same in-flight start", async () => {
    const admission = deferred<void>();
    const start = deferred<void>();
    const f = fixture({
      beginStop: async () => admission.promise,
      startInFlight: start.promise,
    });

    const draining = drainComputerConnector(f.ports);
    expect(f.events).toEqual(["beginStop"]);
    expect(f.ports.waitForMcpStop).not.toHaveBeenCalled();
    expect(f.ports.stopConnector).not.toHaveBeenCalled();

    admission.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.events).toEqual(["beginStop"]);
    expect(f.ports.waitForMcpStop).not.toHaveBeenCalled();

    start.resolve(undefined);
    await draining;
    expect(f.events).toEqual([
      "beginStop",
      "waitForMcpStop",
      "stopConnector",
      "closeSavedChat",
      "confirmStop",
    ]);
  });

  it("keeps the tunnel parent running while MCP lifetime cleanup is pending", async () => {
    const mcpDrain = deferred<void>();
    const f = fixture({
      waitForMcpStop: async () => mcpDrain.promise,
    });

    const draining = drainComputerConnector(f.ports);
    await vi.waitFor(() =>
      expect(f.ports.waitForMcpStop).toHaveBeenCalledOnce(),
    );
    expect(f.events).toEqual(["beginStop", "waitForMcpStop"]);
    expect(f.ports.stopConnector).not.toHaveBeenCalled();
    expect(f.ports.closeSavedChat).not.toHaveBeenCalled();
    expect(f.ports.confirmStop).not.toHaveBeenCalled();

    mcpDrain.resolve(undefined);
    await draining;
    expect(f.events).toEqual([
      "beginStop",
      "waitForMcpStop",
      "stopConnector",
      "closeSavedChat",
      "confirmStop",
    ]);
  });

  it("stops the owned connector once in finally after a failed MCP drain", async () => {
    const error = new Error("MCP lifetime drain failed");
    const f = fixture({
      waitForMcpStop: async () => {
        throw error;
      },
    });

    await expect(drainComputerConnector(f.ports)).rejects.toBe(error);
    expect(f.events).toEqual([
      "beginStop",
      "waitForMcpStop",
      "stopConnector",
      "closeSavedChat",
    ]);
    expect(f.ports.waitForMcpStop).toHaveBeenCalledOnce();
    expect(f.ports.stopConnector).toHaveBeenCalledOnce();
    expect(f.ports.closeSavedChat).toHaveBeenCalledOnce();
    expect(f.ports.confirmStop).not.toHaveBeenCalled();
  });

  it("does not advance after stop admission fails", async () => {
    const error = new Error("stop admission failed");
    const f = fixture({
      beginStop: async () => {
        throw error;
      },
    });

    await expect(drainComputerConnector(f.ports)).rejects.toBe(error);
    expect(f.events).toEqual(["beginStop", "closeSavedChat"]);
    expect(f.ports.waitForMcpStop).not.toHaveBeenCalled();
    expect(f.ports.stopConnector).not.toHaveBeenCalled();
    expect(f.ports.closeSavedChat).toHaveBeenCalledOnce();
    expect(f.ports.confirmStop).not.toHaveBeenCalled();
  });

  it("does not advance after the in-flight start fails", async () => {
    const error = new Error("connector start failed");
    const f = fixture({
      startInFlight: Promise.resolve().then(() => {
        throw error;
      }),
    });

    await expect(drainComputerConnector(f.ports)).rejects.toBe(error);
    expect(f.events).toEqual(["beginStop", "closeSavedChat"]);
    expect(f.ports.waitForMcpStop).not.toHaveBeenCalled();
    expect(f.ports.stopConnector).not.toHaveBeenCalled();
    expect(f.ports.closeSavedChat).toHaveBeenCalledOnce();
    expect(f.ports.confirmStop).not.toHaveBeenCalled();
  });

  it("propagates an owned connector stop failure without retry or final confirmation", async () => {
    const error = new Error("owned connector stop failed");
    const f = fixture({
      stopConnector: async () => {
        throw error;
      },
    });

    await expect(drainComputerConnector(f.ports)).rejects.toBe(error);
    expect(f.events).toEqual([
      "beginStop",
      "waitForMcpStop",
      "stopConnector",
      "closeSavedChat",
    ]);
    expect(f.ports.stopConnector).toHaveBeenCalledOnce();
    expect(f.ports.closeSavedChat).toHaveBeenCalledOnce();
    expect(f.ports.confirmStop).not.toHaveBeenCalled();
  });

  it("propagates saved Chat bridge failure without confirming stop", async () => {
    const error = new Error("saved Chat bridge close failed");
    const f = fixture({
      closeSavedChat: async () => {
        throw error;
      },
    });

    await expect(drainComputerConnector(f.ports)).rejects.toBe(error);
    expect(f.events).toEqual([
      "beginStop",
      "waitForMcpStop",
      "stopConnector",
      "closeSavedChat",
    ]);
    expect(f.ports.stopConnector).toHaveBeenCalledOnce();
    expect(f.ports.closeSavedChat).toHaveBeenCalledOnce();
    expect(f.ports.confirmStop).not.toHaveBeenCalled();
  });

  it("propagates final confirmation failure after all preceding stages succeed", async () => {
    const error = new Error("final stop confirmation failed");
    const f = fixture({
      confirmStop: async () => {
        throw error;
      },
    });

    await expect(drainComputerConnector(f.ports)).rejects.toBe(error);
    expect(f.events).toEqual([
      "beginStop",
      "waitForMcpStop",
      "stopConnector",
      "closeSavedChat",
      "confirmStop",
    ]);
    expect(f.ports.waitForMcpStop).toHaveBeenCalledOnce();
    expect(f.ports.stopConnector).toHaveBeenCalledOnce();
    expect(f.ports.closeSavedChat).toHaveBeenCalledOnce();
    expect(f.ports.confirmStop).toHaveBeenCalledOnce();
  });
});
