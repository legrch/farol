import { describe, expect, it, vi } from "vitest";
import { ChatBridge } from "../../apps/desktop/bridge/chat.ts";
import type { Client } from "../../apps/desktop/bridge/client.ts";
import {
  requiresOperationID,
  type ChatHandle,
  type ChatState,
  type Json,
  type Outcome,
} from "../../apps/desktop/bridge/wire.ts";
const context = { profileId: "profile", backendGeneration: "generation" };
const handle: ChatHandle = {
  handleId: "h",
  binding: {
    ...context,
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    operationId: "operation",
    turnGeneration: "1",
  },
};
const state: ChatState = {
  handle,
  conversationId: "conversation",
  phase: "delivered",
  hasResult: true,
  deliveryAcknowledged: true,
  lifecycleSettled: true,
  released: true,
  followReady: true,
};
function fixture(change: (o: Outcome) => Outcome = (o) => o) {
  const request = vi.fn<Client["request"]>(
    async (_method, _body, options = {}) =>
      change({
        status: "ok",
        requestId: options.id!,
        context: { ...context },
        data: structuredClone(state) as unknown as Json,
      }),
  );
  return {
    request,
    bridge: new ChatBridge({
      request,
      verifiedContext: context,
    } as unknown as Client),
  };
}
describe("Go conversation state projection bridge", () => {
  it("reads without an effect operation and preserves exact Go status", async () => {
    const f = fixture();
    expect(await f.bridge.state(handle)).toEqual(state);
    expect(requiresOperationID("chat.conversation.state")).toBe(false);
    const [method, body, options] = f.request.mock.calls[0]!;
    expect(method).toBe("chat.conversation.state");
    expect(body).toEqual({ handleId: handle.handleId });
    expect(options?.operationId).toBeUndefined();
  });
  it.each([
    "handle",
    "task",
    "turn",
    "profile",
    "generation",
    "operation",
    "request",
  ])("rejects crossed %s", async (field) => {
    const f = fixture((o) => {
      if (field === "profile" || field === "generation")
        return {
          ...o,
          context: {
            ...context,
            ...(field === "profile"
              ? { profileId: "crossed" }
              : { backendGeneration: "crossed" }),
          },
        };
      if (field === "operation") return { ...o, operationId: "unexpected" };
      if (field === "request") return { ...o, requestId: "crossed" };
      const h = structuredClone(handle);
      const altered =
        field === "handle"
          ? { ...h, handleId: "crossed" }
          : {
              ...h,
              binding: {
                ...h.binding,
                ...(field === "task"
                  ? { taskId: "crossed" }
                  : { turnId: "crossed" }),
              },
            };
      return { ...o, data: { ...state, handle: altered } as unknown as Json };
    });
    await expect(f.bridge.state(handle)).rejects.toMatchObject({
      state: "unknown",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("does not repair unavailable owning state", async () => {
    const f = fixture((o) => ({
      requestId: o.requestId,
      context: o.context,
      status: "unknown",
      code: "CHAT_LIFECYCLE_UNSETTLED",
    }));
    await expect(f.bridge.state(handle)).rejects.toMatchObject({
      state: "unknown",
      code: "CHAT_LIFECYCLE_UNSETTLED",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
