/**
 * What the owner has typed into the Agent assignment, held by the renderer
 * rather than by the fields themselves.
 *
 * It used to live only in the DOM. The task menu closes on an `open-settings`
 * shell action, and that action is published when a ChatGPT route window
 * closes — by a task's own lifecycle or a quit drain, not only by the owner.
 * Reopening the menu then ran `openTaskMenu`, which cleared all five fields
 * whenever the selection had moved in between, and nothing else held the
 * text. So a subfolder path typed a moment earlier was gone before Run Agent
 * could be pressed, with no action by the owner at any point.
 *
 * Holding it here makes the draft independent of whether the fields survive,
 * of whether the menu stayed open, and of how often the menu re-renders. The
 * fields remain what the assignment is read from, so the delivered scope is
 * byte-identical to before.
 */
import type { AgentAuthority } from "./shell-action-policy";

export type AgentDraftFields = Readonly<{
  mode: string;
  objective: string;
  subtree: string;
  paths: string;
  exclusions: string;
}>;

export const EMPTY_AGENT_DRAFT: AgentDraftFields = Object.freeze({
  mode: "workspace",
  objective: "",
  subtree: "",
  paths: "",
  exclusions: "",
});

export class AgentDraftStore {
  private taskId = "";
  private fields: AgentDraftFields | null = null;
  // The grant the text was written under. Kept beside the text so restoring
  // one can never quietly restore the other.
  private authority: AgentAuthority | null = null;

  /**
   * The menu is being shown for `taskId`. A different task is a different
   * assignment, so its draft starts empty — the one clearing rule that was
   * already here, kept exactly.
   */
  select(taskId: string): void {
    if (taskId === this.taskId) return;
    this.taskId = taskId;
    this.fields = null;
    this.authority = null;
  }

  /** The owner typed. */
  capture(
    taskId: string,
    fields: AgentDraftFields,
    authority: AgentAuthority | null,
  ): void {
    if (taskId !== this.taskId) return;
    this.fields = { ...fields };
    this.authority = authority === null ? null : { ...authority };
  }

  /** The grant this text was composed under, for the check at submit. */
  composedUnder(): AgentAuthority | null {
    return this.authority;
  }

  /**
   * What the fields should show for `taskId`: the owner's own text if they
   * have typed any, and otherwise nothing, which leaves the empty defaults
   * in place. Never another task's draft.
   */
  restore(taskId: string): AgentDraftFields | null {
    if (taskId !== this.taskId) return null;
    return this.fields;
  }

  /** The assignment was submitted or the owner dismissed the menu. */
  clear(): void {
    this.fields = null;
    this.authority = null;
  }

  /** Whether any text is being held, for the source the menu renders from. */
  held(): boolean {
    return this.fields !== null;
  }
}
