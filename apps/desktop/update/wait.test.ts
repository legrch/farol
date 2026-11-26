import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelaunchWait } from "./wait";

const TIMEOUT = "UPDATE_RELAUNCH_TIMEOUT";

// A clock the tests move by hand, so the boundary is exact rather than timed.
const clock = (start = 1000) => {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
};

const wait = (
  options: Parameters<typeof createRelaunchWait>[0],
  c = clock(),
  pause: (ms: number) => Promise<void> = async () => undefined,
) => ({
  c,
  pause: vi.fn(pause),
  build() {
    return createRelaunchWait(options, { now: c.now, pause: this.pause });
  },
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("relaunch wait configuration", () => {
  it("defaults to a 30 s budget and a 50 ms interval", async () => {
    const w = wait({});
    const built = w.build();
    expect(built.intervalMs).toBe(50);
    expect(built.begin().remaining()).toBe(30000);
  });

  it("accepts the inclusive limits", () => {
    expect(() => wait({ timeoutMs: 1, intervalMs: 1 }).build()).not.toThrow();
    expect(() =>
      wait({ timeoutMs: 60000, intervalMs: 1000 }).build(),
    ).not.toThrow();
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 60001 },
    { timeoutMs: 1.5 },
    { timeoutMs: Number.NaN },
    { timeoutMs: -5 },
    { intervalMs: 0 },
    { intervalMs: 1001 },
    { intervalMs: 0.5 },
    { intervalMs: Number.POSITIVE_INFINITY },
  ])("refuses the deadline %j", (options) => {
    expect(() => wait(options).build()).toThrow(
      "UPDATE_RELAUNCH_DEADLINE_INVALID",
    );
  });
});

describe("relaunch wait budget", () => {
  it("rounds the remaining budget up and times out at zero", () => {
    const w = wait({ timeoutMs: 100 });
    const budget = w.build().begin();
    expect(budget.remaining()).toBe(100);
    w.c.advance(0.4);
    expect(budget.remaining()).toBe(100);
    w.c.advance(98.6);
    expect(budget.remaining()).toBe(1);
    w.c.advance(1);
    expect(() => budget.remaining()).toThrow(TIMEOUT);
    w.c.advance(500);
    expect(() => budget.remaining()).toThrow(TIMEOUT);
  });

  it("gives every observation a fresh budget", () => {
    const w = wait({ timeoutMs: 100 });
    const built = w.build();
    const first = built.begin();
    w.c.advance(100);
    expect(() => first.remaining()).toThrow(TIMEOUT);
    expect(built.begin().remaining()).toBe(100);
  });

  it("returns a read that finishes inside the budget and clears its timer", async () => {
    const w = wait({ timeoutMs: 100 });
    const budget = w.build().begin();
    await expect(budget.bounded(async () => "value")).resolves.toBe("value");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a read that outlives the budget at its exact boundary", async () => {
    const w = wait({ timeoutMs: 100 });
    const budget = w.build().begin();
    const pending = budget.bounded(() => new Promise<never>(() => undefined));
    const settled = vi.fn();
    pending.catch(settled);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toThrow(TIMEOUT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses to start a read once the budget is spent", async () => {
    const w = wait({ timeoutMs: 100 });
    const budget = w.build().begin();
    w.c.advance(100);
    const read = vi.fn(async () => "never");
    await expect(budget.bounded(read)).rejects.toThrow(TIMEOUT);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a read that returns after the clock passed the deadline", async () => {
    const w = wait({ timeoutMs: 100 });
    const budget = w.build().begin();
    await expect(
      budget.bounded(async () => {
        w.c.advance(100);
        return "late";
      }),
    ).rejects.toThrow(TIMEOUT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an observer's own failure, not a timeout, and clears the timer", async () => {
    const w = wait({ timeoutMs: 100 });
    const budget = w.build().begin();
    await expect(
      budget.bounded(async () => {
        throw new Error("UPDATE_RECORD_INVALID");
      }),
    ).rejects.toThrow("UPDATE_RECORD_INVALID");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("relaunch wait sleep", () => {
  it("pauses one interval while the budget is larger", async () => {
    const w = wait({ timeoutMs: 1000, intervalMs: 50 });
    await w.build().begin().sleep();
    expect(w.pause).toHaveBeenCalledWith(50);
  });

  it("never pauses past the remaining budget", async () => {
    const w = wait({ timeoutMs: 100, intervalMs: 50 });
    const budget = w.build().begin();
    w.c.advance(80);
    await budget.sleep();
    expect(w.pause).toHaveBeenCalledWith(20);
  });

  it("times out before pausing when the budget is spent", async () => {
    const w = wait({ timeoutMs: 100, intervalMs: 50 });
    const budget = w.build().begin();
    w.c.advance(100);
    await expect(budget.sleep()).rejects.toThrow(TIMEOUT);
    expect(w.pause).not.toHaveBeenCalled();
  });

  it("times out a pause that never returns", async () => {
    const w = wait(
      { timeoutMs: 100, intervalMs: 50 },
      clock(),
      () => new Promise<void>(() => undefined),
    );
    const sleeping = w.build().begin().sleep();
    const settled = vi.fn();
    sleeping.catch(settled);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(sleeping).rejects.toThrow(TIMEOUT);
  });

  it("passes a pause failure through unchanged", async () => {
    const w = wait({ timeoutMs: 100 }, clock(), async () => {
      throw new Error("PAUSE_FAILED");
    });
    await expect(w.build().begin().sleep()).rejects.toThrow("PAUSE_FAILED");
  });
});
