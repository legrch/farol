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
// Injected clocks and Go-shaped values exercise presentation only, not a live
// provider, native runtime, or the operating system clock.
const sampleAt = (
  wall: number,
  changes: Partial<ComputerConnectorHealthState> = {},
): ComputerConnectorHealthState => ({
  ...sample(),
  sampleAtMillis: String(wall),
  observedAtMillis: String(wall),
  validUntilMillis: String(wall + 45000),
  ...changes,
});
function fixture() {
  let wall = 200000,
    mono = 0,
    current = true,
    owner = "original";
  const capture = vi.fn((): { owner: string } | null => ({ owner }));
  const currentOwner = vi.fn(
    (v: { owner: string }) => v.owner === owner && current,
  );
  const observe = vi.fn(
    async (_: {
      owner: string;
    }): Promise<ComputerConnectorHealthState | null> => sample(),
  );
  const tracker = new ConnectionStatusTracker({
    capture,
    current: currentOwner,
    observe,
    now: () => wall,
    monotonic: () => mono,
  });
  return {
    tracker,
    observe,
    capture,
    currentOwner,
    replaceOwner() {
      owner = "replacement";
    },
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

it("does not restore an expired successful poll after rollback and fresh resampling", async () => {
  const f = fixture();
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
  f.clock(301000, 101000);
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(210000, 102000);
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  expect(f.observe).toHaveBeenCalledTimes(2);
  expect(f.tracker.view().state).toBe("unobserved");
});

it("retains clock origin across normal samples and an empty cache", async () => {
  const f = fixture();
  await f.tracker.sample();
  for (const [wall, mono] of [
    [220000, 20000],
    [240000, 40000],
  ] as const) {
    f.clock(wall, mono);
    f.observe.mockResolvedValueOnce(sampleAt(wall));
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("recent_transport");
  }
  f.clock(301000, 101000);
  f.observe.mockResolvedValueOnce(null);
  await f.tracker.sample();
  f.clock(210000, 102000);
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});

it.each([
  "expiry",
  "absent",
  "refused",
  "capture-null",
  "capture-error",
  "invalidate",
  "wake",
] as const)(
  "retains pre-discontinuity proof after %s clears the cache",
  async (clear) => {
    const f = fixture();
    await f.tracker.sample();
    f.clock(301000, 101000);
    if (clear === "expiry") f.tracker.view();
    if (clear === "absent") {
      f.observe.mockResolvedValueOnce(null);
      await f.tracker.sample();
    }
    if (clear === "refused") {
      f.observe.mockRejectedValueOnce(Error("refused"));
      await f.tracker.sample();
    }
    if (clear === "capture-null") {
      f.capture.mockReturnValueOnce(null);
      await f.tracker.sample();
    }
    if (clear === "capture-error") {
      f.capture.mockImplementationOnce(() => {
        throw Error("failed");
      });
      await f.tracker.sample();
    }
    if (clear === "invalidate") f.tracker.invalidate();
    if (clear === "wake") {
      f.tracker.suspend();
      f.tracker.resume();
    }
    f.clock(210000, 102000);
    f.observe.mockResolvedValueOnce(sampleAt(210000));
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
  },
);

it("normalization, nulls, refusals and invalidation cannot restore a retired proof", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(210000, 1000);
  expect(f.tracker.view().state).toBe("unobserved");
  for (let step = 0; step < 4; step++) {
    const wall = 200000 + step * 1000;
    f.clock(wall, step * 1000);
    f.observe.mockResolvedValueOnce(sampleAt(wall));
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
    f.observe.mockResolvedValueOnce(null);
    await f.tracker.sample();
    f.observe.mockRejectedValueOnce(Error("refused"));
    await f.tracker.sample();
    f.tracker.invalidate();
    f.tracker.suspend();
    f.tracker.resume();
  }
  f.observe.mockResolvedValueOnce(sampleAt(203000));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});

it("a discontinuity during a refused read still retires the observed poll proof", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.observe.mockImplementationOnce(async () => {
    f.clock(210000, 1000);
    throw Error("refused");
  });
  await f.tracker.sample();
  f.clock(200000, 0);
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});

it("retires a poll proof observed in a nonpositive Go result", async () => {
  const f = fixture();
  f.observe.mockResolvedValueOnce({
    ...sample(),
    state: "unavailable",
    reason: "http_unavailable",
  });
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unavailable");
  f.tracker.invalidate();
  f.clock(210000, 1000);
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});

it("a new successful poll in a stable current read restores the Go positive", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(301000, 101000);
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(210000, 102000);
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(211000, 103000);
  f.observe.mockResolvedValueOnce(
    sampleAt(211000, { lastPollSuccessMillis: "210500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
  f.clock(212000, 104000);
  f.observe.mockResolvedValueOnce(sampleAt(212000));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});

it.each([
  "checking",
  "reconnecting",
  "unavailable",
  "unobserved",
  "action_required",
  "stopped",
] as const)(
  "keeps nonpositive Go state %s and historic uploads truthful after discontinuity",
  async (state) => {
    const f = fixture();
    await f.tracker.sample();
    f.clock(210000, 1000);
    const value = sampleAt(210000, {
      state,
      lastResponseAcceptedMillis: "150000",
    });
    f.observe.mockResolvedValueOnce(value);
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe(state);
    expect(f.tracker.view().delivery).toContain("1970-01-01T00:02:30.000Z");
    expect(value.state).toBe(state);
    f.observe.mockResolvedValueOnce({ ...value, state: "recent_transport" });
    await f.tracker.sample();
    const withheld = f.tracker.view();
    expect(withheld.state).toBe("unobserved");
    expect(withheld.delivery).toContain("1970-01-01T00:02:30.000Z");
    expect(withheld.delivery).toContain("does not confirm current attachment");
  },
);

it.each([
  "profileId",
  "backendGeneration",
  "buildId",
  "runtimeId",
  "connectorGeneration",
  "expectedInstanceId",
] as const)(
  "separates the full runtime proof identity at %s",
  async (field) => {
    const f = fixture();
    await f.tracker.sample();
    f.clock(210000, 1000);
    f.observe.mockResolvedValueOnce(
      sampleAt(210000, { binding: { ...binding } }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
    f.replaceOwner();
    const replacement = sampleAt(
      210000,
      field === "expectedInstanceId"
        ? { expectedInstanceId: "replacement" }
        : { binding: { ...binding, [field]: "replacement" } },
    );
    f.observe.mockResolvedValueOnce(replacement);
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
    f.clock(211000, 2000);
    f.observe.mockResolvedValueOnce({
      ...replacement,
      sampleAtMillis: "211000",
      observedAtMillis: "211000",
      validUntilMillis: "256000",
      lastPollSuccessMillis: "210500",
    });
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("recent_transport");
    f.retire();
    expect(f.tracker.view().state).toBe("unobserved");
  },
);

it("a foreign in-flight owner cannot change the retired proof or lend its value to a replacement", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(210000, 1000);
  expect(f.tracker.view().state).toBe("unobserved");
  let release!: (value: ComputerConnectorHealthState) => void;
  f.observe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.tracker.sample();
  f.replaceOwner();
  release(
    sampleAt(210000, { binding: { ...binding, runtimeId: "replacement" } }),
  );
  await pending;
  expect(f.tracker.view().state).toBe("unobserved");
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.observe.mockResolvedValueOnce(
    sampleAt(210000, { binding: { ...binding, runtimeId: "replacement" } }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(211000, 2000);
  f.observe.mockResolvedValueOnce(
    sampleAt(211000, {
      binding: { ...binding, runtimeId: "replacement" },
      lastPollSuccessMillis: "210500",
    }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
});

it("stale and delayed new-success reads cannot replace the retired proof", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(210000, 1000);
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(260000, 51000);
  f.observe.mockResolvedValueOnce(
    sampleAt(210000, { lastPollSuccessMillis: "209000" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.observe.mockImplementationOnce(async () => {
    f.clock(305000, 96000);
    return sampleAt(260000, { lastPollSuccessMillis: "259000" });
  });
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(210000, 97000);
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});

it("post-wake repeat sampling cannot restore a previously observed retired proof", async () => {
  const f = fixture();
  await f.tracker.sample();
  let release!: (value: ComputerConnectorHealthState) => void;
  f.observe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.tracker.sample();
  f.tracker.suspend();
  f.clock(210000, 1000);
  f.tracker.resume();
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  void f.tracker.sample();
  release(sampleAt(210000, { lastPollSuccessMillis: "209000" }));
  await pending;
  await f.tracker.sample();
  expect(f.observe).toHaveBeenCalledTimes(3);
  expect(f.tracker.view().state).toBe("unobserved");
  f.observe.mockResolvedValueOnce(
    sampleAt(210000, { lastPollSuccessMillis: "209000" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(211000, 2000);
  f.observe.mockResolvedValueOnce(
    sampleAt(211000, { lastPollSuccessMillis: "210500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
});

it("a clock jump during a request cannot establish a new success proof", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(201000, 1000);
  f.observe.mockImplementationOnce(async () => {
    f.clock(210000, 2000);
    return sampleAt(210000, { lastPollSuccessMillis: "209000" });
  });
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.observe.mockResolvedValueOnce(
    sampleAt(210000, { lastPollSuccessMillis: "209000" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(211000, 3000);
  f.observe.mockResolvedValueOnce(
    sampleAt(211000, { lastPollSuccessMillis: "210500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
});

it("resampling cannot reset away accumulated wall/monotonic drift", async () => {
  const f = fixture();
  await f.tracker.sample();
  for (const [wall, mono] of [
    [201500, 1000],
    [203000, 2000],
  ] as const) {
    f.clock(wall, mono);
    f.observe.mockResolvedValueOnce(sampleAt(wall));
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("recent_transport");
  }
  f.clock(204500, 3000);
  f.observe.mockResolvedValueOnce(sampleAt(204500));
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
});

it.each([
  [NaN, 0],
  [200000, NaN],
  [200000, Infinity],
  [200000, -1],
] as const)(
  "invalid clock %j cannot erase the poll proof with an empty cache",
  async (wall, mono) => {
    const f = fixture();
    await f.tracker.sample();
    f.tracker.invalidate();
    f.clock(wall, mono);
    await f.tracker.sample();
    expect(f.observe).toHaveBeenCalledTimes(1);
    f.clock(200000, 0);
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
  },
);

// v0.0.16 PollHealth keeps last_success while backpressured, with poll age zero.
// These Go-shaped fixtures model a newly read historical success; reading it
// after a wall-clock rollback does not date the successful server poll.
it.each(
  [true, false].flatMap((retained) =>
    [
      "expiry",
      "absent",
      "refused",
      "capture-null",
      "capture-error",
      "invalidate",
      "wake",
    ].map((gap) => ({ retained, gap })),
  ),
)(
  "withholds an unseen historical success after rollback (retained=$retained, gap=$gap)",
  async ({ retained, gap }) => {
    const f = fixture();
    if (!retained) f.observe.mockResolvedValueOnce(null);
    await f.tracker.sample();
    f.clock(301000, 101000);
    if (gap === "expiry") f.tracker.view();
    if (gap === "absent") {
      f.observe.mockResolvedValueOnce(null);
      await f.tracker.sample();
    }
    if (gap === "refused") {
      f.observe.mockRejectedValueOnce(Error("refused"));
      await f.tracker.sample();
    }
    if (gap === "capture-null") {
      f.capture.mockReturnValueOnce(null);
      await f.tracker.sample();
    }
    if (gap === "capture-error") {
      f.capture.mockImplementationOnce(() => {
        throw Error("failed");
      });
      await f.tracker.sample();
    }
    if (gap === "invalidate") f.tracker.invalidate();
    if (gap === "wake") {
      f.tracker.suspend();
      f.tracker.resume();
    }
    // The helper succeeded at 209000 before health reads failed, then stayed
    // backpressured. At monotonic 102000 that unseen success is 93 seconds old.
    f.clock(210000, 102000);
    f.observe.mockResolvedValueOnce(
      sampleAt(210000, { lastPollSuccessMillis: "209000" }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
    f.clock(211000, 103000);
    f.observe.mockResolvedValueOnce(
      sampleAt(211000, { lastPollSuccessMillis: "209000" }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
    // A later read sees an actual success after the post-jump baseline read.
    f.clock(212000, 104000);
    f.observe.mockResolvedValueOnce(
      sampleAt(212000, { lastPollSuccessMillis: "211500" }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("recent_transport");
  },
);

it("missing success evidence cannot establish a post-jump advancement baseline", async () => {
  const f = fixture();
  f.observe.mockResolvedValueOnce(null);
  await f.tracker.sample();
  f.clock(210000, 1000);
  f.observe.mockResolvedValueOnce({
    binding,
    expectedInstanceId: "instance",
    sampleAtMillis: "210000",
    observedAtMillis: "210000",
    validUntilMillis: "255000",
    state: "checking",
    reason: "polling_missing",
    localReady: true,
  });
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("checking");
  f.clock(211000, 2000);
  f.observe.mockResolvedValueOnce(
    sampleAt(211000, { lastPollSuccessMillis: "209000" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(212000, 3000);
  f.observe.mockResolvedValueOnce(
    sampleAt(212000, { lastPollSuccessMillis: "211500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
});

it.each([false, true])(
  "fences an in-flight read across observed clock epochs even when endpoints normalize (view=%s)",
  async (viewBeforeSettlement) => {
    const f = fixture();
    await f.tracker.sample();
    f.clock(201000, 1000);
    let release!: (value: ComputerConnectorHealthState) => void;
    f.observe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.tracker.sample();
    f.clock(210000, 2000);
    expect(f.tracker.view().state).toBe("unobserved");
    f.clock(202000, 2000);
    if (viewBeforeSettlement) f.tracker.view();
    release(sampleAt(202000, { lastPollSuccessMillis: "201500" }));
    await pending;
    expect(f.tracker.view().state).toBe("unobserved");
    f.observe.mockResolvedValueOnce(
      sampleAt(202000, { lastPollSuccessMillis: "201500" }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
    f.clock(203000, 3000);
    f.observe.mockResolvedValueOnce(
      sampleAt(203000, { lastPollSuccessMillis: "202500" }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("recent_transport");
  },
);

it("requires new advancement again after each discontinuity", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(210000, 1000);
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  f.clock(211000, 2000);
  f.observe.mockResolvedValueOnce(
    sampleAt(211000, { lastPollSuccessMillis: "210500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
  f.clock(220000, 3000);
  f.observe.mockResolvedValueOnce(
    sampleAt(220000, { lastPollSuccessMillis: "219000" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(221000, 4000);
  f.observe.mockResolvedValueOnce(
    sampleAt(221000, { lastPollSuccessMillis: "219000" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(222000, 5000);
  f.observe.mockResolvedValueOnce(
    sampleAt(222000, { lastPollSuccessMillis: "221500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
});

it("does not seed advancement from snapshots predating request issuance", async () => {
  const f = fixture();
  await f.tracker.sample();
  for (const [wall, mono, observed, success, state] of [
    [210000, 1000, 209500, "209000", "unobserved"],
    [211000, 2000, 210500, "210000", "unobserved"],
    [212000, 3000, 212000, "211500", "unobserved"],
    [213000, 4000, 213000, "212500", "recent_transport"],
  ] as const) {
    f.clock(wall, mono);
    f.observe.mockResolvedValueOnce(
      sampleAt(observed, { lastPollSuccessMillis: success }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe(state);
  }
});

it("does not lend an advancement baseline to a replacement owner with the same runtime identity", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(210000, 1000);
  f.observe.mockResolvedValueOnce(sampleAt(210000));
  await f.tracker.sample();
  f.replaceOwner();
  f.clock(211000, 2000);
  f.observe.mockResolvedValueOnce(
    sampleAt(211000, { lastPollSuccessMillis: "210500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(212000, 3000);
  f.observe.mockResolvedValueOnce(
    sampleAt(212000, { lastPollSuccessMillis: "211500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
});

it("dates advancement after baseline settlement rather than request issuance", async () => {
  const f = fixture();
  await f.tracker.sample();
  f.clock(210000, 1000);
  f.observe.mockImplementationOnce(async () => {
    f.clock(212000, 3000);
    return sampleAt(210000, { lastPollSuccessMillis: "209000" });
  });
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(213000, 4000);
  f.observe.mockResolvedValueOnce(
    sampleAt(213000, { lastPollSuccessMillis: "211500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("unobserved");
  f.clock(214000, 5000);
  f.observe.mockResolvedValueOnce(
    sampleAt(214000, { lastPollSuccessMillis: "213500" }),
  );
  await f.tracker.sample();
  expect(f.tracker.view().state).toBe("recent_transport");
});

it.each(["absent", "refused", "expiry", "invalidate", "wake"] as const)(
  "preserves the post-jump baseline across %s without trusting unseen historical success",
  async (gap) => {
    const f = fixture();
    await f.tracker.sample();
    f.clock(210000, 1000);
    f.observe.mockResolvedValueOnce(sampleAt(210000));
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
    f.clock(260000, 51000);
    if (gap === "absent") {
      f.observe.mockResolvedValueOnce(null);
      await f.tracker.sample();
    }
    if (gap === "refused") {
      f.observe.mockRejectedValueOnce(Error("refused"));
      await f.tracker.sample();
    }
    if (gap === "expiry") f.tracker.view();
    if (gap === "invalidate") f.tracker.invalidate();
    if (gap === "wake") {
      f.tracker.suspend();
      f.tracker.resume();
    }
    f.observe.mockResolvedValueOnce(
      sampleAt(260000, {
        lastPollSuccessMillis: "209000",
        validUntilMillis: "299000",
      }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("unobserved");
    f.clock(261000, 52000);
    f.observe.mockResolvedValueOnce(
      sampleAt(261000, { lastPollSuccessMillis: "260500" }),
    );
    await f.tracker.sample();
    expect(f.tracker.view().state).toBe("recent_transport");
  },
);

it("recovers across fresh capture wrappers with the same inner owner and fences an actual replacement", async () => {
  let wall = 200000,
    mono = 0,
    success = "199000";
  let inner = { owner: {}, connector: {}, core: {} };
  const capture = vi.fn(() => ({ ...inner, binding: { ...binding } }));
  const tracker = new ConnectionStatusTracker({
    capture,
    current: (original) =>
      original.owner === inner.owner &&
      original.connector === inner.connector &&
      original.core === inner.core &&
      Object.entries(binding).every(
        ([key, value]) =>
          original.binding[key as keyof typeof binding] === value,
      ),
    observe: async () => sampleAt(wall, { lastPollSuccessMillis: success }),
    now: () => wall,
    monotonic: () => mono,
  });
  await tracker.sample();
  wall = 210000;
  mono = 1000;
  success = "209000";
  await tracker.sample();
  expect(tracker.view().state).toBe("unobserved");
  wall = 211000;
  mono = 2000;
  await tracker.sample();
  expect(tracker.view().state).toBe("unobserved");
  wall = 212000;
  mono = 3000;
  success = "211500";
  await tracker.sample();
  expect(tracker.view().state).toBe("recent_transport");
  const wrappers = capture.mock.results.map((result) => result.value);
  expect(new Set(wrappers).size).toBe(4);
  expect(new Set(wrappers.map((value) => value.owner)).size).toBe(1);
  expect(new Set(wrappers.map((value) => value.binding)).size).toBe(4);
  inner = { owner: {}, connector: {}, core: {} };
  expect(tracker.view().state).toBe("unobserved");
  wall = 213000;
  mono = 4000;
  success = "212500";
  await tracker.sample();
  expect(tracker.view().state).toBe("unobserved");
  wall = 214000;
  mono = 5000;
  success = "213500";
  await tracker.sample();
  expect(tracker.view().state).toBe("recent_transport");
});
