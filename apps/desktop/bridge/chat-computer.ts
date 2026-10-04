import { createHash, randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type ChatComputerRead,
  type ChatComputerOutput,
  type ChatComputerReceipt,
  type ComputerReadResponse,
  type Json,
} from "./wire.ts";

// Trusted host transport only. A parsed relay receipt supplies the return edge;
// reading output or writing a socket never automatically acknowledges the owner.
export class ChatComputerBridge {
  constructor(private readonly client: Client) {}

  async read(input: ChatComputerRead): Promise<ChatComputerOutput> {
    const selected = { ...input };
    const result = await this.call<ChatComputerOutput>(
      "read",
      "ChatComputerRead",
      selected,
      "ChatComputerOutput",
    );
    const receipt = result.receipt;
    if (
      receipt.handleId !== selected.handleId ||
      receipt.callId !== selected.callId ||
      receipt.relayBinding !== selected.relayBinding ||
      receipt.requestSHA256 !== selected.requestSHA256 ||
      receipt.outputBytes !==
        String(Buffer.byteLength(result.output, "utf8")) ||
      receipt.outputSHA256 !==
        createHash("sha256").update(result.output, "utf8").digest("hex")
    )
      throw new BridgeError("unknown", "chat_computer_output_crossed");
    let output: unknown;
    try {
      output = JSON.parse(result.output);
    } catch {
      throw new BridgeError("unknown", "chat_computer_output_invalid");
    }
    if (!validate("ComputerReadResponse", output))
      throw new BridgeError("unknown", "chat_computer_output_invalid");
    const read = output as ComputerReadResponse;
    if (
      read.callId !== selected.callId ||
      read.workspaceId !== selected.workspaceId ||
      read.relativePath !== selected.relativePath ||
      read.page !== undefined
    )
      throw new BridgeError("unknown", "chat_computer_output_crossed");
    return result;
  }

  returned(receipt: ChatComputerReceipt): Promise<Record<string, never>> {
    return this.call("return", "ChatComputerReceipt", { ...receipt }, "Empty");
  }

  private async call<T>(
    method: string,
    inputShape: string,
    input: unknown,
    outputShape: string,
  ): Promise<T> {
    if (!validate(inputShape, input))
      throw new BridgeError("refused", "chat_computer_request_invalid");
    const expected = { ...this.client.verifiedContext };
    const id = randomUUID(),
      operationId = randomUUID();
    const result = await this.client.request(
      `chat.computer.${method}`,
      input as Json,
      { id, operationId, timeoutMs: 16000 },
    );
    if (
      result.requestId !== id ||
      result.operationId !== operationId ||
      result.context.profileId !== expected.profileId ||
      result.context.backendGeneration !== expected.backendGeneration
    )
      throw new BridgeError("unknown", "chat_computer_response_context");
    if (result.status !== "ok")
      throw new BridgeError(
        result.status,
        result.code ?? "chat_computer_request_failed",
      );
    if (!validate(outputShape, result.data))
      throw new BridgeError("unknown", "chat_computer_response_invalid");
    return result.data as T;
  }
}
