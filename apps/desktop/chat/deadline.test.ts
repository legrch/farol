import { describe, expect, it, vi } from "vitest";
import { atDeadline } from "./deadline";

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
