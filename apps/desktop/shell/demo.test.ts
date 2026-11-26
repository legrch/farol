import { describe, expect, it } from "vitest";
import { createProductTasksState } from "./demo";

// The demo task list over plain owners: the runtime's tasks win once it is
// ready, every task is labelled as the synthetic fixture, and outside demo mode
// the live snapshot answers untouched.

const expected = [
  {
    taskId: "task-1",
    sessionId: "session-1",
    turnId: "turn-1",
    label: "Expected",
    hasComputer: false,
  },
];

function state(
  overrides: Partial<Parameters<typeof createProductTasksState>[0]> = {},
) {
  return createProductTasksState({
    runtimeTasks: () => undefined,
    expectedTasks: expected,
    demoMode: true,
    liveSnapshot: () => ({ revision: 9, tasks: [] }),
    ...overrides,
  });
}

describe("createProductTasksState", () => {
  it("lists the expected tasks as fixture tasks before the runtime is ready", () => {
    const result = state().productTasksState();
    expect(result.revision).toBe(0);
    expect(result.tasks).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        label: "Expected",
        provider: "fixture",
        requestedModel: "Synthetic local fixture",
        observedMode: "Deterministic demo",
        hasComputer: false,
        pinned: false,
        lifecycle: "event_driven",
      }),
    ]);
  });

  it("prefers the runtime's tasks once it is ready", () => {
    const result = state({
      runtimeTasks: () => [
        { ...expected[0]!, taskId: "task-2", hasComputer: true },
      ],
    }).productTasksState();
    expect(result.tasks.map((task) => task.taskId)).toEqual(["task-2"]);
    expect(result.tasks[0]?.hasComputer).toBe(true);
  });

  it("returns the live snapshot untouched outside demo mode", () => {
    const live = { revision: 9, tasks: [] };
    expect(
      state({ demoMode: false, liveSnapshot: () => live }).productTasksState(),
    ).toBe(live);
  });
});
