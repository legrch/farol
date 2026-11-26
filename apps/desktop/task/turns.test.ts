import { describe, expect, it } from "vitest";
import { createTurnLifecycle } from "./turns";

function build() {
  const written: string[] = [];
  const lifecycle = createTurnLifecycle({
    surfaceFor: async () => ({ ok: true, surface: {} as never }),
    apply: (taskId, value) => written.push(`${taskId}:${value}`),
  });
  const begin = (taskId = "t") => lifecycle.surfaces.surfaceFor(taskId);
  const settled = (state: "completed" | "outcome_unknown", taskId = "t") =>
    lifecycle.surfaces.settled?.(taskId, state);
  return { lifecycle, written, begin, settled };
}

describe("turn lifecycle", () => {
  it("writes the settled state of a turn nobody cancelled", async () => {
    const h = build();
    await h.begin();
    await h.settled("completed");
    await h.begin();
    await h.settled("outcome_unknown");
    expect(h.written).toEqual(["t:idle", "t:outcome_unknown"]);
  });

  it("does not open a turn for a refused admission", async () => {
    const lifecycle = createTurnLifecycle({
      surfaceFor: async () => ({ ok: false, code: "TASK_ROUTE_BUSY" }),
      apply: () => undefined,
    });
    await lifecycle.surfaces.surfaceFor("t");
    expect(lifecycle.startCancel("t").epoch).toBeNull();
  });

  it("applies the Cancel of a task with no turn in flight as it is", async () => {
    const h = build();
    const ticket = h.lifecycle.startCancel("t");
    expect(ticket.epoch).toBeNull();
    expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(true);
    expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(true);
    await h.begin();
    await h.settled("completed");
    // A turn that has settled is no longer one a Cancel starts on.
    expect(h.lifecycle.startCancel("t").epoch).toBeNull();
  });

  it("lets a confirmed Cancel stand over the abort's own settlement, in either order", async () => {
    const before = build();
    await before.begin();
    const first = before.lifecycle.startCancel("t");
    await before.settled("outcome_unknown");
    expect(before.lifecycle.finishCancel(first, "cancelled")).toBe(true);
    await before.settled("outcome_unknown");
    expect(before.written).toEqual(["t:outcome_unknown"]);

    const after = build();
    await after.begin();
    const second = after.lifecycle.startCancel("t");
    expect(after.lifecycle.finishCancel(second, "cancelled")).toBe(true);
    await after.settled("outcome_unknown");
    expect(after.written).toEqual([]);
  });

  it("does not let an unknown or stale Cancel overwrite another result", async () => {
    const h = build();
    await h.begin();
    const ticket = h.lifecycle.startCancel("t");
    await h.settled("completed");
    expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(false);
    await h.begin();
    expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(false);
    expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(false);
    // The replaced turn's own settlement is not skipped.
    await h.settled("completed");
    expect(h.written).toEqual(["t:idle", "t:idle"]);
  });

  it("writes nothing for a Cancel that started with no turn once a turn was admitted", async () => {
    const h = build();
    const ticket = h.lifecycle.startCancel("t");
    expect(ticket.epoch).toBeNull();
    await h.begin();
    expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(false);
    expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(false);

    // A turn that had settled before the Cancel started is no turn either, and
    // the next turn still takes the Cancel's write away.
    const settledFirst = build();
    await settledFirst.begin();
    await settledFirst.settled("completed");
    const second = settledFirst.lifecycle.startCancel("t");
    expect(second.epoch).toBeNull();
    expect(settledFirst.lifecycle.finishCancel(second, "cancelled")).toBe(true);
    await settledFirst.begin();
    expect(settledFirst.lifecycle.finishCancel(second, "cancelled")).toBe(
      false,
    );
  });

  it("forgets a closed task", async () => {
    const h = build();
    await h.begin();
    const ticket = h.lifecycle.startCancel("t");
    h.lifecycle.forget("t");
    expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(false);
  });
});
