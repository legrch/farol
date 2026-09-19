import type { ProductConfigurationCommand } from "../pkg/product-settings/contract";
import type { ConfigurationOutcome } from "./configuration-outcome";

// Refusals that report the settled outcome of the submitted edit itself.
// A refusal about admission or concurrency (in progress, settings
// unavailable) says nothing about the edit, so it is never acknowledged.
const DELIVERED_EDIT_REFUSALS: ReadonlySet<string> = new Set([
  "WORKSPACE_MUTATION_CONFLICT",
  "WORKSPACE_EDIT_NO_MATCH",
  "WORKSPACE_EDIT_NOT_UNIQUE",
  "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
  "WORKSPACE_MUTATION_FAILED",
  "WORKSPACE_MUTATION_NOT_ADMITTED",
  "WORKSPACE_WRITE_APPROVAL_REQUIRED",
]);

/**
 * The operation ID whose undelivered-result record may be cleared now that
 * its outcome reached the owner, or null.  Only a confirmed reply about the
 * very operation that is still pending counts: a lost or malformed reply
 * leaves the record in place so the edit is observed, never repeated.
 */
export function workspaceEditToAcknowledge(
  command: ProductConfigurationCommand,
  outcome: ConfigurationOutcome,
): string | null {
  if (
    command.kind !== "computer.apply-workspace-edit" &&
    command.kind !== "computer.observe-workspace-edit"
  ) {
    return null;
  }
  if (outcome.kind === "unconfirmed") return null;
  const snapshot = outcome.result.snapshot;
  const pending =
    snapshot.status === "ready" ? snapshot.settings.computer.pendingEdit : null;
  if (pending?.operationId !== command.operationId) return null;
  if (outcome.kind === "applied") {
    return outcome.result.evidence?.kind === "computer.workspace-mutation"
      ? command.operationId
      : null;
  }
  return DELIVERED_EDIT_REFUSALS.has(outcome.result.error)
    ? command.operationId
    : null;
}

/**
 * The owner-facing sentence for a guarded edit whose outcome is unknown, or
 * null for any other refusal.  Unknown is never "not applied": the change may
 * already be in the file, Farol never repeats it, and whatever the helper
 * could not put back is kept beside the file rather than deleted.  The
 * sentence carries no path or content.
 */
export function workspaceEditRefusalMessage(code: string): string | null {
  if (code !== "WORKSPACE_MUTATION_OUTCOME_UNKNOWN") return null;
  return "Edit outcome unknown · the change may already be in the file. Farol will not repeat it and deleted nothing: any version it could not put back stays in a hidden .farol-stage folder beside the file. Check the file before editing it again.";
}
