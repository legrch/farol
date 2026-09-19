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

// The other half of the promotion lease's mutual exclusion (see
// `promotion-lease.ts`): a momentary, synchronous check of the same lease
// file a promotion holds from before its drain check through placement. A
// task admitted after that check completes cannot be admitted once the
// lease is visible, which is exactly the gap the drain check's two reads
// cannot fence by themselves.
export type PromotionLeaseGuard = Readonly<{ isHeld(): boolean }>;

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

  admit(candidate: ProductTask): LiveTaskAdmission {
    const task = ProductTaskSchema.parse(candidate);
    if (this.promotionLease?.isHeld()) {
      return { status: "promotion_pending" };
    }
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
