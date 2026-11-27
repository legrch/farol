import type { ProductConfigurationResultSchema } from "../../pkg/product-settings/contract";
import type { Intent, WindowSnapshot } from "./contract";
import type { z } from "zod";

type Task = WindowSnapshot["tasks"]["tasks"][number];

/** Only bounded upper-case identifiers may reach the UI as a diagnostic code. */
export function displayCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,119}$/u.test(value)
    ? value
    : "DIAGNOSTIC_CODE_UNAVAILABLE";
}

/** A dispatcher result with its code made displayable; the state is kept. */
export function displayable(result: Intent): Intent {
  return {
    ...result,
    code: result.code === null ? null : displayCode(result.code),
  };
}

/**
 * A Cancel whose click may have run leaves the task `outcome_unknown`, and the
 * main process keeps it so through the turn's settlement. While that turn is
 * still in flight the task is still running and the main process accepts a
 * second Cancel for it; once the turn has settled nothing is left to cancel.
 */
export function cancelCanRepeat(task: Task | undefined): boolean {
  return task?.lifecycle === "outcome_unknown" && task.turnInFlight === true;
}

/** An uncertain transport outcome is unknown, never refused or retryable. */
export function commandOutcomeUnknown(key: string): Intent {
  return { id: key, state: "unknown", code: "COMMAND_OUTCOME_UNKNOWN" };
}

/**
 * A rejected task receipt: only an explicit unknown marker stays unknown. A
 * Cancel that raced the child's completion reached the child, so it is one.
 * A Cancel answered AGENT_ASSIGNMENT_FAILED may or may not have sent the stop
 * (a host `failed` reply did, a stored terminal did not), so for a Cancel that
 * one code is unknown; a run refused with it before any spawn stays refused.
 */
export function taskFailure(error: string, intention: string): Intent {
  return {
    id: intention,
    state:
      error.includes("OUTCOME_UNKNOWN") ||
      error === "TASK_CANCEL_FAILED" ||
      error === "AGENT_CANCEL_RACED_COMPLETION" ||
      (error === "AGENT_ASSIGNMENT_FAILED" && intention.startsWith("cancel:"))
        ? "unknown"
        : "refused",
    code: error,
  };
}

/** A malformed task receipt cannot prove the command was not applied. */
export function taskReceiptUnknown(intention: string): Intent {
  return { id: intention, state: "unknown", code: "TASK_OUTCOME_UNKNOWN" };
}

/** Whether a task receipt may move the window to the task it selected. */
export function followsSelectedTask(input: {
  sameContext: boolean;
  state: WindowSnapshot;
  selected: Task;
  navigationUnchanged: boolean;
}): boolean {
  const { state, selected } = input;
  return (
    input.sameContext &&
    state.status === "current" &&
    state.runtime === "ready" &&
    state.tasks.tasks.some(
      (task) =>
        task.taskId === selected.taskId &&
        task.sessionId === selected.sessionId &&
        task.turnId === selected.turnId,
    ) &&
    input.navigationUnchanged &&
    state.overlay === "none"
  );
}

/** Refusals that precede transport may rearm automatic setup completion. */
export function rearmsSetupCompletion(result: Intent): boolean {
  return (
    result.state === "refused" &&
    (result.code === "CURRENT_STATE_REQUIRED" ||
      result.code === "SETUP_INCOMPLETE")
  );
}

/** The intent for a parsed (or malformed) browser presentation reply. */
export function presentBrowserReply(
  intention: string,
  parsed: z.ZodSafeParseResult<
    z.infer<typeof ProductConfigurationResultSchema>
  >,
): Intent {
  if (!parsed.success)
    return {
      id: intention,
      state: "unknown",
      code: "CONFIGURATION_OUTCOME_UNKNOWN",
    };
  // Transport compatibility only: do not adopt settings, readiness or
  // authority from a browser presentation acknowledgement.
  return {
    id: intention,
    state: parsed.data.ok ? "applied" : "refused",
    code: parsed.data.ok ? null : parsed.data.error,
  };
}

/** A shortcut reply that does not match the closed shape is unknown. */
export function shortcutsReply(
  reply: z.ZodSafeParseResult<{ ok: boolean }>,
): Intent {
  if (!reply.success)
    return {
      id: "shortcuts",
      state: "unknown",
      code: "SHORTCUTS_OUTCOME_UNKNOWN",
    };
  if (!reply.data.ok)
    return { id: "shortcuts", state: "refused", code: "SHORTCUTS_REFUSED" };
  return { id: "shortcuts", state: "applied", code: null };
}

/** The refusal for a browser presentation that cannot proceed, if any. */
export function presentBrowserEarly(
  state: WindowSnapshot,
  intention: string,
): Intent | null {
  if (state.destination.area !== "chatgpt")
    return {
      id: intention,
      state: "refused",
      code: "CHATGPT_PRESENTATION_UNAVAILABLE",
    };
  if (state.route === "loaded" || state.destination.taskId !== "")
    return { id: intention, state: "applied", code: null };
  // Own unresolved/failed opens retain their evidence and latch. An old
  // applied sign-in intent is no reason to hide the retained document.
  if (ownOpenUnsettled(state))
    return {
      id: intention,
      state: "refused",
      code: "CHATGPT_PRESENTATION_UNAVAILABLE",
    };
  return null;
}

/** An own browser or sign-in open that has not cleanly applied. */
export function ownOpenUnsettled(state: WindowSnapshot): boolean {
  return ["chatgpt.open-browser", "chatgpt.open-sign-in"].some((kind) => {
    const intent = state.intents[`settings:${kind}:`];
    return intent && intent.state !== "applied";
  });
}
