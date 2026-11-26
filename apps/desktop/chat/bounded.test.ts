import { describe, expect, it, vi } from "vitest";
import { boundedProbe } from "./bounded";

function manualClock(start = 100) {
  const state = {
    t: start,
    timers: [] as { callback: () => void; ms: number; cancelled: boolean }[],
  };
  return {
    state,
    clock: {
      now: () => state.t,
      after: (callback: () => void, ms: number) => {
        const timer = { callback, ms, cancelled: false };
        state.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("boundedProbe", () => {
  it("answers before the deadline and cancels its timer", async () => {
    const { clock, state } = manualClock();
    await expect(boundedProbe(clock, async () => "ok", 200)).resolves.toEqual({
      status: "answered",
      value: "ok",
    });
    expect(state.timers).toHaveLength(1);
    expect(state.timers[0]?.ms).toBe(100);
    expect(state.timers[0]?.cancelled).toBe(true);
  });

  it("times out a probe that never settles and cancels nothing it did not arm", async () => {
    const { clock, state } = manualClock();
    const pending = boundedProbe(
      clock,
      () => new Promise<never>(() => {}),
      200,
    );
    await flush();
    state.t = 200;
    state.timers[0]?.callback();
    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(state.timers[0]?.cancelled).toBe(true);
  });

  it("treats an answer that arrives after the deadline as a timeout", async () => {
    const { clock, state } = manualClock();
    let release!: (value: string) => void;
    const pending = boundedProbe(
      clock,
      () => new Promise<string>((resolve) => (release = resolve)),
      200,
    );
    await flush();
    state.t = 250;
    release("late");
    await expect(pending).resolves.toEqual({ status: "timeout" });
  });

  it("does not run the probe once the deadline has passed", async () => {
    const { clock, state } = manualClock(300);
    const run = vi.fn(async () => "never");
    await expect(boundedProbe(clock, run, 200)).resolves.toEqual({
      status: "timeout",
    });
    expect(run).not.toHaveBeenCalled();
    expect(state.timers).toHaveLength(0);
  });

  it("propagates an early rejection and ignores a late one", async () => {
    const early = manualClock();
    await expect(
      boundedProbe(early.clock, () => Promise.reject(new Error("boom")), 200),
    ).rejects.toThrow("boom");
    expect(early.state.timers[0]?.cancelled).toBe(true);

    const late = manualClock();
    let fail!: (error: Error) => void;
    const pending = boundedProbe(
      late.clock,
      () => new Promise<never>((_resolve, reject) => (fail = reject)),
      200,
    );
    await flush();
    late.state.timers[0]?.callback();
    await expect(pending).resolves.toEqual({ status: "timeout" });
    fail(new Error("late"));
    await flush();
  });

  it("times out a rejection observed after the deadline before the timer ran", async () => {
    const { clock, state } = manualClock();
    let fail!: (error: Error) => void;
    const pending = boundedProbe(
      clock,
      () => new Promise<never>((_resolve, reject) => (fail = reject)),
      200,
    );
    await flush();
    // The clock is past the deadline but its timer callback has not run.
    state.t = 250;
    fail(new Error("late"));
    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(state.timers[0]?.cancelled).toBe(true);
  });

  it("propagates a synchronous throw before the deadline like a rejection", async () => {
    const { clock, state } = manualClock();
    await expect(
      boundedProbe(
        clock,
        () => {
          throw new Error("sync boom");
        },
        200,
      ),
    ).rejects.toThrow("sync boom");
    expect(state.timers.every((timer) => timer.cancelled)).toBe(true);
  });

  it("times out a synchronous throw observed at or after the deadline", async () => {
    const { clock, state } = manualClock();
    await expect(
      boundedProbe(
        clock,
        () => {
          state.t = 200;
          throw new Error("sync late");
        },
        200,
      ),
    ).resolves.toEqual({ status: "timeout" });
    expect(state.timers.every((timer) => timer.cancelled)).toBe(true);
  });
});
