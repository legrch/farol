import { describe, expect, it } from "vitest";
import { adoptReadConversation } from "../../src/ui/renderer/read-conversation-state.ts";
import type { ReadConversationView } from "../../src/pkg/product-settings/chat-conversation.ts";
const binding = {
  profileId: "profile",
  backendGeneration: "backend",
  ownerId: "owner",
  sessionId: "session",
  taskId: "original",
  taskEpoch: "1",
  participantId: "participant",
  turnId: "turn",
  operationId: "admission-operation",
  turnGeneration: "1",
};
function view(
  overrides: Partial<ReadConversationView> = {},
): ReadConversationView {
  return {
    kind: "chatgpt.readonly-conversation",
    operationId: "original",
    handleId: "handle",
    binding,
    conversationId: "conversation",
    phase: "running",
    hasResult: false,
    deliveryAcknowledged: false,
    lifecycleSettled: false,
    released: false,
    followReady: false,
    cursor: "2",
    frames: [{ sequence: "1" }, { sequence: "2", delta: "Early output." }],
    ...overrides,
  };
}
const input = {
  action: "start" as const,
  operationId: "original",
  buildId: "build",
  revision: 1,
};
function initial() {
  return adoptReadConversation(null, view(), input)!;
}
function complete() {
  return view({
    phase: "result-ready",
    hasResult: true,
    frames: [],
    deliveryAcknowledged: true,
    lifecycleSettled: true,
    released: true,
    followReady: true,
    result: {
      resultId: "result",
      outcome: "completed",
      code: "",
      text: "Early output.",
      complete: true,
      acknowledged: true,
      retention: "memory_only",
    },
  });
}
const progress = {
  ...input,
  action: "progress" as const,
  handleId: "handle",
  cursor: "2",
};
describe("window-local Chat delivery adoption", () => {
  it("binds a typed start to the inspected session without fabricating a Computer task", () => {
    const typed = {
      ...input,
      action: "typed-start" as const,
      sessionId: "session",
    };
    const ordinary = view({ binding: { ...binding, taskId: "go-owned-task" } });
    const accepted = adoptReadConversation(null, ordinary, typed);
    expect(accepted?.origin).toBe("typed");
    expect(accepted?.turns[0]?.view.binding.taskId).toBe("go-owned-task");
    expect(adoptReadConversation(null, ordinary, input)).toBeNull();
    for (const change of [{ sessionId: "crossed" }, { turnGeneration: "2" }])
      expect(
        adoptReadConversation(
          null,
          view({ binding: { ...ordinary.binding, ...change } }),
          typed,
        ),
      ).toBeNull();
    expect(
      adoptReadConversation(null, ordinary, { ...typed, sessionId: "" }),
    ).toBeNull();
    expect(adoptReadConversation(accepted, ordinary, typed)).toBeNull();
    const progressed = adoptReadConversation(
      accepted,
      { ...ordinary, frames: [] },
      {
        ...typed,
        action: "progress",
        handleId: ordinary.handleId,
        cursor: ordinary.cursor,
      },
    );
    expect(progressed?.origin).toBe("typed");
  });
  it("correlates the preview with its Go task, preserving the distinct turn operation", () => {
    expect(initial()?.turns[0]?.view.binding.operationId).toBe(
      "admission-operation",
    );
    expect(
      adoptReadConversation(
        null,
        view({
          binding: {
            ...binding,
            taskId: "crossed-task",
            operationId: input.operationId,
          },
        }),
        input,
      ),
    ).toBeNull();
  });
  it("retains an early useful delta without inventing a result or ACK", () => {
    const s = initial();
    expect(s.turns[0]!.text).toBe("Early output.");
    expect(s.turns[0]!.view.result).toBeUndefined();
  });
  it("retains both turns and exact conversation identity across accepted Follow", () => {
    const settled = adoptReadConversation(initial(), complete(), progress)!;
    const second = view({
      handleId: "second",
      binding: {
        ...binding,
        turnId: "second-turn",
        operationId: "second-op",
        turnGeneration: "2",
      },
      frames: [{ sequence: "1", delta: "Next answer." }],
      cursor: "1",
    });
    const next = adoptReadConversation(settled, second, {
      ...input,
      action: "follow",
      handleId: "handle",
    });
    expect(next?.turns.map((t) => t.text)).toEqual([
      "Early output.",
      "Next answer.",
    ]);
    expect(next?.turns[0]!.view.result?.acknowledged).toBe(true);
  });
  it.each([
    "cursor",
    "gap",
    "identity",
    "backend",
    "conversation",
    "operation",
    "missing-result",
    "invented-ready",
  ])("preserves old display on crossed %s", (which) => {
    const next = view({ frames: [], cursor: "2" });
    if (which === "cursor") next.cursor = "3";
    if (which === "gap") {
      next.frames = [{ sequence: "4", delta: "gap" }];
      next.cursor = "4";
    }
    if (which === "identity") next.binding = { ...binding, taskId: "other" };
    if (which === "backend")
      next.binding = { ...binding, backendGeneration: "new" };
    if (which === "conversation") next.conversationId = "replacement";
    if (which === "operation") next.operationId = "other";
    if (which === "missing-result") next.hasResult = true;
    if (which === "invented-ready") next.followReady = true;
    const old = initial();
    const saved = structuredClone(old);
    expect(adoptReadConversation(old, next, progress)).toBeNull();
    expect(old).toEqual(saved);
  });
  it("rejects a result replacing generated output or a regressed ACK", () => {
    const changed = complete();
    changed.result!.text = "Changed";
    expect(adoptReadConversation(initial(), changed, progress)).toBeNull();
    const settled = adoptReadConversation(initial(), complete(), progress)!;
    const regressed = complete();
    regressed.deliveryAcknowledged = false;
    regressed.result!.acknowledged = false;
    regressed.followReady = false;
    expect(adoptReadConversation(settled, regressed, progress)).toBeNull();
  });
  it("refuses stale old-handle adoption after a successor became current", () => {
    const settled = adoptReadConversation(initial(), complete(), progress)!;
    const second = view({
      handleId: "second",
      binding: {
        ...binding,
        turnId: "next",
        operationId: "next-op",
        turnGeneration: "2",
      },
      frames: [],
      cursor: "0",
    });
    const next = adoptReadConversation(settled, second, {
      ...input,
      action: "follow",
      handleId: "handle",
    })!;
    expect(adoptReadConversation(next, complete(), progress)).toBeNull();
  });
  it("requires exact offered result identity for explicit ACK", () => {
    const offered = complete();
    offered.result!.acknowledged = false;
    offered.deliveryAcknowledged = false;
    offered.followReady = false;
    const previous = adoptReadConversation(initial(), offered, progress)!;
    expect(
      adoptReadConversation(previous, complete(), {
        ...progress,
        action: "ack",
        resultId: "wrong",
      }),
    ).toBeNull();
    expect(
      adoptReadConversation(previous, complete(), {
        ...progress,
        action: "ack",
        resultId: "result",
      }),
    ).not.toBeNull();
  });
  it("rejects another build/revision and a second initial Send", () => {
    expect(adoptReadConversation(initial(), view(), input)).toBeNull();
    expect(
      adoptReadConversation(initial(), complete(), {
        ...progress,
        buildId: "changed",
      }),
    ).toBeNull();
    expect(
      adoptReadConversation(initial(), complete(), {
        ...progress,
        revision: 2,
      }),
    ).toBeNull();
  });
});
