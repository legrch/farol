import type {
  ChatArchiveSummary,
  ChatArchivePage,
  ChatArchiveReply,
} from "../../apps/desktop/bridge/wire";

// Pure wire/renderer fixture. No native record, old completion, ACK, owner or
// HistoryOrigin is created. Recorded outcome is deliberately not authority.
export function storedSummary(
  index = 1,
  text = "Synthetic stored reply",
): ChatArchiveSummary {
  return {
    key: index.toString(16).padStart(64, "0"),
    digest: "a".repeat(64),
    backendGeneration: "old-backend",
    operationId: `stored-operation-${index}`,
    resultId: `stored-result-${index}`,
    conversationId: "synthetic-conversation",
    recordedOutcome: "completed",
    bytes: new TextEncoder().encode(text).length,
  };
}
export function storedPage(
  entries = [storedSummary()],
  next = "",
  unresolved = true,
): ChatArchivePage {
  return { observation: "stored_unconfirmed", entries, next, unresolved };
}
export function storedReply(
  summary = storedSummary(),
  text = "Synthetic stored reply",
): ChatArchiveReply {
  return { observation: "stored_unconfirmed", summary, text };
}
