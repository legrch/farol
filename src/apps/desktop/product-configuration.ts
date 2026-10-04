import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  CodexAgentVerificationFieldsSchema,
  CodexTaskSourceSchema,
  ProductConfigurationSnapshotSchema,
  ProductGeneralSettingsSchema,
  PendingWorkspaceEditDeliverySchema,
  ProductSettingsSchema,
  SecureMcpAppSelectionSchema,
  SetupStepIdSchema,
  WorkspaceGitMetadataSchema,
  WorkspaceRootIdentitySchema,
  CodexTaskSelectionSchema,
  type ProductConfigurationSnapshot,
  type ProductSettings,
  type PendingWorkspaceEditDelivery,
  type SetupStepId,
  type WorkspaceGitMetadata,
  type WorkspaceRootIdentity,
} from "../../pkg/product-settings/contract";
import { credentialStorePolicy } from "../../modules/computer/infra/native/home-secret-stores";
import { ownerSettingsComputerApproval } from "../../modules/computer/infra/repo/owner-settings-computer-approval";
import { taskSettingsProjection } from "../../../apps/desktop/task-current-settings";
import {
  SettingsStoreUnsupported,
  settingsStoreSnapshot,
  settingsStoreReplacement,
  type SettingsStoreScope,
} from "../../../apps/desktop/settings-store-document";
import type {
  SettingsStoreReadResult,
  SettingsStoreReplaceResult,
} from "../../../apps/desktop/bridge/wire";

import { resolveOwnerTaskModel } from "./owner-config";

const FILE_NAME = "config.json";
const LEGACY_FILE_NAME = "product-settings.json";
const MAXIMUM_BYTES = 256 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

type StoreHooks = Readonly<{
  beforeCommit?: () => Promise<void>;
}>;

// A per-write fence, supplied by the caller of one mutation rather than
// installed on the store for its whole life. `beforeWrite` is the LAST
// thing `save` does before the rename that makes the new settings durable,
// so a check placed here is a check on the write itself and not on some
// earlier moment the write is merely expected to follow. Throwing from it
// abandons the write with the target untouched.
type StoreWriteFence = Readonly<{
  beforeWrite?: () => Promise<void>;
}>;

// The one throw `beforeWrite` may raise on this path: the promotion lease a
// guarded edit holds is no longer the lease on disk. Carried as its own
// class so `commit` can report the edit's readable refusal instead of the
// generic write failure every other `save` error becomes.
class WorkspaceEditLeaseLost extends Error {
  constructor() {
    super("WORKSPACE_MUTATION_PROMOTION_PENDING");
  }
}

export type ProductSettingsStoreOptions = Readonly<{ root: string }>;

// Mechanical publication result for the retained single Settings writer. This
// says nothing about mutation execution or whether a UI delivery may be ACKed.
export type ConditionalSettingsWrite =
  | Readonly<{ status: "committed"; settings: ProductSettings }>
  | Readonly<{ status: "not_written" }>
  | Readonly<{ status: "unknown" }>;

// Trusted host storage port; Go owns all delivery transitions. The retained
// service queue serializes these calls with ordinary Settings commands.
export type SettingsDeliveryStore = Readonly<{
  read(): Promise<SettingsStoreReadResult>;
  replace(change: unknown): Promise<SettingsStoreReplaceResult>;
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
  now?: () => string;
  id?: () => string;
  // The owner's home, whose credential stores can never be approved as a
  // workspace root. Defaults to this process's home directory.
  homeDirectory?: string;
  // Optional: when supplied, a guarded workspace edit takes this same
  // cross-process promotion lease (role "admission") for its durable
  // critical phase — see `recordPendingEdit` and `releaseWorkspaceEditLease`.
  // Left unset, a guarded edit behaves exactly as before (no exclusion).
  promotionLease?: WorkspaceEditLeaseGuard;
}>;

type MutationResult = Readonly<
  | {
      ok: true;
      snapshot: ProductConfigurationSnapshot;
    }
  | {
      ok: false;
      error:
        | "SETTINGS_UNAVAILABLE"
        | "SETTINGS_INPUT_INVALID"
        | "SETTINGS_WRITE_FAILED"
        | "CONNECTOR_APP_VERIFICATION_STATE_CHANGED"
        | "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"
        | "WORKSPACE_NOT_FOUND"
        | "WORKSPACE_SELECTION_PROTECTED"
        | "WORKSPACE_ROOT_CHANGED"
        | "WORKSPACE_MUTATION_NOT_PENDING"
        | "WORKSPACE_MUTATION_PROMOTION_PENDING";
      snapshot: ProductConfigurationSnapshot;
    }
>;

const workspaceInputSchema = z.strictObject({
  root: z.string(),
  label: z.string().trim().min(1).max(120),
  rootIdentity: WorkspaceRootIdentitySchema.optional(),
});

const verificationInputSchema = z.strictObject({
  profile: z.string().min(1).max(160),
  runtimeGeneration: z.string().min(1).max(160),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  protocol: z.string().min(1).max(160),
});

const chatGptObservationSchema = z.discriminatedUnion("state", [
  verificationInputSchema.extend({ state: z.literal("authenticated") }),
  z.strictObject({ state: z.literal("signed_out") }),
  z.strictObject({ state: z.literal("unreachable") }),
  z.strictObject({ state: z.literal("unsupported") }),
  z.strictObject({ state: z.literal("outcome_unknown") }),
]);

const codexHostInputSchema = z
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

const codexHostFailureSchema = z.enum(["unreachable", "unsupported"]);

const codexHostLiveInputSchema = z.strictObject({
  model: z.literal("gpt-6-astra"),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
});

const codexHostLiveFailureSchema = z.enum([
  "failed",
  "model_unavailable",
  "outcome_unknown",
]);

const codexAgentFailureSchema = z.enum([
  "failed",
  "running",
  "outcome_unknown",
  "workspace_not_verified",
]);

const secureMcpTunnelClientInputSchema = z.strictObject({
  executablePath: z.string(),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
  protocol: z.literal("openai-tunnel-client/v1"),
});

const secureMcpTunnelInputSchema = z.strictObject({
  tunnelId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[0-9A-Za-z._:-]+$/u),
});

const secureMcpRuntimeInputSchema = z.strictObject({
  state: z.enum(["ready", "unreachable", "outcome_unknown"]),
  runtimeGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
  computerGeneration: z.number().int().positive(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
});

const secureMcpAttachmentInputSchema = z.strictObject({
  workspaceId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    ),
  runtimeGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
  computerGeneration: z.number().int().positive(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  challengeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const secureMcpChallengeInputSchema = z.strictObject({
  challenge: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    ),
  runtimeGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
  computerGeneration: z.number().int().positive(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
});

function settingsError(error: unknown): ProductConfigurationSnapshot {
  const message = error instanceof Error ? error.message : "";
  if (message === "CONFIG_RENAME_REQUIRED") {
    return { status: "error", error: "CONFIG_RENAME_REQUIRED" };
  }
  if (message === "SETTINGS_CORRUPT") {
    return { status: "error", error: "SETTINGS_CORRUPT" };
  }
  if (message === "SETTINGS_UNSAFE") {
    return { status: "error", error: "SETTINGS_UNSAFE" };
  }
  return { status: "error", error: "SETTINGS_READ_FAILED" };
}

function readiness(needsAction: string): ProductSettings["setup"][SetupStepId] {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown",
    verified: null,
    needsAction,
    unavailable: null,
    outcomeUnknown: false,
  };
}

function withoutRecovery(
  readiness: ProductSettings["setup"]["verify"],
): ProductSettings["setup"]["verify"] {
  const { recovery: _recovery, ...rest } = readiness;
  return rest;
}

function pendingAgentReadiness(
  previous: ProductSettings["setup"]["verify"],
  needsAction: string,
  configured: boolean,
): ProductSettings["setup"]["verify"] {
  return {
    ...withoutRecovery(previous),
    configured,
    reachable: "unknown",
    verified: null,
    needsAction,
    unavailable: null,
    outcomeUnknown: false,
  };
}

// A Computer verification stands only for a workspace that carries the folder
// identity it bound. Settings written before identities existed name workspaces
// without one; their verification is withdrawn at load and at every commit, so
// no consumer can treat that pathname as the folder the owner approved. Only a
// new explicit verification measures and records the identity.
function invalidateUnboundComputerVerification(
  settings: ProductSettings,
): ProductSettings {
  const verification = settings.setup.computer.verified;
  if (!verification) return settings;
  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === verification.workspaceId,
  );
  if (workspace?.rootIdentity) return settings;
  return {
    ...settings,
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        reachable: "unknown",
        verified: null,
        needsAction: workspace
          ? `Verify ${workspace.label} again so Farol binds it to the folder you approved.`
          : "Verify a folder.",
      },
    },
  };
}

function advanceComputerApprovalGeneration(
  previous: ProductSettings,
  candidate: ProductSettings,
): ProductSettings {
  // Compare the actual owner policy with a fixed expiry, so evidence renewal
  // alone does not invalidate existing approvals.
  if (
    JSON.stringify(ownerSettingsComputerApproval(previous, 0)) ===
    JSON.stringify(ownerSettingsComputerApproval(candidate, 0))
  )
    return candidate;

  const previousGeneration = previous.computer.generation;
  const generation = previousGeneration + 1;
  const verification = candidate.setup.computer.verified;
  return {
    ...candidate,
    computer: {
      ...candidate.computer,
      generation,
      // Preserve the candidate's effective policy when advancing its seal.
      // Evidence already stale in the previous generation stays stale.
      workspaces: candidate.computer.workspaces.map((workspace) =>
        workspace.accessCheck?.computerGeneration === previousGeneration
          ? {
              ...workspace,
              accessCheck: {
                ...workspace.accessCheck,
                computerGeneration: generation,
              },
            }
          : workspace,
      ),
    },
    setup: {
      ...candidate.setup,
      computer: {
        ...candidate.setup.computer,
        verified:
          verification?.configRevision === previousGeneration
            ? { ...verification, configRevision: generation }
            : verification,
      },
    },
  };
}

function invalidateStaleAgentVerification(
  settings: ProductSettings,
): ProductSettings {
  const host = settings.nativeHosts.codex;
  const verification = host?.agentVerification;
  if (!host || !verification) return settings;

  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === verification.workspaceId,
  );
  const computerVerification = settings.setup.computer.verified;
  const liveVerification = host.liveVerification;
  const current =
    host.executableSha256 === verification.executableSha256 &&
    host.schemaSha256 === verification.schemaSha256 &&
    liveVerification?.executableSha256 === verification.executableSha256 &&
    liveVerification.schemaSha256 === verification.schemaSha256 &&
    liveVerification.buildId === verification.buildId &&
    settings.computer.generation === verification.computerGeneration &&
    workspace !== undefined &&
    computerVerification?.workspaceId === verification.workspaceId &&
    computerVerification.configRevision === verification.computerGeneration &&
    computerVerification.buildId === verification.buildId &&
    settings.setup.computer.reachable === "reachable" &&
    !settings.setup.computer.outcomeUnknown;
  if (current) return settings;

  return {
    ...settings,
    nativeHosts: {
      ...settings.nativeHosts,
      codex: { ...host, agentVerification: null },
    },
    setup: {
      ...settings.setup,
      verify: pendingAgentReadiness(
        settings.setup.verify,
        liveVerification
          ? "Run the native Agent lineage check."
          : "Run the live Codex host check first.",
        liveVerification !== null,
      ),
    },
  };
}

function invalidateStaleCodexTaskSource(
  settings: ProductSettings,
): ProductSettings {
  const host = settings.nativeHosts.codex;
  const source = host?.taskSource;
  // Older settings remain readable without inventing source support or migrating
  // unrelated host/Computer evidence. Root treats missing Task evidence as absent.
  if (!host || !source) return settings;
  const local = host.localVerification;
  const bound =
    source.hostGeneration === settings.nativeHosts.generation &&
    local !== null &&
    local.executableSha256 === host.executableSha256 &&
    local.schemaSha256 === host.schemaSha256 &&
    source.localVerification.executableSha256 === local.executableSha256 &&
    source.localVerification.schemaSha256 === local.schemaSha256 &&
    source.localVerification.buildId === local.buildId &&
    source.localVerification.verifiedAt === local.verifiedAt &&
    [source.evidence.handoff, source.evidence.followup].every(
      (witness) =>
        witness.executablePath === host.executablePath &&
        witness.executableSha256 === host.executableSha256 &&
        witness.baseSchemaSha256 === host.schemaSha256,
    ) &&
    (source.evidence.handoff.status !== "supported" ||
      source.evidence.handoff.contract.version === host.version);
  if (bound) return settings;
  return {
    ...settings,
    nativeHosts: {
      ...settings.nativeHosts,
      generation:
        source.hostGeneration === settings.nativeHosts.generation
          ? settings.nativeHosts.generation + 1
          : settings.nativeHosts.generation,
      codex: { ...host, taskSource: null },
      taskRoute: null,
    },
  };
}

function connectorConfigured(
  connector: ProductSettings["connectors"]["secureMcp"],
): boolean {
  return (
    connector.tunnelClient !== null &&
    connector.tunnelId !== null &&
    connector.credential === "stored"
  );
}

function pendingConnectorReadiness(
  previous: ProductSettings["setup"]["connect"],
  connector: ProductSettings["connectors"]["secureMcp"],
  needsAction?: string,
): ProductSettings["setup"]["connect"] {
  const configured = connectorConfigured(connector);
  const nextAction =
    needsAction ??
    (connector.tunnelClient === null
      ? "Choose the verified tunnel-client executable."
      : connector.tunnelId === null
        ? "Enter the OpenAI tunnel ID."
        : connector.credential === "missing"
          ? "Store the tunnel runtime key in the private connector store."
          : "Start the connector and check readiness.");
  return {
    ...previous,
    configured,
    reachable: "unknown",
    verified: null,
    needsAction: nextAction,
    unavailable: null,
    outcomeUnknown: false,
  };
}

function invalidateStaleConnectorRuntime(
  settings: ProductSettings,
): ProductSettings {
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  const challenge = connector.challenge;
  const attachment = connector.attachment;
  const runtimeCurrent =
    runtime === null ||
    (runtime.connectorGeneration === connector.generation &&
      runtime.computerGeneration === settings.computer.generation);
  const challengeCurrent =
    challenge === null ||
    (runtime?.state === "ready" &&
      challenge.runtimeGeneration === runtime.runtimeGeneration &&
      challenge.computerGeneration === settings.computer.generation &&
      challenge.buildId === runtime.buildId);
  const attachmentCurrent =
    attachment === null ||
    (runtime?.state === "ready" &&
      attachment.connectorGeneration === connector.generation &&
      attachment.runtimeGeneration === runtime.runtimeGeneration &&
      attachment.computerGeneration === settings.computer.generation &&
      attachment.buildId === runtime.buildId &&
      attachment.tunnelId === connector.tunnelId);
  if (runtimeCurrent && challengeCurrent && attachmentCurrent) return settings;

  const invalidated = {
    ...connector,
    generation: connector.generation + 1,
    runtime: null,
    challenge: null,
    attachment: null,
  };
  return {
    ...settings,
    connectors: { ...settings.connectors, secureMcp: invalidated },
    setup: {
      ...settings.setup,
      connect: pendingConnectorReadiness(
        settings.setup.connect,
        invalidated,
        "Restart the connector after changing Computer authority.",
      ),
    },
  };
}

function defaultSettings(id: () => string): ProductSettings {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: id(),
      generation: 1,
      name: "This Mac",
      commands: "none",
      workspaces: [],
      pendingEdit: null,
    },
    nativeHosts: { generation: 1, codex: null },
    connectors: {
      secureMcp: {
        generation: 1,
        profile: "farol-next",
        tunnelId: null,
        tunnelClient: null,
        credential: "missing",
        runtime: null,
        challenge: null,
        attachment: null,
      },
    },
    setup: {
      journey: { currentStep: "chatgpt", dismissed: false },
      chatgpt: readiness("Sign in to the isolated Farol Next browser."),
      computer: readiness("Add a read-only workspace."),
      connect: readiness("Configure the Next-only Computer connection."),
      hosts: readiness("Review one scoped native host integration."),
      verify: readiness("Run each configured capability check."),
    },
  });
}

export class ProductSettingsStore {
  private conditionalPublicationUnknown = false;

  constructor(
    private readonly options: ProductSettingsStoreOptions,
    private readonly hooks: StoreHooks = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("SETTINGS_STATE_ROOT_NOT_ABSOLUTE");
    }
  }

  fenceConditionalWrites(): void {
    this.conditionalPublicationUnknown = true;
  }

  async load(): Promise<ProductSettings | null> {
    await this.ensureRoot();
    const target = path.join(this.options.root, FILE_NAME);
    let handle;
    try {
      handle = await fs.open(
        target,
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("SETTINGS_UNSAFE");
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      if (info.size > MAXIMUM_BYTES) throw new Error("SETTINGS_CORRUPT");
      const parsed = ProductSettingsSchema.safeParse(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
      if (!parsed.success) throw new Error("SETTINGS_CORRUPT");
      return parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("SETTINGS_CORRUPT");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async save(
    settings: ProductSettings,
    fence: StoreWriteFence = {},
  ): Promise<void> {
    if (this.conditionalPublicationUnknown)
      throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
    return this.saveOnce(settings, fence);
  }

  // The owning service must serialize this with every other Settings mutation.
  // Compare the complete existing document so unrelated values cannot be lost.
  // This is conditional replacement under that one writer, not a filesystem CAS
  // against arbitrary external writers. It does not decide a delivery transition.
  async saveConditional(
    expected: ProductSettings,
    next: ProductSettings,
    fence: StoreWriteFence = {},
  ): Promise<ConditionalSettingsWrite> {
    if (this.conditionalPublicationUnknown) return { status: "unknown" };
    let attempted = false;
    try {
      const before = ProductSettingsSchema.parse(structuredClone(expected));
      const candidate = ProductSettingsSchema.parse(structuredClone(next));
      if (candidate.revision !== before.revision + 1)
        return { status: "not_written" };
      const serializedBefore = JSON.stringify(before);
      const assertCurrent = async () => {
        if (JSON.stringify(await this.load()) !== serializedBefore)
          throw new Error("SETTINGS_CONDITIONAL_SOURCE_CHANGED");
      };
      await assertCurrent();
      await this.saveOnce(
        candidate,
        {
          beforeWrite: async () => {
            await assertCurrent();
            await fence.beforeWrite?.();
          },
        },
        () => {
          attempted = true;
        },
      );
      const readBack = await this.load();
      if (JSON.stringify(readBack) !== JSON.stringify(candidate))
        throw new Error("SETTINGS_CONDITIONAL_READ_BACK_FAILED");
      return { status: "committed", settings: readBack! };
    } catch {
      if (!attempted) return { status: "not_written" };
      // Never re-read after the failed publication/readback to infer success.
      // Visible bytes cannot settle an unknown acknowledgement. Even legacy
      // writes through this retained store must now refuse.
      this.conditionalPublicationUnknown = true;
      return { status: "unknown" };
    }
  }

  private async saveOnce(
    settings: ProductSettings,
    fence: StoreWriteFence,
    publicationAttempted?: () => void,
  ): Promise<void> {
    if (this.conditionalPublicationUnknown)
      throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
    const validated = ProductSettingsSchema.parse(settings);
    await this.ensureRoot();
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAXIMUM_BYTES) {
      throw new Error("SETTINGS_TOO_LARGE");
    }
    const target = path.join(this.options.root, FILE_NAME);
    await this.assertReplaceableTarget(target);
    const temporary = path.join(
      this.options.root,
      `.${FILE_NAME}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.hooks.beforeCommit?.();
      await this.assertConfigName();
      // Last before the bytes become durable: a fence that refuses here
      // leaves the target exactly as it was, and the temporary file is
      // removed by the `finally` below.
      await fence.beforeWrite?.();
      if (this.conditionalPublicationUnknown)
        throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
      publicationAttempted?.();
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await this.syncRoot();
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.options.root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      throw new Error("SETTINGS_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(this.options.root, 0o700);
    await this.assertConfigName();
  }

  private async assertConfigName(): Promise<void> {
    // Never interpret an older preview's existing config as a fresh install.
    // No dual readers, automatic reset, overwrite or live profile migration.
    try {
      await fs.lstat(path.join(this.options.root, LEGACY_FILE_NAME));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("CONFIG_RENAME_REQUIRED");
  }

  private assertPrivateFile(info: Stats): void {
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("SETTINGS_UNSAFE");
    }
  }

  private async assertReplaceableTarget(target: string): Promise<void> {
    try {
      this.assertPrivateFile(await fs.lstat(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async syncRoot(): Promise<void> {
    const directory = await fs.open(
      this.options.root,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export class ProductConfigurationService {
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly homeDirectory: string;
  private current: ProductSettings | null = null;
  private currentError: ProductConfigurationSnapshot | null = null;
  private taskSourceWithdrawalGeneration: number | null = null;
  private settingsDeliveryAttached = false;
  private settingsDeliveryFenced = false;
  private settingsDeliveryFenceOutcome: Promise<void> | undefined;
  private settingsDeliveryWithdrawalHeld = false;
  // One owner change at a time: each runs, with the checks its caller makes
  // against the current settings, through to its commit before the next one
  // clones them. Re-entrant, so a method that checks and then mutates holds
  // one turn, not two.
  private readonly turn = new AsyncLocalStorage<true>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly promotionLease: WorkspaceEditLeaseGuard | undefined;
  private withdrawComputerAuthority: ProductConfigurationDependencies["withdrawComputerAuthority"];
  // Holds the exact lease a guarded edit's `recordPendingEdit` acquired,
  // keyed by its operation ID, from the moment the edit became durable until
  // `releaseWorkspaceEditLease` is called once its outcome is recorded (see
  // `withSettingsEditLease` in `apps/desktop/with-settings-edit-lease.ts`) or, as a backstop, once its
  // delivery is acknowledged (`clearPendingEdit`). Never read for anything
  // but that one release; a process restart drops this map along with every
  // other in-memory admission, and the on-disk lease file is then recovered
  // the same way every other crashed holder is (see `promotion-lease.ts`).
  private readonly pendingEditLeases = new Map<
    string,
    WorkspaceEditLeaseHold
  >();

  constructor(
    private readonly store: ProductSettingsStore,
    dependencies: ProductConfigurationDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.id = dependencies.id ?? randomUUID;
    this.homeDirectory = dependencies.homeDirectory ?? os.homedir();
    this.promotionLease = dependencies.promotionLease;
    this.withdrawComputerAuthority = dependencies.withdrawComputerAuthority;
  }

  // Trusted boot composition only, after initial settings readback and before
  // IPC admission. Existing configured callbacks can never be replaced.
  attachComputerAuthority(
    withdraw: NonNullable<
      ProductConfigurationDependencies["withdrawComputerAuthority"]
    >,
  ): void {
    if (this.withdrawComputerAuthority || typeof withdraw !== "function")
      throw new Error("COMPUTER_AUTHORITY_ALREADY_BOUND");
    this.withdrawComputerAuthority = withdraw;
  }

  // Exactly one trusted host binding, using the existing document and writer.
  // This is not a renderer API and does not activate the Go delivery service.
  attachSettingsDeliveryStore(
    scope: SettingsStoreScope,
  ): SettingsDeliveryStore {
    if (this.settingsDeliveryAttached)
      throw new Error("SETTINGS_DELIVERY_STORE_ALREADY_BOUND");
    this.settingsDeliveryAttached = true;
    const selected = structuredClone(scope);
    return {
      read: () =>
        this.exclusive(async () => {
          if (this.settingsDeliveryFenced || !this.current)
            return { status: "unavailable" };
          try {
            const readback = await this.store.load();
            if (JSON.stringify(readback) !== JSON.stringify(this.current))
              return { status: "unavailable" };
            return {
              status: "ok",
              snapshot: settingsStoreSnapshot(this.current, selected),
            };
          } catch (error) {
            return {
              status:
                error instanceof SettingsStoreUnsupported
                  ? "unsupported"
                  : "unavailable",
            };
          }
        }),
      replace: (change) => {
        // Capture caller bytes before joining the queue.
        const captured: unknown = structuredClone(change);
        return this.exclusive(() =>
          this.replaceSettingsDeliveryStore(selected, captured),
        );
      },
      fence: () => {
        // Loss is synchronous, including while a write/readback/publication is
        // awaiting. The queued withdrawal must not be the first loss marker.
        this.latchSettingsDeliveryLoss();
        return this.exclusive(() => this.fenceSettingsDeliveryStore());
      },
    };
  }

  private latchSettingsDeliveryLoss(): void {
    this.settingsDeliveryFenced = true;
    this.store.fenceConditionalWrites();
    this.current = null;
    this.currentError = settingsError(
      new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN"),
    );
  }

  private fenceSettingsDeliveryStore(): Promise<void> {
    this.latchSettingsDeliveryLoss();
    if (this.settingsDeliveryFenceOutcome)
      return this.settingsDeliveryFenceOutcome;
    // No publication callback: authority remains withdrawn until an explicitly
    // supported recovery, never a fresh read of valid-looking disk bytes.
    this.settingsDeliveryFenceOutcome = (async () => {
      // A successful withdrawal with an unused publication capability already
      // proves inactivity. Repeating it would call the locked host owner again.
      if (this.settingsDeliveryWithdrawalHeld) return;
      await this.withdrawComputerAuthority?.();
      this.settingsDeliveryWithdrawalHeld = true;
    })();
    return this.settingsDeliveryFenceOutcome;
  }

  private retainSettingsDeliveryAuthorityFailure(error: unknown): void {
    this.latchSettingsDeliveryLoss();
    this.settingsDeliveryFenceOutcome = Promise.reject(error);
    void this.settingsDeliveryFenceOutcome.catch(() => undefined);
  }

  private async replaceSettingsDeliveryStore(
    scope: SettingsStoreScope,
    change: unknown,
  ): Promise<SettingsStoreReplaceResult> {
    if (this.settingsDeliveryFenced) return { status: "unknown" };
    if (!this.current) return { status: "not_written" };
    const before = structuredClone(this.current);
    let candidate: ProductSettings | undefined;
    try {
      candidate = settingsStoreReplacement(before, scope, change);
    } catch {
      return { status: "not_written" };
    }
    if (!candidate) return { status: "not_written" };
    const beginning =
      before.computer.pendingEdit === null &&
      candidate.computer.pendingEdit !== null;
    let lease: WorkspaceEditLeaseHold | null = null;
    let storeCalled = false;
    let keepLease = false;
    try {
      if (beginning && this.promotionLease) {
        lease = await this.promotionLease.acquireForAdmission();
        if (!lease || (lease.verify && !(await lease.verify())))
          return { status: "not_written" };
      }
      const changed =
        JSON.stringify(ownerSettingsComputerApproval(before, 0)) !==
          JSON.stringify(ownerSettingsComputerApproval(candidate, 0)) ||
        JSON.stringify(taskSettingsProjection(before)) !==
          JSON.stringify(taskSettingsProjection(candidate));
      let publication: ComputerSettingsPublication | undefined;
      if (changed && this.withdrawComputerAuthority) {
        try {
          publication = await this.withdrawComputerAuthority();
          this.settingsDeliveryWithdrawalHeld = true;
        } catch (error) {
          // The original authority call may have completed. Retain that exact
          // uncertainty instead of retrying it through the generic fence hook.
          this.retainSettingsDeliveryAuthorityFailure(error);
          return { status: "unknown" };
        }
      }
      if (this.settingsDeliveryFenced) {
        await this.fenceSettingsDeliveryStore();
        return { status: "unknown" };
      }
      const verify = lease?.verify?.bind(lease);
      storeCalled = true;
      const written = await this.store.saveConditional(
        before,
        candidate,
        verify
          ? {
              beforeWrite: async () => {
                if (!(await verify())) throw new WorkspaceEditLeaseLost();
              },
            }
          : {},
      );
      if (written.status === "not_written") return written;
      if (written.status === "unknown" || this.settingsDeliveryFenced) {
        await this.fenceSettingsDeliveryStore();
        return { status: "unknown" };
      }
      if (publication) {
        this.settingsDeliveryWithdrawalHeld = false;
        try {
          await publication.publish(structuredClone(written.settings));
        } catch (error) {
          this.retainSettingsDeliveryAuthorityFailure(error);
          return { status: "unknown" };
        }
      }
      if (this.settingsDeliveryFenced) {
        await this.fenceSettingsDeliveryStore();
        return { status: "unknown" };
      }
      this.current = written.settings;
      this.currentError = null;
      if (beginning && lease) {
        this.pendingEditLeases.set(
          candidate.computer.pendingEdit!.operationId,
          lease,
        );
        keepLease = true;
      }
      if (
        candidate.computer.pendingEdit === null &&
        before.computer.pendingEdit !== null
      )
        await this.releaseWorkspaceEditLease(
          before.computer.pendingEdit.operationId,
        );
      if (this.settingsDeliveryFenced) return { status: "unknown" };
      return {
        status: "committed",
        snapshot: settingsStoreSnapshot(written.settings, scope),
      };
    } catch {
      if (!storeCalled) return { status: "not_written" };
      await this.fenceSettingsDeliveryStore().catch(() => undefined);
      return { status: "unknown" };
    } finally {
      if (!keepLease) await lease?.release();
    }
  }

  async initialize(): Promise<void> {
    if (this.settingsDeliveryFenced) return;
    try {
      let loaded = await this.store.load();
      if (loaded === null) {
        await this.store.save(defaultSettings(this.id));
        loaded = await this.store.load();
      }
      if (loaded === null) throw new Error("SETTINGS_READ_BACK_FAILED");
      if (this.settingsDeliveryFenced) return;
      this.current = this.fenceTaskSource(loaded);
      this.currentError = null;
    } catch (error) {
      this.current = null;
      this.currentError = settingsError(error);
      return;
    }
    // Settings saved before folder identities existed may still name a
    // verified workspace without one; withdraw that verification before any
    // consumer reads it, and persist the withdrawal like any other change.
    if (
      invalidateUnboundComputerVerification(this.current) !== this.current ||
      invalidateStaleCodexTaskSource(this.current) !== this.current
    ) {
      const withdrawn = await this.mutate((settings) => ({
        ...settings,
        revision: settings.revision + 1,
      }));
      if (!withdrawn.ok) {
        const invalidated = invalidateStaleCodexTaskSource(
          invalidateUnboundComputerVerification(this.current),
        );
        if (
          this.current.nativeHosts.codex?.taskSource &&
          !invalidated.nativeHosts.codex?.taskSource
        )
          this.taskSourceWithdrawalGeneration = Math.max(
            this.taskSourceWithdrawalGeneration ?? 0,
            invalidated.nativeHosts.generation,
          );
        this.current = this.fenceTaskSource(invalidated);
      }
    }
    // Older Dev profiles stored only the live attachment. Capture a valid
    // saved proof before a later runtime restart clears that live field.
    const connector = this.current.connectors.secureMcp;
    const attachment = connector.attachment;
    const runtime = connector.runtime;
    const verified = this.current.setup.connect.verified;
    if (
      connector.lastVerifiedAttachment === null &&
      attachment !== null &&
      runtime?.state === "ready" &&
      connector.tunnelId === attachment.tunnelId &&
      connector.generation === attachment.connectorGeneration &&
      runtime.runtimeGeneration === attachment.runtimeGeneration &&
      runtime.buildId === attachment.buildId &&
      runtime.computerGeneration === attachment.computerGeneration &&
      this.current.computer.generation === attachment.computerGeneration &&
      verified?.configRevision === attachment.connectorGeneration &&
      verified.workspaceId === attachment.workspaceId &&
      verified.runtimeGeneration === attachment.runtimeGeneration &&
      verified.buildId === attachment.buildId &&
      this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === attachment.workspaceId,
      )
    ) {
      await this.mutate((settings) => ({
        ...settings,
        revision: settings.revision + 1,
        connectors: {
          ...settings.connectors,
          secureMcp: {
            ...settings.connectors.secureMcp,
            lastVerifiedAttachment: attachment,
          },
        },
      }));
    }
  }

  snapshot(): ProductConfigurationSnapshot {
    const snapshot =
      this.current === null
        ? (this.currentError ?? {
            status: "error" as const,
            error: "SETTINGS_READ_FAILED" as const,
          })
        : {
            status: "ready" as const,
            settings: structuredClone(this.fenceTaskSource(this.current)),
          };
    return ProductConfigurationSnapshotSchema.parse(snapshot);
  }

  async updateGeneral(input: unknown): Promise<MutationResult> {
    const parsed = ProductGeneralSettingsSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      general: parsed.data,
    }));
  }

  async recordSecureMcpTunnelClient(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpTunnelClientInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => {
      const connector = settings.connectors.secureMcp;
      const selected = connector.tunnelClient;
      if (
        selected?.executablePath === parsed.data.executablePath &&
        selected.executableSha256 === parsed.data.executableSha256 &&
        selected.version === parsed.data.version &&
        selected.protocol === parsed.data.protocol
      ) {
        return settings;
      }
      const next = {
        ...connector,
        generation: connector.generation + 1,
        tunnelClient: { ...parsed.data, verifiedAt: this.now() },
        runtime: null,
        challenge: null,
        attachment: null,
      };
      return {
        ...settings,
        revision: settings.revision + 1,
        connectors: { ...settings.connectors, secureMcp: next },
        setup: {
          ...settings.setup,
          connect: pendingConnectorReadiness(settings.setup.connect, next),
        },
      };
    });
  }

  async configureSecureMcpTunnel(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpTunnelInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => {
      const connector = settings.connectors.secureMcp;
      if (connector.tunnelId === parsed.data.tunnelId) return settings;
      const next = {
        ...connector,
        generation: connector.generation + 1,
        tunnelId: parsed.data.tunnelId,
        runtime: null,
        challenge: null,
        attachment: null,
      };
      return {
        ...settings,
        revision: settings.revision + 1,
        connectors: { ...settings.connectors, secureMcp: next },
        setup: {
          ...settings.setup,
          connect: pendingConnectorReadiness(settings.setup.connect, next),
        },
      };
    });
  }

  async selectSecureMcpChatGptApp(input: unknown): Promise<MutationResult> {
    const parsed = SecureMcpAppSelectionSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const connector = this.current.connectors.secureMcp;
      if (
        this.current.setup.connect.outcomeUnknown ||
        connector.runtime?.state === "outcome_unknown"
      )
        return this.failure("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
      if (
        connector.tunnelId !== parsed.data.tunnelId ||
        connector.generation !== parsed.data.connectorGeneration
      )
        return this.failure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
      return this.commit((settings) => ({
        ...settings,
        revision: settings.revision + 1,
        connectors: {
          ...settings.connectors,
          secureMcp: {
            ...settings.connectors.secureMcp,
            chatgptApp: parsed.data,
          },
        },
      }));
    });
  }

  async recordSecureMcpCredential(
    credential: unknown,
  ): Promise<MutationResult> {
    const parsed = z.enum(["missing", "stored"]).safeParse(credential);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => {
      const connector = settings.connectors.secureMcp;
      if (connector.credential === parsed.data) return settings;
      const next = {
        ...connector,
        generation: connector.generation + 1,
        credential: parsed.data,
        runtime: null,
        challenge: null,
        attachment: null,
      };
      return {
        ...settings,
        revision: settings.revision + 1,
        connectors: { ...settings.connectors, secureMcp: next },
        setup: {
          ...settings.setup,
          connect: pendingConnectorReadiness(settings.setup.connect, next),
        },
      };
    });
  }

  async recordSecureMcpRuntime(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpRuntimeInputSchema.safeParse(input);
    if (!parsed.success || this.current === null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    const connector = this.current.connectors.secureMcp;
    if (
      !connectorConfigured(connector) ||
      parsed.data.computerGeneration !== this.current.computer.generation
    ) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) => {
      const current = settings.connectors.secureMcp;
      const observedAt = this.now();
      const runtime = {
        ...parsed.data,
        connectorGeneration: current.generation,
        observedAt,
      };
      const ready = parsed.data.state === "ready";
      const outcomeUnknown = parsed.data.state === "outcome_unknown";
      const next = { ...current, runtime, challenge: null, attachment: null };
      return {
        ...settings,
        revision: settings.revision + 1,
        connectors: { ...settings.connectors, secureMcp: next },
        setup: {
          ...settings.setup,
          connect: {
            ...settings.setup.connect,
            visited: true,
            skipped: false,
            configured: true,
            reachable: ready
              ? "reachable"
              : outcomeUnknown
                ? "unknown"
                : "unreachable",
            verified: null,
            needsAction: ready
              ? "Verify the ChatGPT attachment with a one-time challenge."
              : outcomeUnknown
                ? "Inspect the connector before deliberately starting it again."
                : "Run connector repair, then check readiness again.",
            unavailable: null,
            outcomeUnknown,
          },
        },
      };
    });
  }

  async recordSecureMcpChallenge(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpChallengeInputSchema.safeParse(input);
    if (!parsed.success || this.current === null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    const connector = this.current.connectors.secureMcp;
    const runtime = connector.runtime;
    if (
      runtime?.state !== "ready" ||
      runtime.connectorGeneration !== connector.generation ||
      runtime.runtimeGeneration !== parsed.data.runtimeGeneration ||
      runtime.computerGeneration !== parsed.data.computerGeneration ||
      runtime.buildId !== parsed.data.buildId ||
      parsed.data.computerGeneration !== this.current.computer.generation
    ) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) => {
      const current = settings.connectors.secureMcp;
      const { challenge: value, ...proof } = parsed.data;
      const challenge = {
        ...proof,
        value,
        challengeSha256: createHash("sha256").update(value).digest("hex"),
        preparedAt: this.now(),
      };
      return {
        ...settings,
        revision: settings.revision + 1,
        connectors: {
          ...settings.connectors,
          secureMcp: { ...current, challenge, attachment: null },
        },
        setup: {
          ...settings.setup,
          connect: {
            ...settings.setup.connect,
            visited: true,
            skipped: false,
            configured: true,
            reachable: "reachable",
            verified: null,
            needsAction:
              "Attach this connector in ChatGPT, run the one-time challenge, then check its receipt.",
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async recordSecureMcpAttachment(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpAttachmentInputSchema.safeParse(input);
    if (!parsed.success || this.current === null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    const connector = this.current.connectors.secureMcp;
    const runtime = connector.runtime;
    const challenge = connector.challenge;
    if (
      connector.tunnelId === null ||
      connector.tunnelClient === null ||
      runtime?.state !== "ready" ||
      runtime.connectorGeneration !== connector.generation ||
      runtime.runtimeGeneration !== parsed.data.runtimeGeneration ||
      runtime.computerGeneration !== parsed.data.computerGeneration ||
      runtime.buildId !== parsed.data.buildId ||
      challenge?.challengeSha256 !== parsed.data.challengeSha256 ||
      challenge.runtimeGeneration !== parsed.data.runtimeGeneration ||
      challenge.computerGeneration !== parsed.data.computerGeneration ||
      challenge.buildId !== parsed.data.buildId ||
      !this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === parsed.data.workspaceId,
      ) ||
      parsed.data.computerGeneration !== this.current.computer.generation
    ) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) => {
      const current = settings.connectors.secureMcp;
      const verifiedAt = this.now();
      const attachment = {
        ...parsed.data,
        tunnelId: current.tunnelId as string,
        connectorGeneration: current.generation,
        verifiedAt,
      };
      return {
        ...settings,
        revision: settings.revision + 1,
        connectors: {
          ...settings.connectors,
          secureMcp: {
            ...current,
            challenge: null,
            attachment,
            lastVerifiedAttachment: attachment,
          },
        },
        setup: {
          ...settings.setup,
          connect: {
            ...settings.setup.connect,
            visited: true,
            skipped: false,
            configured: true,
            reachable: "reachable",
            verified: {
              profile: current.profile,
              configRevision: current.generation,
              workspaceId: parsed.data.workspaceId,
              runtimeGeneration: parsed.data.runtimeGeneration,
              buildId: parsed.data.buildId,
              protocol: current.tunnelClient?.protocol as string,
              verifiedAt,
            },
            needsAction: null,
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async recordSecureMcpDrainedForUpdate(): Promise<MutationResult> {
    return this.recordSecureMcpStopped(undefined, "update");
  }

  async recordSecureMcpStopped(
    resumeRefusal?:
      | "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE"
      | "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
    purpose: "stop" | "update" = "stop",
  ): Promise<MutationResult> {
    return this.mutate((settings) => {
      const connector = settings.connectors.secureMcp;
      if (
        connector.runtime === null &&
        connector.challenge === null &&
        connector.attachment === null &&
        resumeRefusal === undefined
      ) {
        return settings;
      }
      const next = {
        ...connector,
        // Keep only a stopped, generation-bound resume intent after a known
        // update drain. This is never live readiness and contains no new proof.
        runtime:
          purpose === "update" &&
          resumeRefusal === undefined &&
          connector.runtime?.state === "ready" &&
          connector.runtime.connectorGeneration === connector.generation &&
          connector.runtime.computerGeneration ===
            settings.computer.generation &&
          !settings.setup.connect.outcomeUnknown
            ? {
                ...connector.runtime,
                state: "unreachable" as const,
                observedAt: this.now(),
              }
            : null,
        challenge: null,
        attachment: null,
      };
      return {
        ...settings,
        revision: settings.revision + 1,
        connectors: { ...settings.connectors, secureMcp: next },
        setup: {
          ...settings.setup,
          connect: {
            ...pendingConnectorReadiness(
              settings.setup.connect,
              next,
              resumeRefusal === undefined
                ? undefined
                : "Choose the tunnel-client executable again before reconnecting.",
            ),
            unavailable:
              next.runtime !== null
                ? "CONNECTOR_UPDATE_DRAINED"
                : (resumeRefusal ?? null),
          },
        },
      };
    });
  }

  async addReadonlyWorkspace(input: unknown): Promise<MutationResult> {
    const parsed = workspaceInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    if (
      credentialStorePolicy(parsed.data.root, this.homeDirectory).kind ===
      "inside-store"
    ) {
      return this.failure("WORKSPACE_SELECTION_PROTECTED");
    }
    return this.mutate((settings) => {
      if (
        settings.computer.workspaces.some(
          (workspace) => workspace.root === parsed.data.root,
        )
      ) {
        return settings;
      }
      const workspaces = [
        ...settings.computer.workspaces,
        {
          workspaceId: this.id(),
          root: parsed.data.root,
          label: parsed.data.label,
          access: "read" as const,
          excludedPaths: [],
          ...(parsed.data.rootIdentity
            ? { rootIdentity: parsed.data.rootIdentity }
            : {}),
        },
      ];
      return {
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          generation: settings.computer.generation + 1,
          workspaces,
        },
        setup: {
          ...settings.setup,
          computer: {
            ...settings.setup.computer,
            configured: true,
            reachable: "unknown" as const,
            verified: null,
            needsAction: "Verify read access to this workspace.",
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async renameComputer(input: unknown): Promise<MutationResult> {
    const parsed = z.string().trim().min(1).max(80).safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      computer: {
        ...settings.computer,
        generation: settings.computer.generation + 1,
        name: parsed.data,
      },
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          reachable: "unknown",
          verified: null,
          needsAction:
            settings.computer.workspaces.length > 0
              ? "Verify read access after changing This Mac."
              : "Add a read-only workspace.",
          outcomeUnknown: false,
        },
      },
    }));
  }

  async removeWorkspace(workspaceId: string): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (
      !this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === workspaceId,
      )
    ) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate((settings) => {
      const workspaces = settings.computer.workspaces.filter(
        (workspace) => workspace.workspaceId !== workspaceId,
      );
      const configured = workspaces.length > 0;
      return {
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          generation: settings.computer.generation + 1,
          workspaces,
        },
        setup: {
          ...settings.setup,
          computer: {
            ...settings.setup.computer,
            configured,
            reachable: "unknown" as const,
            verified: null,
            needsAction: configured
              ? "Verify read access to an approved workspace."
              : "Add a read-only workspace.",
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async updateWorkspaceExclusions(
    workspaceId: string,
    input: unknown,
  ): Promise<MutationResult> {
    const parsed = z.array(z.string()).max(32).safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (
      !this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === workspaceId,
      )
    ) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate((settings) => {
      const current = settings.computer.workspaces.find(
        (workspace) => workspace.workspaceId === workspaceId,
      );
      if (
        current &&
        JSON.stringify(current.excludedPaths) === JSON.stringify(parsed.data)
      ) {
        return settings;
      }
      return {
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          generation: settings.computer.generation + 1,
          workspaces: settings.computer.workspaces.map((workspace) =>
            workspace.workspaceId === workspaceId
              ? {
                  ...workspace,
                  excludedPaths: parsed.data,
                  gitHistoryApproved: false,
                }
              : workspace,
          ),
        },
        setup: {
          ...settings.setup,
          computer: {
            ...settings.setup.computer,
            configured: true,
            reachable: "unknown" as const,
            verified: null,
            needsAction: "Verify read access after changing exclusions.",
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async updateWorkspaceAccess(
    workspaceId: string,
    access: "read" | "write",
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    const current = this.current.computer.workspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (!current) return this.failure("WORKSPACE_NOT_FOUND");
    if (current.access === access) {
      return { ok: true, snapshot: this.snapshot() };
    }
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      computer: {
        ...settings.computer,
        generation: settings.computer.generation + 1,
        workspaces: settings.computer.workspaces.map((workspace) =>
          workspace.workspaceId === workspaceId
            ? { ...workspace, access, gitHistoryApproved: false }
            : workspace,
        ),
      },
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          configured: true,
          reachable: "unknown",
          verified: null,
          needsAction: `Verify ${access} access after changing workspace access.`,
          unavailable: null,
          outcomeUnknown: false,
        },
      },
    }));
  }

  async updateWorkspaceGitHistory(
    workspaceId: string,
    approved: boolean,
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    const current = this.current.computer.workspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (!current) return this.failure("WORKSPACE_NOT_FOUND");
    if (
      approved &&
      (this.current.computer.commands !== "workspace" ||
        !current.rootIdentity ||
        this.current.setup.computer.verified?.workspaceId !== workspaceId ||
        this.current.setup.computer.verified?.configRevision !==
          this.current.computer.generation)
    )
      return this.failure("SETTINGS_INPUT_INVALID");
    if (current.gitHistoryApproved === approved) {
      return { ok: true, snapshot: this.snapshot() };
    }
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      computer: {
        ...settings.computer,
        generation: settings.computer.generation + 1,
        workspaces: settings.computer.workspaces.map((workspace) =>
          workspace.workspaceId === workspaceId
            ? { ...workspace, gitHistoryApproved: approved }
            : workspace,
        ),
      },
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          configured: true,
          reachable: "unknown",
          verified: null,
          needsAction:
            "Verify workspace access after changing Git history authority.",
          unavailable: null,
          outcomeUnknown: false,
        },
      },
    }));
  }

  async updateComputerCommands(input: unknown): Promise<MutationResult> {
    const parsed = z
      .enum(["none", "verification", "workspace"])
      .safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (this.current.computer.commands === parsed.data) {
      return { ok: true, snapshot: this.snapshot() };
    }
    return this.mutate((settings) => {
      const configured = settings.computer.workspaces.length > 0;
      return {
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          generation: settings.computer.generation + 1,
          commands: parsed.data,
          workspaces: settings.computer.workspaces.map((workspace) => ({
            ...workspace,
            gitHistoryApproved: false,
          })),
        },
        setup: {
          ...settings.setup,
          computer: {
            ...settings.setup.computer,
            configured,
            reachable: "unknown" as const,
            verified: null,
            needsAction: configured
              ? "Verify workspace access after changing command authority."
              : "Add a read-only workspace.",
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  // Owner verification is when a workspace's folder is bound: a workspace
  // approved before identities were recorded is bound to the folder this
  // verification observed, and a bound workspace is never rebound to another
  // object. It also approves exactly the linked Git metadata it observed, or
  // clears a grant when the metadata now lives inside the root (null).
  // Persist uncertainty before the app verification is dispatched. A lost
  // renderer reply or restart must not turn that attempt into a retry button.
  async recordSecureMcpAppPending(
    runtimeGeneration: string,
  ): Promise<MutationResult> {
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      if (
        this.current.connectors.secureMcp.runtime?.runtimeGeneration !==
        runtimeGeneration
      )
        return this.failure("SETTINGS_INPUT_INVALID");
      return this.commit((settings) => ({
        ...settings,
        revision: settings.revision + 1,
        setup: {
          ...settings.setup,
          connect: {
            ...settings.setup.connect,
            outcomeUnknown: true,
            needsAction:
              "Check the pending ChatGPT connection result before sending another check.",
          },
        },
      }));
    });
  }

  // The route may positively report that no click occurred after dispatch
  // intent was recorded. Clear only that exact attempt's uncertainty; a lost
  // acknowledgement or any changed binding must remain outcome-unknown.
  async clearSecureMcpAppPendingBeforeSubmit(
    expected: Readonly<{
      tunnelId: string;
      connectorGeneration: number;
      computerGeneration: number;
      runtimeGeneration: string;
      challengeSha256: string;
      buildId: string;
      workspaceId: string;
    }>,
  ): Promise<MutationResult> {
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const settings = this.current;
      const connector = settings.connectors.secureMcp;
      const runtime = connector.runtime;
      const challenge = connector.challenge;
      if (
        !settings.setup.connect.outcomeUnknown ||
        settings.computer.generation !== expected.computerGeneration ||
        settings.setup.computer.verified?.workspaceId !==
          expected.workspaceId ||
        connector.tunnelId !== expected.tunnelId ||
        connector.generation !== expected.connectorGeneration ||
        runtime?.state !== "ready" ||
        runtime.runtimeGeneration !== expected.runtimeGeneration ||
        runtime.buildId !== expected.buildId ||
        challenge?.challengeSha256 !== expected.challengeSha256 ||
        challenge.runtimeGeneration !== expected.runtimeGeneration
      )
        return this.failure("SETTINGS_INPUT_INVALID");
      return this.commit((current) => ({
        ...current,
        revision: current.revision + 1,
        setup: {
          ...current.setup,
          connect: {
            ...current.setup.connect,
            outcomeUnknown: false,
            needsAction:
              "The app check stopped before sending. Reconnect to prepare a new challenge.",
          },
        },
      }));
    });
  }

  // Refresh content-free evidence for an already bound folder. A changed
  // effective approval policy gets a new generation without selecting a root.
  async recordFolderAccessCheck(
    workspaceId: string,
    expectedGeneration: number,
    buildId: string,
    rootIdentity: WorkspaceRootIdentity,
    success: boolean,
  ): Promise<MutationResult> {
    if (
      !/^[a-f0-9]{64}$/u.test(buildId) ||
      !WorkspaceRootIdentitySchema.safeParse(rootIdentity).success
    )
      return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const workspace = this.current.computer.workspaces.find(
        (item) => item.workspaceId === workspaceId,
      );
      if (!workspace) return this.failure("WORKSPACE_NOT_FOUND");
      if (
        this.current.computer.generation !== expectedGeneration ||
        workspace.rootIdentity?.device !== rootIdentity.device ||
        workspace.rootIdentity?.inode !== rootIdentity.inode
      )
        return this.failure("WORKSPACE_ROOT_CHANGED");
      return this.commitComputerEvidence((settings) => ({
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          workspaces: settings.computer.workspaces.map((item) =>
            item.workspaceId !== workspaceId
              ? item
              : {
                  ...item,
                  accessCheck: success
                    ? {
                        buildId,
                        computerGeneration: expectedGeneration,
                        verifiedAt: this.now(),
                        rootIdentity,
                      }
                    : null,
                },
          ),
        },
      }));
    });
  }

  // Explicit owner Verify may bind a legacy unbound folder before the Go
  // inspection. Persisting this observation is not successful verification.
  // The exact normal withdraw/save/readback/publish sequence makes it available
  // to Go without a temporary approval that bypasses the settings owner.
  async bindWorkspaceRootIdentity(
    workspaceId: string,
    expectedRevision: number,
    expectedRoot: string,
    rootIdentity: WorkspaceRootIdentity,
  ): Promise<MutationResult> {
    const identity = WorkspaceRootIdentitySchema.safeParse(rootIdentity);
    if (!identity.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const workspace = this.current.computer.workspaces.find(
        (item) => item.workspaceId === workspaceId,
      );
      if (!workspace) return this.failure("WORKSPACE_NOT_FOUND");
      if (
        this.current.revision !== expectedRevision ||
        workspace.root !== expectedRoot ||
        workspace.rootIdentity
      )
        return this.failure("WORKSPACE_ROOT_CHANGED");
      return this.commitComputerEvidence((settings) => ({
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          workspaces: settings.computer.workspaces.map((item) =>
            item.workspaceId === workspaceId
              ? {
                  ...item,
                  rootIdentity: { ...identity.data },
                  accessCheck: null,
                }
              : item,
          ),
        },
      }));
    });
  }

  async recordComputerVerification(
    workspaceId: string,
    input: unknown,
    observed: Readonly<{
      rootIdentity: WorkspaceRootIdentity;
      gitMetadata?: WorkspaceGitMetadata | null;
      expectedGeneration?: number;
      expectedRoot?: string;
    }>,
  ): Promise<MutationResult> {
    const parsed = verificationInputSchema.safeParse(input);
    const identity = WorkspaceRootIdentitySchema.safeParse(
      observed.rootIdentity,
    );
    const gitMetadata = WorkspaceGitMetadataSchema.nullable()
      .optional()
      .safeParse(observed.gitMetadata);
    if (!parsed.success || !identity.success || !gitMetadata.success) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    // The comparison with the bound identity and the commit share one turn, so
    // no other change to this workspace can land between them.
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const verified = this.current.computer.workspaces.find(
        (workspace) => workspace.workspaceId === workspaceId,
      );
      if (!verified) return this.failure("WORKSPACE_NOT_FOUND");
      if (
        (observed.expectedGeneration !== undefined &&
          this.current.computer.generation !== observed.expectedGeneration) ||
        (observed.expectedRoot !== undefined &&
          verified.root !== observed.expectedRoot)
      )
        return this.failure("WORKSPACE_ROOT_CHANGED");
      const bound = verified.rootIdentity;
      if (
        bound &&
        (bound.device !== identity.data.device ||
          bound.inode !== identity.data.inode)
      ) {
        return this.failure("WORKSPACE_ROOT_CHANGED");
      }
      const rootIdentity = identity.data;
      const bind = (
        workspace: ProductSettings["computer"]["workspaces"][number],
      ) => {
        if (workspace.workspaceId !== workspaceId) return workspace;
        const { gitMetadata: _previous, ...rest } = workspace;
        // A primary checkout's first measurement records the in-root layout
        // covered by its explicit full-Git grant. Linked/outside layouts and
        // changes to a previous binding still require renewed approval.
        const initialApprovedPrimary =
          workspace.gitHistoryApproved === true &&
          workspace.gitMetadata === undefined &&
          gitMetadata.data?.gitDirectory ===
            path.join(workspace.root, ".git") &&
          gitMetadata.data?.commonDirectory ===
            path.join(workspace.root, ".git");
        const metadataChanged =
          gitMetadata.data !== undefined &&
          (gitMetadata.data?.gitDirectory !==
            workspace.gitMetadata?.gitDirectory ||
            gitMetadata.data?.commonDirectory !==
              workspace.gitMetadata?.commonDirectory);
        return {
          ...(gitMetadata.data === undefined ? workspace : rest),
          rootIdentity,
          ...(metadataChanged && !initialApprovedPrimary
            ? { gitHistoryApproved: false }
            : {}),
          accessCheck: {
            buildId: parsed.data.buildId,
            computerGeneration: this.current!.computer.generation,
            verifiedAt: this.now(),
            rootIdentity,
          },
          ...(gitMetadata.data ? { gitMetadata: gitMetadata.data } : {}),
        };
      };
      return this.commitComputerEvidence((settings) => ({
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          workspaces: settings.computer.workspaces.map(bind),
        },
        setup: {
          ...settings.setup,
          computer: {
            ...settings.setup.computer,
            configured: true,
            reachable: "reachable",
            verified: {
              ...parsed.data,
              configRevision: settings.computer.generation,
              workspaceId,
              verifiedAt: this.now(),
            },
            needsAction: null,
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      }));
    });
  }

  // Recorded before a guarded edit executes and cleared only after delivery;
  // neither step changes Computer authority or its verification.
  //
  // S35-N03c: a promotion's drain check decides "nothing owed" from a
  // snapshot it never rechecks before placement (see
  // `tooling/promotion-obligations.mjs`'s two-read comment and
  // `promote-preview.mjs`'s F3-4 note). Recording this edit is the exact
  // moment that decision could already be stale: the write below is what
  // first makes `EDIT_DELIVERY_PENDING` observable on disk, and the bytes it
  // guards are what a promotion could otherwise copy mid-write. When a
  // `promotionLease` dependency is configured, this call therefore takes the
  // SAME cross-process lease a promotion holds from before its drain check
  // through placement, in the "admission" role — exactly the role
  // `LiveTaskRegistry.admitDurable` takes for a new task (see
  // `live-task-registry.ts`). The hold is kept, keyed by operation ID, until
  // `releaseWorkspaceEditLease` is called once the edit's outcome is
  // recorded — never widened to cover the delivery acknowledgement a person
  // gives later, which would block promotion indefinitely.
  recordPendingWorkspaceEdit(
    pending: PendingWorkspaceEditDelivery,
  ): Promise<MutationResult> {
    return this.exclusive(() => this.recordPendingEdit(pending));
  }

  clearPendingWorkspaceEdit(operationId: string): Promise<MutationResult> {
    return this.exclusive(() => this.clearPendingEdit(operationId));
  }

  recordComputerMutationOutcomeUnknown(
    workspaceId: string,
  ): Promise<MutationResult> {
    return this.exclusive(() => this.recordMutationOutcomeUnknown(workspaceId));
  }

  // Releases the lease `recordPendingEdit` acquired for `operationId`, once
  // (and only once) that edit's outcome is durably recorded — see
  // `withSettingsEditLease` in `apps/desktop/with-settings-edit-lease.ts`, which calls this from its
  // own `finally`. Idempotent: a second call, or a call for an operation
  // that never held a lease (no `promotionLease` dependency, or the record
  // itself was refused), is a no-op, exactly like `releasePromotionLease`
  // itself is for a handle it does not recognise.
  async releaseWorkspaceEditLease(operationId: string): Promise<void> {
    const lease = this.pendingEditLeases.get(operationId);
    if (!lease) return;
    this.pendingEditLeases.delete(operationId);
    await lease.release();
  }

  private async recordPendingEdit(
    pending: PendingWorkspaceEditDelivery,
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    const parsed = PendingWorkspaceEditDeliverySchema.safeParse(pending);
    if (
      !parsed.success ||
      !this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === parsed.data.workspaceId,
      )
    ) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    const operationId = parsed.data.operationId;
    const lease = this.promotionLease
      ? await this.promotionLease.acquireForAdmission()
      : null;
    if (this.promotionLease && !lease) {
      // A live promotion already holds the lease: refuse with a readable
      // code of our own rather than racing its placement, exactly as a live
      // promotion refuses a Chat turn or a native Agent start today.
      return this.failure("WORKSPACE_MUTATION_PROMOTION_PENDING");
    }
    if (lease?.verify && !(await lease.verify())) {
      await lease.release();
      return this.failure("WORKSPACE_MUTATION_PROMOTION_PENDING");
    }
    // S35-H1R: the check above is the entry check, several awaits before
    // anything durable happens. The write that first makes
    // `EDIT_DELIVERY_PENDING` observable is inside `mutate`, so the hold is
    // verified AGAIN immediately before those bytes move; a lease deleted
    // and re-taken in between (two live holders) refuses there instead of
    // being written straight through.
    const verifyHold = lease?.verify?.bind(lease);
    const fence: StoreWriteFence = verifyHold
      ? {
          beforeWrite: async () => {
            if (!(await verifyHold())) throw new WorkspaceEditLeaseLost();
          },
        }
      : {};
    const result = await this.mutate(
      (settings) => ({
        ...settings,
        revision: settings.revision + 1,
        computer: { ...settings.computer, pendingEdit: parsed.data },
      }),
      fence,
    );
    if (!result.ok) {
      // The durable write never landed: nothing for the lease to protect.
      await lease?.release();
      return result;
    }
    if (lease) this.pendingEditLeases.set(operationId, lease);
    return result;
  }

  private async clearPendingEdit(operationId: string): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (this.current.computer.pendingEdit?.operationId !== operationId) {
      return this.failure("WORKSPACE_MUTATION_NOT_PENDING");
    }
    const result = await this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      computer: { ...settings.computer, pendingEdit: null },
    }));
    // Backstop only: `withSettingsEditLease` already releases this edit's lease
    // once its outcome is recorded, well before delivery is acknowledged
    // here. A lease still outstanding at this point (a caller that recorded
    // an edit but never applied it) must not survive its own acknowledgement
    // — `releaseWorkspaceEditLease` is a no-op when there is nothing to do.
    await this.releaseWorkspaceEditLease(operationId);
    return result;
  }

  private async recordMutationOutcomeUnknown(
    workspaceId: string,
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (
      !this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === workspaceId,
      )
    ) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          configured: true,
          reachable: "unknown",
          verified: null,
          needsAction:
            "Inspect the selected file, then verify workspace access again.",
          unavailable: null,
          outcomeUnknown: true,
        },
      },
    }));
  }

  async recordChatGptObservation(input: unknown): Promise<MutationResult> {
    const parsed = chatGptObservationSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => {
      const revision = settings.revision + 1;
      const common = {
        ...settings.setup.chatgpt,
        visited: true,
        skipped: false,
        outcomeUnknown: false,
      };
      let chatgpt: ProductSettings["setup"]["chatgpt"];
      switch (parsed.data.state) {
        case "authenticated":
          chatgpt = {
            ...common,
            configured: true,
            reachable: "reachable",
            verified: {
              profile: parsed.data.profile,
              configRevision: 1,
              workspaceId: null,
              runtimeGeneration: parsed.data.runtimeGeneration,
              buildId: parsed.data.buildId,
              protocol: parsed.data.protocol,
              verifiedAt: this.now(),
            },
            needsAction: null,
            unavailable: null,
          };
          break;
        case "signed_out":
          chatgpt = {
            ...common,
            configured: false,
            reachable: "reachable",
            verified: null,
            needsAction: "Sign in to ChatGPT in the isolated Next window.",
            unavailable: null,
          };
          break;
        case "unreachable":
          chatgpt = {
            ...common,
            configured: false,
            reachable: "unreachable",
            verified: null,
            needsAction:
              "Open the isolated ChatGPT window and check network access.",
            unavailable: null,
          };
          break;
        case "unsupported":
          chatgpt = {
            ...common,
            configured: false,
            reachable: "reachable",
            verified: null,
            needsAction: null,
            unavailable:
              "The ChatGPT page loaded, but this build could not verify its composer.",
          };
          break;
        case "outcome_unknown":
          chatgpt = {
            ...common,
            configured: true,
            reachable: "unknown",
            verified: null,
            needsAction:
              "Inspect the isolated ChatGPT window before starting another task.",
            unavailable: null,
            outcomeUnknown: true,
          };
          break;
      }
      return {
        ...settings,
        revision,
        setup: { ...settings.setup, chatgpt },
      };
    });
  }

  async recordCodexHost(input: unknown): Promise<MutationResult> {
    const parsed = codexHostInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutateCodexHost((settings) => {
      const previous = settings.nativeHosts.codex;
      const sameContract =
        previous?.executablePath === parsed.data.executablePath &&
        previous.executableSha256 === parsed.data.executableSha256 &&
        previous.version === parsed.data.version &&
        previous.protocol === parsed.data.protocol &&
        previous.schemaSha256 === parsed.data.schemaSha256;
      const sameTaskSource =
        JSON.stringify(previous?.taskSource?.evidence ?? null) ===
          JSON.stringify(parsed.data.taskSource) &&
        (previous?.taskSource == null ||
          previous.taskSource.localVerification.buildId ===
            parsed.data.buildId);
      const withdrawRoute =
        settings.nativeHosts.taskRoute !== null &&
        parsed.data.taskSource?.handoff.status !== "supported";
      const generation =
        sameContract && sameTaskSource && !withdrawRoute
          ? settings.nativeHosts.generation
          : settings.nativeHosts.generation + 1;
      const verifiedAt = this.now();
      const localVerification = {
        executableSha256: parsed.data.executableSha256,
        schemaSha256: parsed.data.schemaSha256,
        buildId: parsed.data.buildId,
        verifiedAt,
      };
      const taskSource =
        parsed.data.taskSource === null
          ? null
          : {
              hostGeneration: generation,
              localVerification,
              evidence: parsed.data.taskSource,
            };
      const liveVerification =
        sameContract &&
        previous.liveVerification?.buildId === parsed.data.buildId
          ? previous.liveVerification
          : null;
      const agentVerification =
        sameContract &&
        previous.agentVerification?.buildId === parsed.data.buildId
          ? previous.agentVerification
          : null;
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: {
          generation,
          taskRoute:
            sameContract &&
            sameTaskSource &&
            parsed.data.taskSource?.handoff.status === "supported"
              ? settings.nativeHosts.taskRoute
              : null,
          codex: {
            executablePath: parsed.data.executablePath,
            executableSha256: parsed.data.executableSha256,
            version: parsed.data.version,
            protocol: parsed.data.protocol,
            schemaSha256: parsed.data.schemaSha256,
            verifiedAt,
            localVerification,
            taskSource,
            liveVerification,
            agentVerification,
          },
        },
        setup: {
          ...settings.setup,
          hosts: {
            ...settings.setup.hosts,
            visited: true,
            skipped: false,
            configured: true,
            reachable: "reachable",
            verified: liveVerification
              ? {
                  profile: "codex.app-server.live/1",
                  configRevision: generation,
                  workspaceId: null,
                  runtimeGeneration: parsed.data.executableSha256,
                  buildId: liveVerification.buildId,
                  protocol: parsed.data.protocol,
                  verifiedAt: liveVerification.verifiedAt,
                }
              : null,
            needsAction: liveVerification
              ? null
              : "Run the live Codex host check.",
            unavailable: null,
            outcomeUnknown: false,
          },
          verify: agentVerification
            ? settings.setup.verify
            : pendingAgentReadiness(
                settings.setup.verify,
                liveVerification
                  ? "Run the native Agent lineage check."
                  : "Run the live Codex host check first.",
                liveVerification !== null,
              ),
        },
      };
    });
  }

  async recordCodexTaskRoute(input: unknown): Promise<MutationResult> {
    const parsed = CodexTaskSelectionSchema.safeParse(input);
    if (!parsed.success) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    const selected = parsed.data;
    return this.mutate((current) => {
      const model = resolveOwnerTaskModel(current, {
        harness: selected.harness,
      });
      if (model.status !== "ready") {
        throw new Error("CODEX_TASK_ROUTE_STALE");
      }
      const workspace = current.computer.workspaces.find(
        (entry) => entry.workspaceId === selected.workspaceId,
      );
      const now = Date.parse(this.now());
      if (
        !current.nativeHosts.codex?.localVerification ||
        selected.hostGeneration !== current.nativeHosts.generation ||
        selected.computerGeneration !== current.computer.generation ||
        current.setup.computer.verified?.workspaceId !== selected.workspaceId ||
        current.setup.computer.verified.configRevision !==
          current.computer.generation ||
        !workspace?.rootIdentity ||
        workspace.gitMetadata?.commonDirectory !==
          selected.gitCommonDirectory ||
        (selected.execution.sandbox === "workspace-write" &&
          workspace.access !== "write") ||
        selected.expiresAt <= now ||
        selected.expiresAt > now + 12 * 60 * 60 * 1_000
      ) {
        throw new Error("CODEX_TASK_ROUTE_STALE");
      }
      return {
        ...current,
        revision: current.revision + 1,
        nativeHosts: { ...current.nativeHosts, taskRoute: selected },
      };
    });
  }

  async clearCodexTaskRoute(): Promise<MutationResult> {
    return this.mutate((settings) =>
      settings.nativeHosts.taskRoute === null
        ? settings
        : {
            ...settings,
            revision: settings.revision + 1,
            nativeHosts: { ...settings.nativeHosts, taskRoute: null },
          },
    );
  }

  async recordCodexHostLiveVerification(
    input: unknown,
  ): Promise<MutationResult> {
    const parsed = codexHostLiveInputSchema.safeParse(input);
    if (!parsed.success || this.current === null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    const selected = this.current.nativeHosts.codex;
    if (
      !selected ||
      selected.executableSha256 !== parsed.data.executableSha256 ||
      selected.schemaSha256 !== parsed.data.schemaSha256
    ) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) => {
      const host = settings.nativeHosts.codex;
      if (!host) return settings;
      const verifiedAt = this.now();
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: {
          ...settings.nativeHosts,
          codex: {
            ...host,
            liveVerification: {
              ...parsed.data,
              dynamicTool: "farol_next_ping",
              verifiedAt,
            },
          },
        },
        setup: {
          ...settings.setup,
          hosts: {
            ...settings.setup.hosts,
            visited: true,
            skipped: false,
            configured: true,
            reachable: "reachable",
            verified: {
              profile: "codex.app-server.live/1",
              configRevision: settings.nativeHosts.generation,
              workspaceId: null,
              runtimeGeneration: parsed.data.executableSha256,
              buildId: parsed.data.buildId,
              protocol: host.protocol,
              verifiedAt,
            },
            needsAction: null,
            unavailable: null,
            outcomeUnknown: false,
          },
          verify: host.agentVerification
            ? settings.setup.verify
            : pendingAgentReadiness(
                settings.setup.verify,
                "Run the native Agent lineage check.",
                true,
              ),
        },
      };
    });
  }

  async recordCodexAgentVerification(input: unknown): Promise<MutationResult> {
    const parsed = CodexAgentVerificationFieldsSchema.safeParse(input);
    if (!parsed.success || this.current === null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    const host = this.current.nativeHosts.codex;
    const liveVerification = host?.liveVerification;
    const workspace = this.current.computer.workspaces.find(
      (candidate) => candidate.workspaceId === parsed.data.workspaceId,
    );
    const computerVerification = this.current.setup.computer.verified;
    if (
      !host ||
      !liveVerification ||
      host.executableSha256 !== parsed.data.executableSha256 ||
      host.schemaSha256 !== parsed.data.schemaSha256 ||
      liveVerification.executableSha256 !== parsed.data.executableSha256 ||
      liveVerification.schemaSha256 !== parsed.data.schemaSha256 ||
      liveVerification.buildId !== parsed.data.buildId ||
      parsed.data.computerGeneration !== this.current.computer.generation ||
      !workspace ||
      computerVerification?.workspaceId !== parsed.data.workspaceId ||
      computerVerification.configRevision !== parsed.data.computerGeneration ||
      computerVerification.buildId !== parsed.data.buildId ||
      this.current.setup.computer.reachable !== "reachable" ||
      this.current.setup.computer.outcomeUnknown
    ) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }

    return this.mutate((settings) => {
      const selected = settings.nativeHosts.codex;
      if (!selected) return settings;
      const verifiedAt = this.now();
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: {
          ...settings.nativeHosts,
          codex: {
            ...selected,
            agentVerification: { ...parsed.data, verifiedAt },
          },
        },
        setup: {
          ...settings.setup,
          verify: {
            ...withoutRecovery(settings.setup.verify),
            visited: true,
            skipped: false,
            configured: true,
            reachable: "reachable",
            verified: {
              profile: "codex.native-agent.lineage/1",
              configRevision: settings.revision + 1,
              workspaceId: parsed.data.workspaceId,
              runtimeGeneration: parsed.data.executableSha256,
              buildId: parsed.data.buildId,
              protocol: parsed.data.transport,
              verifiedAt,
            },
            needsAction: null,
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async recordCodexAgentFailure(input: unknown): Promise<MutationResult> {
    const parsed = codexAgentFailureSchema.safeParse(input);
    if (!parsed.success || this.current?.nativeHosts.codex == null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) => {
      const host = settings.nativeHosts.codex;
      if (!host) return settings;
      const outcomeUnknown = parsed.data === "outcome_unknown";
      const running = parsed.data === "running";
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: {
          ...settings.nativeHosts,
          codex: { ...host, agentVerification: null },
        },
        setup: {
          ...settings.setup,
          verify: {
            ...withoutRecovery(settings.setup.verify),
            ...(running || outcomeUnknown
              ? { recovery: "rejoin_agent" as const }
              : {}),
            visited: true,
            skipped: false,
            configured: host.liveVerification !== null,
            reachable:
              outcomeUnknown ||
              running ||
              parsed.data === "workspace_not_verified"
                ? "unknown"
                : "unreachable",
            verified: null,
            needsAction:
              parsed.data === "workspace_not_verified"
                ? "Verify read access to one workspace first."
                : running
                  ? "Rejoin the same native Agent assignment to collect its result."
                  : outcomeUnknown
                    ? "Inspect and explicitly rejoin the same native Agent assignment before another launch."
                    : "Recheck the native Agent contract before running it again.",
            unavailable: null,
            outcomeUnknown,
          },
        },
      };
    });
  }

  async recordCodexHostLiveFailure(input: unknown): Promise<MutationResult> {
    const parsed = codexHostLiveFailureSchema.safeParse(input);
    if (!parsed.success || this.current?.nativeHosts.codex == null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) => {
      const host = settings.nativeHosts.codex;
      if (!host) return settings;
      const outcomeUnknown = parsed.data === "outcome_unknown";
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: {
          ...settings.nativeHosts,
          codex: {
            ...host,
            liveVerification: null,
            agentVerification: null,
          },
        },
        setup: {
          ...settings.setup,
          hosts: {
            ...settings.setup.hosts,
            visited: true,
            skipped: false,
            configured: true,
            reachable:
              parsed.data === "model_unavailable"
                ? "reachable"
                : outcomeUnknown
                  ? "unknown"
                  : "unreachable",
            verified: null,
            needsAction: outcomeUnknown
              ? "Inspect the Codex host before deliberately running another live check."
              : parsed.data === "failed"
                ? "Recheck the selected Codex executable, then run the live check again."
                : null,
            unavailable:
              parsed.data === "model_unavailable"
                ? "The selected host does not offer gpt-6-astra without provider fallback."
                : null,
            outcomeUnknown,
          },
          verify: pendingAgentReadiness(
            settings.setup.verify,
            outcomeUnknown
              ? "Resolve the live Codex host outcome before checking Agent lineage."
              : "Run the live Codex host check first.",
            false,
          ),
        },
      };
    });
  }

  async recordCodexHostFailure(input: unknown): Promise<MutationResult> {
    const parsed = codexHostFailureSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutateCodexHost((settings) => {
      const selected = settings.nativeHosts.codex;
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: selected
          ? {
              generation: settings.nativeHosts.generation + 1,
              taskRoute: null,
              codex: {
                ...selected,
                localVerification: null,
                liveVerification: null,
                agentVerification: null,
              },
            }
          : settings.nativeHosts,
        setup: {
          ...settings.setup,
          hosts: {
            ...settings.setup.hosts,
            visited: true,
            skipped: false,
            configured: selected !== null,
            reachable:
              parsed.data === "unreachable" ? "unreachable" : "reachable",
            verified: null,
            needsAction:
              parsed.data === "unreachable"
                ? "Choose the Codex executable again or restore it, then recheck."
                : null,
            unavailable:
              parsed.data === "unsupported"
                ? "This Codex build does not expose the required bounded App Server contract."
                : null,
            outcomeUnknown: false,
          },
          verify: pendingAgentReadiness(
            settings.setup.verify,
            "Run the live Codex host check first.",
            false,
          ),
        },
      };
    });
  }

  async clearCodexHost(): Promise<MutationResult> {
    return this.mutateCodexHost((settings) => {
      if (settings.nativeHosts.codex === null) return settings;
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: {
          generation: settings.nativeHosts.generation + 1,
          codex: null,
          taskRoute: null,
        },
        setup: {
          ...settings.setup,
          hosts: {
            ...settings.setup.hosts,
            visited: true,
            skipped: false,
            configured: false,
            reachable: "unknown",
            verified: null,
            needsAction: "Choose a Codex executable to verify.",
            unavailable: null,
            outcomeUnknown: false,
          },
          verify: pendingAgentReadiness(
            settings.setup.verify,
            "Choose and verify a Codex host first.",
            false,
          ),
        },
      };
    });
  }

  async markSetupVisited(step: unknown): Promise<MutationResult> {
    const parsed = SetupStepIdSchema.safeParse(step);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      setup: {
        ...settings.setup,
        [parsed.data]: { ...settings.setup[parsed.data], visited: true },
      },
    }));
  }

  async setSetupJourney(input: unknown): Promise<MutationResult> {
    const parsed = z
      .strictObject({
        currentStep: SetupStepIdSchema,
        dismissed: z.boolean(),
      })
      .safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      setup: {
        ...settings.setup,
        [settings.setup.journey.currentStep]: {
          ...settings.setup[settings.setup.journey.currentStep],
          visited: true,
        },
        journey: parsed.data,
        [parsed.data.currentStep]: {
          ...settings.setup[parsed.data.currentStep],
          visited: true,
        },
      },
    }));
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.turn.getStore()) return work();
    const run = this.tail.then(() => this.turn.run(true, work));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private mutate(
    transform: (settings: ProductSettings) => ProductSettings,
    fence: StoreWriteFence = {},
  ): Promise<MutationResult> {
    return this.exclusive(() => this.commit(transform, fence));
  }

  private fenceTaskSource(settings: ProductSettings): ProductSettings {
    const floor = this.taskSourceWithdrawalGeneration;
    if (floor === null) return settings;
    const host = settings.nativeHosts.codex;
    if (
      !host?.taskSource &&
      settings.nativeHosts.taskRoute === null &&
      settings.nativeHosts.generation >= floor
    )
      return settings;
    return {
      ...settings,
      nativeHosts: {
        ...settings.nativeHosts,
        generation: Math.max(settings.nativeHosts.generation, floor),
        codex: host ? { ...host, taskSource: null } : null,
        taskRoute: null,
      },
    };
  }

  // Keep withdrawal through every recovery readback. Only a trusted host mutation
  // with successful durable readback can release this in-process Task fence.
  private mutateCodexHost(
    transform: (settings: ProductSettings) => ProductSettings,
  ): Promise<MutationResult> {
    return this.exclusive(async () => {
      const result = await this.commit(
        (settings) => {
          const candidate = transform(settings);
          const previous = settings.nativeHosts.codex?.taskSource;
          const next = candidate.nativeHosts.codex?.taskSource;
          const taskChanged =
            (previous != null ||
              next != null ||
              settings.nativeHosts.taskRoute !== null) &&
            (settings.nativeHosts.generation !==
              candidate.nativeHosts.generation ||
              JSON.stringify(previous?.evidence ?? null) !==
                JSON.stringify(next?.evidence ?? null) ||
              previous?.localVerification.buildId !==
                next?.localVerification.buildId ||
              JSON.stringify(settings.nativeHosts.taskRoute) !==
                JSON.stringify(candidate.nativeHosts.taskRoute));
          if (taskChanged)
            this.taskSourceWithdrawalGeneration = Math.max(
              this.taskSourceWithdrawalGeneration ?? 0,
              settings.nativeHosts.generation + 1,
              candidate.nativeHosts.generation,
            );
          return candidate;
        },
        {},
        true,
      );
      if (result.ok) this.taskSourceWithdrawalGeneration = null;
      if (this.current) this.current = this.fenceTaskSource(this.current);
      return { ...result, snapshot: this.snapshot() };
    });
  }

  private commitComputerEvidence(
    transform: (settings: ProductSettings) => ProductSettings,
  ): Promise<MutationResult> {
    return this.commit((settings) =>
      advanceComputerApprovalGeneration(settings, transform(settings)),
    );
  }

  private async commit(
    transform: (settings: ProductSettings) => ProductSettings,
    fence: StoreWriteFence = {},
    freshTaskSource = false,
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    const before = structuredClone(this.fenceTaskSource(this.current));
    let candidate: ProductSettings;
    try {
      const transformed = ProductSettingsSchema.parse(transform(before));
      const connectorInvalidated = invalidateStaleConnectorRuntime(
        invalidateUnboundComputerVerification(transformed),
      );
      const sourceInvalidated = invalidateStaleCodexTaskSource(
        invalidateStaleAgentVerification(connectorInvalidated),
      );
      const invalidated = freshTaskSource
        ? sourceInvalidated
        : this.fenceTaskSource(sourceInvalidated);
      candidate = ProductSettingsSchema.parse(
        invalidated !== transformed && invalidated.revision === before.revision
          ? { ...invalidated, revision: before.revision + 1 }
          : invalidated,
      );
    } catch {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    try {
      // Compare every final policy projection, including indirect verification
      // invalidation. Command-name lists cannot cover all authority changes.
      const changed =
        JSON.stringify(ownerSettingsComputerApproval(before, 0)) !==
          JSON.stringify(ownerSettingsComputerApproval(candidate, 0)) ||
        JSON.stringify(taskSettingsProjection(before)) !==
          JSON.stringify(taskSettingsProjection(candidate));
      let publication: ComputerSettingsPublication | undefined;
      if (changed && this.withdrawComputerAuthority) {
        try {
          publication = await this.withdrawComputerAuthority();
          this.settingsDeliveryWithdrawalHeld = true;
        } catch (error) {
          if (this.settingsDeliveryAttached)
            this.retainSettingsDeliveryAuthorityFailure(error);
          throw error;
        }
      }
      await this.store.save(candidate, fence);
      const readBack = await this.store.load();
      if (
        readBack === null ||
        JSON.stringify(readBack) !== JSON.stringify(candidate)
      ) {
        throw new Error("SETTINGS_READ_BACK_FAILED");
      }
      if (this.settingsDeliveryFenced)
        throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
      if (publication) {
        this.settingsDeliveryWithdrawalHeld = false;
        try {
          await publication.publish(structuredClone(readBack));
        } catch (error) {
          if (this.settingsDeliveryAttached)
            this.retainSettingsDeliveryAuthorityFailure(error);
          throw error;
        }
      }
      if (this.settingsDeliveryFenced)
        throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
      this.current = readBack;
      this.currentError = null;
      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      if (this.settingsDeliveryFenced) {
        this.latchSettingsDeliveryLoss();
        return this.failure("SETTINGS_WRITE_FAILED");
      }
      // The save may have landed before its read-back failed; what the disk
      // holds is the truth, and the snapshot taken before is only a fallback.
      const fallback = (await this.store.load().catch(() => null)) ?? before;
      if (this.settingsDeliveryFenced) {
        this.latchSettingsDeliveryLoss();
        return this.failure("SETTINGS_WRITE_FAILED");
      }
      this.current = this.fenceTaskSource(fallback);
      // A fence refusal is not a write failure: nothing was written at all,
      // and the caller gets the reason rather than a generic disk error.
      if (error instanceof WorkspaceEditLeaseLost) {
        return this.failure("WORKSPACE_MUTATION_PROMOTION_PENDING");
      }
      return this.failure("SETTINGS_WRITE_FAILED");
    }
  }

  private failure(
    error: Extract<MutationResult, { ok: false }>["error"],
  ): MutationResult {
    return { ok: false, error, snapshot: this.snapshot() };
  }
}
