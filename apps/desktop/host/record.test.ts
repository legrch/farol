import { describe, expect, it, vi } from "vitest";
import { recordQuit, type RecordPorts } from "./record";

// Quit's record step over recording owners. The log is the order of every
// effect; the cases pin which failures are swallowed (journal and audit
// diagnostics) and which end the step (the receipt, the marker removal), and
// that the owner write and the marker stage follow the receipt.

const drained = { drained: true, unconfirmed: [] } as const;
const undrained = { drained: false, unconfirmed: ["go-core"] } as const;

function fixture(
  overrides: Partial<RecordPorts> = {},
  withLog = true,
  withAudit = true,
) {
  const log: string[] = [];
  const quitDrained: boolean[] = [];
  const owners: RecordPorts = {
    operationsLog: () =>
      withLog
        ? {
            shutdown: async (ms) => {
              log.push(`shutdown:${ms}`);
              return true;
            },
          }
        : undefined,
    processAuditCollector: () =>
      withAudit
        ? {
            drain: async (ms) => {
              log.push(`drain:${ms}`);
              return true;
            },
          }
        : undefined,
    recordReserveMs: 2_000,
    warn: (message) => void log.push(`warn:${message}`),
    recordQuitReceipt: async (receipt) => {
      log.push(`receipt:${receipt.drained}`);
    },
    setQuitDrained: (value) => {
      quitDrained.push(value);
      log.push(`owner:${value}`);
    },
    removeMarker: async () => {
      log.push("marker");
      return { removed: true };
    },
    quitTrace: () => ({
      record: (event) => void log.push(`trace:${JSON.stringify(event)}`),
    }),
    ...overrides,
  };
  return { log, quitDrained, record: recordQuit(owners) };
}

describe("quit record step", () => {
  it("drains the audit, flushes the journal, writes the receipt, then the marker", async () => {
    const f = fixture();
    await f.record(drained);
    expect(f.log).toEqual([
      "drain:500",
      "shutdown:1000",
      "receipt:true",
      "owner:true",
      "marker",
      'trace:{"stage":"marker","result":"removed"}',
    ]);
  });

  it("keeps the marker of an undrained quit and still records the receipt", async () => {
    const f = fixture();
    await f.record(undrained);
    expect(f.log).toEqual([
      "drain:500",
      "shutdown:1000",
      "receipt:false",
      "owner:false",
      'trace:{"stage":"marker","result":"kept"}',
    ]);
    expect(f.quitDrained).toEqual([false]);
  });

  it("skips both flushes when no journal was ever opened", async () => {
    const f = fixture({}, false);
    await f.record(drained);
    expect(f.log[0]).toBe("receipt:true");
    expect(f.log).not.toContain("drain:500");
  });

  it("flushes the journal alone when there is no audit collector", async () => {
    const f = fixture({}, true, false);
    await f.record(drained);
    expect(f.log.slice(0, 2)).toEqual(["shutdown:1000", "receipt:true"]);
  });

  it("warns on an unconfirmed audit drain and still flushes the journal", async () => {
    const f = fixture({
      processAuditCollector: () => ({ drain: async () => false }),
    });
    await f.record(drained);
    expect(f.log.slice(0, 3)).toEqual([
      "warn:FAROL_PROCESS_AUDIT_DRAIN_UNCONFIRMED",
      "shutdown:1000",
      "receipt:true",
    ]);
  });

  it("flushes the journal after a throwing audit drain, without a warning", async () => {
    const f = fixture({
      processAuditCollector: () => ({
        drain: async () => {
          throw new Error("audit");
        },
      }),
    });
    await f.record(drained);
    expect(f.log.slice(0, 2)).toEqual(["shutdown:1000", "receipt:true"]);
    expect(f.log.some((entry) => entry.startsWith("warn:"))).toBe(false);
  });

  it("flushes the journal when the audit warning itself throws", async () => {
    const f = fixture({
      processAuditCollector: () => ({ drain: async () => false }),
      warn: () => {
        throw new Error("closed stderr");
      },
    });
    await f.record(drained);
    expect(f.log.slice(0, 2)).toEqual(["shutdown:1000", "receipt:true"]);
  });

  it.each(["false", "throw"])(
    "warns when the journal flush is %s and still writes the receipt",
    async (mode) => {
      const f = fixture({
        operationsLog: () => ({
          shutdown: async () => {
            if (mode === "throw") throw new Error("private detail");
            return false;
          },
        }),
      });
      await f.record(undrained);
      expect(f.log.slice(0, 3)).toEqual([
        "drain:500",
        "warn:FAROL_OPERATIONS_LOG_FLUSH_UNCONFIRMED",
        "receipt:false",
      ]);
    },
  );

  it("records the receipt and removes the marker when the warning sink is closed", async () => {
    const f = fixture({
      operationsLog: () => ({ shutdown: async () => false }),
      warn: () => {
        throw new Error("closed stderr");
      },
    });
    await f.record(drained);
    expect(f.log).toContain("receipt:true");
    expect(f.log).toContain("marker");
  });

  it("reads the operations log when it runs, not when the step was built", async () => {
    let log: { shutdown(ms: number): Promise<boolean> } | undefined;
    const events: string[] = [];
    const f = fixture({ operationsLog: () => log });
    await f.record(undrained);
    log = {
      shutdown: async () => {
        events.push("late-shutdown");
        return true;
      },
    };
    await f.record(undrained);
    expect(events).toEqual(["late-shutdown"]);
  });

  it("traces a marker that was not removed, or an absent result, as kept", async () => {
    for (const result of [{ removed: false }, undefined]) {
      const f = fixture({ removeMarker: async () => result });
      await f.record(drained);
      expect(f.log.at(-1)).toBe('trace:{"stage":"marker","result":"kept"}');
    }
  });

  it("traces a failed marker removal and rethrows it after the owner write", async () => {
    const failure = new Error("marker unreadable");
    const f = fixture({
      removeMarker: async () => {
        throw failure;
      },
    });
    await expect(f.record(drained)).rejects.toBe(failure);
    expect(f.log.slice(-2)).toEqual([
      "owner:true",
      'trace:{"stage":"marker","result":"failed"}',
    ]);
  });

  it("treats a marker lookup that throws synchronously as a failed removal", async () => {
    const f = fixture({
      removeMarker: () => {
        throw new Error("state paths unavailable");
      },
    });
    await expect(f.record(drained)).rejects.toThrow("state paths unavailable");
    expect(f.log.at(-1)).toBe('trace:{"stage":"marker","result":"failed"}');
  });

  it("does not touch the owner or the marker when the receipt cannot be written", async () => {
    const failure = new Error("receipt refused");
    const f = fixture({
      recordQuitReceipt: async () => {
        throw failure;
      },
    });
    await expect(f.record(drained)).rejects.toBe(failure);
    expect(f.quitDrained).toEqual([]);
    expect(f.log).not.toContain("marker");
    expect(f.log.some((entry) => entry.startsWith("trace:"))).toBe(false);
  });

  it("completes without a trace", async () => {
    const f = fixture({ quitTrace: () => null });
    await expect(f.record(drained)).resolves.toBeUndefined();
    expect(f.log).toContain("marker");
  });

  it("spends the recording reserve as a quarter then a half", async () => {
    const drain = vi.fn(async () => true);
    const shutdown = vi.fn(async () => true);
    const f = fixture({
      recordReserveMs: 800,
      processAuditCollector: () => ({ drain }),
      operationsLog: () => ({ shutdown }),
    });
    await f.record(undrained);
    expect(drain).toHaveBeenCalledExactlyOnceWith(200);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(400);
  });
});
