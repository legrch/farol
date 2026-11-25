import type { QuitDrainReceipt } from "../../../src/apps/desktop/quit-drain";
import type { QuitTrace } from "../quit/trace";

// Quit's record step: the receipt first, then, only for a confirmed drain, the
// run marker written at start (N03/D2). An undrained quit, or a receipt that
// could not be written, leaves the marker in place, and the next promotion
// reads that as a stop that never confirmed, never as a clean quit. Main keeps
// every owner; the operations log, the audit collector and the trace are late
// getters, read when the step runs. The one owner write, `quitDrained`, is a
// setter port. Nothing here retries and nothing converts a failed receipt into
// a recorded one: a rejecting receipt write or marker removal propagates to
// the drain, which reports the record phase as failed.

export type RecordPorts = Readonly<{
  operationsLog: () =>
    { shutdown(deadlineMs: number): Promise<boolean> } | undefined;
  processAuditCollector: () =>
    { drain(deadlineMs: number): Promise<boolean> } | undefined;
  /** Quit's existing absolute recording reserve; the flushes spend a part of it. */
  recordReserveMs: number;
  warn: (message: string) => void;
  recordQuitReceipt: (receipt: QuitDrainReceipt) => Promise<void>;
  /** The owner write: lets the launcher end an exit teardown that hangs. */
  setQuitDrained: (drained: boolean) => void;
  removeMarker: () => Promise<Readonly<{ removed: boolean }> | undefined>;
  quitTrace: () => Pick<QuitTrace, "record"> | null;
}>;

export function recordQuit(
  ports: RecordPorts,
): (receipt: QuitDrainReceipt) => Promise<void> {
  return async (receipt) => {
    // Child close observers have settled. Flush their final metadata before
    // real Quit can truncate the asynchronous writer, inside the existing
    // absolute recording deadline. Logging supplies no child-drain authority.
    const operationsLog = ports.operationsLog();
    if (operationsLog) {
      let flushed = false;
      try {
        const processAuditCollector = ports.processAuditCollector();
        if (
          processAuditCollector &&
          !(await processAuditCollector.drain(ports.recordReserveMs / 4))
        ) {
          try {
            ports.warn("FAROL_PROCESS_AUDIT_DRAIN_UNCONFIRMED");
          } catch {
            // Diagnostics cannot prevent the remaining journal flush.
          }
        }
      } catch {
        // An unavailable audit observer must not suppress the journal flush.
      }
      try {
        // Reserve half of Quit's existing recording budget for final metadata.
        // A populated Activity journal can need more than 250 ms to fsync and
        // prune; a stalled writer still times out before the receipt reserve.
        flushed = await operationsLog.shutdown(ports.recordReserveMs / 2);
      } catch {
        // Preserve the original child-drain result even on journal failure.
      }
      if (!flushed) {
        try {
          ports.warn("FAROL_OPERATIONS_LOG_FLUSH_UNCONFIRMED");
        } catch {
          // A closed diagnostic sink cannot suppress the Quit receipt.
        }
      }
    }
    await ports.recordQuitReceipt(receipt);
    ports.setQuitDrained(receipt.drained);
    if (receipt.drained) {
      try {
        const marker = await ports.removeMarker();
        ports.quitTrace()?.record({
          stage: "marker",
          result: marker?.removed === true ? "removed" : "kept",
        });
      } catch (error) {
        ports.quitTrace()?.record({ stage: "marker", result: "failed" });
        throw error;
      }
    } else {
      ports.quitTrace()?.record({ stage: "marker", result: "kept" });
    }
  };
}
