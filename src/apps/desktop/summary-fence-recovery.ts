import type {
  PrivateContextStore,
  StoredContextSummaryAttempt,
} from "../../modules/chat/infra/repo/private-context-store";

export type SummaryFenceRecoveryPorts = Readonly<{
  fence: Readonly<{
    reconcile(
      unresolved: ReadonlyArray<
        Readonly<{ operationId: string; taskId: string }>
      >,
    ): Promise<void>;
  }>;
  store: Pick<PrivateContextStore, "listTaskBindings" | "listSummaryAttempts">;
}>;

export type SummaryFenceRecovery =
  | Readonly<{ status: "reconciled"; unresolved: number }>
  | Readonly<{
      status: "kept";
      code:
        | "CONTEXT_TASK_UNREADABLE"
        | "CONTEXT_STORE_UNREADABLE"
        | "EXECUTION_FENCE_UNRECONCILED";
    }>;

// Whether a summary may still be running on its page after the process that
// submitted it is gone: it was possibly sent and no terminal outcome was
// recorded. A prepared attempt never reached the page.
function unresolved(attempt: StoredContextSummaryAttempt): boolean {
  return attempt.phase !== "prepared";
}

/**
 * At a start, the Computer connector's execution fence is reconciled with
 * the summaries the private context store still holds as possibly running.
 * A summary a crash interrupted may be summarizing on its page right now;
 * its fence outlives the restart until the store proves the operation over.
 * A store that cannot be read proves nothing, so every raised fence is kept
 * as it is, and the connector keeps refusing until a later start can read
 * it; nothing is opened on the strength of a new process.
 */
export async function recoverSummaryExecutionFence(
  ports: SummaryFenceRecoveryPorts,
): Promise<SummaryFenceRecovery> {
  const operations: Array<Readonly<{ operationId: string; taskId: string }>> =
    [];
  try {
    for (const task of await ports.store.listTaskBindings()) {
      if (!task.readable) {
        return { status: "kept", code: "CONTEXT_TASK_UNREADABLE" };
      }
      for (const attempt of await ports.store.listSummaryAttempts(
        task.binding,
      )) {
        if (!unresolved(attempt)) continue;
        operations.push({
          operationId: attempt.operationId,
          taskId: task.binding.taskId,
        });
      }
    }
  } catch {
    return { status: "kept", code: "CONTEXT_STORE_UNREADABLE" };
  }
  try {
    await ports.fence.reconcile(operations);
  } catch {
    return { status: "kept", code: "EXECUTION_FENCE_UNRECONCILED" };
  }
  return { status: "reconciled", unresolved: operations.length };
}
