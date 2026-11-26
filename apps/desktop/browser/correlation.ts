import type { PhysicalBinding } from "../chatgpt-physical-api.ts";
import { fail, validId } from "./check.ts";

export type Turn = Readonly<{
  userTurnId: string;
  replyId: string | null;
  conversationId: string;
}>;

export type Correlation = Readonly<{
  userTurnId: string | null;
  replyId: string | null;
}>;

/**
 * Admit the provider turn identifiers an observation reports. Any pair that is
 * malformed, replays the previous turn or contradicts an adopted one is an
 * unknown effect. Null means the provider names no turn yet.
 */
export function correlate(
  binding: PhysicalBinding,
  correlation: Correlation,
  previous: Readonly<{ userTurnId: string; replyId: string }>,
  adopted: Readonly<{
    userId?: string | undefined;
    replyId?: string | undefined;
  }>,
): Turn | null {
  if (
    !correlation ||
    (correlation.userTurnId !== null && !validId(correlation.userTurnId)) ||
    (correlation.replyId !== null && !validId(correlation.replyId)) ||
    (correlation.userTurnId === null && correlation.replyId !== null)
  )
    fail("chat_browser_frame_correlation_unknown", "unknown");
  if (correlation.userTurnId === null) return null;
  if (
    binding.phase !== "conversation" ||
    correlation.userTurnId === previous.userTurnId ||
    correlation.replyId === previous.replyId ||
    (adopted.userId && adopted.userId !== correlation.userTurnId) ||
    (adopted.replyId && adopted.replyId !== correlation.replyId)
  )
    fail("chat_browser_frame_correlation_unknown", "unknown");
  return {
    userTurnId: correlation.userTurnId,
    replyId: correlation.replyId,
    conversationId: binding.conversationId,
  };
}
