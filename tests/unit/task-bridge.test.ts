import { describe, expect, it, vi } from "vitest";
import { TaskBridge, TaskBridgeError } from "../../apps/desktop/bridge/task.ts";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client.ts";
import { frame } from "../../apps/desktop/bridge/frame.ts";
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
      });
      expect(requiresOperationID(call.wire)).toBe(call.effect);
      if (call.effect) {
        expect(sent[2]?.operationId).toBe(
          call.method === "create" ? dispatchId : `original-${call.method}`,
        );
        expect((data as TaskMutation).operationId).toBe(sent[2]?.operationId);
      } else expect(sent[2]).not.toHaveProperty("operationId");
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
      for (const name of [
        "select",
        "message",
        "cancel",
        "deliver",
        "reconnect",
      ])
        expect(Object.hasOwn(TaskBridge.prototype, name)).toBe(false);
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
  it.each(["continue", "resume"] as const)(
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
