import { z } from "zod";

// Metadata only: no prompt, answer, DOM payload, URL or authentication fields.
// Validate without trimming, case folding or rewriting literal control values.
const textSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value),
  );
const counterSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const bindingSchema = z.strictObject({
  taskId: textSchema,
  conversationId: textSchema,
  documentGeneration: counterSchema,
  buildId: textSchema,
});
const requestedSchema = z.strictObject({
  binding: bindingSchema,
  model: textSchema,
  effort: textSchema,
});
const effortSchema = z.strictObject({
  effort: textSchema,
  aliases: z.array(textSchema).max(16),
  publicValues: z.array(textSchema).min(1).max(16),
});
const modelSchema = z.strictObject({
  model: textSchema,
  aliases: z.array(textSchema).max(16),
  publicValues: z.array(textSchema).min(1).max(16),
  efforts: z.array(effortSchema).min(1).max(32),
});

export const ChatGptModelBeforeSendSchema = z.strictObject({
  current: bindingSchema,
  requested: requestedSchema,
  observed: z.strictObject({
    binding: bindingSchema,
    // One value per visible selected control. Do not deduplicate identical
    // controls: two identical labels still mean an ambiguous observation.
    modelValues: z.array(textSchema).max(8),
    effortValues: z.array(textSchema).max(8),
    observedAtMs: counterSchema,
  }),
  catalogue: z.array(modelSchema).min(1).max(64),
  nowMs: counterSchema,
  maxAgeMs: counterSchema,
});

export type ChatGptModelBeforeSendInput = z.infer<
  typeof ChatGptModelBeforeSendSchema
>;
type Binding = Readonly<z.infer<typeof bindingSchema>>;
export type ChatGptModelSelectionEvidence = Readonly<{
  requested: Readonly<{ binding: Binding; model: string; effort: string }>;
  observed: Readonly<{
    binding: Binding;
    model: string;
    effort: string;
    observedAtMs: number;
  }>;
  validatedAtMs: number;
}>;
export type ChatGptModelBeforeSendCode =
  | "CHATGPT_MODEL_INVALID"
  | "CHATGPT_MODEL_CATALOGUE_AMBIGUOUS"
  | "CHATGPT_MODEL_BINDING_STALE"
  | "CHATGPT_MODEL_OBSERVATION_STALE"
  | "CHATGPT_MODEL_REQUEST_UNSUPPORTED"
  | "CHATGPT_MODEL_SELECTION_MISSING"
  | "CHATGPT_MODEL_SELECTION_AMBIGUOUS"
  | "CHATGPT_MODEL_OBSERVATION_UNSUPPORTED"
  | "CHATGPT_MODEL_SELECTION_MISMATCH";
export type ChatGptModelBeforeSendResult =
  | Readonly<{ ok: true; evidence: ChatGptModelSelectionEvidence }>
  | Readonly<{ ok: false; code: ChatGptModelBeforeSendCode }>;

function sameBinding(left: Binding, right: Binding): boolean {
  return (
    left.taskId === right.taskId &&
    left.conversationId === right.conversationId &&
    left.documentGeneration === right.documentGeneration &&
    left.buildId === right.buildId
  );
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Pure admission check immediately before Send; a false result blocks Send.
 * The caller supplies its supported catalogue and fresh public-control capture.
 * Request aliases and public values are separate namespaces: neither is inferred
 * from the other, a route alias, a model response or a built-in model list.
 *
 * Capture and current binding must come from the same task/conversation/build
 * and document generation. The caller owns generation advancement, clock domain
 * and maximum age, plus invalidation on navigation/selection changes. A success
 * is evidence for this check only, not a reusable Send permit or DOM proof. Keep
 * validation and Send under the route's existing mutation guard; no await or
 * intervening selection change may reuse this result without fresh validation.
 */
export function validateChatGptModelBeforeSend(
  candidate: unknown,
): ChatGptModelBeforeSendResult {
  const parsed = ChatGptModelBeforeSendSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "CHATGPT_MODEL_INVALID" };
  const { current, requested, observed, catalogue, nowMs, maxAgeMs } =
    parsed.data;

  if (
    !unique(catalogue.flatMap((model) => [model.model, ...model.aliases])) ||
    !unique(catalogue.flatMap((model) => model.publicValues)) ||
    catalogue.some(
      (model) =>
        !unique(
          model.efforts.flatMap((effort) => [effort.effort, ...effort.aliases]),
        ) || !unique(model.efforts.flatMap((effort) => effort.publicValues)),
    )
  )
    return { ok: false, code: "CHATGPT_MODEL_CATALOGUE_AMBIGUOUS" };

  if (
    !sameBinding(current, requested.binding) ||
    !sameBinding(current, observed.binding)
  ) {
    return { ok: false, code: "CHATGPT_MODEL_BINDING_STALE" };
  }
  if (
    observed.observedAtMs > nowMs ||
    nowMs - observed.observedAtMs > maxAgeMs
  ) {
    return { ok: false, code: "CHATGPT_MODEL_OBSERVATION_STALE" };
  }

  const requestedModel = catalogue.find(
    (model) =>
      model.model === requested.model ||
      model.aliases.includes(requested.model),
  );
  const requestedEffort = requestedModel?.efforts.find(
    (effort) =>
      effort.effort === requested.effort ||
      effort.aliases.includes(requested.effort),
  );
  if (!requestedModel || !requestedEffort) {
    return { ok: false, code: "CHATGPT_MODEL_REQUEST_UNSUPPORTED" };
  }
  if (!observed.modelValues.length || !observed.effortValues.length) {
    return { ok: false, code: "CHATGPT_MODEL_SELECTION_MISSING" };
  }
  if (observed.modelValues.length !== 1 || observed.effortValues.length !== 1) {
    return { ok: false, code: "CHATGPT_MODEL_SELECTION_AMBIGUOUS" };
  }
  const modelValue = observed.modelValues[0]!;
  const effortValue = observed.effortValues[0]!;
  // Resolve the observation independently; never substitute requested values.
  const observedModel = catalogue.find((model) =>
    model.publicValues.includes(modelValue),
  );
  const observedEffort = observedModel?.efforts.find((effort) =>
    effort.publicValues.includes(effortValue),
  );
  if (!observedModel || !observedEffort) {
    return { ok: false, code: "CHATGPT_MODEL_OBSERVATION_UNSUPPORTED" };
  }
  if (observedModel !== requestedModel || observedEffort !== requestedEffort) {
    return { ok: false, code: "CHATGPT_MODEL_SELECTION_MISMATCH" };
  }
  return {
    ok: true,
    evidence: {
      requested,
      observed: {
        binding: observed.binding,
        model: modelValue,
        effort: effortValue,
        observedAtMs: observed.observedAtMs,
      },
      validatedAtMs: nowMs,
    },
  };
}
