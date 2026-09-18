import type { ContextBinding } from "../../modules/chat/domain/context-continuity";

export type TaskContextCleanup = "deleted" | "failed";

/**
 * Closing a task deletes its private context state: sessions, checkpoints,
 * sources and summaries live only in Next-owned storage and must not outlive
 * the task. The caller refuses the close while this process owns the task's
 * thread; a transition phase an earlier run left behind has no owner and
 * nothing resumes it, so it does not keep the task from closing. The task's
 * removal is saved first, so a failed deletion leaves only private state of a
 * task that is already gone, never a task whose state was deleted under it.
 */
export async function deleteTaskContext(
  store: Readonly<{ deleteTask(binding: ContextBinding): Promise<void> }>,
  binding: ContextBinding,
): Promise<TaskContextCleanup> {
  try {
    await store.deleteTask(binding);
    return "deleted";
  } catch {
    return "failed";
  }
}
