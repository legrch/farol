import { randomUUID } from "node:crypto";
import { BridgeError, RequestNotSentError, type Client } from "./client.ts";
import {
  validate,
  type Json,
  type ComputerSettingsEditRequest,
  type ComputerSettingsMutationRead,
  type ComputerSettingsMutationResponse,
} from "./wire.ts";

class SettingsMutationNotAdmitted extends BridgeError {
  constructor() {
    super("refused", "WORKSPACE_MUTATION_NOT_ADMITTED");
  }
}

// Presentation of transport evidence only; this cannot clear pending delivery,
// release authority, authorize a retry or fabricate a Go mutation receipt.
export async function reportSettingsMutationFailure(
  error: unknown,
  recordUnknown?: () => Promise<unknown>,
): Promise<
  "WORKSPACE_MUTATION_NOT_ADMITTED" | "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
> {
  if (error instanceof SettingsMutationNotAdmitted)
    return "WORKSPACE_MUTATION_NOT_ADMITTED";
  await recordUnknown?.();
  return "WORKSPACE_MUTATION_OUTCOME_UNKNOWN";
}

// Transport only. Go owns admission, native execution, retained state and
// retirement. Observation never reissues the edit or renews its authority.
export class SettingsMutationBridge {
  private readonly attempted = new Set<string>();
  private readonly notSent = new Map<string, string>();
  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
  ) {}

  async edit(
    operationId: string,
    input: ComputerSettingsEditRequest,
  ): Promise<ComputerSettingsMutationResponse> {
    const selected = structuredClone(input);
    if (
      !validate("ComputerSettingsEditRequest", selected) ||
      !validate("ComputerSettingsMutationRead", {
        operationId,
        workspaceId: selected.workspaceId,
        relativePath: selected.relativePath,
        computerGeneration: selected.publication.generation,
      }) ||
      selected.edits.length < 1 ||
      selected.edits.length > 256 ||
      Buffer.byteLength(JSON.stringify(selected), "utf8") > 512 * 1024
    )
      throw new BridgeError("refused", "invalid_settings_mutation_request");
    if (this.attempted.has(operationId) || this.attempted.size >= 4096)
      throw new BridgeError("refused", "settings_mutation_attempt_consumed");
    this.attempted.add(operationId);
    return this.call(
      "computer.settings.edit",
      selected,
      {
        operationId,
        workspaceId: selected.workspaceId,
        relativePath: selected.relativePath,
        computerGeneration: selected.publication.generation,
      },
      selected.expectedSHA256,
    );
  }

  observe(
    input: ComputerSettingsMutationRead,
  ): Promise<ComputerSettingsMutationResponse> {
    const selected = structuredClone(input);
    if (!validate("ComputerSettingsMutationRead", selected))
      throw new BridgeError("refused", "invalid_settings_mutation_request");
    return this.call("computer.settings.mutation.read", selected, selected);
  }

  private async call(
    method: string,
    body: ComputerSettingsEditRequest | ComputerSettingsMutationRead,
    selected: ComputerSettingsMutationRead,
    beforeHash?: string,
  ): Promise<ComputerSettingsMutationResponse> {
    const context = { ...this.client.verifiedContext };
    const id = randomUUID();
    const effect = method === "computer.settings.edit";
    const identity = JSON.stringify([
      context.profileId,
      context.backendGeneration,
      selected.operationId,
      selected.workspaceId,
      selected.relativePath,
      selected.computerGeneration,
    ]);
    let outcome;
    try {
      outcome = await this.client.request(method, body as unknown as Json, {
        id,
        ...(effect ? { operationId: selected.operationId } : {}),
        timeoutMs: 16_000,
      });
    } catch (error) {
      if (effect && error instanceof RequestNotSentError) {
        this.notSent.set(selected.operationId, identity);
        throw new SettingsMutationNotAdmitted();
      }
      if (!effect) this.notSent.delete(selected.operationId);
      throw error;
    }
    if (
      !validate("Outcome", outcome) ||
      outcome.requestId !== id ||
      outcome.operationId !== (effect ? selected.operationId : undefined) ||
      outcome.context.profileId !== context.profileId ||
      outcome.context.backendGeneration !== context.backendGeneration
    ) {
      if (!effect) this.notSent.delete(selected.operationId);
      throw new BridgeError("unknown", "crossed_settings_mutation_result");
    }
    // Absence alone never settles a lost Send. Only the exact original local
    // non-dispatch proof plus a correlated read may present non-admission.
    // This proof is intentionally not reconstructed in a new host lifetime.
    if (
      !effect &&
      outcome.status === "refused" &&
      outcome.code === "COMPUTER_MUTATION_OPERATION_NOT_FOUND" &&
      outcome.data === undefined &&
      this.notSent.get(selected.operationId) === identity
    )
      throw new SettingsMutationNotAdmitted();
    if (!effect) this.notSent.delete(selected.operationId);
    if (outcome.status !== "ok")
      throw new BridgeError(
        outcome.status,
        outcome.code ?? "settings_mutation_unavailable",
      );
    if (
      outcome.code !== undefined ||
      !validate("ComputerSettingsMutationResponse", outcome.data)
    )
      throw new BridgeError("unknown", "invalid_settings_mutation_result");
    const out = outcome.data as unknown as ComputerSettingsMutationResponse;
    if (
      out.operationId !== selected.operationId ||
      out.workspaceId !== selected.workspaceId ||
      out.computerGeneration !== selected.computerGeneration
    )
      throw new BridgeError("unknown", "crossed_settings_mutation_result");
    if (out.phase === "completed") {
      const receipt = out.receipt;
      if (
        out.failure !== undefined ||
        !receipt ||
        receipt.operation !== "edit" ||
        receipt.relativePath !== selected.relativePath ||
        receipt.beforeSHA256 === undefined ||
        (beforeHash !== undefined && receipt.beforeSHA256 !== beforeHash) ||
        BigInt(receipt.bytes) > 8n * 1024n * 1024n ||
        receipt.replacements < 1 ||
        receipt.replacements > 256
      )
        throw new BridgeError("unknown", "crossed_settings_mutation_receipt");
    } else if (
      out.receipt !== undefined ||
      !out.failure ||
      out.failure.retry !== "never" ||
      (out.phase === "outcome_unknown") !==
        (out.failure.code === "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
    )
      throw new BridgeError("unknown", "invalid_settings_mutation_failure");
    return structuredClone(out);
  }
}
