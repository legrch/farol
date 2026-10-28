import type { ComputerProcessTerminalAudit } from "../bridge/wire";
import type {
  OperationReference,
  OperationsSnapshot,
} from "../renderer/operations-contract";

type Reader = {
  read(reference: {
    operationId: string;
    buildId: string;
    runtimeId: string;
  }): Promise<ComputerProcessTerminalAudit | null>;
};
type Writer = {
  recordTerminalObservation(
    reference: OperationReference,
    fact: ComputerProcessTerminalAudit,
  ): Promise<"recorded" | "duplicate" | "conflict" | "unavailable" | "unknown">;
};
type Attempt = {
  count: number;
  nextAt: number;
  stopped: boolean;
  recorded: boolean;
};

// Observational work never runs a command, creates a journal, or changes the
// original MCP result. A lost RPC or
// write ACK fences that exact observation for this collector lifetime.
export class ProcessAuditCollector {
  private readonly attempts = new Map<string, Attempt>();
  private busy = false;
  private inFlight: Promise<void> | undefined;
  constructor(
    private readonly writer: Writer,
    private readonly now = Date.now,
    private readonly backendGeneration?: string,
  ) {}

  observe(
    snapshot: OperationsSnapshot,
    reader: Reader,
    current: () => boolean,
  ): void {
    if (
      this.busy ||
      snapshot.readPending ||
      snapshot.readIncomplete ||
      snapshot.corruptLines > 0 ||
      !current()
    )
      return;
    const terminals = new Set(
      snapshot.entries.flatMap((entry) =>
        "schema" in entry &&
        entry.kind === "computer.process.terminal" &&
        entry.operationRef
          ? [
              JSON.stringify([
                entry.operationRef.buildId,
                entry.operationRef.runtimeId,
                entry.operationRef.operationId,
              ]),
            ]
          : [],
      ),
    );
    // Free only completed observations which the journal itself now proves.
    // Lost RPCs, conflicting facts and unknown writes keep their lifetime fence.
    for (const [key, attempt] of this.attempts) {
      if (attempt.recorded && terminals.has(key)) this.attempts.delete(key);
    }
    for (const entry of snapshot.entries) {
      if (
        !("schema" in entry) ||
        entry.kind !== "computer_shell_start" ||
        entry.outcome === "refused" ||
        !entry.operationRef ||
        entry.operationRef.owner !== "computer.process"
      )
        continue;
      const ref = entry.operationRef;
      // The original Go owner retains process facts only for its lifetime.
      // A legacy or foreign generation is history, not a source to poll.
      if (
        this.backendGeneration !== undefined &&
        ref.backendGeneration !== this.backendGeneration
      )
        continue;
      const key = JSON.stringify([ref.buildId, ref.runtimeId, ref.operationId]);
      if (terminals.has(key)) continue;
      let attempt = this.attempts.get(key);
      if (!attempt) {
        // An unseen reference must not starve already tracked observations
        // when the bounded attempt table is full. Keep all existing fences.
        if (this.attempts.size >= 1024) continue;
        attempt = { count: 0, nextAt: 0, stopped: false, recorded: false };
        this.attempts.set(key, attempt);
      }
      if (attempt.stopped || attempt.nextAt > this.now()) continue;
      // A process can legitimately run for longer than a minute. Keep its
      // read-only observation eligible, with bounded backoff, until it settles.
      attempt.count = Math.min(attempt.count + 1, 12);
      attempt.nextAt = this.now() + attempt.count * 5000;
      this.busy = true;
      const state = attempt;
      const work = reader
        .read({
          operationId: ref.operationId,
          buildId: ref.buildId,
          runtimeId: ref.runtimeId,
        })
        .then(async (fact) => {
          if (!current()) {
            state.stopped = true;
            return;
          }
          if (!fact) return;
          const result = await this.writer.recordTerminalObservation(ref, fact);
          // Never issue the same read after delivery or an uncertain write.
          if (result !== "unavailable") state.stopped = true;
          state.recorded = result === "recorded" || result === "duplicate";
        })
        .catch(() => {
          state.stopped = true;
        })
        .finally(() => {
          this.busy = false;
          if (this.inFlight === work) this.inFlight = undefined;
        });
      this.inFlight = work;
      return;
    }
  }

  /** Wait only for an already admitted observation; never dispatch a read. */
  async drain(deadlineMs: number): Promise<boolean> {
    const pending = this.inFlight;
    if (!pending) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Runs independently of renderer visibility; stopping never starts new reads. */
export class ProcessAuditObserver {
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private stopped = false;
  constructor(
    private readonly collector: ProcessAuditCollector,
    private readonly snapshot: () => Promise<OperationsSnapshot>,
    private readonly reader: Reader,
    private readonly current: () => boolean,
    private readonly intervalMs = 1500,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.reading || !this.current()) return;
    this.reading = true;
    try {
      const snapshot = await this.snapshot();
      if (!this.stopped && this.current())
        this.collector.observe(snapshot, this.reader, this.current);
    } catch {
      // Diagnostics cannot interrupt the application or fabricate an outcome.
    } finally {
      this.reading = false;
    }
  }
}
