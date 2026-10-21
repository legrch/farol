import { z } from "zod";

const canonicalTimestamp = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

export const BuildIdentitySchema = z
  .strictObject({
    schema: z.literal(1),
    product: z.literal("Farol"),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u),
    bundleId: z.literal("io.github.legrch.farol"),
    updateChannel: z.enum([
      "local-preview-only",
      "github-owner-beta",
      "github-stable",
    ]),
    buildVersion: z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/u)
      .optional(),
    builtAt: canonicalTimestamp,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceTreeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceDirty: z.boolean(),
    buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .refine(
    (value) =>
      value.updateChannel !== "github-owner-beta" ||
      (value.buildVersion !== undefined &&
        /^[0-9]+\.[0-9]+\.[0-9]+-owner\.beta\.(0|[1-9][0-9]*)$/u.test(
          value.version,
        )),
  )
  .refine(
    (value) =>
      value.updateChannel !== "github-stable" ||
      (value.buildVersion !== undefined &&
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(
          value.version,
        )),
  );

export type BuildIdentity = z.infer<typeof BuildIdentitySchema>;

export function canonicalBuildIdentityPayload(identity: BuildIdentity): string {
  return JSON.stringify({
    schema: identity.schema,
    product: identity.product,
    version: identity.version,
    bundleId: identity.bundleId,
    updateChannel: identity.updateChannel,
    ...(identity.buildVersion === undefined
      ? {}
      : { buildVersion: identity.buildVersion }),
    builtAt: identity.builtAt,
    sourceCommit: identity.sourceCommit,
    sourceTreeDigest: identity.sourceTreeDigest,
    sourceDirty: identity.sourceDirty,
  });
}
