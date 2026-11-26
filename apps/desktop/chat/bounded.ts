// One page script raced against one deadline. A probe that has not answered by
// the deadline, or answers only after it, is a timeout: the caller treats it as
// an unreadable page and never as a positive answer. The probe is never
// retried here; its late answer or rejection is discarded.
export type ProbeClock = Readonly<{
  now: () => number;
  // Arms one timer; the returned function cancels it.
  after: (callback: () => void, ms: number) => () => void;
}>;

export type BoundedProbe<T> =
  Readonly<{ status: "answered"; value: T }> | Readonly<{ status: "timeout" }>;

const TIMEOUT: BoundedProbe<never> = Object.freeze({ status: "timeout" });

// `deadlineAt` is an absolute reading of `clock.now()`. A rejection of the
// probe before the deadline propagates to the caller unchanged; one observed at
// or after it is a timeout like any other late outcome.
export async function boundedProbe<T>(
  clock: ProbeClock,
  run: () => Promise<T>,
  deadlineAt: number,
): Promise<BoundedProbe<T>> {
  if (!(clock.now() < deadlineAt)) return TIMEOUT;
  let cancel: (() => void) | undefined;
  const probe = run();
  try {
    const raced = await Promise.race([
      probe.then(
        (value) => ({ status: "answered" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<typeof TIMEOUT>((resolve) => {
        cancel = clock.after(
          () => resolve(TIMEOUT),
          Math.max(0, deadlineAt - clock.now()),
        );
      }),
    ]);
    if (raced.status === "timeout" || !(clock.now() < deadlineAt))
      return TIMEOUT;
    if (raced.status === "rejected") throw raced.error;
    return raced;
  } finally {
    cancel?.();
  }
}
