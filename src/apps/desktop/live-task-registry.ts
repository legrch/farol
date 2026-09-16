import {
  ProductTaskLifecycleSchema,
  ProductTaskSchema,
  ProductTasksStateSchema,
  type ProductTask,
  type ProductTaskLifecycle,
  type ProductTasksState,
} from "../../modules/chat/contract/product-task";

export type LiveTaskAdmission =
  | Readonly<{ status: "admitted"; task: ProductTask }>
  | Readonly<{ status: "capacity" | "duplicate" }>;

export class LiveTaskRegistry {
  private readonly tasks: ProductTask[] = [];
  private revision = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 5) {
      throw new Error("LIVE_TASK_CAPACITY_INVALID");
    }
  }

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

  get(taskId: string): ProductTask | null {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    return task ? { ...task } : null;
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

  snapshot(): ProductTasksState {
    return ProductTasksStateSchema.parse({
      revision: this.revision,
      tasks: this.tasks,
    });
  }
}
