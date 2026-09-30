import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startInstalledUpdateHelper,
  type InstalledUpdateRequest,
} from "../../src/modules/release/infra/native/installed-update-helper.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
const helperPath = path.join(
  process.cwd(),
  "resources/native/update_helper.py",
);
const request: InstalledUpdateRequest = {
  action: "apply",
  operationId: "a".repeat(32),
  source: { digest: "1".repeat(64), version: "0.1.0", buildId: "2".repeat(64) },
  target: { digest: "3".repeat(64), version: "0.1.1", buildId: "4".repeat(64) },
  drain: {
    status: "reconciled",
    acceptedSource: "2".repeat(64),
    acceptedTarget: "4".repeat(64),
  },
  pid: 987654,
  processStart: "Tue Sep 29 23:00:00 2026",
  waitSeconds: 1,
  relaunch: false,
};
const event = () => ({
  schema: "farol.installed-update-handoff/1",
  phase: "waiting_for_exit",
  operationId: request.operationId,
  action: request.action,
  source: request.source,
  target: request.target,
  pid: request.pid,
  processStart: request.processStart,
});

// This fixture models only Node's private pipe transport and lifecycle events.
// Native readiness, marker, digest and immediate normal-exit evidence lives in
// installed-update-helper-readiness.test.mjs.
class Transport extends EventEmitter {
  readonly pid = 765432;
  readonly stdin = new Writable({ write: (_chunk, _encoding, done) => done() });
  readonly stdout = new PassThrough();
  readonly requestPipe = new Writable({
    write: (_chunk, _encoding, done) => done(),
  });
  readonly ack = new PassThrough();
  readonly stdio = [this.stdin, this.stdout, null, this.requestPipe, this.ack];
  readonly unref = vi.fn();
  finish(code: number, phase = "verified"): void {
    this.stdout.end(
      `${JSON.stringify({ phase, operationId: request.operationId })}\n`,
    );
    this.emit("close", code, null);
  }
}
const tick = async (): Promise<void> =>
  await new Promise((resolve) => setImmediate(resolve));
async function launch(
  readinessTimeoutMs = 1000,
  input = request,
  recordSpawn?: (
    operation: import("../../src/modules/release/infra/native/installed-update-helper.js").InstalledUpdateOperation,
  ) => Promise<void>,
) {
  const child = new Transport();
  let seen!: () => void;
  const spawned = new Promise<void>((resolve) => {
    seen = resolve;
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.emit("spawn");
      seen();
    });
    return child as unknown as ChildProcess;
  });
  const pending = startInstalledUpdateHelper(helperPath, input, {
    readinessTimeoutMs,
    ...(recordSpawn ? { recordSpawn } : {}),
  });
  await spawned;
  return { child, pending };
}

describe("installed helper bounded readiness protocol", () => {
  it("persists the spawned identity before sending program/request bytes or awaiting readiness", async () => {
    let persist!: () => void;
    const recordSpawn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          persist = resolve;
        }),
    );
    const { child, pending } = await launch(1000, request, recordSpawn);
    const before = {
      programEnded: child.stdin.writableEnded,
      requestEnded: child.requestPipe.writableEnded,
    };
    const calls = recordSpawn.mock.calls.length;
    persist?.();
    await tick();
    child.ack.end(`${JSON.stringify(event())}\n`);
    const result = await pending;
    child.finish(0);
    await result.operation.completion;
    expect(calls).toBe(1);
    expect(before).toEqual({ programEnded: false, requestEnded: false });
    expect(child.stdin.writableEnded).toBe(true);
    expect(result.status).toBe("ready");
  });

  it.each(["failed", "timed-out"])(
    "never sends after a %s spawned-identity record",
    async (mode) => {
      let release!: () => void;
      const record =
        mode === "failed"
          ? async () => {
              throw new Error("fixture record failure");
            }
          : () =>
              new Promise<void>((resolve) => {
                release = resolve;
              });
      const { child, pending } = await launch(10, request, record);
      const result = await pending;
      release?.();
      await tick();
      child.finish(0);
      await result.operation.completion;
      expect(result).toMatchObject({
        status: "outcome_unknown",
        reason: mode === "failed" ? "spawn_record_failed" : "readiness_timeout",
      });
      expect(child.stdin.destroyed).toBe(true);
      expect(child.requestPipe.destroyed).toBe(true);
      expect(child.stdin.writableEnded).toBe(false);
      expect(child.requestPipe.writableEnded).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["ENOENT", "EACCES", "EPERM"])(
    "reports a confirmed %s before spawn only after close, without writing the request",
    async (code) => {
      const child = new Transport();
      Object.defineProperty(child, "pid", { value: undefined });
      const requestWrite = vi.spyOn(child.requestPipe, "end");
      const programWrite = vi.spyOn(child.stdin, "end");
      let seen!: () => void;
      const observed = new Promise<void>((resolve) => {
        seen = resolve;
      });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.emit(
            "error",
            Object.assign(new Error("fixture spawn failure"), {
              code,
              syscall: "spawn /usr/bin/python3",
            }),
          );
          seen();
        });
        return child as unknown as ChildProcess;
      });
      const pending = startInstalledUpdateHelper(helperPath, request, {
        readinessTimeoutMs: 1000,
      });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await observed;
      await tick();
      const settledBeforeClose = settled;
      child.ack.destroy();
      child.stdout.destroy();
      await tick();
      child.emit("close", -2, null);
      const result = await pending;
      expect(settledBeforeClose).toBe(false);
      expect(result).toMatchObject({
        status: "not_started",
        reason: "helper_spawn_failed",
      });
      expect(await result.operation.completion).toMatchObject({
        code: -2,
        signal: null,
        terminal: null,
        protocolError: "helper_spawn_failed",
      });
      expect(result.operation.pid).toBeNull();
      expect(programWrite).not.toHaveBeenCalled();
      expect(requestWrite).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("does not reinterpret a missing close or late close as a new launch decision", async () => {
    const child = new Transport();
    Object.defineProperty(child, "pid", { value: undefined });
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() =>
        child.emit(
          "error",
          Object.assign(new Error("fixture"), {
            code: "ENOENT",
            syscall: "spawn /usr/bin/python3",
          }),
        ),
      );
      return child as unknown as ChildProcess;
    });
    const result = await startInstalledUpdateHelper(helperPath, request, {
      readinessTimeoutMs: 10,
    });
    expect(result).toMatchObject({
      status: "outcome_unknown",
      reason: "readiness_timeout",
    });
    child.ack.destroy();
    child.stdout.destroy();
    child.emit("close", -2, null);
    await result.operation.completion;
    expect(result.status).toBe("outcome_unknown");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retains uncertainty for a process error after spawn", async () => {
    const { child, pending } = await launch();
    child.emit(
      "error",
      Object.assign(new Error("fixture"), {
        code: "EPERM",
        syscall: "spawn /usr/bin/python3",
      }),
    );
    child.finish(79, "unknown");
    expect(await pending).toMatchObject({
      status: "outcome_unknown",
      reason: "helper_process_error",
    });
  });

  it("waits for the entire single frame and EOF, then unrefs the retained operation", async () => {
    const { child, pending } = await launch();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    child.ack.write(JSON.stringify(event()));
    await tick();
    expect(settled).toBe(false);
    child.ack.end("\n");
    const result = await pending;
    expect(result.status).toBe("ready");
    expect(child.unref).toHaveBeenCalledOnce();
    child.finish(0);
    expect((await result.operation.completion).terminal?.phase).toBe(
      "verified",
    );
  });

  it.each([
    [
      "operation",
      () => JSON.stringify({ ...event(), operationId: "b".repeat(32) }),
      "readiness_malformed",
    ],
    [
      "source",
      () => JSON.stringify({ ...event(), source: request.target }),
      "readiness_malformed",
    ],
    [
      "target",
      () => JSON.stringify({ ...event(), target: request.source }),
      "readiness_malformed",
    ],
    [
      "process",
      () => JSON.stringify({ ...event(), processStart: "other" }),
      "readiness_malformed",
    ],
    [
      "duplicate",
      () => `${JSON.stringify(event())}\n${JSON.stringify(event())}`,
      "readiness_malformed",
    ],
    ["oversized", () => "x".repeat(4097), "readiness_oversized"],
  ] as const)(
    "keeps the same operation after %s ACK refusal",
    async (_name, frame, reason) => {
      const { child, pending } = await launch();
      child.ack.end(frame());
      const result = await pending;
      expect(result).toMatchObject({ status: "outcome_unknown", reason });
      expect(result.operation.pid).toBe(child.pid);
      child.finish(79, "unknown");
      expect((await result.operation.completion).code).toBe(79);
      expect(spawn).toHaveBeenCalledOnce();
    },
  );

  it("returns a terminal recovery result without manufacturing Quit readiness", async () => {
    const { child, pending } = await launch(1000, {
      ...request,
      action: "recover",
    });
    child.ack.end();
    await tick();
    child.finish(0);
    const result = await pending;
    expect(result.status).toBe("terminal");
    expect(result.operation.observe().handoff).toBeNull();
    expect((await result.operation.completion).terminal?.phase).toBe(
      "verified",
    );
  });

  it("requires a bound ACK before live recovery may Quit", async () => {
    const input = { ...request, action: "recover" as const, relaunch: true };
    const { child, pending } = await launch(1000, input);
    child.ack.end(JSON.stringify({ ...event(), action: "recover" }));
    const result = await pending;
    expect(result.status).toBe("ready");
    child.finish(0, "cancel_completed");
    expect((await result.operation.completion).terminal?.phase).toBe(
      "cancel_completed",
    );
  });

  it("does not treat a live recovery exit without ACK as terminal readiness", async () => {
    const input = { ...request, action: "recover" as const, relaunch: true };
    const { child, pending } = await launch(1000, input);
    child.ack.end();
    await tick();
    child.finish(0, "cancelled");
    expect(await pending).toMatchObject({
      status: "outcome_unknown",
      reason: "helper_exited_before_readiness",
    });
  });

  it("classifies a helper exit before acknowledgment without granting Quit", async () => {
    const { child, pending } = await launch();
    child.ack.end();
    await tick();
    child.finish(79, "unknown");
    const result = await pending;
    expect(result).toMatchObject({
      status: "outcome_unknown",
      reason: "helper_exited_before_readiness",
    });
    expect(result.operation.observe().exit?.code).toBe(79);
  });

  it("retains observation through timeout, late ACK and exit without another spawn", async () => {
    const { child, pending } = await launch(10);
    const result = await pending;
    expect(result).toMatchObject({
      status: "outcome_unknown",
      reason: "readiness_timeout",
    });
    expect(result.operation.pid).toBe(child.pid);
    expect(result.operation.observe().exit).toBeNull();
    child.ack.end(JSON.stringify(event()));
    await tick();
    expect(result.operation.observe().handoff?.phase).toBe("waiting_for_exit");
    expect(result.status).toBe("outcome_unknown");
    child.finish(70, "refused");
    expect((await result.operation.completion).code).toBe(70);
    expect(result.operation.observe().exit?.code).toBe(70);
    expect(spawn).toHaveBeenCalledOnce();
  });
});
