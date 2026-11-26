import { describe, expect, it } from "vitest";
import {
  lifecycleCode,
  lifecycleIdentity,
  lifecycleObservation,
  safeIdentity,
} from "./lifecycle.ts";

const base = {
  event: "child-close",
  code: "backend_child_closed",
  state: "observed",
  phase: "active",
  forced: false,
  identity: undefined,
} as const;

describe("lifecycleIdentity", () => {
  it("keeps a safe pair of identifiers and freezes it", () => {
    const identity = lifecycleIdentity({
      hostLifetimeId: "host-1",
      childLaunchId: "child:2",
    });
    expect(identity).toEqual({
      hostLifetimeId: "host-1",
      childLaunchId: "child:2",
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("drops a missing or unsafe pair without throwing", () => {
    expect(lifecycleIdentity(undefined)).toBeUndefined();
    expect(
      lifecycleIdentity({ hostLifetimeId: "host", childLaunchId: "-bad" }),
    ).toBeUndefined();
    expect(
      lifecycleIdentity({
        hostLifetimeId: "x".repeat(129),
        childLaunchId: "child",
      }),
    ).toBeUndefined();
  });

  it("never invokes caller accessors", () => {
    let reads = 0;
    const hostile = {
      get hostLifetimeId() {
        reads += 1;
        return "host";
      },
      childLaunchId: "child",
    };
    expect(lifecycleIdentity(hostile)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("is the same predicate the launcher applies", () => {
    expect(safeIdentity.test("a.b_c:d/e-f")).toBe(true);
    expect(safeIdentity.test("")).toBe(false);
  });
});

describe("lifecycleCode", () => {
  it("passes a closed code and collapses everything else", () => {
    expect(lifecycleCode("response_timeout")).toBe("response_timeout");
    expect(lifecycleCode("anything_else")).toBe("backend_unclassified_failure");
  });
});

describe("lifecycleObservation", () => {
  it("reports a known exit code", () => {
    const observation = lifecycleObservation({
      ...base,
      exitCode: 0,
      signal: null,
    });
    expect(observation).toMatchObject({
      source: "go-backend",
      state: "observed",
      exitCode: 0,
      signal: null,
      hostLifetimeId: null,
      childLaunchId: null,
    });
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it("reports a known signal", () => {
    expect(
      lifecycleObservation({ ...base, exitCode: null, signal: "SIGKILL" }),
    ).toMatchObject({ state: "observed", exitCode: null, signal: "SIGKILL" });
  });

  it("marks a close with no or ambiguous terminal facts unknown", () => {
    for (const [exitCode, signal] of [
      [null, null],
      [0, "SIGTERM"],
      [1.5, null],
      [2 ** 31, null],
      [null, "SIGNOPE"],
    ] as const)
      expect(lifecycleObservation({ ...base, exitCode, signal })).toMatchObject(
        {
          state: "outcome_unknown",
          exitCode: null,
          signal: null,
        },
      );
  });

  it("keeps the supplied state for a non-close event even without facts", () => {
    expect(
      lifecycleObservation({
        ...base,
        event: "failure",
        state: "unavailable",
        exitCode: null,
        signal: null,
      }),
    ).toMatchObject({ event: "failure", state: "unavailable" });
  });

  it("carries phase, forced flag and identity", () => {
    const identity = { hostLifetimeId: "host", childLaunchId: "child" };
    expect(
      lifecycleObservation({
        ...base,
        phase: "closing",
        forced: true,
        identity,
        exitCode: null,
        signal: "SIGKILL",
      }),
    ).toMatchObject({ phase: "closing", forced: true, ...identity });
  });
});
