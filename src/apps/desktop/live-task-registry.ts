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
export type PromotionLeaseHold = Readonly<{ release(): Promise<void> }>;
export type PromotionLeaseGuard = Readonly<{
  acquireForAdmission(): Promise<PromotionLeaseHold | null>;
}>;

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
    const outcome = await this.withPromotionLease(async () => {
      const admitted = this.admit(candidate);
      if (admitted.status !== "admitted") return admitted;
      try {
        await persist();
      } catch (error) {
        this.rollback(before);
        throw error;
      }
      return admitted;
    });
    return outcome.ok ? outcome.value : { status: "promotion_pending" };
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
  async withPromotionLease<T>(
    work: () => Promise<T>,
  ): Promise<Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>> {
    if (!this.promotionLease) return { ok: true, value: await work() };
    const hold = await this.promotionLease.acquireForAdmission();
    if (!hold) return { ok: false };
    try {
      return { ok: true, value: await work() };
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
