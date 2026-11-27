import { describe, expect, it, vi } from "vitest";
import type { CollectPorts } from "./collect";
import { quitCollect } from "./collect";

const discard = vi.hoisted(() => vi.fn());
vi.mock("../../../src/apps/desktop/chatgpt-attachment-staging", () => ({
  discardChatGptAttachments: discard,
}));

// Quit's collection over recording owners: which closers come out, in what
// order, and that each one-shot slot is taken when the step runs.

function closeable(log: string[], name: string) {
  return { close: () => Promise.resolve(void log.push(name)) };
}

function ports(log: string[], overrides: Partial<CollectPorts> = {}) {
  const owners: CollectPorts = {
    installedUpdates: closeable(log, "installed-updater"),
    statePaths: () => ({ attachmentStaging: "/state/staging" }),
    takeAttachmentTask: () => null,
    takeAgentCheck: () => null,
    takeProductAgent: () => null,
    takePersistedProductAgentExpiry: () => null,
    hostCheckClients: [],
    secureMcpConnectorRuntime: () => null,
    desktopGoCore: () => null,
    savedBridge: { get: () => null, set: () => undefined },
    connectorStartInFlight: () => null,
    startupConnectionChecking: () => false,
    connectorStartCancellation: () => null,
    connectorStartQuitBudgetMs: 8_000,
    stopAndConfirmComputerMcp: () => Promise.resolve(),
    operationsStore: () => {
      throw new Error("unused");
    },
    takeModelLifecycle: () => null,
    takeRouteB: () => null,
    takeRelay: () => null,
    disposeChatGptRoutes: () => void log.push("dispose-routes"),
    disposeRuntimeTaskViews: () => void log.push("dispose-views"),
    ownedLocalRuntimes: [],
    stopRuntime: () => void log.push("stop-runtime"),
    now: () => 1_000,
    ...overrides,
  };
  return owners;
}

describe("quitCollect", () => {
  it("with nothing owned collects only the updater and runs the teardown steps", () => {
    const log: string[] = [];
    const closers = quitCollect(ports(log))({ deadlineAt: 5_000 });
    expect(closers.map((closer) => closer.name)).toEqual(["installed-updater"]);
    expect(log).toEqual(["dispose-routes", "dispose-views", "stop-runtime"]);
    expect(discard).not.toHaveBeenCalled();
  });

  it("discards a staged attachment and names closers in the original order", () => {
    discard.mockClear();
    const log: string[] = [];
    const timer = setTimeout(() => undefined, 60_000);
    const expiry = setTimeout(() => undefined, 60_000);
    const closers = quitCollect(
      ports(log, {
        takeAttachmentTask: () => ({ operationId: "op-1" }),
        takeAgentCheck: () => ({
          host: { dispose: () => void log.push("agent-host") },
          client: closeable(log, "agent-client"),
        }),
        takeProductAgent: () => ({
          expiryTimer: timer,
          host: { dispose: () => void log.push("product-host") },
          client: closeable(log, "product-client"),
        }),
        takePersistedProductAgentExpiry: () => ({ timer: expiry }),
        hostCheckClients: [closeable(log, "check-client")],
        takeModelLifecycle: () => ({
          stop: () => Promise.resolve(void log.push("model-stop")),
        }),
        takeRouteB: () => closeable(log, "route-b-close"),
        takeRelay: () => closeable(log, "relay-close"),
        ownedLocalRuntimes: [[closeable(log, "local-close"), "local-runtime"]],
      }),
    )({ deadlineAt: 5_000 });
    expect(discard).toHaveBeenCalledWith("/state/staging", "op-1");
    expect(closers.map((closer) => closer.name)).toEqual([
      "installed-updater",
      "agent-check",
      "product-agent",
      "host-check",
      "model-endpoint",
      "route-b",
      "caller-relay",
      "local-runtime",
    ]);
    expect(log).toEqual([
      "agent-host",
      "product-host",
      "dispose-routes",
      "dispose-views",
      "stop-runtime",
    ]);
    clearTimeout(timer);
    clearTimeout(expiry);
  });

  it("closes a saved chat alone before the core and clears its cell", async () => {
    const log: string[] = [];
    const saved = {
      close: () => Promise.resolve(void log.push("saved-close")),
    };
    let cell: typeof saved | null = saved;
    const closers = quitCollect(
      ports(log, {
        savedBridge: {
          get: () => cell as never,
          set: (value) => {
            cell = value as never;
            log.push("saved-cleared");
          },
        },
      }),
    )({ deadlineAt: 5_000 });
    expect(cell).toBeNull();
    expect(closers.map((closer) => closer.name)).toEqual([
      "installed-updater",
      "saved-chat-bridge",
    ]);
    await closers[1]!.close();
    expect(log).toContain("saved-close");
  });

  it("bounds a connector stop by the quit budget, aborts the start and clears the cell afterwards", async () => {
    const log: string[] = [];
    const saved = {
      close: () => Promise.resolve(void log.push("saved-close")),
    };
    let cell: typeof saved | null = saved;
    const stop = vi.fn((..._args: unknown[]) =>
      Promise.reject(new Error("unconfirmed")),
    );
    const closers = quitCollect(
      ports(log, {
        secureMcpConnectorRuntime: () => ({}) as never,
        startupConnectionChecking: () => true,
        connectorStartCancellation: () => ({
          abort: () => void log.push("abort"),
        }),
        savedBridge: {
          get: () => cell as never,
          set: (value) => {
            cell = value as never;
          },
        },
        stopAndConfirmComputerMcp: stop as never,
      }),
    )({ deadlineAt: 5_000 });
    expect(log).toEqual([
      "abort",
      "dispose-routes",
      "dispose-views",
      "stop-runtime",
    ]);
    expect(closers.map((closer) => closer.name)).toEqual([
      "installed-updater",
      "connector",
    ]);
    await expect(closers[1]!.close()).rejects.toThrow("unconfirmed");
    expect(stop.mock.calls[0]?.[6]).toBe(5_000);
    expect(log).toContain("saved-close");
    expect(cell).toBeNull();
  });
});
