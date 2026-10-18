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

it.each(["newer", "unavailable", "malformed", "expired"])(
  "preserves clock continuity through %s before accepting another positive",
  async (intermediate) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(200_000);
    const f = liveFixture(),
      held = deferred<unknown>();
    const original = {
      ...view(1, "recent_transport"),
      validUntilMillis: 245_000,
    };
    vi.mocked(f.api.bootstrap)
      .mockResolvedValueOnce({ ...bootstrap(), connectionStatus: original })
      .mockReturnValue(held.promise);
    const c = new WindowController(f.api);
    try {
      await c.start();
      vi.advanceTimersByTime(intermediate === "expired" ? 45_000 : 30_000);
      vi.setSystemTime(intermediate === "expired" ? 230_000 : 220_000);
      if (intermediate === "unavailable") f.notify(view(2, "unavailable"));
      if (intermediate === "malformed") f.notify({ invalid: true });
      f.notify({ ...original, revision: 3 });
      expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
      expect(c.getSnapshot().connectionStatus?.revision).toBe(3);
      await Promise.resolve();
      expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
      f.notify({ ...original, revision: 4 });
      expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(30_000);
      expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
    } finally {
      c.dispose();
      vi.useRealTimers();
    }
  },
);

it("fences an ordinary refresh started before a renderer clock rollback", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(200_000);
  const f = liveFixture(),
    oldRead = deferred<unknown>(),
    recovery = deferred<unknown>();
  const original = {
    ...view(1, "recent_transport"),
    validUntilMillis: 245_000,
  };
  vi.mocked(f.api.bootstrap)
    .mockResolvedValueOnce({ ...bootstrap(), connectionStatus: original })
    .mockReturnValueOnce(oldRead.promise)
    .mockReturnValue(recovery.promise);
  const c = new WindowController(f.api);
  try {
    await c.start();
    vi.advanceTimersByTime(30_000);
    const refresh = c.refresh();
    vi.setSystemTime(220_000);
    oldRead.resolve({
      ...bootstrap(),
      connectionStatus: { ...original, revision: 2 },
    });
    await refresh;
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    expect(f.api.bootstrap).toHaveBeenCalledTimes(3);
  } finally {
    c.dispose();
    vi.useRealTimers();
  }
});

it.each([
  "current",
  "older",
  "other-build",
  "other-environment",
  "malformed",
  "rejected",
  "second-jump",
  "disposed",
  "newer-unavailable",
])(
  "accepts only the post-discontinuity local read with current fences: %s",
  async (result) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(200_000);
    const f = liveFixture(),
      recovery = deferred<unknown>();
    const original = {
      ...view(1, "recent_transport"),
      validUntilMillis: 245_000,
    };
    vi.mocked(f.api.bootstrap)
      .mockResolvedValueOnce({ ...bootstrap(), connectionStatus: original })
      .mockReturnValue(recovery.promise);
    const c = new WindowController(f.api);
    try {
      await c.start();
      const configuration = c.getSnapshot().configuration,
        tasks = c.getSnapshot().tasks;
      vi.advanceTimersByTime(30_000);
      vi.setSystemTime(220_000);
      f.notify({ ...original, revision: 2 });
      await Promise.resolve();
      expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
      expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
      const reply = {
        ...bootstrap(),
        connectionStatus: {
          ...view(2, "recent_transport"),
          validUntilMillis: 265_000,
        },
      };
      if (result === "older") reply.connectionStatus.revision = 1;
      if (result === "other-build") reply.build.buildId = "4".repeat(64);
      if (result === "other-environment") reply.environment = "dev";
      if (result === "second-jump") {
        vi.setSystemTime(210_000);
        f.notify({ ...original, revision: 3 });
      }
      if (result === "disposed") c.dispose();
      if (result === "newer-unavailable") f.notify(view(3, "unavailable"));
      if (result === "rejected")
        recovery.reject(new Error("local read unavailable"));
      else recovery.resolve(result === "malformed" ? { invalid: true } : reply);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      if (result === "current") {
        expect(c.getSnapshot().connectionStatus?.state).toBe(
          "recent_transport",
        );
        // The explicit read consumes the original main deadline, not a new lease.
        vi.advanceTimersByTime(45_000);
        expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
      } else {
        expect(c.getSnapshot().connectionStatus?.state).toBe(
          result === "newer-unavailable" ? "unavailable" : "unobserved",
        );
      }
      expect(c.getSnapshot().configuration).toBe(configuration);
      expect(c.getSnapshot().tasks).toBe(tasks);
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
      // A rejected/malformed/mismatched response is never automatically replayed.
      expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
    } finally {
      c.dispose();
      vi.useRealTimers();
    }
  },
);

it.each(["unavailable", "malformed"])(
  "recovers after valid clock settlement independently of a newer %s presentation",
  async (intermediate) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(200_000);
    const f = liveFixture(),
      held = deferred<unknown>();
    const original = {
      ...view(1, "recent_transport"),
      validUntilMillis: 245_000,
    };
    vi.mocked(f.api.bootstrap)
      .mockResolvedValueOnce({ ...bootstrap(), connectionStatus: original })
      .mockReturnValue(held.promise);
    const c = new WindowController(f.api);
    try {
      await c.start();
      vi.advanceTimersByTime(30_000);
      vi.setSystemTime(220_000);
      f.notify({ ...original, revision: 2 });
      await Promise.resolve();
      if (intermediate === "unavailable") f.notify(view(3, "unavailable"));
      else f.notify({ invalid: true });
      held.resolve({
        ...bootstrap(),
        connectionStatus: { ...original, revision: 2 },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(c.getSnapshot().connectionStatus?.state).toBe(
        intermediate === "unavailable" ? "unavailable" : "unobserved",
      );
      f.notify({ ...view(4, "recent_transport"), validUntilMillis: 265_000 });
      expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
      expect(c.getSnapshot().connectionStatus?.revision).toBe(4);
      vi.advanceTimersByTime(45_000);
      expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
      expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
    } finally {
      c.dispose();
      vi.useRealTimers();
    }
  },
);

it("withdraws bootstrap queued across a clock discontinuity", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(200_000);
  const f = liveFixture(),
    first = deferred<unknown>(),
    recovery = deferred<unknown>();
  vi.mocked(f.api.bootstrap)
    .mockReturnValueOnce(first.promise)
    .mockReturnValue(recovery.promise);
  const c = new WindowController(f.api);
  try {
    const pending = c.start();
    vi.advanceTimersByTime(30_000);
    vi.setSystemTime(220_000);
    first.resolve({
      ...bootstrap(),
      connectionStatus: {
        ...view(1, "recent_transport"),
        validUntilMillis: 245_000,
      },
    });
    await pending;
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    f.notify({ ...view(2, "recent_transport"), validUntilMillis: 245_000 });
    await Promise.resolve();
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  } finally {
    c.dispose();
    vi.useRealTimers();
  }
});

it("a new explicit post-clock refresh recovers after a rejected local read", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(200_000);
  const f = liveFixture(),
    held = deferred<unknown>();
  const original = {
    ...view(1, "recent_transport"),
    validUntilMillis: 245_000,
  };
  vi.mocked(f.api.bootstrap)
    .mockResolvedValueOnce({ ...bootstrap(), connectionStatus: original })
    .mockReturnValueOnce(held.promise);
  const c = new WindowController(f.api);
  try {
    await c.start();
    vi.advanceTimersByTime(30_000);
    vi.setSystemTime(220_000);
    f.notify({ ...original, revision: 2 });
    await Promise.resolve();
    held.reject(new Error("local read unavailable"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
    vi.mocked(f.api.bootstrap).mockResolvedValueOnce({
      ...bootstrap(),
      connectionStatus: {
        ...view(3, "recent_transport"),
        validUntilMillis: 265_000,
      },
    });
    await c.refresh();
    expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
    vi.advanceTimersByTime(45_000);
    expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
    expect(f.api.bootstrap).toHaveBeenCalledTimes(3);
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  } finally {
    c.dispose();
    vi.useRealTimers();
  }
});

it.each([
  "checking",
  "reconnecting",
  "unavailable",
  "unobserved",
  "action_required",
  "stopped",
] as const)(
  "expires the bounded %s projection without another main message",
  async (state) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(200_000);
    const f = liveFixture(),
      c = new WindowController(f.api);
    try {
      await c.start();
      f.notify({
        ...unavailableConnectionStatus,
        revision: 1,
        state,
        validUntilMillis: 205_000,
        detail: "Bounded local readiness and transport snapshot.",
      });
      vi.advanceTimersByTime(4_999);
      expect(c.getSnapshot().connectionStatus?.detail).toBe(
        "Bounded local readiness and transport snapshot.",
      );
      vi.advanceTimersByTime(1);
      expect(c.getSnapshot().connectionStatus).toEqual({
        ...unavailableConnectionStatus,
        revision: 1,
      });
      expect(f.api.bootstrap).toHaveBeenCalledTimes(1);
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
    } finally {
      c.dispose();
      vi.useRealTimers();
    }
  },
);

it("retains the ordinary unbounded unavailable fallback without an expiry timer", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(200_000);
  const f = liveFixture(),
    c = new WindowController(f.api);
  try {
    await c.start();
    f.notify({ ...unavailableConnectionStatus, revision: 1 });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(c.getSnapshot().connectionStatus).toEqual({
      ...unavailableConnectionStatus,
      revision: 1,
    });
    expect(f.api.bootstrap).toHaveBeenCalledTimes(1);
  } finally {
    c.dispose();
    vi.useRealTimers();
  }
});
