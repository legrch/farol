import { z } from "zod";
import type { ProductTaskSchema } from "../../modules/chat/contract/product-task";

// The record shape `live-tasks.json` has on disk, owned here and nowhere
// else. `PrivateLiveTaskStore` (live-task-store.ts) parses and writes it;
// the promotion reader (`tooling/promotion-obligations.mjs`) validates the
// same file against the same definition before deciding whether anything
// is still running. Until this module existed the reader carried a
// hand-mirrored copy of the store's private schema, which is exactly the
// kind of duplicate that drifts.
//
// Plain module by design: no class, no parameter properties, no enum, so
// Node's unflagged type stripping can load it from the `.mjs` CLI. It also
// carries no runtime import of `product-task.ts`: Node needs a full
// specifier for that (`../../modules/chat/contract/product-task.ts`) and
// `tsc` refuses `.ts` extensions under this project's options, so the task
// schema is a parameter instead. Both consumers pass the one exported
// `ProductTaskSchema`, so both build the identical record schema from the
// identical input; the type-only import above is erased by tsc and by
// Node's type stripping alike.

export const LIVE_TASK_FILE_NAME = "live-tasks.json";
// The store refuses to decode a file larger than this before parsing it;
// the promotion reader must refuse the same bytes, never read them as
// nothing running.
export const MAX_LIVE_TASK_BYTES = 128 * 1_024;
export const LIVE_TASK_CAPACITY = 5;

const canonicalTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

export function liveTaskRecordSchemas(taskSchema: typeof ProductTaskSchema) {
  // A stored task is a product task extended with the two fields the store
  // adds, and never an event-driven one: those are recreated at start, not
  // persisted.
  const storedTask = taskSchema
    .extend({
      provider: z.literal("chatgpt"),
      conversationUrl: z.url().max(2_048).nullable(),
    })
    .refine((task) => task.lifecycle !== "event_driven");
  const record = z.strictObject({
    schema: z.literal(1),
    revision: z.number().int().nonnegative(),
    tasks: z.array(storedTask).max(LIVE_TASK_CAPACITY),
    updatedAt: canonicalTimestampSchema,
  });
  return { storedTask, record };
}
