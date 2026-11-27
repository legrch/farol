import { z } from "zod";
import { ChatGptAccountObservationSchema } from "../chatgpt-account-probe";

/** Main-process request and evidence shapes accepted by the physical adapter. */
export const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
export const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const viewFields = {
  viewId: z.string().regex(/^[1-9][0-9]*$/),
  viewGeneration: z.number().int().positive(),
  documentGeneration: z.number().int().nonnegative(),
  partition: z.enum([
    "persist:farol-app-chatgpt",
    "persist:farol-dev-chatgpt",
    "persist:farol-owner-preview-chatgpt",
  ]),
};
export const bindingSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...viewFields,
    phase: z.literal("home"),
    url: z.url(),
    conversationId: z.null(),
  }),
  z.strictObject({
    ...viewFields,
    phase: z.literal("conversation"),
    url: z.url(),
    conversationId: id,
  }),
]);
export const previousSchema = z
  .strictObject({ userTurnId: id, replyId: id })
  .nullable();
export const declarationSchema = z.strictObject({
  provider: id,
  alias: id,
  accountId: id,
  modelId: id,
  effort: z.string().max(256),
  mode: z.string().max(256),
  connectorId: z.string().max(256),
  connectorGrantId: z.string().max(256),
  toolsEnabled: z.boolean(),
});
export const selectionSchema = z.strictObject({
  requested: declarationSchema,
  admitted: declarationSchema,
  resolved: z.strictObject({
    selection: declarationSchema,
    configSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    translationId: id,
  }),
  controls: z.strictObject({
    modelLabel: id,
    effortLabel: id.nullable(),
    modeLabel: id.nullable(),
    connector: z.strictObject({ id, label: id }).nullable(),
  }),
  requiredControls: z.strictObject({
    model: z.literal(true),
    effort: z.boolean(),
    mode: z.boolean(),
    connector: z.boolean(),
  }),
});
export const factSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("observed"),
    source: z.literal("public-dom"),
    value: id,
  }),
  z.strictObject({
    state: z.literal("unknown"),
    code: z.enum(["not-exposed", "unqualified"]),
  }),
]);
export const observedSchema = z.strictObject({
  modelLabel: factSchema,
  effortLabel: factSchema,
  modeLabel: factSchema,
  connectorLabel: factSchema,
});
export const evidenceSchema = z.strictObject({
  declared: selectionSchema,
  observed: observedSchema,
  observedAtMillis: z.number().int().positive(),
  sourceProfile: z.literal("message-anchors-v1"),
});
const boundFields = {
  operationId: id,
  binding: bindingSchema,
  deadlineMillis: z.number().int().positive(),
};
export const boundSchema = z.strictObject(boundFields);
export const witnessSchema = z.strictObject({
  ...boundFields,
  account: ChatGptAccountObservationSchema.optional(),
  evidenceId: id,
  intentDigest: id,
  previous: previousSchema,
  selection: evidenceSchema,
});
export const verifySchema = z.strictObject({
  ...boundFields,
  previous: previousSchema,
  intentDigest: id,
  selection: selectionSchema,
});
export const sendSchema = z.strictObject({
  ...boundFields,
  witness: witnessSchema,
  intentDigest: id,
  prompt: z
    .string()
    .min(1)
    .max(256 * 1024),
});
export const prepareSchema = z.strictObject({
  operationId: id,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("new-saved") }),
    z.strictObject({ kind: z.literal("owned-saved"), conversationId: id }),
  ]),
  deadlineMillis: z.number().int().positive(),
});
