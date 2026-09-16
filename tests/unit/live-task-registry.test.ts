import { describe, expect, it } from "vitest";
import { LiveTaskRegistry } from "../../src/apps/desktop/live-task-registry";

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
});
