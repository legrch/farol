import { z } from "zod";
import { readConnectorSetupReceipt } from "./connector-setup-receipt.ts";
import {
  CanonicalAbsolutePathSchema,
  CanonicalTimestampSchema,
  IdentifierSchema,
  Sha256Schema,
} from "./scalar.ts";

const SecureMcpTunnelClientSchema = z.strictObject({
  executablePath: CanonicalAbsolutePathSchema,
  executableSha256: Sha256Schema,
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
  protocol: z.literal("openai-tunnel-client/v1"),
  verifiedAt: CanonicalTimestampSchema,
});

const SecureMcpRuntimeSchema = z.strictObject({
  state: z.enum(["ready", "unreachable", "outcome_unknown"]),
  connectorGeneration: z.number().int().positive(),
  runtimeGeneration: Sha256Schema,
  computerGeneration: z.number().int().positive(),
  buildId: Sha256Schema,
  observedAt: CanonicalTimestampSchema,
});

const SecureMcpChallengeSchema = z.strictObject({
  value: IdentifierSchema,
  challengeSha256: Sha256Schema,
  runtimeGeneration: Sha256Schema,
  computerGeneration: z.number().int().positive(),
  buildId: Sha256Schema,
  preparedAt: CanonicalTimestampSchema,
});

const SecureMcpAttachmentSchema = z.strictObject({
  tunnelId: z.string().min(1).max(160),
  workspaceId: IdentifierSchema.nullable(),
  connectorGeneration: z.number().int().positive(),
  runtimeGeneration: Sha256Schema,
  computerGeneration: z.number().int().positive(),
  buildId: Sha256Schema,
  challengeSha256: Sha256Schema,
  receiptSha256: Sha256Schema,
  verifiedAt: CanonicalTimestampSchema,
});

export const SecureMcpAppSelectionSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u),
  tunnelId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[0-9A-Za-z._:-]+$/u),
  connectorGeneration: z.number().int().positive(),
});

export const SecureMcpConnectorSchema = z.strictObject({
  generation: z.number().int().positive(),
  profile: z.literal("farol"),
  tunnelId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[0-9A-Za-z._:-]+$/u)
    .nullable(),
  tunnelClient: SecureMcpTunnelClientSchema.nullable(),
  credential: z.enum(["missing", "stored"]),
  // Explicit owner choice for embedded checks, never inferred from the build
  // environment or a legacy product name. Old settings have no app selection.
  chatgptApp: SecureMcpAppSelectionSchema.nullable().optional(),
  // An uncertain external Send is independent of local connector lifecycle.
  appVerificationPending: z.boolean().optional(),
  runtime: SecureMcpRuntimeSchema.nullable(),
  challenge: SecureMcpChallengeSchema.nullable().default(null),
  attachment: SecureMcpAttachmentSchema.nullable(),
  // A completed onboarding check survives a runtime restart. It is historical
  // evidence only; live Computer access still requires the current attachment.
  lastVerifiedAttachment: SecureMcpAttachmentSchema.nullable().default(null),
});

export const DefaultSecureMcpConnector = {
  generation: 1,
  profile: "farol" as const,
  tunnelId: null,
  tunnelClient: null,
  credential: "missing" as const,
  runtime: null,
  challenge: null,
  attachment: null,
  lastVerifiedAttachment: null,
};

export const SeparateAppVerificationScopeSchema = z.strictObject({
  ownerAuthorized: z.literal(true),
  tunnelId: SecureMcpAppSelectionSchema.shape.tunnelId,
  appName: SecureMcpAppSelectionSchema.shape.name,
  connectorGeneration: z.number().int().positive(),
  computerGeneration: z.number().int().positive(),
  runtimeGeneration: Sha256Schema,
  challengeSha256: Sha256Schema,
  buildId: Sha256Schema,
  workspaceId: IdentifierSchema.nullable(),
});
export type SeparateAppVerificationScope = z.infer<
  typeof SeparateAppVerificationScopeSchema
>;

export const ConnectorTunnelIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[0-9A-Za-z._:-]+$/u);
export const ConnectorRuntimeKeySchema = z
  .string()
  .min(20)
  .max(512)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 33 && code <= 126;
    }),
  );

export const ConnectorAttemptSchema = z.strictObject({
  method: z.literal("computer.connector.open"),
  requestId: IdentifierSchema,
  operationId: IdentifierSchema,
  outcome: z.enum(["known", "unknown"]),
});

// Reuse the receipt owner's strict, content-free parser. Never copy an
// unvalidated receipt (including unknown fields or accessors) into a result.
export const ConnectorSetupReceiptSchema = z
  .unknown()
  .transform((value, context) => {
    const receipt = readConnectorSetupReceipt(value);
    if (
      receipt &&
      IdentifierSchema.safeParse(receipt.operationId).success &&
      (!receipt.connectorAttempt ||
        ConnectorAttemptSchema.safeParse(receipt.connectorAttempt).success)
    )
      return receipt;
    context.addIssue({
      code: "custom",
      message: "Connector setup receipt is invalid.",
    });
    return z.NEVER;
  });
