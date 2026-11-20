import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";
import {
  ContinuitySequence,
  type ContinuityEffectReceipt,
  type ContinuityPhaseResult,
  type ContinuitySequencePorts,
  type ContinuitySequenceResult,
} from "../../../src/apps/desktop/workspace-continuity-sequence";
import {
  ContinuityWriteIntentSchema,
  nextContinuitySettings,
  workspaceConsentDigest,
  type ContinuityWriteIntent,
} from "../../../src/apps/desktop/workspace-continuity-writer";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { ContinuityReply } from "../bridge/continuity";
import {
  validate,
  type ComputerContinuityBeginRequest,
  type ComputerContinuitySavedEvidence,
} from "../bridge/wire";
import type { DesktopGoCore } from "../go-core-host";
import type { DesktopAdmission } from "../host/admission";
import type { ConfigurationDrainPorts, ContinuityDrainResult } from "./drain";
import type { ContinuityDrainCommand } from "../../../src/apps/desktop/workspace-configuration-drain";

type Mode = ComputerContinuityBeginRequest["mode"];
type SettingsOwner = Pick<
  ProductConfigurationService,
  "snapshot" | "commitContinuityFromTransition"
>;
type Core = Pick<
  DesktopGoCore,
  "workspaceContinuity" | "observeComputerContinuity" | "observeOriginalStop"
>;

// Caller is the trusted desktop host. It may only return the original native
// selection for this operation, or an explicit cancellation.
export type ContinuityPicker = (
  operationId: string,
  originalRoot: string,
) => Promise<
  Readonly<
    | { state: "selected"; operationId: string; root: string }
    | { state: "cancelled"; operationId: string }
  >
>;

type HostPorts = Readonly<{
  configuration(): SettingsOwner | null;
  desktopGoCore(): Core | null;
  desktopAdmission: Pick<
    DesktopAdmission,
    "acquire" | "closed" | "occupied" | "withConfigurationRequest"
  >;
  authorityTransitions: AuthorityTransitionReservation;
  setActiveAuthorityChangeKind: ConfigurationDrainPorts["setActiveAuthorityChangeKind"];
  codexAgentOperationActive(): boolean;
  conflictingWorkspaceWork(): boolean;
  computerMcpLifecycle(): Pick<
    ReturnType<ConfigurationDrainPorts["computerMcpLifecycle"]>,
    "hasUnconfirmedStop"
  >;
  drainContinuityPrerequisite(
    command: ContinuityDrainCommand,
  ): Promise<ContinuityDrainResult>;
  ownerComputerConsentDigest: ConfigurationDrainPorts["ownerComputerConsentDigest"];
  // Deliberately absent until the host can attest compatible readers, update
  // recovery and the current native route. There is no renderer setting.
  recoveryQualified?(): Promise<true | "unavailable">;
}>;

const refused = { state: "refused" } as const;
const unknown = { state: "unknown" } as const;
const stopRefused = { state: "refused", phase: "stop" } as const;

function receiptResult(
  result: ContinuityReply<ContinuityEffectReceipt>,
): ContinuityPhaseResult {
  switch (result.state) {
    case "acknowledged":
      return { state: "acknowledged", receipt: result.value };
    case "refused":
      return refused;
    default:
      return unknown;
  }
}

function savedEvidence(
  workspace: ProductSettings["computer"]["workspaces"][number],
): ComputerContinuitySavedEvidence | undefined {
  const evidence = workspace.continuity;
  if (!evidence) return undefined;
  return {
    schema: evidence.schema,
    volumeUuid: evidence.volumeUuid,
    fileId: evidence.fileId,
    birthSeconds: evidence.birthSeconds,
    birthNanoseconds: evidence.birthNanoseconds,
  };
}

export function createWorkspaceContinuityHost(ports: HostPorts) {
  // The same host must retain missing original delivery even if a subsequent
  // status read sees no entry. A new run cannot reconcile an unknown outcome.
  let outcomeUnconfirmed = false;

  async function runWorkspaceContinuity(
    workspaceId: string,
    mode: Mode,
    picker?: ContinuityPicker,
  ): Promise<ContinuitySequenceResult> {
    if (
      outcomeUnconfirmed ||
      ports.desktopAdmission.closed() ||
      ports.codexAgentOperationActive() ||
      ports.conflictingWorkspaceWork() ||
      ports.desktopAdmission.occupied("connector-task") ||
      (mode !== "legacy-confirm" && mode !== "enrolled-rebind") ||
      (mode === "legacy-confirm" && typeof picker !== "function")
    )
      return stopRefused;

    return ports.desktopAdmission.withConfigurationRequest(async () => {
      const reserved = await ports.authorityTransitions.withReservation(
        "authority-change",
        async () => {
          const owner = ports.configuration();
          const core = ports.desktopGoCore();
          if (!owner || !core) return stopRefused;
          const workspaceAdmission =
            ports.desktopAdmission.acquire("workspace-mutation");
          if (!workspaceAdmission) return stopRefused;
          const command: ContinuityDrainCommand = {
            kind:
              mode === "legacy-confirm"
                ? "computer.confirm-workspace"
                : "computer.rebind-workspace",
            workspaceId,
            childOperationId: randomUUID(),
          };
          ports.setActiveAuthorityChangeKind(command.kind);
          try {
            return await runAdmittedContinuity(
              ports,
              core,
              owner,
              command,
              mode,
              picker,
            );
          } finally {
            ports.setActiveAuthorityChangeKind(null);
            workspaceAdmission.release();
          }
        },
      );
      return reserved.admitted ? reserved.value : stopRefused;
    });
  }

  async function runAdmittedContinuity(
    host: HostPorts,
    core: Core,
    owner: SettingsOwner,
    command: ContinuityDrainCommand,
    mode: Mode,
    nativePicker?: ContinuityPicker,
  ): Promise<ContinuitySequenceResult> {
    const lookup = () => {
      const snap = owner.snapshot();
      if (
        snap.status !== "ready" ||
        snap.settings.computer.pendingEdit !== null
      )
        return undefined;
      const workspace = snap.settings.computer.workspaces.find(
        (entry) => entry.workspaceId === command.workspaceId,
      );
      return workspace?.rootIdentity
        ? {
            settings: snap.settings,
            workspace,
            binding: workspace.rootIdentity,
          }
        : undefined;
    };
    let before: ReturnType<typeof lookup>;
    let go: Core["workspaceContinuity"];
    try {
      before = lookup();
      go = core.workspaceContinuity;
    } catch {
      return stopRefused;
    }
    if (
      !before ||
      !validate("ComputerContinuityRootIdentity", before.binding) ||
      (mode === "enrolled-rebind") !== Boolean(before.workspace.continuity)
    )
      return stopRefused;
    const originalConsent = workspaceConsentDigest(before.settings);
    const operationId = command.childOperationId;
    let drain: ContinuityDrainResult | undefined;
    let original: ReturnType<typeof lookup>;
    let writeIntent: ContinuityWriteIntent | undefined;
    let settingsPlan: ContinuityEffectReceipt | undefined;
    let selectedAt: string | undefined;
    let withdrawalAcknowledged = false;
    let expectedSettings: ProductSettings | undefined;

    const current = () =>
      host.configuration() === owner &&
      host.desktopGoCore() === core &&
      host.authorityTransitions.current() === "authority-change" &&
      host.desktopAdmission.occupied("workspace-mutation") &&
      !host.desktopAdmission.closed() &&
      !host.codexAgentOperationActive() &&
      !host.conflictingWorkspaceWork() &&
      (!expectedSettings ||
        isDeepStrictEqual(lookup()?.settings, expectedSettings));

    const sequencePorts: ContinuitySequencePorts = {
      current,
      recoveryQualified: async () =>
        (await host.recoveryQualified?.()) === true ? true : "unavailable",
      priorStopSettled: async () => {
        const stop = await core.observeOriginalStop();
        const continuity = await core.observeComputerContinuity();
        return !stop.restricted &&
          stop.pendingOperationId === undefined &&
          !continuity.restricted &&
          continuity.pendingOperationId === undefined &&
          !(await host.computerMcpLifecycle().hasUnconfirmedStop())
          ? true
          : "unknown";
      },
      // The existing drain owns both effects and runs once. Only its original
      // completed receipt may cross into recordStopped and child admission.
      stop: async () => {
        drain = await host.drainContinuityPrerequisite(command);
        if (drain.state === "confirmed" || drain.phase === "record-stopped")
          return true;
        return drain.state === "refused" ? false : "unknown";
      },
      recordStopped: async () => {
        if (drain?.state === "confirmed") return drain;
        return drain?.state === "refused" ? refused : unknown;
      },
      admit: async (stopped) => {
        original = lookup();
        if (
          !original ||
          original.settings.revision !== stopped.revision ||
          original.settings.computer.generation !== stopped.generation ||
          workspaceConsentDigest(original.settings) !== originalConsent ||
          !isDeepStrictEqual(original.binding, before.binding) ||
          !isDeepStrictEqual(
            original.workspace.continuity,
            before.workspace.continuity,
          )
        )
          return refused;
        expectedSettings = original.settings;
        const evidence = savedEvidence(original.workspace);
        const reply = await go.begin({
          operationId,
          mode,
          savedBinding: original.binding,
          ...(evidence ? { savedEvidence: evidence } : {}),
        });
        if (reply.state === "acknowledged")
          return { state: "admitted", operationId: reply.value.operationId };
        return reply.state === "refused" ? refused : unknown;
      },
      picker: async (id) => {
        const result = await nativePicker?.(id, before.workspace.root);
        if (!result || result.operationId !== id) return "invalid";
        if (result.state === "cancelled") return "cancelled";
        if (result.state !== "selected" || !validate("string", result.root))
          return "invalid";
        if (result.root !== before.workspace.root) return "cancelled";
        selectedAt = new Date().toISOString();
        return "confirmed";
      },
      confirm: async (id, ownerPicked) => {
        const reply = await go.confirm({
          operationId: id,
          ownerPicked,
          selectedRoot: ownerPicked ? before.workspace.root : "",
        });
        if (reply.state !== "acknowledged")
          return reply.state === "refused" ? refused : unknown;
        const measured = reply.value;
        if (
          !original ||
          measured.computerId !== original.settings.computer.computerId ||
          measured.workspaceId !== original.workspace.workspaceId ||
          measured.root !== original.workspace.root ||
          measured.expectedRevision !== String(original.settings.revision) ||
          measured.expectedGeneration !==
            String(original.settings.computer.generation) ||
          measured.expectedConsentSha256 !==
            host.ownerComputerConsentDigest(original.settings)
        )
          return unknown;
        // The original Stop and Go WAL bind the protected stop-consent digest.
        // The Settings writer additionally checks its complete local projection.
        const prior = original.workspace.continuity;
        if (!prior && !selectedAt) return unknown;
        const intent = ContinuityWriteIntentSchema.safeParse({
          operationId: id,
          workspaceId: measured.workspaceId,
          expectedRevision: original.settings.revision,
          expectedGeneration: original.settings.computer.generation,
          expectedConsentSha256: originalConsent,
          rootIdentity: measured.rootIdentity,
          continuity: {
            ...measured.continuity,
            computerId: measured.computerId,
            workspaceId: measured.workspaceId,
            root: measured.root,
            filesystem: "apfs",
            enrollment: prior?.enrollment ?? {
              operationId: id,
              selectedAt,
              policySha256: originalConsent,
            },
          },
        });
        if (
          !intent.success ||
          !nextContinuitySettings(original.settings, intent.data)
        )
          return unknown;
        writeIntent = intent.data;
        return {
          state: "prepared",
          root: measured.root,
          currentDevice: measured.rootIdentity.device,
          currentInode: measured.rootIdentity.inode,
        };
      },
      refuseBeforeWithdraw: async (id) =>
        (await go.finish({ operationId: id, kind: "refused" })).state ===
        "acknowledged"
          ? true
          : "unknown",
      plan: async (id, phase) => {
        const reply = await go.plan({ operationId: id, phase });
        return reply.state === "acknowledged" ? reply.value : "unknown";
      },
      intent: async (id, phase, receipt) => {
        const reply = await go.record({ operationId: id, phase, receipt });
        if (reply.state !== "acknowledged") return "unknown";
        if (phase === "settings_intent") settingsPlan = receipt;
        return true;
      },
      acknowledge: async (id, phase, receipt) => {
        const reply = await go.record({ operationId: id, phase, receipt });
        if (reply.state !== "acknowledged") return "unknown";
        if (phase === "withdraw_ack") withdrawalAcknowledged = true;
        return true;
      },
      withdraw: async (id) => receiptResult(await go.withdraw(id)),
      settings: async (id) => {
        const plan = settingsPlan;
        if (!original || !writeIntent || !plan) return unknown;
        const expected = nextContinuitySettings(original.settings, writeIntent);
        if (!expected) return refused;
        let requalificationUnconfirmed = false;
        const written = await owner.commitContinuityFromTransition(
          writeIntent,
          {
            current,
            withdrawalAcknowledged: () => withdrawalAcknowledged,
            requalifyNative: async () => {
              const rechecked = await go.plan({
                operationId: id,
                phase: "settings_intent",
              });
              const confirmed =
                rechecked.state === "acknowledged" &&
                isDeepStrictEqual(rechecked.value, plan);
              if (!confirmed) requalificationUnconfirmed = true;
              return confirmed;
            },
          },
        );
        if (requalificationUnconfirmed) return unknown;
        if (written.status === "not_written") return refused;
        if (
          written.status !== "committed" ||
          !isDeepStrictEqual(written.settings, expected)
        )
          return unknown;
        expectedSettings = written.settings;
        const digest = createHash("sha256")
          .update(JSON.stringify(written.settings))
          .digest("hex");
        return {
          state: "acknowledged",
          receipt: { effectId: plan.effectId, digest },
        };
      },
      stage: async (id) => receiptResult(await go.stage(id)),
      closeAndCertify: async (id) =>
        (await go.finish({ operationId: id, kind: "committed" })).state ===
        "acknowledged"
          ? true
          : "unknown",
      qualifyCurrent: async (id) => {
        if ((await sequencePorts.recoveryQualified()) !== true || !current())
          return "unavailable";
        const reply = await go.qualify(id);
        if (reply.state === "unknown") return "unknown";
        return reply.state === "acknowledged" ? true : "unavailable";
      },
    };

    const result = await new ContinuitySequence(sequencePorts).run(
      mode === "legacy-confirm",
    );
    if (result.state === "unknown") outcomeUnconfirmed = true;
    return result;
  }

  return Object.freeze({ runWorkspaceContinuity });
}
