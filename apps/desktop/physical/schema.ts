import { z } from "zod";
import { ChatGptAccountObservationSchema } from "../chatgpt-account-probe";

// Validate the serialization boundary before putting anything in page code.
export const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const viewSchema = {
  viewId: idSchema,
  viewGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  documentGeneration: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  partition: z.enum([
    "persist:farol-app-chatgpt",
    "persist:farol-dev-chatgpt",
    "persist:farol-owner-preview-chatgpt",
  ]),
};
export const bindingSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...viewSchema,
    phase: z.literal("home"),
    url: z.string().url().max(2048),
    conversationId: z.null(),
  }),
  z.strictObject({
    ...viewSchema,
    phase: z.literal("conversation"),
    url: z.string().url().max(2048),
    conversationId: idSchema,
  }),
]);
export const policySchema = z.strictObject({
  contentProfile: z
    .enum(["message-anchors-v1", "farol-controlled-settled-segments-v1"])
    .optional(),
  accountObservationProfile: z.literal("provider-session-v1").optional(),
  e2eOrigin: z
    .string()
    .max(2048)
    .nullable()
    .refine((value) => {
      if (value === null) return true;
      try {
        const origin = new URL(value);
        return (
          origin.origin === value &&
          origin.protocol === "http:" &&
          (origin.hostname === "127.0.0.1" ||
            origin.hostname === "localhost") &&
          !origin.username &&
          !origin.password &&
          !origin.search &&
          !origin.hash
        );
      } catch {
        return false;
      }
    }),
});

const previousSchema = z
  .strictObject({ userTurnId: idSchema, replyId: idSchema })
  .nullable();
const controlsSchema = z.strictObject({
  modelLabel: idSchema,
  effortLabel: idSchema.nullable(),
  modeLabel: idSchema.nullable(),
  connector: z.strictObject({ id: idSchema, label: idSchema }).nullable(),
});
const requiredControlsSchema = z.strictObject({
  model: z.literal(true),
  effort: z.boolean(),
  mode: z.boolean(),
  connector: z.boolean(),
});
const stringFact = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("observed"),
    source: z.literal("public-dom"),
    value: idSchema,
  }),
  z.strictObject({
    state: z.literal("unknown"),
    code: z.enum(["not-exposed", "unqualified"]),
  }),
]);
const observedSchema = z.strictObject({
  modelLabel: stringFact,
  effortLabel: stringFact,
  modeLabel: stringFact,
  connectorLabel: stringFact,
});
const operationSchema = { binding: bindingSchema, operationId: idSchema };
const verifyFields = {
  ...operationSchema,
  accountDeadlineMillis: z.number().int().positive().safe().optional(),
  previous: previousSchema,
  intentDigest: idSchema,
  controls: controlsSchema,
  requiredControls: requiredControlsSchema,
};
export const verifySchema = z.strictObject(verifyFields);
const witnessSchema = z.strictObject({
  ...verifyFields,
  account: ChatGptAccountObservationSchema.optional(),
  evidenceId: z.string().uuid(),
  observed: observedSchema,
  sourceProfile: z.literal("message-anchors-v1"),
});
export const sendSchema = z.strictObject({
  ...operationSchema,
  accountDeadlineMillis: z.number().int().positive().safe().optional(),
  witness: witnessSchema,
  intentDigest: idSchema,
  prompt: z
    .string()
    .min(1)
    .max(64 * 1024),
});
const submissionSchema = z.strictObject({
  originBinding: bindingSchema,
  operationId: idSchema,
  evidenceId: z.string().uuid(),
  intentDigest: idSchema,
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  baselineUserIds: z.array(idSchema).max(512),
  previous: previousSchema,
  controls: controlsSchema,
  requiredControls: requiredControlsSchema,
});
export const observationSchema = z.strictObject({
  ...operationSchema,
  submission: submissionSchema,
  correlation: z.strictObject({
    userTurnId: idSchema.nullable(),
    replyId: idSchema.nullable(),
  }),
});
