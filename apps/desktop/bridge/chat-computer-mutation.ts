import { createHash, randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import { parseJSON } from "./frame.ts";
import {
  maxFrameBytes,
  validate,
  type ChatComputerWrite,
  type ChatComputerEdit,
  type ChatComputerOutput,
  type ChatComputerMutationRead,
  type ChatComputerMutationObservation,
  type ComputerMutationResponse,
  type ChatHandle,
  type Context,
  type Json,
} from "./wire.ts";

type MutationInput = ChatComputerWrite | ChatComputerEdit;
type Kind = "write" | "edit";
type Correlation = Readonly<{
  operationId: string;
  kind: Kind;
  workspaceId: string;
  relativePath: string;
  expectedSHA256: string | undefined;
  writeSHA256: string | undefined;
  writeBytes: string | undefined;
  editCount: number | undefined;
}>;
const sha = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

function correlation(
  kind: Kind,
  input: MutationInput,
  operationId: string,
): Correlation {
  return Object.freeze({
    operationId,
    kind,
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    expectedSHA256: input.expectedSHA256,
    writeSHA256: "content" in input ? sha(input.content) : undefined,
    writeBytes:
      "content" in input
        ? String(Buffer.byteLength(input.content, "utf8"))
        : undefined,
    editCount: "edits" in input ? input.edits.length : undefined,
  });
}

function checkedResult(
  handle: ChatHandle,
  callId: string,
  data: unknown,
  expected?: Correlation,
): ComputerMutationResponse {
  if (!validate("ComputerMutationResponse", data))
    throw new BridgeError("unknown", "chat_computer_mutation_result_invalid");
  const result = data as ComputerMutationResponse;
  if (
    result.callId !== callId ||
    result.turnId !== handle.binding.turnId ||
    result.generation !== handle.binding.turnGeneration ||
    (expected &&
      (result.operationId !== expected.operationId ||
        result.workspaceId !== expected.workspaceId))
  )
    throw new BridgeError("unknown", "chat_computer_mutation_result_crossed");
  if (result.phase === "completed") {
    const receipt = result.receipt;
    if (
      !receipt ||
      result.failure !== undefined ||
      BigInt(receipt.bytes) > 8n * 1024n * 1024n ||
      (receipt.operation === "write"
        ? receipt.replacements !== 0
        : receipt.replacements < 1 ||
          receipt.replacements > 256 ||
          receipt.beforeSHA256 === undefined)
    )
      throw new BridgeError("unknown", "chat_computer_mutation_phase_invalid");
    if (
      expected &&
      (receipt.operation !== expected.kind ||
        receipt.relativePath !== expected.relativePath ||
        receipt.beforeSHA256 !== expected.expectedSHA256 ||
        (expected.kind === "write" &&
          (receipt.afterSHA256 !== expected.writeSHA256 ||
            receipt.bytes !== expected.writeBytes)) ||
        (expected.kind === "edit" &&
          receipt.replacements !== expected.editCount))
    )
      throw new BridgeError(
        "unknown",
        "chat_computer_mutation_receipt_crossed",
      );
  } else if (
    result.receipt !== undefined ||
    !result.failure ||
    (result.phase === "outcome_unknown") !==
      (result.failure.code === "WORKSPACE_MUTATION_OUTCOME_UNKNOWN") ||
    (result.phase === "outcome_unknown" &&
      !["native-workspace", "operation-store"].includes(result.failure.source))
  ) {
    throw new BridgeError("unknown", "chat_computer_mutation_phase_invalid");
  }
  return {
    ...result,
    ...(result.receipt ? { receipt: { ...result.receipt } } : {}),
    ...(result.failure ? { failure: { ...result.failure } } : {}),
  };
}

// Also used by the selected relay to verify a structural port's delivery.
// The selected stable effect ID is independent of the relay call ID.
export function checkedChatComputerMutationOutput(
  handle: ChatHandle,
  input: MutationInput,
  kind: Kind,
  data: unknown,
  operationId: string,
): ChatComputerOutput {
  if (!validate("ChatComputerOutput", data))
    throw new BridgeError("unknown", "chat_computer_mutation_output_invalid");
  const out = data as ChatComputerOutput;
  const receipt = out.receipt;
  if (
    receipt.handleId !== handle.handleId ||
    receipt.callId !== input.callId ||
    receipt.relayBinding !== input.relayBinding ||
    receipt.requestSHA256 !== input.requestSHA256 ||
    receipt.outputSHA256 !== sha(out.output) ||
    receipt.outputBytes !== String(Buffer.byteLength(out.output, "utf8"))
  )
    throw new BridgeError("unknown", "chat_computer_mutation_output_crossed");
  let parsed: unknown;
  try {
    parsed = parseJSON(out.output);
  } catch {
    throw new BridgeError("unknown", "chat_computer_mutation_output_invalid");
  }
  if (!validate("ComputerMutationResponse", parsed))
    throw new BridgeError("unknown", "chat_computer_mutation_result_invalid");
  const expected = correlation(kind, input, operationId);
  const result = checkedResult(handle, input.callId, parsed, expected);
  if (result.publication !== "durable" || result.phase === "outcome_unknown")
    throw new BridgeError("unknown", "chat_computer_mutation_not_deliverable");
  return { output: out.output, receipt: { ...receipt } };
}

// Count the entire serialized envelope, including JSON escaping, before the
// client can admit a request. Stop at the existing 1 MiB limit; never chunk.
function checkFrame(request: Json): void {
  let bytes = 0;
  const add = (n: number): void => {
    bytes += n;
    if (bytes > maxFrameBytes)
      throw new BridgeError(
        "refused",
        "chat_computer_mutation_frame_too_large",
      );
  };
  const visit = (value: Json): void => {
    if (Array.isArray(value)) {
      add(2);
      value.forEach((item, index) => {
        if (index) add(1);
        visit(item);
      });
    } else if (value !== null && typeof value === "object") {
      add(2);
      Object.entries(value).forEach(([key, item], index) => {
        if (index) add(1);
        add(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        visit(item);
      });
    } else {
      add(Buffer.byteLength(JSON.stringify(value), "utf8"));
    }
  };
  visit(request);
}

// Trusted transport seam only. Go owns admission, filesystem authority and
// retained lifecycle. This handle-scoped map holds no write/edit text or output;
// it fences a second call/effect ID and correlates an explicit observation.
export class ChatComputerMutationBridge {
  private readonly handle: ChatHandle;
  private readonly attempts = new Map<string, Correlation>();
  private readonly effectIDs = new Set<string>();

  constructor(
    private readonly client: Client,
    handle: ChatHandle,
  ) {
    if (!validate("ChatHandle", handle))
      throw new BridgeError("refused", "chat_computer_mutation_handle_invalid");
    this.handle = { ...handle, binding: { ...handle.binding } };
    this.context();
  }

  write(
    input: ChatComputerWrite,
    operationId?: string,
  ): Promise<ChatComputerOutput> {
    return this.effect("write", input, operationId);
  }
  edit(
    input: ChatComputerEdit,
    operationId?: string,
  ): Promise<ChatComputerOutput> {
    return this.effect("edit", input, operationId);
  }

  async observe(
    input: ChatComputerMutationRead,
  ): Promise<ChatComputerMutationObservation> {
    if (
      !validate("ChatComputerMutationRead", input) ||
      input.handleId !== this.handle.handleId
    )
      throw new BridgeError(
        "refused",
        "chat_computer_mutation_request_invalid",
      );
    const selected = { ...input };
    const expected = this.attempts.get(selected.callId);
    const data = await this.call("mutation.read", selected as unknown as Json);
    if (!validate("ChatComputerMutationObservation", data))
      throw new BridgeError(
        "unknown",
        "chat_computer_mutation_observation_invalid",
      );
    const observed = data as unknown as ChatComputerMutationObservation;
    if (
      observed.handleId !== this.handle.handleId ||
      observed.callId !== selected.callId
    )
      throw new BridgeError(
        "unknown",
        "chat_computer_mutation_observation_crossed",
      );
    return {
      ...observed,
      result: checkedResult(
        this.handle,
        selected.callId,
        observed.result,
        expected,
      ),
    };
  }

  private context(): Context {
    const value = { ...this.client.verifiedContext };
    if (
      !validate("Context", value) ||
      value.profileId !== this.handle.binding.profileId ||
      value.backendGeneration !== this.handle.binding.backendGeneration
    )
      throw new BridgeError("refused", "chat_computer_mutation_handle_context");
    return value;
  }

  private async effect(
    kind: Kind,
    input: MutationInput,
    providedOperationId?: string,
  ): Promise<ChatComputerOutput> {
    if (
      !validate(
        kind === "write" ? "ChatComputerWrite" : "ChatComputerEdit",
        input,
      ) ||
      input.handleId !== this.handle.handleId ||
      ("edits" in input &&
        (input.edits.length === 0 ||
          !Array.from(input.edits).every((edit) =>
            validate("ComputerTextEdit", edit),
          )))
    )
      throw new BridgeError(
        "refused",
        "chat_computer_mutation_request_invalid",
      );
    const selected: MutationInput =
      "edits" in input
        ? { ...input, edits: input.edits.map((edit) => ({ ...edit })) }
        : { ...input };
    const operationId =
      providedOperationId === undefined ? randomUUID() : providedOperationId;
    if (!validate("id", operationId))
      throw new BridgeError(
        "refused",
        "chat_computer_mutation_operation_id_invalid",
      );
    if (this.attempts.has(selected.callId) || this.effectIDs.has(operationId))
      throw new BridgeError(
        "unknown",
        "chat_computer_mutation_already_attempted",
      );
    const data = await this.call(
      kind,
      selected as unknown as Json,
      operationId,
      () => {
        this.effectIDs.add(operationId);
        this.attempts.set(
          selected.callId,
          correlation(kind, selected, operationId),
        );
      },
    );
    return checkedChatComputerMutationOutput(
      this.handle,
      selected,
      kind,
      data,
      operationId,
    );
  }

  private async call(
    method: string,
    body: Json,
    operationId?: string,
    admitted?: () => void,
  ): Promise<Json | undefined> {
    const context = this.context();
    const id = randomUUID();
    const envelope = {
      jsonrpc: "2.0",
      id,
      method: `chat.computer.${method}`,
      params: {
        body,
        context: { ...context },
        ...(operationId ? { operationId } : {}),
      },
    };
    if (!validate("Request", envelope))
      throw new BridgeError(
        "refused",
        "chat_computer_mutation_request_invalid",
      );
    checkFrame(envelope);
    admitted?.();
    const result = await this.client.request(envelope.method, body, {
      id,
      ...(operationId ? { operationId } : {}),
      timeoutMs: 16000,
    });
    if (
      !validate("Outcome", result) ||
      result.requestId !== id ||
      result.operationId !== operationId ||
      result.context.profileId !== context.profileId ||
      result.context.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError(
        "unknown",
        "chat_computer_mutation_response_context",
      );
    if (result.status !== "ok")
      throw new BridgeError(
        result.status,
        result.code ?? "chat_computer_mutation_request_failed",
      );
    return result.data;
  }
}
