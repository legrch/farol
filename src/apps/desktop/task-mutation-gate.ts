// One task mutation at a time, for the whole process.
//
// Admitting a Codex host thread as a task, starting or cancelling a native
// Agent, activating or closing a task, and a Product Agent reservation
// expiring all change the same live task registry and the same private stores
// behind it. They run on one event loop but each of them awaits — a durable
// save, a promotion lease, a surface opening — so two of them interleave
// freely unless something holds them apart. This is that something: the flag
// `main.ts` used to keep as a bare `let taskMutationInFlight`, moved here so
// the rule it encodes is a decision a test can drive rather than a module
// variable nothing can reach.
//
// Three callers read it (`runProductTaskCommand`'s refusal, the Route B
// lifecycle's `mutationInFlight` port, and both Product Agent expiry
// verdicts) and five claim it.
//
// A bare boolean was not enough for either half of that. Reading it free and
// claiming it are not one step for every caller: the Route B lifecycle reads
// `mutationInFlight`, then removes any Agent-input residue and deletes any
// retained context — two filesystem round trips — before it calls
// `admitTask`. A task command that claims the gate in that window used to be
// invisible to the admission, which then ran on the stale reading; and, worse,
// the admission's own `finally` cleared the flag the task command was holding,
// so the *next* command was admitted concurrently with a mutation still in
// flight. The two Product Agent expiry verdicts read the same cleared flag and
// take the `expire` branch, cancelling a live Agent session mid-mutation —
// exactly the race `productAgentSessionExpiryVerdict` documents as
// must-reschedule.
//
// So a claim is a handle, as in `AuthorityTransitionReservation`: `tryEnter`
// refuses rather than overwriting a live claim, and a handle frees only the
// claim it is still holding.

/** A claim on the gate. Freeing it twice, or after it was lost, does nothing. */
export type TaskMutationHandle = Readonly<{ release: () => void }>;

export class TaskMutationGate {
  private holder: symbol | null = null;

  /** True while a task mutation holds the gate. */
  inFlight(): boolean {
    return this.holder !== null;
  }

  /**
   * Claim the gate, or return null when another mutation holds it. Never
   * waits: the caller refuses with its own reason.
   */
  tryEnter(): TaskMutationHandle | null {
    if (this.holder !== null) return null;
    const token = Symbol("task-mutation");
    this.holder = token;
    return {
      release: () => {
        if (this.holder === token) this.holder = null;
      },
    };
  }
}

/**
 * Run `work` as the process's one task mutation, releasing the gate however
 * `work` ends. `refused` supplies the caller's own busy result for the case
 * where another mutation already holds the gate.
 */
export async function underTaskMutation<T>(
  gate: TaskMutationGate,
  refused: () => T,
  work: () => Promise<T>,
): Promise<T> {
  const handle = gate.tryEnter();
  if (!handle) return refused();
  try {
    return await work();
  } finally {
    handle.release();
  }
}
