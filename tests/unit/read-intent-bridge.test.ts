import { describe, expect, it, vi } from "vitest";
import { ReadIntentBridge } from "../../apps/desktop/bridge/read-intent.ts";
import { buildChatGptReadonlyTaskPrompt } from "../../src/apps/desktop/chatgpt-readonly-task.ts";
import type { Client } from "../../apps/desktop/bridge/client.ts";
import {
  requiresOperationID,
  type ChatComputerAdmissionResponse,
  type ChatReadIntentPromote,
  type ChatHandle,
  type ChatReadIntentAccountApprove,
  type Json,
  type Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// Controlled transport. No native/profile/provider or durable owner is exercised.
const context = { profileId: "profile", backendGeneration: "backend" };
const admission: ChatComputerAdmissionResponse = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "1",
  participantId: "participant",
  turnId: "turn",
  generation: "1",
  admissionOperationId: "read-admission",
  storeRevision: "9007199254740993",
};
const selection = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "account",
  modelId: "model",
  effort: "high",
  mode: "standard",
  toolsEnabled: false,
  connectorId: "",
  connectorGrantId: "",
};
const input: ChatReadIntentPromote = {
  admission,
  selection,
  resolution: {
    requestedAlias: "chatgpt",
    requestedExecutor: "farol",
    requestedEffort: "high",
    requestedMode: "standard",
    resolved: selection,
    configSHA256: "a".repeat(64),
    translationId: "selected-controls",
  },
  prompt: "Summarize the selected text.",
  required: { model: true, effort: true, mode: true, connector: false },
};
const handle: ChatHandle = {
  handleId: "conversation-handle",
  binding: {
    ...context,
    ownerId: admission.ownerId,
    sessionId: admission.sessionId,
    taskId: admission.taskId,
    taskEpoch: admission.taskEpoch,
    participantId: admission.participantId,
    turnId: admission.turnId,
    turnGeneration: admission.generation,
    operationId: admission.admissionOperationId,
  },
};
const account: ChatReadIntentAccountApprove = {
  admission,
  confirmedPrincipalKey: "c".repeat(64),
  observation: {
    state: "observed",
    source: "provider-session-v1",
    principalKey: "c".repeat(64),
    observedAtMillis: "1",
    expiresAtMillis: "100",
  },
};
const approved = {
  admission,
  approvalId: "go-account-approval",
  principalKey: account.confirmedPrincipalKey,
};
const revoke = { admission, approvalId: approved.approvalId };
function fixture(mutate: (reply: Outcome) => Outcome = (reply) => reply) {
  const request = vi.fn<Client["request"]>(
    async (method, _body, options = {}) =>
      mutate({
        requestId: options.id!,
        operationId: options.operationId!,
        context: { ...context },
        status: "ok",
        data: structuredClone(
          method.endsWith("promote")
            ? handle
            : method.endsWith("account.approve")
              ? approved
              : { admission },
        ) as unknown as Json,
      }),
  );
  return {
    request,
    bridge: new ReadIntentBridge({
      request,
      verifiedContext: context,
    } as unknown as Client),
  };
}
describe("captured read intent transport", () => {
  it("promotes the original admission without minting another turn", async () => {
    const f = fixture();
    expect(await f.bridge.promote(input)).toEqual(handle);
    expect(f.request).toHaveBeenCalledTimes(1);
    const [method, body, options] = f.request.mock.calls[0]!;
    expect(method).toBe("chat.readintent.promote");
    expect(requiresOperationID(method)).toBe(true);
    expect(body).toEqual(input);
    expect(options?.operationId).toBeTruthy();
  });
  it("requires a correlated withdrawal receipt", async () => {
    const f = fixture();
    await expect(f.bridge.withdraw(admission)).resolves.toBeUndefined();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe("chat.readintent.withdraw");
  });
  it("coalesces simultaneous and later dismissals into the original withdrawal", async () => {
    const f = fixture();
    await Promise.all([
      f.bridge.withdraw(admission),
      f.bridge.withdraw(structuredClone(admission)),
    ]);
    await f.bridge.withdraw(admission);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "refused", "unavailable"] as const)(
    "retains a %s withdrawal instead of sending another effect",
    async (status) => {
      const f = fixture((o) => ({
        ...o,
        status,
        code: "original-failure",
        data: null,
      }));
      await expect(f.bridge.withdraw(admission)).rejects.toMatchObject({
        state: status,
      });
      await expect(f.bridge.withdraw(admission)).rejects.toMatchObject({
        state: status,
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("retains a thrown transport failure and does not reuse it for a crossed owner", async () => {
    const f = fixture();
    const failure = new Error("original transport lost");
    f.request.mockRejectedValueOnce(failure);
    await expect(f.bridge.withdraw(admission)).rejects.toBe(failure);
    await expect(f.bridge.withdraw(admission)).rejects.toBe(failure);
    await expect(
      f.bridge.withdraw({ ...admission, taskId: "crossed" }),
    ).rejects.toMatchObject({
      state: "refused",
      code: "read_intent_withdrawal_crossed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(Object.keys(handle.binding))(
    "refuses crossed promotion %s",
    async (field) => {
      const f = fixture((o) => ({
        ...o,
        data: {
          ...handle,
          binding: {
            ...handle.binding,
            [field]:
              field === "taskEpoch" || field === "turnGeneration"
                ? "2"
                : "crossed",
          },
        } as unknown as Json,
      }));
      await expect(f.bridge.promote(input)).rejects.toMatchObject({
        state: "unknown",
        code: "read_intent_owner_crossed",
      });
      await expect(f.bridge.promote(input)).rejects.toMatchObject({
        state: "unknown",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(Object.keys(admission))(
    "refuses crossed withdrawal %s",
    async (field) => {
      const f = fixture((o) => ({
        ...o,
        data: {
          admission: {
            ...admission,
            [field]: ["taskEpoch", "generation", "storeRevision"].includes(
              field,
            )
              ? "2"
              : "crossed",
          },
        } as unknown as Json,
      }));
      await expect(f.bridge.withdraw(admission)).rejects.toMatchObject({
        state: "unknown",
        code: "read_intent_withdrawal_crossed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["requestId", "operationId", "profileId", "backendGeneration"])(
    "rejects crossed %s before accepting withdrawal",
    async (field) => {
      const f = fixture((o) =>
        field === "profileId" || field === "backendGeneration"
          ? { ...o, context: { ...o.context, [field]: "crossed" } }
          : { ...o, [field]: "crossed" },
      );
      await expect(f.bridge.withdraw(admission)).rejects.toMatchObject({
        state: "unknown",
        code: "read_intent_response_context",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["unknown", "refused", "unavailable"] as const)(
    "never retries a %s promotion reply",
    async (status) => {
      const f = fixture((o) => ({
        ...o,
        status,
        code: "controlled-failure",
        data: null,
      }));
      await expect(f.bridge.promote(input)).rejects.toMatchObject({
        state: status,
        code: "controlled-failure",
      });
      await expect(f.bridge.promote(input)).rejects.toMatchObject({
        state: status,
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("pins nested identities before awaiting the transport", async () => {
    const selected = { ...input, admission: { ...input.admission } };
    const f = fixture((o) => {
      selected.admission.taskId = "changed";
      return o;
    });
    expect(await f.bridge.promote(selected)).toEqual(handle);
  });
  it.each([
    { name: "ASCII 8191", prompt: "x".repeat(8191), bytes: 8191 },
    { name: "ASCII 8192", prompt: "x".repeat(8192), bytes: 8192 },
    { name: "Cyrillic 8191", prompt: "я".repeat(4095) + "x", bytes: 8191 },
    { name: "Cyrillic 8192", prompt: "я".repeat(4096), bytes: 8192 },
    { name: "emoji 8191", prompt: "🙂".repeat(2047) + "abc", bytes: 8191 },
    { name: "emoji 8192", prompt: "🙂".repeat(2048), bytes: 8192 },
  ])(
    "preserves the exact final UTF-8 prompt at the boundary: $name",
    async ({ prompt, bytes }) => {
      expect(Buffer.byteLength(prompt, "utf8")).toBe(bytes);
      const f = fixture();
      await expect(f.bridge.promote({ ...input, prompt })).resolves.toEqual(
        handle,
      );
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.request.mock.calls[0]![1]).toMatchObject({ prompt });
    },
  );
  it.each(["x".repeat(8193), "я".repeat(4096) + "x", "🙂".repeat(2048) + "x"])(
    "refuses an 8193-byte final prompt before original promotion",
    async (prompt) => {
      expect(Buffer.byteLength(prompt, "utf8")).toBe(8193);
      const f = fixture();
      await expect(
        f.bridge.promote({ ...input, prompt }),
      ).rejects.toMatchObject({
        state: "refused",
        code: "read_intent_request_invalid",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("counts the complete file envelope instead of its context character limit", async () => {
    const built = buildChatGptReadonlyTaskPrompt({
      workspaceLabel: "Controlled workspace",
      relativePath: "note.txt",
      text: "я".repeat(4096),
    });
    expect(built.contextTruncated).toBe(false);
    expect(built.contextCharacters).toBe(4096);
    expect(Buffer.byteLength(built.text, "utf8")).toBeGreaterThan(8192);
    const f = fixture();
    await expect(
      f.bridge.promote({ ...input, prompt: built.text }),
    ).rejects.toMatchObject({
      state: "refused",
      code: "read_intent_request_invalid",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(8193), "é".repeat(4097)])(
    "rejects invalid prompt before an effect",
    async (prompt) => {
      const f = fixture();
      await expect(
        f.bridge.promote({ ...input, prompt }),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("does not accept invented admission authority fields", async () => {
    const f = fixture();
    await expect(
      f.bridge.withdraw({
        ...admission,
        workspaceRoot: "/",
      } as ChatComputerAdmissionResponse),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("retains one promotion and returns detached receipts across concurrent commands", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([
      f.bridge.promote(input),
      f.bridge.promote(structuredClone(input)),
    ]);
    Reflect.set(first.binding, "turnId", "caller-mutation");
    expect(second).toEqual(handle);
    expect(await f.bridge.promote(input)).toEqual(handle);
    await expect(
      f.bridge.promote({ ...input, prompt: "replacement" }),
    ).rejects.toMatchObject({ code: "read_intent_promotion_crossed" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("retains explicit account approval and revocation as separate exact effects", async () => {
    const f = fixture();
    const first = await f.bridge.approveAccount(account);
    Reflect.set(first, "approvalId", "mutated");
    const [a, b] = await Promise.all([
      f.bridge.approveAccount(account),
      f.bridge.approveAccount(structuredClone(account)),
    ]);
    expect(a).toEqual(approved);
    expect(b).toEqual(approved);
    await Promise.all([
      f.bridge.revokeAccount(revoke),
      f.bridge.revokeAccount(structuredClone(revoke)),
    ]);
    await f.bridge.revokeAccount(revoke);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "chat.readintent.account.approve",
      "chat.readintent.account.revoke",
    ]);
    for (const [method, , options] of f.request.mock.calls) {
      expect(requiresOperationID(method)).toBe(true);
      expect(options?.operationId).toBeTruthy();
    }
  });
  it.each(["unknown", "refused", "unavailable", "thrown"] as const)(
    "retains %s account effects without another RPC",
    async (status) => {
      for (const action of ["approve", "revoke"] as const) {
        const f = fixture((o) => ({
          ...o,
          status: status === "thrown" ? "unknown" : status,
          code: "original-failure",
          data: null,
        }));
        const failure = new Error("original transport failure");
        if (status === "thrown") f.request.mockRejectedValueOnce(failure);
        const call = () =>
          action === "approve"
            ? f.bridge.approveAccount(account)
            : f.bridge.revokeAccount(revoke);
        for (let i = 0; i < 2; i++) {
          if (status === "thrown") await expect(call()).rejects.toBe(failure);
          else
            await expect(call()).rejects.toMatchObject({
              state: status,
              code: "original-failure",
            });
        }
        expect(f.request).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each([
    "requestId",
    "operationId",
    "profileId",
    "backendGeneration",
    "admission",
    "principalKey",
  ])(
    "refuses crossed account approval %s and retains refusal",
    async (field) => {
      const f = fixture((o) => {
        if (field === "profileId" || field === "backendGeneration")
          return { ...o, context: { ...context, [field]: "other" } };
        if (field === "requestId" || field === "operationId")
          return { ...o, [field]: "other" };
        return {
          ...o,
          data: {
            ...approved,
            ...(field === "admission"
              ? { admission: { ...admission, taskId: "other" } }
              : { principalKey: "d".repeat(64) }),
          } as unknown as Json,
        };
      });
      await expect(f.bridge.approveAccount(account)).rejects.toMatchObject({
        state: "unknown",
      });
      await expect(f.bridge.approveAccount(account)).rejects.toMatchObject({
        state: "unknown",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("does not refresh or cross a captured account confirmation", async () => {
    const f = fixture();
    await f.bridge.approveAccount(account);
    await expect(
      f.bridge.approveAccount({
        ...account,
        observation: { ...account.observation, observedAtMillis: "2" },
      }),
    ).rejects.toMatchObject({ code: "read_intent_account_crossed" });
    await f.bridge.revokeAccount(revoke);
    await expect(
      f.bridge.revokeAccount({ ...revoke, approvalId: "other" }),
    ).rejects.toMatchObject({ code: "read_intent_account_crossed" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("requires the explicitly confirmed principal to match the observation before RPC", async () => {
    const f = fixture();
    await expect(
      f.bridge.approveAccount({
        ...account,
        confirmedPrincipalKey: "d".repeat(64),
      }),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
  });
});
