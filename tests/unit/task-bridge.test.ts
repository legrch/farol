import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskBridge, TaskBridgeError } from "../../apps/desktop/bridge/task.ts";
import {
  BridgeError,
  Client,
  RequestNotSentError,
} from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";
import {
  validate,
  requiresOperationID,
  maxFrameBytes,
  type TaskHandle,
  type TaskBinding,
  type TaskReceipt,
  type TaskMutation,
  type TaskResolution,
  type TaskStatus,
  type TaskDispatch,
  type TaskOperation,
  type TaskObservation,
  type TaskEvent,
  type TaskCreate,
  type TaskContinue,
  type TaskResume,
  type TaskObservationRequest,
  type Outcome,
  type Json,
  type Request,
  protocolMajor,
  protocolMinor,
} from "../../apps/desktop/bridge/wire.ts";

// Actual bridge, generated validator and frame codec; controlled Client only.
// No Go owner/journal, native filesystem, CLI/process, Electron or provider proof.
const handle: TaskHandle = { handleId: "opaque-selected-turn" };
const scope = { profileId: "profile", backendGeneration: "backend" };
const taskId = "original task";
const dispatchId = "original-create";
function binding(provider: "codex" | "claude" = "codex"): TaskBinding {
  return {
    provider,
    profileId: scope.profileId,
    hostId: "selected-host",
    projectId: "project",
    workspaceId: "writer",
    project: {
      path: "/fixture/project",
      device: "1",
      inode: "10",
      gitCommonDirectory: "/fixture/project/.git",
    },
    writer: {
      path: "/fixture/writer",
      device: "1",
      inode: "11",
      gitCommonDirectory: "/fixture/project/.git",
    },
    modelAlias: "selected-alias",
    model: "fixture-model",
    effort: "high",
    configDigest: "a".repeat(64),
  };
}
function receipt(provider: "codex" | "claude" = "codex"): TaskReceipt {
  return {
    state: "known",
    code: "",
    reference:
      provider === "codex"
        ? { threadId: "thread@provider", turnId: "turn-1" }
        : { sessionId: "session@provider", invocationId: "invocation-1" },
    lifecycle: "running",
    result: "",
    cancelRequested: false,
  };
}
function event(): TaskEvent {
  return {
    runId: taskId,
    dispatchId,
    eventId: "event-1",
    streamId: "stream@task",
    generation: "18446744073709551615",
    sourceSequence: "9007199254740993",
    sequence: "9007199254740993",
    timestampMillis: "1760000000000",
    kind: "provider_started",
    source: "provider_runtime",
    reportedLifecycle: "running",
    reference: receipt().reference,
    hasExitCode: false,
    exitCode: 0,
    planSteps: 0,
    completedSteps: 0,
  };
}
function payload(
  method: string,
  routed: Json,
  operationId: string | undefined,
  provider: "codex" | "claude",
): Json {
  const request = (routed as { request?: Record<string, Json> }).request;
  let data:
    | TaskResolution
    | TaskMutation
    | TaskStatus
    | TaskDispatch
    | TaskOperation
    | TaskObservation;
  switch (method) {
    case "task.resolve":
      data = {
        binding: binding(provider),
        capabilities: {
          create: true,
          continue: provider === "codex",
          resume: provider === "claude",
          message: false,
          cancel: false,
        },
      };
      break;
    case "task.create":
    case "task.continue":
    case "task.resume":
    case "task.message":
      data = { operationId: operationId!, taskId, receipt: receipt(provider) };
      break;
    case "task.observe":
      data = {
        taskId,
        binding: binding(provider),
        parentThreadId: "parent-thread",
        parentTurnId: "parent-turn",
        reference: receipt(provider).reference,
        lifecycle: "running",
        dispatchId,
        cancelRequested: false,
      };
      break;
    case "task.status":
    case "task.result":
      data = {
        taskId,
        dispatchId: request!.dispatchId as string,
        reference: receipt(provider).reference,
        lifecycle: "completed",
        pending: false,
        retained: true,
        text: method === "task.result" ? "retained answer 🍐" : "",
        resultEvidence: "task_journal",
        delivery: "not_observed",
      };
      break;
    case "task.operation.status":
      data = {
        operationId: request!.operationId as string,
        taskId,
        action: "create",
        lineage: receipt(provider).reference,
        receipt: receipt(provider),
      };
      break;
    case "task.observation.read":
      data = {
        taskId,
        dispatchId: request!.dispatchId as string,
        reference: receipt(provider).reference,
        events: [{ ...event(), dispatchId: request!.dispatchId as string }],
        next: {
          streamId: event().streamId,
          generation: event().generation,
          sequence: event().sequence,
        },
        gap: false,
        more: false,
        sourceGap: false,
        pending: request!.includeResult !== true,
        retained: request!.includeResult === true,
        lifecycle: request!.includeResult === true ? "completed" : "running",
        result: request!.includeResult === true ? "optional retained text" : "",
        resultEvidence: request!.includeResult === true ? "task_journal" : "",
        delivery: "unknown",
      };
      break;
    default:
      throw Error("controlled_method_not_selected");
  }
  return data as unknown as Json;
}
function fixture(
  change: (method: string, out: Outcome) => Outcome = (_method, out) => out,
  provider: "codex" | "claude" = "codex",
) {
  const context = { ...scope };
  const request = vi.fn<Client["request"]>(async (method, body, options = {}) =>
    change(method, {
      status: "ok",
      requestId: options.id!,
      context: { ...context },
      ...(options.operationId !== undefined
        ? { operationId: options.operationId }
        : {}),
      data: payload(method, body, options.operationId, provider),
    }),
  );
  const client = { request, verifiedContext: context } as unknown as Client;
  return { bridge: new TaskBridge(client, handle), request, client, context };
}
const calls = [
  {
    method: "resolve",
    wire: "task.resolve",
    shape: "TaskResolution",
    request: undefined,
    effect: false,
  },
  {
    method: "create",
    wire: "task.create",
    shape: "TaskMutation",
    request: { message: "source task" },
    effect: true,
  },
  {
    method: "continue",
    wire: "task.continue",
    shape: "TaskMutation",
    request: { dispatchId, message: "follow-up" },
    effect: true,
  },
  {
    method: "resume",
    wire: "task.resume",
    shape: "TaskMutation",
    request: { dispatchId, message: "resume" },
    effect: true,
  },
  {
    method: "message",
    wire: "task.message",
    shape: "TaskMutation",
    request: { dispatchId, message: "adjust active task" },
    effect: true,
  },
  {
    method: "observe",
    wire: "task.observe",
    shape: "TaskStatus",
    request: undefined,
    effect: false,
  },
  {
    method: "status",
    wire: "task.status",
    shape: "TaskDispatch",
    request: { dispatchId },
    effect: false,
  },
  {
    method: "result",
    wire: "task.result",
    shape: "TaskDispatch",
    request: { dispatchId },
    effect: false,
  },
  {
    method: "operationStatus",
    wire: "task.operation.status",
    shape: "TaskOperation",
    request: { operationId: dispatchId },
    effect: false,
  },
  {
    method: "observationRead",
    wire: "task.observation.read",
    shape: "TaskObservation",
    request: { dispatchId, limit: 1, includeResult: false },
    effect: false,
  },
] as const;
function invoke(bridge: TaskBridge, call: (typeof calls)[number]) {
  switch (call.method) {
    case "resolve":
      return bridge.resolve();
    case "create":
      return bridge.create(call.request, dispatchId);
    case "continue":
      return bridge.continue(call.request, "original-continue");
    case "resume":
      return bridge.resume(call.request, "original-resume");
    case "message":
      return bridge.message(call.request, "original-message");
    case "observe":
      return bridge.observe();
    case "status":
      return bridge.status(call.request);
    case "result":
      return bridge.result(call.request);
    case "operationStatus":
      return bridge.operationStatus(call.request);
    case "observationRead":
      return bridge.observationRead(call.request);
  }
}

// Real desktop Client + TaskBridge + framed in-memory peer, with fake time.
// The peer models a retained ACK/lineage; it is not Go journal/provider proof.
async function transportFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const sent: Request[] = [];
  const reply = (
    request: Request,
    status: Outcome["status"] = "ok",
    data: Json = payload(
      request.method,
      request.params.body,
      request.params.operationId,
      "codex",
    ),
  ) => {
    child.stdout.write(
      frame({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          status,
          requestId: request.id,
          context: scope,
          ...(request.params.operationId === undefined
            ? {}
            : { operationId: request.params.operationId }),
          ...(status === "unknown" ? { code: "TASK_OUTCOME_UNKNOWN" } : {}),
          data,
        },
      }),
    );
  };
  const decoder = new Decoder();
  child.stdin.on("data", (bytes: Buffer) => {
    decoder.push(bytes, (value) => {
      expect(validate("Request", value)).toBe(true);
      const request = value as Request;
      sent.push(request);
      if (request.method === "core.handshake") {
        reply(request, "ok", {
          protocolMajor,
          protocolMinor,
          buildId: "controlled-build",
          ...scope,
          capabilities: [],
          maxFrameBytes,
        });
      }
    });
  });
  const client = new Client(child as unknown as ChildProcessWithoutNullStreams);
  await client.handshake(
    {
      protocolMajor,
      protocolMinor,
      buildId: "controlled-build",
      profileId: scope.profileId,
    },
    1000,
  );
  return {
    client,
    bridge: new TaskBridge(client, handle),
    sent,
    reply,
    close: async () => {
      await client.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

describe("Task deadline mismatch with real desktop Client (controlled transport)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1760000000000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // A timely ACK fits the original 30 s transport/29 s Go budget. Go separately
  // verifies queue, execution and settlement using that exact wire timestamp.
  it.each(["create", "continue", "message"] as const)(
    "accepts a valid original %s ACK at 17 seconds without stopping shared observation",
    async (method) => {
      const f = await transportFixture();
      try {
        const operationId = `deadline-${method}`;
        const pending =
          method === "create"
            ? f.bridge.create({ message: "once" }, operationId)
            : f.bridge[method]({ dispatchId, message: "once" }, operationId);
        const settled = pending.then(
          (data) => ({ data }),
          (error: unknown) => ({ error }),
        );
        const original = f.sent.at(-1)!;
        expect(original.params.operationId).toBe(operationId);
        expect(original.params.body).toMatchObject({
          handleId: handle.handleId,
          deadlineMillis: "1760000029000",
          request: {
            ...(method !== "create" ? { dispatchId } : {}),
            message: "once",
          },
        });
        setTimeout(() => f.reply(original), 17000);
        await vi.advanceTimersByTimeAsync(2000);
        const observation = f.bridge.operationStatus({ operationId });
        const read = f.sent.at(-1)!;
        const observed = observation.then(
          (data) => ({ data }),
          (error: unknown) => ({ error }),
        );
        await vi.advanceTimersByTimeAsync(15000);
        expect(await settled).toEqual({
          data: { operationId, taskId, receipt: receipt() },
        });
        f.reply(read);
        expect(await observed).toMatchObject({
          data: { operationId, taskId },
        });
        expect(f.sent.map((request) => request.method)).toEqual([
          "core.handshake",
          `task.${method}`,
          "task.operation.status",
        ]);
      } finally {
        await f.close();
      }
    },
  );

  it("expires at the original transport deadline even when Client framing consumes time", async () => {
    const f = await transportFixture();
    let settled = false;
    try {
      const stringify = JSON.stringify;
      let frames = 0;
      vi.spyOn(JSON, "stringify").mockImplementation((value) => {
        if (value?.method === "task.create" && ++frames === 2)
          vi.advanceTimersByTime(5000);
        return stringify(value);
      });
      const pending = f.bridge.create({ message: "once" }, dispatchId);
      const outcome = pending.then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      expect(Date.now()).toBe(1760000005000);
      await vi.advanceTimersByTimeAsync(25000);
      // This assertion is the required absolute transport deadline, not a new
      // relative wait after the Client's own framing work.
      expect(settled).toBe(true);
      expect(await outcome).toMatchObject({
        state: "unknown",
        code: "response_timeout",
      });
      expect(() => f.client.verifiedContext).toThrow(BridgeError);
      expect(
        f.sent.filter((request) => request.method === "task.create"),
      ).toHaveLength(1);
    } finally {
      await vi.advanceTimersByTimeAsync(30000);
      await f.close();
    }
  });

  it("refuses an expired Task before write with a concrete not-sent error and preserves the Client and original unsent ID", async () => {
    const f = await transportFixture();
    try {
      const stringify = JSON.stringify;
      let frames = 0;
      let original: Request | undefined;
      const delayed = vi
        .spyOn(JSON, "stringify")
        .mockImplementation((value) => {
          if (value?.method === "task.create" && ++frames === 2) {
            original = value as Request;
            vi.advanceTimersByTime(30000);
          }
          return stringify(value);
        });
      const failure = await f.bridge
        .create({ message: "once" }, dispatchId)
        .catch((error: unknown) => error);
      delayed.mockRestore();
      expect(failure).toBeInstanceOf(RequestNotSentError);
      expect(failure).toMatchObject({
        state: "refused",
        code: "request_deadline_expired",
      });
      expect(original!.params.operationId).toBe(dispatchId);
      expect(original!.params.body).toHaveProperty(
        "deadlineMillis",
        "1760000029000",
      );
      expect(f.sent.map((request) => request.method)).toEqual([
        "core.handshake",
      ]);
      expect(f.client.verifiedContext).toEqual(scope);
      expect(vi.getTimerCount()).toBe(0);
      // Reusing the unsent caller ID for an explicit read proves that Client
      // did not consume it. No Task effect or new effect budget is retried.
      const read = f.client.request(
        "task.operation.status",
        { handleId: handle.handleId, request: { operationId: dispatchId } },
        { id: original!.id },
      );
      expect(f.sent.at(-1)!.id).toBe(original!.id);
      f.reply(f.sent.at(-1)!);
      await expect(read).resolves.toMatchObject({ requestId: original!.id });
      await expect(
        f.bridge.create({ message: "again" }, dispatchId),
      ).rejects.toMatchObject({ code: "task_operation_already_attempted" });
      expect(f.sent.map((request) => request.method)).toEqual([
        "core.handshake",
        "task.operation.status",
      ]);
    } finally {
      await f.close();
    }
  });

  it("keeps an existing shared read usable when absolute expiry occurs during another Client frame", async () => {
    const f = await transportFixture();
    try {
      const observed = f.bridge.operationStatus({ operationId: dispatchId });
      const read = f.sent.at(-1)!;
      const stringify = JSON.stringify;
      const delayed = vi
        .spyOn(JSON, "stringify")
        .mockImplementation((value) => {
          if (value?.id === "unsent-original") vi.advanceTimersByTime(5000);
          return stringify(value);
        });
      const failure = await f.client
        .request(
          "task.create",
          {
            handleId: handle.handleId,
            request: { message: "once" },
            deadlineMillis: "1760000029000",
          },
          {
            id: "unsent-original",
            operationId: dispatchId,
            timeoutMs: 30000,
            deadlineAtMillis: 1760000002000,
          },
        )
        .catch((error: unknown) => error);
      delayed.mockRestore();
      expect(failure).toBeInstanceOf(RequestNotSentError);
      expect(failure).toMatchObject({
        state: "refused",
        code: "request_deadline_expired",
      });
      expect(f.sent.map((request) => request.method)).toEqual([
        "core.handshake",
        "task.operation.status",
      ]);
      expect(vi.getTimerCount()).toBe(1);
      f.reply(read);
      await expect(observed).resolves.toHaveProperty("operationId", dispatchId);
      expect(f.client.verifiedContext).toEqual(scope);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1760000001000",
    null,
  ])(
    "refuses malformed absolute host deadline %s without writing or consuming its ID",
    async (deadlineAtMillis) => {
      const f = await transportFixture();
      try {
        const body = {
          handleId: handle.handleId,
          request: { operationId: dispatchId },
        };
        await expect(
          f.client.request("task.operation.status", body, {
            id: "original-read",
            deadlineAtMillis: deadlineAtMillis as number,
          }),
        ).rejects.toMatchObject({ state: "refused", code: "invalid_deadline" });
        expect(f.sent.map((request) => request.method)).toEqual([
          "core.handshake",
        ]);
        const pending = f.client.request("task.operation.status", body, {
          id: "original-read",
        });
        f.reply(f.sent.at(-1)!);
        await expect(pending).resolves.toMatchObject({
          requestId: "original-read",
        });
        expect(f.client.verifiedContext).toEqual(scope);
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    { timeoutMs: 1000, deadlineOffset: 10000, expiresAfter: 1000 },
    { timeoutMs: 10000, deadlineOffset: 1000, expiresAfter: 1000 },
    { timeoutMs: undefined, deadlineOffset: undefined, expiresAfter: 2000 },
  ])(
    "keeps the earlier relative/absolute timer and omitted default ($expiresAfter ms)",
    async ({ timeoutMs, deadlineOffset, expiresAfter }) => {
      const f = await transportFixture();
      try {
        const pending = f.client.request(
          "task.operation.status",
          { handleId: handle.handleId, request: { operationId: dispatchId } },
          {
            id: "original-read",
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(deadlineOffset === undefined
              ? {}
              : { deadlineAtMillis: Date.now() + deadlineOffset }),
          },
        );
        let settled = false;
        const failure = pending.catch((error: unknown) => {
          settled = true;
          return error;
        });
        await vi.advanceTimersByTimeAsync(expiresAfter - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await failure).toMatchObject({
          state: "unknown",
          code: "response_timeout",
        });
        expect(f.sent.at(-1)!.params).not.toHaveProperty("deadlineAtMillis");
        expect(f.sent.at(-1)!.params.body).not.toHaveProperty(
          "deadlineAtMillis",
        );
        expect(() => f.client.verifiedContext).toThrow(BridgeError);
      } finally {
        await f.close();
      }
    },
  );

  it("keeps the existing relative transport cap with an absolute host deadline", async () => {
    const f = await transportFixture();
    try {
      await expect(
        f.client.request(
          "task.operation.status",
          { handleId: handle.handleId, request: { operationId: dispatchId } },
          { timeoutMs: 30001, deadlineAtMillis: Date.now() + 1000 },
        ),
      ).rejects.toMatchObject({ state: "refused", code: "invalid_deadline" });
      expect(f.sent.map((request) => request.method)).toEqual([
        "core.handshake",
      ]);
      expect(f.client.verifiedContext).toEqual(scope);
    } finally {
      await f.close();
    }
  });

  it("keeps the read-only 16-second relative timer after framing when the absolute option is omitted", async () => {
    const f = await transportFixture();
    try {
      const stringify = JSON.stringify;
      let frames = 0;
      vi.spyOn(JSON, "stringify").mockImplementation((value) => {
        if (value?.method === "task.resolve" && ++frames === 2)
          vi.advanceTimersByTime(5000);
        return stringify(value);
      });
      const pending = f.bridge.resolve();
      let settled = false;
      const failure = pending.catch((error: unknown) => {
        settled = true;
        return error;
      });
      expect(Date.now()).toBe(1760000005000);
      expect(f.sent.at(-1)!.params.body).toEqual({ handleId: handle.handleId });
      await vi.advanceTimersByTimeAsync(15999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await failure).toMatchObject({
        state: "unknown",
        code: "response_timeout",
      });
    } finally {
      await f.close();
    }
  });

  it("counts local preparation against the original absolute budget instead of resetting at send", async () => {
    const f = fixture();
    Object.defineProperty(f.client, "verifiedContext", {
      get: () => {
        vi.advanceTimersByTime(5000);
        return scope;
      },
    });
    await f.bridge.create({ message: "once" }, dispatchId);
    expect(f.request.mock.calls[0]?.[1]).toEqual({
      handleId: handle.handleId,
      request: { message: "once" },
      deadlineMillis: "1760000029000",
    });
    expect(f.request.mock.calls[0]?.[2]).toMatchObject({
      operationId: dispatchId,
      timeoutMs: 25000,
      deadlineAtMillis: 1760000030000,
    });
  });

  it.each([27000, 30000, -1])(
    "refuses before transport when preparation consumes the execution window or the clock regresses (%s ms)",
    async (elapsed) => {
      const f = fixture();
      Object.defineProperty(f.client, "verifiedContext", {
        get: () => {
          vi.setSystemTime(1760000000000 + elapsed);
          return scope;
        },
      });
      await expect(
        f.bridge.create({ message: "once" }, dispatchId),
      ).rejects.toMatchObject({
        state: "refused",
        code: "task_deadline_invalid",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["TaskRoutedCreate", "TaskRoutedContinue", "TaskRoutedResume"])(
    "requires a closed decimal deadline only on %s",
    (shape) => {
      const request =
        shape === "TaskRoutedCreate"
          ? { message: "once" }
          : { dispatchId, message: "once" };
      const body = {
        handleId: handle.handleId,
        request,
        deadlineMillis: "1760000029000",
      };
      expect(validate(shape, body)).toBe(true);
      for (const value of [
        undefined,
        null,
        1760000029000,
        "",
        "01",
        "-1",
        "1.5",
        "NaN",
        "Infinity",
      ])
        expect(validate(shape, { ...body, deadlineMillis: value })).toBe(false);
      expect(validate(shape, { ...body, timeoutMs: 30000 })).toBe(false);
      expect(
        validate("TaskRoutedRequest", {
          handleId: handle.handleId,
          deadlineMillis: body.deadlineMillis,
        }),
      ).toBe(false);
    },
  );

  it("retains the final transport acknowledgement reserve after a Go reply at 29 seconds", async () => {
    const f = await transportFixture();
    try {
      const pending = f.bridge.create({ message: "once" }, dispatchId);
      const original = f.sent.at(-1)!;
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(29000);
      expect(settled).toBe(false);
      f.reply(original);
      await expect(pending).resolves.toMatchObject({
        operationId: dispatchId,
        taskId,
      });
      expect(f.client.verifiedContext).toEqual(scope);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("keeps a missing ACK unknown, stops pending shared observation and never replays", async () => {
    const f = await transportFixture();
    try {
      const pending = f.bridge.create({ message: "once" }, dispatchId);
      const original = f.sent.at(-1)!;
      const effectError = expect(pending).rejects.toMatchObject({
        state: "unknown",
        code: "response_timeout",
      });
      await vi.advanceTimersByTimeAsync(1000);
      // Start the shared read later, with a deadline beyond every permitted
      // effect wait (Client caps those at 30 seconds). Its rejection must come
      // from the effect stopping the shared Client, not its own read timer.
      const observation = f.client.request(
        "task.operation.status",
        { handleId: handle.handleId, request: { operationId: dispatchId } },
        { timeoutMs: 30000 },
      );
      const observationError = expect(observation).rejects.toMatchObject({
        state: "unknown",
        code: "response_timeout",
      });
      await vi.advanceTimersByTimeAsync(29000);
      await effectError;
      await observationError;
      // A late valid ACK is not new authority and cannot reopen this Client.
      f.reply(original);
      await expect(
        f.bridge.create({ message: "again" }, dispatchId),
      ).rejects.toMatchObject({
        state: "unavailable",
        code: "backend_unavailable",
      });
      expect(f.sent.map((request) => request.method)).toEqual([
        "core.handshake",
        "task.create",
        "task.operation.status",
      ]);
      expect(original.params.operationId).toBe(dispatchId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("retains a lost provider ACK as unknown with original partial lineage and explicit observation", async () => {
    const f = await transportFixture();
    try {
      const pending = f.bridge.create({ message: "once" }, dispatchId);
      const original = f.sent.at(-1)!;
      const data: TaskMutation = {
        operationId: dispatchId,
        taskId,
        receipt: {
          state: "outcome_unknown",
          code: "CODEX_TASK_OUTCOME_UNKNOWN",
          reference: { threadId: "original-partial-thread" },
          result: "",
          cancelRequested: false,
        },
      };
      const unknown = expect(pending).rejects.toMatchObject({
        state: "unknown",
        code: "TASK_OUTCOME_UNKNOWN",
        data,
      });
      setTimeout(
        () => f.reply(original, "unknown", data as unknown as Json),
        15000,
      );
      await vi.advanceTimersByTimeAsync(15000);
      await unknown;
      await expect(
        f.bridge.create({ message: "again" }, dispatchId),
      ).rejects.toMatchObject({
        state: "unknown",
        code: "task_operation_already_attempted",
      });
      const observation = f.bridge.operationStatus({ operationId: dispatchId });
      const read = f.sent.at(-1)!;
      const retained = payload(
        read.method,
        read.params.body,
        undefined,
        "codex",
      ) as unknown as TaskOperation;
      f.reply(read, "ok", {
        ...retained,
        lineage: data.receipt.reference,
        receipt: data.receipt,
      } as unknown as Json);
      await expect(observation).resolves.toMatchObject({
        operationId: dispatchId,
        taskId,
        lineage: data.receipt.reference,
        receipt: data.receipt,
      });
      expect(read.params).not.toHaveProperty("operationId");
      expect(f.sent.map((request) => request.method)).toEqual([
        "core.handshake",
        "task.create",
        "task.operation.status",
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });
});

describe("opaque routed Task bridge", () => {
  it.each(["provider", "modelAlias", "model", "configDigest", "writer"])(
    "fences a changed Go-selected binding %s on the same handle",
    async (field) => {
      const f = fixture((method, out) => {
        if (method !== "task.observe") return out;
        const data = out.data as unknown as TaskStatus;
        return {
          ...out,
          data: {
            ...data,
            binding: {
              ...data.binding,
              [field]:
                field === "provider"
                  ? "claude"
                  : field === "writer"
                    ? { ...data.binding.writer, inode: "99" }
                    : "changed",
            },
          } as unknown as Json,
        };
      });
      await f.bridge.resolve();
      await expect(f.bridge.observe()).rejects.toMatchObject({
        state: "unknown",
        code: "task_response_crossed",
      });
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it("keeps an immutable correlation fingerprint when returned binding fields are changed by the caller", async () => {
    const f = fixture();
    const resolved = await f.bridge.resolve();
    Object.assign(resolved.binding, { model: "changed-by-caller" });
    Object.assign(resolved.binding.writer, { inode: "99" });
    await expect(f.bridge.observe()).resolves.toHaveProperty("taskId", taskId);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("rejects a delayed duplicate effect reply on an explicit read without dispatching again", async () => {
    let original!: Outcome;
    const f = fixture((method, out) => {
      if (method === "task.create") {
        original = out;
        return out;
      }
      return original;
    });
    await f.bridge.create({ message: "once" }, dispatchId);
    await expect(
      f.bridge.operationStatus({ operationId: dispatchId }),
    ).rejects.toMatchObject({
      state: "unknown",
      code: "task_response_context",
    });
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      "task.create",
      "task.operation.status",
    ]);
    expect(f.request.mock.calls[1]?.[2]).not.toHaveProperty("operationId");
  });
  it("copies a validated unknown receipt before exposing partial lineage in an error", async () => {
    let original!: TaskMutation;
    const f = fixture((_method, out) => {
      original = {
        ...(out.data as unknown as TaskMutation),
        receipt: {
          state: "outcome_unknown",
          code: "TASK_OUTCOME_UNKNOWN",
          reference: { sessionId: "partial session" },
          result: "",
          cancelRequested: false,
        },
      };
      return {
        ...out,
        status: "unknown",
        code: "TASK_OUTCOME_UNKNOWN",
        data: original as unknown as Json,
      };
    }, "claude");
    let error!: TaskBridgeError;
    try {
      await f.bridge.create({ message: "once" }, dispatchId);
    } catch (caught) {
      expect(caught).toBeInstanceOf(TaskBridgeError);
      error = caught as TaskBridgeError;
    }
    Object.assign(original.receipt.reference, { sessionId: "changed" });
    expect(error.data).toMatchObject({
      receipt: { reference: { sessionId: "partial session" } },
    });
    expect(error.state).toBe("unknown");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("validates each retained read body instead of allowing extra route authority", async () => {
    const f = fixture();
    await expect(
      f.bridge.status({ dispatchId, ownerId: "other" } as never),
    ).rejects.toMatchObject({ state: "refused" });
    await expect(
      f.bridge.result({ dispatchId, handleId: "other" } as never),
    ).rejects.toMatchObject({ state: "refused" });
    await expect(
      f.bridge.operationStatus({
        operationId: dispatchId,
        provider: "claude",
      } as never),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("returns requested retained observation text with original evidence and delivery uncertainty", async () => {
    const f = fixture();
    const out = await f.bridge.observationRead({
      dispatchId,
      includeResult: true,
    });
    expect(out).toMatchObject({
      pending: false,
      retained: true,
      lifecycle: "completed",
      result: "optional retained text",
      resultEvidence: "task_journal",
      delivery: "unknown",
    });
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      "task.observation.read",
    ]);
    expect(f.request.mock.calls[0]?.[2]).not.toHaveProperty("operationId");
  });
  it.each(calls)(
    "routes $wire through the original selected handle with its canonical envelope",
    async (call) => {
      const f = fixture();
      const data = await invoke(f.bridge, call);
      expect(validate(call.shape, data)).toBe(true);
      expect(f.request).toHaveBeenCalledTimes(1);
      const sent = f.request.mock.calls[0]!;
      expect(sent[0]).toBe(call.wire);
      expect(sent[1]).toEqual({
        handleId: handle.handleId,
        ...(call.request === undefined ? {} : { request: call.request }),
        ...(call.effect ? { deadlineMillis: expect.any(String) } : {}),
      });
      expect(requiresOperationID(call.wire)).toBe(call.effect);
      if (call.effect) {
        expect(sent[2]?.timeoutMs).toBeGreaterThan(27000);
        expect(sent[2]?.timeoutMs).toBeLessThanOrEqual(30000);
        expect(sent[2]?.deadlineAtMillis).toBe(
          Number((sent[1] as { deadlineMillis: string }).deadlineMillis) + 1000,
        );
        expect(sent[2]?.operationId).toBe(
          call.method === "create" ? dispatchId : `original-${call.method}`,
        );
        expect((data as TaskMutation).operationId).toBe(sent[2]?.operationId);
      } else {
        expect(sent[2]).not.toHaveProperty("operationId");
        expect(sent[2]).not.toHaveProperty("deadlineAtMillis");
        expect(sent[2]?.timeoutMs).toBe(16000);
      }
      expect(
        frame({
          jsonrpc: "2.0",
          id: sent[2]?.id,
          method: sent[0],
          params: {
            body: sent[1],
            context: scope,
            ...(call.effect ? { operationId: sent[2]?.operationId } : {}),
          },
        }).readUInt32BE(),
      ).toBeLessThanOrEqual(maxFrameBytes);
    },
  );
  it.each(["codex", "claude"] as const)(
    "preserves selected %s binding/capabilities and provider-specific references",
    async (provider) => {
      const f = fixture((_method, out) => out, provider);
      const resolved = await f.bridge.resolve();
      expect(resolved.binding).toEqual(binding(provider));
      expect(resolved.capabilities).toEqual({
        create: true,
        continue: provider === "codex",
        resume: provider === "claude",
        message: false,
        cancel: false,
      });
      const created = await f.bridge.create(
        { message: "selected vocabulary" },
        dispatchId,
      );
      expect(created.receipt.reference).toEqual(receipt(provider).reference);
      expect(f.request.mock.calls.map((c) => c[0])).toEqual([
        "task.resolve",
        "task.create",
      ]);
      for (const name of ["select", "cancel", "deliver", "reconnect"])
        expect(Object.hasOwn(TaskBridge.prototype, name)).toBe(false);
      expect(Object.hasOwn(TaskBridge.prototype, "message")).toBe(true);
    },
  );
  it.each(["requestId", "operationId", "profileId", "backendGeneration"])(
    "rejects crossed common %s without another request",
    async (field) => {
      const f = fixture((_method, out) =>
        field === "profileId" || field === "backendGeneration"
          ? { ...out, context: { ...out.context, [field]: "other" } }
          : { ...out, [field]: "other" },
      );
      await expect(
        f.bridge.create({ message: "once" }, dispatchId),
      ).rejects.toMatchObject({
        state: "unknown",
        code: "task_response_context",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a nested effect operation mismatch even when the common outcome matches", async () => {
    const f = fixture((_method, out) => ({
      ...out,
      data: { ...(out.data as object), operationId: "replacement" } as Json,
    }));
    await expect(
      f.bridge.create({ message: "once" }, dispatchId),
    ).rejects.toMatchObject({ code: "task_response_crossed" });
    await expect(
      f.bridge.create({ message: "once" }, dispatchId),
    ).rejects.toMatchObject({ code: "task_operation_already_attempted" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "refused", "unavailable", "unsupported"] as const)(
    "keeps %s with validated partial lineage and never redispatches",
    async (status) => {
      const f = fixture((_method, out) => {
        const value = out.data as unknown as TaskMutation;
        const { lifecycle: _lifecycle, ...rest } = value.receipt;
        return {
          ...out,
          status,
          code: "TASK_OUTCOME_UNKNOWN",
          data: {
            ...value,
            receipt: {
              ...rest,
              state: status === "refused" ? "refused" : "outcome_unknown",
              code: "TASK_OUTCOME_UNKNOWN",
              reference: { threadId: "partial original thread" },
            },
          } as unknown as Json,
        };
      });
      let caught: unknown;
      try {
        await f.bridge.create({ message: "once" }, dispatchId);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TaskBridgeError);
      expect(caught).toMatchObject({
        state: status,
        code: "TASK_OUTCOME_UNKNOWN",
        data: {
          operationId: dispatchId,
          taskId,
          receipt: { reference: { threadId: "partial original thread" } },
        },
      });
      expect((caught as TaskBridgeError).data).not.toHaveProperty(
        "receipt.lifecycle",
      );
      await expect(
        f.bridge.create({ message: "changed payload" }, dispatchId),
      ).rejects.toMatchObject({ code: "task_operation_already_attempted" });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["unknown", "refused", "unavailable", "unsupported"] as const)(
    "preserves data-free %s as a Task error without inventing lineage",
    async (status) => {
      const f = fixture((_method, out) => {
        const { data: _data, ...rest } = out;
        return { ...rest, status, code: "TASK_UNAVAILABLE" };
      });
      await expect(f.bridge.resolve()).rejects.toMatchObject({
        state: status,
        code: "TASK_UNAVAILABLE",
        data: undefined,
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("consumes an in-flight duplicate stable effect across methods before a second Client call", async () => {
    const f = fixture();
    const first = f.bridge.create({ message: "once" }, dispatchId);
    await expect(
      f.bridge.resume({ dispatchId, message: "same id" }, dispatchId),
    ).rejects.toMatchObject({ code: "task_operation_already_attempted" });
    await first;
    await expect(
      f.bridge.create({ message: "once" }, dispatchId),
    ).rejects.toMatchObject({ code: "task_operation_already_attempted" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("does not replay Message after a lost ACK or a retained operation read", async () => {
    const f = fixture();
    const lost = new BridgeError("unknown", "response_timeout");
    f.request.mockRejectedValueOnce(lost);
    const request = { dispatchId, message: "one active adjustment" };
    await expect(f.bridge.message(request, "steer-once")).rejects.toBe(lost);
    await f.bridge.operationStatus({ operationId: "steer-once" });
    await expect(f.bridge.message(request, "steer-once")).rejects.toMatchObject(
      { code: "task_operation_already_attempted" },
    );
    await expect(
      f.bridge.create({ message: "replacement" }, "steer-once"),
    ).rejects.toMatchObject({ code: "task_operation_already_attempted" });
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      "task.message",
      "task.operation.status",
    ]);
  });
  it.each([
    { lifecycle: "completed" },
    { result: "invented completion" },
    { cancelRequested: true },
    { reference: { threadId: "thread@provider" } },
    { reference: { sessionId: "claude@provider", invocationId: "invocation" } },
  ])(
    "rejects a known Message ACK that claims other semantics: %j",
    async (changed) => {
      const f = fixture((_method, out) => ({
        ...out,
        data: {
          ...(out.data as unknown as TaskMutation),
          receipt: { ...receipt(), ...changed },
        } as unknown as Json,
      }));
      await expect(
        f.bridge.message({ dispatchId, message: "adjust" }, "steer"),
      ).rejects.toMatchObject({
        state: "unknown",
        code: "task_response_crossed",
      });
      await expect(
        f.bridge.message({ dispatchId, message: "adjust" }, "steer"),
      ).rejects.toMatchObject({ code: "task_operation_already_attempted" });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["a".repeat(8193), "🍐".repeat(2049), ""])(
    "rejects unbounded active input before consuming an operation",
    async (message) => {
      const f = fixture();
      await expect(
        f.bridge.message({ dispatchId, message }, "bounded-steer"),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.request).not.toHaveBeenCalled();
      await expect(
        f.bridge.message(
          { dispatchId, message: "corrected bounded input" },
          "bounded-steer",
        ),
      ).resolves.toHaveProperty("receipt");
    },
  );
  it("does not turn a lost reply or explicit retained observation into a second effect", async () => {
    const f = fixture();
    const lost = new BridgeError("unknown", "response_timeout");
    f.request.mockRejectedValueOnce(lost);
    await expect(f.bridge.create({ message: "once" }, dispatchId)).rejects.toBe(
      lost,
    );
    expect(f.request).toHaveBeenCalledTimes(1);
    await expect(
      f.bridge.operationStatus({ operationId: dispatchId }),
    ).resolves.toMatchObject({ operationId: dispatchId });
    await expect(f.bridge.observe()).resolves.toHaveProperty("lifecycle");
    await expect(
      f.bridge.create({ message: "once" }, dispatchId),
    ).rejects.toMatchObject({ code: "task_operation_already_attempted" });
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      "task.create",
      "task.operation.status",
      "task.observe",
    ]);
    expect(
      f.request.mock.calls
        .slice(1)
        .every((c) => c[2]?.operationId === undefined),
    ).toBe(true);
  });
  it.each(["", "invalid id", "a".repeat(129), undefined])(
    "requires a caller-supplied valid stable effect ID before admission",
    async (operationId) => {
      const f = fixture();
      await expect(
        f.bridge.create({ message: "once" }, operationId as string),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each([
    "ownerId",
    "taskId",
    "taskEpoch",
    "provider",
    "model",
    "modelAlias",
    "configDigest",
    "grant",
    "root",
    "operationId",
    "handleId",
  ])(
    "rejects nested %s authority instead of selecting a provider",
    async (field) => {
      const f = fixture();
      await expect(
        f.bridge.create(
          { message: "once", [field]: "injected" } as TaskCreate,
          dispatchId,
        ),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("rejects invalid handles and snapshots the trusted handle before caller mutation", async () => {
    const f = fixture();
    expect(
      () =>
        new TaskBridge(f.client, {
          ...handle,
          ownerId: "injected",
        } as TaskHandle),
    ).toThrow(BridgeError);
    expect(() => new TaskBridge(f.client, { handleId: "" })).toThrow(
      BridgeError,
    );
    const actual = { ...handle };
    const bridge = new TaskBridge(f.client, actual);
    actual.handleId = "changed";
    await bridge.resolve();
    expect(f.request.mock.calls[0]?.[1]).toEqual(handle);
  });
  it.each(["profileId", "backendGeneration"])(
    "fences a changed verified %s before transport without selecting a replacement channel",
    async (field) => {
      const f = fixture();
      f.context[field as keyof typeof scope] = "other";
      await expect(
        f.bridge.create({ message: "once" }, dispatchId),
      ).rejects.toMatchObject({
        state: "refused",
        code: "task_context_changed",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("copies nested request and cursor before an await, and copies the returned payload", async () => {
    let original!: Outcome;
    const f = fixture((_method, out) => {
      original = out;
      return out;
    });
    const request: TaskObservationRequest = {
      dispatchId,
      cursor: {
        streamId: "stream@task",
        generation: event().generation,
        sequence: "9007199254740992",
      },
      includeResult: false,
      limit: 1,
    };
    const promise = f.bridge.observationRead(request);
    Object.assign(request.cursor!, { streamId: "changed", generation: "1" });
    Object.assign(request, { dispatchId: "changed", includeResult: true });
    const out = await promise;
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({
      request: {
        dispatchId,
        includeResult: false,
        cursor: { streamId: "stream@task", generation: event().generation },
      },
    });
    Object.assign((original.data as unknown as TaskObservation).next, {
      sequence: "0",
    });
    Object.assign((original.data as unknown as TaskObservation).events[0]!, {
      eventId: "changed",
    });
    expect(out.next.sequence).toBe(event().sequence);
    expect(out.events[0]?.eventId).toBe("event-1");
  });
  it("copies an original mutation message before caller input changes", async () => {
    const f = fixture();
    const request = { message: "original" };
    const pending = f.bridge.create(request, dispatchId);
    request.message = "changed";
    await pending;
    expect(f.request.mock.calls[0]?.[1]).toEqual({
      handleId: handle.handleId,
      request: { message: "original" },
      deadlineMillis: expect.any(String),
    });
  });
  it.each([
    { name: "ASCII max", message: "a".repeat(65536) },
    { name: "UTF-8 max", message: "🍐".repeat(16384) },
    { name: "escaped max", message: "\u0001".repeat(65536) },
  ])(
    "accepts $name with bounded original bytes and full envelope",
    async ({ message }) => {
      const f = fixture();
      await expect(
        f.bridge.create({ message }, dispatchId),
      ).resolves.toHaveProperty("receipt");
      const sent = f.request.mock.calls[0]!;
      const bytes = frame({
        jsonrpc: "2.0",
        id: sent[2]?.id,
        method: sent[0],
        params: { body: sent[1], context: scope, operationId: dispatchId },
      });
      expect(bytes.readUInt32BE()).toBe(bytes.length - 4);
      expect(bytes.length - 4).toBeLessThanOrEqual(maxFrameBytes);
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { name: "empty", message: "" },
    { name: "ASCII overflow", message: "a".repeat(65537) },
    { name: "UTF-8 overflow", message: "🍐".repeat(16385) },
    { name: "lone surrogate", message: "\ud800" },
  ])(
    "refuses $name input before consuming an effect ID",
    async ({ message }) => {
      const f = fixture();
      await expect(
        f.bridge.create({ message }, dispatchId),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.request).not.toHaveBeenCalled();
      await expect(
        f.bridge.create(
          { message: "corrected bounded source input" },
          dispatchId,
        ),
      ).resolves.toHaveProperty("receipt");
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["continue", "resume", "message"] as const)(
    "validates the original %s body without new authority fields",
    async (method) => {
      const f = fixture();
      for (const request of [
        { dispatchId: "", message: "x" },
        { dispatchId, message: "" },
        { dispatchId, message: "x", provider: "claude" },
      ]) {
        await expect(
          f.bridge[method](request as TaskContinue | TaskResume, "follow-up"),
        ).rejects.toMatchObject({ state: "refused" });
      }
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each(["dispatch", "operation", "binding-profile", "task"])(
    "fences crossed %s result correlation",
    async (kind) => {
      const f = fixture((method, out) => {
        if (method === "task.create") return out;
        const data = out.data as Record<string, Json>;
        if (kind === "binding-profile")
          return {
            ...out,
            data: {
              ...data,
              binding: { ...(data.binding as object), profileId: "other" },
            } as Json,
          };
        return {
          ...out,
          data: {
            ...data,
            [kind === "dispatch"
              ? "dispatchId"
              : kind === "operation"
                ? "operationId"
                : "taskId"]: "other",
          },
        };
      });
      await f.bridge.create({ message: "bind original task" }, dispatchId);
      const result =
        kind === "operation"
          ? f.bridge.operationStatus({ operationId: dispatchId })
          : kind === "binding-profile"
            ? f.bridge.observe()
            : f.bridge.result({ dispatchId });
      await expect(result).rejects.toMatchObject({
        state: "unknown",
        code: "task_response_crossed",
      });
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    "extra",
    "invented-state",
    "invalid-json-value",
    "oversized-text",
    "missing",
  ])(
    "rejects %s positive payload without manufacturing success",
    async (kind) => {
      const f = fixture((_method, out) => {
        if (kind === "missing") {
          const { data: _data, ...rest } = out;
          return rest;
        }
        const data = out.data as unknown as TaskMutation;
        return {
          ...out,
          data:
            kind === "extra"
              ? ({ ...data, grant: "invented" } as unknown as Json)
              : kind === "oversized-text"
                ? ({
                    ...data,
                    receipt: { ...data.receipt, result: "a".repeat(65537) },
                  } as unknown as Json)
                : kind === "invented-state"
                  ? ({
                      ...data,
                      receipt: { ...data.receipt, state: "retryable" },
                    } as unknown as Json)
                  : (Number.NaN as unknown as Json),
        };
      });
      await expect(
        f.bridge.create({ message: "once" }, dispatchId),
      ).rejects.toMatchObject({ state: "unknown" });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("never exposes malformed or crossed partial error data", async () => {
    const f = fixture((_method, out) => ({
      ...out,
      status: "unknown",
      code: "TASK_OUTCOME_UNKNOWN",
      data: { ...(out.data as object), operationId: "other" } as Json,
    }));
    await expect(
      f.bridge.create({ message: "once" }, dispatchId),
    ).rejects.toMatchObject({
      state: "unknown",
      code: "task_response_crossed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    "limit-zero",
    "limit-overflow",
    "authority",
    "numeric-generation",
    "unsafe-generation",
  ])("rejects invalid observation %s before any read", async (kind) => {
    const f = fixture();
    const request =
      kind === "limit-zero"
        ? { dispatchId, limit: 0 }
        : kind === "limit-overflow"
          ? { dispatchId, limit: 33 }
          : kind === "authority"
            ? { dispatchId, root: "/" }
            : {
                dispatchId,
                cursor: {
                  streamId: "stream@task",
                  generation:
                    kind === "numeric-generation" ? 1 : "18446744073709551616",
                  sequence: "0",
                },
              };
    await expect(
      f.bridge.observationRead(request as TaskObservationRequest),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    "runId",
    "dispatchId",
    "streamId",
    "generation",
    "sparse",
    "over-page",
    "cursor",
    "private-result",
  ])(
    "fences crossed retained observation %s without provider polling",
    async (kind) => {
      const f = fixture((_method, out) => {
        const data = out.data as unknown as TaskObservation;
        return {
          ...out,
          data: {
            ...data,
            ...(kind === "private-result"
              ? { result: "unrequested private output" }
              : {}),
            ...(kind === "cursor"
              ? { next: { ...data.next, generation: "1" } }
              : {}),
            events:
              kind === "sparse"
                ? Array(1)
                : kind === "over-page"
                  ? [event(), { ...event(), eventId: "event-2" }]
                  : [
                      {
                        ...event(),
                        ...(kind === "runId" ||
                        kind === "dispatchId" ||
                        kind === "streamId" ||
                        kind === "generation"
                          ? { [kind]: kind === "generation" ? "1" : "other" }
                          : {}),
                      },
                    ],
          } as unknown as Json,
        };
      });
      await expect(
        f.bridge.observationRead({
          dispatchId,
          limit: 1,
          cursor: {
            streamId: "stream@task",
            generation: event().generation,
            sequence: "0",
          },
        }),
      ).rejects.toMatchObject({
        state: "unknown",
        code: "task_response_crossed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves provider-terminal metadata before final observation without turning it into retention or parent ACK", async () => {
    const f = fixture((_method, out) => {
      const data = out.data as unknown as TaskObservation;
      return {
        ...out,
        data: {
          ...data,
          pending: true,
          retained: false,
          lifecycle: "outcome_unknown",
          delivery: "unknown",
          events: [
            {
              ...event(),
              kind: "provider_terminal",
              reportedLifecycle: "completed",
            },
          ],
        } as unknown as Json,
      };
    });
    const out = await f.bridge.observationRead({ dispatchId });
    expect(out).toMatchObject({
      pending: true,
      retained: false,
      lifecycle: "outcome_unknown",
      resultEvidence: "",
      result: "",
      delivery: "unknown",
    });
    expect(out.events[0]?.reportedLifecycle).toBe("completed");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("preserves a declared cursor gap without retrying a fresh snapshot or changing generations", async () => {
    const f = fixture((_method, out) => ({
      ...out,
      data: {
        ...(out.data as object),
        gap: true,
        events: [],
        more: false,
        sourceGap: true,
      } as Json,
    }));
    const out = await f.bridge.observationRead({
      dispatchId,
      cursor: { streamId: "stale-stream", generation: "1", sequence: "4" },
    });
    expect(out).toMatchObject({
      gap: true,
      sourceGap: true,
      next: { generation: event().generation },
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("bounds the complete reply frame before returning a schema-valid oversized payload", async () => {
    const f = fixture((_method, out) => {
      const data = out.data as unknown as TaskObservation;
      const escaped = "\u0001".repeat(128);
      const rich: TaskEvent = {
        ...event(),
        runId: escaped,
        streamId: escaped,
        eventId: escaped,
        itemId: escaped,
        reference: {
          threadId: escaped,
          turnId: escaped,
          sessionId: escaped,
          invocationId: escaped,
        },
      };
      const value = {
        ...data,
        taskId: escaped,
        next: { ...data.next, streamId: escaped },
        result: "\u0001".repeat(65536),
        events: Array.from({ length: 128 }, () => ({ ...rich })),
      };
      expect(validate("TaskObservation", value)).toBe(true);
      expect(
        Buffer.byteLength(
          JSON.stringify({
            jsonrpc: "2.0",
            id: out.requestId,
            result: { ...out, data: value },
          }),
        ),
      ).toBeGreaterThan(maxFrameBytes);
      return { ...out, data: value as unknown as Json };
    });
    await expect(
      f.bridge.observationRead({ dispatchId, includeResult: true }),
    ).rejects.toMatchObject({
      state: "unknown",
      code: "task_response_frame_invalid",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("keeps status metadata empty and never automatically acknowledges retained result delivery", async () => {
    const f = fixture();
    const status = await f.bridge.status({ dispatchId });
    expect(status.text).toBe("");
    const result = await f.bridge.result({ dispatchId });
    expect(result.text).toBe("retained answer 🍐");
    expect(result.delivery).toBe("not_observed");
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      "task.status",
      "task.result",
    ]);
  });
});
