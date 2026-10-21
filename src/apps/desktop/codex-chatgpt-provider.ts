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
import type { VisibleOutputItem } from "./chatgpt-visible-output";
import {
  CHATGPT_MODEL_ID,
  FAROL_PROVIDER_ID,
  findFarolModel,
} from "../../pkg/model-route/contract";

import {
  extractGoChatRequestSelection,
  goChatRequestIntentSHA256,
  type GoChatRequestSelection,
  type GoChatResponses,
  type GoChatPreparedInput,
} from "../../../apps/desktop/go-chat-responses.ts";

const visibleItemSchema = z.strictObject({
  sequence: z.number().int().positive(),
  id: z.string().min(1).max(256),
  channel: z.enum(["answer", "commentary", "status"]),
  text: z
    .string()
    .min(1)
    .max(256 * 1_024),
});

const textDeltaSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  delta: z
    .string()
    .min(1)
    .max(256 * 1_024),
  text: z
    .string()
    .min(1)
    .max(256 * 1_024),
  observedCharacters: z
    .number()
    .int()
    .positive()
    .max(256 * 1_024),
});

const MAX_REQUEST_BYTES = 1 * 1_024 * 1_024;
// The longest prompt a Route B turn sends into one ChatGPT message.
export const MAX_PROMPT_CHARACTERS = 128 * 1_024;
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
      onVisibleItem?(item: VisibleOutputItem): void | Promise<void>;
      onToolCall(request: CodexNativeToolRequest): Promise<string>;
    }>,
  ): Promise<CodexChatGptConversationResult>;
}>;

export type CodexChatGptCompactionErrorCode =
  | HostCompactionErrorCode
  | "FAROL_COMPACTION_SOURCE_STORE_FAILED"
  | "FAROL_COMPACTION_SOURCE_UNAVAILABLE"
  | "FAROL_COMPACTION_SUMMARY_BLOCKED"
  | "FAROL_COMPACTION_SUMMARY_OUTCOME_UNKNOWN"
  | "FAROL_COMPACTION_STATE_FAILED"
  | "FAROL_COMPACTION_RECONCILIATION_FAILED"
  | "FAROL_COMPACTION_TURN_ACTIVE";

export type CodexChatGptCompaction = Readonly<{
  compact(
    input: Readonly<{
      endpoint: HostCompactionEndpoint;
      body: unknown;
      metadataHeader: string | undefined;
    }>,
  ): Promise<Result<HostCompactionHandoff, CodexChatGptCompactionErrorCode>>;
  // `delivered` is called once the turn carrying `trustedContext` completed
  // in the conversation, so the same checkpoint is not sent again.
  prepareTurn?(
    input: Readonly<{ body: unknown }>,
  ): Promise<
    Result<
      Readonly<{ trustedContext: string | null; delivered?: () => void }>,
      CodexChatGptCompactionErrorCode
    >
  >;
}>;

export type CodexChatGptProviderRuntime = Readonly<{
  providerId: typeof FAROL_PROVIDER_ID;
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
    lastInputRoles: readonly string[];
    lastInputContentKinds: readonly string[];
    lastToolNames: readonly string[];
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
  conversation?: CodexChatGptConversation;
  // Selected once at startup, before any ActiveProviderTurn is constructed.
  goResponses?: GoChatResponses;
  compaction?: CodexChatGptCompaction;
  // Durable identity of every admitted initial request; see EV-05 in
  // handleResponses.
  turns: ProviderTurnJournal;
  // Marks the thread of an initial request as in use from before its context
  // is prepared until its first round has been served, which is after its
  // durable admission and the start of its conversation run, or until the
  // request is refused first. Releasing twice is harmless.
  threads?: Readonly<{
    hold(identity: CodexChatGptTurnInput["identity"]): (() => void) | null;
  }>;
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

export function streamedCompactionRequest(
  candidate: unknown,
  metadataHeader?: string,
): boolean {
  let headerCompaction = false;
  if (metadataHeader) {
    try {
      headerCompaction = isHostCompactionRequestMetadata(
        JSON.parse(metadataHeader),
      );
    } catch {
      // An unreadable header is not a recognized compaction declaration.
    }
  }
  return (
    headerCompaction ||
    embeddedCompactionRequest(candidate) ||
    (record(candidate) &&
      Array.isArray(candidate.input) &&
      compactionTrigger(candidate.input.at(-1)))
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

function inputRoles(candidate: unknown): string[] {
  if (!record(candidate) || !Array.isArray(candidate.input)) return [];
  return candidate.input.map((item) =>
    record(item) && typeof item.role === "string" ? item.role : "none",
  );
}

function inputContentKinds(candidate: unknown): string[] {
  if (!record(candidate) || !Array.isArray(candidate.input)) return [];
  return candidate.input.flatMap((item, itemIndex) => {
    if (!record(item) || !Array.isArray(item.content)) return [];
    return item.content.map((part, partIndex) => {
      const kind =
        record(part) && typeof part.type === "string" ? part.type : "unknown";
      return `${itemIndex}:${partIndex}:${kind}`;
    });
  });
}

function toolNames(candidate: unknown): string[] {
  if (!record(candidate) || !Array.isArray(candidate.tools)) return [];
  return candidate.tools.map((tool) => {
    if (!record(tool)) return "unknown";
    if (typeof tool.name === "string") return tool.name;
    return typeof tool.type === "string" ? tool.type : "unknown";
  });
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
      throw new Error("FAROL_REQUEST_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("FAROL_REQUEST_INVALID");
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
  // The host resends its whole history with every turn, while the task's
  // ChatGPT conversation already holds everything a previous turn sent. Only
  // the user messages after the last item the conversation produced (an
  // answer, a tool call or a compaction) are this turn's own.
  let turnStart = input.length;
  while (turnStart > 0) {
    const item = input[turnStart - 1];
    if (!record(item) || item.type !== "message" || item.role !== "user") {
      break;
    }
    turnStart -= 1;
  }
  const messages = input.slice(turnStart).flatMap((item) => {
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
    throw new Error("FAROL_HOST_DELIVERY_LOST");
  }
  if (response.write(value)) return;
  await Promise.race([
    once(response, "drain"),
    once(response, "close").then(() => {
      throw new Error("FAROL_HOST_DELIVERY_LOST");
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

export function modelCatalogue(
  model: string,
): Readonly<Record<string, unknown>> {
  const entry = findFarolModel({ provider: FAROL_PROVIDER_ID, model });
  const displayName = entry?.displayName ?? model;
  return {
    id: model,
    object: "model",
    owned_by: FAROL_PROVIDER_ID,
    slug: model,
    display_name: displayName,
    description:
      model === CHATGPT_MODEL_ID
        ? "ChatGPT through Farol. Stable default alias; the upstream selection is verified separately. Native tools retain the host task's permissions."
        : "An explicitly selected Farol model route; native tools retain the host task's permissions.",
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
      "Use the isolated Farol provider route selected for this task. Keep native tools under the host task's own sandbox, approvals, and exact registry. Never switch provider or model silently.",
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
      kind: "visible";
      item: VisibleOutputItem;
      delivered: Deferred<void>;
    }>
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
  private messageId = `${this.responseId}_message`;
  private readonly output: Readonly<Record<string, unknown>>[] = [];
  private text = "";
  private textStarted = false;
  private textPhase: "commentary" | "final_answer" | null = null;
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
    await this.appendText(value, null, false);
  }

  async visible(item: VisibleOutputItem): Promise<void> {
    if (this.ended) throw new Error("FAROL_HOST_DELIVERY_LOST");
    if (item.channel !== "status") {
      await this.appendText(
        item.text,
        item.channel === "answer" ? "final_answer" : "commentary",
        true,
      );
      return;
    }
    await this.finishText();
    const outputIndex = this.output.length;
    const id = `${this.responseId}_status_${outputIndex}`;
    const itemFields = { id, type: "reasoning" } as const;
    const eventFields = {
      item_id: id,
      output_index: outputIndex,
      summary_index: 0,
    };
    await writeEvent(this.response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...itemFields, summary: [] },
    });
    await writeEvent(this.response, "response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      ...eventFields,
      part: { type: "summary_text", text: "" },
    });
    await writeEvent(this.response, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      ...eventFields,
      delta: item.text,
    });
    await writeEvent(this.response, "response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      ...eventFields,
      text: item.text,
    });
    const part = { type: "summary_text", text: item.text } as const;
    await writeEvent(this.response, "response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      ...eventFields,
      part,
    });
    const completed = { ...itemFields, summary: [part] };
    await writeEvent(this.response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: completed,
    });
    this.output.push(completed);
  }

  private async appendText(
    value: string,
    phase: "commentary" | "final_answer" | null,
    separateBlock: boolean,
  ): Promise<void> {
    if (this.ended) throw new Error("FAROL_HOST_DELIVERY_LOST");
    if (this.textStarted && this.textPhase !== phase) await this.finishText();
    const separator = separateBlock && this.textStarted ? "\n\n" : "";
    if (!this.textStarted) {
      this.textPhase = phase;
      this.messageId = `${this.responseId}_message_${this.output.length}`;
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
          ...(phase === null ? {} : { phase }),
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
    const delta = `${separator}${value}`;
    this.text += delta;
    await writeEvent(this.response, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.messageId,
      output_index: this.output.length,
      content_index: 0,
      delta,
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
      ...(this.textPhase === null ? {} : { phase: this.textPhase }),
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
    this.text = "";
    this.textStarted = false;
    this.textPhase = null;
  }

  async completeTool(
    call: IssuedToolCall,
    current: () => boolean,
  ): Promise<void> {
    const requireCurrent = () => {
      if (!current()) throw new Error("FAROL_HOST_DELIVERY_LOST");
    };
    requireCurrent();
    await this.finishText();
    requireCurrent();
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
    requireCurrent();
    await writeEvent(this.response, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: call.itemId,
      output_index: outputIndex,
      delta: call.encodedArguments,
    });
    requireCurrent();
    await writeEvent(this.response, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: call.itemId,
      output_index: outputIndex,
      arguments: call.encodedArguments,
    });
    requireCurrent();
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
    requireCurrent();
    this.output.push(item);
    await this.complete();
  }

  async completeFinal(): Promise<void> {
    await this.finishText();
    if (this.output.length < 1) {
      await this.fail("FAROL_PROVIDER_RESULT_INVALID");
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
  private streamMode: "unset" | "text" | "visible" = "unset";
  private readonly visibleIds = new Set<string>();
  private readonly visibleDeliveries = new Set<Deferred<void>>();
  private visibleCharacters = 0;
  private streamFailure: Error | null = null;
  private state: "created" | "running" | "ended" = "created";
  private readonly lifetime: NodeJS.Timeout;

  constructor(
    data: ResponseRequest,
    private readonly input: CodexChatGptTurnInput,
    private readonly conversation: CodexChatGptConversation,
    private readonly onToolCallObserved: () => void,
    private readonly onTerminal: () => void,
    // Learns how the conversation run ended before the host hears it, so a
    // repeat sent the moment the host learns cannot race the bookkeeping.
    private readonly onSettled: (
      state: CodexChatGptConversationResult["state"],
    ) => Promise<void> = async () => undefined,
  ) {
    this.key = turnKey(input.identity);
    this.tag = turnTag(input.identity);
    this.binding = bindingFingerprint(data);
    this.registry = CodexNativeToolRegistry.parse(data.tools);
    this.lifetime = setTimeout(
      () => this.cancel("FAROL_TURN_EXPIRED"),
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
    if (this.state !== "created") throw new Error("FAROL_TURN_STATE_INVALID");
    let writer: ResponseRound;
    try {
      writer = await this.attach(response);
    } catch (error) {
      // The host went away before the conversation run was started.
      await this.onSettled("failed_before_submit");
      throw error;
    }
    this.state = "running";
    void Promise.resolve()
      .then(() =>
        this.conversation.run(this.input, {
          onTextDelta: (delta) => this.observeDelta(delta),
          onVisibleItem: (item) => this.observeVisibleItem(item),
          onToolCall: (request) => this.requestTool(request),
        }),
      )
      .then(async (result) => {
        // A source adapter may accidentally catch an observer rejection.
        // That cannot turn a damaged stream into successful durable state.
        const invalidResult =
          (result.state === "completed" && !this.validCompletion(result)) ||
          (result.state === "failed_before_submit" &&
            (this.sequence > 0 || this.issued.size > 0));
        const code =
          this.streamFailure?.message ??
          (invalidResult ? "FAROL_PROVIDER_RESULT_INVALID" : null);
        const settled: CodexChatGptConversationResult = code
          ? { ...result, state: "outcome_unknown", code }
          : result;
        await this.onSettled(settled.state);
        this.push({ kind: "final", result: settled, code });
      })
      .catch(() =>
        this.push({
          kind: "final",
          result: null,
          code: "FAROL_CONVERSATION_FAILED",
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
      throw new Error("FAROL_CONTINUATION_INVALID");
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
    for (const delivery of this.visibleDeliveries) {
      delivery.reject(new Error(code));
    }
    this.visibleDeliveries.clear();
    // A blocked stream may still be draining. No queued display or tool call
    // survives cancellation; completeTool also fences already-dequeued calls
    // after every awaited write before any further executable output.
    this.events.length = 0;
    this.push({ kind: "final", result: null, code });
    this.onTerminal();
  }

  private async attach(response: ServerResponse): Promise<ResponseRound> {
    if (this.writer || this.state === "ended") {
      throw new Error("FAROL_TURN_STATE_INVALID");
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
      let event = await this.next();
      while (event.kind === "visible") {
        try {
          if (this.state === "ended") {
            throw new Error("FAROL_HOST_DELIVERY_LOST");
          }
          await writer.visible(event.item);
          event.delivered.resolve();
        } catch (error) {
          event.delivered.reject(
            error instanceof Error
              ? error
              : new Error("FAROL_HOST_DELIVERY_LOST"),
          );
          throw error;
        } finally {
          this.visibleDeliveries.delete(event.delivered);
        }
        event = await this.next();
      }
      if (event.kind === "tool") {
        const call = event.call;
        await writer.completeTool(
          call,
          () =>
            this.state === "running" &&
            this.streamFailure === null &&
            this.pending === call,
        );
        return false;
      }
      const valid = event.result !== null && this.validCompletion(event.result);
      if (valid) await writer.completeFinal();
      else {
        await writer.fail(
          this.streamFailure?.message ??
            event.code ??
            event.result?.code ??
            "FAROL_PROVIDER_RESULT_INVALID",
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

  private validCompletion(result: CodexChatGptConversationResult): boolean {
    return (
      this.state === "running" &&
      this.streamFailure === null &&
      result.state === "completed" &&
      result.code === null &&
      result.outputText === this.text &&
      this.text.length > 0 &&
      this.pending === null
    );
  }

  private failStream(): never {
    this.streamFailure ??= new Error("FAROL_PROVIDER_STREAM_INVALID");
    throw this.streamFailure;
  }

  private async observeDelta(input: CodexChatGptTextDelta): Promise<void> {
    if (this.streamFailure) throw this.streamFailure;
    const parsed = textDeltaSchema.safeParse(input);
    if (!parsed.success) this.failStream();
    const delta = parsed.data;
    if (
      this.state !== "running" ||
      this.streamMode === "visible" ||
      delta.sequence !== this.sequence + 1 ||
      delta.observedCharacters !== delta.text.length ||
      delta.text !== `${this.text}${delta.delta}` ||
      !this.writer
    ) {
      this.failStream();
    }
    this.streamMode = "text";
    this.sequence = delta.sequence;
    this.text = delta.text;
    await this.writer.delta(delta.delta);
  }

  private async observeVisibleItem(input: VisibleOutputItem): Promise<void> {
    if (this.streamFailure) throw this.streamFailure;
    const parsed = visibleItemSchema.safeParse(input);
    if (!parsed.success) this.failStream();
    const item = parsed.data;
    const separator = this.visibleIds.size > 0 ? 2 : 0;
    if (
      this.state !== "running" ||
      this.streamMode === "text" ||
      item.sequence !== this.sequence + 1 ||
      this.visibleIds.has(item.id) ||
      this.visibleIds.size >= 512 ||
      this.visibleCharacters + item.text.length + separator > 256 * 1_024
    ) {
      this.failStream();
    }
    this.streamMode = "visible";
    this.sequence = item.sequence;
    this.visibleIds.add(item.id);
    this.visibleCharacters += item.text.length + separator;
    if (item.channel === "answer") {
      this.text += `${this.text ? "\n\n" : ""}${item.text}`;
    }
    // Display observations and actual tool requests share the same ordered
    // queue. A status arriving while Codex executes a tool waits for the next
    // response round; it cannot interleave SSE writes or execute that tool.
    const delivered = deferred<void>();
    this.visibleDeliveries.add(delivered);
    this.push({ kind: "visible", item, delivered });
    await delivered.promise;
  }

  private async requestTool(request: CodexNativeToolRequest): Promise<string> {
    if (this.streamFailure) throw this.streamFailure;
    if (this.state !== "running" || this.pending !== null) {
      throw new Error("FAROL_TOOL_CALL_STATE_INVALID");
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
      throw new Error("FAROL_CONTINUATION_STATE_INVALID");
    }
    if (turnKey(identityFromRequest(data)) !== this.key) {
      throw new Error("FAROL_CONTINUATION_IDENTITY_INVALID");
    }
    if (bindingFingerprint(data) !== this.binding) {
      throw new Error("FAROL_CONTINUATION_BINDING_INVALID");
    }
    if (!Array.isArray(data.input)) {
      throw new Error("FAROL_CONTINUATION_INPUT_INVALID");
    }
    const calls = new Map<string, Record<string, unknown>>();
    const outputs = new Map<string, Record<string, unknown>>();
    for (const item of data.input) {
      if (!currentCallEntry(item, this.tag) || !record(item)) continue;
      const callId = String(item.call_id);
      const target = item.type === "function_call" ? calls : outputs;
      if (target.has(callId)) {
        throw new Error("FAROL_CONTINUATION_CARDINALITY_INVALID");
      }
      target.set(callId, item);
    }
    if (calls.size !== this.issued.size || outputs.size !== this.issued.size) {
      throw new Error("FAROL_CONTINUATION_CARDINALITY_INVALID");
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
        throw new Error("FAROL_CONTINUATION_CALL_INVALID");
      }
      const normalized = outputText(output.output);
      if (normalized === null) {
        throw new Error("FAROL_CONTINUATION_OUTPUT_INVALID");
      }
      const canonical = canonicalJson(output.output);
      if (issued === this.pending) {
        pendingOutput = normalized;
        pendingCanonical = canonical;
      } else if (issued.outputCanonical !== canonical) {
        throw new Error("FAROL_CONTINUATION_REPLAY_INVALID");
      }
    }
    if (pendingOutput === null || pendingCanonical === null) {
      throw new Error("FAROL_CONTINUATION_OUTPUT_INVALID");
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
    if (this.waiter) throw new Error("FAROL_TURN_STATE_INVALID");
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
    onRefusal("FAROL_REQUEST_INVALID");
    refusal(response, 400, "FAROL_REQUEST_INVALID");
    return;
  }
  if (parsed.data.model !== options.model) {
    refusal(response, 422, "FAROL_MODEL_UNAVAILABLE");
    return;
  }
  const identity = identityFromRequest(parsed.data);
  const key = turnKey(identity);
  if (options.goResponses) {
    try {
      const requestSelection = extractGoChatRequestSelection(parsed.data);
      await options.goResponses.serve({
        key,
        identity,
        request: parsed.data,
        response,
        prepareInitial: async () => {
          const release = options.threads
            ? options.threads.hold(identity)
            : () => undefined;
          if (!release) {
            const code = "FAROL_COMPACTION_TURN_ACTIVE";
            onRefusal(code);
            refusal(response, 409, code);
            return null;
          }
          try {
            return await prepareInitialInput(
              raw,
              parsed.data,
              key,
              response,
              options,
              onRefusal,
              requestSelection,
            );
          } finally {
            release();
          }
        },
        onToolCall: onToolCallObserved,
      });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const code =
          error instanceof Error && /^FAROL_[A-Z_]+$/u.test(error.message)
            ? error.message
            : "FAROL_GO_OUTCOME_UNKNOWN";
        onRefusal(code);
        refusal(
          response,
          code.includes("UNSUPPORTED") || code.includes("UNAVAILABLE")
            ? 422
            : 409,
          code,
        );
        return;
      }
      throw error;
    }
    return;
  }
  const existing = turns.get(key);
  if (existing) {
    if (!existing.hasContinuation(parsed.data)) {
      refusal(response, 409, "FAROL_CONTINUATION_REQUIRED");
      return;
    }
    try {
      await existing.serveContinuation(response, parsed.data);
    } catch (error) {
      if (error instanceof Error && !response.headersSent) {
        onRefusal(
          /^FAROL_CONTINUATION_[A-Z_]+$/u.test(error.message)
            ? error.message
            : "FAROL_CONTINUATION_INVALID",
        );
        refusal(response, 409, "FAROL_CONTINUATION_INVALID");
        return;
      }
      existing.cancel("FAROL_HOST_DELIVERY_LOST");
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
    refusal(response, 409, "FAROL_CONTINUATION_FOREIGN");
    return;
  }
  if (
    Array.isArray(parsed.data.input) &&
    parsed.data.input.some((entry) => currentCallEntry(entry, tag))
  ) {
    refusal(response, 409, "FAROL_CONTINUATION_NOT_FOUND");
    return;
  }
  if (turns.size >= MAX_ACTIVE_TURNS) {
    refusal(response, 503, "FAROL_PROVIDER_BUSY");
    return;
  }
  // From here the thread is in use: its context is prepared, the request is
  // admitted durably and its conversation run starts before the hold ends,
  // so nothing closes the task in between.
  const release = options.threads
    ? options.threads.hold(identity)
    : () => undefined;
  if (!release) {
    onRefusal("FAROL_COMPACTION_TURN_ACTIVE");
    refusal(response, 409, "FAROL_COMPACTION_TURN_ACTIVE");
    return;
  }
  try {
    await serveInitialRequest(
      raw,
      parsed.data,
      identity,
      key,
      response,
      options,
      turns,
      onToolCallObserved,
      onRefusal,
    );
  } finally {
    release();
  }
}

async function prepareInitialInput(
  raw: unknown,
  data: ResponseRequest,
  key: string,
  response: ServerResponse,
  options: ProviderOptions,
  onRefusal: (code: string) => void,
  requestSelection?: GoChatRequestSelection,
): Promise<GoChatPreparedInput | null> {
  const intentSHA256 = requestSelection
    ? goChatRequestIntentSHA256(data, requestSelection)
    : undefined;
  let trustedContext: string | null = null;
  let contextDelivered: (() => void) | undefined;
  if (options.compaction?.prepareTurn) {
    const prepared = await options.compaction.prepareTurn({
      body: structuredClone(raw),
    });
    if (!prepared.ok) {
      refusal(response, 409, prepared.error.code);
      return null;
    }
    trustedContext = prepared.value.trustedContext;
    contextDelivered = prepared.value.delivered;
  }
  const prompt = promptFromInput(data.input, trustedContext);
  if (prompt === null) {
    refusal(response, 422, "FAROL_INPUT_UNSUPPORTED");
    return null;
  }
  try {
    CodexNativeToolRegistry.parse(data.tools);
  } catch (error) {
    onRefusal(
      error instanceof Error && /^CODEX_TOOL_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "FAROL_TOOL_CATALOGUE_INVALID",
    );
    refusal(response, 422, "FAROL_TOOL_CATALOGUE_INVALID");
    return null;
  }
  // A host may repeat an initial request after a terminal answer, a lost
  // stream or a restart. The logical request is recorded durably, with its
  // immutable intent, after every local refusal and before anything reaches
  // ChatGPT, so a repeat never starts a second conversation run and the same
  // identity cannot carry a different request. A deliberately new identity
  // with the same text is a new request.
  return {
    prompt,
    ...(contextDelivered ? { completed: contextDelivered } : {}),
    admit: async () => {
      let admission: ProviderTurnAdmission;
      try {
        admission = await options.turns.admit(
          key,
          intentSHA256 ??
            digest(
              canonicalJson({
                model: data.model,
                input: data.input,
                tools: data.tools,
              }),
            ),
        );
      } catch {
        onRefusal("FAROL_TURN_JOURNAL_UNAVAILABLE");
        refusal(response, 503, "FAROL_TURN_JOURNAL_UNAVAILABLE");
        return false;
      }
      if (admission !== "admitted") {
        const code =
          admission === "replayed"
            ? "FAROL_TURN_ALREADY_SUBMITTED"
            : admission === "conflict"
              ? "FAROL_TURN_INTENT_CONFLICT"
              : "FAROL_TURN_STATE_UNKNOWN";
        onRefusal(code);
        refusal(response, 409, code);
        return false;
      }
      return true;
    },
  };
}

async function serveInitialRequest(
  raw: unknown,
  data: ResponseRequest,
  identity: CodexChatGptTurnInput["identity"],
  key: string,
  response: ServerResponse,
  options: ProviderOptions,
  turns: Map<string, ActiveProviderTurn>,
  onToolCallObserved: () => void,
  onRefusal: (code: string) => void,
): Promise<void> {
  const prepared = await prepareInitialInput(
    raw,
    data,
    key,
    response,
    options,
    onRefusal,
  );
  if (!prepared || !(await prepared.admit())) return;
  const prompt = prepared.prompt;
  const contextDelivered = prepared.completed;
  if (!options.conversation) throw new Error("FAROL_PROVIDER_OPTIONS_INVALID");
  let turn: ActiveProviderTurn;
  try {
    turn = new ActiveProviderTurn(
      data,
      {
        requestedModel: data.model,
        prompt,
        identity,
        tools: structuredClone(data.tools),
      },
      options.conversation,
      onToolCallObserved,
      () => turns.delete(key),
      async (state) => {
        if (state === "completed") contextDelivered?.();
        // Nothing reached ChatGPT, so a repeat of this request is a new
        // attempt rather than a duplicate. A record that cannot be removed
        // stays, and a repeat is refused as already submitted.
        if (state === "failed_before_submit") {
          await options.turns.release(key).catch(() => undefined);
        }
      },
    );
  } catch (error) {
    onRefusal(
      error instanceof Error && /^CODEX_TOOL_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "FAROL_TOOL_CATALOGUE_INVALID",
    );
    refusal(response, 422, "FAROL_TOOL_CATALOGUE_INVALID");
    return;
  }
  turns.set(key, turn);
  try {
    await turn.serveInitial(response);
  } catch (error) {
    turn.cancel("FAROL_HOST_DELIVERY_LOST");
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
  // Compaction is a new request on the selected route, even when it reads a
  // historical checkpoint. Never relabel a stale alias as the current model.
  if (!record(raw) || raw.model !== options.model) {
    refusal(response, 422, "FAROL_MODEL_UNAVAILABLE");
    return;
  }
  if (!options.compaction) {
    refusal(response, 501, "FAROL_COMPACTION_UNAVAILABLE");
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
    refusal(response, 500, "FAROL_COMPACTION_RESULT_INVALID");
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
    refusal(response, 415, "FAROL_CONTENT_TYPE_INVALID");
    return { ok: false };
  }
  try {
    return { ok: true, value: await readBody(request) };
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "FAROL_REQUEST_INVALID";
    refusal(response, code === "FAROL_REQUEST_TOO_LARGE" ? 413 : 400, code);
    return { ok: false };
  }
}

export async function startCodexChatGptProvider(
  options: ProviderOptions,
): Promise<CodexChatGptProviderRuntime> {
  if (
    // Historical low-level context fixtures keep their exact original IDs.
    // The production route supplies CHATGPT_MODEL_ID exclusively; its exact
    // request-model guard never treats these strings as aliases of chatgpt.
    (options.model !== CHATGPT_MODEL_ID &&
      options.model !== "legacy-route/mind" &&
      options.model !== "legacy-route/drive") ||
    Boolean(options.conversation) === Boolean(options.goResponses) ||
    options.token.length < 16 ||
    options.token.length > 512 ||
    /[\r\n]/u.test(options.token)
  ) {
    throw new Error("FAROL_PROVIDER_OPTIONS_INVALID");
  }

  let modelRequests = 0;
  let responseRequests = 0;
  let unauthorizedRequests = 0;
  let failedRequests = 0;
  let toolCalls = 0;
  let compactionRequests = 0;
  let lastRefusalCode: string | null = null;
  let lastInputKinds: string[] = [];
  let lastInputRoles: string[] = [];
  let lastInputContentKinds: string[] = [];
  let lastToolNames: string[] = [];
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
        refusal(response, 401, "FAROL_PROVIDER_UNAUTHORIZED");
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
        lastInputRoles = inputRoles(body.value);
        lastInputContentKinds = inputContentKinds(body.value);
        lastToolNames = toolNames(body.value);
        lastMetadataKeys = metadataKeys(body.value);
        lastTurnMetadataKeys = turnMetadataKeys(body.value);
        lastCompactionMarkerKind = compactionMarkerKind(body.value);
        lastCompactionMarkerShape = compactionMarkerShape(body.value);
        lastRequestKindCompaction = requestKindCompaction(body.value);
        lastRequestKindShape = requestKindShape(body.value);
        const endpoint =
          url.pathname === "/v1/responses/compact"
            ? "responses_compact"
            : streamedCompactionRequest(
                  body.value,
                  compactionMetadataHeader(request),
                )
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
      refusal(response, 404, "FAROL_PROVIDER_NOT_FOUND");
    })().catch(() => {
      failedRequests += 1;
      if (!response.headersSent) {
        refusal(response, 500, "FAROL_PROVIDER_FAILED");
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
    throw new Error("FAROL_PROVIDER_BIND_FAILED");
  }
  const port = address.port;
  return {
    providerId: FAROL_PROVIDER_ID,
    model: options.model,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    diagnostics: () => ({
      modelRequests,
      responseRequests,
      unauthorizedRequests,
      failedRequests,
      activeTurns: options.goResponses?.activeResponses ?? turns.size,
      toolCalls,
      compactionRequests,
      lastRefusalCode,
      lastInputKinds: [...lastInputKinds],
      lastInputRoles: [...lastInputRoles],
      lastInputContentKinds: [...lastInputContentKinds],
      lastToolNames: [...lastToolNames],
      lastMetadataKeys: [...lastMetadataKeys],
      lastTurnMetadataKeys: [...lastTurnMetadataKeys],
      lastCompactionMarkerKind,
      lastCompactionMarkerShape: [...lastCompactionMarkerShape],
      lastRequestKindCompaction,
      lastRequestKindShape: [...lastRequestKindShape],
    }),
    close: async () => {
      await options.goResponses?.close();
      for (const turn of [...turns.values()]) {
        turn.cancel("FAROL_PROVIDER_CLOSED");
      }
      turns.clear();
      server.closeAllConnections();
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}
