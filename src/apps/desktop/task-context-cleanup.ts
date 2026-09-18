import type { ProductTaskContext } from "../../modules/chat/contract/product-task";
import type { ContextBinding } from "../../modules/chat/domain/context-continuity";

// Phases in which a context transition is still moving between stores; the
// task's private state cannot be deleted under it.
const TRANSITIONAL = new Set<ProductTaskContext["phase"]>([
  "quiescing",
  "checkpoint_requested",
  "validated",
  "durably_stored",
  "handoff_offered",
  "host_context_confirmed",
  "old_epoch_retired",
]);

export type TaskContextCleanup = "deleted" | "in_transition" | "failed";

/**
 * Closing a task deletes its private context state: sessions, checkpoints,
 * sources and summaries live only in Next-owned storage and must not outlive
 * the task. A transition in progress refuses the close explicitly instead of
 * deleting state under it; a failed deletion refuses it too, so nothing of the
 * task is dropped from view while its private state remains.
 */
export async function deleteTaskContext(
  store: Readonly<{ deleteTask(binding: ContextBinding): Promise<void> }>,
  binding: ContextBinding,
  context: ProductTaskContext | null | undefined,
): Promise<TaskContextCleanup> {
  if (context && TRANSITIONAL.has(context.phase)) return "in_transition";
  try {
    await store.deleteTask(binding);
    return "deleted";
  } catch {
    return "failed";
  }
}
