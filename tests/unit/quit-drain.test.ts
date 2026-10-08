import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createQuitDrain,
  drainOwnedChildren,
  type OwnedCloser,
  type QuitDrainPorts,
  type QuitDrainReceipt,
  type QuitPreparationContext,
  type QuitPreparationResult,
} from "../../src/apps/desktop/quit-drain";

describe("LIF-09 quit drains owned children before claiming they stopped", () => {
  it("reports drained only when every child confirmed its exit", async () => {
    await expect(
      drainOwnedChildren(
        [
          { name: "agent-host", close: async () => undefined },
          { name: "route-b", close: async () => undefined },
        ],
        1_000,
      ),
    ).resolves.toEqual({ drained: true, unconfirmed: [] });
  });

  it("names a child that ignores termination or fails to close", async () => {
    const receipt = await drainOwnedChildren(
      [
        { name: "agent-host", close: () => new Promise<void>(() => undefined) },
        {
          name: "relay",
          close: async () => {
            throw new Error("CODEX_APP_SERVER_SHUTDOWN_UNCONFIRMED");
          },
        },
        { name: "route-b", close: async () => undefined },
      ],
      20,
    );

    expect(receipt).toEqual({
      drained: false,
      unconfirmed: ["agent-host", "relay"],
    });
  });

  describe("LIF-09/Q-08 quit as the product composes it", () => {
    function event() {
      let prevented = 0;
      return {
        preventDefault: () => {
          prevented += 1;
        },
        prevented: () => prevented,
      };
    }

    it("holds the first quit, drains every child collected once, records the receipt, then quits for real", async () => {
      const closed: string[] = [];
      let releaseLate!: () => void;
      const late = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      const registered: OwnedCloser[] = [
        {
          name: "host-check",
          close: async () => {
            closed.push("host-check");
          },
        },
        {
          name: "product-agent",
          close: async () => {
            await late;
            closed.push("product-agent");
          },
        },
      ];
      const receipts: unknown[] = [];
      let quits = 0;
      let collects = 0;
      const drain = createQuitDrain({
        deadlineMs: 5_000,
        collect: () => {
          collects += 1;
          return [...registered];
        },
        record: async (receipt) => {
          receipts.push(receipt);
        },
        quit: () => {
          quits += 1;
        },
      });
      const first = event();
      drain.onBeforeQuit(first);
      expect(first.prevented()).toBe(1);
      expect(drain.state()).toBe("draining");
      // A child that unregisters itself while quit is under way is still
      // drained: the set was read once.
      registered.length = 0;
      // A second quit while draining is held too and starts nothing new.
      const second = event();
      drain.onBeforeQuit(second);
      expect(second.prevented()).toBe(1);
      expect(collects).toBe(1);
      expect(quits).toBe(0);
      releaseLate();
      await vi.waitFor(() => expect(drain.state()).toBe("done"));
      expect(closed).toEqual(["host-check", "product-agent"]);
      expect(receipts).toEqual([{ drained: true, unconfirmed: [] }]);
      expect(quits).toBe(1);
      // After the drain the real quit is not intercepted.
      const third = event();
      drain.onBeforeQuit(third);
      expect(third.prevented()).toBe(0);
      expect(quits).toBe(1);
    });

    it("names a child that failed to close or outlived the deadline, records that, and still quits", async () => {
      const receipts: unknown[] = [];
      let quits = 0;
      const drain = createQuitDrain({
        deadlineMs: 20,
        collect: () => [
          {
            name: "route-b",
            close: async () => undefined,
          },
          {
            name: "connector",
            close: async () => {
              throw new Error("CONNECTOR_STOP_FAILED");
            },
          },
          {
            name: "agent-check",
            close: () => new Promise<void>(() => undefined),
          },
        ],
        record: async (receipt) => {
          receipts.push(receipt);
        },
        quit: () => {
          quits += 1;
        },
      });
      drain.onBeforeQuit(event());
      await vi.waitFor(() => expect(drain.state()).toBe("done"));
      expect(receipts).toEqual([
        { drained: false, unconfirmed: ["connector", "agent-check"] },
      ]);
      expect(quits).toBe(1);
    });

    it("quits no later than the drain deadline even when the receipt record never settles", async () => {
      let quits = 0;
      const startedAt = Date.now();
      let quitAt = 0;
      const drain = createQuitDrain({
        deadlineMs: 30,
        collect: () => [{ name: "route-b", close: async () => undefined }],
        record: () => new Promise<void>(() => undefined),
        quit: () => {
          quits += 1;
          quitAt = Date.now() - startedAt;
        },
      });
      drain.onBeforeQuit(event());
      await vi.waitFor(() => expect(drain.state()).toBe("done"), {
        timeout: 500,
      });
      expect(quits).toBe(1);
      expect(quitAt).toBeLessThan(300);
    });

    it("quits even when the diagnostic receipt cannot be written", async () => {
      let quits = 0;
      const drain = createQuitDrain({
        deadlineMs: 1_000,
        collect: () => [{ name: "route-b", close: async () => undefined }],
        record: async () => {
          throw new Error("EROFS");
        },
        quit: () => {
          quits += 1;
        },
      });
      drain.onBeforeQuit(event());
      await vi.waitFor(() => expect(drain.state()).toBe("done"));
      expect(quits).toBe(1);
    });

    it("records an unconfirmed drain and quits when collecting owned children throws", async () => {
      const receipts: unknown[] = [];
      let collects = 0;
      let quits = 0;
      const drain = createQuitDrain({
        deadlineMs: 1_000,
        collect: () => {
          collects += 1;
          throw new Error("OWNED_CHILD_DISPOSAL_FAILED");
        },
        record: async (receipt) => {
          receipts.push(receipt);
        },
        quit: () => {
          quits += 1;
        },
      });
      const first = event();
      expect(() => drain.onBeforeQuit(first)).not.toThrow();
      expect(first.prevented()).toBe(1);
      const second = event();
      drain.onBeforeQuit(second);
      expect(second.prevented()).toBe(1);
      await vi.waitFor(() => expect(drain.state()).toBe("done"));
      expect(collects).toBe(1);
      expect(receipts).toEqual([
        { drained: false, unconfirmed: ["collection"] },
      ]);
      expect(quits).toBe(1);
      const final = event();
      drain.onBeforeQuit(final);
      expect(final.prevented()).toBe(0);
    });
  });
});

describe("normal Quit preparation shares the original absolute drain budget", () => {
  const startedAt = 1_000_000;
  const deadlineAt = startedAt + 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
  });
  afterEach(() => vi.useRealTimers());

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  function event() {
    return { preventDefault: vi.fn() };
  }

  function harness(overrides: Partial<QuitDrainPorts> = {}) {
    const receipts: QuitDrainReceipt[] = [];
    const close = vi.fn(async () => undefined);
    const collect = vi.fn(() => [{ name: "actual-child", close }]);
    const record = vi.fn(async (receipt: QuitDrainReceipt) => {
      receipts.push(receipt);
    });
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 10_000,
      collect,
      record,
      quit,
      ...overrides,
    });
    return { drain, receipts, close, collect, record, quit };
  }

  it.each(["accepted", "skipped", "blocked"] as const)(
    "collects after %s preparation and closes the effect fence before collection",
    async (status) => {
      const preparation = deferred<QuitPreparationResult>();
      let context!: QuitPreparationContext;
      const prepare = vi.fn((value: QuitPreparationContext) => {
        context = value;
        return preparation.promise;
      });
      const close = vi.fn(async () => undefined);
      const collect = vi.fn(() => {
        expect(context.canStartEffect()).toBe(false);
        return [{ name: "actual-child", close }];
      });
      const h = harness({ prepare, collect });
      h.drain.onBeforeQuit(event());
      expect(context.deadlineAt).toBe(deadlineAt);
      expect(context.canStartEffect()).toBe(true);
      expect(collect).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_500);
      preparation.resolve({ status });
      await vi.advanceTimersByTimeAsync(0);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(collect).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(h.receipts).toEqual([{ drained: true, unconfirmed: [] }]);
      expect(h.quit).toHaveBeenCalledTimes(1);
      expect(h.drain.state()).toBe("done");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves a settled unknown on the original promise without retry or a clean receipt", async () => {
    const result = {
      status: "unknown" as const,
      code: "UPDATE_HANDOFF_UNKNOWN",
    };
    const original = Promise.resolve(result);
    const prepare = vi.fn(() => original);
    const h = harness({ prepare });
    h.drain.onBeforeQuit(event());
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare.mock.results[0]?.value).toBe(original);
    await expect(original).resolves.toBe(result);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["preparation"] },
    ]);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.quit).toHaveBeenCalledTimes(1);
    const final = event();
    h.drain.onBeforeQuit(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it.each(["throw", "reject"])(
    "still collects and quits with unconfirmed preparation on a hook %s",
    async (fault) => {
      const h = harness({
        prepare: () => {
          if (fault === "throw") throw new Error("PREPARATION_OUTCOME_UNKNOWN");
          return Promise.reject(new Error("PREPARATION_OUTCOME_UNKNOWN"));
        },
      });
      expect(() => h.drain.onBeforeQuit(event())).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.collect).toHaveBeenCalledTimes(1);
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(h.receipts).toEqual([
        { drained: false, unconfirmed: ["preparation"] },
      ]);
      expect(h.quit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["accepted", "unknown", "reject"] as const)(
    "bounds pending preparation without rewriting its late %s result or confirming late child exits",
    async (lateOutcome) => {
      const preparation = deferred<QuitPreparationResult>();
      const settled = vi.fn();
      void preparation.promise.then(settled, settled);
      let context!: QuitPreparationContext;
      const prepare = vi.fn((value: QuitPreparationContext) => {
        context = value;
        return preparation.promise;
      });
      const h = harness({ prepare });
      h.drain.onBeforeQuit(event());
      await vi.advanceTimersByTimeAsync(9_999);
      h.drain.onBeforeQuit(event());
      expect(context.deadlineAt).toBe(deadlineAt);
      expect(h.collect).not.toHaveBeenCalled();
      expect(h.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(context.canStartEffect()).toBe(false);
      expect(Date.now()).toBe(deadlineAt);
      expect(h.drain.state()).toBe("done");
      expect(h.collect).toHaveBeenCalledTimes(1);
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(h.receipts).toEqual([
        { drained: false, unconfirmed: ["preparation", "actual-child"] },
      ]);
      expect(h.quit).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();
      expect(prepare.mock.results[0]?.value).toBe(preparation.promise);
      if (lateOutcome === "reject")
        preparation.reject(new Error("LATE_PREPARATION_UNKNOWN"));
      else preparation.resolve({ status: lateOutcome });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(h.record).toHaveBeenCalledTimes(1);
      expect(h.receipts[0]?.drained).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("fences a hook that resumes late without cancelling a helper dispatched in time", async () => {
    const resumed = deferred<void>();
    const dispatch = vi.fn();
    const helperCompleted = vi.fn();
    let original!: Promise<QuitPreparationResult>;
    const prepare = vi.fn((context: QuitPreparationContext) => {
      if (context.canStartEffect()) dispatch();
      original = (async () => {
        await resumed.promise;
        helperCompleted();
        // The hook must recheck this immediately before any new effect.
        if (context.canStartEffect()) dispatch();
        return { status: "accepted" as const };
      })();
      return original;
    });
    const h = harness({ prepare });
    h.drain.onBeforeQuit(event());
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(helperCompleted).not.toHaveBeenCalled();
    h.drain.onBeforeQuit(event());
    resumed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(original).resolves.toEqual({ status: "accepted" });
    expect(helperCompleted).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.receipts[0]?.drained).toBe(false);
  });

  it("closes the fence by absolute time even before a delayed timeout callback runs", async () => {
    const preparation = deferred<QuitPreparationResult>();
    let context!: QuitPreparationContext;
    const h = harness({
      prepare: (value) => {
        context = value;
        return preparation.promise;
      },
    });
    h.drain.onBeforeQuit(event());
    vi.setSystemTime(deadlineAt);
    expect(context.canStartEffect()).toBe(false);
    preparation.resolve({ status: "accepted" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["preparation", "actual-child"] },
    ]);
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it("claims preparation before synchronous reentry and allows the final Quit through", async () => {
    const preparation = deferred<QuitPreparationResult>();
    const reentrant = event();
    const prepare = vi.fn(() => {
      expect(h.drain.state()).toBe("draining");
      h.drain.onBeforeQuit(reentrant);
      return preparation.promise;
    });
    const h = harness({ prepare });
    const first = event();
    h.drain.onBeforeQuit(first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(reentrant.preventDefault).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    preparation.resolve({ status: "skipped" });
    await vi.advanceTimersByTimeAsync(0);
    const final = event();
    h.drain.onBeforeQuit(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("gives child drain only the time remaining after preparation", async () => {
    const preparation = deferred<QuitPreparationResult>();
    const child = deferred<void>();
    const close = vi.fn(() => child.promise);
    const h = harness({
      prepare: () => preparation.promise,
      collect: () => [{ name: "actual-child", close }],
    });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(7_000);
    preparation.resolve({ status: "accepted" });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["actual-child"] },
    ]);
    child.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipts[0]?.drained).toBe(false);
  });

  it("charges collection time to the same budget and cannot confirm an exit at the deadline", async () => {
    const child = deferred<void>();
    const h = harness({
      prepare: async () => ({ status: "accepted" }),
      collect: () => {
        vi.setSystemTime(deadlineAt - 1);
        return [{ name: "actual-child", close: () => child.promise }];
      },
    });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(deadlineAt);
    child.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["actual-child"] },
    ]);
  });

  it("shares receipt time with preparation and drain without granting a fresh write budget", async () => {
    const preparation = deferred<QuitPreparationResult>();
    const child = deferred<void>();
    const recorded = deferred<void>();
    const record = vi.fn(() => recorded.promise);
    const h = harness({
      prepare: () => preparation.promise,
      collect: () => [{ name: "actual-child", close: () => child.promise }],
      record,
    });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(2_000);
    preparation.resolve({ status: "accepted" });
    await vi.advanceTimersByTimeAsync(3_000);
    child.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledWith({ drained: true, unconfirmed: [] });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now()).toBe(deadlineAt);
    expect(h.quit).toHaveBeenCalledTimes(1);
    recorded.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait for recording when pending preparation spent the whole budget", async () => {
    const h = harness({
      prepare: () => new Promise<QuitPreparationResult>(() => undefined),
      record: () => new Promise<void>(() => undefined),
    });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips preparation on an expired budget, invokes actual closers, and does not fake confirmation", async () => {
    const prepare = vi.fn(async () => ({ status: "accepted" as const }));
    const h = harness({ deadlineMs: 0, prepare });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["actual-child"] },
    ]);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves both unknown preparation and failed collection in the existing receipt", async () => {
    const h = harness({
      prepare: async () => ({ status: "unknown" }),
      collect: () => {
        throw new Error("COLLECTION_UNCONFIRMED");
      },
    });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["preparation", "collection"] },
    ]);
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it("counts synchronous preparation against the deadline and closes its fence without waiting for its promise", async () => {
    const preparation = deferred<QuitPreparationResult>();
    let context!: QuitPreparationContext;
    const h = harness({
      prepare: (value) => {
        context = value;
        vi.setSystemTime(deadlineAt);
        return preparation.promise;
      },
    });
    h.drain.onBeforeQuit(event());
    expect(context.canStartEffect()).toBe(false);
    // The original attempt is still pending; expiry cannot depend on its ACK
    // or on the timeout callback being serviced after synchronous hook work.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["preparation", "actual-child"] },
    ]);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts synchronous closer time before starting its remaining drain timer", async () => {
    const h = harness({
      prepare: async () => ({ status: "accepted" }),
      collect: () => [
        {
          name: "actual-child",
          close: () => {
            vi.setSystemTime(deadlineAt - 1_000);
            return new Promise<void>(() => undefined);
          },
        },
      ],
    });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now()).toBe(deadlineAt);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["actual-child"] },
    ]);
  });

  it("counts synchronous receipt time before starting its remaining write timer", async () => {
    const record = vi.fn(() => {
      vi.setSystemTime(deadlineAt - 1_000);
      return new Promise<void>(() => undefined);
    });
    const h = harness({
      prepare: async () => ({ status: "accepted" }),
      record,
    });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now()).toBe(deadlineAt);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
