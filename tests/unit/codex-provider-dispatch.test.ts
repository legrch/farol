import { EventEmitter, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startCodexChatGptProvider,
  type CodexChatGptProviderRuntime,
} from "../../src/apps/desktop/codex-chatgpt-provider";

// Execute the real provider request handler with deterministic stream pressure.
// No socket is created: this is unit evidence, not the blocked HTTP/native gate.
const transport = vi.hoisted(() => ({
  handler: null as
    null | ((request: IncomingMessage, response: ServerResponse) => void),
}));
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    createServer: (handler: typeof transport.handler) => {
      transport.handler = handler;
      const server = Object.assign(new EventEmitter(), {
        listening: false,
        listen() {
          server.listening = true;
          queueMicrotask(() => server.emit("listening"));
        },
        address: () => ({ port: 1 }),
        closeAllConnections() {},
        close() {
          server.listening = false;
          queueMicrotask(() => server.emit("close"));
        },
      });
      return server;
    },
  };
});

class ResponseFixture extends EventEmitter {
  statusCode = 0;
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  readonly chunks: string[] = [];
  blocked = false;
  constructor(private readonly blockEvent: string | null = null) {
    super();
  }
  writeHead(status: number) {
    this.statusCode = status;
    this.headersSent = true;
  }
  flushHeaders() {}
  write(value: string) {
    this.chunks.push(value);
    if (
      !this.blocked &&
      this.blockEvent &&
      value.startsWith(`event: ${this.blockEvent}\n`)
    ) {
      this.blocked = true;
      return false;
    }
    return true;
  }
  end(value = "") {
    if (value) this.chunks.push(value);
    this.writableEnded = true;
    this.emit("finish");
  }
  events(): Record<string, unknown>[] {
    return this.chunks
      .filter((chunk) => chunk.startsWith("event: "))
      .map((chunk) => JSON.parse(chunk.split("\ndata: ")[1]!));
  }
}

const token = "provider-dispatch-fixture-token";
let runtime: CodexChatGptProviderRuntime | null = null;
afterEach(async () => {
  await runtime?.close();
  runtime = null;
});

function post(
  body: unknown,
  response: ResponseFixture,
  endpoint = "/v1/responses",
) {
  const request = Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url: endpoint,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  transport.handler!(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  );
}

const tool = {
  type: "function",
  name: "fixture_read",
  description: "Synthetic read only.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  strict: true,
};
const body = {
  model: "chatgpt",
  stream: true,
  input: "Synthetic bounded task.",
  tools: [tool],
  client_metadata: {
    session_id: "session",
    thread_id: "thread",
    turn_id: "turn",
    root_turn_id: "turn",
  },
};
const completed = {
  state: "completed" as const,
  code: null,
  outputText: "Public answer",
  observedProvider: "chatgpt-web",
  observedModel: null,
  observedMode: null,
};

describe("provider dispatch without a listening transport", () => {
  it("delivers one executable call when the same queued turn is not cancelled", async () => {
    const response = new ResponseFixture("response.output_text.delta");
    runtime = await startCodexChatGptProvider({
      model: body.model,
      token,
      turns: { admit: async () => "admitted", release: async () => {} },
      conversation: {
        run: async (_input, observer) => {
          const visible = observer.onVisibleItem!({
            sequence: 1,
            id: "answer",
            channel: "answer",
            text: completed.outputText,
          });
          const requested = observer
            .onToolCall({ name: "fixture_read", arguments: {} })
            .catch(() => "");
          await Promise.allSettled([visible, requested]);
          return completed;
        },
      },
    });
    const finished = once(response, "finish");
    post(body, response);
    await vi.waitFor(() => expect(response.blocked).toBe(true));
    response.emit("drain");
    await finished;
    const events = response.events();
    expect(
      events.filter(
        (event) =>
          event.type === "response.output_item.done" &&
          (event.item as { type?: string })?.type === "function_call",
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "response.completed"),
    ).toHaveLength(1);
  });

  it.each([
    "response.output_text.delta",
    "response.output_text.done",
    "response.function_call_arguments.delta",
  ])(
    "does not emit a completed executable call after cancel during %s pressure",
    async (blockedEvent) => {
      const response = new ResponseFixture(blockedEvent);
      let toolRejected = false;
      runtime = await startCodexChatGptProvider({
        model: body.model,
        token,
        turns: { admit: async () => "admitted", release: async () => {} },
        conversation: {
          run: async (_input, observer) => {
            const visible = observer.onVisibleItem!({
              sequence: 1,
              id: "answer",
              channel: "answer",
              text: completed.outputText,
            });
            const requested = observer
              .onToolCall({ name: "fixture_read", arguments: {} })
              .catch(() => {
                toolRejected = true;
                return "";
              });
            await Promise.allSettled([visible, requested]);
            return completed;
          },
        },
      });
      const finished = once(response, "finish");
      post(body, response);
      await vi.waitFor(() => expect(response.blocked).toBe(true));
      await runtime.close();
      response.emit("drain");
      await finished;
      expect(toolRejected).toBe(true);
      const events = response.events();
      expect(
        events.some(
          (event) =>
            event.type === "response.output_item.done" &&
            (event.item as { type?: string })?.type === "function_call",
        ),
      ).toBe(false);
      expect(events.some((event) => event.type === "response.completed")).toBe(
        false,
      );
      if (blockedEvent !== "response.function_call_arguments.delta") {
        expect(
          events.some(
            (event) =>
              (event.item as { type?: string })?.type === "function_call",
          ),
        ).toBe(false);
      }
    },
  );

  it.each(["/v1/responses/compact", "/v1/responses"])(
    "refuses stale compaction aliases before its adapter at %s",
    async (endpoint) => {
      const compact = vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "HOST_COMPACTION_REQUEST_INVALID" as const,
          retry: "never" as const,
        },
      }));
      const admit = vi.fn(async () => "admitted" as const);
      runtime = await startCodexChatGptProvider({
        model: body.model,
        token,
        turns: { admit, release: async () => {} },
        conversation: { run: async () => completed },
        compaction: { compact },
      });
      for (const model of [
        "legacy-route/mind",
        "legacy-route/drive",
        "legacy-route/chatgpt",
        "farol/chatgpt",
        "chatgpt-release-a",
        "deepseek",
        "other",
        null,
        undefined,
      ]) {
        const response = new ResponseFixture();
        const finished = once(response, "finish");
        post(
          { model, stream: true, input: [{ type: "compaction_trigger" }] },
          response,
          endpoint,
        );
        await finished;
        expect(response.statusCode).toBe(422);
        expect(JSON.parse(response.chunks.join(""))).toEqual({
          error: { code: "FAROL_MODEL_UNAVAILABLE" },
        });
      }
      expect(compact).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
      const selected = new ResponseFixture();
      const finished = once(selected, "finish");
      post(
        {
          model: body.model,
          stream: true,
          input: [{ type: "compaction_trigger" }],
        },
        selected,
        endpoint,
      );
      await finished;
      expect(compact).toHaveBeenCalledTimes(1);
      expect(JSON.parse(selected.chunks.join(""))).toEqual({
        error: { code: "HOST_COMPACTION_REQUEST_INVALID" },
      });
    },
  );
});
