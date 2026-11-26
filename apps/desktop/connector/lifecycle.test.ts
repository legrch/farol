import { describe, expect, it, vi } from "vitest";
import {
  lifecycleObserver,
  reportCleanupUnknown,
  type ConnectorLifetime,
} from "./lifecycle";
import type { ConnectorRuntimeLifecycleObservation } from "./receipt";

// The diagnostic forwarding over a recording sink. The lifetime is a value the
// test owns and changes, so the phase is proven to be read at delivery time.

function lifetime(
  phase: ConnectorLifetime["phase"]["value"] = "startup",
): ConnectorLifetime {
  return {
    phase: { value: phase },
    runtimeGeneration: "gen-1",
    reported: new Set(),
  };
}

const exit = {
  source: "connector-tunnel",
  event: "exit",
  code: "CONNECTOR_TUNNEL_EXIT",
  state: "observed",
  exitCode: 9,
  signal: null,
  forced: false,
};

function recorder() {
  const seen: ConnectorRuntimeLifecycleObservation[] = [];
  return {
    seen,
    sink: (value: ConnectorRuntimeLifecycleObservation) => seen.push(value),
  };
}

describe("lifecycleObserver", () => {
  it("forwards a valid record with the current phase and generation", () => {
    const { seen, sink } = recorder();
    const life = lifetime();
    const observe = lifecycleObserver(life, sink);
    life.phase.value = "active";
    observe(exit);
    expect(seen).toEqual([
      { ...exit, phase: "active", runtimeGeneration: "gen-1" },
    ]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("reports each source and event once", () => {
    const { seen, sink } = recorder();
    const observe = lifecycleObserver(lifetime(), sink);
    observe(exit);
    observe({ ...exit, exitCode: 10 });
    observe({
      ...exit,
      source: "connector-anchor",
      code: "CONNECTOR_ANCHOR_EXIT",
    });
    expect(seen.map((item) => item.exitCode)).toEqual([9, 9]);
  });

  it("drops a record that is not in the closed vocabulary", () => {
    const { seen, sink } = recorder();
    const observe = lifecycleObserver(lifetime(), sink);
    observe({ ...exit, extra: "secret" });
    observe(null);
    observe("exit");
    expect(seen).toEqual([]);
  });

  it("never throws when the sink throws or rejects", async () => {
    const life = lifetime();
    const throwing = lifecycleObserver(life, () => {
      throw new Error("sink failed");
    });
    expect(() => throwing(exit)).not.toThrow();
    const rejecting = lifecycleObserver(lifetime(), async () => {
      throw new Error("sink rejected");
    });
    expect(() => rejecting(exit)).not.toThrow();
    await Promise.resolve();
  });

  it("marks the record reported before the sink runs", () => {
    const life = lifetime();
    const sink = vi.fn(() => {
      expect(life.reported.has("connector-tunnel:exit")).toBe(true);
    });
    lifecycleObserver(life, sink)(exit);
    expect(sink).toHaveBeenCalledOnce();
  });
});

describe("reportCleanupUnknown", () => {
  it("reports an unconfirmed Stop in the closing phase", () => {
    const { seen, sink } = recorder();
    reportCleanupUnknown(lifetime("active"), sink, false);
    expect(seen).toEqual([
      {
        source: "connector-anchor",
        phase: "closing",
        event: "cleanup-unknown",
        code: "CONNECTOR_STOP_UNCONFIRMED",
        state: "outcome_unknown",
        exitCode: null,
        signal: null,
        forced: false,
        runtimeGeneration: "gen-1",
      },
    ]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("carries the forced flag", () => {
    const { seen, sink } = recorder();
    reportCleanupUnknown(lifetime(), sink, true);
    expect(seen[0]).toMatchObject({ forced: true });
  });

  it("reports at most once per lifetime", () => {
    const { seen, sink } = recorder();
    const life = lifetime();
    reportCleanupUnknown(life, sink, false);
    reportCleanupUnknown(life, sink, true);
    expect(seen).toHaveLength(1);
    expect(life.reported.has("connector-anchor:cleanup-unknown")).toBe(true);
  });

  it("is not blocked by another event but blocks the observer's duplicate", () => {
    const { seen, sink } = recorder();
    const life = lifetime();
    lifecycleObserver(life, sink)(exit);
    reportCleanupUnknown(life, sink, false);
    expect(seen).toHaveLength(2);
    lifecycleObserver(
      life,
      sink,
    )({
      source: "connector-anchor",
      event: "cleanup-unknown",
      code: "CONNECTOR_STOP_UNCONFIRMED",
      state: "outcome_unknown",
      exitCode: null,
      signal: null,
      forced: false,
    });
    expect(seen).toHaveLength(2);
  });

  it("never throws when the sink throws", () => {
    expect(() =>
      reportCleanupUnknown(
        lifetime(),
        () => {
          throw new Error("sink failed");
        },
        true,
      ),
    ).not.toThrow();
  });

  it("never throws when the sink rejects", async () => {
    expect(() =>
      reportCleanupUnknown(
        lifetime(),
        async () => Promise.reject(new Error("x")),
        true,
      ),
    ).not.toThrow();
    await Promise.resolve();
  });
});
