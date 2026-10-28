import { expect, it, vi } from "vitest";
import { ProcessAuditCollector } from "../../apps/desktop/operations/process-audit-collector";
import {
  OperationEntrySchema,
  type OperationsSnapshot,
} from "../../apps/desktop/renderer/operations-contract";

const ref = {
  owner: "computer.process" as const,
  operationId: "original",
  buildId: "build",
  runtimeId: "runtime",
  binding: "requested" as const,
};
const fact = {
  operationId: "original",
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
const entry = OperationEntrySchema.parse({
  id: "c7b853ec-0862-4540-8e29-e1b680d5149d",
  at: 100,
  source: "ChatGPT",
  kind: "computer_shell_start",
  target: {},
  outcome: "unknown",
  code: "PROCESS_OUTCOME_UNKNOWN",
  durationMs: 12,
  schema: "farol.operation/2",
  operationRef: ref,
  subjectRef: null,
  timing: null,
  exit: null,
  executionFacts: null,
});
const snapshot: OperationsSnapshot = {
  entries: [entry],
  corruptLines: 0,
  writeFailures: 0,
  droppedEntries: 0,
  unrecordedUncertainEntries: 0,
  unmappedCodes: 0,
};

it("observes the exact original reference once and keeps the MCP record untouched", async () => {
  const reader = { read: vi.fn().mockResolvedValue(fact) };
  const writer = {
    recordTerminalObservation: vi.fn().mockResolvedValue("recorded" as const),
  };
  const collector = new ProcessAuditCollector(writer);
  collector.observe(snapshot, reader, () => true);
  await vi.waitFor(() =>
    expect(writer.recordTerminalObservation).toHaveBeenCalledExactlyOnceWith(
      ref,
      fact,
    ),
  );
  collector.observe(snapshot, reader, () => true);
  expect(reader.read).toHaveBeenCalledOnce();
  expect(snapshot.entries[0]?.outcome).toBe("unknown");
});

it("never repeats a lost observation or an uncertain journal write", async () => {
  for (const kind of ["rpc", "write"] as const) {
    const reader = {
      read:
        kind === "rpc"
          ? vi.fn().mockRejectedValue(new Error("lost"))
          : vi.fn().mockResolvedValue(fact),
    };
    const writer = {
      recordTerminalObservation: vi.fn().mockResolvedValue("unknown" as const),
    };
    const collector = new ProcessAuditCollector(writer, () => 10000);
    collector.observe(snapshot, reader, () => true);
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    collector.observe(snapshot, reader, () => true);
    expect(reader.read).toHaveBeenCalledOnce();
  }
});

it("does not write an observation after the selected backend changes", async () => {
  let current = true;
  let complete!: (value: typeof fact) => void;
  const reader = {
    read: vi.fn(
      () =>
        new Promise<typeof fact>((resolve) => {
          complete = resolve;
        }),
    ),
  };
  const writer = {
    recordTerminalObservation: vi.fn().mockResolvedValue("recorded" as const),
  };
  const collector = new ProcessAuditCollector(writer);
  collector.observe(snapshot, reader, () => current);
  current = false;
  complete(fact);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(writer.recordTerminalObservation).not.toHaveBeenCalled();
});

it("backs off when no terminal is observed without changing the original result", async () => {
  let now = 0;
  const reader = { read: vi.fn().mockResolvedValue(null) };
  const writer = {
    recordTerminalObservation: vi.fn().mockResolvedValue("recorded" as const),
  };
  const collector = new ProcessAuditCollector(writer, () => now);
  collector.observe(snapshot, reader, () => true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  collector.observe(snapshot, reader, () => true);
  expect(reader.read).toHaveBeenCalledOnce();
  now = 5000;
  collector.observe(snapshot, reader, () => true);
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(writer.recordTerminalObservation).not.toHaveBeenCalled();
});

it("continues tracking known observations when new references exceed the limit", async () => {
  let now = 0;
  const reader = { read: vi.fn().mockResolvedValue(null) };
  const writer = {
    recordTerminalObservation: vi.fn().mockResolvedValue("recorded" as const),
  };
  const collector = new ProcessAuditCollector(writer, () => now);
  for (let i = 0; i < 1024; i++) {
    const tracked = {
      ...entry,
      operationRef: { ...ref, operationId: `tracked-${i}` },
    };
    collector.observe({ ...snapshot, entries: [tracked] }, reader, () => true);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(reader.read).toHaveBeenCalledTimes(1024);
  now = 5000;
  const unseen = { ...entry, operationRef: { ...ref, operationId: "unseen" } };
  const tracked = {
    ...entry,
    operationRef: { ...ref, operationId: "tracked-0" },
  };
  collector.observe(
    { ...snapshot, entries: [unseen, tracked] },
    reader,
    () => true,
  );
  expect(reader.read).toHaveBeenCalledTimes(1025);
  expect(reader.read).toHaveBeenLastCalledWith({
    operationId: "tracked-0",
    buildId: "build",
    runtimeId: "runtime",
  });
});

it("observes a long-running process after the initial twelve checks", async () => {
  let now = 0;
  const reader = {
    read: vi.fn<() => Promise<typeof fact | null>>().mockResolvedValue(null),
  };
  const writer = {
    recordTerminalObservation: vi.fn().mockResolvedValue("recorded" as const),
  };
  const collector = new ProcessAuditCollector(writer, () => now);
  for (let i = 0; i < 12; i++) {
    collector.observe(snapshot, reader, () => true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    now += (i + 1) * 5000;
  }
  reader.read.mockResolvedValueOnce(fact);
  collector.observe(snapshot, reader, () => true);
  await vi.waitFor(() =>
    expect(writer.recordTerminalObservation).toHaveBeenCalledOnce(),
  );
  expect(reader.read).toHaveBeenCalledTimes(13);
  expect(snapshot.entries[0]?.outcome).toBe("unknown");
});

it("drains an already admitted observation without dispatching another read", async () => {
  let complete!: (value: typeof fact) => void;
  const reader = {
    read: vi.fn(
      () =>
        new Promise<typeof fact>((resolve) => {
          complete = resolve;
        }),
    ),
  };
  const writer = {
    recordTerminalObservation: vi.fn().mockResolvedValue("recorded" as const),
  };
  const collector = new ProcessAuditCollector(writer);
  collector.observe(snapshot, reader, () => true);
  expect(await collector.drain(0)).toBe(false);
  const drain = collector.drain(1000);
  complete(fact);
  expect(await drain).toBe(true);
  expect(writer.recordTerminalObservation).toHaveBeenCalledExactlyOnceWith(
    ref,
    fact,
  );
  expect(reader.read).toHaveBeenCalledOnce();
  expect(snapshot.entries[0]?.outcome).toBe("unknown");
});
