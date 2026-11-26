import { z } from "zod";
import { ChatGptAccountObservationSchema } from "../chatgpt-account-probe";
import { PublicTurnFrameSchema } from "../../../src/apps/desktop/chatgpt-public-turn";
import {
  bindingSchema,
  code,
  id,
  observedSchema,
  previousSchema,
} from "./request";

/** Raw page receipts, parsed before the adapter trusts them. */
export const failureSchema = z.strictObject({
  state: z.enum(["refused", "awaiting-owner", "unknown"]),
  code,
});
export const rawWitnessSchema = z.strictObject({
  account: ChatGptAccountObservationSchema.optional(),
  state: z.literal("witnessed"),
  binding: bindingSchema,
  operationId: id,
  evidenceId: id,
  intentDigest: id,
  previous: previousSchema,
  observed: observedSchema,
  sourceProfile: z.literal("message-anchors-v1"),
  baselineUserIds: z.array(id).max(512),
});
export const correlationSchema = z.strictObject({
  userTurnId: id.nullable(),
  replyId: id.nullable(),
});
export const rawObserveSchema = z.strictObject({
  state: z.literal("observed"),
  originBinding: bindingSchema,
  binding: bindingSchema,
  correlation: correlationSchema,
  frame: PublicTurnFrameSchema.nullable(),
  observed: observedSchema,
  sourceProfile: z.literal("message-anchors-v1"),
});
export const sendResultSchema = z.strictObject({
  state: z.enum(["submitted", "not-sent", "unknown"]),
  binding: bindingSchema,
  operationId: id,
  evidenceId: id,
  code,
});
export const cancelSchema = z.union([
  failureSchema,
  z.strictObject({
    state: z.enum(["requested", "unknown"]),
    binding: bindingSchema,
    code,
  }),
  z.strictObject({
    state: z.enum(["confirmed-terminal", "already-terminal"]),
    proof: z.strictObject({
      binding: bindingSchema,
      correlation: z.strictObject({ userTurnId: id, replyId: id }),
      frame: PublicTurnFrameSchema,
    }),
  }),
]);
