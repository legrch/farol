import { describe, expect, it, vi } from "vitest";
import { ReadIntentBridge } from "../../apps/desktop/bridge/read-intent.ts";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client.ts";
import {
  requiresOperationID,
  type ChatReadIntentResolve,
  type ChatReadIntentResolved,
  type Json,
  type Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// Serialized transport double, not model policy, account approval or browser proof.
const context = { profileId: "profile", backendGeneration: "backend" };
const input: ChatReadIntentResolve = {
  admission: {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    generation: "1",
    admissionOperationId: "read",
    storeRevision: "2",
  },
  policy: {
    defaultHarness: "browser",
    harnesses: [
      {
        name: "browser",
        defaultModel: "chatgpt",
        models: [
          { alias: "chatgpt", model: "controlled-model", defaultEffort: "low" },
        ],
      },
    ],
  },
  requested: {},
  profiles: [
    {
      id: "configured",
      executor: "browser",
      runtimeModel: "controlled-model",
      modelId: "controlled-model",
      defaultEffort: "low",
      mode: "standard",
      efforts: [{ requested: "low", resolved: "low" }],
      required: { model: true, effort: true, mode: true, connector: false },
    },
  ],
};
const selection = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "c".repeat(64),
  modelId: "controlled-model",
  effort: "low",
  mode: "standard",
  toolsEnabled: false,
  connectorId: "",
  connectorGrantId: "",
};
const resolved: ChatReadIntentResolved = {
  admission: input.admission,
  selection,
  resolution: {
    requestedAlias: "chatgpt",
    requestedExecutor: "browser",
    requestedEffort: "",
    requestedMode: "",
    resolved: selection,
    configSHA256:
      "5bf5b497b199cfac19cccadec8ca426f7da9cbbe97b96eeec15364b138809e3e",
    translationId: "configured",
  },
  required: input.profiles[0]!.required,
};
function fixture(mutate: (result: Outcome) => Outcome = (r) => r) {
  const request = vi.fn<Client["request"]>(
    async (_method, _body, options = {}) =>
      mutate({
        status: "ok",
        requestId: options.id!,
        operationId: options.operationId!,
        context: { ...context },
        data: structuredClone(resolved) as unknown as Json,
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
describe("original read intent model selection transport", () => {
  it("publishes one typed effect and retains detached capture on duplicate commands", async () => {
    const f = fixture();
    const original = structuredClone(input);
    const first = f.bridge.resolve(original);
    const second = f.bridge.resolve(original);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(resolved);
    expect(b).toEqual(resolved);
    expect(a).not.toBe(b);
    expect(requiresOperationID("chat.readintent.resolve")).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    const [method, body, options] = f.request.mock.calls[0]!;
    expect(method).toBe("chat.readintent.resolve");
    expect(body).toEqual(input);
    expect(options?.operationId).toBeTruthy();
    expect(options?.id).not.toBe(options?.operationId);
    const changed = structuredClone(a) as { selection: { modelId: string } };
    changed.selection.modelId = "caller-edit";
    expect(await f.bridge.resolve(input)).toEqual(resolved);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("pins the original serialized input before an awaited call", async () => {
    const f = fixture();
    const raw = structuredClone(input) as unknown as {
      policy: { harnesses: { models: { model: string }[] }[] };
    };
    const pending = f.bridge.resolve(raw as unknown as ChatReadIntentResolve);
    raw.policy.harnesses[0]!.models[0]!.model = "edited";
    await pending;
    expect(f.request.mock.calls[0]![1]).toEqual(input);
    await expect(
      f.bridge.resolve(raw as unknown as ChatReadIntentResolve),
    ).rejects.toMatchObject({ code: "read_intent_selection_crossed" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("retains an unknown original outcome without another resolver request", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new BridgeError("unknown", "lost_reply"));
    await expect(f.bridge.resolve(input)).rejects.toMatchObject({
      code: "lost_reply",
    });
    await expect(f.bridge.resolve(input)).rejects.toMatchObject({
      code: "lost_reply",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    "request",
    "operation",
    "profile",
    "generation",
    "owner",
    "turn",
    "selection",
    "proof",
  ])("refuses crossed %s and retains the refused attempt", async (field) => {
    const f = fixture((r) => {
      const d = r.data as unknown as ChatReadIntentResolved;
      if (field === "request") return { ...r, requestId: "crossed" };
      if (field === "operation") return { ...r, operationId: "crossed" };
      if (field === "profile")
        return { ...r, context: { ...context, profileId: "crossed" } };
      if (field === "generation")
        return { ...r, context: { ...context, backendGeneration: "crossed" } };
      if (field === "owner")
        return {
          ...r,
          data: {
            ...d,
            admission: { ...d.admission, ownerId: "crossed" },
          } as unknown as Json,
        };
      if (field === "turn")
        return {
          ...r,
          data: {
            ...d,
            admission: { ...d.admission, turnId: "crossed" },
          } as unknown as Json,
        };
      if (field === "selection")
        return {
          ...r,
          data: {
            ...d,
            selection: { ...d.selection, modelId: "crossed" },
          } as unknown as Json,
        };
      return {
        ...r,
        data: {
          ...d,
          resolution: { ...d.resolution, configSHA256: "invalid" },
        } as unknown as Json,
      };
    });
    await expect(f.bridge.resolve(input)).rejects.toBeInstanceOf(BridgeError);
    await expect(f.bridge.resolve(input)).rejects.toBeInstanceOf(BridgeError);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("rejects an untyped model snapshot before transport", async () => {
    const f = fixture();
    await expect(
      f.bridge.resolve({
        ...input,
        policy: { ...input.policy, unexpected: true },
      } as ChatReadIntentResolve),
    ).rejects.toMatchObject({
      state: "refused",
      code: "read_intent_request_invalid",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
});
