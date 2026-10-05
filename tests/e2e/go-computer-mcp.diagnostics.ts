// Test-side only. Injected child streams and persistence; importing never spawns.
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type RecordValue = { [key: string]: JSONValue };
function object(value: unknown): RecordValue {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "MCP_INVALID_OUTPUT",
  );
  return value as RecordValue;
}
// Keep reply limits unchanged. Host close composes 6s connector + 16s prepare +
// 1s ACK + 2s exact child drain, with a finite 5s allowance for pump/persistence.
export const BUDGETS = Object.freeze({
  initialize: 8000,
  request: 8000,
  mcpCleanup: 8000,
  hostCleanup: 30000,
  persistence: 3000,
});
const codes = new Set([
  "MCP_REPLY_UNKNOWN",
  "MCP_CHILD_CLOSED",
  "MCP_CLEANUP_UNCONFIRMED",
  "MCP_STARTUP_TERMINAL_UNKNOWN",
  "MCP_TERMINAL_UNKNOWN",
  "MCP_INVALID_OUTPUT",
  "MCP_FRAME_LIMIT",
  "MCP_STDERR_LIMIT",
  "MCP_CROSSED_RESPONSE",
  "UNEXPECTED_MCP_NOTIFICATION",
  "MCP_STDIN_WRITE_FAILED",
  "MCP_PROTOCOL_ERROR",
  "HOST_STARTUP_UNKNOWN",
  "HOST_OPEN_UNKNOWN",
  "HOST_WITHDRAW_UNKNOWN",
  "HOST_CLEANUP_UNCONFIRMED",
  "WITNESS_PERSISTENCE_UNCONFIRMED",
  "WITNESS_PHASE_UNKNOWN",
  "SETTINGS_UNAVAILABLE",
  "PROVIDER_FORBIDDEN",
  "core_retirement_prepare_unconfirmed",
  "core_retirement_publication_crossed",
  "core_retirement_browser_unconfirmed",
  "core_retirement_settings_unconfirmed",
  "core_retirement_ack_unconfirmed",
  "core_retirement_ack_crossed",
  "backend_cleanup_unconfirmed",
  "profile_cleanup_unconfirmed",
]);
export function diagnosticCode(error: unknown): string {
  // Never serialize arbitrary error messages, assertion values, payloads or paths.
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    for (const candidate of [value.code, value.message])
      if (typeof candidate === "string" && codes.has(candidate))
        return candidate;
    if (value.code === "ERR_ASSERTION") return "WITNESS_ASSERTION_FAILED";
  }
  return "WITNESS_FAILURE_REDACTED";
}
export async function bounded<T>(
  promise: Promise<T>,
  code: string,
  ms: number,
): Promise<T> {
  assert.ok(Number.isFinite(ms) && ms > 0);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type RequestObservation = {
  id: number;
  method: string;
  tool?: string;
  startedAt: number;
  deadline: number;
  elapsedMillis: number;
  state: string;
  stdinWrite: string;
  response: string;
  code?: string;
};
export class WitnessDiagnostics {
  private tail = Promise.resolve();
  private persistenceFailure: unknown;
  readonly checkpoints: Record<string, unknown>[] = [];
  constructor(
    readonly report: Record<string, unknown>,
    private readonly persist: (serialized: string) => Promise<void>,
    readonly now: () => number = Date.now,
  ) {
    report.checkpoints = this.checkpoints;
    report.budgets = BUDGETS;
  }
  record(phase: string, facts: Record<string, unknown> = {}) {
    this.checkpoints.push({ phase, at: this.now(), ...facts });
    assert.ok(this.checkpoints.length <= 512, "WITNESS_DIAGNOSTIC_LIMIT");
    const serialized = JSON.stringify(this.report, null, 2) + "\n";
    this.tail = this.tail.then(async () => {
      if (this.persistenceFailure) return;
      try {
        await bounded(
          this.persist(serialized),
          "WITNESS_PERSISTENCE_UNCONFIRMED",
          BUDGETS.persistence,
        );
      } catch (error) {
        this.persistenceFailure = error;
        this.report.persistenceError = diagnosticCode(error);
      }
    });
  }
  async checkpoint(phase: string, facts: Record<string, unknown> = {}) {
    this.record(phase, facts);
    // This flush also has a finite budget; it cannot block the native lane forever.
    await bounded(
      this.tail,
      "WITNESS_PERSISTENCE_UNCONFIRMED",
      BUDGETS.persistence,
    );
    if (this.persistenceFailure) throw this.persistenceFailure;
  }
  async stage<T>(
    phase: string,
    ms: number,
    code: string,
    action: () => Promise<T>,
    ownedCleanup = false,
  ): Promise<T> {
    const startedAt = this.now();
    let deadline = startedAt + ms;
    try {
      await this.checkpoint(phase + "-before", {
        startedAt,
        deadline,
        elapsedMillis: 0,
      });
    } catch (error) {
      this.report.persistenceError = diagnosticCode(error);
      if (!ownedCleanup) throw error;
    }
    // Evidence failure can refuse a new effect, never the one-shot cleanup of
    // an already-owned resource. Persistence has its own finite budget.
    if (ownedCleanup) deadline = this.now() + ms;
    try {
      if (this.now() >= deadline) throw new Error(code);
      const result = await bounded(
        Promise.resolve().then(action),
        code,
        Math.max(1, deadline - this.now()),
      );
      try {
        await this.checkpoint(phase + "-after", {
          deadline,
          elapsedMillis: this.now() - startedAt,
          state: "returned",
        });
      } catch (error) {
        this.report.persistenceError = diagnosticCode(error);
        if (!ownedCleanup) throw error;
      }
      return result;
    } catch (error) {
      try {
        await this.checkpoint(phase + "-failed", {
          deadline,
          elapsedMillis: this.now() - startedAt,
          code: diagnosticCode(error),
        });
      } catch (persistence) {
        this.report.persistenceError = diagnosticCode(persistence);
      }
      throw error;
    }
  }
}

// A bounded test client speaks ordinary legacy MCP JSON-RPC lines. It owns one
// exact child and ends stdin once. No SDK negotiation sibling, signals, numeric
// process lookup, automatic restart or TERM/KILL escalation is used.
export class Peer {
  readonly terminal: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private buffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private stderr = Buffer.alloc(0);
  private closed = false;
  private sequence = 0;
  private stopped: Promise<void> | undefined;
  private failure: Error | undefined;
  readonly requests: RequestObservation[] = [];
  terminalFacts:
    { code: number | null; signal: NodeJS.Signals | null } | undefined;
  snapshot() {
    return {
      pid: this.child.pid,
      requests: this.requests,
      terminal: this.terminalFacts ?? { state: "unknown" },
    };
  }
  private readonly pending = new Map<
    number,
    { resolve(value: RecordValue): void; reject(error: Error): void }
  >();
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly diagnostics: WitnessDiagnostics,
  ) {
    this.terminal = new Promise((resolve) =>
      this.child.once("close", (code, signal) => {
        this.closed = true;
        this.terminalFacts = { code, signal };
        this.diagnostics.record("mcp-child-terminal");
        for (const waiter of this.pending.values())
          waiter.reject(new Error("MCP_CHILD_CLOSED"));
        this.pending.clear();
        resolve({ code, signal });
      }),
    );
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 65536) this.fail(new Error("MCP_STDERR_LIMIT"));
      else this.stderr = Buffer.concat([this.stderr, chunk]);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        assert.ok(
          this.buffer.length + chunk.length <= 2 * 1024 * 1024,
          "MCP_FRAME_LIMIT",
        );
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
          const end = this.buffer.indexOf(10);
          if (end < 0) break;
          const message = object(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                this.buffer.subarray(0, end),
              ),
            ),
          );
          this.buffer = this.buffer.subarray(end + 1);
          assert.equal(message.jsonrpc, "2.0");
          assert.equal(
            typeof message.id,
            "number",
            "UNEXPECTED_MCP_NOTIFICATION",
          );
          const waiter = this.pending.get(message.id as number);
          assert.ok(waiter, "MCP_CROSSED_RESPONSE");
          this.pending.delete(message.id as number);
          waiter.resolve(message);
        }
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error("MCP_INVALID_OUTPUT"),
        );
      }
    });
  }
  private fail(error: Error) {
    if (!this.failure) {
      this.failure = error;
      this.diagnostics.record("mcp-transport-failure", {
        code: diagnosticCode(error),
      });
    }
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  async request(method: string, params: RecordValue): Promise<RecordValue> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("MCP_CHILD_CLOSED");
    assert.ok(!this.stopped);
    const id = ++this.sequence;
    const startedAt = this.diagnostics.now();
    const ms = method === "initialize" ? BUDGETS.initialize : BUDGETS.request;
    const observation: RequestObservation = {
      id,
      method,
      ...(method === "tools/call" && typeof params.name === "string"
        ? { tool: params.name }
        : {}),
      startedAt,
      deadline: startedAt + ms,
      elapsedMillis: 0,
      state: "prepared",
      stdinWrite: "not-submitted",
      response: "unobserved",
    };
    this.requests.push(observation);
    const response = new Promise<RecordValue>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    // Attach the rejection handler before persistence or write can fail.
    const reply = bounded(response, "MCP_REPLY_UNKNOWN", ms);
    void reply.catch(() => undefined);
    try {
      await this.diagnostics.checkpoint("mcp-request-before");
      if (
        this.failure ||
        this.closed ||
        this.diagnostics.now() >= observation.deadline
      )
        throw this.failure ?? new Error("MCP_REPLY_UNKNOWN");
      observation.state = "submitted-outcome-unknown";
      observation.stdinWrite = "callback-pending";
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        (error) => {
          observation.stdinWrite = error ? "callback-error" : "callback-ok";
          observation.elapsedMillis = this.diagnostics.now() - startedAt;
          this.diagnostics.record("mcp-stdin-write-callback");
          if (error) this.fail(new Error("MCP_STDIN_WRITE_FAILED"));
        },
      );
      this.diagnostics.record("mcp-request-submitted");
      const result = await reply;
      observation.response =
        result.error === undefined
          ? object(result.result).isError === true
            ? "tool-error"
            : "result"
          : "protocol-error";
      observation.state = "response";
      assert.equal(result.error, undefined, "MCP_PROTOCOL_ERROR");
      return object(result.result);
    } catch (error) {
      observation.state = "failed-outcome-unknown";
      observation.code = diagnosticCode(error);
      this.fail(
        error instanceof Error ? error : new Error("MCP_INVALID_OUTPUT"),
      );
      throw error;
    } finally {
      this.pending.get(id)?.reject(new Error("MCP_REPLY_UNKNOWN"));
      this.pending.delete(id);
      observation.elapsedMillis = this.diagnostics.now() - startedAt;
      try {
        await this.diagnostics.checkpoint("mcp-request-after");
      } catch (error) {
        if (observation.code)
          this.diagnostics.report.persistenceError = diagnosticCode(error);
        else throw error;
      }
    }
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "farol-go-native-fixture", version: "1" },
    });
    assert.equal(result.protocolVersion, "2025-06-18");
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
  }
  async call(name: string, args: RecordValue, error = false) {
    const result = await this.request("tools/call", { name, arguments: args });
    assert.equal(result.isError === true, error, name);
    return object(result.structuredContent);
  }
  close(expectedCode = 0): Promise<void> {
    this.stopped ??= (async () => {
      try {
        await this.diagnostics.checkpoint("mcp-close-before");
      } catch (error) {
        this.diagnostics.report.persistenceError = diagnosticCode(error);
      }
      try {
        this.child.stdin.end();
        assert.deepEqual(
          await bounded(
            this.terminal,
            "MCP_CLEANUP_UNCONFIRMED",
            BUDGETS.mcpCleanup,
          ),
          { code: expectedCode, signal: null },
        );
        assert.equal(this.buffer.length, 0, "MCP_TRUNCATED_OUTPUT");
        if (this.failure) throw this.failure;
      } catch (error) {
        this.diagnostics.record("mcp-close-failed", {
          code: diagnosticCode(error),
        });
        throw error;
      } finally {
        try {
          await this.diagnostics.checkpoint("mcp-close-after");
        } catch (error) {
          this.diagnostics.report.persistenceError = diagnosticCode(error);
        }
      }
    })();
    return this.stopped;
  }
  async requireStartupFailure(): Promise<void> {
    // Observe spontaneous failure before any request or EOF can cause it.
    // Timeout and protocol failure never count as backend-refusal evidence.
    assert.equal(this.sequence, 0);
    assert.equal(this.child.stdin.writableEnded, false);
    assert.deepEqual(
      await bounded(
        this.terminal,
        "MCP_STARTUP_TERMINAL_UNKNOWN",
        BUDGETS.initialize,
      ),
      { code: 1, signal: null },
    );
    assert.equal(this.buffer.length, 0);
    assert.equal(
      this.stderr.toString("utf8"),
      "Farol Next Computer MCP failed to start.\n",
    );
    if (this.failure) throw this.failure;
  }
}
