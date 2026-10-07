import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startInstalledUpdateHelper,
  type InstalledUpdateRequest,
  type PromotionLeaseTransfer,
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
const event = (selected: InstalledUpdateRequest = request) => ({
  schema: "farol.installed-update-handoff/1",
  phase: "waiting_for_exit",
  operationId: selected.operationId,
  action: selected.action,
  source: selected.source,
  target: selected.target,
  pid: selected.pid,
  processStart: selected.processStart,
});

// This fixture models only Node's private pipe transport and lifecycle events.
// Native readiness, marker, digest and immediate normal-exit evidence lives in
// installed-update-helper-readiness.test.mjs.
class Transport extends EventEmitter {
  readonly pid = 765432;
  readonly stdin = new Writable({ write: (_chunk, _encoding, done) => done() });
  readonly stdout = new PassThrough();
  readonly requests: Buffer[] = [];
  readonly requestPipe = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      this.requests.push(Buffer.from(chunk));
      done();
    },
  });
  readonly ack = new PassThrough();
  readonly continues: Buffer[] = [];
  readonly continuation = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      this.continues.push(Buffer.from(chunk));
      done();
    },
  });
  readonly stdio = [
    this.stdin,
    this.stdout,
    null,
    this.requestPipe,
    this.ack,
    null,
    this.continuation,
  ];
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
  input: InstalledUpdateRequest = request,
  recordSpawn?: (
    operation: import("../../src/modules/release/infra/native/installed-update-helper.js").InstalledUpdateOperation,
  ) => Promise<void>,
  promotionLease?: PromotionLeaseTransfer,
  transport?: Transport,
) {
  const child = transport ?? new Transport();
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
    ...(promotionLease ? { promotionLease } : {}),
  });
  await spawned;
  return { child, pending };
}

describe("installed helper bounded readiness protocol", () => {
  it("keeps ordinary live rollback on its correlated Quit handoff", async () => {
    const selected: InstalledUpdateRequest = {
      ...request,
      action: "rollback",
      relaunch: true,
    };
    const { child, pending } = await launch(1000, selected);
    await tick();
    child.ack.end(JSON.stringify(event(selected)));
    const result = await pending;
    expect(result.status).toBe("ready");
    expect(JSON.parse(Buffer.concat(child.requests).toString())).toMatchObject({
      action: "rollback",
      relaunch: true,
    });
    expect(child.continues).toEqual([]);
    child.finish(0, "rolled_back");
    await result.operation.completion;
    expect(spawn).toHaveBeenCalledOnce();
  });
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

const closedApplyRequest = {
  ...request,
  action: "apply",
  predecessor: {
    kind: "confirmed_closed",
    startedAt: "2026-09-29T22:00:00.000Z",
    lastQuitSha256: "5".repeat(64),
    stateIdentity: { device: "11", inode: "22" },
  },
} as const satisfies InstalledUpdateRequest;
function leaseFixture() {
  return {
    descriptor: 17,
    identity: { device: "11", inode: "33" },
    verify: vi.fn(async () => true),
    release: vi.fn(async (): Promise<void> => undefined),
  } satisfies PromotionLeaseTransfer;
}
function closedEvent(
  lease: PromotionLeaseTransfer,
  selected: InstalledUpdateRequest,
) {
  return {
    ...event(selected),
    phase: "closed_predecessor_ready",
    predecessor: selected.predecessor,
    leaseIdentity: lease.identity,
  };
}

function closedTransferProtocol(action: "apply" | "rollback") {
  const closedRequest = {
    ...closedApplyRequest,
    action,
    relaunch: false as const,
  } satisfies InstalledUpdateRequest;
  const terminalPhase = action === "rollback" ? "rolled_back" : "verified";

  it("pins the actual action and current-process proof before asynchronous dispatch", async () => {
    const selected: InstalledUpdateRequest = {
      ...closedRequest,
      source: { ...closedRequest.source },
      predecessor: {
        ...closedRequest.predecessor!,
        stateIdentity: { ...closedRequest.predecessor!.stateIdentity },
      },
    };
    const lease = leaseFixture();
    const { child, pending } = await launch(
      1000,
      selected,
      async () => undefined,
      lease,
    );
    Object.assign(selected, {
      action: action === "apply" ? "rollback" : "apply",
      relaunch: true,
    });
    Object.assign(selected.source, { buildId: "0".repeat(64) });
    Object.assign(selected.predecessor!.stateIdentity, { inode: "99" });
    await tick();
    child.ack.end(JSON.stringify(closedEvent(lease, closedRequest)));
    const result = await pending;
    expect(result.status).toBe("continued");
    const sent = JSON.parse(Buffer.concat(child.requests).toString());
    const continued = JSON.parse(Buffer.concat(child.continues).toString());
    for (const value of [sent, continued])
      expect(value).toMatchObject({
        action,
        source: closedRequest.source,
        predecessor: closedRequest.predecessor,
      });
    expect(sent.relaunch).toBe(false);
    child.finish(0, terminalPhase);
    await result.operation.completion;
  });

  it("keeps a possibly effective dispatch unknown when its terminal belongs to the other action", async () => {
    const lease = leaseFixture();
    const child = new Transport();
    child.stdio[6] = new Writable({
      write: (_chunk, _encoding, done) => {
        child.finish(0, action === "rollback" ? "verified" : "rolled_back");
        done();
      },
    });
    const { pending } = await launch(
      1000,
      closedRequest,
      async () => undefined,
      lease,
      child,
    );
    await tick();
    child.ack.end(JSON.stringify(closedEvent(lease, closedRequest)));
    const result = await pending;
    expect(result).toMatchObject({
      status: "outcome_unknown",
      reason: `closed_${action}_terminal_unconfirmed`,
    });
    expect(result.operation.observe().protocolError).toBe(
      `closed_${action}_terminal_unconfirmed`,
    );
    expect((await result.operation.completion).terminal?.phase).toBe(
      action === "rollback" ? "verified" : "rolled_back",
    );
    expect(result.status).toBe("outcome_unknown");
    expect(lease.release).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
  });
  it.each([
    "missing-lease",
    "bad-descriptor",
    "unverified",
    "verify-throws",
    "no-record",
    "live-lease",
  ])("refuses %s before spawning or releasing", async (kind) => {
    const lease = leaseFixture();
    if (kind === "bad-descriptor") lease.descriptor = 1;
    if (kind === "unverified") lease.verify.mockResolvedValue(false);
    if (kind === "verify-throws")
      lease.verify.mockRejectedValue(new Error("lost verification"));
    const result = await startInstalledUpdateHelper(
      helperPath,
      kind === "live-lease" ? request : closedRequest,
      {
        ...(kind === "missing-lease" ? {} : { promotionLease: lease }),
        ...(kind === "no-record" ? {} : { recordSpawn: async () => undefined }),
      },
    );
    expect(result.status).toBe("not_started");
    expect(result.operation.pid).toBeNull();
    expect((await result.operation.completion).code).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });

  it("passes the same descriptor and writes one correlated continuation only after known release", async () => {
    const lease = leaseFixture();
    let release!: () => void;
    lease.release.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const record = vi.fn(async () => undefined);
    const { child, pending } = await launch(1000, closedRequest, record, lease);
    await tick();
    const options = vi.mocked(spawn).mock.calls[0]![2];
    expect(options).toMatchObject({
      stdio: ["pipe", "pipe", "ignore", "pipe", "pipe", 17, "pipe"],
    });
    expect(record).toHaveBeenCalledOnce();
    expect(child.requestPipe.writableEnded).toBe(true);
    expect(JSON.parse(Buffer.concat(child.requests).toString())).toMatchObject({
      action,
      relaunch: false,
      predecessor: closedRequest.predecessor,
    });
    child.ack.write(JSON.stringify(closedEvent(lease, closedRequest)));
    await tick();
    expect(lease.release).not.toHaveBeenCalled();
    child.ack.end("\n");
    await tick();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(child.continues).toEqual([]);
    release();
    const result = await pending;
    expect(result.status).toBe("continued");
    const { phase: _phase, ...expected } = closedEvent(lease, closedRequest);
    expect(JSON.parse(Buffer.concat(child.continues).toString())).toEqual({
      ...expected,
      schema: "farol.installed-update-continue/1",
    });
    expect(child.continuation.writableEnded).toBe(true);
    expect(lease.verify).toHaveBeenCalledTimes(3);
    child.finish(0, terminalPhase);
    expect((await result.operation.completion).terminal?.phase).toBe(
      terminalPhase,
    );
  });

  it.each([
    "wrong-action",
    "wrong-source",
    "wrong-target",
    "wrong-pid",
    "wrong-start",
    "wrong-state",
    "wrong-lease",
    "wrong-quit",
    "live-ack",
    "partial",
    "duplicate",
    "oversized",
  ])("does not release or continue after %s ACK", async (kind) => {
    const lease = leaseFixture();
    const { child, pending } = await launch(
      1000,
      closedRequest,
      async () => undefined,
      lease,
    );
    await tick();
    const frame = closedEvent(lease, closedRequest);
    if (kind === "wrong-action")
      frame.action = action === "apply" ? "rollback" : "apply";
    if (kind === "wrong-source")
      frame.source = { ...frame.source, digest: "0".repeat(64) };
    if (kind === "wrong-target")
      frame.target = { ...frame.target, buildId: "0".repeat(64) };
    if (kind === "wrong-pid") frame.pid += 1;
    if (kind === "wrong-start") frame.processStart += " changed";
    if (kind === "wrong-state")
      frame.predecessor = {
        ...closedRequest.predecessor!,
        stateIdentity: { device: "11", inode: "99" },
      };
    if (kind === "wrong-lease")
      frame.leaseIdentity = { device: "11", inode: "99" };
    if (kind === "wrong-quit")
      frame.predecessor = {
        ...closedRequest.predecessor!,
        lastQuitSha256: "0".repeat(64),
      };
    if (kind === "live-ack") frame.phase = "waiting_for_exit";
    const raw = JSON.stringify(frame);
    child.ack.end(
      kind === "partial"
        ? raw.slice(0, -1)
        : kind === "duplicate"
          ? raw + raw
          : kind === "oversized"
            ? "x".repeat(4097)
            : raw,
    );
    const result = await pending;
    expect(result.status).toBe("outcome_unknown");
    expect(lease.release).not.toHaveBeenCalled();
    expect(child.continues).toEqual([]);
    expect(child.continuation.destroyed).toBe(true);
    child.finish(70, "refused");
    await result.operation.completion;
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each(["release-throws", "late-release", "late-ack", "verify-lost"])(
    "keeps %s fenced with the original child and no continue",
    async (kind) => {
      const lease = leaseFixture();
      let release: () => void = () => undefined;
      if (kind === "release-throws")
        lease.release.mockRejectedValue(new Error("lost release"));
      if (kind === "late-release")
        lease.release.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
      if (kind === "verify-lost")
        lease.verify
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockRejectedValue(new Error("lost verification"));
      const { child, pending } = await launch(
        25,
        closedRequest,
        async () => undefined,
        lease,
      );
      await tick();
      if (kind !== "late-ack")
        child.ack.end(JSON.stringify(closedEvent(lease, closedRequest)));
      const result = await pending;
      if (kind === "late-ack")
        child.ack.end(JSON.stringify(closedEvent(lease, closedRequest)));
      release();
      await tick();
      expect(result.status).toBe("outcome_unknown");
      expect(child.continues).toEqual([]);
      expect(child.continuation.destroyed).toBe(true);
      expect(lease.release.mock.calls.length).toBe(
        kind === "late-ack" || kind === "verify-lost" ? 0 : 1,
      );
      child.finish(70, "refused");
      await result.operation.completion;
      expect(spawn).toHaveBeenCalledOnce();
    },
  );

  it.each(["immediate", "write-failure", "exit-before-continue"])(
    "retains exact completion when %s races the barrier",
    async (kind) => {
      const lease = leaseFixture();
      const child = new Transport();
      child.stdio[6] = new Writable({
        write: (_chunk, _encoding, done) => {
          if (kind === "write-failure") {
            done(new Error("lost write"));
            return;
          }
          child.finish(0, terminalPhase);
          done();
        },
      });
      const { pending } = await launch(
        1000,
        closedRequest,
        async () => undefined,
        lease,
        child,
      );
      await tick();
      if (kind === "exit-before-continue") {
        child.ack.end();
        child.finish(0, terminalPhase);
      } else child.ack.end(JSON.stringify(closedEvent(lease, closedRequest)));
      const result = await pending;
      expect(result.status).toBe(
        kind === "immediate" ? "terminal" : "outcome_unknown",
      );
      if (kind === "write-failure") child.finish(70, "refused");
      expect((await result.operation.completion).code).toBe(
        kind === "write-failure" ? 70 : 0,
      );
      expect(lease.release.mock.calls.length).toBe(
        kind === "exit-before-continue" ? 0 : 1,
      );
      expect(spawn).toHaveBeenCalledOnce();
    },
  );
}

describe.each(["apply", "rollback"] as const)(
  "closed predecessor %s transfer protocol (Node pipe doubles only)",
  closedTransferProtocol,
);
