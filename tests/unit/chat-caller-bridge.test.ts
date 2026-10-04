import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChatCallerBridge } from "../../apps/desktop/bridge/chat-caller.ts";
import type { Client } from "../../apps/desktop/bridge/client.ts";
import {
  requiresOperationID,
  validate,
  type ChatCallerBegin,
  type ChatCallerHandle,
  type ChatCallerAccept,
  type ChatCallerOutput,
  type Outcome,
  type Json,
} from "../../apps/desktop/bridge/wire.ts";

// Real typed bridge, controlled transport. No native process or provider.
const begin: ChatCallerBegin = {
  handleId: "handle",
  producerOperationId: "relay-operation",
  relayBinding: "a".repeat(64),
  requestSHA256: "b".repeat(64),
  scope: {
    sessionId: "session",
    threadId: "thread",
    turnId: "turn",
    rootTurnId: "root",
    model: "chatgpt",
  },
  call: {
    itemId: "fc_one",
    callId: "farol_next_call_" + "c".repeat(32),
    name: "read_file",
    arguments: '{"path":"note.md"}',
  },
};
const handle: ChatCallerHandle = {
  ticketId: "ticket",
  handleId: begin.handleId,
  producerOperationId: begin.producerOperationId,
  callId: begin.call.callId,
  relayBinding: begin.relayBinding,
  requestSHA256: begin.requestSHA256,
};
const accept: ChatCallerAccept = {
  handle,
  scope: begin.scope,
  calls: [begin.call],
  outputs: [
    {
      callId: begin.call.callId,
      raw: [{ type: "input_text", text: "Hello 🍐" }],
    },
  ],
};
function output(): ChatCallerOutput {
  const text = "Hello 🍐";
  return {
    output: text,
    receipt: {
      receiptId: "receipt",
      handle: structuredClone(handle),
      outputSHA256: createHash("sha256").update(text).digest("hex"),
      outputBytes: String(Buffer.byteLength(text)),
    },
  };
}
function fixture(mutate: (out: Outcome, method: string) => Outcome = (o) => o) {
  const context = { profileId: "profile", backendGeneration: "backend" };
  const request = vi.fn<Client["request"]>(
    async (method, _body, options = {}) =>
      mutate(
        {
          status: "ok",
          requestId: options.id!,
          operationId: options.operationId!,
          context: { ...context },
          data: (method === "chat.caller.begin"
            ? structuredClone(handle)
            : method === "chat.caller.output"
              ? output()
              : {}) as unknown as Json,
        },
        method,
      ),
  );
  return {
    bridge: new ChatCallerBridge({
      request,
      verifiedContext: context,
    } as unknown as Client),
    request,
  };
}
describe("Go caller-tool bridge", () => {
  it("checks the captured original token without an operation or automatic claim", async () => {
    const f = fixture();
    await expect(f.bridge.check(handle)).resolves.toEqual({});
    expect(f.request.mock.calls).toHaveLength(1);
    const [method, body, options] = f.request.mock.calls[0]!;
    expect(method).toBe("chat.caller.check");
    expect(body).toEqual(handle);
    expect(requiresOperationID(method)).toBe(false);
    expect(options?.operationId).toBeUndefined();
  });
  it("rejects a check reply carrying an effect operation identity", async () => {
    const f = fixture((o) => ({ ...o, operationId: "unexpected-effect" }));
    await expect(f.bridge.check(handle)).rejects.toMatchObject({
      state: "unknown",
      code: "chat_caller_response_context",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("keeps begin, dispatch, output and parsed-return as explicit distinct edges", async () => {
    const f = fixture();
    expect(await f.bridge.begin(begin)).toEqual(handle);
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.bridge.claim(handle);
    const result = await f.bridge.output(accept);
    expect(result).toEqual(output());
    expect(f.request).toHaveBeenCalledTimes(3);
    await f.bridge.returned(result.receipt);
    expect(f.request.mock.calls.map(([m]) => m)).toEqual([
      "chat.caller.begin",
      "chat.caller.claim",
      "chat.caller.output",
      "chat.caller.return",
    ]);
    for (const [m, , opts] of f.request.mock.calls) {
      expect(requiresOperationID(m)).toBe(true);
      expect(opts?.operationId).toBeTruthy();
    }
  });
  it.each([
    "handleId",
    "producerOperationId",
    "callId",
    "relayBinding",
    "requestSHA256",
  ])("refuses crossed begin %s", async (field) => {
    const f = fixture((o) => ({
      ...o,
      data: {
        ...handle,
        [field]:
          field === "relayBinding" || field === "requestSHA256"
            ? "d".repeat(64)
            : "other",
      },
    }));
    await expect(f.bridge.begin(begin)).rejects.toMatchObject({
      state: "unknown",
      code: "chat_caller_handle_crossed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    "ticketId",
    "handleId",
    "producerOperationId",
    "callId",
    "relayBinding",
    "requestSHA256",
    "outputSHA256",
    "outputBytes",
  ])("rejects crossed output %s without receipt", async (field) => {
    const f = fixture((o) => {
      const value = { ...output() };
      if (field === "outputBytes")
        value.receipt = { ...value.receipt, outputBytes: "1" };
      else if (field === "outputSHA256")
        value.receipt = { ...value.receipt, outputSHA256: "d".repeat(64) };
      else
        value.receipt = {
          ...value.receipt,
          handle: {
            ...value.receipt.handle,
            [field]:
              field === "relayBinding" || field === "requestSHA256"
                ? "d".repeat(64)
                : "other",
          },
        };
      return { ...o, data: value as unknown as Json };
    });
    await expect(f.bridge.output(accept)).rejects.toMatchObject({
      state: "unknown",
      code: "chat_caller_output_crossed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["requestId", "operationId", "profileId", "backendGeneration"])(
    "rejects common %s mismatch",
    async (field) => {
      const f = fixture((o) =>
        field === "profileId" || field === "backendGeneration"
          ? { ...o, context: { ...o.context, [field]: "other" } }
          : { ...o, [field]: "other" },
      );
      await expect(f.bridge.claim(handle)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_caller_response_context",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["refused", "unknown", "unavailable", "unsupported"] as const)(
    "never retries %s",
    async (status) => {
      const f = fixture((o) => ({ ...o, status, code: "controlled" }));
      await expect(f.bridge.begin(begin)).rejects.toMatchObject({
        state: status,
        code: "controlled",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("captures nested input before transport awaits", async () => {
    const input = {
      ...begin,
      call: { ...begin.call },
      scope: { ...begin.scope },
    };
    const f = fixture((o) => {
      input.call.callId = "changed";
      input.scope.threadId = "changed";
      return o;
    });
    expect(await f.bridge.begin(input)).toEqual(handle);
    expect(f.request.mock.calls[0]?.[1]).toEqual(begin);
  });
  it("refuses authority additions and plural tool rounds before transport", async () => {
    const f = fixture();
    await expect(
      f.bridge.output({ handle } as ChatCallerAccept),
    ).rejects.toMatchObject({
      state: "refused",
      code: "chat_caller_request_invalid",
    });
    await expect(
      f.bridge.begin({ ...begin, ownerId: "invented" } as ChatCallerBegin),
    ).rejects.toMatchObject({ state: "refused" });
    await expect(
      f.bridge.output({ ...accept, outputs: [] }),
    ).rejects.toMatchObject({ state: "refused" });
    await expect(
      f.bridge.returned({ ...output().receipt, returned: true } as never),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("rejects malformed positive claim and return without another operation", async () => {
    const f = fixture((o) => ({ ...o, data: { acknowledged: true } }));
    await expect(f.bridge.claim(handle)).rejects.toMatchObject({
      code: "chat_caller_response_invalid",
    });
    await expect(f.bridge.returned(output().receipt)).rejects.toMatchObject({
      code: "chat_caller_response_invalid",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("retains exact large counter strings and closed scope", () => {
    expect(
      validate("ChatCallerReceipt", {
        ...output().receipt,
        outputBytes: "18446744073709551615",
      }),
    ).toBe(true);
    expect(
      validate("ChatCallerScope", { ...begin.scope, model: "other" }),
    ).toBe(false);
    expect(validate("ChatCallerScope", { ...begin.scope, root: "/" })).toBe(
      false,
    );
  });
});
