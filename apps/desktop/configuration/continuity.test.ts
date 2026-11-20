import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import { nextContinuitySettings } from "../../../src/apps/desktop/workspace-continuity-writer";
import { ownerComputerConsentDigest } from "../../../src/modules/computer/infra/repo/owner-computer-consent";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";
import { BridgeError, type Client } from "../bridge/client";
import { ContinuityBridge } from "../bridge/continuity";
import type {
  ComputerStopAdmitRequest,
  ComputerStopAdvanceRequest,
} from "../bridge/wire";
import { DesktopAdmission } from "../host/admission";
import {
  createWorkspaceContinuityHost,
  type ContinuityPicker,
} from "./continuity";
import {
  createConfigurationDrain,
  type ConfigurationDrainPorts,
  type WorkspaceAuthorityChangeKind,
} from "./drain";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const enrollmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const root = "/synthetic/approved & <selected>";
const schema = "farol.workspace-continuity/1" as const;
const observation = {
  schema,
  volumeUuid: "11111111-2222-3333-4444-555555555555",
  fileId: "42",
  birthSeconds: "1700000000",
  birthNanoseconds: "0",
};
const context = { profileId: "profile", backendGeneration: "backend" };
const binding = {
  runtimeId: "runtime",
  backendGeneration: "backend",
  buildId: "a".repeat(64),
};
const rootIdentity = { device: "17", inode: "42" };
const nextRootIdentity = { device: "29", inode: "42" };
const enrollment = {
  operationId: enrollmentId,
  selectedAt: "2026-11-10T08:00:00.000Z",
  policySha256: "f".repeat(64),
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

type HostPorts = Parameters<typeof createWorkspaceContinuityHost>[0];
type Writer = NonNullable<
  ReturnType<HostPorts["configuration"]>
>["commitContinuityFromTransition"];

type Options = {
  enrolled?: boolean;
  active?: boolean;
  unqualified?: boolean;
  pendingStop?: boolean;
  failAt?: string;
  failOccurrence?: number;
  failure?: "unknown" | "refused" | "malformed";
  cancel?: boolean;
  selectOther?: boolean;
};

const stopSteps = [
  "stop.admit",
  "stop.native",
  "stop.stop_ack",
  "stop.settings_intent",
  "stop.settings",
  "stop.settings_ack",
  "stop.cleanup_intent",
  "stop.cleanup",
  "stop.cleanup_ack",
  "stop.prerequisite_complete",
];
const continuitySteps = [
  "begin",
  "confirm",
  "plan.withdraw_intent",
  "record.withdraw_intent",
  "withdraw",
  "record.withdraw_ack",
  "plan.settings_intent",
  "record.settings_intent",
  "plan.settings_intent",
  "plan.settings_intent",
  "settings.save",
  "record.settings_ack",
  "plan.publish_intent",
  "record.publish_intent",
  "stage",
  "record.publish_ack",
  "plan.close_intent",
  "record.close_intent",
  "finish.committed",
  "qualify",
];

// Real desktop composition, drain and wire parsing. Connector, Go pipe and
// single-writer storage are fakes. No native paths, connector or GUI are used.
function fixture(options: Options = {}) {
  let settings: ProductSettings = defaultSettings(randomUUID);
  const baseRevision = settings.revision;
  const baseGeneration = settings.computer.generation;
  settings.computer.workspaces = [
    {
      workspaceId,
      root,
      label: "Approved folder",
      access: "read",
      excludedPaths: ["private"],
      rootIdentity,
      ...(options.enrolled
        ? {
            continuity: {
              ...observation,
              computerId: settings.computer.computerId,
              workspaceId,
              root,
              filesystem: "apfs" as const,
              enrollment,
            },
          }
        : {}),
    },
  ];

  const events: string[] = [];
  const admission = new DesktopAdmission({
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => options.active === true,
    hostCheck: () => false,
    connectorStart: () => false,
  });
  const authority = new AuthorityTransitionReservation();
  let activeKind: WorkspaceAuthorityChangeKind | null = null;
  const setActiveAuthorityChangeKind = (
    kind: WorkspaceAuthorityChangeKind | null,
  ) => {
    activeKind = kind;
  };
  const state = { operationId: "", stopDone: false, withdrawAck: false };
  const plans = new Map<string, { effectId: string; digest: string }>();

  let failuresSeen = 0;
  const enter = (step: string) => {
    events.push(step);
    expect(authority.current()).toBe("authority-change");
    expect(admission.configurationRequests).toBe(1);
    expect(admission.occupied("workspace-mutation")).toBe(true);
    expect(authority.tryReserve("agent-admission")).toBeNull();
    return (
      options.failAt === step &&
      ++failuresSeen === (options.failOccurrence ?? 1)
    );
  };
  const originalEffect = (step: string) => {
    if (enter(step))
      throw new BridgeError(
        options.failure === "refused" ? "refused" : "unknown",
        "fake_effect_outcome",
      );
  };

  const client = {
    verifiedContext: context,
    request: async (
      method: string,
      body: Record<string, unknown>,
      request: { id: string; operationId?: string },
    ) => {
      const name = method.slice("computer.continuity.".length);
      const phase = String(body.phase ?? body.kind ?? "");
      const step = phase ? `${name}.${phase}` : name;
      const envelope = {
        requestId: request.id,
        context,
        ...(request.operationId ? { operationId: request.operationId } : {}),
      };
      if (enter(step)) {
        if (options.failure === "malformed")
          return { ...envelope, status: "ok", data: { operationId: "wrong" } };
        return {
          ...envelope,
          status: options.failure ?? "unknown",
          code: "fake_outcome",
        };
      }
      const operationId = body.operationId;
      expect(operationId).toBe(state.operationId);
      let data: unknown;
      switch (name) {
        case "begin":
          expect(state.stopDone).toBe(true);
          expect(body.savedBinding).toEqual(rootIdentity);
          expect(body.savedEvidence).toEqual(
            options.enrolled ? observation : undefined,
          );
          data = { operationId, admitted: true, priorPhase: "intent" };
          break;
        case "confirm":
          expect(body).toMatchObject({
            ownerPicked: !options.enrolled,
            selectedRoot: options.enrolled ? "" : root,
          });
          data = {
            operationId,
            workspaceId,
            root,
            computerId: settings.computer.computerId,
            expectedRevision: String(settings.revision),
            expectedGeneration: String(settings.computer.generation),
            expectedConsentSha256: ownerComputerConsentDigest(settings),
            rootIdentity: nextRootIdentity,
            continuity: observation,
          };
          break;
        case "plan": {
          const plan = {
            effectId: `${operationId}_${phase}`,
            digest: hash(phase),
          };
          plans.set(phase, plan);
          data = plan;
          break;
        }
        case "record":
          if (phase.endsWith("_intent"))
            expect(body.receipt).toEqual(plans.get(phase));
          if (phase === "withdraw_ack") state.withdrawAck = true;
          if (phase === "settings_ack")
            expect(body.receipt).toEqual({
              effectId: plans.get("settings_intent")?.effectId,
              digest: hash(settings),
            });
          data = { operationId, phase };
          break;
        case "withdraw":
          data = {
            effectId: plans.get("withdraw_intent")?.effectId,
            digest: "c".repeat(64),
          };
          break;
        case "stage":
          data = {
            effectId: plans.get("publish_intent")?.effectId,
            digest: "d".repeat(64),
          };
          break;
        case "finish":
          data = { operationId, phase };
          break;
        case "qualify":
          data = { operationId, qualified: true };
          break;
      }
      return { ...envelope, status: "ok", data };
    },
  };

  let running = true;
  let stopRequest: ComputerStopAdmitRequest | undefined;
  const core = {
    workspaceContinuity: new ContinuityBridge(client as unknown as Client),
    observeOriginalStop: vi.fn(async () => ({
      restricted: options.pendingStop === true,
    })),
    observeComputerContinuity: vi.fn(async () => ({ restricted: false })),
    currentComputerConnectorBinding: () => binding,
    beginOriginalStop: vi.fn(async (request: ComputerStopAdmitRequest) => {
      originalEffect("stop.admit");
      expect(request).toMatchObject({
        workspaceId,
        root,
        commandKind: options.enrolled
          ? "computer.rebind-workspace"
          : "computer.confirm-workspace",
        childMode: options.enrolled ? "enrolled-rebind" : "legacy-confirm",
      });
      expect(request).not.toHaveProperty("childIntentDigest");
      stopRequest = request;
      state.operationId = request.childOperationId!;
      return { ...binding, parentOperationId: request.operationId };
    }),
    computerConnectorClosureReceipt: () => ({
      operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      result: { closed: true, binding },
    }),
    advanceOriginalStop: async (input: ComputerStopAdvanceRequest) => {
      originalEffect(`stop.${input.phase}`);
      expect(input.parentOperationId).toBe(stopRequest?.operationId);
      if (input.phase === "prerequisite_complete") state.stopDone = true;
      return input;
    },
  } as unknown as NonNullable<
    ReturnType<ConfigurationDrainPorts["desktopGoCore"]>
  >;

  const write: Writer = async (intent, fence) => {
    expect(fence.current()).toBe(true);
    expect(fence.withdrawalAcknowledged()).toBe(true);
    expect(state.withdrawAck).toBe(true);
    expect(intent.expectedRevision).toBe(baseRevision + 1);
    expect(intent.expectedGeneration).toBe(baseGeneration);
    if (!(await fence.requalifyNative()) || !(await fence.requalifyNative()))
      return { status: "not_written" };
    if (enter("settings.save")) {
      if (options.failure === "refused") return { status: "not_written" };
      if (options.failure === "malformed")
        return { status: "committed", settings: structuredClone(settings) };
      return { status: "unknown" };
    }
    const next = nextContinuitySettings(settings, intent);
    if (!next) throw Error("fixture Settings rejected");
    settings = next;
    return { status: "committed", settings: structuredClone(settings) };
  };
  const owner = {
    snapshot: () => ({
      status: "ready" as const,
      settings: structuredClone(settings),
    }),
    commitOriginalStoppedSettings: async (intent, report, current) => {
      expect(current()).toBe(true);
      expect(intent.expectedRevision).toBe(baseRevision);
      expect(intent.expectedDigest).toBe(hash(settings));
      const next = { ...settings, revision: settings.revision + 1 };
      const plan = {
        effectId: intent.effectId,
        expectedRevision: String(settings.revision),
        expectedDigest: hash(settings),
        nextRevision: String(next.revision),
        nextDigest: hash(next),
        computerGeneration: String(next.computer.generation),
        connectorGeneration: String(next.connectors.secureMcp.generation),
        consentDigest: ownerComputerConsentDigest(next),
      };
      await report(plan);
      if (enter("stop.settings")) return { status: "unknown" };
      settings = next;
      return {
        status: "committed",
        settings: structuredClone(next),
        receipt: {
          effectId: intent.effectId,
          revision: plan.nextRevision,
          documentDigest: plan.nextDigest,
          computerGeneration: plan.computerGeneration,
          connectorGeneration: plan.connectorGeneration,
          consentDigest: plan.consentDigest,
          readback: "exact",
        },
      };
    },
    commitContinuityFromTransition: write,
  } satisfies Pick<
    NonNullable<ReturnType<ConfigurationDrainPorts["configuration"]>>,
    | "snapshot"
    | "commitOriginalStoppedSettings"
    | "commitContinuityFromTransition"
  >;
  const lifecycle = {
    hasUnconfirmedStop: async () => false,
    confirmedOriginalStop: () => ({
      lifecycleId: "lifecycle",
      stopRevision: "1",
      preparationRevision: "1",
    }),
  };
  const connector = {
    isRunning: () => running,
    hasUnresolvedEffect: () => false,
  };
  const drain = createConfigurationDrain({
    configuration: () =>
      owner as unknown as NonNullable<
        ReturnType<ConfigurationDrainPorts["configuration"]>
      >,
    secureMcpConnectorRuntime: () =>
      connector as unknown as NonNullable<
        ReturnType<ConfigurationDrainPorts["secureMcpConnectorRuntime"]>
      >,
    desktopGoCore: () => core,
    desktopAdmission: admission,
    authorityTransitions: authority,
    activeAuthorityChangeKind: () => activeKind,
    setActiveAuthorityChangeKind,
    codexAgentOperationActive: () => options.active === true,
    connectorStartInFlight: () => null,
    transitionRefusal: () => {
      throw Error("generic configuration refusal");
    },
    configurationFailure: () => {
      throw Error("generic configuration failure");
    },
    computerMcpLifecycle: () => lifecycle,
    stopAndConfirmComputerMcp: async () => {
      originalEffect("stop.native");
      running = false;
    },
    savedChatBridgeRuntime: () => null,
    statePaths: () => ({ secureMcpLaunch: "/synthetic/launch" }),
    configureAdmittedProduct: async () => {
      throw Error("public configuration path");
    },
    ownerComputerConsentDigest,
    connectorRuntimeUncertain: () => false,
    clearAndConfirmOriginalConnectorVerificationReceipt: async (
      _,
      parentOperationId,
      effectId,
    ) => {
      originalEffect("stop.cleanup");
      return {
        parentOperationId,
        effectId,
        readback: "verified-absent",
        digest: "e".repeat(64),
      };
    },
  });
  const host = createWorkspaceContinuityHost({
    configuration: () => owner,
    desktopGoCore: () => core,
    desktopAdmission: admission,
    authorityTransitions: authority,
    setActiveAuthorityChangeKind,
    codexAgentOperationActive: () => options.active === true,
    conflictingWorkspaceWork: () => false,
    computerMcpLifecycle: () => lifecycle,
    drainContinuityPrerequisite: drain.drainContinuityPrerequisite,
    ownerComputerConsentDigest,
    ...(options.unqualified
      ? {}
      : { recoveryQualified: async () => true as const }),
  });

  const picker = vi.fn<ContinuityPicker>(async (operationId, requestedRoot) => {
    if (enter("picker")) throw Error("picker reply lost");
    expect(operationId).toBe(state.operationId);
    expect(requestedRoot).toBe(root);
    return options.cancel
      ? { state: "cancelled", operationId }
      : {
          state: "selected",
          operationId,
          root: options.selectOther ? "/synthetic/other" : root,
        };
  });
  return {
    run: () =>
      host.runWorkspaceContinuity(
        workspaceId,
        options.enrolled ? "enrolled-rebind" : "legacy-confirm",
        picker,
      ),
    events,
    state,
    settings: () => settings,
    baseRevision,
    baseGeneration,
    picker,
    authority,
    admission,
    core,
    drain,
  };
}

describe("desktop workspace continuity host", () => {
  it.each([false, true])(
    "runs the full owned sequence (enrolled=%s)",
    async (enrolled) => {
      const f = fixture({ enrolled });
      expect(await f.run()).toEqual({
        state: "current-qualified",
        operationId: f.state.operationId,
      });
      const [begin, ...rest] = continuitySteps;
      expect(f.events).toEqual([
        ...stopSteps,
        begin,
        ...(enrolled ? [] : ["picker"]),
        ...rest,
      ]);
      const saved = f.settings();
      expect(saved.revision).toBe(f.baseRevision + 2);
      expect(saved.computer.generation).toBe(f.baseGeneration + 1);
      expect(saved.computer.workspaces[0]).toMatchObject({
        workspaceId,
        root,
        access: "read",
        excludedPaths: ["private"],
        rootIdentity: nextRootIdentity,
        continuity: {
          ...observation,
          enrollment: enrolled
            ? enrollment
            : { operationId: f.state.operationId },
        },
      });
      expect(f.picker).toHaveBeenCalledTimes(enrolled ? 0 : 1);
      expect(f.authority.current()).toBeNull();
      expect(f.admission.configurationRequests).toBe(0);
      expect(f.admission.occupied("connector-task")).toBe(false);
      expect(f.admission.occupied("workspace-mutation")).toBe(false);
    },
  );

  it.each([
    { cancel: true },
    { selectOther: true },
    { failAt: "confirm", failure: "refused" as const },
  ])(
    "certifies only a known refusal before withdrawal (%o)",
    async (options) => {
      const f = fixture(options);
      expect(await f.run()).toEqual({ state: "refused", phase: "confirm" });
      expect(f.events.at(-1)).toBe("finish.refused");
      expect(f.events).not.toContain("withdraw");
      expect(f.settings().revision).toBe(f.baseRevision + 1);
    },
  );

  it.each([{ active: true }, { unqualified: true }, { pendingStop: true }])(
    "fails closed before any effect (%o)",
    async (options) => {
      const f = fixture(options);
      expect(await f.run()).toEqual({ state: "refused", phase: "stop" });
      expect(f.events).toEqual([]);
      expect(f.picker).not.toHaveBeenCalled();
      if (options.active)
        expect(f.core.observeOriginalStop).not.toHaveBeenCalled();
    },
  );

  it("admits only the two host-only continuity drain kinds", async () => {
    const f = fixture();
    for (const kind of [
      "computer.update-access",
      "computer.verify-workspace",
      "connector.stop",
    ]) {
      expect(
        await f.drain.drainContinuityPrerequisite({
          kind,
          workspaceId,
          childOperationId: enrollmentId,
        } as Parameters<typeof f.drain.drainContinuityPrerequisite>[0]),
      ).toEqual({ state: "refused", phase: "stop" });
    }
    expect(f.events).toEqual([]);
  });

  const faults = [
    ...stopSteps.map(
      (step, index) => [step, index < 3 ? "stop" : "record-stopped"] as const,
    ),
    ["begin", "admit"],
    ["picker", "confirm"],
    ["confirm", "confirm"],
    ["plan.withdraw_intent", "withdraw"],
    ["record.withdraw_intent", "withdraw"],
    ["withdraw", "withdraw"],
    ["record.withdraw_ack", "withdraw"],
    ["plan.settings_intent", "settings"],
    ["record.settings_intent", "settings"],
    ["settings.save", "settings"],
    ["record.settings_ack", "settings"],
    ["plan.publish_intent", "stage"],
    ["record.publish_intent", "stage"],
    ["stage", "stage"],
    ["record.publish_ack", "stage"],
    ["plan.close_intent", "close"],
    ["record.close_intent", "close"],
    ["finish.committed", "close"],
  ] as const;

  it.each(faults)(
    "retains an unknown %s and performs no subsequent effect",
    async (step, phase) => {
      const f = fixture({ failAt: step });
      expect(await f.run()).toEqual({ state: "unknown", phase });
      expect(f.events.at(-1)).toBe(step);
      const original = [...f.events];
      expect(await f.run()).toEqual({ state: "refused", phase: "stop" });
      expect(f.events).toEqual(original);
    },
  );

  it.each([2, 3])(
    "stops before the Settings save if native witness %s is lost",
    async (failOccurrence) => {
      const f = fixture({ failAt: "plan.settings_intent", failOccurrence });
      expect(await f.run()).toEqual({ state: "unknown", phase: "settings" });
      expect(f.events.at(-1)).toBe("plan.settings_intent");
      expect(f.events).not.toContain("settings.save");
      expect(await f.run()).toEqual({ state: "refused", phase: "stop" });
      expect(
        f.events.filter((step) => step === "plan.settings_intent"),
      ).toHaveLength(failOccurrence);
    },
  );

  it("keeps a cancellation with missing finish ACK unknown", async () => {
    const f = fixture({ cancel: true, failAt: "finish.refused" });
    expect(await f.run()).toEqual({ state: "unknown", phase: "confirm" });
    expect(f.events.at(-1)).toBe("finish.refused");
    expect(await f.run()).toEqual({ state: "refused", phase: "stop" });
    expect(f.events.filter((step) => step === "finish.refused")).toHaveLength(
      1,
    );
  });

  it("keeps the logical certificate inactive after a known qualification refusal", async () => {
    const f = fixture({ failAt: "qualify", failure: "refused" });
    expect(await f.run()).toEqual({
      state: "committed-not-active",
      operationId: f.state.operationId,
    });
    expect(f.events.slice(-2)).toEqual(["finish.committed", "qualify"]);
  });

  it.each(["unknown", "malformed"] as const)(
    "does not infer current activation from a %s qualification reply",
    async (failure) => {
      const f = fixture({ failAt: "qualify", failure });
      expect(await f.run()).toEqual({
        state: "unknown",
        phase: "current-qualification",
      });
      expect(f.events.slice(-2)).toEqual(["finish.committed", "qualify"]);
      expect(await f.run()).toEqual({ state: "refused", phase: "stop" });
      expect(f.events.filter((step) => step === "qualify")).toHaveLength(1);
    },
  );

  it.each(["refused", "malformed"] as const)(
    "fences the original withdrawal when the Settings result is %s",
    async (failure) => {
      const f = fixture({ failAt: "settings.save", failure });
      expect(await f.run()).toEqual({ state: "unknown", phase: "settings" });
      expect(f.events.at(-1)).toBe("settings.save");
      expect(await f.run()).toEqual({ state: "refused", phase: "stop" });
    },
  );

  it("does not start the child after a known original Stop admission refusal", async () => {
    const f = fixture({ failAt: "stop.admit", failure: "refused" });
    expect(await f.run()).toEqual({ state: "refused", phase: "stop" });
    expect(f.events).toEqual(["stop.admit"]);
  });
});
