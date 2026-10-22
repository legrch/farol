import { describe, expect, it } from "vitest";
// @ts-expect-error Launcher tooling deliberately remains plain JavaScript.
import * as ownedStop from "../../tooling/dev-owned-stop.mjs";

const { DEV_OWNED_STOP_LIMITS, stopRetainedDevProcess } = ownedStop;

// In-memory observations only: no processes, native lookup, profiles, or builds.
const scope = Object.freeze({
  uid: 501,
  writerRoot: "/fixture/Owner's Farol",
  appPath: "/fixture/Owner's Farol/_output/build/app/main.cjs",
  profilePath: "/fixture/Library/Application Support/Farol Dev",
});
const identity = Object.freeze({
  ...scope,
  pid: 42,
  startIdentity: "boot:fixture/kernel-start:123456.123456",
  executable: `${scope.writerRoot}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
  environment: "dev",
  applicationId: "local.farol.dev",
  installed: false,
});
type Signal = "SIGTERM" | "SIGKILL";
type Observation = { status: string; identity?: Record<string, unknown> };

function harness() {
  let time = 0;
  let observation: Observation = {
    status: "present",
    identity: { ...identity },
  };
  const calls: string[] = [];
  const signals: Signal[] = [];
  const delays: number[] = [];
  const budgets: number[] = [];
  let reads = 0;
  const hooks = {
    inspect: (_read: number): Observation => observation,
    signal: (_signal: Signal): { status: string } => ({ status: "sent" }),
    sleep: (_ms: number) => {},
  };
  const ports = {
    clock: () => time,
    sleep: async (ms: number) => {
      calls.push("sleep");
      delays.push(ms);
      time += ms;
      hooks.sleep(ms);
    },
    inspect: (pid: number, budget: number) => {
      expect(pid).toBe(identity.pid);
      calls.push("inspect");
      budgets.push(budget);
      return hooks.inspect(++reads);
    },
    signal: (
      pid: number,
      name: Signal,
      expected: typeof identity,
      budget: number,
    ) => {
      expect(pid).toBe(identity.pid);
      expect(expected).toEqual(identity);
      expect(Object.isFrozen(expected)).toBe(true);
      expect(calls.at(-1)).toBe("inspect");
      expect(budget).toBeGreaterThan(0);
      calls.push(name);
      signals.push(name);
      return hooks.signal(name);
    },
  };
  return {
    ports,
    hooks,
    calls,
    signals,
    delays,
    budgets,
    setObservation: (value: Observation) => {
      observation = value;
    },
    setTime: (value: number) => {
      time = value;
    },
    time: () => time,
    run: (retained: unknown = identity, selected: unknown = scope) =>
      stopRetainedDevProcess(retained, selected, ports),
  };
}

describe("exact retained Dev stop (pure injected ports)", () => {
  it("has frozen fixed limits and confirms initial absence without any signal", async () => {
    expect(Object.isFrozen(DEV_OWNED_STOP_LIMITS)).toBe(true);
    expect(DEV_OWNED_STOP_LIMITS).toEqual({
      gracefulMs: 30000,
      maxWaitMs: 32000,
      pollMs: 100,
    });
    const h = harness();
    h.setObservation({ status: "absent" });
    expect(await h.run()).toEqual({
      status: "absent",
      reason: "absent",
      attemptedSignals: [],
    });
    expect(h.signals).toEqual([]);
    expect(h.delays).toEqual([]);
  });

  it("rechecks immediately before SIGTERM and observes actual disappearance", async () => {
    const h = harness();
    h.hooks.signal = () => {
      h.setObservation({ status: "absent" });
      return { status: "sent" };
    };
    const result = await h.run();
    expect(result.status).toBe("absent");
    expect(result.attemptedSignals).toEqual(["SIGTERM"]);
    expect(h.calls).toEqual(["inspect", "inspect", "SIGTERM", "inspect"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attemptedSignals)).toBe(true);
  });

  it("waits for graceful exit rather than treating signal delivery as exit", async () => {
    const h = harness();
    h.hooks.sleep = () => {
      if (h.time() === 300) h.setObservation({ status: "absent" });
    };
    expect((await h.run()).status).toBe("absent");
    expect(h.time()).toBe(300);
    expect(h.signals).toEqual(["SIGTERM"]);
  });

  it("automatically escalates once at thirty seconds and awaits force exit", async () => {
    const h = harness();
    h.hooks.signal = (signal) => {
      if (signal === "SIGKILL") expect(h.time()).toBe(30000);
      return { status: "sent" };
    };
    h.hooks.sleep = () => {
      if (h.time() === 30300) h.setObservation({ status: "absent" });
    };
    expect((await h.run()).status).toBe("absent");
    expect(h.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.time()).toBe(30300);
    expect(h.budgets.every((budget) => budget >= 0 && budget <= 32000)).toBe(
      true,
    );
  });

  it("refuses at the fixed maximum even after successful SIGKILL delivery", async () => {
    const h = harness();
    expect(await h.run()).toEqual({
      status: "refused",
      reason: "STOP_TIMEOUT",
      attemptedSignals: ["SIGTERM", "SIGKILL"],
    });
    expect(h.time()).toBe(32000);
    expect(h.delays).toHaveLength(320);
    expect(h.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("accepts confirmed absence exactly at the grace boundary without forcing", async () => {
    const h = harness();
    h.hooks.sleep = () => {
      if (h.time() === 30000) h.setObservation({ status: "absent" });
    };
    expect((await h.run()).status).toBe("absent");
    expect(h.signals).toEqual(["SIGTERM"]);
  });

  it.each([
    ["pid", 43],
    ["uid", 502],
    ["startIdentity", "different-lifetime"],
    ["writerRoot", "/fixture/foreign"],
    ["appPath", "/fixture/foreign/main.cjs"],
    ["profilePath", "/fixture/other/Farol Dev"],
    ["executable", "/Applications/Farol.app/Contents/MacOS/Farol"],
    ["environment", "preview"],
    ["applicationId", "io.github.legrch.farol"],
    ["installed", true],
  ])("refuses current %s mismatch without signaling", async (field, value) => {
    const h = harness();
    h.setObservation({
      status: "present",
      identity: { ...identity, [field as string]: value },
    });
    expect((await h.run()).status).toBe("refused");
    expect(h.signals).toEqual([]);
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "catches PID reuse in the final %s recheck",
    async (signal) => {
      const h = harness();
      h.hooks.inspect = (read) => {
        const change =
          signal === "SIGTERM"
            ? read === 2
            : h.time() === 30000 && read === 304;
        return {
          status: "present",
          identity: {
            ...identity,
            startIdentity: change ? "reused" : identity.startIdentity,
          },
        };
      };
      expect((await h.run()).reason).toBe("IDENTITY_CHANGED");
      expect(h.signals).toEqual(signal === "SIGTERM" ? [] : ["SIGTERM"]);
    },
  );

  it("catches disappearance in the final force recheck without SIGKILL", async () => {
    const h = harness();
    h.hooks.inspect = (read) =>
      read === 304
        ? { status: "absent" }
        : { status: "present", identity: { ...identity } };
    expect((await h.run()).status).toBe("absent");
    expect(h.signals).toEqual(["SIGTERM"]);
  });

  it.each([
    {},
    { status: "unreadable" },
    { status: "foreign" },
    { status: "present" },
    { status: "present", identity: { ...identity, startIdentity: null } },
  ])("refuses unreadable/malformed observation %#", async (observation) => {
    const h = harness();
    h.setObservation(observation as Observation);
    expect((await h.run()).reason).toBe("IDENTITY_UNREADABLE");
    expect(h.signals).toEqual([]);
  });

  it.each([
    ["pid", -42],
    ["pid", 0],
    ["pid", 2 ** 31],
    ["pid", 42.5],
    ["uid", -1],
    ["uid", undefined],
    ["startIdentity", " "],
    ["startIdentity", "\0"],
    ["startIdentity", "x".repeat(257)],
    ["writerRoot", "/fixture/../farol"],
    ["writerRoot", "/fixture//farol"],
    ["writerRoot", "/fixture/farol/"],
    ["appPath", "relative/main.cjs"],
    ["profilePath", "/fixture/Farol"],
    ["installed", true],
  ])("rejects invalid retained %s (%#) before lookup", async (field, value) => {
    const h = harness();
    expect(
      (await h.run({ ...identity, [field as string]: value })).reason,
    ).toBe("RETAINED_IDENTITY_INVALID");
    expect(h.calls).toEqual([]);
  });

  it("requires an independently matching selected writer/profile/UID scope", async () => {
    for (const selected of [
      null,
      { ...scope, uid: 502 },
      { ...scope, profilePath: "/fixture/other/Farol Dev" },
      {
        ...scope,
        writerRoot: "/fixture/foreign",
        appPath: "/fixture/foreign/_output/build/app/main.cjs",
      },
    ]) {
      const h = harness();
      expect((await h.run(identity, selected)).status).toBe("refused");
      expect(h.calls).toEqual([]);
    }
  });

  it("snapshots retained authority before yielding to polling", async () => {
    const h = harness();
    const retained: Omit<typeof identity, "pid" | "startIdentity"> & {
      pid: number;
      startIdentity: string;
    } = { ...identity };
    h.hooks.sleep = () => {
      retained.pid = 999;
      retained.startIdentity = "mutated";
      h.setObservation({ status: "absent" });
    };
    expect((await h.run(retained)).status).toBe("absent");
    expect(h.signals).toEqual(["SIGTERM"]);
  });

  it.each(["refused", "unknown", "unexpected"])(
    "does not retry or escalate %s signal outcomes",
    async (status) => {
      const h = harness();
      h.hooks.signal = () => {
        h.setObservation({ status: "absent" });
        return { status };
      };
      expect((await h.run()).reason).toBe(
        status === "refused" ? "SIGNAL_REFUSED" : "SIGNAL_OUTCOME_UNKNOWN",
      );
      expect(h.signals).toEqual(["SIGTERM"]);
      expect(h.delays).toEqual([]);
    },
  );

  it("classifies thrown signal as unknown without retry", async () => {
    const h = harness();
    h.hooks.signal = () => {
      throw new Error("opaque native error");
    };
    expect((await h.run()).reason).toBe("SIGNAL_OUTCOME_UNKNOWN");
    expect(h.signals).toEqual(["SIGTERM"]);
  });

  it.each([true, false])(
    "requires independent confirmation of signal-reported absence (%s)",
    async (absent) => {
      const h = harness();
      h.hooks.signal = () => {
        if (absent) h.setObservation({ status: "absent" });
        return { status: "absent" };
      };
      expect((await h.run()).reason).toBe(
        absent ? "absent" : "SIGNAL_ABSENCE_UNCONFIRMED",
      );
      expect(h.signals).toEqual(["SIGTERM"]);
    },
  );

  it("refuses unreadability during force-exit observation", async () => {
    const h = harness();
    h.hooks.signal = (signal) => {
      if (signal === "SIGKILL") h.setObservation({ status: "unreadable" });
      return { status: "sent" };
    };
    expect((await h.run()).reason).toBe("IDENTITY_UNREADABLE");
    expect(h.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("refuses thrown inspection without any signal", async () => {
    const h = harness();
    h.hooks.inspect = () => {
      throw new Error("unreadable");
    };
    expect((await h.run()).reason).toBe("IDENTITY_UNREADABLE");
    expect(h.signals).toEqual([]);
  });

  it("refuses missing ports with no ambient host fallback", async () => {
    expect((await stopRetainedDevProcess(identity, scope, {})).reason).toBe(
      "PORTS_INVALID",
    );
  });

  it.each([NaN, Infinity, -1])("refuses invalid clock %s", async (time) => {
    const h = harness();
    h.setTime(time);
    expect((await h.run()).reason).toBe("CLOCK_INVALID");
    expect(h.signals).toEqual([]);
  });

  it("refuses a stalled clock without unbounded polling", async () => {
    const h = harness();
    h.hooks.sleep = () => h.setTime(0);
    expect((await h.run()).reason).toBe("CLOCK_NOT_ADVANCING");
    expect(h.delays).toHaveLength(1);
    expect(h.signals).toEqual(["SIGTERM"]);
  });

  it("caps polling work even when the injected clock barely advances", async () => {
    const h = harness();
    let ticks = 0;
    h.hooks.sleep = () => h.setTime(++ticks / 1000);
    expect((await h.run()).reason).toBe("WAIT_BUDGET_EXHAUSTED");
    expect(h.delays).toHaveLength(322);
    expect(h.signals).toEqual(["SIGTERM"]);
  });

  it("refuses a backward clock or failed sleep without forcing", async () => {
    const backward = harness();
    backward.hooks.sleep = () => backward.setTime(-1);
    expect((await backward.run()).reason).toBe("CLOCK_INVALID");
    const failed = harness();
    failed.hooks.sleep = () => {
      throw new Error("sleep unavailable");
    };
    expect((await failed.run()).reason).toBe("WAIT_UNREADABLE");
    expect(failed.signals).toEqual(["SIGTERM"]);
  });

  it("includes native adapter time in the budget and clips the last sleep", async () => {
    const h = harness();
    h.hooks.signal = (signal) => {
      if (signal === "SIGTERM") h.setTime(75);
      return { status: "sent" };
    };
    expect((await h.run()).reason).toBe("STOP_TIMEOUT");
    expect(h.delays).toContain(25);
    expect(h.time()).toBe(32000);
  });

  it("does not signal after an injected operation exhausts the total budget", async () => {
    const h = harness();
    h.hooks.sleep = () => h.setTime(32100);
    expect((await h.run()).reason).toBe("STOP_TIMEOUT");
    expect(h.signals).toEqual(["SIGTERM"]);
  });
});

// Native lookup and signaling remain outside this pure scope validation test.
it("admits the isolated Dev bundle while retaining exact executable comparison", async () => {
  const expected = {
    ...identity,
    executable: `${scope.writerRoot}/_output/dev-runtime/Farol Dev.app/Contents/MacOS/Electron`,
  };
  const h = harness();
  h.hooks.inspect = () => ({ status: "absent" });
  const result = await stopRetainedDevProcess(expected, scope, h.ports);
  expect(result.status).toBe("absent");
});
