import { expect, it, vi } from "vitest";
import {
  ConnectionStatusTracker,
  connectionStatusView,
} from "../../apps/desktop/connection-status";
import type { ComputerConnectorHealthState } from "../../apps/desktop/bridge/wire";
import { ConnectionStatusViewSchema } from "../../apps/desktop/renderer/connection-status";

const binding = {
  profileId: "profile",
  backendGeneration: "backend",
  buildId: "build",
  runtimeId: "runtime",
  connectorGeneration: "1",
};
const sample = (): ComputerConnectorHealthState => ({
  binding,
  expectedInstanceId: "instance",
  sampleAtMillis: "200000",
  state: "recent_transport",
  reason: "recent_poll_success",
  observedAtMillis: "200000",
  validUntilMillis: "245000",
  lastPollSuccessMillis: "199000",
  localReady: true,
});
function fixture() {
  let wall = 200000,
    mono = 0,
    current = true;
  const original = {};
  const observe = vi.fn(
    async (_: object): Promise<ComputerConnectorHealthState | null> => sample(),
  );
  const tracker = new ConnectionStatusTracker({
    capture: () => original,
    current: (v) => v === original && current,
    observe,
    now: () => wall,
    monotonic: () => mono,
  });
  return {
    tracker,
    observe,
    clock(w: number, m: number) {
      wall = w;
      mono = m;
    },
    retire() {
      current = false;
    },
  };
}
it("displays only supplied Go states and keeps response upload separate from attachment", () => {
  const value = { ...sample(), lastResponseAcceptedMillis: "150000" };
  const view = connectionStatusView(value, 200000, true);
  expect(view.state).toBe("recent_transport");
  expect(view.delivery).toContain("historical");
  expect(view.delivery).toContain("does not confirm current attachment");
  expect(
    ConnectionStatusViewSchema.safeParse({ ...view, revision: 1 }).success,
  ).toBe(true);
  expect(connectionStatusView(value, 245000, true).state).toBe("unobserved");
  expect(connectionStatusView(value, 199999, true).state).toBe("unobserved");
  expect(connectionStatusView(value, 200000, false).state).toBe("unobserved");
});
it.each([
  "checking",
  "reconnecting",
  "unavailable",
  "unobserved",
  "action_required",
  "stopped",
] as const)(
  "preserves Go state %s even with a historical successful poll",
  (state) => {
    expect(
      connectionStatusView({ ...sample(), state }, 200000, true).state,
    ).toBe(state);
  },
);
it("expires without a click or new observation and immediately retires foreign lifetime data", async () => {
  const f = fixture();
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
  f.clock(244999, 44999);
  expect(f.tracker.view().state).toBe("recent_transport");
  f.clock(245000, 45000);
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(200000, 0);
  await f.tracker.sample();
  f.retire();
  expect(f.tracker.view().state).toBe("unobserved");
});
it.each([
  [201000, 5000],
  [210000, 1000],
  [200000, -1],
] as const)(
  "wall/monotonic clock discontinuity %j cannot extend cached presentation",
  async (wall, mono) => {
    const f = fixture();
    await f.tracker.sample();
    f.clock(wall, mono);
    expect(f.tracker.view().state).toBe("unobserved");
  },
);
it("uses the original request start, so a delayed completion cannot renew its observation", async () => {
  const f = fixture();
  f.observe.mockImplementationOnce(async () => {
    f.clock(245000, 45000);
    return sample();
  });
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});
it("an absent or refused observation cannot retain a previous positive", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.observe.mockResolvedValueOnce(null);
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  await f.tracker.sample();
  f.observe.mockRejectedValueOnce(new Error("refused"));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});
it.each(["suspend", "invalidate", "close"] as const)(
  "fences in-flight presentation on %s",
  async (action) => {
    const f = fixture();
    let release!: (value: ComputerConnectorHealthState) => void;
    f.observe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.tracker.sample();
    expect(f.tracker.sample()).toBe(pending);
    f.tracker[action]();
    release(sample());
    await pending;
    expect(f.tracker.view().state).toBe("unobserved");
    expect(f.observe).toHaveBeenCalledTimes(1);
  },
);

it("queues one fresh post-wake observation behind the fenced original read", async () => {
  const f = fixture();
  let release!: (value: ComputerConnectorHealthState) => void;
  f.observe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const original = f.tracker.sample();
  f.tracker.suspend();
  f.tracker.resume();
  void f.tracker.sample();
  release(sample());
  await original;
  await Promise.resolve();
  await Promise.resolve();
  expect(f.observe).toHaveBeenCalledTimes(2);
  expect(f.tracker.view().state).toBe("recent_transport");
});

it("a failing local status port cannot crash or preserve a positive", async () => {
  let broken = false;
  const tracker = new ConnectionStatusTracker({
    capture: () => {
      if (broken) throw Error("failed");
      return {};
    },
    current: () => {
      if (broken) throw Error("failed");
      return true;
    },
    observe: async () => sample(),
    now: () => 200000,
    monotonic: () => 0,
  });
  await tracker.sample();
  expect(tracker.view().state).toBe("recent_transport");
  broken = true;
  expect(tracker.view().state).toBe("unobserved");
  await expect(tracker.sample()).resolves.toBeUndefined();
  broken = false;
  expect(tracker.view().state).toBe("unobserved");
});

it("a clock discontinuity permanently retires the cached observation", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(200000, 5000);
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(200000, 0);
  expect(f.tracker.view().state).toBe("unobserved");
});
