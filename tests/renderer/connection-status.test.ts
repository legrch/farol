import { expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import { unavailableConnectionStatus } from "../../apps/desktop/renderer/connection-status";
import { fixture, bootstrap, deferred } from "./fixture";

const view = (revision: number, state: "recent_transport" | "unavailable") => ({
  ...unavailableConnectionStatus,
  revision,
  state,
  marker: state === "recent_transport" ? "✓" : "!",
  validUntilMillis: state === "recent_transport" ? Date.now() + 5000 : null,
  label:
    state === "recent_transport"
      ? "Recent server polling"
      : "Server transport unavailable",
});
function liveFixture() {
  const f = fixture();
  let notify: (value: unknown) => void = () => undefined;
  const off = vi.fn();
  const api = {
    ...f.api,
    onConnectionStatus: (listener: (value: unknown) => void) => {
      notify = listener;
      return off;
    },
  };
  return { ...f, api, off, notify: (value: unknown) => notify(value) };
}
it("adopts live status without configuration/task actions and refuses stale refresh rollback", async () => {
  const f = liveFixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  const c = new WindowController(f.api);
  await c.start();
  expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
  f.notify(view(2, "unavailable"));
  expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
  await c.refresh();
  expect(c.getSnapshot().connectionStatus?.revision).toBe(2);
  expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
  expect(f.off).toHaveBeenCalledTimes(1);
});
it("a newer live event during bootstrap keeps the original ordering", async () => {
  const f = liveFixture(),
    held = deferred<unknown>();
  vi.mocked(f.api.bootstrap).mockReturnValueOnce(held.promise);
  const c = new WindowController(f.api),
    pending = c.start();
  f.notify(view(2, "unavailable"));
  held.resolve({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  await pending;
  expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
  c.dispose();
});
it("malformed status loses a cached positive without permitting an old bootstrap to revive it", async () => {
  const f = liveFixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  const c = new WindowController(f.api);
  await c.start();
  f.notify({ ...view(2, "recent_transport"), state: "invented_connected" });
  expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
  await c.refresh();
  expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
  f.notify(view(2, "unavailable"));
  expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
  c.dispose();
});

it("expires a positive projection without another main-process message", async () => {
  vi.useFakeTimers();
  const f = liveFixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  const c = new WindowController(f.api);
  try {
    await c.start();
    expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
    vi.advanceTimersByTime(60_000);
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  } finally {
    c.dispose();
    vi.useRealTimers();
  }
});

it("consumes the original deadline across duplicate messages and refresh", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(200_000);
  const f = liveFixture();
  const original = view(1, "recent_transport");
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    connectionStatus: original,
  });
  const c = new WindowController(f.api);
  try {
    await c.start();
    vi.advanceTimersByTime(4_000);
    f.notify(view(1, "recent_transport"));
    await c.refresh();
    vi.advanceTimersByTime(999);
    expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    expect(c.getSnapshot().connectionStatus?.revision).toBe(1);
    await c.refresh();
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    f.notify({ ...original, revision: 2 });
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    expect(c.getSnapshot().connectionStatus?.revision).toBe(2);
    f.notify(view(3, "recent_transport"));
    expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
    vi.advanceTimersByTime(5_000);
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
  } finally {
    c.dispose();
    vi.useRealTimers();
  }
});
it.each([
  undefined,
  null,
  0,
  -1,
  0.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  "205000",
])(
  "withholds positive presentation for an absent or invalid deadline %s",
  async (deadline) => {
    const f = liveFixture(),
      c = new WindowController(f.api);
    try {
      await c.start();
      f.notify({ ...view(1, "recent_transport"), validUntilMillis: deadline });
      expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
    } finally {
      c.dispose();
    }
  },
);
it.each([-5_000, 2_000, 60_000])(
  "withdraws the positive lease on renderer clock discontinuity %s",
  async (jump) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(200_000);
    const f = liveFixture();
    vi.mocked(f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      connectionStatus: view(1, "recent_transport"),
    });
    const c = new WindowController(f.api);
    try {
      await c.start();
      expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
      vi.setSystemTime(200_000 + jump);
      vi.advanceTimersByTime(1_000);
      expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
      expect(c.getSnapshot().connectionStatus?.revision).toBe(1);
    } finally {
      c.dispose();
      vi.useRealTimers();
    }
  },
);
it("retires old expiry callbacks on newer projections and window teardown", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(200_000);
  const f = liveFixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  const c = new WindowController(f.api);
  try {
    await c.start();
    vi.advanceTimersByTime(4_000);
    f.notify({ ...view(2, "recent_transport"), validUntilMillis: 212_000 });
    vi.advanceTimersByTime(1_000);
    expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
    expect(c.getSnapshot().connectionStatus?.revision).toBe(2);
    f.notify(view(3, "unavailable"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
    f.notify(view(4, "recent_transport"));
    expect(vi.getTimerCount()).toBe(1);
    c.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(c.getSnapshot().connectionStatus?.revision).toBe(4);
  } finally {
    c.dispose();
    vi.useRealTimers();
  }
});

it("retains one owned timer across synchronous subscribers", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(200_000);
  const f = liveFixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  const c = new WindowController(f.api);
  let stop = () => {};
  try {
    await c.start();
    stop = c.subscribe(() => {
      if (c.getSnapshot().connectionStatus?.revision === 2)
        f.notify(view(3, "recent_transport"));
    });
    f.notify(view(2, "recent_transport"));
    expect(c.getSnapshot().connectionStatus?.revision).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
    c.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stop();
    c.dispose();
    vi.useRealTimers();
  }
});
