import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const netMock = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: netMock.connect }));

import { CodexCallerRelayClient } from "../../src/apps/computer-mcp/codex-caller-relay-client";
import {
  CALLER_RELAY_PROTOCOL,
  type CodexCallerRelayOperation,
} from "../../src/pkg/caller-relay/protocol";

// CPU fixture exercises the actual client parser. node:net is replaced before
// import; no socket/server/connector/native execution or peer receipt is proved.
class FixtureSocket extends EventEmitter {
  write = vi.fn();
  destroy = vi.fn(() => {
    this.emit("close");
    return this;
  });
}
const invoke: CodexCallerRelayOperation = {
  operation: "invoke",
  ticket: "a".repeat(64),
  binding: "b".repeat(64),
  operationId: "fixture-operation",
  name: "fixture_read",
  namespace: null,
  arguments: { relativePath: "fixture.md" },
};
const describeOperation: CodexCallerRelayOperation = {
  operation: "describe",
  ticket: invoke.ticket,
  binding: invoke.binding,
};
const success = {
  ok: true,
  operation: "invoke",
  operationId: "fixture-operation",
  output: "Fixture result: café 🍐\nsecond line",
} as const;
const catalogue = {
  ok: true,
  operation: "describe",
  catalogue: {
    fingerprint: "c".repeat(64),
    tools: [],
    unsupported: [],
  },
} as const;
function fixture(operation: CodexCallerRelayOperation = invoke) {
  const socket = new FixtureSocket();
  netMock.connect.mockReturnValue(socket);
  const client = new CodexCallerRelayClient(
    {
      protocol: CALLER_RELAY_PROTOCOL,
      socketPath: "/fixture/caller-relay.sock",
      token: "0".repeat(64),
    },
    100,
  );
  const pending = client.request(operation);
  socket.emit("connect");
  return { socket, pending };
}
function frame(socket: FixtureSocket, value: unknown) {
  socket.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
}
function oneShot(socket: FixtureSocket) {
  expect(netMock.connect).toHaveBeenCalledTimes(1);
  expect(socket.write).toHaveBeenCalledTimes(1);
  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  netMock.connect.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("caller-relay client request/response correlation (CPU only)", () => {
  it.each([
    {
      name: "foreign invoke ID",
      request: invoke,
      response: { ...success, operationId: "foreign-operation" },
    },
    { name: "invoke receives describe", request: invoke, response: catalogue },
    {
      name: "describe receives invoke",
      request: describeOperation,
      response: success,
    },
  ])(
    "refuses $name without returning tool output or retrying",
    async ({ request, response }) => {
      const { socket, pending } = fixture(request);
      const assertion = expect(pending).rejects.toThrow(
        "CALLER_RELAY_RESPONSE_INVALID",
      );
      frame(socket, response);
      await assertion;
      // A later matching reply cannot recover this failed original request.
      frame(socket, success);
      socket.emit("end");
      await vi.advanceTimersByTimeAsync(200);
      oneShot(socket);
    },
  );

  it.each([
    {
      name: "missing invoke ID",
      response: {
        ok: true,
        operation: "invoke",
        output: "private fixture output",
      },
    },
    {
      name: "missing operation kind",
      response: {
        ok: true,
        operationId: success.operationId,
        output: success.output,
      },
    },
    { name: "empty invoke ID", response: { ...success, operationId: "" } },
    { name: "non-string invoke ID", response: { ...success, operationId: 17 } },
  ])(
    "refuses $name with the existing classified error",
    async ({ response }) => {
      const { socket, pending } = fixture();
      const assertion = expect(pending).rejects.toThrow(
        "CALLER_RELAY_RESPONSE_INVALID",
      );
      frame(socket, response);
      await assertion;
      oneShot(socket);
    },
  );

  it.each([
    { name: "invoke", request: invoke, response: success },
    { name: "describe", request: describeOperation, response: catalogue },
  ])(
    "returns one exactly matching $name response",
    async ({ request, response }) => {
      const { socket, pending } = fixture(request);
      frame(socket, response);
      await expect(pending).resolves.toEqual(response);
      oneShot(socket);
    },
  );

  it("compares to the parsed request that was actually sent", async () => {
    const request = { ...invoke, operationId: "fixture-operation" };
    const { socket, pending } = fixture(request);
    const sent = JSON.parse(String(socket.write.mock.calls[0]?.[0])) as {
      operationId: string;
    };
    expect(sent.operationId).toBe("fixture-operation");
    request.operationId = "changed-after-send";
    frame(socket, success);
    await expect(pending).resolves.toEqual(success);
    oneShot(socket);
  });

  it("accepts a fragmented matching response only after its complete frame", async () => {
    const { socket, pending } = fixture();
    const bytes = Buffer.from(`${JSON.stringify(success)}\n`);
    const pear = bytes.indexOf(Buffer.from("🍐"));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // Split inside a multibyte code point, not just a JSON token.
    socket.emit("data", bytes.subarray(0, pear + 1));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(socket.destroy).not.toHaveBeenCalled();
    socket.emit("data", bytes.subarray(pear + 1));
    await expect(pending).resolves.toEqual(success);
    oneShot(socket);
  });

  it.each([invoke, describeOperation])(
    "preserves retry-never refusal for $operation",
    async (request) => {
      const { socket, pending } = fixture(request);
      const refusal = {
        ok: false,
        error: { code: "CALLER_RELAY_TICKET_NOT_FOUND", retry: "never" },
      };
      frame(socket, refusal);
      await expect(pending).resolves.toEqual(refusal);
      oneShot(socket);
    },
  );

  it("rejects a crossed fragmented result and ignores later matching data", async () => {
    const { socket, pending } = fixture();
    const assertion = expect(pending).rejects.toThrow(
      "CALLER_RELAY_RESPONSE_INVALID",
    );
    const bytes = Buffer.from(
      `${JSON.stringify({ ...success, operationId: "other" })}\n`,
    );
    socket.emit("data", bytes.subarray(0, bytes.length - 1));
    expect(socket.destroy).not.toHaveBeenCalled();
    socket.emit("data", bytes.subarray(bytes.length - 1));
    await assertion;
    frame(socket, success);
    oneShot(socket);
  });

  it("does not select a matching response from a multi-frame reply", async () => {
    const { socket, pending } = fixture();
    const assertion = expect(pending).rejects.toThrow(
      "CALLER_RELAY_RESPONSE_INVALID",
    );
    socket.emit(
      "data",
      Buffer.from(`${JSON.stringify(success)}\n${JSON.stringify(success)}\n`),
    );
    await assertion;
    oneShot(socket);
  });

  it("keeps missing/truncated reply unavailable without reconnect or resend", async () => {
    const { socket, pending } = fixture();
    const assertion = expect(pending).rejects.toThrow(
      "CALLER_RELAY_RESPONSE_INVALID",
    );
    socket.emit("data", Buffer.from('{"ok":true,"operation":"invoke"'));
    socket.emit("end");
    await assertion;
    oneShot(socket);
  });

  it("times out without reconnecting or resending", async () => {
    const { socket, pending } = fixture();
    const assertion = expect(pending).rejects.toThrow("CALLER_RELAY_TIMEOUT");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    oneShot(socket);
  });
});
