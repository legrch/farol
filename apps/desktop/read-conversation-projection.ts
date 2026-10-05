import { ReadConversationViewSchema } from "../../src/pkg/product-settings/chat-conversation.ts";
import type { ReadConversationProjection } from "./bridge/read-conversation.ts";
import { BridgeError } from "./bridge/client.ts";

export function projectReadConversation(
  operationId: string,
  projection: ReadConversationProjection,
) {
  const { handle, state, frames, cursor, result } = projection;
  const parsed = ReadConversationViewSchema.safeParse({
    kind: "chatgpt.readonly-conversation",
    operationId,
    handleId: handle.handleId,
    binding: handle.binding,
    conversationId: state.conversationId,
    phase: state.phase,
    hasResult: state.hasResult,
    deliveryAcknowledged: state.deliveryAcknowledged,
    lifecycleSettled: state.lifecycleSettled,
    released: state.released,
    followReady: state.followReady,
    cursor,
    frames: frames.map((frame) => {
      if (frame.kind !== "response.output_text.delta")
        return { sequence: frame.sequence };
      const delta =
        frame.data && typeof frame.data === "object" && "delta" in frame.data
          ? frame.data.delta
          : undefined;
      if (typeof delta !== "string")
        throw new BridgeError("unknown", "read_chat_projection_invalid");
      return { sequence: frame.sequence, delta };
    }),
    ...(result
      ? {
          result: {
            resultId: result.resultId,
            outcome: result.outcome,
            code: result.code,
            text: result.text,
            complete: result.complete,
            acknowledged: result.acknowledged,
            retention: "memory_only",
          },
        }
      : {}),
  });
  if (!parsed.success)
    throw new BridgeError("unknown", "read_chat_projection_invalid");
  return parsed.data;
}
