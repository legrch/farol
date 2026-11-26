import { connectorRuntimeUncertain } from "../../pkg/product-settings/connector-uncertainty";
import { ownerComputerConsentDigest } from "../../modules/computer/infra/repo/owner-computer-consent";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { z } from "zod";
import {
  advanceComputerApprovalGeneration,
  defaultSettings,
  invalidateStaleAgentVerification,
  invalidateStaleCodexTaskSource,
  invalidateStaleConnectorRuntime,
  invalidateUnboundComputerVerification,
  pendingConnectorReadiness,
  settingsError,
} from "./settings/rules";
import {
  CodexAgentVerificationFieldsSchema,
  ProductConfigurationSnapshotSchema,
  ProductGeneralSettingsSchema,
  ProductSettingsSchema,
  SecureMcpAppSelectionSchema,
  SetupStepIdSchema,
  WorkspaceGitMetadataSchema,
  WorkspaceRootIdentitySchema,
  WorkspaceAccessCheckIdSchema,
  CodexTaskSelectionSchema,
  type ProductConfigurationSnapshot,
  type ProductSettings,
  type WorkspaceGitMetadata,
  type WorkspaceRootIdentity,
} from "../../pkg/product-settings/contract";
import { credentialStorePolicy } from "../../modules/computer/infra/native/home-secret-stores";
import { ownerSettingsComputerApproval } from "../../modules/computer/infra/repo/owner-settings-computer-approval";
import {
  ContinuityWriteIntentSchema,
  nextContinuitySettings,
  type ContinuityWriteIntent,
  type ContinuityWriteFence,
} from "./workspace-continuity-writer";
import type { TaskSettingsComparator } from "../../../apps/desktop/bridge/task-current-settings";
import type { SettingsStoreScope } from "../../../apps/desktop/settings-store-document";

import type {
  TaskModelPolicyResolution,
  TaskModelPolicyResolver,
} from "../../../apps/desktop/bridge/task-model-policy";
import type { TaskSelectionRequest } from "../../pkg/owner-config/contract";

import {
  workspaceInputSchema,
  verificationInputSchema,
  chatGptObservationSchema,
  codexHostInputSchema,
  codexHostFailureSchema,
  codexHostLiveInputSchema,
  codexHostLiveFailureSchema,
  codexAgentFailureSchema,
  secureMcpTunnelClientInputSchema,
  secureMcpTunnelInputSchema,
  secureMcpRuntimeInputSchema,
  secureMcpAttachmentInputSchema,
  secureMcpChallengeInputSchema,
  type MutationResult,
  WORKSPACE_DRIFT_NEEDS_ACTION,
  workspaceCheckEvidence,
  type ProductSettingsStoreOptions,
  type ConditionalSettingsWrite,
  type OriginalStopSettingsPlan,
  type OriginalStopSettingsAck,
  type OriginalStopSettingsResult,
  type SettingsDeliveryStore,
  type WorkspaceEditLeaseHold,
  type WorkspaceEditLeaseGuard,
  type ComputerSettingsPublication,
  type ProductConfigurationDependencies,
} from "../../../apps/desktop/configuration/input";
import {
  WorkspaceEditLeaseLost,
  createSettingsDelivery,
  type SettingsDelivery,
} from "../../../apps/desktop/configuration/delivery";
import {
  ProductSettingsStore,
  type StoreWriteFence,
} from "../../../apps/desktop/configuration/store";
import {
  driftedWorkspaceRefusal,
  driftedWorkspaceWithdrawn,
  folderAccessCheckRefusal,
  withComputerMutationOutcomeUnknown,
  withDriftedWorkspaceChecksWithdrawn,
  withFolderAccessCheck,
  withoutWorkspace,
  withWorkspace,
  withWorkspaceAccess,
  withWorkspaceExclusions,
  withWorkspaceGitHistory,
  withWorkspaceRootIdentity,
  withWorkspaceRootRebound,
  withWorkspaceVerification,
  workspaceApproved,
  workspaceGitHistoryGrantable,
  workspaceRootBindRefusal,
  workspaceRootRebindRefusal,
  workspaceRootRebindUnchanged,
  workspaceVerificationRefusal,
} from "../../../apps/desktop/configuration/folders";
import {
  lastVerifiedAttachmentCapturable,
  legacyAppPendingSeparable,
  legacyVerificationWithdrawalPending,
  taskSourceWithdrawalFloor,
  withLastVerifiedAttachment,
  withLastVerifiedAttachmentKept,
  withLegacyAppPendingSeparated,
  withLegacyVerificationWithdrawn,
} from "../../../apps/desktop/configuration/legacy";
import {
  computerCommandsUnchanged,
  computerFilePolicyUnchanged,
  withComputerCommands,
  withComputerFilePolicy,
  withComputerRenamed,
} from "../../../apps/desktop/configuration/machine";
import {
  codexAgentVerificationAdmitted,
  codexHostMatchesLiveInput,
  withChatGptObservation,
  withCodexAgentFailure,
  withCodexAgentVerification,
  withCodexHost,
  withCodexHostFailure,
  withCodexHostLiveFailure,
  withCodexHostLiveVerification,
  withCodexTaskRoute,
  withoutCodexHost,
  withoutCodexTaskRoute,
} from "../../../apps/desktop/configuration/native";
import {
  secureMcpAppPendingAdmitted,
  secureMcpAppPendingClearable,
  secureMcpAppSelectionRefusal,
  secureMcpAttachmentAdmitted,
  secureMcpChallengeAdmitted,
  secureMcpCredentialChangeBlocked,
  secureMcpCredentialChangeCompletable,
  secureMcpRuntimeAdmitted,
  withoutSecureMcpAppPending,
  withSecureMcpAppPending,
  withSecureMcpAttachment,
  withSecureMcpChallenge,
  withSecureMcpChatGptApp,
  withSecureMcpCredential,
  withSecureMcpCredentialChangeBegun,
  withSecureMcpCredentialChangeCompleted,
  withSecureMcpRuntime,
  withSecureMcpStopped,
  withSecureMcpTunnel,
  withSecureMcpTunnelClient,
} from "../../../apps/desktop/configuration/tunnel";

export {
  ProductSettingsStore,
  WORKSPACE_DRIFT_NEEDS_ACTION,
  workspaceCheckEvidence,
};
export type {
  ProductSettingsStoreOptions,
  ConditionalSettingsWrite,
  OriginalStopSettingsPlan,
  OriginalStopSettingsAck,
  OriginalStopSettingsResult,
  SettingsDeliveryStore,
  WorkspaceEditLeaseHold,
  WorkspaceEditLeaseGuard,
  ComputerSettingsPublication,
  ProductConfigurationDependencies,
};

// A completion fence refuses before Settings publication.
class SetupIncomplete extends Error {}

export class ProductConfigurationService {
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly homeDirectory: string;
  private current: ProductSettings | null = null;
  private currentError: ProductConfigurationSnapshot | null = null;
  private taskSourceWithdrawalGeneration: number | null = null;
  // One owner change at a time: each runs, with the checks its caller makes
  // against the current settings, through to its commit before the next one
  // clones them. Re-entrant, so a method that checks and then mutates holds
  // one turn, not two.
  private readonly turn = new AsyncLocalStorage<true>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly promotionLease: WorkspaceEditLeaseGuard | undefined;
  private readonly delivery: SettingsDelivery;
  private readonly taskModelPolicy: TaskModelPolicyResolver | undefined;
  private readonly taskSettingsCompare: TaskSettingsComparator | undefined;
  private withdrawComputerAuthority: ProductConfigurationDependencies["withdrawComputerAuthority"];
  // The typed settings writer retains each admission lease through the native
  // edit outcome. The host finally wrapper releases it; conditional pending
  // clearance is a backstop. A restart drops only this in-memory reference;
  // promotion-lease.ts owns recovery of the original on-disk holder.
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
    this.taskModelPolicy = dependencies.taskModelPolicy;
    this.taskSettingsCompare = dependencies.taskSettingsCompare;
    this.withdrawComputerAuthority = dependencies.withdrawComputerAuthority;
    // Every port reads the service late: the settings, the queue and the
    // withdrawal hook (attached after construction) are never captured.
    this.delivery = createSettingsDelivery({
      store,
      settings: {
        current: () => this.current,
        settle: (settings) => {
          this.current = settings;
          this.currentError = null;
        },
        lose: () => {
          this.current = null;
          this.currentError = settingsError(
            new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN"),
          );
        },
      },
      exclusive: (work) => this.exclusive(work),
      authority: {
        withdrawal: () => this.withdrawComputerAuthority?.bind(this),
        changed: (before, candidate, original) =>
          this.computerAuthorityChanged(before, candidate, original),
      },
      leases: {
        guard: this.promotionLease,
        keep: (operationId, lease) =>
          this.pendingEditLeases.set(operationId, lease),
        release: (operationId) => this.releaseWorkspaceEditLease(operationId),
      },
    });
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

  // Trusted composition only; no renderer command, implicit Verify, writer
  // fallback or automatic Go publication. The original Go-owned WAL must
  // already have a CONFIRMED withdrawal ACK and continue to hold both native
  // chains. This service remains the sole Settings writer.
  async commitContinuityFromTransition(
    intent: ContinuityWriteIntent,
    fence: ContinuityWriteFence,
  ): Promise<ConditionalSettingsWrite> {
    return this.exclusive(async () => {
      if (
        !ContinuityWriteIntentSchema.safeParse(intent).success ||
        this.current === null ||
        this.delivery.fenced ||
        connectorRuntimeUncertain(this.current) ||
        typeof fence?.current !== "function" ||
        typeof fence.withdrawalAcknowledged !== "function" ||
        typeof fence.requalifyNative !== "function"
      )
        return { status: "not_written" };
      const original = this.current;
      if (!fence.current() || !fence.withdrawalAcknowledged())
        return { status: "not_written" };
      const next = nextContinuitySettings(original, intent);
      if (!next) return { status: "not_written" };
      try {
        if (
          !(await fence.requalifyNative()) ||
          !fence.current() ||
          !fence.withdrawalAcknowledged() ||
          this.current !== original
        )
          return { status: "not_written" };
        const result = await this.store.saveConditional(original, next, {
          beforeWrite: async () => {
            if (
              !(await fence.requalifyNative()) ||
              !fence.current() ||
              !fence.withdrawalAcknowledged() ||
              this.current !== original ||
              this.delivery.fenced
            )
              throw new Error("CONTINUITY_NATIVE_OR_SETTINGS_CHANGED");
          },
          assertBeforePublication: () => {
            if (
              !fence.current() ||
              !fence.withdrawalAcknowledged() ||
              this.current !== original ||
              this.delivery.fenced
            )
              throw new Error("CONTINUITY_PUBLICATION_FENCED");
          },
        });
        if (result.status === "unknown") {
          this.delivery.latchLoss();
          return { status: "unknown" };
        }
        if (result.status === "not_written") return result;
        // This ACK certifies only Settings CAS/readback. The Go transition
        // remains staged/closed until its own publication/cleanup certificate.
        this.current = result.settings;
        this.currentError = null;
        return result;
      } catch {
        // We cannot prove whether the native requalification, storage or
        // transport rejected before the rename. Retain a conservative fence;
        // never infer success by loading the currently visible file.
        this.delivery.latchLoss();
        return { status: "unknown" };
      }
    });
  }

  // Exactly one trusted host binding, using the existing document and writer.
  // This is not a renderer API and does not activate the Go delivery service.
  attachSettingsDeliveryStore(
    scope: SettingsStoreScope,
  ): SettingsDeliveryStore {
    return this.delivery.attach(scope);
  }

  async initialize(): Promise<void> {
    if (this.delivery.fenced) return;
    try {
      let loaded = await this.store.load();
      if (loaded === null) {
        await this.store.save(defaultSettings(this.id));
        loaded = await this.store.load();
      }
      if (loaded === null) throw new Error("SETTINGS_READ_BACK_FAILED");
      if (this.delivery.fenced) return;
      this.current = this.fenceTaskSource(loaded);
      this.currentError = null;
    } catch (error) {
      this.current = null;
      this.currentError = settingsError(error);
      return;
    }
    // Older builds used the same flag for an external Send and a credential
    // write; only the exact pending-app record can be separated.
    if (legacyAppPendingSeparable(this.current)) {
      const migrated = await this.mutate(withLegacyAppPendingSeparated);
      if (!migrated.ok) return;
    }
    // Settings saved before folder identities existed may still name a
    // verified workspace without one; withdraw that verification before any
    // consumer reads it, and persist the withdrawal like any other change.
    if (legacyVerificationWithdrawalPending(this.current)) {
      const withdrawn = await this.mutate((settings) => ({
        ...settings,
        revision: settings.revision + 1,
      }));
      if (!withdrawn.ok) {
        const invalidated = withLegacyVerificationWithdrawn(this.current);
        this.taskSourceWithdrawalGeneration = taskSourceWithdrawalFloor(
          this.current,
          invalidated,
          this.taskSourceWithdrawalGeneration,
        );
        this.current = this.fenceTaskSource(invalidated);
      }
    }
    // Older Dev profiles stored only the live attachment. Capture a valid
    // saved proof before a later runtime restart clears that live field.
    const attachment = lastVerifiedAttachmentCapturable(this.current);
    if (attachment !== null) {
      await this.mutate((settings) =>
        withLastVerifiedAttachment(settings, attachment),
      );
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
    return this.mutateConnector((settings) =>
      withSecureMcpTunnelClient(settings, parsed.data, () => this.now()),
    );
  }

  async configureSecureMcpTunnel(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpTunnelInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutateConnector((settings) =>
      withSecureMcpTunnel(settings, parsed.data),
    );
  }

  // The credential file is a separate durable writer. Fence connector use
  // before its replacement begins, so a crash or failed post-rename sync
  // cannot leave an old Settings admission pointing at new secret bytes.
  async beginSecureMcpCredentialChange(): Promise<MutationResult> {
    return this.exclusive(() => {
      const current = this.current;
      if (!current)
        return Promise.resolve(this.failure("SETTINGS_UNAVAILABLE"));
      if (secureMcpCredentialChangeBlocked(current))
        return Promise.resolve(
          this.failure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"),
        );
      return this.commit(withSecureMcpCredentialChangeBegun);
    });
  }

  // Only the host that has completed the exact credential write may clear
  // this pending fence. An unrelated Settings mutation cannot settle it.
  async completeSecureMcpCredentialChange(
    input: unknown,
    expectedGeneration: number,
  ): Promise<MutationResult> {
    const parsed = secureMcpTunnelInputSchema.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(expectedGeneration))
      return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(() => {
      const current = this.current;
      if (
        !current ||
        !secureMcpCredentialChangeCompletable(current, expectedGeneration)
      )
        return Promise.resolve(
          this.failure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"),
        );
      return this.commit(
        (settings) =>
          withSecureMcpCredentialChangeCompleted(settings, parsed.data),
        {},
        false,
        true,
      );
    });
  }

  async selectSecureMcpChatGptApp(input: unknown): Promise<MutationResult> {
    const parsed = SecureMcpAppSelectionSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const connector = this.current.connectors.secureMcp;
      const refusal = secureMcpAppSelectionRefusal(this.current, parsed.data);
      if (refusal !== null) return this.failure(refusal);
      return this.commit((settings) =>
        withSecureMcpChatGptApp(settings, parsed.data, connector),
      );
    });
  }

  async recordSecureMcpCredential(
    credential: unknown,
  ): Promise<MutationResult> {
    const parsed = z.enum(["missing", "stored"]).safeParse(credential);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutateConnector((settings) =>
      withSecureMcpCredential(settings, parsed.data),
    );
  }

  async recordSecureMcpRuntime(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpRuntimeInputSchema.safeParse(input);
    if (!parsed.success || this.current === null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    if (!secureMcpRuntimeAdmitted(this.current, parsed.data)) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) =>
      withSecureMcpRuntime(settings, parsed.data, () => this.now()),
    );
  }

  async recordSecureMcpChallenge(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpChallengeInputSchema.safeParse(input);
    if (!parsed.success || this.current === null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    if (!secureMcpChallengeAdmitted(this.current, parsed.data)) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) =>
      withSecureMcpChallenge(settings, parsed.data, () => this.now()),
    );
  }

  async recordSecureMcpAttachment(input: unknown): Promise<MutationResult> {
    const parsed = secureMcpAttachmentInputSchema.safeParse(input);
    if (!parsed.success || this.current === null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    if (!secureMcpAttachmentAdmitted(this.current, parsed.data)) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    // The exact challenge, runtime, Computer and workspace were validated
    // above. This is a proven app-pending settlement, not generic dismissal.
    return this.mutate(
      (settings) =>
        withSecureMcpAttachment(settings, parsed.data, () => this.now()),
      {},
      true,
    );
  }

  // Sole-writer, one-shot stopped publication for the ORIGINAL durable C7
  // operation. The callback must confirm Go settings_intent before ANY save.
  // A lost intent reply or post-rename readback is never recovered by matching
  // bytes, the generic commit fallback, or another Settings save.
  async commitOriginalStoppedSettings(
    selection: Readonly<{
      effectId: string;
      expectedRevision: number;
      expectedDigest: string;
      computerGeneration: number;
      connectorGeneration: number;
      consentDigest: string;
    }>,
    admitIntent: (plan: OriginalStopSettingsPlan) => Promise<void>,
    current: () => boolean,
  ): Promise<OriginalStopSettingsResult> {
    return this.exclusive(async () => {
      const original = this.current;
      if (
        original === null ||
        this.delivery.fenced ||
        connectorRuntimeUncertain(original) ||
        typeof admitIntent !== "function" ||
        typeof current !== "function" ||
        !current() ||
        !Number.isSafeInteger(selection.expectedRevision) ||
        original.revision !== selection.expectedRevision ||
        original.computer.generation !== selection.computerGeneration ||
        original.connectors.secureMcp.generation !==
          selection.connectorGeneration ||
        !/^[a-f0-9]{64}$/u.test(selection.expectedDigest) ||
        !/^[a-f0-9]{64}$/u.test(selection.consentDigest) ||
        JSON.stringify(original) === ""
      )
        return { status: "not_written" };
      const documentDigest = (settings: ProductSettings) =>
        createHash("sha256").update(JSON.stringify(settings)).digest("hex");
      if (
        documentDigest(original) !== selection.expectedDigest ||
        ownerComputerConsentDigest(original) !== selection.consentDigest
      )
        return { status: "not_written" };
      const before = structuredClone(original);
      const connector = before.connectors.secureMcp;
      if (
        connector.runtime === null &&
        connector.challenge === null &&
        connector.attachment === null
      )
        return { status: "not_written" };
      const stopped = {
        ...connector,
        runtime: null,
        challenge: null,
        attachment: null,
      };
      let candidate: ProductSettings;
      try {
        candidate = ProductSettingsSchema.parse({
          ...before,
          revision: before.revision + 1,
          connectors: { ...before.connectors, secureMcp: stopped },
          setup: {
            ...before.setup,
            connect: {
              ...pendingConnectorReadiness(
                before.setup.connect,
                stopped,
                undefined,
              ),
              unavailable: null,
            },
          },
        });
      } catch {
        return { status: "not_written" };
      }
      // Stopping the runtime may invalidate verification evidence but must
      // never widen, narrow, or relabel the original owner-authorized limits.
      if (ownerComputerConsentDigest(candidate) !== selection.consentDigest)
        return { status: "not_written" };
      const plan: OriginalStopSettingsPlan = {
        effectId: selection.effectId,
        expectedRevision: String(original.revision),
        expectedDigest: selection.expectedDigest,
        nextRevision: String(candidate.revision),
        nextDigest: documentDigest(candidate),
        computerGeneration: String(selection.computerGeneration),
        connectorGeneration: String(selection.connectorGeneration),
        consentDigest: selection.consentDigest,
      };
      // Admission is a protected Go RPC. If its original response is lost, no
      // Settings write is dispatched. There is no new operation or retry.
      try {
        if (!current() || this.current !== original)
          return { status: "not_written" };
        await admitIntent(plan);
      } catch {
        return { status: "unknown" };
      }
      let result: ConditionalSettingsWrite;
      try {
        result = await this.store.saveConditional(original, candidate, {
          beforeWrite: async () => {
            if (!current() || this.current !== original || this.delivery.fenced)
              throw new Error("ORIGINAL_STOP_SETTINGS_CHANGED");
          },
          assertBeforePublication: () => {
            if (!current() || this.current !== original || this.delivery.fenced)
              throw new Error("ORIGINAL_STOP_SETTINGS_FENCED");
          },
        });
      } catch {
        this.delivery.latchLoss();
        return { status: "unknown" };
      }
      if (result.status === "unknown") {
        this.delivery.latchLoss();
        return { status: "unknown" };
      }
      if (result.status === "not_written") return result;
      if (
        !current() ||
        this.current !== original ||
        documentDigest(result.settings) !== plan.nextDigest ||
        ownerComputerConsentDigest(result.settings) !==
          selection.consentDigest ||
        result.settings.revision !== candidate.revision
      ) {
        this.delivery.latchLoss();
        return { status: "unknown" };
      }
      this.current = result.settings;
      this.currentError = null;
      return {
        status: "committed",
        settings: result.settings,
        receipt: {
          effectId: plan.effectId,
          revision: plan.nextRevision,
          documentDigest: plan.nextDigest,
          computerGeneration: plan.computerGeneration,
          connectorGeneration: plan.connectorGeneration,
          consentDigest: plan.consentDigest,
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
    expectedRevision?: number,
  ): Promise<MutationResult> {
    return this.exclusive(() => {
      // A stopped publication must not absorb a command queued ahead of it.
      // Check inside the same writer turn, before its original mutation.
      if (
        expectedRevision !== undefined &&
        this.current?.revision !== expectedRevision
      )
        return Promise.resolve(this.failure("AUTHORITY_CHANGE_IN_PROGRESS"));
      return this.mutateConnector((settings) =>
        withSecureMcpStopped(settings, resumeRefusal, purpose, () =>
          this.now(),
        ),
      );
    });
  }

  async addReadonlyWorkspace(input: unknown): Promise<MutationResult> {
    return this.addWorkspace(input, "read");
  }

  async addWorkspace(
    input: unknown,
    access: "read" | "write",
  ): Promise<MutationResult> {
    if (access !== "read" && access !== "write")
      return this.failure("SETTINGS_INPUT_INVALID");
    const parsed = workspaceInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    if (
      credentialStorePolicy(parsed.data.root, this.homeDirectory).kind ===
      "inside-store"
    ) {
      return this.failure("WORKSPACE_SELECTION_PROTECTED");
    }
    return this.mutate((settings) =>
      withWorkspace(settings, parsed.data, access, () => this.id()),
    );
  }

  async renameComputer(input: unknown): Promise<MutationResult> {
    const parsed = z.string().trim().min(1).max(80).safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) =>
      withComputerRenamed(settings, parsed.data),
    );
  }

  async removeWorkspace(workspaceId: string): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (!workspaceApproved(this.current, workspaceId)) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate((settings) => withoutWorkspace(settings, workspaceId));
  }

  async updateWorkspaceExclusions(
    workspaceId: string,
    input: unknown,
  ): Promise<MutationResult> {
    const parsed = z.array(z.string()).max(32).safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (!workspaceApproved(this.current, workspaceId)) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate((settings) =>
      withWorkspaceExclusions(settings, workspaceId, parsed.data),
    );
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
    return this.mutate((settings) =>
      withWorkspaceAccess(settings, workspaceId, access),
    );
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
    if (approved && !workspaceGitHistoryGrantable(this.current, workspaceId))
      return this.failure("SETTINGS_INPUT_INVALID");
    if (current.gitHistoryApproved === approved) {
      return { ok: true, snapshot: this.snapshot() };
    }
    return this.mutate((settings) =>
      withWorkspaceGitHistory(settings, workspaceId, approved),
    );
  }

  async updateComputerCommands(input: unknown): Promise<MutationResult> {
    const parsed = z
      .enum(["none", "verification", "workspace"])
      .safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (computerCommandsUnchanged(this.current, parsed.data)) {
      return { ok: true, snapshot: this.snapshot() };
    }
    return this.mutate((settings) =>
      withComputerCommands(settings, parsed.data),
    );
  }

  // A distinct owner choice through the same serialized settings publication.
  // Existing profiles, restrictions and in-flight receipts are never rewritten.
  async updateComputerFilePolicy(input: unknown): Promise<MutationResult> {
    const parsed = z.enum(["", "approved-roots-v1"]).safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      if (computerFilePolicyUnchanged(this.current, parsed.data)) {
        return { ok: true, snapshot: this.snapshot() };
      }
      return this.commit((settings) =>
        withComputerFilePolicy(settings, parsed.data),
      );
    });
  }

  // Persist uncertainty before the app verification is dispatched. A lost
  // renderer reply or restart must not turn that attempt into a retry button.
  async recordSecureMcpAppPending(
    runtimeGeneration: string,
  ): Promise<MutationResult> {
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      if (!secureMcpAppPendingAdmitted(this.current, runtimeGeneration))
        return this.failure("SETTINGS_INPUT_INVALID");
      return this.commit(withSecureMcpAppPending);
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
      workspaceId: string | null;
    }>,
  ): Promise<MutationResult> {
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      if (!secureMcpAppPendingClearable(this.current, expected))
        return this.failure("SETTINGS_INPUT_INVALID");
      // The exact original binding and positive before-submit result were
      // checked above; only this pending app attempt may be cleared.
      return this.commit(withoutSecureMcpAppPending, {}, false, true);
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
    issuedCheckId?: string,
    writableByOthers?: true,
  ): Promise<MutationResult> {
    const checkId =
      WorkspaceAccessCheckIdSchema.optional().safeParse(issuedCheckId);
    if (
      !checkId.success ||
      !/^[a-f0-9]{64}$/u.test(buildId) ||
      !WorkspaceRootIdentitySchema.safeParse(rootIdentity).success
    )
      return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const refusal = folderAccessCheckRefusal(
        this.current,
        workspaceId,
        expectedGeneration,
      );
      if (refusal) return this.failure(refusal);
      return this.commitComputerEvidence((settings) =>
        withFolderAccessCheck(
          settings,
          {
            workspaceId,
            expectedGeneration,
            buildId,
            rootIdentity,
            success,
            checkId: checkId.data,
            writableByOthers,
          },
          () => this.now(),
        ),
      );
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
      const refusal = workspaceRootBindRefusal(
        this.current,
        workspaceId,
        expectedRevision,
        expectedRoot,
      );
      if (refusal) return this.failure(refusal);
      return this.commitComputerEvidence((settings) =>
        withWorkspaceRootIdentity(settings, workspaceId, identity.data),
      );
    });
  }

  // Owner Verify after an ordinary remount: same directory inode, new device
  // number. Path and inode must still match the approved folder; a different
  // inode remains WORKSPACE_ROOT_CHANGED and needs a fresh picker.
  async rebindWorkspaceRootIdentity(
    workspaceId: string,
    expectedRevision: number,
    expectedRoot: string,
    rootIdentity: WorkspaceRootIdentity,
  ): Promise<MutationResult> {
    const identity = WorkspaceRootIdentitySchema.safeParse(rootIdentity);
    if (!identity.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const refusal = workspaceRootRebindRefusal(
        this.current,
        workspaceId,
        expectedRevision,
        expectedRoot,
        identity.data,
      );
      if (refusal) return this.failure(refusal);
      if (
        workspaceRootRebindUnchanged(this.current, workspaceId, identity.data)
      )
        return { ok: true, snapshot: this.snapshot() };
      return this.commitComputerEvidence((settings) =>
        withWorkspaceRootRebound(settings, workspaceId, identity.data),
      );
    });
  }

  // A saved folder's directory identity no longer matches its binding (for
  // example macOS renumbered the startup volume at boot, or the folder was
  // replaced). Its last check described the old binding, so withdraw it, and
  // withdraw the saved connector runtime that carried that grant: the sidebar
  // must not claim Connected and nothing may resume or restart with it. This
  // only reduces authority. It never rebinds and keeps the approval and ID.
  // The withdrawal is conditioned on exactly what the caller observed: the
  // folder's stored identity AND its check evidence (`observed`, from
  // workspaceCheckEvidence). An unrelated save cannot discard detected drift,
  // and a newer successful check cannot be erased by an older observation.
  async withdrawDriftedWorkspaceChecks(
    drifted: readonly Readonly<{
      workspaceId: string;
      root: string;
      rootIdentity: WorkspaceRootIdentity;
      observed: string;
    }>[],
    // The caller's admission (Quit) fence, checked again right before the
    // write and its publication, after this call may have waited its turn.
    admissionOpen: () => boolean = () => true,
  ): Promise<MutationResult> {
    if (drifted.length === 0) return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const refusal = driftedWorkspaceRefusal(this.current, drifted);
      if (refusal) return this.failure(refusal);
      if (!admissionOpen()) return this.failure("AUTHORITY_CHANGE_IN_PROGRESS");
      if (driftedWorkspaceWithdrawn(this.current, drifted))
        return { ok: true, snapshot: this.snapshot() };
      const quitFence = () => {
        if (!admissionOpen()) throw new Error("AUTHORITY_CHANGE_IN_PROGRESS");
      };
      return this.commitComputerEvidence(
        (settings) => withDriftedWorkspaceChecksWithdrawn(settings, drifted),
        {
          beforeWrite: async () => quitFence(),
          assertBeforePublication: quitFence,
        },
      );
    });
  }

  // Owner verification is when a workspace's folder is bound: a workspace
  // approved before identities were recorded is bound to the folder this
  // verification observed, and a bound workspace is never rebound to another
  // object. It also approves exactly the linked Git metadata it observed, or
  // clears a grant when the metadata now lives inside the root (null).
  async recordComputerVerification(
    workspaceId: string,
    input: unknown,
    observed: Readonly<{
      rootIdentity: WorkspaceRootIdentity;
      checkId?: string;
      gitMetadata?: WorkspaceGitMetadata | null;
      writableByOthers?: true;
      expectedGeneration?: number;
      expectedRoot?: string;
    }>,
  ): Promise<MutationResult> {
    const parsed = verificationInputSchema.safeParse(input);
    const checkId = WorkspaceAccessCheckIdSchema.optional().safeParse(
      observed.checkId,
    );
    const identity = WorkspaceRootIdentitySchema.safeParse(
      observed.rootIdentity,
    );
    const gitMetadata = WorkspaceGitMetadataSchema.nullable()
      .optional()
      .safeParse(observed.gitMetadata);
    if (
      !parsed.success ||
      !identity.success ||
      !gitMetadata.success ||
      !checkId.success
    ) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    // The comparison with the bound identity and the commit share one turn, so
    // no other change to this workspace can land between them.
    return this.exclusive(async () => {
      if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
      const refusal = workspaceVerificationRefusal(
        this.current,
        workspaceId,
        observed,
      );
      if (refusal) return this.failure(refusal);
      return this.commitComputerEvidence((settings) =>
        withWorkspaceVerification(
          settings,
          workspaceId,
          parsed.data,
          {
            rootIdentity: identity.data,
            checkId: checkId.data,
            gitMetadata: gitMetadata.data,
            writableByOthers: observed.writableByOthers,
          },
          () => this.now(),
        ),
      );
    });
  }

  // Compatibility ACK for historical TS pending records. Go-owned pending
  // delivery is cleared only through its exact receipt and typed storage port.
  clearPendingWorkspaceEdit(operationId: string): Promise<MutationResult> {
    return this.exclusive(() => this.clearPendingEdit(operationId));
  }

  recordComputerMutationOutcomeUnknown(
    workspaceId: string,
  ): Promise<MutationResult> {
    return this.exclusive(() => this.recordMutationOutcomeUnknown(workspaceId));
  }

  // The host's withSettingsEditLease finally releases the typed writer's hold
  // after the effect outcome. Repeated release, or no original hold, is a no-op.
  async releaseWorkspaceEditLease(operationId: string): Promise<void> {
    const lease = this.pendingEditLeases.get(operationId);
    if (!lease) return;
    this.pendingEditLeases.delete(operationId);
    await lease.release();
  }

  private async clearPendingEdit(operationId: string): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    const pending = this.current.computer.pendingEdit;
    if (pending?.operationId !== operationId || "backend" in pending) {
      return this.failure("WORKSPACE_MUTATION_NOT_PENDING");
    }
    const result = await this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      computer: { ...settings.computer, pendingEdit: null },
    }));
    // Compatibility backstop; normal Go clearing uses the typed storage port.
    // An absent or already released hold remains a no-op.
    await this.releaseWorkspaceEditLease(operationId);
    return result;
  }

  private async recordMutationOutcomeUnknown(
    workspaceId: string,
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (!workspaceApproved(this.current, workspaceId)) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate(withComputerMutationOutcomeUnknown);
  }

  async recordChatGptObservation(
    input: unknown,
    preserveOutcomeUnknown = false,
  ): Promise<MutationResult> {
    const parsed = chatGptObservationSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) =>
      withChatGptObservation(
        settings,
        parsed.data,
        () => this.now(),
        preserveOutcomeUnknown,
      ),
    );
  }

  async recordCodexHost(input: unknown): Promise<MutationResult> {
    const parsed = codexHostInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutateCodexHost((settings) =>
      withCodexHost(settings, parsed.data, () => this.now()),
    );
  }

  // Keep the existing settings writer's turn across this pure Go decision.
  // No adapter recomputes policy when Go is absent or a reply is lost/stale.
  resolveTaskModel(
    request: TaskSelectionRequest,
  ): Promise<TaskModelPolicyResolution> {
    const captured = structuredClone(request);
    return this.exclusive(async () => {
      const current = this.current;
      if (!current || !this.taskModelPolicy || this.delivery.fenced)
        return { status: "unavailable" };
      try {
        const result = await this.taskModelPolicy(
          current.revision,
          structuredClone(current.tasks ?? null),
          captured,
        );
        if (this.current !== current || this.delivery.fenced)
          return { status: "unavailable" };
        return result;
      } catch {
        return { status: "unavailable" };
      }
    });
  }

  async recordCodexTaskRoute(
    input: unknown,
    expectedRevision?: number,
  ): Promise<MutationResult> {
    const parsed = CodexTaskSelectionSchema.safeParse(input);
    if (!parsed.success) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    const selected = parsed.data;
    const revision = expectedRevision ?? this.current?.revision;
    return this.exclusive(async () => {
      if (!this.current) return this.failure("SETTINGS_UNAVAILABLE");
      if (this.current.revision !== revision)
        return this.failure("SETTINGS_INPUT_INVALID");
      const model = await this.resolveTaskModel({
        harness: selected.harness,
      });
      if (model.status !== "ready")
        return this.failure("SETTINGS_INPUT_INVALID");
      return this.mutate((current) =>
        withCodexTaskRoute(current, selected, revision, () => this.now()),
      );
    });
  }

  async clearCodexTaskRoute(): Promise<MutationResult> {
    return this.mutate(withoutCodexTaskRoute);
  }

  async recordCodexHostLiveVerification(
    input: unknown,
  ): Promise<MutationResult> {
    const parsed = codexHostLiveInputSchema.safeParse(input);
    if (
      !parsed.success ||
      this.current === null ||
      !codexHostMatchesLiveInput(this.current, parsed.data)
    ) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) =>
      withCodexHostLiveVerification(settings, parsed.data, () => this.now()),
    );
  }

  async recordCodexAgentVerification(input: unknown): Promise<MutationResult> {
    const parsed = CodexAgentVerificationFieldsSchema.safeParse(input);
    if (
      !parsed.success ||
      this.current === null ||
      !codexAgentVerificationAdmitted(this.current, parsed.data)
    ) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) =>
      withCodexAgentVerification(settings, parsed.data, () => this.now()),
    );
  }

  async recordCodexAgentFailure(input: unknown): Promise<MutationResult> {
    const parsed = codexAgentFailureSchema.safeParse(input);
    if (!parsed.success || this.current?.nativeHosts.codex == null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) =>
      withCodexAgentFailure(settings, parsed.data),
    );
  }

  async recordCodexHostLiveFailure(input: unknown): Promise<MutationResult> {
    const parsed = codexHostLiveFailureSchema.safeParse(input);
    if (!parsed.success || this.current?.nativeHosts.codex == null) {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    return this.mutate((settings) =>
      withCodexHostLiveFailure(settings, parsed.data),
    );
  }

  async recordCodexHostFailure(input: unknown): Promise<MutationResult> {
    const parsed = codexHostFailureSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutateCodexHost((settings) =>
      withCodexHostFailure(settings, parsed.data),
    );
  }

  async clearCodexHost(): Promise<MutationResult> {
    return this.mutateCodexHost(withoutCodexHost);
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

  async setSetupJourney(
    input: unknown,
    // Trusted main-process predicate only; never taken from the IPC payload.
    isComplete?: (settings: ProductSettings) => boolean,
  ): Promise<MutationResult> {
    const parsed = z
      .strictObject({
        currentStep: SetupStepIdSchema,
        dismissed: z.boolean(),
      })
      .safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.exclusive(async () => {
      const complete = () => {
        try {
          return this.current !== null && isComplete?.(this.current) === true;
        } catch {
          return false;
        }
      };
      // Finish is a durable presentation fact. Reviewing a step or losing live
      // receipts must not revoke it; only a FIRST Finish needs current proof.
      const completing =
        parsed.data.dismissed && this.current?.setup.journey.dismissed !== true;
      if (completing && !complete()) return this.failure("SETUP_INCOMPLETE");
      return this.mutate(
        (settings) => ({
          ...settings,
          revision: settings.revision + 1,
          setup: {
            ...settings.setup,
            [settings.setup.journey.currentStep]: {
              ...settings.setup[settings.setup.journey.currentStep],
              visited: true,
            },
            journey: {
              ...parsed.data,
              dismissed:
                settings.setup.journey.dismissed || parsed.data.dismissed,
            },
            [parsed.data.currentStep]: {
              ...settings.setup[parsed.data.currentStep],
              visited: true,
            },
          },
        }),
        {
          assertBeforePublication: () => {
            if (completing && !complete()) throw new SetupIncomplete();
          },
        },
      );
    });
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
    allowProvenAppPendingResolution = false,
  ): Promise<MutationResult> {
    return this.exclusive(() =>
      this.commit(transform, fence, false, allowProvenAppPendingResolution),
    );
  }

  private mutateConnector(
    transform: (settings: ProductSettings) => ProductSettings,
  ): Promise<MutationResult> {
    return this.exclusive(() => {
      const current = this.current;
      if (current && connectorRuntimeUncertain(current))
        return Promise.resolve(
          this.failure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"),
        );
      return this.commit(transform);
    });
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

  private assertCurrentSettings(expected: ProductSettings): void {
    this.delivery.assertCurrent(expected);
  }

  private async computerAuthorityChanged(
    before: ProductSettings,
    candidate: ProductSettings,
    original: ProductSettings,
  ): Promise<boolean> {
    this.assertCurrentSettings(original);
    // Before the native publication owner is attached there is no serving
    // authority to withdraw. This is startup/local persistence, not TS policy.
    if (!this.withdrawComputerAuthority) return false;
    if (
      JSON.stringify(ownerSettingsComputerApproval(before, 0)) !==
      JSON.stringify(ownerSettingsComputerApproval(candidate, 0))
    )
      return true;
    if (!this.taskSettingsCompare)
      throw new Error("TASK_CURRENT_SETTINGS_UNAVAILABLE");
    const changed = await this.taskSettingsCompare(
      structuredClone(before),
      structuredClone(candidate),
    );
    this.assertCurrentSettings(original);
    if (typeof changed !== "boolean")
      throw new Error("TASK_CURRENT_SETTINGS_UNAVAILABLE");
    return changed;
  }

  private commitComputerEvidence(
    transform: (settings: ProductSettings) => ProductSettings,
    fence: StoreWriteFence = {},
  ): Promise<MutationResult> {
    return this.commit(
      (settings) =>
        advanceComputerApprovalGeneration(
          settings,
          transform(settings),
          (approved) => ownerSettingsComputerApproval(approved, 0),
        ),
      fence,
    );
  }

  private async commit(
    transform: (settings: ProductSettings) => ProductSettings,
    fence: StoreWriteFence = {},
    freshTaskSource = false,
    allowProvenAppPendingResolution = false,
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    const original = this.current;
    const before = structuredClone(this.fenceTaskSource(original));
    let candidate: ProductSettings;
    try {
      const transformed = ProductSettingsSchema.parse(transform(before));
      const connectorInvalidated = invalidateStaleConnectorRuntime(
        invalidateUnboundComputerVerification(transformed),
      );
      const sourceInvalidated = invalidateStaleCodexTaskSource(
        invalidateStaleAgentVerification(connectorInvalidated),
      );
      const fenced = freshTaskSource
        ? sourceInvalidated
        : this.fenceTaskSource(sourceInvalidated);
      // A write that clears a capturable live attachment keeps it as the
      // last verified one, so an older profile never loses its only proof.
      const invalidated = withLastVerifiedAttachmentKept(before, fenced);
      candidate = ProductSettingsSchema.parse(
        invalidated !== transformed && invalidated.revision === before.revision
          ? { ...invalidated, revision: before.revision + 1 }
          : invalidated,
      );
    } catch {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    // Generic Computer/Settings mutations also pass through this owner. An
    // authority generation change must not erase an uncertain connector write
    // as a side effect of normal stale-runtime invalidation after restart.
    const originalRuntime = before.connectors.secureMcp.runtime;
    const runtimeChanged =
      JSON.stringify(candidate.connectors.secureMcp.runtime) !==
      JSON.stringify(originalRuntime);
    const pendingCleared =
      before.setup.connect.outcomeUnknown &&
      !candidate.setup.connect.outcomeUnknown;
    if (
      (originalRuntime?.state === "outcome_unknown" &&
        (runtimeChanged || pendingCleared)) ||
      (before.setup.connect.outcomeUnknown &&
        ((runtimeChanged &&
          !(
            before.connectors.secureMcp.appVerificationPending === true &&
            candidate.connectors.secureMcp.appVerificationPending === true
          )) ||
          (pendingCleared && !allowProvenAppPendingResolution)))
    )
      return this.failure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
    let storeCalled = false;
    try {
      // Compare every final policy projection, including indirect verification
      // invalidation. Command-name lists cannot cover all authority changes.
      const changed = await this.computerAuthorityChanged(
        before,
        candidate,
        original,
      );
      let publication: ComputerSettingsPublication | undefined;
      if (changed && this.withdrawComputerAuthority) {
        try {
          publication = await this.withdrawComputerAuthority();
          this.delivery.holdWithdrawal(true);
        } catch (error) {
          if (this.delivery.attached)
            this.delivery.retainAuthorityFailure(error);
          throw error;
        }
      }
      this.assertCurrentSettings(original);
      storeCalled = true;
      await this.store.save(candidate, {
        beforeWrite: async () => {
          await fence.beforeWrite?.();
          this.assertCurrentSettings(original);
        },
        assertBeforePublication: () => {
          this.assertCurrentSettings(original);
          fence.assertBeforePublication?.();
        },
      });
      const readBack = await this.store.load();
      if (
        readBack === null ||
        JSON.stringify(readBack) !== JSON.stringify(candidate)
      ) {
        throw new Error("SETTINGS_READ_BACK_FAILED");
      }
      if (this.delivery.fenced)
        throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
      if (publication) {
        this.delivery.holdWithdrawal(false);
        try {
          await publication.publish(structuredClone(readBack));
        } catch (error) {
          if (this.delivery.attached)
            this.delivery.retainAuthorityFailure(error);
          throw error;
        }
      }
      if (this.delivery.fenced)
        throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
      this.current = readBack;
      this.currentError = null;
      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      if (this.delivery.fenced) {
        this.delivery.latchLoss();
        return this.failure("SETTINGS_WRITE_FAILED");
      }
      if (!storeCalled) return this.failure("SETTINGS_WRITE_FAILED");
      // The save may have landed before its read-back failed; what the disk
      // holds is the truth, and the snapshot taken before is only a fallback.
      const fallback = (await this.store.load().catch(() => null)) ?? before;
      if (this.delivery.fenced) {
        this.delivery.latchLoss();
        return this.failure("SETTINGS_WRITE_FAILED");
      }
      this.current = this.fenceTaskSource(fallback);
      // A fence refusal is not a write failure: nothing was written at all,
      // and the caller gets the reason rather than a generic disk error.
      if (error instanceof SetupIncomplete)
        return this.failure("SETUP_INCOMPLETE");
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
