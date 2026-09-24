import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startCodexChatGptProvider,
  type CodexChatGptConversation,
  type CodexChatGptProviderRuntime,
} from "../../src/apps/desktop/codex-chatgpt-provider";
import {
  PrivateProviderTurnJournal,
  type ProviderTurnJournal,
} from "../../src/apps/desktop/provider-turn-journal";

function memoryJournal(): ProviderTurnJournal {
  const admitted = new Map<string, string>();
  return {
    admit: async (key, intentSha256) => {
      const existing = admitted.get(key);
      if (existing === undefined) {
        admitted.set(key, intentSha256);
        return "admitted";
      }
      return existing === intentSha256 ? "replayed" : "conflict";
    },
    release: async (key) => {
      admitted.delete(key);
    },
  };
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly pending: Readonly<Record<string, unknown>>[] = [];
  private carry = "";
  readonly events: Readonly<Record<string, unknown>>[] = [];

  constructor(response: Response) {
    if (!response.body) throw new Error("SSE_BODY_MISSING");
    this.reader = response.body.getReader();
  }

  async until(type: string): Promise<Readonly<Record<string, unknown>>> {
    for (;;) {
      while (this.pending.length > 0) {
        const event = this.pending.shift();
        if (!event) continue;
        this.events.push(event);
        if (event.type === type) return event;
      }
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
        this.pending.push(
          JSON.parse(data) as Readonly<Record<string, unknown>>,
        );
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

  it("retains coalesced SSE frames between sequential expectations", async () => {
    const payload = [
      'event: first\ndata: {"type":"first"}\n\n',
      'event: second\ndata: {"type":"second"}\n\n',
    ].join("");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
    );
    const stream = new SseReader(response);

    await expect(stream.until("first")).resolves.toEqual({ type: "first" });
    await expect(stream.until("second")).resolves.toEqual({ type: "second" });
    expect(stream.events).toEqual([{ type: "first" }, { type: "second" }]);
  });

  it("streams visible status, commentary and answer as distinct ordered non-executable items", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime = await startCodexChatGptProvider({
      model: "farol-next/chatgpt",
      token: "visible-output-test-token",
      turns: memoryJournal(),
      conversation: {
        run: async (_input, observer) => {
          await observer.onVisibleItem!({
            sequence: 1,
            id: "status-1",
            channel: "status",
            text: "Reading files",
          });
          await observer.onVisibleItem!({
            sequence: 2,
            id: "comment-1",
            channel: "commentary",
            text: "Found the test.",
          });
          await observer.onVisibleItem!({
            sequence: 3,
            id: "comment-2",
            channel: "commentary",
            text: "Checking the result.",
          });
          await observer.onVisibleItem!({
            sequence: 4,
            id: "answer-1",
            channel: "answer",
            text: "First paragraph.",
          });
          await gate;
          await observer.onVisibleItem!({
            sequence: 5,
            id: "answer-2",
            channel: "answer",
            text: "```go\nprintln(42)\n```",
          });
          return {
            state: "completed",
            code: null,
            outputText: "First paragraph.\n\n```go\nprintln(42)\n```",
            observedProvider: "chatgpt-web",
            observedModel: null,
            observedMode: null,
          };
        },
      },
    });
    const response = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer visible-output-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody("farol-next/chatgpt")),
    });
    const stream = new SseReader(response);
    await expect(
      stream.until("response.reasoning_summary_text.delta"),
    ).resolves.toMatchObject({ delta: "Reading files" });
    await expect(
      stream.until("response.output_text.delta"),
    ).resolves.toMatchObject({ delta: "Found the test." });
    expect(
      stream.events.some((event) => event.type === "response.completed"),
    ).toBe(false);
    release();
    const completed = await stream.until("response.completed");
    expect(completed).toMatchObject({
      response: {
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Reading files" }],
          },
          {
            type: "message",
            phase: "commentary",
            content: [
              {
                type: "output_text",
                text: "Found the test.\n\nChecking the result.",
              },
            ],
          },
          {
            type: "message",
            phase: "final_answer",
            content: [
              {
                type: "output_text",
                text: "First paragraph.\n\n```go\nprintln(42)\n```",
              },
            ],
          },
        ],
      },
    });
    const openings = stream.events.filter(
      (event) => event.type === "response.output_item.added",
    );
    const endings = stream.events.filter(
      (event) => event.type === "response.output_item.done",
    );
    expect(openings.map((event) => event.output_index)).toEqual([0, 1, 2]);
    expect(endings.map((event) => event.output_index)).toEqual([0, 1, 2]);
    expect(openings.map((event) => (event.item as { id: string }).id)).toEqual(
      endings.map((event) => (event.item as { id: string }).id),
    );
    expect(
      stream.events.some(
        (event) => event.type === "response.function_call_arguments.delta",
      ),
    ).toBe(false);
    expect(runtime.diagnostics().toolCalls).toBe(0);
  });

  it.each(["duplicate", "sequence", "mixed", "status-only"])(
    "refuses invalid visible output: %s",
    async (kind) => {
      runtime = await startCodexChatGptProvider({
        model: "farol-next/chatgpt",
        token: "visible-output-test-token",
        turns: memoryJournal(),
        conversation: {
          run: async (_input, observer) => {
            await observer.onVisibleItem!({
              sequence: 1,
              id: "one",
              channel: "status",
              text: "Working",
            });
            if (kind === "mixed") {
              await observer.onTextDelta({
                sequence: 2,
                delta: "Answer",
                text: "Answer",
                observedCharacters: 6,
              });
            } else if (kind !== "status-only") {
              await observer.onVisibleItem!({
                sequence: kind === "sequence" ? 3 : 2,
                id: kind === "duplicate" ? "one" : "two",
                channel: "answer",
                text: "Answer",
              });
            }
            return {
              state: "completed",
              code: null,
              outputText: "",
              observedProvider: "chatgpt-web",
              observedModel: null,
              observedMode: null,
            };
          },
        },
      });
      const response = await fetch(`${runtime.baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer visible-output-test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody("farol-next/chatgpt")),
      });
      const body = await response.text();
      expect(body).toContain("response.failed");
      expect(body).not.toContain('"type":"response.completed"');
      expect(runtime.diagnostics().toolCalls).toBe(0);
    },
  );

  it("HR-007 holds an initial request's thread until its first round is served, and releases it after a refusal", async () => {
    const holds: string[] = [];
    let released = 0;
    let releaseRun!: () => void;
    const running = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const conversation: CodexChatGptConversation = {
      run: async (_input, observer) => {
        await running;
        await observer.onTextDelta({
          sequence: 1,
          delta: "Held.",
          text: "Held.",
          observedCharacters: 5,
        });
        return {
          state: "completed" as const,
          code: null,
          outputText: "Held.",
          observedProvider: "chatgpt-web",
          observedModel: null,
          observedMode: null,
        };
      },
    };
    runtime = await startCodexChatGptProvider({
      model: "farol-next/mind",
      token: "route-b-test-token",
      conversation,
      turns: memoryJournal(),
      threads: {
        hold: (identity) => {
          holds.push(identity.threadId);
          return () => {
            released += 1;
          };
        },
      },
    });
    const post = (body: unknown) =>
      fetch(`${runtime!.baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer route-b-test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const first = post(requestBody());
    await vi.waitFor(() => expect(holds).toEqual(["thread-route-b"]));
    expect(released).toBe(0);
    releaseRun();
    expect(await (await first).text()).toContain("response.completed");
    expect(released).toBe(1);

    // Refused before the hold: no hold, nothing to release.
    const wrongModel = await post(requestBody("farol-next/other"));
    expect(wrongModel.status).toBe(422);
    expect(holds).toHaveLength(1);
    // Refused after the hold, before anything runs: released again.
    const replayed = await post(requestBody());
    expect(replayed.status).toBe(409);
    await expect(replayed.json()).resolves.toEqual({
      error: { code: "FAROL_NEXT_TURN_ALREADY_SUBMITTED" },
    });
    expect(holds).toHaveLength(2);
    expect(released).toBe(2);
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
      turns: memoryJournal(),
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

  it.each([false, true])(
    "queues display output across a real tool-response boundary (cancel=%s)",
    async (cancel) => {
      let toolResult = "";
      let displayDelivered = false;
      let runSettled = false;
      runtime = await startCodexChatGptProvider({
        model: "farol-next/mind",
        token: "route-b-test-token",
        turns: memoryJournal(),
        conversation: {
          run: async (_input, observer) => {
            try {
              await observer.onVisibleItem!({
                sequence: 1,
                id: "commentary",
                channel: "commentary",
                text: "Starting one tool.",
              });
              const pendingTool = observer.onToolCall({
                name: "exec_command",
                arguments: { cmd: "printf FIXTURE" },
              });
              // A browser may observe progress while the separate MCP caller
              // waits for Codex. That display must not interleave the tool's
              // terminal frame, disappear, or initiate another execution.
              const pendingDisplay = observer.onVisibleItem!({
                sequence: 2,
                id: "progress",
                channel: "status",
                text: "Tool is running",
              });
              const [output] = await Promise.all([pendingTool, pendingDisplay]);
              toolResult = output;
              displayDelivered = true;
              await observer.onVisibleItem!({
                sequence: 3,
                id: "answer",
                channel: "answer",
                text: "Tool complete.",
              });
              return {
                state: "completed",
                code: null,
                outputText: "Tool complete.",
                observedProvider: "chatgpt-web",
                observedModel: null,
                observedMode: null,
              };
            } finally {
              runSettled = true;
            }
          },
        },
      });
      const post = (body: unknown) =>
        fetch(`${runtime!.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer route-b-test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const body = toolRequestBody();
      const initial = new SseReader(await post(body));
      const completed = await initial.until("response.completed");
      const output = (
        completed.response as { output: Record<string, unknown>[] }
      ).output;
      expect(output.map((item) => item.type)).toEqual([
        "message",
        "function_call",
      ]);
      const call = output[1]!;
      expect(displayDelivered).toBe(false);
      expect(toolResult).toBe("");
      expect(
        initial.events.some(
          (event) => event.type === "response.reasoning_summary_text.delta",
        ),
      ).toBe(false);
      if (cancel) {
        await runtime.close();
        await vi.waitFor(() => expect(runSettled).toBe(true));
        expect(displayDelivered).toBe(false);
        expect(toolResult).toBe("");
        return;
      }
      const continuation = new SseReader(
        await post({
          ...body,
          tools: [],
          input: [
            call,
            {
              type: "function_call_output",
              call_id: call.call_id,
              output: "FIXTURE",
            },
          ],
        }),
      );
      await expect(
        continuation.until("response.reasoning_summary_text.delta"),
      ).resolves.toMatchObject({ delta: "Tool is running" });
      await expect(
        continuation.until("response.completed"),
      ).resolves.toMatchObject({
        response: {
          output: [
            { type: "reasoning" },
            {
              type: "message",
              phase: "final_answer",
              content: [{ type: "output_text", text: "Tool complete." }],
            },
          ],
        },
      });
      expect(displayDelivered).toBe(true);
      expect(toolResult).toBe("FIXTURE");
      expect(runSettled).toBe(true);
      expect(runtime.diagnostics().toolCalls).toBe(1);
    },
  );

  it("round-trips one exact native tool call before resuming the same conversation", async () => {
    let observedToolOutput = "";
    const prepareTurn = vi.fn().mockResolvedValue({
      ok: true as const,
      value: { trustedContext: null },
    });
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
      turns: memoryJournal(),
      compaction: { compact: vi.fn(), prepareTurn },
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
      tools: [],
      input: [
        toolCall,
        {
          type: "function_call_output",
          call_id: toolCall?.call_id,
          output: "FAROL_NEXT_NATIVE_TOOL_OK",
        },
      ],
      previous_response_id: null,
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
    expect(runtime.diagnostics()).toMatchObject({
      lastRefusalCode: "FAROL_NEXT_CONTINUATION_CALL_INVALID",
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
    expect(prepareTurn).toHaveBeenCalledTimes(1);
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
            id: "cmp_fixture",
            type: "compaction" as const,
            encrypted_content: "farol-next-checkpoint-v1:fixture",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          variant: "streamed_compaction_item" as const,
          item: {
            id: "cmp_fixture_native",
            type: "compaction" as const,
            encrypted_content: "farol-next-checkpoint-v1:fixture-native",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "HOST_COMPACTION_TRIGGER_MISSING" },
      });
    const options = {
      model: "farol-next/mind",
      token: "route-b-test-token",
      conversation,
      compaction: { compact },
      turns: memoryJournal(),
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
        id: "cmp_fixture",
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
            id: "cmp_fixture",
            type: "compaction",
            encrypted_content: "farol-next-checkpoint-v1:fixture",
          },
        ],
      },
    });

    const installedMetadata = JSON.stringify({
      thread_id: "thread-route-b",
      turn_id: "turn-compact-installed",
      compaction: {
        implementation: "responses",
        phase: "standalone_turn",
        reason: "user_requested",
        strategy: "memento",
        trigger: "manual",
      },
      request_kind: "compaction",
    });
    const installedBody = {
      model: "farol-next/mind",
      stream: true,
      input: compactionHistory(),
      tools: [],
      client_metadata: {
        session_id: "session-route-b",
        thread_id: "thread-route-b",
        turn_id: "turn-compact-installed",
        "x-codex-turn-metadata": installedMetadata,
      },
    };
    const installed = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(installedBody),
    });
    expect(installed.status).toBe(200);
    const installedStream = new SseReader(installed);
    await expect(
      installedStream.until("response.output_item.done"),
    ).resolves.toMatchObject({
      item: {
        id: "cmp_fixture_native",
        type: "compaction",
        encrypted_content: "farol-next-checkpoint-v1:fixture-native",
      },
    });

    const unsupportedMetadata = JSON.stringify({
      thread_id: "thread-route-b",
      turn_id: "turn-compact-unsupported",
      compaction: {
        implementation: "responses",
        phase: "standalone_turn",
        reason: "user_requested",
        strategy: "memento",
        trigger: "automatic",
      },
      request_kind: "compaction",
    });
    const unsupportedBody = {
      ...installedBody,
      client_metadata: {
        ...installedBody.client_metadata,
        turn_id: "turn-compact-unsupported",
        "x-codex-turn-metadata": unsupportedMetadata,
      },
    };
    const unsupported = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-b-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(unsupportedBody),
    });
    expect(unsupported.status).toBe(422);
    await expect(unsupported.json()).resolves.toEqual({
      error: { code: "HOST_COMPACTION_TRIGGER_MISSING" },
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
    expect(compact).toHaveBeenNthCalledWith(3, {
      endpoint: "responses",
      body: installedBody,
      metadataHeader: undefined,
    });
    expect(compact).toHaveBeenNthCalledWith(4, {
      endpoint: "responses",
      body: unsupportedBody,
      metadataHeader: undefined,
    });
    expect(conversation.run).not.toHaveBeenCalled();
  });

  it("EV-05 runs one logical initial request once across completion, lost delivery and restart", async () => {
    const journalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-provider-turns-"),
    );
    try {
      let hold: Promise<void> | null = null;
      const run = vi.fn<CodexChatGptConversation["run"]>(
        async (_input, observer) => {
          await observer.onTextDelta({
            sequence: 1,
            delta: "Hello",
            text: "Hello",
            observedCharacters: 5,
          });
          if (hold) await hold;
          return {
            state: "completed",
            code: null,
            outputText: "Hello",
            observedProvider: "chatgpt-web",
            observedModel: "gpt-6-astra",
            observedMode: "high",
          };
        },
      );
      const start = () =>
        startCodexChatGptProvider({
          model: "farol-next/mind",
          token: "route-b-test-token",
          conversation: { run },
          turns: new PrivateProviderTurnJournal({ root: journalRoot }),
        });
      const post = (body: unknown, signal?: AbortSignal) =>
        fetch(`${runtime?.baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer route-b-test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      const withTurn = (turnId: string, text = "Say hello") => ({
        ...requestBody(),
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        ],
        client_metadata: {
          ...requestBody().client_metadata,
          turn_id: turnId,
          root_turn_id: turnId,
        },
      });
      const alreadySubmitted = {
        error: { code: "FAROL_NEXT_TURN_ALREADY_SUBMITTED" },
      };
      runtime = await start();

      // Completed, then the host repeats the same initial request.
      const completed = new SseReader(await post(withTurn("turn-complete")));
      await completed.until("response.completed");
      const repeated = await post(withTurn("turn-complete"));
      expect(repeated.status).toBe(409);
      await expect(repeated.json()).resolves.toEqual(alreadySubmitted);
      expect(run).toHaveBeenCalledTimes(1);

      // The host loses the stream while ChatGPT is still answering.
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      const lost = new SseReader(
        await post(withTurn("turn-lost"), controller.signal),
      );
      await lost.until("response.output_text.delta");
      controller.abort();
      // While the original run is still answering it owns the identity.
      const duringRun = await post(withTurn("turn-lost"));
      expect(duringRun.status).toBe(409);
      release();
      hold = null;
      await vi.waitFor(() =>
        expect(runtime?.diagnostics().activeTurns).toBe(0),
      );
      const afterLoss = await post(withTurn("turn-lost"));
      expect(afterLoss.status).toBe(409);
      await expect(afterLoss.json()).resolves.toEqual(alreadySubmitted);
      expect(run).toHaveBeenCalledTimes(2);

      // A restarted provider still knows both requests.
      await runtime.close();
      runtime = await start();
      for (const turnId of ["turn-complete", "turn-lost"]) {
        const afterRestart = await post(withTurn(turnId));
        expect(afterRestart.status).toBe(409);
        await expect(afterRestart.json()).resolves.toEqual(alreadySubmitted);
      }
      expect(run).toHaveBeenCalledTimes(2);

      // The same identity carrying another request is a conflict, not a run.
      const changed = await post(withTurn("turn-complete", "Say goodbye"));
      expect(changed.status).toBe(409);
      await expect(changed.json()).resolves.toEqual({
        error: { code: "FAROL_NEXT_TURN_INTENT_CONFLICT" },
      });
      expect(run).toHaveBeenCalledTimes(2);

      // A deliberately new request with the same text still runs.
      const fresh = new SseReader(await post(withTurn("turn-fresh")));
      await fresh.until("response.completed");
      expect(run).toHaveBeenCalledTimes(3);

      // The journal keeps digests, never the request text.
      for (const entry of await fs.readdir(journalRoot)) {
        const stored = await fs.readFile(path.join(journalRoot, entry), "utf8");
        expect(stored).not.toContain("hello");
        expect(stored).not.toContain("turn-");
      }
    } finally {
      await fs.rm(journalRoot, { recursive: true, force: true });
    }
  });

  it("refuses unauthenticated and unsupported-model requests before dispatch", async () => {
    const conversation: CodexChatGptConversation = {
      run: vi.fn(),
    };
    runtime = await startCodexChatGptProvider({
      model: "farol-next/mind",
      token: "route-b-test-token",
      conversation,
      turns: memoryJournal(),
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
      turns: memoryJournal(),
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
