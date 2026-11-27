import { describe, expect, it } from "vitest";
import { initial } from "../../../apps/desktop/renderer/snapshot";
import type { Intent, WindowSnapshot } from "./contract";
import {
  deepTestUnconfirmedPatch,
  fingerprint,
  intentPatch,
  ordersSetupCheck,
  pendingPatch,
  recoveryRetryPatch,
  releasesLatch,
  settledOriginalPatch,
} from "./latch";

const state = (patch: Partial<WindowSnapshot> = {}): WindowSnapshot => ({
  ...initial,
  ...patch,
});
const result = (s: Intent["state"]): Intent => ({
  id: "k",
  state: s,
  code: null,
});

describe("fingerprint", () => {
  it("is a stable lowercase SHA-256 digest of the payload", async () => {
    const a = await fingerprint({ a: 1 });
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(await fingerprint({ a: 1 })).toBe(a);
    expect(await fingerprint({ a: 2 })).not.toBe(a);
  });
});

describe("pending latch", () => {
  it("installs a pending in-flight intent and keeps the others", () => {
    const base = state({ intents: { other: result("applied") } });
    const patch = pendingPatch(base, "k", null);
    expect(patch.intents).toEqual({
      other: result("applied"),
      k: { id: "k", state: "pending", code: null, inFlight: true },
    });
    expect(patch.setupCheckOrder).toBeUndefined();
  });
  it("records the check order only for a settings intention", () => {
    expect(ordersSetupCheck("settings:x:")).toBe(true);
    expect(ordersSetupCheck("deep-test:run:1")).toBe(false);
    const base = state({ setupCheckOrder: { a: 1 } });
    expect(pendingPatch(base, "settings:x:", 2).setupCheckOrder).toEqual({
      a: 1,
      "settings:x:": 2,
    });
  });
  it("publishes one result without touching other intentions", () => {
    const base = state({ intents: { other: result("pending") } });
    expect(intentPatch(base, "k", result("applied")).intents).toEqual({
      other: result("pending"),
      k: result("applied"),
    });
  });
  it("keeps the latch only for an unknown outcome or retained settlement", () => {
    expect(releasesLatch(result("applied"), false)).toBe(true);
    expect(releasesLatch(result("refused"), false)).toBe(true);
    expect(releasesLatch(result("unknown"), false)).toBe(false);
    expect(releasesLatch(result("applied"), true)).toBe(false);
  });
});

describe("recovery retry record", () => {
  const recovery = { receiptId: "r1" } as never;
  const command = {
    kind: "connector.save-and-connect",
    recovery,
  } as never;
  it("records the named fence for a dispatched retry", () => {
    expect(recoveryRetryPatch(state(), command, "k")).toEqual({
      recoveryRetries: { k: recovery },
    });
  });
  it("never overwrites an identity already recorded", () => {
    const base = state({
      recoveryRetries: { k: { receiptId: "old" } as never },
    });
    expect(recoveryRetryPatch(base, command, "k")).toBeNull();
  });
  it("records nothing for other commands or without a recovery", () => {
    expect(
      recoveryRetryPatch(state(), { kind: "chatgpt.verify" } as never, "k"),
    ).toBeNull();
    expect(
      recoveryRetryPatch(
        state(),
        { kind: "connector.save-and-connect" } as never,
        "k",
      ),
    ).toBeNull();
  });
});

describe("settledOriginalPatch", () => {
  const acknowledged = {
    submitted: { intention: "orig" },
    state: "applied" as const,
    code: null,
  };
  it("settles only an original intent still unknown", () => {
    const base = state({ intents: { orig: result("unknown") } as never });
    const patch = settledOriginalPatch(base, acknowledged);
    expect(patch?.intents?.k?.state).toBe("applied");
    expect(
      settledOriginalPatch(
        state({ intents: { orig: result("applied") } as never }),
        acknowledged,
      ),
    ).toBeNull();
    expect(settledOriginalPatch(state(), acknowledged)).toBeNull();
  });
});

describe("deepTestUnconfirmedPatch", () => {
  it("marks a missing, pending or unknown run unknown", () => {
    for (const intents of [
      {},
      { "deep-test:run:1": result("pending") },
      { "deep-test:run:1": result("unknown") },
    ]) {
      const patch = deepTestUnconfirmedPatch(
        state({ intents: intents as never }),
        "1",
      );
      expect(patch?.intents?.["deep-test:run:1"]).toEqual({
        id: "deep-test:run:1",
        state: "unknown",
        code: "CHATGPT_CONVERSATION_UNCONFIRMED",
      });
    }
  });
  it("never rewrites a settled run", () => {
    expect(
      deepTestUnconfirmedPatch(
        state({ intents: { "deep-test:run:1": result("applied") } as never }),
        "1",
      ),
    ).toBeNull();
  });
});
