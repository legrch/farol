import { describe, expect, it } from "vitest";

import {
  ActivityLog,
  projectActivity,
  type SafeActivity,
} from "../../src/ui/activity-log";
import type { ClientEventDto } from "../../src/modules/chat/contract/client-event";

const identity = {
  ownerId: "OWNER-CANARY",
  sessionId: "SESSION-CANARY",
  taskId: "task-a",
  turnId: "turn-a",
  generation: 1,
  at: 1_000,
};

function project(event: ClientEventDto): SafeActivity {
  const projected = projectActivity(event);
  if (!projected) throw new Error("dropped");
  return projected;
}

describe("OBS-F1 activity keeps its links, not identities", () => {
  it("joins each Computer completion only to its own call and keeps a terminal code", () => {
    const log = new ActivityLog();
    for (const event of [
      {
        ...identity,
        kind: "computer.requested",
        callId: "call-1",
        operation: "workspace.read",
      },
      {
        ...identity,
        kind: "computer.requested",
        callId: "call-2",
        operation: "workspace.search",
      },
      { ...identity, kind: "computer.completed", callId: "call-2" },
      { ...identity, kind: "computer.completed", callId: "call-1" },
      {
        ...identity,
        kind: "turn.terminal",
        phase: "failed",
        code: "PROVIDER_LIMIT",
      },
    ] as ClientEventDto[]) {
      log.record(project(event));
    }

    expect(
      log.entries().map(({ kind, callId, operation, code }) => ({
        kind,
        callId,
        operation,
        code,
      })),
    ).toEqual([
      {
        kind: "computer.requested",
        callId: "call-1",
        operation: "workspace.read",
        code: null,
      },
      {
        kind: "computer.requested",
        callId: "call-2",
        operation: "workspace.search",
        code: null,
      },
      {
        kind: "computer.completed",
        callId: "call-2",
        operation: null,
        code: null,
      },
      {
        kind: "computer.completed",
        callId: "call-1",
        operation: null,
        code: null,
      },
      {
        kind: "turn.terminal",
        callId: null,
        operation: null,
        code: "PROVIDER_LIMIT",
      },
    ]);
    expect(JSON.stringify(log.entries())).not.toMatch(
      /OWNER-CANARY|SESSION-CANARY/u,
    );
  });
});

describe("OBS-F2 stream noise never evicts a lifecycle event", () => {
  it("folds 300 deltas of one turn and keeps another task's lifecycle event", () => {
    const log = new ActivityLog(8);
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      log.record(
        project({
          ...identity,
          kind: "text.delta",
          sequence,
          text: "x",
        } as ClientEventDto),
      );
    }
    log.record(
      project({
        ...identity,
        taskId: "task-b",
        kind: "turn.phase",
        phase: "running",
      } as ClientEventDto),
    );

    expect(log.entries()).toEqual([
      expect.objectContaining({
        taskId: "task-a",
        kind: "text.delta",
        sequence: 300,
        coalesced: 300,
      }),
      expect.objectContaining({ taskId: "task-b", kind: "turn.phase" }),
    ]);
    expect(log.omitted()).toBe(0);
  });

  it("drops the oldest stream records first and counts every drop", () => {
    const log = new ActivityLog(4);
    log.record(
      project({
        ...identity,
        kind: "turn.phase",
        phase: "running",
      } as ClientEventDto),
    );
    for (let turn = 1; turn <= 5; turn += 1) {
      log.record(
        project({
          ...identity,
          turnId: `turn-${turn}`,
          kind: "text.delta",
          sequence: 1,
          text: "x",
        } as ClientEventDto),
      );
    }

    expect(log.entries()[0]).toMatchObject({ kind: "turn.phase" });
    expect(log.entries()).toHaveLength(4);
    expect(log.omitted()).toBe(2);
  });

  it("keeps everything below the bound", () => {
    const log = new ActivityLog(4);
    log.record(
      project({
        ...identity,
        kind: "turn.phase",
        phase: "running",
      } as ClientEventDto),
    );
    log.record(
      project({
        ...identity,
        kind: "turn.terminal",
        phase: "completed",
        code: "OK",
      } as ClientEventDto),
    );
    expect(log.entries()).toHaveLength(2);
    expect(log.omitted()).toBe(0);
  });
});
