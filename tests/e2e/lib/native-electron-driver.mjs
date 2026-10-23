import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import WebSocket from "ws";

const MAX_MESSAGE = 256 * 1024;
const MAX_EXPRESSION = 128 * 1024;
const MAX_STDERR = 64 * 1024;
const MAX_LINE = 4096;
const MAX_PENDING = 32;
const endpointPattern =
  /^Debugger listening on (ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const plain = (value) =>
  record(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === "string" && !value.includes("\0");
const bytes = (value) => Buffer.byteLength(value, "utf8");
const unknown = (reason) =>
  Object.assign(new Error(`NATIVE_ELECTRON_${reason}`), {
    code: `NATIVE_ELECTRON_${reason}`,
    childOutcome: "UNKNOWN",
  });

function jsonValue(value, depth = 0) {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return [...value].every((item) => jsonValue(item, depth + 1));
  return (
    plain(value) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) =>
        Object.hasOwn(descriptor, "value") &&
        jsonValue(descriptor.value, depth + 1),
    )
  );
}

function validate(options) {
  if (
    !plain(options) ||
    Object.keys(options).some(
      (key) => !["executablePath", "args", "env"].includes(key),
    ) ||
    !text(options.executablePath) ||
    !isAbsolute(options.executablePath) ||
    bytes(options.executablePath) > 16384 ||
    !Array.isArray(options.args) ||
    options.args.length > 256 ||
    ![...options.args].every(
      (arg) =>
        text(arg) &&
        bytes(arg) <= 16384 &&
        !/^--(?:inspect|debug|remote-debugging)(?:[-=]|$)/i.test(arg),
    ) ||
    !plain(options.env) ||
    !Object.entries(options.env).every(
      ([key, value]) =>
        text(key) && key.length > 0 && !key.includes("=") && text(value),
    )
  )
    throw new TypeError("NATIVE_ELECTRON_OPTIONS_INVALID");
  return {
    executablePath: options.executablePath,
    args: [...options.args, "--inspect=127.0.0.1:0"],
    env: { ...options.env },
  };
}

/**
 * Owns one child launch and only its Node inspector transport. Never owns Quit.
 * Ports are test injection, not another target or a reconnect mechanism.
 * ready() waits for Runtime.enable and the unique default Node main context;
 * Electron's module may still be unavailable. Root decides whether to poll it.
 * Errors deliberately exclude endpoint, stderr, argument and protocol contents.
 */
export function spawnNativeElectron(options, ports = {}) {
  const launch = validate(options);
  const {
    spawn: spawnChild = spawn,
    WebSocket: Socket = WebSocket,
    setTimeout: schedule = setTimeout,
    clearTimeout: cancel = clearTimeout,
    readyTimeoutMs = 10000,
    requestTimeoutMs = 10000,
    disconnectTimeoutMs = 1000,
  } = ports;
  if (
    ![spawnChild, Socket, schedule, cancel].every(
      (port) => typeof port === "function",
    ) ||
    ![readyTimeoutMs, requestTimeoutMs, disconnectTimeoutMs].every(
      (limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 60000,
    )
  )
    throw new TypeError("NATIVE_ELECTRON_PORTS_INVALID");

  // Retain the actual process before any initialization. No lifecycle hooks.
  let child;
  try {
    child = spawnChild(launch.executablePath, launch.args, {
      env: launch.env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw unknown("SPAWN_FAILED");
  }
  let resolveReady, rejectReady;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Root receives the child before it attaches to readiness; avoid an unhandled rejection.
  void readiness.catch(() => {});
  let failure, socket, closing, readyTimer;
  let tail = "";
  let stderrBytes = 0;
  let endpointSeen = false;
  let enabled = false;
  let contextId;
  let sequence = 0;
  let evaluations = 0;
  const pending = new Map();

  function detachChild() {
    child.off("error", onChildError);
    child.off("exit", onChildExit);
    child.off("close", onChildExit);
    child.stderr?.off("data", onStderr);
    child.stderr?.off("error", onStderrError);
    child.stderr?.off("end", onStderrEnd);
    tail = "";
  }

  function stopTransport() {
    if (closing) return closing;
    if (!socket) return Promise.resolve();
    const owned = socket;
    socket = undefined;
    owned.off("open", onOpen);
    owned.off("message", onMessage);
    owned.off("error", onSocketError);
    owned.off("close", onSocketClose);
    closing = new Promise((resolve) => {
      let timer;
      const ignoreError = () => {};
      const done = () => {
        cancel(timer);
        owned.off("error", ignoreError);
        owned.off("close", done);
        resolve();
      };
      // ws emits an asynchronous error when terminating a CONNECTING socket.
      owned.on("error", ignoreError);
      owned.once("close", done);
      timer = schedule(done, disconnectTimeoutMs);
      try {
        if (owned.readyState === Socket.CLOSED) done();
        else owned.terminate(); // Destroys only this inspector socket, without a close handshake.
      } catch {
        done();
      }
    });
    return closing;
  }

  function fail(reason) {
    if (failure) return;
    failure = unknown(reason);
    cancel(readyTimer);
    detachChild();
    rejectReady(failure);
    for (const request of pending.values()) {
      cancel(request.timer);
      request.reject(failure);
    }
    pending.clear();
    void stopTransport();
  }
  const onChildError = () => fail("CHILD_ERROR");
  const onChildExit = () => fail("CHILD_TERMINAL");
  const onStderrError = () => fail("STDERR_ERROR");
  const onStderrEnd = () => fail("STDERR_ENDED");
  const onSocketError = () => fail("TRANSPORT_ERROR");
  const onSocketClose = () => fail("TRANSPORT_CLOSED");

  function markReady() {
    if (!failure && enabled && contextId !== undefined) {
      cancel(readyTimer);
      resolveReady();
    }
  }

  function request(method, params) {
    if (failure) return Promise.reject(failure);
    if (!socket || socket.readyState !== Socket.OPEN)
      return Promise.reject(unknown("TRANSPORT_NOT_OPEN"));
    if (pending.size >= MAX_PENDING)
      return Promise.reject(unknown("PENDING_LIMIT"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = schedule(() => fail("REQUEST_TIMEOUT"), requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) fail("TRANSPORT_SEND");
        });
      } catch {
        fail("TRANSPORT_SEND");
      }
    });
  }

  function onOpen() {
    if (failure) return;
    void request("Runtime.enable", {}).then(
      (response) => {
        if (Object.keys(response).length !== 0)
          return fail("INITIALIZATION_INVALID");
        enabled = true;
        markReady();
      },
      () => fail("INITIALIZATION_FAILED"),
    );
  }

  function onMessage(data, binary) {
    if (failure) return;
    if (binary || !(typeof data === "string" || Buffer.isBuffer(data)))
      return fail("PROTOCOL_INVALID");
    if (data.length > MAX_MESSAGE || bytes(data) > MAX_MESSAGE)
      return fail("PROTOCOL_TOO_LARGE");
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return fail("PROTOCOL_INVALID");
    }
    if (!record(message)) return fail("PROTOCOL_INVALID");
    if (!Object.hasOwn(message, "id")) {
      if (
        typeof message.method !== "string" ||
        !record(message.params) ||
        Object.keys(message).some((key) => !["method", "params"].includes(key))
      )
        return fail("PROTOCOL_INVALID");
      if (message.method === "Runtime.executionContextCreated") {
        const context = message.params.context;
        if (
          !record(context) ||
          !Number.isSafeInteger(context.id) ||
          context.id <= 0
        )
          return fail("CONTEXT_INVALID");
        if (context.auxData?.isDefault === true) {
          if (contextId !== undefined && contextId !== context.id)
            return fail("CONTEXT_AMBIGUOUS");
          contextId = context.id;
          markReady();
        }
      } else if (
        message.method === "Runtime.executionContextsCleared" ||
        (message.method === "Runtime.executionContextDestroyed" &&
          message.params.executionContextId === contextId)
      ) {
        fail("CONTEXT_LOST");
      }
      return;
    }
    if (
      !Number.isSafeInteger(message.id) ||
      !pending.has(message.id) ||
      Object.keys(message).some(
        (key) => !["id", "result", "error"].includes(key),
      ) ||
      Object.hasOwn(message, "result") === Object.hasOwn(message, "error")
    )
      return fail("PROTOCOL_CORRELATION");
    const current = pending.get(message.id);
    if (Object.hasOwn(message, "error")) {
      if (
        !record(message.error) ||
        !Number.isSafeInteger(message.error.code) ||
        typeof message.error.message !== "string"
      )
        return fail("PROTOCOL_INVALID");
      cancel(current.timer);
      pending.delete(message.id);
      current.reject(unknown("PROTOCOL_REJECTED"));
      return;
    }
    if (!record(message.result)) return fail("PROTOCOL_INVALID");
    cancel(current.timer);
    pending.delete(message.id);
    current.resolve(message.result);
  }

  function onStderr(chunk) {
    if (failure) return;
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk)))
      return fail("STDERR_INVALID");
    stderrBytes += bytes(chunk);
    if (stderrBytes > MAX_STDERR) return fail("STDERR_LIMIT");
    tail += chunk.toString();
    let endpoint;
    for (;;) {
      const newline = tail.indexOf("\n");
      if (newline < 0) break;
      const line = tail.slice(0, newline).replace(/\r$/, "");
      tail = tail.slice(newline + 1);
      if (bytes(line) > MAX_LINE) return fail("STDERR_LINE_LIMIT");
      if (!line.includes("Debugger listening on")) continue;
      const match = endpointPattern.exec(line);
      if (!match || Number(match[2]) > 65535) return fail("ENDPOINT_INVALID");
      if (endpointSeen) return fail("ENDPOINT_MULTIPLE");
      endpointSeen = true;
      endpoint = match[1];
    }
    if (bytes(tail) > MAX_LINE) return fail("STDERR_LINE_LIMIT");
    if (!endpoint) return;
    try {
      socket = new Socket(endpoint, {
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: MAX_MESSAGE,
        handshakeTimeout: readyTimeoutMs,
      });
      socket.on("open", onOpen);
      socket.on("message", onMessage);
      socket.on("error", onSocketError);
      socket.on("close", onSocketClose);
    } catch {
      fail("TRANSPORT_CONNECT");
    }
  }

  // Install error handling immediately; no async boundary precedes these listeners.
  child.on("error", onChildError);
  child.on("exit", onChildExit);
  child.on("close", onChildExit);
  child.stderr?.on("error", onStderrError);
  child.stderr?.on("end", onStderrEnd);
  child.stderr?.on("data", onStderr);
  readyTimer = schedule(() => fail("READY_TIMEOUT"), readyTimeoutMs);
  if (!child.stderr) fail("STDERR_MISSING");

  return Object.freeze({
    child,
    ready: () => readiness,
    async evaluate(fn, arg = null) {
      let expression;
      try {
        if (typeof fn !== "function" || !jsonValue(arg)) throw new Error();
        const source = Function.prototype.toString.call(fn);
        if (source.includes("[native code]")) throw new Error();
        // Parse JSON as data: an object literal would reinterpret a __proto__ key.
        expression = `(${source})(require('electron'),JSON.parse(${JSON.stringify(JSON.stringify(arg))}))`;
        if (bytes(expression) > MAX_EXPRESSION) throw new Error();
      } catch {
        throw unknown("EVALUATION_INVALID");
      }
      if (evaluations >= MAX_PENDING) throw unknown("PENDING_LIMIT");
      evaluations++;
      try {
        await readiness;
        const response = await request("Runtime.evaluate", {
          expression,
          contextId,
          includeCommandLineAPI: true,
          returnByValue: true,
          awaitPromise: true,
        });
        if (Object.hasOwn(response, "exceptionDetails")) {
          if (!record(response.exceptionDetails)) {
            fail("PROTOCOL_INVALID");
            throw failure;
          }
          throw unknown("EVALUATION_EXCEPTION");
        }
        const remote = response.result;
        if (
          !record(remote) ||
          Object.hasOwn(remote, "objectId") ||
          Object.hasOwn(remote, "unserializableValue")
        ) {
          fail("PROTOCOL_INVALID");
          throw failure;
        }
        // Keep the public result JSON-only, including a successful void Quit call.
        if (remote.type === "undefined" && !Object.hasOwn(remote, "value"))
          return null;
        const value = remote.value;
        if (
          !Object.hasOwn(remote, "value") ||
          !["object", "string", "number", "boolean"].includes(remote.type) ||
          (value !== null && typeof value !== remote.type) ||
          (value === null && remote.type !== "object") ||
          !jsonValue(value)
        ) {
          fail("RESULT_INVALID");
          throw failure;
        }
        return value;
      } finally {
        evaluations--;
      }
    },
    async disconnect() {
      fail("DISCONNECTED");
      await stopTransport();
    },
  });
}
