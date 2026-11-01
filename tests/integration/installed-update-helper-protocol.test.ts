import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startInstalledUpdateHelper,
  type InstalledUpdateHelperSelection,
  type InstalledUpdateOperation,
  type InstalledUpdateRequest,
  type PromotionLeaseTransfer,
  type InstalledHelperLifetime,
} from "../../src/modules/release/infra/native/installed-update-helper.js";
import {
  FIXTURE_GO_EXECUTABLE,
  fakeGoHelper,
  goSelection,
} from "./fixtures/installed-update-go-helper";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  // A preflight refusal can leave an unused mockImplementationOnce queued.
  // That transport belongs to this fixture, never the next test's launch.
  vi.mocked(spawn).mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
// A Go capability double: its qualification is the only preflight and it reads
// no file. The spawn double below receives `[FIXTURE_GO_EXECUTABLE, mode]`.
const goHelper = fakeGoHelper();
const selection = goSelection(goHelper);
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
  ...(selected.relaunchPresentation
    ? { relaunchPresentation: selected.relaunchPresentation }
    : {}),
});

// This fixture models only Node's private pipe transport and lifecycle events.
// Native readiness, marker, digest and immediate normal-exit evidence lives in
// installed-update-helper-readiness.test.mjs.
class Transport extends EventEmitter {
  readonly pid = 765432;
  // Node reports a null stdin for an "ignore" stdio entry.
  readonly stdin = null;
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
  readonly kill = vi.fn();
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
  quitOptions: Readonly<{
    deadlineAt?: number;
    canStartEffect?(): boolean;
    lifetime?: InstalledHelperLifetime;
  }> = {},
  selected: InstalledUpdateHelperSelection = selection,
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
  const pending = startInstalledUpdateHelper(selected, input, {
    readinessTimeoutMs,
    ...(recordSpawn ? { recordSpawn } : {}),
    ...(promotionLease ? { promotionLease } : {}),
    ...quitOptions,
  });
  // The capability's qualification may refuse before invoking our spawn
  // double. Surface that result instead of leaving the fixture waiting forever.
  await Promise.race([
    spawned,
    pending.then(() => {
      throw new Error("HELPER_FIXTURE_DID_NOT_SPAWN");
    }),
  ]);
  return { child, pending };
}

describe("installed helper bounded readiness protocol", () => {
  it("pins Sidecar presentation in request bytes and requires its exact ACK", async () => {
    const selected: InstalledUpdateRequest = {
      ...request,
      relaunch: true,
      relaunchPresentation: "sidecar-only",
    };
    const { child, pending } = await launch(1000, selected);
    await tick();
    expect(
      JSON.parse(Buffer.concat(child.requests).toString("utf8")),
    ).toMatchObject({ relaunchPresentation: "sidecar-only" });
    child.ack.end(JSON.stringify(event(selected)) + "\n");
    const result = await pending;
    expect(result.status).toBe("ready");
    child.finish(0);
    await result.operation.completion;
  });
  it.each(["missing", "changed", "unsolicited"] as const)(
    "refuses a %s presentation ACK without another spawn",
    async (kind) => {
      const selected: InstalledUpdateRequest =
        kind === "unsolicited"
          ? request
          : {
              ...request,
              relaunch: true,
              relaunchPresentation: "sidecar-only",
            };
      const { child, pending } = await launch(1000, selected);
      const frame: Record<string, unknown> = event(selected);
      if (kind === "missing") delete frame["relaunchPresentation"];
      else
        frame["relaunchPresentation"] =
          kind === "changed" ? "primary" : "sidecar-only";
      child.ack.end(JSON.stringify(frame) + "\n");
      const result = await pending;
      expect(result).toMatchObject({
        status: "outcome_unknown",
        reason: "readiness_malformed",
      });
      child.finish(79, "unknown");
      await result.operation.completion;
      expect(spawn).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
    },
  );
  it("sends no request after lifetime acceptance returns past the original bound", async () => {
    const transport = new Transport();
    Object.defineProperty(transport, "pid", { value: process.pid });
    const retain = vi.fn(async (_request, _helper, deadline: number) => {
      vi.spyOn(Date, "now").mockReturnValue(deadline);
    });
    const { child, pending } = await launch(
      3000,
      request,
      async () => undefined,
      undefined,
      transport,
      { lifetime: { available: () => true, retain } },
    );
    expect(await pending).toMatchObject({
      status: "outcome_unknown",
      reason: "helper_lifetime_deadline_expired",
    });
    expect(retain).toHaveBeenCalledOnce();
    expect(child.requests).toHaveLength(0);
    child.finish(79);
    await tick();
  });
  it("holds request bytes behind the durable spawn record and private lifetime ACK", async () => {
    // A real ps observation of this still-live test process supplies the helper
    // lstart token. Transport itself remains a pipe/event double.
    const transport = new Transport();
    Object.defineProperty(transport, "pid", { value: process.pid });
    const order: string[] = [];
    let accept!: () => void;
    const held = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const retain = vi.fn(async (_request, helper, deadline) => {
      expect(transport.requests).toHaveLength(0);
      expect(helper.pid).toBe(process.pid);
      expect(helper.processStart.length).toBeGreaterThan(0);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 3000);
      order.push("lifetime");
      await held;
    });
    const { child, pending } = await launch(
      3000,
      request,
      async () => {
        order.push("record");
      },
      undefined,
      transport,
      { lifetime: { available: () => true, retain } },
    );
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    expect(order).toEqual(["record", "lifetime"]);
    expect(child.requests).toHaveLength(0);
    accept();
    await tick();
    expect(child.requests).toHaveLength(1);
    child.ack.end(JSON.stringify(event()) + "\n");
    expect((await pending).status).toBe("ready");
    child.finish(0);
    await tick();
  });
  it("ends the fixture when helper qualification refuses before spawn", async () => {
    const refusing = fakeGoHelper(async () => {
      throw new Error("fixture qualification refused");
    });
    await expect(
      launch(
        1000,
        request,
        undefined,
        undefined,
        undefined,
        {},
        goSelection(refusing),
      ),
    ).rejects.toThrow("HELPER_FIXTURE_DID_NOT_SPAWN");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns the qualified Go executable in live mode with stdin ignored", async () => {
    const { child, pending } = await launch();
    expect(spawn).toHaveBeenCalledOnce();
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(executable).toBe(FIXTURE_GO_EXECUTABLE);
    expect(args).toEqual(["run-live-release-helper"]);
    expect(options).toMatchObject({
      cwd: "/",
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      detached: true,
      // No program on stdin and nothing on stderr; fd3 request, fd4 ACK.
      stdio: ["ignore", "pipe", "ignore", "pipe", "pipe"],
    });
    expect(Object.keys(options as object).sort()).toEqual([
      "cwd",
      "detached",
      "env",
      "stdio",
    ]);
    expect(goHelper.qualified).toBeGreaterThan(0);
    child.ack.end(`${JSON.stringify(event())}\n`);
    const result = await pending;
    expect(result.status).toBe("ready");
    child.finish(0);
    await result.operation.completion;
  });

  it("spawns the closed mode with the borrowed lease and continuation descriptors", async () => {
    const lease = leaseFixture();
    const { child, pending } = await launch(
      1000,
      closedApplyRequest,
      async () => undefined,
      lease,
    );
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(executable).toBe(FIXTURE_GO_EXECUTABLE);
    expect(args).toEqual(["run-closed-release-helper"]);
    expect((options as { stdio: unknown[] }).stdio).toEqual([
      "ignore",
      "pipe",
      "ignore",
      "pipe",
      "pipe",
      lease.descriptor,
      "pipe",
    ]);
    child.ack.end(
      `${JSON.stringify(closedEvent(lease, closedApplyRequest))}\n`,
    );
    await tick();
    child.finish(0);
    const result = await pending;
    expect(["continued", "terminal"]).toContain(result.status);
    expect(Buffer.concat(child.continues).length).toBeGreaterThan(0);
  });

  it("refuses a legacy build or an unselected capability without any process", async () => {
    for (const reason of [
      "helper_go_core_required",
      "helper_preflight_failed",
    ] as const) {
      const result = await startInstalledUpdateHelper(
        { kind: "refused", reason },
        request,
      );
      expect(result).toMatchObject({ status: "not_started", reason });
      expect(result.operation.pid).toBeNull();
      expect(await result.operation.completion).toEqual({
        code: null,
        signal: null,
        terminal: null,
        protocolError: reason,
      });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["relative", "farol-backend"],
    ["unnormalized", "/fixture/../fixture/farol-backend"],
    ["empty", ""],
  ])(
    "refuses a %s qualified executable path before spawn",
    async (_name, executable) => {
      const result = await startInstalledUpdateHelper(
        goSelection(fakeGoHelper(executable)),
        request,
      );
      expect(result).toMatchObject({
        status: "not_started",
        reason: "helper_preflight_failed",
      });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("refuses a capability whose build identity is not a digest", async () => {
    const result = await startInstalledUpdateHelper(
      goSelection({
        buildId: "not-a-digest",
        qualify: async () => FIXTURE_GO_EXECUTABLE,
        remeasure: async () => FIXTURE_GO_EXECUTABLE,
      }),
      request,
    );
    expect(result).toMatchObject({
      status: "not_started",
      reason: "helper_preflight_failed",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("re-qualifies the executable after the child closes and fails closed on drift", async () => {
    let calls = 0;
    const drifting = fakeGoHelper(async () =>
      ++calls === 1 ? FIXTURE_GO_EXECUTABLE : "/fixture/replaced-farol-backend",
    );
    const { child, pending } = await launch(
      1000,
      request,
      undefined,
      undefined,
      undefined,
      {},
      goSelection(drifting),
    );
    child.ack.end(`${JSON.stringify(event())}\n`);
    const result = await pending;
    child.finish(0);
    const finished = await result.operation.completion;
    expect(calls).toBe(2);
    expect(finished).toMatchObject({
      code: 0,
      protocolError: "helper_executable_changed",
    });
  });

  it("fails closed when the post-close qualification throws, and keeps a clean close clean", async () => {
    let calls = 0;
    const failing = fakeGoHelper(async () => {
      if (++calls === 2) throw new Error("fixture resources changed");
      return FIXTURE_GO_EXECUTABLE;
    });
    const first = await launch(
      1000,
      request,
      undefined,
      undefined,
      undefined,
      {},
      goSelection(failing),
    );
    first.child.ack.end(`${JSON.stringify(event())}\n`);
    const unchanged = await first.pending;
    first.child.finish(0);
    expect(await unchanged.operation.completion).toMatchObject({
      protocolError: "helper_executable_changed",
    });
    vi.mocked(spawn).mockReset();
    const clean = await launch();
    clean.child.ack.end(`${JSON.stringify(event())}\n`);
    const ready = await clean.pending;
    clean.child.finish(0);
    expect(await ready.operation.completion).toMatchObject({
      code: 0,
      protocolError: null,
    });
  });

  it("measures the executable after close without the effect fence that ended with the Quit", async () => {
    // A normal-Quit fence ends once preparation returns, while the detached
    // helper still runs. Its refusal after close is not executable drift.
    let fenced = 0;
    let measured = 0;
    const helper = {
      buildId: fakeGoHelper().buildId,
      qualify: async () => {
        if (++fenced > 1) throw new Error("UPDATE_QUIT_EFFECT_NOT_ALLOWED");
        return FIXTURE_GO_EXECUTABLE;
      },
      remeasure: async () => {
        measured += 1;
        return FIXTURE_GO_EXECUTABLE;
      },
    };
    const { child, pending } = await launch(
      1000,
      request,
      undefined,
      undefined,
      undefined,
      {},
      goSelection(helper),
    );
    child.ack.end(`${JSON.stringify(event())}\n`);
    const result = await pending;
    child.finish(0);
    expect(await result.operation.completion).toMatchObject({
      code: 0,
      protocolError: null,
    });
    expect([fenced, measured]).toEqual([1, 1]);
  });

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
    const before = { requestEnded: child.requestPipe.writableEnded };
    const calls = recordSpawn.mock.calls.length;
    persist?.();
    await tick();
    child.ack.end(`${JSON.stringify(event())}\n`);
    const result = await pending;
    child.finish(0);
    await result.operation.completion;
    expect(calls).toBe(1);
    expect(before).toEqual({ requestEnded: false });
    expect(child.requestPipe.writableEnded).toBe(true);
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
      expect(child.requestPipe.destroyed).toBe(true);
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
              syscall: `spawn ${FIXTURE_GO_EXECUTABLE}`,
            }),
          );
          seen();
        });
        return child as unknown as ChildProcess;
      });
      const pending = startInstalledUpdateHelper(selection, request, {
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
            syscall: `spawn ${FIXTURE_GO_EXECUTABLE}`,
          }),
        ),
      );
      return child as unknown as ChildProcess;
    });
    const result = await startInstalledUpdateHelper(selection, request, {
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
        syscall: `spawn ${FIXTURE_GO_EXECUTABLE}`,
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

describe("normal-Quit deadline fencing (Node transport doubles and test clocks only)", () => {
  const now = 1_800_000_000_000;
  const deadlineAt = now + 100;
  const quitOptions = () => ({ deadlineAt, canStartEffect: () => true });
  const clock = (): void => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(now);
  };
  const retainCompletion = async (
    child: Transport,
    operation: InstalledUpdateOperation,
  ): Promise<void> => {
    expect(operation.pid).toBe(child.pid);
    expect(operation.observe().exit).toBeNull();
    let completed = false;
    void operation.completion.then(() => {
      completed = true;
    });
    await tick();
    expect(completed).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(false);
    if (!child.ack.writableEnded) expect(child.ack.destroyed).toBe(false);
    child.finish(70, "refused");
    const terminal = await operation.completion;
    expect(terminal).toMatchObject({
      code: 70,
      signal: null,
      terminal: { phase: "refused", error: null },
    });
    expect(operation.observe().exit).toBe(terminal);
    expect(spawn).toHaveBeenCalledOnce();
  };

  it.each([
    { deadlineAt },
    { canStartEffect: () => true },
    { deadlineAt: NaN, canStartEffect: () => true },
    { deadlineAt: Infinity, canStartEffect: () => true },
    { deadlineAt: 0, canStartEffect: () => true },
    { deadlineAt: -1, canStartEffect: () => true },
    { deadlineAt: 1.5, canStartEffect: () => true },
    { deadlineAt: Number.MAX_SAFE_INTEGER + 1, canStartEffect: () => true },
    { deadlineAt, canStartEffect: true as unknown as () => boolean },
  ])(
    "rejects an invalid paired context %j before preflight",
    async (options) => {
      goHelper.qualified = 0;
      await expect(
        startInstalledUpdateHelper(selection, request, options),
      ).rejects.toThrow("INSTALLED_UPDATE_QUIT_CONTEXT_INVALID");
      expect(goHelper.qualified).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each([request, closedApplyRequest])(
    "rejects relaunch in a normal-Quit context for $action",
    async (input) => {
      await expect(
        startInstalledUpdateHelper(
          selection,
          {
            ...input,
            relaunch: true,
          },
          quitOptions(),
        ),
      ).rejects.toThrow("INSTALLED_UPDATE_QUIT_CONTEXT_INVALID");
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each(["expired", "revoked", "throws", "non-boolean"])(
    "keeps %s preflight known not_started without an invented process exit",
    async (mode) => {
      clock();
      if (mode === "expired") vi.setSystemTime(deadlineAt);
      goHelper.qualified = 0;
      const result = await startInstalledUpdateHelper(selection, request, {
        deadlineAt,
        canStartEffect: () => {
          if (mode === "throws") throw new Error("fixture callback failure");
          return mode === "non-boolean"
            ? (1 as unknown as boolean)
            : mode === "expired";
        },
      });
      const reason =
        mode === "expired"
          ? "quit_deadline_expired"
          : "quit_effect_not_allowed";
      expect(result).toMatchObject({ status: "not_started", reason });
      expect(result.operation.pid).toBeNull();
      expect(await result.operation.completion).toEqual({
        code: null,
        signal: null,
        terminal: null,
        protocolError: reason,
      });
      // An expired or revoked fence stops before the capability is even asked.
      expect(goHelper.qualified).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each(["qualify", "owner-home"])(
    "rechecks after %s preflight before spawn",
    async (stage) => {
      clock();
      let selected = selection;
      if (stage === "owner-home") {
        const originalUserInfo = os.userInfo.bind(os);
        vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
          const user = originalUserInfo();
          vi.setSystemTime(deadlineAt);
          return user;
        });
      } else {
        // The deadline passes while the attestation itself runs.
        selected = goSelection(
          fakeGoHelper(async () => {
            vi.setSystemTime(deadlineAt);
            return FIXTURE_GO_EXECUTABLE;
          }),
        );
      }
      const result = await startInstalledUpdateHelper(
        selected,
        request,
        quitOptions(),
      );
      expect(result).toMatchObject({
        status: "not_started",
        reason: "quit_deadline_expired",
      });
      expect((await result.operation.completion).code).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("bounds an unanswered preflight lease by the original deadline", async () => {
    clock();
    const lease = leaseFixture();
    let reply!: (value: boolean) => void;
    lease.verify.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          reply = resolve;
        }),
    );
    const pending = startInstalledUpdateHelper(selection, closedApplyRequest, {
      ...quitOptions(),
      promotionLease: lease,
      recordSpawn: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    reply(true);
    await tick();
    expect(result).toMatchObject({
      status: "not_started",
      reason: "quit_deadline_expired",
    });
    expect(result.operation.pid).toBeNull();
    expect((await result.operation.completion).code).toBeNull();
    expect(lease.release).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a late successful preflight lease before timer dispatch", async () => {
    clock();
    const lease = leaseFixture();
    lease.verify.mockImplementationOnce(async () => {
      vi.setSystemTime(deadlineAt);
      return true;
    });
    const result = await startInstalledUpdateHelper(
      selection,
      closedApplyRequest,
      {
        ...quitOptions(),
        promotionLease: lease,
        recordSpawn: async () => undefined,
      },
    );
    expect(result).toMatchObject({
      status: "not_started",
      reason: "quit_deadline_expired",
    });
    expect((await result.operation.completion).code).toBeNull();
    expect(lease.release).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fences a late spawn event even without recordSpawn", async () => {
    clock();
    const child = new Transport();
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        vi.setSystemTime(deadlineAt);
        child.emit("spawn");
      });
      return child as unknown as ChildProcess;
    });
    const result = await startInstalledUpdateHelper(
      selection,
      request,
      quitOptions(),
    );
    expect(result).toMatchObject({
      status: "outcome_unknown",
      reason: "quit_deadline_expired",
    });
    expect(child.requestPipe.destroyed).toBe(true);
    expect(child.requests).toEqual([]);
    await retainCompletion(child, result.operation);
  });

  it.each(["record", "lease", "timer", "revoked"])(
    "retains the actual spawned operation after late %s with no program/request",
    async (stage) => {
      clock();
      let recorded!: InstalledUpdateOperation;
      let reply!: () => void;
      let allowed = true;
      const lease = stage === "lease" ? leaseFixture() : undefined;
      if (lease)
        lease.verify
          .mockImplementationOnce(async () => true)
          .mockImplementationOnce(
            () =>
              new Promise<boolean>((resolve) => {
                reply = () => resolve(true);
              }),
          );
      const record = async (
        operation: InstalledUpdateOperation,
      ): Promise<void> => {
        recorded = operation;
        if (!lease)
          await new Promise<void>((resolve) => {
            reply = resolve;
          });
      };
      const { child, pending } = await launch(
        1000,
        lease ? closedApplyRequest : request,
        record,
        lease,
        undefined,
        { deadlineAt, canStartEffect: () => allowed },
      );
      await tick();
      if (stage === "timer") await vi.advanceTimersByTimeAsync(100);
      else if (stage === "revoked") allowed = false;
      else vi.setSystemTime(deadlineAt);
      reply();
      const result = await pending;
      await tick();
      expect(result).toMatchObject({
        status: "outcome_unknown",
        reason:
          stage === "revoked"
            ? "quit_effect_not_allowed"
            : "quit_deadline_expired",
      });
      expect(result.operation).toBe(recorded);
      expect(child.requestPipe.destroyed).toBe(true);
      expect(child.requests).toEqual([]);
      expect(child.continues).toEqual([]);
      if (lease) expect(lease.release).not.toHaveBeenCalled();
      await retainCompletion(child, result.operation);
    },
  );

  it.each(["verify", "release", "revoked"])(
    "never continues after late transfer %s even before timer dispatch",
    async (stage) => {
      clock();
      const lease = leaseFixture();
      let reply!: () => void;
      let allowed = true;
      if (stage === "verify")
        lease.verify
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockImplementationOnce(
            () =>
              new Promise<boolean>((resolve) => {
                reply = () => resolve(true);
              }),
          );
      else
        lease.release.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              reply = resolve;
            }),
        );
      const { child, pending } = await launch(
        1000,
        closedApplyRequest,
        async () => undefined,
        lease,
        undefined,
        { deadlineAt, canStartEffect: () => allowed },
      );
      await tick();
      expect(child.requests).toHaveLength(1);
      child.ack.end(JSON.stringify(closedEvent(lease, closedApplyRequest)));
      await tick();
      if (stage === "revoked") allowed = false;
      else vi.setSystemTime(deadlineAt);
      reply();
      const result = await pending;
      expect(result).toMatchObject({
        status: "outcome_unknown",
        reason:
          stage === "revoked"
            ? "quit_effect_not_allowed"
            : "quit_deadline_expired",
      });
      expect(child.continues).toEqual([]);
      expect(child.continuation.destroyed).toBe(true);
      expect(lease.release).toHaveBeenCalledTimes(stage === "verify" ? 0 : 1);
      await retainCompletion(child, result.operation);
    },
  );

  it("uses the remaining absolute budget after lease preflight without resetting readiness", async () => {
    clock();
    const lease = leaseFixture();
    lease.verify.mockImplementationOnce(async () => {
      vi.setSystemTime(now + 40);
      return true;
    });
    const { child, pending } = await launch(
      1000,
      closedApplyRequest,
      async () => undefined,
      lease,
      undefined,
      quitOptions(),
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(59);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(Date.now()).toBe(deadlineAt);
    expect(result).toMatchObject({
      status: "outcome_unknown",
      reason: "quit_deadline_expired",
    });
    child.ack.end(JSON.stringify(closedEvent(lease, closedApplyRequest)));
    await tick();
    expect(lease.release).not.toHaveBeenCalled();
    expect(child.continues).toEqual([]);
    await retainCompletion(child, result.operation);
  });

  it("keeps the bounded normal-Quit success path at relaunch false", async () => {
    clock();
    const { child, pending } = await launch(
      1000,
      request,
      async () => undefined,
      undefined,
      undefined,
      quitOptions(),
    );
    await tick();
    child.ack.end(JSON.stringify(event()));
    const result = await pending;
    expect(result.status).toBe("ready");
    expect(JSON.parse(Buffer.concat(child.requests).toString())).toMatchObject({
      relaunch: false,
    });
    child.finish(0);
    await result.operation.completion;
  });
});

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
      selection,
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
      stdio: ["ignore", "pipe", "ignore", "pipe", "pipe", 17, "pipe"],
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
