import { describe, expect, it, vi } from "vitest";
import { ChatGptPhysical } from "../../apps/desktop/chatgpt-physical";
import type {
  PhysicalBinding,
  PhysicalFrame,
  PhysicalSelection,
  PhysicalWitness,
} from "../../apps/desktop/chatgpt-physical-api";
import type {
  ChatGptPhysicalHostPort,
  PhysicalSurface,
} from "../../apps/desktop/chatgpt-physical-host-port";

const home: PhysicalBinding = {
  viewId: "42",
  viewGeneration: 1,
  documentGeneration: 2,
  partition: "persist:farol-dev-chatgpt",
  phase: "home",
  url: "https://chatgpt.com/",
  conversationId: null,
};
const bound: PhysicalBinding = {
  ...home,
  phase: "conversation",
  url: "https://chatgpt.com/c/actual-cid",
  conversationId: "actual-cid",
};
const pins = {
  provider: "farol",
  alias: "owner",
  accountId: "local-only-account",
  modelId: "canonical-model",
  effort: "standard",
  mode: "saved",
  connectorId: "connector-id",
  connectorGrantId: "local-grant",
  toolsEnabled: true,
};
const selection: PhysicalSelection = {
  requested: pins,
  admitted: pins,
  resolved: {
    selection: pins,
    configSHA256: "a".repeat(64),
    translationId: "qualified-mapping",
  },
  controls: {
    modelLabel: "Thinking",
    effortLabel: "Standard",
    modeLabel: null,
    connector: { id: "connector-id", label: "Farol" },
  },
  requiredControls: { model: true, effort: true, mode: false, connector: true },
};
const observed = {
  modelLabel: { state: "observed", source: "public-dom", value: "Thinking" },
  effortLabel: { state: "observed", source: "public-dom", value: "Standard" },
  modeLabel: { state: "unknown", code: "not-exposed" },
  connectorLabel: { state: "observed", source: "public-dom", value: "Farol" },
} as const;
const frame: PhysicalFrame = {
  userId: "user-new",
  messages: [
    {
      id: "reply-new",
      parentId: "user-new",
      channel: "answer",
      text: "Answer",
      complete: true,
    },
  ],
  terminal: true,
};

function harness(initial: PhysicalBinding = home) {
  let binding = initial;
  let destroyed = false;
  let pointer: object = {};
  let available = true;
  let clock = 1_000;
  const snapshot = (): PhysicalSurface | null =>
    available
      ? { handle: pointer, binding, isDestroyed: () => destroyed }
      : null;
  const port: ChatGptPhysicalHostPort = {
    qualified: vi.fn(() => true),
    snapshot: vi.fn(snapshot),
    homeUrl: home.url,
    conversationUrl: vi.fn((cid) =>
      /^[-\w]+$/.test(cid) ? `https://chatgpt.com/c/${cid}` : null,
    ),
    load: vi.fn(async (_s, url) => {
      binding = url === home.url ? home : bound;
    }),
    prepareProbe: vi.fn(async (_s, _b) => ({
      readiness: "ready",
    })),
    verifySend: vi.fn(async (_s, input) => ({
      state: "witnessed",
      binding: input.binding,
      operationId: input.operationId,
      evidenceId: "evidence-one",
      intentDigest: input.intentDigest,
      previous: input.previous,
      observed,
      sourceProfile: "message-anchors-v1",
      baselineUserIds: [],
    })),
    send: vi.fn(async (_s, input) => ({
      state: "submitted",
      binding: input.binding,
      operationId: input.operationId,
      evidenceId: input.witness.evidenceId,
      code: "PHYSICAL_SUBMITTED",
    })),
    observe: vi.fn(async (_s, input) => ({
      state: "observed",
      originBinding: input.submission.originBinding,
      binding: input.binding,
      correlation: { userTurnId: "user-new", replyId: "reply-new" },
      observed,
      sourceProfile: "message-anchors-v1",
      frame,
    })),
    cancel: vi.fn(async (_s, input) => ({
      state: "requested",
      binding: input.binding,
      code: "PHYSICAL_STOP_REQUESTED",
    })),
    destroy: vi.fn(async () => {
      destroyed = true;
      available = false;
    }),
  };
  const api = new ChatGptPhysical(port, () => clock);
  const operation = {
    operationId: "operation-one",
    binding: initial,
    deadlineMillis: 10_000,
  };
  const verify = {
    ...operation,
    previous: null,
    intentDigest: "opaque-go-intent",
    selection,
  };
  const guard = vi.fn(() => true);
  const witness = async (): Promise<PhysicalWitness> => {
    const result = await api.verifySend(verify, guard);
    if (result.state !== "witnessed") throw new Error(result.code);
    return result.witness;
  };
  const send = async () =>
    api.send(
      {
        ...operation,
        witness: await witness(),
        intentDigest: verify.intentDigest,
        prompt: "Transient\r\nprompt",
      },
      guard,
    );
  return {
    api,
    port,
    operation,
    verify,
    guard,
    witness,
    send,
    navigate: (b: PhysicalBinding) => {
      binding = b;
    },
    replace: () => {
      pointer = {};
    },
    hide: () => {
      available = false;
    },
    expire: () => {
      clock = 10_001;
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

describe("dedicated physical host facade", () => {
  it("prepares Home without a fabricated conversation ID or prompt", async () => {
    const h = harness(bound);
    expect(
      await h.api.prepare(
        {
          operationId: "prepare",
          target: { kind: "new-saved" },
          deadlineMillis: 10_000,
        },
        h.guard,
      ),
    ).toEqual({ state: "prepared", binding: home, readiness: "ready" });
    expect(h.port.load).toHaveBeenCalledOnce();
    expect(h.port.send).not.toHaveBeenCalled();
  });
  it("performs a readonly witness and preserves declarations separately from four facts", async () => {
    const h = harness();
    const witness = await h.witness();
    expect(witness.selection).toEqual({
      declared: selection,
      observed,
      observedAtMillis: 1_000,
      sourceProfile: "message-anchors-v1",
    });
    expect(Object.keys(witness.selection.observed).sort()).toEqual([
      "connectorLabel",
      "effortLabel",
      "modeLabel",
      "modelLabel",
    ]);
    expect(h.port.send).not.toHaveBeenCalled();
  });
  it("refuses an unknown required control and accepts unknown optional controls", async () => {
    const h = harness();
    h.verify.selection = {
      ...selection,
      requiredControls: { ...selection.requiredControls, mode: true },
    };
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "refused",
      code: "PHYSICAL_VERIFICATION_MISMATCH",
    });
    expect(h.port.send).not.toHaveBeenCalled();
  });
  it("never replaces a missing control fact with a configured model ID", async () => {
    const h = harness();
    vi.mocked(h.port.verifySend).mockResolvedValue({
      state: "witnessed",
      binding: home,
      operationId: h.operation.operationId,
      evidenceId: "e",
      intentDigest: h.verify.intentDigest,
      previous: null,
      observed: {
        ...observed,
        modelLabel: { state: "unknown", code: "not-exposed" },
      },
      sourceProfile: "message-anchors-v1",
      baselineUserIds: [],
    });
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "refused",
    });
  });
  it("rejects a changed view after readonly evidence", async () => {
    const h = harness();
    vi.mocked(h.port.verifySend).mockImplementation(async () => {
      h.replace();
      return {};
    });
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "refused",
      code: "PHYSICAL_BINDING_LOST",
    });
  });
  it("requires the full external lease guard before and after evidence", async () => {
    const h = harness();
    h.guard.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "refused",
    });
  });
  it("consumes an exact detached witness before the first Send and denies replay", async () => {
    const h = harness();
    const witness = await h.witness();
    const sendInput = {
      ...h.operation,
      witness,
      intentDigest: h.verify.intentDigest,
      prompt: "Transient prompt",
    };
    expect(await h.api.send(sendInput, h.guard)).toMatchObject({
      state: "submitted",
    });
    expect(await h.api.send(sendInput, h.guard)).toMatchObject({
      state: "not-sent",
    });
    expect(h.port.send).toHaveBeenCalledOnce();
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "refused",
    });
  });
  it("rejects a caller-mutated witness without changing the retained original", async () => {
    const h = harness();
    const witness = await h.witness();
    const changed = structuredClone(witness);
    Reflect.set(changed.selection.declared.controls, "modelLabel", "Other");
    expect(
      await h.api.send(
        {
          ...h.operation,
          witness: changed,
          intentDigest: h.verify.intentDigest,
          prompt: "prompt",
        },
        h.guard,
      ),
    ).toMatchObject({ state: "not-sent" });
    expect(
      await h.api.send(
        {
          ...h.operation,
          witness,
          intentDigest: h.verify.intentDigest,
          prompt: "prompt",
        },
        h.guard,
      ),
    ).toMatchObject({ state: "submitted" });
  });
  it("retains one-shot fuse and prompt-free metadata after lost ACK", async () => {
    const h = harness();
    vi.mocked(h.port.send).mockRejectedValue(new Error("secret page body"));
    expect(await h.send()).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_SEND_UNCONFIRMED",
    });
    await h.api.observe(h.operation, h.guard);
    const page = vi.mocked(h.port.observe).mock.calls[0]![1];
    expect(page.submission.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(page)).not.toContain("Transient");
    expect(page.submission.intentDigest).toBe("opaque-go-intent");
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "refused",
    });
  });
  it("does not confirm Send when owner authority is lost after dispatch", async () => {
    const h = harness();
    const witness = await h.witness();
    h.guard.mockReturnValueOnce(true).mockReturnValue(false);
    expect(
      await h.api.send(
        {
          ...h.operation,
          witness,
          intentDigest: h.verify.intentDigest,
          prompt: "prompt",
        },
        h.guard,
      ),
    ).toMatchObject({ state: "unknown" });
    expect(h.port.send).toHaveBeenCalledOnce();
  });
  it("observes the exact original submitted operation, no latest turn lookup", async () => {
    const h = harness();
    await h.send();
    expect(
      await h.api.observe({ ...h.operation, operationId: "other" }, h.guard),
    ).toMatchObject({ state: "refused" });
    expect(h.port.observe).not.toHaveBeenCalled();
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "user-new", replyId: "reply-new" },
    });
  });
  it("adopts a real canonical first CID once while keeping the origin Home", async () => {
    const h = harness();
    await h.send();
    h.navigate(bound);
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "observed",
      originBinding: home,
      binding: bound,
    });
    expect(
      await h.api.observe({ ...h.operation, binding: bound }, h.guard),
    ).toMatchObject({ state: "observed" });
    h.navigate({
      ...bound,
      conversationId: "other",
      url: "https://chatgpt.com/c/other",
    });
    expect(
      await h.api.observe({ ...h.operation, binding: bound }, h.guard),
    ).toMatchObject({ state: "refused" });
  });
  it("does not treat a new document as same-document CID adoption", async () => {
    const h = harness();
    await h.send();
    h.navigate({ ...bound, documentGeneration: 3 });
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "refused",
    });
    expect(h.port.observe).not.toHaveBeenCalled();
  });
  it("retains provider IDs once, refusing stale/mismatched later events", async () => {
    const h = harness();
    await h.send();
    await h.api.observe(h.operation, h.guard);
    vi.mocked(h.port.observe).mockImplementation(async (_s, input) => ({
      state: "observed",
      originBinding: home,
      binding: input.binding,
      correlation: { userTurnId: "other-user", replyId: "reply-new" },
      observed,
      sourceProfile: "message-anchors-v1",
      frame,
    }));
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "refused",
      code: "PHYSICAL_CORRELATION_MISMATCH",
    });
  });
  it("allows an accepted user turn before an assistant reply exists", async () => {
    const h = harness();
    await h.send();
    vi.mocked(h.port.observe).mockResolvedValue({
      state: "observed",
      originBinding: home,
      binding: home,
      correlation: { userTurnId: "user-new", replyId: null },
      observed,
      sourceProfile: "message-anchors-v1",
      frame: null,
    });
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "user-new", replyId: null },
    });
  });
  it("does not promote missing Stop to cancellation completion", async () => {
    const h = harness();
    await h.send();
    vi.mocked(h.port.cancel).mockResolvedValue({
      state: "unknown",
      binding: home,
      code: "PHYSICAL_STOP_MISSING",
    });
    expect(await h.api.cancel(h.operation, h.guard)).toMatchObject({
      state: "unknown",
    });
    expect(await h.api.cancel(h.operation, h.guard)).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_CANCEL_ALREADY_ATTEMPTED",
    });
    expect(h.port.cancel).toHaveBeenCalledOnce();
  });
  it("requires an exact full terminal frame for cancellation proof", async () => {
    const h = harness();
    await h.send();
    vi.mocked(h.port.cancel).mockResolvedValue({
      state: "already-terminal",
      proof: {
        binding: home,
        correlation: { userTurnId: "user-new", replyId: "reply-new" },
        frame: { ...frame, terminal: false },
      },
    });
    expect(await h.api.cancel(h.operation, h.guard)).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_CANCEL_TERMINAL_UNPROVEN",
    });
  });
  it("confirms cancellation only with correlated terminal proof", async () => {
    const h = harness();
    await h.send();
    vi.mocked(h.port.cancel).mockResolvedValue({
      state: "already-terminal",
      proof: {
        binding: home,
        correlation: { userTurnId: "user-new", replyId: "reply-new" },
        frame,
      },
    });
    expect(await h.api.cancel(h.operation, h.guard)).toMatchObject({
      state: "already-terminal",
    });
  });
  it("confirms disposal from the same native object even if disposal throws afterward", async () => {
    const h = harness();
    vi.mocked(h.port.destroy).mockImplementation(async () => {
      h.destroy();
      throw new Error("after native destroy");
    });
    expect(await h.api.dispose(h.operation, h.guard)).toMatchObject({
      state: "destroyed",
      destroyedWebContentsId: "42",
    });
  });
  it("never treats void disposal or null binding as destruction proof", async () => {
    const h = harness();
    vi.mocked(h.port.destroy).mockImplementation(async () => {
      h.hide();
    });
    expect(await h.api.dispose(h.operation, h.guard)).toMatchObject({
      state: "unconfirmed",
    });
    expect(h.port.destroy).toHaveBeenCalledOnce();
    expect(await h.api.dispose(h.operation, h.guard)).toMatchObject({
      state: "refused",
    });
  });
  it("rejects expired deadlines and secret-bearing malformed page receipts", async () => {
    const h = harness();
    h.expire();
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "refused",
    });
    expect(h.port.verifySend).not.toHaveBeenCalled();
    const other = harness();
    vi.mocked(other.port.verifySend).mockResolvedValue({
      state: "refused",
      code: "private prompt text",
    });
    expect(await other.api.verifySend(other.verify, other.guard)).toEqual({
      state: "refused",
      code: "PHYSICAL_VERIFICATION_RECEIPT_INVALID",
    });
  });
  it("denies concurrent Send while preserving a single dispatch", async () => {
    const h = harness();
    const witness = await h.witness();
    let complete!: (value: unknown) => void;
    vi.mocked(h.port.send).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const request = {
      ...h.operation,
      witness,
      intentDigest: h.verify.intentDigest,
      prompt: "prompt",
    };
    const first = h.api.send(request, h.guard);
    expect(await h.api.send(request, h.guard)).toMatchObject({
      state: "not-sent",
    });
    complete({
      state: "submitted",
      binding: home,
      operationId: h.operation.operationId,
      evidenceId: witness.evidenceId,
      code: "PHYSICAL_SUBMITTED",
    });
    expect(await first).toMatchObject({ state: "submitted" });
    expect(h.port.send).toHaveBeenCalledOnce();
  });
  it("retains Prepare fuse when navigation acknowledgement is lost", async () => {
    const h = harness(bound);
    vi.mocked(h.port.load).mockRejectedValue(
      new Error("unconfirmed navigation"),
    );
    const request = {
      operationId: "prepare",
      target: { kind: "new-saved" as const },
      deadlineMillis: 10_000,
    };
    expect(await h.api.prepare(request, h.guard)).toMatchObject({
      state: "unknown",
    });
    expect(await h.api.prepare(request, h.guard)).toMatchObject({
      state: "refused",
    });
    expect(h.port.load).toHaveBeenCalledOnce();
  });
  it("refuses malformed Send without echoing any private input", async () => {
    const h = harness();
    const result = await h.api.send(
      { password: "private-canary" } as never,
      h.guard,
    );
    expect(result).toEqual({ state: "refused", code: "PHYSICAL_SEND_INVALID" });
    expect(h.port.send).not.toHaveBeenCalled();
  });
  it("refuses a full-terminal claim with an incomplete semantic message", async () => {
    const h = harness();
    await h.send();
    vi.mocked(h.port.cancel).mockResolvedValue({
      state: "already-terminal",
      proof: {
        binding: home,
        correlation: { userTurnId: "user-new", replyId: "reply-new" },
        frame: {
          ...frame,
          messages: [{ ...frame.messages[0]!, complete: false }],
        },
      },
    });
    expect(await h.api.cancel(h.operation, h.guard)).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_CANCEL_TERMINAL_UNPROVEN",
    });
  });
  it("refuses a first CID unless the provider user turn is proven", async () => {
    const h = harness();
    await h.send();
    h.navigate(bound);
    vi.mocked(h.port.observe).mockResolvedValue({
      state: "observed",
      originBinding: home,
      binding: bound,
      correlation: { userTurnId: null, replyId: null },
      observed,
      sourceProfile: "message-anchors-v1",
      frame: null,
    });
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "refused",
      code: "PHYSICAL_PROVIDER_ID_UNPROVEN",
    });
  });

  it("accepts empty declared mode with optional unknown public mode", async () => {
    const h = harness();
    const noMode = { ...pins, mode: "" };
    h.verify.selection = {
      ...selection,
      requested: noMode,
      admitted: noMode,
      resolved: { ...selection.resolved, selection: noMode },
    };
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "witnessed",
      witness: {
        selection: {
          declared: { admitted: { mode: "" } },
          observed: { modeLabel: { state: "unknown" } },
        },
      },
    });
  });

  it("rejects a late old Observe instead of opening Send during a newer submission", async () => {
    const h = harness();
    await h.send();
    await h.api.observe(h.operation, h.guard);
    let complete!: (value: unknown) => void;
    vi.mocked(h.port.observe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const old = h.api.observe(h.operation, h.guard);
    vi.mocked(h.port.verifySend).mockImplementation(async (_s, request) => ({
      state: "witnessed",
      binding: request.binding,
      operationId: request.operationId,
      evidenceId: request.operationId,
      intentDigest: request.intentDigest,
      previous: request.previous,
      observed,
      sourceProfile: "message-anchors-v1",
      baselineUserIds: [],
    }));
    const sendOther = async (operationId: string) => {
      const request = { ...h.verify, operationId };
      const verified = await h.api.verifySend(request, h.guard);
      if (verified.state !== "witnessed") throw new Error(verified.code);
      return h.api.send(
        {
          ...h.operation,
          operationId,
          witness: verified.witness,
          intentDigest: h.verify.intentDigest,
          prompt: "other",
        },
        h.guard,
      );
    };
    expect(await sendOther("operation-B")).toMatchObject({
      state: "submitted",
    });
    complete({
      state: "observed",
      originBinding: home,
      binding: home,
      correlation: { userTurnId: "user-new", replyId: "reply-new" },
      observed,
      sourceProfile: "message-anchors-v1",
      frame,
    });
    expect(await old).toMatchObject({
      state: "refused",
      code: "PHYSICAL_OBSERVATION_STALE",
    });
    expect(await sendOther("operation-C")).toMatchObject({ state: "not-sent" });
    expect(h.port.send).toHaveBeenCalledTimes(2);
  });
  it("freezes exact native disposal identity before an awaited effect", async () => {
    const h = harness();
    let complete!: () => void;
    vi.mocked(h.port.destroy).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () => {
            h.destroy();
            resolve();
          };
        }),
    );
    const request = { ...h.operation, binding: { ...home } };
    const result = h.api.dispose(request, h.guard);
    Reflect.set(request.binding, "viewId", "99");
    Reflect.set(request.binding, "viewGeneration", 99);
    complete();
    expect(await result).toMatchObject({
      state: "destroyed",
      destroyedWebContentsId: "42",
      view: { viewId: "42", viewGeneration: 1 },
    });
  });
  it("detaches accepted correlation from a caller-modifiable Observe result", async () => {
    const h = harness();
    await h.send();
    const first = await h.api.observe(h.operation, h.guard);
    if (first.state !== "observed") throw new Error(first.code);
    Reflect.set(first.correlation, "userTurnId", "foreign");
    Reflect.set(first.correlation, "replyId", "foreign-reply");
    vi.mocked(h.port.observe).mockResolvedValue({
      state: "observed",
      originBinding: home,
      binding: home,
      correlation: { userTurnId: "foreign", replyId: "foreign-reply" },
      observed,
      sourceProfile: "message-anchors-v1",
      frame: {
        userId: "foreign",
        messages: [
          { ...frame.messages[0]!, id: "foreign-reply", parentId: "foreign" },
        ],
        terminal: true,
      },
    });
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "refused",
      code: "PHYSICAL_CORRELATION_MISMATCH",
    });
  });
  it("detaches accepted provider IDs from a caller-modifiable Cancel proof", async () => {
    const h = harness();
    await h.send();
    vi.mocked(h.port.cancel).mockResolvedValue({
      state: "already-terminal",
      proof: {
        binding: home,
        correlation: { userTurnId: "user-new", replyId: "reply-new" },
        frame,
      },
    });
    const proof = await h.api.cancel(h.operation, h.guard);
    if (proof.state !== "already-terminal") throw new Error("missing proof");
    Reflect.set(proof.proof.correlation, "userTurnId", "foreign");
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "user-new" },
    });
  });
  it("rechecks the original logical lease after native teardown", async () => {
    const h = harness();
    h.guard.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await h.api.dispose(h.operation, h.guard)).toMatchObject({
      state: "unconfirmed",
      code: "PHYSICAL_DISPOSE_AUTHORITY_LOST",
    });
    expect(h.guard).toHaveBeenCalledTimes(2);
    expect(h.port.destroy).toHaveBeenCalledOnce();
  });
  it("accepts ordered assistant parents while rejecting foreign and forward parents", async () => {
    const h = harness();
    await h.send();
    const chained = {
      ...frame,
      messages: [
        { ...frame.messages[0]!, channel: "commentary" as const },
        { ...frame.messages[0]!, id: "reply-two", parentId: "reply-new" },
      ],
    };
    vi.mocked(h.port.observe).mockResolvedValue({
      state: "observed",
      originBinding: home,
      binding: home,
      correlation: { userTurnId: "user-new", replyId: "reply-new" },
      observed,
      sourceProfile: "message-anchors-v1",
      frame: chained,
    });
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "observed",
    });
    vi.mocked(h.port.observe).mockResolvedValue({
      state: "observed",
      originBinding: home,
      binding: home,
      correlation: { userTurnId: "user-new", replyId: "reply-new" },
      observed,
      sourceProfile: "message-anchors-v1",
      frame: {
        ...chained,
        messages: [
          { ...chained.messages[0]!, parentId: "reply-two" },
          chained.messages[1]!,
        ],
      },
    });
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "refused",
    });
  });
  it("prepares a settled route for a different target and a new document epoch", async () => {
    const h = harness(bound);
    const verify = { ...h.verify, binding: bound };
    vi.mocked(h.port.verifySend).mockResolvedValue({
      state: "witnessed",
      binding: bound,
      operationId: h.operation.operationId,
      evidenceId: "evidence-one",
      intentDigest: h.verify.intentDigest,
      previous: null,
      observed,
      sourceProfile: "message-anchors-v1",
      baselineUserIds: [],
    });
    const witness = await h.api.verifySend(verify, h.guard);
    if (witness.state !== "witnessed") throw new Error(witness.code);
    await h.api.send(
      {
        ...h.operation,
        witness: witness.witness,
        intentDigest: h.verify.intentDigest,
        prompt: "prompt",
      },
      h.guard,
    );
    await h.api.observe(h.operation, h.guard);
    const next = { ...home, documentGeneration: 3 };
    vi.mocked(h.port.load).mockImplementation(async () => {
      h.navigate(next);
    });
    const guard = vi.fn(
      (binding: PhysicalBinding) =>
        binding.viewId === "42" &&
        binding.viewGeneration === 1 &&
        binding.partition === home.partition &&
        (binding.documentGeneration === 2 || binding.documentGeneration === 3),
    );
    expect(
      await h.api.prepare(
        {
          operationId: "new-prepare",
          target: { kind: "new-saved" },
          deadlineMillis: 10_000,
        },
        guard,
      ),
    ).toMatchObject({ state: "prepared", binding: next });
    expect(h.port.load).toHaveBeenCalledOnce();
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "refused",
    });
  });
  it("refuses replacement view during a controlled Prepare navigation", async () => {
    const h = harness(bound);
    vi.mocked(h.port.load).mockImplementation(async () => {
      h.navigate(home);
      h.replace();
    });
    expect(
      await h.api.prepare(
        {
          operationId: "new-prepare",
          target: { kind: "new-saved" },
          deadlineMillis: 10_000,
        },
        h.guard,
      ),
    ).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_PREPARE_BINDING_LOST",
    });
  });

  it("keeps recovery bound when callers mutate an unknown Send fallback binding", async () => {
    const h = harness();
    vi.mocked(h.port.send).mockRejectedValue(new Error("ACK lost"));
    const result = await h.send();
    if (result.state !== "unknown" || !("binding" in result))
      throw new Error("missing unknown binding");
    Reflect.set(result.binding, "viewId", "99");
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "observed",
      originBinding: { viewId: "42" },
    });
    expect(await h.api.verifySend(h.verify, h.guard)).toMatchObject({
      state: "refused",
    });
    expect(h.port.send).toHaveBeenCalledOnce();
  });
  it("keeps an exact click ACK as submitted during the first same-document CID change", async () => {
    const h = harness();
    vi.mocked(h.port.send).mockImplementation(async (_s, request) => {
      h.navigate(bound);
      return {
        state: "submitted",
        binding: request.binding,
        operationId: request.operationId,
        evidenceId: request.witness.evidenceId,
        code: "PHYSICAL_SUBMITTED",
      };
    });
    expect(await h.send()).toMatchObject({ state: "submitted", binding: home });
    expect(await h.api.observe(h.operation, h.guard)).toMatchObject({
      state: "observed",
      originBinding: home,
      binding: bound,
    });
  });
  it("never promotes a real unknown Send during the first CID change", async () => {
    const h = harness();
    vi.mocked(h.port.send).mockImplementation(async (_s, request) => {
      h.navigate(bound);
      return {
        state: "unknown",
        binding: request.binding,
        operationId: request.operationId,
        evidenceId: request.witness.evidenceId,
        code: "PHYSICAL_ACK_LOST",
      };
    });
    expect(await h.send()).toMatchObject({ state: "unknown" });
  });
  it("does not retain a click ACK across document replacement", async () => {
    const h = harness();
    vi.mocked(h.port.send).mockImplementation(async (_s, request) => {
      h.navigate({ ...bound, documentGeneration: 3 });
      return {
        state: "submitted",
        binding: request.binding,
        operationId: request.operationId,
        evidenceId: request.witness.evidenceId,
        code: "PHYSICAL_SUBMITTED",
      };
    });
    expect(await h.send()).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_SEND_BINDING_LOST",
    });
  });
});
