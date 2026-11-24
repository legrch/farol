import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationsStore } from "../operations/store";
import { createCoreReporters } from "./report";

// The two core diagnostic sinks over scripted ports. One ordered log carries
// the operations record and the console line, so a test asserts both content
// and order. No store, child or provider runs; stderr and console are spies.
const buildIdentity = { buildId: "b".repeat(64) };
const originalE2e = process.env.FAROL_E2E;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalE2e === undefined) delete process.env.FAROL_E2E;
  else process.env.FAROL_E2E = originalE2e;
});

function build(runtimeEnvironment = "dev") {
  const log: string[] = [];
  const records: unknown[][] = [];
  const store: Pick<OperationsStore, "record"> = {
    record: (...args: unknown[]) => {
      log.push("record");
      records.push(args);
      return undefined as never;
    },
  };
  const stores = vi.fn(() => store);
  vi.spyOn(console, "warn").mockImplementation((line: string) => {
    log.push(`warn:${line.slice(0, line.indexOf(":"))}`);
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((
    line: string,
  ) => {
    log.push(`stderr:${line.slice(0, line.indexOf(":"))}`);
    return true;
  }) as never);
  const reporters = createCoreReporters({
    runtimeEnvironment,
    buildIdentity,
    operationsStore: stores,
  });
  return { ...reporters, log, records, stores, stderr };
}

const qualification = {
  schema: 1,
  stage: "controlled",
  result: "pass",
} as never;

describe("qualification observation", () => {
  it("writes one tagged stderr line carrying the build and process", () => {
    const { reportQualificationObservation, stderr } = build("dev");
    reportQualificationObservation({ metric: "controlled" } as never);
    expect(stderr).toHaveBeenCalledTimes(1);
    const line = stderr.mock.calls[0]![0] as string;
    expect(line.startsWith("FAROL_QUALIFICATION_METRICS:")).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.slice(line.indexOf(":") + 1))).toEqual({
      schema: 1,
      buildId: buildIdentity.buildId,
      pid: process.pid,
      metric: "controlled",
    });
  });

  it("stays silent outside dev unless the E2E gate is set", () => {
    delete process.env.FAROL_E2E;
    const quiet = build("preview");
    quiet.reportQualificationObservation(qualification);
    expect(quiet.stderr).not.toHaveBeenCalled();
    process.env.FAROL_E2E = "0";
    const stillQuiet = build("owner-preview");
    stillQuiet.reportQualificationObservation(qualification);
    expect(stillQuiet.stderr).not.toHaveBeenCalled();
    process.env.FAROL_E2E = "1";
    const gated = build("preview");
    gated.reportQualificationObservation(qualification);
    expect(gated.stderr).toHaveBeenCalledTimes(1);
  });

  it("reads the gate at each call", () => {
    delete process.env.FAROL_E2E;
    const { reportQualificationObservation, stderr } = build("preview");
    reportQualificationObservation(qualification);
    process.env.FAROL_E2E = "1";
    reportQualificationObservation(qualification);
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("never throws when stderr is closed", () => {
    const { reportQualificationObservation, stderr } = build("dev");
    stderr.mockImplementation(() => {
      throw Error("CONTROLLED_STDERR_CLOSED");
    });
    expect(() => reportQualificationObservation(qualification)).not.toThrow();
  });
});

const backend = {
  source: "go-backend",
  phase: "closing",
  event: "child-close",
  code: "backend_requested_clean_exit",
  state: "observed",
  exitCode: 0,
  signal: null,
  forced: false,
  hostLifetimeId: "host",
  childLaunchId: "child",
} as never;

describe("backend lifecycle observation", () => {
  it("records first, then writes the closed console line", () => {
    const { reportOwnedBackendLifecycle, log, records } = build();
    reportOwnedBackendLifecycle(backend);
    expect(log).toEqual(["record", "warn:FAROL_BACKEND_LIFECYCLE"]);
    expect(records).toEqual([
      [
        { source: "Setup", kind: "hub.lifecycle", target: {} },
        "done",
        "backend_requested_clean_exit",
        0,
      ],
    ]);
  });

  it("writes the console line regardless of environment gating", () => {
    delete process.env.FAROL_E2E;
    const { reportOwnedBackendLifecycle, log } = build("preview");
    reportOwnedBackendLifecycle(backend);
    expect(log).toContain("warn:FAROL_BACKEND_LIFECYCLE");
  });

  it("projects a tunnel observation with its runtime generation only", () => {
    const { reportOwnedBackendLifecycle } = build();
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: string) => {
      lines.push(line);
    });
    reportOwnedBackendLifecycle({
      source: "connector-tunnel",
      phase: "active",
      event: "exit",
      code: "CONNECTOR_TUNNEL_EXIT",
      state: "observed",
      exitCode: 0,
      signal: null,
      forced: false,
      runtimeGeneration: "original-runtime",
      hostLifetimeId: "must-not-appear",
    } as never);
    const record = JSON.parse(lines[0]!.slice(lines[0]!.indexOf(":") + 1));
    expect(record).toEqual({
      at: expect.any(String),
      source: "connector-tunnel",
      phase: "active",
      event: "exit",
      code: "CONNECTOR_TUNNEL_EXIT",
      state: "observed",
      exitCode: 0,
      signal: null,
      forced: false,
      runtimeGeneration: "original-runtime",
    });
  });

  it("records a tunnel observation as a connection lifecycle", () => {
    const { reportOwnedBackendLifecycle, records } = build();
    reportOwnedBackendLifecycle({
      source: "connector-anchor",
      phase: "active",
      event: "failure",
      code: "CONNECTOR_ANCHOR_EXIT",
      state: "observed",
      exitCode: null,
      signal: null,
      forced: false,
      runtimeGeneration: "g",
    } as never);
    expect(records).toEqual([
      [
        { source: "Setup", kind: "connection.lifecycle", target: {} },
        "failed",
        "CONNECTOR_ANCHOR_EXIT",
        0,
      ],
    ]);
  });

  it("keeps a connector Stop notification out of operations", () => {
    const { reportOwnedBackendLifecycle, log } = build();
    reportOwnedBackendLifecycle({
      source: "connector-anchor",
      phase: "closing",
      event: "exit",
      code: "CONNECTOR_ANCHOR_EXIT",
      state: "observed",
      exitCode: null,
      signal: "SIGKILL",
      forced: true,
      runtimeGeneration: "g",
    } as never);
    expect(log).toEqual(["warn:FAROL_BACKEND_LIFECYCLE"]);
  });

  it("reads the operations store at each report", () => {
    const { reportOwnedBackendLifecycle, stores } = build();
    reportOwnedBackendLifecycle(backend);
    reportOwnedBackendLifecycle(backend);
    expect(stores).toHaveBeenCalledTimes(2);
  });

  it("still writes the console line when recording throws", () => {
    const { reportOwnedBackendLifecycle, stores, log } = build();
    stores.mockImplementation(() => {
      throw Error("CONTROLLED_STORE_UNAVAILABLE");
    });
    expect(() => reportOwnedBackendLifecycle(backend)).not.toThrow();
    expect(log).toEqual(["warn:FAROL_BACKEND_LIFECYCLE"]);
  });

  it("never throws when the console is closed", () => {
    const { reportOwnedBackendLifecycle, log } = build();
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw Error("CONTROLLED_SINK_CLOSED");
    });
    expect(() => reportOwnedBackendLifecycle(backend)).not.toThrow();
    expect(log).toEqual(["record"]);
  });
});
