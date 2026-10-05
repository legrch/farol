import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createGoChatResponses,
  extractGoChatRequestSelection,
  goChatRequestIntentSHA256,
  type GoChatRequest,
  type GoChatRequestSelection,
  type GoChatResponsesOptions,
} from "../../apps/desktop/go-chat-responses.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import type {
  ChatCreate,
  ChatHandle,
  ChatCallerBegin,
  ChatCallerHandle,
} from "../../apps/desktop/bridge/wire.ts";
import { canonicalJson } from "../../src/apps/desktop/codex-native-tool-registry.ts";

// Pure transport doubles only: no sockets, filesystem, subprocess, app or Go.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  writeHead = vi.fn(() => {
    this.headersSent = true;
    return this;
  });
  write = vi.fn((_bytes: string) => true);
  end = vi.fn(() => {
    this.writableEnded = true;
    queueMicrotask(() => this.emit("finish"));
    return this;
  });
  asResponse() {
    return this as unknown as ServerResponse;
  }
}
const handle: ChatHandle = {
  handleId: "handle",
  binding: {
    profileId: "profile",
    backendGeneration: "backend",
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    operationId: "operation",
    turnGeneration: "1",
  },
};
function target(
  selection: GoChatRequestSelection,
  resolvedEffort = selection.effort ?? "profile-default",
) {
  const resolved = {
    provider: "farol",
    alias: "chatgpt",
    accountId: "account",
    modelId: "configured-model",
    effort: resolvedEffort,
    mode: "standard",
    toolsEnabled: false,
    connectorId: "",
    connectorGrantId: "",
  };
  return {
    selection: resolved,
    resolution: {
      // The public route must not replace this independently configured alias.
      requestedAlias: "configured-small",
      requestedExecutor: "browser",
      requestedEffort: selection.effort ?? "",
      requestedMode: "",
      configSHA256: "a".repeat(64),
      translationId: "declared-route-translation",
      resolved,
    },
    required: { model: true, effort: true, mode: true, connector: false },
  } satisfies Pick<ChatCreate, "selection" | "resolution" | "required">;
}
function fixture(
  tool = false,
  resolver?: GoChatResponsesOptions["resolveCreate"],
) {
  const created = deferred<void>(),
    issued = deferred<void>(),
    outputAccepted = deferred<void>();
  const chat = {
    create: vi.fn(async (_input: ChatCreate) => {
      return handle;
    }),
    // Capacity refusal retains a pending owner handle without pumping/timers.
    prepare: vi.fn(async () => {
      created.resolve();
      throw new BridgeError("refused", "CHAT_CAPACITY");
    }),
    send: vi.fn(async () => ({})),
    observe: vi.fn(async () => ({})),
    events: vi.fn(async () => ({ frames: [] })),
    result: vi.fn<GoChatResponsesOptions["chat"]["result"]>(),
    cancel: vi.fn(async () => ({})),
  } satisfies GoChatResponsesOptions["chat"];
  let beginInput: ChatCallerBegin | undefined;
  const caller = {
    begin: vi.fn(async (input: ChatCallerBegin): Promise<ChatCallerHandle> => {
      beginInput = input;
      return {
        ticketId: "ticket",
        handleId: input.handleId,
        callId: input.call.callId,
        producerOperationId: input.producerOperationId,
        relayBinding: input.relayBinding,
        requestSHA256: input.requestSHA256,
      };
    }),
    claim: vi.fn(async () => ({})),
    issue: vi.fn(async (token: ChatCallerHandle) => ({
      issuanceId: "issuance",
      handle: token,
      firstSequence: "1",
      lastSequence: "1",
      data: "controlled caller bytes",
      dataSHA256: "a".repeat(64),
      dataBytes: "23",
    })),
    output: vi.fn<GoChatResponsesOptions["caller"]["output"]>(async (input) => {
      outputAccepted.resolve();
      return {
        output: "accepted",
        receipt: {
          receiptId: "receipt",
          handle: input.handle,
          outputSHA256: "a".repeat(64),
          outputBytes: "8",
        },
      };
    }),
    returned: vi.fn(async () => ({})),
  } satisfies GoChatResponsesOptions["caller"];
  type OpenInput = Parameters<
    NonNullable<GoChatResponsesOptions["relay"]>["openTurn"]
  >[0];
  let invokeOwned: OpenInput["invokeOwned"];
  const relay = {
    openTurn: vi.fn((input: OpenInput) => {
      invokeOwned = input.invokeOwned;
      return {
        ticket: "relay-ticket",
        binding: "b".repeat(64),
        inventory: [],
        close: vi.fn(),
      };
    }),
  };
  const resolveCreate = vi.fn<GoChatResponsesOptions["resolveCreate"]>(
    resolver ?? ((input) => target(input.requestSelection)),
  );
  const transport = createGoChatResponses({
    chat,
    caller,
    relay,
    resolveCreate,
  });
  const admit = vi.fn(async () => true),
    prepareInitial = vi.fn(async () => ({ prompt: "question", admit }));
  const serve = (request: GoChatRequest, response = new Response()) => ({
    response,
    done: transport
      .serve({
        key: "original-key",
        identity: {
          sessionId: "session",
          threadId: "thread",
          turnId: "turn",
          rootTurnId: "root",
        },
        request,
        response: response.asResponse(),
        prepareInitial,
        onToolCall: () => issued.resolve(),
      })
      .catch((error: unknown) => error),
  });
  const request = (reasoning?: unknown): GoChatRequest => ({
    model: "chatgpt",
    input: "question",
    tools: tool ? [{ type: "function", name: "shell" }] : [],
    ...(reasoning === undefined ? {} : { reasoning }),
  });
  const invoke = () => {
    if (!invokeOwned) throw new Error("missing controlled relay");
    return invokeOwned(
      { name: "shell", namespace: null, arguments: {}, encodedArguments: "{}" },
      {
        operationId: "producer",
        binding: "b".repeat(64),
        requestSHA256: "c".repeat(64),
      },
    );
  };
  const continuation = (reasoning?: unknown): GoChatRequest => {
    const call = beginInput!.call;
    return {
      ...request(reasoning),
      input: [
        {
          type: "function_call",
          id: call.itemId,
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments,
        },
        {
          type: "function_call_output",
          call_id: call.callId,
          output: "controlled output",
        },
      ],
    };
  };
  return {
    chat,
    caller,
    relay,
    resolveCreate,
    transport,
    admit,
    prepareInitial,
    serve,
    request,
    invoke,
    continuation,
    created: created.promise,
    issued: issued.promise,
    outputAccepted: outputAccepted.promise,
  };
}

describe("Go Responses scalar request selection", () => {
  for (const [reasoning, expected, resolved] of [
    [undefined, { model: "chatgpt" }, "configured-default"],
    [{}, { model: "chatgpt" }, "profile-default"],
    [{ effort: "high" }, { model: "chatgpt", effort: "high" }, "high"],
    [{ effort: "Ultra" }, { model: "chatgpt", effort: "Ultra" }, "route-max"],
    [
      { effort: "A".repeat(40) },
      { model: "chatgpt", effort: "A".repeat(40) },
      "route-boundary",
    ],
  ] as const) {
    it(`preserves ${JSON.stringify(reasoning)} through the resolver and Create`, async () => {
      const f = fixture(false, (input) =>
        target(input.requestSelection, resolved),
      );
      const initial = f.serve(f.request(reasoning));
      try {
        await f.created;
        const capture = f.resolveCreate.mock.calls[0]![0].requestSelection;
        expect(capture).toEqual(expected);
        expect(Object.isFrozen(capture)).toBe(true);
        expect(Object.hasOwn(capture, "effort")).toBe(
          Object.hasOwn(expected, "effort"),
        );
        const create = f.chat.create.mock.calls[0]![0];
        expect(create.resolution.requestedEffort).toBe(capture.effort ?? "");
        expect(create.resolution.requestedAlias).toBe("configured-small");
        expect(create.selection.effort).toBe(resolved);
        expect(f.admit).toHaveBeenCalledTimes(1);
      } finally {
        await f.transport.close();
        await initial.done;
      }
    });
  }
  for (const reasoning of [
    undefined,
    null,
    "high",
    [],
    false,
    { effort: "" },
    { effort: null },
    { effort: undefined },
    { effort: 3 },
    { effort: {} },
    { effort: "a".repeat(41) },
    { effort: "high\n" },
    { effort: " hi" },
    { effort: "é" },
    { summary: "auto" },
    { effort: "high", summary: "auto" },
    { future: true },
  ]) {
    it(`refuses malformed/unsupported reasoning ${JSON.stringify(reasoning)} before preparation/effects`, async () => {
      const f = fixture(true);
      const initial = f.serve({ ...f.request(), reasoning });
      expect(await initial.done).toBeInstanceOf(Error);
      expect(f.prepareInitial).not.toHaveBeenCalled();
      expect(f.resolveCreate).not.toHaveBeenCalled();
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.chat.create).not.toHaveBeenCalled();
      expect(f.chat.prepare).not.toHaveBeenCalled();
      expect(f.relay.openTurn).not.toHaveBeenCalled();
      expect(initial.response.write).not.toHaveBeenCalled();
      await f.transport.close();
    });
  }
  for (const model of ["configured-small", "foreign", "ChatGPT"]) {
    it(`refuses public route ${model} before preparation`, async () => {
      const f = fixture();
      expect(await f.serve({ ...f.request(), model }).done).toEqual(
        new Error("FAROL_NEXT_MODEL_UNAVAILABLE"),
      );
      expect(f.prepareInitial).not.toHaveBeenCalled();
      await f.transport.close();
    });
  }
  for (const [reasoning, reported] of [
    [undefined, "low"],
    [{ effort: "high" }, ""],
    [{ effort: "high" }, "HIGH"],
  ] as const) {
    it(`rejects resolver requested-effort mismatch ${reported} before admission/Create`, async () => {
      const f = fixture(false, (input) => {
        const value = target(input.requestSelection);
        value.resolution.requestedEffort = reported;
        return value;
      });
      expect(await f.serve(f.request(reasoning)).done).toEqual(
        new Error("FAROL_NEXT_GO_SELECTION_CONFLICT"),
      );
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.chat.create).not.toHaveBeenCalled();
      await f.transport.close();
    });
  }
  for (const change of ["provider", "alias", "resolved"] as const) {
    it(`rejects crossed resolved ${change} before admission/Create`, async () => {
      const f = fixture(false, (input) => {
        const value = target(input.requestSelection);
        if (change === "resolved")
          value.resolution.resolved = { ...value.selection, effort: "other" };
        else value.selection[change] = "foreign";
        return value;
      });
      expect(await f.serve(f.request()).done).toEqual(
        new Error("FAROL_NEXT_GO_SELECTION_CONFLICT"),
      );
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.chat.create).not.toHaveBeenCalled();
      await f.transport.close();
    });
  }
  it("detaches and freezes request selection before an async resolver", async () => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const f = fixture(false, async (input) => {
      entered.resolve();
      await release.promise;
      expect(input.requestSelection).toEqual({
        model: "chatgpt",
        effort: "high",
      });
      expect(() =>
        Object.assign(input.requestSelection, { effort: "low" }),
      ).toThrow(TypeError);
      return target(input.requestSelection);
    });
    const reasoning = { effort: "high" };
    const request = { ...f.request(reasoning) };
    const initial = f.serve(request);
    try {
      await entered.promise;
      reasoning.effort = "low";
      request.model = "foreign";
      release.resolve();
      await f.created;
      expect(f.chat.create.mock.calls[0]![0].resolution.requestedEffort).toBe(
        "high",
      );
    } finally {
      release.resolve();
      await f.transport.close();
      await initial.done;
    }
  });
});

describe("same-key tool continuation selection", () => {
  for (const [original, next] of [
    [undefined, { effort: "high" }],
    [{ effort: "high" }, undefined],
    [{ effort: "high" }, { effort: "low" }],
    [{ effort: "Ultra" }, { effort: "ultra" }],
  ] as const) {
    it(`refuses ${JSON.stringify(original)} -> ${JSON.stringify(next)} without output/claim/effects`, async () => {
      const f = fixture(true);
      const initial = f.serve(f.request(original));
      await f.created;
      const invoked = f.invoke().catch((error: unknown) => error);
      try {
        await f.issued;
        await initial.done;
        const counts = [
          f.chat.create,
          f.chat.prepare,
          f.chat.send,
          f.chat.events,
          f.chat.cancel,
          f.caller.begin,
          f.caller.claim,
          f.caller.issue,
          f.caller.output,
          f.caller.returned,
          f.relay.openTurn,
        ].map((fn) => fn.mock.calls.length);
        const response = new Response();
        expect(await f.serve(f.continuation(next), response).done).toEqual(
          new Error("FAROL_NEXT_CONTINUATION_SELECTION_CONFLICT"),
        );
        expect(
          [
            f.chat.create,
            f.chat.prepare,
            f.chat.send,
            f.chat.events,
            f.chat.cancel,
            f.caller.begin,
            f.caller.claim,
            f.caller.issue,
            f.caller.output,
            f.caller.returned,
            f.relay.openTurn,
          ].map((fn) => fn.mock.calls.length),
        ).toEqual(counts);
        expect(response.write).not.toHaveBeenCalled();
        expect(response.writeHead).not.toHaveBeenCalled();
        // The rejected crossing does not consume the original output claim.
        const correct = f.serve(f.continuation(original));
        await f.outputAccepted;
        expect(f.caller.output).toHaveBeenCalledTimes(1);
        await f.transport.close();
        await correct.done;
      } finally {
        await f.transport.close();
        await invoked;
        await initial.done;
      }
    });
  }
});

describe("external immutable intent digest", () => {
  it("keeps omission bytes compatible and separates exact explicit effort", () => {
    const request = { model: "chatgpt", input: "question", tools: [] };
    const omission = extractGoChatRequestSelection(request);
    const original = createHash("sha256")
      .update(canonicalJson(request))
      .digest("hex");
    expect(goChatRequestIntentSHA256(request, omission)).toBe(original);
    expect(
      goChatRequestIntentSHA256(
        request,
        extractGoChatRequestSelection({ ...request, reasoning: {} }),
      ),
    ).toBe(original);
    const efforts = ["high", "low", "HIGH", "Ultra", "ultra"];
    const hashes = efforts.map((effort) =>
      goChatRequestIntentSHA256(
        request,
        extractGoChatRequestSelection({ ...request, reasoning: { effort } }),
      ),
    );
    expect(new Set([original, ...hashes]).size).toBe(6);
    expect(hashes[0]).toBe(
      createHash("sha256")
        .update(canonicalJson({ ...request, effort: "high" }))
        .digest("hex"),
    );
  });
  it("refuses original unknown keys and changed effort across adapter lifetimes", async () => {
    const journal = new Map<string, string>();
    const admissions: string[] = [];
    for (const effort of [undefined, undefined, "high", "low"]) {
      const f = fixture();
      const request = f.request(effort === undefined ? undefined : { effort });
      const intent = goChatRequestIntentSHA256(
        request,
        extractGoChatRequestSelection(request),
      );
      f.admit.mockImplementation(async () => {
        const old = journal.get("original-key");
        admissions.push(
          old === undefined
            ? "admitted"
            : old === intent
              ? "replayed"
              : "conflict",
        );
        if (old !== undefined) return false;
        journal.set("original-key", intent);
        return true;
      });
      f.chat.create.mockRejectedValue(
        new Error("controlled lost Create reply"),
      );
      await f.serve(request).done;
      expect(f.chat.create).toHaveBeenCalledTimes(
        journal.size === 1 && admissions.length === 1 ? 1 : 0,
      );
      expect(f.chat.send).not.toHaveBeenCalled();
      await f.transport.close();
    }
    expect(admissions).toEqual([
      "admitted",
      "replayed",
      "conflict",
      "conflict",
    ]);
  });
});
