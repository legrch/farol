import { describe, expect, it } from "vitest";
import { ClientEventSchema } from "../../src/modules/chat/contract/client-event";

const identity = {
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  turnId: "turn-a",
  generation: 1,
  at: 1_000,
};

describe("chat client event contract", () => {
  it.each(["completed", "cancelled", "failed", "outcome_unknown"])(
    "accepts a turn.terminal event whose phase %s is terminal",
    (phase) => {
      expect(
        ClientEventSchema.safeParse({
          ...identity,
          kind: "turn.terminal",
          phase,
          code: "TURN_FINISHED",
        }).success,
      ).toBe(true);
    },
  );

  // Every consumer treats turn.terminal as the end of the turn; one that
  // names a phase still in progress would end a stream that is not over.
  it.each(["prepared", "submit_activated", "running", "tool_wait"])(
    "refuses a turn.terminal event whose phase %s is still in progress",
    (phase) => {
      expect(
        ClientEventSchema.safeParse({
          ...identity,
          kind: "turn.terminal",
          phase,
          code: "TURN_FINISHED",
        }).success,
      ).toBe(false);
    },
  );
});
