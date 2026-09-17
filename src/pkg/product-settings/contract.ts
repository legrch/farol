import { z } from "zod";

const CanonicalTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

const CanonicalAbsolutePathSchema = z.string().refine((value) => {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  if (value === "/") return true;
  if (value.endsWith("/")) return false;
  return value.split("/").every((part, index) => {
    if (index === 0) return part === "";
    return part !== "" && part !== "." && part !== "..";
  });
});

const IdentifierSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const CodexHostCapabilitiesSchema = z.strictObject({
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
  dynamicTool: z.literal("farol_next_ping"),
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

export const CodexHostSelectionSchema = z.strictObject({
  executablePath: CanonicalAbsolutePathSchema,
  executableSha256: Sha256Schema,
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
  protocol: z.literal("codex-app-server/v2"),
  schemaSha256: Sha256Schema,
  verifiedAt: CanonicalTimestampSchema,
  liveVerification: CodexHostLiveVerificationSchema.nullable().default(null),
  agentVerification: CodexAgentVerificationSchema.nullable().default(null),
});

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

const SecureMcpAttachmentSchema = z.strictObject({
  tunnelId: z.string().min(1).max(160),
  connectorGeneration: z.number().int().positive(),
  runtimeGeneration: Sha256Schema,
  computerGeneration: z.number().int().positive(),
  buildId: Sha256Schema,
  challengeSha256: Sha256Schema,
  receiptSha256: Sha256Schema,
  verifiedAt: CanonicalTimestampSchema,
});

export const SecureMcpConnectorSchema = z.strictObject({
  generation: z.number().int().positive(),
  profile: z.literal("farol-next"),
  tunnelId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[0-9A-Za-z._:-]+$/u)
    .nullable(),
  tunnelClient: SecureMcpTunnelClientSchema.nullable(),
  credential: z.enum(["missing", "stored"]),
  runtime: SecureMcpRuntimeSchema.nullable(),
  attachment: SecureMcpAttachmentSchema.nullable(),
});

const DefaultSecureMcpConnector = {
  generation: 1,
  profile: "farol-next" as const,
  tunnelId: null,
  tunnelClient: null,
  credential: "missing" as const,
  runtime: null,
  attachment: null,
};

const ProductRelativePathSchema = z.string().refine((value) => {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\")
  ) {
    return false;
  }
  return value.split("/").every((part) => {
    if (part === "" || part === "." || part === "..") return false;
    return [...part].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    });
  });
});

const ProductScopeRelativePathSchema = z
  .string()
  .refine(
    (value) =>
      value === "." || ProductRelativePathSchema.safeParse(value).success,
  );

const ProductSearchPatternSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    }),
  );

const ProductWorkspaceEntrySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => {
    const name = value.endsWith("/") ? value.slice(0, -1) : value;
    return (
      name.length > 0 &&
      !name.includes("/") &&
      ProductRelativePathSchema.safeParse(name).success
    );
  });

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

export const ProductGeneralSettingsSchema = z.strictObject({
  openAtLaunch: z.enum(["browser", "activity", "settings"]),
  sidebarDefault: z.enum(["full", "rail"]),
  activityDetail: z.enum(["summary", "technical"]),
});

export const ApprovedProductWorkspaceSchema = z
  .strictObject({
    workspaceId: IdentifierSchema,
    root: CanonicalAbsolutePathSchema,
    label: z.string().trim().min(1).max(120),
    access: z.enum(["read", "write"]),
    excludedPaths: z.array(CanonicalAbsolutePathSchema).max(32),
  })
  .superRefine((workspace, context) => {
    const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
    const unique = new Set(workspace.excludedPaths);
    if (unique.size !== workspace.excludedPaths.length) {
      context.addIssue({ code: "custom", message: "duplicate exclusions" });
    }
    for (const excluded of workspace.excludedPaths) {
      if (excluded !== workspace.root && !excluded.startsWith(prefix)) {
        context.addIssue({ code: "custom", message: "exclusion escapes root" });
      }
    }
  });

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
});

export const SetupStepIdSchema = z.enum([
  "chatgpt",
  "computer",
  "connect",
  "hosts",
  "verify",
]);

export const ProductSettingsSchema = z.strictObject({
  schema: z.literal(1),
  revision: z.number().int().positive(),
  general: ProductGeneralSettingsSchema,
  computer: z.strictObject({
    computerId: IdentifierSchema,
    generation: z.number().int().positive(),
    name: z.string().trim().min(1).max(80),
    commands: z.enum(["none", "verification"]).default("none"),
    workspaces: z.array(ApprovedProductWorkspaceSchema).max(64),
  }),
  nativeHosts: z
    .strictObject({
      generation: z.number().int().positive(),
      codex: CodexHostSelectionSchema.nullable(),
    })
    .default({ generation: 1, codex: null }),
  connectors: z
    .strictObject({
      secureMcp: SecureMcpConnectorSchema,
    })
    .default({ secureMcp: DefaultSecureMcpConnector }),
  setup: z.strictObject({
    journey: z
      .strictObject({
        currentStep: SetupStepIdSchema,
        dismissed: z.boolean(),
      })
      .default({ currentStep: "chatgpt", dismissed: false }),
    chatgpt: SetupReadinessSchema,
    computer: SetupReadinessSchema,
    connect: SetupReadinessSchema,
    hosts: SetupReadinessSchema,
    verify: SetupReadinessSchema,
  }),
});

export const ProductConfigurationSnapshotSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("ready"),
      settings: ProductSettingsSchema,
    }),
    z.strictObject({
      status: z.literal("error"),
      error: z.enum([
        "SETTINGS_CORRUPT",
        "SETTINGS_UNSAFE",
        "SETTINGS_READ_FAILED",
      ]),
    }),
  ],
);

export const ProductConfigurationCommandSchema = z.discriminatedUnion("kind", [
  ProductGeneralSettingsSchema.extend({ kind: z.literal("general.update") }),
  z.strictObject({ kind: z.literal("chatgpt.open-sign-in") }),
  z.strictObject({ kind: z.literal("chatgpt.verify") }),
  z.strictObject({ kind: z.literal("chatgpt.reset-conversation") }),
  z.strictObject({ kind: z.literal("support.export") }),
  z.strictObject({ kind: z.literal("host.select-codex") }),
  z.strictObject({ kind: z.literal("host.verify-codex") }),
  z.strictObject({ kind: z.literal("host.remove-codex") }),
  z.strictObject({ kind: z.literal("host.run-codex-smoke") }),
  z.strictObject({ kind: z.literal("host.run-codex-agent-check") }),
  z.strictObject({ kind: z.literal("connector.select-client") }),
  z.strictObject({
    kind: z.literal("connector.configure"),
    tunnelId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[0-9A-Za-z._:-]+$/u),
    runtimeKey: z
      .string()
      .min(20)
      .max(512)
      .refine((value) =>
        [...value].every((character) => {
          const code = character.codePointAt(0);
          return code !== undefined && code >= 33 && code <= 126;
        }),
      )
      .nullable(),
  }),
  z.strictObject({ kind: z.literal("connector.start") }),
  z.strictObject({ kind: z.literal("connector.repair") }),
  z.strictObject({ kind: z.literal("connector.stop") }),
  z.strictObject({ kind: z.literal("chatgpt.prepare-attachment-task") }),
  z.strictObject({ kind: z.literal("chatgpt.recover-task-result") }),
  z.strictObject({
    kind: z.literal("chatgpt.ack-task-result"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.submit-attachment-task"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.cancel-attachment-task"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.prepare-readonly-task"),
    workspaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.submit-readonly-task"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.cancel-readonly-task"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.rename"),
    name: z.string().trim().min(1).max(80),
  }),
  z.strictObject({ kind: z.literal("computer.add-workspace") }),
  z.strictObject({
    kind: z.literal("computer.remove-workspace"),
    workspaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.update-exclusions"),
    workspaceId: IdentifierSchema,
    excludedPaths: z
      .array(ProductRelativePathSchema)
      .max(32)
      .refine((paths) => paths.length === new Set(paths).size),
  }),
  z.strictObject({
    kind: z.literal("computer.update-access"),
    workspaceId: IdentifierSchema,
    access: z.enum(["read", "write"]),
  }),
  z.strictObject({
    kind: z.literal("computer.update-commands"),
    commands: z.enum(["none", "verification"]),
  }),
  z.strictObject({
    kind: z.literal("computer.verify-workspace"),
    workspaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.list-workspace"),
    workspaceId: IdentifierSchema,
    relativePath: ProductScopeRelativePathSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.search-workspace"),
    workspaceId: IdentifierSchema,
    relativePath: ProductScopeRelativePathSchema,
    pattern: ProductSearchPatternSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.run-git-status"),
    workspaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.prepare-workspace-edit"),
    workspaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.apply-workspace-edit"),
    operationId: IdentifierSchema,
    oldText: z.string().min(1).max(32_768),
    newText: z.string().max(32_768),
  }),
  z.strictObject({
    kind: z.literal("computer.cancel-workspace-edit"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("setup.progress"),
    currentStep: SetupStepIdSchema,
    dismissed: z.boolean(),
  }),
]);

export const ProductConfigurationEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("host.codex-probe"),
    version: CodexHostSelectionSchema.shape.version,
    protocol: CodexHostSelectionSchema.shape.protocol,
    executableSha256: Sha256Schema,
    schemaSha256: Sha256Schema,
    capabilities: CodexHostCapabilitiesSchema,
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
    kind: z.literal("connector.runtime"),
    state: z.enum(["ready", "unreachable", "outcome_unknown"]),
    runtimeGeneration: Sha256Schema,
    computerGeneration: z.number().int().positive(),
    buildId: Sha256Schema,
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
        "CHATGPT_TASK_PAGE_LOST",
        "CHATGPT_TASK_ERROR",
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
        "CHATGPT_TASK_PAGE_LOST",
        "CHATGPT_TASK_ERROR",
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
    command: z.literal("git.status"),
    exitCode: z.literal(0),
    stdout: z.string().max(64 * 1_024),
    stderr: z.literal(""),
    outputBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1_024),
    network: z.literal("none"),
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
]);

export const ProductConfigurationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    snapshot: ProductConfigurationSnapshotSchema,
    evidence: ProductConfigurationEvidenceSchema.optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum([
      "SETTINGS_UNAVAILABLE",
      "SETTINGS_INPUT_INVALID",
      "SETTINGS_WRITE_FAILED",
      "CHATGPT_ROUTE_UNAVAILABLE",
      "CHATGPT_CONNECTION_NOT_VERIFIED",
      "CHATGPT_TASK_IN_PROGRESS",
      "CHATGPT_TASK_PREVIEW_PENDING",
      "CHATGPT_TASK_PREVIEW_NOT_FOUND",
      "CHATGPT_TASK_PREVIEW_EXPIRED",
      "CHATGPT_TASK_REQUIRES_REVIEW",
      "CHATGPT_TASK_JOURNAL_FAILED",
      "CHATGPT_TASK_RESULT_NOT_FOUND",
      "CHATGPT_CONVERSATION_STATE_FAILED",
      "CHATGPT_CONVERSATION_REVIEW_REQUIRED",
      "CHATGPT_ATTACHMENT_PICKER_CANCELLED",
      "CHATGPT_ATTACHMENT_SELECTION_INVALID",
      "CHATGPT_ATTACHMENT_TYPE_UNSUPPORTED",
      "CHATGPT_ATTACHMENT_TOO_LARGE",
      "CHATGPT_ATTACHMENT_STAGING_FAILED",
      "CHATGPT_ATTACHMENT_REFERENCE_MISSING",
      "CHATGPT_ATTACHMENT_PREVIEW_PENDING",
      "CHATGPT_ATTACHMENT_PREVIEW_NOT_FOUND",
      "CHATGPT_ATTACHMENT_PREVIEW_EXPIRED",
      "WORKSPACE_NOT_FOUND",
      "WORKSPACE_PICKER_CANCELLED",
      "WORKSPACE_SELECTION_INVALID",
      "WORKSPACE_VERIFICATION_FAILED",
      "WORKSPACE_FILE_PICKER_CANCELLED",
      "WORKSPACE_FILE_SELECTION_INVALID",
      "WORKSPACE_PATH_REFUSED",
      "WORKSPACE_NOT_A_FILE",
      "WORKSPACE_FILE_TOO_LARGE",
      "WORKSPACE_NOT_TEXT",
      "WORKSPACE_SEARCH_TIMEOUT",
      "WORKSPACE_VERIFICATION_REQUIRED",
      "WORKSPACE_READ_FAILED",
      "WORKSPACE_COMMAND_APPROVAL_REQUIRED",
      "WORKSPACE_COMMAND_UNAVAILABLE",
      "WORKSPACE_COMMAND_TIMEOUT",
      "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
      "WORKSPACE_COMMAND_FAILED",
      "WORKSPACE_WRITE_APPROVAL_REQUIRED",
      "WORKSPACE_MUTATION_IN_PROGRESS",
      "WORKSPACE_MUTATION_PREVIEW_NOT_FOUND",
      "WORKSPACE_MUTATION_PREVIEW_EXPIRED",
      "WORKSPACE_MUTATION_CONFLICT",
      "WORKSPACE_EDIT_NO_MATCH",
      "WORKSPACE_EDIT_NOT_UNIQUE",
      "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
      "WORKSPACE_MUTATION_FAILED",
      "SUPPORT_EXPORT_CANCELLED",
      "SUPPORT_EXPORT_FAILED",
      "CODEX_HOST_PICKER_CANCELLED",
      "CODEX_HOST_NOT_CONFIGURED",
      "CODEX_HOST_SELECTION_INVALID",
      "CODEX_HOST_EXECUTABLE_UNSAFE",
      "CODEX_HOST_INCOMPATIBLE",
      "CODEX_HOST_PROBE_FAILED",
      "CODEX_HOST_RECHECK_REQUIRED",
      "CODEX_HOST_TASK_IN_PROGRESS",
      "CODEX_HOST_MODEL_UNAVAILABLE",
      "CODEX_HOST_LIVE_FAILED",
      "CODEX_HOST_LIVE_OUTCOME_UNKNOWN",
      "CODEX_AGENT_WORKSPACE_NOT_VERIFIED",
      "CODEX_AGENT_STILL_RUNNING",
      "CODEX_AGENT_LIVE_FAILED",
      "CODEX_AGENT_LIVE_OUTCOME_UNKNOWN",
      "TUNNEL_CLIENT_PICKER_CANCELLED",
      "TUNNEL_CLIENT_SELECTION_INVALID",
      "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
      "TUNNEL_CLIENT_INCOMPATIBLE",
      "TUNNEL_CLIENT_PROBE_FAILED",
      "CONNECTOR_CREDENTIAL_REQUIRED",
      "CONNECTOR_CREDENTIAL_STORE_FAILED",
      "CONNECTOR_WORKSPACE_REQUIRED",
      "CONNECTOR_WORKSPACE_LIMIT",
      "CONNECTOR_CONFIGURE_FAILED",
      "CONNECTOR_DOCTOR_FAILED",
      "CONNECTOR_START_FAILED",
      "CONNECTOR_RUNTIME_UNREACHABLE",
      "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
      "CONNECTOR_ALREADY_RUNNING",
      "CONNECTOR_STOP_REQUIRED",
    ]),
    snapshot: ProductConfigurationSnapshotSchema,
  }),
]);

export type ProductGeneralSettings = z.infer<
  typeof ProductGeneralSettingsSchema
>;
export type ApprovedProductWorkspace = z.infer<
  typeof ApprovedProductWorkspaceSchema
>;
export type CodexHostSelection = z.infer<typeof CodexHostSelectionSchema>;
export type SecureMcpConnector = z.infer<typeof SecureMcpConnectorSchema>;
export type SetupStepId = z.infer<typeof SetupStepIdSchema>;
export type ProductSettings = z.infer<typeof ProductSettingsSchema>;
export type ProductConfigurationSnapshot = z.infer<
  typeof ProductConfigurationSnapshotSchema
>;
export type ProductConfigurationCommand = z.infer<
  typeof ProductConfigurationCommandSchema
>;
export type ProductConfigurationEvidence = z.infer<
  typeof ProductConfigurationEvidenceSchema
>;
export type ProductConfigurationResult = z.infer<
  typeof ProductConfigurationResultSchema
>;
