import { describe, expect, it, vi } from "vitest";
import {
  ContinuitySequence,
  type ContinuitySequencePorts,
} from "../../src/apps/desktop/workspace-continuity-sequence";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const stoppedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const digest = "a".repeat(64);
const prepared = {
  state: "prepared" as const,
  root: "/synthetic/approved",
  currentDevice: "17",
  currentInode: "42",
};

function fixture(changes: Partial<ContinuitySequencePorts> = {}) {
  const calls: string[] = [];
  let current = true;
  const port: ContinuitySequencePorts = {
    current: () => current,
    recoveryQualified: async () => true,
    priorStopSettled: async () => true,
    stop: async () => {
      calls.push("stop");
      return true;
    },
    recordStopped: async () => {
      calls.push("record-stopped");
      return {
        state: "confirmed",
        revision: 7,
        generation: 4,
        operationId: stoppedId,
      };
    },
    admit: async () => {
      calls.push("admit");
      return { state: "admitted", operationId: id };
    },
    picker: async () => {
      calls.push("picker");
      return "confirmed";
    },
    confirm: async () => {
      calls.push("confirm");
      return prepared;
    },
    refuseBeforeWithdraw: async () => {
      calls.push("refuse");
      return true;
    },
    plan: async (_id, phase) => {
      calls.push(`plan:${phase}`);
      return { effectId: `${phase}-1`, digest };
    },
    intent: async (_id, phase) => {
      calls.push(`intent:${phase}`);
      return true;
    },
    acknowledge: async (_id, phase) => {
      calls.push(`ack:${phase}`);
      return true;
    },
    withdraw: async () => {
      calls.push("withdraw");
      return {
        state: "acknowledged",
        receipt: { effectId: "withdraw_intent-1", digest },
      };
    },
    settings: async () => {
      calls.push("settings");
      return {
        state: "acknowledged",
        receipt: { effectId: "settings_intent-1", digest },
      };
    },
    stage: async () => {
      calls.push("stage");
      return {
        state: "acknowledged",
        receipt: { effectId: "publish_intent-1", digest },
      };
    },
    closeAndCertify: async () => {
      calls.push("close");
      return true;
    },
    qualifyCurrent: async () => {
      calls.push("qualify-current");
      return "unavailable";
    },
    ...changes,
  };
  return {
    port,
    calls,
    make: () => new ContinuitySequence(port),
    loseCurrent: () => {
      current = false;
    },
  };
}

describe("single-owner C5 continuity sequencing (synthetic ports, no native/provider)", () => {
  it("records every original WAL intent before its effect, does not claim current activation", async () => {
    const f = fixture();
    expect(await f.make().run(false)).toEqual({
      state: "committed-not-active",
      operationId: id,
    });
    for (const [intent, effect] of [
      ["intent:withdraw_intent", "withdraw"],
      ["intent:settings_intent", "settings"],
      ["intent:publish_intent", "stage"],
      ["intent:close_intent", "close"],
    ] as const)
      expect(f.calls.indexOf(intent)).toBeLessThan(f.calls.indexOf(effect));
    expect(f.calls).toEqual([
      "stop",
      "record-stopped",
      "admit",
      "confirm",
      "plan:withdraw_intent",
      "intent:withdraw_intent",
      "withdraw",
      "ack:withdraw_ack",
      "plan:settings_intent",
      "intent:settings_intent",
      "settings",
      "ack:settings_ack",
      "plan:publish_intent",
      "intent:publish_intent",
      "stage",
      "ack:publish_ack",
      "plan:close_intent",
      "intent:close_intent",
      "close",
      "qualify-current",
    ]);
  });

  it("refuses an unqualified recovery reader before stop or WAL", async () => {
    const f = fixture({ recoveryQualified: async () => "unavailable" });
    expect(await f.make().run(false)).toEqual({
      state: "refused",
      phase: "stop",
    });
    expect(f.calls).not.toContain("stop");
    expect(f.calls).not.toContain("admit");
  });

  it("separates qualified CURRENT activation from historical certificate", async () => {
    const f = fixture({ qualifyCurrent: vi.fn(async () => true as const) });
    expect(await f.make().run(false)).toEqual({
      state: "current-qualified",
      operationId: id,
    });
  });

  it("unknown stopped-state publication blocks a second ordinary request, even for equal Settings bytes", async () => {
    const f = fixture({ recordStopped: async () => ({ state: "unknown" }) });
    const run = f.make();
    expect(await run.run(false)).toEqual({
      state: "unknown",
      phase: "record-stopped",
    });
    // Simulate same visible Settings values: these are not an original ACK.
    expect(run.stoppedPublicationUnconfirmed).toBe(true);
    expect(await run.run(false)).toEqual({ state: "refused", phase: "stop" });
    expect(f.calls).not.toContain("admit");
  });

  it("fresh ordinary request cannot overwrite an unknown stopped publication based on equal Settings bytes", async () => {
    // Two separate sequencers (two ordinary UI commands). The real stop owner
    // must return its original durable custody; this double represents it.
    let originalStoppedOutcome: true | "unknown" = true;
    const first = fixture({
      priorStopSettled: async () => originalStoppedOutcome,
      recordStopped: async () => {
        originalStoppedOutcome = "unknown";
        return { state: "unknown" };
      },
    });
    expect(await first.make().run(false)).toEqual({
      state: "unknown",
      phase: "record-stopped",
    });
    const second = fixture({
      priorStopSettled: async () => originalStoppedOutcome,
      recordStopped: async () => ({
        state: "confirmed",
        revision: 7,
        generation: 4,
        operationId: stoppedId,
      }),
    });
    // A new fixture has the same synthetic visible Settings values; this is
    // explicitly NOT proof of the first operation's original stop ACK.
    expect(await second.make().run(false)).toEqual({
      state: "refused",
      phase: "stop",
    });
    expect(second.calls).not.toContain("stop");
    expect(second.calls).not.toContain("admit");
  });

  it("missing independent stopped-publication proof refuses before stop and Go WAL", async () => {
    const f = fixture({ priorStopSettled: async () => "unknown" });
    expect(await f.make().run(false)).toEqual({
      state: "refused",
      phase: "stop",
    });
    expect(f.calls).not.toContain("stop");
    expect(f.calls).not.toContain("admit");
  });

  it("a thrown stop is UNKNOWN, never eligible for a new transition UUID", async () => {
    const f = fixture({
      stop: async () => {
        throw Error("transport lost");
      },
    });
    const run = f.make();
    expect(await run.run(false)).toEqual({ state: "unknown", phase: "stop" });
    expect(await run.run(false)).toMatchObject({ state: "refused" });
    expect(f.calls).not.toContain("admit");
  });

  it("known legacy picker cancellation certifies a pre-withdraw refusal with no Settings mutation", async () => {
    const f = fixture({ picker: async () => "cancelled" });
    expect(await f.make().run(true)).toEqual({
      state: "refused",
      phase: "confirm",
    });
    expect(f.calls).toContain("refuse");
    expect(f.calls).not.toContain("withdraw");
    expect(f.calls).not.toContain("settings");
  });

  it("uncertain picker cleanup never pretends a known refusal", async () => {
    const f = fixture({
      picker: async () => "cancelled",
      refuseBeforeWithdraw: async () => "unknown",
    });
    expect(await f.make().run(true)).toEqual({
      state: "unknown",
      phase: "confirm",
    });
  });

  it("wrong per-effect ACK never dispatches the next effect", async () => {
    const f = fixture({
      withdraw: async () => ({
        state: "acknowledged",
        receipt: { effectId: "wrong", digest },
      }),
    });
    expect(await f.make().run(false)).toEqual({
      state: "unknown",
      phase: "withdraw",
    });
    expect(f.calls).not.toContain("settings");
  });

  it("invalid plan fails closed before the corresponding effect", async () => {
    const f = fixture({ plan: async () => ({ effectId: "", digest }) });
    expect(await f.make().run(false)).toEqual({
      state: "unknown",
      phase: "withdraw",
    });
    expect(f.calls).not.toContain("withdraw");
  });

  it("unknown Settings result cannot retry or advance to staged publication", async () => {
    const f = fixture({ settings: async () => ({ state: "unknown" }) });
    const run = f.make();
    expect(await run.run(false)).toEqual({
      state: "unknown",
      phase: "settings",
    });
    expect(await run.run(false)).toMatchObject({ state: "refused" });
    expect(f.calls).not.toContain("stage");
  });

  it("stale runtime after Go admission never dispatches withdraw", async () => {
    let lose!: () => void;
    const f = fixture({
      admit: async () => {
        lose();
        return { state: "admitted", operationId: id };
      },
    });
    lose = f.loseCurrent;
    expect(await f.make().run(false)).toEqual({
      state: "unknown",
      phase: "admit",
    });
    expect(f.calls).not.toContain("withdraw");
  });
});

it.each([
  ["withdraw_intent", "withdraw"],
  ["settings_intent", "settings"],
  ["publish_intent", "stage"],
  ["close_intent", "close"],
] as const)(
  "keeps acknowledged %s but fences its effect after losing ownership",
  async (phase, effect) => {
    let release!: (value: true) => void;
    let entered!: () => void;
    const pending = new Promise<true>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture({
      intent: async (_id, next) => {
        f.calls.push(`intent:${next}`);
        if (next === phase) {
          entered();
          return pending;
        }
        return true;
      },
    });
    const run = f.make().run(false);
    await waiting;
    f.loseCurrent();
    release(true);
    expect(await run).toMatchObject({ state: "unknown" });
    expect(f.calls).toContain(`intent:${phase}`);
    expect(f.calls).not.toContain(effect);
    expect(f.calls).not.toContain("qualify-current");
  },
);
