import type { DesktopAdmission } from "../../apps/desktop/host/admission";
import { admissionFixture } from "../support/desktop-admission";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createConfigurationDrain } from "../../apps/desktop/configuration/drain";
import { WorkspaceConfigurationDrain } from "../../src/apps/desktop/workspace-configuration-drain";
import { ownerComputerConsentDigest } from "../../src/modules/computer/infra/repo/owner-computer-consent";

const command = {
  kind: "computer.update-access",
  workspaceId: "workspace-one",
  access: "write",
} as const;

function harness() {
  const events: string[] = [];
  let restricted = false;
  let revision = 9;
  let unknownSettings = false;
  let failStopAck = false;
  let failCleanup = false;
  let nativeCalls = 0;
  let settingsCalls = 0;
  const binding = {
    runtimeId: "runtime-one",
    backendGeneration: "generation-one",
    buildId: "a".repeat(64),
  };
  const originalSettings = {
    revision: 9,
    computer: {
      computerId: "computer-one",
      generation: 4,
      commands: "verification",
      filePolicy: "approved-roots-v1",
      workspaces: [
        {
          workspaceId: command.workspaceId,
          root: "/Users/example/project",
          access: "read",
          excludedPaths: [],
        },
      ],
    },
    connectors: { secureMcp: { generation: 3, runtime: { state: "ready" } } },
  };
  let settings: Omit<typeof originalSettings, "connectors"> & {
    connectors: {
      secureMcp: { generation: number; runtime: { state: string } | null };
    };
  } = originalSettings;
  const owner = {
    snapshot: () => ({ status: "ready" as const, settings }),
    commitOriginalStoppedSettings: vi.fn(
      async (
        selection: {
          effectId: string;
          expectedRevision: number;
          expectedDigest: string;
          computerGeneration: number;
          connectorGeneration: number;
          consentDigest: string;
        },
        admit: (plan: {
          effectId: string;
          expectedRevision: string;
          expectedDigest: string;
          nextRevision: string;
          nextDigest: string;
          computerGeneration: string;
          connectorGeneration: string;
          consentDigest: string;
        }) => Promise<void>,
        current: () => boolean,
      ) => {
        settingsCalls++;
        events.push("settings-owner");
        if (!current()) return { status: "unknown" as const };
        const nextSettings = {
          ...settings,
          revision: revision + 1,
          connectors: {
            secureMcp: { generation: 3, runtime: null },
          },
        };
        const plan = {
          effectId: selection.effectId,
          expectedRevision: String(selection.expectedRevision),
          expectedDigest: selection.expectedDigest,
          nextRevision: String(nextSettings.revision),
          nextDigest: createHash("sha256")
            .update(JSON.stringify(nextSettings))
            .digest("hex"),
          computerGeneration: String(selection.computerGeneration),
          connectorGeneration: String(selection.connectorGeneration),
          consentDigest: selection.consentDigest,
        };
        await admit(plan);
        if (unknownSettings) return { status: "unknown" as const };
        settings = nextSettings;
        revision = nextSettings.revision;
        return {
          status: "committed" as const,
          settings,
          receipt: {
            effectId: plan.effectId,
            revision: plan.nextRevision,
            documentDigest: plan.nextDigest,
            computerGeneration: plan.computerGeneration,
            connectorGeneration: plan.connectorGeneration,
            consentDigest: plan.consentDigest,
          },
        };
      },
    ),
  };
  const connector = {
    isRunning: () => true,
    hasUnresolvedEffect: () => false,
  };
  let closure: unknown;
  const core = {
    observeComputerContinuity: vi.fn(async () => ({
      restricted,
      pendingOperationId: restricted ? "old-parent" : undefined,
    })),
    currentComputerConnectorBinding: () => binding,
    beginOriginalStop: vi.fn(
      async (request: { operationId: string; stopEffectId: string }) => {
        events.push("go-stop-intent");
        if (restricted) throw new Error("existing pending parent");
        return {
          parentOperationId: request.operationId,
          phase: "stop_intent",
          first: true,
          stopEffectId: request.stopEffectId,
          ...binding,
        };
      },
    ),
    advanceOriginalStop: vi.fn(async (phase: { phase: string }) => {
      events.push("go-" + phase.phase);
      if (phase.phase === "stop_ack" && failStopAck)
        throw new Error("lost original Go ACK");
    }),
    computerConnectorClosureReceipt: () => closure,
  };
  const lifecycle = {
    hasUnconfirmedStop: vi.fn(async () => false),
    confirmedOriginalStop: () => ({
      lifecycleId: "44444444-4444-4444-8444-444444444444",
      stopRevision: "1",
      preparationRevision: "0",
    }),
  };
  let id = 0;
  const sandbox: Record<string, unknown> = {
    configuration: owner,
    secureMcpConnectorRuntime: connector,
    desktopGoCore: core,
    connectorTaskAdmission: false,
    connectorStartInFlight: null,
    savedChatBridgeRuntime: null,
    authorityTransitions: { current: () => "authority-change" },
    activeAuthorityChangeKind: command.kind,
    quitInProgress: false,
    installedUpdateAdmission: false,
    codexAgentOperationActive: () => false,
    connectorRuntimeUncertain: () => false,
    transitionRefusal: () => ({ ok: false, error: "REFUSED" }),
    configurationFailure: (code: string) => ({ ok: false, error: code }),
    computerMcpLifecycle: () => lifecycle,
    WorkspaceConfigurationDrain,
    randomUUID: () =>
      "11111111-1111-4111-8111-" + String(++id).padStart(12, "0"),
    createHash,
    ownerComputerConsentDigest,
    stopAndConfirmComputerMcp: vi.fn(
      async (
        _connector: unknown,
        _inFlight: unknown,
        _core: unknown,
        _saved: unknown,
        _reason: unknown,
        parent: string,
      ) => {
        nativeCalls++;
        events.push("native-stop");
        closure = {
          operationId: "55555555-5555-4555-8555-555555555555",
          result: { binding, closed: true, recovery: "settled" },
          parent,
        };
      },
    ),
    clearAndConfirmOriginalConnectorVerificationReceipt: vi.fn(
      async (_root: string, parentOperationId: string, effectId: string) => {
        events.push("verification-cleanup");
        if (failCleanup) throw new Error("cleanup outcome unknown");
        return {
          parentOperationId,
          effectId,
          readback: "verified-absent",
          digest: "f".repeat(64),
        };
      },
    ),
    statePaths: () => ({ secureMcpLaunch: "/Users/example/launch" }),
    configureAdmittedProduct: vi.fn(async () => {
      events.push("apply");
      return { ok: true, original: true };
    }),
  };
  const sandboxWithAdmission = admissionFixture(sandbox);
  const ports = {
    configuration: () => (sandboxWithAdmission as any).configuration,
    secureMcpConnectorRuntime: () =>
      (sandboxWithAdmission as any).secureMcpConnectorRuntime,
    desktopGoCore: () => (sandboxWithAdmission as any).desktopGoCore,
    desktopAdmission: sandboxWithAdmission.desktopAdmission,
    connectorStartInFlight: () => sandboxWithAdmission.connectorStartInFlight,
    transitionRefusal: () => (sandboxWithAdmission as any).transitionRefusal(),
    configurationFailure: (code: unknown) =>
      (sandboxWithAdmission as any).configurationFailure(code),
    authorityTransitions: (sandboxWithAdmission as any).authorityTransitions,
    activeAuthorityChangeKind: () =>
      (sandboxWithAdmission as any).activeAuthorityChangeKind,
    setActiveAuthorityChangeKind: (value: unknown) => {
      (sandboxWithAdmission as any).activeAuthorityChangeKind = value;
    },
    codexAgentOperationActive: () =>
      (sandboxWithAdmission as any).codexAgentOperationActive(),
    computerMcpLifecycle: () =>
      (sandboxWithAdmission as any).computerMcpLifecycle(),
    stopAndConfirmComputerMcp: (...args: unknown[]) =>
      (sandboxWithAdmission as any).stopAndConfirmComputerMcp(...args),
    savedChatBridgeRuntime: () =>
      (sandboxWithAdmission as any).savedChatBridgeRuntime,
    configureAdmittedProduct: (cmd: unknown) =>
      (sandboxWithAdmission as any).configureAdmittedProduct(cmd),
    statePaths: () => (sandboxWithAdmission as any).statePaths(),
    ownerComputerConsentDigest: (s: unknown) =>
      (sandboxWithAdmission as any).ownerComputerConsentDigest(s),
    connectorRuntimeUncertain: (s: unknown) =>
      (sandboxWithAdmission as any).connectorRuntimeUncertain(s),
    clearAndConfirmOriginalConnectorVerificationReceipt: (...args: unknown[]) =>
      (
        sandboxWithAdmission as any
      ).clearAndConfirmOriginalConnectorVerificationReceipt(...args),
  };
  const drain = createConfigurationDrain(ports as never);
  const execute = (input: unknown) =>
    drain.configureDrainedWorkspaceChange(input as never);
  return {
    events,
    core,
    owner,
    lifecycle,
    sandbox,
    execute,
    get settings() {
      return settings;
    },
    setRestricted(value: boolean) {
      restricted = value;
    },
    failStopAck() {
      failStopAck = true;
    },
    unknownSettings() {
      unknownSettings = true;
    },
    failCleanup() {
      failCleanup = true;
    },
    get nativeCalls() {
      return nativeCalls;
    },
    get settingsCalls() {
      return settingsCalls;
    },
  };
}

describe("main.ts original Stop prerequisite integration", () => {
  it("orders protected Go admission, native Stop, writer intent/readback, cleanup and terminal before apply", async () => {
    const f = harness();
    const result = await f.execute(command);
    expect(result.ok).toBe(true);
    expect(f.events).toEqual([
      "go-stop-intent",
      "native-stop",
      "go-stop_ack",
      "settings-owner",
      "go-settings_intent",
      "go-settings_ack",
      "go-cleanup_intent",
      "verification-cleanup",
      "go-cleanup_ack",
      "go-prerequisite_complete",
      "apply",
    ]);
    expect(f.nativeCalls).toBe(1);
    expect(f.settingsCalls).toBe(1);
  });

  it("pending original Go custody stops a second ordinary request before native Stop", async () => {
    const f = harness();
    f.setRestricted(true);
    const result = await f.execute(command);
    expect(result.ok).toBe(false);
    expect(f.core.beginOriginalStop).not.toHaveBeenCalled();
    expect(f.nativeCalls).toBe(0);
    expect(f.settingsCalls).toBe(0);
  });

  it("lost original Go stop ACK never authorizes Settings, cleanup or apply", async () => {
    const f = harness();
    f.failStopAck();
    const result = await f.execute(command);
    expect(result.ok).toBe(false);
    expect(f.nativeCalls).toBe(1);
    expect(f.settingsCalls).toBe(0);
    expect(f.events).not.toContain("verification-cleanup");
    expect(f.events).not.toContain("apply");
    // New process observes only the original pending ledger.
    f.setRestricted(true);
    await f.execute(command);
    expect(f.nativeCalls).toBe(1);
  });

  it("unknown stopped-Settings publication does not become success from equal visible bytes", async () => {
    const f = harness();
    f.unknownSettings();
    const result = await f.execute(command);
    expect(result.ok).toBe(false);
    expect(f.events).toContain("go-settings_intent");
    expect(f.events).not.toContain("go-settings_ack");
    expect(f.events).not.toContain("go-cleanup_intent");
    expect(f.events).not.toContain("apply");
    f.setRestricted(true);
    await f.execute(command);
    expect(f.settingsCalls).toBe(1);
    expect(f.nativeCalls).toBe(1);
  });

  it("cleanup failure retains the original pending phase, without a terminal certificate", async () => {
    const f = harness();
    f.failCleanup();
    const result = await f.execute(command);
    expect(result.ok).toBe(false);
    expect(f.events).toContain("go-cleanup_intent");
    expect(f.events).not.toContain("go-cleanup_ack");
    expect(f.events).not.toContain("go-prerequisite_complete");
    expect(f.events).not.toContain("apply");
  });

  it.each([
    { kind: "computer.add-workspace", selectionId: "owner-picker" },
    { kind: "computer.update-commands", commands: "workspace" },
    { kind: "computer.update-file-policy", filePolicy: "approved-roots-v1" },
  ])(
    "adopts $kind without borrowing an unrelated existing workspace root",
    async (requested) => {
      const f = harness();
      f.sandbox.activeAuthorityChangeKind = requested.kind;
      const result = await f.execute(requested as unknown as typeof command);
      expect(result.ok).toBe(true);
      expect(f.nativeCalls).toBe(1);
      const call = f.core.beginOriginalStop.mock.calls[0]?.[0] as unknown as
        | {
            commandKind: string;
            workspaceId?: string;
            root?: string;
            consentDigest: string;
          }
        | undefined;
      expect(call).toBeDefined();
      expect(call?.commandKind).toBe(requested.kind);
      expect(call?.workspaceId).toBeUndefined();
      expect(call?.root).toBeUndefined();
      expect(call?.consentDigest).toBe(
        ownerComputerConsentDigest(
          f.settings as unknown as Parameters<
            typeof ownerComputerConsentDigest
          >[0],
        ),
      );
    },
  );

  it("requires the exact original workspace root for a workspace-specific change", async () => {
    const f = harness();
    const result = await f.execute({
      ...command,
      workspaceId: "foreign-workspace",
    });
    expect(result.ok).toBe(false);
    expect(f.core.beginOriginalStop).not.toHaveBeenCalled();
    expect(f.nativeCalls).toBe(0);
    expect(f.settingsCalls).toBe(0);
  });

  it("rejects owner-consent changes after original Stop before Settings or cleanup", async () => {
    const f = harness();
    const original = f.sandbox.stopAndConfirmComputerMcp as (
      ...args: unknown[]
    ) => Promise<void>;
    f.sandbox.stopAndConfirmComputerMcp = async (...args: unknown[]) => {
      await original(...args);
      f.settings.computer.commands = "workspace";
    };
    const result = await f.execute(command);
    expect(result.ok).toBe(false);
    expect(f.events).toContain("go-stop-intent");
    expect(f.events).not.toContain("settings-owner");
    expect(f.events).not.toContain("verification-cleanup");
    expect(f.events).not.toContain("go-prerequisite_complete");
  });

  it("does not acknowledge a crossed native directory cleanup proof", async () => {
    const f = harness();
    f.sandbox.clearAndConfirmOriginalConnectorVerificationReceipt = async (
      _root: string,
      _parent: string,
      effectId: string,
    ) => ({
      parentOperationId: "foreign-parent",
      effectId,
      readback: "verified-absent",
      digest: "a".repeat(64),
    });
    const result = await f.execute(command);
    expect(result.ok).toBe(false);
    expect(f.events).toContain("go-cleanup_intent");
    expect(f.events).not.toContain("go-cleanup_ack");
    expect(f.events).not.toContain("go-prerequisite_complete");
  });
});

it("holds connector admission while awaiting the original continuity observation", async () => {
  const f = harness();
  let resume!: () => void;
  const continuity = new Promise<{
    restricted: boolean;
    pendingOperationId: string | undefined;
  }>((resolve) => {
    resume = () =>
      resolve({ restricted: false, pendingOperationId: undefined });
  });
  vi.mocked(f.core.observeComputerContinuity).mockImplementation(
    () => continuity,
  );
  const first = f.execute(command);
  expect(f.core.observeComputerContinuity).toHaveBeenCalledOnce();
  const admission = f.sandbox.desktopAdmission as DesktopAdmission;
  const competingHealth = admission.acquire("connector-task");
  try {
    expect(competingHealth).toBeNull();
    expect(f.nativeCalls).toBe(0);
    expect(f.settingsCalls).toBe(0);
  } finally {
    competingHealth?.release();
    resume();
    await first;
  }
  expect(admission.occupied("connector-task")).toBe(false);
});
