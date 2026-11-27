import { z } from "zod";
import { ReadConversationViewSchema } from "./chat-conversation.ts";
import { TaskModelCatalogueViewSchema } from "../owner-config/contract.ts";
import {
  CHATGPT_MODEL_ID,
  FAROL_PROVIDER_ID,
} from "../model-route/contract.ts";
import {
  CanonicalAbsolutePathSchema,
  CanonicalTimestampSchema,
  IdentifierSchema,
  ProductRelativePathSchema,
  ProductScopeRelativePathSchema,
  ProductSearchPatternSchema,
  ProductWorkspaceEntrySchema,
  Sha256Schema,
} from "./scalar.ts";
import {
  CodexAgentVerificationFieldsSchema,
  CodexHostCapabilitiesSchema,
  CodexHostSelectionSchema,
} from "./codex.ts";

const ChatGptAttachmentMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

const ChatGptAttachmentMetadataSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.includes("/") && !value.includes("\\")),
  mimeType: ChatGptAttachmentMimeTypeSchema,
  bytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1_024 * 1_024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const DiscoveryCandidateSchema = z.strictObject({
  requestedPath: CanonicalAbsolutePathSchema,
  path: CanonicalAbsolutePathSchema,
  source: z.enum([
    "chatgpt-app",
    "codex-app",
    "homebrew",
    "npm-global",
    "reviewed-build-dir",
  ]),
  bytes: z.number().int().nonnegative().optional(),
  sha256: Sha256Schema.optional(),
  origin: z.enum([
    "reviewed-digest",
    "signed-by-openai",
    "signature-other-team",
    "unsigned",
    "unknown",
  ]),
  verdict: z.enum(["offer", "needs-owner-choice", "refused"]),
  refusalReason: z
    .enum([
      "not-a-regular-file",
      "world-or-group-writable",
      "wrong-owner",
      "oversize",
      "changed-during-discovery",
      "symlink-loop",
      "unreadable",
    ])
    .optional(),
});

// What a Ping did at each best-effort preparation step before it typed and
// sent. A step that could not be done never stops the Ping; it only says so.
// Closed lowercase values; no page text, address or identifier.
export const ConnectionCheckStepsSchema = z.strictObject({
  // The chat was a Temporary chat by its address, or it was not.
  temporary: z.enum(["temporary", "not_temporary"]),
  // Instant was selected, could not be (its controls were unusable), the chip
  // shows another model, or no model control was found at all.
  model: z.enum([
    "instant",
    "instant_unavailable",
    "other_model",
    "model_unrecognized",
  ]),
  // Personalization was set, or its control is absent or unrecognized.
  personalization: z.enum(["set", "unavailable"]),
});
export type ConnectionCheckSteps = z.infer<typeof ConnectionCheckStepsSchema>;

export const ProductConfigurationEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("connector.connection-check"),
    operationId: IdentifierSchema,
    receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    // A replay observes a historical result; it never claims a new current test.
    retained: z.boolean(),
    // Present and false only when the check ran with no currently verified
    // folder: the tunnel is proven, but no attachment was recorded.
    attachmentRecorded: z.literal(false).optional(),
    // Present for a check that ran now; a replay has none.
    steps: ConnectionCheckStepsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("chatgpt.deep-test-result"),
    operationId: IdentifierSchema,
    state: z.enum([
      "completed",
      "send_requested",
      "not_authenticated",
      "failed_before_submit",
      "outcome_unknown",
    ]),
    code: z.string().max(120).nullable(),
  }),
  z.strictObject({
    kind: z.literal("chatgpt.deep-test-status"),
    attempts: z
      .array(
        z.strictObject({
          operationId: IdentifierSchema,
          state: z.enum([
            "completed",
            "send_requested",
            "not_authenticated",
            "failed_before_submit",
            "outcome_unknown",
          ]),
          code: z.string().max(120).nullable(),
        }),
      )
      .max(256),
  }),
  ReadConversationViewSchema,
  z
    .strictObject({
      kind: z.literal("chatgpt.sign-in-status"),
      observationId: IdentifierSchema,
      buildId: Sha256Schema,
      state: z.enum(["authenticated", "signed_out", "unknown"]),
      binding: z
        .strictObject({
          documentGeneration: z.number().int().nonnegative(),
          sequence: z.number().int().positive(),
        })
        .nullable(),
    })
    .refine((value) => value.state === "unknown" || value.binding !== null),
  z.strictObject({
    kind: z.literal("chatgpt.chat-account-preview"),
    operationId: IdentifierSchema,
    sessionId: IdentifierSchema,
    confirmationId: IdentifierSchema,
    state: z.literal("observed"),
  }),
  z.strictObject({
    kind: z.literal("host.task-models"),
    view: TaskModelCatalogueViewSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-pick"),
    selectionId: IdentifierSchema,
    // Presentation only. Add still consumes the host's sealed selection ID.
    displayPath: CanonicalAbsolutePathSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-selection"),
    workspaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("host.codex-discovery"),
    candidates: z.array(DiscoveryCandidateSchema).max(32),
    searched: z.array(CanonicalAbsolutePathSchema).max(32),
  }),
  z.strictObject({
    kind: z.literal("connector.client-discovery"),
    candidates: z.array(DiscoveryCandidateSchema).max(32),
    searched: z.array(CanonicalAbsolutePathSchema).max(32),
  }),
  z.strictObject({
    kind: z.literal("host.codex-probe"),
    version: CodexHostSelectionSchema.shape.version,
    protocol: CodexHostSelectionSchema.shape.protocol,
    executableSha256: Sha256Schema,
    schemaSha256: Sha256Schema,
    capabilities: CodexHostCapabilitiesSchema,
  }),
  z.strictObject({
    kind: z.literal("host.route-b"),
    provider: z.literal(FAROL_PROVIDER_ID),
    model: z.literal(CHATGPT_MODEL_ID),
    deltaCount: z.number().int().positive(),
    observedCharacters: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("host.codex-live"),
    model: z.literal("gpt-6-astra"),
    threadState: z.literal("completed"),
    dynamicToolCalls: z.literal(1),
    executableSha256: Sha256Schema,
    schemaSha256: Sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("connector.client-probe"),
    version: z
      .string()
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
    protocol: z.literal("openai-tunnel-client/v1"),
    executableSha256: Sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("connector.polling"),
    state: z.enum(["recent", "stale", "no_success", "unknown"]),
    runtimeGeneration: Sha256Schema,
    connectorGeneration: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u),
    computerGeneration: z.number().int().positive(),
    buildId: Sha256Schema,
    observedAtMillis: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  }),
  z.strictObject({
    kind: z.literal("connector.runtime"),
    state: z.enum(["ready", "unreachable", "outcome_unknown"]),
    runtimeGeneration: Sha256Schema,
    computerGeneration: z.number().int().positive(),
    buildId: Sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("connector.attachment"),
    runtimeGeneration: Sha256Schema,
    computerGeneration: z.number().int().positive(),
    workspaceId: IdentifierSchema.nullable(),
    challengeSha256: Sha256Schema,
    receiptSha256: Sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("dev-proof.prepared"),
    proofId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    computerGeneration: z.number().int().positive(),
    buildId: Sha256Schema,
    allowedPath: z.literal("sentinel.txt"),
    deniedPath: z.literal("outside-link.txt"),
  }),
  z.strictObject({
    kind: z.literal("dev-proof.verified"),
    proofId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    environment: z.literal("dev"),
    runtimeGeneration: Sha256Schema,
    computerGeneration: z.number().int().positive(),
    buildId: Sha256Schema,
    sentinelSha256: Sha256Schema,
    answerSha256: Sha256Schema,
    receiptSha256: Sha256Schema,
    outsideGrantError: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/u)
      .max(120),
  }),
  CodexAgentVerificationFieldsSchema.extend({
    kind: z.literal("host.codex-agent-lineage"),
  }),
  z.strictObject({
    kind: z.literal("chatgpt.readiness"),
    state: z.enum([
      "authenticated",
      "signed_out",
      "unreachable",
      "unsupported",
    ]),
    code: z
      .enum([
        "CHATGPT_PAGE_UNREACHABLE",
        "CHATGPT_SIGN_IN_REQUIRED",
        "CHATGPT_UI_UNRECOGNIZED",
      ])
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal("chatgpt.readonly-task-preview"),
    sendAvailable: z.boolean().optional(),
    operationId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    workspaceLabel: z.string().trim().min(1).max(120),
    relativePath: ProductRelativePathSchema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024),
    contextCharacters: z.number().int().nonnegative().max(24_000),
    contextLimit: z.literal(24_000),
    contextTruncated: z.boolean(),
    excludedPaths: z.array(ProductRelativePathSchema).max(32),
    expiresAt: CanonicalTimestampSchema,
    account: z
      .strictObject({
        confirmationId: IdentifierSchema,
        state: z.enum(["observed", "approved"]),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("chatgpt.readonly-task"),
    operationId: IdentifierSchema,
    state: z.enum([
      "completed",
      "not_authenticated",
      "failed_before_submit",
      "outcome_unknown",
    ]),
    code: z
      .enum([
        "CHATGPT_TASK_IN_PROGRESS",
        "CHATGPT_PAGE_UNREACHABLE",
        "CHATGPT_SIGN_IN_REQUIRED",
        "CHATGPT_UI_UNRECOGNIZED",
        "CHATGPT_COMPOSER_UNAVAILABLE",
        "CHATGPT_SUBMIT_UNAVAILABLE",
        "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
        "CHATGPT_APP_SELECTION_MISSING",
        "CHATGPT_APP_SELECTION_AMBIGUOUS",
        "CHATGPT_APP_SELECTION_CONFLICT",
        "CHATGPT_APP_SELECTION_LOST",
        "CHATGPT_COMPOSER_DRAFT_PRESENT",
        "CHATGPT_TEMPORARY_CHAT_REQUIRED",
        "CHATGPT_INSTANT_MODEL_REQUIRED",
        "CHATGPT_TASK_PAGE_LOST",
        "CHATGPT_TASK_ERROR",
        "CHATGPT_USAGE_LIMITED",
        "CHATGPT_TASK_OUTPUT_CHANGED",
        "CHATGPT_TASK_TIMEOUT",
      ])
      .nullable(),
    workspaceId: IdentifierSchema,
    relativePath: ProductRelativePathSchema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024),
    contextCharacters: z.number().int().nonnegative().max(24_000),
    contextLimit: z.literal(24_000),
    contextTruncated: z.boolean(),
    deltaCount: z.number().int().nonnegative(),
    observedCharacters: z.number().int().nonnegative(),
    conversationContinuity: z.enum([
      "retained",
      "not_observed",
      "review_required",
      "unavailable",
    ]),
    redelivered: z.boolean(),
    deliveryAckRequired: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("chatgpt.attachment-task-preview"),
    operationId: IdentifierSchema,
    attachments: z.array(ChatGptAttachmentMetadataSchema).min(1).max(4),
    totalBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1_024 * 1_024),
    expiresAt: CanonicalTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.attachment-task"),
    operationId: IdentifierSchema,
    state: z.enum([
      "completed",
      "not_authenticated",
      "failed_before_submit",
      "outcome_unknown",
    ]),
    code: z
      .enum([
        "CHATGPT_TASK_IN_PROGRESS",
        "CHATGPT_PAGE_UNREACHABLE",
        "CHATGPT_SIGN_IN_REQUIRED",
        "CHATGPT_UI_UNRECOGNIZED",
        "CHATGPT_COMPOSER_UNAVAILABLE",
        "CHATGPT_SUBMIT_UNAVAILABLE",
        "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
        "CHATGPT_APP_SELECTION_MISSING",
        "CHATGPT_APP_SELECTION_AMBIGUOUS",
        "CHATGPT_APP_SELECTION_CONFLICT",
        "CHATGPT_APP_SELECTION_LOST",
        "CHATGPT_COMPOSER_DRAFT_PRESENT",
        "CHATGPT_TEMPORARY_CHAT_REQUIRED",
        "CHATGPT_INSTANT_MODEL_REQUIRED",
        "CHATGPT_TASK_PAGE_LOST",
        "CHATGPT_TASK_ERROR",
        "CHATGPT_USAGE_LIMITED",
        "CHATGPT_TASK_OUTPUT_CHANGED",
        "CHATGPT_TASK_TIMEOUT",
        "CHATGPT_ATTACHMENT_CONTROL_UNAVAILABLE",
        "CHATGPT_ATTACHMENT_UPLOAD_FAILED",
        "CHATGPT_ATTACHMENT_UPLOAD_TIMEOUT",
      ])
      .nullable(),
    attachmentCount: z.number().int().min(1).max(4),
    totalBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1_024 * 1_024),
    deltaCount: z.number().int().nonnegative(),
    observedCharacters: z.number().int().nonnegative(),
    stagingCleanup: z.enum(["removed", "pending_startup_cleanup"]),
    conversationContinuity: z.enum([
      "retained",
      "not_observed",
      "review_required",
      "unavailable",
    ]),
    redelivered: z.boolean(),
    deliveryAckRequired: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("chatgpt.task-recovery"),
    operationId: IdentifierSchema,
    taskKind: z.enum(["readonly", "attachment"]),
    state: z.enum([
      "completed",
      "not_authenticated",
      "failed_before_submit",
      "outcome_unknown",
    ]),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/u)
      .max(120)
      .nullable(),
    deltaCount: z.number().int().nonnegative(),
    observedCharacters: z.number().int().nonnegative(),
    attachmentCount: z.number().int().min(0).max(4),
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1_024 * 1_024),
    stagingCleanup: z.enum(["removed", "pending_startup_cleanup"]).nullable(),
    conversationContinuity: z.enum([
      "retained",
      "not_observed",
      "review_required",
      "unavailable",
    ]),
    redelivered: z.boolean(),
    deliveryAckRequired: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("chatgpt.conversation-reset"),
    state: z.literal("new"),
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-read"),
    workspaceId: IdentifierSchema,
    relativePath: ProductRelativePathSchema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024),
    text: z.string().max(32_768),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-inspection"),
    workspaceId: IdentifierSchema,
    relativePath: ProductScopeRelativePathSchema,
    // Present only when true: other users of this Mac can change files here.
    writableByOthers: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-list"),
    workspaceId: IdentifierSchema,
    relativePath: ProductScopeRelativePathSchema,
    entries: z.array(ProductWorkspaceEntrySchema).max(500),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-search"),
    workspaceId: IdentifierSchema,
    relativePath: ProductScopeRelativePathSchema,
    pattern: ProductSearchPatternSchema,
    matches: z
      .array(
        z.strictObject({
          path: ProductRelativePathSchema,
          line: z.number().int().positive(),
          text: z.string().max(500),
          truncated: z.boolean(),
        }),
      )
      .max(100),
    resultLimited: z.boolean(),
    scanLimited: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-command"),
    workspaceId: IdentifierSchema,
    command: z.enum(["git.status", "git.head"]),
    exitCode: z.literal(0),
    stdout: z.string().max(64 * 1_024),
    stderr: z.literal(""),
    outputBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1_024),
    network: z.literal("none"),
    coverage: z.enum(["tracked-files-only", "head-commit"]),
    layout: z.enum(["primary", "linked-worktree"]),
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-edit-preview"),
    operationId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    relativePath: ProductRelativePathSchema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024),
    beforeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    expiresAt: CanonicalTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.workspace-mutation"),
    operationId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    relativePath: ProductRelativePathSchema,
    operation: z.enum(["edit", "write"]),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024),
    replacements: z.number().int().nonnegative(),
    beforeSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    afterSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    resultRetention: z.enum(["durable", "memory_only"]),
    redelivered: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("support.exported"),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !value.includes("/") && !value.includes("\\")),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    kind: z.literal("model.status"),
    // Never "not running": Farol reports that as a plain command failure
    // (MODEL_ENDPOINT_UNAVAILABLE) so a caller cannot mistake a stale
    // evidence value for the current state.
    state: z.enum(["port_conflict", "listening", "connected"]),
    port: z.number().int().positive().nullable(),
    requestsServed: z.number().int().nonnegative(),
    // On a port conflict: what the authenticated loopback identity probe
    // found holding the port, once "Check status" has looked.
    occupant: z.enum(["unprobed", "farol", "foreign", "vacated"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("model.config-preview"),
    configPath: CanonicalAbsolutePathSchema,
    providerBlockStatus: z.enum([
      "noop",
      "install",
      "update",
      "conflict",
      "insecure_permissions",
      "symlink",
      "malformed",
    ]),
    providerBlockDiff: z.string().optional(),
    // The diff never carries a bearer-token literal; this says one was
    // replaced by the fixed placeholder.
    providerBlockTokenRedacted: z.boolean().optional(),
    providerBlockConflicts: z
      .array(z.strictObject({ table: z.string(), line: z.string() }))
      .optional(),
    providerBlockInsecureMode: z.number().int().nonnegative().optional(),
    providerSelectionRequested: z.boolean(),
    providerSelectionStatus: z
      .enum(["noop", "install", "update", "conflict", "symlink", "malformed"])
      .optional(),
    providerSelectionDiff: z.string().optional(),
    providerSelectionConflicts: z
      .array(z.strictObject({ table: z.string(), line: z.string() }))
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("model.config-applied"),
    providerBlockApplied: z.boolean(),
    providerSelectionApplied: z.boolean(),
    restartStep: z.literal("restart_codex_to_apply"),
    // Read-only process-table scan for the verified Codex executable at
    // apply time: decides which restart note the control shows.
    codexHost: z.enum(["running", "not_running", "unknown"]),
  }),
  z.strictObject({
    kind: z.literal("model.config-rollback"),
    providerBlockRestored: z.boolean(),
    providerSelectionRestored: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("model.token-rotated"),
    // True when the consented block carried the old literal and was
    // rewritten in place with the new one.
    providerBlockUpdated: z.boolean(),
    providerBlockStatus: z.enum([
      "noop",
      "install",
      "update",
      "conflict",
      "insecure_permissions",
      "symlink",
      "malformed",
      // S35-H2-1: no managed block is installed, so none was rewritten.
      "not_present",
      // The rewrite that carried the new literal actually landed.
      "applied",
    ]),
  }),
]);
