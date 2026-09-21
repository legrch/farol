import { describe, expect, it } from "vitest";

import {
  TaskMutationGate,
  underTaskMutation,
} from "../../src/apps/desktop/task-mutation-gate";

// A promise this test settles by hand, so one mutation can be held open
// across another the way two real ones interleave in the main process.
function deferred(): Readonly<{ promise: Promise<void>; settle: () => void }> {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const busy = () => "busy" as const;

describe("S35-Q1 task mutation gate", () => {
  it("reports the gate free before anything claims it", () => {
    expect(new TaskMutationGate().inFlight()).toBe(false);
  });

  it("holds the gate for the whole of one mutation and frees it after", async () => {
    const gate = new TaskMutationGate();
    const work = deferred();

    const running = underTaskMutation(gate, busy, async () => {
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
      underTaskMutation(gate, busy, async () => {
        throw new Error("TASK_STATE_UNAVAILABLE");
      }),
    ).rejects.toThrow("TASK_STATE_UNAVAILABLE");
    expect(gate.inFlight()).toBe(false);
  });

  it("refuses a second mutation and never starts its work", async () => {
    const gate = new TaskMutationGate();
    const first = deferred();
    const started: string[] = [];

    const running = underTaskMutation(gate, busy, async () => {
      started.push("first");
      await first.promise;
      return "done" as const;
    });

    await expect(
      underTaskMutation(gate, busy, async () => {
        started.push("second");
        return "done" as const;
      }),
    ).resolves.toBe("busy");
    expect(started).toEqual(["first"]);

    first.settle();
    await running;
  });

  it("keeps the first mutation's claim when a refused one settles", async () => {
    const gate = new TaskMutationGate();
    const first = deferred();

    const running = underTaskMutation(gate, busy, async () => {
      await first.promise;
    });
    // A second mutation arrives and settles while the first is still in
    // flight. Its ending must not speak for a gate it never held.
    await underTaskMutation(gate, busy, async () => undefined);

    expect(gate.inFlight()).toBe(true);
    first.settle();
    await running;
    expect(gate.inFlight()).toBe(false);
  });

  it("ignores a release from a claim the gate no longer holds", () => {
    const gate = new TaskMutationGate();
    const stale = gate.tryEnter();

    stale?.release();
    const current = gate.tryEnter();
    stale?.release();

    expect(gate.inFlight()).toBe(true);
    current?.release();
    expect(gate.inFlight()).toBe(false);
  });

  it("ignores a second release from the same claim", () => {
    const gate = new TaskMutationGate();
    const mutation = gate.tryEnter();

    mutation?.release();
    mutation?.release();

    expect(gate.inFlight()).toBe(false);
  });
});
