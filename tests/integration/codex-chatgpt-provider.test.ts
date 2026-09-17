import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startCodexChatGptProvider,
  type CodexChatGptConversation,
  type CodexChatGptProviderRuntime,
} from "../../src/apps/desktop/codex-chatgpt-provider";

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private carry = "";
  readonly events: Readonly<Record<string, unknown>>[] = [];

  constructor(response: Response) {
    if (!response.body) throw new Error("SSE_BODY_MISSING");
    this.reader = response.body.getReader();
  }

  async until(type: string): Promise<Readonly<Record<string, unknown>>> {
    for (;;) {
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error(`SSE_ENDED_BEFORE:${type}`);
      this.carry += this.decoder.decode(chunk.value, { stream: true });
      const frames = this.carry.split("\n\n");
      this.carry = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (!data) continue;
        const event = JSON.parse(data) as Readonly<Record<string, unknown>>;
        this.events.push(event);
        if (event.type === type) return event;
      }
    }
  }
}

function requestBody(model = "farol-next/mind") {
  return {
    model,
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say hello" }],
      },
    ],
    tools: [],
    client_metadata: {
      session_id: "session-route-b",
      thread_id: "thread-route-b",
      turn_id: "turn-route-b",
      root_turn_id: "turn-route-b",
    },
  };
}

describe("Farol Next Codex to ChatGPT provider transport", () => {
  let runtime: CodexChatGptProviderRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("delivers observed text deltas before the terminal host response", async () => {
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const conversation: CodexChatGptConversation = {
      run: vi.fn(async (input, observer) => {
        expect(input).toMatchObject({
          requestedModel: "farol-next/mind",
          prompt: "Say hello",
          identity: {
            sessionId: "session-route-b",
            threadId: "thread-route-b",
            turnId: "turn-route-b",
            rootTurnId: "turn-route-b",
          },
          tools: [],
        });
        await observer.onTextDelta({
          sequence: 1,
          delta: "Hel",
          text: "Hel",
          observedCharacters: 3,
        });
        await observer.onTextDelta({
          sequence: 2,
          delta: "lo",
          text: "Hello",
          observedCharacters: 5,
        });
        await completionGate;
        return {
          state: "completed" as const,
          code: null,
          outputText: "Hello",
          observedProvider: "chatgpt-web",
          observedModel: "gpt-6-astra",
          observedMode: "high",
        };
      }),
    };
    runtime = await startCodexChatGptProvider({
      model: "farol-next/mind",
      token: "route-b-test-token",
      conversation,
    });

    const response = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = new SseReader(response);

    await expect(stream.until("response.output_text.delta")).resolves.toEqual(
      expect.objectContaining({ delta: "Hel" }),
    );
    await expect(stream.until("response.output_text.delta")).resolves.toEqual(
      expect.objectContaining({ delta: "lo" }),
    );
    expect(
      stream.events.some((event) => event.type === "response.completed"),
    ).toBe(false);

    releaseCompletion();
    await expect(stream.until("response.completed")).resolves.toMatchObject({
      response: {
        model: "farol-next/mind",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello" }],
          },
        ],
      },
    });
    expect(conversation.run).toHaveBeenCalledTimes(1);
  });

  it("refuses unauthenticated and unsupported-model requests before dispatch", async () => {
    const conversation: CodexChatGptConversation = {
      run: vi.fn(),
    };
    runtime = await startCodexChatGptProvider({
      model: "farol-next/mind",
      token: "route-b-test-token",
      conversation,
    });

    const unauthenticated = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    });
    expect(unauthenticated.status).toBe(401);

    const unsupported = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody("farol-next/unknown")),
    });
    expect(unsupported.status).toBe(422);
    await expect(unsupported.json()).resolves.toEqual({
      error: { code: "FAROL_NEXT_MODEL_UNAVAILABLE" },
    });
    expect(conversation.run).not.toHaveBeenCalled();
  });

  it("publishes only the configured Next model in the local catalogue", async () => {
    runtime = await startCodexChatGptProvider({
      model: "farol-next/mind",
      token: "route-b-test-token",
      conversation: { run: vi.fn() },
    });

    const response = await fetch(`${runtime.baseUrl}/v1/models`, {
      headers: { authorization: "Bearer route-b-test-token" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: "list",
      data: [
        expect.objectContaining({
          id: "farol-next/mind",
          object: "model",
          owned_by: "farol-next",
          slug: "farol-next/mind",
          display_name: "Farol Next Mind",
          shell_type: "unified_exec",
          supported_reasoning_levels: [
            expect.objectContaining({ effort: "low" }),
          ],
          default_reasoning_level: "low",
          supported_in_api: true,
        }),
      ],
    });
  });
});
