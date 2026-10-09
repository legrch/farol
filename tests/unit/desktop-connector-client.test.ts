import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BridgeError,
  RequestNotSentError,
  type Client,
} from "../../apps/desktop/bridge/client.ts";
import { ComputerBridge } from "../../apps/desktop/bridge/computer.ts";
import {
  SocketConnectorClient,
  type ConnectorSocket,
} from "../../apps/desktop/bridge/connector-client.ts";
import { frame, parseJSON } from "../../apps/desktop/bridge/frame.ts";
import {
  maxFrameBytes,
  protocolMajor,
  protocolMinor,
  type ComputerConnectorEndpoint,
  type Identity,
  type Json,
  type Request,
} from "../../apps/desktop/bridge/wire.ts";

// Every connection is an in-memory double. These tests do not qualify native
// sockets, endpoint protection, peer credentials, module authority or activation.
vi.mock("node:net", () => ({ createConnection: vi.fn() }));

class MemorySocket extends EventEmitter implements ConnectorSocket {
  destroyed = false;
  writable = true;
  writableLength = 0;
  writes: Buffer[] = [];
  acceptWrites = true;
  writeFailure = false;
  onWrite: ((bytes: Buffer) => void) | undefined;
  write(bytes: Uint8Array): boolean {
    const copy = Buffer.from(bytes);
    this.writes.push(copy);
    if (this.writeFailure) throw Error("private fixture transport detail");
    this.onWrite?.(copy);
    return this.acceptWrites;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
  }
  receive(value: unknown): void {
    this.emit("data", frame(value));
  }
}
function endpoint(): ComputerConnectorEndpoint {
  return {
    binding: {
      buildId: "build",
      profileId: "profile",
      backendGeneration: "backend",
      runtimeId: "runtime",
      connectorGeneration: "9007199254740993",
    },
    socketPath: "/private/tmp/fixture/computer.sock",
    token: "a".repeat(64),
  };
}
const methods = [
  "computer.workspace.read",
  "computer.workspace.list",
  "computer.workspace.search",
  "computer.workspace.catalogue",
  "computer.workspace.bootstrap",
  "computer.workspace.mutation.read",
  "computer.connector.verify",
  "computer.connector.verification",
];
const effectMethods = ["computer.workspace.write", "computer.workspace.edit"];
function identity(): Identity {
  return {
    protocolMajor,
    protocolMinor,
    buildId: "build",
    profileId: "profile",
    backendGeneration: "backend",
    maxFrameBytes,
    capabilities: ["core.status", ...methods, ...effectMethods],
  };
}
const context = { profileId: "profile", backendGeneration: "backend" };
function decode(bytes: Buffer): unknown {
  expect(bytes.readUInt32BE()).toBe(bytes.length - 4);
  return parseJSON(bytes.subarray(4).toString("utf8"));
}
function requestAt(
  socket: MemorySocket,
  index = socket.writes.length - 1,
): Request {
  return decode(socket.writes[index]!) as Request;
}
function response(id: string, data: Json = {}): object {
  return {
    jsonrpc: "2.0",
    id,
    result: { status: "ok", requestId: id, context, data },
  };
}
function effectResponse(
  id: string,
  operationId: string,
  status: "ok" | "refused" | "unknown" | "unavailable" | "unsupported" = "ok",
) {
  return {
    jsonrpc: "2.0",
    id,
    result: { status, requestId: id, operationId, context, data: {} },
  };
}
const clients: SocketConnectorClient[] = [];
function fixture(selected = endpoint()) {
  const socket = new MemorySocket();
  const factory = vi.fn(() => socket);
  const client = new SocketConnectorClient(selected, factory);
  clients.push(client);
  return { socket, factory, client };
}
function opening(f = fixture(), timeoutMs = 1000) {
  const connected = f.client.connect(timeoutMs);
  f.socket.emit("connect");
  return { ...f, connected };
}
async function ready() {
  const f = opening();
  f.socket.receive(endpoint().binding);
  f.socket.receive(
    response(requestAt(f.socket).id, identity() as unknown as Json),
  );
  await f.connected;
  return f;
}
function error(state: string, code: string) {
  return { state, code, message: code };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it("uses the selected Unix factory once, exact hello ACK, then canonical handshake", async () => {
  const f = opening();
  expect(f.factory).toHaveBeenCalledExactlyOnceWith(endpoint().socketPath);
  expect(decode(f.socket.writes[0]!)).toEqual({
    binding: endpoint().binding,
    token: endpoint().token,
  });
  expect(f.socket.writes).toHaveLength(1);
  expect(() => f.client.verifiedContext).toThrow("handshake_required");
  await expect(f.client.request(methods[0]!, {})).rejects.toMatchObject(
    error("unavailable", "handshake_required"),
  );
  await expect(f.client.connect()).rejects.toMatchObject(
    error("refused", "connector_already_used"),
  );
  const ack = frame(endpoint().binding);
  for (const byte of ack) f.socket.emit("data", Buffer.from([byte]));
  const handshake = requestAt(f.socket);
  expect(handshake).toEqual({
    jsonrpc: "2.0",
    id: expect.any(String),
    method: "core.handshake",
    params: {
      body: {
        protocolMajor,
        protocolMinor,
        buildId: "build",
        profileId: "profile",
      },
    },
  });
  const bytes = frame(response(handshake.id, identity() as unknown as Json));
  f.socket.emit("data", bytes.subarray(0, 7));
  f.socket.emit("data", bytes.subarray(7));
  const verified = await f.connected;
  expect(verified).toEqual(identity());
  expect(Object.isFrozen(verified)).toBe(true);
  expect(Object.isFrozen(verified.capabilities)).toBe(true);
  expect(f.client.verifiedContext).toEqual(context);
  expect(Object.isFrozen(f.client.verifiedContext)).toBe(true);
});

it("defaults to net.createConnection({path}) without any child abstraction", async () => {
  const socket = new MemorySocket();
  vi.mocked(createConnection).mockReturnValueOnce(
    socket as unknown as ReturnType<typeof createConnection>,
  );
  const client = new SocketConnectorClient(endpoint());
  clients.push(client);
  const connected = client.connect();
  const rejected = expect(connected).rejects.toMatchObject(
    error("unavailable", "connector_closed"),
  );
  expect(createConnection).toHaveBeenCalledExactlyOnceWith({
    path: endpoint().socketPath,
  });
  await client.close();
  await rejected;
});

it("snapshots the constructor endpoint and never exposes it in a public DTO", async () => {
  const selected = endpoint();
  const f = fixture(selected);
  const mutable = selected as {
    binding: { buildId: string };
    socketPath: string;
    token: string;
  };
  mutable.binding.buildId = "changed";
  mutable.socketPath = "/private/tmp/other.sock";
  mutable.token = "b".repeat(64);
  const opened = opening(f);
  expect(decode(f.socket.writes[0]!)).toEqual({
    binding: endpoint().binding,
    token: endpoint().token,
  });
  expect(f.factory).toHaveBeenCalledExactlyOnceWith(endpoint().socketPath);
  expect(JSON.stringify(f.client)).not.toContain(endpoint().token);
  expect(JSON.stringify(f.client)).not.toContain(endpoint().socketPath);
  const rejected = expect(opened.connected).rejects.toMatchObject(
    error("unavailable", "connector_closed"),
  );
  await f.client.close();
  await rejected;
});

it.each([
  null,
  {},
  { ...endpoint(), token: "auth secret" },
  { ...endpoint(), socketPath: "relative.sock" },
  { ...endpoint(), socketPath: "/private/tmp/\0socket" },
  { ...endpoint(), socketPath: "/" + "a".repeat(100) },
  {
    ...endpoint(),
    binding: {
      ...endpoint().binding,
      connectorGeneration: "18446744073709551616",
    },
  },
  { ...endpoint(), extra: true },
])("rejects malformed endpoint %# before invoking a factory", (selected) => {
  const factory = vi.fn();
  expect(
    () =>
      new SocketConnectorClient(selected as ComputerConnectorEndpoint, factory),
  ).toThrow("invalid_connector_endpoint");
  expect(factory).not.toHaveBeenCalled();
});

it.each(Object.keys(endpoint().binding))(
  "rejects a crossed ACK %s before core dispatch",
  async (field) => {
    const f = opening();
    const rejected = expect(f.connected).rejects.toMatchObject(
      error("refused", "crossed_connector_ack"),
    );
    f.socket.receive({
      ...endpoint().binding,
      [field]: field === "connectorGeneration" ? "9007199254740994" : "other",
    });
    await rejected;
    expect(f.socket.writes).toHaveLength(1);
    expect(f.socket.destroyed).toBe(true);
  },
);

it.each([
  {},
  { ...endpoint().binding, token: endpoint().token },
  { ...endpoint().binding, connectorGeneration: 1 },
  { ...endpoint().binding, operationId: "op" },
])("rejects non-exact ACK shape %#", async (ack) => {
  const f = opening();
  const rejected = expect(f.connected).rejects.toMatchObject(
    error("refused", "invalid_connector_ack"),
  );
  f.socket.receive(ack);
  await rejected;
  expect(f.socket.writes).toHaveLength(1);
});

it.each([
  ["buildId", "other"],
  ["profileId", "other"],
  ["backendGeneration", "other"],
  ["protocolMajor", 2],
  ["protocolMinor", 1],
  ["maxFrameBytes", 8192],
])("requires exact handshake identity %s", async (field, value) => {
  const f = opening();
  f.socket.receive(endpoint().binding);
  const rejected = expect(f.connected).rejects.toMatchObject(
    error("refused", "wrong_backend_identity"),
  );
  f.socket.receive(
    response(requestAt(f.socket).id, {
      ...identity(),
      [field]: value,
    } as unknown as Json),
  );
  await rejected;
  expect(() => f.client.verifiedContext).toThrow("connector_unavailable");
  expect(f.socket.destroyed).toBe(true);
});

it("rejects invalid identity and crossed handshake result context", async () => {
  for (const crossed of [false, true]) {
    const f = opening();
    f.socket.receive(endpoint().binding);
    const id = requestAt(f.socket).id;
    const rejected = expect(f.connected).rejects.toMatchObject(
      error(
        crossed ? "unknown" : "refused",
        crossed ? "crossed_response_context" : "invalid_backend_identity",
      ),
    );
    f.socket.receive({
      jsonrpc: "2.0",
      id,
      result: {
        status: "ok",
        requestId: id,
        context: crossed ? { ...context, backendGeneration: "other" } : context,
        data: crossed ? identity() : {},
      },
    });
    await rejected;
  }
});

it("implements the real Client.request signature and ComputerBridge list composition", async () => {
  const f = await ready();
  const transport: Pick<Client, "request"> = f.client;
  const bridge = new ComputerBridge(transport);
  const body = {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "9007199254740993",
    participantId: "participant",
    turnId: "turn",
    generation: "18446744073709551615",
    callId: "call",
    workspaceId: "workspace",
    relativePath: ".",
  };
  const result = bridge.list(body, { requestId: "list", context });
  expect(requestAt(f.socket)).toEqual({
    jsonrpc: "2.0",
    id: "list",
    method: "computer.workspace.list",
    params: { context, body },
  });
  f.socket.receive(
    response("list", {
      ...body,
      entries: ["AGENTS.md", "folder/"],
      truncated: false,
    }),
  );
  await expect(result).resolves.toEqual({
    status: "ok",
    requestId: "list",
    context,
    data: { ...body, entries: ["AGENTS.md", "folder/"], truncated: false },
  });
});

it.each(methods)(
  "permits only named read route %s with exact IDs",
  async (method) => {
    const f = await ready();
    const result = f.client.request(method, {}, { id: "read" });
    expect(requestAt(f.socket).params).toEqual({ context, body: {} });
    f.socket.receive(response("read"));
    await expect(result).resolves.toMatchObject({
      status: "ok",
      requestId: "read",
    });
  },
);

it.each([
  "core.handshake",
  "core.status",
  "computer.authority.publish",
  "computer.settings.snapshot",
  "task.create",
  "unknown",
])("withholds route %s without a write", async (method) => {
  const f = await ready();
  const count = f.socket.writes.length;
  await expect(
    f.client.request(method, {}, { operationId: "op" }),
  ).rejects.toMatchObject(error("unsupported", "connector_method_unsupported"));
  expect(f.socket.writes).toHaveLength(count);
});

it.each(methods)("forbids operation IDs on read route %s", async (method) => {
  const f = await ready();
  const count = f.socket.writes.length;
  await expect(
    f.client.request(method, {}, { operationId: "op" }),
  ).rejects.toMatchObject(error("refused", "connector_operation_id_forbidden"));
  expect(f.socket.writes).toHaveLength(count);
});

it.each(effectMethods)(
  "requires a caller-selected valid operation ID on %s before submission",
  async (method) => {
    const f = await ready();
    const count = f.socket.writes.length;
    for (const operationId of [
      undefined,
      "",
      "bad id",
      "-op",
      "x".repeat(129),
      "op\0",
      "op\n",
      "op\ud800",
      null,
      1,
    ]) {
      await expect(
        f.client.request(method, {}, { operationId: operationId as string }),
      ).rejects.toMatchObject(
        error("refused", "connector_operation_id_required"),
      );
    }
    expect(f.socket.writes).toHaveLength(count);
    const operationId = "a".repeat(128);
    const pending = f.client.request(method, {}, { id: "valid", operationId });
    expect(requestAt(f.socket).params.operationId).toBe(operationId);
    f.socket.receive(effectResponse("valid", operationId));
    await expect(pending).resolves.toMatchObject({ operationId });
  },
);

it.each(effectMethods)(
  "sends and correlates the outer operation ID on every %s outcome",
  async (method) => {
    const f = await ready();
    let unknownSeen = false;
    for (const status of [
      "ok",
      "refused",
      "unknown",
      "unavailable",
      "unsupported",
    ] as const) {
      const id = `request-${status}`;
      const operationId = `caller/${status}:op`;
      const body = { operationId: "untrusted-body-operation" };
      const pending = f.client.request(method, body, { id, operationId });
      expect(requestAt(f.socket)).toEqual({
        jsonrpc: "2.0",
        id,
        method,
        params: { context, body, operationId },
      });
      const ack = effectResponse(id, operationId, status);
      f.socket.receive(ack);
      await expect(pending).resolves.toEqual(ack.result);
      unknownSeen ||= status === "unknown";
      expect(f.client.hasUnresolvedEffect).toBe(unknownSeen);
      const count = f.socket.writes.length;
      await expect(
        f.client.request(method, body, { id: `new-${id}`, operationId }),
      ).rejects.toMatchObject(error("refused", "duplicate_operation_id"));
      expect(f.socket.writes).toHaveLength(count);
    }
  },
);

it.each(["ok", "refused", "unknown", "unavailable", "unsupported"] as const)(
  "observes only an unresolved original effect for returned %s",
  async (status) => {
    const f = await ready();
    const pending = f.client.request(
      effectMethods[0]!,
      {},
      {
        id: "effect",
        operationId: "original",
      },
    );
    f.socket.receive(effectResponse("effect", "original", status));
    await pending;
    expect(f.client.hasUnresolvedEffect).toBe(status === "unknown");
    await f.client.close();
    expect(f.client.terminal?.submittedEffectCount).toBe(0);
    expect(f.client.hasUnresolvedEffect).toBe(status === "unknown");
    expect(f.socket.writes).toHaveLength(3);
  },
);

it("keeps backend outcome_unknown sticky after pending removal and later known result bytes", async () => {
  const f = await ready();
  const pending = f.client.request(
    effectMethods[0]!,
    {},
    {
      id: "effect",
      operationId: "original",
    },
  );
  f.socket.receive({
    ...effectResponse("effect", "original"),
    result: {
      ...effectResponse("effect", "original").result,
      data: { phase: "outcome_unknown" },
    },
  });
  await pending;
  expect(f.client.hasUnresolvedEffect).toBe(true);
  const read = f.client.request(
    "computer.workspace.mutation.read",
    {},
    { id: "known-read" },
  );
  f.socket.receive(response("known-read", { phase: "completed" }));
  await read;
  // Read-only reconciliation cannot clear the original caller's UNKNOWN.
  expect(f.client.hasUnresolvedEffect).toBe(true);
  await f.client.close();
  expect(f.client.terminal).toMatchObject({
    submittedPendingCount: 0,
    submittedEffectCount: 0,
  });
  expect(f.client.hasUnresolvedEffect).toBe(true);
  expect(f.socket.writes).toHaveLength(4);
});

it("does not turn a read-only UNKNOWN or unsent effect into an unresolved submitted effect", async () => {
  const f = await ready();
  const read = f.client.request(methods[0]!, {}, { id: "read" });
  f.socket.receive({
    ...response("read"),
    result: {
      status: "unknown",
      requestId: "read",
      context,
      code: "READ_UNKNOWN",
    },
  });
  await read;
  f.socket.writableLength = maxFrameBytes + 4;
  await expect(
    f.client.request(
      effectMethods[0]!,
      {},
      {
        id: "unsent",
        operationId: "original",
      },
    ),
  ).rejects.toBeInstanceOf(RequestNotSentError);
  await f.client.close();
  expect(f.client.hasUnresolvedEffect).toBe(false);
  expect(f.client.terminal?.submittedEffectCount).toBe(0);
  expect(f.socket.writes).toHaveLength(3);
});

it("never resubmits a pending operation under another request ID or effect method", async () => {
  const f = await ready();
  const pending = f.client.request(
    effectMethods[0]!,
    {},
    { id: "write", operationId: "op" },
  );
  for (const id of ["write", "edit"]) {
    await expect(
      f.client.request(effectMethods[1]!, {}, { id, operationId: "op" }),
    ).rejects.toMatchObject(error("refused", "duplicate_operation_id"));
  }
  expect(f.socket.writes).toHaveLength(3);
  f.socket.receive(effectResponse("write", "op"));
  await pending;
});

it("correlates concurrent effects received out of order", async () => {
  const f = await ready();
  const a = f.client.request(
    effectMethods[0]!,
    {},
    { id: "a", operationId: "op-a" },
  );
  const b = f.client.request(
    effectMethods[1]!,
    {},
    { id: "b", operationId: "op-b" },
  );
  f.socket.emit(
    "data",
    Buffer.concat([
      frame(effectResponse("b", "op-b")),
      frame(effectResponse("a", "op-a")),
    ]),
  );
  await expect(a).resolves.toMatchObject({
    requestId: "a",
    operationId: "op-a",
  });
  await expect(b).resolves.toMatchObject({
    requestId: "b",
    operationId: "op-b",
  });
});

it.each([
  "missing",
  "crossed",
  "invalid",
  "request",
  "context",
  "fault",
  "malformed",
])("leaves both effects unknown and stops on a %s effect ACK", async (kind) => {
  const f = await ready();
  const a = f.client.request(
    effectMethods[0]!,
    {},
    { id: "a", operationId: "op-a" },
  );
  const b = f.client.request(
    effectMethods[1]!,
    {},
    { id: "b", operationId: "op-b" },
  );
  const rejectedA = expect(a).rejects.toMatchObject({ state: "unknown" });
  const rejectedB = expect(b).rejects.toMatchObject({ state: "unknown" });
  const ack = effectResponse(
    "a",
    kind === "crossed" ? "op-b" : kind === "invalid" ? "" : "op-a",
  );
  const { operationId: _omitted, ...withoutOperation } = ack.result;
  f.socket.receive(
    kind === "fault"
      ? {
          jsonrpc: "2.0",
          id: "a",
          error: { code: -32602, message: "private peer detail" },
        }
      : {
          ...ack,
          result:
            kind === "missing"
              ? withoutOperation
              : {
                  ...ack.result,
                  ...(kind === "request" ? { requestId: "b" } : {}),
                  ...(kind === "context"
                    ? { context: { ...context, backendGeneration: "other" } }
                    : {}),
                  ...(kind === "malformed" ? { unexpected: true } : {}),
                },
        },
  );
  await rejectedA;
  await rejectedB;
  expect(f.client.hasUnresolvedEffect).toBe(true);
  expect(f.client.terminal).toMatchObject({
    submittedPendingCount: 2,
    submittedEffectCount: 2,
  });
  expect(f.socket.destroyed).toBe(true);
  await expect(f.client.connect()).rejects.toMatchObject(
    error("refused", "connector_already_used"),
  );
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(f.socket.writes).toHaveLength(4);
});

it("forbids operation IDs in the handshake outcome", async () => {
  const f = opening();
  f.socket.receive(endpoint().binding);
  expect(requestAt(f.socket).params).not.toHaveProperty("operationId");
  const rejected = expect(f.connected).rejects.toMatchObject(
    error("unknown", "crossed_response_context"),
  );
  f.socket.receive({
    ...effectResponse(requestAt(f.socket).id, "op"),
    result: {
      ...effectResponse(requestAt(f.socket).id, "op").result,
      data: identity(),
    },
  });
  await rejected;
  expect(f.socket.destroyed).toBe(true);
});

it("retains submitted operation IDs through backpressure without consuming unsent ones", async () => {
  const f = await ready();
  f.socket.acceptWrites = false;
  const first = f.client.request(
    effectMethods[0]!,
    {},
    { id: "first", operationId: "op-first" },
  );
  await expect(
    f.client.request(
      effectMethods[1]!,
      {},
      { id: "duplicate", operationId: "op-first" },
    ),
  ).rejects.toMatchObject(error("refused", "duplicate_operation_id"));
  await expect(
    f.client.request(
      effectMethods[1]!,
      {},
      { id: "not-sent", operationId: "op-next" },
    ),
  ).rejects.toBeInstanceOf(RequestNotSentError);
  expect(f.socket.writes).toHaveLength(3);
  f.socket.receive(effectResponse("first", "op-first"));
  await first;
  f.socket.acceptWrites = true;
  f.socket.emit("drain");
  const next = f.client.request(
    effectMethods[1]!,
    {},
    { id: "not-sent", operationId: "op-next" },
  );
  f.socket.receive(effectResponse("not-sent", "op-next"));
  await expect(next).resolves.toMatchObject({ operationId: "op-next" });
  expect(f.socket.writes).toHaveLength(4);
});

it.each(["error", "end", "close", "write-throw", "timeout", "client-close"])(
  "keeps a submitted effect unknown on %s without retry or reconnect",
  async (event) => {
    const f = await ready();
    if (event === "write-throw") f.socket.writeFailure = true;
    const pending = f.client.request(
      effectMethods[0]!,
      {},
      { id: "write", operationId: "op", timeoutMs: 20 },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      state: "unknown",
    });
    if (event === "timeout") await vi.advanceTimersByTimeAsync(20);
    else if (event === "client-close") await f.client.close();
    else if (event !== "write-throw") f.socket.emit(event);
    await rejected;
    expect(f.client.hasUnresolvedEffect).toBe(true);
    expect(f.client.terminal).toMatchObject({
      submittedPendingCount: 1,
      submittedEffectCount: 1,
    });
    f.socket.receive(effectResponse("write", "op")); // A late ACK cannot recover the stream.
    await f.client.close();
    expect(f.client.hasUnresolvedEffect).toBe(true);
    await expect(
      f.client.request(
        effectMethods[1]!,
        {},
        { id: "retry", operationId: "op" },
      ),
    ).rejects.toMatchObject(error("unavailable", "connector_unavailable"));
    await expect(f.client.connect()).rejects.toMatchObject(
      error("refused", "connector_already_used"),
    );
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.socket.writes).toHaveLength(3);
  },
);

it("stops on a late duplicate effect ACK and leaves another submitted effect unknown", async () => {
  const f = await ready();
  const a = f.client.request(
    effectMethods[0]!,
    {},
    { id: "a", operationId: "op-a" },
  );
  f.socket.receive(effectResponse("a", "op-a"));
  await a;
  const b = f.client.request(
    effectMethods[1]!,
    {},
    { id: "b", operationId: "op-b" },
  );
  const rejected = expect(b).rejects.toMatchObject(
    error("unknown", "crossed_response_id"),
  );
  f.socket.receive(effectResponse("a", "op-a"));
  await rejected;
  expect(f.socket.destroyed).toBe(true);
  expect(f.socket.writes).toHaveLength(4);
});

it("bounds submitted operation history within the 4096-request stream budget", async () => {
  const f = await ready();
  f.socket.onWrite = (bytes) => {
    const request = decode(bytes) as Request;
    f.socket.receive(effectResponse(request.id, request.params.operationId!));
  };
  for (let i = 0; i < 4095; i++)
    await f.client.request(
      effectMethods[i % 2]!,
      {},
      { id: `r${i}`, operationId: `op${i}` },
    );
  await expect(
    f.client.request(
      effectMethods[0]!,
      {},
      { id: "overflow", operationId: "op0" },
    ),
  ).rejects.toMatchObject(error("refused", "duplicate_operation_id"));
  await expect(
    f.client.request(
      effectMethods[0]!,
      {},
      { id: "overflow", operationId: "op-overflow" },
    ),
  ).rejects.toBeInstanceOf(RequestNotSentError);
  expect(f.socket.writes).toHaveLength(4097);
});

it("rejects operation IDs, invalid IDs/deadlines/body and oversized frames before writing", async () => {
  const f = await ready();
  const count = f.socket.writes.length;
  await expect(
    f.client.request(methods[0]!, {}, { operationId: "op" }),
  ).rejects.toMatchObject(error("refused", "connector_operation_id_forbidden"));
  await expect(
    f.client.request(methods[0]!, {}, { id: "bad id" }),
  ).rejects.toMatchObject(error("refused", "invalid_request"));
  for (const timeoutMs of [0, -1, NaN, Infinity, 30001]) {
    await expect(
      f.client.request(methods[0]!, {}, { timeoutMs }),
    ).rejects.toMatchObject(error("refused", "invalid_deadline"));
  }
  await expect(f.client.request(methods[0]!, NaN)).rejects.toMatchObject(
    error("refused", "invalid_request"),
  );
  await expect(
    f.client.request(methods[0]!, "x".repeat(maxFrameBytes)),
  ).rejects.toMatchObject(error("refused", "invalid_request_frame"));
  expect(f.socket.writes).toHaveLength(count);
});

it("correlates out-of-order and coalesced responses and never reuses completed IDs", async () => {
  const f = await ready();
  const a = f.client.request(methods[0]!, {}, { id: "a" });
  const b = f.client.request(methods[0]!, {}, { id: "b" });
  await expect(
    f.client.request(methods[0]!, {}, { id: "a" }),
  ).rejects.toMatchObject(error("refused", "duplicate_request_id"));
  f.socket.emit(
    "data",
    Buffer.concat([frame(response("b")), frame(response("a"))]),
  );
  await expect(a).resolves.toMatchObject({ requestId: "a" });
  await expect(b).resolves.toMatchObject({ requestId: "b" });
  const count = f.socket.writes.length;
  await expect(
    f.client.request(methods[0]!, {}, { id: "a" }),
  ).rejects.toMatchObject(error("refused", "duplicate_request_id"));
  expect(f.socket.writes).toHaveLength(count);
});

it.each([
  "id",
  "null-id",
  "requestId",
  "profileId",
  "backendGeneration",
  "operationId",
  "both",
  "neither",
  "event",
])("fails closed on crossed/malformed response %s", async (crossed) => {
  const f = await ready();
  const id = "request";
  const pending = f.client.request(methods[0]!, {}, { id });
  const rejected = expect(pending).rejects.toMatchObject({ state: "unknown" });
  const value = {
    jsonrpc: "2.0",
    id: crossed === "id" ? "other" : crossed === "null-id" ? null : id,
    result: {
      status: "ok",
      requestId: crossed === "requestId" ? "other" : id,
      context: {
        profileId: crossed === "profileId" ? "other" : context.profileId,
        backendGeneration:
          crossed === "backendGeneration" ? "other" : context.backendGeneration,
      },
      ...(crossed === "operationId" ? { operationId: "op" } : {}),
      data: {},
    },
    ...(crossed === "both" ? { error: { code: -1, message: "secret" } } : {}),
  };
  f.socket.receive(
    crossed === "neither"
      ? { jsonrpc: "2.0", id }
      : crossed === "event"
        ? {
            jsonrpc: "2.0",
            method: "core.event",
            params: {
              context,
              stream: "stream",
              sequence: "1",
              kind: "changed",
              data: {},
            },
          }
        : value,
  );
  await rejected;
  expect(f.socket.destroyed).toBe(true);
  await expect(f.client.request(methods[0]!, {})).rejects.toMatchObject(
    error("unavailable", "connector_unavailable"),
  );
  expect(f.factory).toHaveBeenCalledTimes(1);
});

it("suppresses raw peer fault diagnostics and retains a correlated refusal", async () => {
  const f = await ready();
  const pending = f.client.request(methods[0]!, {}, { id: "fault" });
  const rejected = expect(pending).rejects.toMatchObject(
    error("refused", "connector_protocol_refused"),
  );
  f.socket.receive({
    jsonrpc: "2.0",
    id: "fault",
    error: {
      code: -32602,
      message: endpoint().token,
      data: { auth: "private" },
    },
  });
  await rejected;
  expect(f.socket.destroyed).toBe(false);
});

it.each(["error", "end", "close", "write-throw", "timeout", "client-close"])(
  "keeps submitted call unknown on %s and never reconnects",
  async (event) => {
    const f = await ready();
    if (event === "write-throw") f.socket.writeFailure = true;
    const pending = f.client.request(
      methods[0]!,
      {},
      { id: "submitted", timeoutMs: 20 },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      state: "unknown",
    });
    if (event === "timeout") await vi.advanceTimersByTimeAsync(20);
    else if (event === "client-close") await f.client.close();
    else if (event !== "write-throw")
      f.socket.emit(event, Error(endpoint().token));
    await rejected;
    expect(f.socket.writes).toHaveLength(3);
    await expect(
      f.client.request(methods[0]!, {}, { id: "next" }),
    ).rejects.toMatchObject({ state: "unavailable" });
    await expect(f.client.connect()).rejects.toMatchObject({
      state: "refused",
    });
    expect(f.factory).toHaveBeenCalledTimes(1);
  },
);

it("separates prewrite failure from submitted calls already on the same stream", async () => {
  const f = await ready();
  const pending = f.client.request(methods[0]!, {}, { id: "submitted" });
  const rejected = expect(pending).rejects.toMatchObject({ state: "unknown" });
  f.socket.writable = false;
  const count = f.socket.writes.length;
  await expect(
    f.client.request(methods[0]!, {}, { id: "not-sent" }),
  ).rejects.toMatchObject({ state: "unavailable" });
  await rejected;
  expect(f.socket.writes).toHaveLength(count);
});

it("bounds backpressure and write buffers without enqueueing or consuming unsent IDs", async () => {
  const f = await ready();
  f.socket.acceptWrites = false;
  const first = f.client.request(methods[0]!, {}, { id: "first" });
  const count = f.socket.writes.length;
  await expect(
    f.client.request(methods[0]!, {}, { id: "not-sent" }),
  ).rejects.toBeInstanceOf(RequestNotSentError);
  expect(f.socket.writes).toHaveLength(count);
  f.socket.receive(response("first"));
  await first;
  f.socket.acceptWrites = true;
  f.socket.emit("drain");
  f.socket.writableLength = maxFrameBytes;
  await expect(
    f.client.request(methods[0]!, {}, { id: "not-sent" }),
  ).rejects.toBeInstanceOf(RequestNotSentError);
  f.socket.writableLength = 0;
  const second = f.client.request(methods[0]!, {}, { id: "not-sent" });
  f.socket.receive(response("not-sent"));
  await second;
  expect(f.socket.writes).toHaveLength(count + 1);
});

it("bounds pending calls at 32 and rejects only the unsubmitted overflow", async () => {
  const f = await ready();
  const pending = Array.from({ length: 32 }, (_, i) =>
    f.client.request(methods[0]!, {}, { id: `r${i}` }),
  );
  const settled = Promise.allSettled(pending);
  const count = f.socket.writes.length;
  await expect(
    f.client.request(methods[0]!, {}, { id: "overflow" }),
  ).rejects.toBeInstanceOf(RequestNotSentError);
  expect(f.socket.writes).toHaveLength(count);
  await f.client.close();
  for (const result of await settled) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason).toMatchObject({ state: "unknown" });
  }
});

it("bounds request history at 4096 including the handshake", async () => {
  const f = await ready();
  f.socket.onWrite = (bytes) => {
    const request = decode(bytes) as Request;
    f.socket.receive(response(request.id));
  };
  for (let i = 0; i < 4095; i++)
    await f.client.request(methods[0]!, {}, { id: `r${i}` });
  expect(f.socket.writes).toHaveLength(4097); // Authentication hello is not a core request.
  await expect(
    f.client.request(methods[0]!, {}, { id: "overflow" }),
  ).rejects.toBeInstanceOf(RequestNotSentError);
  expect(f.socket.writes).toHaveLength(4097);
});

it.each(["opening", "binding", "handshake"])(
  "bounds total connection timeout during %s",
  async (phase) => {
    const f = fixture();
    const connected = f.client.connect(50);
    const rejected = expect(connected).rejects.toMatchObject(
      error(
        phase === "handshake" ? "unknown" : "unavailable",
        "connector_timeout",
      ),
    );
    if (phase !== "opening") f.socket.emit("connect");
    if (phase === "handshake") f.socket.receive(endpoint().binding);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(f.socket.destroyed).toBe(true);
    expect(f.factory).toHaveBeenCalledTimes(1);
  },
);

it("handles a factory refusal and invalid deadline with no writes or leaked diagnostics", async () => {
  const factory = vi.fn(() => {
    throw new BridgeError("refused", endpoint().token);
  });
  const client = new SocketConnectorClient(endpoint(), factory);
  clients.push(client);
  await expect(client.connect(30001)).rejects.toMatchObject(
    error("refused", "invalid_deadline"),
  );
  expect(factory).not.toHaveBeenCalled();
  await expect(client.connect()).rejects.toMatchObject(
    error("unavailable", "connector_unavailable"),
  );
  await expect(client.connect()).rejects.toMatchObject(
    error("refused", "connector_already_used"),
  );
  expect(factory).toHaveBeenCalledTimes(1);
});

it.each(["zero", "oversized", "utf8", "duplicate", "truncated"])(
  "rejects malformed framing %s with bounded decoding",
  async (kind) => {
    const f = await ready();
    const pending = f.client.request(methods[0]!, {}, { id: "request" });
    const rejected = expect(pending).rejects.toMatchObject({
      state: "unknown",
    });
    if (kind === "zero" || kind === "oversized") {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(kind === "zero" ? 0 : maxFrameBytes + 1);
      f.socket.emit("data", bytes);
    } else if (kind === "utf8") {
      f.socket.emit("data", Buffer.from([0, 0, 0, 1, 0xff]));
    } else if (kind === "duplicate") {
      const bytes = Buffer.from('{"id":"request","id":"request"}', "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      f.socket.emit("data", Buffer.concat([header, bytes]));
    } else {
      f.socket.emit("data", Buffer.from([0, 0]));
      f.socket.emit("end");
    }
    await rejected;
    expect(f.socket.destroyed).toBe(true);
  },
);

it("fails closed on a duplicate response after completion", async () => {
  const f = await ready();
  const pending = f.client.request(methods[0]!, {}, { id: "once" });
  f.socket.receive(response("once"));
  await pending;
  f.socket.receive(response("once"));
  expect(f.socket.destroyed).toBe(true);
  await expect(f.client.request(methods[0]!, {})).rejects.toMatchObject({
    state: "unavailable",
  });
});

it("keeps socket opening and hello write failures unavailable before a core call", async () => {
  for (const stage of ["opening", "hello"]) {
    const f = fixture();
    const connected = f.client.connect();
    const rejected = expect(connected).rejects.toMatchObject(
      error("unavailable", "connector_transport_failed"),
    );
    if (stage === "opening") f.socket.emit("error", Error(endpoint().token));
    else {
      f.socket.writeFailure = true;
      f.socket.emit("connect");
    }
    await rejected;
    expect(f.socket.writes).toHaveLength(stage === "opening" ? 0 : 1);
    expect(f.factory).toHaveBeenCalledTimes(1);
  }
});

it("never queues a handshake when the hello is backpressured", async () => {
  const f = fixture();
  f.socket.acceptWrites = false;
  const opened = opening(f);
  const rejected = expect(opened.connected).rejects.toMatchObject(
    error("unavailable", "backpressure"),
  );
  f.socket.receive(endpoint().binding);
  await rejected;
  f.socket.emit("drain");
  expect(f.socket.writes).toHaveLength(1);
  expect(f.socket.destroyed).toBe(true);
});

it("sanitizes a handshake fault and closes the exact stream once", async () => {
  const f = opening();
  const destroy = vi.spyOn(f.socket, "destroy");
  f.socket.receive(endpoint().binding);
  const rejected = expect(f.connected).rejects.toMatchObject(
    error("refused", "connector_protocol_refused"),
  );
  f.socket.receive({
    jsonrpc: "2.0",
    id: requestAt(f.socket).id,
    error: { code: -32003, message: endpoint().token },
  });
  await rejected;
  await f.client.close();
  await f.client.close();
  expect(destroy).toHaveBeenCalledTimes(1);
  for (const event of ["connect", "data", "error", "drain", "end", "close"])
    expect(f.socket.listenerCount(event)).toBe(0);
});

it("observes idle EOF once, retaining the same frozen content-free record for late subscribers", async () => {
  const f = await ready();
  const destroy = vi.spyOn(f.socket, "destroy");
  const observed = vi.fn();
  const off = f.client.onTerminal(observed);
  expect(f.client.terminal).toBeUndefined();
  expect(f.client.hasUnresolvedEffect).toBe(false);
  f.socket.emit("end");
  const first = f.client.terminal;
  expect(first).toEqual({
    reason: "transport_ended",
    phase: "ready",
    submittedPendingCount: 0,
    submittedEffectCount: 0,
    binding: endpoint().binding,
  });
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first!.binding)).toBe(true);
  expect(() => Object.assign(first!, { reason: "closed" })).toThrow();
  expect(() =>
    Object.assign(first!.binding, { runtimeId: "changed" }),
  ).toThrow();
  off();
  off();
  await f.client.close();
  f.socket.emit("close");
  expect(observed).toHaveBeenCalledExactlyOnceWith(first);
  const late = vi.fn();
  f.client.onTerminal(late)();
  expect(late).toHaveBeenCalledExactlyOnceWith(first);
  expect(late.mock.calls[0]![0]).toBe(first);
  expect(f.client.terminal).toBe(first);
  expect(f.client.hasUnresolvedEffect).toBe(false);
  expect(destroy).toHaveBeenCalledTimes(1);
  await expect(f.client.request(methods[0]!, {})).rejects.toMatchObject(
    error("unavailable", "connector_unavailable"),
  );
  await expect(f.client.connect()).rejects.toMatchObject(
    error("refused", "connector_already_used"),
  );
  expect(f.factory).toHaveBeenCalledTimes(1);
});

it.each(["end", "error", "close"])(
  "counts submitted effects on %s before settling unknown without retaining content or raw errors",
  async (event) => {
    const f = await ready();
    const observed = vi.fn();
    f.client.onTerminal((terminal) => {
      expect(f.client.hasUnresolvedEffect).toBe(true);
      observed(terminal);
    });
    const read = f.client.request(
      methods[0]!,
      { private: "read body" },
      { id: "read" },
    );
    const effect = f.client.request(
      effectMethods[0]!,
      { content: "secret body" },
      {
        id: "effect",
        operationId: "private-operation",
      },
    );
    const code = {
      end: "connector_transport_ended",
      error: "connector_transport_failed",
      close: "connector_transport_closed",
    }[event]!;
    const reason = {
      end: "transport_ended",
      error: "transport_failed",
      close: "transport_closed",
    }[event]!;
    const rejected = Promise.all([
      expect(read).rejects.toMatchObject(error("unknown", code)),
      expect(effect).rejects.toMatchObject(error("unknown", code)),
    ]);
    f.socket.emit(
      event,
      Error(`${endpoint().token} ${endpoint().socketPath} raw-private-error`),
    );
    await rejected;
    expect(f.client.terminal).toEqual({
      reason,
      phase: "ready",
      submittedPendingCount: 2,
      submittedEffectCount: 1,
      binding: endpoint().binding,
    });
    await f.client.close();
    expect(observed).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(f.client.terminal);
    for (const secret of [
      endpoint().token,
      endpoint().socketPath,
      "secret body",
      "read body",
      "raw-private-error",
      "private-operation",
    ])
      expect(text).not.toContain(secret);
    expect(f.socket.destroyed).toBe(true);
    expect(f.socket.writes).toHaveLength(4);
  },
);

it("allows unsubscribe before and during notification and isolates throwing or reentrant observers", async () => {
  const f = await ready();
  const removed = vi.fn();
  const off = f.client.onTerminal(removed);
  off();
  off();
  const skipped = vi.fn();
  let skip = () => {};
  f.client.onTerminal(() => {
    skip();
    void f.client.close();
    throw Error("private observer detail");
  });
  skip = f.client.onTerminal(skipped);
  const observed = vi.fn();
  f.client.onTerminal(observed);
  const pending = f.client.request(methods[0]!, {}, { id: "pending" });
  const rejected = expect(pending).rejects.toMatchObject({ state: "unknown" });
  f.socket.emit("end");
  await rejected;
  expect(removed).not.toHaveBeenCalled();
  expect(skipped).not.toHaveBeenCalled();
  expect(observed).toHaveBeenCalledTimes(1);
  expect(f.socket.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(() =>
    f.client.onTerminal(() => {
      throw Error("late observer");
    })(),
  ).not.toThrow();
});

it("classifies a local close and a truncated frame without replacing the first terminal", async () => {
  const local = await ready();
  await local.client.close();
  expect(local.client.terminal?.reason).toBe("closed");
  const truncated = await ready();
  truncated.socket.emit("data", Buffer.from([0, 0]));
  truncated.socket.emit("end");
  await truncated.client.close();
  expect(truncated.client.terminal?.reason).toBe("protocol_violation");
});

it("retains the pre-ready phase and handshake pending count without exposing malformed identity", async () => {
  const f = opening();
  f.socket.receive(endpoint().binding);
  const rejected = expect(f.connected).rejects.toMatchObject(
    error("refused", "invalid_backend_identity"),
  );
  f.socket.receive(
    response(requestAt(f.socket).id, { private: endpoint().token }),
  );
  await rejected;
  expect(f.client.terminal).toEqual({
    reason: "protocol_violation",
    phase: "handshake",
    submittedPendingCount: 1,
    submittedEffectCount: 0,
    binding: endpoint().binding,
  });
  expect(() => f.client.verifiedContext).toThrow("connector_unavailable");
});
