import { startGoChatResponsesFixture } from "./fixtures/go-chat-responses-process.ts";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoChatResponses,
  type GoChatResponsesOptions,
} from "../../apps/desktop/go-chat-responses.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import type {
  ChatCreate,
  ChatFrame,
  ChatHandle,
  ChatResult,
  ChatCallerBegin,
  ChatCallerHandle,
  ChatCallerAccept,
} from "../../apps/desktop/bridge/wire.ts";
import { startRouteBRuntime } from "../../src/apps/desktop/route-b-runtime.ts";
import {
  PrivateProviderTurnJournal,
  type ProviderTurnJournal,
} from "../../src/apps/desktop/provider-turn-journal.ts";
import type { CodexChatGptCompaction } from "../../src/apps/desktop/codex-chatgpt-provider.ts";
import { startCodexCallerRelay } from "../../src/apps/desktop/codex-caller-relay.ts";
import { CodexCallerRelayClient } from "../../apps/desktop/computer-mcp/codex-caller-relay-client.ts";

// Real provider HTTP, durable admission and private relay/client. The facade
// below is an in-memory transport peer, not Go/native/provider qualification.
// Lead's real-Go process fixture supplies the independent cross-language proof.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
const selection = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "account",
  modelId: "model",
  effort: "high",
  mode: "chat",
  connectorId: "connector",
  connectorGrantId: "grant",
  toolsEnabled: true,
};
const target: Pick<ChatCreate, "selection" | "resolution" | "required"> = {
  selection,
  resolution: {
    requestedAlias: "chatgpt",
    requestedExecutor: "chatgpt-web",
    requestedEffort: "",
    requestedMode: "chat",
    configSHA256: "a".repeat(64),
    translationId: "controlled-transport-fixture",
    resolved: selection,
  },
  required: { model: true, effort: true, mode: true, connector: true },
};
const tool = {
  type: "function",
  name: "shell",
  description: "Fixture tool",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
};
function body(
  thread = "thread",
  turn = "turn",
  input: unknown = "Say hello.",
  tools: unknown[] = [],
) {
  return {
    model: "chatgpt",
    stream: true,
    store: false,
    input,
    tools,
    client_metadata: {
      session_id: "session",
      thread_id: thread,
      turn_id: turn,
      root_turn_id: turn,
    },
  };
}
function parse(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
function peer(scenario: "text" | "tool" | "lost-send" = "text") {
  const states = new Map<
    string,
    {
      handle: ChatHandle;
      frames: ChatFrame[];
      observations: number;
      terminal: boolean;
      unknown: boolean;
    }
  >();
  let next = 0;
  let preparations = 0;
  let beginInput: ChatCallerBegin | undefined;
  let callerToken: ChatCallerHandle | undefined;
  let returned = false;
  const frame = (
    id: string,
    kind: string,
    data: Record<string, unknown> = {},
  ) => {
    const state = states.get(id)!;
    const sequence = String(state.frames.length + 1);
    state.frames.push({
      sequence,
      kind,
      data: { type: kind, sequence_number: Number(sequence), ...data },
    });
  };
  const result = (id: string): ChatResult => {
    const s = states.get(id)!;
    return {
      handle: s.handle,
      conversationId: `conversation-${id}`,
      userTurnId: "user",
      replyId: "reply",
      resultId: "result",
      evidence: {
        requested: selection,
        resolution: target.resolution,
        resolutionSource: "controlled",
        admitted: selection,
        admissionSource: "controlled",
        observationSource: "controlled",
        evidenceId: "evidence",
        pinnedSource: "controlled",
      },
      phase: s.unknown ? "unknown" : s.terminal ? "result-ready" : "running",
      outcome: s.unknown ? "unknown" : s.terminal ? "completed" : "",
      code: s.unknown ? "CHAT_SEND_UNKNOWN" : "",
      text: "",
      complete: s.terminal && !s.unknown,
      acknowledged: false,
    };
  };
  const chat = {
    create: vi.fn(async (input: ChatCreate) => {
      const handle: ChatHandle = {
        handleId: `handle-${++next}`,
        binding: {
          profileId: "profile",
          backendGeneration: "backend",
          ownerId: "owner",
          sessionId: input.sessionId,
          taskId: `task-${next}`,
          taskEpoch: "1",
          participantId: "participant",
          turnId: `turn-${next}`,
          operationId: `operation-${next}`,
          turnGeneration: "1",
        },
      };
      states.set(handle.handleId, {
        handle,
        frames: [],
        observations: 0,
        terminal: false,
        unknown: false,
      });
      frame(handle.handleId, "response.created", {
        response: { id: "response", status: "in_progress" },
      });
      return handle;
    }),
    prepare: vi.fn(async (_deadline: string) => {
      const handle = [...states.values()][preparations++]!.handle;
      return {
        handle,
        slotOrdinal: 1,
        slotGeneration: "1",
        viewId: "view",
        viewGeneration: "1",
        documentGeneration: "1",
        conversationId: "",
        providerState: "home" as const,
      };
    }),
    send: vi.fn(async (id: string, _deadline: string) => {
      if (scenario === "lost-send") {
        states.get(id)!.unknown = true;
        frame(id, "response.failed", {
          response: { status: "failed", error: { code: "CHAT_SEND_UNKNOWN" } },
        });
      }
      return {};
    }),
    observe: vi.fn(async (id: string, _deadline: string) => {
      const s = states.get(id)!;
      s.observations++;
      if (s.observations === 1) {
        frame(id, "response.output_item.added", {
          item: { type: "message", id: "message" },
        });
        frame(id, "response.content_part.added", {
          part: { type: "output_text", text: "" },
        });
        frame(id, "response.output_text.delta", { delta: `Prefix ${id}.` });
      }
      if ((scenario === "text" || returned) && !s.terminal) {
        frame(id, "response.output_text.delta", { delta: `Final ${id}.` });
        frame(id, "response.completed", {
          response: { id: "response", status: "completed" },
        });
        s.terminal = true;
      }
      return {};
    }),
    events: vi.fn(async (id: string, after: string) => ({
      frames: states
        .get(id)!
        .frames.filter((item) => BigInt(item.sequence) > BigInt(after)),
    })),
    result: vi.fn(async (id: string) => result(id)),
    cancel: vi.fn(async (_id: string) => ({})),
  };
  const caller = {
    begin: vi.fn(async (input: ChatCallerBegin) => {
      beginInput = input;
      callerToken = {
        ticketId: "caller-ticket",
        handleId: input.handleId,
        producerOperationId: input.producerOperationId,
        callId: input.call.callId,
        relayBinding: input.relayBinding,
        requestSHA256: input.requestSHA256,
      };
      const id = input.handleId;
      frame(id, "response.output_text.done", { text: `Prefix ${id}.` });
      frame(id, "response.content_part.done");
      frame(id, "response.output_item.done", {
        item: { type: "message", id: "message" },
      });
      const item = {
        type: "function_call",
        id: input.call.itemId,
        call_id: input.call.callId,
        name: input.call.name,
        arguments: input.call.arguments,
      };
      frame(id, "response.output_item.added", { item });
      frame(id, "response.function_call_arguments.delta", {
        delta: input.call.arguments,
      });
      frame(id, "response.function_call_arguments.done", {
        arguments: input.call.arguments,
      });
      frame(id, "response.output_item.done", { item });
      frame(id, "response.completed", {
        response: { status: "completed", output: [item] },
      });
      return callerToken;
    }),
    claim: vi.fn(async (_token: ChatCallerHandle) => ({})),
    issue: vi.fn(async (token: ChatCallerHandle) => {
      const frames = states.get(token.handleId)!.frames.slice(4);
      const data = frames
        .map((f) => `event: ${f.kind}\ndata: ${JSON.stringify(f.data)}\n\n`)
        .join("");
      return {
        issuanceId: "issuance",
        handle: token,
        firstSequence: frames[0]!.sequence,
        lastSequence: frames.at(-1)!.sequence,
        data,
        dataSHA256: hash(data),
        dataBytes: String(Buffer.byteLength(data)),
      };
    }),
    output: vi.fn(async (input: ChatCallerAccept) => {
      const output = input.outputs[0]!.raw as string;
      return {
        output,
        receipt: {
          receiptId: "root-receipt",
          handle: input.handle,
          outputSHA256: hash(output),
          outputBytes: String(Buffer.byteLength(output)),
        },
      };
    }),
    returned: vi.fn(async (_receipt) => {
      returned = true;
      return {};
    }),
  } satisfies GoChatResponsesOptions["caller"];
  return {
    chat,
    caller,
    states,
    frame,
    get beginInput() {
      return beginInput;
    },
  };
}

describe("startup-selected Go Responses transport with controlled peers", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });
  async function compose(
    p = peer(),
    opts: {
      journal?: ProviderTurnJournal;
      context?: string;
      relay?: boolean;
      resolve?: GoChatResponsesOptions["resolveCreate"];
    } = {},
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg-resp-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const relay = opts.relay
      ? await startCodexCallerRelay({ root: path.join(root, "relay") })
      : undefined;
    if (relay) cleanups.push(() => relay.close());
    const completed = vi.fn();
    const compaction = {
      compact: vi.fn<CodexChatGptCompaction["compact"]>(async () => {
        throw new Error("Unused controlled compaction");
      }),
      prepareTurn: vi.fn(async () => ({
        ok: true as const,
        value: { trustedContext: opts.context ?? null, delivered: completed },
      })),
    };
    const journal =
      opts.journal ??
      new PrivateProviderTurnJournal({ root: path.join(root, "journal") });
    const admit = vi.spyOn(journal, "admit"),
      release = vi.spyOn(journal, "release");
    const legacy = vi.fn(async () => {
      throw new Error("Legacy executor must not run");
    });
    const resolveCreate = vi.fn<GoChatResponsesOptions["resolveCreate"]>(
      opts.resolve ?? (() => target),
    );
    const transport = createGoChatResponses({
      chat: p.chat,
      caller: p.caller,
      ...(relay ? { relay } : {}),
      resolveCreate,
    });
    const runtime = await startRouteBRuntime({
      stateRoot: root,
      surfaces: { surfaceFor: legacy },
      compaction,
      journal,
      goResponses: transport,
    });
    cleanups.push(() => runtime.close());
    const post = (data: unknown, signal?: AbortSignal) =>
      fetch(`${runtime.endpoint.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.endpoint.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
        ...(signal ? { signal } : {}),
      });
    return {
      root,
      runtime,
      transport,
      relay,
      compaction,
      completed,
      admit,
      release,
      legacy,
      resolveCreate,
      post,
    };
  }
  it("refuses reasoning outside the supported effort subset before context, admission or relay", async () => {
    const p = peer();
    const a = await compose(p, { relay: true });
    const open = vi.spyOn(a.relay!, "openTurn");
    for (const reasoning of [
      null,
      [],
      { effort: null },
      { effort: "" },
      { effort: "h".repeat(41) },
      { effort: "high\n" },
      { effort: "high", summary: "auto" },
    ]) {
      const response = await a.post({ ...body(), reasoning });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).toMatch(
        /FAROL_REASONING_(INVALID|UNSUPPORTED)/u,
      );
    }
    expect(a.compaction.prepareTurn).not.toHaveBeenCalled();
    expect(a.resolveCreate).not.toHaveBeenCalled();
    expect(a.admit).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(p.chat.create).not.toHaveBeenCalled();
    expect(p.chat.send).not.toHaveBeenCalled();
  });
  it("carries exact explicit effort and declared translation from HTTP into resolver, intent and Create", async () => {
    const p = peer();
    const a = await compose(p, {
      resolve: ({ requestSelection }) => {
        const resolved = {
          ...selection,
          effort: requestSelection.effort === "Ultra" ? "route-max" : "high",
        };
        return {
          ...target,
          selection: resolved,
          resolution: {
            ...target.resolution,
            requestedAlias: "configured-small",
            requestedEffort: requestSelection.effort ?? "",
            resolved,
          },
        };
      },
    });
    for (const effort of ["high", "Ultra"]) {
      const data = { ...body(`thread-${effort}`), reasoning: { effort } };
      const response = await a.post(data);
      expect(response.status).toBe(200);
      await response.text();
      const capture = a.resolveCreate.mock.calls.at(-1)![0].requestSelection;
      expect(capture).toEqual({ model: "chatgpt", effort });
      expect(Object.isFrozen(capture)).toBe(true);
      expect(p.chat.create.mock.calls.at(-1)![0]).toMatchObject({
        selection: {
          provider: "farol",
          alias: "chatgpt",
          effort: effort === "Ultra" ? "route-max" : "high",
        },
        resolution: {
          requestedAlias: "configured-small",
          requestedEffort: effort,
        },
      });
      expect(a.admit.mock.calls.at(-1)![1]).toBe(
        hash(
          JSON.stringify({
            effort,
            input: data.input,
            model: "chatgpt",
            tools: data.tools,
          }),
        ),
      );
    }
  });
  it("conflicts changed explicit effort across adapter lifetimes without retrying a lost Send", async () => {
    const resolve: GoChatResponsesOptions["resolveCreate"] = ({
      requestSelection,
    }) => ({
      ...target,
      resolution: {
        ...target.resolution,
        requestedEffort: requestSelection.effort ?? "",
      },
    });
    const p = peer("lost-send");
    const a = await compose(p, { resolve });
    const data = { ...body(), reasoning: { effort: "high" } };
    expect(parse(await (await a.post(data)).text()).at(-1)!.type).toBe(
      "response.failed",
    );
    await a.runtime.close();
    const second = peer();
    const b = await compose(second, {
      resolve,
      journal: new PrivateProviderTurnJournal({
        root: path.join(a.root, "journal"),
      }),
    });
    const replay = await b.post(data);
    expect(await replay.text()).toContain("FAROL_TURN_ALREADY_SUBMITTED");
    for (const reasoning of [undefined, { effort: "low" }]) {
      const conflict = await b.post({
        ...body(),
        ...(reasoning ? { reasoning } : {}),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.text()).toContain("FAROL_TURN_INTENT_CONFLICT");
    }
    expect(second.chat.create).not.toHaveBeenCalled();
    expect(second.chat.send).not.toHaveBeenCalled();
    expect(p.chat.send).toHaveBeenCalledTimes(1);
  });
  it("selects Go before ActiveProviderTurn while retaining auth, schema, model, compaction and original admission", async () => {
    const p = peer();
    const a = await compose(p, { context: "Trusted checkpoint." });
    const unauthorized = await fetch(
      `${a.runtime.endpoint.baseUrl}/responses`,
      { method: "POST", body: JSON.stringify(body()) },
    );
    expect(unauthorized.status).toBe(401);
    expect((await a.post({ ...body(), model: "foreign" })).status).toBe(422);
    expect((await a.post({ ...body(), stream: false })).status).toBe(400);
    expect(a.admit).not.toHaveBeenCalled();
    const response = await a.post(body());
    expect(response.status).toBe(200);
    const stream = parse(await response.text());
    expect(stream.map((event) => event.sequence_number)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(p.chat.create.mock.calls[0]![0].prompt).toContain(
      "Trusted checkpoint.",
    );
    expect(a.admit.mock.calls[0]![1]).toBe(
      hash(
        JSON.stringify({ input: "Say hello.", model: "chatgpt", tools: [] }),
      ),
    );
    expect(a.admit.mock.invocationCallOrder[0]).toBeLessThan(
      p.chat.create.mock.invocationCallOrder[0]!,
    );
    expect(a.legacy).not.toHaveBeenCalled();
    expect(a.completed).toHaveBeenCalledTimes(1);
    expect(a.release).not.toHaveBeenCalled();
    expect(a.runtime.owns("thread")).toBe(true);
    const blockedSummary = await fetch(
      `${a.runtime.endpoint.baseUrl}/responses/compact`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.runtime.endpoint.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "chatgpt",
          input: [],
          client_metadata: { thread_id: "thread" },
        }),
      },
    );
    expect(blockedSummary.status).toBe(422);
    expect(await blockedSummary.text()).toContain(
      "FAROL_COMPACTION_TURN_ACTIVE",
    );
    expect(a.compaction.compact).not.toHaveBeenCalled();

    expect(a.runtime.provider.diagnostics().activeTurns).toBe(0);
    expect((await a.post(body("thread", "next"))).status).toBe(409);
    expect(p.chat.create).toHaveBeenCalledTimes(1);
    expect(p.chat.send).toHaveBeenCalledTimes(1);
  });
  it("refuses the exact UTF-8 Go boundary before durable admission", async () => {
    const p = peer();
    const a = await compose(p);
    expect(
      (await a.post(body("thread", "turn", "é".repeat(4097)))).status,
    ).toBe(422);
    expect(a.admit).not.toHaveBeenCalled();
    expect(p.chat.create).not.toHaveBeenCalled();
    const response = await a.post(body("thread", "turn", "é".repeat(4096)));
    expect(response.status).toBe(200);
    await response.text();
  });
  it("retains the original guard across a lost physical Send reply and process-local restart", async () => {
    const p = peer("lost-send");
    const a = await compose(p);
    const response = await a.post(body());
    const events = parse(await response.text());
    expect(events.at(-1)!.type).toBe("response.failed");
    expect(p.chat.observe).not.toHaveBeenCalled();
    expect(a.completed).not.toHaveBeenCalled();
    expect(a.release).not.toHaveBeenCalled();
    await a.runtime.close();
    const second = peer();
    const journal = new PrivateProviderTurnJournal({
      root: path.join(a.root, "journal"),
    });
    const b = await compose(second, { journal });
    expect((await b.post(body())).status).toBe(409);
    expect(
      (await b.post(body("thread", "turn", "Changed intent."))).status,
    ).toBe(409);
    expect(second.chat.create).not.toHaveBeenCalled();
    expect(second.chat.send).not.toHaveBeenCalled();
    expect(p.chat.create).toHaveBeenCalledTimes(1);
    expect(p.chat.send).toHaveBeenCalledTimes(1);
  });
  it("routes global PrepareNext to its returned handle, not the calling connection", async () => {
    const p = peer();
    const gate = deferred<void>();
    p.chat.prepare
      .mockImplementationOnce(async () => {
        await gate.promise;
        const handle = [...p.states.values()][1]!.handle;
        return {
          handle,
          slotOrdinal: 2,
          slotGeneration: "1",
          viewId: "view-2",
          viewGeneration: "1",
          documentGeneration: "1",
          conversationId: "",
          providerState: "home",
        };
      })
      .mockImplementationOnce(async () => {
        const handle = [...p.states.values()][0]!.handle;
        return {
          handle,
          slotOrdinal: 1,
          slotGeneration: "1",
          viewId: "view-1",
          viewGeneration: "1",
          documentGeneration: "1",
          conversationId: "",
          providerState: "home",
        };
      });
    const a = await compose(p);
    const first = a.post(body("thread-a"));
    await vi.waitFor(() => expect(p.chat.prepare).toHaveBeenCalledTimes(1));
    const second = a.post(body("thread-b"));
    await vi.waitFor(() => expect(p.chat.create).toHaveBeenCalledTimes(2));
    gate.resolve();
    const responses = await Promise.all([first, second]);
    const texts = await Promise.all(responses.map((r) => r.text()));
    expect(texts[0]).toContain("Prefix handle-1.");
    expect(texts[0]).not.toContain("Prefix handle-2.");
    expect(texts[1]).toContain("Prefix handle-2.");
    expect(p.chat.send.mock.calls.map((call) => call[0])).toEqual([
      "handle-2",
      "handle-1",
    ]);
  });
  it("issues the tool group only through the original writer and resolves only the parsed relay receipt", async () => {
    const p = peer("tool");
    const a = await compose(p, { relay: true });
    const initial = await a.post(body("thread", "turn", "Use a tool.", [tool]));
    await vi.waitFor(() =>
      expect(p.chat.events.mock.calls.some((call) => call[1] === "4")).toBe(
        true,
      ),
    );
    const prompt = p.chat.create.mock.calls[0]![0].prompt;
    const ticket = /with ticket (\S+) and binding (\S+)\./u.exec(prompt)!;
    const beginGate = deferred<void>();
    const realBegin = p.caller.begin.getMockImplementation()!;
    p.caller.begin.mockImplementationOnce(async (input) => {
      const token = await realBegin(input);
      await beginGate.promise;
      return token;
    });
    const client = new CodexCallerRelayClient(a.relay!.endpoint, 5000);
    const invocation = client.request({
      operation: "invoke",
      ticket: ticket[1]!,
      binding: ticket[2]!,
      operationId: "tool-operation",
      name: "shell",
      namespace: null,
      arguments: { command: "fixture" },
    });
    await vi.waitFor(() => expect(p.caller.begin).toHaveBeenCalledTimes(1));
    const observations = p.chat.observe.mock.calls.length,
      reads = p.chat.events.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    expect(p.chat.observe).toHaveBeenCalledTimes(observations);
    expect(p.chat.events).toHaveBeenCalledTimes(reads);
    expect(p.caller.issue).not.toHaveBeenCalled();
    beginGate.resolve();
    const firstEvents = parse(await initial.text());
    expect(firstEvents.map((event) => event.sequence_number)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    const call = firstEvents.find(
      (event) =>
        event.type === "response.output_item.done" &&
        (event.item as { type: string }).type === "function_call",
    )!.item as Record<string, unknown>;
    const invalid = await a.post(
      body(
        "thread",
        "turn",
        [
          call,
          { type: "function_call_output", call_id: "foreign", output: "bad" },
        ],
        [tool],
      ),
    );
    expect(invalid.status).toBe(409);
    expect(p.caller.output).not.toHaveBeenCalled();
    const returnGate = deferred<void>();
    const realReturn = p.caller.returned.getMockImplementation()!;
    p.caller.returned.mockImplementationOnce(async (receipt) => {
      await returnGate.promise;
      return realReturn(receipt);
    });
    const continuation = a.post(
      body(
        "thread",
        "turn",
        [
          { type: "function_call", ...call },
          {
            type: "function_call_output",
            call_id: call.call_id,
            output: "Tool result ✓",
          },
        ],
        [tool],
      ),
    );
    await vi.waitFor(() => expect(p.caller.returned).toHaveBeenCalledTimes(1));
    expect(p.caller.issue).toHaveBeenCalledTimes(1);
    expect(p.caller.claim).toHaveBeenCalledTimes(1);
    expect(p.caller.output).toHaveBeenCalledTimes(1);
    expect(p.chat.observe).toHaveBeenCalledTimes(observations);
    returnGate.resolve();
    const response = await continuation;
    const secondEvents = parse(await response.text());
    expect(secondEvents.map((event) => event.sequence_number)).toEqual([
      13, 14,
    ]);
    await expect(invocation).resolves.toMatchObject({
      ok: true,
      operation: "invoke",
      output: "Tool result ✓",
    });
    expect(p.caller.returned.mock.calls[0]![0]).toEqual(
      (await p.caller.output.mock.results[0]!.value).receipt,
    );
    expect(p.chat.create).toHaveBeenCalledTimes(1);
    expect(p.chat.send).toHaveBeenCalledTimes(1);
    expect(a.release).not.toHaveBeenCalled();
    expect(a.legacy).not.toHaveBeenCalled();
  });
  it("withdraws locally before cancellation when an original response disappears during Go Create", async () => {
    const p = peer("tool");
    const created = deferred<ChatHandle>();
    const original = p.chat.create.getMockImplementation()!;
    p.chat.create.mockImplementationOnce(async (input) => {
      const handle = await original(input);
      await created.promise;
      return handle;
    });
    const a = await compose(p);
    const controller = new AbortController();
    const request = a.post(body(), controller.signal);
    void request.catch(() => undefined);
    await vi.waitFor(() => expect(p.chat.create).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(a.transport.activeResponses).toBe(0));
    created.resolve([...p.states.values()][0]!.handle);
    await vi.waitFor(() => expect(p.chat.cancel).toHaveBeenCalledTimes(1));
    expect(p.chat.send).not.toHaveBeenCalled();
    expect(a.release).not.toHaveBeenCalled();
  });
  it("keeps the original summary guard against Go admission while another thread continues", async () => {
    const p = peer();
    const a = await compose(p);
    const summary =
      deferred<Awaited<ReturnType<typeof a.compaction.compact>>>();
    a.compaction.compact.mockImplementationOnce(async () => summary.promise);
    const compact = () =>
      fetch(`${a.runtime.endpoint.baseUrl}/responses/compact`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.runtime.endpoint.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "chatgpt",
          input: [],
          client_metadata: { thread_id: "summary-thread" },
        }),
      });
    const first = compact();
    void first.catch(() => undefined);
    cleanups.push(async () => {
      summary.resolve({
        ok: false,
        error: {
          code: "FAROL_COMPACTION_SUMMARY_BLOCKED",
          retry: "never",
        },
      });
      await first.catch(() => undefined);
    });
    await vi.waitFor(() =>
      expect(a.compaction.compact).toHaveBeenCalledTimes(1),
    );
    expect(a.runtime.owns("summary-thread")).toBe(true);
    const refused = await a.post(body("summary-thread"));
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("FAROL_COMPACTION_TURN_ACTIVE");
    expect(a.admit).not.toHaveBeenCalled();
    expect(p.chat.create).not.toHaveBeenCalled();
    // A rejected preparation/second summary must not release the first guard.
    expect((await compact()).status).toBe(422);
    expect(a.runtime.owns("summary-thread")).toBe(true);
    const neighbor = await a.post(body("neighbor"));
    expect(neighbor.status).toBe(200);
    await neighbor.text();
    summary.resolve({
      ok: false,
      error: { code: "FAROL_COMPACTION_SUMMARY_BLOCKED", retry: "never" },
    });
    expect((await first).status).toBe(422);
    expect(a.runtime.owns("summary-thread")).toBe(false);
    const admitted = await a.post(body("summary-thread"));
    expect(admitted.status).toBe(200);
    await admitted.text();
    expect(p.chat.create).toHaveBeenCalledTimes(2);
    expect(a.compaction.compact).toHaveBeenCalledTimes(1);
  });
  it("retains original summary ownership until its own terminal callback after provider close", async () => {
    const p = peer();
    const a = await compose(p);
    const summary =
      deferred<Awaited<ReturnType<typeof a.compaction.compact>>>();
    const exited = deferred<void>();
    a.compaction.compact.mockImplementationOnce(async () => {
      try {
        return await summary.promise;
      } finally {
        exited.resolve();
      }
    });
    const request = fetch(`${a.runtime.endpoint.baseUrl}/responses/compact`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${a.runtime.endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "chatgpt",
        input: [],
        client_metadata: { thread_id: "summary-thread" },
      }),
    });
    void request.catch(() => undefined);
    await vi.waitFor(() =>
      expect(a.compaction.compact).toHaveBeenCalledTimes(1),
    );
    await a.runtime.close();
    await expect(request).rejects.toThrow();
    // Closing a socket is not proof that the original summary has settled.
    expect(a.runtime.owns("summary-thread")).toBe(true);
    summary.resolve({
      ok: false,
      error: { code: "FAROL_COMPACTION_SUMMARY_BLOCKED", retry: "never" },
    });
    await exited.promise;
    await vi.waitFor(() =>
      expect(a.runtime.owns("summary-thread")).toBe(false),
    );
    expect(p.chat.create).not.toHaveBeenCalled();
    expect(a.admit).not.toHaveBeenCalled();
  });
  it("does not retry an unknown global Prepare or assign it to the requesting connection", async () => {
    const p = peer();
    p.chat.prepare.mockRejectedValueOnce(
      new BridgeError("unknown", "owner_outcome_unknown"),
    );
    const a = await compose(p);
    expect((await a.post(body())).status).toBe(409);
    expect((await a.post(body())).status).toBe(409);
    expect(p.chat.create).toHaveBeenCalledTimes(1);
    expect(p.chat.prepare).toHaveBeenCalledTimes(1);
    expect(p.chat.send).not.toHaveBeenCalled();
    expect(a.release).not.toHaveBeenCalled();
    expect(a.legacy).not.toHaveBeenCalled();
  });
  it("ends the original connection after a lost Send command reply without fallback or another Send", async () => {
    const p = peer();
    p.chat.send.mockRejectedValueOnce(
      new BridgeError("unknown", "send_reply_lost"),
    );
    const a = await compose(p);
    expect((await a.post(body())).status).toBe(409);
    expect((await a.post(body())).status).toBe(409);
    expect(p.chat.create).toHaveBeenCalledTimes(1);
    expect(p.chat.prepare).toHaveBeenCalledTimes(1);
    expect(p.chat.send).toHaveBeenCalledTimes(1);
    expect(p.chat.observe).not.toHaveBeenCalled();
    expect(p.chat.cancel).toHaveBeenCalledTimes(1);
    expect(a.release).not.toHaveBeenCalled();
    expect(a.legacy).not.toHaveBeenCalled();
  });
  it("does not open a Go request when a tool catalogue has no selected original private relay", async () => {
    const p = peer();
    const a = await compose(p);
    expect(
      (await a.post(body("thread", "turn", "Use a tool.", [tool]))).status,
    ).toBe(422);
    expect(a.admit).not.toHaveBeenCalled();
    expect(p.chat.create).not.toHaveBeenCalled();
    expect(a.legacy).not.toHaveBeenCalled();
  });
  it("does not re-admit or switch to legacy after an unknown Create reply", async () => {
    const p = peer();
    p.chat.create.mockRejectedValueOnce(
      new BridgeError("unknown", "lost_create_reply"),
    );
    const a = await compose(p);
    expect((await a.post(body())).status).toBe(409);
    expect((await a.post(body())).status).toBe(409);
    expect(p.chat.create).toHaveBeenCalledTimes(1);
    expect(p.chat.send).not.toHaveBeenCalled();
    expect(a.release).not.toHaveBeenCalled();
    expect(a.legacy).not.toHaveBeenCalled();
  });
});

// Actual Go lifecycle/Caller/Root, ordinary framed server, typed bridge and the
// same auth/admission HTTP adapter. Browser and Go journal remain controlled
// in-memory ports; no native runtime, Electron, account or provider is touched.
describe("ordinary Responses HTTP joined to the actual Go CPU peer", () => {
  for (const scenario of ["text", "tool", "lost-send-reply"] as const) {
    it(`${scenario}: joins original Go ownership without replaying Send`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg-http-"));
      const p = await startGoChatResponsesFixture(scenario);
      const relay = await startCodexCallerRelay({
        root: path.join(root, "relay"),
      });
      const resolveCreate = vi.fn(() => ({
        selection: p.selection,
        resolution: p.resolution,
        required: p.required,
      }));
      const chatCreate = vi.spyOn(p.chat, "create");
      const delivered = vi.fn();
      const legacy = vi.fn(async () => {
        throw new Error("Legacy route must not execute");
      });
      const journal = new PrivateProviderTurnJournal({
        root: path.join(root, "journal"),
      });
      const release = vi.spyOn(journal, "release");
      const route = await startRouteBRuntime({
        stateRoot: root,
        surfaces: { surfaceFor: legacy },
        journal,
        compaction: {
          compact: async () => {
            throw new Error("Unused controlled compaction");
          },
          prepareTurn: async () => ({
            ok: true,
            value: { trustedContext: "Controlled checkpoint", delivered },
          }),
        },
        goResponses: createGoChatResponses({
          chat: p.chat,
          caller: p.caller,
          relay,
          resolveCreate,
        }),
      });
      const post = (data: unknown) =>
        fetch(`${route.endpoint.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${route.endpoint.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
        });
      try {
        expect((await post({ ...body(), model: "foreign" })).status).toBe(422);
        expect(chatCreate).not.toHaveBeenCalled();
        const tools = scenario === "tool" ? [tool] : [];
        const initial = await post(
          body("thread", "turn", "Controlled question", tools),
        );
        expect(initial.status).toBe(200);
        expect(resolveCreate.mock.calls[0]).toBeDefined();
        expect(chatCreate.mock.calls[0]![0].prompt).toContain(
          "Controlled checkpoint",
        );
        if (scenario === "tool") {
          // Wait for actual useful Go delta, rather than admission/created.
          const reader = initial.body!.getReader();
          let firstText = "";
          while (!firstText.includes("Useful before tool.")) {
            const chunk = await reader.read();
            expect(chunk.done).toBe(false);
            firstText += Buffer.from(chunk.value!).toString("utf8");
          }
          const ticket = /with ticket (\S+) and binding (\S+)\./u.exec(
            chatCreate.mock.calls[0]![0].prompt,
          )!;
          const client = new CodexCallerRelayClient(relay.endpoint, 5000);
          const invocation = client.request({
            operation: "invoke",
            ticket: ticket[1]!,
            binding: ticket[2]!,
            operationId: "controlled-tool",
            name: "shell",
            namespace: null,
            arguments: { command: "controlled" },
          });
          void invocation.catch(() => undefined);
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            firstText += Buffer.from(chunk.value!).toString("utf8");
          }
          const first = parse(firstText);
          expect(
            first.filter((event) => event.type === "response.completed"),
          ).toHaveLength(1);
          const call = first.find(
            (event) =>
              event.type === "response.output_item.done" &&
              (event.item as { type: string }).type === "function_call",
          )!.item as Record<string, unknown>;
          expect(call.call_id).toMatch(/^farol_call_/u);
          const continuation = await post(
            body(
              "thread",
              "turn",
              [
                call,
                {
                  type: "function_call_output",
                  call_id: call.call_id,
                  output: "Controlled result ✓",
                },
              ],
              tools,
            ),
          );
          expect(continuation.status).toBe(200);
          const last = parse(await continuation.text());
          expect(
            last.some(
              (event) =>
                event.type === "response.output_text.delta" &&
                String(event.delta).includes("Continued after tool."),
            ),
          ).toBe(true);
          expect(last.at(-1)!.type).toBe("response.completed");
          expect(last[0]!.sequence_number).toBe(
            Number(first.at(-1)!.sequence_number) + 1,
          );
          await expect(invocation).resolves.toMatchObject({
            ok: true,
            operation: "invoke",
            output: "Controlled result ✓",
          });
        } else {
          const events = parse(await initial.text());
          expect(events.at(-1)!.type).toBe(
            scenario === "text" ? "response.completed" : "response.failed",
          );
          if (scenario === "text")
            expect(
              events.some((event) =>
                String(event.delta).includes("Useful before tool."),
              ),
            ).toBe(true);
          else {
            const handle = await chatCreate.mock.results[0]!.value;
            expect((await p.chat.submission(handle)).state).toBe("unknown");
            expect(
              events.some((event) => event.type === "response.completed"),
            ).toBe(false);
          }
        }
        expect(
          (await post(body("thread", "turn", "Controlled question", tools)))
            .status,
        ).toBe(409);
        expect(
          (await post(body("thread", "next", "Later user turn", tools))).status,
        ).toBe(409);
        expect(chatCreate).toHaveBeenCalledTimes(1);
        expect(legacy).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(delivered).toHaveBeenCalledTimes(
          scenario === "lost-send-reply" ? 0 : 1,
        );
      } finally {
        await route.close();
        await relay.close();
        const receipt = await p.close();
        expect(receipt.serverEOF).toBe(true);
        expect(receipt.physicalSendAttempts).toBe(1);
        expect(receipt.acceptedSubmissions).toBe(1);
        for (const method of [
          "chat.conversation.create",
          "chat.conversation.prepare",
          "chat.conversation.send",
        ])
          expect(receipt.methods[method], method).toEqual({
            attempts: 1,
            known: 1,
          });
        expect(receipt.commits.dispatch).toBe(1);
        if (scenario === "tool") {
          for (const method of [
            "chat.caller.begin",
            "chat.caller.claim",
            "chat.caller.issue",
            "chat.caller.output",
            "chat.caller.return",
          ])
            expect(receipt.methods[method], method).toEqual({
              attempts: 1,
              known: 1,
            });
          expect(receipt.commits["resolve-computer"]).toBe(1);
        } else expect(receipt.methods["chat.caller.issue"]).toBeUndefined();
        expect(receipt.methods["chat.conversation.result.ack"]).toBeUndefined();
        expect(receipt.methods["chat.conversation.frame.ack"]).toBeUndefined();
        if (scenario === "lost-send-reply")
          expect(receipt.observations).toBe(0);
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

// Deterministic local stream events. These are transport doubles: they do not
// qualify Go, HTTP socket delivery or the private relay parser. The real-Go
// ordinary HTTP witnesses above exercise that independent composition.
class FinishResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  headersSent = false;
  bytes = "";
  private readonly expectedError = () => undefined;
  constructor(private readonly toolBackpressure = false) {
    super();
    // Let tests emit repeated post-terminal errors without the harness itself
    // throwing EventEmitter's unhandled-error exception. Not a route observer.
    this.on("error", this.expectedError);
  }
  writeHead = vi.fn(() => {
    this.headersSent = true;
    return this;
  });
  write = vi.fn((bytes: string) => {
    this.bytes += bytes;
    return !(
      this.toolBackpressure &&
      bytes.includes("response.function_call_arguments.")
    );
  });
  end = vi.fn(() => {
    this.writableEnded = true;
    return this;
  });
  finish() {
    this.writableFinished = true;
    this.emit("finish");
  }
  lose(event: "close" | "error") {
    if (event === "close") {
      this.destroyed = true;
      this.emit("close");
    } else this.emit("error", new Error("Controlled response error"));
  }
  observers() {
    return {
      close: this.listenerCount("close"),
      error: this.listeners("error").filter(
        (listener) => listener !== this.expectedError,
      ).length,
      finish: this.listenerCount("finish"),
      drain: this.listenerCount("drain"),
    };
  }
  asResponse() {
    return this as unknown as ServerResponse;
  }
}
function finishFixture(scenario: "text" | "tool" = "tool") {
  const p = peer(scenario);
  type OpenInput = Parameters<
    NonNullable<GoChatResponsesOptions["relay"]>["openTurn"]
  >[0];
  let invokeOwned: NonNullable<OpenInput["invokeOwned"]> | undefined;
  const relayClose = vi.fn();
  const relay = {
    openTurn: vi.fn((input: OpenInput) => {
      invokeOwned = input.invokeOwned;
      return {
        ticket: "controlled-ticket",
        binding: "b".repeat(64),
        inventory: [],
        close: relayClose,
      };
    }),
  };
  const transport = createGoChatResponses({
    chat: p.chat,
    caller: p.caller,
    relay,
    resolveCreate: () => target,
  });
  const identity = {
    sessionId: "session",
    threadId: "thread",
    turnId: "turn",
    rootTurnId: "turn",
  };
  const invocation = {
    operationId: "controlled-operation",
    binding: "b".repeat(64),
    requestSHA256: "c".repeat(64),
  };
  const admit = vi.fn(async () => true),
    completed = vi.fn(),
    onToolCall = vi.fn();
  const serve = (response: FinishResponse, input: string | unknown[]) =>
    transport.serve({
      key: "controlled-original-key",
      identity,
      request: {
        model: "chatgpt",
        input,
        tools: scenario === "tool" ? [tool] : [],
      },
      response: response.asResponse(),
      prepareInitial: async () => ({
        prompt: "Controlled transport question",
        admit,
        completed,
      }),
      onToolCall,
    });
  return {
    p,
    transport,
    completed,
    admit,
    onToolCall,
    start: (response: FinishResponse) => serve(response, "Controlled question"),
    invoke: () => {
      if (!invokeOwned) throw new Error("Controlled original producer missing");
      return invokeOwned(
        {
          name: "shell",
          namespace: null,
          arguments: { command: "controlled" },
          encodedArguments: '{"command":"controlled"}',
        },
        invocation,
      );
    },
    continuation: (response: FinishResponse) => {
      const call = p.beginInput!.call;
      return serve(response, [
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
          output: "Controlled output ✓",
        },
      ]);
    },
    receipt: (output: string) => ({
      ...invocation,
      receiptId: "controlled-parsed-receipt",
      outputSHA256: hash(output),
      outputBytes: Buffer.byteLength(output),
    }),
  };
}

describe("original Responses finish/close/error fencing", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });
  async function issued(backpressure = false) {
    const f = finishFixture();
    cleanups.push(() => f.transport.close());
    const response = new FinishResponse(backpressure);
    let settled = false;
    const initial = f.start(response);
    void initial.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() =>
      expect(response.bytes).toContain("Prefix handle-1."),
    );
    const invocation = f.invoke();
    void invocation.catch(() => undefined);
    await vi.waitFor(() => expect(f.p.caller.issue).toHaveBeenCalledTimes(1));
    if (backpressure) {
      await vi.waitFor(() => expect(response.listenerCount("drain")).toBe(1));
      expect(response.end).not.toHaveBeenCalled();
      response.emit("drain");
    }
    await vi.waitFor(() => expect(response.end).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(response.observers()).toEqual({
      close: 1,
      error: 1,
      finish: 1,
      drain: 0,
    });
    expect(f.p.caller.returned).not.toHaveBeenCalled();
    return { f, response, initial, invocation, isSettled: () => settled };
  }
  for (const event of ["close", "error"] as const) {
    for (const backpressure of [false, true]) {
      it(`${event} after issued ${backpressure ? "drain" : "write(true)"} before finish fences once without a Go return`, async () => {
        const { f, response, initial, invocation } = await issued(backpressure);
        const cancellation = deferred<Record<string, never>>();
        f.p.chat.cancel.mockImplementationOnce(
          async () => cancellation.promise,
        );
        cleanups.push(async () => {
          cancellation.resolve({});
        });
        response.lose(event);
        expect(f.p.chat.cancel).toHaveBeenCalledTimes(1);
        expect(response.observers()).toEqual({
          close: 0,
          error: 0,
          finish: 0,
          drain: 0,
        });
        // The deny fence already holds while the original cancellation reply
        // is still outstanding. No new incoming response can accept output.
        const late = new FinishResponse();
        await expect(f.continuation(late)).rejects.toThrow(
          "FAROL_CONTINUATION_REQUIRED",
        );
        expect(late.observers()).toEqual({
          close: 0,
          error: 0,
          finish: 0,
          drain: 0,
        });
        await expect(initial).rejects.toThrow("FAROL_HOST_DELIVERY_LOST");
        await expect(invocation).rejects.toThrow("FAROL_HOST_DELIVERY_LOST");
        response.finish();
        response.lose("close");
        response.lose("error");
        expect(f.p.chat.cancel).toHaveBeenCalledTimes(1);
        expect(f.p.chat.create).toHaveBeenCalledTimes(1);
        expect(f.p.chat.send).toHaveBeenCalledTimes(1);
        expect(f.p.caller.issue).toHaveBeenCalledTimes(1);
        expect(f.p.caller.output).not.toHaveBeenCalled();
        expect(f.p.caller.returned).not.toHaveBeenCalled();
        cancellation.resolve({});
      });
    }
  }
  it("keeps original and early continuation bindings distinct until normal finish", async () => {
    const { f, response, initial, invocation, isSettled } = await issued();
    const next = new FinishResponse();
    let nextSettled = false;
    const continuation = f.continuation(next);
    void continuation.then(
      () => {
        nextSettled = true;
      },
      () => {
        nextSettled = true;
      },
    );
    await vi.waitFor(() => expect(next.observers().finish).toBe(1));
    expect(response.observers()).toEqual({
      close: 1,
      error: 1,
      finish: 1,
      drain: 0,
    });
    expect(f.p.caller.output).not.toHaveBeenCalled();
    expect(isSettled()).toBe(false);
    await expect(f.continuation(new FinishResponse())).rejects.toThrow(
      "FAROL_CONTINUATION_REQUIRED",
    );
    response.finish();
    response.lose("close");
    response.lose("error");
    await initial;
    const owned = await invocation;
    expect(response.observers()).toEqual({
      close: 0,
      error: 0,
      finish: 0,
      drain: 0,
    });
    expect(next.observers()).toEqual({
      close: 1,
      error: 1,
      finish: 1,
      drain: 0,
    });
    expect(f.p.chat.cancel).not.toHaveBeenCalled();
    expect(f.p.caller.output).toHaveBeenCalledTimes(1);
    expect(f.p.caller.returned).not.toHaveBeenCalled();
    // Only this controlled original producer callback represents received;
    // neither old finish nor the continuation's writes can select Go return.
    await expect(owned.onReceived(f.receipt(owned.output))).resolves.toBe(
      "acknowledged",
    );
    await vi.waitFor(() => expect(next.end).toHaveBeenCalledTimes(1));
    expect(nextSettled).toBe(false);
    expect(next.observers()).toEqual({
      close: 1,
      error: 1,
      finish: 1,
      drain: 0,
    });
    next.finish();
    await continuation;
    next.lose("close");
    expect(next.observers()).toEqual({
      close: 0,
      error: 0,
      finish: 0,
      drain: 0,
    });
    expect(f.p.chat.cancel).not.toHaveBeenCalled();
    expect(f.p.chat.create).toHaveBeenCalledTimes(1);
    expect(f.p.chat.send).toHaveBeenCalledTimes(1);
    expect(f.p.caller.issue).toHaveBeenCalledTimes(1);
    expect(f.p.caller.returned).toHaveBeenCalledTimes(1);
  });
  for (const event of ["close", "error"] as const) {
    it(`early continuation ${event} withdraws the still unfinished original response`, async () => {
      const { f, response, initial, invocation } = await issued();
      const next = new FinishResponse();
      const continuation = f.continuation(next);
      void continuation.catch(() => undefined);
      await vi.waitFor(() => expect(next.observers().finish).toBe(1));
      next.lose(event);
      await expect(continuation).rejects.toThrow("FAROL_HOST_DELIVERY_LOST");
      await expect(initial).rejects.toThrow("FAROL_HOST_DELIVERY_LOST");
      await expect(invocation).rejects.toThrow("FAROL_HOST_DELIVERY_LOST");
      response.finish();
      next.finish();
      response.lose("close");
      next.lose("error");
      expect(response.observers()).toEqual({
        close: 0,
        error: 0,
        finish: 0,
        drain: 0,
      });
      expect(next.observers()).toEqual({
        close: 0,
        error: 0,
        finish: 0,
        drain: 0,
      });
      expect(f.p.chat.cancel).toHaveBeenCalledTimes(1);
      expect(f.p.chat.send).toHaveBeenCalledTimes(1);
      expect(f.p.caller.issue).toHaveBeenCalledTimes(1);
      expect(f.p.caller.output).not.toHaveBeenCalled();
      expect(f.p.caller.returned).not.toHaveBeenCalled();
    });
  }
  it("finishes ordinary text locally only on finish, without a business ACK", async () => {
    const f = finishFixture("text");
    cleanups.push(() => f.transport.close());
    const response = new FinishResponse();
    let settled = false;
    const served = f.start(response);
    void served.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(response.end).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(f.transport.activeResponses).toBe(1);
    expect(response.observers()).toEqual({
      close: 1,
      error: 1,
      finish: 1,
      drain: 0,
    });
    response.finish();
    await served;
    response.lose("close");
    expect(f.transport.activeResponses).toBe(0);
    expect(response.observers()).toEqual({
      close: 0,
      error: 0,
      finish: 0,
      drain: 0,
    });
    expect(f.transport.owns("thread")).toBe(true);
    expect(f.p.chat.cancel).not.toHaveBeenCalled();
    expect(f.p.caller.returned).not.toHaveBeenCalled();
    expect(f.p.chat.send).toHaveBeenCalledTimes(1);
  });
});
