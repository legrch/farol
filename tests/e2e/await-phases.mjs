// What the lane was waiting on when it stopped saying anything.
//
// A sealed full lane stalled at 08:01:57Z with its last screenshot written
// and produced nothing further until a watchdog killed the process group
// twenty minutes later (attempt 20260921T080108828Z-2e74fa25: started.json
// and screenshots, no terminal.json). The screenshots alone cannot say
// whether the run was inside `close()`, `electron.launch`, `firstWindow`,
// the presentation wait or the next bridge call, because none of those
// boundaries announces itself. "It stalled at launch()" was a reading of
// where the pictures stopped, not a measurement of where the await was.
//
// This records each awaited boundary as it is crossed and puts one budget
// THROUGH the await rather than checking a deadline after it returns — a
// deadline that is only read on the other side of a promise that never
// settles is never read at all. A budget that fires names the boundary and
// the instance it belonged to, so the next stall arrives with its own
// address instead of a time range.
//
// Budgets are not timeouts for the product. Every existing Playwright and
// harness timeout keeps its own value and fires first on a healthy machine;
// these are the outer bound on an await that no inner timeout covers, set
// far above anything a healthy run has been measured taking.

/** Every stall error starts with this, so one grep finds them all. */
export const STALL_PREFIX = "E2E_AWAIT_STALLED";

/** Every phase line starts with this, in the lane's stdout and in phase.log. */
export const PHASE_PREFIX = "E2E_PHASE";

/** How long releasing one late result may take before it is called unknown. */
export const DEFAULT_DISPOSE_BUDGET_MS = 30_000;

export class AwaitStalledError extends Error {
  constructor(name, budgetMs) {
    super(`${STALL_PREFIX}:${name} after ${budgetMs}ms`);
    this.name = "AwaitStalledError";
    this.phase = name;
    this.budgetMs = budgetMs;
  }
}

/**
 * Create the recorder a lane threads through its instance lifecycle.
 *
 * `sink(line)` receives one already-formatted line per event and decides
 * where it goes; the recorder never holds a file descriptor of its own, so a
 * sink that throws cannot take the lane down with it.
 *
 * `schedule(callback, ms)` returns a handle for `cancel(handle)`. It is
 * injected so a test can drive the budget without waiting for wall-clock
 * time, and so the real one can `unref()` its timer: a budget must never be
 * the reason a finished process stays alive.
 */
export function createPhaseRecorder({
  sink,
  now = () => Date.now(),
  schedule = (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  let sequence = 0;
  let lastCompleted = null;
  const inFlight = new Map();
  // A budget that fires cancels the WAIT, never the producer. `electron.launch`
  // has no abort in this Playwright version, so a launch that missed its
  // budget can still hand over a live application seconds later, with nobody
  // holding it. These are the boundaries whose producer is still running, or
  // whose late result could not be released: they outlive the `inFlight`
  // entry the wrapper's `finally` removes, and they are what the terminal
  // receipt must carry so an unfinished resource is never silently dropped.
  const abandoned = new Map();

  const emit = (event, record, extra = "") => {
    const line =
      `${PHASE_PREFIX} ${event} #${record.seq} ${record.name} ` +
      `${new Date(now()).toISOString()}${extra}`;
    try {
      sink?.(line);
    } catch {
      // A sink that cannot write is not a reason to fail the lane; the
      // phase state below is still readable by the terminal receipt.
    }
  };

  const settleAbandoned = (entry, state, detail = "") => {
    entry.state = state;
    entry.held =
      state === "late-result-held" || state === "late-result-unknown";
    entry.settledAt = now();
    emit(
      "late",
      { seq: entry.seq, name: entry.name },
      ` ${state}${detail ? ` ${detail}` : ""}`,
    );
  };

  function adoptLateResult(record, producer, options) {
    const entry = {
      seq: record.seq,
      name: record.name,
      since: now(),
      state: "awaiting-late-result",
      held: true,
      settledAt: null,
    };
    abandoned.set(entry.seq, entry);
    emit("late", entry, " awaiting-late-result");
    producer.then(
      (value) => {
        if (typeof options.dispose !== "function") {
          // Nothing here knows how to release an arbitrary value, and
          // guessing would be worse than saying so.
          settleAbandoned(entry, "late-result-held");
          return;
        }
        let release;
        new Promise((resolve, reject) => {
          release = schedule(
            () => reject(new Error("LATE_RESULT_DISPOSE_BUDGET")),
            options.disposeBudgetMs ?? DEFAULT_DISPOSE_BUDGET_MS,
          );
          Promise.resolve()
            .then(() => options.dispose(value))
            .then(resolve, reject);
        })
          .then(
            () => settleAbandoned(entry, "late-result-disposed"),
            (error) =>
              settleAbandoned(
                entry,
                "late-result-unknown",
                String(error?.message ?? error).split("\n", 1)[0],
              ),
          )
          .finally(() => {
            if (release !== undefined) cancel(release);
          });
      },
      (error) =>
        // The producer failed on its own after the budget: it produced
        // nothing, so there is nothing to release.
        settleAbandoned(
          entry,
          "late-result-rejected",
          String(error?.message ?? error).split("\n", 1)[0],
        ),
    );
  }

  return {
    /**
     * Run one awaited boundary under a named budget.
     *
     * The returned promise settles exactly as `run()`'s does, except that a
     * `run()` which never settles rejects with `AwaitStalledError` once the
     * budget elapses. Every other rejection is passed through untouched: an
     * application that died mid-await must keep its own error.
     *
     * `options.dispose(value)` is how a late result is released when the
     * budget already fired: the wait is over, but the producer is not, and a
     * launch that resolves afterwards owns a real process. Without a
     * disposer the late value is recorded as held, never guessed at — this
     * releases exactly what this boundary produced and touches nothing else.
     * `options.disposeBudgetMs` bounds that release; a release that does not
     * finish leaves the resource recorded as unknown rather than assumed
     * gone.
     */
    async step(name, budgetMs, run, options = {}) {
      sequence += 1;
      const record = { seq: sequence, name, startedAt: now() };
      inFlight.set(record.seq, record);
      emit("begin", record);
      let budget;
      const producer = Promise.resolve().then(run);
      try {
        const result = await new Promise((resolve, reject) => {
          budget = schedule(
            () => reject(new AwaitStalledError(name, budgetMs)),
            budgetMs,
          );
          producer.then(resolve, reject);
        });
        const elapsedMs = now() - record.startedAt;
        lastCompleted = { ...record, elapsedMs };
        emit("end", record, ` ${elapsedMs}ms`);
        return result;
      } catch (error) {
        const elapsedMs = now() - record.startedAt;
        emit(
          "fail",
          record,
          ` ${elapsedMs}ms ${String(error?.message ?? error).split("\n", 1)[0]}`,
        );
        if (error instanceof AwaitStalledError) {
          adoptLateResult(record, producer, options);
        } else {
          // The producer settled: it is this rejection. Nothing outlives it.
          producer.catch(() => {});
        }
        throw error;
      } finally {
        if (budget !== undefined) cancel(budget);
        inFlight.delete(record.seq);
      }
    },

    /** A marker for something that happened rather than something awaited. */
    note(name, detail = "") {
      sequence += 1;
      const record = { seq: sequence, name, startedAt: now() };
      emit("note", record, detail ? ` ${detail}` : "");
    },

    /**
     * What a terminal receipt writes when the lane could not finish: the last
     * boundary that completed, and every boundary still open with how long it
     * had been open when the receipt was written.
     */
    /**
     * Wait, bounded, for every abandoned boundary to reach a terminal state,
     * and answer with the ones still held. A lane calls this before starting
     * another instance: a new run must not begin on top of resources an
     * earlier boundary is still holding, and a resource that cannot be
     * released must be reported rather than raced.
     */
    async drainLateResults(waitMs = DEFAULT_DISPOSE_BUDGET_MS) {
      const until = now() + waitMs;
      while (
        [...abandoned.values()].some(
          (entry) => entry.state === "awaiting-late-result",
        ) &&
        now() < until
      ) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return [...abandoned.values()].filter((entry) => entry.held);
    },

    snapshot() {
      const at = now();
      return {
        crossed: sequence,
        lastCompleted: lastCompleted
          ? {
              seq: lastCompleted.seq,
              name: lastCompleted.name,
              elapsedMs: lastCompleted.elapsedMs,
            }
          : null,
        inFlight: [...inFlight.values()].map((record) => ({
          seq: record.seq,
          name: record.name,
          elapsedMs: at - record.startedAt,
        })),
        abandoned: [...abandoned.values()].map((entry) => ({
          seq: entry.seq,
          name: entry.name,
          state: entry.state,
          held: entry.held,
          elapsedMs: (entry.settledAt ?? at) - entry.since,
        })),
      };
    },
  };
}
