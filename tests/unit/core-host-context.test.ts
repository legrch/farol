import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Client } from "../../apps/desktop/bridge/client.ts";
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
