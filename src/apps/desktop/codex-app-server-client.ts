import type { Readable, Writable } from "node:stream";

type RequestId = number | string;

type JsonRpcError = Readonly<{
  code: number;
  message: string;
  data?: unknown;
}>;

type PendingRequest = Readonly<{
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}>;

export type CodexAppServerProcess = Readonly<{
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}>;

export type CodexAppServerClientOptions = Readonly<{
  clientInfo: Readonly<{ name: string; version: string }>;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  shutdownTimeoutMs?: number;
}>;

export type CodexAppServerRequestOptions = Readonly<{
  timeoutMs?: number;
}>;

type ServerRequestHandler = (params: unknown) => Promise<unknown>;
type ServerNotificationHandler = (params: unknown) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;

function protocolError(code: string): Error {
  return new Error(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): value is RequestId {
  return typeof value === "string" || Number.isSafeInteger(value);
}

function rpcError(value: unknown): value is JsonRpcError {
  return (
    record(value) &&
    typeof value.code === "number" &&
    typeof value.message === "string"
  );
}

export class CodexAppServerClient {
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly handlers = new Map<string, ServerRequestHandler>();
  private readonly notificationHandlers = new Map<
    string,
    ServerNotificationHandler
  >();
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly shutdownTimeoutMs: number;
  private readonly exited: Promise<void>;
  private resolveExit!: () => void;
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private initialized = false;
  private ready = false;
  private processExited = false;
  private forcedKillIssued = false;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly process: CodexAppServerProcess,
    private readonly options: CodexAppServerClientOptions,
  ) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1 ||
      !Number.isSafeInteger(this.maxFrameBytes) ||
      this.maxFrameBytes < 64 ||
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs < 1
    ) {
      throw protocolError("CODEX_APP_SERVER_OPTIONS_INVALID");
    }
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => this.receive(chunk));
    process.on("exit", () => {
      this.processExited = true;
      this.resolveExit();
      this.fail("CODEX_APP_SERVER_EXITED", false);
    });
    process.on("error", () => this.fail("CODEX_APP_SERVER_FAILED", true));
  }

  async initialize(
    options: Readonly<{ deferReady?: boolean }> = {},
  ): Promise<unknown> {
    if (this.initialized) {
      throw protocolError("CODEX_APP_SERVER_ALREADY_INITIALIZED");
    }
    const result = await this.request("initialize", {
      clientInfo: this.options.clientInfo,
      capabilities: { experimentalApi: true },
    });
    if (this.closed) throw protocolError("CODEX_APP_SERVER_CLOSED");
    this.initialized = true;
    if (!options.deferReady) this.markReady();
    return result;
  }

  markReady(): void {
    if (!this.initialized || this.ready || this.closed) {
      throw protocolError("CODEX_APP_SERVER_READINESS_INVALID");
    }
    this.notify("initialized", {});
    this.ready = true;
  }

  request(
    method: string,
    params: unknown,
    options: CodexAppServerRequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(protocolError("CODEX_APP_SERVER_CLOSED"));
    }
    if (method.length === 0) {
      return Promise.reject(protocolError("CODEX_APP_SERVER_METHOD_INVALID"));
    }
    const requestedTimeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < 1) {
      return Promise.reject(
        protocolError("CODEX_APP_SERVER_REQUEST_TIMEOUT_INVALID"),
      );
    }
    const timeoutMs = Math.min(requestedTimeoutMs, this.requestTimeoutMs);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError("CODEX_APP_SERVER_REQUEST_TIMEOUT"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : protocolError("CODEX_APP_SERVER_WRITE_FAILED"),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) throw protocolError("CODEX_APP_SERVER_CLOSED");
    if (method.length === 0) {
      throw protocolError("CODEX_APP_SERVER_METHOD_INVALID");
    }
    this.write({ method, params });
  }

  handleServerRequest(
    method: string,
    handler: ServerRequestHandler,
  ): () => void {
    if (method.length === 0 || this.handlers.has(method)) {
      throw protocolError("CODEX_APP_SERVER_HANDLER_INVALID");
    }
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }

  handleNotification(
    method: string,
    handler: ServerNotificationHandler,
  ): () => void {
    if (method.length === 0 || this.notificationHandlers.has(method)) {
      throw protocolError("CODEX_APP_SERVER_NOTIFICATION_HANDLER_INVALID");
    }
    this.notificationHandlers.set(method, handler);
    return () => {
      if (this.notificationHandlers.get(method) === handler) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  async close(): Promise<void> {
    if (!this.closing) this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const wasClosed = this.closed;
    if (!this.closed) {
      this.closed = true;
      this.rejectPending("CODEX_APP_SERVER_CLOSED");
      this.process.stdin.end();
    }
    if (this.processExited) return;
    if (wasClosed) {
      this.forcedKillIssued = true;
      this.process.kill("SIGKILL");
    } else {
      this.process.kill("SIGTERM");
    }
    if (await this.waitForExit()) return;
    if (!this.forcedKillIssued) {
      this.forcedKillIssued = true;
      this.process.kill("SIGKILL");
    }
    if (await this.waitForExit()) return;
    throw protocolError("CODEX_APP_SERVER_SHUTDOWN_UNCONFIRMED");
  }

  private waitForExit(): Promise<boolean> {
    if (this.processExited) return Promise.resolve(true);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([
      this.exited.then(() => true as const),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private write(message: unknown): void {
    const frame = `${JSON.stringify(message)}\n`;
    this.process.stdin.write(frame, "utf8");
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      this.fail("CODEX_APP_SERVER_FRAME_TOO_LARGE", true);
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        this.fail("CODEX_APP_SERVER_FRAME_TOO_LARGE", true);
        return;
      }
      if (line.trim().length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.fail("CODEX_APP_SERVER_FRAME_INVALID", true);
        return;
      }
      this.dispatch(message);
      if (this.closed) return;
    }
  }

  private dispatch(message: unknown): void {
    if (!record(message)) {
      this.fail("CODEX_APP_SERVER_MESSAGE_INVALID", true);
      return;
    }
    if (requestId(message.id) && typeof message.method === "string") {
      void this.answerServerRequest(message.id, message.method, message.params);
      return;
    }
    if (requestId(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if ("error" in message) {
        pending.reject(
          rpcError(message.error)
            ? protocolError(`CODEX_APP_SERVER_RPC_${message.error.code}`)
            : protocolError("CODEX_APP_SERVER_RPC_ERROR_INVALID"),
        );
      } else if ("result" in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(protocolError("CODEX_APP_SERVER_RESPONSE_INVALID"));
      }
      return;
    }
    if (typeof message.method === "string") {
      const handler = this.notificationHandlers.get(message.method);
      if (!handler) return;
      try {
        handler(message.params);
      } catch {
        this.fail("CODEX_APP_SERVER_NOTIFICATION_FAILED", true);
      }
      return;
    }
    this.fail("CODEX_APP_SERVER_MESSAGE_INVALID", true);
  }

  private async answerServerRequest(
    id: RequestId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) {
      if (!this.closed) {
        this.write({
          id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      return;
    }
    try {
      const result = await handler(params);
      if (!this.closed) this.write({ id, result });
    } catch {
      if (!this.closed) {
        this.write({
          id,
          error: { code: -32000, message: "Dynamic tool call failed" },
        });
      }
    }
  }

  private fail(code: string, kill: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(code);
    if (kill) {
      this.forcedKillIssued = true;
      this.process.kill("SIGKILL");
    }
  }

  private rejectPending(code: string): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(protocolError(code));
    }
    this.pending.clear();
  }
}
