import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcessAudit, type ProcessAuditPorts } from "./audit";
import type {
  ProcessAuditCollector,
  ProcessAuditObserver,
} from "./process-audit-collector";
import {
  OperationEntrySchema,
  type OperationsSnapshot,
} from "../renderer/operations-contract";

// The operations observation at startup over recording ports and the real
// collector and observer. The log is the order of every effect; the cases pin
// that the notice comes first and its failure only warns, that no history
// context starts no audit, that both owners are written before the observer
// starts, that the collector is built for the core's backend generation, and
// that the observer stops observing once its core is no longer the current one.

const observers: ProcessAuditObserver[] = [];
afterEach(() => {
  for (const observer of observers.splice(0)) observer.stop();
  vi.useRealTimers();
});

const fact = {
  operationId: "op",
  buildId: "build",
  runtimeId: "runtime",
  exitCode: 0,
  exitSignal: 0,
  rootWaited: true,
  outputDrained: true,
  groupCleanup: "confirmed" as const,
  descendantCleanup: "confirmed" as const,
  timedOut: false,
  authorityLost: false,
};
const entryFor = (backendGeneration: string, operationId: string) =>
  OperationEntrySchema.parse({
    id: crypto.randomUUID(),
    at: 100,
    source: "ChatGPT",
    kind: "computer_shell_start",
    target: {},
    outcome: "unknown",
    code: "PROCESS_OUTCOME_UNKNOWN",
    durationMs: 12,
    schema: "farol.operation/2",
    operationRef: {
      owner: "computer.process",
      operationId,
      buildId: "build",
      runtimeId: "runtime",
      binding: "requested",
      backendGeneration,
    },
    subjectRef: null,
    timing: null,
    exit: null,
    executionFacts: null,
  });
const snapshotOf = (
  entries: OperationsSnapshot["entries"],
): OperationsSnapshot => ({
  entries,
  corruptLines: 0,
  writeFailures: 0,
  droppedEntries: 0,
  unrecordedUncertainEntries: 0,
  unmappedCodes: 0,
  rejectedMetadata: 0,
  recentRejections: [],
});

function fixture(
  options: {
    interrupted?: () => Promise<boolean>;
    context?: { backendGeneration: string } | null;
    entries?: OperationsSnapshot["entries"];
    archived?: () => boolean;
  } = {},
) {
  const log: string[] = [];
  const state: {
    collector?: ProcessAuditCollector;
    observer?: ProcessAuditObserver;
  } = {};
  const reads: string[] = [];
  const store = {
    snapshot: vi.fn(async () => {
      log.push("snapshot");
      return snapshotOf(options.entries ?? []);
    }),
    record: vi.fn(() => void log.push("record")),
    recordTerminalObservation: vi.fn(async () => "recorded" as const),
  };
  const core = {
    interruptedCommand: options.interrupted ?? (async () => false),
    historyContext:
      options.context === undefined
        ? { backendGeneration: "gen-1" }
        : options.context,
    processAudit: {
      read: async (reference: { operationId: string }) => {
        reads.push(reference.operationId);
        return fact;
      },
    },
  };
  const current: { core: typeof core | null } = { core };
  const ports: ProcessAuditPorts = {
    core: () => current.core,
    operationsStore: () => store,
    archivedShell: options.archived ?? (() => false),
    warn: (message) => void log.push(`warn:${message}`),
    setCollector: (collector) => {
      state.collector = collector;
      log.push("owner:collector");
    },
    setObserver: (observer) => {
      state.observer = observer;
      observers.push(observer);
      log.push("owner:observer");
    },
  };
  return { ports, log, state, store, current, core, reads };
}

describe("process audit start", () => {
  it("writes both owners, then starts the observer's first read", async () => {
    const f = fixture();
    await startProcessAudit(f.ports);
    expect(f.log).toEqual(["owner:collector", "owner:observer", "snapshot"]);
    expect(f.state.collector).toBeDefined();
    expect(f.state.observer).toBeDefined();
  });

  it("starts no audit and writes no owner without a history context", async () => {
    const f = fixture({ context: null });
    await startProcessAudit(f.ports);
    expect(f.state.collector).toBeUndefined();
    expect(f.state.observer).toBeUndefined();
    expect(f.log).toEqual([]);
  });

  it("records the interrupted notice before any audit owner is written", async () => {
    const f = fixture({ interrupted: async () => true });
    await startProcessAudit(f.ports);
    expect(f.log.slice(0, 4)).toEqual([
      "snapshot",
      "record",
      "owner:collector",
      "owner:observer",
    ]);
  });

  it("warns and still starts the audit when the notice cannot be observed", async () => {
    const f = fixture({
      interrupted: async () => {
        throw new Error("core gone");
      },
    });
    await expect(startProcessAudit(f.ports)).resolves.toBeUndefined();
    expect(f.log).toEqual([
      "warn:The interrupted command notice is unavailable.",
      "owner:collector",
      "owner:observer",
      "snapshot",
    ]);
  });

  it("warns when the lifecycle read throws inside the notice", async () => {
    const f = fixture({
      archived: () => {
        throw new Error("lifecycle");
      },
    });
    await startProcessAudit(f.ports);
    expect(f.log[0]).toBe(
      "warn:The interrupted command notice is unavailable.",
    );
    expect(f.state.observer).toBeDefined();
  });

  it("builds the collector for the core's backend generation", async () => {
    const f = fixture({
      entries: [entryFor("gen-1", "mine"), entryFor("gen-0", "foreign")],
    });
    await startProcessAudit(f.ports);
    await vi.waitFor(() => expect(f.reads).toEqual(["mine"]));
  });

  it("stops observing once the core is no longer the current one", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await startProcessAudit(f.ports);
    expect(f.store.snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.store.snapshot).toHaveBeenCalledTimes(2);
    f.current.core = null;
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.store.snapshot).toHaveBeenCalledTimes(2);
  });
});
