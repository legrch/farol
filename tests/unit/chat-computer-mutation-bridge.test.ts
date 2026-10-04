import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChatComputerMutationBridge } from "../../apps/desktop/bridge/chat-computer-mutation.ts";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client.ts";
import {
  requiresOperationID,
  validate,
  type ChatHandle,
  type ChatComputerWrite,
  type ChatComputerEdit,
  type ChatComputerOutput,
  type ComputerMutationResponse,
  type Outcome,
  type Json,
} from "../../apps/desktop/bridge/wire.ts";

// Real bridge and canonical validator, controlled transport only. These cases
// do not prove Go persistence, native filesystem behavior or a live provider.
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
const write: ChatComputerWrite = {
  handleId: handle.handleId,
  callId: "relay-call",
  relayBinding: "a".repeat(64),
  requestSHA256: "b".repeat(64),
  workspaceId: "work",
  relativePath: "note.md",
  content: "Hello 🍐",
  expectedSHA256: "c".repeat(64),
};
const edit: ChatComputerEdit = {
  handleId: write.handleId,
  callId: write.callId,
  relayBinding: write.relayBinding,
  requestSHA256: write.requestSHA256,
  workspaceId: write.workspaceId,
  relativePath: write.relativePath,
  expectedSHA256: "c".repeat(64),
  edits: [{ oldText: "before", newText: "after 🍐" }],
};
function mutation(
  input: ChatComputerWrite | ChatComputerEdit,
  operationId: string,
): ComputerMutationResponse {
  return {
    operationId,
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
      ...(input.expectedSHA256 ? { beforeSHA256: input.expectedSHA256 } : {}),
      afterSHA256: "content" in input ? sha(input.content) : "d".repeat(64),
    },
  };
}
function delivery(
  input: ChatComputerWrite | ChatComputerEdit,
  result: ComputerMutationResponse,
  raw?: string,
): ChatComputerOutput {
  const output = raw ?? JSON.stringify(result);
  return {
    output,
    receipt: {
      receiptId: "go-receipt",
      handleId: input.handleId,
      callId: input.callId,
      relayBinding: input.relayBinding,
      requestSHA256: input.requestSHA256,
      outputSHA256: sha(output),
      outputBytes: String(Buffer.byteLength(output, "utf8")),
    },
  };
}
type Change = (result: ComputerMutationResponse) => ComputerMutationResponse;
function fixture(
  change: Change = (value) => value,
  changeOutcome: (out: Outcome) => Outcome = (value) => value,
) {
  let retained!: ComputerMutationResponse;
  const context = { profileId: "profile", backendGeneration: "backend" };
  const request = vi.fn<Client["request"]>(
    async (method, body, options = {}) => {
      let data: unknown;
      if (method === "chat.computer.mutation.read") {
        const input = body as Record<string, Json>;
        data = {
          handleId: input.handleId,
          callId: input.callId,
          result: change(retained),
        };
      } else {
        const input = body as unknown as ChatComputerWrite | ChatComputerEdit;
        retained = mutation(input, options.operationId!);
        data = delivery(input, change(retained));
      }
      return changeOutcome({
        status: "ok",
        requestId: options.id!,
        context: { ...context },
        ...(options.operationId ? { operationId: options.operationId } : {}),
        data: data as Json,
      });
    },
  );
  const client = { request, verifiedContext: context } as unknown as Client;
  return {
    bridge: new ChatComputerMutationBridge(client, handle),
    request,
    client,
    context,
  };
}

describe("selected Chat Computer mutation bridge", () => {
  it("keeps a provided stable effect ID distinct from the relay call ID and fences reuse under a new call", async () => {
    const f = fixture();
    const out = await f.bridge.write(write, "original-effect");
    expect(f.request.mock.calls[0]?.[2]?.operationId).toBe("original-effect");
    expect(JSON.parse(out.output)).toMatchObject({
      operationId: "original-effect",
      callId: write.callId,
    });
    await expect(
      f.bridge.edit({ ...edit, callId: "different-call" }, "original-effect"),
    ).rejects.toMatchObject({
      code: "chat_computer_mutation_already_attempted",
    });
    await expect(f.bridge.write(write, "replacement-id")).rejects.toMatchObject(
      { code: "chat_computer_mutation_already_attempted" },
    );
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["", "invalid operation", "a".repeat(129), null])(
    "rejects invalid provided operation ID before admission",
    async (operationId) => {
      const f = fixture();
      await expect(
        f.bridge.write(write, operationId as string),
      ).rejects.toMatchObject({
        state: "refused",
        code: "chat_computer_mutation_operation_id_invalid",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each(["8388608", "8388609", "18446744073709551615"])(
    "bounds fresh retained receipt bytes %s without requiring a local attempt",
    async (bytes) => {
      const f = fixture();
      await f.bridge.write(write, "original-effect");
      const transport = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (...args) => {
        const out = await transport(...args);
        const data = out.data as unknown as {
          handleId: string;
          callId: string;
          result: ComputerMutationResponse;
        };
        return {
          ...out,
          data: {
            ...data,
            result: {
              ...data.result,
              receipt: { ...data.result.receipt!, bytes },
            },
          } as unknown as Json,
        };
      });
      const fresh = new ChatComputerMutationBridge(f.client, handle);
      const observed = fresh.observe({
        handleId: handle.handleId,
        callId: write.callId,
      });
      if (bytes === "8388608")
        await expect(observed).resolves.toMatchObject({
          result: { receipt: { bytes }, operationId: "original-effect" },
        });
      else
        await expect(observed).rejects.toMatchObject({
          state: "unknown",
          code: "chat_computer_mutation_phase_invalid",
        });
      expect(f.request.mock.calls[1]?.[2]).not.toHaveProperty("operationId");
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["write", "edit"] as const)(
    "binds %s to the generated effect ID and selected handle without automatic ACK",
    async (kind) => {
      const f = fixture();
      const out =
        kind === "write"
          ? await f.bridge.write(write)
          : await f.bridge.edit(edit);
      const call = f.request.mock.calls[0]!;
      expect(call[0]).toBe(`chat.computer.${kind}`);
      expect(call[2]?.operationId).toMatch(/^[a-f0-9-]{36}$/);
      expect(JSON.parse(out.output)).toMatchObject({
        operationId: call[2]?.operationId,
        turnId: handle.binding.turnId,
        generation: handle.binding.turnGeneration,
        phase: "completed",
        publication: "durable",
      });
      expect(validate("ChatComputerOutput", out)).toBe(true);
      expect(requiresOperationID(call[0])).toBe(true);
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("delivers a classified durable failure without fabricating a receipt", async () => {
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
    const out = await f.bridge.write(write);
    expect(JSON.parse(out.output)).toMatchObject({
      phase: "failed",
      failure: { retry: "never" },
    });
    expect(JSON.parse(out.output)).not.toHaveProperty("receipt");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["requestId", "operationId", "profileId", "backendGeneration"])(
    "fences crossed common %s",
    async (field) => {
      const f = fixture(
        (value) => value,
        (out) =>
          field === "profileId" || field === "backendGeneration"
            ? { ...out, context: { ...out.context, [field]: "other" } }
            : { ...out, [field]: "other" },
      );
      await expect(f.bridge.write(write)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_computer_mutation_response_context",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["operationId", "workspaceId", "callId", "turnId", "generation"])(
    "fences crossed nested %s even with a correct common outcome",
    async (field) => {
      const f = fixture((value) => ({
        ...value,
        [field]: field === "generation" ? "1" : "other",
      }));
      await expect(f.bridge.write(write)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_computer_mutation_result_crossed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "handleId",
    "callId",
    "relayBinding",
    "requestSHA256",
    "outputSHA256",
    "outputBytes",
  ])("rejects crossed delivery %s", async (field) => {
    const f = fixture(
      (value) => value,
      (out) => {
        const data = out.data as unknown as ChatComputerOutput;
        return {
          ...out,
          data: {
            ...data,
            receipt: {
              ...data.receipt,
              [field]:
                field === "outputBytes"
                  ? "1"
                  : field.endsWith("SHA256") || field === "relayBinding"
                    ? "f".repeat(64)
                    : "other",
            },
          } as unknown as Json,
        };
      },
    );
    await expect(f.bridge.write(write)).rejects.toMatchObject({
      state: "unknown",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    "operation",
    "relativePath",
    "beforeSHA256",
    "afterSHA256",
    "bytes",
    "replacements",
  ])("rejects crossed write mutation receipt %s", async (field) => {
    const f = fixture((value) => ({
      ...value,
      receipt: {
        ...value.receipt!,
        [field]:
          field === "operation"
            ? "edit"
            : field === "bytes"
              ? "11"
              : field === "replacements"
                ? 1
                : field.endsWith("SHA256")
                  ? "f".repeat(64)
                  : "other.md",
      },
    }));
    await expect(f.bridge.write(write)).rejects.toMatchObject({
      state: "unknown",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("requires an edit receipt's exact preimage and replacement count", async () => {
    for (const crossed of [
      { beforeSHA256: "f".repeat(64) },
      { replacements: 0 },
      { replacements: 2 },
    ]) {
      const f = fixture((value) => ({
        ...value,
        receipt: { ...value.receipt!, ...crossed },
      }));
      await expect(f.bridge.edit(edit)).rejects.toMatchObject({
        state: "unknown",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    }
  });
  it.each([
    "missing-receipt",
    "completed-failure",
    "failed-receipt",
    "failed-unknown",
    "unknown-known",
    "retry",
    "extra",
  ])("rejects malformed closed phase %s", async (kind) => {
    const f = fixture((value) => {
      if (kind === "missing-receipt") {
        const { receipt: _receipt, ...rest } = value;
        return rest;
      }
      if (kind === "extra")
        return { ...value, ownerId: "invented" } as ComputerMutationResponse;
      const failure = {
        code:
          kind === "failed-unknown"
            ? "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
            : "WORKSPACE_MUTATION_CONFLICT",
        source: "native-workspace",
        retry: kind === "retry" ? "safe" : "never",
      };
      if (kind === "completed-failure")
        return { ...value, failure } as ComputerMutationResponse;
      if (kind === "failed-receipt")
        return {
          ...value,
          phase: "failed",
          failure,
        } as ComputerMutationResponse;
      const { receipt: _receipt, ...rest } = value;
      return {
        ...rest,
        phase: kind === "unknown-known" ? "outcome_unknown" : "failed",
        failure,
      } as ComputerMutationResponse;
    });
    await expect(f.bridge.write(write)).rejects.toMatchObject({
      state: "unknown",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["memory_only", "outcome_unknown"] as const)(
    "fences %s delivery but permits explicit read-only retained observation",
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
      await expect(f.bridge.write(write)).rejects.toMatchObject({
        code: "chat_computer_mutation_not_deliverable",
      });
      const out = await f.bridge.observe({
        handleId: handle.handleId,
        callId: write.callId,
      });
      expect(out.result.operationId).toBe(
        f.request.mock.calls[0]?.[2]?.operationId,
      );
      expect(
        kind === "memory_only" ? out.result.publication : out.result.phase,
      ).toBe(kind);
      expect(f.request.mock.calls.map((call) => call[0])).toEqual([
        "chat.computer.write",
        "chat.computer.mutation.read",
      ]);
      expect(f.request.mock.calls[1]?.[2]).not.toHaveProperty("operationId");
      expect(requiresOperationID("chat.computer.mutation.read")).toBe(false);
      await expect(f.bridge.write(write)).rejects.toMatchObject({
        code: "chat_computer_mutation_already_attempted",
      });
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["refused", "unknown", "unavailable", "unsupported"] as const)(
    "never repeats %s",
    async (status) => {
      const f = fixture(
        (value) => value,
        (out) => ({ ...out, status, code: "controlled" }),
      );
      await expect(f.bridge.edit(edit)).rejects.toMatchObject({
        state: status,
        code: "controlled",
      });
      await expect(f.bridge.edit(edit)).rejects.toMatchObject({
        code: "chat_computer_mutation_already_attempted",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("retains only original correlation after a lost reply, with no recovery effect", async () => {
    const f = fixture();
    const transport = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const out = await transport(...args);
      if (args[0] === "chat.computer.write")
        throw new BridgeError("unknown", "lost-reply");
      return out;
    });
    await expect(f.bridge.write(write)).rejects.toMatchObject({
      code: "lost-reply",
    });
    await expect(f.bridge.write(write)).rejects.toMatchObject({
      code: "chat_computer_mutation_already_attempted",
    });
    await expect(
      f.bridge.observe({ handleId: handle.handleId, callId: write.callId }),
    ).resolves.toMatchObject({ result: { phase: "completed" } });
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1]?.[0]).toBe("chat.computer.mutation.read");
  });
  it.each([
    "handleId",
    "callId",
    "result-call",
    "result-turn",
    "result-generation",
    "result-operation",
    "extra-authority",
  ])("fences crossed observation %s", async (kind) => {
    const f = fixture(
      (value) => value,
      (out) => {
        if (out.operationId) return out;
        const data = out.data as unknown as {
          handleId: string;
          callId: string;
          result: ComputerMutationResponse;
        };
        const changed =
          kind === "handleId" || kind === "callId"
            ? { ...data, [kind]: "other" }
            : kind === "extra-authority"
              ? { ...data, ownerId: "other" }
              : {
                  ...data,
                  result: {
                    ...data.result,
                    [kind === "result-call"
                      ? "callId"
                      : kind === "result-turn"
                        ? "turnId"
                        : kind === "result-generation"
                          ? "generation"
                          : "operationId"]:
                      kind === "result-generation" ? "1" : "other",
                  },
                };
        return { ...out, data: changed as unknown as Json };
      },
    );
    await f.bridge.write(write);
    await expect(
      f.bridge.observe({ handleId: handle.handleId, callId: write.callId }),
    ).rejects.toMatchObject({ state: "unknown" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("observes an existing call through a fresh bridge without supplying execution authority", async () => {
    const f = fixture();
    await f.bridge.write(write);
    const fresh = new ChatComputerMutationBridge(f.client, handle);
    await expect(
      fresh.observe({ handleId: handle.handleId, callId: write.callId }),
    ).resolves.toMatchObject({ result: { phase: "completed" } });
    expect(f.request.mock.calls[1]?.[1]).toEqual({
      handleId: handle.handleId,
      callId: write.callId,
    });
    await expect(
      fresh.observe({
        handleId: handle.handleId,
        callId: write.callId,
        operationId: "invented",
      } as never),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("copies edits, hashes and handle before awaiting transport", async () => {
    const f = fixture();
    const selected = structuredClone(edit);
    const actual = structuredClone(handle);
    const bridge = new ChatComputerMutationBridge(f.client, actual);
    const out = bridge.edit(selected);
    Object.assign(selected.edits[0]!, {
      oldText: "changed",
      newText: "changed",
    });
    Object.assign(selected, {
      expectedSHA256: "f".repeat(64),
      callId: "changed",
    });
    Object.assign(actual.binding, { turnGeneration: "1" });
    Object.assign(actual, { handleId: "changed" });
    await expect(out).resolves.toHaveProperty("output");
    expect(f.request.mock.calls[0]?.[1]).toEqual(edit);
  });
  it.each([
    { name: "empty", content: "" },
    { name: "ASCII", content: "a".repeat(262144) },
    { name: "non-BMP", content: "🍐".repeat(65536) },
  ])("accepts $name content at its per-text bound", async ({ content }) => {
    const f = fixture();
    const { expectedSHA256: _expected, ...rest } = write;
    const out = await f.bridge.write({ ...rest, content });
    expect(JSON.parse(out.output).receipt).toMatchObject({
      bytes: String(Buffer.byteLength(content)),
      afterSHA256: sha(content),
      replacements: 0,
    });
    expect(JSON.parse(out.output).receipt).not.toHaveProperty("beforeSHA256");
  });
  it.each([
    { name: "ASCII overflow", content: "a".repeat(262145) },
    { name: "non-BMP overflow", content: "🍐".repeat(65537) },
    { name: "lone surrogate", content: "\ud800" },
  ])("rejects $name before Client.request", async ({ content }) => {
    const f = fixture();
    await expect(f.bridge.write({ ...write, content })).rejects.toMatchObject({
      state: "refused",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    { name: "empty", edits: [] },
    {
      name: "129 edits",
      edits: Array.from({ length: 129 }, () => edit.edits[0]!),
    },
    { name: "sparse", edits: Array(1) },
    { name: "empty oldText", edits: [{ oldText: "", newText: "x" }] },
    { name: "untyped newText", edits: [{ oldText: "x", newText: 3 }] },
    {
      name: "extra authority",
      edits: [{ oldText: "x", newText: "y", eval: "authority" }],
    },
    {
      name: "oldText overflow",
      edits: [{ oldText: "a".repeat(262145), newText: "x" }],
    },
    {
      name: "newText overflow",
      edits: [{ oldText: "x", newText: "a".repeat(262145) }],
    },
    { name: "lone surrogate", edits: [{ oldText: "x", newText: "\ud800" }] },
  ])("rejects $name before transport", async ({ edits }) => {
    const f = fixture();
    await expect(
      f.bridge.edit({ ...edit, edits } as ChatComputerEdit),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("accepts an empty replacement and 128 typed edits within the frame bound", async () => {
    const f = fixture();
    const edits = Array.from({ length: 128 }, (_, index) => ({
      oldText: `old-${index}`,
      newText: "",
    }));
    await expect(f.bridge.edit({ ...edit, edits })).resolves.toHaveProperty(
      "output",
    );
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["escaped-write", "aggregate-edits"])(
    "fences the complete %s frame before Client.request",
    async (kind) => {
      const f = fixture();
      const result =
        kind === "escaped-write"
          ? f.bridge.write({ ...write, content: "\u0000".repeat(262144) })
          : f.bridge.edit({
              ...edit,
              edits: Array.from({ length: 3 }, () => ({
                oldText: "a".repeat(262144),
                newText: "b".repeat(262144),
              })),
            });
      await expect(result).rejects.toMatchObject({
        state: "refused",
        code: "chat_computer_mutation_frame_too_large",
      });
      expect(f.request).not.toHaveBeenCalled();
      // Preflight refusal consumed no effect, so a corrected bounded request is admissible.
      await expect(f.bridge.write(write)).resolves.toHaveProperty("output");
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["authority", "wrong-handle", "bad-hash", "undefined-hash"])(
    "rejects %s input before transport",
    async (kind) => {
      const f = fixture();
      const selected =
        kind === "authority"
          ? { ...write, ownerId: "injected" }
          : kind === "wrong-handle"
            ? { ...write, handleId: "other" }
            : {
                ...write,
                expectedSHA256: kind === "bad-hash" ? "bad" : undefined,
              };
      await expect(
        f.bridge.write(selected as ChatComputerWrite),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate keys even when delivery bytes and SHA match", async () => {
    const f = fixture(
      (value) => value,
      (out) => {
        const value = out.data as unknown as ChatComputerOutput;
        const raw = value.output.replace(
          '"phase":"completed"',
          '"phase":"failed","phase":"completed"',
        );
        return {
          ...out,
          data: {
            ...value,
            output: raw,
            receipt: {
              ...value.receipt,
              outputSHA256: sha(raw),
              outputBytes: String(Buffer.byteLength(raw)),
            },
          } as unknown as Json,
        };
      },
    );
    await expect(f.bridge.write(write)).rejects.toMatchObject({
      code: "chat_computer_mutation_output_invalid",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("refuses an invalid handle or crossed client context before any effect", async () => {
    const f = fixture();
    expect(
      () =>
        new ChatComputerMutationBridge(f.client, {
          ...handle,
          ownerId: "invented",
        } as ChatHandle),
    ).toThrow(BridgeError);
    expect(
      () =>
        new ChatComputerMutationBridge(f.client, {
          ...handle,
          binding: { ...handle.binding, backendGeneration: "other" },
        }),
    ).toThrow(BridgeError);
    f.context.backendGeneration = "other";
    await expect(f.bridge.write(write)).rejects.toMatchObject({
      code: "chat_computer_mutation_handle_context",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
});
