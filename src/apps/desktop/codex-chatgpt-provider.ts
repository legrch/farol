import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";

const MAX_REQUEST_BYTES = 1 * 1_024 * 1_024;
const MAX_PROMPT_CHARACTERS = 128 * 1_024;
const MAX_TOOLS = 512;

const identitySchema = z
  .object({
    session_id: z.string().min(1).max(160),
    thread_id: z.string().min(1).max(160),
    turn_id: z.string().min(1).max(160),
    root_turn_id: z.string().min(1).max(160),
  })
  .passthrough();

const responseRequestSchema = z
  .object({
    model: z.string().min(1).max(160),
    stream: z.literal(true),
    store: z.literal(false).optional(),
    input: z.union([z.string(), z.array(z.unknown())]),
    tools: z.array(z.unknown()).max(MAX_TOOLS),
    client_metadata: identitySchema,
    previous_response_id: z.null().optional(),
  })
  .passthrough();

export type CodexChatGptTextDelta = Readonly<{
  sequence: number;
  delta: string;
  text: string;
  observedCharacters: number;
}>;

export type CodexChatGptTurnInput = Readonly<{
  requestedModel: string;
  prompt: string;
  identity: Readonly<{
    sessionId: string;
    threadId: string;
    turnId: string;
    rootTurnId: string;
  }>;
  tools: readonly unknown[];
}>;

export type CodexChatGptConversationResult = Readonly<{
  state: "completed" | "failed_before_submit" | "outcome_unknown";
  code: string | null;
  outputText: string;
  observedProvider: string | null;
  observedModel: string | null;
  observedMode: string | null;
}>;

export type CodexChatGptConversation = Readonly<{
  run(
    input: CodexChatGptTurnInput,
    observer: Readonly<{
      onTextDelta(delta: CodexChatGptTextDelta): void | Promise<void>;
    }>,
  ): Promise<CodexChatGptConversationResult>;
}>;

export type CodexChatGptProviderRuntime = Readonly<{
  providerId: "farol-next";
  model: string;
  port: number;
  baseUrl: string;
  diagnostics(): Readonly<{
    modelRequests: number;
    responseRequests: number;
    unauthorizedRequests: number;
    failedRequests: number;
  }>;
  close(): Promise<void>;
}>;

type ProviderOptions = Readonly<{
  model: string;
  token: string;
  conversation: CodexChatGptConversation;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const supplied = Buffer.from(request.headers.authorization ?? "", "utf8");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

function json(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(encoded);
}

function refusal(response: ServerResponse, status: number, code: string): void {
  json(response, status, { error: { code } });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("FAROL_NEXT_REQUEST_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("FAROL_NEXT_REQUEST_INVALID");
  }
}

function textFromContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!record(part) || typeof part.text !== "string") return [];
    return [part.text];
  });
}

function promptFromInput(input: string | readonly unknown[]): string | null {
  if (typeof input === "string") {
    return input.length <= MAX_PROMPT_CHARACTERS ? input : null;
  }
  const messages = input.flatMap((item) => {
    if (!record(item) || item.type !== "message") return [];
    if (item.role !== "user") return [];
    return textFromContent(item.content);
  });
  const prompt = messages.join("\n\n");
  return prompt.length > 0 && prompt.length <= MAX_PROMPT_CHARACTERS
    ? prompt
    : null;
}

async function writeChunk(
  response: ServerResponse,
  value: string,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error("FAROL_NEXT_HOST_DELIVERY_LOST");
  }
  if (response.write(value)) return;
  await Promise.race([
    once(response, "drain"),
    once(response, "close").then(() => {
      throw new Error("FAROL_NEXT_HOST_DELIVERY_LOST");
    }),
  ]);
}

async function writeEvent(
  response: ServerResponse,
  event: string,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeChunk(
    response,
    `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`,
  );
}

function startStream(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
}

function modelCatalogue(model: string): Readonly<Record<string, unknown>> {
  const profile = model.endsWith("/drive") ? "Drive" : "Mind";
  return {
    id: model,
    object: "model",
    owned_by: "farol-next",
    slug: model,
    display_name: `Farol Next ${profile}`,
    description:
      "The owner's separately authenticated ChatGPT through the isolated Farol Next provider route. Native host tools stay under the selected host task's registry and permissions.",
    supported_reasoning_levels: [
      {
        effort: "low",
        description:
          "Bounded transport check. The observed ChatGPT model and mode are verified separately before a live readiness claim.",
      },
    ],
    default_reasoning_level: "low",
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 100,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 8192 },
    experimental_supported_tools: [],
    base_instructions:
      "Use the isolated Farol Next provider route selected for this task. Keep native tools under the host task's own sandbox, approvals, and exact registry. Never switch provider or model silently.",
  };
}

async function streamResponse(
  response: ServerResponse,
  input: CodexChatGptTurnInput,
  conversation: CodexChatGptConversation,
): Promise<void> {
  const responseId = `resp_${randomUUID()}`;
  const itemId = `${responseId}_message`;
  startStream(response);
  await writeEvent(response, "response.created", {
    type: "response.created",
    response: {
      id: responseId,
      model: input.requestedModel,
      status: "in_progress",
      output: [],
    },
  });
  await writeEvent(response, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  });
  await writeEvent(response, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  let sequence = 0;
  let outputText = "";
  let deliveryLost = false;
  const result = await conversation.run(input, {
    onTextDelta: async (delta) => {
      if (
        delta.sequence !== sequence + 1 ||
        delta.observedCharacters !== delta.text.length ||
        delta.text !== `${outputText}${delta.delta}`
      ) {
        throw new Error("FAROL_NEXT_PROVIDER_STREAM_INVALID");
      }
      sequence = delta.sequence;
      outputText = delta.text;
      if (deliveryLost) return;
      try {
        await writeEvent(response, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: delta.delta,
        });
      } catch {
        deliveryLost = true;
      }
    },
  });

  if (deliveryLost || response.destroyed || response.writableEnded) return;
  if (
    result.state !== "completed" ||
    result.code !== null ||
    result.outputText !== outputText ||
    outputText.length === 0
  ) {
    await writeEvent(response, "response.failed", {
      type: "response.failed",
      response: {
        id: responseId,
        model: input.requestedModel,
        status: "failed",
        error: {
          code: result.code ?? "FAROL_NEXT_PROVIDER_RESULT_INVALID",
        },
      },
    });
    response.end();
    return;
  }

  const outputItem = {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: outputText }],
  } as const;
  await writeEvent(response, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text: outputText,
  });
  await writeEvent(response, "response.content_part.done", {
    type: "response.content_part.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: outputText },
  });
  await writeEvent(response, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: outputItem,
  });
  await writeEvent(response, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      model: input.requestedModel,
      status: "completed",
      output: [outputItem],
    },
  });
  response.end();
}

async function handleResponses(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProviderOptions,
): Promise<void> {
  if (
    request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
  ) {
    refusal(response, 415, "FAROL_NEXT_CONTENT_TYPE_INVALID");
    return;
  }
  let raw: unknown;
  try {
    raw = await readBody(request);
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "FAROL_NEXT_REQUEST_INVALID";
    refusal(
      response,
      code === "FAROL_NEXT_REQUEST_TOO_LARGE" ? 413 : 400,
      code,
    );
    return;
  }
  const parsed = responseRequestSchema.safeParse(raw);
  if (!parsed.success) {
    refusal(response, 400, "FAROL_NEXT_REQUEST_INVALID");
    return;
  }
  if (parsed.data.model !== options.model) {
    refusal(response, 422, "FAROL_NEXT_MODEL_UNAVAILABLE");
    return;
  }
  const prompt = promptFromInput(parsed.data.input);
  if (prompt === null) {
    refusal(response, 422, "FAROL_NEXT_INPUT_UNSUPPORTED");
    return;
  }
  await streamResponse(
    response,
    {
      requestedModel: parsed.data.model,
      prompt,
      identity: {
        sessionId: parsed.data.client_metadata.session_id,
        threadId: parsed.data.client_metadata.thread_id,
        turnId: parsed.data.client_metadata.turn_id,
        rootTurnId: parsed.data.client_metadata.root_turn_id,
      },
      tools: structuredClone(parsed.data.tools),
    },
    options.conversation,
  );
}

export async function startCodexChatGptProvider(
  options: ProviderOptions,
): Promise<CodexChatGptProviderRuntime> {
  if (
    !/^farol-next\/[a-z][a-z0-9-]{0,31}$/u.test(options.model) ||
    options.token.length < 16 ||
    options.token.length > 512 ||
    /[\r\n]/u.test(options.token)
  ) {
    throw new Error("FAROL_NEXT_PROVIDER_OPTIONS_INVALID");
  }

  let modelRequests = 0;
  let responseRequests = 0;
  let unauthorizedRequests = 0;
  let failedRequests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!authorized(request, options.token)) {
        unauthorizedRequests += 1;
        refusal(response, 401, "FAROL_NEXT_PROVIDER_UNAUTHORIZED");
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        modelRequests += 1;
        json(response, 200, {
          object: "list",
          data: [modelCatalogue(options.model)],
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        responseRequests += 1;
        await handleResponses(request, response, options);
        return;
      }
      refusal(response, 404, "FAROL_NEXT_PROVIDER_NOT_FOUND");
    })().catch(() => {
      failedRequests += 1;
      if (!response.headersSent) {
        refusal(response, 500, "FAROL_NEXT_PROVIDER_FAILED");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("FAROL_NEXT_PROVIDER_BIND_FAILED");
  }
  const port = address.port;
  return {
    providerId: "farol-next",
    model: options.model,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    diagnostics: () => ({
      modelRequests,
      responseRequests,
      unauthorizedRequests,
      failedRequests,
    }),
    close: async () => {
      server.closeAllConnections();
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}
