import type { LiveTaskRegistry } from "./live-task-registry";

// S35-03: a ChatGPT one-shot task's journal writes (`prepare`,
// `markDispatchIntent`) are exactly the obligations a promotion's drain check
// refuses on (`CHATGPT_DISPATCH_PREPARED`, `CHATGPT_DELIVERY_PENDING`), so
// each takes the same cross-process lease for its durable write. A live
// promotion refuses the task with its own readable code instead of racing
// the placement it has already validated.
//
// S35-H1R2: this lives here rather than inside `main.ts` so a test can drive
// the function the four call sites actually call. A replica of it in a test
// proves only that the replica is fenced.

/**
 * The one capability this wrapper needs from the live task registry: the
 * cross-process promotion lease, with the fence every durable write takes.
 */
export type PromotionLeaseRegistry = Readonly<{
  withPromotionLease: LiveTaskRegistry["withPromotionLease"];
}>;

/**
 * A lease held by a live promotion, refusing this journal write. `main.ts`
 * renders it as `CHATGPT_TASK_PROMOTION_PENDING`; every other failure from
 * the journal keeps its own `CHATGPT_TASK_JOURNAL_FAILED`.
 */
export class PromotionPendingRefusal extends Error {
  constructor() {
    super("CHATGPT_TASK_PROMOTION_PENDING");
  }
}

export async function journalUnderPromotionLease<T>(
  registry: PromotionLeaseRegistry,
  work: () => Promise<T>,
): Promise<T> {
  const outcome = await registry.withPromotionLease(async (fence) => {
    // S35-H1-1: `work` IS the journal write, so the fence immediately
    // before it is the fence immediately before the durable write.
    await fence();
    return work();
  });
  if (!outcome.ok) throw new PromotionPendingRefusal();
  return outcome.value;
}
