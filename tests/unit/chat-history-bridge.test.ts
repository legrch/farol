import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryBridge } from "../../apps/desktop/bridge/chat-history.ts";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client.ts";
import {
  requiresOperationID,
  validate,
  type BrowserSelection,
  type ChatHistoryPage,
  type ChatHistoryResult,
  type ChatHistorySummary,
  type ChatTurnBinding,
  type Json,
  type Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// CPU-only fake Client. These tests prove no Go authority, retained disk bytes,
// application lifecycle, native process, network or live-provider behavior.
type Mutable<T> = {
  -readonly [P in keyof T]: T[P] extends readonly (infer U)[]
    ? Mutable<U>[]
    : T[P] extends object
      ? Mutable<T[P]>
      : T[P];
};
const current = { profileId: "profile", backendGeneration: "current-backend" };
const binding: ChatTurnBinding = {
  profileId: current.profileId,
  backendGeneration: "original-backend",
  ownerId: "original-owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "9007199254740993",
  participantId: "participant",
  turnId: "turn",
  operationId: "original-operation",
  turnGeneration: "18446744073709551615",
};
const summary: ChatHistorySummary = {
  key: {
    backendGeneration: binding.backendGeneration,
    operationId: binding.operationId,
  },
  binding,
  resultId: "retained-result",
  conversationId: "saved-conversation",
};
const selection: BrowserSelection = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "account",
  modelId: "model",
  effort: "high",
  mode: "ordinary",
  connectorId: "",
  connectorGrantId: "",
  toolsEnabled: false,
};
function retained(): ChatHistoryResult {
  return structuredClone({
    ...summary,
    userTurnId: "user-turn",
    replyId: "reply",
    evidence: {
      requested: selection,
      resolution: {
        requestedAlias: "chatgpt",
        requestedExecutor: "chatgpt",
        requestedEffort: "high",
        requestedMode: "ordinary",
        configSHA256: "a".repeat(64),
        translationId: "translation",
        resolved: selection,
      },
      resolutionSource: "configuration",
      admissionSource: "not-observed",
      observationSource: "not-observed",
      evidenceId: "evidence",
      pinnedSource: "original-selection",
    },
    phase: "delivered",
    outcome: "completed",
    code: "CHAT_COMPLETED",
    text: "Retained answer",
    complete: true,
    acknowledged: true,
  });
}
function page(offset = 0, total = 1): ChatHistoryPage {
  return {
    offset,
    total,
    entries: Array.from(
      { length: Math.min(32, Math.max(0, total - offset)) },
      (_, index) => {
        const selected = structuredClone(
          summary,
        ) as Mutable<ChatHistorySummary>;
        const operation = `original-operation-${offset + index}`;
        selected.key.operationId = selected.binding.operationId = operation;
        return selected;
      },
    ),
  };
}
function envelope(data: unknown, requestId: string): Outcome {
  return {
    status: "ok",
    requestId,
    context: { ...current },
    data: data as Json,
  };
}
function fixture(
  data: unknown = page(),
  change: (outcome: Outcome) => unknown = (outcome) => outcome,
) {
  const peer = { current: { ...current }, error: undefined as unknown };
  const request = vi.fn<Client["request"]>(
    async (_method, _body, options = {}) =>
      change(envelope(structuredClone(data), options.id!)) as Outcome,
  );
  const client = {
    request,
    get verifiedContext() {
      if (peer.error !== undefined) throw peer.error;
      return peer.current;
    },
  } as unknown as Client;
  return { bridge: new ChatHistoryBridge(client), request, peer };
}
function crossedPage(change: (value: Mutable<ChatHistoryPage>) => void) {
  const data = structuredClone(page()) as Mutable<ChatHistoryPage>;
  change(data);
  return fixture(data);
}
function crossedResult(change: (value: Mutable<ChatHistoryResult>) => void) {
  const data = structuredClone(retained()) as Mutable<ChatHistoryResult>;
  change(data);
  return fixture(data);
}
afterEach(() => vi.useRealTimers());

describe("Read-only Chat history host bridge", () => {
  it("dispatches only history reads with fresh request IDs and no operationId", async () => {
    const f = fixture();
    await f.bridge.list();
    await f.bridge.list();
    f.request.mockImplementationOnce(async (_method, _body, options = {}) =>
      envelope(retained(), options.id!),
    );
    expect(await f.bridge.result(summary)).toEqual(retained());
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "chat.history.list",
      "chat.history.list",
      "chat.history.result",
    ]);
    const ids = f.request.mock.calls.map(([method, body, options]) => {
      expect(requiresOperationID(method)).toBe(false);
      expect(options).not.toHaveProperty("operationId");
      expect(options?.timeoutMs).toBe(16000);
      expect(validate("id", options?.id)).toBe(true);
      expect(body).toEqual(
        method.endsWith(".list") ? { offset: 0 } : summary.key,
      );
      expect(Object.isFrozen(body)).toBe(true);
      expect(Object.isFrozen(options)).toBe(true);
      return options?.id;
    });
    expect(new Set(ids).size).toBe(3);
  });

  it("uses the canonical generated shapes", () => {
    expect(validate("ChatHistoryKey", summary.key)).toBe(true);
    expect(validate("ChatHistorySummary", summary)).toBe(true);
    expect(validate("ChatHistoryPage", page())).toBe(true);
    expect(validate("ChatHistoryResult", retained())).toBe(true);
  });

  it.each([
    [0, 0],
    [0, 1],
    [0, 32],
    [0, 33],
    [0, 1024],
    [32, 33],
    [32, 64],
    [32, 65],
    [33, 33],
    [1024, 1024],
  ])(
    "returns the exact bounded page at offset %i of %i",
    async (offset, total) => {
      const expected = page(offset, total);
      const f = fixture(expected);
      expect(await f.bridge.list(offset)).toEqual(expected);
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.request.mock.calls[0]![1]).toEqual({ offset });
    },
  );

  it.each([-1, 0.5, 1025, NaN, Infinity])(
    "refuses invalid offset %s before dispatch",
    async (offset) => {
      const f = fixture();
      await expect(f.bridge.list(offset)).rejects.toMatchObject({
        state: "refused",
        code: "chat_history_request_invalid",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    "offset",
    "total",
    "short",
    "long",
    "oversized",
    "fraction",
    "extra",
  ])("rejects a malformed page: %s", async (field) => {
    const f = crossedPage((value) => {
      if (field === "offset") value.offset = 1;
      if (field === "total") value.total = 0;
      if (field === "short") value.entries = [];
      if (field === "long") value.total = 2;
      if (field === "oversized") value.total = 1025;
      if (field === "fraction") value.offset = 0.5;
      if (field === "extra") Object.assign(value, { handleId: "forged" });
    });
    await expect(f.bridge.list()).rejects.toMatchObject({ state: "unknown" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("rejects offset beyond total even with an empty page", async () => {
    const f = fixture({ offset: 2, total: 1, entries: [] });
    await expect(f.bridge.list(2)).rejects.toMatchObject({
      state: "unknown",
      code: "chat_history_page_invalid",
    });
  });

  it("rejects more than 32 entries and duplicates in a correctly sized page", async () => {
    for (const data of [
      {
        offset: 0,
        total: 33,
        entries: Array.from({ length: 33 }, () => summary),
      },
      { offset: 0, total: 2, entries: [summary, structuredClone(summary)] },
    ]) {
      const f = fixture(data);
      await expect(f.bridge.list()).rejects.toMatchObject({ state: "unknown" });
      expect(f.request).toHaveBeenCalledTimes(1);
    }
  });

  it("qualifies duplicate keys as a pair rather than by operationId alone", async () => {
    const other = structuredClone(summary) as Mutable<ChatHistorySummary>;
    other.key.backendGeneration = other.binding.backendGeneration =
      "older-backend";
    const expected = { offset: 0, total: 2, entries: [summary, other] };
    expect(await fixture(expected).bridge.list()).toEqual(expected);
  });

  it("rejects sparse entries from an unknown fake response", async () => {
    const data = page() as Mutable<ChatHistoryPage>;
    delete data.entries[0];
    const f = fixture(data);
    await expect(f.bridge.list()).rejects.toMatchObject({
      state: "unknown",
      code: "chat_history_response_invalid",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    "key-operation",
    "key-backend",
    "profile",
    "live-backend",
    "malformed",
  ])("rejects an invalid original reference in a page: %s", async (field) => {
    const f = crossedPage((value) => {
      const selected = value.entries[0]!;
      if (field === "key-operation") selected.key.operationId = "crossed";
      if (field === "key-backend") selected.key.backendGeneration = "crossed";
      if (field === "profile") selected.binding.profileId = "other-profile";
      if (field === "live-backend")
        selected.key.backendGeneration = selected.binding.backendGeneration =
          current.backendGeneration;
      if (field === "malformed") selected.resultId = "";
    });
    await expect(f.bridge.list()).rejects.toMatchObject({ state: "unknown" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    "shape",
    "extra",
    "key-operation",
    "key-backend",
    "profile",
    "live-backend",
  ])(
    "validates the selected summary before result dispatch: %s",
    async (field) => {
      const selected = structuredClone(summary) as Mutable<ChatHistorySummary>;
      if (field === "shape") selected.resultId = "";
      if (field === "extra") Object.assign(selected, { ownerAuthority: true });
      if (field === "key-operation") selected.key.operationId = "crossed";
      if (field === "key-backend") selected.key.backendGeneration = "crossed";
      if (field === "profile") selected.binding.profileId = "other-profile";
      if (field === "live-backend")
        selected.key.backendGeneration = selected.binding.backendGeneration =
          current.backendGeneration;
      const f = fixture(retained());
      await expect(f.bridge.result(selected)).rejects.toMatchObject({
        state: "refused",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["list", "result"] as const)(
    "validates the current context before %s dispatch",
    async (method) => {
      const f = fixture(method === "list" ? page() : retained());
      f.peer.current.profileId = "";
      await expect(
        method === "list" ? f.bridge.list() : f.bridge.result(summary),
      ).rejects.toMatchObject({
        state: "refused",
        code: "chat_history_context_invalid",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["list", "result"] as const)(
    "preserves an unavailable context before %s dispatch",
    async (method) => {
      const f = fixture();
      const original = new BridgeError("unavailable", "handshake_required");
      f.peer.error = original;
      await expect(
        method === "list" ? f.bridge.list() : f.bridge.result(summary),
      ).rejects.toBe(original);
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    "key-operation",
    "key-backend",
    "resultId",
    "conversationId",
    "profileId",
    "backendGeneration",
    "ownerId",
    "sessionId",
    "taskId",
    "taskEpoch",
    "participantId",
    "turnId",
    "operationId",
    "turnGeneration",
  ])(
    "correlates the returned result with the exact selected %s",
    async (field) => {
      const f = crossedResult((value) => {
        if (field === "key-operation") value.key.operationId = "other";
        else if (field === "key-backend") value.key.backendGeneration = "other";
        else if (field === "resultId") value.resultId = "other";
        else if (field === "conversationId") value.conversationId = "other";
        else
          Object.assign(value.binding, {
            [field]:
              field === "taskEpoch" || field === "turnGeneration"
                ? "2"
                : "other",
          });
      });
      await expect(f.bridge.result(summary)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_history_selection_crossed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["phase", "outcome", "complete", "acknowledged"])(
    "requires terminal delivery and acknowledgement: %s",
    async (field) => {
      const f = crossedResult((value) => {
        if (field === "phase") value.phase = "completed";
        if (field === "outcome") value.outcome = "unknown";
        if (field === "complete") value.complete = false;
        if (field === "acknowledged") value.acknowledged = false;
      });
      await expect(f.bridge.result(summary)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_history_result_unsettled",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts a terminal retained result with empty useful text and provider IDs", async () => {
    const f = crossedResult((value) => {
      value.text = value.conversationId = value.userTurnId = value.replyId = "";
    });
    expect(
      await f.bridge.result({ ...summary, conversationId: "" }),
    ).toMatchObject({
      text: "",
      complete: true,
      acknowledged: true,
      userTurnId: "",
      replyId: "",
    });
  });

  it.each(["list", "result"] as const)(
    "checks the %s response request and context identity",
    async (method) => {
      for (const field of [
        "requestId",
        "operationId",
        "profileId",
        "backendGeneration",
      ]) {
        const f = fixture(method === "list" ? page() : retained(), (outcome) =>
          field === "profileId" || field === "backendGeneration"
            ? { ...outcome, context: { ...outcome.context, [field]: "other" } }
            : { ...outcome, [field]: "other" },
        );
        await expect(
          method === "list" ? f.bridge.list() : f.bridge.result(summary),
        ).rejects.toMatchObject({
          state: "unknown",
          code: "chat_history_response_context",
        });
        expect(f.request).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["list", "result"] as const)(
    "validates unknown %s responses without fallback",
    async (method) => {
      for (const bad of [
        null,
        [],
        {},
        { status: "ok" },
        { status: "success" },
      ]) {
        const f = fixture(undefined, () => bad);
        await expect(
          method === "list" ? f.bridge.list() : f.bridge.result(summary),
        ).rejects.toMatchObject({
          state: "unknown",
          code: "chat_history_response_invalid",
        });
        expect(f.request).toHaveBeenCalledTimes(1);
      }
      for (const bad of [null, [], {}, { extra: true }]) {
        const f = fixture(bad);
        await expect(
          method === "list" ? f.bridge.list() : f.bridge.result(summary),
        ).rejects.toMatchObject({
          state: "unknown",
          code: "chat_history_response_invalid",
        });
      }
    },
  );

  it("rejects malformed retained text, evidence and terminal field types", async () => {
    for (const change of [
      (value: Mutable<ChatHistoryResult>) => {
        value.text = "x".repeat(8193);
      },
      (value: Mutable<ChatHistoryResult>) => {
        value.evidence.evidenceId = "";
      },
      (value: Mutable<ChatHistoryResult>) => {
        Object.assign(value, { complete: "true" });
      },
      (value: Mutable<ChatHistoryResult>) => {
        Object.assign(value, { handleId: "forged" });
      },
    ]) {
      const f = crossedResult(change);
      await expect(f.bridge.result(summary)).rejects.toMatchObject({
        state: "unknown",
        code: "chat_history_response_invalid",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["list", "result"] as const)(
    "captures and rechecks the incarnation around %s await",
    async (method) => {
      for (const field of [
        "profileId",
        "backendGeneration",
        "missing",
        "malformed",
        "replacement",
      ]) {
        const f = fixture();
        let release!: (outcome: Outcome) => void;
        f.request.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        );
        const work =
          method === "list" ? f.bridge.list() : f.bridge.result(summary);
        if (field === "profileId") f.peer.current.profileId = "other";
        if (field === "backendGeneration")
          f.peer.current.backendGeneration = "successor";
        if (field === "missing")
          f.peer.error = new BridgeError("unavailable", "backend_unavailable");
        if (field === "malformed") f.peer.current.profileId = "";
        if (field === "replacement")
          f.peer.current = { ...current, backendGeneration: "successor" };
        release(
          envelope(
            method === "list" ? page() : retained(),
            f.request.mock.calls[0]![2]!.id!,
          ),
        );
        await expect(work).rejects.toMatchObject({
          state: "unknown",
          code: "chat_history_peer_changed",
        });
        expect(f.request).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["list", "result"] as const)(
    "rejects a late %s reply even if the transport resolves",
    async (method) => {
      vi.useFakeTimers();
      const f = fixture();
      let release!: (outcome: Outcome) => void;
      f.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const work =
        method === "list" ? f.bridge.list() : f.bridge.result(summary);
      vi.setSystemTime(Date.now() + 16000);
      release(
        envelope(
          method === "list" ? page() : retained(),
          f.request.mock.calls[0]![2]!.id!,
        ),
      );
      await expect(work).rejects.toMatchObject({
        state: "unknown",
        code: "chat_history_response_late",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["list", "result"] as const)(
    "rechecks the peer after the outer %s await as well",
    async (method) => {
      const f = fixture();
      f.request.mockImplementationOnce(async (_method, _body, options = {}) => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            f.peer.current.backendGeneration = "successor";
          });
        });
        return envelope(method === "list" ? page() : retained(), options.id!);
      });
      await expect(
        method === "list" ? f.bridge.list() : f.bridge.result(summary),
      ).rejects.toMatchObject({
        state: "unknown",
        code: "chat_history_peer_changed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["list", "result"] as const)(
    "preserves truthful %s request failures without retry",
    async (method) => {
      for (const state of [
        "unavailable",
        "unsupported",
        "refused",
        "unknown",
      ] as const) {
        const original = new BridgeError(state, "original-request-failure");
        const f = fixture();
        f.request.mockRejectedValueOnce(original);
        await expect(
          method === "list" ? f.bridge.list() : f.bridge.result(summary),
        ).rejects.toBe(original);
        expect(f.request).toHaveBeenCalledTimes(1);
        const g = fixture(undefined, (outcome) => ({
          status: state,
          requestId: outcome.requestId,
          context: outcome.context,
          code: "CHAT_HISTORY_OWNER_REFUSED",
        }));
        await expect(
          method === "list" ? g.bridge.list() : g.bridge.result(summary),
        ).rejects.toMatchObject({ state, code: "CHAT_HISTORY_OWNER_REFUSED" });
        expect(g.request).toHaveBeenCalledTimes(1);
      }
      const f = fixture();
      const original = new Error("synchronous transport failure");
      f.request.mockImplementationOnce(() => {
        throw original;
      });
      await expect(
        method === "list" ? f.bridge.list() : f.bridge.result(summary),
      ).rejects.toBe(original);
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an immutable selected summary and request when the caller mutates during await", async () => {
    const selected = structuredClone(summary) as Mutable<ChatHistorySummary>;
    const f = fixture();
    let release!: (outcome: Outcome) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const work = f.bridge.result(selected);
    selected.key.operationId = "caller-change";
    selected.binding.taskId = "caller-change";
    selected.resultId = selected.conversationId = "caller-change";
    const [, body, options] = f.request.mock.calls[0]!;
    expect(body).toEqual(summary.key);
    expect(body).not.toBe(selected.key);
    expect(Reflect.set(body as object, "operationId", "transport-change")).toBe(
      false,
    );
    release(envelope(retained(), options!.id!));
    expect(await work).toEqual(retained());
  });

  it("cannot change the frozen list request or result options after dispatch", async () => {
    const f = fixture();
    let release!: (outcome: Outcome) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const work = f.bridge.list(32);
    const [, body, options] = f.request.mock.calls[0]!;
    expect(Reflect.set(body as object, "offset", 0)).toBe(false);
    expect(Reflect.set(options!, "id", "crossed")).toBe(false);
    release(envelope(page(32, 33), options!.id!));
    expect(await work).toEqual(page(32, 33));
  });

  it("rejects forged result selection even when transport tries to replace its key", async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async (_method, body, options = {}) => {
      expect(Reflect.set(body as object, "operationId", "forged")).toBe(false);
      const crossed = retained() as Mutable<ChatHistoryResult>;
      crossed.key.operationId = crossed.binding.operationId = "forged";
      return envelope(crossed, options.id!);
    });
    await expect(f.bridge.result(summary)).rejects.toMatchObject({
      state: "unknown",
      code: "chat_history_selection_crossed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("returns independent deeply frozen output copies", async () => {
    const rawPage = page() as Mutable<ChatHistoryPage>;
    const f = fixture();
    f.request.mockImplementationOnce(async (_method, _body, options = {}) =>
      envelope(rawPage, options.id!),
    );
    const listed = await f.bridge.list();
    rawPage.entries[0]!.binding.taskId = "raw-change";
    expect(listed.entries[0]!.binding.taskId).toBe(binding.taskId);
    expect(Object.isFrozen(listed.entries)).toBe(true);
    expect(Object.isFrozen(listed.entries[0]!.binding)).toBe(true);
    const rawResult = retained() as Mutable<ChatHistoryResult>;
    f.request.mockImplementationOnce(async (_method, _body, options = {}) =>
      envelope(rawResult, options.id!),
    );
    const result = await f.bridge.result(summary);
    rawResult.evidence.resolution.resolved.modelId = "raw-change";
    expect(result.evidence.resolution.resolved.modelId).toBe(selection.modelId);
    expect(Object.isFrozen(result.key)).toBe(true);
    expect(Object.isFrozen(result.evidence.resolution.resolved)).toBe(true);
  });
});
