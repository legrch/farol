import { describe, expect, it } from "vitest";

import {
  TaskMutationGate,
  underTaskMutation,
} from "../../src/apps/desktop/task-mutation-gate";

// A promise this test settles by hand, so two mutations can be held open
// across each other the way two real ones interleave in the main process.
function deferred(): Readonly<{ promise: Promise<void>; settle: () => void }> {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("S35-Q1 task mutation gate", () => {
  it("reports the gate free before anything claims it", () => {
    expect(new TaskMutationGate().inFlight()).toBe(false);
  });

  it("holds the gate for the whole of one mutation and frees it after", async () => {
    const gate = new TaskMutationGate();
    const work = deferred();

    const running = underTaskMutation(gate, async () => {
      await work.promise;
      return "done" as const;
    });
    expect(gate.inFlight()).toBe(true);

    work.settle();
    await expect(running).resolves.toBe("done");
    expect(gate.inFlight()).toBe(false);
  });

  it("frees the gate when the mutation throws", async () => {
    const gate = new TaskMutationGate();

    await expect(
      underTaskMutation(gate, async () => {
        throw new Error("TASK_STATE_UNAVAILABLE");
      }),
    ).rejects.toThrow("TASK_STATE_UNAVAILABLE");
    expect(gate.inFlight()).toBe(false);
  });

  it("ignores a second release from the same claim", () => {
    const gate = new TaskMutationGate();
    const mutation = gate.enter();

    mutation.release();
    mutation.release();

    expect(gate.inFlight()).toBe(false);
  });
});
