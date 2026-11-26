import { activityProbeSchema } from "./probe";

// The ChatGPT route's task-activity watch: while a task owns a page, a poll
// asks the page whether the task is still running and tells the route when the
// answer changes. The watch owns everything about that poll (its timer, its
// generation, whether a probe is in flight, the last observed state) and
// nothing else; what the route lends it is spelled out as ports, so the
// timing and the stop rules can be driven by hand in a test.

// How often the page is asked whether the task is still running.
export const ACTIVITY_POLL_INTERVAL_MS = 250;

// How long one page activity probe may take before activity is unknown.
export const ACTIVITY_PROBE_DEADLINE_MS = 2_000;

export type TaskActivityState = "idle" | "running" | "outcome_unknown";

// Timers lent by the route: the real ones in the product, fakes in a test.
// Each arms one timer and returns what cancels it.
export type ActivityWatchTimers = Readonly<{
  every: (callback: () => void, ms: number) => () => void;
  after: (callback: () => void, ms: number) => () => void;
}>;

export type ActivityWatchPorts<Target> = Readonly<{
  timers: ActivityWatchTimers;
  // The page being watched: whether it is gone, and one raw probe reading.
  page: Readonly<{
    isDestroyed: (target: Target) => boolean;
    probe: (target: Target) => Promise<unknown>;
  }>;
  // Route state a poll defers to: an update owns the page, or it has not
  // finished loading, and nothing is measured.
  route: Readonly<{
    updateAdmitted: () => boolean;
    loaded: () => boolean;
  }>;
  // What the watch reports: a changed activity state, and a fresh reading
  // that lets the route re-publish the conversation address.
  report: Readonly<{
    activity: (state: TaskActivityState) => void;
    conversation: (target: Target) => void;
  }>;
}>;

export type ActivityWatch<Target> = Readonly<{
  start: (target: Target) => void;
  stop: () => void;
  // Record one reading taken outside the poll, with the same dedupe.
  record: (running: boolean) => void;
  // The last observed state: null while unknown or after a stop.
  running: () => boolean | null;
}>;

export function createActivityWatch<Target>(
  ports: ActivityWatchPorts<Target>,
): ActivityWatch<Target> {
  let cancelTimer: (() => void) | null = null;
  let pollInFlight = false;
  let probeStale = false;
  // The in-flight probe has passed its deadline: its answer is discarded.
  let probeLate = false;
  let generation = 0;
  let observedRunning: boolean | null = null;

  const record = (running: boolean): void => {
    if (observedRunning === running) return;
    observedRunning = running;
    ports.report.activity(running ? "running" : "idle");
  };

  const stop = (): void => {
    generation += 1;
    if (cancelTimer) cancelTimer();
    cancelTimer = null;
    pollInFlight = false;
    probeStale = false;
    probeLate = false;
    observedRunning = null;
  };

  // Report the activity unknown, once per stale period.
  const reportUnknown = (): void => {
    if (probeStale) return;
    probeStale = true;
    observedRunning = null;
    ports.report.activity("outcome_unknown");
  };

  const poll = async (
    target: Target,
    pollGeneration: number,
  ): Promise<void> => {
    if (
      ports.route.updateAdmitted() ||
      pollGeneration !== generation ||
      ports.page.isDestroyed(target) ||
      !ports.route.loaded()
    ) {
      return;
    }
    if (pollInFlight) {
      // A probe that went late while an update held the page could not
      // report then; the first poll after the release does, so a hung probe
      // never leaves the watch silently stalled.
      if (probeLate) reportUnknown();
      return;
    }
    pollInFlight = true;
    // A probe that never settles must not silence the watcher: past its
    // deadline the task's activity is reported unknown once, no further
    // probe starts while this one hangs, and its late answer is discarded.
    // When it finally settles, the next poll measures afresh. The probe goes
    // late at its deadline even while an update owns the page (its answer is
    // then discarded too); only the unknown report waits for the release.
    let late = false;
    const cancelDeadline = ports.timers.after(() => {
      if (pollGeneration !== generation) return;
      late = true;
      probeLate = true;
      if (!ports.route.updateAdmitted()) reportUnknown();
    }, ACTIVITY_PROBE_DEADLINE_MS);
    try {
      const observed = activityProbeSchema.safeParse(
        await ports.page.probe(target),
      );
      if (
        !late &&
        !ports.route.updateAdmitted() &&
        pollGeneration === generation &&
        !ports.page.isDestroyed(target) &&
        ports.route.loaded() &&
        observed.success
      ) {
        probeStale = false;
        ports.report.conversation(target);
        record(observed.data.running);
      }
    } catch {
      // A navigation can invalidate an in-flight probe. Navigation lifecycle
      // events own readiness and the next bounded poll remeasures activity.
    } finally {
      cancelDeadline();
      if (pollGeneration === generation) {
        pollInFlight = false;
        probeLate = false;
      }
    }
  };

  const start = (target: Target): void => {
    stop();
    const pollGeneration = generation;
    const tick = (): void => void poll(target, pollGeneration);
    tick();
    cancelTimer = ports.timers.every(tick, ACTIVITY_POLL_INTERVAL_MS);
  };

  return { start, stop, record, running: () => observedRunning };
}
