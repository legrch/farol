import { afterEach, describe, expect, it, vi } from "vitest";
import { quitClaim, type ClaimPorts } from "./claim";

// Quit's claim steps over recording owners. Main's `let`s are getters and its
// timers sit in holders, so each case swaps an owner after construction to
// prove the step reads it when it runs. The drain's own isolation of a
// throwing step is covered with the drain; here a step only has to do exactly
// its one effect, in the order main always ran them.

afterEach(() => vi.useRealTimers());

function ports(log: string[], overrides: Partial<ClaimPorts> = {}) {
  const owners: ClaimPorts = {
    desktopAdmission: { beginQuit: () => void log.push("admission") },
    cancelConnectorResume: () => void log.push("connector-resume"),
    connectorStartCancellation: () => ({
      abort: () => void log.push("connector-start"),
    }),
    processAuditObserver: () => ({
      stop: () => void log.push("process-audit"),
    }),
    connectorTransportWatch: {
      current: { close: () => void log.push("transport-watch") },
    },
    connectorTransportTimer: { current: null },
    connectorConnection: { close: () => void log.push("connection") },
    isolatedE2EHome: undefined,
    process: {
      removeAllListeners: ((event?: string | symbol) => {
        log.push(`e2e-observer:${String(event)}`);
        return process;
      }) as NodeJS.Process["removeAllListeners"],
    },
    connectorStatusTimer: { current: null },
    installedUpdates: { stopTimer: () => void log.push("update-timer") },
    ...overrides,
  };
  return owners;
}

const run = (steps: ReturnType<typeof quitClaim>) =>
  steps.forEach((step) => step.run());

describe("quit claim steps", () => {
  it("names the ten steps in the order Quit has always run them", () => {
    expect(quitClaim(ports([])).map((step) => step.name)).toEqual([
      "admission",
      "connector-resume",
      "connector-start",
      "process-audit",
      "transport-watch",
      "transport-timer",
      "connection",
      "e2e-observer",
      "status-timer",
      "update-timer",
    ]);
  });

  it("latches admission first and stops the update timer last", () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const transport = setInterval(() => {}, 1000);
    const status = setInterval(() => {}, 1000);
    const steps = quitClaim(
      ports(log, {
        isolatedE2EHome: "/e2e",
        connectorTransportTimer: { current: transport },
        connectorStatusTimer: { current: status },
      }),
    );
    run(steps);
    expect(log).toEqual([
      "admission",
      "connector-resume",
      "connector-start",
      "process-audit",
      "transport-watch",
      "connection",
      "e2e-observer:farol-e2e-observe-connection",
      "update-timer",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes the owner's resume flag only through its setter", () => {
    let cancelled = false;
    const step = quitClaim(
      ports([], {
        cancelConnectorResume: () => {
          cancelled = true;
        },
      }),
    ).find((candidate) => candidate.name === "connector-resume")!;
    expect(cancelled).toBe(false);
    step.run();
    expect(cancelled).toBe(true);
  });

  it("reads each owner when the step runs, not when the steps were built", () => {
    const log: string[] = [];
    let cancellation: { abort(): void } | null = null;
    let observer: { stop(): void } | undefined;
    const watch: { current: { close(): void } | null } = { current: null };
    const steps = quitClaim(
      ports(log, {
        connectorStartCancellation: () => cancellation,
        processAuditObserver: () => observer,
        connectorTransportWatch: watch,
      }),
    );
    // Nothing exists yet: every step is a no-op and none throws.
    expect(() => run(steps)).not.toThrow();
    expect(log).toEqual([
      "admission",
      "connector-resume",
      "connection",
      "update-timer",
    ]);
    log.length = 0;
    cancellation = { abort: () => void log.push("late-abort") };
    observer = { stop: () => void log.push("late-stop") };
    watch.current = { close: () => void log.push("late-close") };
    run(steps);
    expect(log).toEqual([
      "admission",
      "connector-resume",
      "late-abort",
      "late-stop",
      "late-close",
      "connection",
      "update-timer",
    ]);
  });

  it("clears only the timers that exist, through their holders", () => {
    vi.useFakeTimers();
    const holder: { current: NodeJS.Timeout | null } = { current: null };
    const status: { current: NodeJS.Timeout | null } = { current: null };
    const steps = quitClaim(
      ports([], {
        connectorTransportTimer: holder,
        connectorStatusTimer: status,
      }),
    );
    expect(() => run(steps)).not.toThrow();
    const fired = vi.fn();
    holder.current = setInterval(fired, 100) as unknown as NodeJS.Timeout;
    status.current = setInterval(fired, 100) as unknown as NodeJS.Timeout;
    run(steps);
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
  });

  it("drops the E2E observer only for an isolated E2E home", () => {
    const plain: string[] = [];
    run(quitClaim(ports(plain)));
    expect(plain.some((entry) => entry.startsWith("e2e-observer"))).toBe(false);
    const isolated: string[] = [];
    run(quitClaim(ports(isolated, { isolatedE2EHome: "/e2e" })));
    expect(isolated).toContain("e2e-observer:farol-e2e-observe-connection");
  });

  it("lets a throwing step surface so the drain can record it", () => {
    const steps = quitClaim(
      ports([], {
        connectorConnection: {
          close: () => {
            throw new Error("close failed");
          },
        },
      }),
    );
    const connection = steps.find((step) => step.name === "connection")!;
    expect(() => connection.run()).toThrow("close failed");
  });
});
