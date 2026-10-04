import { describe, expect, it, vi } from "vitest";
import { ChatBridge } from "../../apps/desktop/bridge/chat.ts";
import type { Client } from "../../apps/desktop/bridge/client.ts";
import {
  requiresOperationID,
  type ChatHandle,
  type ChatSubmissionState,
  type Outcome,
  type Json,
} from "../../apps/desktop/bridge/wire.ts";
// Controlled transport only. State cannot authorize replay or guard release.
const handle: ChatHandle = {
  handleId: "handle",
  binding: {
    profileId: "profile",
    backendGeneration: "backend",
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "9007199254740993",
    participantId: "participant",
    turnId: "turn",
    operationId: "create",
    turnGeneration: "18446744073709551615",
  },
};
function fixture(
  state: ChatSubmissionState["state"] = "not-dispatched",
  mutate: (o: Outcome) => Outcome = (o) => o,
) {
  const context = { profileId: "profile", backendGeneration: "backend" };
  const request = vi.fn<Client["request"]>(
    async (_method, _body, options = {}) =>
      mutate({
        status: "ok",
        requestId: options.id!,
        context: { ...context },
        data: { handle: structuredClone(handle), state } as unknown as Json,
      }),
  );
  return {
    bridge: new ChatBridge({
      request,
      verifiedContext: context,
    } as unknown as Client),
    request,
  };
}
describe("Chat submission observation bridge", () => {
  it.each(["not-dispatched", "intent-committed", "unknown"] as const)(
    "reads %s without issuing an effect",
    async (state) => {
      const f = fixture(state);
      expect(await f.bridge.submission(handle)).toEqual({ handle, state });
      expect(f.request.mock.calls).toHaveLength(1);
      const [method, body, options] = f.request.mock.calls[0]!;
      expect(method).toBe("chat.conversation.submission");
      expect(body).toEqual({ handleId: handle.handleId });
      expect(requiresOperationID(method)).toBe(false);
      expect(options?.operationId).toBeUndefined();
    },
  );
  it.each(["handleId", "taskId", "taskEpoch", "turnGeneration"])(
    "refuses crossed %s",
    async (field) => {
      const f = fixture("not-dispatched", (o) => {
        const crossed = { ...handle, binding: { ...handle.binding } };
        if (field === "handleId") crossed.handleId = "other";
        else
          (crossed.binding as Record<string, string>)[field] =
            field === "taskId" ? "other" : "2";
        return {
          ...o,
          data: { handle: crossed, state: "not-dispatched" } as unknown as Json,
        };
      });
      await expect(f.bridge.submission(handle)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_submission_handle_crossed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["requestId", "operationId", "profileId", "backendGeneration"])(
    "refuses wrong common %s",
    async (field) => {
      const f = fixture("unknown", (o) =>
        field === "profileId" || field === "backendGeneration"
          ? { ...o, context: { ...o.context, [field]: "other" } }
          : { ...o, [field]: "other" },
      );
      await expect(f.bridge.submission(handle)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_response_context",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["released", "sent", "completed"])(
    "rejects invented %s classification",
    async (state) => {
      const f = fixture("unknown", (o) => ({
        ...o,
        data: { handle, state } as unknown as Json,
      }));
      await expect(f.bridge.submission(handle)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_response_invalid",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("does not interpret transport failure as not-dispatched", async () => {
    const f = fixture("unknown", (o) => ({
      ...o,
      status: "unknown",
      code: "controlled-lost-reply",
      data: null,
    }));
    await expect(f.bridge.submission(handle)).rejects.toMatchObject({
      state: "unknown",
      code: "controlled-lost-reply",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("captures nested handle identity before the transport await", async () => {
    const selected = { ...handle, binding: { ...handle.binding } };
    const f = fixture("intent-committed", (o) => {
      selected.binding.taskId = "changed";
      return o;
    });
    expect(await f.bridge.submission(selected)).toEqual({
      handle,
      state: "intent-committed",
    });
  });
  it("refuses an invalid authority-shaped handle before transport", async () => {
    const f = fixture();
    await expect(
      f.bridge.submission({ ...handle, root: "/" } as ChatHandle),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
  });
});
