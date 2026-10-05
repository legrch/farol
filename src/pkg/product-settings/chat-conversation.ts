import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\x21-\x7e]+$/u);
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/u)
  .refine(
    (value) =>
      /^[0-9]+$/u.test(value) && BigInt(value) <= 18446744073709551615n,
  );
const text = z
  .string()
  .refine(
    (value) =>
      !/[\ud800-\udfff]/u.test(value) &&
      new TextEncoder().encode(value).length <= 8192,
  );

// Renderer-safe presentation of the existing Go owner. These values do not
// grant Send, select a worker or infer delivery/settlement from result text.
export const ReadConversationViewSchema = z.strictObject({
  kind: z.literal("chatgpt.readonly-conversation"),
  operationId: id,
  handleId: id,
  binding: z.strictObject({
    profileId: id,
    backendGeneration: id,
    ownerId: id,
    sessionId: id,
    taskId: id,
    taskEpoch: counter,
    participantId: id,
    turnId: id,
    operationId: id,
    turnGeneration: counter,
  }),
  conversationId: z.string().max(120),
  phase: id,
  hasResult: z.boolean(),
  deliveryAcknowledged: z.boolean(),
  lifecycleSettled: z.boolean(),
  released: z.boolean(),
  followReady: z.boolean(),
  cursor: counter,
  frames: z
    .array(z.strictObject({ sequence: counter, delta: text.optional() }))
    .max(128),
  result: z
    .strictObject({
      resultId: id,
      outcome: id,
      code: z.string().max(120),
      text,
      complete: z.boolean(),
      acknowledged: z.boolean(),
      retention: z.literal("memory_only"),
    })
    .optional(),
});
export type ReadConversationView = z.infer<typeof ReadConversationViewSchema>;
export const ReadConversationHandleSchema = id;
export const ReadConversationCursorSchema = counter;
export const ReadConversationPromptSchema = text.refine(
  (value) => value.trim().length > 0,
);
