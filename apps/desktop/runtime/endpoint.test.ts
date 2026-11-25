import { describe, expect, it, vi } from "vitest";
import type {
  FarolModelCompactionHandler,
  FarolModelTurnHandler,
} from "../../../src/apps/desktop/farol-model-endpoint";
import { startModelEndpoint, type ModelEndpointOptions } from "./endpoint";

// The endpoint build over scripted handlers: each handler is a tagged fake so
// the test can see which one reached the lifecycle and through which recorder.

const tagged = <T>(tag: string) =>
  Object.assign(() => {}, { tag }) as unknown as T;

function setup(
  over: {
    enabled?: boolean;
    syntheticReply?: string;
    start?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const created: ModelEndpointOptions[] = [];
  const lifecycle = {
    start: vi.fn(over.start ?? (async () => {})),
  };
  const ports = {
    enabled: over.enabled ?? true,
    syntheticReply: over.syntheticReply,
    stateRoot: "/state/model",
    model: "model-x",
    createLifecycle: (options: ModelEndpointOptions) => {
      calls.push("create");
      created.push(options);
      return lifecycle;
    },
    recordTurn: (h: FarolModelTurnHandler) => {
      calls.push("recordTurn");
      return Object.assign(() => {}, {
        recorded: h,
      }) as unknown as FarolModelTurnHandler;
    },
    recordCompaction: (h: FarolModelCompactionHandler) => {
      calls.push("recordCompaction");
      return Object.assign(() => {}, {
        recorded: h,
      }) as unknown as FarolModelCompactionHandler;
    },
    syntheticTurn: vi.fn((reply: string) =>
      tagged<FarolModelTurnHandler>(`synthetic:${reply}`),
    ),
    routeBTurn: vi.fn(() => tagged<FarolModelTurnHandler>("routeB")),
    routeBCompaction: vi.fn(() =>
      tagged<FarolModelCompactionHandler>("routeBCompaction"),
    ),
  };
  return { ports, calls, created, lifecycle };
}

const recorded = (h: unknown) =>
  (h as { recorded: { tag: string } }).recorded.tag;

describe("model endpoint startup", () => {
  it("builds and starts nothing when the route is disabled", async () => {
    const { ports, calls, lifecycle } = setup({ enabled: false });
    await expect(startModelEndpoint(ports)).resolves.toBeNull();
    expect(calls).toEqual([]);
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  it("serves through Route B and starts the lifecycle once", async () => {
    const { ports, created, lifecycle } = setup();
    await expect(startModelEndpoint(ports)).resolves.toBe(lifecycle);
    expect(created[0]!.stateRoot).toBe("/state/model");
    expect(created[0]!.model).toBe("model-x");
    expect(recorded(created[0]!.handler)).toBe("routeB");
    expect(recorded(created[0]!.compactionHandler)).toBe("routeBCompaction");
    expect(ports.syntheticTurn).not.toHaveBeenCalled();
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
  });

  it("serves the synthetic reply instead of Route B when one is given", async () => {
    const { ports, created } = setup({ syntheticReply: "hello" });
    await startModelEndpoint(ports);
    expect(recorded(created[0]!.handler)).toBe("synthetic:hello");
    expect(ports.routeBTurn).not.toHaveBeenCalled();
    expect(recorded(created[0]!.compactionHandler)).toBe("routeBCompaction");
  });

  it("keeps the built endpoint when the start fails", async () => {
    const { ports, lifecycle } = setup({
      start: async () => {
        throw new Error("EADDRINUSE");
      },
    });
    await expect(startModelEndpoint(ports)).resolves.toBe(lifecycle);
  });
});
