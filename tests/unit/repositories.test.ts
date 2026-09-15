import { describe, expect, it } from "vitest";
import { ActivityLog } from "../../src/modules/chat/infra/repo/activity-log";
import { InMemoryTurns } from "../../src/modules/chat/infra/repo/in-memory-turns";
import { createTurn } from "../../src/modules/chat/domain/turn";

const record = {
  taskId: "task-a",
  turnId: "turn-a",
  generation: 1,
  at: 1_000,
  kind: "phase" as const,
  phase: "prepared" as const,
  sequence: null,
  capability: null,
};

describe("bounded in-memory repositories", () => {
  it("rejects invalid Activity capacity and evicts the oldest safe record", async () => {
    expect(() => new ActivityLog(0)).toThrow("ACTIVITY_CAPACITY_INVALID");
    const log = new ActivityLog(1);
    await log.record(record);
    await log.record({ ...record, taskId: "task-b", at: 1_001 });
    expect(log.snapshot()).toEqual([
      { ...record, taskId: "task-b", at: 1_001 },
    ]);
  });

  it("returns an isolated Turn copy and no value for an unknown task", async () => {
    const turns = new InMemoryTurns();
    await expect(turns.get("missing")).resolves.toBeNull();
    const turn = createTurn({
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      turnId: "turn-a",
      generation: 1,
    });
    await turns.save(turn);
    await expect(turns.get("task-a")).resolves.toEqual(turn);
  });
});
