import type {
  PrivateContextStore,
  StoredContextSummaryAttempt,
} from "../../modules/chat/infra/repo/private-context-store";

export type SummaryFenceRecoveryPorts = Readonly<{
  fence: Readonly<{
    raise(
      input: Readonly<{ operationId: string; taskId: string }>,
    ): Promise<void>;
    reconcile(
      unresolved: ReadonlyArray<
        Readonly<{ operationId: string; taskId: string }>
      >,
    ): Promise<void>;
  }>;
  store: Pick<PrivateContextStore, "listTaskBindings" | "listSummaryAttempts">;
}>;

// The record the desktop raises when reconciliation could not materialize
// every required fence: it holds the connector closed until a later start
// reconciles for real, which removes it as stale.
export const FENCE_RECOVERY_SENTINEL = Object.freeze({
  operationId: "farol-next-fence-recovery-unreconciled",
  taskId: "farol-next-desktop",
});

export type SummaryFenceRecovery =
  | Readonly<{ status: "reconciled"; unresolved: number }>
  | Readonly<{
      status: "kept";
      code: "CONTEXT_TASK_UNREADABLE" | "CONTEXT_STORE_UNREADABLE";
    }>
  | Readonly<{
      status: "kept";
      code: "EXECUTION_FENCE_UNRECONCILED";
      // Whether the sentinel record could be raised, so the connector keeps
      // refusing; when it could not, the fence directory itself cannot be
      // written and the launch root is not usable.
      held: boolean;
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
 * it; nothing is opened on the strength of a new process. A fence that could
 * not be reconciled is held closed by a sentinel record rather than left to
 * whatever the crash and a partial repair left behind.
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
    // A reconciliation that could not materialize every required record
    // must not leave the connector open: the sentinel record refuses every
    // Computer tool until a later start reconciles for real.
    let held = true;
    try {
      await ports.fence.raise(FENCE_RECOVERY_SENTINEL);
    } catch {
      held = false;
    }
    return { status: "kept", code: "EXECUTION_FENCE_UNRECONCILED", held };
  }
  return { status: "reconciled", unresolved: operations.length };
}

export type ComputerConnectorAdmission =
  | Readonly<{ admissible: true }>
  | Readonly<{ admissible: false; code: "COMPUTER_FENCE_UNHELD" }>;

/**
 * Whether the Computer connector may be exposed at all after a start. The
 * broker refuses while a fence record exists, so a start that reconciled,
 * or that could at least hold the sentinel, leaves the connector to the
 * records. A start that could hold nothing — reconciliation failed and the
 * sentinel could not be written either — has no record to refuse with, and
 * a start whose recovery never ran proves nothing; in both cases the desktop
 * itself refuses to start the connector until a later start recovers.
 */
export function computerConnectorAdmission(
  recovery: SummaryFenceRecovery | null,
): ComputerConnectorAdmission {
  if (recovery === null)
    return { admissible: false, code: "COMPUTER_FENCE_UNHELD" };
  if (
    recovery.status === "kept" &&
    recovery.code === "EXECUTION_FENCE_UNRECONCILED" &&
    !recovery.held
  ) {
    return { admissible: false, code: "COMPUTER_FENCE_UNHELD" };
  }
  return { admissible: true };
}
