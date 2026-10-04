import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, type Client } from "./client.ts";
import { frame } from "./frame.ts";
import {
  validate,
  type Context,
  type Json,
  type TaskHandle,
  type TaskBinding,
  type TaskCreate,
  type TaskContinue,
  type TaskResume,
  type TaskDispatchRequest,
  type TaskOperationRequest,
  type TaskObservationRequest,
  type TaskResolution,
  type TaskMutation,
  type TaskStatus,
  type TaskDispatch,
  type TaskOperation,
  type TaskObservation,
} from "./wire.ts";

type TaskResponse =
  | TaskResolution
  | TaskMutation
  | TaskStatus
  | TaskDispatch
  | TaskOperation
  | TaskObservation;
type TaskRequest =
  | TaskCreate
  | TaskContinue
  | TaskResume
  | TaskDispatchRequest
  | TaskOperationRequest
  | TaskObservationRequest;

// Go may return a retained mutation with partial lineage on unknown/refused.
// Keep that validated data while preserving the actual transport state/code.
export class TaskBridgeError extends BridgeError {
  constructor(
    state: BridgeError["state"],
    code: string,
    readonly data?: TaskResponse,
  ) {
    super(state, code);
  }
}

// Trusted host transport only. Root supplies the opaque selected handle and
// verified Client; Go retains the original Task owner/client, policy and state.
// No provider selection, native activation, delivery ACK or recovery dispatch.
export class TaskBridge {
  private readonly handle: TaskHandle;
  private readonly context: Context;
  private readonly attempted = new Set<string>();
  // Correlation witness only; no admission, lifecycle or provider state cache.
  private taskId: string | undefined;
  private binding: TaskBinding | undefined;

  constructor(
    private readonly client: Client,
    handle: TaskHandle,
  ) {
    if (!validate("TaskHandle", handle))
      throw new BridgeError("refused", "task_handle_invalid");
    this.handle = { ...handle };
    this.context = { ...client.verifiedContext };
    if (!validate("Context", this.context))
      throw new BridgeError("refused", "task_context_invalid");
  }

  resolve(): Promise<TaskResolution> {
    return this.call(
      "resolve",
      "TaskRoutedRequest",
      undefined,
      "TaskResolution",
    );
  }
  create(request: TaskCreate, operationId: string): Promise<TaskMutation> {
    return this.call(
      "create",
      "TaskRoutedCreate",
      request,
      "TaskMutation",
      operationId,
    );
  }
  continue(request: TaskContinue, operationId: string): Promise<TaskMutation> {
    return this.call(
      "continue",
      "TaskRoutedContinue",
      request,
      "TaskMutation",
      operationId,
    );
  }
  resume(request: TaskResume, operationId: string): Promise<TaskMutation> {
    return this.call(
      "resume",
      "TaskRoutedResume",
      request,
      "TaskMutation",
      operationId,
    );
  }
  observe(): Promise<TaskStatus> {
    return this.call("observe", "TaskRoutedRequest", undefined, "TaskStatus");
  }
  status(request: TaskDispatchRequest): Promise<TaskDispatch> {
    return this.call(
      "status",
      "TaskRoutedDispatchRequest",
      request,
      "TaskDispatch",
    );
  }
  result(request: TaskDispatchRequest): Promise<TaskDispatch> {
    return this.call(
      "result",
      "TaskRoutedDispatchRequest",
      request,
      "TaskDispatch",
    );
  }
  operationStatus(request: TaskOperationRequest): Promise<TaskOperation> {
    return this.call(
      "operation.status",
      "TaskRoutedOperationRequest",
      request,
      "TaskOperation",
    );
  }
  observationRead(request: TaskObservationRequest): Promise<TaskObservation> {
    return this.call(
      "observation.read",
      "TaskRoutedObservationRequest",
      request,
      "TaskObservation",
    );
  }

  private async call<T extends TaskResponse>(
    method: string,
    inputShape: string,
    request: TaskRequest | undefined,
    outputShape: string,
    operationId?: string,
  ): Promise<T> {
    const effect =
      method === "create" || method === "continue" || method === "resume";
    const input = {
      handleId: this.handle.handleId,
      ...(request === undefined ? {} : { request }),
    };
    if (
      !validate(inputShape, input) ||
      (effect && !validate("id", operationId))
    )
      throw new BridgeError("refused", "task_request_invalid");
    const selected = structuredClone(input);
    const context = { ...this.client.verifiedContext };
    if (
      !validate("Context", context) ||
      context.profileId !== this.context.profileId ||
      context.backendGeneration !== this.context.backendGeneration
    )
      throw new BridgeError("refused", "task_context_changed");
    const id = randomUUID();
    const envelope = {
      jsonrpc: "2.0",
      id,
      method: `task.${method}`,
      params: { body: selected, context, ...(effect ? { operationId } : {}) },
    };
    if (!validate("Request", envelope))
      throw new BridgeError("refused", "task_request_invalid");
    try {
      frame(envelope);
    } catch {
      throw new BridgeError("refused", "task_request_frame_invalid");
    }
    if (effect) {
      if (this.attempted.has(operationId!))
        throw new BridgeError("unknown", "task_operation_already_attempted");
      // Consume before the request, including refusal, timeout or a lost reply.
      // Keep only the effect ID, never a message, result or provider transcript.
      this.attempted.add(operationId!);
    }
    const outcome = await this.client.request(
      envelope.method,
      selected as unknown as Json,
      {
        id,
        ...(effect ? { operationId: operationId! } : {}),
        timeoutMs: 16000,
      },
    );
    if (
      !validate("Outcome", outcome) ||
      outcome.requestId !== id ||
      outcome.operationId !== operationId ||
      outcome.context.profileId !== context.profileId ||
      outcome.context.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError("unknown", "task_response_context");
    try {
      frame({ jsonrpc: "2.0", id, result: outcome });
    } catch {
      throw new BridgeError("unknown", "task_response_frame_invalid");
    }
    let data: T | undefined;
    if (outcome.data !== undefined) {
      if (!validate(outputShape, outcome.data))
        throw new BridgeError("unknown", "task_response_invalid");
      data = structuredClone(outcome.data) as unknown as T;
      this.correlate(method, selected.request, data, operationId);
    }
    if (outcome.status !== "ok")
      throw new TaskBridgeError(
        outcome.status,
        outcome.code ?? "task_request_failed",
        data,
      );
    if (data === undefined)
      throw new BridgeError("unknown", "task_response_invalid");
    return data;
  }

  private correlate(
    method: string,
    request: TaskRequest | undefined,
    data: TaskResponse,
    operationId?: string,
  ): void {
    const crossed = (): never => {
      throw new BridgeError("unknown", "task_response_crossed");
    };
    if (
      "binding" in data &&
      (data.binding.profileId !== this.context.profileId ||
        (this.binding !== undefined &&
          !isDeepStrictEqual(data.binding, this.binding)))
    )
      crossed();
    if (
      "taskId" in data &&
      this.taskId !== undefined &&
      data.taskId !== this.taskId
    )
      crossed();
    if (method === "create" || method === "continue" || method === "resume") {
      if ((data as TaskMutation).operationId !== operationId) crossed();
    } else if (method === "status" || method === "result") {
      const out = data as TaskDispatch;
      if (
        out.dispatchId !== (request as TaskDispatchRequest).dispatchId ||
        (method === "status" && out.text !== "")
      )
        crossed();
    } else if (method === "operation.status") {
      if (
        (data as TaskOperation).operationId !==
        (request as TaskOperationRequest).operationId
      )
        crossed();
    } else if (method === "observation.read") {
      const out = data as TaskObservation;
      const input = request as TaskObservationRequest;
      if (
        out.dispatchId !== input.dispatchId ||
        out.events.length > (input.limit ?? 32) ||
        (input.includeResult !== true && out.result !== "") ||
        !Array.from(out.events).every(
          (event) =>
            validate("TaskEvent", event) &&
            event.runId === out.taskId &&
            event.dispatchId === out.dispatchId &&
            event.streamId === out.next.streamId &&
            event.generation === out.next.generation,
        ) ||
        (input.cursor?.streamId &&
          !out.gap &&
          (input.cursor.streamId !== out.next.streamId ||
            input.cursor.generation !== out.next.generation))
      )
        crossed();
    }
    if ("taskId" in data) this.taskId = data.taskId;
    // Snapshot the Go-selected fingerprint only; never select/normalize aliases,
    // providers, native roots or capabilities from caller fields.
    if ("binding" in data) this.binding = structuredClone(data.binding);
  }
}
