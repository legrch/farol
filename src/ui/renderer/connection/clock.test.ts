import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  unavailableConnectionStatus,
  type ConnectionStatusView,
} from "../../../../apps/desktop/renderer/connection-status";
import { ConnectionStatusClock, type ConnectionStatusBootstrap } from "./clock";

const view = (
  revision: number,
  state: ConnectionStatusView["state"],
  validUntilMillis: number | null = null,
): ConnectionStatusView => ({
  ...unavailableConnectionStatus,
  revision,
  state,
  validUntilMillis,
});

function harness() {
  const shown: { current: ConnectionStatusView | undefined } = {
    current: undefined,
  };
  const published: ConnectionStatusView[] = [];
  const state = {
    disposed: false,
    buildId: "build-1" as string | null,
    bootstrap: null as ConnectionStatusBootstrap | null,
  };
  const readBootstrap = vi.fn(async () => state.bootstrap);
  const clock = new ConnectionStatusClock({
    disposed: () => state.disposed,
    current: () => shown.current,
    buildId: () => state.buildId,
    environment: () => "preview",
    publish: (next) => {
      shown.current = next;
      published.push(next);
    },
    readBootstrap,
  });
  return { clock, shown, published, state, readBootstrap };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(200_000);
});
afterEach(() => vi.useRealTimers());

describe("ConnectionStatusClock", () => {
  it("publishes a positive view and retires it at the original deadline", () => {
    const h = harness();
    h.clock.adopt(view(1, "recent_transport", 205_000));
    expect(h.shown.current?.state).toBe("recent_transport");
    vi.advanceTimersByTime(4_999);
    expect(h.shown.current?.state).toBe("recent_transport");
    vi.advanceTimersByTime(1);
    expect(h.shown.current).toMatchObject({ state: "unobserved", revision: 1 });
  });

  it("does not renew the deadline when the same revision arrives again", () => {
    const h = harness();
    h.clock.adopt(view(1, "recent_transport", 205_000));
    vi.advanceTimersByTime(4_000);
    h.clock.adopt(view(1, "recent_transport", 205_000));
    expect(h.published).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(h.shown.current?.state).toBe("unobserved");
  });

  it("refuses an older revision and accepts a newer one", () => {
    const h = harness();
    h.clock.adopt(view(5, "unavailable"));
    h.clock.adopt(view(4, "recent_transport", 205_000));
    expect(h.shown.current).toMatchObject({
      revision: 5,
      state: "unavailable",
    });
    h.clock.adopt(view(6, "recent_transport", 205_000));
    expect(h.shown.current).toMatchObject({
      revision: 6,
      state: "recent_transport",
    });
  });

  it("publishes a view with no deadline directly and starts no timer", () => {
    const h = harness();
    h.clock.adopt(view(1, "unavailable"));
    expect(h.shown.current?.state).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withdraws a positive view whose deadline already passed", () => {
    const h = harness();
    h.clock.adopt(view(1, "recent_transport", 199_000));
    expect(h.shown.current).toMatchObject({ state: "unobserved", revision: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withdraws a malformed view and fences a read begun before it", () => {
    const h = harness();
    h.clock.adopt(view(1, "recent_transport", 205_000));
    const read = h.clock.beginRead();
    h.clock.adopt({ ...view(2, "recent_transport", 205_000), state: "bogus" });
    expect(h.shown.current?.state).toBe("unobserved");
    const before = h.published.length;
    h.clock.adoptRead(
      {
        environment: "preview",
        build: { buildId: "build-1" },
        connectionStatus: view(3, "recent_transport", 205_000),
      },
      read,
    );
    expect(h.published).toHaveLength(before);
  });

  it("retire cancels the pending expiry", () => {
    const h = harness();
    h.clock.adopt(view(1, "recent_transport", 205_000));
    h.clock.retire();
    vi.advanceTimersByTime(10_000);
    expect(h.shown.current?.state).toBe("recent_transport");
  });

  it("ignores everything once the window is disposed", () => {
    const h = harness();
    h.state.disposed = true;
    h.clock.adopt(view(1, "recent_transport", 205_000));
    expect(h.published).toHaveLength(0);
  });

  it("retires a positive view on a clock rollback and re-reads once", async () => {
    const h = harness();
    h.state.bootstrap = {
      environment: "preview",
      build: { buildId: "build-1" },
      connectionStatus: view(2, "recent_transport", 245_000),
    };
    h.clock.adopt(view(1, "recent_transport", 245_000));
    vi.advanceTimersByTime(1_000);
    vi.setSystemTime(150_000);
    vi.advanceTimersByTime(1_000);
    expect(h.shown.current).toMatchObject({ state: "unobserved", revision: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.readBootstrap).toHaveBeenCalledTimes(1);
    // The fresh read settles the fence, so a later positive is shown again.
    h.clock.adopt(view(3, "recent_transport", 245_000));
    expect(h.shown.current?.state).toBe("recent_transport");
  });

  it("does not adopt a re-read made for another build", async () => {
    const h = harness();
    h.state.bootstrap = {
      environment: "preview",
      build: { buildId: "other-build" },
      connectionStatus: view(2, "recent_transport", 245_000),
    };
    h.clock.adopt(view(1, "recent_transport", 245_000));
    vi.setSystemTime(150_000);
    vi.advanceTimersByTime(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.readBootstrap).toHaveBeenCalledTimes(1);
    expect(h.shown.current).toMatchObject({ state: "unobserved", revision: 1 });
  });

  it("survives a failing re-read without renewing the retired view", async () => {
    const h = harness();
    h.readBootstrap.mockRejectedValue(new Error("offline"));
    h.clock.adopt(view(1, "recent_transport", 245_000));
    vi.setSystemTime(150_000);
    vi.advanceTimersByTime(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.shown.current).toMatchObject({ state: "unobserved", revision: 1 });
  });
});
