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
type Attempt = { count: number; nextAt: number; stopped: boolean };

// Observational work is driven by existing Activity refreshes. It never runs a
// command, creates a journal, or changes the original MCP result. A lost RPC or
// write ACK fences that exact observation for this collector lifetime.
export class ProcessAuditCollector {
  private readonly attempts = new Map<string, Attempt>();
  private busy = false;
  private inFlight: Promise<void> | undefined;
  constructor(
    private readonly writer: Writer,
    private readonly now = Date.now,
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
      const key = JSON.stringify([ref.buildId, ref.runtimeId, ref.operationId]);
      if (terminals.has(key)) continue;
      let attempt = this.attempts.get(key);
      if (!attempt) {
        // An unseen reference must not starve already tracked observations
        // when the bounded attempt table is full. Keep all existing fences.
        if (this.attempts.size >= 1024) continue;
        attempt = { count: 0, nextAt: 0, stopped: false };
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
