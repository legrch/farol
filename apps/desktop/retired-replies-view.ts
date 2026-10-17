import {
  sameHistoryContext,
  type ChatHistoryContext,
} from "../../src/pkg/ipc/chat-history";
import {
  RetiredReplyRequestSchema,
  RetiredReplyResponseSchema,
} from "./renderer/retired-replies-contract";
import type { RecoveryArchiveReader } from "./recovery/archive";

export type RetiredReplyHost = Readonly<{
  historyContext: ChatHistoryContext | null;
  retiredReplies: Pick<RecoveryArchiveReader, "list" | "read">;
}>;

// Main validates the original sender first. No renderer path or archive name
// crosses this boundary; Go selects fixed retired children of its own profile.
export async function readRetiredRepliesView(
  current: () => RetiredReplyHost | null,
  input: unknown,
): Promise<unknown> {
  const parsed = RetiredReplyRequestSchema.safeParse(input);
  if (!parsed.success) return { error: "RETIRED_REPLY_REQUEST_INVALID" };
  const host = current();
  if (!host || !sameHistoryContext(host.historyContext, parsed.data.context))
    return { error: "RETIRED_REPLY_UNAVAILABLE" };
  const valid = () =>
    current() === host &&
    sameHistoryContext(host.historyContext, parsed.data.context);
  try {
    const query = parsed.data.query;
    let data;
    if (query.kind === "archive-list") {
      const page = await host.retiredReplies.list(query.after);
      data = { kind: "archive-list", after: query.after, ...page };
    } else if (query.kind === "archive-read") {
      const reply = await host.retiredReplies.read(query.key, query.digest);
      data = { kind: "archive-read", ...reply };
    } else return { error: "RETIRED_REPLY_REQUEST_INVALID" };
    if (!valid()) return { error: "RETIRED_REPLY_STALE" };
    return RetiredReplyResponseSchema.parse({
      context: parsed.data.context,
      result: { status: "ok", data },
    });
  } catch {
    return { error: "RETIRED_REPLY_UNAVAILABLE" };
  }
}
