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
// verdicts) and five claim it. The two expiry verdicts are the reason a
// stale reading matters beyond a second admission: a timer that reads the
// gate as free while a mutation is in flight takes the `expire` branch and
// cancels a live Agent session, which is exactly the race
// `productAgentSessionExpiryVerdict` documents as must-reschedule.

/** A claim on the gate. Releasing more than once does nothing. */
export type TaskMutationHandle = Readonly<{ release: () => void }>;

export class TaskMutationGate {
  private held = false;

  /** True while a task mutation holds the gate. */
  inFlight(): boolean {
    return this.held;
  }

  /** Claim the gate. Never refuses; the caller checks `inFlight` first. */
  enter(): TaskMutationHandle {
    this.held = true;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.held = false;
      },
    };
  }
}

/**
 * Run `work` as the process's one task mutation, releasing the gate however
 * `work` ends.
 */
export async function underTaskMutation<T>(
  gate: TaskMutationGate,
  work: () => Promise<T>,
): Promise<T> {
  const handle = gate.enter();
  try {
    return await work();
  } finally {
    handle.release();
  }
}
