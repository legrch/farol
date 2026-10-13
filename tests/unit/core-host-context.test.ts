import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  Client,
  RequestNotSentError,
} from "../../apps/desktop/bridge/client.ts";
import { DESKTOP_CORE_STARTUP_TIMEOUT_MS } from "../../apps/desktop/go-core-host.ts";
import { SettingsDeliveryBridge } from "../../apps/desktop/bridge/settings-delivery.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";
import type { Request } from "../../apps/desktop/bridge/wire.ts";

// Serialized in-memory child pipes test host composition correlation, not a
// native child, profile, provider or product journey.
function fixture(wrongGeneration = false, responseDelayMs = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  const calls: Request[] = [];
  const decoder = new Decoder();
  child.stdin.on("data", (bytes: Buffer) =>
    decoder.push(bytes, (raw) => {
      const request = raw as Request;
      calls.push(request);
      const respond = () =>
        child.stdout.write(
          frame({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              status: "ok",
              requestId: request.id,
              context: {
                profileId: "22222222-2222-4222-8222-222222222222",
                backendGeneration: "generation",
              },
              data: {
                protocolMajor: 1,
                protocolMinor: 0,
                buildId: "build",
                profileId: "22222222-2222-4222-8222-222222222222",
                backendGeneration: wrongGeneration ? "crossed" : "generation",
                capabilities: [],
                maxFrameBytes: 1048576,
              },
            },
          }),
        );
      if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
      else respond();
    }),
  );
  return {
    child,
    calls,
    client: new Client(child as unknown as ChildProcessWithoutNullStreams),
  };
}
const hello = {
  protocolMajor: 1,
  protocolMinor: 0,
  buildId: "build",
  profileId: "22222222-2222-4222-8222-222222222222",
};
describe("verified core context for normal host composition", () => {
  it("accepts one cold handshake after the ordinary RPC deadline without replay", async () => {
    vi.useFakeTimers();
    const f = fixture(false, 2500);
    try {
      const ready = f.client.handshake(hello, DESKTOP_CORE_STARTUP_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(2500);
      await expect(ready).resolves.toMatchObject({ buildId: "build" });
      expect(f.calls.map((call) => call.method)).toEqual(["core.handshake"]);
    } finally {
      await f.client.close();
      vi.useRealTimers();
    }
  });

  it("keeps a startup deadline failure unknown and never sends a second handshake", async () => {
    vi.useFakeTimers();
    const f = fixture(false, DESKTOP_CORE_STARTUP_TIMEOUT_MS + 1);
    try {
      const failed = f.client
        .handshake(hello, DESKTOP_CORE_STARTUP_TIMEOUT_MS)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(DESKTOP_CORE_STARTUP_TIMEOUT_MS);
      expect(await failed).toMatchObject({
        state: "unknown",
        code: "response_timeout",
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.calls.map((call) => call.method)).toEqual(["core.handshake"]);
      expect(() => f.client.verifiedContext).toThrow();
    } finally {
      await f.client.close();
      vi.useRealTimers();
    }
  });

  it("proves physical non-dispatch and never fabricates an offer from missing observation", async () => {
    const f = fixture();
    await f.client.handshake(hello, 1000);
    f.child.stdin.removeAllListeners("data");
    const decoder = new Decoder();
    const sent: Request[] = [];
    f.child.stdin.on("data", (bytes: Buffer) =>
      decoder.push(bytes, (raw) => sent.push(raw as Request)),
    );
    const held = Array.from({ length: 32 }, (_, index) =>
      f.client.request("core.status", {}, { id: `held-${index}` }),
    );
    const bridge = new SettingsDeliveryBridge(f.client);
    const operationId = "11111111-1111-4111-8111-111111111111";
    const edit = {
      publication: {
        fence: "1",
        storeRevision: "2",
        settingsRevision: "3",
        generation: "4",
        approvalDigest: "a".repeat(64),
        publishOperationId: "publish",
      },
      workspaceId: "33333333-3333-4333-8333-333333333333",
      relativePath: "note.md",
      expectedSHA256: "b".repeat(64),
      edits: [{ oldText: "old", newText: "new" }],
    };
    try {
      const rejected = await bridge
        .apply(operationId, edit)
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(RequestNotSentError);
      expect(rejected).toMatchObject({
        state: "unavailable",
        code: "backpressure",
      });
      expect(sent).toHaveLength(32);
      expect(
        sent.some(
          (request) => request.method === "computer.settings.delivery.apply",
        ),
      ).toBe(false);
      await expect(bridge.apply(operationId, edit)).rejects.toMatchObject({
        code: "settings_delivery_attempt_consumed",
      });
      expect(sent).toHaveLength(32);
      for (const request of sent)
        f.child.stdout.write(
          frame({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              status: "ok",
              requestId: request.id,
              context: f.client.verifiedContext,
              data: {},
            },
          }),
        );
      await Promise.all(held);
      const observed = bridge
        .observe({
          backend: "go-owner-v2",
          operationId,
          profileId: f.client.verifiedContext.profileId,
          beforeSHA256: edit.expectedSHA256,
          submittedAt: "2026-10-05T08:00:00.000Z",
          workspaceId: "33333333-3333-4333-8333-333333333333",
          relativePath: "note.md",
          computerGeneration: "4",
        })
        .catch((error: unknown) => error);
      const request = sent.at(-1)!;
      expect(request.method).toBe("computer.settings.delivery.observe");
      expect(request.params.operationId).not.toBe(operationId);
      expect(request.params.body).not.toHaveProperty("edits");
      expect(request.params.body).not.toHaveProperty("publication");
      f.child.stdout.write(
        frame({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            status: "refused",
            requestId: request.id,
            operationId: request.params.operationId,
            context: f.client.verifiedContext,
            code: "COMPUTER_MUTATION_OPERATION_NOT_FOUND",
          },
        }),
      );
      expect(await observed).toMatchObject({
        state: "refused",
        code: "COMPUTER_MUTATION_OPERATION_NOT_FOUND",
      });
      await expect(bridge.acknowledge(operationId)).rejects.toMatchObject({
        code: "settings_delivery_offer_missing",
      });
      await expect(bridge.apply(operationId, edit)).rejects.toMatchObject({
        code: "settings_delivery_attempt_consumed",
      });
      expect(sent).toHaveLength(33);
    } finally {
      await f.client.close();
      await Promise.allSettled(held);
    }
  });
  it("refuses context access before handshake without sending anything", async () => {
    const f = fixture();
    expect(() => f.client.verifiedContext).toThrow("handshake_required");
    expect(f.calls).toHaveLength(0);
    await f.client.close();
  });
  it("exposes the immutable context from exactly one serialized handshake", async () => {
    const f = fixture();
    await f.client.handshake(hello, 1000);
    const context = f.client.verifiedContext;
    expect(context).toEqual({
      profileId: "22222222-2222-4222-8222-222222222222",
      backendGeneration: "generation",
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(f.client.verifiedContext).toBe(context);
    expect(f.calls.map((c) => c.method)).toEqual(["core.handshake"]);
    await f.client.close();
    expect(() => f.client.verifiedContext).toThrow("backend_unavailable");
  });
  it("never exposes a mismatched generation or silently handshakes again", async () => {
    const f = fixture(true);
    await expect(f.client.handshake(hello, 1000)).rejects.toThrow(
      "wrong_backend_identity",
    );
    expect(() => f.client.verifiedContext).toThrow("backend_unavailable");
    expect(f.calls).toHaveLength(1);
    await f.client.close();
  });
  it("withdraws access on child closure without manufacturing a successor", async () => {
    const f = fixture();
    await f.client.handshake(hello, 1000);
    f.child.emit("close", 0, null);
    expect(() => f.client.verifiedContext).toThrow("backend_unavailable");
    expect(f.calls).toHaveLength(1);
    await f.client.close();
  });
});
