import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chatComputerMutationRelay } from "../../apps/desktop/go-chat-computer-mutation-relay.ts";
import { ChatComputerMutationBridge } from "../../apps/desktop/bridge/chat-computer-mutation.ts";
import { ChatComputerBridge } from "../../apps/desktop/bridge/chat-computer.ts";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client.ts";
import type {
  ChatHandle,
  ChatComputerWrite,
  ChatComputerEdit,
  ChatComputerOutput,
  ComputerMutationResponse,
  Json,
} from "../../apps/desktop/bridge/wire.ts";
import {
  canonicalJson,
  type ResolvedCodexNativeToolCall,
} from "../../src/apps/desktop/codex-native-tool-registry";
import type { CodexCallerRelayReceipt } from "../../src/pkg/caller-relay/protocol";

// Selected TS adapter, real typed bridges and controlled transport. No native
// constructor, filesystem operation, Go child, browser, socket or provider.
const sha = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");
const handle: ChatHandle = {
  handleId: "selected",
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
function selected(
  name = "computer_workspace_write",
  args: Readonly<Record<string, unknown>> = {
    operationId: "original-effect",
    workspaceId: "work",
    relativePath: "note.md",
    content: "Hello 🍐",
    expectedSha256: "c".repeat(64),
  },
) {
  const request: ResolvedCodexNativeToolCall = {
    name,
    namespace: null,
    arguments: args,
    encodedArguments: canonicalJson(args),
  };
  const context = {
    operationId: "relay-call",
    binding: "a".repeat(64),
    requestSHA256: sha(
      canonicalJson({ name, namespace: null, arguments: args }),
    ),
  };
  return { request, context };
}
function fixture(
  change: (value: ComputerMutationResponse) => ComputerMutationResponse = (
    value,
  ) => value,
  lostReturn = false,
) {
  let retained!: ChatComputerOutput;
  const request = vi.fn<Client["request"]>(
    async (method, body, options = {}) => {
      if (method === "chat.computer.return" && lostReturn)
        throw new BridgeError("unknown", "lost-original-return");
      let data: Json = {};
      if (method === "chat.computer.write" || method === "chat.computer.edit") {
        const input = body as unknown as ChatComputerWrite | ChatComputerEdit;
        const result = change({
          operationId: options.operationId!,
          workspaceId: input.workspaceId,
          callId: input.callId,
          turnId: handle.binding.turnId,
          generation: handle.binding.turnGeneration,
          phase: "completed",
          publication: "durable",
          receipt: {
            operation: "content" in input ? "write" : "edit",
            relativePath: input.relativePath,
            bytes:
              "content" in input
                ? String(Buffer.byteLength(input.content, "utf8"))
                : "10",
            replacements: "edits" in input ? input.edits.length : 0,
            ...(input.expectedSHA256
              ? { beforeSHA256: input.expectedSHA256 }
              : {}),
            afterSHA256:
              "content" in input ? sha(input.content) : "d".repeat(64),
          },
        });
        const output = JSON.stringify(result);
        retained = {
          output,
          receipt: {
            receiptId: "private-go-receipt",
            handleId: input.handleId,
            callId: input.callId,
            relayBinding: input.relayBinding,
            requestSHA256: input.requestSHA256,
            outputSHA256: sha(output),
            outputBytes: String(Buffer.byteLength(output, "utf8")),
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
  const client = {
    request,
    verifiedContext: { profileId: "profile", backendGeneration: "backend" },
  } as unknown as Client;
  const mutation = new ChatComputerMutationBridge(client, handle);
  const returns = new ChatComputerBridge(client);
  const invoke = chatComputerMutationRelay(mutation, returns, handle);
  const receipt = (
    context: ReturnType<typeof selected>["context"],
  ): CodexCallerRelayReceipt => ({
    operationId: context.operationId,
    binding: context.binding,
    requestSHA256: context.requestSHA256,
    receiptId: "e".repeat(64),
    outputSHA256: retained.receipt.outputSHA256,
    outputBytes: Number(retained.receipt.outputBytes),
  });
  return {
    invoke,
    request,
    mutation,
    returns,
    receipt,
    retained: () => retained,
  };
}

describe("selected Go Chat Computer mutation relay", () => {
  it("maps the required nullable write preimage to the canonical optional wire hash", async () => {
    const f = fixture();
    const call = selected("computer_workspace_write", {
      operationId: "original-effect",
      workspaceId: "work",
      relativePath: "new.md",
      content: "",
      expectedSha256: null,
    });
    const out = await f.invoke(call.request, call.context);
    expect(f.request.mock.calls[0]?.[1]).not.toHaveProperty("expectedSHA256");
    expect(f.request.mock.calls[0]?.[1]).not.toHaveProperty("expectedSha256");
    expect(f.request.mock.calls[0]?.[1]).not.toHaveProperty("operationId");
    expect(f.request.mock.calls[0]?.[2]?.operationId).toBe("original-effect");
    expect(JSON.parse(out.output)).toMatchObject({
      operationId: "original-effect",
      receipt: { bytes: "0", afterSHA256: sha("") },
    });
    expect(JSON.parse(out.output).receipt).not.toHaveProperty("beforeSHA256");
    await expect(out.onReceived(f.receipt(call.context))).resolves.toBe(
      "acknowledged",
    );
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("fences one stable original operation under a different relay callId without re-execution", async () => {
    const f = fixture();
    const call = selected();
    await f.invoke(call.request, call.context);
    await expect(
      f.invoke(call.request, {
        ...call.context,
        operationId: "different-relay-call",
      }),
    ).rejects.toMatchObject({
      code: "chat_computer_mutation_already_attempted",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[2]?.operationId).toBe("original-effect");
  });
  it.each(["write", "edit"] as const)(
    "delivers one %s and uses the original parsed-ACK return bridge",
    async (kind) => {
      const call =
        kind === "write"
          ? selected()
          : selected("computer_workspace_edit", {
              operationId: "original-effect",
              workspaceId: "work",
              relativePath: "note.md",
              expectedSha256: "c".repeat(64),
              edits: [{ oldText: "before", newText: "after 🍐" }],
            });
      const f = fixture();
      const result = await f.invoke(call.request, call.context);
      expect(result.status).toBe("known");
      expect(result.output).toBe(f.retained().output);
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.request.mock.calls[0]?.[0]).toBe(`chat.computer.${kind}`);
      const { operationId, expectedSha256, ...wireArgs } =
        call.request.arguments;
      expect(f.request.mock.calls[0]?.[1]).toEqual({
        ...wireArgs,
        expectedSHA256: expectedSha256,
        handleId: handle.handleId,
        callId: call.context.operationId,
        relayBinding: call.context.binding,
        requestSHA256: call.context.requestSHA256,
      });
      expect(f.request.mock.calls[0]?.[2]?.operationId).toBe(operationId);
      expect(JSON.parse(result.output).operationId).toBe(operationId);
      const original = structuredClone(f.retained().receipt);
      await expect(result.onReceived(f.receipt(call.context))).resolves.toBe(
        "acknowledged",
      );
      expect(f.request.mock.calls[1]?.[0]).toBe("chat.computer.return");
      expect(f.request.mock.calls[1]?.[1]).toEqual(original);
      await expect(
        result.onReceived(f.receipt(call.context)),
      ).rejects.toMatchObject({
        code: "chat_computer_mutation_return_already_attempted",
      });
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it("preserves a known durable failure for the original delivery/ACK lifecycle", async () => {
    const f = fixture((value) => {
      const { receipt: _receipt, ...rest } = value;
      return {
        ...rest,
        phase: "failed",
        failure: {
          code: "WORKSPACE_MUTATION_CONFLICT",
          source: "native-workspace",
          retry: "never",
        },
      };
    });
    const call = selected();
    const out = await f.invoke(call.request, call.context);
    expect(JSON.parse(out.output)).toMatchObject({ phase: "failed" });
    expect(JSON.parse(out.output)).not.toHaveProperty("receipt");
    await expect(out.onReceived(f.receipt(call.context))).resolves.toBe(
      "acknowledged",
    );
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      "chat.computer.write",
      "chat.computer.return",
    ]);
  });
  it.each([
    "operationId",
    "binding",
    "requestSHA256",
    "outputSHA256",
    "outputBytes",
    "invented",
  ])(
    "consumes the sole onReceived attempt on crossed parsed %s",
    async (field) => {
      const f = fixture();
      const call = selected();
      const out = await f.invoke(call.request, call.context);
      const receipt = f.receipt(call.context);
      const crossed =
        field === "invented"
          ? { ...receipt, returned: true }
          : {
              ...receipt,
              [field]:
                field === "outputBytes"
                  ? 1
                  : field === "operationId"
                    ? "other"
                    : "f".repeat(64),
            };
      await expect(out.onReceived(crossed)).rejects.toMatchObject({
        code: "chat_computer_mutation_return_crossed",
      });
      await expect(out.onReceived(receipt)).rejects.toMatchObject({
        code: "chat_computer_mutation_return_already_attempted",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("does not repeat or observe after a lost original return ACK", async () => {
    const f = fixture((value) => value, true);
    const call = selected();
    const out = await f.invoke(call.request, call.context);
    await expect(out.onReceived(f.receipt(call.context))).rejects.toMatchObject(
      { code: "lost-original-return" },
    );
    await expect(out.onReceived(f.receipt(call.context))).rejects.toMatchObject(
      { code: "chat_computer_mutation_return_already_attempted" },
    );
    await expect(f.invoke(call.request, call.context)).rejects.toMatchObject({
      code: "chat_computer_mutation_already_attempted",
    });
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      "chat.computer.write",
      "chat.computer.return",
    ]);
  });
  it("keeps the original Go receipt private after mutable port/caller objects change", async () => {
    const f = fixture();
    const call = selected();
    const out = await f.invoke(call.request, call.context);
    const ack = f.receipt(call.context);
    const expected = structuredClone(f.retained().receipt);
    Object.assign(f.retained().receipt, {
      receiptId: "changed",
      callId: "changed",
      outputSHA256: "f".repeat(64),
    });
    Object.assign(f.retained(), { output: "changed" });
    Object.assign(call.context, {
      operationId: "changed",
      requestSHA256: "f".repeat(64),
    });
    await expect(out.onReceived(ack)).resolves.toBe("acknowledged");
    Object.assign(ack, { outputSHA256: "f".repeat(64) });
    expect(f.request.mock.calls[1]?.[1]).toEqual(expected);
    expect(out.output).not.toBe("changed");
  });
  it.each([
    "other-tool",
    "read-tool",
    "namespace",
    "extra-authority",
    "extra-handle",
    "fingerprint",
    "encoded-args",
    "missing-content",
    "wrong-content",
    "wrong-hash",
    "wire-uppercase",
    "missing-operation",
    "missing-preimage",
    "invalid-operation",
  ])("refuses %s before any effect or legacy fallback", async (kind) => {
    const f = fixture();
    const call = selected();
    let r = { ...call.request };
    const c = { ...call.context };
    if (kind === "other-tool") r.name = "other";
    if (kind === "read-tool") r.name = "computer_workspace_read";
    if (kind === "namespace") r.namespace = "other";
    if (kind === "extra-authority") r.arguments = { ...r.arguments, root: "/" };
    if (kind === "extra-handle")
      r.arguments = { ...r.arguments, handleId: "other" };
    if (kind === "fingerprint") c.requestSHA256 = "f".repeat(64);
    if (kind === "encoded-args") r.encodedArguments = "{}";
    if (kind === "missing-content") {
      const { content: _content, ...rest } = r.arguments;
      r.arguments = rest;
    }
    if (kind === "wrong-content") r.arguments = { ...r.arguments, content: 3 };
    if (kind === "wrong-hash")
      r.arguments = { ...r.arguments, expectedSha256: "bad" };
    if (kind === "wire-uppercase") {
      const { expectedSha256, ...rest } = r.arguments;
      r.arguments = { ...rest, expectedSHA256: expectedSha256 };
    }
    if (kind === "missing-operation") {
      const { operationId: _operation, ...rest } = r.arguments;
      r.arguments = rest;
    }
    if (kind === "missing-preimage") {
      const { expectedSha256: _preimage, ...rest } = r.arguments;
      r.arguments = rest;
    }
    if (kind === "invalid-operation")
      r.arguments = { ...r.arguments, operationId: "invalid operation" };
    await expect(f.invoke(r, c)).rejects.toMatchObject({
      state: "refused",
      code: "chat_computer_mutation_tool_invalid",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    { name: "empty", edits: [] },
    { name: "sparse", edits: Array(1) },
    { name: "empty oldText", edits: [{ oldText: "", newText: "x" }] },
    {
      name: "extra authority",
      edits: [{ oldText: "x", newText: "y", cookies: "injected" }],
    },
    {
      name: "129 edits",
      edits: Array.from({ length: 129 }, () => ({
        oldText: "x",
        newText: "y",
      })),
    },
  ])("requires canonical edits: $name", async ({ edits }) => {
    const f = fixture();
    const call = selected("computer_workspace_edit", {
      operationId: "original-effect",
      workspaceId: "work",
      relativePath: "note.md",
      expectedSha256: "c".repeat(64),
      edits,
    });
    await expect(f.invoke(call.request, call.context)).rejects.toMatchObject({
      state: "refused",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["write-text", "edit-text", "escaped-frame", "aggregate-frame"])(
    "fences %s without widening or chunking",
    async (kind) => {
      const f = fixture();
      const call =
        kind.startsWith("edit") || kind === "aggregate-frame"
          ? selected("computer_workspace_edit", {
              operationId: "original-effect",
              workspaceId: "work",
              relativePath: "note.md",
              expectedSha256: "c".repeat(64),
              edits:
                kind === "edit-text"
                  ? [{ oldText: "x", newText: "a".repeat(262145) }]
                  : Array.from({ length: 3 }, () => ({
                      oldText: "a".repeat(262144),
                      newText: "b".repeat(262144),
                    })),
            })
          : selected("computer_workspace_write", {
              operationId: "original-effect",
              workspaceId: "work",
              relativePath: "note.md",
              expectedSha256: null,
              content:
                kind === "write-text"
                  ? "a".repeat(262145)
                  : "\u0001".repeat(262144),
            });
      await expect(f.invoke(call.request, call.context)).rejects.toMatchObject({
        state: "refused",
        code: kind.endsWith("frame")
          ? "chat_computer_mutation_frame_too_large"
          : "chat_computer_mutation_tool_invalid",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each(["memory_only", "outcome_unknown"] as const)(
    "never manufactures delivery or ACK for %s",
    async (kind) => {
      const f = fixture((value) => {
        if (kind === "memory_only")
          return { ...value, publication: "memory_only" };
        const { receipt: _receipt, ...rest } = value;
        return {
          ...rest,
          phase: "outcome_unknown",
          failure: {
            code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
            source: "operation-store",
            retry: "never",
          },
        };
      });
      const call = selected();
      await expect(f.invoke(call.request, call.context)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_computer_mutation_not_deliverable",
      });
      expect(f.request.mock.calls.map((c) => c[0])).toEqual([
        "chat.computer.write",
      ]);
    },
  );
  it.each([
    "output-digest",
    "effect-operation",
    "turn",
    "generation",
    "path",
    "preimage",
    "publication",
    "phase",
  ])(
    "checks a structural mutation port's %s before exposing onReceived",
    async (kind) => {
      const f = fixture();
      const call = selected();
      const port = {
        write: vi.fn(async (input: ChatComputerWrite, operationId?: string) => {
          const out = await f.mutation.write(input, operationId);
          const value = JSON.parse(out.output) as ComputerMutationResponse;
          if (kind === "output-digest")
            return {
              ...out,
              receipt: { ...out.receipt, outputSHA256: "f".repeat(64) },
            };
          if (kind === "turn") Object.assign(value, { turnId: "other" });
          if (kind === "effect-operation")
            Object.assign(value, { operationId: "replaced-effect" });
          if (kind === "generation") Object.assign(value, { generation: "1" });
          if (kind === "path")
            Object.assign(value.receipt!, { relativePath: "other.md" });
          if (kind === "preimage")
            Object.assign(value.receipt!, { beforeSHA256: "f".repeat(64) });
          if (kind === "publication")
            Object.assign(value, { publication: "memory_only" });
          if (kind === "phase") Object.assign(value, { phase: "failed" });
          const output = JSON.stringify(value);
          return {
            output,
            receipt: {
              ...out.receipt,
              outputSHA256: sha(output),
              outputBytes: String(Buffer.byteLength(output)),
            },
          };
        }),
        edit: vi.fn(f.mutation.edit.bind(f.mutation)),
      };
      const invoke = chatComputerMutationRelay(port, f.returns, handle);
      await expect(invoke(call.request, call.context)).rejects.toMatchObject({
        state: "unknown",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("captures selected handle, request hashes and edit objects before an await", async () => {
    const f = fixture();
    const actual = structuredClone(handle);
    const invoke = chatComputerMutationRelay(f.mutation, f.returns, actual);
    const args = {
      operationId: "original-effect",
      workspaceId: "work",
      relativePath: "note.md",
      expectedSha256: "c".repeat(64),
      edits: [{ oldText: "before", newText: "after" }],
    };
    const call = selected("computer_workspace_edit", args);
    const out = invoke(call.request, call.context);
    Object.assign(args.edits[0]!, { oldText: "changed", newText: "changed" });
    args.expectedSha256 = "f".repeat(64);
    args.operationId = "changed-effect";
    Object.assign(actual.binding, { turnGeneration: "1" });
    Object.assign(actual, { handleId: "other" });
    Object.assign(call.context, {
      operationId: "other",
      binding: "f".repeat(64),
    });
    await expect(out).resolves.toHaveProperty("output");
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({
      handleId: handle.handleId,
      callId: "relay-call",
      relayBinding: "a".repeat(64),
      expectedSHA256: "c".repeat(64),
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[2]?.operationId).toBe("original-effect");
  });
});
