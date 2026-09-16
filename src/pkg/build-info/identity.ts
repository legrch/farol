import { z } from "zod";

const canonicalTimestamp = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

export const BuildIdentitySchema = z.strictObject({
  schema: z.literal(1),
  product: z.literal("Farol Next Preview"),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u),
  bundleId: z.literal("local.farol.next.preview"),
  updateChannel: z.literal("local-preview-only"),
  builtAt: canonicalTimestamp,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceTreeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceDirty: z.boolean(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type BuildIdentity = z.infer<typeof BuildIdentitySchema>;

export function canonicalBuildIdentityPayload(identity: BuildIdentity): string {
  return JSON.stringify({
    schema: identity.schema,
    product: identity.product,
    version: identity.version,
    bundleId: identity.bundleId,
    updateChannel: identity.updateChannel,
    builtAt: identity.builtAt,
    sourceCommit: identity.sourceCommit,
    sourceTreeDigest: identity.sourceTreeDigest,
    sourceDirty: identity.sourceDirty,
  });
}
