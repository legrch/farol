import { z } from "zod";
import {
  CanonicalAbsolutePathSchema,
  CanonicalTimestampSchema,
  IdentifierSchema,
  Sha256Schema,
} from "./scalar.ts";
import { WorkspaceRootIdentitySchema } from "./workspace.ts";

export const CodexHostCapabilitiesSchema = z.strictObject({
  dynamicTools: z.literal(true),
  correlatedToolCalls: z.literal(true),
  descendantObservation: z.literal(true),
  collabObservation: z.literal(true),
  compaction: z.literal(true),
});

const CodexHostLiveVerificationSchema = z.strictObject({
  model: z.literal("gpt-6-astra"),
  executableSha256: Sha256Schema,
  schemaSha256: Sha256Schema,
  buildId: Sha256Schema,
  dynamicTool: z.literal("farol_ping"),
  verifiedAt: CanonicalTimestampSchema,
});

const CodexHostLocalVerificationSchema = z.strictObject({
  executableSha256: Sha256Schema,
  schemaSha256: Sha256Schema,
  buildId: Sha256Schema,
  verifiedAt: CanonicalTimestampSchema,
});

export const CodexAgentVerificationFieldsSchema = z.strictObject({
  model: z.literal("gpt-6-astra"),
  executableSha256: Sha256Schema,
  schemaSha256: Sha256Schema,
  buildId: Sha256Schema,
  workspaceId: IdentifierSchema,
  computerGeneration: z.number().int().positive(),
  transport: z.literal("codex-native-agent/spawn-prompt-sha256-v1"),
  authorityRole: z.enum(["agent", "critic"]),
  hostRole: z.string().min(1).max(160).nullable(),
  delegationDigest: Sha256Schema,
  parentThreadSha256: Sha256Schema,
  childThreadSha256: Sha256Schema,
  boundedRunning: z.literal(true),
  modelTurnsSubmitted: z.literal(1),
  fallbackAllowed: z.literal(false),
  descendantCount: z.literal(0),
  resultRefProtocol: z.literal("codex-app-server"),
  resultRetention: z.literal("durable"),
  parentDelivery: z.literal("acknowledged"),
  workspaceEnforcement: z.enum(["not_verified", "verified"]),
});

const CodexAgentVerificationSchema = CodexAgentVerificationFieldsSchema.extend({
  verifiedAt: CanonicalTimestampSchema,
});

const CodexTaskSourceBindingShape = {
  executablePath: CanonicalAbsolutePathSchema,
  executableSha256: Sha256Schema,
  baseSchemaSha256: Sha256Schema,
};
const CodexTaskSourceUnavailableSchema = z.strictObject({
  ...CodexTaskSourceBindingShape,
  status: z.literal("unavailable"),
  code: z.enum([
    "CODEX_HOST_SCHEMA_UNSAFE",
    "CODEX_HOST_SCHEMA_INVALID",
    "CODEX_HOST_HANDOFF_UNAVAILABLE",
    "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
    "CODEX_HOST_TASK_SOURCE_CHANGED",
    "CODEX_HOST_TASK_SOURCE_UNCONFIRMED",
  ]),
});

// Source evidence only. A saved witness never issues a Task or serving grant.
export const CodexTaskSourceSchema = z
  .strictObject({
    handoff: z.discriminatedUnion("status", [
      CodexTaskSourceUnavailableSchema,
      z.strictObject({
        ...CodexTaskSourceBindingShape,
        status: z.literal("supported"),
        contract: z.strictObject({
          version: z
            .string()
            .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
          protocol: z.literal("codex-app-server/v2"),
          schemaSha256: Sha256Schema,
          projectBoundCreateStatus: z.literal(true),
        }),
      }),
    ]),
    followup: z.discriminatedUnion("status", [
      CodexTaskSourceUnavailableSchema,
      z.strictObject({
        ...CodexTaskSourceBindingShape,
        status: z.literal("supported"),
        contract: z.strictObject({
          kind: z.literal("codex-followup-schema/v1"),
          protocol: z.literal("codex-app-server/v2"),
          baseSchemaSha256: Sha256Schema,
          schemaSha256: Sha256Schema,
        }),
      }),
    ]),
  })
  .superRefine(({ handoff, followup }, context) => {
    // The producer's final snapshot fence withdraws both witnesses together.
    const changed = (witness: typeof handoff | typeof followup) =>
      witness.status === "unavailable" &&
      witness.code === "CODEX_HOST_TASK_SOURCE_CHANGED";
    if (
      ((changed(handoff) || changed(followup)) &&
        !(changed(handoff) && changed(followup))) ||
      handoff.executablePath !== followup.executablePath ||
      handoff.executableSha256 !== followup.executableSha256 ||
      handoff.baseSchemaSha256 !== followup.baseSchemaSha256 ||
      (handoff.status === "supported" &&
        handoff.contract.schemaSha256 === handoff.baseSchemaSha256) ||
      (followup.status === "supported" &&
        (handoff.status !== "supported" ||
          followup.contract.baseSchemaSha256 !==
            handoff.contract.schemaSha256 ||
          followup.contract.schemaSha256 === handoff.contract.schemaSha256 ||
          followup.contract.schemaSha256 === handoff.baseSchemaSha256))
    )
      context.addIssue({
        code: "custom",
        message: "Task source binding is inconsistent.",
      });
  });
export type CodexTaskSource = z.infer<typeof CodexTaskSourceSchema>;

export const CodexTaskSourceRecordSchema = z.strictObject({
  hostGeneration: z.number().int().positive().safe(),
  localVerification: CodexHostLocalVerificationSchema,
  evidence: CodexTaskSourceSchema,
});
export type CodexTaskSourceRecord = z.infer<typeof CodexTaskSourceRecordSchema>;

export const CodexHostSelectionSchema = z.strictObject({
  executablePath: CanonicalAbsolutePathSchema,
  executableSha256: Sha256Schema,
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
  protocol: z.literal("codex-app-server/v2"),
  schemaSha256: Sha256Schema,
  verifiedAt: CanonicalTimestampSchema,
  localVerification: CodexHostLocalVerificationSchema.nullable().default(null),
  taskSource: CodexTaskSourceRecordSchema.nullable().default(null).optional(),
  liveVerification: CodexHostLiveVerificationSchema.nullable().default(null),
  agentVerification: CodexAgentVerificationSchema.nullable().default(null),
});

export const CodexReadSelectionShape = {
  /** One thread explicitly selected in Settings for read-only observation. */
  observeThreadId: z.string().uuid().optional(),
  /** Exact native turn; never inferred from thread history or a request. */
  observeTurnId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
};

export function validateCodexReadSelection(
  selection: {
    observeThreadId?: string | undefined;
    observeTurnId?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    selection.observeTurnId !== undefined &&
    selection.observeThreadId === undefined
  )
    context.addIssue({
      code: "custom",
      path: ["observeTurnId"],
      message:
        "An exact observation turn requires an explicitly selected thread.",
    });
}

export const CodexTaskSelectionSchema = z
  .strictObject({
    transport: z.literal("codex-shared-proxy/v1"),
    socketPath: CanonicalAbsolutePathSchema,
    expectedCodexHome: CanonicalAbsolutePathSchema,
    workspaceId: IdentifierSchema,
    projectId: IdentifierSchema,
    ...CodexReadSelectionShape,
    projectRoot: CanonicalAbsolutePathSchema,
    projectIdentity: WorkspaceRootIdentitySchema,
    // Live writer witness frozen at route setup (path-bound approval).
    // Routes saved before it fall back to the workspace's saved pair.
    writerIdentity: WorkspaceRootIdentitySchema.optional(),
    gitCommonDirectory: CanonicalAbsolutePathSchema,
    execution: z.strictObject({
      sandbox: z.enum(["read-only", "workspace-write"]),
      approvalPolicy: z.enum(["untrusted", "on-request"]),
    }),
    harness: z.literal("codex"),
    computerGeneration: z.number().int().positive(),
    hostGeneration: z.number().int().positive(),
    approvedAt: CanonicalTimestampSchema,
    expiresAt: z.number().int().positive().safe(),
  })
  .superRefine(validateCodexReadSelection);
export type CodexTaskSelection = z.infer<typeof CodexTaskSelectionSchema>;
