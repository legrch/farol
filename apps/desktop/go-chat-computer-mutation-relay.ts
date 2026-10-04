import { createHash } from "node:crypto";
import { BridgeError } from "./bridge/client.ts";
import type { ChatComputerBridge } from "./bridge/chat-computer.ts";
import {
  checkedChatComputerMutationOutput,
  type ChatComputerMutationBridge,
} from "./bridge/chat-computer-mutation.ts";
import {
  validate,
  type ChatHandle,
  type ChatComputerWrite,
  type ChatComputerEdit,
} from "./bridge/wire.ts";
import {
  canonicalJson,
  type ResolvedCodexNativeToolCall,
} from "../../src/apps/desktop/codex-native-tool-registry";
import type {
  CodexCallerRelayInvocation,
  CodexCallerRelayOwnedResult,
} from "../../src/apps/desktop/codex-caller-relay";
import { CodexCallerRelayReceiptSchema } from "../../src/pkg/caller-relay/protocol";

// An explicitly selected two-tool adapter. No filesystem execution, recovery
// effect, browser authority or automatic return is inferred from its output.
export function chatComputerMutationRelay(
  mutationBridge: Pick<ChatComputerMutationBridge, "write" | "edit">,
  returnBridge: Pick<ChatComputerBridge, "returned">,
  handle: ChatHandle,
): (
  request: ResolvedCodexNativeToolCall,
  context: CodexCallerRelayInvocation,
) => Promise<CodexCallerRelayOwnedResult> {
  if (!validate("ChatHandle", handle))
    throw new BridgeError("refused", "chat_computer_mutation_handle_invalid");
  const selectedHandle = { ...handle, binding: { ...handle.binding } };
  return async (request, context) => {
    const kind =
      request.name === "computer_workspace_write"
        ? "write"
        : request.name === "computer_workspace_edit"
          ? "edit"
          : undefined;
    const args = request.arguments;
    if (
      !kind ||
      request.namespace !== null ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      throw new BridgeError("refused", "chat_computer_mutation_tool_invalid");
    // Validate the merged DTO, but forbid arguments that could override or
    // manufacture the adapter's selected authority/correlation fields.
    const keys =
      kind === "write"
        ? [
            "operationId",
            "workspaceId",
            "relativePath",
            "content",
            "expectedSha256",
          ]
        : [
            "operationId",
            "workspaceId",
            "relativePath",
            "expectedSha256",
            "edits",
          ];
    const input = {
      workspaceId: args.workspaceId,
      relativePath: args.relativePath,
      ...(kind === "write" ? { content: args.content } : { edits: args.edits }),
      ...(args.expectedSha256 === null && kind === "write"
        ? {}
        : { expectedSHA256: args.expectedSha256 }),
      handleId: selectedHandle.handleId,
      callId: context.operationId,
      relayBinding: context.binding,
      requestSHA256: context.requestSHA256,
    };
    if (
      Object.keys(args).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(args, key)) ||
      Object.keys(args).some((key) => !keys.includes(key)) ||
      !validate("id", args.operationId) ||
      (args.operationId as string).length > 120 ||
      !validate("id", args.workspaceId) ||
      (args.workspaceId as string).length > 120 ||
      !validate(
        kind === "write" ? "ChatComputerWrite" : "ChatComputerEdit",
        input,
      ) ||
      (kind === "edit" &&
        ((input as unknown as ChatComputerEdit).edits.length === 0 ||
          !Array.from((input as unknown as ChatComputerEdit).edits).every(
            (edit) => validate("ComputerTextEdit", edit),
          )))
    )
      throw new BridgeError("refused", "chat_computer_mutation_tool_invalid");
    if (
      kind === "write"
        ? (input as unknown as ChatComputerWrite).content.includes("\0")
        : (input as unknown as ChatComputerEdit).edits.some(
            (edit) =>
              edit.oldText === edit.newText ||
              edit.oldText.includes("\0") ||
              edit.newText.includes("\0"),
          )
    )
      throw new BridgeError("refused", "chat_computer_mutation_tool_invalid");
    const canonical = canonicalJson(args);
    if (
      request.encodedArguments !== canonical ||
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
      throw new BridgeError("refused", "chat_computer_mutation_tool_invalid");
    const selected: ChatComputerWrite | ChatComputerEdit =
      kind === "write"
        ? { ...(input as unknown as ChatComputerWrite) }
        : {
            ...(input as unknown as ChatComputerEdit),
            edits: (input as unknown as ChatComputerEdit).edits.map((edit) => ({
              ...edit,
            })),
          };
    const operationId = args.operationId as string;
    const out =
      kind === "write"
        ? await mutationBridge.write(
            { ...selected } as ChatComputerWrite,
            operationId,
          )
        : await mutationBridge.edit(
            {
              ...selected,
              edits: (selected as ChatComputerEdit).edits.map((edit) => ({
                ...edit,
              })),
            } as ChatComputerEdit,
            operationId,
          );
    const result = checkedChatComputerMutationOutput(
      selectedHandle,
      selected,
      kind,
      out,
      operationId,
    );
    const expected = Object.freeze({ ...result.receipt });
    let attempted = false;
    return {
      status: "known",
      output: result.output,
      onReceived: async (receipt) => {
        if (attempted)
          throw new BridgeError(
            "unknown",
            "chat_computer_mutation_return_already_attempted",
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
          throw new BridgeError(
            "unknown",
            "chat_computer_mutation_return_crossed",
          );
        // Use the original parsed-relay ACK join, with the private Go receipt.
        // Consume the attempt even when the return transport loses its reply.
        await returnBridge.returned(expected);
        return "acknowledged";
      },
    };
  };
}
