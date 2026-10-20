export type SearchMatchDisplay = Readonly<{
  text: string;
  title: string | null;
}>;

// A truncated match is an excerpt of a longer line around the hit, not the
// whole line; show that instead of presenting the excerpt as complete.
export function searchMatchDisplay(
  match: Readonly<{ text: string; truncated: boolean }>,
): SearchMatchDisplay {
  if (!match.truncated) return { text: match.text, title: null };
  return {
    text: `${match.text} …`,
    title: "Excerpt of a longer line around the match",
  };
}

/**
 * Why a workspace search cannot be run yet, or null when it can.
 *
 * Its neighbour "Git status" already names its own first unmet prerequisite;
 * this control was disabled in the same situations and said nothing.
 */
export function workspaceSearchPrerequisite(
  verified: boolean,
  pattern: string,
): string | null {
  if (!verified) return "Verify this workspace again first.";
  if (pattern.trim().length === 0) return "Enter a text pattern to search for.";
  return null;
}

export const GIT_VERIFICATION_UNAVAILABLE_NOTE =
  "Git checks are not available in this build";

/**
 * The title of a fixed Git check button: its first unmet prerequisite, or the
 * given text when it can run. A build without the Git checks says so before
 * anything the owner could still change.
 */
export function gitVerificationPrerequisite(
  state: Readonly<{
    available: boolean;
    commandsEnabled: boolean;
    verified: boolean;
  }>,
  enabledReason: string,
): string {
  if (!state.available) return GIT_VERIFICATION_UNAVAILABLE_NOTE;
  if (!state.commandsEnabled) return "Enable Verified commands above";
  if (!state.verified) return "Verify this workspace again first";
  return enabledReason;
}

/**
 * Why a prepared guarded edit cannot be applied yet, or null when it can.
 *
 * The note above the fields states the "one exact match" half of the rule.
 * The other half — that the replacement has to differ from what it replaces
 * — was enforced but never stated, so identical text disabled the button
 * with no explanation.
 */
export function guardedEditApplyPrerequisite(
  oldText: string,
  newText: string,
): string | null {
  if (oldText.length === 0) {
    return "Enter the exact text to replace.";
  }
  if (oldText === newText) {
    return "The replacement is identical to the text it replaces. Change one of them.";
  }
  return null;
}

/**
 * Why the bounded approval cannot be released yet, or null when it can.
 *
 * Three conditions disabled it and the summary beside it named one: that no
 * request was waiting. A runtime that is not ready, and a task surface that
 * has failed, both left the control dead under a summary saying a task was
 * waiting for the owner's approval.
 */
export function approveToolPrerequisite(
  state: Readonly<{
    hasWaitingTask: boolean;
    runtimeReady: boolean;
    surfaceFailed: boolean;
  }>,
): string | null {
  if (!state.hasWaitingTask) return "No request is waiting.";
  if (!state.runtimeReady) {
    return "The local runtime is not ready. The request stays waiting until it is.";
  }
  if (state.surfaceFailed) {
    return "This task's page failed. Reopen or restart it before releasing the approval.";
  }
  return null;
}

/**
 * Why a verified-workspace read action cannot run, or null when it can.
 *
 * `listRoot`, the Git commands and `Edit file…` each set a disabled flag and
 * a title from the same booleans, written out twice. One function so an edit
 * to one cannot leave the other behind.
 */
export function workspaceReadPrerequisite(
  verified: boolean,
  pendingEdit: boolean,
): string | null {
  if (pendingEdit) return "Check the result of the last guarded edit first.";
  if (!verified) return "Verify this workspace again first.";
  return null;
}
