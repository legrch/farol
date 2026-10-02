import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Decoder, frame } from "./frame.ts";
import {
  protocolMajor,
  protocolMinor,
  validate,
  type Context,
  type EventData,
  type Handshake,
  type Identity,
  type Json,
  type Outcome,
  type Request,
  type Response,
} from "./wire.ts";

export class BridgeError extends Error {
  constructor(
    readonly state: "unavailable" | "unknown" | "refused" | "unsupported",
    readonly code: string,
  ) {
    super(code);
  }
}
type Pending = {
  resolve: (outcome: Outcome) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  operationId?: string;
  handshake?: Handshake;
};

// Trusted Electron host only. No renderer IPC, endpoint discovery or automatic restart.
export class Client {
  private decoder = new Decoder();
  private pending = new Map<string, Pending>();
  private used = new Set<string>();
  private stopped = false;
  private context: Context | undefined;
  private identity: Identity | undefined;
  private connecting = false;
  private sequences = new Map<string, bigint>();
  private stale = new Set<string>();
  private listeners = new Set<(event: EventData, stale: boolean) => void>();
  private diagnosticBytes = 0;
  private writerBusy = false;
  private childClosed = false;
  private cleanupPromise: Promise<void> | undefined;
  private cleanup: "none" | "pending" | "confirmed" | "unknown" = "none";
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private owned = false,
  ) {
    child.stdout.on("data", (data: Buffer) => {
      try {
        this.decoder.push(data, (value) => this.receive(value));
      } catch {
        this.fail("protocol_violation");
      }
    });
    child.stdout.on("end", () => {
      try {
        this.decoder.finish();
        this.fail("transport_ended");
      } catch {
        this.fail("truncated_frame");
      }
    });
    child.stdout.on("error", () => this.fail("transport_failed"));
    child.stdin.on("error", () => this.fail("transport_failed"));
    child.stderr.on("data", (data: Buffer) => {
      this.diagnosticBytes = Math.min(
        65536,
        this.diagnosticBytes + data.length,
      );
    });
    child.once("error", () =>
      this.fail(
        "backend_unavailable",
        child.pid === undefined ? "unavailable" : "unknown",
      ),
    );
    child.once("close", () => {
      this.childClosed = true;
      this.fail("backend_unavailable");
    });
  }
  async handshake(expected: Handshake, timeoutMs: number): Promise<Identity> {
    if (this.context || this.identity || this.connecting)
      throw new BridgeError("refused", "already_connected");
    if (!validate("Handshake", expected))
      throw new BridgeError("refused", "invalid_handshake");
    const hello = Object.freeze({ ...expected });
    this.connecting = true;
    try {
      await this.send(
        "core.handshake",
        hello as unknown as Json,
        randomUUID(),
        timeoutMs,
        undefined,
        hello,
      );
      if (this.stopped || !this.identity)
        throw new BridgeError("unknown", "backend_unavailable");
      return this.identity;
    } finally {
      this.connecting = false;
    }
  }

  request(
    method: string,
    body: Json,
    options: { id?: string; operationId?: string; timeoutMs?: number } = {},
  ): Promise<Outcome> {
    if (!this.context)
      return Promise.reject(
        new BridgeError("unavailable", "handshake_required"),
      );
    return this.send(
      method,
      body,
      options.id ?? randomUUID(),
      options.timeoutMs ?? 2000,
      options.operationId,
    );
  }
  subscribe(listener: (event: EventData, stale: boolean) => void): () => void {
    if (this.listeners.size >= 32)
      throw new BridgeError("unavailable", "observer_budget");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  get cleanupState(): "none" | "pending" | "confirmed" | "unknown" {
    return this.cleanup;
  }
  get diagnosticByteCount(): number {
    return this.diagnosticBytes;
  }
  private send(
    method: string,
    body: Json,
    id: string,
    timeoutMs: number,
    operationId?: string,
    handshake?: Handshake,
  ): Promise<Outcome> {
    if (this.stopped)
      return Promise.reject(
        new BridgeError("unavailable", "backend_unavailable"),
      );
    if (this.pending.size >= 32 || this.writerBusy || this.used.size >= 4096)
      return Promise.reject(new BridgeError("unavailable", "backpressure"));
    if (this.used.has(id))
      return Promise.reject(new BridgeError("refused", "duplicate_request_id"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
      return Promise.reject(new BridgeError("refused", "invalid_deadline"));
    const params = {
      body,
      ...(this.context ? { context: this.context } : {}),
      ...(operationId !== undefined ? { operationId } : {}),
    };
    const request: Request = { jsonrpc: "2.0", id, method, params };
    if (!validate("Request", request))
      return Promise.reject(new BridgeError("refused", "invalid_request"));
    let bytes: Buffer;
    try {
      bytes = frame(request);
    } catch {
      return Promise.reject(new BridgeError("refused", "oversized_request"));
    }
    this.used.add(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("unknown", "response_timeout"));
        this.fail("response_timeout");
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(operationId !== undefined ? { operationId } : {}),
        ...(handshake ? { handshake } : {}),
      });
      try {
        if (!this.child.stdin.write(bytes)) {
          this.writerBusy = true;
          this.child.stdin.once("drain", () => {
            this.writerBusy = false;
          });
        }
      } catch {
        this.fail("transport_failed");
      }
    });
  }
  private receive(value: unknown): void {
    if (this.stopped) return;
    if (validate("Event", value)) {
      const event = (value as { params: EventData }).params;
      if (
        !this.context ||
        event.context.profileId !== this.context.profileId ||
        event.context.backendGeneration !== this.context.backendGeneration
      ) {
        this.fail("stale_event_context");
        return;
      }
      if (!this.sequences.has(event.stream) && this.sequences.size >= 64) {
        this.fail("event_stream_budget");
        return;
      }
      const previous = this.sequences.get(event.stream) ?? 0n;
      const sequence = BigInt(event.sequence);
      if (sequence <= previous) {
        this.fail("event_sequence_regression");
        return;
      }
      if (sequence !== previous + 1n || event.kind === "gap")
        this.stale.add(event.stream);
      this.sequences.set(event.stream, sequence);
      for (const listener of this.listeners) {
        try {
          listener(event, this.stale.has(event.stream));
        } catch {
          // A local observer failure cannot invalidate wire data or pending work.
          this.listeners.delete(listener);
        }
      }
      return;
    }
    if (!validate("Response", value)) {
      this.fail("invalid_response");
      return;
    }
    const response = value as Response;
    if (!response.id || !this.pending.has(response.id)) {
      this.fail("crossed_response_id");
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.result) {
      const result = response.result;
      if (
        result.requestId !== response.id ||
        result.operationId !== pending.operationId ||
        (this.context &&
          (result.context.profileId !== this.context.profileId ||
            result.context.backendGeneration !==
              this.context.backendGeneration))
      ) {
        this.fail("crossed_response_context");
        return;
      }
      if (pending.handshake) {
        const expected = pending.handshake;
        let code: string | undefined;
        if (result.status !== "ok" || !validate("Identity", result.data)) {
          code = "invalid_backend_identity";
        } else {
          const identity = result.data as unknown as Identity;
          if (
            identity.protocolMajor !== expected.protocolMajor ||
            identity.protocolMinor < expected.protocolMinor ||
            identity.buildId !== expected.buildId ||
            identity.profileId !== expected.profileId ||
            result.context.backendGeneration !== identity.backendGeneration ||
            result.context.profileId !== identity.profileId
          ) {
            code = "wrong_backend_identity";
          } else {
            // Adopt verified identity before the decoder handles the next frame.
            this.identity = Object.freeze(identity);
            this.context = Object.freeze({ ...result.context });
          }
        }
        if (code) {
          clearTimeout(pending.timer);
          this.pending.delete(response.id);
          pending.reject(new BridgeError("refused", code));
          this.fail(code);
          return;
        }
      }
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(result);
    } else {
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.reject(
        new BridgeError(
          "refused",
          response.error?.message ?? "protocol_refused",
        ),
      );
      if (pending.handshake) this.fail("handshake_refused");
    }
  }
  private fail(
    code: string,
    state: "unknown" | "unavailable" = "unknown",
  ): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError(state, code));
    }
    this.pending.clear();
    // Admission cannot recover this pipe. Cleanup never resubmits work or proves
    // cancellation of a module-owned OS/provider operation.
    void this.terminateOwned().catch(() => {
      /* close() exposes unconfirmed cleanup. */
    });
  }
  private terminateOwned(): Promise<void> {
    if (!this.owned) return Promise.resolve();
    if (this.cleanupPromise) return this.cleanupPromise;
    if (
      this.childClosed ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    ) {
      this.cleanup = "confirmed";
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      return Promise.resolve();
    }
    this.cleanup = "pending";
    this.cleanupPromise = new Promise<void>((resolve, reject) => {
      const kill = setTimeout(() => {
        this.child.kill("SIGKILL");
      }, 1000);
      const deadline = setTimeout(() => {
        clearTimeout(kill);
        this.cleanup = "unknown";
        reject(new BridgeError("unknown", "backend_cleanup_unconfirmed"));
      }, 2000);
      this.child.once("close", () => {
        clearTimeout(kill);
        clearTimeout(deadline);
        this.cleanup = "confirmed";
        resolve();
      });
      this.child.stdin.end();
    });
    return this.cleanupPromise;
  }
  async close(): Promise<void> {
    this.fail("client_closed");
    this.listeners.clear();
    await this.terminateOwned();
  }
}

export async function spawnCore(
  executable: string,
  profileId: string,
  buildId: string,
  timeoutMs = 2000,
): Promise<Client> {
  if (!isAbsolute(executable))
    throw new BridgeError("refused", "executable_path_required");
  const child = spawn(executable, ["serve", "--profile", profileId], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new Client(child, true);
  try {
    await client.handshake(
      { protocolMajor, protocolMinor, buildId, profileId },
      timeoutMs,
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
