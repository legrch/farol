import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChatComputerBridge } from "../../apps/desktop/bridge/chat-computer.ts";
import type { Client } from "../../apps/desktop/bridge/client.ts";
import {
  validate,
  requiresOperationID,
  type ChatComputerRead,
  type ChatComputerOutput,
  type ComputerReadResponse,
  type Outcome,
  type Json,
} from "../../apps/desktop/bridge/wire.ts";

// Real bridge/validator, controlled transport. No native child or provider.
const input: ChatComputerRead = {
  handleId: "handle",
  callId: "relay-call",
  relayBinding: "a".repeat(64),
  requestSHA256: "b".repeat(64),
  workspaceId: "work",
  relativePath: "note.md",
};
function response(): ChatComputerOutput {
  const read: ComputerReadResponse = {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "9007199254740993",
    participantId: "participant",
    turnId: "turn",
    generation: "18446744073709551615",
    callId: input.callId,
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    text: "Hello 🍐",
    bytes: "10",
    sha256: "c".repeat(64),
  };
  const output = JSON.stringify(read);
  return {
    output,
    receipt: {
      receiptId: "receipt",
      handleId: input.handleId,
      callId: input.callId,
      relayBinding: input.relayBinding,
      requestSHA256: input.requestSHA256,
      outputSHA256: createHash("sha256").update(output).digest("hex"),
      outputBytes: String(Buffer.byteLength(output)),
    },
  };
}
function fixture(mutate: (outcome: Outcome) => Outcome = (value) => value) {
  const context = { profileId: "profile", backendGeneration: "backend" };
  const request = vi.fn<Client["request"]>(
    async (method, _body, options = {}) =>
      mutate({
        status: "ok",
        requestId: options.id!,
        operationId: options.operationId!,
        context: { ...context },
        data: (method === "chat.computer.read"
          ? response()
          : {}) as unknown as Json,
      }),
  );
  const client = { request, verifiedContext: context } as unknown as Client;
  return { bridge: new ChatComputerBridge(client), request };
}
describe("trusted Chat Computer bridge", () => {
  it("preserves exact output and returns it without automatic ACK", async () => {
    const f = fixture();
    const out = await f.bridge.read(input);
    expect(out).toEqual(response());
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[0]).toBe("chat.computer.read");
    expect(validate("ComputerReadResponse", JSON.parse(out.output))).toBe(true);
    await expect(f.bridge.returned(out.receipt)).resolves.toEqual({});
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1]?.[0]).toBe("chat.computer.return");
    expect(f.request.mock.calls[1]?.[1]).toEqual(out.receipt);
    expect(requiresOperationID("chat.computer.read")).toBe(true);
    expect(requiresOperationID("chat.computer.return")).toBe(true);
  });
  it.each([
    "handleId",
    "callId",
    "relayBinding",
    "requestSHA256",
    "outputSHA256",
    "outputBytes",
  ])("refuses crossed %s without ACK or resend", async (field) => {
    const f = fixture((out) => {
      const value = structuredClone(response());
      (value.receipt as unknown as Record<string, string>)[field] =
        field === "outputBytes"
          ? "1"
          : field.endsWith("SHA256") || field === "relayBinding"
            ? "d".repeat(64)
            : "other";
      return { ...out, data: value as unknown as Json };
    });
    await expect(f.bridge.read(input)).rejects.toMatchObject({
      state: "unknown",
      code: "chat_computer_output_crossed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["requestId", "operationId", "profileId", "backendGeneration"])(
    "rejects mismatched common %s",
    async (field) => {
      const f = fixture((out) =>
        field === "profileId" || field === "backendGeneration"
          ? { ...out, context: { ...out.context, [field]: "other" } }
          : { ...out, [field]: "other" },
      );
      await expect(f.bridge.read(input)).rejects.toMatchObject({
        code: "chat_computer_response_context",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["workspaceId", "relativePath", "callId", "page", "invalid-json"])(
    "rejects internally crossed or malformed Computer %s",
    async (field) => {
      const f = fixture((out) => {
        const value = response();
        const read = JSON.parse(value.output);
        if (field === "page") read.page = { offset: "0", size: "10" };
        else read[field] = "other";
        const output =
          field === "invalid-json" ? "not-json" : JSON.stringify(read);
        return {
          ...out,
          data: {
            ...value,
            output,
            receipt: {
              ...value.receipt,
              outputSHA256: createHash("sha256").update(output).digest("hex"),
              outputBytes: String(Buffer.byteLength(output)),
            },
          } as unknown as Json,
        };
      });
      await expect(f.bridge.read(input)).rejects.toMatchObject({
        state: "unknown",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["refused", "unknown", "unavailable", "unsupported"] as const)(
    "does not turn %s into another request",
    async (status) => {
      const f = fixture((out) => ({ ...out, status, code: "controlled" }));
      await expect(f.bridge.read(input)).rejects.toMatchObject({
        state: status,
        code: "controlled",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("captures immutable original input before awaiting the transport", async () => {
    const selected = { ...input };
    const f = fixture((out) => {
      selected.callId = "mutated";
      return out;
    });
    await expect(f.bridge.read(selected)).resolves.toEqual(response());
    expect(
      (f.request.mock.calls[0]?.[1] as Record<string, unknown>).callId,
    ).toBe(input.callId);
  });
  it("rejects body authority or invented returned flags before transport", async () => {
    const f = fixture();
    await expect(
      f.bridge.read({ ...input, ownerId: "supplied" } as ChatComputerRead),
    ).rejects.toMatchObject({ state: "refused" });
    const invented = { ...response().receipt, returned: true };
    await expect(f.bridge.returned(invented)).rejects.toMatchObject({
      state: "refused",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("rejects malformed positive return acknowledgement without a second resolve", async () => {
    const f = fixture((out) => ({ ...out, data: { returned: true } }));
    await expect(f.bridge.returned(response().receipt)).rejects.toMatchObject({
      state: "unknown",
      code: "chat_computer_response_invalid",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
