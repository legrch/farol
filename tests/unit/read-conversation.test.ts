import { describe, expect, it, vi } from "vitest";
import { ReadConversationClient } from "../../apps/desktop/bridge/read-conversation.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import {
  validate,
  type ChatHandle,
  type ChatReadIntentResolve,
  type ChatReadIntentResolved,
  type ChatState,
  type ChatFrame,
  type ChatResult,
  type ChatCreate,
  type ChatStart,
  type ChatStarted,
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
    phase: "running",
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
    phase: "result-ready",
    outcome: "completed",
    code: "",
    text: "First useful chunk. Final chunk.",
    complete: true,
    acknowledged,
  };
}
it("represents absent provider IDs without widening populated result-ID bounds", () => {
  const result = {
    ...terminal(handle),
    evidence: { ...terminal(handle).evidence, evidenceId: "verified-evidence" },
    conversationId: "",
    userTurnId: "",
    replyId: "",
    outcome: "failed",
    code: "SEND_NOT_SENT",
    text: "",
    complete: false,
  };
  expect(validate("ChatResult", result)).toBe(true);
  for (const field of ["conversationId", "userTurnId", "replyId"] as const) {
    for (const value of ["", "a".repeat(256), "é".repeat(128)])
      expect(validate("ChatResult", { ...result, [field]: value })).toBe(true);
    for (const value of [
      "a".repeat(257),
      "é".repeat(129),
      "bad\u0000id",
      "bad\rid",
      "bad\nid",
      "bad\ud800id",
      null,
      1,
    ])
      expect(validate("ChatResult", { ...result, [field]: value })).toBe(false);
    const absent: Record<string, unknown> = { ...result };
    delete absent[field];
    expect(validate("ChatResult", absent)).toBe(false);
  }
});

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
  it.each(["refused", "unknown", "transport"] as const)(
    "allows exact admission withdrawal only after known resolution refusal: %s",
    async (outcome) => {
      const f = fixture();
      const error =
        outcome === "transport"
          ? new Error("reply lost")
          : new BridgeError(outcome, "model_unavailable");
      expect(f.client.canWithdrawAdmission()).toBe(false);
      f.owner.resolve.mockRejectedValueOnce(error);
      const attempt = f.client.start(input, "First");
      expect(f.client.canWithdrawAdmission()).toBe(false);
      await expect(attempt).rejects.toBe(error);
      expect(f.client.canWithdrawAdmission()).toBe(outcome === "refused");
      await expect(f.client.start(input, "First")).rejects.toBe(error);
      expect(f.owner.resolve).toHaveBeenCalledTimes(1);
      expect(f.owner.promote).not.toHaveBeenCalled();
      expect(f.chat.send).not.toHaveBeenCalled();
    },
  );
  it.each(["refused", "unknown"] as const)(
    "keeps attempted promotion fenced after %s",
    async (outcome) => {
      const f = fixture();
      f.owner.promote.mockRejectedValueOnce(
        new BridgeError(outcome, "promotion_failed"),
      );
      await expect(f.client.start(input, "First")).rejects.toThrow();
      expect(f.client.canWithdrawAdmission()).toBe(false);
      expect(f.owner.promote).toHaveBeenCalledTimes(1);
      expect(f.chat.send).not.toHaveBeenCalled();
    },
  );
  it.each(["progress", "snapshot"] as const)(
    "refuses queued %s on a superseded turn before any RPC",
    async (method) => {
      const f = fixture();
      await f.client.start(input, "Explain.");
      f.states.set(handle.handleId, { ...state(handle), followReady: true });
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = f.chat.create.getMockImplementation()!;
      f.chat.create.mockImplementationOnce(async (request) => {
        entered();
        await held;
        return original(request);
      });
      const follow = f.client.follow(handle.handleId, "Next.");
      await started;
      const stale = expect(
        f.client[method](handle.handleId, "0"),
      ).rejects.toMatchObject({ code: "read_chat_turn_superseded" });
      release();
      const next = await follow;
      vi.clearAllMocks();
      await stale;
      expect(next.handle).toEqual(second);
      expect(f.chat.observe).not.toHaveBeenCalled();
      expect(f.chat.acknowledgeFrame).not.toHaveBeenCalled();
      expect((await f.client.snapshot(second.handleId, "0")).handle).toEqual(
        second,
      );
    },
  );
  it("permits a new deliberate Follow after a proven local not-ready refusal", async () => {
    const f = fixture();
    await f.client.start(input, "Explain.");
    await expect(
      f.client.follow(handle.handleId, "Too early."),
    ).rejects.toMatchObject({ code: "read_chat_follow_not_ready" });
    expect(f.chat.create).not.toHaveBeenCalled();
    f.states.set(handle.handleId, { ...state(handle), followReady: true });
    expect(
      (await f.client.follow(handle.handleId, "Now ready.")).handle,
    ).toEqual(second);
    expect(f.chat.create).toHaveBeenCalledTimes(1);
    expect(f.chat.send).toHaveBeenCalledTimes(2);
  });
  it("keeps a Go-retained unknown result readable and ACKable without Observe or another Send", async () => {
    const f = fixture();
    await f.client.start(input, "Explain.");
    f.states.set(handle.handleId, {
      ...state(handle),
      phase: "unknown",
      hasResult: true,
    });
    f.chat.result.mockImplementation(async () => ({
      ...terminal(handle, f.states.get(handle.handleId)!.deliveryAcknowledged),
      phase: "unknown",
      outcome: "unknown",
      complete: false,
    }));
    f.chat.observe.mockRejectedValue(
      new BridgeError("unknown", "CHAT_UNSETTLED"),
    );
    const shown = await f.client.progress(handle.handleId, "0");
    expect(shown.result?.outcome).toBe("unknown");
    await f.client.acknowledge(handle.handleId, shown.result!.resultId);
    expect(
      (await f.client.snapshot(handle.handleId, "0")).result?.acknowledged,
    ).toBe(true);
    expect(f.chat.observe).not.toHaveBeenCalled();
    expect(f.chat.send).toHaveBeenCalledTimes(1);
    await expect(
      f.client.follow(handle.handleId, "Unsafe"),
    ).rejects.toMatchObject({ code: "read_chat_follow_not_ready" });
  });
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
    const attempt = f.client.start(input, "Explain this file.");
    expect(
      f.client.start(structuredClone(input), "Explain this file."),
    ).toBe(attempt);
    const [a, b] = await Promise.all([
      attempt,
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
      phase: "result-ready",
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

function authorizedFixture() {
  const f = fixture();
  const principal = "c".repeat(64);
  const request: ChatStart = {
    sessionId: handle.binding.sessionId,
    prompt: "Explain.",
    policy: input.policy,
    profiles: input.profiles,
    requested: input.requested,
    confirmedPrincipalKey: principal,
    observation: {
      state: "observed",
      source: "provider-session-v1",
      principalKey: principal,
      observedAtMillis: "1",
      expiresAtMillis: "100",
    },
  };
  const resolvedSelection = { ...selection, accountId: principal };
  const started: ChatStarted = {
    handle: structuredClone(handle),
    selection: resolvedSelection,
    resolution: { ...selected.resolution, resolved: { ...resolvedSelection } },
    required,
  };
  const chat = {
    ...f.chat,
    start: vi.fn(async (_request: ChatStart): Promise<ChatStarted> =>
      structuredClone(started),
    ),
  };
  chat.result.mockImplementation(async (id) => ({
    ...terminal(
      id === handle.handleId ? handle : second,
      f.states.get(id)!.deliveryAcknowledged,
    ),
    evidence: {
      ...terminal(handle).evidence,
      requested: started.selection,
      resolution: started.resolution,
    },
  }));
  return {
    ...f,
    request: structuredClone(request),
    started: structuredClone(started),
    chat,
    client: new ReadConversationClient(null, chat, () => 1),
  };
}

// Injected Chat port only: these states prove client mechanics, not Go
// admission, provider authorization, native transport or actual settlement.
describe("authorized ordinary conversation mechanical client", () => {
  it("pins the exact promise synchronously and starts, prepares and sends once", async () => {
    const f = authorizedFixture();
    const attempt = f.client.startAuthorized(f.request);
    expect(f.chat.start).not.toHaveBeenCalled();
    expect(f.client.startAuthorized(structuredClone(f.request))).toBe(attempt);
    const first = await attempt;
    expect(f.client.startAuthorized(f.request)).toBe(attempt);
    expect(first.handle).toEqual(handle);
    expect(f.chat.start).toHaveBeenCalledWith(f.request);
    expect(f.chat.start.mock.contexts[0]).toBe(f.chat);
    await f.client.progress(handle.handleId, "0");
    await f.client.progress(handle.handleId, "0");
    expect(f.chat.start).toHaveBeenCalledTimes(1);
    expect(f.chat.prepare).toHaveBeenCalledTimes(1);
    expect(f.chat.send).toHaveBeenCalledTimes(1);
    expect(f.chat.send).toHaveBeenCalledWith(handle.handleId, "12001");
    expect(f.chat.create).not.toHaveBeenCalled();
    expect(f.owner.resolve).not.toHaveBeenCalled();
    expect(f.owner.promote).not.toHaveBeenCalled();
    expect(f.client.canWithdrawAdmission()).toBe(false);
  });

  it.each(["start", "prepare", "send", "state", "events"] as const)(
    "retains the exact failed promise after unknown %s without replay effects",
    async (stage) => {
      const f = authorizedFixture();
      const error = new BridgeError("unknown", "lost");
      f.chat[stage].mockRejectedValueOnce(error);
      const attempt = f.client.startAuthorized(f.request);
      expect(f.client.startAuthorized(f.request)).toBe(attempt);
      await expect(attempt).rejects.toBe(error);
      expect(f.client.startAuthorized(f.request)).toBe(attempt);
      await expect(f.client.startAuthorized(f.request)).rejects.toBe(error);
      expect(f.chat[stage]).toHaveBeenCalledTimes(1);
      expect(f.chat.start).toHaveBeenCalledTimes(1);
      expect(f.chat.send.mock.calls.length).toBeLessThanOrEqual(1);
      expect(f.client.canWithdrawAdmission()).toBe(false);
    },
  );

  it.each(["refused", "transport"] as const)(
    "retains a %s admission attempt without another start",
    async (outcome) => {
      const f = authorizedFixture();
      const error =
        outcome === "refused"
          ? new BridgeError("refused", "account_unavailable")
          : new Error("reply lost");
      f.chat.start.mockRejectedValueOnce(error);
      const attempt = f.client.startAuthorized(f.request);
      await expect(attempt).rejects.toBe(error);
      expect(f.client.startAuthorized(f.request)).toBe(attempt);
      await expect(attempt).rejects.toBe(error);
      expect(() =>
        f.client.startAuthorized({ ...f.request, prompt: "Changed." }),
      ).toThrow("read_chat_start_crossed");
      expect(() => f.client.start(input, "Explain.")).toThrow(
        "read_chat_start_crossed",
      );
      expect(f.chat.start).toHaveBeenCalledTimes(1);
      expect(f.chat.prepare).not.toHaveBeenCalled();
      expect(f.chat.send).not.toHaveBeenCalled();
      expect(f.client.canWithdrawAdmission()).toBe(false);
    },
  );

  it.each(["read", "authorized"] as const)(
    "refuses changed input and crossing from the %s start path before effects",
    async (path) => {
      const f = authorizedFixture();
      const client = new ReadConversationClient(f.owner, f.chat, () => 1);
      const attempt =
        path === "read"
          ? client.start(input, "Explain.")
          : client.startAuthorized(f.request);
      if (path === "read") {
        expect(() => client.startAuthorized(f.request)).toThrow(
          "read_chat_start_crossed",
        );
        expect(() => client.start(input, "Changed.")).toThrow(
          "read_chat_start_crossed",
        );
      } else {
        expect(() => client.start(input, "Explain.")).toThrow(
          "read_chat_start_crossed",
        );
        for (const changed of [
          { ...f.request, prompt: "Changed." },
          { ...f.request, sessionId: "other-session" },
          { ...f.request, requested: { effort: "high" } },
          {
            ...f.request,
            observation: { ...f.request.observation, expiresAtMillis: "101" },
          },
        ])
          expect(() => client.startAuthorized(changed)).toThrow(
            "read_chat_start_crossed",
          );
      }
      await attempt;
      expect(f.chat.start).toHaveBeenCalledTimes(path === "read" ? 0 : 1);
      expect(f.owner.promote).toHaveBeenCalledTimes(path === "read" ? 1 : 0);
      expect(f.chat.send).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses unavailable ports and invalid requests before admission or transport", () => {
    const f = fixture();
    const direct = authorizedFixture();
    const client = new ReadConversationClient(null, f.chat, () => 1);
    expect(() => client.startAuthorized(direct.request)).toThrow(
      "read_chat_start_unavailable",
    );
    expect(() => client.start(input, "Explain.")).toThrow(
      "read_chat_owner_unavailable",
    );
    for (const request of [
      { ...direct.request, prompt: "" },
      { ...direct.request, prompt: "x".repeat(8193) },
      { ...direct.request, prompt: "bad\ud800" },
      { ...direct.request, approved: true },
      {
        ...direct.request,
        observation: {
          ...direct.request.observation,
          principalKey: "d".repeat(64),
        },
      },
    ])
      expect(() => direct.client.startAuthorized(request)).toThrow(BridgeError);
    expect(direct.chat.start).not.toHaveBeenCalled();
    expect(f.chat.prepare).not.toHaveBeenCalled();
    expect(f.chat.send).not.toHaveBeenCalled();
    expect(direct.chat.prepare).not.toHaveBeenCalled();
    expect(direct.chat.send).not.toHaveBeenCalled();
  });

  it.each(["invalid", "session", "principal", "resolution", "generation"])(
    "fences a %s start result before Prepare or Send",
    async (field) => {
      const f = authorizedFixture();
      const out = f.started;
      if (field === "invalid") Reflect.set(out, "extra", true);
      if (field === "session")
        Reflect.set(out.handle.binding, "sessionId", "other");
      if (field === "principal") {
        Reflect.set(out.selection, "accountId", "d".repeat(64));
        Reflect.set(out.resolution.resolved, "accountId", "d".repeat(64));
      }
      if (field === "resolution")
        Reflect.set(out.resolution.resolved, "modelId", "other-model");
      if (field === "generation")
        Reflect.set(out.handle.binding, "turnGeneration", "2");
      f.chat.start.mockResolvedValueOnce(out);
      const attempt = f.client.startAuthorized(f.request);
      await expect(attempt).rejects.toMatchObject({
        state: "unknown",
        code:
          field === "invalid"
            ? "read_chat_start_invalid"
            : "read_chat_start_result_crossed",
      });
      expect(f.client.startAuthorized(f.request)).toBe(attempt);
      await expect(attempt).rejects.toBeInstanceOf(BridgeError);
      expect(f.chat.start).toHaveBeenCalledTimes(1);
      expect(f.chat.prepare).not.toHaveBeenCalled();
      expect(f.chat.send).not.toHaveBeenCalled();
    },
  );

  it("detaches input, port replies and projections while pinning Go's selection for Follow", async () => {
    const f = authorizedFixture();
    const original = structuredClone(f.request);
    const authoritative = {
      ...f.started,
      selection: { ...f.started.selection, modelId: "go-selected-model" },
      resolution: {
        ...f.started.resolution,
        resolved: { ...f.started.selection, modelId: "go-selected-model" },
      },
    };
    const expected = structuredClone(authoritative);
    f.chat.start.mockImplementationOnce(async (request) => {
      expect(request).toEqual(original);
      Reflect.set(request, "prompt", "port mutation");
      return authoritative;
    });
    const attempt = f.client.startAuthorized(f.request);
    Reflect.set(f.request, "prompt", "caller mutation");
    const first = await attempt;
    expect(f.client.startAuthorized(original)).toBe(attempt);
    Reflect.set(authoritative.selection, "modelId", "later port mutation");
    Reflect.set(authoritative.handle.binding, "ownerId", "later port mutation");
    Reflect.set(first.handle.binding, "sessionId", "projection mutation");
    Reflect.set(first.state, "followReady", true);
    expect((await f.client.snapshot(handle.handleId, "0")).handle).toEqual(
      handle,
    );
    await expect(
      f.client.follow(handle.handleId, "Too early."),
    ).rejects.toMatchObject({ code: "read_chat_follow_not_ready" });
    expect(f.chat.create).not.toHaveBeenCalled();
    f.states.set(handle.handleId, { ...state(handle), followReady: true });
    await f.client.follow(handle.handleId, "Next.");
    expect(f.chat.create).toHaveBeenCalledWith({
      previousHandle: handle.handleId,
      sessionId: handle.binding.sessionId,
      prompt: "Next.",
      selection: expected.selection,
      resolution: expected.resolution,
      required: expected.required,
    });
    expect(f.chat.start).toHaveBeenCalledTimes(1);
    expect(f.chat.send).toHaveBeenCalledTimes(2);
  });

  it("uses the same frame ACK, result ACK and Go settlement gate before Follow", async () => {
    const f = authorizedFixture();
    await f.client.startAuthorized(f.request);
    f.batches.set(handle.handleId, [
      { sequence: "1", kind: "response.created", data: {} },
      {
        sequence: "2",
        kind: "response.output_text.delta",
        data: { delta: "Useful." },
      },
    ]);
    const early = await f.client.progress(handle.handleId, "0");
    expect(early.cursor).toBe("2");
    expect(early.result).toBeUndefined();
    await f.client.progress(handle.handleId, early.cursor);
    expect(f.chat.acknowledgeFrame.mock.calls).toEqual([
      [handle.handleId, "1"],
      [handle.handleId, "2"],
    ]);
    expect(f.chat.acknowledgeResult).not.toHaveBeenCalled();
    f.states.set(handle.handleId, {
      ...state(handle),
      phase: "result-ready",
      hasResult: true,
    });
    const shown = await f.client.snapshot(handle.handleId, early.cursor);
    const ack = f.client.acknowledge(handle.handleId, shown.result!.resultId);
    expect(f.client.acknowledge(handle.handleId, shown.result!.resultId)).toBe(
      ack,
    );
    await ack;
    expect(f.chat.acknowledgeResult).toHaveBeenCalledTimes(1);
    await expect(
      f.client.follow(handle.handleId, "Too early."),
    ).rejects.toMatchObject({ code: "read_chat_follow_not_ready" });
    f.states.set(handle.handleId, {
      ...f.states.get(handle.handleId)!,
      lifecycleSettled: true,
      released: false,
    });
    await expect(
      f.client.follow(handle.handleId, "Still early."),
    ).rejects.toMatchObject({ code: "read_chat_follow_not_ready" });
    expect(f.chat.create).not.toHaveBeenCalled();
    f.states.set(handle.handleId, {
      ...f.states.get(handle.handleId)!,
      released: true,
      followReady: true,
    });
    expect((await f.client.follow(handle.handleId, "Next.")).handle).toEqual(
      second,
    );
    expect(f.chat.create).toHaveBeenCalledTimes(1);
    expect(f.chat.prepare).toHaveBeenCalledTimes(2);
    expect(f.chat.send).toHaveBeenCalledTimes(2);
    expect(f.chat.start).toHaveBeenCalledTimes(1);
  });

  it("preserves the capacity-refused queued handle until deliberate progress", async () => {
    const f = authorizedFixture();
    f.chat.prepare.mockRejectedValueOnce(
      new BridgeError("refused", "CHAT_CAPACITY"),
    );
    const attempt = f.client.startAuthorized(f.request);
    await attempt;
    expect(f.client.startAuthorized(f.request)).toBe(attempt);
    expect(f.chat.prepare).toHaveBeenCalledTimes(1);
    expect(f.chat.send).not.toHaveBeenCalled();
    await f.client.progress(handle.handleId, "0");
    await f.client.progress(handle.handleId, "0");
    expect(f.chat.start).toHaveBeenCalledTimes(1);
    expect(f.chat.prepare).toHaveBeenCalledTimes(2);
    expect(f.chat.send).toHaveBeenCalledTimes(1);
    expect(f.chat.create).not.toHaveBeenCalled();
  });
});
