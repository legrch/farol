import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundaries = vi.hoisted(() => ({
  createServer: vi.fn(),
  createConnection: vi.fn(),
  mkdir: vi.fn(),
  lstat: vi.fn(),
  chmod: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:net", () => ({
  createServer: boundaries.createServer,
  createConnection: boundaries.createConnection,
}));
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: boundaries.mkdir,
    lstat: boundaries.lstat,
    chmod: boundaries.chmod,
    rm: boundaries.rm,
  },
}));

import {
  startCodexCallerRelay,
  type CodexCallerRelayRuntime,
  type CodexCallerRelayOwnedResult,
  type CodexCallerRelayInvocation,
} from "../../src/apps/desktop/codex-caller-relay";
import { CodexCallerRelayClient } from "../../src/apps/computer-mcp/codex-caller-relay-client";
import {
  CodexCallerRelayOperationSchema,
  CodexCallerRelayResponseSchema,
  CALLER_RELAY_MAX_FRAME_BYTES,
  type CodexCallerRelayOperation,
} from "../../src/pkg/caller-relay/protocol";

// Actual server/client data handlers, schema, registry and operation owner with
// in-memory net/fs boundaries. Fake listen/connect never touch OS sockets/files.
// Owned callbacks count simulated effects/Go ACKs, not native reads or Send.
type Direction = "client" | "server";
type Transfer = (
  direction: Direction,
  connection: number,
  data: Buffer,
) => Buffer[];
let transfer: Transfer;
let afterDelivery:
  ((direction: Direction, connection: number) => void) | undefined;
let accept: (socket: FakeSocket) => void;
const connections: { client: FakeSocket; server: FakeSocket }[] = [];
let runtime: CodexCallerRelayRuntime | null;
class FakeSocket extends EventEmitter {
  destroyed = false;
  peer!: FakeSocket;
  readonly frames: Buffer[] = [];
  constructor(
    readonly direction: Direction,
    readonly index: number,
  ) {
    super();
  }
  write = vi.fn((value: string | Buffer) => {
    const data = Buffer.from(value);
    this.frames.push(data);
    queueMicrotask(() => {
      for (const chunk of transfer(this.direction, this.index, data)) {
        if (!this.peer.destroyed) {
          this.peer.emit("data", chunk);
          // Runs after the real dispatch handler has queued its invocation,
          // before the queued Promise callback gets its next microtask.
          afterDelivery?.(this.direction, this.index);
        }
      }
    });
    return true;
  });
  end = vi.fn((value?: string) => {
    if (value !== undefined) this.write(value);
    queueMicrotask(() => {
      if (!this.peer.destroyed) this.peer.emit("end");
    });
    return this;
  });
  pause = vi.fn(() => this);
  destroy = vi.fn(() => {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  });
}
class FakeServer extends EventEmitter {
  listening = false;
  listen = vi.fn(() => {
    this.listening = true;
    queueMicrotask(() => this.emit("listening"));
    return this;
  });
  close = vi.fn(() => {
    this.listening = false;
    queueMicrotask(() => this.emit("close"));
    return this;
  });
}
function connect() {
  const index = connections.length;
  const client = new FakeSocket("client", index),
    server = new FakeSocket("server", index);
  client.peer = server;
  server.peer = client;
  connections.push({ client, server });
  accept(server);
  queueMicrotask(() => client.emit("connect"));
  return client;
}
const tool = {
  type: "function",
  name: "fixture_read",
  parameters: {
    type: "object",
    properties: { relativePath: { type: "string" } },
    required: ["relativePath"],
    additionalProperties: false,
  },
};
const output = "Fixture result café 🍐\nsecond line";
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
async function flush() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
function requestFrame(index: number) {
  const value = connections[index]?.client.frames[0];
  if (!value) throw new Error("fixture request missing");
  return JSON.parse(value.toString("utf8")) as Record<string, unknown>;
}
function responseFrame(index: number) {
  const value = connections[index]?.server.frames[0];
  if (!value) throw new Error("fixture response missing");
  return JSON.parse(value.toString("utf8")) as Record<string, unknown>;
}
async function rawRequest(value: unknown) {
  const socket = connect();
  const result = new Promise<Record<string, unknown>>((resolve) => {
    socket.on("data", (data: Buffer) => {
      resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      socket.destroy();
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
  });
  return result;
}
async function fixture(
  owned = true,
  callback?: CodexCallerRelayOwnedResult["onReceived"],
) {
  runtime = await startCodexCallerRelay({
    root: "/fixture/relay",
    token: "0".repeat(64),
  });
  const onReceived = vi.fn(callback ?? (async () => "acknowledged" as const));
  const invoke = vi.fn(async () => output);
  const invokeOwned = vi.fn(
    async (
      _request: unknown,
      _context: CodexCallerRelayInvocation,
    ): Promise<CodexCallerRelayOwnedResult> => ({
      status: "known",
      output,
      onReceived,
    }),
  );
  const turn = runtime.openTurn({
    identity: {
      sessionId: "session",
      threadId: "thread",
      turnId: "turn",
      rootTurnId: "turn",
    },
    tools: [tool],
    invoke,
    ...(owned ? { invokeOwned } : {}),
  });
  const client = new CodexCallerRelayClient(runtime.endpoint, 100);
  const operation: CodexCallerRelayOperation = {
    operation: "invoke",
    ticket: turn.ticket,
    binding: turn.binding,
    operationId: "fixture-operation",
    name: "fixture_read",
    namespace: null,
    arguments: { relativePath: "fixture.md" },
  };
  return { runtime, turn, client, operation, invoke, invokeOwned, onReceived };
}
function mutate(
  direction: Direction,
  index: number,
  change: (value: Record<string, unknown>) => void,
) {
  transfer = (from, connection, data) => {
    if (from !== direction || connection !== index) return [data];
    const value = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    change(value);
    return [Buffer.from(`${JSON.stringify(value)}\n`)];
  };
}
function refused(value: Record<string, unknown>, code: string) {
  expect(value).toEqual({ ok: false, error: { code, retry: "never" } });
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  connections.length = 0;
  afterDelivery = undefined;
  runtime = null;
  transfer = (_direction, _index, data) => [data];
  for (const mock of Object.values(boundaries)) mock.mockReset();
  boundaries.mkdir.mockResolvedValue(undefined);
  boundaries.chmod.mockResolvedValue(undefined);
  boundaries.rm.mockResolvedValue(undefined);
  boundaries.lstat.mockImplementation(async (value: string) => {
    if (value.endsWith(".sock"))
      throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
    return {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: process.geteuid?.(),
      mode: 0o700,
    };
  });
  boundaries.createServer.mockImplementation(
    (listener: (socket: FakeSocket) => void) => {
      accept = listener;
      return new FakeServer();
    },
  );
  boundaries.createConnection.mockImplementation(connect);
});
afterEach(async () => {
  await runtime?.close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("private parsed-result receipt (actual handlers, CPU boundaries)", () => {
  it("correlates fragmented frames, calls the trusted ACK once and strips all private fields", async () => {
    const f = await fixture();
    transfer = (_from, _index, data) => [
      data.subarray(0, 3),
      data.subarray(3, data.length - 1),
      data.subarray(data.length - 1),
    ];
    const result = await f.client.request(f.operation);
    expect(result).toEqual({
      ok: true,
      operation: "invoke",
      operationId: "fixture-operation",
      output,
    });
    expect(CodexCallerRelayResponseSchema.parse(result)).toEqual(result);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
    expect(f.onReceived).toHaveBeenCalledTimes(1);
    const context = f.invokeOwned.mock.calls[0]?.[1];
    expect(context).toEqual({
      operationId: "fixture-operation",
      binding: f.turn.binding,
      requestSHA256: sha(
        '{"arguments":{"relativePath":"fixture.md"},"name":"fixture_read","namespace":null}',
      ),
    });
    const receipt = f.onReceived.mock.calls[0]?.[0];
    expect(receipt).toMatchObject({
      ...context,
      outputSHA256: sha(output),
      outputBytes: Buffer.byteLength(output, "utf8"),
    });
    expect(receipt?.outputBytes).not.toBe(output.length);
    expect(receipt?.receiptId).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(receipt?.receiptId);
    expect(receipt).not.toHaveProperty("token");
    expect(receipt).not.toHaveProperty("ticket");
    expect(connections).toHaveLength(2);
    expect(requestFrame(1).operation).toBe("received");
  });

  it("keeps public describe/invoke and legacy replay unchanged, without Go ACK semantics", async () => {
    const f = await fixture(false);
    const description = await f.client.request({
      operation: "describe",
      ticket: f.turn.ticket,
      binding: f.turn.binding,
    });
    expect(description.ok && description.operation).toBe("describe");
    const first = await f.client.request(f.operation);
    const duplicate = await f.client.request(f.operation);
    expect(duplicate).toEqual(first);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.invokeOwned).not.toHaveBeenCalled();
    expect(f.onReceived).not.toHaveBeenCalled();
    expect(connections).toHaveLength(3);
    for (let n = 0; n < 3; n++)
      expect(requestFrame(n).operation).not.toBe("received");
  });

  it("excludes private receipt fields/operation from the model-callable schema", async () => {
    const f = await fixture();
    await f.client.request(f.operation);
    const receipt = requestFrame(1);
    expect(CodexCallerRelayOperationSchema.safeParse(receipt).success).toBe(
      false,
    );
    expect(
      CodexCallerRelayOperationSchema.safeParse({
        ...f.operation,
        receiptId: receipt.receiptId,
      }).success,
    ).toBe(false);
    expect(
      CodexCallerRelayResponseSchema.safeParse(responseFrame(0)).success,
    ).toBe(false);
  });

  it("socket write/end without parsed peer receipt never invokes Go settlement", async () => {
    const f = await fixture();
    transfer = (from, index, data) =>
      from === "server" && index === 0 ? [] : [data];
    const assertion = expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_RESPONSE_INVALID",
    );
    await flush();
    await assertion;
    expect(connections[0]?.server.end).toHaveBeenCalledTimes(1);
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
    expect(f.onReceived).not.toHaveBeenCalled();
    expect(connections).toHaveLength(1);
  });

  it("lost receipt stays outstanding, refuses replay/new effect and never reconnects as recovery", async () => {
    const f = await fixture();
    transfer = (from, index, data) =>
      from === "client" && index === 1 ? [] : [data];
    const assertion = expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_TIMEOUT",
    );
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(connections).toHaveLength(2);
    expect(f.onReceived).not.toHaveBeenCalled();
    transfer = (_from, _index, data) => [data];
    refused(
      await rawRequest({ ...f.operation, token: "0".repeat(64) }),
      "CALLER_RELAY_OPERATION_ALREADY_DISPATCHED",
    );
    refused(
      await rawRequest({
        ...f.operation,
        operationId: "another-operation",
        token: "0".repeat(64),
      }),
      "CALLER_RELAY_OPERATION_IN_PROGRESS",
    );
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: "receiptId",
      value: "f".repeat(64),
      code: "CALLER_RELAY_RECEIPT_INVALID",
    },
    {
      field: "requestSHA256",
      value: "f".repeat(64),
      code: "CALLER_RELAY_RECEIPT_INVALID",
    },
    {
      field: "outputSHA256",
      value: "f".repeat(64),
      code: "CALLER_RELAY_RECEIPT_INVALID",
    },
    { field: "outputBytes", value: 1, code: "CALLER_RELAY_RECEIPT_INVALID" },
    {
      field: "binding",
      value: "f".repeat(64),
      code: "CALLER_RELAY_BINDING_INVALID",
    },
    {
      field: "operationId",
      value: "foreign-operation",
      code: "CALLER_RELAY_RECEIPT_UNAVAILABLE",
    },
    {
      field: "ticket",
      value: "f".repeat(64),
      code: "CALLER_RELAY_TICKET_NOT_FOUND",
    },
    {
      field: "token",
      value: "f".repeat(64),
      code: "CALLER_RELAY_UNAUTHORIZED",
    },
    {
      field: "operation",
      value: "describe",
      code: "CALLER_RELAY_REQUEST_INVALID",
    },
  ])(
    "refuses crossed private $field without Go ACK or extra execution",
    async ({ field, value, code }) => {
      const f = await fixture();
      mutate("client", 1, (request) => {
        request[field] = value;
      });
      await expect(f.client.request(f.operation)).rejects.toThrow(
        "CALLER_RELAY_RECEIPT_UNKNOWN",
      );
      refused(responseFrame(1), code);
      expect(f.onReceived).not.toHaveBeenCalled();
      expect(f.invokeOwned).toHaveBeenCalledTimes(1);
      expect(f.invoke).not.toHaveBeenCalled();
      expect(connections).toHaveLength(2);
    },
  );

  it.each(["binding", "operationId", "outputSHA256", "outputBytes"])(
    "rejects bad received-result %s before sending a receipt",
    async (field) => {
      const f = await fixture();
      mutate("server", 0, (response) => {
        const receipt = response.receipt as Record<string, unknown>;
        receipt[field] =
          field === "outputBytes"
            ? 1
            : field === "operationId"
              ? "foreign-operation"
              : "f".repeat(64);
      });
      await expect(f.client.request(f.operation)).rejects.toThrow(
        "CALLER_RELAY_RESPONSE_INVALID",
      );
      expect(f.onReceived).not.toHaveBeenCalled();
      expect(f.invokeOwned).toHaveBeenCalledTimes(1);
      expect(connections).toHaveLength(1);
    },
  );

  it("rejects a private response kind in place of the original invoke result", async () => {
    const f = await fixture();
    transfer = (from, index, data) =>
      from === "server" && index === 0
        ? [
            Buffer.from(
              JSON.stringify({
                ok: true,
                operation: "received",
                operationId: "fixture-operation",
                receiptId: "f".repeat(64),
              }) + "\n",
            ),
          ]
        : [data];
    await expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_RESPONSE_INVALID",
    );
    expect(f.onReceived).not.toHaveBeenCalled();
    expect(connections).toHaveLength(1);
  });

  it.each(["throw", "unknown"])(
    "preserves first callback %s outcome across exact duplicate receipts",
    async (fault) => {
      const f = await fixture(true, async () => {
        if (fault === "throw")
          throw new Error("fixture private callback diagnostic");
        return "unknown" as "acknowledged";
      });
      await expect(f.client.request(f.operation)).rejects.toThrow(
        "CALLER_RELAY_RECEIPT_UNKNOWN",
      );
      const receipt = requestFrame(1);
      transfer = (_from, _index, data) => [data];
      refused(await rawRequest(receipt), "CALLER_RELAY_RECEIPT_ALREADY_USED");
      refused(
        await rawRequest({ ...f.operation, token: "0".repeat(64) }),
        "CALLER_RELAY_OPERATION_ALREADY_DISPATCHED",
      );
      expect(f.onReceived).toHaveBeenCalledTimes(1);
      expect(f.invokeOwned).toHaveBeenCalledTimes(1);
      expect(f.runtime.diagnostics().lastRefusalCode).not.toContain("private");
    },
  );

  it("consumes callback before await and rejects racing/settled duplicate receipts", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(true, async () => {
      await barrier;
      return "acknowledged";
    });
    const pending = f.client.request(f.operation);
    await flush();
    expect(f.onReceived).toHaveBeenCalledTimes(1);
    const receipt = requestFrame(1);
    refused(await rawRequest(receipt), "CALLER_RELAY_RECEIPT_ALREADY_USED");
    release();
    await expect(pending).resolves.toMatchObject({ ok: true, output });
    refused(await rawRequest(receipt), "CALLER_RELAY_RECEIPT_ALREADY_USED");
    expect(f.onReceived).toHaveBeenCalledTimes(1);
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
  });

  it("keeps an invalid original receipt unknown rather than accepting its later corrected duplicate", async () => {
    const f = await fixture();
    mutate("client", 1, (request) => {
      request.outputBytes = 1;
    });
    await expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_RECEIPT_UNKNOWN",
    );
    const receipt = requestFrame(1);
    transfer = (_from, _index, data) => [data];
    refused(await rawRequest(receipt), "CALLER_RELAY_RECEIPT_ALREADY_USED");
    expect(f.onReceived).not.toHaveBeenCalled();
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
  });

  it("uses one deadline budget across original result and callback receipt", async () => {
    let releaseResult!: () => void, releaseAck!: () => void;
    const resultBarrier = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const ackBarrier = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const f = await fixture(true, async () => {
      await ackBarrier;
      return "acknowledged";
    });
    f.invokeOwned.mockImplementation(async () => {
      await resultBarrier;
      return { status: "known", output, onReceived: f.onReceived };
    });
    const assertion = expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_TIMEOUT",
    );
    await flush();
    await vi.advanceTimersByTimeAsync(60);
    releaseResult();
    await flush();
    expect(f.onReceived).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
    expect(connections).toHaveLength(2);
    releaseAck();
    await flush();
    expect(f.onReceived).toHaveBeenCalledTimes(1);
  });

  it("refuses malformed/multiple private frames without a trusted callback", async () => {
    const f = await fixture();
    transfer = (from, index, data) =>
      from === "client" && index === 1 ? [Buffer.concat([data, data])] : [data];
    await expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_RECEIPT_UNKNOWN",
    );
    refused(responseFrame(1), "CALLER_RELAY_REQUEST_INVALID");
    expect(f.onReceived).not.toHaveBeenCalled();
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
  });

  it("does not mint a receipt for unknown/malformed owned results or fall back to legacy", async () => {
    const f = await fixture();
    f.invokeOwned.mockResolvedValue({
      status: "unknown",
      output,
      onReceived: f.onReceived,
    } as unknown as CodexCallerRelayOwnedResult);
    const result = await f.client.request(f.operation);
    expect(result).toMatchObject({ ok: false, error: { retry: "never" } });
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.onReceived).not.toHaveBeenCalled();
    expect(connections).toHaveLength(1);
  });

  it("fences a turn closed during trusted callback instead of publishing a positive receipt", async () => {
    const f = await fixture();
    f.onReceived.mockImplementation(async () => {
      f.turn.close();
      return "acknowledged";
    });
    await expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_RECEIPT_UNKNOWN",
    );
    expect(f.onReceived).toHaveBeenCalledTimes(1);
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
  });
  it("refuses oversized private frames without a callback or repeated effect", async () => {
    const f = await fixture();
    transfer = (from, index, data) =>
      from === "client" && index === 1
        ? [Buffer.alloc(CALLER_RELAY_MAX_FRAME_BYTES + 1, 0x78)]
        : [data];
    await expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_RECEIPT_UNKNOWN",
    );
    refused(responseFrame(1), "CALLER_RELAY_REQUEST_TOO_LARGE");
    expect(f.onReceived).not.toHaveBeenCalled();
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
  });
  it("checks complete UTF-8 wire size before publishing an owned receipt", async () => {
    const f = await fixture();
    f.invokeOwned.mockResolvedValue({
      status: "known",
      output: "🍐".repeat(200_000),
      onReceived: f.onReceived,
    });
    const result = await f.client.request(f.operation);
    expect(result).toEqual({
      ok: false,
      error: { code: "CALLER_RELAY_OUTPUT_TOO_LARGE", retry: "never" },
    });
    expect(f.onReceived).not.toHaveBeenCalled();
    expect(connections).toHaveLength(1);
  });
  it("mints a fresh receipt only for a distinct known operation after original settlement", async () => {
    const f = await fixture();
    await f.client.request(f.operation);
    const first = requestFrame(1);
    await f.client.request({ ...f.operation, operationId: "second-operation" });
    const second = requestFrame(3);
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(f.onReceived).toHaveBeenCalledTimes(2);
    expect(f.invokeOwned).toHaveBeenCalledTimes(2);
    refused(
      await rawRequest({ ...first, operationId: "second-operation" }),
      "CALLER_RELAY_RECEIPT_ALREADY_USED",
    );
    expect(f.onReceived).toHaveBeenCalledTimes(2);
  });
  it("does not replay when the receipt confirmation is lost after known Go callback", async () => {
    const f = await fixture();
    transfer = (from, index, data) =>
      from === "server" && index === 1 ? [] : [data];
    await expect(f.client.request(f.operation)).rejects.toThrow(
      "CALLER_RELAY_RESPONSE_INVALID",
    );
    // Receipt WAS parsed and the original callback reported known success. A
    // lost confirmation makes the client unknown; it cannot undo Go's truth.
    expect(f.onReceived).toHaveBeenCalledTimes(1);
    expect(f.invokeOwned).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(2);
    transfer = (_from, _index, data) => [data];
    refused(
      await rawRequest(requestFrame(1)),
      "CALLER_RELAY_RECEIPT_ALREADY_USED",
    );
    expect(f.onReceived).toHaveBeenCalledTimes(1);
  });
  it.each(["close", "expiry"] as const)(
    "withdraws owned %s after dispatch queues but before original callback starts",
    async (withdrawal) => {
      const f = await fixture();
      let queuedBoundarySeen = false;
      afterDelivery = (direction, connection) => {
        if (direction !== "client" || connection !== 0 || queuedBoundarySeen)
          return;
        // Assert the precise window: dispatch stored the original record,
        // while neither the owned effect nor legacy effect has started.
        expect(f.runtime.diagnostics().operations).toBe(1);
        expect(f.invokeOwned).not.toHaveBeenCalled();
        expect(f.invoke).not.toHaveBeenCalled();
        queuedBoundarySeen = true;
        if (withdrawal === "close") f.turn.close();
        else vi.setSystemTime(Date.now() + 15 * 60 * 1_000 + 1);
      };
      const result = await f.client.request(f.operation);
      expect(queuedBoundarySeen).toBe(true);
      expect(result).toEqual({
        ok: false,
        error: {
          code: "CALLER_RELAY_RECEIPT_UNKNOWN",
          retry: "never",
        },
      });
      expect(f.invokeOwned).not.toHaveBeenCalled();
      expect(f.invoke).not.toHaveBeenCalled();
      expect(f.onReceived).not.toHaveBeenCalled();
      expect(responseFrame(0)).not.toHaveProperty("receipt");
      expect(connections).toHaveLength(1);
    },
  );
});
