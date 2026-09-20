import { describe, expect, it } from "vitest";
import { TaskMenuTrace } from "../../src/ui/task-menu-trace";

function traceAt(times: number[]): TaskMenuTrace {
  let index = 0;
  return new TaskMenuTrace(() => times[Math.min(index++, times.length - 1)]!);
}

describe("what happened to a task-menu command", () => {
  it("records the phases in the order they happen", () => {
    const trace = traceAt([0, 40, 42]);
    trace.dispatch("task.rename");
    expect(trace.phase()).toBe("in-flight");
    trace.settle("ok");
    expect(trace.phase()).toBe("settled:ok");
    trace.noted();
    expect(trace.phase()).toBe("noted");
    expect(trace.serialize()).toBe("task.rename 40ms/ok note 42ms");
  });

  it("names which silence it is when the note never arrives", () => {
    // The three are not interchangeable: the first is a slow or lost IPC,
    // the second and third are the renderer returning above the line that
    // writes the note. A wait on the note's text cannot tell them apart,
    // which is why it expires instead of reporting.
    for (const reason of ["no-task", "not-live", "menu-closed"] as const) {
      const trace = traceAt([0, 30]);
      trace.dispatch("task.start-agent");
      trace.settle("ok");
      trace.skipped(reason);
      expect(trace.phase()).toBe(`not-noted:${reason}`);
      expect(trace.serialize()).toContain(`no note (${reason})`);
    }
  });

  it("keeps a command that never settled distinguishable from one that did", () => {
    const trace = traceAt([0]);
    trace.dispatch("task.cancel");
    expect(trace.phase()).toBe("in-flight");
    expect(trace.serialize()).toBe("task.cancel … no note");
  });

  it("marks an earlier command superseded once a newer one starts", () => {
    const trace = traceAt([0, 10, 20, 25, 30]);
    trace.dispatch("task.rename");
    trace.settle("ok");
    trace.dispatch("task.pin");
    expect(trace.read()[0]?.superseded).toBe(true);
    expect(trace.read()[1]?.superseded).toBe(false);
    expect(trace.serialize()).toContain("superseded");
  });

  it("does not supersede a command that already reached its note", () => {
    const trace = traceAt([0, 5, 6, 20]);
    trace.dispatch("task.rename");
    trace.settle("ok");
    trace.noted();
    trace.dispatch("task.pin");
    expect(trace.read()[0]?.superseded).toBe(false);
  });

  it("keeps the first outcome for a command, not the last render's", () => {
    // renderTaskMenu runs many times per command; the note's timestamp must
    // stay the one where it first appeared.
    const trace = traceAt([0, 5, 9, 90]);
    trace.dispatch("task.rename");
    trace.settle("ok");
    trace.noted();
    trace.noted();
    expect(trace.read()[0]?.notedAt).toBe(9);
  });

  it("stays bounded however many commands run", () => {
    const trace = traceAt([0]);
    for (let index = 0; index < 20; index += 1) trace.dispatch("task.pin");
    expect(trace.read()).toHaveLength(4);
  });

  it("admits nothing but command kinds, fixed tokens and milliseconds", () => {
    // The serialized form goes into a DOM attribute an E2E failure prints.
    // It must be incapable of carrying a label, a path or an error body, so
    // the only caller-supplied value is the command kind, which is the
    // product's own closed vocabulary.
    const trace = traceAt([0, 12]);
    trace.dispatch("task.rename");
    trace.settle("refused");
    trace.skipped("no-task");
    const serialized = trace.serialize();
    expect(serialized).toBe("task.rename 12ms/refused no note (no-task)");
    for (const entry of trace.read()) {
      expect(Object.keys(entry).sort()).toEqual([
        "dispatchedAt",
        "kind",
        "notedAt",
        "outcome",
        "settledAt",
        "skipped",
        "superseded",
      ]);
      expect(typeof entry.kind).toBe("string");
      expect(entry.dispatchedAt).toBeTypeOf("number");
    }
  });

  it("says nothing at all before any command has run", () => {
    const trace = traceAt([0]);
    expect(trace.phase()).toBe("none");
    expect(trace.serialize()).toBe("");
  });
});
