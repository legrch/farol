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

function toolRequestBody() {
  return {
    ...requestBody(),
    tools: [
      {
        type: "function",
        name: "exec_command",
        description: "Run one command through the exact native host registry.",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string", minLength: 1 } },
          required: ["cmd"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
  };
}

function compactionHistory() {
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Keep the latest constraint." }],
    },
  ];
}

function compactionMetadata() {
  return JSON.stringify({
    thread_id: "thread-route-b",
    turn_id: "turn-compact-1",
  });
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

  it("round-trips one exact native tool call before resuming the same conversation", async () => {
    let observedToolOutput = "";
    const conversation: CodexChatGptConversation = {
      run: vi.fn(async (_input, observer) => {
        observedToolOutput = await observer.onToolCall({
          name: "exec_command",
          arguments: { cmd: "printf FAROL_NEXT_NATIVE_TOOL_OK" },
        });
        await observer.onTextDelta({
          sequence: 1,
          delta: "Tool result retained.",
          text: "Tool result retained.",
          observedCharacters: 21,
        });
        return {
          state: "completed" as const,
          code: null,
          outputText: "Tool result retained.",
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

    const initialBody = toolRequestBody();
    const initial = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(initialBody),
    });
    const initialStream = new SseReader(initial);
    const toolTerminal = await initialStream.until("response.completed");
    const toolCall = (
      toolTerminal.response as { output: Readonly<Record<string, unknown>>[] }
    ).output[0];
    expect(toolCall).toMatchObject({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "printf FAROL_NEXT_NATIVE_TOOL_OK" }),
      call_id: expect.stringMatching(/^farol_next_call_[a-f0-9]{32}$/u),
    });
    expect(observedToolOutput).toBe("");

    const continuationBody = {
      ...initialBody,
      input: [
        ...initialBody.input,
        toolCall,
        {
          type: "function_call_output",
          call_id: toolCall?.call_id,
          output: "FAROL_NEXT_NATIVE_TOOL_OK",
        },
      ],
    };
    const foreign = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...continuationBody,
        client_metadata: {
          ...continuationBody.client_metadata,
          turn_id: "turn-route-foreign",
          root_turn_id: "turn-route-foreign",
        },
      }),
    });
    expect(foreign.status).toBe(409);
    await expect(foreign.json()).resolves.toEqual({
      error: { code: "FAROL_NEXT_CONTINUATION_FOREIGN" },
    });

    const changedCall = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...continuationBody,
        input: continuationBody.input.map((item) =>
          item === toolCall
            ? { ...toolCall, arguments: JSON.stringify({ cmd: "changed" }) }
            : item,
        ),
      }),
    });
    expect(changedCall.status).toBe(409);
    await expect(changedCall.json()).resolves.toEqual({
      error: { code: "FAROL_NEXT_CONTINUATION_INVALID" },
    });
    expect(observedToolOutput).toBe("");
    expect(conversation.run).toHaveBeenCalledTimes(1);

    const continuation = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(continuationBody),
    });
    const continuationStream = new SseReader(continuation);
    await expect(
      continuationStream.until("response.output_text.delta"),
    ).resolves.toMatchObject({ delta: "Tool result retained." });
    await expect(
      continuationStream.until("response.completed"),
    ).resolves.toMatchObject({
      response: {
        status: "completed",
        output: [
          expect.objectContaining({
            type: "message",
            content: [{ type: "output_text", text: "Tool result retained." }],
          }),
        ],
      },
    });
    expect(observedToolOutput).toBe("FAROL_NEXT_NATIVE_TOOL_OK");
    expect(conversation.run).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics()).toMatchObject({ responseRequests: 4 });

    const duplicate = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(continuationBody),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      error: { code: "FAROL_NEXT_CONTINUATION_NOT_FOUND" },
    });
    expect(conversation.run).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics()).toMatchObject({
      responseRequests: 5,
      activeTurns: 0,
      toolCalls: 1,
    });
  });

  it("routes unary and streamed host compaction through the summary-only adapter", async () => {
    const conversation: CodexChatGptConversation = { run: vi.fn() };
    const compact = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          variant: "unary_replacement_history" as const,
          response: {
            output: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: "Validated compact context" },
                ],
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          variant: "streamed_compaction_item" as const,
          item: {
            type: "compaction" as const,
            encrypted_content: "farol-next-checkpoint-v1:fixture",
          },
        },
      });
    const options = {
      model: "farol-next/mind",
      token: "route-b-test-token",
      conversation,
      compaction: { compact },
    };
    runtime = await startCodexChatGptProvider(options);

    const unaryBody = {
      model: "farol-next/mind",
      input: compactionHistory(),
    };
    const unary = await fetch(`${runtime.baseUrl}/v1/responses/compact`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
        "x-codex-turn-metadata": compactionMetadata(),
      },
      body: JSON.stringify(unaryBody),
    });
    expect(unary.status).toBe(200);
    await expect(unary.json()).resolves.toEqual({
      output: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Validated compact context" }],
        },
      ],
    });

    const streamedBody = {
      model: "farol-next/mind",
      stream: true,
      input: [...compactionHistory(), { type: "compaction_trigger" }],
    };
    const streamed = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
        "x-codex-turn-metadata": compactionMetadata(),
      },
      body: JSON.stringify(streamedBody),
    });
    expect(streamed.status).toBe(200);
    const stream = new SseReader(streamed);
    await expect(stream.until("response.output_item.done")).resolves.toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "compaction",
        encrypted_content: "farol-next-checkpoint-v1:fixture",
      },
    });
    await expect(stream.until("response.completed")).resolves.toMatchObject({
      response: {
        model: "farol-next/mind",
        status: "completed",
        output: [
          {
            type: "compaction",
            encrypted_content: "farol-next-checkpoint-v1:fixture",
          },
        ],
      },
    });

    expect(compact).toHaveBeenNthCalledWith(1, {
      endpoint: "responses_compact",
      body: unaryBody,
      metadataHeader: compactionMetadata(),
    });
    expect(compact).toHaveBeenNthCalledWith(2, {
      endpoint: "responses",
      body: streamedBody,
      metadataHeader: compactionMetadata(),
    });
    expect(conversation.run).not.toHaveBeenCalled();
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
