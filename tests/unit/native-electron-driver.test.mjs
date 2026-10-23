// Hermetic controller/transport fixtures only: no Electron, app, account or native acceptance.
import { EventEmitter, once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawnNativeElectron } from "../e2e/lib/native-electron-driver.mjs";

const endpoint = "ws://127.0.0.1:43210/12345678-abcd-1234-abcd-123456789abc";
const announcement = (url = endpoint) => `Debugger listening on ${url}\n`;
const options = () => ({
  executablePath: "/sealed/Farol Dev.app/Contents/MacOS/Farol Dev",
  args: ["/sealed/app/main.cjs", "--hidden"],
  env: { HOME: "/disposable", FAROL_TEST: "true" },
});
const drivers = [];

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url, config) {
    super();
    this.url = url;
    this.config = config;
    FakeSocket.instances.push(this);
  }
  send = vi.fn((data, callback) => {
    this.sent.push(JSON.parse(data));
    callback?.();
  });
  terminate = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close");
  });
  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
  message(value) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
  reply(id, result) {
    this.message({ id, result });
  }
  context(id = 42, isDefault = true) {
    this.message({
      method: "Runtime.executionContextCreated",
      params: {
        context: { id, name: "Electron Main Context", auxData: { isDefault } },
      },
    });
  }
}

function fixture(extraPorts = {}, childOverrides = {}) {
  const child = Object.assign(
    new EventEmitter(),
    {
      pid: 123,
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
      kill: vi.fn(() => {
        throw new Error("Child signal forbidden");
      }),
      unref: vi.fn(),
    },
    childOverrides,
  );
  const spawn = vi.fn(() => child);
  const driver = spawnNativeElectron(options(), {
    spawn,
    WebSocket: FakeSocket,
    readyTimeoutMs: 100,
    requestTimeoutMs: 80,
    disconnectTimeoutMs: 20,
    ...extraPorts,
  });
  drivers.push(driver);
  return { child, spawn, driver };
}
function connect(f) {
  f.child.stderr.emit("data", Buffer.from(announcement()));
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  return socket;
}
async function initialized(f = fixture()) {
  const socket = connect(f);
  socket.context();
  expect(socket.sent[0]).toEqual({
    id: 1,
    method: "Runtime.enable",
    params: {},
  });
  socket.reply(1, {});
  await f.driver.ready();
  return { ...f, socket };
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.disconnect();
  if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it.each([
  null,
  { executablePath: undefined },
  { executablePath: "relative" },
  { executablePath: "/bad\0path" },
  { args: "--hidden" },
  { args: [undefined] },
  { args: ["\0"] },
  { args: ["--inspect=9230"] },
  { args: ["--inspect-brk"] },
  { args: ["--remote-debugging-port=0"] },
  { args: Array(257).fill("x") },
  { env: undefined },
  { env: { KEY: 1 } },
  { env: { "BAD=KEY": "x" } },
  { env: { KEY: "\0" } },
  { targetURL: endpoint },
])("refuses malformed options before any spawn: %j", (patch) => {
  const spawn = vi.fn();
  const input = patch === null ? null : { ...options(), ...patch };
  expect(() => spawnNativeElectron(input, { spawn })).toThrow(
    "NATIVE_ELECTRON_OPTIONS_INVALID",
  );
  expect(spawn).not.toHaveBeenCalled();
});
it("refuses invalid injected bounds before spawn", () => {
  const spawn = vi.fn();
  expect(() =>
    spawnNativeElectron(options(), { spawn, readyTimeoutMs: 0 }),
  ).toThrow("NATIVE_ELECTRON_PORTS_INVALID");
  expect(spawn).not.toHaveBeenCalled();
});
it("synchronously retains one detached original child and exactly the supplied environment", async () => {
  const f = fixture();
  expect(Object.isFrozen(f.driver)).toBe(true);
  expect(f.driver.child).toBe(f.child);
  expect(Object.keys(f.driver)).toEqual([
    "child",
    "ready",
    "evaluate",
    "disconnect",
  ]);
  expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
    options().executablePath,
    [...options().args, "--inspect=127.0.0.1:0"],
    {
      env: options().env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ready = f.driver.ready();
  expect(f.driver.ready()).toBe(ready);
  await f.driver.disconnect();
  await expect(ready).rejects.toThrow("NATIVE_ELECTRON_DISCONNECTED");
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.child.kill).not.toHaveBeenCalled();
  expect(f.child.unref).not.toHaveBeenCalled();
});
it.each(["error", "exit", "close"])(
  "listens immediately for child %s before initialization",
  async (event) => {
    const f = fixture();
    f.child.emit(event, new Error("private diagnostics"));
    await expect(f.driver.ready()).rejects.toThrow(
      event === "error" ? "CHILD_ERROR" : "CHILD_TERMINAL",
    );
    expect(f.driver.child).toBe(f.child);
    expect(f.child.kill).not.toHaveBeenCalled();
  },
);
it.each(["error", "exit", "close"])(
  "rejects child %s during the inspector handshake",
  async (event) => {
    const f = fixture();
    f.child.stderr.emit("data", announcement());
    f.child.emit(event, new Error("private diagnostics"));
    await expect(f.driver.ready()).rejects.toThrow("NATIVE_ELECTRON_CHILD_");
    expect(FakeSocket.instances[0].terminate).toHaveBeenCalledTimes(1);
  },
);
it("retains original child on endpoint timeout without launching or connecting again", async () => {
  const f = fixture();
  vi.advanceTimersByTime(101);
  await expect(f.driver.ready()).rejects.toMatchObject({
    code: "NATIVE_ELECTRON_READY_TIMEOUT",
    childOutcome: "UNKNOWN",
  });
  f.child.stderr.emit("data", announcement());
  expect(FakeSocket.instances).toHaveLength(0);
  expect(f.driver.child).toBe(f.child);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.child.kill).not.toHaveBeenCalled();
});
it("connects once to a split CRLF endpoint from only the exact child's stderr", async () => {
  const f = fixture();
  f.child.stdout.emit("data", announcement());
  expect(FakeSocket.instances).toHaveLength(0);
  f.child.stderr.emit("data", announcement().slice(0, 22));
  f.child.stderr.emit("data", announcement().slice(22).replace("\n", "\r\n"));
  const socket = FakeSocket.instances[0];
  expect(socket.url).toBe(endpoint);
  expect(socket.config).toEqual({
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: 262144,
    handshakeTimeout: 100,
  });
  socket.open();
  socket.context();
  socket.reply(1, {});
  await f.driver.ready();
  expect(FakeSocket.instances).toHaveLength(1);
});
it.each([
  endpoint.replace("127.0.0.1", "localhost"),
  endpoint.replace("127.0.0.1", "[::1]"),
  endpoint.replace("127.0.0.1", "192.0.2.1"),
  endpoint.replace("ws:", "wss:"),
  endpoint.replace(":43210/", ":0/"),
  endpoint.replace(":43210/", ":65536/"),
  endpoint.replace(":43210/", ":04321/"),
  endpoint.replace("127.0.0.1", "user@127.0.0.1"),
  `${endpoint}?secret=hidden`,
  `${endpoint}/extra`,
  endpoint.replace("/12345678", "/devtools/browser/12345678"),
  endpoint.replace("123456789abc", "not-a-uuid"),
])(
  "refuses an invalid inspector endpoint without exposing it: %s",
  async (url) => {
    const f = fixture();
    f.child.stderr.emit("data", announcement(url));
    await expect(f.driver.ready()).rejects.toThrow(
      /^NATIVE_ELECTRON_ENDPOINT_INVALID$/,
    );
    expect(FakeSocket.instances).toHaveLength(0);
  },
);
it.each([false, true])(
  "refuses multiple endpoint announcements, separate chunks=%s",
  async (separate) => {
    const f = fixture();
    if (separate) {
      f.child.stderr.emit("data", announcement());
      f.child.stderr.emit("data", announcement());
    } else f.child.stderr.emit("data", announcement() + announcement());
    await expect(f.driver.ready()).rejects.toThrow("ENDPOINT_MULTIPLE");
    expect(FakeSocket.instances.length).toBe(separate ? 1 : 0);
    if (separate)
      expect(FakeSocket.instances[0].terminate).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ["x".repeat(4097), "STDERR_LINE_LIMIT"],
  ["x".repeat(4097) + "\n", "STDERR_LINE_LIMIT"],
  ["x\n".repeat(32769), "STDERR_LIMIT"],
])(
  "bounds stderr discovery without retaining diagnostics",
  async (data, code) => {
    const f = fixture();
    f.child.stderr.emit("data", data);
    await expect(f.driver.ready()).rejects.toThrow(`NATIVE_ELECTRON_${code}`);
    expect(f.child.stderr.listenerCount("data")).toBe(0);
  },
);
it.each(["error", "end"])(
  "rejects stderr %s without affecting the child",
  async (event) => {
    const f = fixture();
    f.child.stderr.emit(event, new Error("private"));
    await expect(f.driver.ready()).rejects.toThrow("NATIVE_ELECTRON_STDERR_");
    expect(f.child.kill).not.toHaveBeenCalled();
  },
);
it("retains custody when stderr is absent or transport construction rejects", async () => {
  const missing = fixture({}, { stderr: null });
  await expect(missing.driver.ready()).rejects.toThrow("STDERR_MISSING");
  const bad = fixture({
    WebSocket: class {
      constructor() {
        throw new Error(endpoint);
      }
    },
  });
  bad.child.stderr.emit("data", announcement());
  await expect(bad.driver.ready()).rejects.toThrow(
    /^NATIVE_ELECTRON_TRANSPORT_CONNECT$/,
  );
  expect(bad.driver.child).toBe(bad.child);
});
it("requires the default main context and Runtime.enable reply, without probing Electron", async () => {
  const f = fixture();
  const socket = connect(f);
  const resolved = vi.fn();
  void f.driver.ready().then(resolved);
  socket.context(7, false);
  socket.reply(1, {});
  await tick();
  expect(resolved).not.toHaveBeenCalled();
  socket.context(42);
  await f.driver.ready();
  expect(socket.sent).toHaveLength(1);
});
it.each(["missing", "ambiguous", "invalid", "rejected"])(
  "preserves custody with %s main initialization",
  async (kind) => {
    const f = fixture();
    const socket = connect(f);
    if (kind === "rejected")
      socket.message({ id: 1, error: { code: -1, message: endpoint } });
    else {
      if (kind === "ambiguous") {
        socket.context();
        socket.context(43);
      }
      if (kind === "invalid") socket.context(0);
      if (kind === "missing") {
        socket.reply(1, {});
        vi.advanceTimersByTime(101);
      }
    }
    await expect(f.driver.ready()).rejects.toThrow("NATIVE_ELECTRON_");
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(f.child.kill).not.toHaveBeenCalled();
  },
);
it("evaluates only through the selected Node context with correlated JSON values", async () => {
  const { driver, socket } = await initialized();
  const arg = { text: "'); app.quit(); //", values: [1, true, null] };
  const fn = (electron, input) => ({
    windows: electron.BrowserWindow.getAllWindows().length,
    input,
  });
  fn.toString = () => "app.quit()";
  const result = driver.evaluate(fn, arg);
  await tick();
  const sent = socket.sent[1];
  expect(sent.method).toBe("Runtime.evaluate");
  expect(sent.params).toEqual({
    expression: `(${Function.prototype.toString.call(fn)})(require('electron/main'),JSON.parse(${JSON.stringify(JSON.stringify(arg))}))`,
    contextId: 42,
    includeCommandLineAPI: true,
    returnByValue: true,
    awaitPromise: true,
  });
  socket.reply(sent.id, {
    result: { type: "object", value: { result: [1, null] } },
  });
  await expect(result).resolves.toEqual({ result: [1, null] });
});
it.each([undefined, null, "text", true, 12])(
  "returns JSON or null for protocol value %j",
  async (value) => {
    const { driver, socket } = await initialized();
    const result = driver.evaluate(() => null);
    await tick();
    socket.reply(2, {
      result:
        value === undefined
          ? { type: "undefined" }
          : { type: value === null ? "object" : typeof value, value },
    });
    await expect(result).resolves.toEqual(value ?? null);
  },
);
it("correlates concurrent replies in reverse order", async () => {
  const { driver, socket } = await initialized();
  const first = driver.evaluate(() => 1);
  const second = driver.evaluate(() => 2);
  await tick();
  socket.reply(3, { result: { type: "number", value: 2 } });
  socket.reply(2, { result: { type: "number", value: 1 } });
  await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
});
it.each([new Date(), undefined, Infinity, { bad: undefined }, () => {}, 1n])(
  "refuses non-JSON arguments before sending",
  async (arg) => {
    const { driver, socket } = await initialized();
    // Undefined selects the documented default null; test nested undefined instead.
    const value = arg === undefined ? [undefined] : arg;
    await expect(driver.evaluate(() => 1, value)).rejects.toThrow(
      "EVALUATION_INVALID",
    );
    expect(socket.sent).toHaveLength(1);
  },
);
it("bounds function source and arguments, refuses cycles and native functions", async () => {
  const { driver, socket } = await initialized();
  const cycle = {};
  cycle.self = cycle;
  for (const [fn, arg] of [
    ["not a function", null],
    [Math.max, null],
    [() => 1, cycle],
    [() => 1, "x".repeat(131073)],
  ])
    await expect(driver.evaluate(fn, arg)).rejects.toThrow(
      "EVALUATION_INVALID",
    );
  expect(socket.sent).toHaveLength(1);
});
it("bounds queued and in-flight evaluations", async () => {
  const f = fixture();
  const pending = Array.from({ length: 32 }, () => f.driver.evaluate(() => 1));
  const settled = Promise.allSettled(pending);
  await expect(f.driver.evaluate(() => 1)).rejects.toThrow("PENDING_LIMIT");
  const { socket } = await initialized(f);
  await tick();
  expect(socket.sent).toHaveLength(33);
  await expect(f.driver.evaluate(() => 1)).rejects.toThrow("PENDING_LIMIT");
  await f.driver.disconnect();
  expect((await settled).every((result) => result.status === "rejected")).toBe(
    true,
  );
});
it.each([
  "not-json",
  "null",
  "[]",
  JSON.stringify({ id: 999, result: {} }),
  JSON.stringify({ id: "2", result: {} }),
  JSON.stringify({ id: 2, result: {}, error: { code: 1, message: "x" } }),
  JSON.stringify({ id: 2, result: null }),
  JSON.stringify({ id: 2, error: "private" }),
  JSON.stringify({ id: 2, result: {}, sessionId: "browser" }),
  JSON.stringify({ method: "Runtime.consoleAPICalled", params: null }),
])("rejects malformed or uncorrelated protocol data", async (payload) => {
  const { driver, socket } = await initialized();
  const pending = driver.evaluate(() => 1);
  await tick();
  socket.emit("message", Buffer.from(payload), false);
  await expect(pending).rejects.toThrow("NATIVE_ELECTRON_PROTOCOL_");
  expect(socket.terminate).toHaveBeenCalledTimes(1);
});
it.each(["binary", "oversized", "duplicate"])(
  "rejects %s protocol frames",
  async (kind) => {
    const { driver, socket } = await initialized();
    const pending = driver.evaluate(() => 1);
    await tick();
    if (kind === "binary") socket.emit("message", Buffer.from("{}"), true);
    else if (kind === "oversized")
      socket.emit("message", Buffer.alloc(262145), false);
    else socket.reply(1, {});
    await expect(pending).rejects.toThrow("NATIVE_ELECTRON_PROTOCOL_");
  },
);
it.each([
  {},
  { result: { type: "number", value: "wrong" } },
  { result: { type: "object", objectId: "handle" } },
  { result: { type: "number", unserializableValue: "NaN" } },
  { result: { type: "function", value: null } },
  { result: { type: "undefined", unserializableValue: "NaN" } },
  { exceptionDetails: null },
])("refuses malformed or non-JSON evaluation results", async (response) => {
  const { driver, socket } = await initialized();
  const pending = driver.evaluate(() => 1);
  await tick();
  socket.reply(2, response);
  await expect(pending).rejects.toThrow("NATIVE_ELECTRON_");
  expect(socket.terminate).toHaveBeenCalledTimes(1);
});
it.each(["exception", "protocol-error"])(
  "redacts %s and permits an explicit next evaluation without replay",
  async (kind) => {
    const { driver, socket } = await initialized();
    const pending = driver.evaluate(() => 1);
    await tick();
    if (kind === "exception")
      socket.reply(2, {
        result: { type: "object" },
        exceptionDetails: { text: endpoint },
      });
    else socket.message({ id: 2, error: { code: -32000, message: endpoint } });
    await expect(pending).rejects.toThrow(
      kind === "exception"
        ? /^NATIVE_ELECTRON_EVALUATION_EXCEPTION$/
        : /^NATIVE_ELECTRON_PROTOCOL_REJECTED$/,
    );
    const next = driver.evaluate(() => true);
    await tick();
    socket.reply(3, { result: { type: "boolean", value: true } });
    await expect(next).resolves.toBe(true);
    expect(socket.sent).toHaveLength(3);
  },
);
it.each([
  "error",
  "close",
  "send-throw",
  "send-callback",
  "timeout",
  "context-lost",
])("rejects pending requests after %s without replay", async (kind) => {
  const { driver, child, socket, spawn } = await initialized();
  if (kind === "send-throw")
    socket.send.mockImplementation(() => {
      throw new Error(endpoint);
    });
  if (kind === "send-callback")
    socket.send.mockImplementation((_, callback) =>
      callback(new Error(endpoint)),
    );
  const pending = driver.evaluate(() => 1);
  const settled = expect(pending).rejects.toThrow("NATIVE_ELECTRON_");
  await tick();
  if (kind === "error") socket.emit("error", new Error(endpoint));
  if (kind === "close") {
    socket.readyState = FakeSocket.CLOSED;
    socket.emit("close");
  }
  if (kind === "timeout") vi.advanceTimersByTime(81);
  if (kind === "context-lost")
    socket.message({
      method: "Runtime.executionContextDestroyed",
      params: { executionContextId: 42 },
    });
  await settled;
  await driver.disconnect();
  await expect(driver.evaluate(() => 1)).rejects.toThrow("NATIVE_ELECTRON_");
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).not.toHaveBeenCalled();
});
it("disconnect only terminates its own socket, cancels pending work and detaches its own listeners", async () => {
  const signals = ["SIGTERM", "SIGINT", "SIGHUP", "exit"];
  const counts = signals.map((event) => process.listenerCount(event));
  const { child, driver, socket } = await initialized();
  const foreignStderr = vi.fn(),
    foreignTerminal = vi.fn(),
    foreignMessage = vi.fn();
  child.stderr.on("data", foreignStderr);
  child.on("exit", foreignTerminal);
  socket.on("message", foreignMessage);
  const pending = driver.evaluate(() => 1);
  const settled = expect(pending).rejects.toThrow("DISCONNECTED");
  await tick();
  await driver.disconnect();
  await driver.disconnect();
  await settled;
  expect(socket.terminate).toHaveBeenCalledTimes(1);
  expect(socket.sent.map((message) => message.method)).toEqual([
    "Runtime.enable",
    "Runtime.evaluate",
  ]);
  expect(child.kill).not.toHaveBeenCalled();
  expect(child.unref).not.toHaveBeenCalled();
  expect(signals.map((event) => process.listenerCount(event))).toEqual(counts);
  expect(child.stderr.listeners("data")).toEqual([foreignStderr]);
  expect(child.listeners("exit")).toEqual([foreignTerminal]);
  expect(socket.listeners("message")).toEqual([foreignMessage]);
  expect(socket.listenerCount("error")).toBe(0);
  expect(socket.listenerCount("close")).toBe(0);
  socket.reply(2, { result: { type: "number", value: 99 } });
  child.stderr.emit("data", "root still owns logs");
  child.emit("exit", 0, null);
  expect(foreignStderr).toHaveBeenCalled();
  expect(foreignTerminal).toHaveBeenCalled();
});
it("bounds transport disposal even if an injected socket never emits close", async () => {
  const { driver, socket } = await initialized();
  socket.terminate.mockImplementation(() => {});
  const disconnected = driver.disconnect();
  expect(socket.terminate).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(21);
  await disconnected;
  expect(socket.eventNames()).toEqual([]);
});
it("absorbs only its asynchronous CONNECTING termination error until close", async () => {
  const f = fixture();
  f.child.stderr.emit("data", announcement());
  const socket = FakeSocket.instances[0];
  socket.terminate.mockImplementation(() => {
    queueMicrotask(() => {
      socket.emit("error", new Error("aborted"));
      socket.emit("close");
    });
  });
  await f.driver.disconnect();
  expect(socket.eventNames()).toEqual([]);
});

it("classifies a synchronous spawn refusal without retry or diagnostics", () => {
  const spawn = vi.fn(() => {
    throw new Error(endpoint);
  });
  expect(() => spawnNativeElectron(options(), { spawn })).toThrow(
    /^NATIVE_ELECTRON_SPAWN_FAILED$/,
  );
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("exercises the pinned ws client on a disposable loopback fixture and destroys only that transport", async () => {
  vi.useRealTimers();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests = [];
  try {
    await once(server, "listening");
    const peerConnected = once(server, "connection");
    const f = fixture({
      WebSocket,
      readyTimeoutMs: 2000,
      requestTimeoutMs: 2000,
    });
    f.child.stderr.emit(
      "data",
      announcement(endpoint.replace(":43210/", `:${server.address().port}/`)),
    );
    const [peer] = await peerConnected;
    peer.on("message", (data) => {
      const message = JSON.parse(data.toString());
      requests.push(message);
      if (message.method === "Runtime.enable") {
        peer.send(
          JSON.stringify({
            method: "Runtime.executionContextCreated",
            params: { context: { id: 91, auxData: { isDefault: true } } },
          }),
        );
        peer.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.params.expression.includes("fixture-result")) {
        peer.send(
          JSON.stringify({
            id: message.id,
            result: { result: { type: "string", value: "fixture-result" } },
          }),
        );
      }
    });
    await f.driver.ready();
    await expect(f.driver.evaluate(() => "fixture-result")).resolves.toBe(
      "fixture-result",
    );
    expect(requests[1].params.contextId).toBe(91);
    // Leave a request unresolved: disconnect must reject it and never wait for a close handshake.
    const nextRequest = once(peer, "message");
    const pending = f.driver.evaluate(() => "pending");
    const rejected = expect(pending).rejects.toThrow("DISCONNECTED");
    await nextRequest;
    const closed = once(peer, "close");
    await f.driver.disconnect();
    await rejected;
    const [code] = await closed;
    expect(code).toBe(1006); // No graceful WebSocket close frame or application Quit.
    expect(requests.map((request) => request.method)).toEqual([
      "Runtime.enable",
      "Runtime.evaluate",
      "Runtime.evaluate",
    ]);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.driver.child).toBe(f.child);
  } finally {
    for (const driver of drivers.splice(0)) await driver.disconnect();
    for (const peer of server.clients) peer.terminate(); // Fixture-owned peer only.
    await new Promise((resolve) => server.close(resolve));
  }
});

it("rejects a malformed Runtime.enable response instead of declaring readiness", async () => {
  const f = fixture();
  const socket = connect(f);
  socket.context();
  socket.reply(1, { unexpected: true });
  await expect(f.driver.ready()).rejects.toThrow("INITIALIZATION_INVALID");
});

it("serializes the argument as JSON data, preserving prototype-named keys", async () => {
  const { driver, socket } = await initialized();
  const arg = JSON.parse('{"__proto__":{"fixture":true},"quoted":"\\\""}');
  const pending = driver.evaluate((_, value) => value, arg);
  await tick();
  expect(socket.sent[1].params.expression).toContain(
    `JSON.parse(${JSON.stringify(JSON.stringify(arg))})`,
  );
  socket.reply(2, { result: { type: "object", value: arg } });
  await expect(pending).resolves.toEqual(arg);
});

it("disposes a real ws connection stuck before upgrade without waiting for handshake timeout", async () => {
  vi.useRealTimers();
  const server = createServer();
  const peers = new Set();
  server.on("connection", (peer) => {
    peers.add(peer);
    peer.once("close", () => peers.delete(peer));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const upgrade = once(server, "upgrade");
    const f = fixture({ WebSocket, readyTimeoutMs: 2000 });
    const rejected = expect(f.driver.ready()).rejects.toThrow("DISCONNECTED");
    f.child.stderr.emit(
      "data",
      announcement(endpoint.replace(":43210/", `:${server.address().port}/`)),
    );
    const [, peer] = await upgrade; // Fixture deliberately never completes the handshake.
    peer.on("end", () => peer.end());
    peer.resume(); // Consume the aborted client's EOF; upgraded HTTP sockets are paused.
    const closed = once(peer, "close", { signal: AbortSignal.timeout(1000) });
    await f.driver.disconnect();
    await rejected;
    await closed;
    expect(f.child.kill).not.toHaveBeenCalled();
  } finally {
    for (const driver of drivers.splice(0)) await driver.disconnect();
    for (const peer of peers) peer.destroy(); // Exact disposable fixture sockets only.
    await new Promise((resolve) => server.close(resolve));
  }
});

it("never resolves the npm installer shim when native Electron is not initialized", async () => {
  const { driver, socket } = await initialized();
  let installerAttempts = 0;
  const pending = driver.evaluate(({ app }) => app.isReady());
  const rejected = expect(pending).rejects.toThrow("EVALUATION_EXCEPTION");
  await tick();
  const sent = socket.sent[1];
  expect(() =>
    runInNewContext(sent.params.expression, {
      require: (name) => {
        if (name === "electron") {
          installerAttempts++;
          return { app: { isReady: () => false } };
        }
        expect(name).toBe("electron/main");
        throw Error("native module is not initialized");
      },
    }),
  ).toThrow("native module is not initialized");
  socket.reply(sent.id, {
    exceptionDetails: { text: "native module unavailable" },
  });
  await rejected;
  expect(installerAttempts).toBe(0);
  expect(driver.child.kill).not.toHaveBeenCalled();
});
