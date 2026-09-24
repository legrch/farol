import { describe, expect, it } from "vitest";

import {
  runCodexChatGptHostRoute,
  continueCodexChatGptHostThread,
  type CodexChatGptHostPeer,
} from "../../src/apps/desktop/codex-chatgpt-host-route";

class FakePeer implements CodexChatGptHostPeer {
  readonly requests: Readonly<{ method: string; params: unknown }>[] = [];
  private readonly notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >();

  constructor(
    private readonly options: Readonly<{
      observedModel?: string;
      observedProvider?: string;
      staleTerminalBeforeTurnResponse?: boolean;
      terminalBeforeDelta?: boolean;
      messages?: readonly Readonly<{ id: string; text: string }>[];
      retainedMessages?: readonly Readonly<{ id: string; text: string }>[];
    }> = {},
  ) {}

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return {
        model: this.options.observedModel ?? "chatgpt",
        thread: {
          id: "thread-route-b",
          parentThreadId: null,
          modelProvider: this.options.observedProvider ?? "farol",
        },
      };
    }
    if (method === "turn/start") {
      if (this.options.staleTerminalBeforeTurnResponse) {
        this.notify("turn/completed", {
          threadId: "thread-route-b",
          turn: { id: "turn-compaction", status: "completed" },
        });
      }
      queueMicrotask(() => {
        if (this.options.terminalBeforeDelta) {
          this.notify("turn/completed", {
            threadId: "thread-route-b",
            turn: { id: "turn-route-b", status: "completed" },
          });
          return;
        }
        const messages = this.options.messages ?? [
          { id: "message-route-b", text: "Hel" },
          { id: "message-route-b", text: "lo" },
        ];
        for (const message of messages) {
          this.notify("item/agentMessage/delta", {
            threadId: "thread-route-b",
            turnId: "turn-route-b",
            itemId: message.id,
            delta: message.text,
          });
        }
        this.notify("turn/completed", {
          threadId: "thread-route-b",
          turn: { id: "turn-route-b", status: "completed" },
        });
      });
      return {
        turn: { id: "turn-route-b", status: "inProgress" },
      };
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-route-b",
          model: this.options.observedModel ?? "chatgpt",
          modelProvider: this.options.observedProvider ?? "farol",
          turns: [
            {
              id: "turn-route-b",
              status: "completed",
              items: (
                this.options.retainedMessages ?? [
                  { id: "message-route-b", text: "Hello" },
                ]
              ).map((message) => ({ ...message, type: "agentMessage" })),
            },
          ],
        },
      };
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  }

  handleNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    this.notificationHandlers.set(method, handler);
    return () => this.notificationHandlers.delete(method);
  }

  private notify(method: string, params: unknown): void {
    this.notificationHandlers.get(method)?.(params);
  }
}

describe("isolated Codex to ChatGPT host route", () => {
  it.each([
    "farol/chatgpt",
    "farol-next/chatgpt",
    "chatgpt-release-a",
    "deepseek",
  ])(
    "rejects unregistered requested model %s before any RPC",
    async (model) => {
      const peer = new FakePeer();
      const unsupported = model as "chatgpt";
      await expect(
        runCodexChatGptHostRoute(peer, {
          model: unsupported,
          cwd: "/private/tmp/farol-route-b",
          prompt: "Synthetic request",
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("CODEX_CHATGPT_ROUTE_INPUT_INVALID");
      await expect(
        continueCodexChatGptHostThread(peer, {
          model: unsupported,
          threadId: "thread-route-b",
          prompt: "Synthetic continuation",
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("CODEX_CHATGPT_ROUTE_INPUT_INVALID");
      expect(peer.requests).toEqual([]);
    },
  );

  it.each([
    { observedProvider: "farol_next" },
    { observedProvider: "openai" },
    { observedModel: "farol-next/chatgpt" },
    { observedModel: "farol/chatgpt" },
  ])("refuses a retained prior route %j before resuming", async (observed) => {
    const peer = new FakePeer(observed);
    await expect(
      continueCodexChatGptHostThread(peer, {
        model: "chatgpt",
        threadId: "thread-route-b",
        prompt: "Continue the same task",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("CODEX_CHATGPT_PROVIDER_IDENTITY_CHANGED");
    expect(peer.requests).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-route-b", includeTurns: false },
      },
    ]);
  });

  it("starts the exact custom provider without relying on the built-in model list", async () => {
    const peer = new FakePeer();

    await expect(
      runCodexChatGptHostRoute(peer, {
        model: "chatgpt",
        cwd: "/private/tmp/farol-route-b",
        prompt: "Say hello",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      requestedProvider: "farol",
      observedProvider: "farol",
      requestedModel: "chatgpt",
      observedModel: "chatgpt",
      threadId: "thread-route-b",
      turnId: "turn-route-b",
      deltaCount: 2,
      observedCharacters: 5,
      retainedResult: true,
    });
    expect(peer.requests).toEqual([
      {
        method: "thread/start",
        params: expect.objectContaining({
          model: "chatgpt",
          modelProvider: "farol",
          allowProviderModelFallback: false,
          cwd: "/private/tmp/farol-route-b",
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: false,
          dynamicTools: [],
        }),
      },
      {
        method: "thread/read",
        params: { threadId: "thread-route-b", includeTurns: false },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-route-b",
          effort: "low",
          input: [{ type: "text", text: "Say hello" }],
        },
      },
      {
        method: "thread/read",
        params: { threadId: "thread-route-b", includeTurns: true },
      },
    ]);
  });

  it("correlates commentary and answer separately on the neutral provider route", async () => {
    const messages = [
      { id: "commentary", text: "Checking." },
      { id: "answer", text: "Done." },
    ];
    const peer = new FakePeer({
      observedModel: "chatgpt",
      messages,
      retainedMessages: messages,
    });
    await expect(
      runCodexChatGptHostRoute(peer, {
        model: "chatgpt",
        cwd: "/private/tmp/farol-route-b",
        prompt: "Check the answer",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      deltaCount: 2,
      observedCharacters: "Checking.Done.".length,
      retainedResult: true,
    });
  });

  it.each(["missing", "changed", "duplicate", "reordered"])(
    "refuses %s retained multi-message history",
    async (kind) => {
      const messages = [
        { id: "commentary", text: "Checking." },
        { id: "answer", text: "Done." },
      ];
      const retainedMessages =
        kind === "missing"
          ? messages.slice(1)
          : kind === "changed"
            ? [messages[0]!, { id: "answer", text: "Not done." }]
            : kind === "duplicate"
              ? [messages[0]!, messages[1]!, messages[1]!]
              : [...messages].reverse();
      await expect(
        runCodexChatGptHostRoute(new FakePeer({ messages, retainedMessages }), {
          model: "chatgpt",
          cwd: "/private/tmp/farol-route-b",
          prompt: "Check the answer",
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("CODEX_CHATGPT_RETAINED_RESULT_INVALID");
    },
  );

  it("rejects a delta that reopens an earlier message after a later one", async () => {
    const peer = new FakePeer({
      messages: [
        { id: "first", text: "A" },
        { id: "second", text: "B" },
        { id: "first", text: "C" },
      ],
    });
    await expect(
      runCodexChatGptHostRoute(peer, {
        model: "chatgpt",
        cwd: "/private/tmp/farol-route-b",
        prompt: "Check the answer",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
  });

  it.each([
    { observedProvider: "openai" },
    { observedProvider: "farol_next" },
    { observedModel: "gpt-6-astra" },
    { observedModel: "farol-next/chatgpt" },
    { observedModel: "farol/chatgpt" },
  ])(
    "refuses provider/model substitution %j before starting a turn",
    async (observed) => {
      const peer = new FakePeer(observed);
      await expect(
        runCodexChatGptHostRoute(peer, {
          model: "chatgpt",
          cwd: "/private/tmp/farol-route-b",
          prompt: "Say hello",
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("CODEX_CHATGPT_PROVIDER_IDENTITY_CHANGED");
      expect(peer.requests.map((request) => request.method)).toEqual([
        "thread/start",
      ]);
    },
  );

  it("does not accept terminal completion without a prior host delta", async () => {
    await expect(
      runCodexChatGptHostRoute(new FakePeer({ terminalBeforeDelta: true }), {
        model: "chatgpt",
        cwd: "/private/tmp/farol-route-b",
        prompt: "Say hello",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("CODEX_CHATGPT_INCREMENTAL_DELIVERY_MISSING");
  });

  it("ignores a stale same-thread terminal while correlating the new turn", async () => {
    await expect(
      runCodexChatGptHostRoute(
        new FakePeer({ staleTerminalBeforeTurnResponse: true }),
        {
          model: "chatgpt",
          cwd: "/private/tmp/farol-route-b",
          prompt: "Say hello",
          timeoutMs: 1_000,
        },
      ),
    ).resolves.toMatchObject({
      threadId: "thread-route-b",
      turnId: "turn-route-b",
      deltaCount: 2,
      retainedResult: true,
    });
  });
});
