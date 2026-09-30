import { createInstalledUpdateView } from "./installed-update-view";
import { InstalledUpdateViewSchema } from "../modules/release/contract/installed-update";
import { z } from "zod";
import { chatGptPreSubmitRemedy } from "./chatgpt-pre-submit-remedy";
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
  BrowserRouteStatusSchema,
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
  ProductConfigurationSnapshotSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationEvidence,
  type ProductDiscoveryCandidate,
} from "../pkg/product-settings/contract";
import {
  guidedSetupSelected,
  initialSetupPresentation,
} from "../pkg/product-settings/setup-entry";
import {
  compactBrowserSelected,
  embeddedBrowserSelected,
} from "../pkg/product-settings/browser-presentation";
import { GuidedOnboardingView } from "./guided-onboarding-view";
import {
  advanceSetup,
  createSetupJourney,
  reopenSetup,
  retreatSetup,
  setupSteps,
} from "./setup-journey";
import { contextTaskPresentation } from "./context-task-presentation";
import { TaskMenuTrace } from "./task-menu-trace";
import { hostLayoutChanged, hostLayoutUpdate } from "./host-layout";
import { DiagnosticThrottle } from "./diagnostic-throttle";
import {
  AGENT_AUTHORITY_CHANGED,
  agentAuthorityUnchanged,
  completionMayNavigate,
  decideShellAction,
  type AgentAuthority,
} from "./shell-action-policy";
import {
  AgentDraftStore,
  EMPTY_AGENT_DRAFT,
  type AgentDraftFields,
} from "./agent-draft";
import {
  agentActionPrerequisite,
  agentFieldPrerequisite,
  agentWorkspaceFixedReason,
  reviewComputerRequestPrerequisite,
  taskCancelPrerequisite,
  taskClosePrerequisite,
  taskRenamePrerequisite,
  TASK_MENU_BUSY_NOTE,
  taskMenuNote,
} from "./task-menu-presentation";
import {
  approveToolPrerequisite,
  guardedEditApplyPrerequisite,
  searchMatchDisplay,
  workspaceReadPrerequisite,
  workspaceSearchPrerequisite,
} from "./computer-presentation";
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
import {
  ActivityLog,
  SetupCheckHistory,
  projectActivity,
  type SetupCheckOperation,
  type SetupCheckPhase,
} from "./activity-log";
import { captureInputDraft, restoreInputDraft } from "./input-draft";
import {
  agentRouteReadiness,
  agentVerifyStepPresentation,
  connectorChoosePrerequisite,
  connectorRoutePrerequisite,
  connectorStartPrerequisite,
  connectorStopPrerequisite,
  devHostSetupSummary,
  devProofEvidenceCurrent,
  localHostRouteReadiness,
  localHostContractVerified,
  readinessDetail,
  readinessLabel,
  nativeHostActionPrerequisite,
  routeReadiness,
  routeRowDetail,
  routeRowLabel,
  setupConnectPrimary,
  setupStepStale,
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
  configurationEffectOutcome,
  UNCONFIRMED_CONFIGURATION_MESSAGE,
  type ConfigurationTransport,
} from "./configuration-outcome";
import {
  ConfigurationRequestOrder,
  shouldAdoptConfigurationSnapshot,
  configurationEvidenceRevision,
} from "./configuration-request-order";
import { sidebarToggleLeft } from "./window-chrome-geometry";
import {
  defaultNavigationShortcuts,
  parseNavigationShortcuts,
  sidebarShortcutMatches,
  sectionForShortcut,
  type NavigationShortcuts,
} from "../pkg/ipc/navigation-shortcuts";

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

function sharedCodexSocketRefusalMessage(error: string): string | null {
  switch (error) {
    case "CODEX_SHARED_SOCKET_NOT_FOUND":
      return "The selected shared Codex socket is no longer present. No task was started.";
    case "CODEX_SHARED_SOCKET_ACCESS_DENIED":
      return "Access was denied while inspecting the selected shared Codex socket. No task was started.";
    case "CODEX_SHARED_SOCKET_ALIAS_UNSUPPORTED":
      return "This Farol version does not support the selected shared Codex alias. No task was started.";
    case "CODEX_SHARED_SOCKET_INVALID_TARGET":
      return "The selected shared Codex endpoint has the wrong type, owner, or canonical path. No task was started.";
    case "CODEX_SHARED_SOCKET_CHECK_FAILED":
      return "Farol could not classify the selected shared Codex socket. No task was started.";
    case "CODEX_SHARED_PROXY_LAUNCH_FAILED":
      return "The shared Codex proxy could not start. No task was started.";
    case "CODEX_SHARED_PROXY_PIPE_FAILED":
      return "The shared Codex proxy connection failed. No task was started.";
    case "CODEX_SHARED_PROXY_EXITED":
      return "The shared Codex proxy exited before initialization. No task was started.";
    case "CODEX_SHARED_PROXY_TIMEOUT":
      return "The shared Codex proxy did not initialize in time. No task was started.";
    case "CODEX_SHARED_PROXY_INVALID_IDENTITY":
      return "The shared Codex proxy reported an unexpected runtime identity. No task was started.";
    case "CODEX_SHARED_PROXY_PROTOCOL_ERROR":
      return "The shared Codex proxy sent an invalid response. No task was started.";
    case "CODEX_SHARED_PROXY_RPC_ERROR":
      return "The shared Codex proxy refused initialization. No task was started.";
    default:
      return null;
  }
}

// `bootstrap.productName` carries the release identity the main process
// validates elsewhere ("Farol Next Preview"); the diagnostics row below
// only names the app to the owner, so it reads "Farol" with its
// "Developer Preview" edition mark, matching the window title and the
// brand mark in shell.html.
let displayProductName = "Farol";
let displayEdition = "Developer Preview";

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
  environment: z.enum(["preview", "dev"]),
  displayName: z.enum(["Farol", "Farol Dev"]),
  displayEdition: z.enum(["Developer Preview", "Development"]),
  applicationId: z.enum(["local.farol.next.preview", "local.farol.dev"]),
  build: BuildIdentitySchema,
  demoMode: z.boolean(),
  legacySetupTestMode: z.boolean().default(false),
  configuration: ProductConfigurationSnapshotSchema,
  runtimeState: z.enum(["starting", "ready", "offline", "failed"]),
  runtimeError: z.string().nullable(),
  runtimeIdentity: z.string().nullable(),
  embeddedNode: z.string().nullable(),
  embeddedElectron: z.string().nullable(),
  taskRevision: z.number().int().nonnegative(),
  tasks: z.array(ProductTaskSchema).max(5),
  partition: z.string(),
  chatgptPartition: z.enum([
    "persist:farol-next-chatgpt",
    "persist:farol-dev-chatgpt",
  ]),
  chatgptRecoveryPending: z.boolean(),
  chatgptConversationState: z.enum([
    "new",
    "retained",
    "review_required",
    "unavailable",
  ]),
  updateChannel: z.enum(["local-preview-only", "github-owner-beta"]),
  nativeFilesystem: z.literal(true),
  nativeAgent: z.boolean(),
  liveProvider: z.literal(false),
  windowState: WindowStateSchema,
  chatgptSignInBlocked: chatGptSignInBlockedSchema,
  chatgptSignInOutcome: chatGptSignInOutcomeSchema,
  // Null in every production build: see main.ts's bootstrap() and
  // configuration-reply-fault.ts. Nullable rather than optional so a build
  // that forgot to publish it fails the parse instead of reading as unarmed.
  e2eWorkspaceEditAckHold: z.number().int().nonnegative().nullable(),
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
  "setup.check": "Setup check",
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
      installedUpdate(command: unknown): Promise<unknown>;
      onInstalledUpdateState(listener: (state: unknown) => void): () => void;
      bootstrap(): Promise<unknown>;
      snapshot(): Promise<unknown>;
      configure(command: unknown): Promise<unknown>;
      task(command: unknown): Promise<unknown>;
      control(taskId: string, action: string): Promise<unknown>;
      setNavigationShortcuts(shortcuts: NavigationShortcuts): Promise<unknown>;
      layout(
        section: string,
        taskId: string,
        setupOpen: boolean,
        checkFeedbackVisible: boolean,
        sidebar: string,
        overlay: string,
      ): void;
      onRuntimeEvent(listener: (event: unknown) => void): () => void;
      onRuntimeState(listener: (status: unknown) => void): () => void;
      onBrowserRouteState(listener: (status: unknown) => void): () => void;
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

function applyProductIdentity(): void {
  const dev = bootstrap.environment === "dev";
  if (
    bootstrap.displayName !== (dev ? "Farol Dev" : "Farol") ||
    bootstrap.displayEdition !== (dev ? "Development" : "Developer Preview") ||
    bootstrap.applicationId !==
      (dev ? "local.farol.dev" : "local.farol.next.preview")
  ) {
    throw new Error("UI_DESKTOP_IDENTITY_INVALID");
  }
  displayProductName = bootstrap.displayName;
  displayEdition = bootstrap.displayEdition;
  document.documentElement.dataset.environment = bootstrap.environment;
  document.title = `${displayProductName} · ${displayEdition}`;
  required("#product-brand").setAttribute(
    "aria-label",
    `${displayProductName}, ${displayEdition}`,
  );
  required("#brand-name").textContent = displayProductName;
  required("#brand-edition").textContent = displayEdition;
  required("#window-product-name").textContent = displayProductName;
  required("#window-product-edition").textContent = displayEdition;
  required("#setup-product-name").textContent = displayProductName;
  required("#setup-product-edition").textContent = displayEdition;
}

const narrowSidebar = window.matchMedia("(max-width: 979px)");

let bootstrap: Bootstrap;
let bootstrapReady = false;
let section: SurfaceSection = "browser";
let selectedTaskId = "";
let connectionCheckFeedback: string | null = null;
let connectionCheckTone: "running" | "failed" | "complete" | null = null;
let setupJourney = createSetupJourney();
let guidedOnboarding: GuidedOnboardingView | null = null;
let setupFocusKey = "";
let sidebarPreference: Exclude<SidebarMode, "overlay"> = "full";
let sidebarOverlayOpen = false;
let shellOverlay: ShellOverlay = "none";
let settingsCategory: "preferences" | "shortcuts" | "model" | "diagnostics" =
  "preferences";
const navigationShortcutStorageKey = "farol.next.navigation-shortcuts.v1";
function storedNavigationShortcuts(): NavigationShortcuts {
  try {
    return (
      parseNavigationShortcuts(
        JSON.parse(
          localStorage.getItem(navigationShortcutStorageKey) ?? "null",
        ),
      ) ?? { ...defaultNavigationShortcuts }
    );
  } catch {
    return { ...defaultNavigationShortcuts };
  }
}
let navigationShortcuts = storedNavigationShortcuts();

/**
 * Every write to `shellOverlay` goes through here, so a run can say which
 * code path closed an open overlay.
 *
 * The dialog follows this value: it closes the moment the value leaves
 * "task-menu". A measured run ended with the task menu closed, the section
 * unchanged, no navigating shell action and no layout push — so something
 * inside the renderer wrote it and nothing recorded which. Diagnostic only;
 * the assignment itself is unchanged.
 *
 * The frames are reduced to basename:line:column, so the line carries call
 * sites and never a path from this machine.
 */
// The two lines that can fire as often as the renderer draws. Everything
// else here is one line per event and is rare by construction.
const renderDuringMenu = new DiagnosticThrottle(() => Date.now());
const tasksStateDuringMenu = new DiagnosticThrottle(() => Date.now());

// The dialog node this module is holding, captured once the document is
// ready, so a later render can say whether the document still has the same
// one. A replaced node keeps `open` true while showing nothing, emits no
// close event and changes no overlay value — the one shape that leaves no
// trace in any of the other lines.
let taskMenuNode: HTMLDialogElement | null = null;

// A fresh identifier per renderer instance. If a run's lines carry two of
// these, the page or the window was replaced and nothing inside this module
// closed anything.
const rendererInstance = Math.random().toString(36).slice(2, 10);

function watchTaskMenuNode(): void {
  taskMenuNode = document.querySelector<HTMLDialogElement>("#task-menu");
  console.debug(
    "farol.shell-start",
    JSON.stringify({ rendererInstance, hasDialog: taskMenuNode !== null }),
  );
  const parent = taskMenuNode?.parentElement;
  if (!parent) return;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const [kind, nodes] of [
        ["removed", record.removedNodes],
        ["added", record.addedNodes],
      ] as const) {
        for (const node of nodes) {
          if (!(node instanceof HTMLElement) || node.id !== "task-menu") {
            continue;
          }
          console.debug(
            "farol.task-menu-node",
            JSON.stringify({
              rendererInstance,
              event: kind,
              sameNode: node === taskMenuNode,
              open: (node as HTMLDialogElement).open,
              connected: node.isConnected,
              frames: diagnosticFrames(),
            }),
          );
        }
      }
    }
  }).observe(parent, { childList: true });
}

// Which dialogs are open, which one the browser considers topmost, and
// therefore which one the owner can actually reach.
//
// A second showModal() puts its dialog above the first in the top layer and
// makes everything outside the topmost modal inert: not focusable, not
// clickable, with no close event and no state change anywhere. An open,
// connected, same-node dialog whose controls cannot be used is that and
// nothing else.
function topLayerCensus(): Readonly<Record<string, unknown>> {
  const open = [...document.querySelectorAll("dialog[open]")];
  return {
    openDialogs: open.map((dialog) => dialog.id || "(anonymous)"),
    topmostModal: open.find((dialog) => dialog.matches(":modal"))?.id ?? null,
    taskMenuIsModal:
      document.querySelector("#task-menu")?.matches(":modal") ?? null,
    activeElement: (document.activeElement as HTMLElement | null)?.id ?? null,
    setupOpen: setupJourney.open,
  };
}

function diagnosticFrames(): string {
  return (new Error().stack ?? "")
    .split("\n")
    .slice(1, 7)
    .map((frame) =>
      frame
        .trim()
        .replace(/\(?.*[/\\]/u, "")
        .replace(/\)$/u, ""),
    )
    .join(" < ");
}

function setShellOverlay(next: ShellOverlay): void {
  if (shellOverlay !== next && shellOverlay === "task-menu") {
    const frames = (new Error().stack ?? "")
      .split("\n")
      .slice(1, 7)
      .map((frame) =>
        frame
          .trim()
          .replace(/\(?.*[/\\]/u, "")
          .replace(/\)$/u, ""),
      )
      .join(" < ");
    console.debug(
      "farol.overlay",
      JSON.stringify({ from: shellOverlay, to: next, frames }),
    );
  }
  if (next !== "task-menu") {
    // Report what the window swallowed before forgetting it. Without this
    // the suppressed count only ever surfaces on a LATER admitted line, so
    // a burst of renders just before a run fails is invisible — which is a
    // hole this instrument had, found while decoding one.
    for (const [name, throttle] of [
      ["render-during-menu", renderDuringMenu],
      ["tasks-state-during-menu", tasksStateDuringMenu],
    ] as const) {
      const pending = throttle.pending();
      if (pending > 0) {
        console.debug(
          `farol.${name}-final`,
          JSON.stringify({ rendererInstance, suppressed: pending }),
        );
      }
    }
    // A later menu session starts with its own first line rather than being
    // silenced by this one's window.
    renderDuringMenu.reset();
    tasksStateDuringMenu.reset();
  }
  // eslint-disable-next-line no-restricted-syntax -- the one real write
  shellOverlay = next;
}
let renderedOverlay: ShellOverlay = "none";
let lastHostLayout = "";
let windowState: WindowState = {
  focused: false,
  fullScreen: false,
  trafficLightPosition: null,
};
let computerTargetTaskId: string | null = null;
let taskModelCatalogue: {
  revision: number;
  view: import("../pkg/owner-config/contract").TaskModelCatalogueView;
} | null = null;
let settingsFeedback = "";
let settingsFeedbackError = false;
let settingsFeedbackSurface: "computer" | "settings" | "setup" = "settings";
const configurationRequestOrder = new ConfigurationRequestOrder();
let taskAdmissionFeedback = "";
let browserHomeStatus: "idle" | "opening" | "ready" | "failed" = "idle";
let browserHomeOpening = false;
let taskMenuFeedback = "";
let taskMenuFeedbackError = false;
// Why a task-menu command's sentence did or did not reach the note. See
// task-menu-trace.ts: a wait on the note's text cannot tell the three
// silences apart, and this does.
const taskMenuTrace = new TaskMenuTrace(() => Math.round(performance.now()));
let taskMenuBusy = false;
// The owner's Agent assignment text, held here rather than only in the
// fields, so an unowned shell action that closes the menu cannot take it.
const taskAgentDraft = new AgentDraftStore();
// Shell actions already acted on, so a proven duplicate has no second
// effect. Only ids go in; an envelope without one is never deduplicated.
const handledShellActionIds = new Set<string>();
// Whether a background event has updated readiness while the owner was
// writing an assignment, so the menu offers a way out instead of taking
// the editor.
let taskMenuReturnOffered = false;
// The sign-in surface this renderer last saw opened. A return stamped with an
// older number is a delayed event from a previous attempt.
let currentAuthWindowGeneration: number | null = null;
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
let devProofEvidence: Extract<
  ProductConfigurationEvidence,
  { kind: "dev-proof.prepared" | "dev-proof.verified" }
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
const setupCheckHistory = new SetupCheckHistory(localStorage);
for (const entry of setupCheckHistory.entries()) activity.record(entry);

function setupCheckOperation(
  command: ProductConfigurationCommand,
): SetupCheckOperation | null {
  return command.kind === "connector.verify-app" ||
    command.kind === "connector.check-health"
    ? command.kind
    : null;
}

function recordSetupCheck(
  operation: SetupCheckOperation,
  phase: SetupCheckPhase,
  runId: string,
  code: string | null = null,
): void {
  activity.record(setupCheckHistory.record(operation, phase, runId, code));
}
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
    checkFeedbackVisible:
      embeddedBrowserSelected(bootstrap) &&
      section === "browser" &&
      chatGptSignInOpened &&
      Boolean(connectionCheckFeedback),
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
    layout.checkFeedbackVisible,
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
                  return "ChatGPT connected";
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
  const retry = required<HTMLButtonElement>("#browser-retry");
  retry.hidden = true;
  const task = taskById(selectedTaskId);
  const surfaceFailed =
    taskSurfaceStatuses.get(selectedTaskId)?.state === "failed";
  if (
    embeddedBrowserSelected(bootstrap) &&
    section === "browser" &&
    bootstrap.tasks.length === 0
  ) {
    const failed = browserHomeStatus === "failed";
    loading.dataset.state = failed
      ? "browser-error"
      : browserHomeStatus === "ready"
        ? "ready"
        : "sign-in";
    mark.className = `state-lamp ${failed ? "failed" : "running"}`;
    title.textContent = failed
      ? "ChatGPT could not open"
      : browserHomeStatus === "ready"
        ? "ChatGPT is open"
        : "Opening ChatGPT";
    detail.textContent = failed
      ? "Check your connection, then try opening ChatGPT again."
      : chatGptSignInOpened
        ? "Finish signing in here, then choose Return to Setup in the sidebar."
        : "ChatGPT opens inside Farol. You can return to Setup at any time.";
    retry.hidden = !failed;
  } else if (
    bootstrap.runtimeState === "ready" &&
    bootstrap.tasks.length === 0
  ) {
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
    title.textContent = "Opening ChatGPT";
    detail.textContent = "Your ChatGPT page opens in this tab.";
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
  if (
    embeddedBrowserSelected(bootstrap) &&
    (chatGptSignInOpened || bootstrap.tasks.length === 0)
  ) {
    const item = document.createElement("div");
    item.className = "task-tab-item";
    const button = document.createElement("button");
    button.className = "task-tab task-tab-home active";
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "true");
    button.setAttribute("aria-label", "ChatGPT page");
    const label = document.createElement("span");
    label.textContent = chatGptSignInOpened ? "ChatGPT check" : "ChatGPT";
    const lamp = document.createElement("i");
    lamp.className = `state-lamp ${browserHomeStatus === "ready" ? "complete" : browserHomeStatus === "failed" ? "failed" : "starting"}`;
    lamp.setAttribute("aria-hidden", "true");
    button.title =
      browserHomeStatus === "ready"
        ? "ChatGPT page ready"
        : browserHomeStatus === "failed"
          ? "ChatGPT page unavailable"
          : "Opening ChatGPT";
    button.append(label, lamp);
    item.append(button);
    tabs.replaceChildren(item);
    return;
  }
  tabs.replaceChildren(
    ...bootstrap.tasks.map((task) => {
      const state = taskState(task.taskId);
      const item = document.createElement("div");
      item.className = "task-tab-item";
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
      item.append(button);
      if (compactBrowserSelected(bootstrap) && task.provider === "chatgpt") {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "task-tab-close";
        close.textContent = "×";
        close.setAttribute("aria-label", `Close ${taskLabel(task)}`);
        close.title = `Close ${taskLabel(task)}`;
        close.addEventListener("click", () => void closeTaskTab(task.taskId));
        item.append(close);
      }
      return item;
    }),
  );
}

async function closeTaskTab(taskId: string): Promise<void> {
  let response: unknown;
  try {
    response = await window.farolNext.task({ kind: "task.close", taskId });
  } catch {
    selectedTaskId = taskId;
    openTaskMenu();
    taskMenuFeedback =
      "The task close result was not confirmed. Check this task before trying again.";
    taskMenuFeedbackError = true;
    render();
    return;
  }
  const parsed = ProductTaskCommandResultSchema.safeParse(response);
  if (parsed.success) applyTasksState(parsed.data.state);
  if (!parsed.success || !parsed.data.ok) {
    selectedTaskId = taskId;
    openTaskMenu();
    taskMenuFeedback = !parsed.success
      ? "The task route returned an invalid result."
      : !parsed.data.ok
        ? taskMenuErrorMessage(parsed.data.error)
        : "The task could not be closed.";
    taskMenuFeedbackError = true;
    render();
    return;
  }
  selectedTaskId = parsed.data.selectedTaskId ?? "";
  render();
}

function renderBrowserStatus(): void {
  const task = taskById(selectedTaskId);
  const request = task ? unresolvedComputerRequest(task.taskId) : null;
  const state = task ? taskState(task.taskId) : null;
  const feedback = chatGptSignInOpened ? connectionCheckFeedback : null;
  document.documentElement.dataset.checkFeedback = feedback ? "true" : "false";
  const checkBanner = required<HTMLElement>("#browser-check-banner");
  checkBanner.hidden = !feedback;
  checkBanner.dataset.tone = feedback ? (connectionCheckTone ?? "running") : "";
  required<HTMLElement>("#browser-check-title").textContent =
    connectionCheckTone === "failed"
      ? "Check needs attention"
      : connectionCheckTone === "complete"
        ? "Check passed"
        : "Checking ChatGPT";
  required<HTMLElement>("#browser-check-detail").textContent = feedback ?? "";
  checkBanner.title = feedback ?? "";
  const status = required<HTMLElement>("#browser-status");
  status.textContent = request
    ? "Computer permission requested"
    : state?.attention
      ? `${taskLabel(task!)} · ${state.label}`
      : task
        ? `${taskLabel(task)} · ${state?.label ?? "Ready"}`
        : "ChatGPT inside Farol";
  status.title = "";
  const action = required<HTMLButtonElement>("#browser-review-request");
  action.hidden = !request;
  action.textContent = "Review request";
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
      const digit = navigationShortcuts[route];
      const shortcut =
        route === "settings"
          ? digit === 0
            ? "⌘,"
            : `⌘, or ⌘${digit}`
          : digit === 0
            ? "no assigned key"
            : `⌘${digit}`;
      const keyHint = button.querySelector<HTMLElement>("kbd");
      if (keyHint)
        keyHint.textContent =
          route === "settings" ? "⌘," : digit === 0 ? "" : `⌘${digit}`;
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
  route.title = route.disabled
    ? "This task is still connecting. Its page opens once it is ready."
    : "";
  route.innerHTML =
    task.provider === "chatgpt"
      ? "Focus page <span>›</span>"
      : state.tone === "waiting"
        ? "Review request <span>›</span>"
        : state.tone === "unavailable"
          ? "Open Settings <span>›</span>"
          : "Open Activity <span>›</span>";

  const reviewPrerequisite = reviewComputerRequestPrerequisite(
    unresolvedComputerRequest(selectedTaskId) !== null,
  );
  taskMenuComputer.disabled = reviewPrerequisite !== null;
  taskMenuComputer.title =
    reviewPrerequisite ??
    "Review the bounded Computer request this task is waiting on";
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
  return routeReadiness(settings.setup.computer, {
    stale: setupStepStale(settings, "computer"),
  });
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

/**
 * Put the task menu's sentence in the DOM.
 *
 * This used to be inline, two hundred lines below `renderTaskMenu`'s
 * `if (!live || !task) return;`. A command that settled into a state where
 * the selection was empty or no longer a live ChatGPT task therefore set its
 * success sentence on the module variable and then returned above the only
 * line that would have shown it — so the sentence could never appear, and a
 * wait for it could only expire. Both sites now call this.
 */
function writeTaskMenuNote(state: Parameters<typeof taskMenuNote>[0]): void {
  const note = document.querySelector<HTMLElement>("#task-menu-note");
  if (!note) return;
  if (state.feedback) taskMenuTrace.noted();
  note.dataset.error = String(taskMenuFeedbackError);
  note.textContent = taskMenuNote(state);
  writeTaskMenuTrace();
}

// The trace has to be readable even when renderTaskMenu returned before it
// could write the note — which is the case worth reading.
function writeTaskMenuTrace(): void {
  const note = document.querySelector<HTMLElement>("#task-menu-note");
  if (!note) return;
  note.dataset.trace = taskMenuTrace.serialize();
  note.dataset.phase = taskMenuTrace.phase();
}

function currentAgentAuthority(): AgentAuthority | null {
  const configured = bootstrap.configuration;
  if (configured.status !== "ready") return null;
  const settings = configured.settings;
  const verified = settings.setup.computer.verified;
  if (!verified?.workspaceId) return null;
  return {
    workspaceId: verified.workspaceId,
    configGeneration: settings.computer.generation,
    hostExecutablePath: settings.nativeHosts.codex?.executablePath ?? null,
  };
}

function readAgentDraftFields(): AgentDraftFields {
  return {
    mode: required<HTMLSelectElement>("#task-agent-scope").value,
    objective: required<HTMLTextAreaElement>("#task-agent-objective").value,
    subtree: required<HTMLInputElement>("#task-agent-subtree").value,
    paths: required<HTMLTextAreaElement>("#task-agent-paths").value,
    exclusions: required<HTMLTextAreaElement>("#task-agent-exclusions").value,
  };
}

function writeAgentDraftFields(fields: AgentDraftFields): void {
  required<HTMLSelectElement>("#task-agent-scope").value = fields.mode;
  required<HTMLTextAreaElement>("#task-agent-objective").value =
    fields.objective;
  required<HTMLInputElement>("#task-agent-subtree").value = fields.subtree;
  required<HTMLTextAreaElement>("#task-agent-paths").value = fields.paths;
  required<HTMLTextAreaElement>("#task-agent-exclusions").value =
    fields.exclusions;
}

function renderTaskMenu(): void {
  const task = taskById(selectedTaskId);
  const live = task?.provider === "chatgpt";
  required<HTMLElement>("#task-menu-live").hidden = !live;
  required<HTMLElement>("#task-menu-fixture").hidden = live;
  if (!live || !task) {
    // No live task to advise about — but a command's own result sentence
    // still has to reach the owner, which is exactly what returning here
    // used to prevent.
    taskMenuTrace.skipped(task ? "not-live" : "no-task");
    writeTaskMenuNote({
      feedback: taskMenuFeedback,
      busy: taskMenuBusy,
      contextLocked: false,
      contextLabel: null,
      agentLocked: false,
      agentRunning: false,
      uncertain: false,
      agentUnavailable: null,
      lifecycle: task?.lifecycle ?? "",
    });
    return;
  }

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
  // Whatever rebuilt this menu — a render, a reopen after an unowned shell
  // action, a task state push — the owner's own text goes back before
  // anything below reads the fields, so the assignment is built from it.
  const heldDraft = taskAgentDraft.restore(task.taskId);
  if (heldDraft) writeAgentDraftFields(heldDraft);
  // A background event updated readiness while this was being written. The
  // owner gets a way to Settings rather than being sent there.
  const returnAction = required<HTMLButtonElement>("#task-menu-return");
  returnAction.hidden = !taskMenuReturnOffered;
  // Whatever rebuilt this menu — a render, a reopen after an unowned shell
  // action, a task state push — the owner's own text goes back before
  // anything below reads the fields, so the assignment is built from it.
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
  // The note says this too; the controls carry it as well so a pointer that
  // rests on one gets the same answer the note is already giving.
  const busyReason = taskMenuBusy ? TASK_MENU_BUSY_NOTE : null;
  name.disabled = busyReason !== null;
  pin.disabled = busyReason !== null;
  // Rename carries one more condition than the other two: the handler
  // refuses a task it cannot rename, and used to refuse it in silence.
  const renameReason = taskRenamePrerequisite({
    busy: taskMenuBusy,
    provider: task.provider,
    label: name.value,
  });
  rename.disabled = renameReason !== null;
  rename.title = renameReason ?? "Rename this task";
  for (const control of [name, pin]) {
    if (busyReason !== null) control.title = busyReason;
    else control.removeAttribute("title");
  }
  const cancelReason = taskCancelPrerequisite({
    busy: taskMenuBusy,
    contextLocked,
    agentRunning,
    agentLocked,
    lifecycle: task.lifecycle,
  });
  cancel.disabled = cancelReason !== null;
  cancel.title = cancelReason ?? "Ask the provider to stop this task";
  const closeReason = taskClosePrerequisite({
    busy: taskMenuBusy,
    agentLocked,
  });
  close.disabled = closeReason !== null;
  close.title = closeReason ?? "Remove this local task and its window";
  // Never a chooser: it holds exactly one option in both branches above, so
  // present it as the fixed value it is and say why it is fixed. Its own
  // value is still what the assignment reads.
  workspace.disabled = true;
  workspace.title = agentWorkspaceFixedReason(readiness.ready);
  // Five fields, one condition, and until now no sentence on any of them.
  const agentFieldReason = agentFieldPrerequisite({
    busy: taskMenuBusy,
    agentLocked,
    workspaceReason: readiness.ready ? null : readiness.reason,
  });
  for (const field of [scopeMode, subtree, paths, exclusions, objective]) {
    field.disabled = agentFieldReason !== null;
    if (agentFieldReason !== null) field.title = agentFieldReason;
    else field.removeAttribute("title");
  }
  // The flag and the reason from one function. The panel's tone, label and
  // detail come from the assignment's phase alone, so nothing here used to
  // say why the action was unavailable for any other reason.
  const agentPrerequisite = agentActionPrerequisite({
    busy: taskMenuBusy,
    workspaceReason: readiness.ready ? null : readiness.reason,
    uncertain,
    contextLocked,
    needsRejoin,
    objective: objective.value,
    scopeValid: scopeSelection !== null,
  });
  runAgent.disabled = agentPrerequisite !== null;
  if (agentPrerequisite !== null) runAgent.title = agentPrerequisite;
  else runAgent.removeAttribute("title");
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

  writeTaskMenuNote({
    feedback: taskMenuFeedback,
    busy: taskMenuBusy,
    contextLocked,
    contextLabel: context?.label ?? null,
    agentLocked,
    agentRunning,
    uncertain,
    // Only for a task that actually has an Agent assignment: an ordinary
    // task must not be told about a workspace its menu never offered.
    agentUnavailable:
      task.agent !== null && !readiness.ready ? readiness.reason : null,
    lifecycle: task.lifecycle,
  });
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
  // The flag and the sentence from one function: three conditions disabled
  // this control and the summary named only the first of them.
  const approvePrerequisite = approveToolPrerequisite({
    hasWaitingTask: waitingTask !== null,
    runtimeReady: bootstrap.runtimeState === "ready",
    surfaceFailed:
      waitingTask !== null &&
      taskSurfaceStatuses.get(waitingTask.taskId)?.state === "failed",
  });
  button.disabled = approvePrerequisite !== null;
  if (approvePrerequisite !== null) button.title = approvePrerequisite;
  else button.removeAttribute("title");
  required("#computer-summary").textContent =
    approvePrerequisite ?? "One task is waiting for your bounded approval.";
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
  required<HTMLElement>("#activity-setup-note").hidden =
    bootstrap.environment !== "dev";
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
      task.textContent =
        record.kind === "setup.check"
          ? "Setup"
          : taskLabel(taskById(record.taskId));
      const message = document.createElement("b");
      message.textContent =
        record.kind === "setup.check"
          ? record.operation === "connector.verify-app"
            ? "ChatGPT end-to-end check"
            : "Connection check"
          : (activityLabels[record.kind] ?? "Lifecycle event");
      const phase = document.createElement("span");
      phase.textContent =
        record.sequence === null
          ? `${phaseLabels[record.phase] ?? "Updated"}${record.kind === "setup.check" && record.code ? ` · ${record.code}` : ""}`
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

// Discovery runs at most once per session per surface (until a fresh scan is
// explicitly requested). Setup may request it when a step is shown, and the
// unfinished DEV journey requests the tunnel scan from Connections. Both go
// through queueMicrotask so an async configureProduct call never starts
// mid-render.
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
    const automatic = document.createElement("p");
    automatic.className = "discovery-empty";
    automatic.textContent =
      advancedKey === "hosts"
        ? `Farol found ${offered.length === 1 ? "a trusted local Codex candidate" : `${offered.length} trusted local Codex candidates`}. Open Advanced to select and verify one.`
        : `Farol found ${offered.length === 1 ? "a trusted local candidate" : `${offered.length} trusted local candidates`}, but none passed the full compatibility probe automatically. Open Advanced only if you need to inspect or override discovery.`;
    panel.append(automatic);
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

  if (offered.length > 0) {
    advanced.append(
      ...offered.map((candidate) => candidateCard(candidate, "offer")),
    );
  }

  if (needsChoice.length > 0) {
    const warning = document.createElement("p");
    warning.className = "discovery-warning";
    warning.textContent =
      advancedKey === "connect"
        ? "This file does not match the reviewed tunnel-client digest. Only continue if you placed it yourself and intend to override automatic discovery."
        : "Not signed by OpenAI, or the signature could not be confirmed. Only continue if you placed this file yourself.";
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
  const sharedPanelFeedback = visibleSurface !== "setup" && surface !== "setup";
  feedback.textContent =
    configured.status === "error"
      ? `Settings unavailable · ${configured.error}`
      : visibleSurface === surface || sharedPanelFeedback
        ? settingsFeedback
        : "";
  feedback.classList.toggle(
    "error",
    configured.status === "error" ||
      ((visibleSurface === surface || sharedPanelFeedback) &&
        settingsFeedbackError),
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
  // Farol Dev starts unfinished onboarding on this real Connections page,
  // not inside the modal wizard. Keep its fixed-location dependency checks
  // just as automatic here: only exact reviewed/signed candidates are
  // probed, and each discovery runs at most once per renderer session.
  if (bootstrap.environment === "dev") {
    if (settings.connectors.secureMcp.tunnelClient === null) {
      ensureDiscovery("connect");
    }
  }
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
  commandTitle.textContent = "Computer commands";
  commandDetail.textContent =
    settings.computer.commands === "workspace"
      ? "Sandboxed workspace shell · no network · Git history and user settings require separate folder approval"
      : settings.computer.commands === "verification"
        ? "Fixed Git status and HEAD · Apple Git · no network · bounded output"
        : "Off · no command authority is granted";
  commandCopy.append(commandTitle, commandDetail);
  const commandMode = document.createElement("select");
  commandMode.setAttribute("aria-label", "Computer command authority");
  for (const [value, label] of [
    ["none", "Off"],
    ["verification", "Fixed verification"],
    ["workspace", "Workspace shell"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    commandMode.append(option);
  }
  commandMode.value = settings.computer.commands;
  const updateCommands = document.createElement("button");
  updateCommands.type = "button";
  updateCommands.textContent = "Apply";
  updateCommands.addEventListener("click", () => {
    const commands = commandMode.value;
    if (
      commands !== "none" &&
      commands !== "verification" &&
      commands !== "workspace"
    )
      return;
    const witness =
      settings.setup.computer.verified?.workspaceId ??
      settings.computer.workspaces[0]?.workspaceId;
    if (guidedSetupSelected(bootstrap) && guidedOnboarding && witness) {
      selectSection("computer");
      guidedOnboarding.requestWorkspaceAccess({
        workspaceId: witness,
        commands,
      });
      return;
    }
    void configureProduct(
      { kind: "computer.update-commands", commands },
      commands === "none"
        ? "Command authority removed."
        : "Command authority changed. Verify the workspace again before use.",
    );
  });
  commandRow.append(commandCopy, commandMode, updateCommands);
  commandPolicy.replaceChildren(commandRow);

  const computerState = settings.setup.computer;
  // The workspace card below says "not verified · Verify folder" for exactly
  // this data once the verification has been outgrown. This badge used to
  // read the raw record and keep saying Verified beside it.
  const computerStale = setupStepStale(settings, "computer");
  computerReadiness.textContent = readinessLabel(computerState, {
    stale: computerStale,
  });
  computerReadiness.classList.toggle(
    "verified",
    computerState.verified !== null && !computerStale,
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
        if (guidedSetupSelected(bootstrap) && guidedOnboarding) {
          selectSection("computer");
          guidedOnboarding.requestWorkspaceAccess({
            workspaceId: workspace.workspaceId,
          });
          return;
        }
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
        if (guidedSetupSelected(bootstrap) && guidedOnboarding) {
          selectSection("computer");
          guidedOnboarding.requestWorkspaceAccess({
            workspaceId: workspace.workspaceId,
            access,
            ...(access === "read" ? { gitHistoryApproved: false } : {}),
          });
          return;
        }
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
        if (guidedSetupSelected(bootstrap) && guidedOnboarding) {
          selectSection("computer");
          guidedOnboarding.requestFolderRemoval(workspace.workspaceId);
          return;
        }
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
      const gitDisclosure = document.createElement("p");
      gitDisclosure.textContent =
        "Full Git access includes .git/config, refs, objects, hooks, linked-worktree metadata, ~/.gitconfig (including an owner-owned symlink target inside HOME), and ~/.config/git with includes and hooks. These can contain credentials or past versions of excluded files. Approve only if these Git settings and this repository's complete metadata may be shared with the connected ChatGPT service. Verify the folder again after changing this approval.";
      policy.append(gitDisclosure);
      const gitHistory = document.createElement("button");
      gitHistory.type = "button";
      gitHistory.textContent = workspace.gitHistoryApproved
        ? "Revoke full Git and user settings"
        : "Approve full Git and user settings";
      gitHistory.disabled =
        !guidedSetupSelected(bootstrap) &&
        !workspace.gitHistoryApproved &&
        (!verified || settings.computer.commands !== "workspace");
      gitHistory.title = workspace.gitHistoryApproved
        ? "Remove shell access to this repository's Git metadata and user Git settings"
        : "Allow shell access to complete Git metadata and user Git settings after verifying this folder and reviewing the disclosure above.";
      gitHistory.addEventListener("click", () => {
        if (guidedSetupSelected(bootstrap) && guidedOnboarding) {
          selectSection("computer");
          guidedOnboarding.requestWorkspaceAccess(
            workspace.gitHistoryApproved
              ? {
                  workspaceId: workspace.workspaceId,
                  gitHistoryApproved: false,
                }
              : {
                  workspaceId: workspace.workspaceId,
                  commands: "workspace",
                  gitHistoryApproved: true,
                },
          );
          return;
        }
        void configureProduct(
          {
            kind: "computer.update-git-history",
            workspaceId: workspace.workspaceId,
            approved: !workspace.gitHistoryApproved,
          },
          `${workspace.label} Git history authority changed. Verify the folder again.`,
        );
      });
      policy.append(gitHistory);
      card.append(row, policy);

      const query = document.createElement("div");
      query.className = "workspace-query";
      const listRoot = document.createElement("button");
      listRoot.type = "button";
      listRoot.textContent = "List root";
      const listRootReason = workspaceReadPrerequisite(verified, false);
      listRoot.disabled = listRootReason !== null;
      listRoot.title =
        listRootReason ?? "List the visible entries at this workspace root";
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
      if (!verified) searchInput.title = "Verify this workspace again first.";
      searchLabel.append(searchInput);
      const search = document.createElement("button");
      search.type = "button";
      search.textContent = "Search";
      // One predicate for the state and the reason, as its "Git status"
      // neighbour already does.
      const updateSearchState = () => {
        const reason = workspaceSearchPrerequisite(verified, searchInput.value);
        search.disabled = reason !== null;
        search.title =
          reason ?? "Search this workspace for an exact text pattern";
      };
      updateSearchState();
      searchInput.addEventListener("input", updateSearchState);
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
      gitStatus.disabled = !verified || settings.computer.commands === "none";
      gitStatus.title =
        settings.computer.commands === "none"
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
      gitHead.disabled = !verified || settings.computer.commands === "none";
      gitHead.title =
        settings.computer.commands === "none"
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
        const editReason = workspaceReadPrerequisite(
          verified,
          pendingEdit !== null,
        );
        edit.disabled = editReason !== null;
        edit.title =
          editReason ??
          "Choose a text file, review an exact replacement, then apply it once";
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
          const updateApplyState = () => {
            const reason = guardedEditApplyPrerequisite(
              oldText.value,
              newText.value,
            );
            apply.disabled = reason !== null;
            apply.title =
              reason ?? "Apply this exact replacement once, to this file";
          };
          updateApplyState();
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

// How many acknowledgements this window has been asked to send. Only the
// E2E hold below reads it; production never arms that hold.
let workspaceEditAcksAttempted = 0;

// Clears the undelivered-result record of one guarded edit after its outcome
// was shown.  A lost reply leaves the record, and the edit stays observable.
async function acknowledgeWorkspaceEdit(operationId: string): Promise<void> {
  // E2E only: acknowledgement loss, which is a different scenario from a
  // lost result. The edit ran, its result reached this window and was
  // rendered; what never happens is this send, so the product's own durable
  // pending record stays exactly as it wrote it. Returning before the send
  // is the whole seam — nothing below is reordered, and no state is
  // fabricated.
  const ackHold = bootstrap.e2eWorkspaceEditAckHold;
  if (ackHold !== null) {
    workspaceEditAcksAttempted += 1;
    if (workspaceEditAcksAttempted > ackHold) {
      console.debug("farol-next-e2e:ack-held", operationId);
      return;
    }
  }
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

function devMcpProofFailureMessage(code: string): string | null {
  switch (code) {
    case "DEV_MCP_PROOF_DEV_ONLY":
      return "The real MCP proof is available only in the isolated Farol Dev environment.";
    case "DEV_MCP_PROOF_CONNECTOR_MUST_STOP":
      return "Stop the DEV connector before preparing a fresh synthetic grant.";
    case "DEV_MCP_PROOF_NOT_PREPARED":
      return "Prepare the private synthetic fixture first.";
    case "DEV_MCP_PROOF_CONNECTOR_NOT_READY":
      return "Start the DEV connector, attach @Farol Dev in ChatGPT, and verify the attachment before the live proof.";
    case "DEV_MCP_PROOF_STALE":
      return "The proof belongs to an older build, Computer generation, or prior live attempt. Stop the connector and prepare a fresh fixture.";
    case "DEV_MCP_PROOF_CHATGPT_FAILED":
      return "The live ChatGPT proof did not complete. Inspect the owned ChatGPT task before preparing any fresh attempt; nothing was retried.";
    case "DEV_MCP_PROOF_ANSWER_MISMATCH":
      return "ChatGPT replied, but its exact answer did not match the private sentinel. The proof failed and was not retried.";
    case "DEV_MCP_PROOF_RECEIPT_MISSING":
      return "The reply arrived without both correlated Computer MCP receipts. The proof failed.";
    case "DEV_MCP_PROOF_RECEIPT_INVALID":
      return "The Computer MCP receipt did not match this DEV build, generation, exact read, and outside-grant refusal.";
    case "DEV_MCP_PROOF_PREPARE_FAILED":
      return "Farol Dev could not create and verify the private synthetic fixture.";
    default:
      return null;
  }
}

function connectorAppVerificationFailureMessage(code: string): string {
  const preSubmit = chatGptPreSubmitRemedy(code);
  if (preSubmit) return preSubmit;
  switch (code) {
    case "CONNECTOR_APP_VERIFICATION_NOT_READY":
      return "Sign in, verify a folder, and activate this DEV tunnel before verifying the app.";
    case "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED":
    case "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN":
      return "This check may have been sent. Inspect the existing ChatGPT conversation and Advanced receipt before deliberately starting a fresh challenge; Farol did not resend it.";
    case "CONNECTOR_APP_VERIFICATION_BEFORE_SUBMIT_FAILED":
      return "The check stopped before a confirmed send. Inspect the ChatGPT window before trying again.";
    case "CONNECTOR_APP_VERIFICATION_STATE_CHANGED":
      return "The folder or tunnel changed during verification. Inspect Advanced before starting a new challenge.";
    case "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE":
      return "Farol could not safely record this one-time check. No verified result was accepted.";
    default:
      return `App verification failed: ${code}`;
  }
}

async function configureProduct(
  command: ProductConfigurationCommand,
  successMessage: string,
  onEvidence?: (evidence: ProductConfigurationEvidence | undefined) => void,
  onOutcome?: (outcome: "applied" | "refused" | "unknown") => void,
): Promise<boolean> {
  if (
    guidedOnboarding?.hasUnconfirmedWorkspaceChange() &&
    (command.kind.startsWith("computer.") ||
      command.kind.startsWith("connector."))
  ) {
    onOutcome?.("unknown");
    settingsFeedback =
      "Read the existing access change from Folders before changing its scope. Nothing was repeated.";
    settingsFeedbackError = true;
    render();
    return false;
  }
  const configurationRequest = configurationRequestOrder.begin();
  const checkOperation = setupCheckOperation(command);
  const checkRunId = checkOperation
    ? setupCheckHistory.start(checkOperation)
    : null;
  if (checkOperation && checkRunId) {
    activity.record(setupCheckHistory.entries().at(-1)!);
  }
  if (command.kind === "chatgpt.open-sign-in") {
    connectionCheckFeedback = null;
    connectionCheckTone = null;
  } else if (command.kind === "connector.verify-app") {
    connectionCheckFeedback = "Running the ChatGPT end-to-end check…";
    connectionCheckTone = "running";
  }
  // While Setup is open it is the only visible surface — a failure or
  // success routed to the Computer or Settings panel behind a modal dialog
  // would never be seen (UX34-09: the step being worked on must always show
  // its own pending/success/failure state, not rely on Activity or a
  // panel the dialog is covering).
  settingsFeedbackSurface = setupJourney.open
    ? "setup"
    : command.kind.startsWith("computer.") ||
        command.kind.startsWith("dev-proof.")
      ? "computer"
      : "settings";
  if (
    command.kind === "computer.verify-workspace" ||
    command.kind === "computer.list-workspace" ||
    command.kind === "computer.search-workspace" ||
    command.kind === "computer.run-git-status" ||
    command.kind === "computer.prepare-workspace-edit" ||
    command.kind === "computer.update-access" ||
    command.kind === "computer.update-git-history" ||
    command.kind === "computer.update-commands" ||
    command.kind === "computer.update-exclusions" ||
    command.kind === "computer.remove-workspace"
  ) {
    workspaceEvidence = null;
  }
  settingsFeedback =
    command.kind === "support.export"
      ? "Preparing a content-free support export…"
      : command.kind === "dev-proof.prepare"
        ? "Creating a fresh private sentinel fixture and verifying its local read-only grant…"
        : command.kind === "dev-proof.run"
          ? "Running one owner-triggered @Farol Dev ChatGPT proof with no retry…"
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
                              : command.kind ===
                                  "chatgpt.prepare-attachment-task"
                                ? "Validating and privately staging the selected attachments…"
                                : command.kind ===
                                    "chatgpt.submit-attachment-task"
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
  const supersededFeedback = configurationRequestOrder.isLatest(
    configurationRequest,
  )
    ? null
    : {
        message: settingsFeedback,
        error: settingsFeedbackError,
        surface: settingsFeedbackSurface,
      };
  const renderOutcome = (): void => {
    if (supersededFeedback) {
      settingsFeedback = supersededFeedback.message;
      settingsFeedbackError = supersededFeedback.error;
      settingsFeedbackSurface = supersededFeedback.surface;
    }
    render();
  };
  const editToAcknowledge = workspaceEditToAcknowledge(command, outcome);
  if (editToAcknowledge) {
    queueMicrotask(() => {
      void acknowledgeWorkspaceEdit(editToAcknowledge);
    });
  }
  if (outcome.kind === "unconfirmed") {
    onOutcome?.("unknown");
    if (checkOperation && checkRunId)
      recordSetupCheck(checkOperation, "outcome_unknown", checkRunId);
    // Neither a malformed reply nor a lost promise proves the command was
    // not applied, so this must not claim "nothing was applied" — see
    // UNCONFIRMED_CONFIGURATION_MESSAGE. No snapshot is adopted either.
    settingsFeedback = UNCONFIRMED_CONFIGURATION_MESSAGE;
    settingsFeedbackError = true;
    if (command.kind === "connector.verify-app")
      connectionCheckFeedback =
        "Check outcome unknown. Return to Setup for the existing result.";
    if (command.kind === "connector.verify-app") connectionCheckTone = "failed";
    renderOutcome();
    return false;
  }
  const parsed = outcome.result;
  if (
    shouldAdoptConfigurationSnapshot(bootstrap.configuration, parsed.snapshot)
  ) {
    bootstrap = { ...bootstrap, configuration: parsed.snapshot };
    renderedGeneralSettingsRevision = -1;
    renderedComputerSettingsRevision = -1;
  }
  if (!parsed.ok) {
    onOutcome?.(configurationEffectOutcome(outcome));
    if (checkOperation && checkRunId)
      recordSetupCheck(checkOperation, "failed", checkRunId, parsed.error);
    if (
      command.kind === "chatgpt.submit-readonly-task" ||
      command.kind === "chatgpt.cancel-readonly-task" ||
      command.kind === "chatgpt.submit-attachment-task" ||
      command.kind === "chatgpt.cancel-attachment-task"
    ) {
      pendingChatGptPreview = null;
      if (shellOverlay === "context-preview") setShellOverlay("none");
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
    settingsFeedback =
      command.kind === "connector.verify-app"
        ? connectorAppVerificationFailureMessage(parsed.error)
        : cancellation
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
                        ? "Stop the connector before changing Computer, host, or task-route authority."
                        : parsed.error === "CONNECTOR_STOP_UNCONFIRMED"
                          ? "The connector did not confirm process exit. Its task grant may still be active; route changes remain blocked. Inspect the owned connector before retrying."
                          : parsed.error === "WORKSPACE_MUTATION_RESULT_PENDING"
                            ? "The last guarded edit has no delivered result yet. Check its result first."
                            : parsed.error === "WORKSPACE_MUTATION_NOT_ADMITTED"
                              ? "The last guarded edit was never admitted, so nothing was changed."
                              : parsed.error ===
                                  "WORKSPACE_MUTATION_NOT_PENDING"
                                ? "There is no undelivered edit result to check."
                                : parsed.error ===
                                    "WORKSPACE_NOT_GIT_REPOSITORY"
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
                                                          "ROUTE_B_CHECK_TOOL_USED"
                                                        ? "Route B's basic model check invoked a host tool, so the result was refused. Recheck the isolated Codex host before trying again."
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
                                                                    "CODEX_TASK_ROUTE_REFUSED"
                                                                  ? "The saved project, verified workspace, and Git identity did not match exactly. No task route was saved."
                                                                  : parsed.error ===
                                                                      "CODEX_TASK_ROUTE_UNAVAILABLE"
                                                                    ? "The selected shared Codex socket could not be verified. Computer remains available; no model turn was started."
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
                                                                                          : (devMcpProofFailureMessage(
                                                                                              parsed.error,
                                                                                            ) ??
                                                                                            transitionRefusalMessage(
                                                                                              parsed.error,
                                                                                            ) ??
                                                                                            workspaceEditRefusalMessage(
                                                                                              parsed.error,
                                                                                            ) ??
                                                                                            sharedCodexSocketRefusalMessage(
                                                                                              parsed.error,
                                                                                            ) ??
                                                                                            `Not applied · ${parsed.error}`);
    settingsFeedbackError =
      !cancellation && parsed.error !== "CODEX_AGENT_STILL_RUNNING";
    if (command.kind === "connector.verify-app") {
      connectionCheckFeedback = settingsFeedback;
      connectionCheckTone = "failed";
    }
    renderOutcome();
    return false;
  }
  const evidence = parsed.evidence;
  if (!supersededFeedback) onEvidence?.(evidence);
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
  } else if (evidence?.kind === "host.task-models") {
    const revision = configurationEvidenceRevision(
      bootstrap.configuration,
      parsed.snapshot,
      configurationRequestOrder.isLatest(configurationRequest),
    );
    if (revision !== null)
      taskModelCatalogue = { revision, view: evidence.view };
    evidenceError = evidence.view.catalogue.status !== "ready";
    settingsFeedback = evidenceError
      ? "Model catalogue unavailable. No task was started; configured models were not changed."
      : "Runtime model catalogue refreshed. Availability is not a quota guarantee.";
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
  } else if (evidence?.kind === "dev-proof.prepared") {
    devProofEvidence = evidence;
    settingsFeedback =
      "Private DEV fixture prepared and verified locally. Start the connector again, attach @Farol Dev in ChatGPT, then run the real proof.";
  } else if (evidence?.kind === "dev-proof.verified") {
    devProofEvidence = evidence;
    settingsFeedback = `Farol Dev MCP proof verified · exact answer ${evidence.answerSha256.slice(0, 12)} · outside-grant refusal ${evidence.outsideGrantError} · receipt ${evidence.receiptSha256.slice(0, 12)}.`;
  } else if (evidence?.kind === "chatgpt.readonly-task-preview") {
    pendingChatGptPreview = evidence;
    setShellOverlay("context-preview");
    settingsFeedback = `Review ${evidence.relativePath} before sending it once.`;
  } else if (evidence?.kind === "chatgpt.attachment-task-preview") {
    pendingChatGptPreview = evidence;
    setShellOverlay("context-preview");
    settingsFeedback = `Review ${evidence.attachments.length} staged attachment${evidence.attachments.length === 1 ? "" : "s"} before sending once.`;
  } else if (evidence?.kind === "chatgpt.readonly-task") {
    pendingChatGptPreview = null;
    if (shellOverlay === "context-preview") setShellOverlay("none");
    evidenceError = evidence.state !== "completed";
    settingsFeedback =
      evidence.state === "completed"
        ? `Read-only task completed from ${evidence.relativePath} after ${evidence.deltaCount} incremental update${evidence.deltaCount === 1 ? "" : "s"}. File and answer text were not persisted${evidence.redelivered ? "; result receipt redelivered" : ""}. Conversation continuity: ${evidence.conversationContinuity.replace("_", " ")}.`
        : evidence.state === "outcome_unknown"
          ? `Outcome unknown · ${evidence.code ?? "CHATGPT_TASK_ERROR"}. Inspect the isolated ChatGPT window before another task.`
          : evidence.state === "not_authenticated"
            ? "The isolated ChatGPT session needs sign-in before this task can start."
            : (chatGptPreSubmitRemedy(evidence.code) ??
              `Task not submitted · ${evidence.code ?? "CHATGPT_TASK_ERROR"}.`);
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
    if (shellOverlay === "context-preview") setShellOverlay("none");
    evidenceError = evidence.state !== "completed";
    settingsFeedback =
      evidence.state === "completed"
        ? `${evidence.attachmentCount} attachment${evidence.attachmentCount === 1 ? "" : "s"} delivered intact · ${evidence.deltaCount} incremental update${evidence.deltaCount === 1 ? "" : "s"} · staging ${evidence.stagingCleanup === "removed" ? "removed" : "awaiting startup cleanup"}${evidence.redelivered ? " · result receipt redelivered" : ""} · conversation ${evidence.conversationContinuity.replace("_", " ")}.`
        : evidence.state === "outcome_unknown"
          ? `Attachment task outcome unknown · ${evidence.code ?? "CHATGPT_TASK_ERROR"}. Inspect the isolated ChatGPT window before another task.`
          : evidence.state === "not_authenticated"
            ? "The isolated ChatGPT session needs sign-in before attachments can be sent."
            : (chatGptPreSubmitRemedy(evidence.code) ??
              `Attachments not submitted · ${evidence.code ?? "CHATGPT_TASK_ERROR"}.`);
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
  if (command.kind === "connector.verify-app") {
    connectionCheckFeedback =
      "End-to-end check passed. Read the reply, then return to Setup.";
    connectionCheckTone = "complete";
  }
  if (command.kind === "chatgpt.cancel-readonly-task") {
    pendingChatGptPreview = null;
    if (shellOverlay === "context-preview") setShellOverlay("none");
  }
  if (command.kind === "chatgpt.cancel-attachment-task") {
    pendingChatGptPreview = null;
    if (shellOverlay === "context-preview") setShellOverlay("none");
  }
  if (command.kind === "computer.cancel-workspace-edit") {
    workspaceEvidence = null;
  }
  if (command.kind === "chatgpt.open-sign-in") {
    chatGptSignInOpened = true;
  }
  settingsFeedbackError = evidenceError;
  if (checkOperation && checkRunId)
    recordSetupCheck(
      checkOperation,
      evidenceError ? "failed" : "completed",
      checkRunId,
    );
  if (
    command.kind === "general.update" &&
    bootstrap.configuration.status === "ready"
  ) {
    sidebarPreference = bootstrap.configuration.settings.general.sidebarDefault;
  }
  renderOutcome();
  if (taskResultToAcknowledge) {
    queueMicrotask(() => {
      void acknowledgeChatGptTaskResult(taskResultToAcknowledge);
    });
  }
  onOutcome?.("applied");
  return true;
}

// Read the existing native bootstrap snapshot without changing sign-in mode,
// probing the browser, or replaying any configuration action.
async function refreshSettingsAfterReturn(): Promise<boolean> {
  try {
    const incoming = bootstrapSchema.safeParse(
      await window.farolNext.bootstrap(),
    );
    if (
      incoming.success &&
      incoming.data.build.buildId === bootstrap.build.buildId &&
      incoming.data.configuration.status === "ready" &&
      shouldAdoptConfigurationSnapshot(
        bootstrap.configuration,
        incoming.data.configuration,
      )
    ) {
      bootstrap = { ...bootstrap, configuration: incoming.data.configuration };
      renderedGeneralSettingsRevision = -1;
      renderedComputerSettingsRevision = -1;
      render();
      return true;
    }
  } catch {
    // A failed read leaves an unconfirmed action fenced.
  }
  return false;
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

function renderSettingsNavigation(): void {
  const enabled = guidedSetupSelected(bootstrap);
  required<HTMLElement>("#settings-description").textContent =
    enabled && bootstrap.environment === "dev"
      ? "Preferences are saved in this Farol Dev profile."
      : "Changes are saved to Farol Next state only and read back before they are shown as applied.";
  required<HTMLElement>("#settings-nav").hidden =
    !enabled || section !== "settings" || setupJourney.open;
  document
    .querySelectorAll<HTMLButtonElement>("#settings-nav button")
    .forEach((button) => {
      button.hidden =
        button.dataset.settingsCategory === "shortcuts" &&
        bootstrap.environment !== "dev";
      if (enabled && button.dataset.settingsCategory === settingsCategory)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  required<HTMLElement>('[data-panel="settings"]')
    .querySelectorAll<HTMLElement>(
      ":scope > .settings-group, :scope > #connection-diagnostics",
    )
    .forEach((group) => {
      group.hidden = enabled
        ? (group.dataset.settingsPage ?? "preferences") !== settingsCategory
        : group.dataset.settingsPage === "shortcuts";
    });
  if (enabled && settingsCategory === "diagnostics") {
    required<HTMLDetailsElement>("#diagnostics-group").open = true;
  }
}

function shortcutSelects(): HTMLSelectElement[] {
  return [
    ...document.querySelectorAll<HTMLSelectElement>(
      ".settings-shortcuts [data-shortcut-section]",
    ),
  ];
}

function setShortcutDraft(shortcuts: NavigationShortcuts): void {
  required<HTMLSelectElement>("#setting-sidebar-shortcut").value =
    shortcuts.sidebar;
  if (guidedSetupSelected(bootstrap) && bootstrap.environment === "preview") {
    // Preview keeps its existing diagnostic commands and presentation. Moving
    // this panel leaves the sidebar Setup as the sole primary journey.
    required('[data-panel="settings"]').append(
      required("#connection-diagnostics"),
    );
  }
  for (const select of shortcutSelects()) {
    const section = select.dataset.shortcutSection as keyof NavigationShortcuts;
    select.value = String(shortcuts[section]);
  }
}

let shortcutSaveBusy = false;
async function applyShortcutDraft(): Promise<void> {
  if (shortcutSaveBusy) return;
  const values = Object.fromEntries(
    shortcutSelects().map((select) => [
      select.dataset.shortcutSection,
      Number(select.value),
    ]),
  );
  values.sidebar = required<HTMLSelectElement>(
    "#setting-sidebar-shortcut",
  ).value;
  const parsed = parseNavigationShortcuts(values);
  const feedback = required<HTMLElement>("#shortcut-feedback");
  if (!parsed) {
    feedback.textContent =
      "Give each section a different ⌘ number, or choose Off.";
    feedback.dataset.state = "error";
    return;
  }
  let previous: string | null;
  try {
    previous = localStorage.getItem(navigationShortcutStorageKey);
    localStorage.setItem(navigationShortcutStorageKey, JSON.stringify(parsed));
  } catch {
    feedback.textContent = "Shortcuts could not be saved in this profile.";
    feedback.dataset.state = "error";
    return;
  }
  shortcutSaveBusy = true;
  let applied: unknown;
  try {
    applied = await window.farolNext.setNavigationShortcuts(parsed);
  } catch {
    shortcutSaveBusy = false;
    feedback.textContent =
      "Saved for the next launch, but the active shortcut change was not confirmed. Restart Farol Dev before relying on it.";
    feedback.dataset.state = "error";
    return;
  }
  shortcutSaveBusy = false;
  if (
    typeof applied !== "object" ||
    applied === null ||
    !("ok" in applied) ||
    applied.ok !== true
  ) {
    try {
      if (previous === null)
        localStorage.removeItem(navigationShortcutStorageKey);
      else localStorage.setItem(navigationShortcutStorageKey, previous);
    } catch {
      // The next launch will re-validate the saved value before activation.
    }
    feedback.textContent =
      "The shortcut change was refused. Review your choices.";
    feedback.dataset.state = "error";
    return;
  }
  navigationShortcuts = parsed;
  feedback.textContent = "Shortcuts saved for this Farol profile.";
  feedback.dataset.state = "ready";
  render();
}

function renderSettings(): void {
  renderSettingsNavigation();
  const configured = bootstrap.configuration;
  const values = [
    [
      "Configuration",
      configured.status === "error" &&
      configured.error === "CONFIG_RENAME_REQUIRED"
        ? "Quit every Farol preview, then rename product-settings.json to config.json in the same preview state folder. Do not overwrite an existing config.json; resolve that conflict first. No settings were reset."
        : "config.json · tasks.harnesses contains model policy",
    ],
    [
      "Application",
      `${displayProductName} · ${displayEdition} · ${bootstrap.applicationId}`,
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
  const connectionsSummary = required<HTMLParagraphElement>(
    "#settings-connections-summary",
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
    connectionsSummary.textContent =
      "Connection readiness is unavailable while settings are invalid.";
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
  // The workspace card below says "not verified · Verify folder" for exactly
  // this data once the verification has been outgrown. This badge used to
  // read the raw record and keep saying Verified beside it.
  const computerStale = setupStepStale(settings, "computer");
  computerReadiness.textContent = readinessLabel(computerState, {
    stale: computerStale,
  });
  computerReadiness.classList.toggle(
    "verified",
    computerState.verified !== null && !computerStale,
  );
  const workspaceCount = settings.computer.workspaces.length;
  computerSummary.textContent = `${settings.computer.name} · ${workspaceCount} approved ${workspaceCount === 1 ? "workspace" : "workspaces"} · ${readinessDetail(computerState, { stale: computerStale })}`;

  const connectionStates: readonly [string, Readiness][] = [
    ["ChatGPT", settings.setup.chatgpt],
    ["Computer", settings.setup.computer],
    ["Connection", settings.setup.connect],
    ["Native hosts", settings.setup.hosts],
    ["Native Agent", settings.setup.verify],
  ];
  const devLocalHostReady =
    bootstrap.environment === "dev" &&
    localHostContractVerified(settings.nativeHosts.codex);
  const persistedVerifiedConnectionCount = connectionStates.filter(
    ([, state]) => state.verified !== null && !state.outcomeUnknown,
  ).length;
  const verifiedConnectionCount =
    persistedVerifiedConnectionCount +
    (devLocalHostReady && settings.setup.hosts.verified === null ? 1 : 0);
  connectionsSummary.textContent = `${verifiedConnectionCount} of ${connectionStates.length} independent readiness checks currently have valid evidence. Open Connections for controls and remedies.`;
  const proofCard = required<HTMLElement>("#dev-proof-card");
  const proofSummary = required<HTMLElement>("#dev-proof-summary");
  const proofPrepare = required<HTMLButtonElement>("#dev-proof-prepare");
  const proofRun = required<HTMLButtonElement>("#dev-proof-run");
  proofCard.hidden = bootstrap.environment !== "dev";
  if (bootstrap.environment === "dev") {
    const connector = settings.connectors.secureMcp;
    const connectorRunning = connector.runtime !== null;
    const proofReady =
      connector.runtime?.state === "ready" && connector.attachment !== null;
    const currentDevProof =
      devProofEvidence !== null &&
      devProofEvidenceCurrent(devProofEvidence, {
        buildId: bootstrap.build.buildId,
        computerGeneration: settings.computer.generation,
        workspaceIds: settings.computer.workspaces.map(
          (workspace) => workspace.workspaceId,
        ),
        runtime: connector.runtime,
        attachment: connector.attachment,
      });
    proofPrepare.disabled = connectorRunning;
    proofPrepare.title = connectorRunning
      ? "Stop the DEV connector before changing its synthetic workspace grant"
      : "Create a fresh random app-owned fixture and verify its read-only grant locally";
    const proofAttemptReady =
      proofReady &&
      currentDevProof &&
      devProofEvidence?.kind === "dev-proof.prepared";
    proofRun.disabled = !proofAttemptReady;
    proofRun.title = proofAttemptReady
      ? "Owner-trigger one real @Farol Dev ChatGPT call; this uses a model turn and never retries"
      : devProofEvidence !== null && !currentDevProof
        ? "Stop the connector and prepare a fresh proof for the current build, workspace and runtime"
        : devProofEvidence?.kind === "dev-proof.verified"
          ? "This one-shot proof already completed; prepare a fresh fixture before another attempt"
          : "Start the connector, attach @Farol Dev, and verify the attachment first";
    proofSummary.textContent =
      devProofEvidence?.kind === "dev-proof.verified" && currentDevProof
        ? `Verified for DEV generation ${devProofEvidence.computerGeneration} · exact answer and ${devProofEvidence.outsideGrantError} refusal correlated. This does not qualify Test model or Agent.`
        : devProofEvidence !== null && !currentDevProof
          ? "Previous DEV proof evidence no longer matches the current build, workspace, Computer generation or connector runtime. Stop the connector and prepare a fresh fixture."
          : devProofEvidence?.kind === "dev-proof.prepared"
            ? `Fixture prepared for DEV generation ${devProofEvidence.computerGeneration}. Start the connector again, attach @Farol Dev, verify the attachment, then run the live proof.`
            : "Prepare an app-owned random fixture, start the DEV connector, attach @Farol Dev, then run one real ChatGPT read and one outside-grant refusal. No sentinel value is shown or placed in the prompt.";
  }
  // The task routes still share the central readiness functions. DEV's
  // Native-host row is intentionally narrower: a selected host already
  // carries a verified executable/App Server contract, while the merged
  // Agent route keeps its separate live-turn and lineage prerequisites.
  const routeStateForLabel = (label: string): RouteReadinessState => {
    switch (label) {
      case "ChatGPT":
        return chatGptRouteState();
      case "Computer":
        return computerRouteState();
      case "Connection":
        return connectRouteState();
      case "Native hosts":
        return bootstrap.environment === "dev"
          ? localHostRouteReadiness(
              localHostContractVerified(settings.nativeHosts.codex),
              settings.setup.hosts,
            )
          : agentRouteState();
      case "Native Agent":
        return agentRouteState();
      default:
        return "not-configured";
    }
  };
  connections.replaceChildren(
    ...connectionStates.map(([label, state]) => {
      const row = document.createElement("div");
      // The tone and the words come from the same state. They used to be
      // read from two different places: the merged, stale-aware route state
      // for the colour and the raw per-field record for the sentence.
      const rowState = routeStateForLabel(label);
      row.className = `connection-row route-${routeStatusClass(rowState)}`;
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      const devHostContractReady =
        bootstrap.environment === "dev" &&
        label === "Native hosts" &&
        localHostContractVerified(settings.nativeHosts.codex);
      title.textContent = devHostContractReady
        ? "Native hosts · Local host ready"
        : `${label} · ${routeRowLabel(rowState, state)}`;
      const detail = document.createElement("small");
      detail.textContent =
        label === "ChatGPT"
          ? `${routeRowDetail(rowState, state)} · Conversation: ${bootstrap.chatgptConversationState.replace("_", " ")}`
          : label === "Connection"
            ? `${routeRowDetail(rowState, state)} · ${settings.connectors.secureMcp.tunnelClient ? `tunnel-client ${settings.connectors.secureMcp.tunnelClient.version}` : "client not selected"} · tunnel ${settings.connectors.secureMcp.tunnelId ?? "not set"} · credential ${settings.connectors.secureMcp.credential} · runtime ${settings.connectors.secureMcp.runtime?.state ?? "stopped"}`
            : label === "Native hosts" && settings.nativeHosts.codex
              ? devHostContractReady
                ? `Codex ${settings.nativeHosts.codex.version} · ${settings.nativeHosts.codex.protocol} · local executable and App Server contract verified with zero model turns. Advanced host/tool and Agent checks remain separate.`
                : `${routeRowDetail(rowState, state)} · Codex ${settings.nativeHosts.codex.version} · ${settings.nativeHosts.codex.executablePath}`
              : label === "Native Agent" &&
                  settings.nativeHosts.codex?.agentVerification
                ? `${routeRowDetail(rowState, state)} · Main → Agent → Critic · one model turn · workspace enforcement ${settings.nativeHosts.codex.agentVerification.workspaceEnforcement === "verified" ? "verified" : "not verified"} · ${settings.nativeHosts.codex.agentVerification.verifiedAt}`
                : routeRowDetail(rowState, state);
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
            bootstrap.environment === "dev"
              ? "ChatGPT opened inside Farol Dev."
              : "Isolated ChatGPT window opened.",
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
        const routeFieldReason = connectorRoutePrerequisite(running, true);
        tunnel.disabled = routeFieldReason !== null;
        if (routeFieldReason !== null) tunnel.title = routeFieldReason;
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
        key.disabled = routeFieldReason !== null;
        if (routeFieldReason !== null) key.title = routeFieldReason;
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
        const saveReason = connectorRoutePrerequisite(
          running,
          connector.tunnelClient !== null,
        );
        save.disabled = saveReason !== null;
        save.title = saveReason ?? "Save this tunnel route and its runtime key";
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
          ? "Re-detect client"
          : "Detect client";
        const choosePrerequisite = connectorChoosePrerequisite(running);
        if (choosePrerequisite !== null) choose.title = choosePrerequisite;
        choose.disabled = running;
        choose.addEventListener("click", () => {
          void configureProduct(
            { kind: "connector.discover-client" },
            "Local tunnel-client detected and verified.",
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
        // One predicate for both the state and the reason, so they cannot
        // drift: the button is disabled exactly when there is a prerequisite
        // left to name, and it names that one.
        const startPrerequisite = connectorStartPrerequisite(
          connector,
          settings.computer.workspaces.length,
          attachmentCheckPending,
        );
        start.disabled = startPrerequisite !== null;
        if (startPrerequisite !== null) start.title = startPrerequisite;
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
        const stopPrerequisite = connectorStopPrerequisite(
          connector.runtime !== null,
        );
        stop.disabled = stopPrerequisite !== null;
        stop.title = stopPrerequisite ?? "Stop the connector runtime";
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
        choose.textContent = selected ? "Re-detect host" : "Detect host";
        choose.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.discover-codex" },
            "Local Codex host candidates detected. Choose one to verify.",
          );
        });
        const chooseFile = document.createElement("button");
        chooseFile.type = "button";
        chooseFile.textContent = "Choose host…";
        chooseFile.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.select-codex" },
            "Selected local Codex host contract verified.",
          );
        });
        const verify = document.createElement("button");
        verify.type = "button";
        verify.textContent = "Recheck host";
        const verifyPrerequisite = nativeHostActionPrerequisite(
          selected !== null,
          "recheck",
        );
        verify.disabled = verifyPrerequisite !== null;
        verify.title =
          verifyPrerequisite ?? "Recheck this Codex executable's contract";
        verify.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.verify-codex" },
            "Codex host rechecked.",
          );
        });
        const live = document.createElement("button");
        live.type = "button";
        live.textContent =
          bootstrap.environment === "dev"
            ? selected?.liveVerification
              ? "Repeat Agent prerequisite"
              : "Run Agent prerequisite"
            : selected?.liveVerification
              ? "Run live check again"
              : "Run live check";
        live.disabled = selected === null || state.outcomeUnknown;
        live.title = state.outcomeUnknown
          ? "Recheck the host contract before deliberately running another live turn"
          : bootstrap.environment === "dev"
            ? "Advanced only: run one gpt-6-astra host/tool turn required for Agent qualification, not basic setup"
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
        const removePrerequisite = nativeHostActionPrerequisite(
          selected !== null,
          "remove",
        );
        remove.disabled = removePrerequisite !== null;
        remove.title =
          removePrerequisite ?? "Forget this Codex executable and its checks";
        remove.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.remove-codex" },
            "Codex host selection removed.",
          );
        });
        // Route B: an isolated host this app launches answers one harmless
        // turn through ChatGPT. The local contract check is enough to expose
        // this owner-triggered entry point; premium-model/Agent gates remain
        // separate advanced qualifications.
        const routeB = document.createElement("button");
        routeB.type = "button";
        routeB.textContent = "Test model";
        const routeBReady =
          selected !== null && settings.setup.chatgpt.verified !== null;
        routeB.disabled = !routeBReady;
        routeB.title = routeBReady
          ? "After choosing a supported model in ChatGPT, run one explicit no-fallback turn through Farol Dev"
          : "Detect the supported Codex host and verify ChatGPT first";
        routeB.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.run-route-b-check" },
            "Route B answered through ChatGPT.",
          );
        });
        actions.append(choose, chooseFile, verify, live, agent, routeB, remove);
        row.append(actions);
        const taskRoute = settings.nativeHosts.taskRoute;
        const taskNote = document.createElement("p");
        taskNote.textContent = taskRoute
          ? `Saved task route: ${taskRoute.projectRoot} · ${taskRoute.observeThreadId ? "one owner-selected observation thread" : "observation off"} · expires ${new Date(taskRoute.expiresAt).toLocaleString()}`
          : "Persistent task route is off. Stop the connector, then select an existing shared Codex socket and saved project. Verification does not run a model turn; the selection takes effect when the connector next starts.";
        row.append(taskNote);
        const taskForm = document.createElement("form");
        taskForm.className = "connector-form";
        const taskText = (
          field: string,
          title: string,
          saved: string,
          placeholder: string,
        ): HTMLInputElement => {
          const previous = captureInputDraft(
            document.querySelector<HTMLInputElement>(
              `#settings-codex-task-${field}`,
            ),
            document.activeElement,
          );
          const label = document.createElement("label");
          label.textContent = title;
          const input = document.createElement("input");
          input.id = `settings-codex-task-${field}`;
          input.type = "text";
          input.autocomplete = "off";
          input.spellcheck = false;
          input.placeholder = placeholder;
          input.value = saved;
          label.append(input);
          taskForm.append(label);
          queueMicrotask(() => restoreInputDraft(input, previous));
          return input;
        };
        const socket = taskText(
          "socket",
          "Existing Codex socket",
          taskRoute?.socketPath ?? "",
          "/absolute/path/to/codex.sock",
        );
        const codexHome = taskText(
          "home",
          "Expected Codex home",
          taskRoute?.expectedCodexHome ?? "",
          "/absolute/path/to/codex-home",
        );
        const projectId = taskText(
          "project-id",
          "Saved project ID",
          taskRoute?.projectId ?? "",
          "Project UUID",
        );
        const projectRoot = taskText(
          "project-root",
          "Saved project root",
          taskRoute?.projectRoot ?? "",
          "/absolute/path/to/repository",
        );
        const observeThreadId = taskText(
          "observe-thread-id",
          "Owner-selected thread ID for read-only observation (optional)",
          taskRoute?.observeThreadId ?? "",
          "Exact native task UUID",
        );
        const modelPolicy = document.createElement("p");
        modelPolicy.textContent =
          "Model names and default effort come from tasks.harnesses in config.json. Each task may select a configured model and override effort. Close Farol before editing; restart to load the new policy.";
        taskForm.append(modelPolicy);
        const refreshModels = document.createElement("button");
        refreshModels.type = "button";
        refreshModels.textContent = "Refresh models";
        refreshModels.disabled = taskRoute == null;
        refreshModels.addEventListener("click", () => {
          void configureProduct(
            { kind: "host.refresh-codex-task-models" },
            "Models refreshed.",
          );
        });
        taskForm.append(refreshModels);
        const modelStatus = document.createElement("div");
        modelStatus.dataset.taskModels = "runtime-catalogue";
        const modelView =
          taskModelCatalogue?.revision === settings.revision
            ? taskModelCatalogue.view
            : null;
        if (!modelView) {
          modelStatus.textContent =
            "Not checked. Verify the task route, then refresh models. Configured names are not availability evidence.";
        } else {
          const checked = document.createElement("p");
          const catalogue = modelView.catalogue;
          checked.textContent =
            catalogue.status === "ready"
              ? `Runtime observed at ${new Date(catalogue.observedAt).toISOString()}${Date.now() - catalogue.observedAt >= 60_000 ? " · stale, refresh before relying on this display" : ""}. Every new dispatch rechecks the runtime.`
              : `Availability unknown · ${catalogue.code}`;
          modelStatus.append(checked);
          if (modelView.configError) {
            const warning = document.createElement("p");
            warning.textContent =
              "Configure tasks.harnesses.codex in config.json. The runtime catalogue does not change the config.";
            modelStatus.append(warning);
          }
          for (const item of modelView.configured) {
            const row = document.createElement("p");
            row.textContent = `${item.alias} → ${item.model} · configured effort: ${item.defaultEffort ?? "runtime default"} · available: ${item.available}${item.effortAvailable === false && item.available === "yes" ? " · configured effort unavailable" : ""}`;
            modelStatus.append(row);
          }
          if (catalogue.status === "ready") {
            const available = document.createElement("p");
            available.textContent =
              "Reported by Codex: " +
              catalogue.models
                .map(
                  (item) =>
                    `${item.model} (${item.supportedEfforts.join(", ") || "no effort"}${item.hidden ? "; hidden from picker" : ""})`,
                )
                .join("; ");
            modelStatus.append(available);
          }
        }
        taskForm.append(modelStatus);
        const workspaceLabel = document.createElement("label");
        workspaceLabel.textContent = "Verified Computer workspace";
        const workspaceSelect = document.createElement("select");
        for (const workspace of settings.computer.workspaces) {
          if (!workspace.rootIdentity || !workspace.gitMetadata) continue;
          const option = document.createElement("option");
          option.value = workspace.workspaceId;
          option.textContent = `${workspace.label} · ${workspace.root}`;
          workspaceSelect.append(option);
        }
        workspaceSelect.value =
          taskRoute?.workspaceId ??
          settings.setup.computer.verified?.workspaceId ??
          "";
        workspaceLabel.append(workspaceSelect);
        taskForm.append(workspaceLabel);
        const sandboxLabel = document.createElement("label");
        sandboxLabel.textContent = "Task sandbox";
        const sandboxSelect = document.createElement("select");
        for (const value of ["read-only", "workspace-write"] as const) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          sandboxSelect.append(option);
        }
        sandboxSelect.value = taskRoute?.execution.sandbox ?? "read-only";
        sandboxLabel.append(sandboxSelect);
        taskForm.append(sandboxLabel);
        const approvalLabel = document.createElement("label");
        approvalLabel.textContent = "Task approvals";
        const approvalSelect = document.createElement("select");
        for (const value of ["untrusted", "on-request"] as const) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          approvalSelect.append(option);
        }
        approvalSelect.value =
          taskRoute?.execution.approvalPolicy ?? "on-request";
        approvalLabel.append(approvalSelect);
        taskForm.append(approvalLabel);
        const taskSave = document.createElement("button");
        taskSave.type = "submit";
        taskSave.textContent = "Verify and save task route";
        taskSave.disabled =
          selected?.localVerification == null ||
          workspaceSelect.options.length === 0;
        taskForm.append(taskSave);
        taskForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const parsed = ProductConfigurationCommandSchema.safeParse({
            kind: "host.configure-codex-tasks",
            socketPath: socket.value.trim(),
            expectedCodexHome: codexHome.value.trim(),
            workspaceId: workspaceSelect.value,
            projectId: projectId.value.trim(),
            ...(observeThreadId.value.trim()
              ? { observeThreadId: observeThreadId.value.trim() }
              : {}),
            projectRoot: projectRoot.value.trim(),
            sandbox: sandboxSelect.value,
            approvalPolicy: approvalSelect.value,
          });
          if (!parsed.success) {
            settingsFeedbackSurface = "settings";
            settingsFeedback =
              "Enter exact absolute paths and a saved project UUID.";
            settingsFeedbackError = true;
            render();
            return;
          }
          void configureProduct(
            parsed.data,
            "Persistent task route verified and saved.",
          );
        });
        row.append(taskForm);
        if (taskRoute) {
          const taskClear = document.createElement("button");
          taskClear.type = "button";
          taskClear.textContent = "Revoke task route";
          taskClear.addEventListener("click", () => {
            void configureProduct(
              { kind: "host.clear-codex-tasks" },
              "Persistent task route revoked.",
            );
          });
          row.append(taskClear);
        }
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
  const devEnvironment = bootstrap.environment === "dev";
  const selectDefaultLabel = selectDefault.closest("label");
  if (selectDefaultLabel instanceof HTMLElement) {
    selectDefaultLabel.hidden = devEnvironment;
  }
  if (devEnvironment) {
    modelSelectAsDefault = false;
    selectDefault.checked = false;
  }
  required<HTMLElement>("#model-config-scope").textContent = devEnvironment
    ? "Uses only Farol Dev's private Codex home and loopback provider; personal Codex config and authentication are never read or changed."
    : "Writes only a Farol-managed block to your Codex config.toml, never anything else in the file.";

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
        ? `Listening on port ${status.port}, waiting for a request from the isolated Farol Dev Codex child.`
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
      restartNote.textContent = devEnvironment
        ? "Applied only inside Farol Dev's private Codex home. Test model launches a fresh isolated child; your Codex settings and model menu are untouched."
        : modelRestartNoteText(modelConfigCodexHost);
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
  const devHostStep = bootstrap.environment === "dev" && step.id === "hosts";
  const devHostStepReady =
    devHostStep &&
    configured.status === "ready" &&
    localHostContractVerified(configured.settings.nativeHosts.codex);
  dialog.dataset.mode = setupJourney.mode;
  dialog.dataset.stepId = step.id;
  renderConfigurationFeedback("#setup-feedback", "setup");
  required("#setup-eyeline").textContent = step.eyeline;
  required("#setup-title").textContent = step.title;
  required("#setup-copy").textContent = devHostStep
    ? "Detect the installed supported Codex executable and verify its App Server contract locally. This readiness check uses zero model turns; Test model and Agent qualification remain separate owner-triggered steps."
    : step.copy;
  const status = required<HTMLDivElement>("#setup-status");
  const stepStale =
    configured.status === "ready" &&
    setupStepStale(configured.settings, step.id);
  const stepState = devHostStepReady
    ? "ready"
    : readinessState
      ? routeReadiness(readinessState, { stale: stepStale })
      : "not-configured";
  status.className = `setup-status ${routeStatusClass(stepState)}`;
  required<HTMLElement>("#setup-status strong").textContent = devHostStepReady
    ? "Local host ready"
    : readinessState
      ? readinessLabel(readinessState, { stale: stepStale })
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
  const stepDetails = devHostStep
    ? [
        "Detection verifies the executable digest, supported version, protocol and App Server schema without a model request.",
        "The isolated Test model route and premium-model Agent gates are not part of this local check.",
      ]
    : step.details;
  details.replaceChildren(
    ...[...stepDetails, ...liveDetails].map((detail) => {
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
        configured.status === "ready" &&
          progressId !== undefined &&
          (bootstrap.environment === "dev" && progressId === "hosts"
            ? localHostContractVerified(configured.settings.nativeHosts.codex)
            : progressState !== null &&
              routeReadiness(progressState, {
                stale: setupStepStale(configured.settings, progressId),
              }) === "ready"),
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
  // "Open ChatGPT" implies there is something to open. With no live
  // ChatGPT task yet, closing Setup only lands on the empty ChatGPT panel,
  // so the last step must not promise otherwise (UX34-03/04).
  const hasWorkingTask = bootstrap.tasks.some(
    (task) => task.provider === "chatgpt",
  );
  required<HTMLButtonElement>("#setup-next").textContent =
    setupJourney.step === setupSteps.length - 1
      ? hasWorkingTask
        ? "Open ChatGPT"
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
            bootstrap.environment === "dev"
              ? "ChatGPT opened inside Farol Dev."
              : "Isolated ChatGPT window opened.",
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
    // Caption, disabled flag and reason from one function, and the same
    // prerequisite Settings' sibling button uses — including the approved
    // workspace the connector serves, which this step used to omit.
    const connectPrimary = setupConnectPrimary(
      connector,
      configured.settings.computer.workspaces.length,
    );
    livePrimary.hidden = connectPrimary.hidden;
    livePrimary.textContent = connectPrimary.label;
    livePrimary.disabled = connectPrimary.disabled;
    if (connectPrimary.reason !== null) {
      livePrimary.title = connectPrimary.reason;
    } else {
      livePrimary.removeAttribute("title");
    }
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
      ? bootstrap.environment === "dev"
        ? devHostSetupSummary(host, readiness)
        : `${readinessDetail(readiness)} Codex ${host.version} is selected; a live check uses gpt-6-astra without provider fallback and stores no prompt or response.`
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
      : bootstrap.environment === "dev"
        ? "Recheck local host"
        : readiness.outcomeUnknown
          ? "Recheck contract"
          : host.liveVerification
            ? "Run live check again"
            : "Run live check";
    livePrimary.disabled = !host;
    setupPrimaryAction = async () => {
      if (!host) return;
      const kind =
        bootstrap.environment === "dev" || readiness.outcomeUnknown
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
    // The sentence and the caption from one function, with outcome-unknown
    // first: the caption used to omit it entirely, so "Rejoin Agent" could
    // sit under a sentence telling the owner to inspect before recovering.
    const verifyStep = agentVerifyStepPresentation({
      outcomeUnknown: readiness.outcomeUnknown,
      proof,
      needsRejoin,
      prerequisitesReady,
    });
    liveSummary.textContent = verifyStep.summary;
    livePrimary.textContent = verifyStep.label;
    livePrimary.disabled = verifyStep.disabled;
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
  toggle.title = `${label}${navigationShortcuts.sidebar === "off" ? "" : ` (⌃⌘${navigationShortcuts.sidebar.toUpperCase()})`}`;
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
  if (shellOverlay === "task-menu") {
    // Every rebuild of an open task menu, with who asked for it. A rebuild
    // between two keystrokes replaces the element the rest of the word was
    // addressed to, so "it re-rendered" is not a harmless observation here.
    // Rate limited: this fires on every keystroke, and a line per call is a
    // second load on the thing being measured rather than a measurement.
    const admitted = renderDuringMenu.admit();
    if (admitted) {
      const dialog = document.querySelector("#task-menu");
      console.debug(
        "farol.render-during-menu",
        JSON.stringify({
          notify,
          suppressed: admitted.suppressed,
          // If the document's dialog is no longer the node this module
          // holds, the element was replaced rather than closed — which
          // emits no close event and writes no overlay value.
          sameNode: dialog === taskMenuNode,
          connected: taskMenuNode?.isConnected ?? null,
          open: taskMenuNode?.open ?? null,
          ...topLayerCensus(),
          frames: diagnosticFrames(),
        }),
      );
    }
  }
  const root = document.documentElement;
  root.dataset.section = section;
  root.dataset.hasTasks = String(bootstrap.tasks.length > 0);
  const compactBrowser = compactBrowserSelected(bootstrap);
  root.dataset.compactBrowser = String(compactBrowser);
  root.dataset.browserChrome = String(
    (!compactBrowser && !chatGptSignInOpened) ||
      (bootstrap.tasks.length > 0 && !chatGptSignInOpened) ||
      (compactBrowser && section === "browser" && !setupJourney.open),
  );
  required<HTMLButtonElement>("#browser-sidebar-toggle").hidden = !(
    embeddedBrowserSelected(bootstrap) &&
    section === "browser" &&
    !setupJourney.open &&
    (chatGptSignInOpened || bootstrap.tasks.length === 0
      ? browserHomeStatus === "ready"
      : taskById(selectedTaskId)?.provider === "chatgpt" &&
        taskSurfaceStatuses.get(selectedTaskId)?.state === "ready")
  );
  const browserMenu = required<HTMLButtonElement>("#browser-task-menu");
  const browserMenuLabel =
    bootstrap.tasks.length > 0 ? "Selected task options" : "Browser options";
  browserMenu.setAttribute("aria-label", browserMenuLabel);
  browserMenu.title = browserMenuLabel;
  const newTask = required<HTMLButtonElement>("#new-task");
  const chatGptReady = chatGptRouteState() === "ready";
  required("#window-mode").textContent = windowModeLabel({
    demoMode: bootstrap.demoMode,
    taskCount: bootstrap.tasks.length,
    chatGptReady,
  });
  if (
    embeddedBrowserSelected(bootstrap) &&
    section === "browser" &&
    bootstrap.tasks.length === 0
  ) {
    required("#window-mode").textContent = "ChatGPT inside Farol";
  }
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
  required<HTMLButtonElement>("#sign-in-return").hidden =
    !chatGptSignInOpened || !guidedSetupSelected(bootstrap);
  renderWindowState();
  renderBuildIdentity();
  renderRuntime();
  renderBrowser();
  renderTabs();
  renderBrowserStatus();
  renderSignals();
  renderDossier();
  renderTaskMenu();
  renderComputer();
  renderActivity();
  renderSettings();
  const guidedEnabled = guidedSetupSelected(bootstrap);
  guidedOnboarding?.render(
    guidedEnabled,
    settingsFeedback,
    settingsFeedbackError,
  );
  if (guidedEnabled) {
    // Settings and Setup each own the rail while open. Keep the product
    // sections in the app rail, not alongside either journey's navigation.
    const settingsOwnsRail = section === "settings" && guidedEnabled;
    required<HTMLElement>("#nav").hidden =
      section === "computer" || settingsOwnsRail;
    required<HTMLButtonElement>(
      '.nav-utility .nav-item[data-section="settings"]',
    ).hidden = settingsOwnsRail;
    const pendingApproval = pendingComputerTask() !== null;
    required<HTMLElement>("#connection-permission").hidden = !pendingApproval;
    required<HTMLElement>("#connection-scope").hidden = true;
    required('.nav-item[data-section="computer"] .nav-label').textContent =
      "Setup";
  }
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
  // The owner dismissing the menu is one of the three things that drops the
  // Agent draft. The menu closing for any other reason — an `open-settings`
  // shell action published when a route window closed, for one — does not
  // come through here, which is the whole point.
  if (shellOverlay === "task-menu") {
    taskAgentDraft.clear();
    taskMenuReturnOffered = false;
  }
  sidebarOverlayOpen = false;
  setShellOverlay("none");
  render();
}

async function cancelContextPreview(): Promise<void> {
  if (contextPreviewBusy) return;
  const preview = pendingChatGptPreview;
  if (!preview) {
    setShellOverlay("none");
    render();
    return;
  }
  contextPreviewBusy = true;
  pendingChatGptPreview = null;
  setShellOverlay("none");
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
  setShellOverlay("none");
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
    setShellOverlay(sidebarOverlayOpen ? "sidebar" : "none");
  } else {
    sidebarOverlayOpen = false;
    setShellOverlay("none");
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
    // A different task is a different assignment: the store drops the old
    // draft and the fields go back to their defaults. Same rule as before,
    // now the only place that decides it.
    taskAgentDraft.select(task.taskId);
    if (!taskAgentDraft.held()) writeAgentDraftFields(EMPTY_AGENT_DRAFT);
  }
  sidebarOverlayOpen = false;
  setShellOverlay("task-menu");
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
    return "Product Agent is unavailable in this build. No Agent operation was started.";
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
  onSuccess?: () => void,
): Promise<void> {
  if (taskMenuBusy) return;
  taskMenuBusy = true;
  taskMenuFeedback = "";
  taskMenuFeedbackError = false;
  taskMenuTrace.dispatch(command.kind);
  render();
  try {
    const parsed = ProductTaskCommandResultSchema.safeParse(
      await window.farolNext.task(command),
    );
    if (!parsed.success) {
      taskMenuTrace.settle("invalid");
      taskMenuFeedback = "The task route returned an invalid result.";
      taskMenuFeedbackError = true;
      return;
    }
    applyTasksState(parsed.data.state);
    if (!parsed.data.ok) {
      taskMenuTrace.settle("refused");
      taskMenuFeedback = taskMenuErrorMessage(parsed.data.error);
      taskMenuFeedbackError = true;
      return;
    }
    taskMenuTrace.settle("ok");
    selectedTaskId = parsed.data.selectedTaskId ?? "";
    onSuccess?.();
    taskMenuFeedback = successMessage;
    if (closeAfterSuccess) {
      setShellOverlay("none");
      taskMenuTrace.skipped("menu-closed");
      return;
    }
    const task = taskById(selectedTaskId);
    if (task?.provider === "chatgpt") {
      required<HTMLInputElement>("#task-menu-name").value = task.label;
    }
  } catch {
    taskMenuTrace.settle("threw");
    taskMenuFeedback = "The task operation could not be completed.";
    taskMenuFeedbackError = true;
  } finally {
    taskMenuBusy = false;
    render();
    writeTaskMenuTrace();
  }
}

function openCommands(): void {
  sidebarOverlayOpen = false;
  setShellOverlay("quick-switcher");
  render();
}

function executeCommand(item: CommandItem): void {
  setShellOverlay("none");
  if (item.kind === "section") selectSection(item.value as SurfaceSection);
  else selectTask(item.value);
}

function selectTask(taskId: string): void {
  const task = taskById(taskId);
  if (!task) return;
  selectedTaskId = taskId;
  section = "browser";
  sidebarOverlayOpen = false;
  setShellOverlay("none");
  render();
  if (task.provider === "chatgpt") {
    void window.farolNext.task({ kind: "task.activate", taskId });
  }
}

function selectSection(next: SurfaceSection): void {
  if (!sections.includes(next)) return;
  if (next === "settings" && section !== "settings") {
    settingsFeedback = "";
    settingsFeedbackError = false;
  }
  section = next;
  sidebarOverlayOpen = false;
  setShellOverlay("none");
  render();
  if (
    next === "browser" &&
    embeddedBrowserSelected(bootstrap) &&
    bootstrap.tasks.length === 0 &&
    !chatGptSignInOpened
  ) {
    void openBrowserHome();
  }
}

async function openBrowserHome(): Promise<void> {
  if (
    browserHomeOpening ||
    !embeddedBrowserSelected(bootstrap) ||
    bootstrap.tasks.length !== 0 ||
    chatGptSignInOpened
  )
    return;
  browserHomeOpening = true;
  browserHomeStatus = "opening";
  render();
  try {
    const opened = await configureProduct(
      { kind: "chatgpt.open-browser" },
      "ChatGPT opened inside Farol.",
    );
    browserHomeStatus = opened ? "ready" : "failed";
  } finally {
    browserHomeOpening = false;
    render();
  }
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
  const hadTasks = bootstrap.tasks.length > 0;
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
  if (shellOverlay === "task-menu") {
    const admitted = tasksStateDuringMenu.admit();
    if (admitted) {
      console.debug(
        "farol.tasks-state-during-menu",
        JSON.stringify({
          tasks: state.tasks.length,
          selectionKept: taskIds.has(selectedTaskId),
          suppressed: admitted.suppressed,
        }),
      );
    }
  }
  render();
  if (hadTasks && state.tasks.length === 0 && section === "browser") {
    void openBrowserHome();
  }
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
  // Everything main genuinely coordinates, and nothing about whether an
  // overlay is open: main's copy of that is a mirror of what this renderer
  // told it, and sending a mirror back was able to close a menu the owner
  // was typing in. See host-layout.ts.
  const update = hostLayoutUpdate(layout);
  // A push that moves nothing is not a reason to rebuild anything. One
  // arriving between two keystrokes replaces the element the rest of the
  // word was going to, and restoring the value into a fresh node is not the
  // same as never having replaced it.
  const changed = hostLayoutChanged(update, {
    section,
    taskId: selectedTaskId,
    setupOpen: setupJourney.open,
    sidebarPreference,
    sidebarOverlayOpen,
  });
  section = update.section;
  selectedTaskId = update.taskId;
  setupJourney = { ...setupJourney, open: update.setupOpen };
  if (update.sidebarPreference !== null) {
    sidebarPreference = update.sidebarPreference;
  }
  sidebarOverlayOpen = update.sidebarOverlayOpen;
  lastHostLayout = JSON.stringify(currentLayout());
  if (changed) render(false);
}

async function start(): Promise<void> {
  const updaterView = createInstalledUpdateView(document, (kind) => {
    void window.farolNext.installedUpdate({ kind }).then(renderUpdate, () => {
      updaterView.render({
        phase: "failed",
        code: "UPDATE_STATUS_UNKNOWN",
        recoveryRequired: true,
      });
    });
  });
  const renderUpdate = (value: unknown): void => {
    const parsed = InstalledUpdateViewSchema.safeParse(value);
    if (parsed.success) updaterView.render(parsed.data);
  };
  updaterView.render({ phase: "unavailable", code: "UPDATE_NOT_INSTALLED" });
  window.farolNext.onInstalledUpdateState(renderUpdate);
  void window.farolNext.installedUpdate({ kind: "status" }).then(renderUpdate);
  window.farolNext.onLayout((value) => {
    const parsed = ShellLayoutSchema.safeParse(value);
    if (!parsed.success) return;
    if (!bootstrapReady) {
      pendingLayout = parsed.data;
      return;
    }
    applyHostLayout(parsed.data);
  });
  watchTaskMenuNode();
  window.farolNext.onShellAction((value) => {
    const parsed = ShellActionSchema.safeParse(value);
    if (!parsed.success || !bootstrapReady) return;
    // Every arrival, whichever branch takes it. `close-overlay` reaches
    // closeOverlay() — the one path that closes the menu AND clears the
    // draft with the section unchanged, which is the shape of the dump —
    // and it used to leave no line at all.
    console.debug(
      "farol.shell-action",
      JSON.stringify({
        eventId: parsed.data.eventId,
        action: parsed.data.action,
        source: parsed.data.source,
        gen: parsed.data.authWindowGeneration,
        branch:
          parsed.data.action === "toggle-sidebar" ||
          parsed.data.action === "open-quick-switcher"
            ? parsed.data.action
            : parsed.data.action === "open-settings" ||
                parsed.data.action === "sign-in-returned"
              ? "policy"
              : "close-overlay",
        shellOverlay,
        held: taskAgentDraft.held(),
        draftTaskMatches: taskAgentDraft.keyedTo() === selectedTaskId,
        draftHeld: shellOverlay === "task-menu" && taskAgentDraft.held(),
      }),
    );
    if (parsed.data.action === "toggle-sidebar") toggleSidebar();
    else if (parsed.data.action === "open-quick-switcher") openCommands();
    else if (
      parsed.data.action === "open-settings" ||
      parsed.data.action === "sign-in-returned"
    ) {
      // The envelope now says who published it. Which publisher it was
      // decides whether the editor may be taken; it never decides whether
      // readiness is re-read.
      const provenance = {
        eventId: parsed.data.eventId,
        source: parsed.data.source,
        authWindowGeneration: parsed.data.authWindowGeneration,
      };
      const decision = decideShellAction(provenance, {
        draftHeld: shellOverlay === "task-menu" && taskAgentDraft.held(),
        currentAuthWindowGeneration,
        handledEventIds: handledShellActionIds,
      });
      if (provenance.eventId !== null) {
        handledShellActionIds.add(provenance.eventId);
      }
      // One line per shell action, content-free: what arrived, what the
      // renderer held when it did, and what was decided. A run that ends
      // with an editor gone can then say which input produced that, instead
      // of leaving the decision to be inferred from the outcome.
      console.debug(
        "farol.shell-decision",
        JSON.stringify({
          eventId: provenance.eventId,
          reason: decision.reason,
          navigate: decision.navigate,
          refreshReadiness: decision.refreshReadiness,
          offerReturn: decision.offerReturn,
          ...topLayerCensus(),
        }),
      );
      if (!decision.refreshReadiness) return;
      chatGptSignInOpened = false;
      guidedOnboarding?.signInReturned();
      if (decision.navigate) {
        taskMenuReturnOffered = false;
        if (parsed.data.action === "open-settings") {
          setupJourney = { ...setupJourney, open: false };
          settingsCategory = "preferences";
          selectSection("settings");
        }
      } else if (decision.offerReturn) {
        // Readiness still changes; the editor does not move.
        taskMenuReturnOffered = true;
        renderTaskMenu();
      }
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
  window.farolNext.onBrowserRouteState((value) => {
    const parsed = BrowserRouteStatusSchema.safeParse(value);
    if (!parsed.success) return;
    browserHomeStatus =
      parsed.data.state === "loaded"
        ? "ready"
        : parsed.data.state === "failed"
          ? "failed"
          : "opening";
    if (bootstrapReady) render();
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
  if (bootstrap.environment === "dev" && !bootstrap.demoMode) {
    try {
      const applied =
        await window.farolNext.setNavigationShortcuts(navigationShortcuts);
      if (
        typeof applied !== "object" ||
        applied === null ||
        !("ok" in applied) ||
        applied.ok !== true
      )
        navigationShortcuts = { ...defaultNavigationShortcuts };
    } catch {
      navigationShortcuts = { ...defaultNavigationShortcuts };
    }
  }
  applyProductIdentity();
  windowState = bootstrap.windowState;
  selectedTaskId = bootstrap.tasks[0]?.taskId ?? "";
  if (bootstrap.configuration.status === "ready") {
    const settings = bootstrap.configuration.settings;
    const initialSetup = initialSetupPresentation({
      environment: bootstrap.environment,
      demoMode: bootstrap.demoMode,
      legacySetupTestMode: bootstrap.legacySetupTestMode,
      dismissed: settings.setup.journey.dismissed,
      currentStep: settings.setup.journey.currentStep,
      openAtLaunch: settings.general.openAtLaunch,
    });
    setupJourney = createSetupJourney({
      open: initialSetup.setupOpen,
      step: initialSetup.setupStep,
    });
    sidebarPreference = settings.general.sidebarDefault;
    section = initialSetup.section;
  }

  guidedOnboarding = new GuidedOnboardingView({
    mode: "embedded",
    verificationCard: () =>
      bootstrap.configuration.status === "ready"
        ? connectorChallengeCard(bootstrap.configuration.settings)
        : null,
    settings: () =>
      bootstrap.configuration.status === "ready"
        ? bootstrap.configuration.settings
        : null,
    buildId: () => bootstrap.build.buildId,
    isActive: () => section === "computer",
    configure: configureProduct,
    configureAccess: async (command, message) => {
      let result: "applied" | "refused" | "unknown" = "unknown";
      await configureProduct(command, message, undefined, (outcome) => {
        result = outcome;
      });
      return result;
    },
    readSettings: refreshSettingsAfterReturn,
    chooseFolder: async () => {
      let selectionId: string | null = null;
      await configureProduct(
        { kind: "computer.choose-workspace" },
        "Folder selected.",
        (evidence) => {
          if (evidence?.kind === "computer.workspace-pick")
            selectionId = evidence.selectionId;
        },
      );
      return selectionId;
    },
    pickFolder: async (selectionId) => {
      let selected: string | null = null;
      await configureProduct(
        { kind: "computer.add-workspace", selectionId },
        "Folder selected.",
        (evidence) => {
          if (evidence?.kind === "computer.workspace-selection")
            selected = evidence.workspaceId;
        },
      );
      return selected;
    },
    openSettings: () => selectSection("settings"),
    openDiagnostics: () => {
      settingsCategory = "diagnostics";
      selectSection("settings");
      const diagnostics = required<HTMLDetailsElement>(
        "#connection-diagnostics",
      );
      diagnostics.open = true;
      diagnostics.scrollIntoView({ block: "start" });
    },
    render: () => render(),
    returnToChat: () => selectSection("browser"),
    openChat: () => selectSection("browser"),
  });
  // Diagnostic and optional model/Agent controls are available in Settings,
  // not a second setup journey beneath the guided steps.
  if (guidedSetupSelected(bootstrap)) {
    const diagnostics = required<HTMLDetailsElement>("#connection-diagnostics");
    diagnostics.open = false;
    diagnostics.dataset.settingsPage = "diagnostics";
    required('[data-panel="settings"]').append(diagnostics);
    required("#connection-diagnostics > summary").textContent =
      "Connection diagnostics";
  }
  for (const select of shortcutSelects()) {
    select.replaceChildren(
      ...[
        { value: 0, label: "Off" },
        ...[1, 2, 3, 4].map((digit) => ({
          value: digit,
          label: `⌘${digit}`,
        })),
      ].map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = label;
        return option;
      }),
    );
  }
  setShortcutDraft(navigationShortcuts);
  document
    .querySelectorAll<HTMLButtonElement>(
      "#settings-nav button[data-settings-category]",
    )
    .forEach((button) => {
      button.addEventListener("click", () => {
        settingsCategory = button.dataset
          .settingsCategory as typeof settingsCategory;
        render();
        required<HTMLElement>('[data-panel="settings"]').scrollTop = 0;
      });
    });
  required<HTMLButtonElement>("#settings-return").addEventListener(
    "click",
    () => selectSection("browser"),
  );
  required<HTMLButtonElement>("#apply-shortcuts").addEventListener(
    "click",
    applyShortcutDraft,
  );
  required<HTMLButtonElement>("#reset-shortcuts").addEventListener(
    "click",
    () => {
      setShortcutDraft(defaultNavigationShortcuts);
      applyShortcutDraft();
    },
  );

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
  required<HTMLButtonElement>("#sign-in-return").addEventListener(
    "click",
    () => {
      void window.farolNext.configure({ kind: "chatgpt.sign-in-return" });
    },
  );
  required<HTMLButtonElement>("#browser-retry").addEventListener(
    "click",
    () => {
      void openBrowserHome();
    },
  );
  required<HTMLButtonElement>("#sidebar-backdrop").addEventListener(
    "click",
    closeOverlay,
  );
  required<HTMLButtonElement>("#command-button").addEventListener(
    "click",
    openCommands,
  );
  required<HTMLButtonElement>("#browser-task-menu").addEventListener(
    "click",
    openTaskMenu,
  );
  required<HTMLButtonElement>("#browser-sidebar-toggle").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "chatgpt.toggle-sidebar" },
        "ChatGPT sidebar toggled.",
      );
    },
  );
  required<HTMLButtonElement>("#browser-review-request").addEventListener(
    "click",
    () => {
      selectSection("computer");
    },
  );
  required<HTMLButtonElement>("#browser-check-return").addEventListener(
    "click",
    () => required<HTMLButtonElement>("#sign-in-return").click(),
  );
  required<HTMLButtonElement>("#new-task").addEventListener(
    "click",
    async () => {
      taskAdmissionFeedback = "";
      const button = required<HTMLButtonElement>("#new-task");
      button.disabled = true;
      // What the surface was when this was asked for. The answer can arrive
      // seconds later, and by then the owner may be somewhere else.
      const overlayAtDispatch = shellOverlay;
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
      if (completionMayNavigate(overlayAtDispatch, shellOverlay)) {
        selectedTaskId = parsed.data.selectedTaskId;
        section = "browser";
        setShellOverlay("none");
      } else {
        // The owner opened something while this was in flight — a task menu
        // with an Agent assignment being written, in the case that found
        // this. The task is admitted and waiting in the tabs; taking the
        // owner to it would close what they are working in.
        taskAdmissionFeedback =
          "The new task is ready and waiting in the task tabs.";
      }
      render();
    },
  );
  required<HTMLButtonElement>("#task-menu-button").addEventListener(
    "click",
    openTaskMenu,
  );
  required<HTMLButtonElement>("#task-menu-return").addEventListener(
    "click",
    () => {
      // The owner choosing to go: their navigation is honoured, and the
      // assignment is kept because going to Settings is not dismissing one.
      taskMenuReturnOffered = false;
      setupJourney = { ...setupJourney, open: false };
      sidebarOverlayOpen = false;
      setShellOverlay("none");
      selectSection("settings");
    },
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
      setShellOverlay("none");
      if (guidedSetupSelected(bootstrap)) {
        setupJourney = { ...setupJourney, open: false };
        selectSection("computer");
        guidedOnboarding?.restart();
      } else {
        setupJourney = reopenSetup(setupJourney);
        render();
      }
    },
  );
  const renameLiveTask = () => {
    const task = taskById(selectedTaskId);
    const input = required<HTMLInputElement>("#task-menu-name");
    const reason = taskRenamePrerequisite({
      busy: taskMenuBusy,
      provider: task?.provider ?? null,
      label: input.value,
    });
    if (reason !== null) {
      // Never a silent return. The control is disabled for each of these,
      // so reaching here means the selection changed under the open menu —
      // and that must produce a sentence, not nothing.
      taskMenuFeedback = reason;
      taskMenuFeedbackError = true;
      render();
      return;
    }
    void runTaskMenuCommand(
      { kind: "task.rename", taskId: task!.taskId, label: input.value.trim() },
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
  const captureAgentDraft = (): void => {
    taskAgentDraft.capture(
      selectedTaskId,
      readAgentDraftFields(),
      currentAgentAuthority(),
    );
    renderTaskMenu();
  };
  for (const selector of [
    "#task-agent-objective",
    "#task-agent-scope",
    "#task-agent-subtree",
    "#task-agent-paths",
    "#task-agent-exclusions",
  ]) {
    required<HTMLElement>(selector).addEventListener(
      "input",
      captureAgentDraft,
    );
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
      // Text survived a background event; permission does not travel with
      // it. If the grant it was written under has moved, the assignment is
      // refused out loud and nothing is sent.
      if (
        taskAgentDraft.held() &&
        !agentAuthorityUnchanged(
          taskAgentDraft.composedUnder(),
          currentAgentAuthority(),
        )
      ) {
        taskMenuFeedback = AGENT_AUTHORITY_CHANGED;
        taskMenuFeedbackError = true;
        render();
        return;
      }
      void runTaskMenuCommand(
        {
          kind: "task.start-agent",
          taskId: task.taskId,
          workspaceId,
          objective,
          scope,
        },
        "Agent assignment admitted.",
        false,
        () => {
          // A refusal leaves the owner's text and its authority snapshot in
          // place. After admission, clear both so another press cannot send
          // the old assignment under a changed grant.
          taskAgentDraft.clear();
          writeAgentDraftFields(EMPTY_AGENT_DRAFT);
        },
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
  for (const kind of ["close", "cancel"] as const) {
    // A <dialog> closes on Escape and on its own `close`; either would end
    // the editor without any renderer code asking for it, and neither is
    // visible in the overlay setter because the element closed itself.
    required<HTMLDialogElement>("#task-menu").addEventListener(kind, () => {
      console.debug(
        "farol.task-menu-close",
        JSON.stringify({
          kind,
          shellOverlay,
          returnValue: required<HTMLDialogElement>("#task-menu").returnValue,
          frames: diagnosticFrames(),
        }),
      );
    });
  }
  required<HTMLDialogElement>("#task-menu").addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      closeOverlay();
    },
  );
  required<HTMLDialogElement>("#task-menu").addEventListener(
    "click",
    (event) => {
      if (event.target === event.currentTarget) closeOverlay();
    },
  );
  required<HTMLDialogElement>("#command-dialog").addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      closeOverlay();
    },
  );
  required<HTMLDialogElement>("#command-dialog").addEventListener(
    "click",
    (event) => {
      if (event.target === event.currentTarget) closeOverlay();
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
  required<HTMLButtonElement>("#open-connections").addEventListener(
    "click",
    () => selectSection("computer"),
  );
  required<HTMLButtonElement>("#connections-open-chatgpt").addEventListener(
    "click",
    () => selectSection("browser"),
  );
  required<HTMLButtonElement>("#dev-proof-prepare").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "dev-proof.prepare" },
        "Farol Dev MCP fixture prepared.",
      );
    },
  );
  required<HTMLButtonElement>("#dev-proof-run").addEventListener(
    "click",
    () => {
      void configureProduct(
        { kind: "dev-proof.run" },
        "Farol Dev MCP proof verified.",
      );
    },
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
    if (guidedSetupSelected(bootstrap)) {
      setupJourney = { ...setupJourney, open: false };
      selectSection("computer");
      guidedOnboarding?.restart();
    } else {
      setupJourney = reopenSetup(setupJourney);
      render();
    }
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
      if (shellOverlay === "sidebar") setShellOverlay("none");
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
    if (
      event.ctrlKey &&
      event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      sidebarShortcutMatches(navigationShortcuts, event.key)
    ) {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
      const next = sectionForShortcut(navigationShortcuts, event.key);
      if (next) {
        event.preventDefault();
        selectSection(next);
      }
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
  if (
    section === "browser" &&
    embeddedBrowserSelected(bootstrap) &&
    bootstrap.tasks.length === 0 &&
    !setupJourney.open
  ) {
    queueMicrotask(() => {
      void openBrowserHome();
    });
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
