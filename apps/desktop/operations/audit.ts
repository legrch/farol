import { recordInterruptedCommand } from "./interrupted-command";
import {
  ProcessAuditCollector,
  ProcessAuditObserver,
} from "./process-audit-collector";
import type { OperationsStore } from "./store";

// The Go core's operations observation at startup: the interrupted-command
// notice, then the process-audit collector and its observer. Main keeps the
// core owner, the dev shell log that follows, the startup boundary and both
// audit owners: the collector and the observer are written through setters at
// the point they exist, the observer is started after both are written, and
// the core is a late getter read at call time, never copied. The observer
// keeps observing only while the core it was built for is still the current
// one. Nothing here retries: a notice that cannot be observed is warned about
// and never becomes a startup fence, and a core without a verified history
// context starts no audit at all.

export type ProcessAuditCore = Readonly<{
  interruptedCommand: () => Promise<boolean>;
  historyContext: Readonly<{ backendGeneration: string }> | null;
  processAudit: ConstructorParameters<typeof ProcessAuditObserver>[2];
}>;

export type ProcessAuditPorts = Readonly<{
  core: () => ProcessAuditCore | null;
  operationsStore: () => Pick<
    OperationsStore,
    "snapshot" | "record" | "recordTerminalObservation"
  >;
  /** Read inside the notice's try, as main read the lifecycle there. */
  archivedShell: () => boolean;
  warn: (message: string) => void;
  /** The owner write. */
  setCollector: (collector: ProcessAuditCollector) => void;
  /** The owner write. */
  setObserver: (observer: ProcessAuditObserver) => void;
}>;

export async function startProcessAudit(
  ports: ProcessAuditPorts,
): Promise<void> {
  try {
    await recordInterruptedCommand(
      ports.core()!,
      ports.operationsStore(),
      ports.archivedShell(),
    );
  } catch {
    // Observation failure cannot turn old uncertainty into a startup fence.
    ports.warn("The interrupted command notice is unavailable.");
  }
  const auditCore = ports.core()!;
  const auditContext = auditCore.historyContext;
  if (auditContext) {
    const collector = new ProcessAuditCollector(
      ports.operationsStore(),
      Date.now,
      auditContext.backendGeneration,
    );
    ports.setCollector(collector);
    const observer = new ProcessAuditObserver(
      collector,
      () => ports.operationsStore().snapshot(),
      auditCore.processAudit,
      () => ports.core() === auditCore,
    );
    ports.setObserver(observer);
    observer.start();
  }
}
