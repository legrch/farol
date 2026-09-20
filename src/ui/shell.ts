import { z } from "zod";
import {
  ClientEventSchema,
  type ClientEventDto,
} from "../modules/chat/contract/client-event";
import {
  ProductAgentScopeSelectionSchema,
  ProductTaskCommandResultSchema,
  ProductTaskSchema,
  ProductTasksStateSchema,
  type ProductAgentScopeSelection,
  type ProductTaskCommand,
  type ProductTasksState,
} from "../modules/chat/contract/product-task";
import {
  RuntimeStatusSchema,
  type RuntimeStatus,
} from "../pkg/ipc/runtime-status";
import { BuildIdentitySchema } from "../pkg/build-info/identity";
import {
  ShellActionSchema,
  ShellLayoutSchema,
  WindowStateSchema,
  type ShellOverlay,
  type SidebarMode,
  type SurfaceSection,
  type WindowState,
} from "../pkg/ipc/shell-state";
import {
  TaskSurfaceStatusSchema,
  type TaskSurfaceStatus,
} from "../pkg/ipc/task-surface-status";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationResultSchema,
  ProductConfigurationSnapshotSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationEvidence,
  type ProductDiscoveryCandidate,
} from "../pkg/product-settings/contract";
import {
  advanceSetup,
  createSetupJourney,
  reopenSetup,
  retreatSetup,
  setupSteps,
} from "./setup-journey";
import { contextTaskPresentation } from "./context-task-presentation";
import { searchMatchDisplay } from "./computer-presentation";
import {
  modelDisconnectedReadiness,
  modelDisconnectedSummary,
  modelEvidenceAbsenceAfterFailure,
  type ModelEvidenceAbsence,
} from "./model-presentation";
import {
  workspaceEditRefusalMessage,
  workspaceEditToAcknowledge,
} from "./workspace-edit-delivery";
import { ActivityLog, projectActivity } from "./activity-log";
import { captureInputDraft, restoreInputDraft } from "./input-draft";
import {
  agentRouteReadiness,
  readinessDetail,
  readinessLabel,
  routeReadiness,
  waitsForAgentRejoin,
  windowModeLabel,
  workspaceAccessLabel,
  type RouteReadinessState,
} from "./setup-presentation";
import {
  SETUP_MEDIA_MANIFEST,
  findSetupMediaSlot,
  shouldRenderClip,
  type SetupMediaSlotId,
} from "./setup-media";
import {
  classifyConfigurationResponse,
  UNCONFIRMED_CONFIGURATION_MESSAGE,
  type ConfigurationTransport,
} from "./configuration-outcome";
import { sidebarToggleLeft } from "./window-chrome-geometry";

// Refusals that name a transition in progress or an open review finding,
// so the owner sees why an action is unavailable instead of an error code.
function transitionRefusalMessage(error: string): string | null {
  if (error === "AUTHORITY_CHANGE_IN_PROGRESS") {
    return "Another change to Computer access, a connector start or an Agent start is in progress. Try again when it has finished.";
  }
  // The main process reports several native-gate refusals as this one
  // product code (an unsupported request shape, a sandbox that could not be
  // applied, or an executable that failed its own trust check). Git checks
  // run for real now (N02): this message never claims they are off, only
  // that this particular attempt did not go through.
  if (error === "WORKSPACE_COMMAND_UNAVAILABLE") {
    return "This Git check could not run right now. Listing, searching and reading files are not affected; try the Git check again.";
  }
  return null;
}

// `bootstrap.productName` carries the release identity the main process
// validates elsewhere ("Farol Next Preview"); the diagnostics row below
// only names the app to the owner, so it reads "Farol" with its
// "Developer Preview" edition mark, matching the window title and the
// brand mark in shell.html.
const DISPLAY_PRODUCT_NAME = "Farol";
const DISPLAY_EDITION = "Developer Preview";

// Independently declared, not imported: `ui` never imports from
// `apps/desktop` (architecture.config enforces it), so this mirrors
// `ChatGptSignInBlockedDiagnostic` in chatgpt-route.ts by shape rather
// than by reference — the same pattern `chatgptPartition` below already
// uses for a literal owned there.
const chatGptSignInBlockedSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("navigation-blocked"),
      host: z.string(),
    }),
    z.strictObject({ kind: z.literal("popup-blocked"), host: z.string() }),
    z.strictObject({
      kind: z.literal("permission-denied"),
      permission: z.string(),
    }),
    z.strictObject({ kind: z.literal("load-failed"), code: z.number() }),
  ])
  .nullable();

// Spelled out here rather than imported for the same reason the block
// schema above is: the renderer validates what it was handed, by value.
// Content-free by contract — a fixed reason token, the classified page
// state, a duration and which trigger started the read.
const chatGptSignInOutcomeSchema = z
  .strictObject({
    reason: z.enum([
      "answered",
      "timeout",
      "no-window",
      "load-failed",
      "url-unsupported",
      "probe-unrecognized",
      "probe-threw",
    ]),
    state: z
      .enum(["authenticated", "signed_out", "unreachable", "unsupported"])
      .nullable(),
    elapsedMs: z.number().int().nonnegative(),
    readStartedBy: z.enum(["return", "closing"]),
  })
  .nullable();

function chatGptSignInBlockedMessage(
  diagnostic: NonNullable<z.infer<typeof chatGptSignInBlockedSchema>>,
): string {
  switch (diagnostic.kind) {
    case "navigation-blocked":
      return `Sign-in was blocked at ${diagnostic.host}… Farol only follows this provider's own sign-in and MFA domains.`;
    case "popup-blocked":
      return `Sign-in was blocked: a popup to ${diagnostic.host} was not allowed to open.`;
    case "permission-denied":
      return `Sign-in was blocked: the "${diagnostic.permission}" permission was refused.`;
    case "load-failed":
      return `Sign-in was blocked: the page failed to load (code ${diagnostic.code}).`;
  }
}

const bootstrapSchema = z.strictObject({
  schema: z.literal(3),
  productName: z.literal("Farol Next Preview"),
  bundleId: z.literal("local.farol.next.preview"),
  build: BuildIdentitySchema,
  demoMode: z.boolean(),
  configuration: ProductConfigurationSnapshotSchema,
  runtimeState: z.enum(["starting", "ready", "offline", "failed"]),
  runtimeError: z.string().nullable(),
  runtimeIdentity: z.string().nullable(),
  embeddedNode: z.string().nullable(),
  embeddedElectron: z.string().nullable(),
  taskRevision: z.number().int().nonnegative(),
  tasks: z.array(ProductTaskSchema).max(5),
  partition: z.string(),
  chatgptPartition: z.literal("persist:farol-next-chatgpt"),
  chatgptRecoveryPending: z.boolean(),
  chatgptConversationState: z.enum([
    "new",
    "retained",
    "review_required",
    "unavailable",
  ]),
  updateChannel: z.literal("local-preview-only"),
  nativeFilesystem: z.literal(true),
  nativeAgent: z.boolean(),
  liveProvider: z.literal(false),
  windowState: WindowStateSchema,
  chatgptSignInBlocked: chatGptSignInBlockedSchema,
  chatgptSignInOutcome: chatGptSignInOutcomeSchema,
});

const controlSuccessSchema = z.strictObject({ ok: z.literal(true) });

type Bootstrap = z.infer<typeof bootstrapSchema>;
type PreviewTask = Bootstrap["tasks"][number];
type ReadySettings = Extract<
  Bootstrap["configuration"],
  { status: "ready" }
>["settings"];
type Readiness = ReadySettings["setup"]["chatgpt"];
type TaskTone =
  | "connecting"
  | "running"
  | "waiting"
  | "complete"
  | "failed"
  | "unknown"
  | "unavailable";
type TaskState = Readonly<{
  tone: TaskTone;
  label: string;
  attention: boolean;
}>;
const sections: readonly SurfaceSection[] = [
  "browser",
  "computer",
  "activity",
  "settings",
];

const phaseLabels: Readonly<Record<string, string>> = {
  prepared: "Prepared",
  submit_activated: "Submitting",
  running: "Running",
  tool_wait: "Awaiting approval",
  completed: "Complete",
  cancelled: "Cancelled",
  failed: "Failed",
  outcome_unknown: "Outcome unknown",
};

const activityLabels: Readonly<Record<string, string>> = {
  "turn.phase": "Turn state changed",
  "text.delta": "Response fragment received",
  "computer.requested": "Computer approval requested",
  "computer.completed": "Computer result returned",
  "client.delivery_acknowledged": "Client delivery acknowledged",
  "turn.terminal": "Turn finished",
};

declare global {
  interface Window {
    farolNext: Readonly<{
      bootstrap(): Promise<unknown>;
      snapshot(): Promise<unknown>;
      configure(command: unknown): Promise<unknown>;
      task(command: unknown): Promise<unknown>;
      control(taskId: string, action: string): Promise<unknown>;
      layout(
        section: string,
        taskId: string,
        setupOpen: boolean,
        sidebar: string,
        overlay: string,
      ): void;
      onRuntimeEvent(listener: (event: unknown) => void): () => void;
      onRuntimeState(listener: (status: unknown) => void): () => void;
      onTaskSurfaceState(listener: (status: unknown) => void): () => void;
      onTasksState(listener: (state: unknown) => void): () => void;
      onLayout(listener: (layout: unknown) => void): () => void;
      onShellAction(listener: (action: unknown) => void): () => void;
      onWindowState(listener: (state: unknown) => void): () => void;
    }>;
  }
}

const required = <ElementType extends Element>(
  selector: string,
): ElementType => {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`UI_ELEMENT_MISSING:${selector}`);
  return element;
};

const narrowSidebar = window.matchMedia("(max-width: 979px)");

let bootstrap: Bootstrap;
let bootstrapReady = false;
let section: SurfaceSection = "browser";
let selectedTaskId = "";
let setupJourney = createSetupJourney();
let setupFocusKey = "";
let sidebarPreference: Exclude<SidebarMode, "overlay"> = "full";
let sidebarOverlayOpen = false;
let shellOverlay: ShellOverlay = "none";
let renderedOverlay: ShellOverlay = "none";
let lastHostLayout = "";
let windowState: WindowState = {
  focused: false,
  fullScreen: false,
  trafficLightPosition: null,
};
let computerTargetTaskId: string | null = null;
let settingsFeedback = "";
let settingsFeedbackError = false;
let settingsFeedbackSurface: "computer" | "settings" | "setup" = "settings";
let taskAdmissionFeedback = "";
let taskMenuFeedback = "";
let taskMenuFeedbackError = false;
let taskMenuBusy = false;
let taskAgentDraftTaskId = "";
let chatGptSignInOpened = false;
let workspaceEvidence: Extract<
  ProductConfigurationEvidence,
  {
    kind:
      | "computer.workspace-read"
      | "computer.workspace-list"
      | "computer.workspace-search"
      | "computer.workspace-command"
      | "computer.workspace-edit-preview"
      | "computer.workspace-mutation";
  }
> | null = null;
let pendingChatGptPreview: Extract<
  ProductConfigurationEvidence,
  {
    kind: "chatgpt.readonly-task-preview" | "chatgpt.attachment-task-preview";
  }
> | null = null;
// Discovery replaces a blind file picker with a bounded, read-only scan the
// main process re-verifies before ever running a chosen candidate (see
// `reverifyDiscoveredCandidate` in main.ts). Results are cached here so the
// Setup dialog does not re-scan on every render; `discoveryRequested` marks
// that this session already asked once, `discoveryAdvancedOpen` tracks the
// per-step disclosure that reveals "Use anyway" and "Choose another…".
let discoveredCodexCandidates: Extract<
  ProductConfigurationEvidence,
  { kind: "host.codex-discovery" }
> | null = null;
let discoveredTunnelClientCandidates: Extract<
  ProductConfigurationEvidence,
  { kind: "connector.client-discovery" }
> | null = null;
let discoveryRequested: Record<"connect" | "hosts", boolean> = {
  connect: false,
  hosts: false,
};
let discoveryAdvancedOpen: Record<"connect" | "hosts", boolean> = {
  connect: false,
  hosts: false,
};
let contextPreviewBusy = false;
// Farol Model (Decisions.md N04/N04b): live endpoint status and the last
// config preview, both ephemeral evidence — never part of persisted
// settings. `modelConfigApplied` marks that the last preview's apply
// already ran (so the diff stays visible with a restart note instead of
// silently disappearing), and clears back to false on the next preview.
let modelStatusEvidence: Extract<
  ProductConfigurationEvidence,
  { kind: "model.status" }
> | null = null;
// Why there is no status evidence: never connected in this session, or an
// endpoint that stopped accepting requests. The card must not report the
// second as the first.
let modelEvidenceAbsence: ModelEvidenceAbsence = "no-evidence-yet";
let modelConfigPreviewEvidence: Extract<
  ProductConfigurationEvidence,
  { kind: "model.config-preview" }
> | null = null;
let modelSelectAsDefault = false;
let modelConfigApplied = false;
// From the last apply: whether a Codex started from the verified
// executable was running at that moment (read-only process-table scan).
let modelConfigCodexHost: "running" | "not_running" | "unknown" | null = null;
let renderedGeneralSettingsRevision = -1;
let setupConnectorError: string | null = null;
let renderedComputerSettingsRevision = -1;
let setupPrimaryAction: (() => Promise<void>) | null = null;
const taskEvents = new Map<string, ClientEventDto[]>();
const activity = new ActivityLog();
const pendingRuntimeEvents: ClientEventDto[] = [];
let pendingRuntimeStatus: RuntimeStatus | null = null;
const pendingTaskSurfaceStatuses: TaskSurfaceStatus[] = [];
let pendingTasksState: ProductTasksState | null = null;
let pendingLayout: z.infer<typeof ShellLayoutSchema> | null = null;
const taskSurfaceStatuses = new Map<string, TaskSurfaceStatus>();

function taskLabel(task: PreviewTask | undefined): string {
  return task?.label.replace(/^Demo · /u, "") ?? "Unknown task";
}

function renderCapability(
  selector: "#dossier-model" | "#dossier-mode",
  requested: string | null,
  observed: string | null,
): void {
  const element = required<HTMLElement>(selector);
  const compact = (value: string) =>
    value === "Account default" ? "Default" : value;
  element.textContent = observed
    ? compact(observed)
    : requested
      ? `${compact(requested)} · unknown`
      : "Not selected";
  const detail = `Requested: ${requested ?? "Not selected"} · Observed: ${observed ?? "Not observed"}`;
  element.title = detail;
  element.setAttribute("aria-label", detail);
}

function taskById(taskId: string): PreviewTask | undefined {
  return bootstrap.tasks.find((task) => task.taskId === taskId);
}

function unresolvedComputerRequest(taskId: string): ClientEventDto | null {
  const events = taskEvents.get(taskId) ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== "computer.requested") continue;
    const closed = events
      .slice(index + 1)
      .some(
        (candidate) =>
          candidate.kind === "computer.completed" ||
          candidate.kind === "turn.terminal",
      );
    return closed ? null : event;
  }
  return null;
}

function taskState(taskId: string): TaskState {
  if (bootstrap.runtimeState !== "ready") {
    return {
      tone: "unavailable",
      label: bootstrap.runtimeState === "failed" ? "Runtime failed" : "Offline",
      attention: true,
    };
  }
  if (taskSurfaceStatuses.get(taskId)?.state === "failed") {
    return { tone: "failed", label: "Surface failed", attention: true };
  }
  const task = taskById(taskId);
  if (task?.provider === "chatgpt") {
    if (task.agent?.phase === "running") {
      return task.agent.observation === "unavailable"
        ? { tone: "running", label: "Agent not observed", attention: true }
        : { tone: "running", label: "Agent running", attention: false };
    }
    if (
      task.agent?.phase === "completed" &&
      task.agent.parentDelivery === "pending"
    ) {
      return { tone: "waiting", label: "Agent result ready", attention: true };
    }
    if (task.agent?.phase === "outcome_unknown") {
      return {
        tone: "unknown",
        label: "Agent outcome unknown",
        attention: true,
      };
    }
    if (task.agent?.phase === "failed") {
      return { tone: "failed", label: "Agent failed", attention: true };
    }
    if (task.agent?.phase === "cancelled") {
      return { tone: "complete", label: "Agent cancelled", attention: false };
    }
    const context = contextTaskPresentation(task.context);
    if (context) return context;
    if (task.lifecycle === "running") {
      return { tone: "running", label: "Running", attention: false };
    }
    if (task.lifecycle === "completed") {
      return { tone: "complete", label: "Complete", attention: false };
    }
    if (task.lifecycle === "cancelled") {
      return { tone: "complete", label: "Cancelled", attention: false };
    }
    if (task.lifecycle === "outcome_unknown") {
      return { tone: "unknown", label: "Outcome unknown", attention: true };
    }
    if (task.lifecycle === "failed") {
      return { tone: "failed", label: "Needs attention", attention: true };
    }
    if (
      task.agent?.phase === "completed" &&
      task.agent.parentDelivery === "acknowledged"
    ) {
      return { tone: "complete", label: "Agent complete", attention: false };
    }
    return { tone: "complete", label: "Ready", attention: false };
  }
  const events = taskEvents.get(taskId) ?? [];
  const terminal = events
    .slice()
    .reverse()
    .find((event) => event.kind === "turn.terminal");
  if (terminal?.kind === "turn.terminal") {
    if (terminal.phase === "completed") {
      return { tone: "complete", label: "Complete", attention: false };
    }
    if (terminal.phase === "outcome_unknown") {
      return { tone: "unknown", label: "Outcome unknown", attention: true };
    }
    return { tone: "failed", label: "Needs attention", attention: true };
  }
  if (unresolvedComputerRequest(taskId)) {
    return { tone: "waiting", label: "Computer waiting", attention: false };
  }
  const last = events
    .filter((event) => event.kind !== "client.delivery_acknowledged")
    .at(-1);
  if (!last)
    return { tone: "connecting", label: "Connecting", attention: false };
  if (last.kind === "turn.phase") {
    if (last.phase === "outcome_unknown") {
      return { tone: "unknown", label: "Outcome unknown", attention: true };
    }
    if (last.phase === "failed" || last.phase === "cancelled") {
      return { tone: "failed", label: "Needs attention", attention: true };
    }
  }
  return { tone: "running", label: "Streaming", attention: false };
}

function sidebarMode(): SidebarMode {
  if (narrowSidebar.matches) return sidebarOverlayOpen ? "overlay" : "rail";
  return sidebarPreference;
}

function currentLayout() {
  return {
    section,
    taskId: selectedTaskId,
    setupOpen: setupJourney.open,
    sidebar: sidebarMode(),
    overlay: shellOverlay,
  } as const;
}

function notifyHost(): void {
  const layout = currentLayout();
  const serialized = JSON.stringify(layout);
  if (serialized === lastHostLayout) return;
  lastHostLayout = serialized;
  window.farolNext.layout(
    layout.section,
    layout.taskId,
    layout.setupOpen,
    layout.sidebar,
    layout.overlay,
  );
}

function renderWindowState(): void {
  const root = document.documentElement;
  root.dataset.windowActive = String(windowState.focused);
  root.dataset.fullScreen = String(windowState.fullScreen);
  if (windowState.trafficLightPosition) {
    root.dataset.trafficLightX = String(windowState.trafficLightPosition.x);
    root.dataset.trafficLightY = String(windowState.trafficLightPosition.y);
  } else {
    delete root.dataset.trafficLightX;
    delete root.dataset.trafficLightY;
  }
  // The toggle's left offset is computed from the traffic lights' own
  // reported position, not a constant, so it stays clear of them (see
  // `window-chrome-geometry.ts`) across every window and display this
  // reports for — a resize, a fullscreen enter/exit, or a different macOS
  // button layout.
  root.style.setProperty(
    "--sidebar-toggle-left",
    `${sidebarToggleLeft(windowState.trafficLightPosition)}px`,
  );
}

function renderRuntime(): void {
  const pill = required<HTMLDivElement>("#runtime-pill");
  const lamp = required<HTMLElement>("#runtime-pill .state-lamp");
  const label = required<HTMLElement>("#runtime-pill b");
  const detail = required<HTMLElement>("#runtime-pill small");
  const tone =
    bootstrap.runtimeState === "ready"
      ? "running"
      : bootstrap.runtimeState === "starting"
        ? "starting"
        : "failed";
  pill.dataset.state = bootstrap.runtimeState;
  lamp.className = `state-lamp ${tone}`;
  label.textContent =
    bootstrap.runtimeState === "ready"
      ? "Local runtime"
      : bootstrap.runtimeState;
  // This second line used to be a static HTML placeholder ("No live
  // provider") that nothing ever updated, so it kept showing that text
  // forever regardless of actual state — the sidebar half of UX34-03/04.
  // It now agrees with the same `chatGptRouteState()` the header and New
  // task control use.
  detail.textContent =
    bootstrap.runtimeState === "starting"
      ? "Starting…"
      : bootstrap.runtimeState === "offline"
        ? "Runtime offline"
        : bootstrap.runtimeState === "failed"
          ? "Runtime failed"
          : (() => {
              switch (chatGptRouteState()) {
                case "ready":
                  return "Ready for a new task";
                case "checking":
                  return "Checking ChatGPT connection…";
                case "outcome-unknown":
                  return "ChatGPT outcome unknown";
                case "failed":
                  return "ChatGPT route unreachable";
                default:
                  return "No live provider";
              }
            })();
}

function renderBuildIdentity(): void {
  const container = required<HTMLElement>("#build-identity");
  const primary = required<HTMLElement>("#build-identity > span");
  const secondary = required<HTMLElement>("#build-identity > small");
  const builtAt = new Date(bootstrap.build.builtAt);
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(builtAt);
  primary.textContent = `v${bootstrap.build.version} · ${bootstrap.build.sourceCommit.slice(0, 8)}${bootstrap.build.sourceDirty ? " · dirty" : ""}`;
  secondary.textContent = `Built ${formatted}`;
  container.title = `${bootstrap.build.buildId}\nBuilt ${bootstrap.build.builtAt}`;
  container.setAttribute(
    "aria-label",
    `Farol Next ${bootstrap.build.version}, build ${bootstrap.build.sourceCommit.slice(0, 8)}, built ${formatted}`,
  );
}

function renderBrowser(): void {
  const loading = required<HTMLDivElement>("#browser-loading");
  const title = required<HTMLElement>("#browser-state-title");
  const detail = required<HTMLElement>("#browser-state-detail");
  const mark = required<HTMLElement>("#browser-state-mark");
  const task = taskById(selectedTaskId);
  const surfaceFailed =
    taskSurfaceStatuses.get(selectedTaskId)?.state === "failed";
  if (bootstrap.runtimeState === "ready" && bootstrap.tasks.length === 0) {
    loading.dataset.state = "empty";
    mark.className = "state-lamp unavailable";
    title.textContent = taskAdmissionFeedback
      ? "Task not created"
      : "No tasks yet";
    // Agrees with the same `chatGptRouteState()` the header, New task
    // control, and sidebar use: when the route is actually ready, this
    // empty state must say so instead of unconditionally asking to
    // "Complete Setup" (UX34-03/04).
    detail.textContent =
      taskAdmissionFeedback ||
      (chatGptRouteState() === "ready"
        ? "Ready for a new task — use the + New task control above."
        : "Complete Setup and connect a supported route to create the first real task.");
  } else if (surfaceFailed || task?.lifecycle === "failed") {
    loading.dataset.state = "failed";
    mark.className = "state-lamp failed";
    title.textContent = "Selected task surface is unavailable";
    detail.textContent =
      "This task stream failed in isolation. Other task surfaces remain independent.";
  } else if (task?.provider === "chatgpt") {
    loading.dataset.state = "ready";
    mark.className = "state-lamp complete";
    title.textContent = "Isolated ChatGPT task";
    detail.textContent =
      "The actual provider page is embedded below this dossier; Farol does not mirror its conversation.";
  } else if (bootstrap.runtimeState === "ready") {
    loading.dataset.state = "ready";
    mark.className = "state-lamp running";
    title.textContent = "Opening task surface";
    detail.textContent = "The selected isolated Browser view is ready.";
  } else if (bootstrap.runtimeState === "offline") {
    loading.dataset.state = "offline";
    mark.className = "state-lamp unavailable";
    title.textContent = "Local runtime is offline";
    detail.textContent =
      "Your task state is not being replayed. Open Settings for the recorded reason.";
  } else if (bootstrap.runtimeState === "failed") {
    loading.dataset.state = "failed";
    mark.className = "state-lamp failed";
    title.textContent = "The local runtime stopped";
    detail.textContent =
      "Task surfaces are unavailable. Do not resubmit an uncertain task automatically.";
  } else {
    loading.dataset.state = "starting";
    mark.className = "state-lamp starting";
    title.textContent = "Preparing task surfaces";
    detail.textContent = "Starting the isolated local runtime…";
  }
}

function renderTabs(): void {
  const tabs = required<HTMLDivElement>("#task-tabs");
  tabs.replaceChildren(
    ...bootstrap.tasks.map((task) => {
      const state = taskState(task.taskId);
      const button = document.createElement("button");
      button.className = `task-tab ${task.taskId === selectedTaskId ? "active" : ""}`;
      button.dataset.taskId = task.taskId;
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute(
        "aria-selected",
        String(task.taskId === selectedTaskId),
      );
      const label = document.createElement("span");
      label.textContent = taskLabel(task);
      const lamp = document.createElement("i");
      lamp.className = `state-lamp ${state.tone}`;
      lamp.setAttribute("aria-hidden", "true");
      const status = document.createElement("small");
      status.textContent = state.label;
      button.append(label, lamp, status);
      button.addEventListener("click", () => selectTask(task.taskId));
      return button;
    }),
  );
}

function renderSignals(): void {
  const states = bootstrap.tasks.map((task) => taskState(task.taskId));
  const running = states.filter((state) => state.tone === "running").length;
  const waiting = bootstrap.tasks.filter((task) =>
    Boolean(unresolvedComputerRequest(task.taskId)),
  ).length;
  const attention = states.filter((state) => state.attention).length;
  const signals: Partial<
    Record<SurfaceSection, { tone: TaskTone; count: string; text: string }>
  > = {
    ...(running > 0
      ? {
          browser: {
            tone: "running" as const,
            count: String(running),
            text: `${running} ${running === 1 ? "task is" : "tasks are"} running`,
          },
        }
      : {}),
    ...(waiting > 0
      ? {
          computer: {
            tone: "waiting" as const,
            count: String(waiting),
            text: `${waiting} ${waiting === 1 ? "request is" : "requests are"} waiting for approval`,
          },
        }
      : {}),
    ...(attention > 0
      ? {
          activity: {
            tone: states.some((state) => state.tone === "unknown")
              ? ("unknown" as const)
              : states.some((state) => state.tone === "failed")
                ? ("failed" as const)
                : ("waiting" as const),
            count: String(attention),
            text: `${attention} ${attention === 1 ? "task needs" : "tasks need"} attention`,
          },
        }
      : {}),
    ...(bootstrap.runtimeState === "ready"
      ? {}
      : {
          settings: {
            tone: "unavailable" as const,
            count: "",
            text: "Local runtime is offline",
          },
        }),
  };
  document
    .querySelectorAll<HTMLButtonElement>(".nav-item")
    .forEach((button) => {
      const route = button.dataset.section as SurfaceSection;
      const signal = signals[route];
      const badge = button.querySelector<HTMLElement>(".nav-signal");
      if (!badge) return;
      const shortcut =
        route === "settings" ? "⌘," : `⌘${sections.indexOf(route) + 1}`;
      const base = `${route.charAt(0).toUpperCase()}${route.slice(1)} (${shortcut})`;
      if (!signal) {
        badge.hidden = true;
        button.title = base;
        return;
      }
      badge.hidden = false;
      badge.dataset.tone = signal.tone;
      const lamp = badge.querySelector<HTMLElement>(".state-lamp");
      const count = badge.querySelector<HTMLElement>("b");
      const description = badge.querySelector<HTMLElement>("small");
      if (lamp) lamp.className = `state-lamp ${signal.tone}`;
      if (count) count.textContent = signal.count;
      if (description) description.textContent = signal.text;
      button.title = `${base} · ${signal.text}`;
    });
}

function renderDossier(): void {
  const task = taskById(selectedTaskId);
  const finish = required<HTMLButtonElement>("#finish-demo");
  const route = required<HTMLButtonElement>("#dossier-route");
  const taskMenuComputer = required<HTMLButtonElement>("#task-menu-computer");
  if (!task) {
    finish.hidden = true;
    finish.disabled = true;
    route.hidden = true;
    route.disabled = true;
    taskMenuComputer.disabled = true;
    return;
  }
  const state = taskState(selectedTaskId);
  const stateElement = required<HTMLDivElement>("#dossier-state");
  required<HTMLElement>("#dossier-state .state-lamp").className =
    `state-lamp ${state.tone}`;
  required<HTMLElement>("#dossier-state b").textContent =
    state.label.toLocaleUpperCase();
  stateElement.dataset.tone = state.tone;
  required<HTMLElement>("#dossier-title").textContent = taskLabel(task);
  renderCapability("#dossier-model", task.requestedModel, task.observedModel);
  renderCapability("#dossier-mode", task.requestedMode, task.observedMode);
  required<HTMLElement>("#dossier-computer").textContent =
    unresolvedComputerRequest(selectedTaskId)
      ? "Approval required"
      : task?.hasComputer
        ? "No request"
        : "Unavailable";

  const canFinish =
    task.provider === "fixture" &&
    state.tone === "running" &&
    bootstrap.runtimeState === "ready" &&
    taskSurfaceStatuses.get(selectedTaskId)?.state !== "failed";
  finish.hidden = !canFinish;
  finish.disabled = !canFinish;
  route.hidden = canFinish;
  route.disabled = state.tone === "connecting";
  route.innerHTML =
    task.provider === "chatgpt"
      ? "Focus page <span>›</span>"
      : state.tone === "waiting"
        ? "Review request <span>›</span>"
        : state.tone === "unavailable"
          ? "Open Settings <span>›</span>"
          : "Open Activity <span>›</span>";

  taskMenuComputer.disabled = !unresolvedComputerRequest(selectedTaskId);
}

// The one place that decides whether the ChatGPT route can start a new task
// right now. The header status line, the New task control, the Setup
// checklist and Settings all call this (or `agentRouteState` below) instead
// of re-deriving their own boolean — see UX34-03/04 in setup-presentation.ts.
function chatGptRouteState(): RouteReadinessState {
  if (bootstrap.configuration.status !== "ready") return "not-configured";
  return routeReadiness(bootstrap.configuration.settings.setup.chatgpt);
}

function computerRouteState(): RouteReadinessState {
  if (bootstrap.configuration.status !== "ready") return "not-configured";
  const settings = bootstrap.configuration.settings;
  const workspace = settings.computer.workspaces[0];
  const stale =
    workspace !== undefined &&
    (settings.setup.computer.verified?.workspaceId !== workspace.workspaceId ||
      settings.setup.computer.verified.configRevision !==
        settings.computer.generation);
  return routeReadiness(settings.setup.computer, { stale });
}

function connectRouteState(): RouteReadinessState {
  if (bootstrap.configuration.status !== "ready") return "not-configured";
  return routeReadiness(bootstrap.configuration.settings.setup.connect);
}

function agentRouteState(): RouteReadinessState {
  if (bootstrap.configuration.status !== "ready") return "not-configured";
  const settings = bootstrap.configuration.settings;
  return agentRouteReadiness(settings.setup.hosts, settings.setup.verify);
}

type ProductAgentReadiness =
  | Readonly<{
      ready: true;
      workspace: ReadySettings["computer"]["workspaces"][number];
    }>
  | Readonly<{ ready: false; reason: string }>;

function productAgentReadiness(): ProductAgentReadiness {
  if (bootstrap.configuration.status !== "ready") {
    return { ready: false, reason: "Repair Settings before running Agent." };
  }
  const settings = bootstrap.configuration.settings;
  const host = settings.nativeHosts.codex;
  if (!host) {
    return { ready: false, reason: "Choose and verify a native Codex host." };
  }
  const live = host.liveVerification;
  if (
    !live ||
    live.executableSha256 !== host.executableSha256 ||
    live.schemaSha256 !== host.schemaSha256 ||
    live.buildId !== bootstrap.build.buildId
  ) {
    return { ready: false, reason: "Run the exact-build native host check." };
  }
  const proof = host.agentVerification;
  if (
    !proof ||
    proof.executableSha256 !== host.executableSha256 ||
    proof.schemaSha256 !== host.schemaSha256 ||
    proof.buildId !== bootstrap.build.buildId ||
    proof.computerGeneration !== settings.computer.generation ||
    proof.workspaceEnforcement !== "verified"
  ) {
    return {
      ready: false,
      reason: "Verify native Agent lineage and workspace enforcement first.",
    };
  }
  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === proof.workspaceId,
  );
  const computer = settings.setup.computer;
  if (
    !workspace ||
    computer.reachable !== "reachable" ||
    computer.outcomeUnknown ||
    computer.verified?.workspaceId !== workspace.workspaceId ||
    computer.verified.configRevision !== settings.computer.generation ||
    computer.verified.buildId !== bootstrap.build.buildId
  ) {
    return {
      ready: false,
      reason: "Verify the same workspace for this exact build.",
    };
  }
  return { ready: true, workspace };
}

function scopeLines(selector: string): string[] {
  return required<HTMLTextAreaElement>(selector)
    .value.split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function productAgentScopeSelection(): ProductAgentScopeSelection | null {
  const mode = required<HTMLSelectElement>("#task-agent-scope").value;
  const excludedPaths = scopeLines("#task-agent-exclusions");
  const candidate =
    mode === "workspace"
      ? { mode, excludedPaths }
      : mode === "subtree"
        ? {
            mode,
            relativeRoot: required<HTMLInputElement>(
              "#task-agent-subtree",
            ).value.trim(),
            excludedPaths,
          }
        : mode === "exact"
          ? { mode, relativePaths: scopeLines("#task-agent-paths") }
          : null;
  const parsed = ProductAgentScopeSelectionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function renderTaskMenu(): void {
  const task = taskById(selectedTaskId);
  const live = task?.provider === "chatgpt";
  required<HTMLElement>("#task-menu-live").hidden = !live;
  required<HTMLElement>("#task-menu-fixture").hidden = live;
  if (!live || !task) return;

  const name = required<HTMLInputElement>("#task-menu-name");
  const rename = required<HTMLButtonElement>("#task-menu-rename");
  const pin = required<HTMLButtonElement>("#task-menu-pin");
  const cancel = required<HTMLButtonElement>("#task-menu-cancel");
  const close = required<HTMLButtonElement>("#task-menu-close-task");
  const workspace = required<HTMLSelectElement>("#task-agent-workspace");
  const scopeMode = required<HTMLSelectElement>("#task-agent-scope");
  const subtree = required<HTMLInputElement>("#task-agent-subtree");
  const paths = required<HTMLTextAreaElement>("#task-agent-paths");
  const exclusions = required<HTMLTextAreaElement>("#task-agent-exclusions");
  const scopeHelp = required<HTMLElement>("#task-agent-scope-help");
  const objective = required<HTMLTextAreaElement>("#task-agent-objective");
  const runAgent = required<HTMLButtonElement>("#task-menu-agent");
  const agentState = required<HTMLElement>("#task-agent-state");
  const agentLamp = required<HTMLElement>("#task-agent-state .state-lamp");
  const agentLabel = required<HTMLElement>("#task-agent-state small");
  const agentDetail = required<HTMLElement>("#task-agent-detail");
  const readiness = productAgentReadiness();
  const scopeSelection = productAgentScopeSelection();
  const exactScope = scopeMode.value === "exact";
  const subtreeScope = scopeMode.value === "subtree";
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-agent-scope-field="subtree"]',
  )) {
    element.hidden = !subtreeScope;
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-agent-scope-field="exact"]',
  )) {
    element.hidden = !exactScope;
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-agent-scope-field="exclusions"]',
  )) {
    element.hidden = exactScope;
  }
  const previousWorkspace = workspace.value;
  if (readiness.ready) {
    const option = document.createElement("option");
    option.value = readiness.workspace.workspaceId;
    option.textContent = readiness.workspace.label;
    workspace.replaceChildren(option);
    workspace.value =
      previousWorkspace === readiness.workspace.workspaceId
        ? previousWorkspace
        : readiness.workspace.workspaceId;
  } else {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No verified workspace";
    workspace.replaceChildren(option);
  }
  const needsRejoin =
    task.agent?.phase === "running" ||
    (task.agent?.phase === "completed" &&
      task.agent.parentDelivery === "pending" &&
      task.agent.resultAvailable);
  const uncertain = task.agent?.phase === "outcome_unknown";
  const agentRunning = task.agent?.phase === "running";
  const context = contextTaskPresentation(task.context);
  const contextLocked = context?.locked ?? false;
  const agentLocked = needsRejoin || contextLocked;
  name.disabled = taskMenuBusy;
  rename.disabled = taskMenuBusy;
  pin.disabled = taskMenuBusy;
  cancel.disabled =
    taskMenuBusy ||
    contextLocked ||
    (!agentRunning && (task.lifecycle !== "running" || agentLocked));
  close.disabled = taskMenuBusy || agentLocked;
  workspace.disabled = taskMenuBusy || agentLocked || !readiness.ready;
  scopeMode.disabled = taskMenuBusy || agentLocked || !readiness.ready;
  subtree.disabled = taskMenuBusy || agentLocked || !readiness.ready;
  paths.disabled = taskMenuBusy || agentLocked || !readiness.ready;
  exclusions.disabled = taskMenuBusy || agentLocked || !readiness.ready;
  objective.disabled = taskMenuBusy || agentLocked || !readiness.ready;
  runAgent.disabled =
    taskMenuBusy ||
    !readiness.ready ||
    uncertain ||
    contextLocked ||
    (!needsRejoin &&
      (objective.value.trim().length === 0 || scopeSelection === null));
  runAgent.querySelector("span")!.textContent =
    task.agent?.phase === "running"
      ? "Rejoin Agent"
      : task.agent?.phase === "completed" &&
          task.agent.parentDelivery === "pending"
        ? "Deliver result"
        : "Run Agent";
  runAgent.querySelector("small")!.textContent = needsRejoin
    ? task.agent?.phase === "running"
      ? "Same child"
      : "Durable result"
    : scopeSelection?.mode === "workspace" &&
        scopeSelection.excludedPaths.length === 0
      ? "Whole workspace"
      : "Owner narrowed";
  scopeHelp.textContent =
    scopeSelection === null
      ? "Enter canonical relative paths without wildcards, empty segments, or parent traversal."
      : scopeSelection.mode === "workspace" &&
          scopeSelection.excludedPaths.length === 0
        ? "The Agent inherits the whole verified workspace and its existing exclusions. This does not require per-file approval."
        : scopeSelection.mode === "workspace"
          ? "Explicit owner narrowing keeps the verified workspace while adding the listed exclusions."
          : scopeSelection.mode === "subtree"
            ? "Explicit owner narrowing limits this assignment to one subfolder plus the listed exclusions."
            : "Explicit owner narrowing permits non-recursive reads of only the listed files.";

  const agentPresentation =
    task.agent?.phase === "running"
      ? {
          tone: "running",
          label: "Running",
          detail:
            "Rejoin checks the same native child without submitting another model turn.",
        }
      : task.agent?.phase === "completed" &&
          task.agent.parentDelivery === "pending"
        ? {
            tone: "waiting",
            label: "Result ready",
            detail:
              "The result is retained durably and still needs exact parent delivery acknowledgement.",
          }
        : task.agent?.phase === "completed"
          ? {
              tone: "complete",
              label: "Delivered",
              detail:
                "The previous Agent result was retained and acknowledged by the parent task.",
            }
          : task.agent?.phase === "failed"
            ? {
                tone: "failed",
                label: "Failed",
                detail:
                  "The native host confirmed failure. A new assignment requires a new explicit Run Agent action.",
              }
            : task.agent?.phase === "cancelled"
              ? {
                  tone: "complete",
                  label: "Cancelled",
                  detail:
                    "The exact native assignment stop was acknowledged. Any already-completed child work was not delivered, and a new assignment still requires an explicit Run Agent action.",
                }
              : task.agent?.phase === "outcome_unknown"
                ? {
                    tone: "unknown",
                    label: "Outcome unknown",
                    detail:
                      "Farol will not retry this assignment. Inspect the native task before starting elsewhere.",
                  }
                : readiness.ready
                  ? {
                      tone: "complete",
                      label: "Ready",
                      detail:
                        "One verified workspace will be delegated read-only, without per-file reapproval.",
                    }
                  : {
                      tone: "unavailable",
                      label: "Unavailable",
                      detail: readiness.reason,
                    };
  agentState.dataset.tone = agentPresentation.tone;
  agentLamp.className = `state-lamp ${agentPresentation.tone}`;
  agentLabel.textContent = agentPresentation.label;
  agentDetail.textContent = agentPresentation.detail;
  pin.querySelector("span")!.textContent = task.pinned
    ? "Unpin task"
    : "Pin task";
  pin.querySelector("small")!.textContent = task.pinned
    ? "Use task order"
    : "Keep first";

  const note = required<HTMLElement>("#task-menu-note");
  note.dataset.error = String(taskMenuFeedbackError);
  note.textContent =
    taskMenuFeedback ||
    (contextLocked
      ? `${context?.label ?? "Context transition"} is still active. Farol will not cancel, close, or delegate this task until the exact context operation is reconciled.`
      : agentLocked
        ? agentRunning
          ? "Agent state is retained before native execution. Cancel interrupts this exact native child; Close stays unavailable until cancellation or delivery is reconciled."
          : "Agent state is retained before native execution. Closing and provider cancellation stay unavailable until the same assignment is reconciled."
        : uncertain
          ? "Outcome unknown is not Failed. Farol will not submit this Agent assignment again."
          : task.lifecycle === "running"
            ? "Cancel requests a provider stop. Closing only removes the local task and does not prove provider cancellation."
            : "Close removes this local task and its window. It does not cancel provider work.");
}

function pendingComputerTask(): PreviewTask | null {
  const ordered = [
    ...bootstrap.tasks.filter((task) => task.taskId === selectedTaskId),
    ...bootstrap.tasks.filter((task) => task.taskId !== selectedTaskId),
  ];
  return (
    ordered.find((task) => unresolvedComputerRequest(task.taskId) !== null) ??
    null
  );
}

function renderComputer(): void {
  const waitingTask = pendingComputerTask();
  computerTargetTaskId = waitingTask?.taskId ?? null;
  const button = required<HTMLButtonElement>("#approve-tool");
  button.disabled =
    !waitingTask ||
    bootstrap.runtimeState !== "ready" ||
    taskSurfaceStatuses.get(waitingTask.taskId)?.state === "failed";
  required("#computer-summary").textContent = waitingTask
    ? "One task is waiting for your bounded approval."
    : "No request is waiting.";
  required("#computer-task").textContent = waitingTask
    ? `Task · ${taskLabel(waitingTask)}`
    : "No selected request";
  required("#computer-title").textContent = waitingTask
    ? "Inspect synthetic fixture status"
    : "No task request";
  required("#computer-detail").textContent = waitingTask
    ? "Target: fixture workspace status. This admitted preview task exposes no path, file content, command, screenshot, or account state."
    : "Task approvals appear here when an exact correlated action waits. Workspace access below never starts an action by itself.";

  const configured = bootstrap.configuration;
  const available = required("#computer-available");
  const unavailable = required("#computer-unavailable");
  const authority = required("#computer-authority");
  if (configured.status === "error") {
    available.textContent = "Configuration repair";
    unavailable.textContent = "Workspace operations while settings are invalid";
    authority.textContent = `Unavailable · ${configured.error}`;
  } else {
    const settings = configured.settings;
    const verifiedWorkspace = settings.computer.workspaces.find(
      (workspace) =>
        settings.setup.computer.verified?.workspaceId ===
          workspace.workspaceId &&
        settings.setup.computer.verified.configRevision ===
          settings.computer.generation,
    );
    if (verifiedWorkspace) {
      available.textContent = `${verifiedWorkspace.access === "write" ? "Read, list, search and guarded edits" : "Read, list and search"} · ${verifiedWorkspace.label}`;
      unavailable.textContent =
        verifiedWorkspace.access === "write"
          ? "Commands · screenshots · account state"
          : "Writes · commands · screenshots · account state";
      authority.textContent = `${settings.computer.name} · ${verifiedWorkspace.access} generation ${settings.computer.generation} · exclusions enforced`;
    } else if (settings.computer.workspaces.length > 0) {
      available.textContent = "Workspace configuration · verification required";
      unavailable.textContent =
        "File operations until the current workspace grant is verified";
      authority.textContent = `${settings.computer.name} · no current verified grant`;
    } else {
      available.textContent = "Workspace configuration";
      unavailable.textContent =
        "File operations until a workspace is approved and verified";
      authority.textContent = `${settings.computer.name} · no approved workspace`;
    }
  }
  renderComputerConfiguration();
}

function renderActivity(): void {
  const list = required<HTMLOListElement>("#activity-list");
  const technical =
    bootstrap.configuration.status === "ready" &&
    bootstrap.configuration.settings.general.activityDetail === "technical";
  const visible = activity
    .entries()
    .filter(
      (record) =>
        technical ||
        !["text.delta", "client.delivery_acknowledged"].includes(record.kind),
    )
    .slice(-14)
    .reverse();
  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "activity-empty";
    const dot = document.createElement("i");
    const message = document.createElement("span");
    message.textContent = "Waiting for the first safe lifecycle event.";
    empty.append(dot, message);
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...visible.map((record) => {
      const item = document.createElement("li");
      const dot = document.createElement("i");
      const task = document.createElement("span");
      task.className = "activity-task";
      task.textContent = taskLabel(taskById(record.taskId));
      const message = document.createElement("b");
      message.textContent = activityLabels[record.kind] ?? "Lifecycle event";
      const phase = document.createElement("span");
      phase.textContent =
        record.sequence === null
          ? (phaseLabels[record.phase] ?? "Updated")
          : record.coalesced > 1
            ? `Part ${record.sequence} · ${record.coalesced} updates`
            : `Part ${record.sequence}`;
      const at = document.createElement("time");
      at.dateTime = new Date(record.at).toISOString();
      at.textContent = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(record.at);
      item.append(dot, task, message, phase, at);
      return item;
    }),
    ...(activity.omitted() > 0
      ? [
          (() => {
            const omitted = document.createElement("li");
            omitted.className = "activity-empty";
            const dot = document.createElement("i");
            const message = document.createElement("span");
            message.textContent = `${activity.omitted()} older stream ${activity.omitted() === 1 ? "record was" : "records were"} not kept.`;
            omitted.append(dot, message);
            return omitted;
          })(),
        ]
      : []),
  );
}

function routeStatusClass(state: RouteReadinessState): string {
  switch (state) {
    case "ready":
      return "available";
    case "action-required":
      return "limited";
    case "checking":
      return "checking";
    case "failed":
      return "failed";
    case "outcome-unknown":
      return "unknown";
    case "not-configured":
      return "blocked";
  }
}

function discoverySourceLabel(
  source: ProductDiscoveryCandidate["source"],
): string {
  switch (source) {
    case "chatgpt-app":
      return "ChatGPT.app";
    case "codex-app":
      return "Codex.app";
    case "homebrew":
      return "Homebrew";
    case "npm-global":
      return "npm · @openai/codex (global)";
    case "reviewed-build-dir":
      return "Reviewed tunnel-client build";
  }
}

function discoveryOriginLabel(
  origin: ProductDiscoveryCandidate["origin"],
): string {
  switch (origin) {
    case "signed-by-openai":
      return "Signed by OpenAI";
    case "reviewed-digest":
      return "Matches the reviewed digest";
    case "signature-other-team":
      return "Signed by a different team";
    case "unsigned":
      return "Not code-signed";
    case "unknown":
      return "Signature could not be verified";
  }
}

// Discovery never runs itself; the Setup dialog asks for it exactly once per
// session per step (until a fresh scan is explicitly requested), the same
// way every other live check here waits for an explicit action. Triggering
// it from inside render() has to go through queueMicrotask so the async
// configureProduct call never starts mid-render.
function ensureDiscovery(kind: "connect" | "hosts"): void {
  if (discoveryRequested[kind]) return;
  discoveryRequested = { ...discoveryRequested, [kind]: true };
  queueMicrotask(() => {
    void configureProduct(
      kind === "connect"
        ? { kind: "connector.discover-client" }
        : { kind: "host.discover-codex" },
      kind === "connect"
        ? "Local tunnel-client candidates discovered."
        : "Local Codex candidates discovered.",
    );
  });
}

function rescanDiscovery(kind: "connect" | "hosts"): void {
  discoveryRequested = { ...discoveryRequested, [kind]: false };
  if (kind === "connect") discoveredTunnelClientCandidates = null;
  else discoveredCodexCandidates = null;
  ensureDiscovery(kind);
  render();
}

// Inline, bounded owner instructions for the one external step Setup itself
// cannot verify (creating a tunnel, creating a key, attaching the
// connector inside ChatGPT). Text always renders; a <video> only appears
// when the manifest names a clip, per `shouldRenderClip` — no clip ships
// today, so this always falls back to text-only, exactly as the acceptance
// criteria for the media manifest require.
function buildMediaInstructions(slotId: SetupMediaSlotId): HTMLElement | null {
  const slot = findSetupMediaSlot(SETUP_MEDIA_MANIFEST, slotId);
  if (!slot) return null;
  const container = document.createElement("details");
  container.className = "setup-media";
  const summary = document.createElement("summary");
  summary.textContent = slot.title;
  container.append(summary);
  const list = document.createElement("ol");
  list.className = "setup-media-steps";
  list.append(
    ...slot.steps.map((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      return item;
    }),
  );
  container.append(list);
  if (slot.clip && shouldRenderClip(slot, true)) {
    const clip = slot.clip;
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "none";
    video.poster = clip.poster;
    const source = document.createElement("source");
    source.src = clip.file;
    const track = document.createElement("track");
    track.kind = "captions";
    track.src = clip.captions;
    video.append(source, track);
    container.append(video);
  }
  return container;
}

function buildDiscoveryPanel(
  advancedKey: "connect" | "hosts",
  discovery: Extract<
    ProductConfigurationEvidence,
    { kind: "host.codex-discovery" | "connector.client-discovery" }
  > | null,
  labels: Readonly<{
    itemNoun: string;
    notFoundHint: string;
    selectCommandKind:
      "host.select-discovered-codex" | "connector.select-discovered-client";
    pickerCommandKind: "host.select-codex" | "connector.select-client";
  }>,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "discovery-panel";

  if (!discovery) {
    const scanning = document.createElement("p");
    scanning.className = "discovery-scanning";
    scanning.textContent = `Looking for a local ${labels.itemNoun} in a few fixed, known locations…`;
    panel.append(scanning);
    return panel;
  }

  const offered = discovery.candidates.filter(
    (candidate) => candidate.verdict === "offer",
  );
  const needsChoice = discovery.candidates.filter(
    (candidate) => candidate.verdict === "needs-owner-choice",
  );

  function candidateCard(
    candidate: ProductDiscoveryCandidate,
    action: "offer" | "needs-owner-choice",
  ): HTMLElement {
    const card = document.createElement("article");
    card.className = "discovery-candidate";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = discoverySourceLabel(candidate.source);
    const detail = document.createElement("small");
    detail.textContent = `${candidate.path} · ${discoveryOriginLabel(candidate.origin)}`;
    copy.append(title, detail);
    const use = document.createElement("button");
    use.type = "button";
    use.textContent =
      action === "offer" ? `Use this ${labels.itemNoun}` : "Use anyway";
    use.addEventListener("click", () => {
      void configureProduct(
        { kind: labels.selectCommandKind, path: candidate.path },
        `${labels.itemNoun} selected and verified.`,
      );
    });
    card.append(copy, use);
    return card;
  }

  if (offered.length > 0) {
    const list = document.createElement("div");
    list.className = "discovery-offered";
    list.append(
      ...offered.map((candidate) => candidateCard(candidate, "offer")),
    );
    panel.append(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "discovery-empty";
    empty.textContent =
      discovery.candidates.length === 0
        ? `No local ${labels.itemNoun} was found. ${labels.notFoundHint}`
        : `A local ${labels.itemNoun} was found but is not trusted automatically. Open Advanced to review it or choose another one.`;
    panel.append(empty);
  }

  const advanced = document.createElement("details");
  advanced.className = "discovery-advanced";
  advanced.open = discoveryAdvancedOpen[advancedKey];
  advanced.addEventListener("toggle", () => {
    discoveryAdvancedOpen = {
      ...discoveryAdvancedOpen,
      [advancedKey]: advanced.open,
    };
  });
  const summary = document.createElement("summary");
  summary.textContent = "Advanced";
  advanced.append(summary);

  if (needsChoice.length > 0) {
    const warning = document.createElement("p");
    warning.className = "discovery-warning";
    warning.textContent =
      "Not signed by OpenAI, or the signature could not be confirmed. Only continue if you placed this file yourself.";
    advanced.append(warning);
    advanced.append(
      ...needsChoice.map((candidate) =>
        candidateCard(candidate, "needs-owner-choice"),
      ),
    );
  }

  const rescan = document.createElement("button");
  rescan.type = "button";
  rescan.textContent = "Scan again";
  rescan.addEventListener("click", () => rescanDiscovery(advancedKey));
  const choosePicker = document.createElement("button");
  choosePicker.type = "button";
  choosePicker.textContent = "Choose another…";
  choosePicker.addEventListener("click", () => {
    void configureProduct(
      { kind: labels.pickerCommandKind },
      `${labels.itemNoun} selected and verified.`,
    );
  });
  const advancedActions = document.createElement("div");
  advancedActions.className = "discovery-advanced-actions";
  advancedActions.append(rescan, choosePicker);
  advanced.append(advancedActions);
  panel.append(advanced);

  return panel;
}

function renderConfigurationFeedback(
  selector: string,
  surface: "computer" | "settings" | "setup",
): void {
  const configured = bootstrap.configuration;
  const feedback = required<HTMLParagraphElement>(selector);
  // A message addressed to Setup must not vanish with the dialog: once Setup
  // is closed (finished, or the last step dismissed it) the same message is
  // shown on the Settings panel instead.
  const visibleSurface =
    settingsFeedbackSurface === "setup" && !setupJourney.open
      ? "settings"
      : settingsFeedbackSurface;
  feedback.textContent =
    configured.status === "error"
      ? `Settings unavailable · ${configured.error}`
      : visibleSurface === surface
        ? settingsFeedback
        : "";
  feedback.classList.toggle(
    "error",
    configured.status === "error" ||
      (visibleSurface === surface && settingsFeedbackError),
  );
}

function renderComputerConfiguration(): void {
  const configured = bootstrap.configuration;
  const computerName = required<HTMLInputElement>("#computer-name");
  const saveComputerName = required<HTMLButtonElement>("#save-computer-name");
  const addWorkspace = required<HTMLButtonElement>("#add-workspace");
  const commandPolicy = required<HTMLDivElement>("#computer-command-policy");
  const workspaces = required<HTMLDivElement>("#computer-workspaces");
  const computerReadiness = required<HTMLSpanElement>("#computer-readiness");
  renderConfigurationFeedback("#computer-feedback", "computer");

  if (configured.status === "error") {
    computerName.disabled = true;
    saveComputerName.disabled = true;
    addWorkspace.disabled = true;
    commandPolicy.textContent =
      "Command settings are unavailable until product settings are repaired.";
    workspaces.textContent =
      "Repair is required before Computer access can be changed.";
    computerReadiness.textContent = "Unavailable";
    computerReadiness.classList.remove("verified");
    return;
  }

  const settings = configured.settings;
  computerName.disabled = false;
  saveComputerName.disabled = false;
  addWorkspace.disabled = false;
  if (
    renderedComputerSettingsRevision !== settings.revision &&
    document.activeElement !== computerName
  ) {
    computerName.value = settings.computer.name;
    renderedComputerSettingsRevision = settings.revision;
  }

  const commandRow = document.createElement("div");
  commandRow.className = "connection-row command-policy-row";
  const commandCopy = document.createElement("div");
  const commandTitle = document.createElement("strong");
  const commandDetail = document.createElement("small");
  commandTitle.textContent = "Verified commands";
  commandDetail.textContent =
    settings.computer.commands === "verification"
      ? "Fixed Git status and HEAD · Apple Git · no network · bounded output"
      : "Off · no command authority is granted";
  commandCopy.append(commandTitle, commandDetail);
  const updateCommands = document.createElement("button");
  updateCommands.type = "button";
  updateCommands.textContent =
    settings.computer.commands === "verification" ? "Turn off" : "Enable";
  updateCommands.addEventListener("click", () => {
    const commands =
      settings.computer.commands === "verification" ? "none" : "verification";
    void configureProduct(
      { kind: "computer.update-commands", commands },
      commands === "verification"
        ? "Fixed no-network Git status and HEAD enabled. Verify the workspace again before use."
        : "Command authority removed.",
    );
  });
  commandRow.append(commandCopy, updateCommands);
  commandPolicy.replaceChildren(commandRow);

  const computerState = settings.setup.computer;
  computerReadiness.textContent = readinessLabel(computerState);
  computerReadiness.classList.toggle(
    "verified",
    computerState.verified !== null,
  );
  if (settings.computer.workspaces.length === 0) {
    const empty = document.createElement("div");
    empty.className = "connection-row";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    title.textContent = "No approved folders";
    detail.textContent =
      "Add a folder to create a read-only Computer approval.";
    copy.append(title, detail);
    empty.append(copy);
    workspaces.replaceChildren(empty);
    return;
  }

  workspaces.replaceChildren(
    ...settings.computer.workspaces.map((workspace) => {
      const card = document.createElement("article");
      card.className = "workspace-card";
      const row = document.createElement("div");
      row.className = "workspace-row";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = workspace.label;
      const detail = document.createElement("small");
      const verified =
        computerState.verified?.workspaceId === workspace.workspaceId &&
        computerState.verified.configRevision === settings.computer.generation;
      detail.textContent = `${workspace.root} · ${workspace.access === "write" ? "guarded edits" : "read-only"} · ${verified ? "verified" : "not verified"}`;
      copy.append(title, detail);
      const actions = document.createElement("span");
      actions.className = "workspace-actions";
      const verify = document.createElement("button");
      verify.type = "button";
      verify.textContent = verified ? "Recheck" : "Verify folder";
      verify.addEventListener("click", () => {
        void configureProduct(
          {
            kind: "computer.verify-workspace",
            workspaceId: workspace.workspaceId,
          },
          `Farol can open ${workspace.label}.`,
        );
      });
      const updateAccess = document.createElement("button");
      updateAccess.type = "button";
      updateAccess.textContent =
        workspace.access === "read" ? "Enable edits" : "Use read-only";
      updateAccess.title =
        workspace.access === "read"
          ? "Require a fresh verification before guarded edits are available"
          : "Remove write authority and require a fresh read verification";
      updateAccess.addEventListener("click", () => {
        const access = workspace.access === "read" ? "write" : "read";
        void configureProduct(
          {
            kind: "computer.update-access",
            workspaceId: workspace.workspaceId,
            access,
          },
          `${workspace.label} now requires ${access} verification.`,
        );
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        void configureProduct(
          {
            kind: "computer.remove-workspace",
            workspaceId: workspace.workspaceId,
          },
          `${workspace.label} approval removed.`,
        );
      });
      actions.append(verify, updateAccess, remove);
      row.append(copy, actions);

      const policy = document.createElement("div");
      policy.className = "workspace-policy";
      const exclusionLabel = document.createElement("label");
      exclusionLabel.textContent = "Excluded paths";
      const exclusionInput = document.createElement("input");
      exclusionInput.type = "text";
      exclusionInput.placeholder = "private, build/secrets.txt";
      exclusionInput.setAttribute(
        "aria-label",
        `Excluded paths for ${workspace.label}`,
      );
      const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
      exclusionInput.value = workspace.excludedPaths
        .flatMap((excluded) =>
          excluded.startsWith(prefix) ? [excluded.slice(prefix.length)] : [],
        )
        .join(", ");
      exclusionLabel.append(exclusionInput);
      const saveExclusions = document.createElement("button");
      saveExclusions.type = "button";
      saveExclusions.textContent = "Save exclusions";
      saveExclusions.addEventListener("click", () => {
        const excludedPaths = exclusionInput.value
          .split(/[\n,]/u)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        const command = ProductConfigurationCommandSchema.safeParse({
          kind: "computer.update-exclusions",
          workspaceId: workspace.workspaceId,
          excludedPaths,
        });
        if (!command.success) {
          settingsFeedbackSurface = "computer";
          settingsFeedback =
            "Exclusions must be unique relative paths without dot segments.";
          settingsFeedbackError = true;
          render();
          return;
        }
        void configureProduct(
          command.data,
          `${workspace.label} exclusions saved and read back.`,
        );
      });
      policy.append(exclusionLabel, saveExclusions);
      card.append(row, policy);

      const query = document.createElement("div");
      query.className = "workspace-query";
      const listRoot = document.createElement("button");
      listRoot.type = "button";
      listRoot.textContent = "List root";
      listRoot.disabled = !verified;
      listRoot.title = verified
        ? "List the visible entries at this workspace root"
        : "Verify this workspace first";
      listRoot.addEventListener("click", () => {
        void configureProduct(
          {
            kind: "computer.list-workspace",
            workspaceId: workspace.workspaceId,
            relativePath: ".",
          },
          `${workspace.label} root listed.`,
        );
      });
      const searchLabel = document.createElement("label");
      searchLabel.textContent = "Search workspace";
      const searchInput = document.createElement("input");
      searchInput.type = "search";
      searchInput.maxLength = 160;
      searchInput.placeholder = "Exact text pattern";
      searchInput.setAttribute("aria-label", `Search ${workspace.label}`);
      searchInput.disabled = !verified;
      searchLabel.append(searchInput);
      const search = document.createElement("button");
      search.type = "button";
      search.textContent = "Search";
      search.disabled = true;
      searchInput.addEventListener("input", () => {
        search.disabled = !verified || searchInput.value.trim().length === 0;
      });
      search.addEventListener("click", () => {
        const command = ProductConfigurationCommandSchema.safeParse({
          kind: "computer.search-workspace",
          workspaceId: workspace.workspaceId,
          relativePath: ".",
          pattern: searchInput.value.trim(),
        });
        if (!command.success) return;
        void configureProduct(
          command.data,
          `${workspace.label} search completed.`,
        );
      });
      query.append(listRoot, searchLabel, search);
      const gitStatus = document.createElement("button");
      gitStatus.type = "button";
      gitStatus.textContent = "Git status";
      gitStatus.disabled =
        !verified || settings.computer.commands !== "verification";
      gitStatus.title =
        settings.computer.commands !== "verification"
          ? "Enable Verified commands above"
          : verified
            ? "Run the fixed no-network Git status verifier at this workspace root"
            : "Verify this workspace again first";
      gitStatus.addEventListener("click", () => {
        void configureProduct(
          {
            kind: "computer.run-git-status",
            workspaceId: workspace.workspaceId,
          },
          `${workspace.label} Git status completed without network access.`,
        );
      });
      const gitHead = document.createElement("button");
      gitHead.type = "button";
      gitHead.textContent = "Git HEAD";
      gitHead.disabled =
        !verified || settings.computer.commands !== "verification";
      gitHead.title =
        settings.computer.commands !== "verification"
          ? "Enable Verified commands above"
          : verified
            ? "Read the exact Git HEAD commit through the fixed no-network verifier"
            : "Verify this workspace again first";
      gitHead.addEventListener("click", () => {
        void configureProduct(
          {
            kind: "computer.run-git-head",
            workspaceId: workspace.workspaceId,
          },
          `${workspace.label} Git HEAD read without network access.`,
        );
      });
      query.append(gitStatus, gitHead);
      const pendingEdit =
        bootstrap.configuration.status === "ready"
          ? bootstrap.configuration.settings.computer.pendingEdit
          : null;
      if (workspace.access === "write") {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.textContent = "Edit file…";
        edit.disabled = !verified || pendingEdit !== null;
        edit.title =
          pendingEdit !== null
            ? "Check the result of the last guarded edit first"
            : verified
              ? "Choose a text file, review an exact replacement, then apply it once"
              : "Verify guarded edit access first";
        edit.addEventListener("click", () => {
          void configureProduct(
            {
              kind: "computer.prepare-workspace-edit",
              workspaceId: workspace.workspaceId,
            },
            `Review an edit in ${workspace.label}.`,
          );
        });
        query.append(edit);
      }
      card.append(query);
      if (
        pendingEdit?.workspaceId === workspace.workspaceId &&
        workspaceEvidence?.kind !== "computer.workspace-mutation"
      ) {
        // A submitted edit whose result never reached this window: observe
        // that exact operation instead of offering to edit again.
        const notice = document.createElement("p");
        notice.className = "workspace-pending-edit";
        notice.textContent = `The last guarded edit of ${pendingEdit.relativePath} has no delivered result.`;
        const check = document.createElement("button");
        check.type = "button";
        check.textContent = "Check result";
        check.addEventListener("click", () => {
          void configureProduct(
            {
              kind: "computer.observe-workspace-edit",
              operationId: pendingEdit.operationId,
            },
            `Checked the last guarded edit of ${pendingEdit.relativePath}.`,
          );
        });
        notice.append(" ", check);
        card.append(notice);
      }

      if (workspaceEvidence?.workspaceId === workspace.workspaceId) {
        const evidence = document.createElement("section");
        evidence.className =
          workspaceEvidence.kind === "computer.workspace-read"
            ? "workspace-read-evidence"
            : workspaceEvidence.kind === "computer.workspace-edit-preview" ||
                workspaceEvidence.kind === "computer.workspace-mutation"
              ? "workspace-mutation-evidence"
              : "workspace-query-evidence";
        const heading = document.createElement("strong");
        if (workspaceEvidence.kind === "computer.workspace-read") {
          heading.textContent = `${workspaceEvidence.relativePath} · ${workspaceEvidence.bytes} bytes${workspaceEvidence.truncated ? " · preview truncated" : ""}`;
          const preview = document.createElement("pre");
          preview.textContent = workspaceEvidence.text;
          evidence.append(heading, preview);
        } else if (workspaceEvidence.kind === "computer.workspace-list") {
          heading.textContent = `${workspaceEvidence.relativePath} · ${workspaceEvidence.entries.length} visible ${workspaceEvidence.entries.length === 1 ? "entry" : "entries"}${workspaceEvidence.truncated ? " · result limited" : ""}`;
          const entries = document.createElement("ul");
          for (const entry of workspaceEvidence.entries) {
            const item = document.createElement("li");
            item.textContent = entry;
            entries.append(item);
          }
          evidence.append(heading, entries);
        } else if (workspaceEvidence.kind === "computer.workspace-search") {
          heading.textContent = `Search · ${workspaceEvidence.matches.length} ${workspaceEvidence.matches.length === 1 ? "match" : "matches"}${workspaceEvidence.resultLimited || workspaceEvidence.scanLimited ? " · result limited" : ""}`;
          const matches = document.createElement("ol");
          for (const match of workspaceEvidence.matches) {
            const item = document.createElement("li");
            const location = document.createElement("code");
            location.textContent = `${match.path}:${match.line}`;
            const text = document.createElement("span");
            const display = searchMatchDisplay(match);
            text.textContent = display.text;
            if (display.title) text.title = display.title;
            item.append(location, text);
            matches.append(item);
          }
          evidence.append(heading, matches);
        } else if (workspaceEvidence.kind === "computer.workspace-command") {
          const status = workspaceEvidence.command === "git.status";
          heading.textContent = `${status ? "Git status" : "Git HEAD"}${workspaceEvidence.layout === "linked-worktree" ? " · linked worktree" : ""} · exit ${workspaceEvidence.exitCode} · ${workspaceEvidence.outputBytes} bytes · network ${workspaceEvidence.network}`;
          const output = document.createElement("pre");
          output.textContent =
            status && workspaceEvidence.stdout === ""
              ? "No changes to tracked files"
              : workspaceEvidence.stdout.trimEnd();
          evidence.append(heading, output);
          if (workspaceEvidence.coverage === "tracked-files-only") {
            const coverage = document.createElement("p");
            coverage.textContent =
              "Tracked files only: untracked files and submodules are not checked.";
            evidence.append(coverage);
          }
        } else if (
          workspaceEvidence.kind === "computer.workspace-edit-preview"
        ) {
          const editPreview = workspaceEvidence;
          heading.textContent = `${editPreview.relativePath} · ${editPreview.bytes} bytes · source ${editPreview.beforeSha256.slice(0, 12)}`;
          const note = document.createElement("p");
          note.textContent =
            "Enter one exact match and its replacement. The source digest is checked again before one atomic edit; file contents are not retained.";
          const oldLabel = document.createElement("label");
          oldLabel.textContent = "Find exact text";
          const oldText = document.createElement("textarea");
          oldText.maxLength = 32_768;
          oldText.setAttribute(
            "aria-label",
            `Find exact text in ${workspace.label}`,
          );
          oldLabel.append(oldText);
          const newLabel = document.createElement("label");
          newLabel.textContent = "Replace with";
          const newText = document.createElement("textarea");
          newText.maxLength = 32_768;
          newText.setAttribute(
            "aria-label",
            `Replacement text for ${workspace.label}`,
          );
          newLabel.append(newText);
          const controls = document.createElement("div");
          controls.className = "workspace-mutation-actions";
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.textContent = "Cancel";
          cancel.addEventListener("click", () => {
            void configureProduct(
              {
                kind: "computer.cancel-workspace-edit",
                operationId: editPreview.operationId,
              },
              "Guarded edit cancelled.",
            );
          });
          const apply = document.createElement("button");
          apply.type = "button";
          apply.className = "primary-action";
          apply.textContent = "Apply guarded edit";
          apply.disabled = true;
          const updateApplyState = () => {
            apply.disabled =
              oldText.value.length === 0 || oldText.value === newText.value;
          };
          oldText.addEventListener("input", updateApplyState);
          newText.addEventListener("input", updateApplyState);
          apply.addEventListener("click", () => {
            const command = ProductConfigurationCommandSchema.safeParse({
              kind: "computer.apply-workspace-edit",
              operationId: editPreview.operationId,
              oldText: oldText.value,
              newText: newText.value,
            });
            if (!command.success) return;
            void configureProduct(
              command.data,
              `${workspace.label} edit applied.`,
            );
          });
          controls.append(cancel, apply);
          evidence.append(heading, note, oldLabel, newLabel, controls);
        } else {
          heading.textContent = `${workspaceEvidence.operation === "edit" ? "Edited" : "Wrote"} ${workspaceEvidence.relativePath} · ${workspaceEvidence.bytes} bytes`;
          const receipt = document.createElement("p");
          receipt.textContent = `${workspaceEvidence.replacements} exact replacement${workspaceEvidence.replacements === 1 ? "" : "s"} · ${workspaceEvidence.beforeSha256?.slice(0, 12) ?? "new file"} → ${workspaceEvidence.afterSha256.slice(0, 12)} · ${workspaceEvidence.resultRetention}${workspaceEvidence.redelivered ? " · redelivered" : ""}`;
          evidence.append(heading, receipt);
        }
        card.append(evidence);
      }
      return card;
    }),
  );
}

async function acknowledgeChatGptTaskResult(
  operationId: string,
): Promise<void> {
  let transport: ConfigurationTransport;
  try {
    transport = {
      settled: "fulfilled",
      value: await window.farolNext.configure({
        kind: "chatgpt.ack-task-result",
        operationId,
      }),
    };
  } catch {
    transport = { settled: "rejected" };
  }
  const outcome = classifyConfigurationResponse(transport);
  if (outcome.kind !== "applied") {
    // Only a valid refusal proves the acknowledgement was not saved.
    settingsFeedback =
      outcome.kind === "refused"
        ? "The task result is visible, but its delivery acknowledgement could not be saved. It will be redelivered after restart."
        : "The task result is visible, but its delivery acknowledgement could not be confirmed. If it was not saved, the result will be redelivered after restart.";
    settingsFeedbackError = true;
    render();
    return;
  }
  bootstrap = {
    ...bootstrap,
    configuration: outcome.result.snapshot,
    chatgptRecoveryPending: false,
  };
}

// Clears the undelivered-result record of one guarded edit after its outcome
// was shown.  A lost reply leaves the record, and the edit stays observable.
async function acknowledgeWorkspaceEdit(operationId: string): Promise<void> {
  let transport: ConfigurationTransport;
  try {
    transport = {
      settled: "fulfilled",
      value: await window.farolNext.configure({
        kind: "computer.ack-workspace-edit",
        operationId,
      }),
    };
  } catch {
    transport = { settled: "rejected" };
  }
  const outcome = classifyConfigurationResponse(transport);
  if (outcome.kind === "unconfirmed") return;
  bootstrap = { ...bootstrap, configuration: outcome.result.snapshot };
  render();
}

async function configureProduct(
  command: ProductConfigurationCommand,
  successMessage: string,
): Promise<boolean> {
  // While Setup is open it is the only visible surface — a failure or
  // success routed to the Computer or Settings panel behind a modal dialog
  // would never be seen (UX34-09: the step being worked on must always show
  // its own pending/success/failure state, not rely on Activity or a
  // panel the dialog is covering).
  settingsFeedbackSurface = setupJourney.open
    ? "setup"
    : command.kind.startsWith("computer.")
      ? "computer"
      : "settings";
  if (
    command.kind === "computer.verify-workspace" ||
    command.kind === "computer.list-workspace" ||
    command.kind === "computer.search-workspace" ||
    command.kind === "computer.run-git-status" ||
    command.kind === "computer.prepare-workspace-edit" ||
    command.kind === "computer.update-access" ||
    command.kind === "computer.update-commands" ||
    command.kind === "computer.update-exclusions" ||
    command.kind === "computer.remove-workspace"
  ) {
    workspaceEvidence = null;
  }
  settingsFeedback =
    command.kind === "support.export"
      ? "Preparing a content-free support export…"
      : command.kind === "connector.select-client"
        ? "Verifying the exact tunnel-client executable and supported CLI surface…"
        : command.kind === "connector.configure"
          ? "Saving the tunnel ID and private runtime-key reference…"
          : command.kind === "connector.check-attachment"
            ? "Checking the one-time connector receipt against this runtime, build, and Computer authority…"
            : command.kind === "connector.start"
              ? "Checking the profile, starting one owned connector, and waiting for loopback readiness…"
              : command.kind === "connector.repair"
                ? "Stopping the known connector, rebuilding its profile, and checking readiness once…"
                : command.kind === "connector.stop"
                  ? "Stopping the owned connector and clearing runtime proof…"
                  : command.kind === "host.select-codex" ||
                      command.kind === "host.verify-codex"
                    ? "Verifying the selected Codex executable and bounded App Server contract…"
                    : command.kind === "host.run-codex-smoke"
                      ? "Running one bounded gpt-6-astra host turn with a correlated Farol Next tool…"
                      : command.kind === "host.run-codex-agent-check"
                        ? "Running Main → Agent → Critic with one preserved read-only TaskGrant…"
                        : command.kind === "host.remove-codex"
                          ? "Removing the saved Codex host selection…"
                          : command.kind === "chatgpt.prepare-attachment-task"
                            ? "Validating and privately staging the selected attachments…"
                            : command.kind === "chatgpt.submit-attachment-task"
                              ? "Uploading the reviewed attachments and submitting once…"
                              : command.kind ===
                                  "chatgpt.cancel-attachment-task"
                                ? "Removing the private attachment staging…"
                                : command.kind ===
                                    "chatgpt.prepare-readonly-task"
                                  ? "Reading the selected file for review…"
                                  : command.kind ===
                                      "chatgpt.submit-readonly-task"
                                    ? "Submitting once and waiting for one ChatGPT result…"
                                    : command.kind ===
                                        "chatgpt.cancel-readonly-task"
                                      ? "Discarding the prepared context…"
                                      : command.kind ===
                                          "chatgpt.reset-conversation"
                                        ? "Clearing the retained conversation binding…"
                                        : command.kind ===
                                            "computer.prepare-workspace-edit"
                                          ? "Reading the selected file and preparing a content-free edit review…"
                                          : command.kind ===
                                              "computer.run-git-status"
                                            ? "Running fixed Apple Git status with no network access…"
                                            : command.kind ===
                                                "computer.run-git-head"
                                              ? "Reading exact Git HEAD with fixed Apple Git and no network access…"
                                              : command.kind ===
                                                  "computer.apply-workspace-edit"
                                                ? "Applying this guarded edit once…"
                                                : command.kind ===
                                                    "computer.cancel-workspace-edit"
                                                  ? "Discarding the prepared edit…"
                                                  : "Saving and reading back…";
  settingsFeedbackError = false;
  render();
  // The IPC promise can reject after the main process already admitted the
  // command. The rejection is caught here, never left unhandled at the
  // fire-and-forget `void configureProduct(...)` call sites, and treated like
  // a malformed reply: the outcome is unconfirmed, not refused.
  let transport: ConfigurationTransport;
  try {
    transport = {
      settled: "fulfilled",
      value: await window.farolNext.configure(command),
    };
  } catch {
    transport = { settled: "rejected" };
  }
  const outcome = classifyConfigurationResponse(transport);
  const editToAcknowledge = workspaceEditToAcknowledge(command, outcome);
  if (editToAcknowledge) {
    queueMicrotask(() => {
      void acknowledgeWorkspaceEdit(editToAcknowledge);
    });
  }
  if (outcome.kind === "unconfirmed") {
    // Neither a malformed reply nor a lost promise proves the command was
    // not applied, so this must not claim "nothing was applied" — see
    // UNCONFIRMED_CONFIGURATION_MESSAGE. No snapshot is adopted either.
    settingsFeedback = UNCONFIRMED_CONFIGURATION_MESSAGE;
    settingsFeedbackError = true;
    render();
    return false;
  }
  const parsed = outcome.result;
  bootstrap = { ...bootstrap, configuration: parsed.snapshot };
  renderedGeneralSettingsRevision = -1;
  renderedComputerSettingsRevision = -1;
  if (!parsed.ok) {
    if (
      command.kind === "chatgpt.submit-readonly-task" ||
      command.kind === "chatgpt.cancel-readonly-task" ||
      command.kind === "chatgpt.submit-attachment-task" ||
      command.kind === "chatgpt.cancel-attachment-task"
    ) {
      pendingChatGptPreview = null;
      if (shellOverlay === "context-preview") shellOverlay = "none";
    }
    const absence = modelEvidenceAbsenceAfterFailure(
      parsed.error,
      command.kind,
    );
    if (absence) {
      modelStatusEvidence = null;
      modelEvidenceAbsence = absence;
    }
    const cancellation = [
      "WORKSPACE_PICKER_CANCELLED",
      "WORKSPACE_FILE_PICKER_CANCELLED",
      "CHATGPT_ATTACHMENT_PICKER_CANCELLED",
      "CODEX_HOST_PICKER_CANCELLED",
      "TUNNEL_CLIENT_PICKER_CANCELLED",
      "SUPPORT_EXPORT_CANCELLED",
    ].includes(parsed.error);
    settingsFeedback = cancellation
      ? "No selection was made."
      : parsed.error === "CODEX_AGENT_STILL_RUNNING"
        ? "The same native Agent child is still running. Use Rejoin Agent to collect its result; no second child will be created."
        : parsed.error === "CODEX_AGENT_LIVE_OUTCOME_UNKNOWN"
          ? "Native Agent outcome unknown. Inspect the existing Codex task before any deliberate recovery."
          : parsed.error === "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
            ? "Connector readiness is unknown. Inspect the current connector before an explicit Repair."
            : parsed.error === "CONNECTOR_ATTACHMENT_NOT_FOUND"
              ? "No connector receipt exists yet. Attach this tunnel in ChatGPT, run the displayed one-time challenge, then check again."
              : parsed.error === "CONNECTOR_ATTACHMENT_INVALID"
                ? "The connector receipt does not match this runtime, build, workspace, or Computer authority. Stop and deliberately start a fresh challenge."
                : parsed.error === "CONNECTOR_CHALLENGE_UNAVAILABLE"
                  ? "No current connector challenge is available. Start the connector before checking its ChatGPT attachment."
                  : parsed.error === "CONNECTOR_STOP_REQUIRED"
                    ? "Stop the connector before changing Computer authority or connector identity."
                    : parsed.error === "WORKSPACE_MUTATION_RESULT_PENDING"
                      ? "The last guarded edit has no delivered result yet. Check its result first."
                      : parsed.error === "WORKSPACE_MUTATION_NOT_ADMITTED"
                        ? "The last guarded edit was never admitted, so nothing was changed."
                        : parsed.error === "WORKSPACE_MUTATION_NOT_PENDING"
                          ? "There is no undelivered edit result to check."
                          : parsed.error === "WORKSPACE_NOT_GIT_REPOSITORY"
                            ? "This workspace is not a Git repository."
                            : parsed.error === "WORKSPACE_GIT_HEAD_UNBORN"
                              ? "This repository has no commits yet, so there is no HEAD commit to read."
                              : parsed.error ===
                                  "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED"
                                ? "This repository borrows objects from another object store (objects/info/alternates), which the fixed Git checks cannot follow. Nothing was read."
                                : parsed.error ===
                                    "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT"
                                  ? "The repository index changed while the check was being prepared, so no single instant could be reported. Run the check again."
                                  : parsed.error ===
                                      "WORKSPACE_CHANGED_DURING_SNAPSHOT"
                                    ? "A tracked file changed while the check was being prepared, so no single instant could be reported. Run the check again."
                                    : parsed.error ===
                                        "WORKSPACE_TRACKED_LIST_TOO_LARGE"
                                      ? "This repository tracks more files than one check can list. Nothing was read."
                                      : parsed.error ===
                                          "WORKSPACE_TRACKED_PATH_UNSUPPORTED"
                                        ? "A tracked path in this repository contains a character the fixed Git checks will not carry (a backslash or a line break). Nothing was reported."
                                        : parsed.error ===
                                            "WORKSPACE_SNAPSHOT_TOO_LARGE"
                                          ? "The tracked files are too large to snapshot for one check. Nothing was read."
                                          : parsed.error ===
                                              "WORKSPACE_SNAPSHOT_CROSS_VOLUME"
                                            ? "The workspace and Farol Next's runtime directory are on different volumes, so the private snapshot cannot be made. Nothing was read."
                                            : parsed.error ===
                                                "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED"
                                              ? "This volume cannot make file clones (it is not APFS), so the private snapshot cannot be made. Nothing was read."
                                              : parsed.error ===
                                                  "WORKSPACE_SELECTION_PROTECTED"
                                                ? "This folder holds credentials, so it cannot be a workspace. Choose a project folder instead."
                                                : parsed.error ===
                                                    "ROUTE_B_OUTCOME_UNKNOWN"
                                                  ? "Route B's check may have reached ChatGPT, but its result was not observed. Inspect the Codex task before checking again."
                                                  : parsed.error ===
                                                      "ROUTE_B_HOST_START_FAILED"
                                                    ? "The isolated Codex host for Route B did not start. Nothing was sent."
                                                    : parsed.error ===
                                                        "ROUTE_B_UNAVAILABLE"
                                                      ? "Route B is not running in this app. Restart Farol Next and check again."
                                                      : parsed.error ===
                                                          "WORKSPACE_GIT_METADATA_NOT_APPROVED"
                                                        ? "This worktree's Git metadata lives outside the workspace and has not been approved. Verify the workspace again to approve it."
                                                        : parsed.error ===
                                                            "CODEX_HOST_TASK_IN_PROGRESS"
                                                          ? "A native Agent task is still running. Stop it from its task, or let it finish, then change Computer access or the Codex host."
                                                          : parsed.error ===
                                                              "WORKSPACE_ROOT_CHANGED"
                                                            ? "A different folder now has this workspace's path. Nothing was read or changed. Remove the workspace and add the folder again to approve it."
                                                            : parsed.error ===
                                                                "MODEL_ENDPOINT_UNAVAILABLE"
                                                              ? "Farol Model is not running. Nothing was read or changed."
                                                              : parsed.error ===
                                                                  "MODEL_CONFIG_INSECURE_PERMISSIONS"
                                                                ? "Refusing to write the connection because config.toml is readable by group or other. Fix its permissions and try again."
                                                                : parsed.error ===
                                                                    "MODEL_CONFIG_CONFLICT"
                                                                  ? "config.toml already has a hand-written entry with the same name. Nothing was overwritten."
                                                                  : parsed.error ===
                                                                      "MODEL_CONFIG_SYMLINK"
                                                                    ? "config.toml is a symbolic link. Farol only writes a regular file; nothing was changed."
                                                                    : parsed.error ===
                                                                        "MODEL_CONFIG_MALFORMED"
                                                                      ? "config.toml has a damaged Farol marker. Repair or remove the marked block by hand; nothing was changed."
                                                                      : parsed.error ===
                                                                          "MODEL_TOKEN_ROTATE_FAILED"
                                                                        ? "Token rotation did not complete. Check status and preview the connection before trying again."
                                                                        : parsed.error ===
                                                                            "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED"
                                                                          ? "The Farol block in config.toml could not be rewritten, so the token was left as it is and Codex still connects. Repair the marked block, then rotate again."
                                                                          : parsed.error ===
                                                                              "FAROL_MODEL_ROTATE_RESTORE_FAILED"
                                                                            ? "The Farol block in config.toml could not be rewritten and the previous token could not be put back, so Farol Model now accepts no token at all. Preview and Apply the connection again to reconnect Codex."
                                                                            : parsed.error ===
                                                                                  "MODEL_CONFIG_APPLY_FAILED" ||
                                                                                parsed.error ===
                                                                                  "MODEL_CONFIG_ROLLBACK_FAILED"
                                                                              ? "config.toml could not be changed. Nothing was left half-written."
                                                                              : (transitionRefusalMessage(
                                                                                  parsed.error,
                                                                                ) ??
                                                                                workspaceEditRefusalMessage(
                                                                                  parsed.error,
                                                                                ) ??
                                                                                `Not applied · ${parsed.error}`);
    settingsFeedbackError =
      !cancellation && parsed.error !== "CODEX_AGENT_STILL_RUNNING";
    render();
    return false;
  }
  const evidence = parsed.evidence;
  let evidenceError = false;
  let taskResultToAcknowledge: string | null = null;
  if (evidence?.kind === "computer.workspace-read") {
    workspaceEvidence = evidence;
    settingsFeedback = `Read ${evidence.bytes} bytes from ${evidence.relativePath}. Nothing from the file was persisted.`;
  } else if (evidence?.kind === "computer.workspace-list") {
    workspaceEvidence = evidence;
    if (command.kind === "computer.verify-workspace") {
      // This one bounded top-level listing is the whole proof: Farol can
      // open the approved folder. It says nothing about reading file
      // contents, writing, or Git — those are separate checks the owner
      // can run afterward, and a blank folder (0 items) is a pass too.
      const label =
        parsed.snapshot.status === "ready"
          ? (parsed.snapshot.settings.computer.workspaces.find(
              (workspace) => workspace.workspaceId === evidence.workspaceId,
            )?.label ?? "this folder")
          : "this folder";
      settingsFeedback = `Farol can open ${label} (${evidence.entries.length} ${evidence.entries.length === 1 ? "item" : "items"} at the top level).`;
    } else {
      const location =
        evidence.relativePath === "."
          ? "the workspace root"
          : evidence.relativePath;
      settingsFeedback = `Listed ${evidence.entries.length} ${evidence.entries.length === 1 ? "entry" : "entries"} from ${location}${evidence.truncated ? " (result limited)" : ""}.`;
    }
  } else if (evidence?.kind === "computer.workspace-search") {
    workspaceEvidence = evidence;
    settingsFeedback = `Found ${evidence.matches.length} ${evidence.matches.length === 1 ? "match" : "matches"} for "${evidence.pattern}"${evidence.resultLimited || evidence.scanLimited ? " (result limited)" : ""}.`;
  } else if (evidence?.kind === "computer.workspace-command") {
    workspaceEvidence = evidence;
    settingsFeedback = `Fixed ${evidence.command === "git.status" ? "Git status" : "Git HEAD"} completed · exit ${evidence.exitCode} · ${evidence.outputBytes} bytes · network ${evidence.network}.`;
  } else if (evidence?.kind === "computer.workspace-edit-preview") {
    workspaceEvidence = evidence;
    settingsFeedback = `Review one exact replacement in ${evidence.relativePath}. Nothing has been changed.`;
  } else if (evidence?.kind === "computer.workspace-mutation") {
    workspaceEvidence = evidence;
    settingsFeedback = `${evidence.operation === "edit" ? "Edited" : "Wrote"} ${evidence.relativePath} once · ${evidence.resultRetention}${evidence.redelivered ? " · result redelivered" : ""}.`;
  } else if (evidence?.kind === "chatgpt.readiness") {
    settingsFeedback =
      evidence.state === "authenticated"
        ? "ChatGPT composer verified in the isolated Next partition."
        : evidence.state === "signed_out"
          ? "The isolated ChatGPT page is reachable and needs sign-in."
          : evidence.state === "unreachable"
            ? "The isolated ChatGPT page could not be reached."
            : "ChatGPT loaded, but its composer could not be verified.";
  } else if (evidence?.kind === "support.exported") {
    settingsFeedback = `Saved ${evidence.fileName} · ${evidence.bytes} bytes · ${evidence.sha256.slice(0, 12)}.`;
  } else if (evidence?.kind === "model.status") {
    modelStatusEvidence = evidence;
    modelEvidenceAbsence = "no-evidence-yet";
    settingsFeedback =
      evidence.state === "connected"
        ? `Farol Model connected on port ${evidence.port} · ${evidence.requestsServed} request${evidence.requestsServed === 1 ? "" : "s"} served.`
        : evidence.state === "listening"
          ? `Farol Model is listening on port ${evidence.port}, waiting for a request.`
          : modelPortConflictText(evidence.port, evidence.occupant);
  } else if (evidence?.kind === "model.config-preview") {
    modelConfigPreviewEvidence = evidence;
    modelConfigApplied = false;
    settingsFeedback =
      evidence.providerBlockStatus === "insecure_permissions"
        ? `Refusing to write the connection: ${evidence.configPath} is readable by group or other (mode ${evidence.providerBlockInsecureMode?.toString(8)}). Fix its permissions first.`
        : evidence.providerBlockStatus === "symlink"
          ? `Refusing to touch ${evidence.configPath}: it is a symbolic link. Farol only writes a regular file.`
          : evidence.providerBlockStatus === "malformed"
            ? `${evidence.configPath} has a damaged Farol marker. Repair or remove the marked block by hand, then preview again.`
            : evidence.providerBlockStatus === "conflict"
              ? `${evidence.configPath} already has a hand-written entry with the same name — nothing will be overwritten.`
              : evidence.providerBlockStatus === "noop"
                ? "The connection is already configured exactly this way."
                : `Review the exact change to ${evidence.configPath} before applying it.`;
  } else if (evidence?.kind === "model.config-applied") {
    modelConfigApplied = true;
    modelConfigCodexHost = evidence.codexHost;
    settingsFeedback = `${
      evidence.providerSelectionApplied
        ? "Applied the Farol connection and set it as the default provider."
        : "Applied the Farol connection."
    } ${modelRestartNoteText(evidence.codexHost)}`;
  } else if (evidence?.kind === "model.config-rollback") {
    modelConfigPreviewEvidence = null;
    modelConfigApplied = false;
    modelConfigCodexHost = null;
    settingsFeedback =
      evidence.providerBlockRestored || evidence.providerSelectionRestored
        ? "Removed Farol's managed block from config.toml; everything else in the file is as you left it."
        : "There was nothing to roll back.";
  } else if (evidence?.kind === "model.token-rotated") {
    settingsFeedback = evidence.providerBlockUpdated
      ? "Rotated the Farol Model token and rewrote it in your Codex config.toml. The old token no longer works; a running Codex needs a restart to use the new one."
      : evidence.providerBlockStatus === "install"
        ? "Rotated the Farol Model token. The connection is not written to config.toml yet, so nothing else changed."
        : `Rotated the Farol Model token, but config.toml was not updated (${evidence.providerBlockStatus.replace("_", " ")}). Preview the connection to see why.`;
  } else if (evidence?.kind === "host.codex-probe") {
    settingsFeedback = `Codex ${evidence.version} contract verified · ${evidence.protocol} · executable ${evidence.executableSha256.slice(0, 12)} · schema ${evidence.schemaSha256.slice(0, 12)}.`;
  } else if (evidence?.kind === "host.route-b") {
    settingsFeedback = `Route B answered through ChatGPT on ${evidence.model} · ${evidence.observedCharacters} characters in ${evidence.deltaCount} ${evidence.deltaCount === 1 ? "update" : "updates"}.`;
  } else if (evidence?.kind === "host.codex-live") {
    settingsFeedback = `${evidence.model} host turn completed with ${evidence.dynamicToolCalls} correlated Farol Next tool call · executable ${evidence.executableSha256.slice(0, 12)} · schema ${evidence.schemaSha256.slice(0, 12)}.`;
  } else if (evidence?.kind === "host.codex-agent-lineage") {
    settingsFeedback = `Main → Agent → Critic verified on ${evidence.model} · one model turn · same-child bounded rejoin · durable delivery acknowledged · workspace enforcement ${evidence.workspaceEnforcement.replace("_", " ")}.`;
  } else if (evidence?.kind === "connector.client-probe") {
    settingsFeedback = `tunnel-client ${evidence.version} verified · ${evidence.protocol} · executable ${evidence.executableSha256.slice(0, 12)}.`;
  } else if (evidence?.kind === "host.codex-discovery") {
    discoveredCodexCandidates = evidence;
    const offered = evidence.candidates.filter(
      (candidate) => candidate.verdict === "offer",
    ).length;
    settingsFeedback =
      evidence.candidates.length === 0
        ? "No local Codex executable was found in any searched location."
        : `Found ${evidence.candidates.length} local ${evidence.candidates.length === 1 ? "candidate" : "candidates"}${offered > 0 ? `, ${offered} ready to use` : ", none trusted automatically"}.`;
  } else if (evidence?.kind === "connector.client-discovery") {
    discoveredTunnelClientCandidates = evidence;
    const offered = evidence.candidates.filter(
      (candidate) => candidate.verdict === "offer",
    ).length;
    settingsFeedback =
      evidence.candidates.length === 0
        ? "No local tunnel-client executable was found in any searched location."
        : `Found ${evidence.candidates.length} local ${evidence.candidates.length === 1 ? "candidate" : "candidates"}${offered > 0 ? `, ${offered} ready to use` : ", none trusted automatically"}.`;
  } else if (evidence?.kind === "connector.runtime") {
    settingsFeedback = `Connector ${evidence.state.replace("_", " ")} · runtime ${evidence.runtimeGeneration.slice(0, 12)} · Computer generation ${evidence.computerGeneration}.`;
  } else if (evidence?.kind === "connector.attachment") {
    settingsFeedback = `ChatGPT attachment verified · workspace ${evidence.workspaceId.slice(0, 12)} · runtime ${evidence.runtimeGeneration.slice(0, 12)} · receipt ${evidence.receiptSha256.slice(0, 12)}.`;
  } else if (evidence?.kind === "chatgpt.readonly-task-preview") {
    pendingChatGptPreview = evidence;
    shellOverlay = "context-preview";
    settingsFeedback = `Review ${evidence.relativePath} before sending it once.`;
  } else if (evidence?.kind === "chatgpt.attachment-task-preview") {
    pendingChatGptPreview = evidence;
    shellOverlay = "context-preview";
    settingsFeedback = `Review ${evidence.attachments.length} staged attachment${evidence.attachments.length === 1 ? "" : "s"} before sending once.`;
  } else if (evidence?.kind === "chatgpt.readonly-task") {
    pendingChatGptPreview = null;
    if (shellOverlay === "context-preview") shellOverlay = "none";
    evidenceError = evidence.state !== "completed";
    settingsFeedback =
      evidence.state === "completed"
        ? `Read-only task completed from ${evidence.relativePath} after ${evidence.deltaCount} incremental update${evidence.deltaCount === 1 ? "" : "s"}. File and answer text were not persisted${evidence.redelivered ? "; result receipt redelivered" : ""}. Conversation continuity: ${evidence.conversationContinuity.replace("_", " ")}.`
        : evidence.state === "outcome_unknown"
          ? `Outcome unknown · ${evidence.code ?? "CHATGPT_TASK_ERROR"}. Inspect the isolated ChatGPT window before another task.`
          : evidence.state === "not_authenticated"
            ? "The isolated ChatGPT session needs sign-in before this task can start."
            : `Task not submitted · ${evidence.code ?? "CHATGPT_TASK_ERROR"}.`;
    if (evidence.deliveryAckRequired) {
      taskResultToAcknowledge = evidence.operationId;
    }
    bootstrap = {
      ...bootstrap,
      chatgptConversationState:
        evidence.conversationContinuity === "not_observed"
          ? bootstrap.chatgptConversationState
          : evidence.conversationContinuity,
    };
  } else if (evidence?.kind === "chatgpt.attachment-task") {
    pendingChatGptPreview = null;
    if (shellOverlay === "context-preview") shellOverlay = "none";
    evidenceError = evidence.state !== "completed";
    settingsFeedback =
      evidence.state === "completed"
        ? `${evidence.attachmentCount} attachment${evidence.attachmentCount === 1 ? "" : "s"} delivered intact · ${evidence.deltaCount} incremental update${evidence.deltaCount === 1 ? "" : "s"} · staging ${evidence.stagingCleanup === "removed" ? "removed" : "awaiting startup cleanup"}${evidence.redelivered ? " · result receipt redelivered" : ""} · conversation ${evidence.conversationContinuity.replace("_", " ")}.`
        : evidence.state === "outcome_unknown"
          ? `Attachment task outcome unknown · ${evidence.code ?? "CHATGPT_TASK_ERROR"}. Inspect the isolated ChatGPT window before another task.`
          : evidence.state === "not_authenticated"
            ? "The isolated ChatGPT session needs sign-in before attachments can be sent."
            : `Attachments not submitted · ${evidence.code ?? "CHATGPT_TASK_ERROR"}.`;
    if (evidence.deliveryAckRequired) {
      taskResultToAcknowledge = evidence.operationId;
    }
    bootstrap = {
      ...bootstrap,
      chatgptConversationState:
        evidence.conversationContinuity === "not_observed"
          ? bootstrap.chatgptConversationState
          : evidence.conversationContinuity,
    };
  } else if (evidence?.kind === "chatgpt.task-recovery") {
    evidenceError = evidence.state !== "completed";
    settingsFeedback =
      evidence.state === "completed"
        ? `Recovered the previous ${evidence.taskKind} task result · ${evidence.deltaCount} incremental update${evidence.deltaCount === 1 ? "" : "s"}. Prompt, response, paths, and attachment contents were not persisted.`
        : evidence.state === "outcome_unknown"
          ? `Previous ChatGPT task outcome unknown · ${evidence.code ?? "CHATGPT_TASK_ERROR"}. Nothing was submitted again; inspect the isolated ChatGPT window before another task.`
          : evidence.state === "not_authenticated"
            ? "Recovered a task that stopped before sign-in. Nothing was submitted again."
            : `Recovered a task that failed before submit · ${evidence.code ?? "CHATGPT_TASK_ERROR"}. Nothing was submitted again.`;
    if (evidence.deliveryAckRequired) {
      taskResultToAcknowledge = evidence.operationId;
    }
    bootstrap = {
      ...bootstrap,
      chatgptConversationState:
        evidence.conversationContinuity === "not_observed"
          ? bootstrap.chatgptConversationState
          : evidence.conversationContinuity,
    };
  } else if (evidence?.kind === "chatgpt.conversation-reset") {
    bootstrap = { ...bootstrap, chatgptConversationState: "new" };
    settingsFeedback =
      "Retained conversation binding cleared. The next task starts a fresh isolated ChatGPT conversation.";
  } else {
    settingsFeedback = successMessage;
  }
  if (command.kind === "chatgpt.cancel-readonly-task") {
    pendingChatGptPreview = null;
    if (shellOverlay === "context-preview") shellOverlay = "none";
  }
  if (command.kind === "chatgpt.cancel-attachment-task") {
    pendingChatGptPreview = null;
    if (shellOverlay === "context-preview") shellOverlay = "none";
  }
  if (command.kind === "computer.cancel-workspace-edit") {
    workspaceEvidence = null;
  }
  settingsFeedbackError = evidenceError;
  if (
    command.kind === "general.update" &&
    bootstrap.configuration.status === "ready"
  ) {
    sidebarPreference = bootstrap.configuration.settings.general.sidebarDefault;
  }
  render();
  if (taskResultToAcknowledge) {
    queueMicrotask(() => {
      void acknowledgeChatGptTaskResult(taskResultToAcknowledge);
    });
  }
  return true;
}

// Called whenever the main process brings the owner back to Setup
// ("open-settings" — see onShellAction below). It is always safe to call:
// `chatgpt.sign-in-return` reads the current settings snapshot only, never
// probes the ChatGPT page itself, and never shows a "Verifying…" message
// the way `configureProduct` does — the sign-in surface's own window
// close already recorded a truthful observation (UX34-08). A failure here
// leaves the existing "Check connection" action as the correct fallback.
async function refreshSettingsAfterReturn(): Promise<void> {
  try {
    const parsed = ProductConfigurationResultSchema.safeParse(
      await window.farolNext.configure({ kind: "chatgpt.sign-in-return" }),
    );
    if (parsed.success && parsed.data.ok) {
      bootstrap = { ...bootstrap, configuration: parsed.data.snapshot };
      renderedGeneralSettingsRevision = -1;
      renderedComputerSettingsRevision = -1;
      render();
    }
  } catch {
    // Best-effort refresh only.
  }
}

function connectorChallengeCard(
  settings: ReadySettings,
): HTMLDivElement | null {
  const connector = settings.connectors.secureMcp;
  const challenge = connector.challenge;
  if (!challenge) return null;
  const verifiedWorkspaceId = settings.setup.computer.verified?.workspaceId;
  const workspace =
    settings.computer.workspaces.find(
      (candidate) => candidate.workspaceId === verifiedWorkspaceId,
    ) ?? settings.computer.workspaces[0];
  if (!workspace) return null;

  const card = document.createElement("div");
  card.className = "connector-challenge";
  card.dataset.connectorChallenge = "pending";
  const title = document.createElement("strong");
  title.textContent = "Verify from ChatGPT";
  const instruction = document.createElement("p");
  instruction.textContent = `Attach tunnel ${connector.tunnelId ?? "(not set)"} in ChatGPT Settings. Ask the connector to call farol_next_connector_verify once with:`;
  const values = document.createElement("dl");
  for (const [label, value] of [
    ["challenge", challenge.value],
    ["workspaceId", workspace.workspaceId],
  ] as const) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    const code = document.createElement("code");
    code.textContent = value;
    detail.append(code);
    row.append(term, detail);
    values.append(row);
  }
  const note = document.createElement("small");
  note.textContent =
    "The one-time check lists only the approved workspace root and returns counts, never names or file contents.";
  card.append(title, instruction, values, note);
  return card;
}

function renderSettings(): void {
  const configured = bootstrap.configuration;
  const values = [
    [
      "Application",
      `${DISPLAY_PRODUCT_NAME} · ${DISPLAY_EDITION} · ${bootstrap.bundleId}`,
    ],
    [
      "Build",
      `${bootstrap.build.version} · ${bootstrap.build.sourceCommit.slice(0, 12)} · ${bootstrap.build.builtAt}`,
    ],
    [
      "Runtime",
      `${bootstrap.runtimeState} · ${bootstrap.runtimeIdentity ?? "not started"}${bootstrap.runtimeError ? ` · ${bootstrap.runtimeError}` : ""}`,
    ],
    [
      "Secure MCP connector",
      configured.status === "ready"
        ? configured.settings.connectors.secureMcp.tunnelClient
          ? `tunnel-client ${configured.settings.connectors.secureMcp.tunnelClient.version} · tunnel ${configured.settings.connectors.secureMcp.tunnelId ?? "not set"} · runtime ${configured.settings.connectors.secureMcp.runtime?.state ?? "stopped"} · attachment ${configured.settings.connectors.secureMcp.attachment ? "verified" : "not verified"}`
          : "tunnel-client not selected"
        : "Unavailable",
    ],
    [
      "Embedded closure",
      `Electron ${bootstrap.embeddedElectron ?? "unknown"} · Node ${bootstrap.embeddedNode ?? "unknown"}`,
    ],
    ["Browser partition", bootstrap.partition],
    ["ChatGPT partition", bootstrap.chatgptPartition],
    ["Update channel", bootstrap.updateChannel],
    ["Typeface", "Geist 1.7.2 · SIL OFL 1.1 · system fallback"],
    [
      "Native Codex host",
      configured.status === "ready" && configured.settings.nativeHosts.codex
        ? `Codex ${configured.settings.nativeHosts.codex.version} · ${configured.settings.nativeHosts.codex.protocol} · contract ${configured.settings.nativeHosts.codex.verifiedAt} · live ${configured.settings.nativeHosts.codex.liveVerification?.verifiedAt ?? "not run"} · Agent ${configured.settings.nativeHosts.codex.agentVerification?.verifiedAt ?? "not verified"}`
        : "Not selected",
    ],
    [
      "Task authority",
      "Contract-tested · Main Turn → Agent → Critic continuity with explicit owner narrowing",
    ],
    [
      "Native access",
      configured.status === "ready" &&
      configured.settings.computer.workspaces.length > 0
        ? configured.settings.nativeHosts.codex?.agentVerification
          ? `${configured.settings.computer.workspaces.length} approved workspace(s) · Agent lineage verified · native workspace enforcement ${configured.settings.nativeHosts.codex.agentVerification.workspaceEnforcement === "verified" ? "verified" : "not verified"}`
          : `${configured.settings.computer.workspaces.length} approved workspace(s) · Agent lineage not verified`
        : "No workspace approved · Agent lineage not verified",
    ],
  ];
  const list = required<HTMLDListElement>("#settings-list");
  list.replaceChildren(
    ...values.map(([name, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = name ?? "";
      const detail = document.createElement("dd");
      detail.textContent = value ?? "";
      row.append(term, detail);
      return row;
    }),
  );

  renderConfigurationFeedback("#settings-feedback", "settings");
  const formControls = [
    required<HTMLSelectElement>("#setting-open-at-launch"),
    required<HTMLSelectElement>("#setting-sidebar-default"),
    required<HTMLSelectElement>("#setting-activity-detail"),
  ] as const;
  const applyGeneral = required<HTMLButtonElement>("#apply-general-settings");
  const connections = required<HTMLDivElement>("#connection-readiness");
  const computerReadiness = required<HTMLSpanElement>(
    "#settings-computer-readiness",
  );
  const computerSummary = required<HTMLParagraphElement>(
    "#settings-computer-summary",
  );

  if (configured.status === "error") {
    for (const control of formControls) control.disabled = true;
    applyGeneral.disabled = true;
    connections.textContent =
      "Readiness is unavailable while settings are invalid.";
    computerReadiness.textContent = "Unavailable";
    computerReadiness.classList.remove("verified");
    computerSummary.textContent =
      "Repair settings before changing workspace authority.";
    return;
  }

  const settings = configured.settings;
  for (const control of formControls) control.disabled = false;
  applyGeneral.disabled = false;
  if (
    renderedGeneralSettingsRevision !== settings.revision &&
    !formControls.includes(document.activeElement as HTMLSelectElement)
  ) {
    formControls[0].value = settings.general.openAtLaunch;
    formControls[1].value = settings.general.sidebarDefault;
    formControls[2].value = settings.general.activityDetail;
    renderedGeneralSettingsRevision = settings.revision;
  }

  const computerState = settings.setup.computer;
  computerReadiness.textContent = readinessLabel(computerState);
  computerReadiness.classList.toggle(
    "verified",
    computerState.verified !== null,
  );
  const workspaceCount = settings.computer.workspaces.length;
  computerSummary.textContent = `${settings.computer.name} · ${workspaceCount} approved ${workspaceCount === 1 ? "workspace" : "workspaces"} · ${readinessDetail(computerState)}`;

  const connectionStates: readonly [string, Readiness][] = [
    ["ChatGPT", settings.setup.chatgpt],
    ["Computer", settings.setup.computer],
    ["Connection", settings.setup.connect],
    ["Native hosts", settings.setup.hosts],
    ["Native Agent", settings.setup.verify],
  ];
  // The same four routes the header, New task control, and Setup checklist
  // agree on (chatGptRouteState / computerRouteState / connectRouteState /
  // agentRouteState) — "Native hosts" and "Native Agent" are the two halves
  // of the single Codex/Agent route, so both rows carry its merged state.
  const routeStateForLabel = (label: string): RouteReadinessState => {
    switch (label) {
      case "ChatGPT":
        return chatGptRouteState();
      case "Computer":
        return computerRouteState();
      case "Connection":
        return connectRouteState();
      case "Native hosts":
      case "Native Agent":
        return agentRouteState();
      default:
        return "not-configured";
    }
  };
  connections.replaceChildren(
    ...connectionStates.map(([label, state]) => {
      const row = document.createElement("div");
      row.className = `connection-row route-${routeStatusClass(routeStateForLabel(label))}`;
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${label} · ${readinessLabel(state)}`;
      const detail = document.createElement("small");
      detail.textContent =
        label === "ChatGPT"
          ? `${readinessDetail(state)} · Conversation: ${bootstrap.chatgptConversationState.replace("_", " ")}`
          : label === "Connection"
            ? `${readinessDetail(state)} · ${settings.connectors.secureMcp.tunnelClient ? `tunnel-client ${settings.connectors.secureMcp.tunnelClient.version}` : "client not selected"} · tunnel ${settings.connectors.secureMcp.tunnelId ?? "not set"} · credential ${settings.connectors.secureMcp.credential} · runtime ${settings.connectors.secureMcp.runtime?.state ?? "stopped"}`
            : label === "Native hosts" && settings.nativeHosts.codex
              ? `${readinessDetail(state)} · Codex ${settings.nativeHosts.codex.version} · ${settings.nativeHosts.codex.executablePath}`
              : label === "Native Agent" &&
                  settings.nativeHosts.codex?.agentVerification
                ? `${readinessDetail(state)} · Main → Agent → Critic · one model turn · workspace enforcement ${settings.nativeHosts.codex.agentVerification.workspaceEnforcement === "verified" ? "verified" : "not verified"} · ${settings.nativeHosts.codex.agentVerification.verifiedAt}`
                : readinessDetail(state);
      copy.append(title, detail);
      if (label === "ChatGPT" && bootstrap.chatgptSignInBlocked) {
        const blocked = document.createElement("small");
        blocked.className = "sign-in-blocked-notice";
        blocked.textContent = chatGptSignInBlockedMessage(
          bootstrap.chatgptSignInBlocked,
        );
        copy.append(blocked);
      }
      row.append(copy);
      if (label === "ChatGPT") {
        const actions = document.createElement("span");
        actions.className = "connection-actions";
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = "Open sign-in…";
        open.addEventListener("click", () => {
          void configureProduct(
            { kind: "chatgpt.open-sign-in" },
            "Isolated ChatGPT window opened.",
          );
        });
        const verify = document.createElement("button");
        verify.type = "button";
        verify.textContent = state.verified ? "Recheck" : "Check connection";
        verify.addEventListener("click", () => {
          void configureProduct(
            { kind: "chatgpt.verify" },
            "ChatGPT connection checked.",
          );
        });
        const task = document.createElement("button");
        task.type = "button";
        task.textContent = "Review read-only task…";
        const workspaceId = settings.setup.computer.verified?.workspaceId;
        const conversationUnavailable =
          bootstrap.chatgptConversationState === "review_required" ||
          bootstrap.chatgptConversationState === "unavailable";
        task.disabled =
          !state.verified ||
          workspaceId == null ||
          state.outcomeUnknown ||
          conversationUnavailable;
        task.title = state.outcomeUnknown
          ? "Inspect the existing ChatGPT outcome before another task"
          : conversationUnavailable
            ? "Review or reset the retained ChatGPT conversation first"
            : !state.verified
              ? "Verify ChatGPT first"
              : workspaceId == null
                ? "Verify a read-only workspace first"
                : "Choose one approved text file and summarize it in ChatGPT";
        task.addEventListener("click", () => {
          if (workspaceId == null) return;
          void configureProduct(
            { kind: "chatgpt.prepare-readonly-task", workspaceId },
            "Read-only ChatGPT context prepared.",
          );
        });
        const attachments = document.createElement("button");
        attachments.type = "button";
        attachments.textContent = "Review attachments…";
        attachments.disabled =
          !state.verified || state.outcomeUnknown || conversationUnavailable;
        attachments.title = state.outcomeUnknown
          ? "Inspect the existing ChatGPT outcome before another task"
          : conversationUnavailable
            ? "Review or reset the retained ChatGPT conversation first"
            : !state.verified
              ? "Verify ChatGPT first"
              : "Choose up to four bounded images or documents";
        attachments.addEventListener("click", () => {
          void configureProduct(
            { kind: "chatgpt.prepare-attachment-task" },
            "ChatGPT attachments prepared.",
          );
        });
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "Start fresh chat";
        reset.disabled =
          state.outcomeUnknown ||
          bootstrap.chatgptConversationState === "new" ||
          bootstrap.chatgptConversationState === "unavailable";
        reset.title = state.outcomeUnknown
          ? "Inspect the unknown ChatGPT outcome before clearing its binding"
          : bootstrap.chatgptConversationState === "new"
            ? "No retained conversation exists"
            : bootstrap.chatgptConversationState === "unavailable"
              ? "Conversation state is unavailable"
              : "Clear only the private conversation identifier; sign-in remains isolated";
        reset.addEventListener("click", () => {
          void configureProduct(
            { kind: "chatgpt.reset-conversation" },
            "Retained ChatGPT conversation cleared.",
          );
        });
        actions.append(open, verify, task, attachments, reset);
        row.append(actions);
      } else if (label === "Connection") {
        row.classList.add("connector-row");
        const connector = settings.connectors.secureMcp;
        const running =
          connector.runtime?.state === "ready" ||
          connector.runtime?.state === "outcome_unknown";
        const form = document.createElement("form");
        form.className = "connector-form";
        // The rows are rebuilt on every event; drafts carry what the owner
        // is typing across that rebuild.
        const tunnelDraft = captureInputDraft(
          document.querySelector<HTMLInputElement>(
            "#settings-connector-tunnel",
          ),
          document.activeElement,
        );
        const keyDraft = captureInputDraft(
          document.querySelector<HTMLInputElement>("#settings-connector-key"),
          document.activeElement,
        );
        const tunnelLabel = document.createElement("label");
        tunnelLabel.textContent = "Tunnel ID";
        const tunnel = document.createElement("input");
        tunnel.id = "settings-connector-tunnel";
        tunnel.type = "text";
        tunnel.autocomplete = "off";
        tunnel.spellcheck = false;
        tunnel.placeholder = "tunnel_…";
        tunnel.value = connector.tunnelId ?? "";
        tunnel.disabled = running;
        tunnelLabel.append(tunnel);
        const keyLabel = document.createElement("label");
        keyLabel.textContent = "Runtime key";
        const key = document.createElement("input");
        key.id = "settings-connector-key";
        key.type = "password";
        key.autocomplete = "off";
        key.spellcheck = false;
        key.placeholder =
          connector.credential === "stored"
            ? "Stored privately; leave blank to keep"
            : "Required once";
        key.disabled = running;
        keyLabel.append(key);
        if (!running) {
          queueMicrotask(() => {
            restoreInputDraft(tunnel, tunnelDraft);
            restoreInputDraft(key, keyDraft);
          });
        }
        const save = document.createElement("button");
        save.type = "submit";
        save.textContent = "Save route";
        save.disabled = connector.tunnelClient === null || running;
        form.append(tunnelLabel, keyLabel, save);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const command = ProductConfigurationCommandSchema.safeParse({
            kind: "connector.configure",
            tunnelId: tunnel.value.trim(),
            runtimeKey: key.value === "" ? null : key.value,
          });
          key.value = "";
          if (!command.success) {
            settingsFeedbackSurface = "settings";
            settingsFeedback =
              "Enter a valid tunnel ID and a runtime key of at least 20 printable characters.";
            settingsFeedbackError = true;
            render();
            return;
          }
          void configureProduct(command.data, "Connector route saved.");
        });

        const actions = document.createElement("span");
        actions.className = "connection-actions";
        const choose = document.createElement("button");
        choose.type = "button";
        choose.textContent = connector.tunnelClient
          ? "Replace client…"
          : "Choose client…";
        choose.disabled = running;
        choose.addEventListener("click", () => {
          void configureProduct(
            { kind: "connector.select-client" },
            "tunnel-client selected and verified.",
          );
        });
        const start = document.createElement("button");
        start.type = "button";
        const attachmentCheckPending =
          connector.runtime?.state === "ready" && connector.challenge !== null;
        start.textContent =
          connector.runtime?.state === "outcome_unknown"
            ? "Repair explicitly"
            : attachmentCheckPending
              ? "Check attachment"
              : connector.runtime?.state === "ready"
                ? "Running"
                : "Start & check";
        start.disabled =
          connector.tunnelClient === null ||
          connector.tunnelId === null ||
          connector.credential !== "stored" ||
          settings.computer.workspaces.length === 0 ||
          (connector.runtime?.state === "ready" && !attachmentCheckPending);
        start.addEventListener("click", () => {
          if (attachmentCheckPending) {
            void configureProduct(
              { kind: "connector.check-attachment" },
              "ChatGPT connector attachment verified.",
            );
            return;
          }
          const repair = connector.runtime?.state === "outcome_unknown";
          void configureProduct(
            { kind: repair ? "connector.repair" : "connector.start" },
            repair
              ? "Connector repaired and readiness checked."
              : "Connector started and readiness checked.",
          );
        });
        const stop = document.createElement("button");
        stop.type = "button";
        stop.textContent = "Stop";
        stop.disabled = connector.runtime === null;
        stop.addEventListener("click", () => {
          void configureProduct(
            { kind: "connector.stop" },
            "Connector stopped and runtime proof cleared.",
          );
        });
        actions.append(choose, start, stop);
        row.append(form, actions);
        const challenge = connectorChallengeCard(settings);
        if (challenge) row.append(challenge);
      } else if (label === "Native hosts") {
        const actions = document.createElement("span");
        actions.className = "connection-actions";
        const selected = settings.nativeHosts.codex;
        const choose = document.createElement("button");
        choose.type = "button";
        choose.textContent = selected ? "Replace…" : "Choose…";
        choose.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.select-codex" },
            "Codex host selected and contract verified.",
          );
        });
        const verify = document.createElement("button");
        verify.type = "button";
        verify.textContent = "Recheck host";
        verify.disabled = selected === null;
        verify.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.verify-codex" },
            "Codex host rechecked.",
          );
        });
        const live = document.createElement("button");
        live.type = "button";
        live.textContent = selected?.liveVerification
          ? "Run live check again"
          : "Run live check";
        live.disabled = selected === null || state.outcomeUnknown;
        live.title = state.outcomeUnknown
          ? "Recheck the host contract before deliberately running another live turn"
          : "Run one gpt-6-astra turn with the bounded Farol Next ping tool";
        live.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.run-codex-smoke" },
            "Live Codex host check completed.",
          );
        });
        const agentState = settings.setup.verify;
        const agentProof = selected?.agentVerification ?? null;
        const verifiedWorkspaceId =
          settings.setup.computer.verified?.workspaceId;
        const verifiedWorkspace = settings.computer.workspaces.find(
          (workspace) => workspace.workspaceId === verifiedWorkspaceId,
        );
        const agentCanRun =
          selected?.liveVerification != null &&
          verifiedWorkspace !== undefined &&
          settings.setup.computer.reachable === "reachable" &&
          !settings.setup.computer.outcomeUnknown;
        const agentNeedsRejoin = waitsForAgentRejoin(agentState);
        const agent = document.createElement("button");
        agent.type = "button";
        // Outcome-unknown first, exactly as agentRouteReadiness decides it.
        // An earlier proof does not describe the attempt that ended unknown,
        // and a button reading "Agent verified" over an unknown outcome is
        // this product saying the one thing it must never say.
        agent.textContent = agentState.outcomeUnknown
          ? "Agent outcome unknown"
          : agentProof
            ? "Agent verified"
            : agentNeedsRejoin
              ? "Rejoin Agent"
              : "Verify Agent";
        agent.disabled =
          agentProof !== null || agentState.outcomeUnknown || !agentCanRun;
        agent.title = agentState.outcomeUnknown
          ? "Inspect the existing Codex task before deliberate recovery"
          : agentProof
            ? agentProof.workspaceEnforcement === "verified"
              ? "Lineage, workspace enforcement, and delivery are verified"
              : "Lineage and delivery are verified; native workspace enforcement remains not verified"
            : !agentCanRun
              ? "Run the live Codex host check and verify one workspace first"
              : agentNeedsRejoin
                ? "Rejoin the same child without another model turn"
                : "Verify Main to Agent to Critic continuity with one bounded gpt-6-astra turn";
        agent.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.run-codex-agent-check" },
            "Native Agent lineage and delivery verified.",
          );
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.disabled = selected === null;
        remove.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.remove-codex" },
            "Codex host selection removed.",
          );
        });
        // Route B: an isolated host this app launches answers one harmless
        // turn through ChatGPT. It needs the live-verified host and a
        // verified ChatGPT connection.
        const routeB = document.createElement("button");
        routeB.type = "button";
        routeB.textContent = "Check Route B";
        const routeBReady =
          selected?.liveVerification != null &&
          settings.setup.chatgpt.verified !== null;
        routeB.disabled = !routeBReady;
        routeB.title = routeBReady
          ? "Run one harmless Codex turn through Farol Next and ChatGPT"
          : "Run the live Codex host check and verify ChatGPT first";
        routeB.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.run-route-b-check" },
            "Route B answered through ChatGPT.",
          );
        });
        actions.append(choose, verify, live, agent, routeB, remove);
        row.append(actions);
      }
      return row;
    }),
  );
  renderModelSection();
}

// Port-conflict wording by what the authenticated loopback identity probe
// found holding the port (`unprobed` until "Check status" has looked).
function modelPortConflictText(
  port: number | null,
  occupant: "unprobed" | "farol" | "foreign" | "vacated" | undefined,
): string {
  switch (occupant) {
    case "farol":
      return `Port ${port} is in use by another running Farol Model endpoint. Quit the other Farol Next, then restart this one.`;
    case "foreign":
      return `Port ${port} is in use by something that is not this Farol. Free the port or quit that program, then restart Farol Next.`;
    case "vacated":
      return `Port ${port} was busy when Farol started and is free now. Restart Farol Next to use it.`;
    default:
      return `Port ${port} was already in use when Farol started. Check status to find out by what.`;
  }
}

// The restart note after an apply, from the read-only host-presence scan
// `main.ts` runs at apply time. Detection covers a Codex started from the
// verified executable path; anything else reads as unknown.
function modelRestartNoteText(
  codexHost: "running" | "not_running" | "unknown" | null,
): string {
  switch (codexHost) {
    case "running":
      return "Codex is running: finish or restart it, then the connection is used.";
    case "not_running":
      return "Codex is not running: the connection is used at its next start.";
    default:
      return "If Codex is running, finish or restart it; otherwise the connection is used at its next start.";
  }
}

// Farol Model's own status/preview/apply/rollback card. It reads only the
// ephemeral evidence this session has already fetched or applied — it
// never polls on its own, and connected is only ever reported once
// `model.status`/`model.config-*` evidence says the endpoint served a
// request. See Decisions.md N04/N04b.
function renderModelSection(): void {
  const readiness = required<HTMLSpanElement>("#model-readiness");
  const summary = required<HTMLParagraphElement>("#model-status-summary");
  const message = required<HTMLParagraphElement>("#model-config-message");
  const diff = required<HTMLPreElement>("#model-config-diff");
  const selectDefault = required<HTMLInputElement>("#model-select-default");
  const restartNote = required<HTMLParagraphElement>("#model-restart-note");
  const previewBtn = required<HTMLButtonElement>("#model-preview-btn");
  const applyBtn = required<HTMLButtonElement>("#model-apply-btn");
  const rollbackBtn = required<HTMLButtonElement>("#model-rollback-btn");

  const status = modelStatusEvidence;
  readiness.textContent =
    status?.state === "connected"
      ? "Connected"
      : status?.state === "listening"
        ? "Listening"
        : status?.state === "port_conflict"
          ? "Port conflict"
          : modelDisconnectedReadiness(modelEvidenceAbsence);
  readiness.classList.toggle("verified", status?.state === "connected");
  summary.textContent =
    status?.state === "connected"
      ? `Connected on port ${status.port} · ${status.requestsServed} request${status.requestsServed === 1 ? "" : "s"} served.`
      : status?.state === "listening"
        ? `Listening on port ${status.port}, waiting for a request from your Codex host.`
        : status?.state === "port_conflict"
          ? modelPortConflictText(status.port, status.occupant)
          : modelDisconnectedSummary(modelEvidenceAbsence);

  if (!document.activeElement || document.activeElement !== selectDefault) {
    selectDefault.checked = modelSelectAsDefault;
  }

  const preview = modelConfigPreviewEvidence;
  if (!preview) {
    message.hidden = true;
    diff.hidden = true;
    diff.textContent = "";
    applyBtn.hidden = true;
    rollbackBtn.hidden = modelConfigApplied ? false : true;
    restartNote.hidden = true;
  } else if (preview.providerBlockStatus === "insecure_permissions") {
    message.hidden = false;
    message.textContent = `Refusing to write ${preview.configPath}: it is readable by group or other (mode ${preview.providerBlockInsecureMode?.toString(8)}). Fix its permissions, then preview again.`;
    diff.hidden = true;
    diff.textContent = "";
    applyBtn.hidden = true;
    rollbackBtn.hidden = true;
    restartNote.hidden = true;
  } else if (preview.providerBlockStatus === "conflict") {
    message.hidden = false;
    const conflictLines = (preview.providerBlockConflicts ?? [])
      .map((conflict) => conflict.line)
      .join("\n");
    message.textContent = `${preview.configPath} already has a hand-written entry with the same name — nothing will be overwritten:\n${conflictLines}`;
    diff.hidden = true;
    diff.textContent = "";
    applyBtn.hidden = true;
    rollbackBtn.hidden = true;
    restartNote.hidden = true;
  } else if (
    preview.providerBlockStatus === "symlink" ||
    preview.providerBlockStatus === "malformed"
  ) {
    message.hidden = false;
    message.textContent =
      preview.providerBlockStatus === "symlink"
        ? `Refusing to touch ${preview.configPath}: it is a symbolic link. Farol only writes a regular file.`
        : `${preview.configPath} has a damaged Farol marker. Repair or remove the marked block by hand, then preview again.`;
    diff.hidden = true;
    diff.textContent = "";
    applyBtn.hidden = true;
    rollbackBtn.hidden = true;
    restartNote.hidden = true;
  } else {
    message.hidden = true;
    const diffText = [
      preview.providerBlockTokenRedacted
        ? "# The token literal is redacted in this preview; the file receives the real value."
        : undefined,
      preview.providerBlockDiff,
      preview.providerSelectionStatus === "install" ||
      preview.providerSelectionStatus === "update"
        ? preview.providerSelectionDiff
        : preview.providerSelectionStatus === "conflict"
          ? `(default-provider selection skipped: a hand-written model_provider or model line already exists)`
          : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    diff.hidden = diffText.length === 0;
    diff.textContent = diffText;
    applyBtn.hidden = modelConfigApplied;
    applyBtn.disabled = false;
    rollbackBtn.hidden = !modelConfigApplied;
    restartNote.hidden = !modelConfigApplied;
    if (modelConfigApplied) {
      restartNote.textContent = modelRestartNoteText(modelConfigCodexHost);
    }
  }
  previewBtn.disabled = false;
}

function renderSetup(): void {
  const dialog = required<HTMLDialogElement>("#setup-dialog");
  if (!setupJourney.open) {
    setupFocusKey = "";
    if (dialog.open) dialog.close();
    return;
  }
  const step = setupSteps[setupJourney.step];
  if (!step) throw new Error("SETUP_STEP_MISSING");
  const configured = bootstrap.configuration;
  const readinessState =
    configured.status === "ready" ? configured.settings.setup[step.id] : null;
  dialog.dataset.mode = setupJourney.mode;
  dialog.dataset.stepId = step.id;
  renderConfigurationFeedback("#setup-feedback", "setup");
  required("#setup-eyeline").textContent = step.eyeline;
  required("#setup-title").textContent = step.title;
  required("#setup-copy").textContent = step.copy;
  const status = required<HTMLDivElement>("#setup-status");
  const stepState = readinessState
    ? routeReadiness(readinessState)
    : "not-configured";
  status.className = `setup-status ${routeStatusClass(stepState)}`;
  required<HTMLElement>("#setup-status strong").textContent = readinessState
    ? readinessLabel(readinessState)
    : "Settings unavailable";
  const details = required<HTMLUListElement>("#setup-details");
  const liveDetails =
    configured.status === "ready" && step.id === "computer"
      ? configured.settings.computer.workspaces.map(
          (workspace) =>
            `${workspace.label}: ${workspaceAccessLabel(workspace, configured.settings.computer.commands)} · ${workspace.root}`,
        )
      : configured.status === "ready" && step.id === "connect"
        ? [
            `Client · ${configured.settings.connectors.secureMcp.tunnelClient ? `${configured.settings.connectors.secureMcp.tunnelClient.version} · ${configured.settings.connectors.secureMcp.tunnelClient.executablePath}` : "not selected"}`,
            `Tunnel · ${configured.settings.connectors.secureMcp.tunnelId ?? "not set"} · credential ${configured.settings.connectors.secureMcp.credential}`,
            `Runtime · ${configured.settings.connectors.secureMcp.runtime?.state ?? "stopped"} · attachment ${configured.settings.connectors.secureMcp.attachment ? "verified" : "not verified"}`,
          ]
        : configured.status === "ready" &&
            step.id === "hosts" &&
            configured.settings.nativeHosts.codex
          ? [
              `Codex ${configured.settings.nativeHosts.codex.version} · ${configured.settings.nativeHosts.codex.protocol}`,
              `Executable · ${configured.settings.nativeHosts.codex.executablePath}`,
            ]
          : configured.status === "ready" &&
              step.id === "verify" &&
              configured.settings.nativeHosts.codex?.agentVerification
            ? [
                `Delegation · ${configured.settings.nativeHosts.codex.agentVerification.delegationDigest.slice(0, 12)}`,
                `Parent ${configured.settings.nativeHosts.codex.agentVerification.parentThreadSha256.slice(0, 12)} · child ${configured.settings.nativeHosts.codex.agentVerification.childThreadSha256.slice(0, 12)}`,
                `Native workspace enforcement · ${configured.settings.nativeHosts.codex.agentVerification.workspaceEnforcement === "verified" ? "verified" : "not verified"}`,
              ]
            : [];
  details.replaceChildren(
    ...[...step.details, ...liveDetails].map((detail) => {
      const item = document.createElement("li");
      item.textContent = detail;
      return item;
    }),
  );
  document
    .querySelectorAll<HTMLElement>("[data-setup-progress]")
    .forEach((item, index) => {
      const progressId = item.dataset.setupProgress as
        (typeof setupSteps)[number]["id"] | undefined;
      const progressState =
        configured.status === "ready" && progressId
          ? configured.settings.setup[progressId]
          : null;
      item.classList.toggle(
        "complete",
        progressState !== null && routeReadiness(progressState) === "ready",
      );
      item.classList.toggle("visited", progressState?.visited === true);
      item.classList.toggle("active", index === setupJourney.step);
      if (index === setupJourney.step)
        item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
  required("#setup-counter").textContent =
    `Step ${setupJourney.step + 1} of ${setupSteps.length}`;
  required<HTMLButtonElement>("#setup-back").disabled = setupJourney.step === 0;
  // "Open Browser" implies there is something to open. With no live
  // ChatGPT task yet, closing Setup only lands on the empty Browser panel,
  // so the last step must not promise otherwise (UX34-03/04).
  const hasWorkingTask = bootstrap.tasks.some(
    (task) => task.provider === "chatgpt",
  );
  required<HTMLButtonElement>("#setup-next").textContent =
    setupJourney.step === setupSteps.length - 1
      ? hasWorkingTask
        ? "Open Browser"
        : "Finish setup"
      : "Continue";
  required<HTMLButtonElement>("#setup-close").hidden =
    setupJourney.mode !== "review";
  const liveAction = required<HTMLDivElement>("#setup-live-action");
  const liveSummary = required<HTMLDivElement>("#setup-live-summary");
  const livePrimary = required<HTMLButtonElement>("#setup-live-primary");
  liveAction.hidden = false;
  livePrimary.hidden = false;
  setupPrimaryAction = null;
  if (configured.status === "error") {
    liveSummary.textContent = `Settings cannot be changed: ${configured.error}`;
    livePrimary.textContent = "Unavailable";
    livePrimary.disabled = true;
  } else if (step.id === "chatgpt") {
    const readiness = configured.settings.setup.chatgpt;
    const needsSignIn =
      !chatGptSignInOpened &&
      (!readiness.visited ||
        readiness.reachable === "unreachable" ||
        (readiness.reachable === "reachable" &&
          !readiness.configured &&
          readiness.needsAction !== null));
    liveSummary.textContent = readinessDetail(readiness);
    livePrimary.textContent = needsSignIn
      ? "Open sign-in…"
      : readiness.verified
        ? "Recheck connection"
        : "Check connection";
    livePrimary.disabled = false;
    setupPrimaryAction = async () => {
      if (needsSignIn) {
        if (
          await configureProduct(
            { kind: "chatgpt.open-sign-in" },
            "Isolated ChatGPT window opened.",
          )
        ) {
          chatGptSignInOpened = true;
          render();
        }
        return;
      }
      chatGptSignInOpened = false;
      await configureProduct(
        { kind: "chatgpt.verify" },
        "ChatGPT connection checked.",
      );
    };
  } else if (step.id === "computer") {
    const settings = configured.settings;
    const workspace = settings.computer.workspaces[0];
    const verified =
      workspace !== undefined &&
      settings.setup.computer.verified?.workspaceId === workspace.workspaceId &&
      settings.setup.computer.verified.configRevision ===
        settings.computer.generation;
    liveSummary.textContent =
      settings.computer.workspaces.length === 0
        ? "Choose a folder with the native picker. It is saved as read-only."
        : readinessDetail(settings.setup.computer);
    livePrimary.textContent =
      workspace === undefined
        ? "Add folder…"
        : verified
          ? "Add another…"
          : "Verify folder";
    livePrimary.disabled = false;
    setupPrimaryAction = async () => {
      if (!workspace || verified) {
        await configureProduct(
          { kind: "computer.add-workspace" },
          "Read-only workspace saved and read back.",
        );
        return;
      }
      await configureProduct(
        {
          kind: "computer.verify-workspace",
          workspaceId: workspace.workspaceId,
        },
        `Farol can open ${workspace.label}.`,
      );
    };
  } else if (step.id === "connect") {
    const settings = configured.settings;
    const connector = settings.connectors.secureMcp;
    const readiness = settings.setup.connect;
    const tunnelDraft = captureInputDraft(
      document.querySelector<HTMLInputElement>("#setup-connector-tunnel"),
      document.activeElement,
    );
    const keyDraft = captureInputDraft(
      document.querySelector<HTMLInputElement>("#setup-connector-key"),
      document.activeElement,
    );
    liveSummary.textContent = connector.tunnelClient
      ? readinessDetail(readiness)
      : "Farol Next looks for the installed tunnel-client itself and verifies its profile, doctor, and run surface before saving it.";
    if (!connector.tunnelClient) {
      ensureDiscovery("connect");
      liveSummary.append(
        buildDiscoveryPanel("connect", discoveredTunnelClientCandidates, {
          itemNoun: "tunnel-client",
          notFoundHint:
            "Install it with: brew install openai/tools/tunnel-client",
          selectCommandKind: "connector.select-discovered-client",
          pickerCommandKind: "connector.select-client",
        }),
      );
    }
    const challenge = connectorChallengeCard(settings);
    if (challenge) {
      liveSummary.append(challenge);
      const attachInstructions = buildMediaInstructions("attach-connector");
      if (attachInstructions) liveSummary.append(attachInstructions);
    }
    if (
      connector.tunnelClient &&
      (connector.tunnelId === null || connector.credential === "missing")
    ) {
      const createTunnelInstructions = buildMediaInstructions("create-tunnel");
      if (createTunnelInstructions)
        liveSummary.append(createTunnelInstructions);
      const createKeyInstructions = buildMediaInstructions("create-key");
      if (createKeyInstructions) liveSummary.append(createKeyInstructions);
      const form = document.createElement("div");
      form.className = "setup-connector-form";
      const tunnelLabel = document.createElement("label");
      tunnelLabel.textContent = "Tunnel ID";
      const tunnel = document.createElement("input");
      tunnel.id = "setup-connector-tunnel";
      tunnel.type = "text";
      tunnel.autocomplete = "off";
      tunnel.spellcheck = false;
      tunnel.placeholder = "tunnel_…";
      tunnel.value = connector.tunnelId ?? "";
      tunnelLabel.append(tunnel);
      const keyLabel = document.createElement("label");
      keyLabel.textContent = "Runtime key";
      const key = document.createElement("input");
      key.id = "setup-connector-key";
      key.type = "password";
      key.autocomplete = "off";
      key.spellcheck = false;
      key.placeholder =
        connector.credential === "stored"
          ? "Stored privately; leave blank to keep"
          : "Required once";
      keyLabel.append(key);
      form.append(tunnelLabel, keyLabel);
      // A rejected value is explained inside this dialog, next to its field.
      if (setupConnectorError) {
        const error = document.createElement("p");
        error.id = "setup-connector-error";
        error.className = "setup-field-error";
        error.setAttribute("role", "alert");
        error.textContent = setupConnectorError;
        for (const input of [tunnel, key]) {
          input.setAttribute("aria-invalid", "true");
          input.setAttribute("aria-describedby", error.id);
        }
        form.append(error);
      }
      liveSummary.append(form);
      queueMicrotask(() => {
        restoreInputDraft(tunnel, tunnelDraft);
        restoreInputDraft(key, keyDraft);
      });
    }
    livePrimary.hidden = !connector.tunnelClient;
    livePrimary.textContent = !connector.tunnelClient
      ? ""
      : connector.tunnelId === null || connector.credential === "missing"
        ? "Save connector"
        : connector.runtime?.state === "outcome_unknown"
          ? "Repair explicitly"
          : connector.runtime?.state === "ready"
            ? connector.challenge
              ? "Check attachment"
              : "Connection verified"
            : "Start & check";
    livePrimary.disabled =
      !connector.tunnelClient ||
      (connector.runtime?.state === "ready" && connector.challenge === null);
    setupPrimaryAction = async () => {
      if (!connector.tunnelClient) return;
      if (connector.tunnelId === null || connector.credential === "missing") {
        const tunnel = required<HTMLInputElement>("#setup-connector-tunnel");
        const key = required<HTMLInputElement>("#setup-connector-key");
        const command = ProductConfigurationCommandSchema.safeParse({
          kind: "connector.configure",
          tunnelId: tunnel.value.trim(),
          runtimeKey: key.value === "" ? null : key.value,
        });
        key.value = "";
        if (!command.success) {
          setupConnectorError =
            "Enter a valid tunnel ID and a runtime key of at least 20 printable characters.";
          render();
          return;
        }
        setupConnectorError = null;
        await configureProduct(command.data, "Connector route saved.");
        return;
      }
      if (connector.runtime?.state === "ready") {
        if (connector.challenge) {
          await configureProduct(
            { kind: "connector.check-attachment" },
            "ChatGPT connector attachment verified.",
          );
        }
        return;
      }
      const repair = connector.runtime?.state === "outcome_unknown";
      await configureProduct(
        { kind: repair ? "connector.repair" : "connector.start" },
        repair
          ? "Connector repaired and readiness checked."
          : "Connector started and readiness checked.",
      );
    };
  } else if (step.id === "hosts") {
    const host = configured.settings.nativeHosts.codex;
    const readiness = configured.settings.setup.hosts;
    liveSummary.textContent = host
      ? `${readinessDetail(readiness)} Codex ${host.version} is selected; a live check uses gpt-6-astra without provider fallback and stores no prompt or response.`
      : "Farol Next looks for the installed Codex executable itself, in a small set of known locations. It never searches your shell PATH or infers a host from configuration files.";
    if (!host) {
      ensureDiscovery("hosts");
      liveSummary.append(
        buildDiscoveryPanel("hosts", discoveredCodexCandidates, {
          itemNoun: "Codex executable",
          notFoundHint:
            "Install the ChatGPT desktop app or the Codex CLI (`npm install -g @openai/codex`), then scan again.",
          selectCommandKind: "host.select-discovered-codex",
          pickerCommandKind: "host.select-codex",
        }),
      );
    }
    livePrimary.hidden = !host;
    livePrimary.textContent = !host
      ? ""
      : readiness.outcomeUnknown
        ? "Recheck contract"
        : host.liveVerification
          ? "Run live check again"
          : "Run live check";
    livePrimary.disabled = !host;
    setupPrimaryAction = async () => {
      if (!host) return;
      const kind = readiness.outcomeUnknown
        ? "host.verify-codex"
        : "host.run-codex-smoke";
      await configureProduct(
        { kind },
        kind === "host.verify-codex"
          ? "Codex host contract rechecked."
          : "Live Codex host check completed.",
      );
    };
  } else if (step.id === "verify") {
    const settings = configured.settings;
    const host = settings.nativeHosts.codex;
    const readiness = settings.setup.verify;
    const proof = host?.agentVerification ?? null;
    const verifiedWorkspaceId = settings.setup.computer.verified?.workspaceId;
    const workspace = settings.computer.workspaces.find(
      (candidate) => candidate.workspaceId === verifiedWorkspaceId,
    );
    const prerequisitesReady =
      host?.liveVerification != null &&
      workspace !== undefined &&
      settings.setup.computer.reachable === "reachable" &&
      !settings.setup.computer.outcomeUnknown;
    const needsRejoin = waitsForAgentRejoin(readiness);
    liveSummary.textContent = proof
      ? proof.workspaceEnforcement === "verified"
        ? `Main → Agent → Critic completed with one ${proof.model} turn, verified native workspace enforcement, and durable acknowledged delivery.`
        : `Main → Agent → Critic completed with one ${proof.model} turn and durable acknowledged delivery. Native workspace enforcement remains not verified.`
      : readiness.outcomeUnknown
        ? "The native Agent outcome is unknown. Inspect the existing Codex task before deliberate recovery."
        : needsRejoin
          ? "The same native child is still running. Rejoin it without creating another child or model turn."
          : prerequisitesReady
            ? "Ready to verify lineage, unchanged TaskGrant transport, bounded same-child rejoin and durable parent delivery."
            : "Run the live Codex host check and verify one workspace first.";
    livePrimary.textContent = proof
      ? "Agent verified"
      : needsRejoin
        ? "Rejoin Agent"
        : "Verify Agent";
    livePrimary.disabled =
      proof !== null || readiness.outcomeUnknown || !prerequisitesReady;
    setupPrimaryAction = async () => {
      await configureProduct(
        { kind: "host.run-codex-agent-check" },
        "Native Agent lineage and delivery verified.",
      );
    };
  } else {
    liveSummary.textContent = readinessState
      ? readinessDetail(readinessState)
      : "No readiness record is available.";
    livePrimary.textContent =
      step.id === "connect" ? "Connector unavailable" : "Checks unavailable";
    livePrimary.disabled = true;
  }
  if (!dialog.open) dialog.showModal();
  const focusKey = `${setupJourney.mode}:${setupJourney.step}`;
  if (setupFocusKey !== focusKey) {
    setupFocusKey = focusKey;
    queueMicrotask(() => required<HTMLButtonElement>("#setup-next").focus());
  }
}

type CommandItem = Readonly<{
  id: string;
  label: string;
  meta: string;
  kind: "section" | "task";
  value: string;
}>;

function commandItems(): CommandItem[] {
  return [
    ...sections.map((item, index) => ({
      id: `section:${item}`,
      label: `${item.charAt(0).toUpperCase()}${item.slice(1)}`,
      meta: `Section · ⌘${index + 1}`,
      kind: "section" as const,
      value: item,
    })),
    ...bootstrap.tasks.map((task) => ({
      id: `task:${task.taskId}`,
      label: taskLabel(task),
      meta: `Task · ${taskState(task.taskId).label}`,
      kind: "task" as const,
      value: task.taskId,
    })),
  ];
}

function renderCommands(filter = ""): void {
  const normalized = filter.trim().toLocaleLowerCase();
  const items = commandItems().filter((item) =>
    `${item.label} ${item.meta}`.toLocaleLowerCase().includes(normalized),
  );
  const results = required<HTMLDivElement>("#command-results");
  results.replaceChildren(
    ...items.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.commandId = item.id;
      button.classList.toggle("is-selected", index === 0);
      const label = document.createElement("span");
      label.textContent = item.label;
      const meta = document.createElement("small");
      meta.textContent = item.meta;
      button.append(label, meta);
      button.addEventListener("click", () => executeCommand(item));
      return button;
    }),
  );
}

function moveCommandSelection(direction: -1 | 1): void {
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>("#command-results button"),
  ];
  if (buttons.length === 0) return;
  const selected = buttons.findIndex((button) =>
    button.classList.contains("is-selected"),
  );
  const next =
    (Math.max(selected, 0) + direction + buttons.length) % buttons.length;
  buttons.forEach((button, index) =>
    button.classList.toggle("is-selected", index === next),
  );
  buttons[next]?.scrollIntoView({ block: "nearest" });
}

function renderOverlayState(): void {
  const mode = sidebarMode();
  const root = document.documentElement;
  root.dataset.sidebar = mode;
  const toggle = required<HTMLButtonElement>("#sidebar-toggle");
  const expanded = mode === "full" || mode === "overlay";
  const label = narrowSidebar.matches
    ? expanded
      ? "Hide sidebar"
      : "Show sidebar"
    : expanded
      ? "Collapse sidebar"
      : "Expand sidebar";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", label);
  toggle.title = `${label} (⌃⌘S)`;
  required<HTMLButtonElement>("#sidebar-backdrop").hidden =
    shellOverlay !== "sidebar";

  const taskMenu = required<HTMLDialogElement>("#task-menu");
  const commandDialog = required<HTMLDialogElement>("#command-dialog");
  const contextPreview = required<HTMLDialogElement>("#context-preview");
  if (shellOverlay === "task-menu" && !taskMenu.open) taskMenu.showModal();
  if (shellOverlay !== "task-menu" && taskMenu.open) taskMenu.close();
  if (shellOverlay === "quick-switcher" && !commandDialog.open) {
    const input = required<HTMLInputElement>("#command-search");
    input.value = "";
    renderCommands();
    commandDialog.showModal();
  }
  if (shellOverlay !== "quick-switcher" && commandDialog.open) {
    commandDialog.close();
  }
  if (shellOverlay === "context-preview" && pendingChatGptPreview) {
    const preview = pendingChatGptPreview;
    const exclusions = required<HTMLUListElement>(
      "#context-preview-exclusions",
    );
    if (preview.kind === "chatgpt.readonly-task-preview") {
      required("#context-preview-boundaries").textContent = "Custom exclusions";
      required("#context-preview-file").textContent =
        `${preview.workspaceLabel} / ${preview.relativePath}`;
      required("#context-preview-scope").textContent =
        `Read-only · one file · ${preview.bytes} bytes`;
      required("#context-preview-budget").textContent =
        `${preview.contextCharacters.toLocaleString()} of ${preview.contextLimit.toLocaleString()} characters${preview.contextTruncated ? " · truncated" : ""}`;
      const items =
        preview.excludedPaths.length > 0
          ? preview.excludedPaths.map((excluded) => `Excluded · ${excluded}`)
          : ["No custom exclusions · credential defaults remain denied"];
      exclusions.replaceChildren(
        ...items.map((text) => {
          const item = document.createElement("li");
          item.textContent = text;
          return item;
        }),
      );
      required("#context-preview-note").textContent =
        "File contents stay in main-process memory for this preview and are not shown or saved here. Send once has no automatic retry after a possible submission.";
    } else {
      required("#context-preview-boundaries").textContent =
        "Attachment boundary";
      required("#context-preview-file").textContent = preview.attachments
        .map((attachment) => attachment.name)
        .join(", ");
      required("#context-preview-scope").textContent =
        `Owner-selected · ${preview.attachments.length} attachment${preview.attachments.length === 1 ? "" : "s"} · ${preview.totalBytes} bytes`;
      required("#context-preview-budget").textContent = preview.attachments
        .map(
          (attachment) =>
            `${attachment.mimeType} · ${attachment.sha256.slice(0, 12)}`,
        )
        .join("; ");
      exclusions.replaceChildren(
        ...[
          "Only exact private staged copies will be uploaded",
          "Staging is removed after send or cancel",
        ].map((text) => {
          const item = document.createElement("li");
          item.textContent = text;
          return item;
        }),
      );
      required("#context-preview-note").textContent =
        "Attachment contents are not rendered in Farol or added to diagnostics. Send once waits for visible upload completion and has no automatic retry after a possible submission.";
    }
    required("#context-preview-expiry").textContent = new Intl.DateTimeFormat(
      undefined,
      {
        dateStyle: "medium",
        timeStyle: "short",
      },
    ).format(new Date(preview.expiresAt));
    if (!contextPreview.open) contextPreview.showModal();
  } else if (contextPreview.open) {
    contextPreview.close();
  }
  if (renderedOverlay !== shellOverlay) {
    renderedOverlay = shellOverlay;
    if (shellOverlay === "sidebar") {
      queueMicrotask(() =>
        document.querySelector<HTMLButtonElement>(".nav-item.active")?.focus(),
      );
    } else if (shellOverlay === "task-menu") {
      queueMicrotask(() => {
        const task = taskById(selectedTaskId);
        if (task?.provider === "chatgpt") {
          required<HTMLInputElement>("#task-menu-name").focus();
          return;
        }
        required<HTMLButtonElement>("#task-menu-activity").focus();
      });
    } else if (shellOverlay === "quick-switcher") {
      queueMicrotask(() =>
        required<HTMLInputElement>("#command-search").focus(),
      );
    } else if (shellOverlay === "context-preview") {
      queueMicrotask(() =>
        required<HTMLButtonElement>("#context-preview-submit").focus(),
      );
    }
  }
}

function render(notify = true): void {
  const root = document.documentElement;
  root.dataset.section = section;
  root.dataset.hasTasks = String(bootstrap.tasks.length > 0);
  const newTask = required<HTMLButtonElement>("#new-task");
  const chatGptReady = chatGptRouteState() === "ready";
  required("#window-mode").textContent = windowModeLabel({
    demoMode: bootstrap.demoMode,
    taskCount: bootstrap.tasks.length,
    chatGptReady,
  });
  const taskCapacityAvailable = bootstrap.tasks.length < 5;
  newTask.disabled =
    bootstrap.demoMode || !chatGptReady || !taskCapacityAvailable;
  newTask.title = bootstrap.demoMode
    ? "Unavailable in explicit demo mode"
    : !chatGptReady
      ? "Verify the isolated ChatGPT connection in Setup or Settings"
      : !taskCapacityAvailable
        ? "Five live tasks are already admitted"
        : "Create an isolated ChatGPT task";
  const newTaskLabel = newTask.querySelector<HTMLElement>("b");
  const newTaskStatus = newTask.querySelector<HTMLElement>("small");
  if (newTaskLabel) newTaskLabel.textContent = "New task";
  if (newTaskStatus) {
    newTaskStatus.textContent = bootstrap.demoMode
      ? "Unavailable"
      : `${bootstrap.tasks.length} / 5`;
  }
  document.querySelectorAll<HTMLElement>(".nav-item").forEach((item) => {
    const active = item.dataset.section === section;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.querySelectorAll<HTMLElement>(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === section);
  });
  renderWindowState();
  renderBuildIdentity();
  renderRuntime();
  renderBrowser();
  renderTabs();
  renderSignals();
  renderDossier();
  renderTaskMenu();
  renderComputer();
  renderActivity();
  renderSettings();
  renderSetup();
  renderOverlayState();
  if (notify) notifyHost();
  document.documentElement.dataset.ready = "true";
}

function closeOverlay(): void {
  if (shellOverlay === "context-preview") {
    void cancelContextPreview();
    return;
  }
  sidebarOverlayOpen = false;
  shellOverlay = "none";
  render();
}

async function cancelContextPreview(): Promise<void> {
  if (contextPreviewBusy) return;
  const preview = pendingChatGptPreview;
  if (!preview) {
    shellOverlay = "none";
    render();
    return;
  }
  contextPreviewBusy = true;
  pendingChatGptPreview = null;
  shellOverlay = "none";
  render();
  try {
    await configureProduct(
      preview.kind === "chatgpt.attachment-task-preview"
        ? {
            kind: "chatgpt.cancel-attachment-task",
            operationId: preview.operationId,
          }
        : {
            kind: "chatgpt.cancel-readonly-task",
            operationId: preview.operationId,
          },
      preview.kind === "chatgpt.attachment-task-preview"
        ? "Attachment staging removed. Nothing was submitted."
        : "Context preview cancelled. Nothing was submitted.",
    );
  } finally {
    contextPreviewBusy = false;
  }
}

async function submitContextPreview(): Promise<void> {
  if (contextPreviewBusy) return;
  const preview = pendingChatGptPreview;
  if (!preview) return;
  contextPreviewBusy = true;
  pendingChatGptPreview = null;
  shellOverlay = "none";
  render();
  try {
    await configureProduct(
      preview.kind === "chatgpt.attachment-task-preview"
        ? {
            kind: "chatgpt.submit-attachment-task",
            operationId: preview.operationId,
          }
        : {
            kind: "chatgpt.submit-readonly-task",
            operationId: preview.operationId,
          },
      preview.kind === "chatgpt.attachment-task-preview"
        ? "Attachment ChatGPT task finished."
        : "Read-only ChatGPT task finished.",
    );
  } finally {
    contextPreviewBusy = false;
  }
}

function toggleSidebar(): void {
  if (narrowSidebar.matches) {
    sidebarOverlayOpen = !sidebarOverlayOpen;
    shellOverlay = sidebarOverlayOpen ? "sidebar" : "none";
  } else {
    sidebarOverlayOpen = false;
    shellOverlay = "none";
    sidebarPreference = sidebarPreference === "full" ? "rail" : "full";
  }
  render();
}

function openTaskMenu(): void {
  const task = taskById(selectedTaskId);
  taskMenuFeedback = "";
  taskMenuFeedbackError = false;
  if (task?.provider === "chatgpt") {
    required<HTMLInputElement>("#task-menu-name").value = task.label;
    if (taskAgentDraftTaskId !== task.taskId) {
      taskAgentDraftTaskId = task.taskId;
      required<HTMLTextAreaElement>("#task-agent-objective").value = "";
      required<HTMLSelectElement>("#task-agent-scope").value = "workspace";
      required<HTMLInputElement>("#task-agent-subtree").value = "";
      required<HTMLTextAreaElement>("#task-agent-paths").value = "";
      required<HTMLTextAreaElement>("#task-agent-exclusions").value = "";
    }
  }
  sidebarOverlayOpen = false;
  shellOverlay = "task-menu";
  render();
}

function taskMenuErrorMessage(
  error: Extract<
    ReturnType<typeof ProductTaskCommandResultSchema.parse>,
    { ok: false }
  >["error"],
): string {
  if (error === "TASK_OPERATION_IN_PROGRESS") {
    return "Another task operation is still finishing.";
  }
  if (error === "TASK_STATE_UNAVAILABLE") {
    return "Durable task state is unavailable. No change was applied.";
  }
  if (error === "TASK_NOT_FOUND") return "This task no longer exists.";
  if (error === "TASK_NOT_RUNNING") {
    return "This task is not observed as running. Nothing was cancelled.";
  }
  if (error === "TASK_CANCEL_FAILED") {
    return "Farol could not confirm a provider stop. Check the task before retrying.";
  }
  if (error === "TASK_COMMAND_INVALID") {
    return "Enter a task name between 1 and 80 characters.";
  }
  if (error === "AGENT_NOT_READY") {
    return "Verify the exact native host, Agent lineage, and workspace first.";
  }
  if (error === "AGENT_SCOPE_INVALID") {
    return "The requested Agent scope is outside the verified workspace or conflicts with an existing exclusion.";
  }
  if (error === "AGENT_ALREADY_RUNNING") {
    return "This Agent assignment must be reconciled before changing or closing the task.";
  }
  if (error === "AGENT_INPUT_STATE_UNAVAILABLE") {
    return "Private Agent input could not be retained safely. Nothing was submitted.";
  }
  if (error === "AGENT_ASSIGNMENT_FAILED") {
    return "The native host confirmed that the Agent assignment failed.";
  }
  if (error === "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN") {
    return "The Agent outcome is unknown. Farol will not retry it automatically.";
  }
  if (error === "AGENT_CANCEL_RACED_COMPLETION") {
    return "The Agent completed before cancellation was confirmed. Its retained result still needs delivery.";
  }
  if (error === "AGENT_DELIVERY_FAILED") {
    return "The result is retained, but parent delivery was not acknowledged. Use Deliver result.";
  }
  if (error === "AGENT_REJOIN_UNAVAILABLE") {
    return "No exact running child or retained result is available to rejoin.";
  }
  return "The task operation is unavailable.";
}

async function runTaskMenuCommand(
  command: ProductTaskCommand,
  successMessage: string,
  closeAfterSuccess = false,
): Promise<void> {
  if (taskMenuBusy) return;
  taskMenuBusy = true;
  taskMenuFeedback = "";
  taskMenuFeedbackError = false;
  render();
  try {
    const parsed = ProductTaskCommandResultSchema.safeParse(
      await window.farolNext.task(command),
    );
    if (!parsed.success) {
      taskMenuFeedback = "The task route returned an invalid result.";
      taskMenuFeedbackError = true;
      return;
    }
    applyTasksState(parsed.data.state);
    if (!parsed.data.ok) {
      taskMenuFeedback = taskMenuErrorMessage(parsed.data.error);
      taskMenuFeedbackError = true;
      return;
    }
    selectedTaskId = parsed.data.selectedTaskId ?? "";
    taskMenuFeedback = successMessage;
    if (closeAfterSuccess) {
      shellOverlay = "none";
      return;
    }
    const task = taskById(selectedTaskId);
    if (task?.provider === "chatgpt") {
      required<HTMLInputElement>("#task-menu-name").value = task.label;
    }
  } catch {
    taskMenuFeedback = "The task operation could not be completed.";
    taskMenuFeedbackError = true;
  } finally {
    taskMenuBusy = false;
    render();
  }
}

function openCommands(): void {
  sidebarOverlayOpen = false;
  shellOverlay = "quick-switcher";
  render();
}

function executeCommand(item: CommandItem): void {
  shellOverlay = "none";
  if (item.kind === "section") selectSection(item.value as SurfaceSection);
  else selectTask(item.value);
}

function selectTask(taskId: string): void {
  const task = taskById(taskId);
  if (!task) return;
  selectedTaskId = taskId;
  section = "browser";
  sidebarOverlayOpen = false;
  shellOverlay = "none";
  render();
  if (task.provider === "chatgpt") {
    void window.farolNext.task({ kind: "task.activate", taskId });
  }
}

function selectSection(next: SurfaceSection): void {
  if (!sections.includes(next)) return;
  section = next;
  sidebarOverlayOpen = false;
  shellOverlay = "none";
  render();
}

function recordEvent(event: ClientEventDto): void {
  const events = taskEvents.get(event.taskId) ?? [];
  events.push(event);
  if (events.length > 128) events.shift();
  taskEvents.set(event.taskId, events);
  const projected = projectActivity(event);
  if (projected) activity.record(projected);
  render();
}

function applyRuntimeStatus(status: RuntimeStatus): void {
  bootstrap = {
    ...bootstrap,
    runtimeState: status.state,
    runtimeError: status.error,
    runtimeIdentity: status.identity,
    embeddedNode: status.embeddedNode,
    embeddedElectron: status.embeddedElectron,
  };
  render();
}

function applyTasksState(state: ProductTasksState): void {
  if (state.revision < bootstrap.taskRevision) return;
  bootstrap = {
    ...bootstrap,
    taskRevision: state.revision,
    tasks: state.tasks,
  };
  const taskIds = new Set(state.tasks.map((task) => task.taskId));
  for (const taskId of taskEvents.keys()) {
    if (!taskIds.has(taskId)) taskEvents.delete(taskId);
  }
  for (const taskId of taskSurfaceStatuses.keys()) {
    if (!taskIds.has(taskId)) taskSurfaceStatuses.delete(taskId);
  }
  if (!taskIds.has(selectedTaskId)) {
    selectedTaskId = state.tasks[0]?.taskId ?? "";
  }
  render();
}

function applyTaskSurfaceStatus(status: TaskSurfaceStatus): void {
  if (!taskById(status.taskId)) return;
  taskSurfaceStatuses.set(status.taskId, status);
  render();
}

function applyHostLayout(layout: z.infer<typeof ShellLayoutSchema>): void {
  if (
    bootstrap.tasks.length === 0
      ? layout.taskId !== ""
      : !taskById(layout.taskId)
  )
    return;
  section = layout.section;
  selectedTaskId = layout.taskId;
  setupJourney = { ...setupJourney, open: layout.setupOpen };
  if (layout.sidebar === "full" || layout.sidebar === "rail") {
    sidebarPreference = layout.sidebar;
  }
  sidebarOverlayOpen = layout.sidebar === "overlay";
  shellOverlay = layout.overlay;
  lastHostLayout = JSON.stringify(currentLayout());
  render(false);
}

async function start(): Promise<void> {
  window.farolNext.onLayout((value) => {
    const parsed = ShellLayoutSchema.safeParse(value);
    if (!parsed.success) return;
    if (!bootstrapReady) {
      pendingLayout = parsed.data;
      return;
    }
    applyHostLayout(parsed.data);
  });
  window.farolNext.onShellAction((value) => {
    const parsed = ShellActionSchema.safeParse(value);
    if (!parsed.success || !bootstrapReady) return;
    if (parsed.data.action === "toggle-sidebar") toggleSidebar();
    else if (parsed.data.action === "open-quick-switcher") openCommands();
    else if (parsed.data.action === "open-settings") {
      chatGptSignInOpened = false;
      setupJourney = { ...setupJourney, open: false };
      selectSection("settings");
      void refreshSettingsAfterReturn();
    } else if (parsed.data.action === "sign-in-returned") {
      // The sign-in window closed and its outcome is recorded: the step's
      // next action comes from that outcome, not from "a window is open".
      chatGptSignInOpened = false;
      void refreshSettingsAfterReturn();
    } else closeOverlay();
  });
  window.farolNext.onWindowState((value) => {
    const parsed = WindowStateSchema.safeParse(value);
    if (!parsed.success) return;
    windowState = parsed.data;
    if (bootstrapReady) renderWindowState();
  });
  window.farolNext.onRuntimeEvent((value) => {
    const parsed = ClientEventSchema.safeParse(value);
    if (!parsed.success) return;
    if (!bootstrapReady) {
      pendingRuntimeEvents.push(parsed.data);
      return;
    }
    recordEvent(parsed.data);
  });
  window.farolNext.onRuntimeState((value) => {
    const parsed = RuntimeStatusSchema.safeParse(value);
    if (!parsed.success) return;
    if (!bootstrapReady) {
      pendingRuntimeStatus = parsed.data;
      return;
    }
    applyRuntimeStatus(parsed.data);
  });
  window.farolNext.onTaskSurfaceState((value) => {
    const parsed = TaskSurfaceStatusSchema.safeParse(value);
    if (!parsed.success) return;
    if (!bootstrapReady) {
      pendingTaskSurfaceStatuses.push(parsed.data);
      return;
    }
    applyTaskSurfaceStatus(parsed.data);
  });
  window.farolNext.onTasksState((value) => {
    const parsed = ProductTasksStateSchema.safeParse(value);
    if (!parsed.success) return;
    if (!bootstrapReady) {
      pendingTasksState = parsed.data;
      return;
    }
    applyTasksState(parsed.data);
  });

  bootstrap = bootstrapSchema.parse(await window.farolNext.bootstrap());
  windowState = bootstrap.windowState;
  selectedTaskId = bootstrap.tasks[0]?.taskId ?? "";
  if (bootstrap.configuration.status === "ready") {
    const settings = bootstrap.configuration.settings;
    const persistedStep = Math.max(
      0,
      setupSteps.findIndex(
        (step) => step.id === settings.setup.journey.currentStep,
      ),
    );
    setupJourney = createSetupJourney({
      open: !settings.setup.journey.dismissed,
      step: persistedStep,
    });
    sidebarPreference = settings.general.sidebarDefault;
    section = settings.general.openAtLaunch;
  }

  document
    .querySelectorAll<HTMLButtonElement>(".nav-item")
    .forEach((button) => {
      button.addEventListener("click", () =>
        selectSection(button.dataset.section as SurfaceSection),
      );
    });
  required<HTMLButtonElement>("#sidebar-toggle").addEventListener(
    "click",
    toggleSidebar,
  );
  required<HTMLButtonElement>("#sidebar-backdrop").addEventListener(
    "click",
    closeOverlay,
  );
  required<HTMLButtonElement>("#command-button").addEventListener(
    "click",
    openCommands,
  );
  required<HTMLButtonElement>("#new-task").addEventListener(
    "click",
    async () => {
      taskAdmissionFeedback = "";
      const button = required<HTMLButtonElement>("#new-task");
      button.disabled = true;
      const parsed = ProductTaskCommandResultSchema.safeParse(
        await window.farolNext.task({ kind: "task.create-chatgpt" }),
      );
      if (!parsed.success) {
        taskAdmissionFeedback = "The task route returned an invalid result.";
        render();
        return;
      }
      applyTasksState(parsed.data.state);
      if (!parsed.data.ok) {
        taskAdmissionFeedback =
          parsed.data.error === "CHATGPT_CONNECTION_NOT_VERIFIED"
            ? "Verify the isolated ChatGPT connection in Setup or Settings."
            : parsed.data.error === "TASK_CAPACITY_REACHED"
              ? "Five live tasks are already admitted."
              : parsed.data.error === "TASK_SURFACE_UNREACHABLE"
                ? "The isolated ChatGPT page could not be opened."
                : "The task route is unavailable.";
        render();
        return;
      }
      if (parsed.data.selectedTaskId === null) {
        taskAdmissionFeedback = "The task route omitted its selected task.";
        render();
        return;
      }
      selectedTaskId = parsed.data.selectedTaskId;
      section = "browser";
      shellOverlay = "none";
      render();
    },
  );
  required<HTMLButtonElement>("#task-menu-button").addEventListener(
    "click",
    openTaskMenu,
  );
  required<HTMLButtonElement>("#task-menu-close").addEventListener(
    "click",
    closeOverlay,
  );
  required<HTMLButtonElement>("#task-menu-activity").addEventListener(
    "click",
    () => selectSection("activity"),
  );
  required<HTMLButtonElement>("#task-menu-computer").addEventListener(
    "click",
    () => selectSection("computer"),
  );
  required<HTMLButtonElement>("#task-menu-setup").addEventListener(
    "click",
    () => {
      shellOverlay = "none";
      setupJourney = reopenSetup(setupJourney);
      render();
    },
  );
  const renameLiveTask = () => {
    const task = taskById(selectedTaskId);
    if (task?.provider !== "chatgpt") return;
    const label = required<HTMLInputElement>("#task-menu-name").value.trim();
    void runTaskMenuCommand(
      { kind: "task.rename", taskId: task.taskId, label },
      "Task renamed.",
    );
  };
  required<HTMLButtonElement>("#task-menu-rename").addEventListener(
    "click",
    renameLiveTask,
  );
  required<HTMLInputElement>("#task-menu-name").addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      renameLiveTask();
    },
  );
  required<HTMLTextAreaElement>("#task-agent-objective").addEventListener(
    "input",
    renderTaskMenu,
  );
  for (const selector of [
    "#task-agent-scope",
    "#task-agent-subtree",
    "#task-agent-paths",
    "#task-agent-exclusions",
  ]) {
    required<HTMLElement>(selector).addEventListener("input", renderTaskMenu);
  }
  required<HTMLButtonElement>("#task-menu-agent").addEventListener(
    "click",
    () => {
      const task = taskById(selectedTaskId);
      if (task?.provider !== "chatgpt") return;
      const needsRejoin =
        task.agent?.phase === "running" ||
        (task.agent?.phase === "completed" &&
          task.agent.parentDelivery === "pending" &&
          task.agent.resultAvailable);
      if (needsRejoin) {
        void runTaskMenuCommand(
          { kind: "task.rejoin-agent", taskId: task.taskId },
          task.agent?.phase === "running"
            ? "Agent state refreshed."
            : "Agent result delivered.",
        );
        return;
      }
      const workspaceId = required<HTMLSelectElement>(
        "#task-agent-workspace",
      ).value;
      const objective = required<HTMLTextAreaElement>(
        "#task-agent-objective",
      ).value.trim();
      const scope = productAgentScopeSelection();
      if (!scope) return;
      void runTaskMenuCommand(
        {
          kind: "task.start-agent",
          taskId: task.taskId,
          workspaceId,
          objective,
          scope,
        },
        "Agent assignment admitted.",
      );
    },
  );
  required<HTMLButtonElement>("#task-menu-pin").addEventListener(
    "click",
    () => {
      const task = taskById(selectedTaskId);
      if (task?.provider !== "chatgpt") return;
      void runTaskMenuCommand(
        { kind: "task.pin", taskId: task.taskId, pinned: !task.pinned },
        task.pinned ? "Task unpinned." : "Task pinned.",
      );
    },
  );
  required<HTMLButtonElement>("#task-menu-cancel").addEventListener(
    "click",
    () => {
      const task = taskById(selectedTaskId);
      if (task?.provider !== "chatgpt") return;
      void runTaskMenuCommand(
        { kind: "task.cancel", taskId: task.taskId },
        task.agent?.phase === "running"
          ? "Agent cancellation confirmed."
          : "Provider stop confirmed.",
      );
    },
  );
  required<HTMLButtonElement>("#task-menu-close-task").addEventListener(
    "click",
    () => {
      const task = taskById(selectedTaskId);
      if (task?.provider !== "chatgpt") return;
      void runTaskMenuCommand(
        { kind: "task.close", taskId: task.taskId },
        "Task closed.",
        true,
      );
    },
  );
  required<HTMLDialogElement>("#task-menu").addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      closeOverlay();
    },
  );
  required<HTMLDialogElement>("#command-dialog").addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      closeOverlay();
    },
  );
  required<HTMLDialogElement>("#context-preview").addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      void cancelContextPreview();
    },
  );
  required<HTMLButtonElement>("#context-preview-cancel").addEventListener(
    "click",
    () => void cancelContextPreview(),
  );
  required<HTMLButtonElement>("#context-preview-submit").addEventListener(
    "click",
    () => void submitContextPreview(),
  );
  required<HTMLInputElement>("#command-search").addEventListener(
    "input",
    (event) => renderCommands((event.currentTarget as HTMLInputElement).value),
  );
  required<HTMLInputElement>("#command-search").addEventListener(
    "keydown",
    (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveCommandSelection(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      document
        .querySelector<HTMLButtonElement>("#command-results button.is-selected")
        ?.click();
    },
  );
  required<HTMLButtonElement>("#approve-tool").addEventListener(
    "click",
    async () => {
      if (!computerTargetTaskId) return;
      const result = await window.farolNext.control(
        computerTargetTaskId,
        "release-tool",
      );
      if (!controlSuccessSchema.safeParse(result).success) return;
      required<HTMLButtonElement>("#approve-tool").disabled = true;
    },
  );
  required<HTMLButtonElement>("#finish-demo").addEventListener(
    "click",
    async () => {
      await window.farolNext.control(selectedTaskId, "finish-demo");
    },
  );
  required<HTMLButtonElement>("#dossier-route").addEventListener(
    "click",
    () => {
      const task = taskById(selectedTaskId);
      if (task?.provider === "chatgpt") {
        void window.farolNext.task({
          kind: "task.activate",
          taskId: selectedTaskId,
        });
        return;
      }
      const tone = taskState(selectedTaskId).tone;
      selectSection(
        tone === "waiting"
          ? "computer"
          : tone === "unavailable"
            ? "settings"
            : "activity",
      );
    },
  );
  required<HTMLButtonElement>("#apply-general-settings").addEventListener(
    "click",
    () => {
      const openAtLaunch = required<HTMLSelectElement>(
        "#setting-open-at-launch",
      ).value;
      const sidebarDefault = required<HTMLSelectElement>(
        "#setting-sidebar-default",
      ).value;
      const activityDetail = required<HTMLSelectElement>(
        "#setting-activity-detail",
      ).value;
      const command = ProductConfigurationCommandSchema.safeParse({
        kind: "general.update",
        openAtLaunch,
        sidebarDefault,
        activityDetail,
      });
      if (!command.success) return;
      void configureProduct(command.data, "General settings applied.");
    },
  );
  required<HTMLButtonElement>("#open-computer-settings").addEventListener(
    "click",
    () => selectSection("computer"),
  );
  required<HTMLButtonElement>("#export-support").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "support.export" },
        "Support report exported.",
      );
    },
  );
  required<HTMLButtonElement>("#save-computer-name").addEventListener(
    "click",
    () => {
      const name = required<HTMLInputElement>("#computer-name").value;
      const command = ProductConfigurationCommandSchema.safeParse({
        kind: "computer.rename",
        name,
      });
      if (!command.success) {
        settingsFeedbackSurface = "computer";
        settingsFeedback = "Computer name must contain 1–80 characters.";
        settingsFeedbackError = true;
        render();
        return;
      }
      void configureProduct(command.data, "Computer name saved.");
    },
  );
  required<HTMLButtonElement>("#add-workspace").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "computer.add-workspace" },
        "Read-only workspace saved and read back.",
      );
    },
  );
  required<HTMLButtonElement>("#setup-live-primary").addEventListener(
    "click",
    () => {
      void setupPrimaryAction?.();
    },
  );
  required<HTMLButtonElement>("#setup-back").addEventListener("click", () => {
    const next = retreatSetup(setupJourney);
    const step = setupSteps[next.step];
    if (!step) return;
    void configureProduct(
      { kind: "setup.progress", currentStep: step.id, dismissed: false },
      "Setup position saved.",
    ).then((saved) => {
      if (!saved) return;
      setupJourney = next;
      render();
    });
  });
  required<HTMLButtonElement>("#setup-next").addEventListener("click", () => {
    const wasFirstRun = setupJourney.mode === "first-run";
    const next = advanceSetup(setupJourney);
    const step = setupSteps[next.step];
    if (!step) return;
    void configureProduct(
      {
        kind: "setup.progress",
        currentStep: step.id,
        dismissed: !next.open,
      },
      next.open
        ? "Setup position saved."
        : "Setup saved. Limited mode is open.",
    ).then((saved) => {
      if (!saved) return;
      setupJourney = next;
      if (!setupJourney.open && wasFirstRun) section = "browser";
      render();
    });
  });
  required<HTMLButtonElement>("#setup-close").addEventListener("click", () => {
    setupJourney = { ...setupJourney, open: false };
    render();
  });
  required<HTMLButtonElement>("#review-setup").addEventListener("click", () => {
    setupJourney = reopenSetup(setupJourney);
    render();
  });
  required<HTMLInputElement>("#model-select-default").addEventListener(
    "change",
    (event) => {
      modelSelectAsDefault = (event.currentTarget as HTMLInputElement).checked;
    },
  );
  required<HTMLButtonElement>("#model-check-status-btn").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "model.status" },
        "Farol Model status checked.",
      );
    },
  );
  required<HTMLButtonElement>("#model-preview-btn").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "model.preview", selectAsDefault: modelSelectAsDefault },
        "Farol Model connection previewed.",
      );
    },
  );
  required<HTMLButtonElement>("#model-apply-btn").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "model.apply", selectAsDefault: modelSelectAsDefault },
        "Farol Model connection applied.",
      );
    },
  );
  required<HTMLButtonElement>("#model-rollback-btn").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "model.rollback" },
        "Farol Model connection rolled back.",
      );
    },
  );
  required<HTMLButtonElement>("#model-rotate-btn").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "model.rotate-token" },
        "Farol Model token rotated.",
      );
    },
  );
  required<HTMLDialogElement>("#setup-dialog").addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      if (setupJourney.mode !== "review") return;
      setupJourney = { ...setupJourney, open: false };
      render();
    },
  );

  narrowSidebar.addEventListener("change", () => {
    if (!narrowSidebar.matches) {
      sidebarOverlayOpen = false;
      if (shellOverlay === "sidebar") shellOverlay = "none";
    }
    render();
  });
  window.addEventListener("keydown", (event) => {
    if (setupJourney.open) return;
    if (event.key === "Escape" && shellOverlay !== "none") {
      event.preventDefault();
      closeOverlay();
      return;
    }
    if (event.metaKey && /^[1-4]$/u.test(event.key)) {
      event.preventDefault();
      const next = sections[Number(event.key) - 1];
      if (next) selectSection(next);
    } else if (event.ctrlKey && event.key === "Tab") {
      event.preventDefault();
      if (bootstrap.tasks.length === 0) return;
      const index = bootstrap.tasks.findIndex(
        (task) => task.taskId === selectedTaskId,
      );
      const direction = event.shiftKey ? -1 : 1;
      const task =
        bootstrap.tasks[
          (index + direction + bootstrap.tasks.length) % bootstrap.tasks.length
        ];
      if (task) selectTask(task.taskId);
    }
  });

  bootstrapReady = true;
  if (pendingRuntimeStatus) applyRuntimeStatus(pendingRuntimeStatus);
  if (pendingTasksState) {
    const state = pendingTasksState;
    pendingTasksState = null;
    applyTasksState(state);
  }
  pendingTaskSurfaceStatuses.splice(0).forEach(applyTaskSurfaceStatus);
  pendingRuntimeEvents.splice(0).forEach(recordEvent);
  if (pendingLayout) {
    const layout = pendingLayout;
    pendingLayout = null;
    applyHostLayout(layout);
  } else {
    render();
  }
  if (bootstrap.chatgptRecoveryPending) {
    queueMicrotask(() => {
      void configureProduct(
        { kind: "chatgpt.recover-task-result" },
        "Previous ChatGPT task result recovered.",
      );
    });
  }
}

void start();
