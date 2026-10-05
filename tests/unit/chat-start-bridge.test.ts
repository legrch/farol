import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ChatBridge } from "../../apps/desktop/bridge/chat.ts";
import type { Client } from "../../apps/desktop/bridge/client.ts";
import {
  validate,
  requiresOperationID,
  type ChatStart,
  type ChatStarted,
  type Json,
  type Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// Shared wire values only. The injected peer is not Go/provider qualification.
const fixture = JSON.parse(
  readFileSync(
    new URL("../../api/desktop/v1/fixtures/chat-start.json", import.meta.url),
    "utf8",
  ),
) as { input: ChatStart; output: ChatStarted };
const context = { profileId: "profile", backendGeneration: "backend" };
function peer(change: (out: Outcome) => Outcome = (o) => o) {
  const request = vi.fn<Client["request"]>(
    async (method, _input, options = {}) => {
      const output = structuredClone(fixture.output);
      const data =
        method === "chat.conversation.start"
          ? {
              ...output,
              handle: {
                ...output.handle,
                binding: {
                  ...output.handle.binding,
                  operationId: options.operationId!,
                },
              },
            }
          : {};
      return change({
        status: "ok",
        context,
        requestId: options.id!,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        data: data as unknown as Json,
      });
    },
  );
  return {
    request,
    bridge: new ChatBridge({
      request,
      verifiedContext: context,
    } as unknown as Client),
  };
}

describe("authorized ordinary Chat bridge", () => {
  it("uses the shared closed wire contract and one explicit effect", async () => {
    expect(validate("ChatStart", fixture.input)).toBe(true);
    expect(validate("ChatStarted", fixture.output)).toBe(true);
    expect(requiresOperationID("chat.conversation.start")).toBe(true);
    expect(requiresOperationID("chat.conversation.account.revoke")).toBe(true);
    const f = peer();
    const out = await f.bridge.start(fixture.input);
    expect(out.selection).toEqual(fixture.output.selection);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe("chat.conversation.start");
    expect(f.request.mock.calls[0]![1]).toEqual(fixture.input);
    expect(out.handle.binding.operationId).toBe(
      f.request.mock.calls[0]![2]?.operationId,
    );
  });
  it.each([
    "sessionId",
    "profileId",
    "backendGeneration",
    "operationId",
    "turnGeneration",
    "accountId",
    "resolved",
  ])("fences crossed %s without another attempt", async (field) => {
    const f = peer((o) => {
      const out = structuredClone(o.data) as unknown as ChatStarted;
      if (field === "accountId")
        return {
          ...o,
          data: {
            ...out,
            selection: { ...out.selection, accountId: "d".repeat(64) },
          } as unknown as Json,
        };
      if (field === "resolved")
        return {
          ...o,
          data: {
            ...out,
            resolution: {
              ...out.resolution,
              resolved: { ...out.selection, modelId: "other" },
            },
          } as unknown as Json,
        };
      return {
        ...o,
        data: {
          ...out,
          handle: {
            ...out.handle,
            binding: {
              ...out.handle.binding,
              [field]: field === "turnGeneration" ? "2" : "crossed",
            },
          },
        } as unknown as Json,
      };
    });
    await expect(f.bridge.start(fixture.input)).rejects.toMatchObject({
      state: "unknown",
      code: "chat_response_crossed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "refused"] as const)(
    "retains peer %s without retry",
    async (status) => {
      const f = peer((o) => {
        const { data: _data, ...original } = o;
        return { ...original, status, code: "original_outcome" };
      });
      await expect(f.bridge.start(fixture.input)).rejects.toMatchObject({
        state: status,
        code: "original_outcome",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses a renderer-supplied extra field before the peer", async () => {
    const f = peer();
    await expect(
      f.bridge.start({ ...fixture.input, approved: true } as ChatStart),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("sends account withdrawal as an independent explicit operation", async () => {
    const f = peer();
    await f.bridge.revokeAccount("handle");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe(
      "chat.conversation.account.revoke",
    );
    expect(f.request.mock.calls[0]![1]).toEqual({ handleId: "handle" });
    expect(f.request.mock.calls[0]![2]?.operationId).toBeTypeOf("string");
  });
});
