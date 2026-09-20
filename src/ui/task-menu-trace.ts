/**
 * A bounded, content-free record of what happened to the last few task-menu
 * commands.
 *
 * A task-menu command's success sentence can fail to appear, observed twice
 * on 19434d33 under load at two different commands. A wait on the note's text
 * cannot tell apart the three things that produce that silence: the command
 * never settled, it settled and the note was never written, or the note was
 * written for a different command. This records which, so the next
 * recurrence names its own phase instead of expiring.
 *
 * Content-free by construction: every field is either a command kind from the
 * product's own closed vocabulary, a token from the enums below, or a
 * millisecond count. No label, path, payload or error text is admitted.
 */
export type TaskMenuTraceOutcome = "ok" | "refused" | "invalid" | "threw";

/** Why the note was not written after a command settled. */
export type TaskMenuTraceSkip =
  /** The selection no longer names any task. */
  | "no-task"
  /** The selection names a task whose provider has no live panel. */
  | "not-live"
  /** The command closed the menu on success. */
  | "menu-closed";

export type TaskMenuTraceEntry = Readonly<{
  kind: string;
  dispatchedAt: number;
  settledAt: number | null;
  outcome: TaskMenuTraceOutcome | null;
  notedAt: number | null;
  skipped: TaskMenuTraceSkip | null;
  superseded: boolean;
}>;

const MAX_ENTRIES = 4;

export class TaskMenuTrace {
  private readonly entries: TaskMenuTraceEntry[] = [];

  constructor(private readonly now: () => number) {}

  /**
   * A command left the renderer. Any earlier command still without its note
   * is marked superseded, because from here its sentence can never appear.
   */
  dispatch(kind: string): void {
    for (const [index, entry] of this.entries.entries()) {
      if (entry.notedAt === null && entry.skipped === null) {
        this.entries[index] = { ...entry, superseded: true };
      }
    }
    this.entries.push({
      kind,
      dispatchedAt: this.now(),
      settledAt: null,
      outcome: null,
      notedAt: null,
      skipped: null,
      superseded: false,
    });
    while (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  settle(outcome: TaskMenuTraceOutcome): void {
    this.amendLatest((entry) => ({
      ...entry,
      settledAt: this.now(),
      outcome,
    }));
  }

  /** The note was written to the DOM for the command in flight. */
  noted(): void {
    this.amendLatest((entry) =>
      entry.notedAt === null ? { ...entry, notedAt: this.now() } : entry,
    );
  }

  /** The renderer returned before it could write the note. */
  skipped(reason: TaskMenuTraceSkip): void {
    this.amendLatest((entry) =>
      entry.notedAt === null && entry.skipped === null
        ? { ...entry, skipped: reason }
        : entry,
    );
  }

  private amendLatest(
    amend: (entry: TaskMenuTraceEntry) => TaskMenuTraceEntry,
  ): void {
    const index = this.entries.length - 1;
    const latest = this.entries[index];
    if (latest === undefined) return;
    this.entries[index] = amend(latest);
  }

  read(): readonly TaskMenuTraceEntry[] {
    return [...this.entries];
  }

  /**
   * The phase the newest command reached, as one token. This is the answer
   * the failing wait needs: which of the three silences it is looking at.
   */
  phase(): string {
    const entry = this.entries.at(-1);
    if (!entry) return "none";
    if (entry.notedAt !== null) return "noted";
    if (entry.skipped !== null) return `not-noted:${entry.skipped}`;
    if (entry.settledAt !== null)
      return `settled:${entry.outcome ?? "unknown"}`;
    return "in-flight";
  }

  /** Short enough for a `data-` attribute, in the order the commands ran. */
  serialize(): string {
    return this.entries
      .map((entry) => {
        const settle =
          entry.settledAt === null
            ? "…"
            : `${entry.settledAt - entry.dispatchedAt}ms/${entry.outcome ?? "unknown"}`;
        const note =
          entry.notedAt !== null
            ? `note ${entry.notedAt - entry.dispatchedAt}ms`
            : entry.skipped !== null
              ? `no note (${entry.skipped})`
              : "no note";
        return `${entry.kind} ${settle} ${note}${entry.superseded ? " superseded" : ""}`;
      })
      .join(" | ");
  }
}
