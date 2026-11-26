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
