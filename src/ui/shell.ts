import { z } from "zod";
import {
  ClientEventSchema,
  type ClientEventDto,
} from "../modules/chat/contract/client-event";
import {
  RuntimeStatusSchema,
  type RuntimeStatus,
} from "../pkg/ipc/runtime-status";

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

declare global {
  interface Window {
    farolNext: Readonly<{
      bootstrap(): Promise<unknown>;
      snapshot(): Promise<unknown>;
      control(taskId: string, action: string): Promise<unknown>;
      layout(section: string, taskId: string): void;
      onRuntimeEvent(listener: (event: unknown) => void): () => void;
      onRuntimeState(listener: (status: unknown) => void): () => void;
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
const taskEvents = new Map<string, ClientEventDto[]>();
const activity: SafeActivity[] = [];
const pendingRuntimeEvents: ClientEventDto[] = [];
let pendingRuntimeStatus: RuntimeStatus | null = null;
let pendingLayout: z.infer<typeof layoutSchema> | null = null;

function statusFor(taskId: string): string {
  if (bootstrap.runtimeState !== "ready") {
    return bootstrap.runtimeState === "failed" ? "Runtime failed" : "Offline";
  }
  const events = taskEvents.get(taskId) ?? [];
  const last = events.at(-1);
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
  loading.textContent =
    bootstrap.runtimeState === "ready"
      ? "Opening isolated task surface…"
      : bootstrap.runtimeState === "offline"
        ? "Local runtime is offline. Open Settings for the recorded reason."
        : bootstrap.runtimeState === "failed"
          ? "Task surfaces are unavailable because the local runtime failed."
          : "Preparing isolated task surfaces…";
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
  completion.disabled = bootstrap.runtimeState !== "ready" || terminal;
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
    !waiting || closedAfter || bootstrap.runtimeState !== "ready";
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
  list.replaceChildren(
    ...visible.map((record) => {
      const item = document.createElement("li");
      const dot = document.createElement("i");
      const task = document.createElement("code");
      task.textContent = record.taskId;
      const message = document.createElement("b");
      message.textContent = record.kind.replaceAll(".", " ");
      const phase = document.createElement("span");
      phase.textContent =
        record.sequence === null ? record.phase : `delta ${record.sequence}`;
      item.append(dot, task, message, phase);
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
  if (notifyHost) window.farolNext.layout(section, selectedTaskId);
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
  activity.push({
    taskId: event.taskId,
    kind: event.kind,
    phase: "phase" in event ? event.phase : event.kind,
    sequence: event.kind === "text.delta" ? event.sequence : null,
    at: event.at,
  });
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
  bootstrapReady = true;
  if (pendingRuntimeStatus) applyRuntimeStatus(pendingRuntimeStatus);
  pendingRuntimeEvents.splice(0).forEach(recordEvent);
  if (pendingLayout) {
    section = pendingLayout.section;
    selectedTaskId = pendingLayout.taskId;
    pendingLayout = null;
  }
  window.addEventListener("keydown", (event) => {
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
