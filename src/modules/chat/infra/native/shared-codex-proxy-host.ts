import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

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
  "project/list",
  "thread/start",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "turn/start",
  "turn/steer",
]);

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type Launch = () => ChildProcessWithoutNullStreams;

function unavailable(): Error {
  return new Error("CODEX_SHARED_HOST_UNAVAILABLE");
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
  if (!validSocketPath(socketPath)) throw unavailable();
  const info = await fs.lstat(socketPath).catch(() => null);
  if (
    !info?.isSocket() ||
    info.isSymbolicLink() ||
    (process.getuid?.() !== undefined && info.uid !== process.getuid()) ||
    (await fs.realpath(socketPath).catch(() => null)) !== socketPath
  ) {
    throw unavailable();
  }
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
  private received = Buffer.alloc(0);
  private ready: Promise<void> | null = null;
  private lost = false;

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
    if (this.lost) throw unavailable();
    if (this.ready) return this.ready;
    const child = this.launch();
    this.child = child;
    child.stdin.on("error", () => this.fail());
    child.stdout.on("error", () => this.fail());
    child.stderr.on("error", () => this.fail());
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", () => {
      // Never forward daemon diagnostics or profile data to connector output.
    });
    child.once("error", () => this.fail());
    child.once("exit", () => this.fail());
    this.ready = this.send("initialize", {
      clientInfo: { name: "farol-shared-handoff", version: "1" },
    })
      .then((result) => {
        const response = object(result);
        if (
          response?.codexHome !== this.expectedCodexHome ||
          response.platformFamily !== "unix" ||
          response.platformOs !== "macos" ||
          typeof response.userAgent !== "string"
        ) {
          throw unavailable();
        }
        if (this.lost || !this.child?.stdin.writable) throw unavailable();
        this.child.stdin.write(
          `${JSON.stringify({ method: "initialized", params: {} })}\n`,
          (error) => {
            if (error) this.fail();
          },
        );
      })
      .catch((error: unknown) => {
        this.fail();
        throw error;
      });
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
    } catch {
      // This request has not reached send(); no steer frame exists. Errors
      // after send() keep their original unknown-submission classification.
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
    this.fail();
  }

  async closeAndWait(): Promise<boolean> {
    const child = this.child;
    if (!child) {
      this.fail();
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
    this.fail();
    if (await first) return true;
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    return exited(1_000);
  }

  private fail(): void {
    if (this.lost) return;
    this.lost = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(unavailable());
    }
    this.pending.clear();
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
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
    const frame = `${JSON.stringify({ id, method, params })}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(new Error("CODEX_SHARED_REQUEST_TOO_LARGE"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(frame, (error) => {
        if (error) this.fail();
      });
    });
  }

  private receive(chunk: Buffer): void {
    if (this.lost) return;
    this.received = Buffer.concat([this.received, chunk]);
    if (this.received.length > MAX_FRAME_BYTES) {
      this.fail();
      return;
    }
    for (;;) {
      const end = this.received.indexOf(0x0a);
      if (end < 0) return;
      const line = this.received.subarray(0, end).toString("utf8");
      this.received = this.received.subarray(end + 1);
      let value: Record<string, unknown> | null;
      try {
        value = object(JSON.parse(line));
      } catch {
        this.fail();
        return;
      }
      if (!value) {
        this.fail();
        return;
      }
      if (typeof value.id === "number" && typeof value.method === "string") {
        // A server request may be an approval. Never approve it implicitly.
        this.child?.stdin.write(
          `${JSON.stringify({ id: value.id, error: { code: -32601, message: "Method not available" } })}\n`,
          (error) => {
            if (error) this.fail();
          },
        );
        continue;
      }
      if (value.id === undefined) continue; // provider notification
      if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) {
        this.fail();
        return;
      }
      const pending = this.pending.get(value.id);
      if (!pending) {
        this.fail();
        return;
      }
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if ("error" in value || !("result" in value))
        pending.reject(unavailable());
      else pending.resolve(value.result);
    }
  }
}
