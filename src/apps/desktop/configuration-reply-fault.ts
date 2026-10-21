// The one place a configuration reply can be lost on its way to the window.
//
// A guarded edit that really executed and whose result never reached the
// renderer is the single state the product's durable pending-edit record
// exists for, and no test could cause it: the handler always completed and
// Electron always delivered what it returned, so the E2E lane could only
// restore a record the product had already written and cleared. This decides,
// for one already-computed reply, whether the window receives it. It never
// decides whether the command runs: by the time it is asked, the edit, its
// receipt and its pending record are all on disk.
//
// It is inert outside the E2E lane. Both `FAROL_E2E` and a delivery
// budget must be set before a reply can be dropped, exactly as the live-task
// save fault in main.ts requires both before it can fail a commit. Only a
// successful `computer.apply-workspace-edit` reply is ever counted or dropped:
// a failure carries no operation to observe, and dropping another command's
// reply would be a different scenario with a different recovery.

import type { ProductConfigurationResult } from "../../pkg/product-settings/contract";

export type ConfigurationReplyDecision = "deliver" | "drop";

export const WORKSPACE_EDIT_REPLY_DELIVERIES_ENV =
  "FAROL_E2E_WORKSPACE_EDIT_REPLY_DELIVERIES";

export const WORKSPACE_EDIT_REPLY_FAULT_INVALID =
  "WORKSPACE_EDIT_E2E_REPLY_FAULT_INVALID";

export const WORKSPACE_EDIT_ACK_HOLD_ENV = "FAROL_E2E_HOLD_WORKSPACE_EDIT_ACK";

export const WORKSPACE_EDIT_ACK_HOLD_INVALID =
  "WORKSPACE_EDIT_E2E_ACK_HOLD_INVALID";

/**
 * Read one E2E budget under the lane's double gate.
 *
 * `null` means the lane is not armed — which is every production build, so
 * every caller's behaviour is the production one. A value that is set but is
 * not a count throws `invalidCode`, at the moment the budget is first needed
 * rather than at startup, so a setting for one seam never turns an unrelated
 * operation into a failure.
 */
export function e2eBudget(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  invalidCode: string,
): number | null {
  if (env.FAROL_E2E !== "1") return null;
  const raw = env[name];
  if (raw === undefined) return null;
  const budget = Number(raw);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error(invalidCode);
  return budget;
}

const DROPPABLE_COMMAND_KIND = "computer.apply-workspace-edit";

/** The reply that carries a guarded edit's own result back to the window. */
function isDroppableReply(
  commandKind: string,
  result: ProductConfigurationResult,
): boolean {
  return (
    commandKind === DROPPABLE_COMMAND_KIND &&
    result.ok &&
    result.evidence?.kind === "computer.workspace-mutation"
  );
}

/**
 * Decide the fate of each configuration reply for one process.
 *
 * `env` is read on every call rather than captured, so an unset budget is
 * indistinguishable from the production path and a budget set for one lane
 * cannot outlive it. The budget is the number of successful guarded-edit
 * replies this process delivers before every further one is dropped; an
 * unusable budget throws at the first reply that would have consumed it,
 * rather than at construction, so an unrelated command is never turned into
 * a failure by a setting that does not concern it.
 */
export function createConfigurationReplyFault(
  env: Readonly<Record<string, string | undefined>>,
): (
  commandKind: string,
  result: ProductConfigurationResult,
) => ConfigurationReplyDecision {
  let droppableReplies = 0;
  return (commandKind, result) => {
    if (!isDroppableReply(commandKind, result)) return "deliver";
    const deliveries = e2eBudget(
      env,
      WORKSPACE_EDIT_REPLY_DELIVERIES_ENV,
      WORKSPACE_EDIT_REPLY_FAULT_INVALID,
    );
    if (deliveries === null) return "deliver";
    droppableReplies += 1;
    return droppableReplies > deliveries ? "drop" : "deliver";
  };
}
