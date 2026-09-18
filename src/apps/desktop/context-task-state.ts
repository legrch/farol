import type { ProductTaskContext } from "../../modules/chat/contract/product-task";
import type {
  ContextBinding,
  ContextSession,
} from "../../modules/chat/domain/context-continuity";

export function toProductTaskContext(
  session: ContextSession,
): ProductTaskContext {
  return {
    epoch: session.epoch,
    phase: session.phase,
    source:
      session.operation?.source ?? session.lastCompletedRequest?.source ?? null,
    code:
      session.phase === "blocked" || session.phase === "outcome_unknown"
        ? session.blockedCode
        : null,
  };
}

export type TaskContextReconciliation = Readonly<{
  taskId: string;
  context: ProductTaskContext | null;
}>;

/**
 * A task snapshot carries only a copy of its context state; the private
 * context store is the truth. On restart, before any work is admitted, each
 * restored task's visible context is replaced by what the store holds. State
 * the store cannot read is shown as blocked, never as the stale copy, and a
 * task with no stored session shows none.
 */
export async function reconcileTaskContexts(
  taskIds: readonly string[],
  store: Readonly<{
    load(binding: ContextBinding): Promise<ContextSession | null>;
  }>,
  bindingFor: (taskId: string) => ContextBinding,
): Promise<TaskContextReconciliation[]> {
  const reconciled: TaskContextReconciliation[] = [];
  for (const taskId of taskIds) {
    let session: ContextSession | null;
    try {
      session = await store.load(bindingFor(taskId));
    } catch (error) {
      reconciled.push({
        taskId,
        context: {
          epoch: 1,
          phase: "blocked",
          source: null,
          code:
            error instanceof Error && /^CONTEXT_[A-Z_]+$/u.test(error.message)
              ? error.message
              : "CONTEXT_STATE_UNREADABLE",
        },
      });
      continue;
    }
    reconciled.push({
      taskId,
      context: session ? toProductTaskContext(session) : null,
    });
  }
  return reconciled;
}
