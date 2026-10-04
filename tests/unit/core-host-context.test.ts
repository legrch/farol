import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Client } from "../../apps/desktop/bridge/client.ts";
import {
  SettingsMutationBridge,
  reportSettingsMutationFailure,
} from "../../apps/desktop/bridge/settings-mutation.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";
import type { Request } from "../../apps/desktop/bridge/wire.ts";

// Serialized in-memory child pipes test host composition correlation, not a
// native child, profile, provider or product journey.
function fixture(wrongGeneration = false) {
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
      child.stdout.write(
        frame({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            status: "ok",
            requestId: request.id,
            context: { profileId: "profile", backendGeneration: "generation" },
            data: {
              protocolMajor: 1,
              protocolMinor: 0,
              buildId: "build",
              profileId: "profile",
              backendGeneration: wrongGeneration ? "crossed" : "generation",
              capabilities: [],
              maxFrameBytes: 1048576,
            },
          },
        }),
      );
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
  profileId: "profile",
};
describe("verified core context for normal host composition", () => {
  it("proves backpressure before physical edit dispatch and observes only the same non-admission", async () => {
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
    const bridge = new SettingsMutationBridge(f.client);
    const edit = {
      publication: {
        fence: "1",
        storeRevision: "2",
        settingsRevision: "3",
        generation: "4",
        approvalDigest: "a".repeat(64),
        publishOperationId: "publish",
      },
      workspaceId: "work",
      relativePath: "note.md",
      expectedSHA256: "b".repeat(64),
      edits: [{ oldText: "old", newText: "new" }],
    };
    let invalidations = 0;
    const report = (error: unknown) =>
      reportSettingsMutationFailure(error, async () => {
        invalidations++;
      });
    try {
      expect(await bridge.edit("edit", edit).catch(report)).toBe(
        "WORKSPACE_MUTATION_NOT_ADMITTED",
      );
      expect(sent).toHaveLength(32);
      expect(
        sent.some((request) => request.method === "computer.settings.edit"),
      ).toBe(false);
      await expect(bridge.edit("edit", edit)).rejects.toMatchObject({
        code: "settings_mutation_attempt_consumed",
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
          operationId: "edit",
          workspaceId: "work",
          relativePath: "note.md",
          computerGeneration: "4",
        })
        .catch(report);
      const request = sent.at(-1)!;
      expect(request.method).toBe("computer.settings.mutation.read");
      f.child.stdout.write(
        frame({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            status: "refused",
            requestId: request.id,
            context: f.client.verifiedContext,
            code: "COMPUTER_MUTATION_OPERATION_NOT_FOUND",
          },
        }),
      );
      expect(await observed).toBe("WORKSPACE_MUTATION_NOT_ADMITTED");
      expect(invalidations).toBe(0);
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
      profileId: "profile",
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
