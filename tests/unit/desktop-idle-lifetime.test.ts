import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import {
  Client,
  RequestNotSentError,
} from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";
import type {
  ComputerConnectorHealthRequest,
  Request,
} from "../../apps/desktop/bridge/wire.ts";
import { SettingsStorePump } from "../../apps/desktop/bridge/settings-store.ts";
import { GoComputerAuthority } from "../../apps/desktop/go-computer-authority.ts";

const healthBody = {
  binding: {
    buildId: "build",
    profileId: "profile",
    backendGeneration: "backend",
    runtimeId: "runtime",
    connectorGeneration: "1",
  },
  expectedInstanceId: "instance",
};

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
                  : request.method === "computer.connector.health"
                    ? {
                        binding: (
                          request.params
                            .body as unknown as ComputerConnectorHealthRequest
                        ).binding,
                        expectedInstanceId: (
                          request.params
                            .body as unknown as ComputerConnectorHealthRequest
                        ).expectedInstanceId,
                        state: "unobserved",
                        reason: "missing_snapshot",
                        localReady: false,
                      }
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

it.each(["computer.settings.store.next", "chat.browser.next"])(
  "observes the original %s poll during the IO turn after its timer",
  async (method) => {
    const f = await peer([method]);
    vi.useFakeTimers();
    try {
      const original = f.client.request(
        method,
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
      expect(f.calls.filter((call) => call.method === method)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await f.client.close();
    }
  },
);

it.each(["computer.settings.store.next", "chat.browser.next", "core.status"])(
  "still fences a missing original %s response without resending",
  async (method) => {
    const f = await peer([method]);
    vi.useFakeTimers();
    try {
      const original = f.client.request(
        method,
        method !== "core.status"
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
  "retires the running Settings pump beyond the former request cap only after the original withdrawal ACK (valid=%s)",
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
      // The former 4088-request ordinary cap no longer exists.
      for (let i = 0; i < 5000; i++)
        await client.request("core.status", {}, { id: `status-${i}` });
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

it("keeps ordinary withdrawals and the retirement exchange admissible beyond the former request cap", async () => {
  const { client, calls } = await peer();
  try {
    for (let i = 0; i < 5000; i++)
      await client.request("core.status", {}, { id: `status-${i}` });
    const before = calls.length;
    // Without a lifetime history there is no retirement reserve to protect:
    // repeatable Settings withdrawals and the retirement exchange all run.
    for (let i = 0; i < 8; i++)
      await new GoComputerAuthority(client, client.verifiedContext).withdraw();
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
      ...Array.from({ length: 8 }, () => "computer.authority.deactivate"),
      "computer.connector.close",
      "core.retirement.prepare",
      "computer.authority.deactivate",
      "core.retirement.ack",
    ]);
    // Every ordinary request took the next sequence of one connection lane.
    const nonce = /^desktop-call:([0-9a-f-]{36}):1$/u.exec(calls[0]!.id)![1];
    expect(calls.map((call) => call.id)).toEqual(
      calls.map((_, index) => `desktop-call:${nonce}:${index + 1}`),
    );
  } finally {
    await client.close();
  }
}, 30000);

it.each([
  ["missing", {}],
  ["crossed", { handoffId: "other", receiptDigest: "a".repeat(64) }],
  ["malformed", { handoffId: "handoff", receiptDigest: "short" }],
] as const)(
  "does not gate withdrawal on a %s prepare response",
  async (_name, data) => {
    const { client, calls, reply } = await peer(["core.retirement.prepare"]);
    try {
      for (let i = 0; i < 5000; i++)
        await client.request("core.status", {}, { id: `status-${i}` });
      const preparation = client.request(
        "core.retirement.prepare",
        { handoffId: "handoff" },
        { operationId: "prepare" },
      );
      reply(calls.at(-1)!, data);
      await preparation;
      const before = calls.length;
      await new GoComputerAuthority(client, client.verifiedContext).withdraw();
      expect(calls.slice(before).map((call) => call.method)).toEqual([
        "computer.authority.deactivate",
      ]);
    } finally {
      await client.close();
    }
  },
  30000,
);

it("keeps all three ordered reads and ordinary calls alive beyond the old stream budget with constant state", async () => {
  const { client, calls } = await peer();
  try {
    for (let i = 0; i < 6001; i++) {
      for (const method of [
        "chat.browser.next",
        "computer.settings.store.next",
        "computer.connector.health",
      ]) {
        const id = `${method}-${i}`;
        expect(
          (
            await client.request(
              method,
              method === "computer.connector.health"
                ? healthBody
                : { deadlineMillis: String(Date.now() + 14000) },
              { id },
            )
          ).requestId,
        ).toBe(id);
      }
    }
    expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
    expect(calls[1]!.id).toMatch(/^desktop-poll-browser:.*:1$/u);
    expect(calls[2]!.id).toMatch(/^desktop-poll-settings:.*:1$/u);
    expect(calls[3]!.id).toMatch(/^desktop-poll-health:.*:1$/u);
    const retained = client as unknown as {
      requestSequence: bigint;
      polls: Map<string, bigint>;
      pending: Map<string, unknown>;
    };
    expect(retained.requestSequence).toBe(1n); // Only the original handshake.
    expect(retained.polls.size).toBe(3);
    expect(retained.pending.size).toBe(0);
    // Ordinary calls keep one sequence, not a history: no cap, no retry.
    for (let i = 0; i < 6001; i++)
      await client.request("core.status", {}, { id: `status-${i}` });
    expect(retained.requestSequence).toBe(6002n);
    expect(retained.pending.size).toBe(0);
    expect(calls.at(-1)!.id).toMatch(/^desktop-call:[0-9a-f-]{36}:6002$/u);
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
    // A settled caller ID is not a lifetime fence; its call takes a fresh
    // wire sequence. Effect fences are the module-owned operation IDs.
    const reused = await client.request("core.status", {}, { id: "status-0" });
    expect(reused.requestId).toBe("status-0");
    expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
    // Idle observation remains independent of ordinary traffic.
    expect(
      (await client.request("chat.browser.next", { deadlineMillis: "1" }))
        .status,
    ).toBe("ok");
    await expect(
      client.request("computer.connector.health", healthBody),
    ).resolves.toMatchObject({ status: "ok", data: healthBody });
  } finally {
    await client.close();
  }
}, 30000);

it("refuses a live duplicate caller ID before submission and admits it once settled", async () => {
  const { client, calls, reply } = await peer(["core.status"]);
  try {
    const held = client.request("core.status", {}, { id: "live" });
    const count = calls.length;
    await expect(
      client.request("core.status", {}, { id: "live" }),
    ).rejects.toMatchObject({ state: "refused", code: "duplicate_request_id" });
    expect(calls).toHaveLength(count);
    reply(calls.at(-1)!);
    await expect(held).resolves.toMatchObject({ requestId: "live" });
    const again = client.request("core.status", {}, { id: "live" });
    expect(calls.at(-1)!.id).toMatch(/:3$/u);
    reply(calls.at(-1)!);
    await expect(again).resolves.toMatchObject({ requestId: "live" });
  } finally {
    await client.close();
  }
});

it("rejects forged namespaces and invalid polls before submission without spending a poll sequence", async () => {
  const { client, calls } = await peer();
  try {
    for (const [body, options] of [
      [{ deadlineMillis: "1" }, { id: "bad id" }],
      [{ deadlineMillis: "1" }, { id: "poll", operationId: "effect" }],
      [{ invalid: true }, { id: "poll" }],
      [{ deadlineMillis: "1" }, { id: "desktop-poll-browser:forged:1" }],
      [{ deadlineMillis: "1" }, { id: "desktop-call:forged:1" }],
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
    expect(calls.at(-1)!.id).toMatch(/:2$/u); // Ordinary lane, after the handshake.
    await expect(
      client.request("core.status", {}, { id: "desktop-call:forged:3" }),
    ).rejects.toMatchObject({ code: "reserved_request_id" });
    expect(calls.at(-1)!.id).toMatch(/:2$/u);
  } finally {
    await client.close();
  }
});

it("refuses invalid health reads before submission without spending an ordered sequence", async () => {
  const { client, calls } = await peer();
  try {
    for (const [body, options] of [
      [healthBody, { id: "bad id" }],
      [healthBody, { id: "health", operationId: "effect" }],
      [{ deadlineMillis: "1" }, { id: "health" }],
      [{ ...healthBody, extra: true }, { id: "health" }],
      [{ ...healthBody, expectedInstanceId: "" }, { id: "health" }],
      [{ ...healthBody, snapshot: {} }, { id: "health" }],
      [healthBody, { id: "desktop-poll-health:forged:1" }],
    ] as const) {
      await expect(
        client.request("computer.connector.health", body, options),
      ).rejects.toMatchObject({ state: "refused" });
    }
    expect(calls).toHaveLength(1);
    for (let i = 1; i <= 2; i++) {
      await expect(
        client.request("computer.connector.health", healthBody, { id: "same" }),
      ).resolves.toMatchObject({ requestId: "same", data: healthBody });
      expect(calls.at(-1)!.id).toMatch(
        new RegExp(`^desktop-poll-health:.*:${i}$`, "u"),
      );
    }
    const retained = client as unknown as { polls: Map<string, bigint> };
    retained.polls.set("health", 18446744073709551614n);
    await client.request("computer.connector.health", healthBody);
    expect(calls.at(-1)!.id).toMatch(/:18446744073709551615$/u);
    const count = calls.length;
    await expect(
      client.request("computer.connector.health", healthBody),
    ).rejects.toBeInstanceOf(RequestNotSentError);
    expect(calls).toHaveLength(count);
    await expect(client.request("core.status", {})).resolves.toMatchObject({
      status: "ok",
    });
  } finally {
    await client.close();
  }
});
