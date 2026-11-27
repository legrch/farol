import type { z } from "zod";
import {
  sameHistoryContext,
  type ChatHistoryContext,
  type ChatHistoryQuery,
  type ChatHistoryReply,
} from "../../pkg/ipc/chat-history";
import type {
  RetiredReplyQuerySchema,
  RetiredReplyResponseSchema,
} from "../../../apps/desktop/renderer/retired-replies-contract";
import type { WindowSnapshot } from "./contract";

type RetiredQuery = z.infer<typeof RetiredReplyQuerySchema>;
type RetiredResponse = z.infer<typeof RetiredReplyResponseSchema>;

/** Revisions captured before a read, compared again when its reply arrives. */
export type ReadRevisions = Readonly<{
  stale: number;
  runtime: number;
  history: number;
}>;

/** A read cannot start once the window is gone, stale or without context. */
export function readUnavailable(
  disposed: boolean,
  before: WindowSnapshot,
  hasTransport: boolean,
): boolean {
  return disposed || before.status !== "current" || !hasTransport;
}

/** A reply is stale when anything it was asked against has since moved. */
export function readSuperseded(input: {
  disposed: boolean;
  before: WindowSnapshot;
  now: WindowSnapshot;
  context: ChatHistoryContext;
  captured: ReadRevisions;
  current: ReadRevisions;
}): boolean {
  const { before, now, captured, current } = input;
  return (
    input.disposed ||
    now.status !== "current" ||
    captured.stale !== current.stale ||
    captured.runtime !== current.runtime ||
    captured.history !== current.history ||
    before.buildId !== now.buildId ||
    !sameHistoryContext(input.context, now.chatHistoryContext)
  );
}

/** A chat-history reply must answer exactly the query it was sent for. */
export function chatHistoryCrossed(
  reply: ChatHistoryReply,
  context: ChatHistoryContext,
  request: ChatHistoryQuery,
): boolean {
  if (
    !sameHistoryContext(reply.context, context) ||
    reply.value.kind !== (request.kind === "list" ? "page" : "result")
  )
    return true;
  if (
    request.kind === "list" &&
    reply.value.kind === "page" &&
    reply.value.offset !== request.offset
  )
    return true;
  return (
    request.kind === "result" &&
    reply.value.kind === "result" &&
    (reply.value.entry.key.operationId !== request.key.operationId ||
      reply.value.entry.key.backendGeneration !== request.key.backendGeneration)
  );
}

/** A retired-reply response must be ok and answer the query it was sent for. */
export function retiredReplyCrossed(
  reply: RetiredResponse,
  context: ChatHistoryContext,
  request: RetiredQuery,
): boolean {
  if (
    !sameHistoryContext(reply.context, context) ||
    reply.result.status !== "ok"
  )
    return true;
  const value = reply.result.data;
  return (
    (request.kind === "archive-list" &&
      (value.kind !== "archive-list" || value.after !== request.after)) ||
    (request.kind === "archive-read" &&
      (value.kind !== "archive-read" ||
        value.summary.key !== request.key ||
        value.summary.digest !== request.digest))
  );
}

/** Same-context test that also treats two absent contexts as equal. */
export function sameOrBothAbsent(
  next: ChatHistoryContext | null,
  current: ChatHistoryContext | null,
): boolean {
  return (
    sameHistoryContext(next, current) || (next === null && current === null)
  );
}
