import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import { parseJSON } from "./frame.ts";
import {
  validate,
  type Json,
  type TaskModelCatalogueResponse,
} from "./wire.ts";
import {
  TaskModelCatalogueViewSchema,
  type TaskModelCatalogueView,
} from "../../../src/pkg/owner-config/contract.ts";

// Transport only: Task's Go owner interprets configured choices and the
// separately observed runtime catalogue. A view grants no provider authority.
export class TaskModelCatalogueBridge {
  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
  ) {}

  async describe(
    revision: number,
    config: unknown,
    harness: string,
    catalogue: unknown,
  ): Promise<TaskModelCatalogueView> {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new BridgeError("refused", "task_model_catalogue_revision_invalid");
    const context = { ...this.client.verifiedContext };
    if (!validate("Context", context))
      throw new BridgeError(
        "unavailable",
        "task_model_catalogue_context_invalid",
      );
    const body = parseJSON(
      JSON.stringify({
        revision: String(revision),
        config: config ?? null,
        harness,
        catalogue,
      }),
    ) as Json;
    if (!validate("TaskModelCatalogueRequest", body))
      throw new BridgeError("refused", "task_model_catalogue_request_invalid");
    const id = randomUUID();
    const outcome = await this.client.request("task.models.describe", body, {
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
      throw new BridgeError("unknown", "task_model_catalogue_response_context");
    if (outcome.status !== "ok")
      throw new BridgeError(
        outcome.status,
        outcome.code ?? "task_model_catalogue_unavailable",
      );
    if (!validate("TaskModelCatalogueResponse", outcome.data))
      throw new BridgeError("unknown", "task_model_catalogue_response_invalid");
    const result = outcome.data as unknown as TaskModelCatalogueResponse;
    if (result.revision !== String(revision))
      throw new BridgeError(
        "unknown",
        "task_model_catalogue_response_revision",
      );
    const parsed = TaskModelCatalogueViewSchema.safeParse(result.view);
    if (!parsed.success || parsed.data.harness !== harness)
      throw new BridgeError("unknown", "task_model_catalogue_response_invalid");
    // Schema parsing supplies an independent bounded DTO; no policy is derived
    // here and neither response objects nor their arrays alias transport data.
    return parsed.data;
  }
}
