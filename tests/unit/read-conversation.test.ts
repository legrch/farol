import { describe, expect, it, vi } from "vitest";
import { ReadConversationClient } from "../../apps/desktop/bridge/read-conversation.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import type {
  ChatHandle,
  ChatReadIntentResolve,
  ChatReadIntentResolved,
  ChatState,
  ChatFrame,
  ChatResult,
  ChatCreate,
} from "../../apps/desktop/bridge/wire.ts";

// Mechanical client fixture. Go owns all status decisions in production; these
// explicit states do not establish actual queue, browser, retention or ACK proof.
const admission = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "1",
  participantId: "participant",
  turnId: "turn",
  generation: "1",
  admissionOperationId: "original-read",
  storeRevision: "2",
};
const handle: ChatHandle = {
  handleId: "first-handle",
  binding: {
    profileId: "profile",
    backendGeneration: "backend",
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    operationId: "original-read",
    turnGeneration: "1",
  },
};
const second: ChatHandle = {
  handleId: "second-handle",
  binding: {
    ...handle.binding,
    turnId: "second-turn",
    operationId: "second-operation",
    turnGeneration: "2",
  },
};
const required = { model: true, effort: true, mode: false, connector: false };
const selection = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "account",
  modelId: "controlled-model",
  effort: "low",
  mode: "",
  toolsEnabled: false,
  connectorId: "",
  connectorGrantId: "",
};
const selected: ChatReadIntentResolved = {
  admission,
  selection,
  resolution: {
    requestedAlias: "chatgpt",
    requestedExecutor: "browser",
    requestedEffort: "",
    requestedMode: "",
    resolved: selection,
    configSHA256: "a".repeat(64),
    translationId: "controlled",
  },
  required,
};
const input: ChatReadIntentResolve = {
  admission,
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
      id: "controlled",
      executor: "browser",
      runtimeModel: "controlled-model",
      modelId: "controlled-model",
      defaultEffort: "low",
      mode: "",
      efforts: [{ requested: "low", resolved: "low" }],
      required,
    },
  ],
};
function state(h: ChatHandle): ChatState {
  return {
    handle: h,
    conversationId: "conversation",
    phase: "submitted",
    hasResult: false,
    deliveryAcknowledged: false,
    lifecycleSettled: false,
    released: false,
    followReady: false,
  };
}
function terminal(h: ChatHandle, acknowledged = false): ChatResult {
  return {
    handle: h,
    conversationId: "conversation",
    userTurnId: `user-${h.handleId}`,
    replyId: `reply-${h.handleId}`,
    resultId: `result-${h.handleId}`,
    evidence: {
      requested: selection,
      resolution: selected.resolution,
      resolutionSource: "configured",
      admissionSource: "unknown",
      observationSource: "unknown",
      evidenceId: "",
      pinnedSource: "requested",
    },
    phase: "completed",
    outcome: "completed",
    code: "",
    text: "First useful chunk. Final chunk.",
    complete: true,
    acknowledged,
  };
}
function fixture() {
  let next = handle;
  const states = new Map([
    [handle.handleId, state(handle)],
    [second.handleId, state(second)],
  ]);
  const batches = new Map<string, ChatFrame[]>([
    [handle.handleId, []],
    [second.handleId, []],
  ]);
  const owner = {
    resolve: vi.fn(async () => structuredClone(selected)),
    promote: vi.fn(async () => structuredClone(handle)),
  };
  const chat = {
    create: vi.fn(async (_input: ChatCreate) => {
      next = second;
      return structuredClone(second);
    }),
    prepare: vi.fn(async () => ({
      handle: structuredClone(next),
      providerState: "home" as const,
      slotOrdinal: 0,
      slotGeneration: "1",
      viewId: "view",
      viewGeneration: "1",
      documentGeneration: "1",
      conversationId: "",
    })),
    send: vi.fn(async () => ({})),
    observe: vi.fn(async () => ({})),
    events: vi.fn(async (id: string, after: string) => ({
      frames: structuredClone(
        batches.get(id)!.filter((f) => BigInt(f.sequence) > BigInt(after)),
      ),
    })),
    state: vi.fn(async (h: ChatHandle) =>
      structuredClone(states.get(h.handleId)!),
    ),
    result: vi.fn(async (id: string) =>
      terminal(
        id === handle.handleId ? handle : second,
        states.get(id)!.deliveryAcknowledged,
      ),
    ),
    acknowledgeFrame: vi.fn(async () => ({ status: "acknowledged" })),
    acknowledgeResult: vi.fn(async (id: string) => {
      const s = states.get(id)!;
      states.set(id, { ...s, deliveryAcknowledged: true });
      return {};
    }),
  };
  return {
    owner,
    chat,
    states,
    batches,
    client: new ReadConversationClient(owner, chat, () => 1),
  };
}
describe("normal read conversation mechanical client", () => {
  it("reads a snapshot without Send, observation, preparation or delivery ACK", async () => {
    const f = fixture();
    await f.client.start(input, "Explain.");
    f.batches.set(handle.handleId, [
      { sequence: "1", kind: "response.created", data: {} },
    ]);
    vi.clearAllMocks();
    const shown = await f.client.snapshot(handle.handleId, "0");
    expect(shown.cursor).toBe("1");
    expect(f.chat.state).toHaveBeenCalledTimes(1);
    expect(f.chat.events).toHaveBeenCalledWith(handle.handleId, "0");
    expect(f.chat.observe).not.toHaveBeenCalled();
    expect(f.chat.prepare).not.toHaveBeenCalled();
    expect(f.chat.send).not.toHaveBeenCalled();
    expect(f.chat.acknowledgeFrame).not.toHaveBeenCalled();
    expect(f.chat.acknowledgeResult).not.toHaveBeenCalled();
  });
  it("serializes explicit result acknowledgement behind an in-flight observation", async () => {
    const f = fixture();
    await f.client.start(input, "Explain.");
    f.states.set(handle.handleId, { ...state(handle), hasResult: true });
    const shown = await f.client.progress(handle.handleId, "0");
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<Record<string, never>>((resolve) => {
      release = () => resolve({});
    });
    f.chat.observe.mockImplementationOnce(() => {
      entered();
      return held;
    });
    const poll = f.client.progress(handle.handleId, "0");
    await started;
    const ack = f.client.acknowledge(handle.handleId, shown.result!.resultId);
    expect(f.chat.acknowledgeResult).not.toHaveBeenCalled();
    release();
    await Promise.all([poll, ack]);
    expect(f.chat.acknowledgeResult).toHaveBeenCalledTimes(1);
    expect(f.chat.send).toHaveBeenCalledTimes(1);
  });
  it("promotes the original owner once and sends once across duplicate submit and repeated progress", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      f.client.start(input, "Explain this file."),
      f.client.start(structuredClone(input), "Explain this file."),
    ]);
    expect(a).toEqual(b);
    expect(f.owner.resolve).toHaveBeenCalledTimes(1);
    expect(f.owner.promote).toHaveBeenCalledWith({
      ...selected,
      prompt: "Explain this file.",
    });
    expect(f.chat.create).not.toHaveBeenCalled();
    await f.client.progress(handle.handleId, "0");
    await f.client.progress(handle.handleId, "0");
    expect(f.chat.send).toHaveBeenCalledTimes(1);
    expect(f.chat.prepare).toHaveBeenCalledTimes(1);
  });
  it("serves useful output before terminal and acknowledges each delivered frame separately", async () => {
    const f = fixture();
    await f.client.start(input, "Explain.");
    f.batches.set(handle.handleId, [
      { sequence: "1", kind: "response.created", data: {} },
      {
        sequence: "2",
        kind: "response.output_text.delta",
        data: { delta: "First useful chunk." },
      },
    ]);
    const early = await f.client.progress(handle.handleId, "0");
    expect(early.cursor).toBe("2");
    expect(early.frames[1]!.data).toEqual({ delta: "First useful chunk." });
    expect(early.result).toBeUndefined();
    expect(f.chat.acknowledgeFrame).not.toHaveBeenCalled();
    expect(f.chat.acknowledgeResult).not.toHaveBeenCalled();
    await f.client.progress(handle.handleId, early.cursor);
    expect(f.chat.acknowledgeFrame.mock.calls).toEqual([
      [handle.handleId, "1"],
      [handle.handleId, "2"],
    ]);
    expect(f.chat.send).toHaveBeenCalledTimes(1);
  });
  it("requires an offered exact result and keeps final ACK distinct from progress ACK", async () => {
    const f = fixture();
    await f.client.start(input, "Explain.");
    expect(() =>
      f.client.acknowledge(handle.handleId, "guessed-result"),
    ).toThrow("read_chat_result_not_offered");
    expect(f.chat.acknowledgeResult).not.toHaveBeenCalled();
    f.states.set(handle.handleId, {
      ...state(handle),
      phase: "completed",
      hasResult: true,
    });
    const shown = await f.client.progress(handle.handleId, "0");
    expect(shown.result?.complete).toBe(true);
    expect(shown.state.followReady).toBe(false);
    await Promise.all([
      f.client.acknowledge(handle.handleId, shown.result!.resultId),
      f.client.acknowledge(handle.handleId, shown.result!.resultId),
    ]);
    expect(f.chat.acknowledgeResult).toHaveBeenCalledTimes(1);
    expect(f.chat.create).not.toHaveBeenCalled();
  });
  it.each(["no-ack", "no-settlement", "no-release"])(
    "does not infer Follow from %s",
    async (variant) => {
      const f = fixture();
      await f.client.start(input, "Explain.");
      f.states.set(handle.handleId, {
        ...state(handle),
        hasResult: true,
        deliveryAcknowledged: variant !== "no-ack",
        lifecycleSettled: variant !== "no-settlement",
        released: variant !== "no-release",
        followReady: false,
      });
      await expect(
        f.client.follow(handle.handleId, "Continue."),
      ).rejects.toMatchObject({ code: "read_chat_follow_not_ready" });
      expect(f.chat.create).not.toHaveBeenCalled();
      expect(f.chat.send).toHaveBeenCalledTimes(1);
    },
  );
  it("follows the same owner with pinned selection and a new turn after Go declares readiness", async () => {
    const f = fixture();
    await f.client.start(input, "Explain.");
    f.states.set(handle.handleId, {
      ...state(handle),
      hasResult: true,
      deliveryAcknowledged: true,
      lifecycleSettled: true,
      released: true,
      followReady: true,
    });
    const [a, b] = await Promise.all([
      f.client.follow(handle.handleId, "What next?"),
      f.client.follow(handle.handleId, "What next?"),
    ]);
    expect(a).toEqual(b);
    expect(a.handle).toEqual(second);
    expect(f.chat.create).toHaveBeenCalledTimes(1);
    expect(f.chat.create).toHaveBeenCalledWith({
      previousHandle: handle.handleId,
      sessionId: handle.binding.sessionId,
      prompt: "What next?",
      selection,
      resolution: selected.resolution,
      required,
    });
    expect(f.chat.send).toHaveBeenCalledTimes(2);
    expect(f.owner.promote).toHaveBeenCalledTimes(1);
  });
  it("keeps a capacity-refused original queued and never replaces its admission", async () => {
    const f = fixture();
    f.chat.prepare.mockRejectedValueOnce(
      new BridgeError("refused", "CHAT_CAPACITY"),
    );
    await f.client.start(input, "Explain.");
    expect(f.chat.send).not.toHaveBeenCalled();
    await f.client.progress(handle.handleId, "0");
    expect(f.chat.send).toHaveBeenCalledTimes(1);
    expect(f.owner.promote).toHaveBeenCalledTimes(1);
    expect(f.chat.create).not.toHaveBeenCalled();
  });
  it.each(["prepare", "send", "observe", "acknowledgeFrame"] as const)(
    "a lost %s reply blocks later effects",
    async (stage) => {
      const f = fixture();
      if (stage === "prepare" || stage === "send") {
        f.chat[stage].mockRejectedValueOnce(new BridgeError("unknown", "lost"));
        await expect(f.client.start(input, "Explain.")).rejects.toMatchObject({
          code: "lost",
        });
        await expect(f.client.start(input, "Explain.")).rejects.toMatchObject({
          code: "lost",
        });
        expect(f.chat[stage]).toHaveBeenCalledTimes(1);
        return;
      }
      await f.client.start(input, "Explain.");
      let cursor = "0";
      if (stage === "acknowledgeFrame") {
        f.batches.set(handle.handleId, [
          { sequence: "1", kind: "response.created", data: {} },
        ]);
        cursor = (await f.client.progress(handle.handleId, "0")).cursor;
      }
      f.chat[stage].mockRejectedValueOnce(new BridgeError("unknown", "lost"));
      await expect(
        f.client.progress(handle.handleId, cursor),
      ).rejects.toMatchObject({ code: "lost" });
      const calls = f.chat[stage].mock.calls.length;
      await expect(
        f.client.progress(handle.handleId, cursor),
      ).rejects.toMatchObject({ code: "lost" });
      expect(f.chat[stage]).toHaveBeenCalledTimes(calls);
      expect(f.chat.send).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a missing frame ACK and a gapped projection without further effects", async () => {
    const f = fixture();
    await f.client.start(input, "Explain.");
    f.batches.set(handle.handleId, [
      { sequence: "1", kind: "response.created", data: {} },
    ]);
    const offered = await f.client.progress(handle.handleId, "0");
    f.chat.acknowledgeFrame.mockResolvedValueOnce({ status: "missing" });
    await expect(
      f.client.progress(handle.handleId, offered.cursor),
    ).rejects.toMatchObject({ code: "read_chat_frame_ack_unconfirmed" });
    const observed = f.chat.observe.mock.calls.length;
    await expect(
      f.client.progress(handle.handleId, offered.cursor),
    ).rejects.toBeInstanceOf(BridgeError);
    expect(f.chat.observe).toHaveBeenCalledTimes(observed);
    const gap = fixture();
    await gap.client.start(input, "Explain.");
    gap.batches.set(handle.handleId, [
      {
        sequence: "2",
        kind: "response.output_text.delta",
        data: { delta: "gap" },
      },
    ]);
    await expect(
      gap.client.progress(handle.handleId, "0"),
    ).rejects.toMatchObject({ code: "read_chat_stream_gap" });
    expect(gap.chat.send).toHaveBeenCalledTimes(1);
  });
  it("refuses a prepared or follow-up handle from another owner", async () => {
    const f = fixture();
    f.chat.prepare.mockResolvedValueOnce({
      handle: second,
      providerState: "home" as const,
      slotOrdinal: 0,
      slotGeneration: "1",
      viewId: "view",
      viewGeneration: "1",
      documentGeneration: "1",
      conversationId: "",
    });
    await expect(f.client.start(input, "Explain.")).rejects.toMatchObject({
      code: "read_chat_handle_crossed",
    });
    expect(f.chat.send).not.toHaveBeenCalled();
    const follow = fixture();
    await follow.client.start(input, "Explain.");
    follow.states.set(handle.handleId, { ...state(handle), followReady: true });
    follow.chat.create.mockResolvedValueOnce({
      ...second,
      binding: { ...second.binding, taskId: "replacement-task" },
    });
    await expect(
      follow.client.follow(handle.handleId, "Next."),
    ).rejects.toMatchObject({ code: "read_chat_follow_owner_crossed" });
    expect(follow.chat.send).toHaveBeenCalledTimes(1);
  });
  it("bounds the complete first and next prompts before promotion or create", async () => {
    const f = fixture();
    expect(() => f.client.start(input, "🙂".repeat(2049))).toThrow(
      "read_chat_prompt_invalid",
    );
    expect(f.owner.resolve).not.toHaveBeenCalled();
    await f.client.start(input, "Small.");
    expect(() => f.client.follow(handle.handleId, "x".repeat(8193))).toThrow(
      "read_chat_prompt_invalid",
    );
    expect(f.chat.create).not.toHaveBeenCalled();
  });
});
