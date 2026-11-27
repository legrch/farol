import { z } from "zod";
import { CanonicalTimestampSchema, IdentifierSchema } from "./scalar.ts";

export const SetupVerificationSchema = z.strictObject({
  profile: z.string().min(1).max(160),
  configRevision: z.number().int().positive(),
  workspaceId: IdentifierSchema.nullable(),
  runtimeGeneration: z.string().min(1).max(160),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  protocol: z.string().min(1).max(160),
  verifiedAt: CanonicalTimestampSchema,
});

export const SetupReadinessSchema = z.strictObject({
  visited: z.boolean(),
  skipped: z.boolean(),
  configured: z.boolean(),
  reachable: z.enum(["unknown", "reachable", "unreachable"]),
  verified: SetupVerificationSchema.nullable(),
  needsAction: z.string().min(1).max(240).nullable(),
  unavailable: z.string().min(1).max(240).nullable(),
  outcomeUnknown: z.boolean(),
  // The typed recovery a step waits for; its wording lives in needsAction.
  recovery: z.enum(["rejoin_agent"]).optional(),
});

export const SetupStepIdSchema = z.enum([
  "chatgpt",
  "computer",
  "connect",
  "hosts",
  "verify",
]);
