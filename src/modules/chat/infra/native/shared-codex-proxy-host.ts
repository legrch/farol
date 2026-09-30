import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CodexProxyWebSocket } from "./codex-proxy-websocket";

import {
  HandoffNotSubmittedError,
  type HandoffHost,
} from "../../app/service/persistent-codex-handoff";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 8;
const REQUEST_TIMEOUT_MS = 20_000;
const SAFE_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const METHODS = new Set([
  "model/list",
  "project/list",
  "thread/start",
  "thread/read",
  "thread/list",
  "thread/name/set",
  "thread/turns/list",
  "thread/items/list",
  "turn/start",
  "turn/steer",
]);

type Pending = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type Launch = () => ChildProcessWithoutNullStreams;

function unavailable(): Error {
  return new Error("CODEX_SHARED_HOST_UNAVAILABLE");
}

export type CodexProxyFailureResult =
  | "launch_failed"
  | "pipe_failed"
  | "exited"
  | "timeout"
  | "invalid_identity"
  | "invalid_protocol"
  | "rpc_error"
  | "closed";

export type CodexProxyDiagnostic = Readonly<{
  phase: "initialize" | "request" | "idle";
  method: string;
  result: CodexProxyFailureResult;
  rpcCode?: number;
}>;

/** Closed transport evidence; never retains an exception, payload, or stderr. */
export class CodexProxyFailure extends Error {
  readonly diagnostic: CodexProxyDiagnostic;

  constructor(diagnostic: CodexProxyDiagnostic) {
    super("CODEX_SHARED_HOST_UNAVAILABLE");
    this.name = "CodexProxyFailure";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

/** Pre-send refusal with closed transport evidence, preserving effect safety. */
export class CodexProxyNotSubmittedFailure extends HandoffNotSubmittedError {
  readonly diagnostic: CodexProxyDiagnostic;

  constructor(diagnostic: CodexProxyDiagnostic) {
    super("CODEX_SHARED_HOST_UNAVAILABLE");
    this.name = "CodexProxyNotSubmittedFailure";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export type CodexSocketAdmissionCode =
  | "CODEX_SHARED_SOCKET_NOT_FOUND"
  | "CODEX_SHARED_SOCKET_ACCESS_DENIED"
  | "CODEX_SHARED_SOCKET_ALIAS_UNSUPPORTED"
  | "CODEX_SHARED_SOCKET_INVALID_TARGET"
  | "CODEX_SHARED_SOCKET_CHECK_FAILED";

export class CodexSocketAdmissionError extends Error {
  constructor(
    readonly code: CodexSocketAdmissionCode,
    readonly phase: "path" | "lstat" | "realpath",
    readonly errno?: "ENOENT" | "EPERM" | "EACCES",
  ) {
    super(code);
    this.name = "CodexSocketAdmissionError";
  }
}

function socketMetadataError(
  error: unknown,
  phase: "lstat" | "realpath",
): CodexSocketAdmissionError {
  const errno =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (errno === "ENOENT")
    return new CodexSocketAdmissionError(
      "CODEX_SHARED_SOCKET_NOT_FOUND",
      phase,
      errno,
    );
  if (errno === "EPERM" || errno === "EACCES")
    return new CodexSocketAdmissionError(
      "CODEX_SHARED_SOCKET_ACCESS_DENIED",
      phase,
      errno,
    );
  return new CodexSocketAdmissionError(
    "CODEX_SHARED_SOCKET_CHECK_FAILED",
    phase,
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validSocketPath(value: string): boolean {
  return path.isAbsolute(value) && value !== "/" && !value.includes("\0");
}

/** Attach to an already-running Codex-owned control socket; never start a daemon. */
export async function existingCodexSocket(socketPath: string): Promise<string> {
  if (!validSocketPath(socketPath))
    throw new CodexSocketAdmissionError(
      "CODEX_SHARED_SOCKET_INVALID_TARGET",
      "path",
    );
  const info = await fs.lstat(socketPath).catch((error: unknown) => {
    throw socketMetadataError(error, "lstat");
  });
  if (info.isSymbolicLink())
    throw new CodexSocketAdmissionError(
      "CODEX_SHARED_SOCKET_ALIAS_UNSUPPORTED",
      "lstat",
    );
  if (
    !info.isSocket() ||
    (process.getuid?.() !== undefined && info.uid !== process.getuid())
  )
    throw new CodexSocketAdmissionError(
      "CODEX_SHARED_SOCKET_INVALID_TARGET",
      "lstat",
    );
  const canonical = await fs.realpath(socketPath).catch((error: unknown) => {
    throw socketMetadataError(error, "realpath");
  });
  if (canonical !== socketPath)
    throw new CodexSocketAdmissionError(
      "CODEX_SHARED_SOCKET_INVALID_TARGET",
      "realpath",
    );
  return socketPath;
}

async function existingPrivateScratch(root: string): Promise<string> {
  if (!path.isAbsolute(root) || root === "/" || root.includes("\0")) {
    throw unavailable();
  }
  const info = await fs.lstat(root).catch(() => null);
  if (
    !info?.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && info.uid !== process.getuid()) ||
    (await fs.realpath(root).catch(() => null)) !== root
  ) {
    throw unavailable();
  }
  return root;
}

/** A single proxy client lifetime. Connection loss is final for this instance. */
export class SharedCodexProxyHost implements HandoffHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly catalogueClientId = randomUUID();
  private catalogueEpoch = 0;

  modelCatalogueScope(): string {
    return `${this.catalogueClientId}:${this.catalogueEpoch}:${this.lost ? "lost" : "connected"}`;
  }
  private transport: CodexProxyWebSocket | null = null;
  private initializing = false;
  private ready: Promise<void> | null = null;
  private lost = false;
  private signalFailed = false;
  private escalationAttempted = false;
  private terminal: CodexProxyDiagnostic | null = null;

  terminalDiagnostic(): CodexProxyDiagnostic | null {
    return this.terminal;
  }

  private diagnostic(
    method: string,
    result: CodexProxyFailureResult,
    rpcCode?: number,
  ): CodexProxyDiagnostic {
    return Object.freeze({
      phase: method === "initialize" ? "initialize" : "request",
      method,
      result,
      ...(rpcCode === undefined ? {} : { rpcCode }),
    });
  }

  constructor(
    private readonly launch: Launch,
    private readonly expectedCodexHome: string,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    if (
      !path.isAbsolute(expectedCodexHome) ||
      expectedCodexHome.includes("\0") ||
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > REQUEST_TIMEOUT_MS
    ) {
      throw unavailable();
    }
  }

  static async attach(
    input: Readonly<{
      executablePath: string;
      executableSha256: string;
      socketPath: string;
      cwd: string;
      expectedCodexHome: string;
    }>,
  ): Promise<SharedCodexProxyHost> {
    if (
      !path.isAbsolute(input.executablePath) ||
      !path.isAbsolute(input.cwd) ||
      !/^[a-f0-9]{64}$/u.test(input.executableSha256) ||
      input.executablePath.includes("\0") ||
      input.cwd.includes("\0")
    ) {
      throw unavailable();
    }
    const executable = await fs.lstat(input.executablePath).catch(() => null);
    if (
      !executable?.isFile() ||
      executable.isSymbolicLink() ||
      (executable.mode & 0o111) === 0 ||
      (executable.mode & 0o022) !== 0 ||
      (process.getuid?.() !== undefined &&
        executable.uid !== process.getuid() &&
        executable.uid !== 0) ||
      (await fs.realpath(input.executablePath).catch(() => null)) !==
        input.executablePath
    ) {
      throw unavailable();
    }
    const digest = createHash("sha256");
    try {
      for await (const chunk of createReadStream(input.executablePath)) {
        digest.update(chunk);
      }
    } catch {
      throw unavailable();
    }
    if (digest.digest("hex") !== input.executableSha256) throw unavailable();
    const socketPath = await existingCodexSocket(input.socketPath);
    const scratch = await existingPrivateScratch(input.cwd);
    // The caller supplies a previously attested canonical CLI path. A proxy
    // forwards bytes to the selected socket; it does not own server lifetime.
    const host = new SharedCodexProxyHost(
      () =>
        spawn(
          input.executablePath,
          ["app-server", "proxy", "--sock", socketPath],
          {
            cwd: scratch,
            env: {
              HOME: scratch,
              PATH: SAFE_PATH,
              NO_COLOR: "1",
              TERM: "dumb",
            },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        ),
      input.expectedCodexHome,
    );
    try {
      await host.connect();
    } catch (error) {
      if (!(await host.closeAndWait()))
        throw new Error("CODEX_PROXY_CLEANUP_UNVERIFIED");
      throw error;
    }
    return host;
  }

  async connect(): Promise<void> {
    if (this.lost)
      throw new CodexProxyFailure(
        this.terminal ?? { phase: "idle", method: "none", result: "closed" },
      );
    if (this.ready) return this.ready;
    this.initializing = true;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch();
    } catch {
      const diagnostic = this.diagnostic("initialize", "launch_failed");
      this.fail("launch_failed", diagnostic);
      throw new CodexProxyFailure(diagnostic);
    }
    this.child = child;
    child.stdin.on("error", () => this.fail("pipe_failed"));
    child.stdout.on("error", () => this.fail("pipe_failed"));
    child.stderr.on("error", () => this.fail("pipe_failed"));
    child.stderr.on("data", () => {
      // Never forward daemon diagnostics or profile data to connector output.
    });
    child.once("error", () => this.fail("launch_failed"));
    child.once("exit", () => this.fail("exited"));
    const timer = setTimeout(
      () => this.fail("timeout", this.diagnostic("initialize", "timeout")),
      this.requestTimeoutMs,
    );
    timer.unref?.();
    this.transport = new CodexProxyWebSocket(
      child,
      MAX_FRAME_BYTES,
      MAX_FRAME_BYTES * MAX_PENDING,
      (message) => this.receive(message),
      (failure) => this.fail(failure),
    );
    this.ready = this.transport.opened
      .then(() =>
        this.send("initialize", {
          clientInfo: { name: "farol-shared-handoff", version: "1" },
          capabilities: { experimentalApi: true },
        }),
      )
      .then(async (result) => {
        const response = object(result);
        if (
          response?.codexHome !== this.expectedCodexHome ||
          response.platformFamily !== "unix" ||
          response.platformOs !== "macos" ||
          typeof response.userAgent !== "string"
        ) {
          throw new CodexProxyFailure(
            this.diagnostic("initialize", "invalid_identity"),
          );
        }
        if (this.lost || !this.child?.stdin.writable) throw unavailable();
        await this.transport!.send(
          JSON.stringify({ method: "initialized", params: {} }),
        );
        if (this.lost) throw new CodexProxyFailure(this.terminal!);
        this.initializing = false;
      })
      .catch((error: unknown) => {
        const diagnostic =
          this.terminal ??
          (error instanceof CodexProxyFailure
            ? error.diagnostic
            : this.diagnostic("initialize", "invalid_protocol"));
        this.fail(diagnostic.result, diagnostic);
        throw new CodexProxyFailure(diagnostic);
      })
      .finally(() => clearTimeout(timer));
    return this.ready;
  }

  async request(
    method: string,
    params: unknown,
    deadlineAt?: number,
  ): Promise<unknown> {
    if (!METHODS.has(method)) throw new Error("CODEX_SHARED_METHOD_DENIED");
    try {
      await this.connect();
    } catch (error) {
      // This request has not reached send(); no steer frame exists. Errors
      // after send() keep their original unknown-submission classification.
      if (error instanceof CodexProxyFailure)
        throw new CodexProxyNotSubmittedFailure(error.diagnostic);
      throw new HandoffNotSubmittedError("CODEX_SHARED_HOST_UNAVAILABLE");
    }
    // Capacity is checked synchronously before send() can write a frame.
    // Never classify a rejection from an already pending request this way.
    if (this.pending.size >= MAX_PENDING)
      throw new HandoffNotSubmittedError("CODEX_SHARED_HOST_BUSY");
    // This request has not reached send(); deadline expiry cannot have
    // submitted a steer frame. Failures after send() remain outcome-unknown.
    if (deadlineAt !== undefined && Date.now() >= deadlineAt)
      throw new HandoffNotSubmittedError("CODEX_SHARED_DEADLINE_EXPIRED");
    return this.send(method, params);
  }

  close(): void {
    this.fail("closed");
  }

  async closeAndWait(): Promise<boolean> {
    const child = this.child;
    if (!child) {
      this.fail("closed");
      return true;
    }
    const exited = (timeoutMs: number): Promise<boolean> => {
      if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("exit", onExit);
          child.off("error", onError);
          resolve(value);
        };
        const onExit = () => finish(true);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", onExit);
        child.once("error", onError);
      });
    };
    const first = exited(1_500);
    this.fail("closed");
    if (await first) return true;
    if (this.signalFailed) return false;
    if (!this.escalationAttempted) {
      this.escalationAttempted = true;
      this.signalProxy("SIGKILL");
    }
    return exited(1_000);
  }

  private fail(
    result: CodexProxyFailureResult,
    diagnostic?: CodexProxyDiagnostic,
  ): void {
    if (this.lost) return;
    this.lost = true;
    const first = this.pending.values().next().value as Pending | undefined;
    this.terminal =
      diagnostic ??
      (this.initializing
        ? this.diagnostic("initialize", result)
        : this.pending.size === 1 && first
          ? this.diagnostic(first.method, result)
          : Object.freeze({
              phase: this.pending.size > 1 ? "request" : "idle",
              method: this.pending.size > 1 ? "multiple" : "none",
              result,
            }));
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new CodexProxyFailure(this.diagnostic(request.method, result)),
      );
    }
    this.pending.clear();
    this.transport?.close();
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.signalProxy("SIGTERM");
  }

  private signalProxy(signal: "SIGTERM" | "SIGKILL"): void {
    const child = this.child;
    if (
      this.signalFailed ||
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    try {
      // Delivery is not exit proof. A refusal is final for this instance;
      // later cleanup reads may only observe an independently completed exit.
      if (!child.kill(signal)) this.signalFailed = true;
    } catch {
      this.signalFailed = true;
    }
  }

  private send(method: string, params: unknown): Promise<unknown> {
    if (
      this.lost ||
      !this.child?.stdin.writable ||
      this.pending.size >= MAX_PENDING
    ) {
      return Promise.reject(unavailable());
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(new Error("CODEX_SHARED_REQUEST_TOO_LARGE"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail("timeout", this.diagnostic(method, "timeout")),
        this.requestTimeoutMs,
      );
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      void this.transport!.send(frame).catch(() => this.fail("pipe_failed"));
    });
  }

  private receive(message: Buffer): void {
    if (this.lost) return;
    if (message.length > MAX_FRAME_BYTES) {
      this.fail("invalid_protocol");
      return;
    }
    let value: Record<string, unknown> | null;
    try {
      value = object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            message,
          ),
        ),
      );
    } catch {
      this.fail("invalid_protocol");
      return;
    }
    if (!value) {
      this.fail("invalid_protocol");
      return;
    }
    if (Object.hasOwn(value, "id") && Object.hasOwn(value, "method")) {
      if (
        (typeof value.id !== "string" &&
          !(typeof value.id === "number" && Number.isSafeInteger(value.id))) ||
        typeof value.method !== "string" ||
        Object.hasOwn(value, "result") ||
        Object.hasOwn(value, "error")
      ) {
        this.fail("invalid_protocol");
        return;
      }
      // This client has no request ownership or owner decision route. An
      // error reply could settle another client's consent prompt. Leave
      // these exact methods unanswered, without retaining/disclosing params.
      if (UNQUALIFIED_CONSENT_METHODS.has(value.method)) return;
      // Other requests are unsupported. Preserve the exact ID without
      // coercion, admission, payload disclosure or implicit approval.
      const frame = JSON.stringify({
        id: value.id,
        error: { code: -32601, message: "Method not available" },
      });
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        this.fail("invalid_protocol");
        return;
      }
      void this.transport?.send(frame).catch(() => this.fail("pipe_failed"));
      return;
    }
    if (value.id === undefined) {
      // A local cache epoch, not a claim that initialize identifies an account.
      // No auth payload is retained. Reconnect constructs a new client ID.
      if (
        value.method === "account/updated" ||
        value.method === "account/login/completed"
      )
        this.catalogueEpoch++;
      return;
    }
    if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) {
      this.fail("invalid_protocol");
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) {
      this.fail("invalid_protocol");
      return;
    }
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if ("error" in value) {
      const code = object(value.error)?.code;
      if (typeof code !== "number" || !Number.isSafeInteger(code)) {
        pending.reject(
          new CodexProxyFailure(
            this.diagnostic(pending.method, "invalid_protocol"),
          ),
        );
        return;
      }
      pending.reject(
        new CodexProxyFailure(
          this.diagnostic(pending.method, "rpc_error", code),
        ),
      );
    } else if (!("result" in value)) {
      pending.reject(
        new CodexProxyFailure(
          this.diagnostic(pending.method, "invalid_protocol"),
        ),
      );
      return;
    } else pending.resolve(value.result);
  }
}

// Saved ServerRequest contract: exact variants only, never a method-prefix gate.
// Auth refresh, tool execution and unrelated requests are not consent prompts.
const UNQUALIFIED_CONSENT_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "execCommandApproval",
  "applyPatchApproval",
]);
