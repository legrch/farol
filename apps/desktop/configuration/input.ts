import { z } from "zod";
import {
  CodexTaskSourceSchema,
  WorkspaceRootIdentitySchema,
  type ProductConfigurationSnapshot,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type { TaskSettingsComparator } from "../bridge/task-current-settings";
import type {
  SettingsStoreReadResult,
  SettingsStoreReplaceResult,
} from "../bridge/wire";
import type { TaskModelPolicyResolver } from "../bridge/task-model-policy";

export const WORKSPACE_DRIFT_NEEDS_ACTION =
  "Farol withdrew a folder check because that folder no longer matches the one you approved. Check each folder; remove and add again any that keeps refusing, then connect.";

// The check evidence a drift observation is conditioned on: the folder's own
// saved check and the Computer step's current verification.
export function workspaceCheckEvidence(
  settings: ProductSettings,
  workspaceId: string,
): string {
  const workspace = settings.computer.workspaces.find(
    (item) => item.workspaceId === workspaceId,
  );
  return JSON.stringify({
    accessCheck: workspace?.accessCheck ?? null,
    verified: settings.setup.computer.verified ?? null,
  });
}
export type ProductSettingsStoreOptions = Readonly<{ root: string }>;

// Mechanical publication result for the retained single Settings writer. This
// says nothing about mutation execution or whether a UI delivery may be ACKed.
export type ConditionalSettingsWrite =
  | Readonly<{ status: "committed"; settings: ProductSettings }>
  | Readonly<{ status: "not_written" }>
  | Readonly<{ status: "unknown" }>;

// Only trusted desktop composition can bind one original Go Stop parent to
// the retained sole ProductSettings writer. These are phase receipts, never a
// renderer command, a generic Settings mutation or current Computer authority.
export type OriginalStopSettingsPlan = Readonly<{
  effectId: string;
  expectedRevision: string;
  expectedDigest: string;
  nextRevision: string;
  nextDigest: string;
  computerGeneration: string;
  connectorGeneration: string;
  consentDigest: string;
}>;
export type OriginalStopSettingsAck = Readonly<{
  effectId: string;
  revision: string;
  documentDigest: string;
  computerGeneration: string;
  connectorGeneration: string;
  consentDigest: string;
}>;
export type OriginalStopSettingsResult =
  | Readonly<{
      status: "committed";
      receipt: OriginalStopSettingsAck;
      settings: ProductSettings;
    }>
  | Readonly<{ status: "not_written" | "unknown" }>;

// Trusted host storage port; Go owns all delivery transitions. The retained
// service queue serializes these calls with ordinary Settings commands.
export type SettingsDeliveryStore = Readonly<{
  read(deadlineMillis?: string): Promise<SettingsStoreReadResult>;
  replace(
    change: unknown,
    deadlineMillis?: string,
  ): Promise<SettingsStoreReplaceResult>;
  // A lost caller/transport acknowledgement must fence this same writer even
  // if a lower-level publication had already returned known bytes.
  fence(): Promise<void>;
}>;

// The same cross-process exclusion `LiveTaskRegistry.admitDurable` and
// `withPromotionLease` use (see `live-task-registry.ts`), structurally
// duplicated here rather than imported: both shapes are simple ports, and a
// guarded edit has no other reason to depend on the chat task registry
// module. Whichever side actually holds the lease wins; the loser gets its
// own refusal.
export type WorkspaceEditLeaseHold = Readonly<{
  release(): Promise<void>;
  // Fencing check taken immediately before the durable write; a hold that
  // no longer verifies is treated like a lease that was never acquired.
  verify?(): Promise<boolean>;
}>;
export type WorkspaceEditLeaseGuard = Readonly<{
  acquireForAdmission(): Promise<WorkspaceEditLeaseHold | null>;
}>;

// Trusted host bridge only. Withdrawal precedes settings persistence; publication
// consumes only the exact successful readback. Neither hook admits a task.
export type ComputerSettingsPublication = Readonly<{
  publish(settings: ProductSettings): Promise<void>;
}>;

export type ProductConfigurationDependencies = Readonly<{
  withdrawComputerAuthority?: () => Promise<ComputerSettingsPublication>;
  taskModelPolicy?: TaskModelPolicyResolver;
  taskSettingsCompare?: TaskSettingsComparator;
  now?: () => string;
  id?: () => string;
  // The owner's home, whose credential stores can never be approved as a
  // workspace root. Defaults to this process's home directory.
  homeDirectory?: string;
  // Optional: when supplied, a guarded workspace edit takes this same
  // cross-process promotion lease (role "admission") for its durable
  // critical phase — see `replaceSettingsDeliveryStore` and
  // `releaseWorkspaceEditLease`. Without this port there is no exclusion.
  promotionLease?: WorkspaceEditLeaseGuard;
}>;

export type MutationResult = Readonly<
  | {
      ok: true;
      snapshot: ProductConfigurationSnapshot;
    }
  | {
      ok: false;
      error:
        | "SETTINGS_UNAVAILABLE"
        | "SETTINGS_INPUT_INVALID"
        | "SETUP_INCOMPLETE"
        | "AUTHORITY_CHANGE_IN_PROGRESS"
        | "SETTINGS_WRITE_FAILED"
        | "CONNECTOR_APP_VERIFICATION_STATE_CHANGED"
        | "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"
        | "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
        | "WORKSPACE_NOT_FOUND"
        | "WORKSPACE_SELECTION_PROTECTED"
        | "WORKSPACE_ROOT_CHANGED"
        | "WORKSPACE_MUTATION_NOT_PENDING"
        | "WORKSPACE_MUTATION_PROMOTION_PENDING";
      snapshot: ProductConfigurationSnapshot;
    }
>;

export const workspaceInputSchema = z.strictObject({
  root: z.string(),
  label: z.string().trim().min(1).max(120),
  rootIdentity: WorkspaceRootIdentitySchema.optional(),
});

export const verificationInputSchema = z.strictObject({
  profile: z.string().min(1).max(160),
  runtimeGeneration: z.string().min(1).max(160),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  protocol: z.string().min(1).max(160),
});

export const chatGptObservationSchema = z.discriminatedUnion("state", [
  verificationInputSchema.extend({ state: z.literal("authenticated") }),
  z.strictObject({ state: z.literal("signed_out") }),
  z.strictObject({ state: z.literal("unreachable") }),
  z.strictObject({ state: z.literal("unsupported") }),
  z.strictObject({ state: z.literal("outcome_unknown") }),
]);

export const codexHostInputSchema = z
  .strictObject({
    executablePath: z.string(),
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    version: z
      .string()
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
    protocol: z.literal("codex-app-server/v2"),
    schemaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    buildId: z.string().regex(/^[a-f0-9]{64}$/u),
    taskSource: CodexTaskSourceSchema.nullable().default(null),
  })
  .superRefine((host, context) => {
    const source = host.taskSource;
    if (source === null) return;
    if (
      [source.handoff, source.followup].some(
        (witness) =>
          witness.executablePath !== host.executablePath ||
          witness.executableSha256 !== host.executableSha256 ||
          witness.baseSchemaSha256 !== host.schemaSha256,
      ) ||
      (source.handoff.status === "supported" &&
        source.handoff.contract.version !== host.version)
    )
      context.addIssue({
        code: "custom",
        message: "Task source does not match the selected host.",
      });
  });

export const codexHostFailureSchema = z.enum(["unreachable", "unsupported"]);

export const codexHostLiveInputSchema = z.strictObject({
  model: z.literal("gpt-6-astra"),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const codexHostLiveFailureSchema = z.enum([
  "failed",
  "model_unavailable",
  "outcome_unknown",
]);

export const codexAgentFailureSchema = z.enum([
  "failed",
  "running",
  "outcome_unknown",
  "workspace_not_verified",
]);

export const secureMcpTunnelClientInputSchema = z.strictObject({
  executablePath: z.string(),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
  protocol: z.literal("openai-tunnel-client/v1"),
});

export const secureMcpTunnelInputSchema = z.strictObject({
  tunnelId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[0-9A-Za-z._:-]+$/u),
});

export const secureMcpRuntimeInputSchema = z.strictObject({
  state: z.enum(["ready", "unreachable", "outcome_unknown"]),
  runtimeGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
  computerGeneration: z.number().int().positive(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const secureMcpAttachmentInputSchema = z.strictObject({
  workspaceId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    .nullable(),
  runtimeGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
  computerGeneration: z.number().int().positive(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  challengeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const secureMcpChallengeInputSchema = z.strictObject({
  challenge: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    ),
  runtimeGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
  computerGeneration: z.number().int().positive(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
});
