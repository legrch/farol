import {
  sameContextBinding,
  type ContextBinding,
} from "../../modules/chat/domain/context-continuity";

export type TaskContextCleanup = "deleted" | "failed";

// The Computer connector's execution fence, by the task that raised it: a
// task that is gone has no owner left to observe its summaries, so its
// records go with its context. A release that fails leaves them up.
export type TaskExecutionFence = Readonly<{
  release(taskId: string): Promise<void>;
}>;

/**
 * Closing a task deletes its private context state: sessions, checkpoints,
 * sources and summaries live only in Farol-owned storage and must not outlive
 * the task. The caller refuses the close while this process owns the task's
 * thread; a transition phase an earlier run left behind has no owner and
 * nothing resumes it, so it does not keep the task from closing. The task's
 * removal is saved first, so a failed deletion leaves only private state of a
 * task that is already gone, never a task whose state was deleted under it.
 */
export async function deleteTaskContext(
  store: Readonly<{ deleteTask(binding: ContextBinding): Promise<void> }>,
  binding: ContextBinding,
  fence?: TaskExecutionFence,
): Promise<TaskContextCleanup> {
  try {
    await store.deleteTask(binding);
  } catch {
    return "failed";
  }
  await fence?.release(binding.taskId).catch(() => undefined);
  return "deleted";
}

export type OrphanContextSweep = Readonly<{
  // Task ids whose private context was deleted because no live task owns it.
  swept: readonly string[];
  // Directories left in place: their session could not be read, so their
  // owner is unknown; or their deletion failed.
  unreadable: number;
  failed: readonly string[];
}>;

export type LiveTaskInventory =
  | Readonly<{ status: "loaded"; taskIds: readonly string[] }>
  // The task registry could not be read: nothing is known to be an orphan.
  | Readonly<{ status: "unavailable" }>;

/**
 * Private context a closed task left behind, for example when its deletion
 * failed after the task's removal was already saved, is removed at the next
 * start, once the live task registry has been read for real. An unreadable
 * registry is not an empty one: then nothing is swept. Only a directory whose
 * session names this product's exact binding for a task that is not live is
 * deleted; an unreadable session keeps its directory. Sweeping twice changes
 * nothing, and a live task's context is never touched.
 */
export async function sweepOrphanTaskContexts(
  store: Readonly<{
    listTaskBindings(): Promise<
      ReadonlyArray<
        | Readonly<{ readable: true; binding: ContextBinding }>
        | Readonly<{ readable: false; key: string }>
      >
    >;
    deleteTask(binding: ContextBinding): Promise<void>;
  }>,
  inventory: LiveTaskInventory,
  bindingFor: (taskId: string) => ContextBinding,
  fence?: TaskExecutionFence,
): Promise<OrphanContextSweep> {
  if (inventory.status !== "loaded") {
    return { swept: [], unreadable: 0, failed: [] };
  }
  const live = new Set(inventory.taskIds);
  const swept: string[] = [];
  const failed: string[] = [];
  let unreadable = 0;
  for (const entry of await store.listTaskBindings()) {
    if (!entry.readable) {
      unreadable += 1;
      continue;
    }
    const { binding } = entry;
    if (
      live.has(binding.taskId) ||
      !sameContextBinding(binding, bindingFor(binding.taskId))
    ) {
      continue;
    }
    try {
      await store.deleteTask(binding);
    } catch {
      failed.push(binding.taskId);
      continue;
    }
    await fence?.release(binding.taskId).catch(() => undefined);
    swept.push(binding.taskId);
  }
  return { swept, unreadable, failed };
}
