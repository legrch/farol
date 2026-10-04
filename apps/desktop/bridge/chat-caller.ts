import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type ChatCallerBegin,
  type ChatCallerDelivery,
  type ChatCallerHandle,
  type ChatCallerAccept,
  type ChatCallerOutput,
  type ChatCallerReceipt,
  type Json,
} from "./wire.ts";

// Transport facade only. Go owns the existing conversation and tool round.
// Retained frame observation is not dispatch; output acceptance is not receipt.
export class ChatCallerBridge {
  constructor(private readonly client: Client) {}
  async begin(input: ChatCallerBegin): Promise<ChatCallerHandle> {
    const selected = structuredClone(input);
    const token = await this.call<ChatCallerHandle>(
      "begin",
      "ChatCallerBegin",
      selected,
      "ChatCallerHandle",
    );
    if (
      token.handleId !== selected.handleId ||
      token.producerOperationId !== selected.producerOperationId ||
      token.callId !== selected.call.callId ||
      token.relayBinding !== selected.relayBinding ||
      token.requestSHA256 !== selected.requestSHA256
    )
      throw new BridgeError("unknown", "chat_caller_handle_crossed");
    return token;
  }
  // One original executable delivery only. Failure is never replay permission.
  claim(handle: ChatCallerHandle): Promise<Record<string, never>> {
    return this.call(
      "claim",
      "ChatCallerHandle",
      structuredClone(handle),
      "Empty",
    );
  }
  // Current-owner snapshot only. A later write needs its own consumptive edge;
  // a positive read does not replace an original claim or transport fence.
  check(handle: ChatCallerHandle): Promise<Record<string, never>> {
    return this.call(
      "check",
      "ChatCallerHandle",
      structuredClone(handle),
      "Empty",
      false,
    );
  }
  // Consumes the original owner's one issuance. Unknown/refused never retries.
  async issue(handle: ChatCallerHandle): Promise<ChatCallerDelivery> {
    const selected = structuredClone(handle);
    const out = await this.call<ChatCallerDelivery>(
      "issue",
      "ChatCallerHandle",
      selected,
      "ChatCallerDelivery",
    );
    if (
      !isDeepStrictEqual(out.handle, selected) ||
      out.dataBytes !== String(Buffer.byteLength(out.data, "utf8")) ||
      out.dataSHA256 !==
        createHash("sha256").update(out.data, "utf8").digest("hex") ||
      BigInt(out.firstSequence) === 0n ||
      BigInt(out.lastSequence) < BigInt(out.firstSequence) ||
      BigInt(out.lastSequence) - BigInt(out.firstSequence) >= 128n
    )
      throw new BridgeError("unknown", "chat_caller_delivery_crossed");
    return out;
  }
  async output(input: ChatCallerAccept): Promise<ChatCallerOutput> {
    const selected = structuredClone(input);
    if (!validate("ChatCallerAccept", selected))
      throw new BridgeError("refused", "chat_caller_request_invalid");
    if (selected.calls.length !== 1 || selected.outputs.length !== 1)
      throw new BridgeError("refused", "chat_caller_cardinality_invalid");
    const out = await this.call<ChatCallerOutput>(
      "output",
      "ChatCallerAccept",
      selected,
      "ChatCallerOutput",
    );
    if (
      !isDeepStrictEqual(out.receipt.handle, selected.handle) ||
      out.receipt.outputBytes !==
        String(Buffer.byteLength(out.output, "utf8")) ||
      out.receipt.outputSHA256 !==
        createHash("sha256").update(out.output, "utf8").digest("hex")
    )
      throw new BridgeError("unknown", "chat_caller_output_crossed");
    return out;
  }
  // Only the original private caller-relay parsed receipt may select this call.
  // SSE writes, frame ACKs and AcceptOutput do not invoke it automatically.
  returned(receipt: ChatCallerReceipt): Promise<Record<string, never>> {
    return this.call(
      "return",
      "ChatCallerReceipt",
      structuredClone(receipt),
      "Empty",
    );
  }
  private async call<T>(
    method: string,
    shape: string,
    input: unknown,
    outputShape: string,
    effect = true,
  ): Promise<T> {
    if (!validate(shape, input))
      throw new BridgeError("refused", "chat_caller_request_invalid");
    const expected = { ...this.client.verifiedContext };
    const id = randomUUID(),
      operationId = effect ? randomUUID() : undefined;
    const result = await this.client.request(
      `chat.caller.${method}`,
      input as Json,
      { id, ...(operationId ? { operationId } : {}), timeoutMs: 16000 },
    );
    if (
      result.requestId !== id ||
      result.operationId !== operationId ||
      result.context.profileId !== expected.profileId ||
      result.context.backendGeneration !== expected.backendGeneration
    )
      throw new BridgeError("unknown", "chat_caller_response_context");
    if (result.status !== "ok")
      throw new BridgeError(
        result.status,
        result.code ?? "chat_caller_request_failed",
      );
    if (!validate(outputShape, result.data))
      throw new BridgeError("unknown", "chat_caller_response_invalid");
    return result.data as T;
  }
}
