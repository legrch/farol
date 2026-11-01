import { z } from "zod";

// The record shape `chatgpt-task-journal.json` has on disk, owned here and
// nowhere else. `PrivateChatGptTaskJournal` (chatgpt-task-journal.ts)
// parses and writes it; the promotion reader
// (`tooling/promotion-obligations.mjs`) validates the same file against the
// same objects before deciding whether a ChatGPT turn is still undelivered.
// Until this module existed the reader carried a hand-mirrored copy of the
// journal's private schemas.
//
// Plain module by design: no class, no parameter properties, no enum, no
// relative import, so Node's unflagged type stripping can load it from the
// `.mjs` CLI.

export const CHATGPT_TASK_JOURNAL_FILE_NAME = "chatgpt-task-journal.json";
export const DEEP_TEST_JOURNAL_PREFIX = "deep-test-";
export const LEGACY_PREPARATION_ARCHIVE_NAME = "legacy-chatgpt-prepared.json";
// The journal refuses to decode a file larger than this before parsing it;
// the promotion reader must refuse the same bytes.
export const MAX_CHATGPT_TASK_JOURNAL_BYTES = 64 * 1_024;

const canonicalTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

export const ChatGptTaskJournalOperationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

export function deepTestJournalFileName(operationId: string): string {
  return `${DEEP_TEST_JOURNAL_PREFIX}${ChatGptTaskJournalOperationIdSchema.parse(operationId)}.json`;
}

export const ChatGptTaskJournalResultSchema = z.strictObject({
  state: z.enum([
    "completed",
    "not_authenticated",
    "failed_before_submit",
    "outcome_unknown",
  ]),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/u)
    .max(120)
    .nullable(),
  deltaCount: z.number().int().nonnegative(),
  observedCharacters: z.number().int().nonnegative(),
  attachmentCount: z.number().int().min(0).max(4),
  totalBytes: z
    .number()
    .int()
    .nonnegative()
    .max(20 * 1_024 * 1_024),
  stagingCleanup: z.enum(["removed", "pending_startup_cleanup"]).nullable(),
});

export const ChatGptTaskJournalRecordSchema = z.strictObject({
  schema: z.literal(1),
  operationId: ChatGptTaskJournalOperationIdSchema,
  kind: z.enum(["readonly", "attachment"]),
  phase: z.enum([
    "prepared",
    "dispatch_intent",
    "result_retained",
    "delivery_acknowledged",
  ]),
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
  result: ChatGptTaskJournalResultSchema.nullable(),
});

export type ChatGptTaskJournalResult = z.infer<
  typeof ChatGptTaskJournalResultSchema
>;
export type ChatGptTaskJournalRecord = z.infer<
  typeof ChatGptTaskJournalRecordSchema
>;
