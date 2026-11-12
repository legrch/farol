import { describe, expect, it, vi } from "vitest";
import { ContinuityStatusBridge } from "../../apps/desktop/bridge/continuity-status";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client";

const base = {
  present: true,
  restricted: true,
  currentQualified: false,
  entryCount: 1,
  delivery: "not_recorded",
  pendingOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  pendingPhase: "settings_intent",
};
function fixture(outcomes: unknown[]) {
  const request = vi.fn().mockImplementation(async () => outcomes.shift());
  const bridge = new ContinuityStatusBridge({
    request,
  } as unknown as Pick<Client, "request">);
  return { bridge, request };
}

describe("protected Go continuity status through real typed wire bridge", () => {
  it("reads pending WAL without dispatching an effect or granting authority", async () => {
    const f = fixture([{ status: "ok", data: base }]);
    await expect(f.bridge.observe()).resolves.toEqual(base);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "computer.continuity.status",
      {},
    );
  });
  it("does not settle a second ordinary command with equal Settings bytes", async () => {
    const f = fixture([
      { status: "ok", data: base },
      { status: "ok", data: { ...base, pendingPhase: "settings_ack" } },
    ]);
    expect((await f.bridge.observe()).restricted).toBe(true);
    expect((await f.bridge.observe()).restricted).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("rejects missing or contradictory native proof", async () => {
    for (const changed of [
      { currentQualified: true },
      { pendingOperationId: undefined },
      { pendingPhase: undefined },
      { restricted: false },
      { entryCount: -1 },
      { delivery: "delivered" },
    ]) {
      const f = fixture([{ status: "ok", data: { ...base, ...changed } }]);
      await expect(f.bridge.observe()).rejects.toBeInstanceOf(BridgeError);
    }
  });
  it("does not turn refusal, transport unknown or a crossed operation into success", async () => {
    for (const answer of [
      { status: "refused", code: "WORKSPACE_TRANSITION_PENDING" },
      { status: "unknown", code: "backend_unavailable" },
      { status: "ok", operationId: "other", data: base },
    ]) {
      const f = fixture([answer]);
      await expect(f.bridge.observe()).rejects.toBeInstanceOf(BridgeError);
    }
  });
});
