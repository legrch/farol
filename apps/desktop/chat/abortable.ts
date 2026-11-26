// Waiting on something the caller cannot cancel (a navigation, a page script, a
// readiness observation) must not hold the caller once its own turn was
// cancelled. `abortable` settles with the work's result, or rejects as soon as
// the signal aborts, whichever comes first. The work itself keeps running to
// its end: the caller only stops waiting for it, and must never act on its
// late result.

export const ABORTED_MESSAGE = "CHATGPT_TASK_CANCELLED";

export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // The work is not awaited, so its own rejection must not go unhandled.
    work.catch(() => undefined);
    return Promise.reject(new Error(ABORTED_MESSAGE));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(ABORTED_MESSAGE));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
