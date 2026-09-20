/**
 * The one sentence under the task menu's controls.
 *
 * The menu refuses a second command while one is in flight — correctly, so a
 * double press cannot submit twice — but it used to refuse it in silence.
 * The guard cleared the feedback line, disabled the controls and returned,
 * so a press during that window produced no response at all, and the note
 * went on offering advice about actions the menu was not currently
 * accepting. A control that does nothing and says nothing is indistinguishable
 * from a broken one.
 */
export type TaskMenuNoteState = Readonly<{
  /** The result of the last completed command, or "" while none is shown. */
  feedback: string;
  /** A command is in flight; the menu is not accepting another. */
  busy: boolean;
  contextLocked: boolean;
  contextLabel: string | null;
  agentLocked: boolean;
  agentRunning: boolean;
  /** The Agent assignment's outcome is unknown. */
  uncertain: boolean;
  lifecycle: string;
}>;

export const TASK_MENU_BUSY_NOTE =
  "Working on the last thing you asked for. This menu takes the next one when it finishes.";

export function taskMenuNote(state: TaskMenuNoteState): string {
  // A finished command's own result outranks everything: it is the answer to
  // what the owner just did.
  if (state.feedback) return state.feedback;
  // Then the reason the controls are inert right now. This has to come before
  // the standing advice below, because that advice describes actions the menu
  // is not accepting at this moment.
  if (state.busy) return TASK_MENU_BUSY_NOTE;
  if (state.contextLocked) {
    return `${state.contextLabel ?? "Context transition"} is still active. Farol will not cancel, close, or delegate this task until the exact context operation is reconciled.`;
  }
  if (state.agentLocked) {
    return state.agentRunning
      ? "Agent state is retained before native execution. Cancel interrupts this exact native child; Close stays unavailable until cancellation or delivery is reconciled."
      : "Agent state is retained before native execution. Closing and provider cancellation stay unavailable until the same assignment is reconciled.";
  }
  if (state.uncertain) {
    return "Outcome unknown is not Failed. Farol will not submit this Agent assignment again.";
  }
  return state.lifecycle === "running"
    ? "Cancel requests a provider stop. Closing only removes the local task and does not prove provider cancellation."
    : "Close removes this local task and its window. It does not cancel provider work.";
}

/**
 * Why the Agent's approved-workspace field cannot be changed.
 *
 * It was a `<select>`, and it was always filled with exactly one option —
 * the single verified workspace, or a "No verified workspace" placeholder.
 * It had no change listener because there was never a second value to pick,
 * so it looked like a chooser that did nothing. It is a fixed value, and it
 * should say which value and why.
 *
 * The field's own `.value` is still what the Agent assignment reads, and a
 * disabled `<select>` keeps that value; only the appearance of choice goes.
 */
export function agentWorkspaceFixedReason(
  hasVerifiedWorkspace: boolean,
): string {
  return hasVerifiedWorkspace
    ? "Farol delegates to the one workspace it has verified for this Computer. Verify another in Computer to change this."
    : "No workspace has been verified yet. Approve one in Computer and verify it before delegating.";
}
