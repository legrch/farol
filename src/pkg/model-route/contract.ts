import { z } from "zod";

// Permanent wire identity, independent of Preview/Dev application isolation.
export const FAROL_PROVIDER_ID = "farol";
export const CHATGPT_MODEL_ID = "chatgpt";

// A model ID is local to the Farol provider. A slash-qualified display name
// is never accepted as a wire model or split to select a provider implicitly.
export const FarolModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u);

export const FarolModelRouteSchema = z.strictObject({
  provider: z.literal(FAROL_PROVIDER_ID),
  model: FarolModelIdSchema,
});
export type FarolModelRoute = Readonly<z.infer<typeof FarolModelRouteSchema>>;

export const CHATGPT_ROUTE: FarolModelRoute = Object.freeze({
  provider: FAROL_PROVIDER_ID,
  model: CHATGPT_MODEL_ID,
});

export function formatFarolModelRoute(candidate: unknown): string {
  const route = FarolModelRouteSchema.parse(candidate);
  return `${route.provider}/${route.model}`;
}

// This is an exact catalogue, not a prefix-based adapter dispatcher. Future
// adapters and explicit pins must register their own entries after capability
// qualification. A syntactically valid model is not necessarily supported.
export const FAROL_MODEL_CATALOGUE = Object.freeze([
  Object.freeze({
    id: CHATGPT_MODEL_ID,
    displayName: "ChatGPT",
    upstream: "chatgpt",
    selection: "latest-qualified" as const,
  }),
]);

export function findFarolModel(candidate: unknown) {
  const parsed = FarolModelRouteSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return (
    FAROL_MODEL_CATALOGUE.find((entry) => entry.id === parsed.data.model) ??
    null
  );
}
