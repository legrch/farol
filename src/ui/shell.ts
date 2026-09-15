import { z } from "zod";
import {
  ClientEventSchema,
  type ClientEventDto,
} from "../modules/chat/contract/client-event";
import {
  RuntimeStatusSchema,
  type RuntimeStatus,
} from "../pkg/ipc/runtime-status";
import {
  TaskSurfaceStatusSchema,
  type TaskSurfaceStatus,
} from "../pkg/ipc/task-surface-status";
import {
  advanceSetup,
  createSetupJourney,
  reopenSetup,
  retreatSetup,
  setupSteps,
} from "./setup-journey";

const bootstrapSchema = z.strictObject({
  schema: z.literal(1),
  productName: z.literal("Farol Next Preview"),
  bundleId: z.literal("local.farol.next.preview"),
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
  updateChannel: z.literal("local-preview-only"),
  nativeFilesystem: z.literal(false),
  nativeAgent: z.literal(false),
  liveProvider: z.literal(false),
});

const controlSuccessSchema = z.strictObject({ ok: z.literal(true) });
const layoutSchema = z.strictObject({
  section: z.enum(["browser", "computer", "activity", "settings"]),
  taskId: z.string(),
  setupOpen: z.boolean(),
});

type Bootstrap = z.infer<typeof bootstrapSchema>;
type Section = "browser" | "computer" | "activity" | "settings";
type SafeActivity = Readonly<{
  taskId: string;
  kind: string;
  phase: string;
  sequence: number | null;
  at: number;
}>;

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
      control(taskId: string, action: string): Promise<unknown>;
      layout(section: string, taskId: string, setupOpen: boolean): void;
      onRuntimeEvent(listener: (event: unknown) => void): () => void;
      onRuntimeState(listener: (status: unknown) => void): () => void;
      onTaskSurfaceState(listener: (status: unknown) => void): () => void;
      onLayout(listener: (layout: unknown) => void): () => void;
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

let bootstrap: Bootstrap;
let bootstrapReady = false;
let section: Section = "browser";
let selectedTaskId = "";
let setupJourney = createSetupJourney();
let setupFocusKey = "";
const taskEvents = new Map<string, ClientEventDto[]>();
const activity: SafeActivity[] = [];
const pendingRuntimeEvents: ClientEventDto[] = [];
let pendingRuntimeStatus: RuntimeStatus | null = null;
const pendingTaskSurfaceStatuses: TaskSurfaceStatus[] = [];
let pendingLayout: z.infer<typeof layoutSchema> | null = null;
const taskSurfaceStatuses = new Map<string, TaskSurfaceStatus>();

function statusFor(taskId: string): string {
  if (bootstrap.runtimeState !== "ready") {
    return bootstrap.runtimeState === "failed" ? "Runtime failed" : "Offline";
  }
  if (taskSurfaceStatuses.get(taskId)?.state === "failed") {
    return "Surface failed";
  }
  const events = taskEvents.get(taskId) ?? [];
  const last = events
    .filter((event) => event.kind !== "client.delivery_acknowledged")
    .at(-1);
  if (!last)
    return bootstrap.runtimeState === "ready" ? "Connecting" : "Offline";
  if (last.kind === "turn.terminal")
    return last.phase === "completed" ? "Complete" : "Needs attention";
  if (last.kind === "computer.requested") return "Computer waiting";
  if (last.kind === "computer.completed") return "Result returned";
  if (last.kind === "text.delta") return "Streaming";
  return last.phase.replaceAll("_", " ");
}

function renderRuntime(): void {
  const pill = required<HTMLDivElement>("#runtime-pill");
  pill.className = `runtime-pill ${bootstrap.runtimeState === "ready" ? "ready" : bootstrap.runtimeState === "starting" ? "" : "failed"}`;
  required<HTMLElement>("#runtime-pill b").textContent =
    bootstrap.runtimeState === "ready"
      ? "Local runtime"
      : bootstrap.runtimeState;
}

function renderBrowser(): void {
  const loading = required<HTMLDivElement>("#browser-loading");
  const title = required<HTMLElement>("#browser-state-title");
  const detail = required<HTMLElement>("#browser-state-detail");
  const mark = required<HTMLElement>("#browser-state-mark");
  loading.classList.toggle(
    "failed",
    bootstrap.runtimeState === "offline" || bootstrap.runtimeState === "failed",
  );
  if (bootstrap.runtimeState === "ready") {
    mark.textContent = "◌";
    title.textContent = "Opening task surface";
    detail.textContent = "The selected isolated Browser view is ready.";
  } else if (bootstrap.runtimeState === "offline") {
    mark.textContent = "!";
    title.textContent = "Local runtime is offline";
    detail.textContent =
      "Your task state is not being replayed. Open Settings for the recorded reason.";
  } else if (bootstrap.runtimeState === "failed") {
    mark.textContent = "!";
    title.textContent = "Task surfaces are unavailable";
    detail.textContent =
      "The local runtime stopped. Do not resubmit an uncertain task automatically.";
  } else {
    mark.textContent = "◌";
    title.textContent = "Preparing task surfaces";
    detail.textContent = "Starting the isolated local runtime…";
  }
}

function renderTabs(): void {
  const selectedEvents = taskEvents.get(selectedTaskId) ?? [];
  const terminal = selectedEvents.some(
    (event) => event.kind === "turn.terminal",
  );
  const tabs = required<HTMLDivElement>("#task-tabs");
  tabs.replaceChildren(
    ...bootstrap.tasks.map((task) => {
      const button = document.createElement("button");
      button.className = `task-tab ${task.taskId === selectedTaskId ? "active" : ""}`;
      button.dataset.taskId = task.taskId;
      button.setAttribute("role", "tab");
      button.setAttribute(
        "aria-selected",
        String(task.taskId === selectedTaskId),
      );
      const label = document.createElement("span");
      label.textContent = task.label;
      const status = document.createElement("small");
      status.textContent = statusFor(task.taskId);
      button.append(label, status);
      button.addEventListener("click", () => selectTask(task.taskId));
      return button;
    }),
  );
  const completion = required<HTMLButtonElement>("#release-completion");
  completion.disabled =
    bootstrap.runtimeState !== "ready" ||
    taskSurfaceStatuses.get(selectedTaskId)?.state === "failed" ||
    terminal;
}

function renderComputer(): void {
  const events = taskEvents.get(selectedTaskId) ?? [];
  let waitingIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind !== "computer.requested") continue;
    waitingIndex = index;
    break;
  }
  const waiting = waitingIndex >= 0 ? events[waitingIndex] : undefined;
  const closedAfter = waiting
    ? events
        .slice(waitingIndex + 1)
        .some(
          (event) =>
            event.kind === "computer.completed" ||
            event.kind === "turn.terminal",
        )
    : false;
  const button = required<HTMLButtonElement>("#approve-tool");
  button.disabled =
    !waiting ||
    closedAfter ||
    bootstrap.runtimeState !== "ready" ||
    taskSurfaceStatuses.get(selectedTaskId)?.state === "failed";
  required("#computer-summary").textContent =
    waiting && !closedAfter
      ? "One task is waiting for your bounded approval."
      : "No request is waiting.";
  required("#computer-title").textContent =
    waiting && !closedAfter
      ? "Inspect synthetic fixture status"
      : "Synthetic fixture only";
  required("#computer-detail").textContent =
    waiting && !closedAfter
      ? "Target: fixture workspace status. No path, file content or command is exposed."
      : "This preview cannot read files or run commands on your Mac.";
}

function renderActivity(): void {
  const list = required<HTMLOListElement>("#activity-list");
  const visible = activity.slice(-14).reverse();
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
        bootstrap.tasks.find((candidate) => candidate.taskId === record.taskId)
          ?.label ?? "Unknown task";
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

function renderSettings(): void {
  const values = [
    ["Application", `${bootstrap.productName} · ${bootstrap.bundleId}`],
    [
      "Runtime",
      `${bootstrap.runtimeState} · ${bootstrap.runtimeIdentity ?? "not started"}${bootstrap.runtimeError ? ` · ${bootstrap.runtimeError}` : ""}`,
    ],
    [
      "Embedded closure",
      `Electron ${bootstrap.embeddedElectron ?? "unknown"} · Node ${bootstrap.embeddedNode ?? "unknown"}`,
    ],
    ["Browser partition", bootstrap.partition],
    ["Update channel", bootstrap.updateChannel],
    [
      "Native access",
      "Filesystem unavailable · Agent unavailable · live provider unavailable",
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
  dialog.dataset.mode = setupJourney.mode;
  dialog.dataset.stepId = step.id;
  required("#setup-eyeline").textContent = step.eyeline;
  required("#setup-title").textContent = step.title;
  required("#setup-copy").textContent = step.copy;
  const status = required<HTMLDivElement>("#setup-status");
  status.className = `setup-status ${step.tone}`;
  required<HTMLElement>("#setup-status strong").textContent =
    step.id === "verify" && bootstrap.runtimeState !== "ready"
      ? "Local runtime unavailable"
      : step.status;
  const details = required<HTMLUListElement>("#setup-details");
  details.replaceChildren(
    ...step.details.map((detail) => {
      const item = document.createElement("li");
      item.textContent = detail;
      return item;
    }),
  );
  document
    .querySelectorAll<HTMLElement>("[data-setup-progress]")
    .forEach((item, index) => {
      item.classList.toggle("complete", index < setupJourney.step);
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
  if (!dialog.open) dialog.showModal();
  const focusKey = `${setupJourney.mode}:${setupJourney.step}`;
  if (setupFocusKey !== focusKey) {
    setupFocusKey = focusKey;
    queueMicrotask(() => required<HTMLButtonElement>("#setup-next").focus());
  }
}

function render(notifyHost = true): void {
  document.querySelectorAll<HTMLElement>(".nav-item").forEach((item) => {
    const active = item.dataset.section === section;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.querySelectorAll<HTMLElement>(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === section);
  });
  renderRuntime();
  renderBrowser();
  renderTabs();
  renderComputer();
  renderActivity();
  renderSettings();
  renderSetup();
  if (notifyHost)
    window.farolNext.layout(section, selectedTaskId, setupJourney.open);
}

function selectTask(taskId: string): void {
  if (!bootstrap.tasks.some((task) => task.taskId === taskId)) return;
  selectedTaskId = taskId;
  section = "browser";
  render();
  document
    .querySelector<HTMLButtonElement>(
      `.task-tab[data-task-id="${CSS.escape(taskId)}"]`,
    )
    ?.focus();
}

function selectSection(next: Section): void {
  section = next;
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
  if (!bootstrap.tasks.some((task) => task.taskId === status.taskId)) return;
  taskSurfaceStatuses.set(status.taskId, status);
  render();
}

async function start(): Promise<void> {
  window.farolNext.onLayout((value) => {
    const parsed = layoutSchema.safeParse(value);
    if (!parsed.success) return;
    if (!bootstrapReady) {
      pendingLayout = parsed.data;
      return;
    }
    if (!bootstrap.tasks.some((task) => task.taskId === parsed.data.taskId))
      return;
    section = parsed.data.section;
    selectedTaskId = parsed.data.taskId;
    render(false);
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
  selectedTaskId = bootstrap.tasks[0]?.taskId ?? "";
  document
    .querySelectorAll<HTMLButtonElement>(".nav-item")
    .forEach((button) => {
      button.addEventListener("click", () =>
        selectSection(button.dataset.section as Section),
      );
    });
  required<HTMLButtonElement>("#approve-tool").addEventListener(
    "click",
    async () => {
      const result = await window.farolNext.control(
        selectedTaskId,
        "release-tool",
      );
      if (!controlSuccessSchema.safeParse(result).success) return;
      required<HTMLButtonElement>("#approve-tool").disabled = true;
    },
  );
  required<HTMLButtonElement>("#release-completion").addEventListener(
    "click",
    async () => {
      await window.farolNext.control(selectedTaskId, "release-completion");
    },
  );
  required<HTMLButtonElement>("#setup-back").addEventListener("click", () => {
    setupJourney = retreatSetup(setupJourney);
    render();
  });
  required<HTMLButtonElement>("#setup-next").addEventListener("click", () => {
    const wasFirstRun = setupJourney.mode === "first-run";
    setupJourney = advanceSetup(setupJourney);
    if (!setupJourney.open && wasFirstRun) section = "browser";
    render();
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
  bootstrapReady = true;
  if (pendingRuntimeStatus) applyRuntimeStatus(pendingRuntimeStatus);
  pendingTaskSurfaceStatuses.splice(0).forEach(applyTaskSurfaceStatus);
  pendingRuntimeEvents.splice(0).forEach(recordEvent);
  if (pendingLayout) {
    section = pendingLayout.section;
    selectedTaskId = pendingLayout.taskId;
    pendingLayout = null;
  }
  window.addEventListener("keydown", (event) => {
    if (setupJourney.open) return;
    if (event.metaKey && /^[1-4]$/u.test(event.key)) {
      event.preventDefault();
      selectSection(
        ["browser", "computer", "activity", "settings"][
          Number(event.key) - 1
        ] as Section,
      );
    } else if (event.ctrlKey && event.key === "Tab") {
      event.preventDefault();
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
  render();
}

void start();
