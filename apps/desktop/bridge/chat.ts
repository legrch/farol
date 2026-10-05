import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type ChatCreate,
  type ChatHandle,
  type ChatSubmissionState,
  type ChatState,
  type ChatPrepared,
  type ChatResult,
  type ChatFrames,
  type ChatFrameAckResult,
  type Json,
} from "./wire.ts";

// Narrow transport facade for the trusted host. The Go Chat owner alone owns
// conversation admission, queue, Send intent, retained output and business ACK.
// Every call is explicit and one-shot; reading a result never acknowledges it.
export class ChatBridge {
  constructor(private readonly client: Client) {}
  create(input: ChatCreate): Promise<ChatHandle> {
    return this.call("create", "ChatCreate", input, "ChatHandle", true);
  }
  async state(handle: ChatHandle): Promise<ChatState> {
    if (!validate("ChatHandle", handle))
      throw new BridgeError("refused", "chat_request_invalid");
    const selected = structuredClone(handle);
    const state = await this.call<ChatState>(
      "state",
      "ChatHandleRequest",
      { handleId: selected.handleId },
      "ChatState",
      false,
    );
    if (!isDeepStrictEqual(state.handle, selected))
      throw new BridgeError("unknown", "chat_state_handle_crossed");
    return state;
  }
  // Observation only: not-dispatched may still be queued/prepared and able to
  // Send. This never releases a replay guard or creates another operation.
  async submission(handle: ChatHandle): Promise<ChatSubmissionState> {
    if (!validate("ChatHandle", handle))
      throw new BridgeError("refused", "chat_request_invalid");
    const selected = structuredClone(handle);
    const result = await this.call<ChatSubmissionState>(
      "submission",
      "ChatHandleRequest",
      { handleId: selected.handleId },
      "ChatSubmissionState",
      false,
    );
    if (!isDeepStrictEqual(result.handle, selected))
      throw new BridgeError("unknown", "chat_submission_handle_crossed");
    return result;
  }
  prepare(deadlineMillis: string): Promise<ChatPrepared> {
    return this.call(
      "prepare",
      "ChatDeadline",
      { deadlineMillis },
      "ChatPrepared",
      true,
    );
  }
  send(
    handleId: string,
    deadlineMillis: string,
  ): Promise<Record<string, never>> {
    return this.call(
      "send",
      "ChatAction",
      { handleId, deadlineMillis },
      "Empty",
      true,
    );
  }
  observe(
    handleId: string,
    deadlineMillis: string,
  ): Promise<Record<string, never>> {
    return this.call(
      "observe",
      "ChatAction",
      { handleId, deadlineMillis },
      "Empty",
      true,
    );
  }
  result(handleId: string): Promise<ChatResult> {
    return this.call(
      "result",
      "ChatHandleRequest",
      { handleId },
      "ChatResult",
      false,
    );
  }
  events(handleId: string, afterSequence: string): Promise<ChatFrames> {
    return this.call(
      "events",
      "ChatEventsRequest",
      { handleId, afterSequence },
      "ChatFrames",
      false,
    );
  }
  acknowledgeResult(
    handleId: string,
    resultId: string,
  ): Promise<Record<string, never>> {
    return this.call(
      "result.ack",
      "ChatResultAck",
      { handleId, resultId },
      "Empty",
      true,
    );
  }
  acknowledgeFrame(
    handleId: string,
    sequence: string,
  ): Promise<ChatFrameAckResult> {
    return this.call(
      "frame.ack",
      "ChatFrameAck",
      { handleId, sequence },
      "ChatFrameAckResult",
      true,
    );
  }
  cancel(handleId: string): Promise<Record<string, never>> {
    return this.call(
      "cancel",
      "ChatHandleRequest",
      { handleId },
      "Empty",
      true,
    );
  }
  resume(handleId: string): Promise<Record<string, never>> {
    return this.call(
      "resume",
      "ChatHandleRequest",
      { handleId },
      "Empty",
      true,
    );
  }
  private async call<T>(
    method: string,
    inputShape: string,
    input: unknown,
    outputShape: string,
    effect: boolean,
  ): Promise<T> {
    if (!validate(inputShape, input))
      throw new BridgeError("refused", "chat_request_invalid");
    const context = this.client.verifiedContext;
    const id = randomUUID();
    const operationId = effect ? randomUUID() : undefined;
    const result = await this.client.request(
      `chat.conversation.${method}`,
      input as Json,
      { id, ...(operationId ? { operationId } : {}), timeoutMs: 16000 },
    );
    if (
      result.requestId !== id ||
      result.operationId !== operationId ||
      result.context.profileId !== context.profileId ||
      result.context.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError("unknown", "chat_response_context");
    if (result.status !== "ok")
      throw new BridgeError(
        result.status,
        result.code ?? "chat_request_failed",
      );
    if (!validate(outputShape, result.data))
      throw new BridgeError("unknown", "chat_response_invalid");
    return result.data as T;
  }
}
