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

describe("Quit reserves recording inside one absolute budget", () => {
  const startedAt = 1_000_000;
  const overallDeadline = startedAt + 60_000;
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

  function harness(overrides: Partial<QuitDrainPorts> = {}) {
    const receipts: QuitDrainReceipt[] = [];
    const close = vi.fn(async () => undefined);
    const collect = vi.fn(() => [{ name: "original-child", close }]);
    const record = vi.fn(async (receipt: QuitDrainReceipt) => {
      receipts.push(receipt);
    });
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 60_000,
      preparationMs: 10_000,
      recordReserveMs: 2_000,
      collect,
      record,
      quit,
      ...overrides,
    });
    return { drain, receipts, close, collect, record, quit };
  }

  it("caps pending preparation and drains before the original overall deadline", async () => {
    const preparation = deferred<QuitPreparationResult>();
    let context!: QuitPreparationContext;
    const h = harness({
      prepare: (value) => {
        context = value;
        return preparation.promise;
      },
    });
    h.drain.onBeforeQuit({ preventDefault() {} });
    expect(context.deadlineAt).toBe(startedAt + 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.collect).not.toHaveBeenCalled();
    expect(context.canStartEffect()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(context.canStartEffect()).toBe(false);
    expect(h.collect).toHaveBeenCalledWith({
      deadlineAt: overallDeadline - 2_000,
    });
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["preparation"] },
    ]);
    expect(h.quit).toHaveBeenCalledTimes(1);
    preparation.resolve({ status: "accepted" });
    await expect(preparation.promise).resolves.toEqual({ status: "accepted" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "reserves an asynchronous record after a stalled closer (prepare=%s)",
    async (prepare) => {
      const child = deferred<void>();
      const recorded = deferred<void>();
      const close = vi.fn(() => child.promise);
      const records: { at: number; receipt: QuitDrainReceipt }[] = [];
      const h = harness({
        ...(prepare
          ? { prepare: async () => ({ status: "skipped" as const }) }
          : {}),
        collect: () => [{ name: "original-child", close }],
        record: (receipt) => {
          records.push({ at: Date.now(), receipt });
          return recorded.promise;
        },
      });
      h.drain.onBeforeQuit({ preventDefault() {} });
      await vi.advanceTimersByTimeAsync(58_000);
      expect(records).toEqual([
        {
          at: overallDeadline - 2_000,
          receipt: { drained: false, unconfirmed: ["original-child"] },
        },
      ]);
      expect(h.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      recorded.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.quit).toHaveBeenCalledTimes(1);
      expect(Date.now()).toBe(overallDeadline - 1_000);
      child.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(records[0]?.receipt.drained).toBe(false);
    },
  );

  it("retains the overall deadline when the reserved write itself stalls", async () => {
    const h = harness({
      collect: () => [
        {
          name: "stalled-child",
          close: () => new Promise<void>(() => undefined),
        },
      ],
      record: () => new Promise<void>(() => undefined),
    });
    h.drain.onBeforeQuit({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(58_000);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now()).toBe(overallDeadline);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences late preparation work without cancelling its original rejected Promise", async () => {
    const resumed = deferred<void>();
    const dispatch = vi.fn();
    const originalError = new Error("ORIGINAL_PREPARATION_UNKNOWN");
    let original!: Promise<QuitPreparationResult>;
    const h = harness({
      prepare: (context) => {
        if (context.canStartEffect()) dispatch();
        original = (async () => {
          await resumed.promise;
          if (context.canStartEffect()) dispatch();
          throw originalError;
        })();
        return original;
      },
    });
    h.drain.onBeforeQuit({ preventDefault() {} });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.quit).toHaveBeenCalledTimes(1);
    resumed.resolve();
    await expect(original).rejects.toBe(originalError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["preparation"] },
    ]);
  });

  it("charges synchronous collection to the reserved drain deadline without renewing it", async () => {
    const child = deferred<void>();
    const recorded = deferred<void>();
    const h = harness({
      collect: (context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.deadlineAt).toBe(overallDeadline - 2_000);
        vi.setSystemTime(context.deadlineAt);
        return [{ name: "original-child", close: () => child.promise }];
      },
      record: () => recorded.promise,
    });
    h.drain.onBeforeQuit({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.quit).not.toHaveBeenCalled();
    child.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(overallDeadline);
  });

  it("bounds preparation by the earlier drain deadline when the preparation cap is longer", async () => {
    let context!: QuitPreparationContext;
    const h = harness({
      preparationMs: 120_000,
      prepare: (value) => {
        context = value;
        return new Promise<QuitPreparationResult>(() => undefined);
      },
    });
    h.drain.onBeforeQuit({ preventDefault() {} });
    expect(context.deadlineAt).toBe(overallDeadline - 2_000);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(context.canStartEffect()).toBe(false);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["preparation", "original-child"] },
    ]);
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { deadlineMs: -1 },
    { deadlineMs: Number.NaN },
    { deadlineMs: Infinity },
    { recordReserveMs: -1 },
    { recordReserveMs: Number.NaN },
    { recordReserveMs: Infinity },
    { recordReserveMs: 60_001 },
    { preparationMs: -1 },
    { preparationMs: Number.NaN },
    { preparationMs: Infinity },
  ])("refuses invalid budgets before any Quit effect: %j", (overrides) => {
    expect(() => harness(overrides)).toThrow("QUIT_BUDGET_INVALID");
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

  it("reserves recording time even when preparation and child drain time out", async () => {
    const recorded = deferred<void>();
    const collect = vi.fn(() => [
      { name: "stalled-child", close: () => new Promise<void>(() => {}) },
    ]);
    let context!: QuitPreparationContext;
    const h = harness({
      preparationMs: 3_000,
      recordReserveMs: 1_000,
      prepare: (value) => {
        context = value;
        return new Promise(() => {});
      },
      collect,
      record: () => recorded.promise,
    });
    h.drain.onBeforeQuit(event());
    expect(context.deadlineAt).toBe(startedAt + 3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.canStartEffect()).toBe(false);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.drain.state()).toBe("draining");
    await vi.advanceTimersByTimeAsync(500);
    recorded.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(startedAt + 9_500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled recorder at the original deadline without confirming late child completion", async () => {
    const child = deferred<void>();
    const record = vi.fn(() => new Promise<void>(() => {}));
    const h = harness({
      recordReserveMs: 1_000,
      collect: () => [{ name: "late-child", close: () => child.promise }],
      record,
    });
    h.drain.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(9_000);
    expect(record).toHaveBeenCalledWith({
      drained: false,
      unconfirmed: ["late-child"],
    });
    expect(h.quit).not.toHaveBeenCalled();
    child.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-1, 10_001, NaN, Infinity])(
    "rejects invalid receipt reserve %s",
    (recordReserveMs) => {
      expect(() => harness({ recordReserveMs })).toThrow("QUIT_BUDGET_INVALID");
    },
  );

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

describe("Quit claim steps and stage observation (0.5.27 stabilization)", () => {
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it("latches every claim step before the first synchronous preparation step", async () => {
    const order: string[] = [];
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 1_000,
      onClaim: [
        { name: "admission", run: () => order.push("admission") },
        { name: "start", run: () => order.push("start") },
      ],
      prepare: (context) => {
        order.push(`prepare:${context.canStartEffect()}`);
        return Promise.resolve({ status: "skipped" });
      },
      collect: () => {
        order.push("collect");
        return [];
      },
      record: async () => undefined,
      quit,
    });
    const event = { preventDefault: vi.fn() };
    drain.onBeforeQuit(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(order.slice(0, 3)).toEqual(["admission", "start", "prepare:true"]);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(order).toEqual(["admission", "start", "prepare:true", "collect"]);
  });

  it("still drains when a claim step throws and records it as unconfirmed", async () => {
    const receipts: QuitDrainReceipt[] = [];
    const closed = vi.fn(async () => undefined);
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 1_000,
      onClaim: [
        {
          name: "transport-watch",
          run: () => {
            throw new Error("closed twice");
          },
        },
        { name: "admission", run: () => undefined },
      ],
      collect: () => [{ name: "connector", close: closed }],
      record: async (receipt) => void receipts.push(receipt),
      quit,
    });
    drain.onBeforeQuit({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(closed).toHaveBeenCalledOnce();
    expect(receipts).toEqual([
      { drained: false, unconfirmed: ["claim:transport-watch"] },
    ]);
  });

  it("runs claim steps once and reports a re-entrant Quit without restarting", async () => {
    const admission = vi.fn();
    const stages: string[] = [];
    let release!: () => void;
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 1_000,
      onClaim: [{ name: "admission", run: admission }],
      collect: () => [
        {
          name: "connector",
          close: () => new Promise<void>((r) => (release = r)),
        },
      ],
      record: async () => undefined,
      quit,
      observe: (stage) => stages.push(stage.stage),
    });
    drain.onBeforeQuit({ preventDefault: () => undefined });
    drain.onBeforeQuit({ preventDefault: () => undefined });
    expect(admission).toHaveBeenCalledOnce();
    expect(stages).toContain("second-quit");
    release();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it("confirms two closers that share a name separately", async () => {
    let releaseSecond!: () => void;
    const receipt = await drainOwnedChildren(
      [
        { name: "host-check", close: async () => undefined },
        {
          name: "host-check",
          close: () => new Promise<void>((r) => (releaseSecond = r)),
        },
      ],
      30,
    );
    releaseSecond?.();
    expect(receipt).toEqual({ drained: false, unconfirmed: ["host-check"] });
  });

  it("emits the full stage sequence and survives a throwing observer", async () => {
    const stages: string[] = [];
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 1_000,
      prepare: async () => ({ status: "skipped" }),
      collect: () => [
        { name: "connector", close: async () => undefined },
        {
          name: "go-core",
          close: async () => {
            throw new Error("unconfirmed");
          },
        },
      ],
      record: async () => undefined,
      quit,
      observe: (stage) => {
        stages.push(
          stage.stage === "closer-end"
            ? `closer-end:${stage.name}:${stage.result}`
            : stage.stage === "record-end"
              ? `record-end:${stage.result}`
              : stage.stage,
        );
        throw new Error("observer bug");
      },
    });
    drain.onBeforeQuit({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    await flush();
    expect(stages).toEqual([
      "drain-entered",
      "preparation-begin",
      "preparation-end",
      "collect-end",
      "closer-begin",
      "closer-begin",
      "closer-end:connector:confirmed",
      "closer-end:go-core:failed",
      "drain-end",
      "record-begin",
      "record-end:recorded",
      "exit-requested",
    ]);
  });

  it("marks a recorder that outlives the budget as timed out and still quits", async () => {
    vi.useFakeTimers();
    try {
      const outcomes: string[] = [];
      const quit = vi.fn();
      const drain = createQuitDrain({
        deadlineMs: 100,
        collect: () => [],
        record: () => new Promise<void>(() => undefined),
        quit,
        observe: (stage) => {
          if (stage.stage === "record-end") outcomes.push(stage.result);
        },
      });
      drain.onBeforeQuit({ preventDefault: () => undefined });
      await vi.advanceTimersByTimeAsync(150);
      expect(quit).toHaveBeenCalledOnce();
      expect(outcomes).toEqual(["timed-out"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a hung closer one terminal timeout before recording and reports a late finish separately", async () => {
    vi.useFakeTimers();
    try {
      const stages: string[] = [];
      let release!: () => void;
      const quit = vi.fn();
      const drain = createQuitDrain({
        deadlineMs: 100,
        collect: () => [
          {
            name: "connector",
            close: () => new Promise<void>((r) => (release = r)),
          },
        ],
        record: async () => undefined,
        quit,
        observe: (stage) =>
          stages.push(
            stage.stage === "closer-end"
              ? `closer-end:${stage.result}`
              : stage.stage,
          ),
      });
      drain.onBeforeQuit({ preventDefault: () => undefined });
      await vi.advanceTimersByTimeAsync(150);
      expect(quit).toHaveBeenCalledOnce();
      const timedOut = stages.indexOf("closer-end:timed-out");
      expect(timedOut).toBeGreaterThan(-1);
      expect(timedOut).toBeLessThan(stages.indexOf("record-begin"));
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(stages.filter((s) => s.startsWith("closer-end"))).toEqual([
        "closer-end:timed-out",
      ]);
      expect(stages.at(-1)).toBe("closer-late");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one terminal recorder result when the recorder finishes after the budget", async () => {
    vi.useFakeTimers();
    try {
      const stages: string[] = [];
      let release!: () => void;
      const quit = vi.fn();
      const drain = createQuitDrain({
        deadlineMs: 100,
        collect: () => [],
        record: () => new Promise<void>((r) => (release = r)),
        quit,
        observe: (stage) =>
          stages.push(
            stage.stage === "record-end"
              ? `record-end:${stage.result}`
              : stage.stage,
          ),
      });
      drain.onBeforeQuit({ preventDefault: () => undefined });
      await vi.advanceTimersByTimeAsync(150);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(stages.filter((s) => s.startsWith("record-end"))).toEqual([
        "record-end:timed-out",
      ]);
      expect(stages).toContain("record-late");
      expect(quit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a recorder that settles after the deadline as timed out while the timer is still pending", async () => {
    vi.useFakeTimers();
    try {
      const stages: string[] = [];
      let release!: () => void;
      const drain = createQuitDrain({
        deadlineMs: 100,
        collect: () => [],
        record: () => new Promise<void>((r) => (release = r)),
        quit: () => undefined,
        observe: (stage) =>
          stages.push(
            stage.stage === "record-end"
              ? `record-end:${stage.result}`
              : stage.stage,
          ),
      });
      drain.onBeforeQuit({ preventDefault: () => undefined });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(stages).toContain("record-begin");
      // Move the clock past the deadline without running the overdue timer.
      vi.setSystemTime(Date.now() + 101);
      release();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(stages.filter((s) => s.startsWith("record-end"))).toEqual([
        "record-end:timed-out",
      ]);
      expect(stages.slice(-3)).toEqual([
        "record-end:timed-out",
        "record-late",
        "exit-requested",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["fulfilled", "rejected"] as const)(
    "reports preparation %s after its deadline as one timeout plus a late event",
    async (settlement) => {
      vi.useFakeTimers();
      try {
        const stages: string[] = [];
        let fulfil!: (value: { status: "accepted" }) => void;
        let reject!: (error: Error) => void;
        const drain = createQuitDrain({
          deadlineMs: 1_000,
          preparationMs: 100,
          prepare: () =>
            new Promise((resolve, no) => {
              fulfil = resolve;
              reject = no;
            }),
          collect: () => [],
          record: async () => undefined,
          quit: () => undefined,
          observe: (stage) =>
            stages.push(
              stage.stage === "preparation-end"
                ? `preparation-end:${stage.result}`
                : stage.stage,
            ),
        });
        drain.onBeforeQuit({ preventDefault: () => undefined });
        vi.setSystemTime(Date.now() + 150);
        if (settlement === "fulfilled") fulfil({ status: "accepted" });
        else reject(new Error("late"));
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(stages.filter((s) => s.startsWith("preparation-"))).toEqual([
          "preparation-begin",
          "preparation-end:timed-out",
          "preparation-late",
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["fulfilled", "rejected"] as const)(
    "keeps the late preparation event when the timer wins and the attempt then %s",
    async (settlement) => {
      vi.useFakeTimers();
      try {
        const stages: string[] = [];
        const receipts: QuitDrainReceipt[] = [];
        let fulfil!: (value: { status: "accepted" }) => void;
        let reject!: (error: Error) => void;
        const drain = createQuitDrain({
          deadlineMs: 1_000,
          preparationMs: 100,
          prepare: () =>
            new Promise((resolve, no) => {
              fulfil = resolve;
              reject = no;
            }),
          collect: () => [],
          record: async (receipt) => void receipts.push(receipt),
          quit: () => undefined,
          observe: (stage) =>
            stages.push(
              stage.stage === "preparation-end"
                ? `preparation-end:${stage.result}`
                : stage.stage,
            ),
        });
        drain.onBeforeQuit({ preventDefault: () => undefined });
        // Fire the timer, then settle before the race continuation runs.
        vi.advanceTimersByTime(100);
        if (settlement === "fulfilled") fulfil({ status: "accepted" });
        else reject(new Error("late"));
        await vi.advanceTimersByTimeAsync(10);
        expect(stages.filter((s) => s.startsWith("preparation-"))).toEqual([
          "preparation-begin",
          "preparation-end:timed-out",
          "preparation-late",
        ]);
        expect(receipts[0]?.unconfirmed).toContain("preparation");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["fulfilled", "rejected"] as const)(
    "reports a closer %s after the deadline as one timeout plus closer-late while the timer is pending",
    async (settlement) => {
      vi.useFakeTimers();
      try {
        const stages: string[] = [];
        let fulfil!: () => void;
        let reject!: (error: Error) => void;
        const pending = drainOwnedChildren(
          [
            {
              name: "connector",
              close: () =>
                new Promise<void>((resolve, no) => {
                  fulfil = resolve;
                  reject = no;
                }),
            },
          ],
          1_000,
          Date.now() + 100,
          (stage) =>
            stages.push(
              stage.stage === "closer-end"
                ? `closer-end:${stage.result}`
                : stage.stage,
            ),
        );
        vi.setSystemTime(Date.now() + 150);
        if (settlement === "fulfilled") fulfil();
        else reject(new Error("late"));
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await pending).toEqual({
          drained: false,
          unconfirmed: ["connector"],
        });
        expect(stages).toEqual([
          "closer-begin",
          "closer-end:timed-out",
          "closer-late",
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["accepted", "skipped", "blocked"] as const)(
    "keeps preparation unconfirmed when %s settles before the deadline but the drain resumes after it",
    async (status) => {
      vi.useFakeTimers();
      try {
        const stages: string[] = [];
        const receipts: QuitDrainReceipt[] = [];
        let fulfil!: (value: { status: typeof status }) => void;
        const drain = createQuitDrain({
          deadlineMs: 1_000,
          preparationMs: 100,
          prepare: () => new Promise((resolve) => (fulfil = resolve)),
          collect: () => [],
          record: async (receipt) => void receipts.push(receipt),
          quit: () => undefined,
          observe: (stage) =>
            stages.push(
              stage.stage === "preparation-end"
                ? `preparation-end:${stage.result}`
                : stage.stage,
            ),
        });
        drain.onBeforeQuit({ preventDefault: () => undefined });
        vi.setSystemTime(Date.now() + 90);
        fulfil({ status });
        // Let the settlement be observed, then cross the deadline before the
        // drain's continuation runs.
        await Promise.resolve();
        vi.setSystemTime(Date.now() + 20);
        await vi.advanceTimersByTimeAsync(10);
        expect(receipts[0]?.unconfirmed).toContain("preparation");
        expect(stages).toContain("preparation-end:timed-out");
        expect(stages).not.toContain(`preparation-end:${status}`);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["fulfilled", "rejected"] as const)(
    "times out a closer whose timer fires in the same turn it %s (relative deadline)",
    async (settlement) => {
      vi.useFakeTimers();
      try {
        const results: string[] = [];
        let fulfil!: () => void;
        let reject!: (error: Error) => void;
        const pending = drainOwnedChildren(
          [
            {
              name: "connector",
              close: () =>
                new Promise<void>((resolve, no) => {
                  fulfil = resolve;
                  reject = no;
                }),
            },
          ],
          100,
          undefined,
          (stage) => {
            if (stage.stage === "closer-end") results.push(stage.result);
            if (stage.stage === "closer-late") results.push("late");
          },
        );
        vi.advanceTimersByTime(100);
        if (settlement === "fulfilled") fulfil();
        else reject(new Error("late"));
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual({
          drained: false,
          unconfirmed: ["connector"],
        });
        expect(results).toEqual(["timed-out", "late"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reports zero-budget closers as timed out and then late when they finish", async () => {
    vi.useFakeTimers();
    try {
      const stages: string[] = [];
      const receipts: QuitDrainReceipt[] = [];
      let release!: () => void;
      const drain = createQuitDrain({
        deadlineMs: 100,
        collect: () => {
          // Collection spends the whole remaining budget.
          vi.setSystemTime(Date.now() + 200);
          return [
            {
              name: "connector",
              close: () => new Promise<void>((r) => (release = r)),
            },
          ];
        },
        record: async (receipt) => void receipts.push(receipt),
        quit: () => undefined,
        observe: (stage) =>
          stages.push(
            stage.stage === "closer-end"
              ? `closer-end:${stage.result}`
              : stage.stage,
          ),
      });
      drain.onBeforeQuit({ preventDefault: () => undefined });
      await vi.advanceTimersByTimeAsync(1);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(receipts[0]).toEqual({
        drained: false,
        unconfirmed: ["connector"],
      });
      expect(stages.filter((s) => s.startsWith("closer-"))).toEqual([
        "closer-begin",
        "closer-end:timed-out",
        "closer-late",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the preparation status exactly once", async () => {
    let reads = 0;
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 1_000,
      prepare: () =>
        Promise.resolve({
          get status() {
            reads++;
            return "accepted" as const;
          },
        }),
      collect: () => [],
      record: async () => undefined,
      quit,
    });
    drain.onBeforeQuit({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(reads).toBe(1);
  });

  it("treats a throwing status getter as an unconfirmed preparation without an unhandled rejection", async () => {
    const receipts: QuitDrainReceipt[] = [];
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const quit = vi.fn();
      const drain = createQuitDrain({
        deadlineMs: 1_000,
        prepare: () =>
          Promise.resolve({
            get status(): "accepted" {
              throw new Error("getter");
            },
          }),
        collect: () => [],
        record: async (receipt) => void receipts.push(receipt),
        quit,
      });
      drain.onBeforeQuit({ preventDefault: () => undefined });
      await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
      await new Promise((r) => setImmediate(r));
      expect(receipts[0]?.unconfirmed).toContain("preparation");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("closes the preparation fence before the terminal event is observed", async () => {
    let fenceAtEnd: boolean | undefined;
    let context!: QuitPreparationContext;
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 1_000,
      prepare: (value) => {
        context = value;
        return Promise.resolve({ status: "skipped" });
      },
      collect: () => [],
      record: async () => undefined,
      quit,
      observe: (stage) => {
        if (stage.stage === "preparation-end")
          fenceAtEnd = context.canStartEffect();
      },
    });
    drain.onBeforeQuit({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(fenceAtEnd).toBe(false);
  });

  it("starts recording in the drain's own continuation, without an extra turn", async () => {
    const order: string[] = [];
    let releaseCloser!: () => void;
    const quit = vi.fn();
    const drain = createQuitDrain({
      deadlineMs: 1_000,
      onClaim: [
        {
          name: "watch",
          run: () => {
            throw new Error("claim");
          },
        },
      ],
      collect: () => [
        {
          name: "connector",
          close: () => new Promise<void>((r) => (releaseCloser = r)),
        },
      ],
      record: async () => void order.push("record"),
      quit,
    });
    drain.onBeforeQuit({ preventDefault: () => undefined });
    await Promise.resolve();
    releaseCloser();
    // Count the turns between the drain settling and recording starting.
    let turns = 0;
    while (!order.includes("record") && turns < 20) {
      await Promise.resolve();
      turns++;
    }
    expect(order).toContain("record");
    // The same number of turns as the baseline drain: recording begins in
    // the continuation that receives the drain result.
    expect(turns).toBe(5);
  });
});
