import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chatComputerReadRelay } from "../../apps/desktop/go-chat-computer-relay";
import { ChatComputerBridge } from "../../apps/desktop/bridge/chat-computer";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client";
import type {
  ChatComputerRead,
  ChatComputerOutput,
  ChatHandle,
  Json,
  ComputerReadResponse,
} from "../../apps/desktop/bridge/wire";
import {
  canonicalJson,
  CodexNativeToolRegistry,
} from "../../src/apps/desktop/codex-native-tool-registry";
import type { CodexCallerRelayReceipt } from "../../src/pkg/caller-relay/protocol";

// Real registry -> selected adapter -> actual typed bridge; controlled Go
// transport complements the separate actual Go framed aggregate. No OS effects.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const handle: ChatHandle = {
  handleId: "selected",
  binding: {
    profileId: "profile",
    backendGeneration: "backend",
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    operationId: "chat-create",
    turnGeneration: "1",
  },
};
const descriptor = {
  type: "function",
  name: "computer_workspace_read",
  parameters: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      relativePath: { type: "string" },
    },
    required: ["workspaceId", "relativePath"],
    additionalProperties: false,
  },
};
function fixture(unknownReturn = false) {
  const requested = CodexNativeToolRegistry.parse([descriptor]).resolve({
    name: descriptor.name,
    arguments: { workspaceId: "work", relativePath: "note.md" },
  });
  const context = {
    operationId: "relay-call",
    binding: "a".repeat(64),
    requestSHA256: sha(
      canonicalJson({
        name: requested.name,
        namespace: requested.namespace,
        arguments: requested.arguments,
      }),
    ),
  };
  let retained!: ChatComputerOutput;
  const request = vi.fn<Client["request"]>(
    async (method, body, options = {}) => {
      if (method === "chat.computer.return" && unknownReturn)
        throw new BridgeError("unknown", "controlled-lost-resolve");
      let data: Json = {};
      if (method === "chat.computer.read") {
        const input = body as unknown as ChatComputerRead;
        const value: ComputerReadResponse = {
          ownerId: handle.binding.ownerId,
          sessionId: handle.binding.sessionId,
          taskId: handle.binding.taskId,
          taskEpoch: "1",
          participantId: handle.binding.participantId,
          turnId: handle.binding.turnId,
          generation: "1",
          callId: input.callId,
          workspaceId: input.workspaceId,
          relativePath: input.relativePath,
          text: "Retained file 🍐",
          bytes: "18",
          sha256: "c".repeat(64),
        };
        const output = JSON.stringify(value);
        retained = {
          output,
          receipt: {
            receiptId: "opaque-go-receipt",
            handleId: input.handleId,
            callId: input.callId,
            relayBinding: input.relayBinding,
            requestSHA256: input.requestSHA256,
            outputSHA256: sha(output),
            outputBytes: String(Buffer.byteLength(output)),
          },
        };
        data = retained as unknown as Json;
      }
      return {
        status: "ok",
        requestId: options.id!,
        operationId: options.operationId!,
        context: { profileId: "profile", backendGeneration: "backend" },
        data,
      };
    },
  );
  const bridge = new ChatComputerBridge({
    request,
    verifiedContext: { profileId: "profile", backendGeneration: "backend" },
  } as unknown as Client);
  const invoke = chatComputerReadRelay(bridge, handle);
  const receipt = (): CodexCallerRelayReceipt => ({
    operationId: context.operationId,
    binding: context.binding,
    requestSHA256: context.requestSHA256,
    receiptId: "d".repeat(64),
    outputSHA256: retained.receipt.outputSHA256,
    outputBytes: Number(retained.receipt.outputBytes),
  });
  return {
    invoke,
    request,
    requested,
    context,
    receipt,
    retained: () => retained,
  };
}
describe("selected Go Chat Computer relay join", () => {
  it("delivers one exact read and sends only its captured Go receipt after parsed-peer acknowledgement", async () => {
    const f = fixture();
    const result = await f.invoke(f.requested, f.context);
    expect(result.status).toBe("known");
    expect(result.output).toBe(f.retained().output);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[1]).toEqual({
      handleId: handle.handleId,
      callId: f.context.operationId,
      relayBinding: f.context.binding,
      requestSHA256: f.context.requestSHA256,
      workspaceId: "work",
      relativePath: "note.md",
    });
    await expect(result.onReceived(f.receipt())).resolves.toBe("acknowledged");
    expect(f.request.mock.calls[1]?.[1]).toEqual(f.retained().receipt);
    expect(f.request).toHaveBeenCalledTimes(2);
    await expect(result.onReceived(f.receipt())).rejects.toMatchObject({
      code: "chat_computer_return_already_attempted",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([
    "operationId",
    "binding",
    "requestSHA256",
    "outputSHA256",
    "outputBytes",
  ])("rejects crossed parsed %s before Go settlement", async (field) => {
    const f = fixture();
    const result = await f.invoke(f.requested, f.context);
    const receipt = {
      ...f.receipt(),
      [field]:
        field === "outputBytes"
          ? 1
          : field === "operationId"
            ? "other"
            : "f".repeat(64),
    };
    await expect(result.onReceived(receipt)).rejects.toMatchObject({
      code: "chat_computer_return_crossed",
    });
    await expect(result.onReceived(f.receipt())).rejects.toMatchObject({
      code: "chat_computer_return_already_attempted",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("never retries an unknown Go resolve through a new transport operation", async () => {
    const f = fixture(true);
    const result = await f.invoke(f.requested, f.context);
    await expect(result.onReceived(f.receipt())).rejects.toMatchObject({
      code: "controlled-lost-resolve",
    });
    await expect(result.onReceived(f.receipt())).rejects.toMatchObject({
      code: "chat_computer_return_already_attempted",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      "chat.computer.read",
      "chat.computer.return",
    ]);
  });
  it.each(["other-tool", "namespace", "window", "authority", "fingerprint"])(
    "refuses %s without any Go read or legacy fallback",
    async (kind) => {
      const f = fixture();
      let r = { ...f.requested };
      const c = { ...f.context };
      if (kind === "other-tool") r = { ...r, name: "other" };
      if (kind === "namespace") r = { ...r, namespace: "other" };
      if (kind === "window")
        r = { ...r, arguments: { ...r.arguments, offset: 0 } };
      if (kind === "authority")
        r = { ...r, arguments: { ...r.arguments, root: "/" } };
      if (kind === "fingerprint") c.requestSHA256 = "f".repeat(64);
      await expect(f.invoke(r, c)).rejects.toMatchObject({
        code: "chat_computer_tool_invalid",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("captures the selected handle before an external object changes", async () => {
    const f = fixture();
    const selected = structuredClone(handle);
    const bridge = new ChatComputerBridge({
      request: f.request,
      verifiedContext: { profileId: "profile", backendGeneration: "backend" },
    } as unknown as Client);
    const invoke = chatComputerReadRelay(bridge, selected);
    Object.assign(selected, { handleId: "changed" });
    await invoke(f.requested, f.context);
    expect(
      (f.request.mock.calls[0]?.[1] as Record<string, unknown>).handleId,
    ).toBe(handle.handleId);
  });
});
