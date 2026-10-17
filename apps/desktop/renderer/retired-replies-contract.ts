import { z } from "zod";
import { ChatHistoryContextSchema } from "../../../src/pkg/ipc/chat-history";
import {
  RecoveryReadRequestSchema,
  RecoveryReadResultSchema,
} from "./recovery/contract";

// Reuse the stored-copy projection, with no folder or normal execution query.
export const RetiredReplyQuerySchema = RecoveryReadRequestSchema.refine(
  (value) => value.kind === "archive-list" || value.kind === "archive-read",
);
export const RetiredReplyRequestSchema = z.strictObject({
  context: ChatHistoryContextSchema,
  query: RetiredReplyQuerySchema,
});
export const RetiredReplyResponseSchema = z.strictObject({
  context: ChatHistoryContextSchema,
  result: RecoveryReadResultSchema.refine(
    (value) =>
      value.status !== "ok" ||
      value.data.kind === "archive-list" ||
      value.data.kind === "archive-read",
  ),
});
