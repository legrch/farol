import type { ServerResponse } from "node:http";
import { BridgeError } from "./bridge/client.ts";
import type { ChatCallerBridge } from "./bridge/chat-caller.ts";
import { validate, type ChatCallerHandle } from "./bridge/wire.ts";

type ResponseSink = Pick<
  ServerResponse,
  "destroyed" | "writableEnded" | "write" | "on" | "off"
>;
export type CallerDeliveryWrite = Readonly<{
  issuanceId: string;
  firstSequence: string;
  lastSequence: string;
}>;

// One original HTTP response and one owner-issued bounded group. Abort/close is
// a monotonic local deny fence, never Go authority or proof of non-consumption.
// Composition must withdraw locally before awaiting its own Go cancellation.
export async function writeGoCallerDelivery(
  bridge: Pick<ChatCallerBridge, "issue">,
  handle: ChatCallerHandle,
  response: ResponseSink,
  signal: AbortSignal,
  afterSequence: string,
): Promise<CallerDeliveryWrite> {
  const selected = structuredClone(handle);
  if (
    !validate("ChatEventsRequest", {
      handleId: selected.handleId,
      afterSequence,
    })
  )
    throw new BridgeError("refused", "chat_caller_cursor_invalid");
  let withdrawn =
    signal.aborted || response.destroyed || response.writableEnded;
  let wake: ((result: "drained" | "lost") => void) | undefined;
  const lost = () => {
    withdrawn = true;
    wake?.("lost");
  };
  const drained = () => wake?.("drained");
  const current = () =>
    !withdrawn &&
    !signal.aborted &&
    !response.destroyed &&
    !response.writableEnded;
  signal.addEventListener("abort", lost, { once: true });
  response.on("close", lost);
  response.on("error", lost);
  try {
    if (!current())
      throw new BridgeError("refused", "chat_caller_transport_closed");
    const issued = await bridge.issue(selected);
    if (BigInt(issued.firstSequence) !== BigInt(afterSequence) + 1n)
      throw new BridgeError("unknown", "chat_caller_delivery_gap");
    if (!current())
      throw new BridgeError("unknown", "chat_caller_delivery_lost");
    const drain = new Promise<"drained" | "lost">((resolve) => {
      wake = resolve;
    });
    response.on("drain", drained);
    // No await between the last local fence check and this single exact write.
    // false means bytes already buffered; a later drain never grants a write.
    const buffered = response.write(issued.data, "utf8");
    if (!current())
      throw new BridgeError("unknown", "chat_caller_delivery_lost");
    if (!buffered && (await drain) === "lost")
      throw new BridgeError("unknown", "chat_caller_delivery_lost");
    if (!current())
      throw new BridgeError("unknown", "chat_caller_delivery_lost");
    return {
      issuanceId: issued.issuanceId,
      firstSequence: issued.firstSequence,
      lastSequence: issued.lastSequence,
    };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("unknown", "chat_caller_delivery_lost");
  } finally {
    withdrawn = true;
    signal.removeEventListener("abort", lost);
    response.off("close", lost);
    response.off("error", lost);
    response.off("drain", drained);
  }
}
