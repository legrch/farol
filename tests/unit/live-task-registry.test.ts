import { describe, expect, it } from "vitest";
import { LiveTaskRegistry } from "../../src/apps/desktop/live-task-registry";
import { ProductTaskCommandSchema } from "../../src/modules/chat/contract/product-task";

function candidate(index: number) {
  return {
    taskId: `task-${index}`,
    sessionId: `session-${index}`,
    turnId: `turn-${index}`,
    label: `ChatGPT task ${index}`,
    provider: "chatgpt" as const,
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle" as const,
  };
}

describe("live task registry", () => {
  it("accepts only bounded explicit Product Agent commands", () => {
    expect(
      ProductTaskCommandSchema.parse({
        kind: "task.start-agent",
        taskId: "task-1",
        workspaceId: "workspace-a",
        objective: "Inspect the approved workspace and summarize the risk.",
        scope: { mode: "workspace", excludedPaths: [] },
      }),
    ).toEqual({
      kind: "task.start-agent",
      taskId: "task-1",
      workspaceId: "workspace-a",
      objective: "Inspect the approved workspace and summarize the risk.",
      scope: { mode: "workspace", excludedPaths: [] },
    });
    expect(
      ProductTaskCommandSchema.parse({
        kind: "task.rejoin-agent",
        taskId: "task-1",
      }),
    ).toEqual({ kind: "task.rejoin-agent", taskId: "task-1" });
    expect(
      ProductTaskCommandSchema.safeParse({
        kind: "task.start-agent",
        taskId: "task-1",
        workspaceId: "workspace-a",
        objective: "\0",
        scope: { mode: "workspace", excludedPaths: [] },
      }).success,
    ).toBe(false);
    expect(
      ProductTaskCommandSchema.safeParse({
        kind: "task.start-agent",
        taskId: "task-1",
        workspaceId: "workspace-a",
        objective: "Inspect one explicitly narrowed subtree.",
        scope: {
          mode: "subtree",
          relativeRoot: "../private",
          excludedPaths: [],
        },
      }).success,
    ).toBe(false);
    expect(
      ProductTaskCommandSchema.safeParse({
        kind: "task.start-agent",
        taskId: "task-1",
        workspaceId: "workspace-a",
        objective: "Inspect exact approved files.",
        scope: {
          mode: "exact",
          relativePaths: ["README.md", "README.md"],
        },
      }).success,
    ).toBe(false);
    expect(
      ProductTaskCommandSchema.safeParse({
        kind: "task.start-agent",
        taskId: "task-1",
        workspaceId: "workspace-a",
        objective: "Inspect exact approved files.",
        scope: {
          mode: "exact",
          relativePaths: ["docs/*.md"],
        },
      }).success,
    ).toBe(false);
  });

  it("admits caller-owned opaque task identities and advances its revision", () => {
    const registry = new LiveTaskRegistry(5);

    expect(registry.snapshot()).toEqual({ revision: 0, tasks: [] });
    expect(registry.admit(candidate(1))).toEqual({
      status: "admitted",
      task: candidate(1),
    });
    expect(registry.snapshot()).toEqual({
      revision: 1,
      tasks: [candidate(1)],
    });
  });

  it("keeps five live tasks and refuses a sixth without replacing one", () => {
    const registry = new LiveTaskRegistry(5);
    for (let index = 1; index <= 5; index += 1) {
      expect(registry.admit(candidate(index)).status).toBe("admitted");
    }

    expect(registry.admit(candidate(6))).toEqual({ status: "capacity" });
    expect(registry.snapshot()).toEqual({
      revision: 5,
      tasks: [1, 2, 3, 4, 5].map(candidate),
    });
  });

  it("rejects duplicate task, session, or turn identities", () => {
    const registry = new LiveTaskRegistry(5);
    expect(registry.admit(candidate(1)).status).toBe("admitted");

    expect(registry.admit(candidate(1))).toEqual({ status: "duplicate" });
    expect(
      registry.admit({ ...candidate(2), sessionId: candidate(1).sessionId }),
    ).toEqual({ status: "duplicate" });
    expect(
      registry.admit({ ...candidate(3), turnId: candidate(1).turnId }),
    ).toEqual({ status: "duplicate" });
    expect(registry.snapshot().revision).toBe(1);
  });

  it("updates only an admitted task lifecycle", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));

    expect(registry.setLifecycle("missing", "failed")).toBe(false);
    expect(registry.snapshot().revision).toBe(1);
    expect(registry.setLifecycle("task-1", "running")).toBe(true);
    expect(registry.snapshot()).toEqual({
      revision: 2,
      tasks: [{ ...candidate(1), lifecycle: "running" }],
    });
  });

  it("carries the in-flight turn mark only while it is set, and advances the revision only on a change", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));
    const revision = registry.snapshot().revision;

    expect(registry.setTurnInFlight("missing", true)).toBe(false);
    // Clearing a mark that was never set changes nothing.
    expect(registry.setTurnInFlight("task-1", false)).toBe(false);
    expect(registry.snapshot().revision).toBe(revision);

    expect(registry.setTurnInFlight("task-1", true)).toBe(true);
    expect(registry.get("task-1")?.turnInFlight).toBe(true);
    expect(registry.snapshot().revision).toBe(revision + 1);
    expect(registry.setTurnInFlight("task-1", true)).toBe(false);
    // Another change to the task keeps the mark.
    registry.setLifecycle("task-1", "outcome_unknown");
    expect(registry.get("task-1")?.turnInFlight).toBe(true);

    expect(registry.setTurnInFlight("task-1", false)).toBe(true);
    expect(registry.get("task-1")).toEqual({
      ...candidate(1),
      lifecycle: "outcome_unknown",
    });
    expect(registry.get("task-1")).not.toHaveProperty("turnInFlight");
  });

  it("never lowers the published revision on a rollback, and keeps the live in-flight mark", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));
    registry.admit(candidate(2));
    const before = registry.snapshot();

    registry.rename("task-1", "Lost");
    registry.setTurnInFlight("task-2", true);
    const published = registry.snapshot().revision;
    expect(published).toBeGreaterThan(before.revision);

    registry.rollback(before);
    const restored = registry.snapshot();
    expect(restored.revision).toBeGreaterThan(published);
    expect(restored.tasks[0]?.label).toBe(candidate(1).label);
    // A mark set after the snapshot is the run's, not the command's.
    expect(restored.tasks[1]?.turnInFlight).toBe(true);
    // A mark the snapshot carried is not restored over a live registry without.
    registry.setTurnInFlight("task-2", false);
    const marked = {
      ...before,
      tasks: before.tasks.map((task) => ({ ...task, turnInFlight: true })),
    };
    registry.rollback(marked);
    expect(registry.get("task-2")).not.toHaveProperty("turnInFlight");
    expect(registry.snapshot().revision).toBeGreaterThan(restored.revision);

    // A task the command removed comes back with the mark its snapshot had.
    registry.setTurnInFlight("task-1", true);
    const withMark = registry.snapshot();
    registry.remove("task-1");
    registry.rollback(withMark);
    expect(registry.get("task-1")?.turnInFlight).toBe(true);
  });

  it("never lowers a live outcome_unknown lifecycle on a rollback, and still reverts the command's own change", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));
    registry.admit(candidate(2));
    registry.setLifecycle("task-1", "running");
    const before = registry.snapshot();

    // The command's own change, and an unknown outcome another path writes
    // while the command waits for its save.
    registry.rename("task-1", "Lost");
    registry.setPinned("task-2", true);
    registry.setLifecycle("task-1", "outcome_unknown");
    registry.rollback(before);

    expect(registry.get("task-1")).toEqual({
      ...candidate(1),
      lifecycle: "outcome_unknown",
    });
    // The other task, and every other field, are the snapshot's.
    expect(registry.get("task-2")).toEqual(candidate(2));
    expect(registry.snapshot().tasks.map((task) => task.taskId)).toEqual([
      "task-1",
      "task-2",
    ]);
  });

  it("restores the snapshot's outcome_unknown over a live lifecycle that is more certain", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));
    registry.setLifecycle("task-1", "outcome_unknown");
    const before = registry.snapshot();

    registry.setLifecycle("task-1", "running");
    registry.rollback(before);
    expect(registry.get("task-1")?.lifecycle).toBe("outcome_unknown");
  });

  it("keeps a live outcome_unknown Agent or context phase, and restores the snapshot's otherwise", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));
    const agent = {
      assignmentBindingSha256: "a".repeat(64),
      phase: "running" as const,
      workspaceId: "workspace-a",
      parentDelivery: "not_applicable" as const,
      workspaceEnforcement: "verified" as const,
      resultAvailable: false,
    };
    const context = {
      epoch: 1,
      phase: "active" as const,
      source: null,
      code: null,
    };
    registry.setAgent("task-1", agent);
    registry.setContext("task-1", context);
    const before = registry.snapshot();

    const unknownAgent = { ...agent, phase: "outcome_unknown" as const };
    const unknownContext = { ...context, phase: "outcome_unknown" as const };
    registry.setAgent("task-1", unknownAgent);
    registry.setContext("task-1", unknownContext);
    registry.rollback(before);
    expect(registry.get("task-1")?.agent).toEqual(unknownAgent);
    expect(registry.get("task-1")?.context).toEqual(unknownContext);

    // A live phase that is not unknown is the command's to revert.
    registry.setAgent("task-1", { ...agent, phase: "completed" });
    registry.setContext("task-1", { ...context, phase: "validated" });
    registry.rollback(before);
    expect(registry.get("task-1")?.agent).toEqual(agent);
    expect(registry.get("task-1")?.context).toEqual(context);

    // A task the command removed has no live record: its snapshot's stands.
    registry.setAgent("task-1", unknownAgent);
    const unknownSnapshot = registry.snapshot();
    registry.remove("task-1");
    registry.rollback(unknownSnapshot);
    expect(registry.get("task-1")?.agent).toEqual(unknownAgent);
  });

  it("stores only content-free Agent state on the visible task", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));
    const agent = {
      assignmentBindingSha256: "a".repeat(64),
      phase: "running" as const,
      workspaceId: "workspace-a",
      parentDelivery: "not_applicable" as const,
      workspaceEnforcement: "not_applicable" as const,
      resultAvailable: false,
    };

    expect(registry.setAgent("missing", agent)).toBe(false);
    expect(registry.setAgent("task-1", agent)).toBe(true);
    expect(registry.snapshot()).toEqual({
      revision: 2,
      tasks: [{ ...candidate(1), agent }],
    });
    expect(JSON.stringify(registry.snapshot())).not.toMatch(
      /objective|assignmentId|authorityId|participantId/iu,
    );
    expect(registry.setAgent("task-1", agent)).toBe(true);
    expect(registry.snapshot().revision).toBe(2);
  });

  it("stores only content-free context continuity state on the visible task", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));
    const context = {
      epoch: 2,
      phase: "checkpoint_requested" as const,
      source: "canonical_history" as const,
      code: null,
    };

    expect(registry.setContext("missing", context)).toBe(false);
    expect(registry.setContext("task-1", context)).toBe(true);
    expect(registry.snapshot()).toEqual({
      revision: 2,
      tasks: [{ ...candidate(1), context }],
    });
    expect(JSON.stringify(registry.snapshot())).not.toMatch(
      /canonicalHistory|checkpointContent|prompt|answer/iu,
    );
  });

  it("renames, pins, and closes tasks without changing their identities", () => {
    const registry = new LiveTaskRegistry(5);
    registry.admit(candidate(1));
    registry.admit(candidate(2));

    expect(registry.rename("task-1", "Owner review")).toBe(true);
    expect(registry.setPinned("task-2", true)).toBe(true);
    expect(registry.snapshot().tasks).toEqual([
      { ...candidate(2), pinned: true },
      { ...candidate(1), label: "Owner review" },
    ]);
    expect(registry.remove("task-2")).toEqual({
      ...candidate(2),
      pinned: true,
    });
    expect(registry.get("task-2")).toBeNull();
  });

  it("restores a validated durable snapshot exactly once", () => {
    const registry = new LiveTaskRegistry(5);
    registry.restore({ revision: 9, tasks: [candidate(1), candidate(2)] });

    expect(registry.snapshot()).toEqual({
      revision: 9,
      tasks: [candidate(1), candidate(2)],
    });
    expect(() =>
      registry.restore({ revision: 10, tasks: [candidate(3)] }),
    ).toThrow("LIVE_TASK_REGISTRY_NOT_EMPTY");
  });
  it("restores and rolls back a Route B task whose thread is its task and session identity", () => {
    // A Codex host thread runs in the Farol task with the same identity, so
    // taskId and sessionId are equal by design; only another task may not
    // reuse any of the three identities.
    const routeB = {
      ...candidate(1),
      taskId: "thread-1",
      sessionId: "thread-1",
      turnId: "turn-1",
      label: "Codex task 1",
    };
    const registry = new LiveTaskRegistry(5);
    expect(() =>
      registry.restore({ revision: 3, tasks: [routeB, candidate(2)] }),
    ).not.toThrow();
    expect(registry.get("thread-1")).toEqual(routeB);
    expect(() =>
      registry.rollback({ revision: 4, tasks: [routeB] }),
    ).not.toThrow();
    for (const twin of [
      { ...candidate(3), taskId: "thread-1" },
      { ...candidate(3), sessionId: "thread-1" },
      { ...candidate(3), turnId: "turn-1" },
    ]) {
      expect(() =>
        registry.rollback({ revision: 5, tasks: [routeB, twin] }),
      ).toThrow("LIVE_TASK_IDENTITY_DUPLICATE");
    }
  });
});
