import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import type { Result } from "../../pkg/kernel/domain/result";
import {
  HOST_CHECKPOINT_PREFIX,
  isHostCompactionRequestMetadata,
  type HostCompactionEndpoint,
  type HostCompactionErrorCode,
  type HostCompactionHandoff,
} from "../../modules/chat/infra/client/host-compaction-codec";
import {
  canonicalJson,
  CodexNativeToolRegistry,
  type CodexNativeToolRequest,
  type ResolvedCodexNativeToolCall,
} from "./codex-native-tool-registry";
import type {
  ProviderTurnAdmission,
  ProviderTurnJournal,
} from "./provider-turn-journal";

const MAX_REQUEST_BYTES = 1 * 1_024 * 1_024;
const MAX_PROMPT_CHARACTERS = 128 * 1_024;
const MAX_TOOLS = 512;
const MAX_ACTIVE_TURNS = 8;
const MAX_TOOL_OUTPUT_CHARACTERS = 512 * 1_024;
const TURN_LIFETIME_MS = 15 * 60 * 1_000;
const CALL_ID_PREFIX = "farol_next_call_";

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
      onToolCall(request: CodexNativeToolRequest): Promise<string>;
    }>,
  ): Promise<CodexChatGptConversationResult>;
}>;

export type CodexChatGptCompactionErrorCode =
  | HostCompactionErrorCode
  | "FAROL_NEXT_COMPACTION_SOURCE_STORE_FAILED"
  | "FAROL_NEXT_COMPACTION_SOURCE_UNAVAILABLE"
  | "FAROL_NEXT_COMPACTION_SUMMARY_BLOCKED"
  | "FAROL_NEXT_COMPACTION_SUMMARY_OUTCOME_UNKNOWN"
  | "FAROL_NEXT_COMPACTION_STATE_FAILED"
  | "FAROL_NEXT_COMPACTION_RECONCILIATION_FAILED";

export type CodexChatGptCompaction = Readonly<{
  compact(
    input: Readonly<{
      endpoint: HostCompactionEndpoint;
      body: unknown;
      metadataHeader: string | undefined;
    }>,
  ): Promise<Result<HostCompactionHandoff, CodexChatGptCompactionErrorCode>>;
  prepareTurn?(
    input: Readonly<{ body: unknown }>,
  ): Promise<
    Result<
      Readonly<{ trustedContext: string | null }>,
      CodexChatGptCompactionErrorCode
    >
  >;
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
    activeTurns: number;
    toolCalls: number;
    compactionRequests: number;
    lastRefusalCode: string | null;
    lastInputKinds: readonly string[];
    lastMetadataKeys: readonly string[];
    lastTurnMetadataKeys: readonly string[];
    lastCompactionMarkerKind: string;
    lastCompactionMarkerShape: readonly string[];
    lastRequestKindCompaction: boolean;
    lastRequestKindShape: readonly string[];
  }>;
  close(): Promise<void>;
}>;

type ProviderOptions = Readonly<{
  model: string;
  token: string;
  conversation: CodexChatGptConversation;
  compaction?: CodexChatGptCompaction;
  // Durable identity of every admitted initial request; see EV-05 in
  // handleResponses.
  turns: ProviderTurnJournal;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactionTrigger(candidate: unknown): boolean {
  return (
    record(candidate) &&
    Object.keys(candidate).length === 1 &&
    candidate.type === "compaction_trigger"
  );
}

function streamedCompactionRequest(candidate: unknown): boolean {
  return (
    record(candidate) &&
    Array.isArray(candidate.input) &&
    (compactionTrigger(candidate.input.at(-1)) ||
      embeddedCompactionRequest(candidate))
  );
}

function compactionMetadataHeader(
  request: IncomingMessage,
): string | undefined {
  const value = request.headers["x-codex-turn-metadata"];
  return typeof value === "string" ? value : undefined;
}

function inputKinds(candidate: unknown): string[] {
  if (!record(candidate)) return [];
  if (typeof candidate.input === "string") return ["string"];
  if (!Array.isArray(candidate.input)) return [];
  return candidate.input.map((item) =>
    record(item) && typeof item.type === "string" ? item.type : "unknown",
  );
}

function metadataKeys(candidate: unknown): string[] {
  if (!record(candidate) || !record(candidate.client_metadata)) return [];
  return Object.keys(candidate.client_metadata).sort();
}

function decodedTurnMetadata(
  candidate: unknown,
): Record<string, unknown> | null {
  if (!record(candidate) || !record(candidate.client_metadata)) return null;
  const raw = candidate.client_metadata["x-codex-turn-metadata"];
  let decoded: unknown = raw;
  if (typeof raw === "string") {
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return record(decoded) ? decoded : null;
}

function embeddedCompactionRequest(candidate: unknown): boolean {
  return isHostCompactionRequestMetadata(decodedTurnMetadata(candidate));
}

function compactionMarkerKind(candidate: unknown): string {
  const metadata = decodedTurnMetadata(candidate);
  if (!metadata || !("compaction" in metadata)) return "absent";
  if (metadata.compaction === true) return "true";
  if (metadata.compaction === false) return "false";
  return typeof metadata.compaction;
}

function requestKindCompaction(candidate: unknown): boolean {
  return decodedTurnMetadata(candidate)?.request_kind === "compaction";
}

function controlShape(value: unknown): string[] {
  if (
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(value)
  ) {
    return [`string:${value}`];
  }
  if (!record(value)) return [Array.isArray(value) ? "array" : typeof value];
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      if (typeof entry === "boolean") return `${key}:boolean:${entry}`;
      if (
        typeof entry === "string" &&
        [
          "implementation",
          "kind",
          "mode",
          "name",
          "phase",
          "reason",
          "request_type",
          "strategy",
          "trigger",
          "type",
        ].includes(key) &&
        /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(entry)
      ) {
        return `${key}:string:${entry}`;
      }
      if (record(entry)) {
        return `${key}:object:${Object.keys(entry).sort().join(",")}`;
      }
      return `${key}:${Array.isArray(entry) ? "array" : typeof entry}`;
    });
}

function compactionMarkerShape(candidate: unknown): string[] {
  return controlShape(decodedTurnMetadata(candidate)?.compaction);
}

function requestKindShape(candidate: unknown): string[] {
  return controlShape(decodedTurnMetadata(candidate)?.request_kind);
}

function turnMetadataKeys(candidate: unknown): string[] {
  const decoded = decodedTurnMetadata(candidate);
  return decoded ? Object.keys(decoded).sort() : [];
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

function promptFromInput(
  input: string | readonly unknown[],
  trustedContext: string | null,
): string | null {
  if (typeof input === "string") {
    const prompt = trustedContext ? `${trustedContext}\n\n${input}` : input;
    return prompt.length <= MAX_PROMPT_CHARACTERS ? prompt : null;
  }
  const messages = input.flatMap((item) => {
    if (!record(item) || item.type !== "message") return [];
    if (item.role !== "user") return [];
    const content = textFromContent(item.content);
    return content.some((text) => text.includes(HOST_CHECKPOINT_PREFIX))
      ? []
      : content;
  });
  const prompt = [trustedContext, ...messages]
    .filter((part): part is string => part !== null)
    .join("\n\n");
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

type ResponseRequest = z.infer<typeof responseRequestSchema>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}>;

type IssuedToolCall = ResolvedCodexNativeToolCall & {
  callId: string;
  itemId: string;
  result: Deferred<string>;
  outputCanonical: string | null;
};

type TurnEvent =
  | Readonly<{ kind: "tool"; call: IssuedToolCall }>
  | Readonly<{
      kind: "final";
      result: CodexChatGptConversationResult | null;
      code: string | null;
    }>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityFromRequest(
  data: ResponseRequest,
): CodexChatGptTurnInput["identity"] {
  return {
    sessionId: data.client_metadata.session_id,
    threadId: data.client_metadata.thread_id,
    turnId: data.client_metadata.turn_id,
    rootTurnId: data.client_metadata.root_turn_id,
  };
}

function turnKey(identity: CodexChatGptTurnInput["identity"]): string {
  return canonicalJson(identity);
}

function turnTag(identity: CodexChatGptTurnInput["identity"]): string {
  return digest(turnKey(identity)).slice(0, 16);
}

function currentCallPrefix(tag: string): string {
  return `${CALL_ID_PREFIX}${tag}`;
}

function currentCallId(value: unknown, tag: string): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(currentCallPrefix(tag)) &&
    /^farol_next_call_[a-f0-9]{32}$/u.test(value)
  );
}

function currentCallEntry(value: unknown, tag: string): boolean {
  return (
    record(value) &&
    (value.type === "function_call" || value.type === "function_call_output") &&
    currentCallId(value.call_id, tag)
  );
}

function bindingFingerprint(data: ResponseRequest): string {
  return digest(
    canonicalJson({
      model: data.model,
      identity: identityFromRequest(data),
    }),
  );
}

function outputText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length <= MAX_TOOL_OUTPUT_CHARACTERS ? value : null;
  }
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (
      !record(part) ||
      !["input_text", "output_text", "text"].includes(String(part.type)) ||
      typeof part.text !== "string"
    ) {
      return null;
    }
    parts.push(part.text);
  }
  const joined = parts.join("\n");
  return joined.length <= MAX_TOOL_OUTPUT_CHARACTERS ? joined : null;
}

class ResponseRound {
  private readonly responseId = `resp_${randomUUID()}`;
  private readonly messageId = `${this.responseId}_message`;
  private readonly output: Readonly<Record<string, unknown>>[] = [];
  private text = "";
  private textStarted = false;
  private ended = false;

  constructor(
    private readonly response: ServerResponse,
    private readonly model: string,
  ) {}

  async open(): Promise<void> {
    startStream(this.response);
    await writeEvent(this.response, "response.created", {
      type: "response.created",
      response: {
        id: this.responseId,
        model: this.model,
        status: "in_progress",
        output: [],
      },
    });
  }

  async delta(value: string): Promise<void> {
    if (this.ended) throw new Error("FAROL_NEXT_HOST_DELIVERY_LOST");
    if (!this.textStarted) {
      this.textStarted = true;
      await writeEvent(this.response, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.output.length,
        item: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      await writeEvent(this.response, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: this.messageId,
        output_index: this.output.length,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
    }
    this.text += value;
    await writeEvent(this.response, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.messageId,
      output_index: this.output.length,
      content_index: 0,
      delta: value,
    });
  }

  private async finishText(): Promise<void> {
    if (!this.textStarted) return;
    const outputIndex = this.output.length;
    const item = {
      id: this.messageId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: this.text }],
    } as const;
    await writeEvent(this.response, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: this.messageId,
      output_index: outputIndex,
      content_index: 0,
      text: this.text,
    });
    await writeEvent(this.response, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: this.messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: this.text },
    });
    await writeEvent(this.response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    this.output.push(item);
  }

  async completeTool(call: IssuedToolCall): Promise<void> {
    await this.finishText();
    const outputIndex = this.output.length;
    const opening = {
      id: call.itemId,
      type: "function_call",
      call_id: call.callId,
      name: call.name,
      arguments: "",
      ...(call.namespace === null ? {} : { namespace: call.namespace }),
    } as const;
    await writeEvent(this.response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: opening,
    });
    await writeEvent(this.response, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: call.itemId,
      output_index: outputIndex,
      delta: call.encodedArguments,
    });
    await writeEvent(this.response, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: call.itemId,
      output_index: outputIndex,
      arguments: call.encodedArguments,
    });
    const item = {
      ...opening,
      arguments: call.encodedArguments,
      status: "completed",
    } as const;
    await writeEvent(this.response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    this.output.push(item);
    await this.complete();
  }

  async completeFinal(): Promise<void> {
    await this.finishText();
    if (this.output.length < 1) {
      await this.fail("FAROL_NEXT_PROVIDER_RESULT_INVALID");
      return;
    }
    await this.complete();
  }

  private async complete(): Promise<void> {
    await writeEvent(this.response, "response.completed", {
      type: "response.completed",
      response: {
        id: this.responseId,
        model: this.model,
        status: "completed",
        output: this.output,
      },
    });
    this.end();
  }

  async fail(code: string): Promise<void> {
    if (this.ended) return;
    await writeEvent(this.response, "response.failed", {
      type: "response.failed",
      response: {
        id: this.responseId,
        model: this.model,
        status: "failed",
        error: { code },
      },
    });
    this.end();
  }

  private end(): void {
    this.ended = true;
    this.response.end();
  }
}

class ActiveProviderTurn {
  readonly key: string;
  readonly tag: string;
  private readonly binding: string;
  private readonly registry: CodexNativeToolRegistry;
  private readonly events: TurnEvent[] = [];
  private readonly issued = new Map<string, IssuedToolCall>();
  private waiter: Deferred<TurnEvent> | null = null;
  private writer: ResponseRound | null = null;
  private pending: IssuedToolCall | null = null;
  private sequence = 0;
  private text = "";
  private state: "created" | "running" | "ended" = "created";
  private readonly lifetime: NodeJS.Timeout;

  constructor(
    data: ResponseRequest,
    private readonly input: CodexChatGptTurnInput,
    private readonly conversation: CodexChatGptConversation,
    private readonly onToolCallObserved: () => void,
    private readonly onTerminal: () => void,
  ) {
    this.key = turnKey(input.identity);
    this.tag = turnTag(input.identity);
    this.binding = bindingFingerprint(data);
    this.registry = CodexNativeToolRegistry.parse(data.tools);
    this.lifetime = setTimeout(
      () => this.cancel("FAROL_NEXT_TURN_EXPIRED"),
      TURN_LIFETIME_MS,
    );
    this.lifetime.unref?.();
  }

  hasContinuation(data: ResponseRequest): boolean {
    return (
      Array.isArray(data.input) &&
      data.input.some((entry) => currentCallEntry(entry, this.tag))
    );
  }

  ownsForeignContinuation(data: ResponseRequest): boolean {
    if (!Array.isArray(data.input)) return false;
    return data.input.some(
      (entry) =>
        record(entry) &&
        typeof entry.call_id === "string" &&
        this.issued.has(entry.call_id),
    );
  }

  async serveInitial(response: ServerResponse): Promise<boolean> {
    if (this.state !== "created")
      throw new Error("FAROL_NEXT_TURN_STATE_INVALID");
    const writer = await this.attach(response);
    this.state = "running";
    void Promise.resolve()
      .then(() =>
        this.conversation.run(this.input, {
          onTextDelta: (delta) => this.observeDelta(delta),
          onToolCall: (request) => this.requestTool(request),
        }),
      )
      .then((result) => this.push({ kind: "final", result, code: null }))
      .catch(() =>
        this.push({
          kind: "final",
          result: null,
          code: "FAROL_NEXT_CONVERSATION_FAILED",
        }),
      );
    return this.finishRound(writer);
  }

  async serveContinuation(
    response: ServerResponse,
    data: ResponseRequest,
  ): Promise<boolean> {
    const delivery = this.validateContinuation(data);
    const writer = await this.attach(response);
    const pending = this.pending;
    if (!pending || pending.callId !== delivery.callId) {
      this.detach(writer);
      throw new Error("FAROL_NEXT_CONTINUATION_INVALID");
    }
    pending.outputCanonical = delivery.outputCanonical;
    this.pending = null;
    pending.result.resolve(delivery.output);
    return this.finishRound(writer);
  }

  cancel(code: string): void {
    if (this.state === "ended") return;
    this.state = "ended";
    clearTimeout(this.lifetime);
    this.pending?.result.reject(new Error(code));
    this.pending = null;
    this.push({ kind: "final", result: null, code });
    this.onTerminal();
  }

  private async attach(response: ServerResponse): Promise<ResponseRound> {
    if (this.writer || this.state === "ended") {
      throw new Error("FAROL_NEXT_TURN_STATE_INVALID");
    }
    const writer = new ResponseRound(response, this.input.requestedModel);
    this.writer = writer;
    await writer.open();
    return writer;
  }

  private detach(writer: ResponseRound): void {
    if (this.writer === writer) this.writer = null;
  }

  private async finishRound(writer: ResponseRound): Promise<boolean> {
    try {
      const event = await this.next();
      if (event.kind === "tool") {
        await writer.completeTool(event.call);
        return false;
      }
      const valid =
        event.result !== null &&
        event.result.state === "completed" &&
        event.result.code === null &&
        event.result.outputText === this.text &&
        this.text.length > 0 &&
        this.pending === null;
      if (valid) await writer.completeFinal();
      else {
        await writer.fail(
          event.code ??
            event.result?.code ??
            "FAROL_NEXT_PROVIDER_RESULT_INVALID",
        );
      }
      this.state = "ended";
      clearTimeout(this.lifetime);
      this.onTerminal();
      return true;
    } finally {
      this.detach(writer);
    }
  }

  private async observeDelta(delta: CodexChatGptTextDelta): Promise<void> {
    if (
      this.state !== "running" ||
      delta.sequence !== this.sequence + 1 ||
      delta.observedCharacters !== delta.text.length ||
      delta.text !== `${this.text}${delta.delta}` ||
      !this.writer
    ) {
      throw new Error("FAROL_NEXT_PROVIDER_STREAM_INVALID");
    }
    this.sequence = delta.sequence;
    this.text = delta.text;
    await this.writer.delta(delta.delta);
  }

  private async requestTool(request: CodexNativeToolRequest): Promise<string> {
    if (this.state !== "running" || this.pending !== null) {
      throw new Error("FAROL_NEXT_TOOL_CALL_STATE_INVALID");
    }
    const resolved = this.registry.resolve(request);
    const callId = `${currentCallPrefix(this.tag)}${randomBytes(8).toString("hex")}`;
    const call: IssuedToolCall = {
      ...resolved,
      callId,
      itemId: `fc_${randomUUID()}`,
      result: deferred<string>(),
      outputCanonical: null,
    };
    this.issued.set(callId, call);
    this.pending = call;
    this.onToolCallObserved();
    this.push({ kind: "tool", call });
    return call.result.promise;
  }

  private validateContinuation(data: ResponseRequest): Readonly<{
    callId: string;
    output: string;
    outputCanonical: string;
  }> {
    if (this.state !== "running" || !this.pending) {
      throw new Error("FAROL_NEXT_CONTINUATION_STATE_INVALID");
    }
    if (turnKey(identityFromRequest(data)) !== this.key) {
      throw new Error("FAROL_NEXT_CONTINUATION_IDENTITY_INVALID");
    }
    if (bindingFingerprint(data) !== this.binding) {
      throw new Error("FAROL_NEXT_CONTINUATION_BINDING_INVALID");
    }
    if (!Array.isArray(data.input)) {
      throw new Error("FAROL_NEXT_CONTINUATION_INPUT_INVALID");
    }
    const calls = new Map<string, Record<string, unknown>>();
    const outputs = new Map<string, Record<string, unknown>>();
    for (const item of data.input) {
      if (!currentCallEntry(item, this.tag) || !record(item)) continue;
      const callId = String(item.call_id);
      const target = item.type === "function_call" ? calls : outputs;
      if (target.has(callId)) {
        throw new Error("FAROL_NEXT_CONTINUATION_CARDINALITY_INVALID");
      }
      target.set(callId, item);
    }
    if (calls.size !== this.issued.size || outputs.size !== this.issued.size) {
      throw new Error("FAROL_NEXT_CONTINUATION_CARDINALITY_INVALID");
    }
    let pendingOutput: string | null = null;
    let pendingCanonical: string | null = null;
    for (const [callId, issued] of this.issued) {
      const call = calls.get(callId);
      const output = outputs.get(callId);
      if (
        !call ||
        !output ||
        call.id !== issued.itemId ||
        call.name !== issued.name ||
        call.arguments !== issued.encodedArguments ||
        (call.namespace ?? null) !== issued.namespace
      ) {
        throw new Error("FAROL_NEXT_CONTINUATION_CALL_INVALID");
      }
      const normalized = outputText(output.output);
      if (normalized === null) {
        throw new Error("FAROL_NEXT_CONTINUATION_OUTPUT_INVALID");
      }
      const canonical = canonicalJson(output.output);
      if (issued === this.pending) {
        pendingOutput = normalized;
        pendingCanonical = canonical;
      } else if (issued.outputCanonical !== canonical) {
        throw new Error("FAROL_NEXT_CONTINUATION_REPLAY_INVALID");
      }
    }
    if (pendingOutput === null || pendingCanonical === null) {
      throw new Error("FAROL_NEXT_CONTINUATION_OUTPUT_INVALID");
    }
    return {
      callId: this.pending.callId,
      output: pendingOutput,
      outputCanonical: pendingCanonical,
    };
  }

  private push(event: TurnEvent): void {
    if (this.state === "ended" && event.kind !== "final") return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve(event);
    } else {
      this.events.push(event);
    }
  }

  private next(): Promise<TurnEvent> {
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    if (this.waiter) throw new Error("FAROL_NEXT_TURN_STATE_INVALID");
    this.waiter = deferred<TurnEvent>();
    return this.waiter.promise;
  }
}

async function handleResponses(
  raw: unknown,
  response: ServerResponse,
  options: ProviderOptions,
  turns: Map<string, ActiveProviderTurn>,
  onToolCallObserved: () => void,
  onRefusal: (code: string) => void,
): Promise<void> {
  const parsed = responseRequestSchema.safeParse(raw);
  if (!parsed.success) {
    onRefusal("FAROL_NEXT_REQUEST_INVALID");
    refusal(response, 400, "FAROL_NEXT_REQUEST_INVALID");
    return;
  }
  if (parsed.data.model !== options.model) {
    refusal(response, 422, "FAROL_NEXT_MODEL_UNAVAILABLE");
    return;
  }
  const identity = identityFromRequest(parsed.data);
  const key = turnKey(identity);
  const existing = turns.get(key);
  if (existing) {
    if (!existing.hasContinuation(parsed.data)) {
      refusal(response, 409, "FAROL_NEXT_CONTINUATION_REQUIRED");
      return;
    }
    try {
      await existing.serveContinuation(response, parsed.data);
    } catch (error) {
      if (error instanceof Error && !response.headersSent) {
        onRefusal(
          /^FAROL_NEXT_CONTINUATION_[A-Z_]+$/u.test(error.message)
            ? error.message
            : "FAROL_NEXT_CONTINUATION_INVALID",
        );
        refusal(response, 409, "FAROL_NEXT_CONTINUATION_INVALID");
        return;
      }
      existing.cancel("FAROL_NEXT_HOST_DELIVERY_LOST");
      throw error;
    }
    return;
  }
  const tag = turnTag(identity);
  if (
    [...turns.values()].some((turn) =>
      turn.ownsForeignContinuation(parsed.data),
    )
  ) {
    refusal(response, 409, "FAROL_NEXT_CONTINUATION_FOREIGN");
    return;
  }
  if (
    Array.isArray(parsed.data.input) &&
    parsed.data.input.some((entry) => currentCallEntry(entry, tag))
  ) {
    refusal(response, 409, "FAROL_NEXT_CONTINUATION_NOT_FOUND");
    return;
  }
  if (turns.size >= MAX_ACTIVE_TURNS) {
    refusal(response, 503, "FAROL_NEXT_PROVIDER_BUSY");
    return;
  }
  let trustedContext: string | null = null;
  if (options.compaction?.prepareTurn) {
    const prepared = await options.compaction.prepareTurn({
      body: structuredClone(raw),
    });
    if (!prepared.ok) {
      refusal(response, 409, prepared.error.code);
      return;
    }
    trustedContext = prepared.value.trustedContext;
  }
  const prompt = promptFromInput(parsed.data.input, trustedContext);
  if (prompt === null) {
    refusal(response, 422, "FAROL_NEXT_INPUT_UNSUPPORTED");
    return;
  }
  try {
    CodexNativeToolRegistry.parse(parsed.data.tools);
  } catch (error) {
    onRefusal(
      error instanceof Error && /^CODEX_TOOL_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "FAROL_NEXT_TOOL_CATALOGUE_INVALID",
    );
    refusal(response, 422, "FAROL_NEXT_TOOL_CATALOGUE_INVALID");
    return;
  }
  // A host may repeat an initial request after a terminal answer, a lost
  // stream or a restart. The logical request is recorded durably, with its
  // immutable intent, after every local refusal and before anything reaches
  // ChatGPT, so a repeat never starts a second conversation run and the same
  // identity cannot carry a different request. A deliberately new identity
  // with the same text is a new request.
  let admission: ProviderTurnAdmission;
  try {
    admission = await options.turns.admit(
      key,
      digest(
        canonicalJson({
          model: parsed.data.model,
          input: parsed.data.input,
          tools: parsed.data.tools,
        }),
      ),
    );
  } catch {
    onRefusal("FAROL_NEXT_TURN_JOURNAL_UNAVAILABLE");
    refusal(response, 503, "FAROL_NEXT_TURN_JOURNAL_UNAVAILABLE");
    return;
  }
  if (admission !== "admitted") {
    const code =
      admission === "replayed"
        ? "FAROL_NEXT_TURN_ALREADY_SUBMITTED"
        : admission === "conflict"
          ? "FAROL_NEXT_TURN_INTENT_CONFLICT"
          : "FAROL_NEXT_TURN_STATE_UNKNOWN";
    onRefusal(code);
    refusal(response, 409, code);
    return;
  }
  let turn: ActiveProviderTurn;
  try {
    turn = new ActiveProviderTurn(
      parsed.data,
      {
        requestedModel: parsed.data.model,
        prompt,
        identity,
        tools: structuredClone(parsed.data.tools),
      },
      options.conversation,
      onToolCallObserved,
      () => turns.delete(key),
    );
  } catch (error) {
    onRefusal(
      error instanceof Error && /^CODEX_TOOL_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "FAROL_NEXT_TOOL_CATALOGUE_INVALID",
    );
    refusal(response, 422, "FAROL_NEXT_TOOL_CATALOGUE_INVALID");
    return;
  }
  turns.set(key, turn);
  try {
    await turn.serveInitial(response);
  } catch (error) {
    turn.cancel("FAROL_NEXT_HOST_DELIVERY_LOST");
    throw error;
  }
}

async function handleCompaction(
  endpoint: HostCompactionEndpoint,
  raw: unknown,
  request: IncomingMessage,
  response: ServerResponse,
  options: ProviderOptions,
): Promise<void> {
  if (!options.compaction) {
    refusal(response, 501, "FAROL_NEXT_COMPACTION_UNAVAILABLE");
    return;
  }
  const result = await options.compaction.compact({
    endpoint,
    body: structuredClone(raw),
    metadataHeader: compactionMetadataHeader(request),
  });
  if (!result.ok) {
    refusal(response, 422, result.error.code);
    return;
  }
  const handoff = result.value;
  if (
    (endpoint === "responses_compact" &&
      handoff.variant !== "unary_replacement_history") ||
    (endpoint === "responses" && handoff.variant !== "streamed_compaction_item")
  ) {
    refusal(response, 500, "FAROL_NEXT_COMPACTION_RESULT_INVALID");
    return;
  }
  if (handoff.variant === "unary_replacement_history") {
    json(response, 200, handoff.response);
    return;
  }

  const responseId = `resp_${randomUUID()}`;
  startStream(response);
  await writeEvent(response, "response.created", {
    type: "response.created",
    response: {
      id: responseId,
      model: options.model,
      status: "in_progress",
      output: [],
    },
  });
  await writeEvent(response, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: handoff.item,
  });
  await writeEvent(response, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: handoff.item,
  });
  await writeEvent(response, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      model: options.model,
      status: "completed",
      output: [handoff.item],
    },
  });
  response.end();
}

async function readProviderBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>> {
  if (
    request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
  ) {
    refusal(response, 415, "FAROL_NEXT_CONTENT_TYPE_INVALID");
    return { ok: false };
  }
  try {
    return { ok: true, value: await readBody(request) };
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "FAROL_NEXT_REQUEST_INVALID";
    refusal(
      response,
      code === "FAROL_NEXT_REQUEST_TOO_LARGE" ? 413 : 400,
      code,
    );
    return { ok: false };
  }
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
  let toolCalls = 0;
  let compactionRequests = 0;
  let lastRefusalCode: string | null = null;
  let lastInputKinds: string[] = [];
  let lastMetadataKeys: string[] = [];
  let lastTurnMetadataKeys: string[] = [];
  let lastCompactionMarkerKind = "absent";
  let lastCompactionMarkerShape: string[] = [];
  let lastRequestKindCompaction = false;
  let lastRequestKindShape: string[] = [];
  const turns = new Map<string, ActiveProviderTurn>();
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
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/responses" ||
          url.pathname === "/v1/responses/compact")
      ) {
        const body = await readProviderBody(request, response);
        if (!body.ok) return;
        lastInputKinds = inputKinds(body.value);
        lastMetadataKeys = metadataKeys(body.value);
        lastTurnMetadataKeys = turnMetadataKeys(body.value);
        lastCompactionMarkerKind = compactionMarkerKind(body.value);
        lastCompactionMarkerShape = compactionMarkerShape(body.value);
        lastRequestKindCompaction = requestKindCompaction(body.value);
        lastRequestKindShape = requestKindShape(body.value);
        const endpoint =
          url.pathname === "/v1/responses/compact"
            ? "responses_compact"
            : streamedCompactionRequest(body.value)
              ? "responses"
              : null;
        if (endpoint !== null) {
          compactionRequests += 1;
          await handleCompaction(
            endpoint,
            body.value,
            request,
            response,
            options,
          );
          return;
        }
        responseRequests += 1;
        await handleResponses(
          body.value,
          response,
          options,
          turns,
          () => {
            toolCalls += 1;
          },
          (code) => {
            lastRefusalCode = code;
          },
        );
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
      activeTurns: turns.size,
      toolCalls,
      compactionRequests,
      lastRefusalCode,
      lastInputKinds: [...lastInputKinds],
      lastMetadataKeys: [...lastMetadataKeys],
      lastTurnMetadataKeys: [...lastTurnMetadataKeys],
      lastCompactionMarkerKind,
      lastCompactionMarkerShape: [...lastCompactionMarkerShape],
      lastRequestKindCompaction,
      lastRequestKindShape: [...lastRequestKindShape],
    }),
    close: async () => {
      for (const turn of [...turns.values()]) {
        turn.cancel("FAROL_NEXT_PROVIDER_CLOSED");
      }
      turns.clear();
      server.closeAllConnections();
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}
