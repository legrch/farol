import path from "node:path";
import type { BrowserWindow, NativeImage } from "electron";
import type {
  ChatGptRoute,
  ChatGptSignInBlockLedger,
  ChatGptSignInOutcomeDiagnostic,
} from "../../../src/apps/desktop/chatgpt-route";
import type { ChatGptTaskJournalRecord } from "../../../src/apps/desktop/chatgpt-task-journal";
import type { readRuntimeBuildIdentity } from "../../../src/apps/desktop/build-identity";
import type { e2eBudget } from "../../../src/apps/desktop/configuration-reply-fault";
import type { DesktopIdentity } from "../../../src/apps/desktop/desktop-environment";
import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import { channels } from "../../../src/pkg/ipc/channels";
import type { RuntimeStatus } from "../../../src/pkg/ipc/runtime-status";
import type { CredentialRecovery } from "../../../src/pkg/product-settings/connector-uncertainty";
import type { WindowState } from "../../../src/pkg/ipc/shell-state";
import type { DesktopGoCore } from "../go-core-host";

// The renderer's runtime status: the base address of the local runtime, the
// bootstrap payload the renderer reads once at load, the status event, the
// product mark and the one authenticated call into the runtime. Main keeps
// every owner: each `let` there is a late getter here, read afresh at every
// call, and the const owners are shared by reference. Nothing in this module
// holds state of its own or assigns any of main's, so no cell is needed. The
// payload keeps every field and its order.

type RuntimeReady = Readonly<{
  port: number;
  token: string;
  identity: NonNullable<RuntimeStatus["identity"]>;
  embeddedNode: string;
  embeddedElectron: string;
}>;

export type RuntimeStatusPorts = Readonly<{
  runtime: () => RuntimeReady | null;
  runtimeState: () => RuntimeStatus["state"];
  runtimeError: () => string | null;
  window: () => Pick<BrowserWindow, "webContents"> | null;
  desktopGoCore: () => Pick<
    DesktopGoCore,
    "historyContext" | "limitedSession"
  > | null;
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  selectedTaskId: () => string;
  chatGptRoute: () => Pick<
    ChatGptRoute,
    "loadState" | "navigationHistory"
  > | null;
  liveTaskRoutes: ReadonlyMap<string, Pick<ChatGptRoute, "navigationHistory">>;
  recoverableChatGptTask: () => ChatGptTaskJournalRecord | null;
  chatGptSignInOutcome: () => ChatGptSignInOutcomeDiagnostic | null;
  chatGptSignInBlocked: Pick<ChatGptSignInBlockLedger, "current">;
  nativeImage: Readonly<{ createFromPath: (file: string) => NativeImage }>;
  fetch: (
    input: string,
    init: RequestInit,
  ) => Promise<Pick<Response, "status" | "ok" | "json">>;
  directory: string;
  env: Readonly<Record<string, string | undefined>>;
  versions: Readonly<{ electron: string }>;
  productName: string;
  bundleId: string;
  activeDesktopIdentity: DesktopIdentity;
  buildIdentity: ReturnType<typeof readRuntimeBuildIdentity>;
  demoMode: boolean;
  legacySetupTestMode: boolean;
  compiledGoCore: unknown;
  WORKSPACE_EDIT_ACK_HOLD_ENV: string;
  WORKSPACE_EDIT_ACK_HOLD_INVALID: string;
  e2eBudget: typeof e2eBudget;
  productTasksState: () => ReturnType<LiveTaskRegistry["snapshot"]>;
  currentConnectionStatus: () => unknown;
  /** The fenced document main can still settle, or null; read afresh. */
  credentialRecovery: () => CredentialRecovery | null;
  chatGptConversationState: () => unknown;
  productAgentCapabilityAvailable: () => boolean;
  currentWindowState: () => WindowState;
}>;

export function createRuntimeStatus(ports: RuntimeStatusPorts) {
  const {
    runtime,
    runtimeState,
    runtimeError,
    window,
    desktopGoCore,
    configuration,
    selectedTaskId,
    chatGptRoute,
    liveTaskRoutes,
    recoverableChatGptTask,
    chatGptSignInOutcome,
    chatGptSignInBlocked,
    nativeImage,
    fetch,
    directory,
    env,
    versions,
    productName,
    bundleId,
    activeDesktopIdentity,
    buildIdentity,
    demoMode,
    legacySetupTestMode,
    compiledGoCore,
    WORKSPACE_EDIT_ACK_HOLD_ENV,
    WORKSPACE_EDIT_ACK_HOLD_INVALID,
    e2eBudget,
    productTasksState,
    currentConnectionStatus,
    credentialRecovery,
    chatGptConversationState,
    productAgentCapabilityAvailable,
    currentWindowState,
  } = ports;

  function runtimeBase(): string | null {
    const ready = runtime();
    return ready ? `http://127.0.0.1:${ready.port}` : null;
  }

  function bootstrap() {
    const taskState = productTasksState();
    return {
      schema: 3,
      chatHistoryContext: desktopGoCore()?.historyContext ?? null,
      productName,
      bundleId,
      environment: activeDesktopIdentity.environment,
      displayName: activeDesktopIdentity.displayName,
      displayEdition: activeDesktopIdentity.displayEdition,
      applicationId: activeDesktopIdentity.applicationId,
      build: buildIdentity,
      demoMode,
      legacySetupTestMode,
      configuration: configuration()?.snapshot() ?? {
        status: "error",
        error: "SETTINGS_READ_FAILED",
      },
      runtimeState: runtimeState(),
      independentSession: desktopGoCore()?.limitedSession === true,
      browserRouteState:
        selectedTaskId() === ""
          ? { state: chatGptRoute()?.loadState() ?? "loading" }
          : undefined,
      browserHistoryState: {
        taskId: selectedTaskId(),
        back: false,
        forward: false,
        ...(selectedTaskId() === ""
          ? chatGptRoute()
          : liveTaskRoutes.get(selectedTaskId())
        )?.navigationHistory(),
      },
      connectionStatus: currentConnectionStatus(),
      credentialRecovery: credentialRecovery(),
      runtimeError: runtimeError(),
      runtimeIdentity: runtime()?.identity ?? null,
      embeddedNode: runtime()?.embeddedNode ?? null,
      embeddedElectron: runtime()?.embeddedElectron ?? versions.electron,
      taskRevision: taskState.revision,
      tasks: taskState.tasks,
      selectedTaskId: selectedTaskId(),
      partition: activeDesktopIdentity.runtimePartition,
      chatgptPartition: activeDesktopIdentity.chatGptPartition,
      chatgptRecoveryPending: recoverableChatGptTask() !== null,
      chatgptConversationState: chatGptConversationState(),
      updateChannel: buildIdentity.updateChannel,
      nativeFilesystem: true,
      nativeAgent: productAgentCapabilityAvailable(),
      // The fixed Git verifiers exist only in the explicit legacy build.
      gitVerificationAvailable: compiledGoCore === null,
      liveProvider: false,
      windowState: currentWindowState(),
      chatgptSignInBlocked: chatGptSignInBlocked.current(),
      chatgptSignInOutcome: chatGptSignInOutcome(),
      // The renderer cannot read this process's environment, and one E2E
      // scenario needs it to: the acknowledgement of a guarded edit is sent
      // from the renderer, so only the renderer can fail to send it. This is
      // the one number that seam needs, under the same double gate as the
      // reply fault, and it is null in every production build because the
      // lane variable is unset. It carries no authority and names nothing
      // else. See configuration-reply-fault.ts for the family.
      e2eWorkspaceEditAckHold: e2eBudget(
        env,
        WORKSPACE_EDIT_ACK_HOLD_ENV,
        WORKSPACE_EDIT_ACK_HOLD_INVALID,
      ),
    };
  }

  function currentRuntimeStatus(): RuntimeStatus {
    return {
      state: runtimeState(),
      error: runtimeError(),
      identity: runtime()?.identity ?? null,
      embeddedNode: runtime()?.embeddedNode ?? null,
      embeddedElectron: runtime()?.embeddedElectron ?? versions.electron,
    };
  }

  function publishRuntimeStatus(): void {
    window()?.webContents.send(channels.runtimeState, currentRuntimeStatus());
  }

  function desktopBrandImage() {
    const icon = nativeImage.createFromPath(
      path.join(
        directory,
        activeDesktopIdentity.environment === "dev"
          ? "farol-dev-mark.png"
          : activeDesktopIdentity.environment === "owner-preview"
            ? "farol-preview-mark.png"
            : "farol-mark.png",
      ),
    );
    if (icon.isEmpty()) throw new Error("DESKTOP_BRAND_IMAGE_INVALID");
    return icon;
  }

  async function runtimeJson(
    pathname: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const ready = runtime();
    if (!ready) return { error: "RUNTIME_OFFLINE" };
    const options: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${ready.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(
      `http://127.0.0.1:${ready.port}${pathname}`,
      options,
    );
    if (response.status === 204) return { ok: true };
    const value = (await response.json()) as unknown;
    return response.ok ? value : { ok: false, status: response.status, value };
  }

  return {
    runtimeBase,
    bootstrap,
    currentRuntimeStatus,
    publishRuntimeStatus,
    desktopBrandImage,
    runtimeJson,
  };
}
