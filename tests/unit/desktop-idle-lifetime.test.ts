import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it } from "vitest";
import {
  Client,
  RequestNotSentError,
} from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";
import type { Request } from "../../apps/desktop/bridge/wire.ts";

// Real framed Client, controlled in-memory pipe peer. No Go/Electron/provider.
async function peer() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const context = { profileId: "profile", backendGeneration: "backend" };
  const calls: Request[] = [];
  const decoder = new Decoder();
  child.stdin.on("data", (bytes: Buffer) =>
    decoder.push(bytes, (value) => {
      const request = value as Request;
      calls.push(request);
      child.stdout.write(
        frame({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            status: "ok",
            requestId: request.id,
            context,
            ...(request.params.operationId === undefined
              ? {}
              : { operationId: request.params.operationId }),
            data:
              request.method === "core.handshake"
                ? {
                    protocolMajor: 1,
                    protocolMinor: 0,
                    buildId: "build",
                    ...context,
                    capabilities: [],
                    maxFrameBytes: 1048576,
                  }
                : request.method.endsWith(".next")
                  ? { command: null }
                  : {},
          },
        }),
      );
    }),
  );
  const client = new Client(child as unknown as ChildProcessWithoutNullStreams);
  await client.handshake(
    {
      protocolMajor: 1,
      protocolMinor: 0,
      buildId: "build",
      profileId: "profile",
    },
    1000,
  );
  return { client, calls };
}

it("keeps both idle polls alive beyond a night's old stream budget and retains retirement capacity", async () => {
  const { client, calls } = await peer();
  try {
    for (let i = 0; i < 6000; i++) {
      for (const method of [
        "chat.browser.next",
        "computer.settings.store.next",
      ]) {
        const id = `${method}-${i}`;
        expect(
          (
            await client.request(
              method,
              { deadlineMillis: String(Date.now() + 14000) },
              { id },
            )
          ).requestId,
        ).toBe(id);
      }
    }
    expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
    expect(calls[1]!.id).toMatch(/^desktop-poll-browser:.*:1$/u);
    expect(calls[2]!.id).toMatch(/^desktop-poll-settings:.*:1$/u);
    // Ordinary calls retain a finite replay history; no command is retried.
    for (let i = 0; i < 4087; i++)
      await client.request("core.status", {}, { id: `status-${i}` });
    const before = calls.length;
    await expect(
      client.request("core.status", {}, { id: "overflow" }),
    ).rejects.toBeInstanceOf(RequestNotSentError);
    expect(calls).toHaveLength(before);
    for (const method of [
      "computer.connector.close",
      "core.retirement.prepare",
      "core.retirement.ack",
    ]) {
      expect(
        (
          await client.request(
            method,
            {},
            { id: `quit-${method}`, operationId: `op-${method}` },
          )
        ).status,
      ).toBe("ok");
    }
    // Idle observation remains separate from effect/control history saturation.
    expect(
      (await client.request("chat.browser.next", { deadlineMillis: "1" }))
        .status,
    ).toBe("ok");
  } finally {
    await client.close();
  }
}, 30000);

it("rejects forged namespaces and invalid polls before submission without spending a poll sequence", async () => {
  const { client, calls } = await peer();
  try {
    for (const [body, options] of [
      [{ deadlineMillis: "1" }, { id: "bad id" }],
      [{ deadlineMillis: "1" }, { id: "poll", operationId: "effect" }],
      [{ invalid: true }, { id: "poll" }],
      [{ deadlineMillis: "1" }, { id: "desktop-poll-browser:forged:1" }],
    ] as const) {
      await expect(
        client.request("chat.browser.next", body, options),
      ).rejects.toMatchObject({ state: "refused" });
    }
    expect(calls).toHaveLength(1);
    await client.request(
      "chat.browser.next",
      { deadlineMillis: "1" },
      { id: "good" },
    );
    expect(calls[1]!.id).toMatch(/:1$/u);
    await client.request("core.status", {}, { id: "original" });
    const count = calls.length;
    await expect(
      client.request("core.status", {}, { id: "original" }),
    ).rejects.toMatchObject({ code: "duplicate_request_id" });
    expect(calls).toHaveLength(count);
  } finally {
    await client.close();
  }
});
