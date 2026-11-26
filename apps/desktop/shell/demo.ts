import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import {
  ProductTasksStateSchema,
  type ProductTask,
} from "../../../src/modules/chat/contract/product-task";

// The demo shell's task list: the live runtime's tasks once it is ready, else
// the expected ones, all labelled as the synthetic local fixture. Outside demo
// mode the live registry's snapshot answers instead.

export type DemoTask = Readonly<{
  taskId: string;
  sessionId: string;
  turnId: string;
  label: string;
  hasComputer: boolean;
}>;

export type DemoTasksPorts = Readonly<{
  runtimeTasks: () => readonly DemoTask[] | undefined;
  expectedTasks: readonly DemoTask[];
  demoMode: boolean;
  liveSnapshot: () => ReturnType<LiveTaskRegistry["snapshot"]>;
}>;

export function createProductTasksState(ports: DemoTasksPorts) {
  function demoShellTasks(): readonly ProductTask[] {
    return (ports.runtimeTasks() ?? ports.expectedTasks).map((task) => ({
      taskId: task.taskId,
      sessionId: task.sessionId,
      turnId: task.turnId,
      label: task.label,
      provider: "fixture" as const,
      requestedModel: "Synthetic local fixture",
      observedModel: "Synthetic local fixture",
      requestedMode: "Deterministic demo",
      observedMode: "Deterministic demo",
      hasComputer: task.hasComputer,
      pinned: false,
      lifecycle: "event_driven" as const,
    }));
  }

  return {
    demoShellTasks,
    productTasksState() {
      return ports.demoMode
        ? ProductTasksStateSchema.parse({
            revision: 0,
            tasks: demoShellTasks(),
          })
        : ports.liveSnapshot();
    },
  };
}
