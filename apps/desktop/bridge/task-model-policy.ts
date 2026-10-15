import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import { parseJSON } from "./frame.ts";
import { validate, type Json, type TaskModelPolicyResponse } from "./wire.ts";
import {
  TaskModelBindingSchema,
  type ResolvedTaskModel,
  type TaskSelectionRequest,
} from "../../../src/pkg/owner-config/contract.ts";

export type TaskModelPolicyResolution =
  | Readonly<{
      status: "ready";
      selection: ResolvedTaskModel;
      configSha256: string;
    }>
  | Readonly<{
      status:
        | "config-missing"
        | "config-invalid"
        | "selection-invalid"
        | "harness-missing"
        | "harness-unsupported"
        | "model-missing"
        | "unavailable";
    }>;

export type TaskModelPolicyResolver = (
  revision: number,
  config: unknown,
  selection: TaskSelectionRequest,
) => Promise<TaskModelPolicyResolution>;

// A read-only transport adapter. Go decides defaults, supported harnesses,
// model/effort resolution and semantic identity. This opens no provider or Task.
export class TaskModelPolicyBridge {
  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
  ) {}

  async resolve(
    revision: number,
    config: unknown,
    selection: TaskSelectionRequest,
  ): Promise<TaskModelPolicyResolution> {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new BridgeError("refused", "task_model_policy_revision_invalid");
    const context = { ...this.client.verifiedContext };
    if (!validate("Context", context))
      throw new BridgeError("unavailable", "task_model_policy_context_invalid");
    // Capture caller values before awaiting the original request. parseJSON
    // applies the existing duplicate/Unicode/depth boundary, without policy.
    const body = parseJSON(
      JSON.stringify({
        revision: String(revision),
        config: config ?? null,
        selection,
      }),
    ) as Json;
    if (!validate("TaskModelPolicyRequest", body))
      throw new BridgeError("refused", "task_model_policy_request_invalid");
    const id = randomUUID();
    const outcome = await this.client.request("task.model.resolve", body, {
      id,
    });
    const current = this.client.verifiedContext;
    if (
      !validate("Outcome", outcome) ||
      outcome.requestId !== id ||
      outcome.operationId !== undefined ||
      outcome.context.profileId !== context.profileId ||
      outcome.context.backendGeneration !== context.backendGeneration ||
      current.profileId !== context.profileId ||
      current.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError("unknown", "task_model_policy_response_context");
    if (outcome.status !== "ok")
      throw new BridgeError(
        outcome.status,
        outcome.code ?? "task_model_policy_unavailable",
      );
    if (!validate("TaskModelPolicyResponse", outcome.data))
      throw new BridgeError("unknown", "task_model_policy_response_invalid");
    const result = outcome.data as unknown as TaskModelPolicyResponse;
    if (result.revision !== String(revision))
      throw new BridgeError("unknown", "task_model_policy_response_revision");
    if (result.status !== "ready") {
      if (result.selection !== undefined || result.configSha256 !== undefined)
        throw new BridgeError("unknown", "task_model_policy_response_invalid");
      return Object.freeze({ status: result.status });
    }
    // The wire envelope also contains status/revision, so validate the actual
    // binding projection using its independent existing transport schema.
    const parsed = TaskModelBindingSchema.safeParse({
      selection: result.selection,
      configSha256: result.configSha256,
    });
    if (!parsed.success)
      throw new BridgeError("unknown", "task_model_policy_response_invalid");
    return Object.freeze({
      status: "ready",
      selection: Object.freeze(parsed.data.selection),
      configSha256: parsed.data.configSha256,
    });
  }
}
