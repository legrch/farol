import {
  ChatHistoryRequestSchema,
  ChatHistoryReplySchema,
  sameHistoryContext,
  type ChatHistoryContext,
} from "../../src/pkg/ipc/chat-history";
import type { ChatHistoryBridge } from "./bridge/chat-history.ts";
import type { ChatHistorySummary } from "./bridge/wire.ts";

export type ChatHistoryHost = Readonly<{
  historyContext: ChatHistoryContext | null;
  history: Pick<ChatHistoryBridge, "list" | "result">;
}>;
const entry = (s: ChatHistorySummary) => ({
  key: s.key,
  turnId: s.binding.turnId,
  turnGeneration: s.binding.turnGeneration,
  resultId: s.resultId,
  conversationId: s.conversationId,
});

// Trusted sender validation belongs to main before this adapter. Each request
// pins the current verified host and performs fresh Go-authorized reads. No map
// retains results/authority and no missing history falls back to a live route.
export async function readChatHistoryView(
  current: () => ChatHistoryHost | null,
  input: unknown,
): Promise<unknown> {
  const parsed = ChatHistoryRequestSchema.safeParse(input);
  if (!parsed.success) return { error: "CHAT_HISTORY_REQUEST_INVALID" };
  const host = current();
  if (!host || !sameHistoryContext(host.historyContext, parsed.data.context))
    return { error: "CHAT_HISTORY_UNAVAILABLE" };
  const valid = () =>
    current() === host &&
    sameHistoryContext(host.historyContext, parsed.data.context);
  try {
    const query = parsed.data.query;
    const page = await host.history.list(query.offset);
    if (!valid()) return { error: "CHAT_HISTORY_STALE" };
    let value;
    if (query.kind === "list")
      value = {
        kind: "page",
        offset: page.offset,
        total: page.total,
        entries: page.entries.map(entry),
      };
    else {
      const selected = page.entries.find(
        (s) =>
          s.key.backendGeneration === query.key.backendGeneration &&
          s.key.operationId === query.key.operationId,
      );
      if (!selected) return { error: "CHAT_HISTORY_REFUSED" };
      const result = await host.history.result(selected);
      if (!valid()) return { error: "CHAT_HISTORY_STALE" };
      value = { kind: "result", entry: entry(selected), text: result.text };
    }
    return ChatHistoryReplySchema.parse({
      context: parsed.data.context,
      value,
    });
  } catch {
    return { error: "CHAT_HISTORY_UNAVAILABLE" };
  }
}
