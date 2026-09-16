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
  pid?: number;
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
}>;

type ServerRequestHandler = (params: unknown) => Promise<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 2 * 1_024 * 1_024;

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
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private initialized = false;

  constructor(
    private readonly process: CodexAppServerProcess,
    private readonly options: CodexAppServerClientOptions,
  ) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1 ||
      !Number.isSafeInteger(this.maxFrameBytes) ||
      this.maxFrameBytes < 64
    ) {
      throw protocolError("CODEX_APP_SERVER_OPTIONS_INVALID");
    }
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => this.receive(chunk));
    process.on("exit", () => this.fail("CODEX_APP_SERVER_EXITED", false));
    process.on("error", () => this.fail("CODEX_APP_SERVER_FAILED", true));
  }

  async initialize(): Promise<unknown> {
    if (this.initialized) {
      throw protocolError("CODEX_APP_SERVER_ALREADY_INITIALIZED");
    }
    const result = await this.request("initialize", {
      clientInfo: this.options.clientInfo,
      capabilities: { experimentalApi: true },
    });
    if (this.closed) throw protocolError("CODEX_APP_SERVER_CLOSED");
    this.notify("initialized", {});
    this.initialized = true;
    return result;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(protocolError("CODEX_APP_SERVER_CLOSED"));
    }
    if (method.length === 0) {
      return Promise.reject(protocolError("CODEX_APP_SERVER_METHOD_INVALID"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError("CODEX_APP_SERVER_REQUEST_TIMEOUT"));
      }, this.requestTimeoutMs);
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending("CODEX_APP_SERVER_CLOSED");
    this.process.stdin.end();
    this.process.kill("SIGTERM");
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
            ? protocolError(
                `CODEX_APP_SERVER_RPC_${message.error.code}:${message.error.message}`,
              )
            : protocolError("CODEX_APP_SERVER_RPC_ERROR_INVALID"),
        );
      } else if ("result" in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(protocolError("CODEX_APP_SERVER_RESPONSE_INVALID"));
      }
      return;
    }
    if (typeof message.method === "string") return;
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
    if (kill) this.process.kill("SIGKILL");
  }

  private rejectPending(code: string): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(protocolError(code));
    }
    this.pending.clear();
  }
}
