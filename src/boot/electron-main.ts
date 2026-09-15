import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  utilityProcess,
  WebContentsView,
  type Input,
  type UtilityProcess,
} from "electron";
import path from "node:path";
import { z } from "zod";
import { ClientEventSchema } from "../modules/chat/contract/client-event";
import { channels } from "../pkg/ipc/channels";
import type { RuntimeStatus } from "../pkg/ipc/runtime-status";

const directory = __dirname;
const productName = "Farol Next Preview";
const bundleId = "local.farol.next.preview";
const ownerTasks = [
  {
    taskId: "task-atlantic",
    sessionId: "session-atlantic",
    turnId: "turn-atlantic-1",
    label: "Atlantic workspace check",
    hasComputer: true,
  },
  {
    taskId: "task-harbor",
    sessionId: "session-harbor",
    turnId: "turn-harbor-1",
    label: "Harbor research stream",
    hasComputer: false,
  },
] as const;

const readySchema = z.strictObject({
  kind: z.literal("runtime.ready"),
  identity: z.literal("farol-next-preview-runtime"),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(32),
  tasks: z.array(
    z.strictObject({
      taskId: z.string(),
      sessionId: z.string(),
      turnId: z.string(),
      label: z.string(),
      hasComputer: z.boolean(),
    }),
  ),
  embeddedNode: z.string(),
  embeddedElectron: z.string(),
});
const layoutSchema = z.strictObject({
  section: z.enum(["browser", "computer", "activity", "settings"]),
  taskId: z.string(),
});
const controlSchema = z.strictObject({
  taskId: z.string(),
  action: z.enum(["release-tool", "release-completion"]),
});

type RuntimeReady = z.infer<typeof readySchema>;
type Section = z.infer<typeof layoutSchema>["section"];

app.setName(productName);
if (process.platform === "win32") app.setAppUserModelId(bundleId);

let window: BrowserWindow | null = null;
let runtimeChild: UtilityProcess | null = null;
let runtime: RuntimeReady | null = null;
let runtimeState: "starting" | "ready" | "offline" | "failed" = "starting";
let runtimeError: string | null = null;
let runtimeStopping = false;
let section: Section = "browser";
let selectedTaskId: string = ownerTasks[0].taskId;
const taskViews = new Map<string, WebContentsView>();
const streamControllers: AbortController[] = [];

function runtimeBase(): string | null {
  return runtime ? `http://127.0.0.1:${runtime.port}` : null;
}

function bootstrap() {
  return {
    schema: 1,
    productName,
    bundleId,
    runtimeState,
    runtimeError,
    runtimeIdentity: runtime?.identity ?? null,
    embeddedNode: runtime?.embeddedNode ?? null,
    embeddedElectron: runtime?.embeddedElectron ?? process.versions.electron,
    tasks: runtime?.tasks ?? ownerTasks,
    partition: "persist:farol-next-preview",
    updateChannel: "local-preview-only",
    nativeFilesystem: false,
    nativeAgent: false,
    liveProvider: false,
  };
}

function currentRuntimeStatus(): RuntimeStatus {
  return {
    state: runtimeState,
    error: runtimeError,
    identity: runtime?.identity ?? null,
    embeddedNode: runtime?.embeddedNode ?? null,
    embeddedElectron: runtime?.embeddedElectron ?? process.versions.electron,
  };
}

function publishRuntimeStatus(): void {
  window?.webContents.send(channels.runtimeState, currentRuntimeStatus());
}

function hideTaskViews(): void {
  for (const view of taskViews.values()) {
    view.setVisible(false);
  }
}

function stopStreams(): void {
  streamControllers.splice(0).forEach((controller) => controller.abort());
}

function handleRuntimeExit(code: number | null): void {
  if (runtimeStopping) return;
  runtimeChild = null;
  runtime = null;
  runtimeState = "failed";
  runtimeError =
    code === 0 ? "RUNTIME_PROCESS_EXITED" : "RUNTIME_PROCESS_FAILED";
  stopStreams();
  hideTaskViews();
  publishRuntimeStatus();
}

async function startRuntime(): Promise<void> {
  runtimeStopping = false;
  const child = utilityProcess.fork(path.join(directory, "runtime.cjs"), [], {
    env: {
      LANG: process.env.LANG ?? "en_US.UTF-8",
      FAROL_NEXT_PREVIEW_SCENARIO: process.argv.includes("--preview-failure")
        ? "failure"
        : "normal",
    },
    serviceName: "Farol Next Runtime",
    stdio: "ignore",
  });
  runtimeChild = child;
  try {
    runtime = await new Promise<RuntimeReady>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("RUNTIME_START_TIMEOUT"));
      }, 10_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (settled) {
          handleRuntimeExit(code);
          return;
        }
        settled = true;
        reject(
          new Error(
            code === 0 ? "RUNTIME_EXITED" : `RUNTIME_START_FAILED_${code}`,
          ),
        );
      });
      child.on("message", (message) => {
        const parsed = readySchema.safeParse(message);
        if (!parsed.success || settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(parsed.data);
      });
    });
    runtimeState = "ready";
  } catch (error) {
    runtimeState = "failed";
    runtimeError =
      error instanceof Error ? error.message : "RUNTIME_START_FAILED";
    runtimeStopping = true;
    child.kill();
    runtimeChild = null;
  }
}

function partitionName(): string {
  return "persist:farol-next-preview";
}

function installNetworkFence(): Electron.Session | null {
  const base = runtimeBase();
  if (!base) return null;
  const isolated = session.fromPartition(partitionName(), { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${base}/`) });
  });
  return isolated;
}

function handleShortcut(input: Input): boolean {
  const index = ownerTasks.findIndex((task) => task.taskId === selectedTaskId);
  if (input.control && input.key === "Tab") {
    const direction = input.shift ? -1 : 1;
    const next = (index + direction + ownerTasks.length) % ownerTasks.length;
    selectedTaskId = ownerTasks[next]?.taskId ?? selectedTaskId;
    section = "browser";
    applyLayout();
    window?.webContents.send(channels.layout, {
      section,
      taskId: selectedTaskId,
    });
    return true;
  }
  if (input.meta && /^[1-4]$/u.test(input.key)) {
    section = ["browser", "computer", "activity", "settings"][
      Number(input.key) - 1
    ] as Section;
    applyLayout();
    window?.webContents.send(channels.layout, {
      section,
      taskId: selectedTaskId,
    });
    return true;
  }
  return false;
}

function applyLayout(): void {
  if (!window) return;
  const size = window.getContentSize();
  const width = size[0] ?? 1;
  const height = size[1] ?? 1;
  const rail = width < 760 ? 64 : 176;
  for (const [taskId, view] of taskViews) {
    const visible = section === "browser" && taskId === selectedTaskId;
    view.setVisible(visible);
    view.setBounds({
      x: rail,
      y: 72,
      width: Math.max(1, width - rail),
      height: Math.max(1, height - 72),
    });
  }
}

async function createTaskViews(): Promise<void> {
  if (!window || !runtime) return;
  const base = runtimeBase();
  if (!base || !installNetworkFence()) return;
  for (const task of runtime.tasks) {
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionName(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    taskViews.set(task.taskId, view);
    window.contentView.addChildView(view);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${base}/`)) event.preventDefault();
    });
    view.webContents.on("before-input-event", (event, input) => {
      if (handleShortcut(input)) event.preventDefault();
    });
    await view.webContents.loadURL(
      `${base}/task/${encodeURIComponent(task.taskId)}`,
      {
        extraHeaders: `Authorization: Bearer ${runtime.token}\n`,
      },
    );
  }
  applyLayout();
}

async function consumeSse(taskId: string): Promise<void> {
  if (!runtime || !window) return;
  const controller = new AbortController();
  streamControllers.push(controller);
  const response = await fetch(
    `http://127.0.0.1:${runtime.port}/events/${encodeURIComponent(taskId)}`,
    {
      headers: { authorization: `Bearer ${runtime.token}` },
      signal: controller.signal,
    },
  );
  if (!response.ok || !response.body)
    throw new Error("RUNTIME_STREAM_UNAVAILABLE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  while (!controller.signal.aborted) {
    const part = await reader.read();
    if (part.done) {
      if (!controller.signal.aborted) throw new Error("RUNTIME_STREAM_ENDED");
      break;
    }
    carry += decoder.decode(part.value, { stream: true });
    const frames = carry.split("\n\n");
    carry = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (!data) continue;
      const parsed = ClientEventSchema.safeParse(JSON.parse(data));
      if (!parsed.success) throw new Error("RUNTIME_EVENT_INVALID");
      window?.webContents.send(channels.runtimeEvent, parsed.data);
    }
  }
}

async function runtimeJson(pathname: string, method = "GET"): Promise<unknown> {
  if (!runtime) return { error: "RUNTIME_OFFLINE" };
  const response = await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  if (response.status === 204) return { ok: true };
  const value = (await response.json()) as unknown;
  return response.ok ? value : { ok: false, status: response.status, value };
}

function installIpc(): void {
  ipcMain.handle(channels.bootstrap, (event) =>
    event.sender === window?.webContents
      ? bootstrap()
      : { error: "IPC_SENDER_DENIED" },
  );
  ipcMain.handle(channels.snapshot, (event) =>
    event.sender === window?.webContents
      ? runtimeJson("/snapshot")
      : { error: "IPC_SENDER_DENIED" },
  );
  ipcMain.handle(channels.control, async (event, value: unknown) => {
    if (event.sender !== window?.webContents)
      return { error: "IPC_SENDER_DENIED" };
    const parsed = controlSchema.safeParse(value);
    if (
      !parsed.success ||
      !ownerTasks.some((task) => task.taskId === parsed.data.taskId)
    ) {
      return { error: "IPC_CONTROL_INVALID" };
    }
    return runtimeJson(
      `/control/${encodeURIComponent(parsed.data.taskId)}/${parsed.data.action}`,
      "POST",
    );
  });
  ipcMain.on(channels.layout, (event, value: unknown) => {
    if (event.sender !== window?.webContents) return;
    const parsed = layoutSchema.safeParse(value);
    if (
      !parsed.success ||
      !ownerTasks.some((task) => task.taskId === parsed.data.taskId)
    )
      return;
    section = parsed.data.section;
    selectedTaskId = parsed.data.taskId;
    applyLayout();
  });
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    title: productName,
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 520,
    backgroundColor: "#0d1821",
    show: false,
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("before-input-event", (event, input) => {
    if (handleShortcut(input)) event.preventDefault();
  });
  window.on("resize", applyLayout);
  window.on("closed", () => {
    runtimeStopping = true;
    stopStreams();
    runtimeChild?.postMessage("shutdown");
    taskViews.clear();
    window = null;
  });
  await window.loadFile(path.join(directory, "shell.html"));
  await createTaskViews();
  for (const task of runtime?.tasks ?? []) {
    void consumeSse(task.taskId).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      if (runtimeState !== "ready") return;
      runtimeState = "failed";
      runtimeError = "RUNTIME_STREAM_FAILED";
      stopStreams();
      hideTaskViews();
      publishRuntimeStatus();
    });
  }
  window.show();
}

async function main(): Promise<void> {
  await app.whenReady();
  installIpc();
  await startRuntime();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}

void main().catch(() => app.exit(1));
