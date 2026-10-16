import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "../../apps/desktop/bridge/client";
import { Decoder, frame } from "../../apps/desktop/bridge/frame";
import type { Request } from "../../apps/desktop/bridge/wire";

// Real framed Client, in-memory pipes only. No Go, Electron, physical effect,
// provider, process termination or installed acceptance is exercised here.
const context = { profileId: "profile", backendGeneration: "backend" };
const binding = {
  ...context,
  buildId: "build",
  runtimeId: "runtime",
  connectorGeneration: "1",
};
const samples = {
  cycles: "10",
  errors: "0",
  lastSuccessMillis: "1700000000000",
};
const value = () => ({
  binding: { ...binding },
  state: "recent",
  observedAtMillis: "1700000001000",
  cycles: "10",
  errors: "0",
  ageSeconds: "1",
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});
async function fixture(holdStatus = false) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  const requests: Request[] = [];
  const reply = (
    request: Request,
    data: unknown,
    extra: Record<string, unknown> = {},
  ) =>
    child.stdout.write(
      frame({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          status: "ok",
          requestId: request.id,
          context,
          data,
          ...extra,
        },
      }),
    );
  const decoder = new Decoder();
  child.stdin.on("data", (bytes: Buffer) =>
    decoder.push(bytes, (raw) => {
      const request = raw as Request;
      requests.push(request);
      if (request.method === "core.handshake")
        reply(request, {
          protocolMajor: 1,
          protocolMinor: 0,
          buildId: "build",
          ...context,
          capabilities: [],
          maxFrameBytes: 1048576,
        });
      if (request.method === "core.status" && !holdStatus)
        reply(request, { alive: true });
    }),
  );
  const client = new Client(child as unknown as ChildProcessWithoutNullStreams);
  cleanups.push(() => client.close());
  await client.handshake(
    {
      protocolMajor: 1,
      protocolMinor: 0,
      buildId: "build",
      profileId: "profile",
    },
    1000,
  );
  vi.useFakeTimers();
  vi.setSystemTime(1700000001000);
  const body = { binding: { ...binding }, samples: { ...samples } };
  const query = () =>
    client
      .request("computer.connector.polling", body, {
        id: "original-observation",
        timeoutMs: 5000,
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
  return {
    client,
    requests,
    reply,
    rawReply: (value: unknown) => child.stdout.write(frame(value)),
    body,
    query,
    last: () => requests.at(-1)!,
  };
}
it.each(["timer-first", "stdout-first", "clock-rollback"])(
  "discards the expired original observation without poisoning the pipe (%s)",
  async (ordering) => {
    const f = await fixture();
    const pending = f.query();
    const original = f.last();
    if (ordering === "stdout-first") vi.setSystemTime(Date.now() + 16000);
    else {
      vi.advanceTimersByTime(5000);
      if (ordering === "clock-rollback") vi.setSystemTime(Date.now() - 60000);
    }
    f.reply(original, value());
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({
      error: { state: "refused", code: "connector_polling_expired" },
    });
    expect(f.client.verifiedContext).toEqual(context);
    expect(f.client.lifecycleObservations).toEqual([]);
    expect(
      f.requests.filter((r) => r.method === "computer.connector.polling"),
    ).toHaveLength(1);
    const status = await f.client.request(
      "core.status",
      {},
      { id: "explicit-next-status", timeoutMs: 1000 },
    );
    expect(status.data).toEqual({ alive: true });
    await expect(
      f.client.request("computer.connector.polling", f.body, {
        id: original.id,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: "duplicate_request_id" });
  },
);
it("publishes an on-time original observation", async () => {
  const f = await fixture();
  const pending = f.query();
  f.reply(f.last(), value());
  expect(await pending).toMatchObject({ value: { data: value() } });
  expect(f.client.verifiedContext).toEqual(context);
});
it("retains the sent binding and samples when the caller mutates its input", async () => {
  const f = await fixture();
  const pending = f.query();
  const original = f.last();
  f.body.binding.runtimeId = "caller-mutated";
  f.body.samples.cycles = "999";
  vi.advanceTimersByTime(5000);
  f.reply(original, value());
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toMatchObject({
    error: { code: "connector_polling_expired" },
  });
  expect(f.client.verifiedContext).toEqual(context);
});
it("keeps a missing original response fatal without retry", async () => {
  const f = await fixture();
  const pending = f.query();
  await vi.advanceTimersByTimeAsync(5001);
  expect(await pending).toMatchObject({ error: { code: "response_timeout" } });
  expect(() => f.client.verifiedContext).toThrow("backend_unavailable");
  expect(
    f.requests.filter((r) => r.method === "computer.connector.polling"),
  ).toHaveLength(1);
});
it.each([
  "shape",
  "binding",
  "cycles",
  "errors",
  "age",
  "operation",
  "context",
  "request",
  "status",
  "code",
  "wire-id",
  "protocol-error",
])("keeps an invalid late original response fatal (%s)", async (kind) => {
  const f = await fixture();
  const pending = f.query();
  const original = f.last();
  vi.advanceTimersByTime(5000);
  const data: Record<string, unknown> = value(),
    extra: Record<string, unknown> = {};
  if (kind === "shape") data.observedAtMillis = "invalid";
  if (kind === "binding") data.binding = { ...binding, runtimeId: "crossed" };
  if (kind === "cycles") data.cycles = "11";
  if (kind === "errors") data.errors = "1";
  if (kind === "age") delete data.ageSeconds;
  if (kind === "operation") extra.operationId = "crossed";
  if (kind === "context")
    extra.context = { ...context, backendGeneration: "crossed" };
  if (kind === "request") extra.requestId = "crossed";
  if (kind === "status") extra.status = "unknown";
  if (kind === "code") extra.code = "unexpected";
  if (kind === "protocol-error")
    f.rawReply({
      jsonrpc: "2.0",
      id: original.id,
      error: { code: -32600, message: "synthetic-refusal" },
    });
  else if (kind === "wire-id")
    f.rawReply({
      jsonrpc: "2.0",
      id: "crossed-wire-id",
      result: { status: "ok", requestId: "crossed-wire-id", context, data },
    });
  else f.reply(original, data, extra);
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toHaveProperty("error");
  expect(() => f.client.verifiedContext).toThrow("backend_unavailable");
});
it("refuses a polling operation ID or invalid body before writing", async () => {
  const f = await fixture();
  const before = f.requests.length;
  const operation = f.client
    .request("computer.connector.polling", f.body, {
      id: "effect-shape",
      operationId: "not-an-effect",
    })
    .catch((error) => error);
  const missing = f.client
    .request("computer.connector.polling", {}, { id: "missing-binding" })
    .catch((error) => error);
  expect(f.requests).toHaveLength(before);
  expect(await operation).toMatchObject({ code: "invalid_request" });
  expect(await missing).toMatchObject({ code: "invalid_request" });
  expect(f.requests).toHaveLength(before);
  expect(f.client.verifiedContext).toEqual(context);
});
it("keeps ordinary RPC expiry fatal even if a valid response is already available", async () => {
  const f = await fixture(true);
  const pending = f.client
    .request("core.status", {}, { id: "ordinary-not-polling", timeoutMs: 5000 })
    .catch((error) => error);
  vi.advanceTimersByTime(5000);
  f.reply(f.last(), {});
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toMatchObject({ code: "response_timeout" });
  expect(() => f.client.verifiedContext).toThrow("backend_unavailable");
});
