import { z } from "zod";
import {
  ClientEventSchema,
  type ClientEventDto,
} from "../modules/chat/contract/client-event";
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
} from "../pkg/product-settings/contract";
import {
  advanceSetup,
  createSetupJourney,
  reopenSetup,
  retreatSetup,
  setupSteps,
} from "./setup-journey";

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
  tasks: z.array(
    z.strictObject({
      taskId: z.string(),
      sessionId: z.string(),
      turnId: z.string(),
      label: z.string(),
      hasComputer: z.boolean(),
    }),
  ),
  partition: z.string(),
  chatgptPartition: z.literal("persist:farol-next-chatgpt"),
  updateChannel: z.literal("local-preview-only"),
  nativeFilesystem: z.literal(false),
  nativeAgent: z.literal(false),
  liveProvider: z.literal(false),
  windowState: WindowStateSchema,
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
type SafeActivity = Readonly<{
  taskId: string;
  kind: string;
  phase: string;
  sequence: number | null;
  at: number;
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
let chatGptSignInOpened = false;
let workspaceEvidence: Extract<
  ProductConfigurationEvidence,
  { kind: "computer.workspace-read" }
> | null = null;
let renderedSettingsRevision = -1;
let setupPrimaryAction: (() => Promise<void>) | null = null;
const taskEvents = new Map<string, ClientEventDto[]>();
const activity: SafeActivity[] = [];
const pendingRuntimeEvents: ClientEventDto[] = [];
let pendingRuntimeStatus: RuntimeStatus | null = null;
const pendingTaskSurfaceStatuses: TaskSurfaceStatus[] = [];
let pendingLayout: z.infer<typeof ShellLayoutSchema> | null = null;
const taskSurfaceStatuses = new Map<string, TaskSurfaceStatus>();

function taskLabel(task: PreviewTask | undefined): string {
  return task?.label.replace(/^Demo · /u, "") ?? "Unknown task";
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
}

function renderRuntime(): void {
  const pill = required<HTMLDivElement>("#runtime-pill");
  const lamp = required<HTMLElement>("#runtime-pill .state-lamp");
  const label = required<HTMLElement>("#runtime-pill b");
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
  const surfaceFailed =
    taskSurfaceStatuses.get(selectedTaskId)?.state === "failed";
  if (bootstrap.runtimeState === "ready" && bootstrap.tasks.length === 0) {
    loading.dataset.state = "empty";
    mark.className = "state-lamp unavailable";
    title.textContent = "No tasks yet";
    detail.textContent =
      "Complete Setup and connect a supported route to create the first real task.";
  } else if (surfaceFailed) {
    loading.dataset.state = "failed";
    mark.className = "state-lamp failed";
    title.textContent = "Selected task surface is unavailable";
    detail.textContent =
      "This task stream failed in isolation. Other task surfaces remain independent.";
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
              : ("failed" as const),
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
  required<HTMLElement>("#dossier-computer").textContent =
    unresolvedComputerRequest(selectedTaskId)
      ? "Approval required"
      : task?.hasComputer
        ? "No request"
        : "Unavailable";

  const canFinish =
    state.tone === "running" &&
    bootstrap.runtimeState === "ready" &&
    taskSurfaceStatuses.get(selectedTaskId)?.state !== "failed";
  finish.hidden = !canFinish;
  finish.disabled = !canFinish;
  route.hidden = canFinish;
  route.disabled = state.tone === "connecting";
  route.innerHTML =
    state.tone === "waiting"
      ? "Review request <span>›</span>"
      : state.tone === "unavailable"
        ? "Open Settings <span>›</span>"
        : "Open Activity <span>›</span>";

  taskMenuComputer.disabled = !unresolvedComputerRequest(selectedTaskId);
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
    : bootstrap.tasks.length === 0
      ? "No Computer request"
      : "Synthetic fixture only";
  required("#computer-detail").textContent = waitingTask
    ? "Target: fixture workspace status. This admitted preview task exposes no path, file content, command, screenshot, or account state."
    : bootstrap.tasks.length === 0
      ? "Computer opens only from a correlated task request. Workspace approval alone never starts an action."
      : "This demo cannot read files or run commands on your Mac.";
}

function renderActivity(): void {
  const list = required<HTMLOListElement>("#activity-list");
  const technical =
    bootstrap.configuration.status === "ready" &&
    bootstrap.configuration.settings.general.activityDetail === "technical";
  const visible = activity
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
  );
}

function readinessLabel(readiness: Readiness): string {
  if (readiness.verified) return "Verified";
  if (readiness.outcomeUnknown) return "Outcome unknown";
  if (readiness.unavailable) return "Unavailable";
  if (readiness.needsAction) return "Needs action";
  if (readiness.reachable === "reachable") return "Reachable · verify";
  if (readiness.reachable === "unreachable") return "Unreachable";
  if (readiness.configured) return "Configured · verify";
  return "Needs action";
}

function readinessDetail(readiness: Readiness): string {
  if (readiness.verified) {
    return `Verified ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(readiness.verified.verifiedAt))}`;
  }
  return (
    readiness.needsAction ??
    readiness.unavailable ??
    (readiness.reachable === "unreachable"
      ? "The configured route could not be reached."
      : "No verification has been recorded.")
  );
}

async function configureProduct(
  command: ProductConfigurationCommand,
  successMessage: string,
): Promise<boolean> {
  if (
    command.kind === "computer.verify-workspace" ||
    command.kind === "computer.update-exclusions" ||
    command.kind === "computer.remove-workspace"
  ) {
    workspaceEvidence = null;
  }
  settingsFeedback = "Saving and reading back…";
  settingsFeedbackError = false;
  render();
  const parsed = ProductConfigurationResultSchema.safeParse(
    await window.farolNext.configure(command),
  );
  if (!parsed.success) {
    settingsFeedback =
      "The settings response was invalid. Nothing was applied.";
    settingsFeedbackError = true;
    render();
    return false;
  }
  bootstrap = { ...bootstrap, configuration: parsed.data.snapshot };
  renderedSettingsRevision = -1;
  if (!parsed.data.ok) {
    settingsFeedback =
      parsed.data.error === "WORKSPACE_PICKER_CANCELLED" ||
      parsed.data.error === "WORKSPACE_FILE_PICKER_CANCELLED"
        ? "No selection was made."
        : `Not applied · ${parsed.data.error}`;
    settingsFeedbackError = ![
      "WORKSPACE_PICKER_CANCELLED",
      "WORKSPACE_FILE_PICKER_CANCELLED",
    ].includes(parsed.data.error);
    render();
    return false;
  }
  const evidence = parsed.data.evidence;
  if (evidence?.kind === "computer.workspace-read") {
    workspaceEvidence = evidence;
    settingsFeedback = `Read ${evidence.bytes} bytes from ${evidence.relativePath}. Nothing from the file was persisted.`;
  } else if (evidence?.kind === "chatgpt.readiness") {
    settingsFeedback =
      evidence.state === "authenticated"
        ? "ChatGPT composer verified in the isolated Next partition."
        : evidence.state === "signed_out"
          ? "The isolated ChatGPT page is reachable and needs sign-in."
          : evidence.state === "unreachable"
            ? "The isolated ChatGPT page could not be reached."
            : "ChatGPT loaded, but its composer could not be verified.";
  } else {
    settingsFeedback = successMessage;
  }
  settingsFeedbackError = false;
  if (
    command.kind === "general.update" &&
    bootstrap.configuration.status === "ready"
  ) {
    sidebarPreference = bootstrap.configuration.settings.general.sidebarDefault;
  }
  render();
  return true;
}

function renderSettings(): void {
  const configured = bootstrap.configuration;
  const values = [
    ["Application", `${bootstrap.productName} · ${bootstrap.bundleId}`],
    [
      "Build",
      `${bootstrap.build.version} · ${bootstrap.build.sourceCommit.slice(0, 12)} · ${bootstrap.build.builtAt}`,
    ],
    [
      "Runtime",
      `${bootstrap.runtimeState} · ${bootstrap.runtimeIdentity ?? "not started"}${bootstrap.runtimeError ? ` · ${bootstrap.runtimeError}` : ""}`,
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
      "Task authority",
      "Contract-tested · Main Turn → Agent → Critic continuity with explicit owner narrowing",
    ],
    [
      "Native access",
      configured.status === "ready" &&
      configured.settings.computer.workspaces.length > 0
        ? `${configured.settings.computer.workspaces.length} read-only workspace approval(s) · live provider and Agent still unverified`
        : "No workspace approved · live provider and Agent still unverified",
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

  const feedback = required<HTMLParagraphElement>("#settings-feedback");
  feedback.textContent =
    configured.status === "error"
      ? `Settings unavailable · ${configured.error}`
      : settingsFeedback;
  feedback.classList.toggle(
    "error",
    configured.status === "error" || settingsFeedbackError,
  );

  const formControls = [
    required<HTMLSelectElement>("#setting-open-at-launch"),
    required<HTMLSelectElement>("#setting-sidebar-default"),
    required<HTMLSelectElement>("#setting-activity-detail"),
  ] as const;
  const computerName = required<HTMLInputElement>("#computer-name");
  const applyGeneral = required<HTMLButtonElement>("#apply-general-settings");
  const saveComputerName = required<HTMLButtonElement>("#save-computer-name");
  const addWorkspace = required<HTMLButtonElement>("#add-workspace");
  const workspaces = required<HTMLDivElement>("#settings-workspaces");
  const connections = required<HTMLDivElement>("#connection-readiness");
  const computerReadiness = required<HTMLSpanElement>("#computer-readiness");

  if (configured.status === "error") {
    for (const control of formControls) control.disabled = true;
    computerName.disabled = true;
    applyGeneral.disabled = true;
    saveComputerName.disabled = true;
    addWorkspace.disabled = true;
    workspaces.textContent =
      "Repair is required before settings can be changed.";
    connections.textContent =
      "Readiness is unavailable while settings are invalid.";
    computerReadiness.textContent = "Unavailable";
    computerReadiness.classList.remove("verified");
    return;
  }

  const settings = configured.settings;
  for (const control of formControls) control.disabled = false;
  computerName.disabled = false;
  applyGeneral.disabled = false;
  saveComputerName.disabled = false;
  addWorkspace.disabled = false;
  if (
    renderedSettingsRevision !== settings.revision &&
    ![...formControls, computerName].includes(
      document.activeElement as HTMLInputElement & HTMLSelectElement,
    )
  ) {
    formControls[0].value = settings.general.openAtLaunch;
    formControls[1].value = settings.general.sidebarDefault;
    formControls[2].value = settings.general.activityDetail;
    computerName.value = settings.computer.name;
    renderedSettingsRevision = settings.revision;
  }

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
  } else {
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
          computerState.verified.configRevision ===
            settings.computer.generation;
        detail.textContent = `${workspace.root} · read-only · ${verified ? "verified" : "not verified"}`;
        copy.append(title, detail);
        const actions = document.createElement("span");
        actions.className = "workspace-actions";
        const verify = document.createElement("button");
        verify.type = "button";
        verify.textContent = verified ? "Recheck" : "Verify";
        verify.addEventListener("click", () => {
          void configureProduct(
            {
              kind: "computer.verify-workspace",
              workspaceId: workspace.workspaceId,
            },
            `${workspace.label} read access verified.`,
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
        actions.append(verify, remove);
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

        if (workspaceEvidence?.workspaceId === workspace.workspaceId) {
          const evidence = document.createElement("section");
          evidence.className = "workspace-read-evidence";
          const heading = document.createElement("strong");
          heading.textContent = `${workspaceEvidence.relativePath} · ${workspaceEvidence.bytes} bytes${workspaceEvidence.truncated ? " · preview truncated" : ""}`;
          const preview = document.createElement("pre");
          preview.textContent = workspaceEvidence.text;
          evidence.append(heading, preview);
          card.append(evidence);
        }
        return card;
      }),
    );
  }

  const connectionStates: readonly [string, Readiness][] = [
    ["ChatGPT", settings.setup.chatgpt],
    ["Computer", settings.setup.computer],
    ["Connection", settings.setup.connect],
    ["Native hosts", settings.setup.hosts],
    ["Verification", settings.setup.verify],
  ];
  connections.replaceChildren(
    ...connectionStates.map(([label, state]) => {
      const row = document.createElement("div");
      row.className = "connection-row";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${label} · ${readinessLabel(state)}`;
      const detail = document.createElement("small");
      detail.textContent = readinessDetail(state);
      copy.append(title, detail);
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
        actions.append(open, verify);
        row.append(actions);
      }
      return row;
    }),
  );
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
  required("#setup-eyeline").textContent = step.eyeline;
  required("#setup-title").textContent = step.title;
  required("#setup-copy").textContent = step.copy;
  const status = required<HTMLDivElement>("#setup-status");
  const tone = readinessState?.verified
    ? "available"
    : readinessState?.configured || readinessState?.needsAction
      ? "limited"
      : "blocked";
  status.className = `setup-status ${tone}`;
  required<HTMLElement>("#setup-status strong").textContent = readinessState
    ? readinessLabel(readinessState)
    : "Settings unavailable";
  const details = required<HTMLUListElement>("#setup-details");
  const liveDetails =
    configured.status === "ready" && step.id === "computer"
      ? configured.settings.computer.workspaces.map(
          (workspace) => `${workspace.label}: read-only · ${workspace.root}`,
        )
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
      item.classList.toggle("complete", progressState?.verified != null);
      item.classList.toggle("visited", progressState?.visited === true);
      item.classList.toggle("active", index === setupJourney.step);
      if (index === setupJourney.step)
        item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
  required("#setup-counter").textContent =
    `Step ${setupJourney.step + 1} of ${setupSteps.length}`;
  required<HTMLButtonElement>("#setup-back").disabled = setupJourney.step === 0;
  required<HTMLButtonElement>("#setup-next").textContent =
    setupJourney.step === setupSteps.length - 1 ? "Open Browser" : "Continue";
  required<HTMLButtonElement>("#setup-close").hidden =
    setupJourney.mode !== "review";
  const liveAction = required<HTMLDivElement>("#setup-live-action");
  const liveSummary = required<HTMLDivElement>("#setup-live-summary");
  const livePrimary = required<HTMLButtonElement>("#setup-live-primary");
  liveAction.hidden = false;
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
          : "Verify access";
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
        `${workspace.label} read access verified.`,
      );
    };
  } else {
    liveSummary.textContent = readinessState
      ? readinessDetail(readinessState)
      : "No readiness record is available.";
    livePrimary.textContent =
      step.id === "connect"
        ? "Connector unavailable"
        : step.id === "hosts"
          ? "Host setup unavailable"
          : "Checks unavailable";
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
  if (renderedOverlay !== shellOverlay) {
    renderedOverlay = shellOverlay;
    if (shellOverlay === "sidebar") {
      queueMicrotask(() =>
        document.querySelector<HTMLButtonElement>(".nav-item.active")?.focus(),
      );
    } else if (shellOverlay === "task-menu") {
      queueMicrotask(() =>
        required<HTMLButtonElement>("#task-menu-activity").focus(),
      );
    } else if (shellOverlay === "quick-switcher") {
      queueMicrotask(() =>
        required<HTMLInputElement>("#command-search").focus(),
      );
    }
  }
}

function render(notify = true): void {
  const root = document.documentElement;
  root.dataset.section = section;
  root.dataset.hasTasks = String(bootstrap.tasks.length > 0);
  required("#window-mode").textContent = bootstrap.demoMode
    ? "Explicit demo · synthetic provider"
    : "Local preview · no task route configured";
  const newTask = required<HTMLButtonElement>("#new-task");
  newTask.title = bootstrap.demoMode
    ? "Unavailable in explicit demo mode"
    : "Unavailable until a task route is configured";
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
  renderComputer();
  renderActivity();
  renderSettings();
  renderSetup();
  renderOverlayState();
  if (notify) notifyHost();
  document.documentElement.dataset.ready = "true";
}

function closeOverlay(): void {
  sidebarOverlayOpen = false;
  shellOverlay = "none";
  render();
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
  sidebarOverlayOpen = false;
  shellOverlay = "task-menu";
  render();
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
  if (!taskById(taskId)) return;
  selectedTaskId = taskId;
  section = "browser";
  sidebarOverlayOpen = false;
  shellOverlay = "none";
  render();
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
  const quietReceipt =
    event.kind === "client.delivery_acknowledged" &&
    !["text.delta", "turn.terminal"].includes(event.deliveredKind);
  if (!quietReceipt) {
    activity.push({
      taskId: event.taskId,
      kind: event.kind,
      phase: "phase" in event ? event.phase : event.kind,
      sequence:
        event.kind === "text.delta" ||
        event.kind === "client.delivery_acknowledged"
          ? event.sequence
          : null,
      at: event.at,
    });
  }
  if (activity.length > 256) activity.shift();
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
      setupJourney = { ...setupJourney, open: false };
      selectSection("settings");
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
  required<HTMLButtonElement>("#save-computer-name").addEventListener(
    "click",
    () => {
      const name = required<HTMLInputElement>("#computer-name").value;
      const command = ProductConfigurationCommandSchema.safeParse({
        kind: "computer.rename",
        name,
      });
      if (!command.success) {
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
  pendingTaskSurfaceStatuses.splice(0).forEach(applyTaskSurfaceStatus);
  pendingRuntimeEvents.splice(0).forEach(recordEvent);
  if (pendingLayout) {
    const layout = pendingLayout;
    pendingLayout = null;
    applyHostLayout(layout);
  } else {
    render();
  }
}

void start();
