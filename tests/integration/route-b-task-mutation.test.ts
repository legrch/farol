import { describe, expect, it } from "vitest";

import type {
  RouteBConversationSurface,
  RouteBSurfaceAdmission,
} from "../../src/apps/desktop/route-b-runtime";
import { createRouteBTaskLifecycle } from "../../src/apps/desktop/route-b-task-lifecycle";
import {
  TaskMutationGate,
  underTaskMutation,
} from "../../src/apps/desktop/task-mutation-gate";

// A promise the test settles by hand, so one mutation can be held open across
// another the way two real ones interleave in the main process.
function deferred(): Readonly<{ promise: Promise<void>; settle: () => void }> {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const surface = {
  dispose: () => undefined,
} as unknown as RouteBConversationSurface;

const threadA = "0199c0de-0000-7000-8000-00000000d001";

/**
 * The lifecycle, wired to the real gate exactly as `main.ts` wires it: its
 * `mutationInFlight` port reads the gate, and its `admitTask` port is
 * `admitRouteBTask`, which is `underTaskMutation` around the admission body.
 *
 * `residue` is the await `surfaceFor` performs between reading
 * `mutationInFlight` and calling `admitTask` — for a thread that is not yet a
 * live task it removes any Agent-input residue and then deletes any retained
 * context, so there are two real filesystem round trips in that gap.
 */
function compose(gate: TaskMutationGate) {
  const admitted: string[] = [];
  const residue = deferred();
  const lifecycle = createRouteBTaskLifecycle<null>({
    owns: () => false,
    existingSurface: () => null,
    liveTask: () => false,
    markRunning: async () => true,
    mutationInFlight: () => gate.inFlight(),
    admissionReady: () => true,
    admitTask: (threadId): Promise<RouteBSurfaceAdmission> =>
      underTaskMutation<RouteBSurfaceAdmission>(
        gate,
        () => ({ ok: false as const, code: "TASK_ROUTE_BUSY" }),
        async () => {
          admitted.push(threadId);
          return { ok: true as const, surface };
        },
      ),
    removeAgentInput: async () => {
      await residue.promise;
    },
    snapshotTasks: () => null,
    removeTask: () => true,
    rollbackTasks: () => undefined,
    persist: async () => undefined,
    deleteContext: async () => "none" as const,
    disposeRoute: () => undefined,
  });
  return { admitted, residue, lifecycle };
}

describe("S35-Q1 route B admission and the task mutation gate", () => {
  it("admits a thread that arrives while no task mutation is running", async () => {
    const gate = new TaskMutationGate();
    const { admitted, residue, lifecycle } = compose(gate);

    const pending = lifecycle.surfaceFor(threadA);
    residue.settle();

    await expect(pending).resolves.toEqual({ ok: true, surface });
    expect(admitted).toEqual([threadA]);
    expect(gate.inFlight()).toBe(false);
  });

  it("refuses a thread whose free-gate reading went stale in the residue gap", async () => {
    const gate = new TaskMutationGate();
    const { admitted, residue, lifecycle } = compose(gate);

    // The thread passes `mutationInFlight` while the gate is free, then parks
    // in the residue removal.
    const pending = lifecycle.surfaceFor(threadA);
    // A task command — `task.start-agent`, say — claims the gate meanwhile.
    const command = gate.tryEnter();
    expect(command).not.toBeNull();
    residue.settle();
    const result = await pending;

    expect(result).toEqual({ ok: false, code: "TASK_ROUTE_BUSY" });
    expect(admitted).toEqual([]);
    // The task command is still running: nothing but its own handle may free
    // the gate it holds.
    expect(gate.inFlight()).toBe(true);
    command?.release();
    expect(gate.inFlight()).toBe(false);
  });
});
