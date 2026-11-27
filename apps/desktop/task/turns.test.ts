import { describe, expect, it } from "vitest";
import { createTurnLifecycle } from "./turns";

function build() {
  const written: string[] = [];
  // The route's page-turn epoch, as the route keeps it: advanced by the
  // admission of a turn and by nothing else, never cleared.
  const epochs = new Map<string, number>();
  const gone = new Set<string>();
  const ended: string[] = [];
  const lifecycle = createTurnLifecycle({
    surfaceFor: async (threadId) => {
      epochs.set(threadId, (epochs.get(threadId) ?? 0) + 1);
      return { ok: true, surface: {} as never };
    },
    apply: (taskId, value) => written.push(`${taskId}:${value}`),
    epoch: (taskId) => (gone.has(taskId) ? null : (epochs.get(taskId) ?? 0)),
    endAdmission: (taskId) => ended.push(taskId),
  });
  const begin = (taskId = "t") => lifecycle.surfaces.surfaceFor(taskId);
  const settled = (state: "completed" | "outcome_unknown", taskId = "t") =>
    lifecycle.surfaces.settled?.(taskId, state);
  return { lifecycle, written, begin, settled, epochs, gone, ended };
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

  it("takes the route's epoch for a Cancel, with no turn in flight when no turn was admitted", async () => {
    const h = build();
    expect(h.lifecycle.startCancel("t")).toEqual({
      taskId: "t",
      epoch: 0,
      inFlight: false,
      settled: false,
    });
    await h.begin();
    expect(h.lifecycle.startCancel("t")).toEqual({
      taskId: "t",
      epoch: 1,
      inFlight: true,
      settled: false,
    });
    await h.settled("completed");
    // A turn that has settled is no longer one a Cancel starts on, but its
    // epoch is still the route's: "no turn" never reads as the start again.
    expect(h.lifecycle.startCancel("t")).toEqual({
      taskId: "t",
      epoch: 1,
      inFlight: false,
      settled: true,
    });
  });

  it("applies the Cancel of a task no turn was ever admitted for as it is, while no turn is admitted", async () => {
    const h = build();
    const ticket = h.lifecycle.startCancel("t");
    expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(true);
    expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(true);
  });

  it("keeps a turn unknown after a Cancel of it ended unknown, and starts the next one clean", async () => {
    const h = build();
    await h.begin();
    const ticket = h.lifecycle.startCancel("t");
    expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(true);
    await h.settled("completed");
    expect(h.written).toEqual(["t:outcome_unknown"]);

    // The next turn starts clean.
    await h.begin();
    await h.settled("completed");
    expect(h.written).toEqual(["t:outcome_unknown", "t:idle"]);
  });

  it("never writes a Cancel over the result of a turn that settled before it started", async () => {
    for (const state of ["completed", "outcome_unknown"] as const) {
      const h = build();
      await h.begin();
      await h.settled(state);
      const ticket = h.lifecycle.startCancel("t");
      expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(false);
      expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(false);
      expect(h.written).toEqual([
        state === "completed" ? "t:idle" : "t:outcome_unknown",
      ]);
    }
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
    await h.begin();
    expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(false);
    expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(false);

    // A turn that had settled before the Cancel started keeps its result, and
    // the next turn takes the Cancel's write away as well.
    const settledFirst = build();
    await settledFirst.begin();
    await settledFirst.settled("completed");
    const second = settledFirst.lifecycle.startCancel("t");
    expect(settledFirst.lifecycle.finishCancel(second, "cancelled")).toBe(
      false,
    );
    await settledFirst.begin();
    expect(settledFirst.lifecycle.finishCancel(second, "cancelled")).toBe(
      false,
    );
  });

  it("writes nothing for a no-turn Cancel after a successor that was admitted, ran and ended", async () => {
    // The null-or-generation identity read "no turn" again here and let the
    // stale write through; the epoch is a different one.
    const h = build();
    await h.begin();
    await h.settled("completed");
    const ticket = h.lifecycle.startCancel("t");
    expect(ticket.inFlight).toBe(false);
    await h.begin();
    await h.settled("completed");
    expect(h.lifecycle.startCancel("t").inFlight).toBe(false);
    expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(false);
    expect(h.lifecycle.finishCancel(ticket, "outcome_unknown")).toBe(false);
    expect(h.written).toEqual(["t:idle", "t:idle"]);
  });

  it("holds the epoch of an admission that has begun but not finished", async () => {
    // The route advances its epoch at the start of the admission; this
    // lifecycle's own `surfaceFor` is still pending, so the turn is not yet
    // known to it. A Cancel that started before is stale all the same, and one
    // that starts during belongs to the turn being admitted.
    const h = build();
    const before = h.lifecycle.startCancel("t");
    h.epochs.set("t", 1);
    expect(h.lifecycle.finishCancel(before, "outcome_unknown")).toBe(false);
    const during = h.lifecycle.startCancel("t");
    expect(during).toEqual({
      taskId: "t",
      epoch: 1,
      inFlight: true,
      settled: false,
    });
    expect(h.lifecycle.finishCancel(during, "outcome_unknown")).toBe(true);
    // That Cancel ended unknown for the turn in flight: its settlement can no
    // longer say it ended normally.
    await h.settled("completed");
    expect(h.written).toEqual(["t:outcome_unknown"]);
  });

  it("ends the route's wait for a turn when its admission is refused or the turn settles", async () => {
    const refused = createTurnLifecycle({
      surfaceFor: async () => ({ ok: false, code: "TASK_ROUTE_BUSY" }),
      apply: () => undefined,
      epoch: () => 0,
      endAdmission: (taskId) => refusedEnded.push(taskId),
    });
    const refusedEnded: string[] = [];
    await refused.surfaces.surfaceFor("t");
    expect(refusedEnded).toEqual(["t"]);

    const h = build();
    await h.begin();
    expect(h.ended).toEqual([]);
    await h.settled("completed");
    expect(h.ended).toEqual(["t"]);
    // A turn that was cancelled also stops being waited for.
    await h.begin();
    h.lifecycle.finishCancel(h.lifecycle.startCancel("t"), "cancelled");
    await h.settled("outcome_unknown");
    expect(h.ended).toEqual(["t", "t"]);
  });

  it("forgets a closed task", async () => {
    const h = build();
    await h.begin();
    const ticket = h.lifecycle.startCancel("t");
    h.lifecycle.forget("t");
    h.gone.add("t");
    expect(h.lifecycle.finishCancel(ticket, "cancelled")).toBe(false);
  });
});
