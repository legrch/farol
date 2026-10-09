// Scheduling of observations of one host-owned transport. The recovery port
// must retain existing admission, drain, consent and Go settlement checks.
// This watcher has no authority, credentials, operation retry or process API.
export type ConnectorTransportObservation =
  "healthy" | "unreachable" | "exited" | "unknown";

export class ConnectorTransportWatch<T extends { readonly key: string }> {
  private revision = 0;
  private cancellation = 0;
  private suspended = false;
  private closed = false;
  private inFlight: Promise<void> | null = null;
  private attempted = new Set<string>();
  private wakeWaiters = new Set<() => void>();

  constructor(
    private readonly ports: Readonly<{
      capture(): T | null;
      current(original: T): boolean;
      observe(original: T): Promise<ConnectorTransportObservation>;
      recover(
        original: T,
        observationCurrent: () => boolean,
        afterKnownClosure: () => Promise<(() => boolean) | null>,
      ): Promise<void>;
      unknown(original: T): Promise<void>;
      wait(milliseconds: number): Promise<void>;
    }>,
  ) {}

  // Explicit Stop/settings/update/Quit invalidates suspended observations.
  // An admitted drain keeps its original completion, but may not start a
  // successor from an invalidated observation. It is never retried.
  invalidate(): void {
    this.revision += 1;
    this.cancellation += 1;
    this.releaseWakeWaiters();
  }

  // Sleep expires observations, but does not cancel the admitted original
  // drain. Only its host owner may request continuation after known closure.
  suspend(): void {
    this.suspended = true;
    this.revision += 1;
  }

  resume(): void {
    this.suspended = false;
    this.releaseWakeWaiters();
  }

  private releaseWakeWaiters(): void {
    for (const wake of this.wakeWaiters) wake();
    this.wakeWaiters.clear();
  }

  suppressCurrent(): void {
    this.invalidate();
    const original = this.ports.capture();
    if (original && this.attempted.size < 64) this.attempted.add(original.key);
  }

  close(): void {
    this.closed = true;
    this.invalidate();
  }

  check(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (this.suspended) return Promise.resolve();
    const revision = this.revision;
    const cancellation = this.cancellation;
    const original = this.ports.capture();
    if (
      !original ||
      this.attempted.size >= 64 ||
      this.attempted.has(original.key)
    )
      return Promise.resolve();
    const observationCurrent = () =>
      !this.closed && !this.suspended && this.revision === revision;
    const current = () => observationCurrent() && this.ports.current(original);
    const afterKnownClosure = async () => {
      const admitted = () => !this.closed && this.cancellation === cancellation;
      if (!admitted()) return null;
      while (admitted() && this.suspended)
        await new Promise<void>((resolve) => this.wakeWaiters.add(resolve));
      if (!admitted() || this.suspended) return null;
      const resumedRevision = this.revision;
      // This is a fresh observation guard, not restored launch authority.
      // The host must recheck its exact acknowledged stopped state and owners.
      return () =>
        admitted() && !this.suspended && this.revision === resumedRevision;
    };
    const work = async () => {
      // Backoff applies only to safe health observation. There is at most one
      // effectful recovery attempt for this original runtime, even after loss.
      for (const delay of [0, 1_000, 5_000, 15_000]) {
        if (!current()) return;
        if (delay) await this.ports.wait(delay);
        if (!current()) return;
        const observation = await this.ports.observe(original);
        if (!current()) return;
        if (observation === "healthy") return;
        if (observation === "unknown") {
          this.attempted.add(original.key);
          await this.ports.unknown(original);
          return;
        }
        if (observation === "exited") break;
      }
      if (!current()) return;
      // Saturation refuses new effects rather than evicting a one-shot fence.
      if (this.attempted.size >= 64) return;
      this.attempted.add(original.key);
      await this.ports.recover(original, observationCurrent, afterKnownClosure);
    };
    this.inFlight = Promise.resolve()
      .then(work)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
