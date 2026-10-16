import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import {
  Client,
  RequestNotSentError,
} from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";
import type { Request } from "../../apps/desktop/bridge/wire.ts";
import { SettingsStorePump } from "../../apps/desktop/bridge/settings-store.ts";
import { GoComputerAuthority } from "../../apps/desktop/go-computer-authority.ts";

// Real framed Client, controlled in-memory pipe peer. No Go/Electron/provider.
async function peer(heldMethods: readonly string[] = []) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const context = { profileId: "profile", backendGeneration: "backend" };
  const calls: Request[] = [];
  const answered = new Set<Request>();
  const reply = (request: Request, data?: unknown) => {
    if (answered.has(request)) return;
    answered.add(request);
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
            data ??
            (request.method === "core.handshake"
              ? {
                  protocolMajor: 1,
                  protocolMinor: 0,
                  buildId: "build",
                  ...context,
                  capabilities: [],
                  maxFrameBytes: 1048576,
                }
              : request.method === "core.retirement.prepare"
                ? {
                    handoffId: (request.params.body as { handoffId: string })
                      .handoffId,
                    receiptDigest: "a".repeat(64),
                  }
                : request.method === "computer.authority.deactivate"
                  ? { fence: "1", storeRevision: "0" }
                  : {}),
        },
      }),
    );
  };
  const decoder = new Decoder();
  child.stdin.on("data", (bytes: Buffer) =>
    decoder.push(bytes, (value) => {
      const request = value as Request;
      calls.push(request);
      if (!heldMethods.includes(request.method)) reply(request);
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
  return { client, calls, reply };
}

it("observes the original settings poll during the IO turn after its timer", async () => {
  const f = await peer(["computer.settings.store.next"]);
  vi.useFakeTimers();
  try {
    const original = f.client.request(
      "computer.settings.store.next",
      { deadlineMillis: String(Date.now() + 90) },
      { timeoutMs: 100 },
    );
    vi.advanceTimersByTime(100);
    expect(f.client.verifiedContext.backendGeneration).toBe("backend");
    f.reply(f.calls.at(-1)!);
    await expect(original).resolves.toMatchObject({ status: "ok", data: {} });
    vi.advanceTimersByTime(1);
    await expect(f.client.request("core.status", {})).resolves.toMatchObject({
      status: "ok",
    });
    expect(
      f.calls.filter((call) => call.method === "computer.settings.store.next"),
    ).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await f.client.close();
  }
});

it.each(["computer.settings.store.next", "core.status"])(
  "still fences a missing original %s response without resending",
  async (method) => {
    const f = await peer([method]);
    vi.useFakeTimers();
    try {
      const original = f.client.request(
        method,
        method === "computer.settings.store.next"
          ? { deadlineMillis: String(Date.now() + 90) }
          : {},
        { timeoutMs: 100 },
      );
      const rejected = expect(original).rejects.toMatchObject({
        state: "unknown",
        code: "response_timeout",
      });
      vi.advanceTimersByTime(101);
      await rejected;
      expect(() => f.client.verifiedContext).toThrow();
      expect(f.calls.filter((call) => call.method === method)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await f.client.close();
    }
  },
);

it.each([true, false])(
  "retires the running Settings pump at history saturation only after the original withdrawal ACK (valid=%s)",
  async (valid) => {
    const { client, calls, reply } = await peer([
      "computer.settings.store.next",
      "computer.authority.deactivate",
    ]);
    const authority = new GoComputerAuthority(client, client.verifiedContext);
    let fences = 0;
    const pump = new SettingsStorePump(client, {
      read: async () => {
        throw new Error("unexpected_read");
      },
      replace: async () => {
        throw new Error("unexpected_replace");
      },
      fence: async () => {
        fences++;
        await authority.withdraw();
      },
    });
    pump.start();
    try {
      for (let i = 0; i < 4087; i++)
        await client.request("core.status", {}, { id: `status-${i}` });
      await expect(
        client.request("core.status", {}, { id: "overflow" }),
      ).rejects.toBeInstanceOf(RequestNotSentError);
      await client.request(
        "core.retirement.prepare",
        { handoffId: "handoff" },
        { operationId: "prepare" },
      );
      const stopped = pump.stop();
      expect(pump.stop()).toBe(stopped);
      expect(pump.state).toBe("running");
      expect(pump.fenceState).toBe("pending");
      const withdrawal = calls.filter(
        (call) => call.method === "computer.authority.deactivate",
      );
      expect(withdrawal).toHaveLength(1);
      reply(
        calls.find((call) => call.method === "computer.settings.store.next")!,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pump.fenceState).toBe("pending");
      expect(pump.state).toBe("running");
      reply(withdrawal[0]!, valid ? { fence: "1", storeRevision: "0" } : {});
      await stopped;
      expect(fences).toBe(1);
      expect(pump.state).toBe(valid ? "stopped" : "unknown");
      expect(pump.fenceState).toBe(valid ? "confirmed" : "failed");
      await pump.stop();
      expect(fences).toBe(1);
      if (valid) {
        await client.request(
          "computer.connector.close",
          {},
          { operationId: "close" },
        );
        await client.request("core.retirement.ack", {}, { operationId: "ack" });
      }
      expect(
        calls.filter((call) => call.method === "core.retirement.ack"),
      ).toHaveLength(valid ? 1 : 0);
      expect(
        calls.filter((call) => call.method === "computer.authority.deactivate"),
      ).toHaveLength(1);
    } finally {
      for (const call of calls) reply(call);
      await pump.stop();
      await client.close();
    }
  },
  30000,
);

it("refuses ordinary authority withdrawals before consuming retirement capacity", async () => {
  const { client, calls } = await peer();
  try {
    for (let i = 0; i < 4087; i++)
      await client.request("core.status", {}, { id: `status-${i}` });
    const before = calls.length;
    // Independent callers cannot spend the reserve through a repeatable
    // Settings withdrawal. The caller refuses before any later save/publish.
    for (let i = 0; i < 8; i++) {
      const authority = new GoComputerAuthority(client, client.verifiedContext);
      await expect(authority.withdraw()).rejects.toBeInstanceOf(
        RequestNotSentError,
      );
    }
    expect(calls).toHaveLength(before);
    await client.request(
      "computer.connector.close",
      {},
      { operationId: "close" },
    );
    await client.request(
      "core.retirement.prepare",
      { handoffId: "handoff" },
      { operationId: "prepare" },
    );
    await new GoComputerAuthority(client, client.verifiedContext).withdraw();
    await client.request("core.retirement.ack", {}, { operationId: "ack" });
    expect(calls.slice(before).map((call) => call.method)).toEqual([
      "computer.connector.close",
      "core.retirement.prepare",
      "computer.authority.deactivate",
      "core.retirement.ack",
    ]);
  } finally {
    await client.close();
  }
}, 30000);

it.each([
  ["missing", {}],
  ["crossed", { handoffId: "other", receiptDigest: "a".repeat(64) }],
  ["malformed", { handoffId: "handoff", receiptDigest: "short" }],
] as const)(
  "keeps the withdrawal reserve closed after a %s prepare response",
  async (_name, data) => {
    const { client, calls, reply } = await peer(["core.retirement.prepare"]);
    try {
      for (let i = 0; i < 4087; i++)
        await client.request("core.status", {}, { id: `status-${i}` });
      const preparation = client.request(
        "core.retirement.prepare",
        { handoffId: "handoff" },
        { operationId: "prepare" },
      );
      reply(calls.at(-1)!, data);
      await preparation;
      const before = calls.length;
      await expect(
        new GoComputerAuthority(client, client.verifiedContext).withdraw(),
      ).rejects.toBeInstanceOf(RequestNotSentError);
      expect(calls).toHaveLength(before);
    } finally {
      await client.close();
    }
  },
  30000,
);

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
            method === "core.retirement.prepare"
              ? { handoffId: "handoff" }
              : {},
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
