import { describe, expect, it, vi } from "vitest";
import { ReadIntentBridge } from "../../apps/desktop/bridge/read-intent.ts";
import type { Client } from "../../apps/desktop/bridge/client.ts";
import {
  requiresOperationID,
  type ChatComputerAdmissionResponse,
  type ChatReadIntentPromote,
  type ChatHandle,
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
function fixture(mutate: (reply: Outcome) => Outcome = (reply) => reply) {
  const request = vi.fn<Client["request"]>(
    async (method, _body, options = {}) =>
      mutate({
        requestId: options.id!,
        operationId: options.operationId!,
        context: { ...context },
        status: "ok",
        data: structuredClone(
          method.endsWith("promote") ? handle : { admission },
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
});
