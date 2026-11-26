// One timer for an absolute monotonic deadline. A timer armed for the whole
// milliseconds left can still fire before the deadline: libuv floors its own
// clock, so a delay rounded up from a fractional reading may be eligible up to
// a millisecond early. No caller may conclude "the deadline passed" from a
// timer alone, so this re-reads the clock when the timer fires and re-arms for
// what is left until the clock itself has reached the deadline.
export type DeadlineClock = Readonly<{
  now: () => number;
  // Arms one timer; the returned function cancels it.
  after: (callback: () => void, ms: number) => () => void;
}>;

// Calls `callback` once, only when `clock.now() >= deadline`, unless cancelled
// first. The returned function cancels the pending timer and any re-arm.
export function atDeadline(
  deadline: number,
  clock: DeadlineClock,
  callback: () => void,
): () => void {
  let cancelled = false;
  let cancelTimer: (() => void) | undefined;
  const arm = (ms: number): void => {
    cancelTimer = clock.after(fired, ms);
  };
  const fired = (): void => {
    if (cancelled) return;
    const remaining = deadline - clock.now();
    if (remaining > 0) {
      arm(Math.max(1, Math.ceil(remaining)));
      return;
    }
    callback();
  };
  arm(Math.max(0, Math.ceil(deadline - clock.now())));
  return () => {
    cancelled = true;
    cancelTimer?.();
  };
}

// Races `work` against the absolute `deadline` with the settle-time rule: when
// the work settles, the clock is read again. A result, or a failure, observed
// at or after the deadline is the timeout path, however the timer and the work
// happened to be ordered (the timer may be re-armed, not yet confirmed). A
// settlement before the deadline is accepted and the timer cancelled.
//
// `onDeadline` is the one timeout path: it either returns the timeout value or
// throws the timeout error, and runs at most once.
//
// `signal` is for a caller that stops waiting for another reason (an outer
// race won by invalidation, cancellation or surface loss): aborting it
// releases the timer at once, and the returned promise then never settles, so
// no late result or timeout reaches a caller that has already moved on.
export function raceDeadline<T, D>(
  work: Promise<T>,
  deadline: number,
  clock: DeadlineClock,
  onDeadline: () => D,
  signal?: AbortSignal,
): Promise<T | D> {
  return new Promise<T | D>((resolve, reject) => {
    let done = false;
    let cancel: (() => void) | undefined;
    const abandon = (): void => {
      if (done) return;
      done = true;
      cancel?.();
    };
    const expire = (): void => {
      if (done) return;
      done = true;
      cancel?.();
      try {
        resolve(onDeadline());
      } catch (error) {
        reject(error);
      }
    };
    const settle = (accept: () => void): void => {
      if (done) return;
      if (clock.now() >= deadline) {
        expire();
        return;
      }
      done = true;
      cancel?.();
      accept();
    };
    if (signal?.aborted) {
      done = true;
      return;
    }
    cancel = atDeadline(deadline, clock, expire);
    signal?.addEventListener("abort", abandon, { once: true });
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
