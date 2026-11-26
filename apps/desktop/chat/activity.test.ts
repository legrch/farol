import { describe, expect, it } from "vitest";
import {
  ACTIVITY_POLL_INTERVAL_MS,
  ACTIVITY_PROBE_DEADLINE_MS,
  createActivityWatch,
  type TaskActivityState,
} from "./activity";

type Page = { id: string; destroyed: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let every already-settled promise continuation run.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

// Timers the test drives by hand: nothing runs until `advance`.
function fakeTimers() {
  let now = 0;
  type Timer = {
    at: number;
    callback: () => void;
    every: number | null;
    cancelled: boolean;
  };
  const timers: Timer[] = [];
  const arm = (callback: () => void, ms: number, every: number | null) => {
    const timer: Timer = { at: now + ms, callback, every, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return {
    ports: {
      every: (callback: () => void, ms: number) => arm(callback, ms, ms),
      after: (callback: () => void, ms: number) => arm(callback, ms, null),
    },
    live: () => timers.filter((timer) => !timer.cancelled).length,
    liveIntervals: () =>
      timers.filter((timer) => !timer.cancelled && timer.every !== null).length,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every === null) due.cancelled = true;
        else due.at += due.every;
        due.callback();
      }
      now = target;
    },
  };
}

function harness(
  probe: (page: Page) => Promise<unknown> = () =>
    Promise.resolve({ running: true }),
) {
  const timers = fakeTimers();
  const state = { updateAdmitted: false, loaded: true };
  const activity: TaskActivityState[] = [];
  const conversations: string[] = [];
  const probes: string[] = [];
  const watch = createActivityWatch<Page>({
    timers: timers.ports,
    page: {
      isDestroyed: (page) => page.destroyed,
      probe: (page) => {
        probes.push(page.id);
        return probe(page);
      },
    },
    route: {
      updateAdmitted: () => state.updateAdmitted,
      loaded: () => state.loaded,
    },
    report: {
      activity: (next) => activity.push(next),
      conversation: (page) => conversations.push(page.id),
    },
  });
  return { watch, timers, state, activity, conversations, probes };
}

const page = (id = "a"): Page => ({ id, destroyed: false });

describe("the activity watch timing", () => {
  it("polls every 250 ms and bounds one probe at 2 s", () => {
    expect(ACTIVITY_POLL_INTERVAL_MS).toBe(250);
    expect(ACTIVITY_PROBE_DEADLINE_MS).toBe(2_000);
  });

  it("probes at once on start, then once per interval", async () => {
    const h = harness();
    h.watch.start(page());
    expect(h.probes).toHaveLength(1);
    await settle();
    h.timers.advance(249);
    expect(h.probes).toHaveLength(1);
    h.timers.advance(1);
    expect(h.probes).toHaveLength(2);
    await settle();
    h.timers.advance(250);
    expect(h.probes).toHaveLength(3);
    await settle();
    h.timers.advance(250);
    expect(h.probes).toHaveLength(4);
  });
});

describe("what a poll reports", () => {
  it("publishes the conversation and the first reading", async () => {
    const h = harness();
    h.watch.start(page("a"));
    await settle();
    expect(h.conversations).toEqual(["a"]);
    expect(h.activity).toEqual(["running"]);
    expect(h.watch.running()).toBe(true);
  });

  it("reports only changes, though the conversation is re-published each time", async () => {
    let running = true;
    const h = harness(() => Promise.resolve({ running }));
    h.watch.start(page());
    await settle();
    h.timers.advance(250);
    await settle();
    expect(h.activity).toEqual(["running"]);
    expect(h.conversations).toHaveLength(2);
    running = false;
    h.timers.advance(250);
    await settle();
    expect(h.activity).toEqual(["running", "idle"]);
    expect(h.watch.running()).toBe(false);
  });

  it("ignores a reply that is not exactly the activity shape", async () => {
    for (const reply of [
      null,
      {},
      { running: "yes" },
      { running: true, x: 1 },
    ]) {
      const h = harness(() => Promise.resolve(reply));
      h.watch.start(page());
      await settle();
      expect(h.activity).toEqual([]);
      expect(h.conversations).toEqual([]);
      expect(h.watch.running()).toBeNull();
    }
  });

  it("swallows a probe that rejects or throws, and probes again next time", async () => {
    let mode: "reject" | "throw" | "ok" = "reject";
    const h = harness(() => {
      if (mode === "throw") throw new Error("sync");
      return mode === "reject"
        ? Promise.reject(new Error("navigated"))
        : Promise.resolve({ running: false });
    });
    h.watch.start(page());
    await settle();
    expect(h.activity).toEqual([]);
    mode = "throw";
    h.timers.advance(250);
    await settle();
    expect(h.activity).toEqual([]);
    mode = "ok";
    h.timers.advance(250);
    await settle();
    expect(h.activity).toEqual(["idle"]);
    expect(h.probes).toHaveLength(3);
  });

  it("disarms the probe deadline as soon as the probe settles", async () => {
    const h = harness();
    h.watch.start(page());
    expect(h.timers.live()).toBe(2);
    await settle();
    expect(h.timers.live()).toBe(1);
    expect(h.timers.liveIntervals()).toBe(1);
  });
});

describe("when a poll does not run", () => {
  it("measures nothing while an update owns the page", async () => {
    const h = harness();
    h.state.updateAdmitted = true;
    h.watch.start(page());
    h.timers.advance(1_000);
    await settle();
    expect(h.probes).toEqual([]);
    h.state.updateAdmitted = false;
    h.timers.advance(250);
    await settle();
    expect(h.probes).toHaveLength(1);
  });

  it("measures nothing before the page has loaded", async () => {
    const h = harness();
    h.state.loaded = false;
    h.watch.start(page());
    h.timers.advance(500);
    await settle();
    expect(h.probes).toEqual([]);
  });

  it("measures nothing on a destroyed page", async () => {
    const h = harness();
    const target = page();
    target.destroyed = true;
    h.watch.start(target);
    h.timers.advance(500);
    await settle();
    expect(h.probes).toEqual([]);
  });

  it("discards an answer that arrives after the page is destroyed", async () => {
    const reply = deferred<unknown>();
    const h = harness(() => reply.promise);
    const target = page();
    h.watch.start(target);
    target.destroyed = true;
    reply.resolve({ running: true });
    await settle();
    expect(h.activity).toEqual([]);
    expect(h.conversations).toEqual([]);
  });

  it("discards an answer that arrives after an update took the page or it unloaded", async () => {
    for (const change of [
      (s: { updateAdmitted: boolean; loaded: boolean }) => {
        s.updateAdmitted = true;
      },
      (s: { updateAdmitted: boolean; loaded: boolean }) => {
        s.loaded = false;
      },
    ]) {
      const reply = deferred<unknown>();
      const h = harness(() => reply.promise);
      h.watch.start(page());
      change(h.state);
      reply.resolve({ running: true });
      await settle();
      expect(h.activity).toEqual([]);
      expect(h.watch.running()).toBeNull();
    }
  });

  it("starts no second probe while one is still in flight", async () => {
    const reply = deferred<unknown>();
    const h = harness(() => reply.promise);
    h.watch.start(page());
    h.timers.advance(1_000);
    expect(h.probes).toHaveLength(1);
    reply.resolve({ running: true });
    await settle();
    h.timers.advance(250);
    expect(h.probes).toHaveLength(2);
  });
});

describe("a probe that never settles", () => {
  it("reports the activity unknown once at the deadline, never starting another probe", async () => {
    const h = harness(() => new Promise(() => undefined));
    h.watch.start(page());
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS - 1);
    expect(h.activity).toEqual([]);
    h.timers.advance(1);
    expect(h.activity).toEqual(["outcome_unknown"]);
    h.timers.advance(10_000);
    await settle();
    expect(h.activity).toEqual(["outcome_unknown"]);
    expect(h.probes).toHaveLength(1);
  });

  it("forgets the observed state when it goes unknown", async () => {
    const answers: unknown[] = [
      { running: true },
      new Promise(() => undefined),
    ];
    const h = harness(() => Promise.resolve(answers.shift()));
    h.watch.start(page());
    await settle();
    expect(h.watch.running()).toBe(true);
    h.timers.advance(250);
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    expect(h.activity).toEqual(["running", "outcome_unknown"]);
    expect(h.watch.running()).toBeNull();
  });

  it("discards its late answer, and the next poll measures afresh", async () => {
    const late = deferred<unknown>();
    let first = true;
    const h = harness(() => {
      if (first) {
        first = false;
        return late.promise;
      }
      return Promise.resolve({ running: false });
    });
    h.watch.start(page());
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    expect(h.activity).toEqual(["outcome_unknown"]);
    late.resolve({ running: true });
    await settle();
    expect(h.activity).toEqual(["outcome_unknown"]);
    expect(h.conversations).toEqual([]);
    h.timers.advance(250);
    await settle();
    expect(h.activity).toEqual(["outcome_unknown", "idle"]);
    expect(h.watch.running()).toBe(false);
  });

  it("reports unknown again after a fresh reading in between", async () => {
    const hang = deferred<unknown>();
    const answers = [hang.promise, Promise.resolve({ running: true })];
    const h = harness(
      () => answers.shift() ?? new Promise<unknown>(() => undefined),
    );
    h.watch.start(page());
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    expect(h.activity).toEqual(["outcome_unknown"]);
    hang.resolve(null);
    await settle();
    h.timers.advance(250);
    await settle();
    expect(h.activity).toEqual(["outcome_unknown", "running"]);
    h.timers.advance(250);
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    expect(h.activity).toEqual([
      "outcome_unknown",
      "running",
      "outcome_unknown",
    ]);
  });

  it("does not repeat the unknown report for a second hang until a good reading", async () => {
    const hang = deferred<unknown>();
    const answers = [hang.promise, Promise.resolve(null)];
    const h = harness(
      () => answers.shift() ?? new Promise<unknown>(() => undefined),
    );
    h.watch.start(page());
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    expect(h.activity).toEqual(["outcome_unknown"]);
    hang.resolve(null);
    await settle();
    // An unusable reading does not end the unknown period; the next probe hangs.
    h.timers.advance(250);
    await settle();
    h.timers.advance(250);
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    expect(h.probes).toHaveLength(3);
    expect(h.activity).toEqual(["outcome_unknown"]);
  });

  it("stays silent at the deadline if an update took the page meanwhile", async () => {
    const h = harness(() => new Promise(() => undefined));
    h.watch.start(page());
    h.state.updateAdmitted = true;
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    expect(h.activity).toEqual([]);
  });

  it("discards a pre-update answer that arrives after the update is released", async () => {
    const hang = deferred<unknown>();
    let first = true;
    const h = harness(() => {
      if (first) {
        first = false;
        return hang.promise;
      }
      return Promise.resolve({ running: false });
    });
    h.watch.start(page());
    h.state.updateAdmitted = true;
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    expect(h.activity).toEqual([]);
    h.state.updateAdmitted = false;
    hang.resolve({ running: true });
    await settle();
    expect(h.activity).toEqual([]);
    expect(h.conversations).toEqual([]);
    expect(h.watch.running()).toBeNull();
    h.timers.advance(250);
    await settle();
    expect(h.activity).toEqual(["idle"]);
  });

  it("reports unknown once after an update is released over a still-hung probe, never stalling silently", async () => {
    const h = harness(() => new Promise(() => undefined));
    h.watch.start(page());
    h.state.updateAdmitted = true;
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS);
    h.timers.advance(250);
    expect(h.activity).toEqual([]);
    h.state.updateAdmitted = false;
    h.timers.advance(250);
    await settle();
    expect(h.activity).toEqual(["outcome_unknown"]);
    h.timers.advance(10_000);
    await settle();
    expect(h.activity).toEqual(["outcome_unknown"]);
    expect(h.probes).toHaveLength(1);
  });

  it("stays silent at the deadline if the watch was stopped", async () => {
    const h = harness(() => new Promise(() => undefined));
    h.watch.start(page());
    h.watch.stop();
    h.timers.advance(ACTIVITY_PROBE_DEADLINE_MS * 2);
    expect(h.activity).toEqual([]);
  });
});

describe("stopping and restarting", () => {
  it("cancels the interval and forgets the observed state", async () => {
    const h = harness();
    h.watch.start(page());
    await settle();
    expect(h.watch.running()).toBe(true);
    h.watch.stop();
    expect(h.watch.running()).toBeNull();
    expect(h.timers.liveIntervals()).toBe(0);
    h.timers.advance(2_000);
    await settle();
    expect(h.probes).toHaveLength(1);
  });

  it("discards an answer to a probe that was in flight at stop", async () => {
    const reply = deferred<unknown>();
    const h = harness(() => reply.promise);
    h.watch.start(page());
    h.watch.stop();
    reply.resolve({ running: true });
    await settle();
    expect(h.activity).toEqual([]);
    expect(h.conversations).toEqual([]);
    expect(h.watch.running()).toBeNull();
  });

  it("does not let a stopped probe's settling release a newer probe's slot", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const replies = [first, second];
    const h = harness(
      () => (replies.shift() as { promise: Promise<unknown> }).promise,
    );
    h.watch.start(page("a"));
    h.watch.start(page("b"));
    expect(h.probes).toEqual(["a", "b"]);
    first.resolve({ running: true });
    await settle();
    h.timers.advance(250);
    expect(h.probes).toEqual(["a", "b"]);
    second.resolve({ running: true });
    await settle();
    expect(h.conversations).toEqual(["b"]);
  });

  it("replaces the previous watch on start: one interval, state reset", async () => {
    const h = harness();
    h.watch.start(page("a"));
    await settle();
    h.watch.start(page("b"));
    expect(h.timers.liveIntervals()).toBe(1);
    expect(h.watch.running()).toBeNull();
    await settle();
    h.timers.advance(250);
    await settle();
    expect(h.probes.slice(2)).toEqual(["b"]);
    expect(h.activity).toEqual(["running", "running"]);
  });

  it("can be stopped when never started", () => {
    const h = harness();
    expect(() => h.watch.stop()).not.toThrow();
    expect(h.watch.running()).toBeNull();
  });
});

describe("a reading taken outside the poll", () => {
  it("is recorded with the same dedupe as polled readings", async () => {
    const h = harness();
    h.watch.record(false);
    h.watch.record(false);
    h.watch.record(true);
    expect(h.activity).toEqual(["idle", "running"]);
    expect(h.watch.running()).toBe(true);
    h.watch.stop();
    h.watch.record(true);
    expect(h.activity).toEqual(["idle", "running", "running"]);
  });
});
