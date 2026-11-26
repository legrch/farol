import { describe, expect, it, vi } from "vitest";
import { atDeadline, raceDeadline } from "./deadline";

// A clock whose timers fire when the test says, possibly before the reading
// has reached the delay: libuv floors its own clock, so a timer armed for
// `ceil(deadline - now)` can fire up to a millisecond early.
function earlyClock(start: number) {
  const state = {
    t: start,
    delays: [] as number[],
    pending: [] as { callback: () => void; cancelled: boolean }[],
  };
  return {
    state,
    clock: {
      now: () => state.t,
      after: (callback: () => void, ms: number) => {
        const timer = { callback, cancelled: false };
        state.delays.push(ms);
        state.pending.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    fire() {
      const timer = state.pending.shift();
      if (timer && !timer.cancelled) timer.callback();
    },
  };
}

describe("atDeadline", () => {
  it("arms one whole-millisecond timer rounded up", () => {
    const { clock, state } = earlyClock(10.95);
    atDeadline(110.9, clock, vi.fn());
    expect(state.delays).toEqual([100]);
  });

  it("re-arms when its timer fires before the deadline and calls back only once the clock confirms it", () => {
    const callback = vi.fn();
    const { clock, state, fire } = earlyClock(10.95);
    atDeadline(110.9, clock, callback);
    // The timer fires early: the reading is still 0.9 ms below the deadline.
    state.t = 110;
    fire();
    expect(callback).not.toHaveBeenCalled();
    expect(state.delays).toEqual([100, 1]);
    // It fires early again by a fraction.
    state.t = 110.5;
    fire();
    expect(callback).not.toHaveBeenCalled();
    expect(state.delays).toEqual([100, 1, 1]);
    state.t = 110.9;
    fire();
    expect(callback).toHaveBeenCalledOnce();
    expect(state.pending).toHaveLength(0);
  });

  it("calls back on a deadline already reached, and only once", () => {
    const callback = vi.fn();
    const { clock, state, fire } = earlyClock(200);
    atDeadline(110, clock, callback);
    expect(state.delays).toEqual([0]);
    fire();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("never calls back after it is cancelled, including between re-arms", () => {
    const callback = vi.fn();
    const { clock, state, fire } = earlyClock(0);
    const cancel = atDeadline(100, clock, callback);
    state.t = 99.2;
    fire();
    cancel();
    state.t = 101;
    fire();
    expect(callback).not.toHaveBeenCalled();
    expect(state.pending).toHaveLength(0);
  });
});

describe("raceDeadline", () => {
  const flushMicrotasks = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const timeout = new Error("deadline");

  it("accepts work that settles before the deadline and cancels its timer", async () => {
    const { clock, state } = earlyClock(0);
    const value = raceDeadline(Promise.resolve("ok"), 100, clock, () => {
      throw timeout;
    });
    await expect(value).resolves.toBe("ok");
    expect(state.pending[0]?.cancelled).toBe(true);
  });

  it("takes the timeout path when the work settles at or after the deadline while the timer is still re-armed", async () => {
    const { clock, state, fire } = earlyClock(0);
    let resolveWork!: (value: string) => void;
    const onDeadline = vi.fn(() => "expired");
    const raced = raceDeadline(
      new Promise<string>((resolve) => (resolveWork = resolve)),
      100,
      clock,
      onDeadline,
    );
    // The timer fires 0.9 ms early and is re-armed for the remainder.
    state.t = 99.1;
    fire();
    expect(state.delays).toEqual([100, 1]);
    // The work settles just after the deadline, before the re-armed timer.
    state.t = 100.05;
    resolveWork("late acknowledgement");
    await expect(raced).resolves.toBe("expired");
    expect(onDeadline).toHaveBeenCalledOnce();
    expect(state.pending[0]?.cancelled).toBe(true);
    await flushMicrotasks();
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it("treats a rejection observed after the deadline as the timeout path and one before it as an error", async () => {
    const late = earlyClock(0);
    let failLate!: (error: Error) => void;
    const lateRace = raceDeadline(
      new Promise<never>((_resolve, reject) => (failLate = reject)),
      100,
      late.clock,
      () => "expired",
    );
    late.state.t = 100;
    failLate(new Error("script failed"));
    await expect(lateRace).resolves.toBe("expired");

    const early = earlyClock(0);
    await expect(
      raceDeadline(Promise.reject(new Error("early")), 100, early.clock, () => {
        throw timeout;
      }),
    ).rejects.toThrow("early");
  });

  it("runs the timeout path from the timer once the clock has reached the deadline, and only once", async () => {
    const { clock, state, fire } = earlyClock(0);
    const onDeadline = vi.fn(() => {
      throw timeout;
    });
    const raced = raceDeadline(
      new Promise<never>(() => undefined),
      100,
      clock,
      onDeadline,
    );
    state.t = 100;
    fire();
    await expect(raced).rejects.toBe(timeout);
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it("releases its timer when the caller aborts, and then never settles", async () => {
    const { clock, state, fire } = earlyClock(0);
    const onDeadline = vi.fn(() => "expired");
    let resolveWork!: (value: string) => void;
    const stop = new AbortController();
    const settled = vi.fn();
    raceDeadline(
      new Promise<string>((resolve) => (resolveWork = resolve)),
      100,
      clock,
      onDeadline,
      stop.signal,
    ).then(settled, settled);
    stop.abort();
    expect(state.pending[0]?.cancelled).toBe(true);
    state.t = 100;
    fire();
    resolveWork("late");
    await flushMicrotasks();
    expect(onDeadline).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("arms no timer for a signal already aborted", () => {
    const { clock, state } = earlyClock(0);
    const stop = new AbortController();
    stop.abort();
    void raceDeadline(
      new Promise<never>(() => undefined),
      100,
      clock,
      () => null,
      stop.signal,
    );
    expect(state.delays).toEqual([]);
  });
});
