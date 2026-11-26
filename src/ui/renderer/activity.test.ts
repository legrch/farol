import { describe, expect, it } from "vitest";
import {
  appendActivity,
  eventEntry,
  operationsPatch,
  operationsReadFailure,
} from "./activity";
import type { ActivityEntry } from "./contract";

const entry = (id: string): ActivityEntry => ({
  id,
  taskId: "t",
  turnId: "u",
  generation: 0,
  label: "Task",
  kind: "turn.phase",
  at: 1,
  phase: null,
  operation: null,
  code: null,
});

describe("eventEntry", () => {
  const base = {
    ownerId: "o",
    sessionId: "s",
    taskId: "t",
    turnId: "u",
    generation: 2,
    at: 5,
  };
  it("addresses the entry by task, turn, generation and ordinal", () => {
    const made = eventEntry(
      { ...base, kind: "turn.phase", phase: "running" } as never,
      "Label",
      7,
    );
    expect(made).toEqual({
      id: "t:u:2:7",
      taskId: "t",
      turnId: "u",
      generation: 2,
      label: "Label",
      kind: "turn.phase",
      at: 5,
      phase: "running",
      operation: null,
      code: null,
    });
  });
  it("labels an unknown task and hides non-displayable codes", () => {
    const made = eventEntry(
      { ...base, kind: "turn.failed", code: "not a code" } as never,
      undefined,
      1,
    );
    expect(made.label).toBe("Task");
    expect(made.code).toBe("DIAGNOSTIC_CODE_UNAVAILABLE");
  });
});

describe("appendActivity", () => {
  it("keeps only the newest 256 entries", () => {
    const old = Array.from({ length: 256 }, (_, i) => entry(`e${i}`));
    const next = appendActivity(old, entry("new"));
    expect(next).toHaveLength(256);
    expect(next[0]?.id).toBe("e1");
    expect(next.at(-1)?.id).toBe("new");
    expect(old).toHaveLength(256);
  });
});

describe("operationsPatch", () => {
  const snapshot = (entries: unknown[], extra: object = {}) =>
    ({ entries, corruptLines: 0, ...extra }) as never;
  const row = (patch: object) => ({
    kind: "computer.read_file",
    outcome: "applied",
    code: null,
    target: {},
    ...patch,
  });
  it("labels rows and joins their targets", () => {
    const patch = operationsPatch(
      snapshot([
        row({
          target: {
            workspace: "w",
            relativePath: "p",
            handle: "h",
            start: "unknown",
          },
        }),
        row({ outcome: "unknown" }),
        row({ code: "FRESH_SESSION_INTERRUPTED_COMMAND_UNKNOWN" }),
      ]),
    );
    const [first, second, third] = patch.activity ?? [];
    expect(first?.label).toBe("computer read file");
    expect(first?.operation).toBe("w · p · Handle h (start unknown)");
    expect(second?.phase).toBe("outcome_unknown");
    expect(second?.operation).toBeNull();
    expect(third?.label).toBe("Interrupted command: outcome unknown");
    expect(patch.connectionChecking).toBe(false);
  });
  it("marks only a started lifecycle that is still active", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const patch = operationsPatch(
      snapshot(
        [
          row({ lifecycle: { phase: "started", id } }),
          row({ lifecycle: { phase: "started", id: "other" } }),
        ],
        { activeLifecycleIds: [id], connectionChecking: true },
      ),
    );
    expect(patch.activity?.[0]?.inFlight).toBe(true);
    expect(patch.activity?.[1]?.inFlight).toBeUndefined();
    expect(patch.connectionChecking).toBe(true);
  });
  it("projects diagnostics, with a fresh object per read failure", () => {
    const patch = operationsPatch(
      snapshot([], { corruptLines: 3, readPending: true }),
    );
    expect(patch.activityDiagnostics?.corruptLines).toBe(3);
    expect(patch.activityDiagnostics?.readPending).toBe(true);
    expect(operationsReadFailure().activityDiagnostics).toEqual({
      corruptLines: 0,
      writeFailures: 1,
    });
    expect(operationsReadFailure().activityDiagnostics).not.toBe(
      operationsReadFailure().activityDiagnostics,
    );
  });
});
