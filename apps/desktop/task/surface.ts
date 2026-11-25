import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type { TaskSurfaceStatus } from "../../../src/pkg/ipc/task-surface-status";

// The live-task surface: publishing the task list to the window, the command
// results every task command returns, the lifecycle a settled route sets and
// the load of a task's surface. Main keeps every owner, the persistence, the
// layout and the window; the window is a late getter here, so a change made
// while a surface loads is seen at the next publish. The registry, the route
// and failure maps and the admission are the owners' own objects, shared by
// reference. The result is parsed by the caller's schema and its type is the
// caller's: nothing here knows that contract. Nothing here retries: a failed
// save is surfaced as an unknown outcome, never repeated, and a surface that
// cannot be loaded is classified once.

type Lifecycle = Parameters<LiveTaskRegistry["setLifecycle"]>[1];

export type TaskSurfacePorts<Result> = Readonly<{
  currentWindow: () => Readonly<{
    webContents: Readonly<{
      send: (channel: string, state: unknown) => void;
    }>;
  }> | null;
  demoMode: boolean;
  channels: Readonly<{ tasksState: string }>;
  desktopAdmission: Readonly<{ closed: () => boolean }>;
  liveTaskRegistry: Pick<LiveTaskRegistry, "get" | "snapshot" | "setLifecycle">;
  liveTaskRoutes: Map<string, Pick<ChatGptRoute, "open">>;
  taskSurfaceFailures: Map<string, string>;
  parseResult: (candidate: unknown) => Result;
  persistLiveTaskState: () => Promise<void>;
  publishTaskSurfaceStatus: (status: TaskSurfaceStatus) => void;
  applyLayout: () => void;
  focusForLayoutAfterRendererCommit: () => void;
}>;

export function createTaskSurface<Result>(ports: TaskSurfacePorts<Result>) {
  const {
    currentWindow,
    demoMode,
    channels,
    desktopAdmission,
    liveTaskRegistry,
    liveTaskRoutes,
    taskSurfaceFailures,
    parseResult,
    persistLiveTaskState,
    publishTaskSurfaceStatus,
    applyLayout,
    focusForLayoutAfterRendererCommit,
  } = ports;

  function publishTasksState(): void {
    if (demoMode) return;
    currentWindow()?.webContents.send(
      channels.tasksState,
      liveTaskRegistry.snapshot(),
    );
  }

  function taskFailure(error: string): Result {
    return parseResult({
      ok: false,
      error,
      state: liveTaskRegistry.snapshot(),
    });
  }

  function taskSuccess(taskId: string | null): Result {
    return parseResult({
      ok: true,
      state: liveTaskRegistry.snapshot(),
      selectedTaskId: taskId,
    });
  }

  function surfaceLiveTaskPersistenceFailure(taskId: string): void {
    if (!liveTaskRegistry.get(taskId)) return;
    liveTaskRegistry.setLifecycle(taskId, "outcome_unknown");
    publishTasksState();
  }

  function setLiveTaskLifecycle(taskId: string, lifecycle: Lifecycle): void {
    if (liveTaskRegistry.get(taskId)?.lifecycle === lifecycle) return;
    if (!liveTaskRegistry.setLifecycle(taskId, lifecycle)) return;
    publishTasksState();
    void persistLiveTaskState().catch(() =>
      surfaceLiveTaskPersistenceFailure(taskId),
    );
  }

  async function openLiveTaskSurface(taskId: string): Promise<boolean> {
    if (desktopAdmission.closed()) return false;
    const route = liveTaskRoutes.get(taskId);
    const task = liveTaskRegistry.get(taskId);
    if (!route || !task) return false;
    const currentTask = () => {
      const current = liveTaskRegistry.get(taskId);
      return liveTaskRoutes.get(taskId) === route &&
        current?.sessionId === task.sessionId &&
        current.turnId === task.turnId
        ? current
        : null;
    };
    const recordSurfaceFailure = () => {
      if (!currentTask()) return;
      const error = "TASK_SURFACE_UNREACHABLE";
      taskSurfaceFailures.set(taskId, error);
      try {
        publishTaskSurfaceStatus({ taskId, state: "failed", error });
      } catch {
        // An unavailable observer cannot replace the classified load failure.
      }
      const current = currentTask();
      // Loading a surface does not resolve an existing Task obligation or
      // replace a completion already observed by the activity owner.
      if (
        !current ||
        current.lifecycle === "running" ||
        current.lifecycle === "outcome_unknown" ||
        current.lifecycle === "completed"
      )
        return;
      try {
        setLiveTaskLifecycle(taskId, "failed");
      } catch {
        // Keep the original route outcome and recorded surface failure when
        // the existing lifecycle owner's synchronous publication cannot finish.
      }
    };
    try {
      const opened = await route.open();
      if (!currentTask()) return false;
      if (opened.status !== "opened") {
        recordSurfaceFailure();
        return false;
      }
      // Live ChatGPT surfaces also publish their observed load result. Without
      // this, renderer controls requiring a ready selected page never appear.
      taskSurfaceFailures.delete(taskId);
      publishTaskSurfaceStatus({ taskId, state: "ready", error: null });
      const current = currentTask();
      if (!current) return false;
      if (current.lifecycle === "failed") {
        setLiveTaskLifecycle(taskId, "idle");
      }
      if (!currentTask()) return false;
      applyLayout();
      if (!currentTask()) return false;
      focusForLayoutAfterRendererCommit();
      return currentTask() !== null;
    } catch {
      recordSurfaceFailure();
      return false;
    }
  }

  return {
    publishTasksState,
    taskFailure,
    taskSuccess,
    surfaceLiveTaskPersistenceFailure,
    setLiveTaskLifecycle,
    openLiveTaskSurface,
  };
}
