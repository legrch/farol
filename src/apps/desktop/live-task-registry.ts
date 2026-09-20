import {
  ProductTaskLifecycleSchema,
  ProductTaskSchema,
  ProductTasksStateSchema,
  type ProductTask,
  type ProductTaskAgent,
  type ProductTaskContext,
  type ProductTaskLifecycle,
  type ProductTasksState,
} from "../../modules/chat/contract/product-task";

export type LiveTaskAdmission =
  | Readonly<{ status: "admitted"; task: ProductTask }>
  | Readonly<{ status: "capacity" | "duplicate" | "promotion_pending" }>;

// S35-03/2: a lease that is only ever checked, never held, excludes
// nothing — a promotion could take the lease and validate drained in the
// gap right after this check passed and before admission's own durable
// write lands. `acquireForAdmission` takes the SAME cross-process lease a
// promotion holds from before its drain check through placement, for the
// whole durable admission (`admitDurable` below): the in-memory check, the
// push, and the write that makes it visible on disk all happen while it is
// held. Whichever side actually holds the lease wins; the other gets its
// own refusal, deterministically, not from a race.
// `verify` is the fencing check taken immediately before the durable write:
// the lease must still be the one lock everybody else honours (see
// `verifyPromotionLease` in `promotion-lease.ts`). A hold that no longer
// verifies is treated exactly like a lease that was never acquired.
export type PromotionLeaseHold = Readonly<{
  release(): Promise<void>;
  verify?(): Promise<boolean>;
}>;
export type PromotionLeaseGuard = Readonly<{
  acquireForAdmission(): Promise<PromotionLeaseHold | null>;
}>;

// S35-H1-1: one entry check is not a fence. A critical phase may perform
// several durable writes, and between the entry check and any of them the
// lease file can be deleted and re-created — at which point a second
// acquirer locks the new inode and two holders exist. `work` is therefore
// handed a `fence` it must call immediately before EVERY durable write it
// makes; the fence re-verifies the hold and throws this error when the hold
// no longer names the inode everybody else honours. `withPromotionLease`
// turns that into its ordinary `{ok:false}` refusal, which every caller
// already maps to its own readable code (`promotion_pending`,
// `TASK_ROUTE_UNAVAILABLE`, `CHATGPT_TASK_PROMOTION_PENDING`,
// `WORKSPACE_MUTATION_PROMOTION_PENDING`), so a lost lease is refused
// rather than written through.
export class PromotionLeaseLost extends Error {
  constructor() {
    super("PROMOTION_LEASE_LOST");
    this.name = "PromotionLeaseLost";
  }
}

export type PromotionLeaseFence = () => Promise<void>;

// Without a lease guard there is no exclusion to lose, so the fence a
// `work` callback calls is a no-op — exactly the behaviour a registry
// built without a `promotionLease` has always had.
const UNFENCED: PromotionLeaseFence = async () => undefined;

export class LiveTaskRegistry {
  private readonly tasks: ProductTask[] = [];
  private revision = 0;

  constructor(
    private readonly capacity: number,
    private readonly promotionLease?: PromotionLeaseGuard,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 5) {
      throw new Error("LIVE_TASK_CAPACITY_INVALID");
    }
  }

  // In-memory admission only: capacity and identity, nothing durable, no
  // cross-process exclusion. Real callers that make a task visible on disk
  // must go through `admitDurable` instead — see its comment for why a
  // lease *check* here would not be enough.
  admit(candidate: ProductTask): LiveTaskAdmission {
    const task = ProductTaskSchema.parse(candidate);
    if (this.tasks.length >= this.capacity) return { status: "capacity" };
    if (
      this.tasks.some(
        (current) =>
          current.taskId === task.taskId ||
          current.sessionId === task.sessionId ||
          current.turnId === task.turnId,
      )
    ) {
      return { status: "duplicate" };
    }
    this.tasks.push(task);
    this.revision += 1;
    return { status: "admitted", task: { ...task } };
  }

  // Admits a task and makes it durable while holding the cross-process
  // promotion lease for the whole sequence: the in-memory `admit` above, and
  // `persist` (the caller's write to the live-task store). If `persist`
  // throws, the in-memory admission is rolled back before the lease is
  // released and before the error is rethrown, so a failed durable write
  // never leaves a task visible only in memory.
  async admitDurable(
    candidate: ProductTask,
    persist: () => Promise<void>,
  ): Promise<LiveTaskAdmission> {
    const before = this.snapshot();
    const outcome = await this.withPromotionLease(async (fence) => {
      const admitted = this.admit(candidate);
      if (admitted.status !== "admitted") return admitted;
      try {
        // Immediately before the one durable write this phase makes: a
        // lease lost since the entry check refuses here instead of
        // persisting a task a live promotion has already validated away.
        await fence();
        await persist();
      } catch (error) {
        this.rollback(before);
        throw error;
      }
      return admitted;
    });
    return outcome.ok ? outcome.value : { status: "promotion_pending" };
  }

  // S35-03: a later turn of an existing task becomes the `TASK_RUNNING`
  // obligation a promotion's drain check refuses on the moment it is
  // durably running, so it takes the same cross-process lease a first
  // turn's admission takes; a live promotion refuses the turn before
  // submission instead of racing its placement.
  //
  // S35-TA-1: this body used to sit inline in `main.ts`, which exports
  // nothing and which no test loads, so the only thing that could be
  // tested was a copy of it. It lives here, beside `admitDurable`, for the
  // same reason `journalUnderPromotionLease` lives in its own module: a
  // replica in a test proves only that the replica is fenced.
  //
  // `true` means the turn may proceed. A task that is already running, or
  // that `setLifecycle` does not know, proceeds exactly as it did before;
  // only a lease a live promotion holds — or one lost between the entry
  // check and the persist — refuses with `false`. An ordinary persist
  // failure keeps its own surfaced-failure behaviour and does not refuse
  // the turn.
  async markRunningDurable(
    taskId: string,
    persist: () => Promise<void>,
    hooks: Readonly<{
      onPublish: () => void;
      onPersistFailure: () => void;
    }>,
  ): Promise<boolean> {
    if (this.get(taskId)?.lifecycle === "running") return true;
    const before = this.snapshot();
    const outcome = await this.withPromotionLease(async (fence) => {
      if (!this.setLifecycle(taskId, "running")) return;
      hooks.onPublish();
      try {
        // S35-H1-1: fenced immediately before the durable write, not only
        // on entry. A lease lost in between rolls the running mark back
        // and refuses the turn.
        await fence();
        await persist();
      } catch (error) {
        if (error instanceof PromotionLeaseLost) {
          this.rollback(before);
          hooks.onPublish();
          throw error;
        }
        hooks.onPersistFailure();
      }
    });
    return outcome.ok;
  }

  // S35-03/4: starting a native Agent turns an already-admitted task into
  // the `AGENT_RUNNING` obligation a promotion's drain check refuses on, so
  // it takes the same cross-process lease `admitDurable` does for a brand
  // new task — not only new admission is guarded.
  //
  // S35-TA-1: extracted from `main.ts` for the reason above. `rollbackTo`
  // is the caller's snapshot of the whole command phase, so a failed start
  // restores exactly what the caller would have restored; `onRollback` is
  // the caller's own compensation (removing the Agent input it saved
  // before this call).
  //
  // The three refusals are distinct and each is the caller's own readable
  // code: `TASK_NOT_FOUND` (nothing was mutated), `TASK_STATE_UNAVAILABLE`
  // (the durable write failed and was rolled back) and
  // `TASK_ROUTE_UNAVAILABLE` (a live promotion holds the lease, or it was
  // lost mid-phase — the two are deliberately indistinguishable).
  async startAgentDurable(
    taskId: string,
    agent: ProductTaskAgent,
    persist: () => Promise<void>,
    rollbackTo: ProductTasksState,
    onRollback: () => Promise<void>,
  ): Promise<
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        code:
          | "TASK_NOT_FOUND"
          | "TASK_STATE_UNAVAILABLE"
          | "TASK_ROUTE_UNAVAILABLE";
      }>
  > {
    const outcome = await this.withPromotionLease(async (fence) => {
      if (!this.setAgent(taskId, agent)) {
        return { ok: false as const, code: "TASK_NOT_FOUND" as const };
      }
      try {
        // S35-H1-1: fenced immediately before the durable write. A lease
        // lost since the entry check rolls the agent mark back and leaves
        // through the same refusal a never-acquired lease produces.
        await fence();
        await persist();
      } catch (error) {
        this.rollback(rollbackTo);
        await onRollback();
        if (error instanceof PromotionLeaseLost) throw error;
        return { ok: false as const, code: "TASK_STATE_UNAVAILABLE" as const };
      }
      return { ok: true as const };
    });
    return outcome.ok
      ? outcome.value
      : { ok: false, code: "TASK_ROUTE_UNAVAILABLE" };
  }

  // S35-03/4: the SAME cross-process exclusion `admitDurable` uses, exposed
  // for every other write that turns this generation's state into a
  // promotion obligation — starting a native Agent on an already-admitted
  // task (`AGENT_RUNNING`), for instance — not only admitting a brand new
  // task. `work` runs the in-memory mutation and its durable persist
  // together, exactly as it would without a lease; the only difference is
  // that a live promotion excludes it instead of racing it. Returns
  // `{ok:false}` (never throwing) when a live promotion already holds the
  // lease, so the caller can map that to its own ordinary refusal.
  //
  // S35-H1-1: `work` receives the `fence` it must call immediately before
  // every durable write it performs. The entry check below is kept — it
  // refuses before any in-memory mutation happens — but it is no longer the
  // only one: a `PromotionLeaseLost` raised by any fence leaves through the
  // same `{ok:false}` refusal, so the caller cannot tell a lease lost
  // mid-phase from a lease never acquired, and neither writes.
  async withPromotionLease<T>(
    work: (fence: PromotionLeaseFence) => Promise<T>,
  ): Promise<Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>> {
    if (!this.promotionLease) return { ok: true, value: await work(UNFENCED) };
    const hold = await this.promotionLease.acquireForAdmission();
    if (!hold) return { ok: false };
    const fence: PromotionLeaseFence = async () => {
      if (hold.verify && !(await hold.verify())) {
        throw new PromotionLeaseLost();
      }
    };
    try {
      await fence();
      return { ok: true, value: await work(fence) };
    } catch (error) {
      if (error instanceof PromotionLeaseLost) return { ok: false };
      throw error;
    } finally {
      await hold.release();
    }
  }

  get(taskId: string): ProductTask | null {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    return task ? { ...task } : null;
  }

  restore(state: ProductTasksState): void {
    if (this.tasks.length !== 0 || this.revision !== 0) {
      throw new Error("LIVE_TASK_REGISTRY_NOT_EMPTY");
    }
    this.replace(state);
  }

  rollback(state: ProductTasksState): void {
    this.replace(state);
  }

  // The same rule admission enforces: no two tasks share a task, session or
  // turn identity. One task may spell the same value in two of its own
  // fields — a Codex host thread runs in the Farol task with the same
  // identity as its task and its session — so the fields are compared each
  // against its own kind, never against each other.
  private replace(state: ProductTasksState): void {
    const parsed = ProductTasksStateSchema.parse(state);
    const taskIds = new Set<string>();
    const sessionIds = new Set<string>();
    const turnIds = new Set<string>();
    for (const task of parsed.tasks) {
      if (
        taskIds.has(task.taskId) ||
        sessionIds.has(task.sessionId) ||
        turnIds.has(task.turnId)
      ) {
        throw new Error("LIVE_TASK_IDENTITY_DUPLICATE");
      }
      taskIds.add(task.taskId);
      sessionIds.add(task.sessionId);
      turnIds.add(task.turnId);
    }
    this.tasks.splice(0, this.tasks.length, ...parsed.tasks);
    this.revision = parsed.revision;
  }

  rename(taskId: string, label: string): boolean {
    const index = this.tasks.findIndex(
      (candidate) => candidate.taskId === taskId,
    );
    const current = this.tasks[index];
    if (!current) return false;
    const renamed = ProductTaskSchema.parse({ ...current, label });
    if (renamed.label === current.label) return true;
    this.tasks[index] = renamed;
    this.revision += 1;
    return true;
  }

  setPinned(taskId: string, pinned: boolean): boolean {
    const index = this.tasks.findIndex(
      (candidate) => candidate.taskId === taskId,
    );
    const current = this.tasks[index];
    if (!current) return false;
    if (current.pinned === pinned) return true;
    this.tasks[index] = { ...current, pinned };
    this.tasks.sort(
      (left, right) => Number(right.pinned) - Number(left.pinned),
    );
    this.revision += 1;
    return true;
  }

  remove(taskId: string): ProductTask | null {
    const index = this.tasks.findIndex(
      (candidate) => candidate.taskId === taskId,
    );
    if (index < 0) return null;
    const [removed] = this.tasks.splice(index, 1);
    if (!removed) return null;
    this.revision += 1;
    return { ...removed };
  }

  setLifecycle(taskId: string, lifecycle: ProductTaskLifecycle): boolean {
    const parsed = ProductTaskLifecycleSchema.parse(lifecycle);
    const index = this.tasks.findIndex(
      (candidate) => candidate.taskId === taskId,
    );
    const current = this.tasks[index];
    if (!current) return false;
    if (current.lifecycle === parsed) return true;
    this.tasks[index] = { ...current, lifecycle: parsed };
    this.revision += 1;
    return true;
  }

  setAgent(taskId: string, agent: ProductTaskAgent | null): boolean {
    const index = this.tasks.findIndex(
      (candidate) => candidate.taskId === taskId,
    );
    const current = this.tasks[index];
    if (!current) return false;
    const updated = ProductTaskSchema.parse({ ...current, agent });
    if (JSON.stringify(current.agent ?? null) === JSON.stringify(agent)) {
      return true;
    }
    this.tasks[index] = updated;
    this.revision += 1;
    return true;
  }

  setContext(taskId: string, context: ProductTaskContext | null): boolean {
    const index = this.tasks.findIndex(
      (candidate) => candidate.taskId === taskId,
    );
    const current = this.tasks[index];
    if (!current) return false;
    const updated = ProductTaskSchema.parse({ ...current, context });
    if (JSON.stringify(current.context ?? null) === JSON.stringify(context)) {
      return true;
    }
    this.tasks[index] = updated;
    this.revision += 1;
    return true;
  }

  snapshot(): ProductTasksState {
    return ProductTasksStateSchema.parse({
      revision: this.revision,
      tasks: this.tasks,
    });
  }
}
