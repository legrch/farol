import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  BUDGETS,
  Peer,
  WitnessDiagnostics,
  diagnosticCode,
} from "../e2e/go-computer-mcp.diagnostics.ts";

// Pure injected child streams, clock and in-memory persistence only. No spawn,
// filesystem, Go, Electron, profile, socket, provider or native acceptance proof.
function fixture(writeError?: Error) {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const child = new EventEmitter();
  const wire: string[] = [];
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      wire.push(String(chunk));
      callback(writeError);
    },
  });
  Object.assign(child, { pid: 42, stdin, stdout, stderr });
  const report: Record<string, unknown> = {
    identity: { sourceCommit: "candidate", buildId: "build" },
    harness: {
      sha256: "harness",
      inputs: [{ path: "named-helper", sha256: "digest" }],
    },
  };
  const saved: string[] = [];
  const diagnostics = new WitnessDiagnostics(report, async (serialized) => {
    saved.push(serialized);
  });
  const peer = new Peer(child as ChildProcessWithoutNullStreams, diagnostics);
  Object.defineProperty(report, "requests", {
    enumerable: true,
    get: () => [peer.snapshot()],
  });
  return {
    child,
    stdin,
    stdout,
    stderr,
    wire,
    report,
    saved,
    diagnostics,
    peer,
  };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
afterEach(() => {
  vi.useRealTimers();
});

it("persists identity and prepared request before stdin, then callback and response classification without content", async () => {
  const f = fixture();
  const request = f.peer.request("tools/call", {
    name: "computer_workspace_write",
    arguments: { content: "PRIVATE_SENTINEL" },
  });
  await flush();
  expect(JSON.parse(f.saved[0]!)).toMatchObject({
    identity: f.report.identity,
    harness: f.report.harness,
    requests: [
      {
        requests: [
          {
            id: 1,
            method: "tools/call",
            tool: "computer_workspace_write",
            state: "prepared",
            stdinWrite: "not-submitted",
            startedAt: 1000,
            deadline: 9000,
          },
        ],
      },
    ],
  });
  expect(f.wire).toHaveLength(1);
  f.stdout.write(
    '{"jsonrpc":"2.0","id":1,"result":{"isError":false,"structuredContent":{"content":"PRIVATE_RESPONSE"}}}\n',
  );
  await request;
  await vi.advanceTimersByTimeAsync(0);
  await f.diagnostics.checkpoint("callback-observed");
  expect(f.peer.requests[0]).toMatchObject({
    stdinWrite: "callback-ok",
    response: "result",
    state: "response",
  });
  expect(f.saved.join("\n")).not.toMatch(
    /PRIVATE_SENTINEL|PRIVATE_RESPONSE|arguments|params|structuredContent/,
  );
});

it("retains reply unknown, elapsed deadline, first failure and separate unresolved cleanup", async () => {
  const f = fixture();
  const request = f.peer.request("initialize", {});
  const failed = expect(request).rejects.toThrow("MCP_REPLY_UNKNOWN");
  await vi.advanceTimersByTimeAsync(BUDGETS.initialize);
  await failed;
  f.report.journeyError = "MCP_REPLY_UNKNOWN";
  await f.diagnostics.checkpoint("cleanup-before");
  expect(JSON.parse(f.saved.at(-1)!)).toMatchObject({
    journeyError: "MCP_REPLY_UNKNOWN",
  });
  const close = f.peer.close();
  const cleanup = expect(close).rejects.toThrow("MCP_CLEANUP_UNCONFIRMED");
  await vi.advanceTimersByTimeAsync(BUDGETS.mcpCleanup);
  await cleanup;
  f.report.cleanupError = "MCP_CLEANUP_UNCONFIRMED";
  await f.diagnostics.checkpoint("final");
  expect(f.report.journeyError).toBe("MCP_REPLY_UNKNOWN");
  expect(f.peer.requests[0]).toMatchObject({
    elapsedMillis: 8000,
    deadline: 9000,
    state: "failed-outcome-unknown",
    response: "unobserved",
  });
  expect(f.peer.terminalFacts).toBeUndefined();
  expect(f.wire).toHaveLength(1);
  expect(f.peer.close()).toBe(close);
});

it("classifies write callback error without persisting its secret message or resubmitting", async () => {
  const f = fixture(new Error("PRIVATE_WRITE_ERROR"));
  await expect(f.peer.request("tools/list", {})).rejects.toThrow(
    "MCP_STDIN_WRITE_FAILED",
  );
  expect(f.peer.requests[0]).toMatchObject({
    stdinWrite: "callback-error",
    code: "MCP_STDIN_WRITE_FAILED",
  });
  expect(f.saved.join("\n")).not.toContain("PRIVATE_WRITE_ERROR");
  await expect(f.peer.request("tools/list", {})).rejects.toThrow(
    "MCP_STDIN_WRITE_FAILED",
  );
  expect(f.wire).toHaveLength(1);
});

it.each([
  [
    '"error":{"code":-32603,"message":"PRIVATE_PROTOCOL"}',
    "protocol-error",
    true,
  ],
  ['"result":{"isError":true,"structuredContent":{}}', "tool-error", false],
])(
  "classifies %s while keeping payloads out of checkpoints",
  async (fragment, classification, reject) => {
    const f = fixture();
    const request = f.peer.request("tools/call", {
      name: "computer_workspace_read",
    });
    await flush();
    f.stdout.write(`{"jsonrpc":"2.0","id":1,${fragment}}\n`);
    if (reject) await expect(request).rejects.toThrow();
    else await request;
    expect(f.peer.requests[0]?.response).toBe(classification);
    expect(f.saved.join("\n")).not.toContain("PRIVATE_PROTOCOL");
  },
);

it("memoizes successful close and retains exact child terminal separately from Go", async () => {
  const f = fixture();
  f.report.go = { retirement: "unobserved", terminal: "not-exposed-by-host" };
  const end = vi.spyOn(f.stdin, "end");
  const close = f.peer.close();
  expect(f.peer.close()).toBe(close);
  await flush();
  f.child.emit("close", 0, null);
  await close;
  expect(end).toHaveBeenCalledTimes(1);
  expect(f.peer.terminalFacts).toEqual({ code: 0, signal: null });
  expect(f.report.go).toEqual({
    retirement: "unobserved",
    terminal: "not-exposed-by-host",
  });
  expect(JSON.parse(f.saved.at(-1)!).requests[0].terminal).toEqual({
    code: 0,
    signal: null,
  });
});

it("retains exact nonzero terminal/signal and rejects cleanup instead of counting it as retirement", async () => {
  const f = fixture();
  const close = f.peer.close();
  const failed = expect(close).rejects.toThrow();
  await flush();
  f.child.emit("close", null, "SIGTERM");
  await failed;
  expect(f.peer.terminalFacts).toEqual({ code: null, signal: "SIGTERM" });
  expect(f.peer.close()).toBe(close);
});

it("keeps stdout protocol-only and classifies invalid output without copying stderr", async () => {
  const f = fixture();
  const request = f.peer.request("tools/list", {});
  const failed = expect(request).rejects.toThrow();
  await flush();
  f.stderr.write("PRIVATE_STDERR");
  f.stdout.write("PRIVATE_INVALID_JSON\n");
  await failed;
  expect(f.saved.join("\n")).not.toMatch(/PRIVATE_STDERR|PRIVATE_INVALID_JSON/);
  expect(f.peer.requests[0]?.state).toBe("failed-outcome-unknown");
});

it("makes no stdin submission after persistence fails", async () => {
  const f = fixture();
  const failing = new WitnessDiagnostics({}, async () => {
    throw new Error("PRIVATE_FS_ERROR");
  });
  const peer = new Peer(f.child as ChildProcessWithoutNullStreams, failing);
  await expect(peer.request("initialize", {})).rejects.toThrow(
    "PRIVATE_FS_ERROR",
  );
  expect(f.wire).toEqual([]);
  expect(failing.report.persistenceError).toBe("WITNESS_FAILURE_REDACTED");
});

it("bounds a stuck filesystem fake and does not invoke the risky stage", async () => {
  const f = fixture();
  const action = vi.fn(async () => "effect");
  const diagnostics = new WitnessDiagnostics(
    {},
    async () => new Promise(() => undefined),
  );
  const stage = diagnostics.stage(
    "go-start",
    BUDGETS.initialize,
    "HOST_STARTUP_UNKNOWN",
    action,
  );
  const failed = expect(stage).rejects.toThrow(
    "WITNESS_PERSISTENCE_UNCONFIRMED",
  );
  await vi.advanceTimersByTimeAsync(BUDGETS.persistence);
  await failed;
  expect(action).not.toHaveBeenCalled();
  expect(f.wire).toEqual([]);
});

it("persists finite stage failure without replacing it with a secondary filesystem error", async () => {
  fixture();
  const report: Record<string, unknown> = {};
  let writes = 0;
  const diagnostics = new WitnessDiagnostics(report, async () => {
    if (++writes > 1) throw Error("PRIVATE_FS_ERROR");
  });
  const stage = diagnostics.stage(
    "go-close",
    BUDGETS.hostCleanup,
    "HOST_CLEANUP_UNCONFIRMED",
    async () => new Promise(() => undefined),
  );
  const failed = expect(stage).rejects.toThrow("HOST_CLEANUP_UNCONFIRMED");
  await vi.advanceTimersByTimeAsync(BUDGETS.hostCleanup);
  await failed;
  expect(diagnostics.checkpoints.at(-1)).toMatchObject({
    phase: "go-close-failed",
    deadline: 31000,
    elapsedMillis: 30000,
    code: "HOST_CLEANUP_UNCONFIRMED",
  });
  expect(report.persistenceError).toBe("WITNESS_FAILURE_REDACTED");
});

it("redacts arbitrary exception and assertion content", () => {
  expect(diagnosticCode(new Error("private token"))).toBe(
    "WITNESS_FAILURE_REDACTED",
  );
  expect(
    diagnosticCode({ code: "ERR_ASSERTION", message: "private response" }),
  ).toBe("WITNESS_ASSERTION_FAILED");
  expect(
    diagnosticCode({
      code: "core_retirement_ack_unconfirmed",
      message: "private",
    }),
  ).toBe("core_retirement_ack_unconfirmed");
});

it("does not invoke a risky action when pre-checkpoint persistence consumes its original deadline", async () => {
  fixture();
  let now = 1000;
  const action = vi.fn(async () => "effect");
  const diagnostics = new WitnessDiagnostics(
    {},
    async () => {
      now += BUDGETS.initialize;
    },
    () => now,
  );
  await expect(
    diagnostics.stage(
      "go-start",
      BUDGETS.initialize,
      "HOST_STARTUP_UNKNOWN",
      action,
    ),
  ).rejects.toThrow("HOST_STARTUP_UNKNOWN");
  expect(action).not.toHaveBeenCalled();
  expect(diagnostics.checkpoints.at(-1)).toMatchObject({
    phase: "go-start-failed",
    deadline: 9000,
    elapsedMillis: 8000,
  });
});

it("attempts memoized owned MCP cleanup once when checkpoint persistence fails", async () => {
  const f = fixture();
  const report: Record<string, unknown> = { journeyError: "MCP_REPLY_UNKNOWN" };
  const diagnostics = new WitnessDiagnostics(report, async () => {
    throw Error("PRIVATE_FS_ERROR");
  });
  const peer = new Peer(f.child as ChildProcessWithoutNullStreams, diagnostics);
  const end = vi.spyOn(f.stdin, "end");
  const close = peer.close();
  expect(peer.close()).toBe(close);
  await flush();
  expect(end).toHaveBeenCalledTimes(1);
  f.child.emit("close", 0, null);
  await close;
  expect(peer.close()).toBe(close);
  expect(report.persistenceError).toBe("WITNESS_FAILURE_REDACTED");
  expect(report.journeyError).toBe("MCP_REPLY_UNKNOWN");
});

it("attempts owned host cleanup despite failed evidence and keeps a finite cleanup deadline", async () => {
  fixture();
  const report: Record<string, unknown> = { journeyError: "MCP_REPLY_UNKNOWN" };
  const diagnostics = new WitnessDiagnostics(report, async () => {
    throw Error("PRIVATE_FS_ERROR");
  });
  const close = vi.fn(async () => new Promise<void>(() => undefined));
  const stage = diagnostics.stage(
    "go-close",
    BUDGETS.hostCleanup,
    "HOST_CLEANUP_UNCONFIRMED",
    close,
    true,
  );
  const failed = expect(stage).rejects.toThrow("HOST_CLEANUP_UNCONFIRMED");
  await flush();
  expect(close).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(BUDGETS.hostCleanup);
  await failed;
  expect(report.persistenceError).toBe("WITNESS_FAILURE_REDACTED");
  expect(report.journeyError).toBe("MCP_REPLY_UNKNOWN");
});
