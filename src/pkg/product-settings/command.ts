import { z } from "zod";
import {
  ReadConversationHandleSchema,
  ReadConversationCursorSchema,
  ReadConversationPromptSchema,
} from "./chat-conversation.ts";
import {
  CanonicalAbsolutePathSchema,
  IdentifierSchema,
  ProductRelativePathSchema,
  ProductScopeRelativePathSchema,
  ProductSearchPatternSchema,
  Sha256Schema,
  WorkspaceAccessCheckIdSchema,
} from "./scalar.ts";
import {
  CodexTaskSelectionSchema,
  CodexReadSelectionShape,
  validateCodexReadSelection,
} from "./codex.ts";
import {
  ConnectorRuntimeKeySchema,
  ConnectorTunnelIdSchema,
  SecureMcpAppSelectionSchema,
  SeparateAppVerificationScopeSchema,
} from "./connector.ts";
import { ProductGeneralSettingsSchema } from "./settings.ts";
import { SetupStepIdSchema } from "./setup.ts";

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
    // Present only on a retry that recovers a fence main holds; it names that
    // fence. Main admits it solely over exactly that retained recovery.
    recovery: z
      .strictObject({
        generation: z.number().int().positive(),
        revision: z.number().int().positive(),
        tunnelId: ConnectorTunnelIdSchema.nullable(),
      })
      .optional(),
  }),
  z.strictObject({ kind: z.literal("connector.start") }),
  z.strictObject({ kind: z.literal("connector.repair") }),
  z.strictObject({ kind: z.literal("connector.stop") }),
  z.strictObject({ kind: z.literal("connector.check-attachment") }),
  z.strictObject({ kind: z.literal("connector.check-health") }),
  z.strictObject({ kind: z.literal("connector.verify-app") }),
  // Explicit owner click only. The command contains one original UUID and
  // the already selected browser route, never a Send-success boolean.
  z.strictObject({
    kind: z.literal("connector.test-connection"),
    operationId: IdentifierSchema,
    taskId: z.string().max(120),
  }),
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
    test: z.enum(["connection", "deep"]).optional(),
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
