import type {
  RouteBConversationSurface,
  RouteBSurfaceAdmission,
} from "./route-b-runtime";

export type TaskContextDeletion = "deleted" | "failed" | "none";

export type TaskCloseResult =
  | Readonly<{ ok: true; contextDeletion: TaskContextDeletion }>
  | Readonly<{
      ok: false;
      code:
        | "TASK_OPERATION_IN_PROGRESS"
        | "AGENT_INPUT_STATE_UNAVAILABLE"
        | "TASK_NOT_FOUND"
        | "TASK_STATE_UNAVAILABLE";
    }>;

// What the lifecycle needs from the product. The task registry, the task
// routes and the private stores stay where they are; the lifecycle only fixes
// the order in which they are consulted and the states that exclude each
// other.
export type RouteBTaskLifecyclePorts<Snapshot> = Readonly<{
  // True while the Route B runtime is preparing, admitting, running or
  // summarizing a turn of the task's thread, so its private context is in use.
  owns(taskId: string): boolean;
  existingSurface(taskId: string): RouteBConversationSurface | null;
  markRunning(taskId: string): void;
  mutationInFlight(): boolean;
  admissionReady(): boolean;
  // Admits the first turn of a thread as a new task: creates its route, saves
  // the task and opens its surface.
  admitTask(threadId: string): Promise<RouteBSurfaceAdmission>;
  removeAgentInput(taskId: string): Promise<void>;
  snapshotTasks(): Snapshot;
  removeTask(taskId: string): boolean;
  rollbackTasks(snapshot: Snapshot): void;
  persist(): Promise<void>;
  deleteContext(taskId: string): Promise<TaskContextDeletion>;
  disposeRoute(taskId: string): void;
}>;

export type RouteBTaskLifecycle = Readonly<{
  surfaceFor(threadId: string): Promise<RouteBSurfaceAdmission>;
  close(taskId: string): Promise<TaskCloseResult>;
  closing(taskId: string): boolean;
}>;

/**
 * A Codex host thread runs in the Farol task with the same identity, the
 * identity continuity binds its checkpoints to. The first turn of a thread
 * admits that task under the same gates and capacity as a new Browser task;
 * later turns reuse its ChatGPT conversation. Closing that task removes it,
 * its private context and its conversation surface, in that order.
 *
 * Admission and close exclude each other. A close is refused while the Route
 * B runtime owns the task's thread, which it does continuously from a turn's
 * preparation through its durable admission to its run; and a close that has
 * won ownership enters its closing state before its first await, so a turn
 * arriving meanwhile is refused before submission instead of running on the
 * surface the close is about to dispose. A task closes as soon as its thread
 * is idle; retained context never locks it.
 */
export function createRouteBTaskLifecycle<Snapshot>(
  ports: RouteBTaskLifecyclePorts<Snapshot>,
): RouteBTaskLifecycle {
  const closing = new Set<string>();
  return {
    closing: (taskId) => closing.has(taskId),
    surfaceFor: async (threadId) => {
      if (closing.has(threadId)) return { ok: false, code: "TASK_CLOSING" };
      const existing = ports.existingSurface(threadId);
      if (existing) {
        ports.markRunning(threadId);
        return { ok: true, surface: existing };
      }
      if (ports.mutationInFlight()) {
        return { ok: false, code: "TASK_ROUTE_BUSY" };
      }
      if (!ports.admissionReady()) {
        return { ok: false, code: "CHATGPT_CONNECTION_NOT_VERIFIED" };
      }
      if (threadId.length < 1 || threadId.length > 120) {
        return { ok: false, code: "TASK_IDENTITY_INVALID" };
      }
      return ports.admitTask(threadId);
    },
    close: async (taskId) => {
      // A turn, summary or held initial request of this task's thread is
      // using its private context right now, or another close is under way.
      if (closing.has(taskId) || ports.owns(taskId)) {
        return { ok: false, code: "TASK_OPERATION_IN_PROGRESS" };
      }
      closing.add(taskId);
      try {
        const before = ports.snapshotTasks();
        try {
          await ports.removeAgentInput(taskId);
        } catch {
          return { ok: false, code: "AGENT_INPUT_STATE_UNAVAILABLE" };
        }
        if (!ports.removeTask(taskId)) {
          return { ok: false, code: "TASK_NOT_FOUND" };
        }
        try {
          await ports.persist();
        } catch {
          ports.rollbackTasks(before);
          return { ok: false, code: "TASK_STATE_UNAVAILABLE" };
        }
        // Only once the removal is saved: a failed deletion then leaves
        // private state of a closed task, not an open task without its
        // context.
        const contextDeletion = await ports.deleteContext(taskId);
        ports.disposeRoute(taskId);
        return { ok: true, contextDeletion };
      } finally {
        closing.delete(taskId);
      }
    },
  };
}
