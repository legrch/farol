import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, type Client } from "./client.ts";
import { frame } from "./frame.ts";
import {
  validate,
  type ComputerConnectorOpened,
  type Identity,
  type Json,
  type TaskSelectedCodexReadRequest,
  type TaskSelectedCodexReadResponse,
  type TaskSelectedCodexReadSelection,
} from "./wire.ts";

export const selectedCodexReadMethod = "task.codex.selected.read";
const failureCodes = new Set([
  "TASK_INPUT_INVALID",
  "TASK_IDENTITY_MISMATCH",
  "TASK_STATE_REFUSED",
  "TASK_UNAVAILABLE",
  "TASK_REQUEST_CANCELLED",
  "TASK_OBSERVATION_UNKNOWN",
]);

// The selection witness comes from the exact admitted Go connector receipt.
// The actual socket handshake must independently advertise this read method.
// Neither metadata nor this adapter qualifies the native host/account/provider.
export function selectedCodexReadBridge(
  client: Pick<Client, "request">,
  opened: ComputerConnectorOpened,
  identity: Identity,
): SelectedCodexReadBridge | undefined {
  if (
    !validate("ComputerConnectorOpened", opened) ||
    !validate("Identity", identity)
  )
    throw new BridgeError("refused", "selected_codex_read_selection_invalid");
  const count = identity.capabilities.filter(
    (name) => name === selectedCodexReadMethod,
  ).length;
  if (opened.codexRead === undefined && count === 0) return undefined;
  return new SelectedCodexReadBridge(client, opened, identity);
}

export class SelectedCodexReadBridge {
  private readonly selection: TaskSelectedCodexReadSelection;
  private readonly context;
  constructor(
    private readonly client: Pick<Client, "request">,
    opened: ComputerConnectorOpened,
    identity: Identity,
  ) {
    if (
      !validate("ComputerConnectorOpened", opened) ||
      !validate("Identity", identity) ||
      opened.codexRead === undefined ||
      identity.capabilities.filter((name) => name === selectedCodexReadMethod)
        .length !== 1 ||
      identity.buildId !== opened.endpoint.binding.buildId ||
      identity.profileId !== opened.endpoint.binding.profileId ||
      identity.backendGeneration !==
        opened.endpoint.binding.backendGeneration ||
      opened.codexRead.binding.provider !== "codex" ||
      opened.codexRead.binding.hostId !== "codex" ||
      opened.codexRead.binding.profileId !== identity.profileId
    )
      throw new BridgeError("refused", "selected_codex_read_selection_invalid");
    this.selection = structuredClone(opened.codexRead);
    this.context = Object.freeze({
      profileId: identity.profileId,
      backendGeneration: identity.backendGeneration,
    });
  }

  async read(
    request: TaskSelectedCodexReadRequest,
  ): Promise<TaskSelectedCodexReadResponse> {
    if (!validate("TaskSelectedCodexReadRequest", request))
      throw new BridgeError("refused", "selected_codex_read_input_invalid");
    const body = structuredClone(request);
    const id = randomUUID();
    frame({
      jsonrpc: "2.0",
      id,
      method: selectedCodexReadMethod,
      params: { context: this.context, body },
    });
    const out = await this.client.request(
      selectedCodexReadMethod,
      body as Json,
      { id, timeoutMs: 21000 },
    );
    if (
      !validate("Outcome", out) ||
      out.requestId !== id ||
      out.operationId !== undefined ||
      !isDeepStrictEqual(out.context, this.context)
    )
      throw new BridgeError("unknown", "selected_codex_read_response_crossed");
    if (out.status !== "ok")
      throw new BridgeError(
        out.status,
        out.code !== undefined && failureCodes.has(out.code)
          ? out.code
          : "selected_codex_read_unavailable",
      );
    if (
      out.code !== undefined ||
      !validate("TaskSelectedCodexReadResponse", out.data)
    )
      throw new BridgeError("unknown", "selected_codex_read_response_invalid");
    const data = out.data as unknown as TaskSelectedCodexReadResponse;
    if (
      !isDeepStrictEqual(data.selection, this.selection) ||
      data.retained ||
      (body.includeResult !== true && data.text !== "") ||
      (data.lifecycle === "completed"
        ? data.resultEvidence !== "provider_history"
        : data.resultEvidence !== "" || data.text !== "")
    )
      throw new BridgeError("unknown", "selected_codex_read_response_crossed");
    frame({ jsonrpc: "2.0", id, result: out });
    return structuredClone(data);
  }
}
