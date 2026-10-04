import { createHash } from "node:crypto";
import { BridgeError } from "./bridge/client.ts";
import type { ChatComputerBridge } from "./bridge/chat-computer.ts";
import { validate, type ChatHandle } from "./bridge/wire.ts";
import {
  canonicalJson,
  type ResolvedCodexNativeToolCall,
} from "../../src/apps/desktop/codex-native-tool-registry";
import type {
  CodexCallerRelayInvocation,
  CodexCallerRelayOwnedResult,
} from "../../src/apps/desktop/codex-caller-relay";
import { CodexCallerRelayReceiptSchema } from "../../src/pkg/caller-relay/protocol";

// One explicitly selected whole-file read adapter for an actual Chat handle.
// The caller-relay turn must advertise only this capability. Other tools/ranges
// are refused; no legacy executor or replacement conversation is selected.
export function chatComputerReadRelay(
  bridge: Pick<ChatComputerBridge, "read" | "returned">,
  handle: ChatHandle,
): (
  request: ResolvedCodexNativeToolCall,
  context: CodexCallerRelayInvocation,
) => Promise<CodexCallerRelayOwnedResult> {
  if (!validate("ChatHandle", handle))
    throw new BridgeError("refused", "chat_computer_handle_invalid");
  const handleId = handle.handleId;
  return async (request, context) => {
    const args = request.arguments;
    if (
      request.name !== "computer_workspace_read" ||
      request.namespace !== null ||
      Object.keys(args).length !== 2 ||
      !Object.hasOwn(args, "workspaceId") ||
      !Object.hasOwn(args, "relativePath") ||
      typeof args.workspaceId !== "string" ||
      typeof args.relativePath !== "string" ||
      context.requestSHA256 !==
        createHash("sha256")
          .update(
            canonicalJson({
              name: request.name,
              namespace: request.namespace,
              arguments: args,
            }),
          )
          .digest("hex")
    )
      throw new BridgeError("refused", "chat_computer_tool_invalid");
    const result = await bridge.read({
      handleId,
      callId: context.operationId,
      relayBinding: context.binding,
      requestSHA256: context.requestSHA256,
      workspaceId: args.workspaceId,
      relativePath: args.relativePath,
    });
    const expected = Object.freeze({ ...result.receipt });
    let attempted = false;
    return {
      status: "known",
      output: result.output,
      onReceived: async (receipt) => {
        if (attempted)
          throw new BridgeError(
            "unknown",
            "chat_computer_return_already_attempted",
          );
        attempted = true;
        const parsed = CodexCallerRelayReceiptSchema.safeParse(receipt);
        if (
          !parsed.success ||
          parsed.data.operationId !== expected.callId ||
          parsed.data.binding !== expected.relayBinding ||
          parsed.data.requestSHA256 !== expected.requestSHA256 ||
          parsed.data.outputSHA256 !== expected.outputSHA256 ||
          String(parsed.data.outputBytes) !== expected.outputBytes
        )
          throw new BridgeError("unknown", "chat_computer_return_crossed");
        // Original Go opaque receipt stays private in this trusted closure. Only
        // known Go settlement permits the relay's positive confirmation.
        await bridge.returned(expected);
        return "acknowledged";
      },
    };
  };
}
