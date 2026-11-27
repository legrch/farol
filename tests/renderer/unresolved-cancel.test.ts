import { describe, expect, it } from "vitest";
import type { Intent, WindowSnapshot } from "../../src/ui/renderer/contract";
import { initial } from "../../apps/desktop/renderer/snapshot";
import { unresolvedActions } from "../../apps/desktop/renderer/unresolved-actions";

const REPEATABLE =
  "Farol could not confirm the Cancel. It may have taken effect. Cancel can be tried again while the turn runs, or use Stop in the ChatGPT window.";
const DEFAULT =
  "Farol could not confirm the result. The action may have taken effect; do not repeat it.";

const taskView = (over: Record<string, unknown>) =>
  ({
    taskId: "task-1",
    sessionId: "session-1",
    turnId: "turn-1",
    label: "ChatGPT task 1",
    provider: "chatgpt",
    requestedModel: null,
    observedModel: null,
    requestedMode: null,
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "outcome_unknown",
    ...over,
  }) as WindowSnapshot["tasks"]["tasks"][number];

function snapshotOf(
  intent: Intent,
  over: Record<string, unknown> = {},
): WindowSnapshot {
  return {
    ...initial,
    intents: { [intent.id]: intent },
    tasks: { revision: 1, tasks: [taskView(over)] },
  };
}
const unknown = (id: string, code: string): Intent => ({
  id,
  state: "unknown",
  code,
});
const causeOf = (snapshot: WindowSnapshot) =>
  unresolvedActions(snapshot).map((row) => row.cause);

describe("unresolved actions", () => {
  it("says an unconfirmed Cancel can be tried again while its turn runs", () => {
    const cancel = unknown("cancel:task-1", "TASK_CANCEL_FAILED");
    expect(causeOf(snapshotOf(cancel, { turnInFlight: true }))).toEqual([
      REPEATABLE,
    ]);
  });

  it("keeps the default wording once the turn has settled or for any other unknown", () => {
    const cancel = unknown("cancel:task-1", "TASK_CANCEL_FAILED");
    expect(causeOf(snapshotOf(cancel))).toEqual([DEFAULT]);
    expect(causeOf(snapshotOf(cancel, { lifecycle: "running" }))).toEqual([
      DEFAULT,
    ]);
    expect(
      causeOf(
        snapshotOf(unknown("cancel:task-1", "TASK_OUTCOME_UNKNOWN"), {
          turnInFlight: true,
        }),
      ),
    ).toEqual([DEFAULT]);
    expect(
      causeOf(
        snapshotOf(unknown("rename:task-1", "TASK_CANCEL_FAILED"), {
          turnInFlight: true,
        }),
      ),
    ).toEqual([DEFAULT]);
    // A Cancel of another task's turn does not make this one repeatable.
    expect(
      causeOf(
        snapshotOf(unknown("cancel:task-2", "TASK_CANCEL_FAILED"), {
          turnInFlight: true,
        }),
      ),
    ).toEqual([DEFAULT]);
  });
});
