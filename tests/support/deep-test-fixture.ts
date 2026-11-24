import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { createConfigurationDeep } from "../../apps/desktop/configuration/deep";
import { DesktopAdmission } from "../../apps/desktop/host/admission";
import {
  PrivateChatGptTaskJournal,
  type ChatGptTaskJournalRecord,
} from "../../src/apps/desktop/chatgpt-task-journal";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";
import { scriptedDeepPorts } from "./deep-configuration-ports";

// Test-only. The real journal runs against a disposable directory; the route,
// connector, owner and every main-owned helper are scripted. This exercises the
// deep-test orchestration, not an Electron view, a provider, a native connector
// or an installation.
export type DeepRouteResult = {
  state: string;
  code: string | null;
  deltaCount: number;
  observedCharacters: number;
};
export type DeepObserver = {
  manualDeepTest: boolean;
  manualSubmissionOnly: boolean;
  beforeSend: () => boolean;
  onDispatchIntent: () => Promise<void>;
};

const roots: string[] = [];
export async function cleanupDeepFixtures(): Promise<void> {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
}

export const sendRequested: DeepRouteResult = {
  state: "send_requested",
  code: null,
  deltaCount: 0,
  observedCharacters: 0,
};

export function readySettings() {
  return guidedSettingsFixture();
}

export async function deepFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-deep-host-"));
  roots.push(root);
  const stateRoot = path.join(root, "farol-state");
  await fs.mkdir(stateRoot, { mode: 0o700 });

  const settings = readySettings();
  const state = {
    snapshot: { status: "ready", settings } as unknown,
    owner: null as unknown,
    core: null as unknown,
    connector: null as unknown,
    route: null as unknown,
    liveRoutes: new Map<string, unknown>(),
    selectedTaskId: "",
    section: "browser",
    shellOverlay: "none",
    browserHome: true,
    recoveryReady: true,
    recoverable: [] as readonly ChatGptTaskJournalRecord[],
    pendingReadonly: null as object | null,
    pendingAttachment: null as object | null,
    recoverableTask: null as object | null,
    connectorStart: null as Promise<void> | null,
    fenceAdmissible: true,
    runtimeUncertain: false,
    conversationFailure: null as unknown,
    pageVisible: true,
    bindingCurrent: true,
    appName: "Farol" as string | null,
    attachment: {
      challengeSha256: "c".repeat(64),
      workspaceId: null,
    } as { challengeSha256: string; workspaceId: string | null } | null,
    leaseRefused: false,
    workspaceSelection: null as string | null | undefined,
    targetValid: true,
    binding: { buildId: fixtureBuildId, connectorGeneration: "1" },
    tunnelObservation: null as unknown,
    running: true,
    unresolvedEffect: false,
    backendAvailable: true,
  };
  const events: string[] = [];
  const recordSecureMcpChallenge = vi.fn(async (): Promise<unknown> => {
    events.push("challenge");
    return { ok: false, error: "SETTINGS_UNAVAILABLE" };
  });
  const owner = {
    snapshot: () => state.snapshot,
    recordSecureMcpChallenge,
  };
  const core = {
    get backendAvailable() {
      return state.backendAvailable;
    },
    currentComputerConnectorBinding: () => state.binding,
  };
  const connector = {
    isRunning: () => state.running,
    hasUnresolvedEffect: () => state.unresolvedEffect,
    getTunnelObservation: () => state.tunnelObservation,
  };
  const send = vi.fn<(prompt: string) => void>();
  const route = {
    captureManualTaskTarget: vi.fn(() => () => state.targetValid),
    runReadonlyTask: vi.fn(
      async (
        _prompt: string,
        _attachments: readonly unknown[],
        observer: DeepObserver,
      ): Promise<DeepRouteResult> => {
        await observer.onDispatchIntent();
        if (!observer.beforeSend())
          return {
            state: "failed_before_submit",
            code: "CHATGPT_SUBMIT_UNAVAILABLE",
            deltaCount: 0,
            observedCharacters: 0,
          };
        send(_prompt);
        return sendRequested;
      },
    ),
  };
  state.owner = owner;
  state.core = core;
  state.connector = connector;
  state.route = route;

  const admission = new DesktopAdmission({
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => false,
    hostCheck: () => false,
    connectorStart: () => false,
  });
  const registry = {
    withPromotionLease: async (
      work: (fence: () => Promise<void>) => Promise<unknown>,
    ) => {
      events.push("lease");
      if (state.leaseRefused) return { ok: false };
      return { ok: true, value: await work(async () => {}) };
    },
  };

  const bindingCurrent = vi.fn(
    (_settings: unknown, _expected: unknown) => state.bindingCurrent,
  );
  const ports = scriptedDeepPorts({
    configuration: () => state.owner as never,
    desktopGoCore: () => state.core as never,
    secureMcpConnectorRuntime: () => state.connector as never,
    chatGptRoute: () => state.route as never,
    liveTaskRoutes: state.liveRoutes as never,
    selectedTaskId: () => state.selectedTaskId,
    section: () => state.section,
    shellOverlay: () => state.shellOverlay,
    browserHomeSurfaceOpen: () => state.browserHome,
    setBrowserHomeSurfaceOpen: (value) => {
      state.browserHome = value;
    },
    deepTestRecoveryReady: () => state.recoveryReady,
    setDeepTestRecoveryReady: (value) => {
      state.recoveryReady = value;
    },
    recoverableDeepTests: () => state.recoverable,
    setRecoverableDeepTests: (value) => {
      state.recoverable = value;
    },
    pendingChatGptReadonlyTask: () => state.pendingReadonly,
    pendingChatGptAttachmentTask: () => state.pendingAttachment,
    recoverableChatGptTask: () => state.recoverableTask,
    connectorStartInFlight: () => state.connectorStart,
    summaryFenceRecovery: () => null,
    desktopAdmission: admission,
    liveTaskRegistry: registry as never,
    buildIdentity: { buildId: fixtureBuildId },
    statePaths: () => ({ state: stateRoot }),
    configurationFailure: ((error: string) => ({ ok: false, error })) as never,
    chatGptConversationAdmissionFailure: () =>
      state.conversationFailure as never,
    currentSurfaceLayout: () => ({ pageVisible: state.pageVisible }),
    connectorRuntimeUncertain: (() => state.runtimeUncertain) as never,
    computerConnectorAdmission: (() => ({
      admissible: state.fenceAdmissible,
    })) as never,
    currentConnectorAttachment: (() => state.attachment) as never,
    selectedConnectorApp: (() => state.appName) as never,
    connectorWorkspaceSelection: (() => state.workspaceSelection) as never,
    connectorAppBindingCurrent: bindingCurrent,
  });
  const deep = createConfigurationDeep(ports);

  const journal = (operationId: string): PrivateChatGptTaskJournal =>
    new PrivateChatGptTaskJournal({
      root: stateRoot,
      deepTestOperationId: operationId,
    });
  const run = (
    id: string = randomUUID(),
    taskId = "",
    test?: "connection" | "deep",
  ) =>
    deep.runManualDeepTest(id, taskId, test) as Promise<unknown> as Promise<{
      ok: boolean;
      error?: string;
      evidence?: { kind: string; state?: string; code?: string | null };
    }>;
  return {
    root,
    stateRoot,
    state,
    settings,
    events,
    owner,
    route,
    send,
    admission,
    deep,
    journal,
    run,
    recordSecureMcpChallenge,
    bindingCurrent,
  };
}

export type DeepFixture = Awaited<ReturnType<typeof deepFixture>>;
