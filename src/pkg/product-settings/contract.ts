import { z } from "zod";
import {
  ReadConversationViewSchema,
  ReadConversationHandleSchema,
  ReadConversationCursorSchema,
  ReadConversationPromptSchema,
} from "./chat-conversation.ts";
import { TaskModelCatalogueViewSchema } from "../owner-config/contract.ts";
import { readConnectorSetupReceipt } from "./connector-setup-receipt.ts";
import {
  CHATGPT_MODEL_ID,
  FAROL_PROVIDER_ID,
} from "../model-route/contract.ts";

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

// Correlates one issued folder check with its persisted access witness.
export const WorkspaceAccessCheckIdSchema = IdentifierSchema;

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

const DefaultSecureMcpConnector = {
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
  openAtLaunch: z.enum(["home", "browser", "computer", "activity", "settings"]),
  sidebarDefault: z.enum(["full", "rail"]),
  activityDetail: z.enum(["summary", "technical"]),
});

// The device and inode the approved folder had when the owner approved it. A
// workspace approved before identities were recorded has none until its next
// owner verification binds one.
export const WorkspaceRootIdentitySchema = z.strictObject({
  device: z.string().regex(/^[0-9]{1,20}$/u),
  inode: z.string().regex(/^[0-9]{1,20}$/u),
});

export type WorkspaceRootIdentity = z.infer<typeof WorkspaceRootIdentitySchema>;

// Exact metadata measured during owner workspace verification. Linked
// worktrees require this external grant; a primary checkout records its internal
// .git only with full-Git approval so persistent tasks can bind the same layout.
export const WorkspaceGitMetadataSchema = z.strictObject({
  gitDirectory: CanonicalAbsolutePathSchema,
  commonDirectory: CanonicalAbsolutePathSchema,
});

export type WorkspaceGitMetadata = z.infer<typeof WorkspaceGitMetadataSchema>;

const CodexReadSelectionShape = {
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

function validateCodexReadSelection(
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

export const ApprovedProductWorkspaceSchema = z
  .strictObject({
    workspaceId: IdentifierSchema,
    root: CanonicalAbsolutePathSchema,
    label: z.string().trim().min(1).max(120),
    access: z.enum(["read", "write"]),
    excludedPaths: z.array(CanonicalAbsolutePathSchema).max(32),
    rootIdentity: WorkspaceRootIdentitySchema.optional(),
    gitMetadata: WorkspaceGitMetadataSchema.optional(),
    gitHistoryApproved: z.boolean().optional(),
    // Content-free evidence for the setup folder list, not another grant.
    // The descriptor and existing authority checks still admit every read.
    accessCheck: z
      .strictObject({
        checkId: WorkspaceAccessCheckIdSchema.optional(),
        buildId: z.string().regex(/^[a-f0-9]{64}$/u),
        computerGeneration: z.number().int().positive(),
        verifiedAt: CanonicalTimestampSchema,
        rootIdentity: WorkspaceRootIdentitySchema,
      })
      .nullable()
      .optional(),
  })
  .superRefine((workspace, context) => {
    const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
    const unique = new Set(workspace.excludedPaths);
    if (unique.size !== workspace.excludedPaths.length) {
      context.addIssue({ code: "custom", message: "duplicate exclusions" });
    }
    for (const excluded of workspace.excludedPaths) {
      // S35-TA-4/TA-10: strictly BELOW the root, and the root itself is not
      // below itself. An exclusion equal to the root used to be exempt here,
      // but it matches no `<root>/` prefix, so the descriptor built from it
      // denied nothing: a workspace saying "exclude everything" would have
      // read as "exclude nothing". The state is refused at the source rather
      // than carried into a consumer that cannot express it.
      //
      // The equality is tested SEPARATELY, before the prefix, because the
      // prefix alone does not catch it at the filesystem root: there the
      // prefix is "/" and `"/".startsWith("/")` is true, so `root: "/"` with
      // an exclusion of "/" validated and reached `workspaceDeniedPaths` as
      // the empty relative path. Every other root carries a trailing slash in
      // its prefix and is caught by the prefix test alone.
      if (excluded === workspace.root || !excluded.startsWith(prefix)) {
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

// One guarded edit whose result has not yet been delivered to the owner.  It
// is recorded before the edit executes and cleared only after the renderer
// acknowledges the delivered outcome, so a lost response or a restart leaves
// the exact operation ID to observe instead of a reason to edit again.
const PendingWorkspaceEditIdentity = {
  operationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativePath: ProductRelativePathSchema,
  computerGeneration: z.number().int().positive(),
  submittedAt: z.string().datetime(),
};
export const PendingWorkspaceEditDeliverySchema = z.union([
  // Absence is the exact historical TS journal format, never a Go fallback.
  z.strictObject(PendingWorkspaceEditIdentity),
  z.strictObject({
    ...PendingWorkspaceEditIdentity,
    backend: z.literal("go-owner-v2"),
    profileId: IdentifierSchema,
    beforeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
]);

export const ProductSettingsSchema = z.strictObject({
  schema: z.literal(1),
  revision: z.number().int().positive(),
  general: ProductGeneralSettingsSchema,
  // Human-editable model policy lives in this existing document. Validate the
  // subsection at resolution so a malformed task policy cannot disable Computer.
  tasks: z.unknown().optional(),
  computer: z.strictObject({
    computerId: IdentifierSchema,
    generation: z.number().int().positive(),
    name: z.string().trim().min(1).max(80),
    commands: z.enum(["none", "verification", "workspace"]).default("none"),
    // Missing is the historical protected-files policy, never implicit consent.
    filePolicy: z.enum(["", "approved-roots-v1"]).optional(),
    workspaces: z.array(ApprovedProductWorkspaceSchema).max(64),
    pendingEdit: PendingWorkspaceEditDeliverySchema.nullable().default(null),
  }),
  nativeHosts: z
    .strictObject({
      generation: z.number().int().positive(),
      codex: CodexHostSelectionSchema.nullable(),
      taskRoute: CodexTaskSelectionSchema.nullable().default(null),
    })
    .default({ generation: 1, codex: null, taskRoute: null }),
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
        "CONFIG_RENAME_REQUIRED",
        "SETTINGS_UNSAFE",
        "SETTINGS_READ_FAILED",
      ]),
    }),
  ],
);

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

const ConnectorTunnelIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[0-9A-Za-z._:-]+$/u);
const ConnectorRuntimeKeySchema = z
  .string()
  .min(20)
  .max(512)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 33 && code <= 126;
    }),
  );

export const ProductConfigurationCommandSchema = z.discriminatedUnion("kind", [
  ProductGeneralSettingsSchema.extend({ kind: z.literal("general.update") }),
  z.strictObject({ kind: z.literal("chatgpt.open-sign-in") }),
  z.strictObject({ kind: z.literal("chatgpt.open-browser") }),
  z.strictObject({ kind: z.literal("chatgpt.present-browser") }),
  z.strictObject({
    kind: z.literal("chatgpt.observe-sign-in"),
    observationId: IdentifierSchema,
    buildId: Sha256Schema,
  }),
  z.strictObject({ kind: z.literal("chatgpt.toggle-sidebar") }),

  // Fixed public destinations only; the renderer cannot supply a URL.
  z.strictObject({
    kind: z.literal("onboarding.open-help"),
    destination: z.enum(["tunnels", "api-keys", "chatgpt", "setup-guide"]),
  }),
  z.strictObject({ kind: z.literal("chatgpt.verify") }),
  // A read-only refresh the renderer sends itself once it is told the
  // sign-in window has closed (UX34-08: "returned to Setup with the status
  // updated"). It performs no page probe of its own — the sign-in window's
  // own close already recorded a truthful observation via
  // `onSignInOutcome` — so it is always safe to call and never shows a
  // "Verifying…" message the way `chatgpt.verify` does.
  z.strictObject({ kind: z.literal("chatgpt.sign-in-return") }),
  // A completed network check may finish after the owner has opened a task
  // editor. Keep its background provenance separate from an explicit Return.
  z.strictObject({ kind: z.literal("chatgpt.verification-return") }),
  z.strictObject({ kind: z.literal("chatgpt.reset-conversation") }),
  z.strictObject({ kind: z.literal("support.export") }),
  z.strictObject({ kind: z.literal("host.select-codex") }),
  z.strictObject({ kind: z.literal("host.discover-codex") }),
  z.strictObject({
    kind: z.literal("host.select-discovered-codex"),
    path: CanonicalAbsolutePathSchema,
  }),
  z.strictObject({ kind: z.literal("host.verify-codex") }),
  z.strictObject({ kind: z.literal("host.refresh-codex-task-models") }),
  z
    .strictObject({
      kind: z.literal("host.configure-codex-tasks"),
      socketPath: CanonicalAbsolutePathSchema,
      expectedCodexHome: CanonicalAbsolutePathSchema,
      workspaceId: IdentifierSchema,
      projectId: IdentifierSchema,
      ...CodexReadSelectionShape,
      projectRoot: CanonicalAbsolutePathSchema,
      sandbox: CodexTaskSelectionSchema.shape.execution.shape.sandbox,
      approvalPolicy:
        CodexTaskSelectionSchema.shape.execution.shape.approvalPolicy,
    })
    .superRefine(validateCodexReadSelection),
  z.strictObject({ kind: z.literal("host.clear-codex-tasks") }),
  z.strictObject({ kind: z.literal("host.remove-codex") }),
  z.strictObject({ kind: z.literal("host.run-codex-smoke") }),
  z.strictObject({ kind: z.literal("host.run-codex-agent-check") }),
  z.strictObject({ kind: z.literal("host.run-route-b-check") }),
  z.strictObject({ kind: z.literal("connector.select-client") }),
  z.strictObject({ kind: z.literal("connector.discover-client") }),
  z.strictObject({
    kind: z.literal("connector.select-discovered-client"),
    path: CanonicalAbsolutePathSchema,
  }),
  z.strictObject({
    kind: z.literal("connector.configure"),
    tunnelId: ConnectorTunnelIdSchema,
    runtimeKey: ConnectorRuntimeKeySchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("connector.save-and-connect"),
    operationId: IdentifierSchema,
    buildId: Sha256Schema,
    tunnelId: ConnectorTunnelIdSchema,
    runtimeKey: ConnectorRuntimeKeySchema,
  }),
  z.strictObject({ kind: z.literal("connector.start") }),
  z.strictObject({ kind: z.literal("connector.repair") }),
  z.strictObject({ kind: z.literal("connector.stop") }),
  z.strictObject({ kind: z.literal("connector.check-attachment") }),
  z.strictObject({ kind: z.literal("connector.check-health") }),
  z.strictObject({ kind: z.literal("connector.verify-app") }),
  z.strictObject({
    kind: z.literal("connector.verify-separate-app"),
    expected: SeparateAppVerificationScopeSchema,
  }),
  SecureMcpAppSelectionSchema.extend({
    kind: z.literal("connector.select-chatgpt-app"),
  }),
  z.strictObject({ kind: z.literal("dev-proof.prepare") }),
  z.strictObject({ kind: z.literal("dev-proof.run") }),
  z.strictObject({ kind: z.literal("chatgpt.prepare-attachment-task") }),
  z.strictObject({ kind: z.literal("chatgpt.recover-task-result") }),
  z.strictObject({
    kind: z.literal("chatgpt.run-deep-test"),
    operationId: IdentifierSchema,
    taskId: z.string().max(120),
  }),
  z.strictObject({ kind: z.literal("chatgpt.deep-test-status") }),
  z.strictObject({
    kind: z.literal("chatgpt.ack-deep-test"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.inspect-chat-account"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.start-conversation"),
    operationId: IdentifierSchema,
    confirmationId: IdentifierSchema,
    prompt: ReadConversationPromptSchema,
  }),
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
    kind: z.literal("chatgpt.observe-readonly-conversation"),
    operationId: IdentifierSchema,
    handleId: ReadConversationHandleSchema,
    cursor: ReadConversationCursorSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.ack-readonly-conversation"),
    operationId: IdentifierSchema,
    handleId: ReadConversationHandleSchema,
    resultId: ReadConversationHandleSchema,
    cursor: ReadConversationCursorSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.follow-readonly-conversation"),
    operationId: IdentifierSchema,
    handleId: ReadConversationHandleSchema,
    prompt: ReadConversationPromptSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.inspect-readonly-account"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.approve-readonly-account"),
    operationId: IdentifierSchema,
    confirmationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("chatgpt.cancel-readonly-task"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.rename"),
    name: z.string().trim().min(1).max(80),
  }),
  z.strictObject({ kind: z.literal("computer.choose-workspace") }),
  z.strictObject({
    kind: z.literal("computer.add-workspace"),
    selectionId: IdentifierSchema.optional(),
    access: z.enum(["read", "write"]).optional(),
  }),
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
    kind: z.literal("computer.update-git-history"),
    workspaceId: IdentifierSchema,
    approved: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("computer.update-commands"),
    commands: z.enum(["none", "verification", "workspace"]),
  }),
  z.strictObject({
    kind: z.literal("computer.update-file-policy"),
    filePolicy: z.enum(["", "approved-roots-v1"]),
  }),
  z.strictObject({
    kind: z.literal("computer.check-folder"),
    workspaceId: IdentifierSchema,
    checkId: WorkspaceAccessCheckIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("computer.verify-workspace"),
    workspaceId: IdentifierSchema,
    checkId: WorkspaceAccessCheckIdSchema.optional(),
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
    kind: z.literal("computer.run-git-head"),
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
    kind: z.literal("computer.observe-workspace-edit"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("computer.ack-workspace-edit"),
    operationId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("setup.progress"),
    currentStep: SetupStepIdSchema,
    dismissed: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("model.status") }),
  z.strictObject({
    kind: z.literal("model.preview"),
    selectAsDefault: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("model.apply"),
    selectAsDefault: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("model.rollback") }),
  z.strictObject({ kind: z.literal("model.rotate-token") }),
]);

const DiscoveryCandidateSchema = z.strictObject({
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

export const ProductConfigurationEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("chatgpt.deep-test-result"),
    operationId: IdentifierSchema,
    state: z.enum([
      "completed",
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

const ConnectorAttemptSchema = z.strictObject({
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

export const ProductConfigurationResultSchema = z
  .discriminatedUnion("ok", [
    z.strictObject({
      ok: z.literal(true),
      snapshot: ProductConfigurationSnapshotSchema,
      evidence: ProductConfigurationEvidenceSchema.optional(),
      connectorSetup: ConnectorSetupReceiptSchema.optional(),
    }),
    z.strictObject({
      ok: z.literal(false),
      error: z.enum([
        "SETTINGS_UNAVAILABLE",
        "ONBOARDING_HELP_OPEN_FAILED",
        "SETTINGS_INPUT_INVALID",
        "SETUP_INCOMPLETE",
        "SETTINGS_WRITE_FAILED",
        "CHATGPT_ROUTE_UNAVAILABLE",
        "CHATGPT_CONVERSATION_UNCONFIRMED",
        "CHATGPT_CONVERSATION_REFUSED",
        "CHATGPT_PROMPT_TOO_LARGE",
        "CHATGPT_ACCOUNT_UNAVAILABLE",
        "CHATGPT_ACCOUNT_CHANGED",
        "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
        "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
        "CHATGPT_SIGN_IN_IN_PROGRESS",
        "CHATGPT_PAGE_UNREACHABLE",
        "CHATGPT_CONNECTION_NOT_VERIFIED",
        "CHATGPT_TASK_IN_PROGRESS",
        "CHATGPT_TASK_PREVIEW_PENDING",
        "CHATGPT_TASK_PREVIEW_NOT_FOUND",
        "CHATGPT_TASK_PREVIEW_EXPIRED",
        "CHATGPT_TASK_REQUIRES_REVIEW",
        "CHATGPT_TASK_JOURNAL_FAILED",
        "CHATGPT_TASK_PROMOTION_PENDING",
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
        "WORKSPACE_SELECTION_PROTECTED",
        "WORKSPACE_VERIFICATION_FAILED",
        "WORKSPACE_FILE_PICKER_CANCELLED",
        "WORKSPACE_FILE_SELECTION_INVALID",
        "WORKSPACE_PATH_REFUSED",
        "WORKSPACE_ROOT_CHANGED",
        "WORKSPACE_NOT_A_FILE",
        "WORKSPACE_FILE_TOO_LARGE",
        "WORKSPACE_NOT_TEXT",
        "WORKSPACE_SEARCH_TIMEOUT",
        "WORKSPACE_VERIFICATION_REQUIRED",
        "WORKSPACE_READ_FAILED",
        "WORKSPACE_COMMAND_APPROVAL_REQUIRED",
        "WORKSPACE_COMMAND_UNAVAILABLE",
        "WORKSPACE_COMMAND_CANCELLED",
        "WORKSPACE_COMMAND_TIMEOUT",
        "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
        "WORKSPACE_NOT_GIT_REPOSITORY",
        "WORKSPACE_GIT_HEAD_UNBORN",
        "WORKSPACE_GIT_METADATA_NOT_APPROVED",
        "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED",
        "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT",
        "WORKSPACE_CHANGED_DURING_SNAPSHOT",
        "WORKSPACE_TRACKED_LIST_TOO_LARGE",
        "WORKSPACE_TRACKED_PATH_UNSUPPORTED",
        "WORKSPACE_SNAPSHOT_TOO_LARGE",
        "WORKSPACE_SNAPSHOT_CROSS_VOLUME",
        "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED",
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
        "WORKSPACE_MUTATION_NOT_PENDING",
        "WORKSPACE_MUTATION_NOT_ADMITTED",
        "WORKSPACE_MUTATION_RESULT_PENDING",
        "SUPPORT_EXPORT_CANCELLED",
        "SUPPORT_EXPORT_FAILED",
        "CODEX_HOST_PICKER_CANCELLED",
        "CODEX_HOST_NOT_CONFIGURED",
        "CODEX_TASK_ROUTE_REFUSED",
        "CODEX_TASK_OBSERVATION_REFUSED",
        "CODEX_TASK_ROUTE_UNAVAILABLE",
        "CODEX_SHARED_SOCKET_NOT_FOUND",
        "CODEX_SHARED_SOCKET_ACCESS_DENIED",
        "CODEX_SHARED_SOCKET_ALIAS_UNSUPPORTED",
        "CODEX_SHARED_SOCKET_INVALID_TARGET",
        "CODEX_SHARED_SOCKET_CHECK_FAILED",
        "CODEX_SHARED_PROXY_LAUNCH_FAILED",
        "CODEX_SHARED_PROXY_PIPE_FAILED",
        "CODEX_SHARED_PROXY_EXITED",
        "CODEX_SHARED_PROXY_TIMEOUT",
        "CODEX_SHARED_PROXY_INVALID_IDENTITY",
        "CODEX_SHARED_PROXY_PROTOCOL_ERROR",
        "CODEX_SHARED_PROXY_RPC_ERROR",
        "CODEX_HOST_SELECTION_INVALID",
        "CODEX_HOST_EXECUTABLE_UNSAFE",
        "CODEX_HOST_INCOMPATIBLE",
        "CODEX_HOST_PROBE_FAILED",
        "CODEX_HOST_RECHECK_REQUIRED",
        "CODEX_HOST_TASK_IN_PROGRESS",
        "AUTHORITY_CHANGE_IN_PROGRESS",
        "CODEX_HOST_DISCOVERY_FAILED",
        "CODEX_HOST_DISCOVERY_CANDIDATE_STALE",
        "ROUTE_B_UNAVAILABLE",
        "ROUTE_B_HOST_START_FAILED",
        "ROUTE_B_OUTCOME_UNKNOWN",
        "ROUTE_B_CHECK_TOOL_USED",
        "SUPPORT_EXPORT_TOO_LARGE",
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
        "TUNNEL_CLIENT_DISCOVERY_FAILED",
        "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
        "CONNECTOR_CREDENTIAL_REQUIRED",
        "CONNECTOR_CREDENTIAL_STORE_FAILED",
        "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
        "CONNECTOR_WORKSPACE_REQUIRED",
        "CONNECTOR_WORKSPACE_LIMIT",
        "CONNECTOR_CONFIGURE_FAILED",
        "CONNECTOR_DOCTOR_FAILED",
        "CONNECTOR_TUNNEL_EXITED",
        "CONNECTOR_START_FAILED",
        "CONNECTOR_RUNTIME_UNREACHABLE",
        "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
        "CONNECTOR_RECOVERY_PENDING_OPERATION",
        "CONNECTOR_RECOVERY_AUTHORITY_UNAVAILABLE",
        "CONNECTOR_RECOVERY_UNAVAILABLE",
        "CONNECTOR_ALREADY_RUNNING",
        "COMPUTER_FENCE_UNHELD",
        "CONNECTOR_STOP_REQUIRED",
        "CONNECTOR_STOP_UNCONFIRMED",
        "CONNECTOR_SETUP_BINDING_CHANGED",
        "CONNECTOR_SETUP_STEP_UNCONFIRMED",
        "CONNECTOR_CHALLENGE_UNAVAILABLE",
        "CONNECTOR_ATTACHMENT_NOT_FOUND",
        "CONNECTOR_ATTACHMENT_INVALID",
        "CONNECTOR_APP_VERIFICATION_DEV_ONLY",
        "CONNECTOR_APP_VERIFICATION_UNAVAILABLE",
        "CONNECTOR_APP_TARGET_REQUIRED",
        "CONNECTOR_APP_VERIFICATION_NOT_READY",
        "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED",
        "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
        "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
        "CONNECTOR_APP_VERIFICATION_BEFORE_SUBMIT_FAILED",
        "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
        "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
        "CONNECTOR_POLLING_EXPIRED",
        "CHATGPT_APP_SELECTION_MISSING",
        "CHATGPT_APP_SELECTION_AMBIGUOUS",
        "CHATGPT_APP_SELECTION_CONFLICT",
        "CHATGPT_APP_SELECTION_LOST",
        "CHATGPT_COMPOSER_DRAFT_PRESENT",
        "CHATGPT_TEMPORARY_CHAT_REQUIRED",
        "CHATGPT_INSTANT_MODEL_REQUIRED",
        "DEV_MCP_PROOF_DEV_ONLY",
        "DEV_MCP_PROOF_PREPARE_FAILED",
        "DEV_MCP_PROOF_NOT_PREPARED",
        "DEV_MCP_PROOF_CONNECTOR_MUST_STOP",
        "DEV_MCP_PROOF_CONNECTOR_NOT_READY",
        "DEV_MCP_PROOF_STALE",
        "DEV_MCP_PROOF_CHATGPT_FAILED",
        "DEV_MCP_PROOF_ANSWER_MISMATCH",
        "DEV_MCP_PROOF_RECEIPT_MISSING",
        "DEV_MCP_PROOF_RECEIPT_INVALID",
        "MODEL_ENDPOINT_UNAVAILABLE",
        "MODEL_CONFIG_CONFLICT",
        "MODEL_CONFIG_INSECURE_PERMISSIONS",
        "MODEL_CONFIG_APPLY_FAILED",
        "MODEL_CONFIG_ROLLBACK_FAILED",
        "MODEL_CONFIG_SYMLINK",
        "MODEL_CONFIG_MALFORMED",
        "MODEL_TOKEN_ROTATE_FAILED",
        // S35-H2-1: the installed Codex block could not be rewritten with
        // the new literal, so the token was not moved (or was put back);
        // the owner's config still authenticates.
        "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
        // S35-H2-1R: the rewrite failed AND the previous token could not be
        // put back, so the endpoint was left accepting nothing rather than a
        // literal the owner's config does not carry.
        "FAROL_MODEL_ROTATE_RESTORE_FAILED",
      ]),
      snapshot: ProductConfigurationSnapshotSchema,
      connectorAttempt: ConnectorAttemptSchema.optional(),
      connectorSetup: ConnectorSetupReceiptSchema.optional(),
    }),
  ])
  .superRefine((result, context) => {
    const receipt = result.connectorSetup;
    if (!receipt) return;
    const inconsistent = result.ok
      ? receipt.state !== "completed"
      : receipt.state === "completed" ||
        result.error !== receipt.code ||
        (result.connectorAttempt !== undefined &&
          (receipt.connectorAttempt === undefined ||
            result.connectorAttempt.method !==
              receipt.connectorAttempt.method ||
            result.connectorAttempt.requestId !==
              receipt.connectorAttempt.requestId ||
            result.connectorAttempt.operationId !==
              receipt.connectorAttempt.operationId ||
            result.connectorAttempt.outcome !==
              receipt.connectorAttempt.outcome));
    if (inconsistent)
      context.addIssue({
        code: "custom",
        path: ["connectorSetup"],
        message: "Connector setup result is inconsistent.",
      });
  });

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
export type PendingWorkspaceEditDelivery = z.infer<
  typeof PendingWorkspaceEditDeliverySchema
>;
export type ProductConfigurationSnapshot = z.infer<
  typeof ProductConfigurationSnapshotSchema
>;
export type ProductConfigurationCommand = z.infer<
  typeof ProductConfigurationCommandSchema
>;
export type ProductConfigurationEvidence = z.infer<
  typeof ProductConfigurationEvidenceSchema
>;
export type ProductDiscoveryCandidate = z.infer<
  typeof DiscoveryCandidateSchema
>;
export type ProductConfigurationResult = z.infer<
  typeof ProductConfigurationResultSchema
>;
