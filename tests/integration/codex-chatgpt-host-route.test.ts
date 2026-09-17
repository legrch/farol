import { describe, expect, it } from "vitest";

import {
  runCodexChatGptHostRoute,
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
    }> = {},
  ) {}

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return {
        model: this.options.observedModel ?? "farol-next/mind",
        thread: {
          id: "thread-route-b",
          parentThreadId: null,
          modelProvider: this.options.observedProvider ?? "farol_next",
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
        this.notify("item/agentMessage/delta", {
          threadId: "thread-route-b",
          turnId: "turn-route-b",
          itemId: "message-route-b",
          delta: "Hel",
        });
        this.notify("item/agentMessage/delta", {
          threadId: "thread-route-b",
          turnId: "turn-route-b",
          itemId: "message-route-b",
          delta: "lo",
        });
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
          model: "farol-next/mind",
          modelProvider: "farol_next",
          turns: [
            {
              id: "turn-route-b",
              status: "completed",
              items: [
                {
                  id: "message-route-b",
                  type: "agentMessage",
                  text: "Hello",
                },
              ],
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
  it("starts the exact custom provider without relying on the built-in model list", async () => {
    const peer = new FakePeer();

    await expect(
      runCodexChatGptHostRoute(peer, {
        model: "farol-next/mind",
        cwd: "/private/tmp/farol-route-b",
        prompt: "Say hello",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      requestedProvider: "farol_next",
      observedProvider: "farol_next",
      requestedModel: "farol-next/mind",
      observedModel: "farol-next/mind",
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
          model: "farol-next/mind",
          modelProvider: "farol_next",
          allowProviderModelFallback: false,
          cwd: "/private/tmp/farol-route-b",
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: false,
          dynamicTools: [],
        }),
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

  it("refuses an observed provider or model fallback", async () => {
    await expect(
      runCodexChatGptHostRoute(new FakePeer({ observedProvider: "openai" }), {
        model: "farol-next/mind",
        cwd: "/private/tmp/farol-route-b",
        prompt: "Say hello",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("CODEX_CHATGPT_PROVIDER_IDENTITY_CHANGED");

    await expect(
      runCodexChatGptHostRoute(new FakePeer({ observedModel: "gpt-6-astra" }), {
        model: "farol-next/mind",
        cwd: "/private/tmp/farol-route-b",
        prompt: "Say hello",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("CODEX_CHATGPT_PROVIDER_IDENTITY_CHANGED");
  });

  it("does not accept terminal completion without a prior host delta", async () => {
    await expect(
      runCodexChatGptHostRoute(new FakePeer({ terminalBeforeDelta: true }), {
        model: "farol-next/mind",
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
          model: "farol-next/mind",
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
