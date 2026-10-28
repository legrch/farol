import type { UpdatesProjection } from "../../../apps/desktop/renderer/updates/contract";
import type { OperationEntry } from "../../../apps/desktop/renderer/operations-contract";
import type { ConnectionStatusView } from "../../../apps/desktop/renderer/connection-status";
import type { NavigationShortcuts } from "../../pkg/ipc/navigation-shortcuts";
import type { AgentDraftStore } from "../agent-draft";
import type { ConversationDraftStore } from "./conversation-draft";
import type { ConnectorSetupReceipt } from "../../pkg/product-settings/connector-setup-receipt";
import type {
  ProductConfigurationCommand,
  ProductConfigurationEvidence,
  ProductConfigurationSnapshot,
} from "../../pkg/product-settings/contract";
import type {
  ProductTaskCommand,
  ProductTasksState,
} from "../../modules/chat/contract/product-task";
import type {
  InstalledUpdateCommand,
  InstalledUpdateView,
} from "../../modules/release/contract/installed-update";
import type { WindowState } from "../../pkg/ipc/shell-state";
import type {
  ChatHistoryContext,
  ChatHistoryQuery,
  ChatHistoryReply,
} from "../../pkg/ipc/chat-history";

/** F0 is a window-local presentation facade, not the Desktop/Core wire API. */
export type PreloadApi = Readonly<{
  openUpdates?(): void;
  publishUpdates?(value: UpdatesProjection): void;
  onUpdatesCommand?(listener: (value: unknown) => void): () => void;
  settleUpdates?(value: { sequence: number }): void;
  operations?(): Promise<unknown>;
  bootstrap(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  configure(command: ProductConfigurationCommand): Promise<unknown>;
  chatHistory?(request: unknown): Promise<unknown>;
  retiredReplies?(request: unknown): Promise<unknown>;
  task(command: ProductTaskCommand): Promise<unknown>;
  installedUpdate(
    command: InstalledUpdateCommand,
    operationId?: string,
  ): Promise<unknown>;
  settleUpdateDirect?(settlement: {
    operationId: string;
    outcome: "applied" | "refused" | "unknown";
  }): void;
  setNavigationShortcuts(shortcuts: unknown): Promise<unknown>;
  layout(
    section: string,
    taskId: string,
    setupOpen: boolean,
    feedback: boolean,
    sidebar: string,
    overlay: string,
    sidebarWidth?: number,
  ): void;
  onConfigurationChanged(listener: () => void): () => void;
  onTasksState(listener: (value: unknown) => void): () => void;
  onRuntimeEvent(listener: (value: unknown) => void): () => void;
  onConnectionStatus?(listener: (value: unknown) => void): () => void;
  onRuntimeState(listener: (value: unknown) => void): () => void;
  onInstalledUpdateState(listener: (value: unknown) => void): () => void;
  onBrowserRouteState(listener: (value: unknown) => void): () => void;
  browserHistory?(request: {
    taskId: string;
    direction: -1 | 1;
  }): Promise<unknown>;
  onBrowserHistoryState?(listener: (value: unknown) => void): () => void;
  onTaskSurfaceState(listener: (value: unknown) => void): () => void;
  onLayout(listener: (value: unknown) => void): () => void;
  onShellAction(listener: (value: unknown) => void): () => void;
  onWindowState(listener: (value: unknown) => void): () => void;
}>;
import type {
  SettingsPage,
  SetupStep,
  HomeView,
  NavigationArea,
  Sheet,
} from "../../../apps/desktop/renderer/navigation-destinations";
export type {
  SettingsPage,
  SetupStep,
  HomeView,
} from "../../../apps/desktop/renderer/navigation-destinations";
export type Destination = Readonly<{
  area: NavigationArea;
  page: SettingsPage;
  taskId: string;
  homeView?: HomeView;
  homeSelection?: Readonly<{
    kind: "task" | "activity" | "attention";
    id: string;
    turnId?: string;
  }> | null;
  setupStep?: SetupStep;
  /** Window-local return path for the explicitly started connection check. */
  connectionCheckReturn?: true;
  activityId?: string | null;
  /** Workspace presentation selection only; never an active Computer binding. */
  workspaceId?: string | null;
}>;
export type UpdateAction =
  | "check"
  | "download"
  | "skip"
  | "later"
  | "restart"
  | "restart-confirmed"
  /** Retained only to classify stale renderer intent as a local refusal. */
  | "recover"
  | "rollback"
  | "notice-seen";
export type Intent = Readonly<{
  id: string;
  state: "pending" | "applied" | "refused" | "unknown";
  code: string | null;
  /** Current dispatcher promise only; not a settlement or authority receipt. */
  inFlight?: true;
  /** UI access observation; the original transport outcome is preserved. */
  workspaceReadback?: Readonly<{
    requestId: number;
    originalCode: string | null;
  }>;
  /** Original command progress, independent of ambient snapshot ordering. */
  connectorSetup?: ConnectorSetupReceipt;
  /** This explicit check's result, never a current-document or account grant. */
  chatGptReadiness?: Extract<
    ProductConfigurationEvidence,
    { kind: "chatgpt.readiness" }
  >;
  connectorAttempt?: Readonly<{
    method: "computer.connector.open";
    requestId: string;
    operationId: string;
    outcome: "known" | "unknown";
  }>;
}>;
export type ActivityEntry = Readonly<{
  /** Current host writer still owns this exact lifecycle; not durable proof. */
  inFlight?: true;
  lifecycle?: OperationEntry["lifecycle"];
  source?: OperationEntry["source"];
  outcome?: OperationEntry["outcome"];
  target?: OperationEntry["target"];
  durationMs?: number;
  id: string;
  taskId: string;
  turnId: string;
  generation: number;
  label: string;
  kind: string;
  at: number;
  phase: string | null;
  operation: string | null;
  code: string | null;
}>;
export type Appearance = Readonly<{
  theme: "light" | "graphite" | "system";
  accent: "iris" | "cobalt" | "amber";
  font: "geist" | "system";
}>;
/** Transient content-free read; never an effect receipt or saved readiness. */
export type SignInObservation = Readonly<{
  observationId: string;
  buildId: string;
  counter: number;
  pending: boolean;
  state: "authenticated" | "signed_out" | "unknown";
  binding: Extract<
    ProductConfigurationEvidence,
    { kind: "chatgpt.sign-in-status" }
  >["binding"];
}>;
export type WindowSnapshot = Readonly<{
  status: "starting" | "current" | "stale" | "unavailable" | "incompatible";
  environment: "preview" | "dev" | "owner-preview";
  buildId: string | null;
  installedVersion: Readonly<{
    version: string;
    buildVersion: string | null;
  }> | null;
  configuration: ProductConfigurationSnapshot | null;
  tasks: ProductTasksState;
  activity: readonly ActivityEntry[];
  /** Current host work, independent of journal reads; never connection proof. */
  connectionChecking?: boolean;
  activityDiagnostics?: Readonly<{
    readPending?: boolean;
    corruptLines: number;
    writeFailures: number;
    droppedEntries?: number;
    unrecordedUncertainEntries?: number;
    unmappedCodes?: number;
  }>;
  runtime: "starting" | "ready" | "offline" | "failed";
  independentSession?: boolean;
  connectionStatus?: ConnectionStatusView;
  route: "loading" | "loaded" | "failed";
  signInObservation: SignInObservation | null;
  /** Presentation context only; never evidence that sign-in succeeded. */
  setupSignInReturn?: Destination | null;
  /** Window-owned explicit check, bound to the authenticated document sample. */
  setupSignInCheck?: Readonly<{
    buildId: string;
    binding: NonNullable<SignInObservation["binding"]>;
  }> | null;
  update: InstalledUpdateView;
  intents: Readonly<Record<string, Intent>>;
  /** Window-local attempt order; historical refusals cannot override a newer check. */
  setupCheckOrder?: Readonly<Record<string, number>>;
  shortcuts: NavigationShortcuts;
  workspaceEditDelivery: string | null;
  readConversation:
    import("./read-conversation-state").ReadConversationState | null;
  directChatPreview: Readonly<{
    intention: string;
    buildId: string;
    revision: number;
    value: Extract<
      ProductConfigurationEvidence,
      { kind: "chatgpt.chat-account-preview" }
    >;
  }> | null;
  setupReturn?: Destination | null;
  chatHistoryContext: ChatHistoryContext | null;
  /** Local invalidation counter, not a backend revision or restored authority. */
  chatHistoryEpoch: number;
  /** Window-retained command receipt; not backend recovery or Send authority. */
  readPreview: Readonly<{
    prepareIntention: string;
    evidenceIntention: string;
    buildId: string;
    revision: number;
    value: Extract<
      ProductConfigurationEvidence,
      { kind: "chatgpt.readonly-task-preview" }
    >;
  }> | null;
  evidence: Readonly<{
    revision: number;
    value: ProductConfigurationEvidence;
  }> | null;
  destination: Destination;
  back: boolean;
  forward: boolean;
  browserHistory?: Readonly<{
    taskId: string;
    back: boolean;
    forward: boolean;
  }>;
  sidebar: "full" | "rail" | "overlay";
  overlay: "none" | Sheet;
  window: WindowState;
  appearance: Appearance;
  /** Legacy has no authenticated generation/sequence or general operation query. */
  capabilities: Readonly<{
    incarnation: false;
    sequence: false;
    operationQuery: "workspace-edit-only";
    overlayAcknowledgement: false;
  }>;
}>;
/** Request-owned native bootstrap result; cached presentation never creates one. */
export type NativeRefreshResult =
  | Readonly<{
      status: "adopted";
      requestId: number;
      buildId: string;
      computerId: string;
      generation: number;
      configuration: Extract<ProductConfigurationSnapshot, { status: "ready" }>;
      evidence: null;
    }>
  | Readonly<{
      status: "unqualified";
      reason:
        | "superseded"
        | "disposed"
        | "malformed"
        | "transport-unknown"
        | "incompatible"
        | "not-current"
        | "not-adopted";
    }>;
export interface RendererFacade {
  readonly draft: AgentDraftStore;
  readonly conversationDraft: ConversationDraftStore;
  getSnapshot(): WindowSnapshot;
  subscribe(listener: () => void): () => void;
  configure(
    command: ProductConfigurationCommand,
    intention: string,
  ): Promise<Intent>;
  task(command: ProductTaskCommand, intention: string): Promise<Intent>;
  update(action: UpdateAction, noticeKey?: string): Promise<Intent>;
  setAutomaticDownloads(enabled: boolean): Promise<Intent>;
  observeWorkspaceEdit(operationId: string): Promise<Intent>;
  acknowledgeWorkspaceEdit(operationId: string): Promise<Intent>;
  shortcuts(value: NavigationShortcuts): Promise<Intent>;
  refresh(): Promise<void>;
  refreshSignInStatus?(): void;
  refreshReadback?(): Promise<NativeRefreshResult>;
  reconcileWorkspaceReadback?(
    receipt: NativeRefreshResult,
    intention: string,
    pending: import("../guided-workspace-access").WorkspaceReadbackBinding,
  ): Intent | null;
  readChatHistory(query: ChatHistoryQuery): Promise<ChatHistoryReply>;
  readRetiredReplies?(query: unknown): Promise<unknown>;
  navigate(destination: Partial<Destination>): void;
  travel(direction: -1 | 1): void;
  toggleSidebar(compact: boolean): void;
  overlay(kind: WindowSnapshot["overlay"]): void;
  dismissOverlay(): void;
  appearance(value: Appearance): void;
  returnToSetup(): void;
  presentation(): void;
}
