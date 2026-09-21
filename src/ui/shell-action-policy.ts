/**
 * What an incoming shell action is allowed to do to an Agent draft the owner
 * is in the middle of writing.
 *
 * `open-settings` and `sign-in-returned` are published after an auth window's
 * outcome is recorded — by the owner returning, and also by a task's own
 * lifecycle, a quit drain or a runtime refresh. The renderer handled all of
 * them the same way: close Setup, `selectSection("settings")`, refresh. That
 * takes the editor away, and once it is taken the draft's own fields are gone
 * with it. Nothing the owner did caused that.
 *
 * The owner's rule for this is narrow and worth quoting: a background
 * completion, auth-window close or runtime refresh must not discard an
 * in-progress Agent draft or tear down its editor solely to perform
 * background navigation — and preserving text is not permission to execute
 * stale input.
 *
 * So this decides two separate things, and never lets the first answer the
 * second: whether to navigate, and whether the draft is still safe to run.
 */

/** What the publisher knows about where an action came from. */
export type ShellActionProvenance = Readonly<{
  /** Unique per publish. Absent until the main-process seam carries it. */
  eventId: string | null;
  /** Which publisher produced it, or null when the envelope does not say. */
  source: string | null;
  /**
   * The auth window whose recorded outcome produced this, or null when none
   * was involved — and null too when the envelope cannot say yet.
   */
  authWindowGeneration: number | null;
}>;

export type ShellActionContext = Readonly<{
  /** A draft is being held for the open task menu. */
  draftHeld: boolean;
  /** The newest auth window this renderer knows about, or null. */
  currentAuthWindowGeneration: number | null;
  /** Event ids this renderer has already acted on. */
  handledEventIds: ReadonlySet<string>;
}>;

export type ShellActionDecision = Readonly<{
  /** Take the owner to Settings and close the menu. */
  navigate: boolean;
  /** Re-read readiness. True for every non-duplicate outcome. */
  refreshReadiness: boolean;
  /** Offer a visible, non-destructive way to reach Settings. */
  offerReturn: boolean;
  /** Why, as one token from a closed set. */
  reason:
    | "duplicate-event"
    | "owner-return"
    | "no-draft"
    | "stale-auth-window"
    | "background-publisher"
    | "provenance-unknown";
}>;

const IGNORED: ShellActionDecision = Object.freeze({
  navigate: false,
  refreshReadiness: false,
  offerReturn: false,
  reason: "duplicate-event",
});

/**
 * The one publisher that is not an owner action.
 *
 * Named from the real publishers rather than guessed: `settings-command`,
 * `quick-switcher-command` and `overlay-dismissed` are all reached from an
 * owner gesture, and `auth-window-closed` is published after a ChatGPT auth
 * window's outcome is recorded — which happens whether or not the owner
 * touched anything. It is also the publisher the owner's own sentence names:
 * an auth-window close must not tear down an editor to navigate.
 */
const BACKGROUND_SOURCE = "auth-window-closed";

export function decideShellAction(
  provenance: ShellActionProvenance,
  context: ShellActionContext,
): ShellActionDecision {
  // Only a repeat of an id we have already acted on is a proven duplicate.
  // Two identical actions without ids are two events as far as anyone can
  // prove, and dropping the second on a timer would be a guess.
  if (
    provenance.eventId !== null &&
    context.handledEventIds.has(provenance.eventId)
  ) {
    return IGNORED;
  }

  // Readiness is always re-read. A stale or background event still carries a
  // real outcome, and refusing to read it is how a revoked authority would
  // go unnoticed.
  const base = { refreshReadiness: true } as const;

  // With no draft to protect, today's behaviour is the right behaviour.
  if (!context.draftHeld) {
    return { ...base, navigate: true, offerReturn: false, reason: "no-draft" };
  }

  if (provenance.source === BACKGROUND_SOURCE) {
    // An auth window closing never takes the editor, current or not. The
    // generation only changes what this is called: a close from a window
    // older than the one being held is worth telling apart in a diagnostic
    // from the current one, and both keep the draft.
    const stale =
      provenance.authWindowGeneration !== null &&
      context.currentAuthWindowGeneration !== null &&
      provenance.authWindowGeneration < context.currentAuthWindowGeneration;
    return {
      ...base,
      navigate: false,
      offerReturn: true,
      reason: stale ? "stale-auth-window" : "background-publisher",
    };
  }

  // Every other publisher is reached from an owner gesture. Their navigation
  // is honoured, and the draft is kept rather than cleared — going to
  // Settings is not dismissing an assignment.
  if (provenance.source !== null) {
    return {
      ...base,
      navigate: true,
      offerReturn: false,
      reason: "owner-return",
    };
  }

  // The envelope said nothing. It cannot, now that the schema requires a
  // source, but a parse that ever softened would land here rather than in
  // the owner branch. Wrongly keeping the editor costs one click on a
  // control that is right there; wrongly taking it costs work that cannot
  // be got back.
  return {
    ...base,
    navigate: false,
    offerReturn: true,
    reason: "provenance-unknown",
  };
}

/**
 * The authority an assignment was composed under.
 *
 * A draft that survives a background event must not become a way to run
 * against a grant that has since changed. This is compared at submit, not at
 * restore: restoring text is not restoring permission.
 */
export type AgentAuthority = Readonly<{
  workspaceId: string;
  configGeneration: number;
  hostExecutablePath: string | null;
}>;

export const AGENT_AUTHORITY_CHANGED =
  "The approved workspace or host changed while this assignment was being written. Check the scope and run it again.";

export function agentAuthorityUnchanged(
  composedUnder: AgentAuthority | null,
  now: AgentAuthority | null,
): boolean {
  if (composedUnder === null || now === null) return false;
  return (
    composedUnder.workspaceId === now.workspaceId &&
    composedUnder.configGeneration === now.configGeneration &&
    composedUnder.hostExecutablePath === now.hostExecutablePath
  );
}
