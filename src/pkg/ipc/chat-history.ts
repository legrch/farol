import { z } from "zod";

// Narrow renderer projections. No live handle, owner approval, physical receipt,
// account evidence or privileged Core request is exposed to the renderer.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/u)
  .refine((v) => /^[0-9]+$/u.test(v) && BigInt(v) <= 18446744073709551615n);
export const ChatHistoryContextSchema = z
  .object({ profileId: id, backendGeneration: id })
  .strict();
const key = z.object({ backendGeneration: id, operationId: id }).strict();
const offset = z.number().int().min(0).max(1024);
export const ChatHistoryQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), offset }).strict(),
  z.object({ kind: z.literal("result"), offset, key }).strict(),
]);
export const ChatHistoryRequestSchema = z
  .object({ context: ChatHistoryContextSchema, query: ChatHistoryQuerySchema })
  .strict();
const entry = z
  .object({
    key,
    turnId: id,
    turnGeneration: counter,
    resultId: id,
    conversationId: z.string().min(1).max(256),
  })
  .strict();
export const ChatHistoryValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      offset,
      total: offset,
      entries: z.array(entry).max(32),
    })
    .strict()
    .refine(
      (v) =>
        v.offset <= v.total &&
        v.entries.length === Math.min(32, v.total - v.offset) &&
        new Set(
          v.entries.map((e) =>
            JSON.stringify([e.key.backendGeneration, e.key.operationId]),
          ),
        ).size === v.entries.length,
    ),
  z
    .object({
      kind: z.literal("result"),
      entry,
      text: z
        .string()
        .refine(
          (v) =>
            !/[\ud800-\udfff]/u.test(v) &&
            new TextEncoder().encode(v).length <= 8192,
        ),
    })
    .strict(),
]);
export const ChatHistoryReplySchema = z
  .object({ context: ChatHistoryContextSchema, value: ChatHistoryValueSchema })
  .strict()
  .refine((v) =>
    (v.value.kind === "page" ? v.value.entries : [v.value.entry]).every(
      (e) => e.key.backendGeneration !== v.context.backendGeneration,
    ),
  );
export type ChatHistoryContext = z.infer<typeof ChatHistoryContextSchema>;
export type ChatHistoryQuery = z.infer<typeof ChatHistoryQuerySchema>;
export type ChatHistoryValue = z.infer<typeof ChatHistoryValueSchema>;
export type ChatHistoryReply = z.infer<typeof ChatHistoryReplySchema>;
export function sameHistoryContext(
  a: ChatHistoryContext | null,
  b: ChatHistoryContext | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.profileId === b.profileId &&
    a.backendGeneration === b.backendGeneration
  );
}
