/**
 * A rate limit for a diagnostic that can fire as often as the renderer draws.
 *
 * `render()` runs on every keystroke and on every push, so a line per call is
 * not a measurement — it is a second load on the thing being measured. A
 * widened capture of that stream hung a run for six minutes with the
 * application still alive, which told us about the instrument rather than
 * about the product.
 *
 * So: the first occurrence is always reported, because the first one is the
 * one that says a thing happened at all. After that, at most one line per
 * interval, carrying how many were suppressed — a count nobody has to
 * reconstruct from timestamps, and a stream nobody has to bound from outside.
 */
export class DiagnosticThrottle {
  private admittedAt: number | null = null;
  private suppressed = 0;

  constructor(
    private readonly now: () => number,
    private readonly intervalMs = 1_000,
  ) {}

  /**
   * Whether to report this occurrence, and how many went unreported since
   * the last line. Null suppresses.
   */
  admit(): Readonly<{ suppressed: number }> | null {
    const at = this.now();
    if (this.admittedAt !== null && at - this.admittedAt < this.intervalMs) {
      this.suppressed += 1;
      return null;
    }
    const suppressed = this.suppressed;
    this.admittedAt = at;
    this.suppressed = 0;
    return { suppressed };
  }

  /**
   * Forget the window. The next occurrence is a first one again — used when
   * the state being watched ends, so a later episode is not silenced by an
   * earlier one's timer.
   */
  reset(): void {
    this.admittedAt = null;
    this.suppressed = 0;
  }
}
