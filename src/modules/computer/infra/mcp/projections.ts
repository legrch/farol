import type {
  parseTaskCreate,
  parseTaskMessage,
  parseTaskResult,
  parseTaskStatus,
  parseThreadRuntime,
} from "../peer/codex-task-route-peer";
import type { SavedChatBridgeResponse } from "../../../../pkg/saved-chat-bridge/protocol";

type Created = ReturnType<typeof parseTaskCreate>;
type Steered = ReturnType<typeof parseTaskMessage>;
type Status = ReturnType<typeof parseTaskStatus>;
type Result = ReturnType<typeof parseTaskResult>;
type Runtime = ReturnType<typeof parseThreadRuntime>;

// The answer to a caller that cannot know what happened: the one dispatch it
// may read again, never a reason to send under another key.
export function unknownOutcome(dispatchId: string) {
  return { status: "outcome_unknown" as const, dispatchId };
}

// A dispatch is an error unless it was accepted: refused and unknown both are.
export function isRefusedOrUnknown(status: string): boolean {
  return status === "refused" || status === "outcome_unknown";
}

// A created or continued task shows only its status and handle.
export function publicDispatch(result: Created) {
  return result.status === "dispatched"
    ? { status: "dispatched" as const, dispatchId: result.dispatchId }
    : result;
}

export function publicSteer(result: Steered) {
  return result.status === "steered"
    ? { status: "steered" as const, dispatchId: result.dispatchId }
    : result;
}

export function publicStatus(
  result: Status,
  dispatchId: string,
  threadRuntime: Runtime,
) {
  return result.status === "known"
    ? {
        status: "known" as const,
        dispatchId,
        turnStatus: result.turnStatus,
        threadRuntime,
      }
    : result;
}

export function publicResult(
  result: Result,
  dispatchId: string,
  threadRuntime: Runtime,
) {
  return result.status === "completed"
    ? { status: "completed" as const, dispatchId, text: result.text }
    : result.status === "running"
      ? { status: result.status, dispatchId, threadRuntime }
      : result.status === "failed" || result.status === "interrupted"
        ? { status: result.status, dispatchId }
        : result;
}

// A saved chat create answers only for the key it was sent under: an unknown
// or foreign handle is an unknown outcome of that key.
export function safeChatCreate(response: SavedChatBridgeResponse, key: string) {
  return response.status === "unknown" || response.dispatchId !== key
    ? unknownOutcome(key)
    : response;
}
