import type { NavigationShortcuts } from "../../pkg/ipc/navigation-shortcuts";
import type { AgentDraftStore } from "../agent-draft";
import type { ConversationDraftStore } from "./conversation-draft";
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
  bootstrap(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  configure(command: ProductConfigurationCommand): Promise<unknown>;
  chatHistory?(request: unknown): Promise<unknown>;
  task(command: ProductTaskCommand): Promise<unknown>;
  installedUpdate(command: InstalledUpdateCommand): Promise<unknown>;
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
  onRuntimeState(listener: (value: unknown) => void): () => void;
  onInstalledUpdateState(listener: (value: unknown) => void): () => void;
  onBrowserRouteState(listener: (value: unknown) => void): () => void;
  onTaskSurfaceState(listener: (value: unknown) => void): () => void;
  onLayout(listener: (value: unknown) => void): () => void;
  onShellAction(listener: (value: unknown) => void): () => void;
  onWindowState(listener: (value: unknown) => void): () => void;
}>;
export type SettingsPage =
  | "general"
  | "appearance"
  | "folders"
  | "computer"
  | "connection"
  | "model"
  | "shortcuts"
  | "updates"
  | "diagnostics";
export type Destination = Readonly<{
  area: "home" | "chatgpt" | "activity" | "setup" | "settings";
  page: SettingsPage;
  taskId: string;
  homeView?: HomeView;
  homeSelection?: Readonly<{
    kind: "task" | "activity" | "attention";
    id: string;
    turnId?: string;
  }> | null;
  setupStep?: SetupStep;
  activityId?: string | null;
}>;
export type HomeView =
  "overview" | "work" | "attention" | "activity" | "access";
export type SetupStep =
  "overview" | "folders" | "connection" | "attachment" | "finish";
export type UpdateAction =
  | "check"
  | "download"
  | "skip"
  | "later"
  | "restart"
  | "recover"
  | "rollback"
  | "notice-seen";
export type Intent = Readonly<{
  id: string;
  state: "pending" | "applied" | "refused" | "unknown";
  code: string | null;
}>;
export type ActivityEntry = Readonly<{
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
export type WindowSnapshot = Readonly<{
  status: "starting" | "current" | "stale" | "unavailable" | "incompatible";
  environment: "preview" | "dev";
  buildId: string | null;
  installedVersion: Readonly<{
    version: string;
    buildVersion: string | null;
  }> | null;
  configuration: ProductConfigurationSnapshot | null;
  tasks: ProductTasksState;
  activity: readonly ActivityEntry[];
  runtime: "starting" | "ready" | "offline" | "failed";
  route: "loading" | "loaded" | "failed";
  update: InstalledUpdateView;
  intents: Readonly<Record<string, Intent>>;
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
  sidebar: "full" | "rail" | "overlay";
  /** Window-local geometry; not a saved configuration setting. */
  sidebarWidth: number;
  sidebarResizing: boolean;
  overlay: "none" | "search" | "task" | "update" | "activity";
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
  readChatHistory(query: ChatHistoryQuery): Promise<ChatHistoryReply>;
  navigate(destination: Partial<Destination>): void;
  travel(direction: -1 | 1): void;
  toggleSidebar(compact: boolean): void;
  resizeSidebar(width: number, active: boolean): void;
  overlay(kind: WindowSnapshot["overlay"]): void;
  dismissOverlay(): void;
  appearance(value: Appearance): void;
  presentation(): void;
}
